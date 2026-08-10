-- Run this once in the Supabase SQL editor.
--
-- Two tables, because a run has two halves that fail differently.
--
-- `runs` is the answer: one row, rewritten as the run progresses and holding
-- the finished SweepResult. `run_spans` is the work: append-only, one row per
-- span, written in batches while the run is still going.
--
-- The second table is the point. Everything a run produced used to live only in
-- the server's memory until the pipeline's last instruction, so a process that
-- died at minute 11 of 12 discarded every search and every model call already
-- paid for. Spans land as they happen, so a dead run is now a readable one.

create table if not exists runs (
  id          uuid        primary key,
  domain      text        not null,
  queries     int         not null,
  status      text        not null check (status in ('running', 'complete', 'failed')),
  started_at  timestamptz not null,
  ended_at    timestamptz,
  error       text,
  -- Written once, at the end. A run without it is one that did not finish.
  result      jsonb,
  updated_at  timestamptz not null default now()
);

-- The gallery reads newest first and nothing else.
create index if not exists runs_recent_idx on runs (started_at desc);

create table if not exists run_spans (
  run_id  uuid not null references runs (id) on delete cascade,
  -- The stream's own cursor. A browser resumes with `seq > n`, which is the
  -- same thing SpanStream does in memory, so a reconnect after a server restart
  -- reads exactly the frames it has not seen.
  seq     int  not null,
  span    jsonb not null,
  -- (run_id, seq) as the key makes a retried flush idempotent: a batch that
  -- half-landed can be sent again without duplicating rows.
  primary key (run_id, seq)
);

-- What the budget reads. Added after the table shipped, so they are `alter`s
-- rather than columns above: re-running this whole file against an existing
-- project is the documented upgrade, and every statement in it has to be a
-- no-op the second time.
--
-- `usd` is what the run cost — model plus search plus fetch, taken from the
-- span stream's own running total and written at the run's ending whether it
-- succeeded or failed. A failed run still bought its searches, which is exactly
-- why this is not derived from `result`.
--
-- `visitor` is a salted hash of the requester's address, never the address. The
-- only question asked of it is "same person as that one", and a hash answers
-- that as well as an address does while not being a personal identifier sitting
-- in a table for years. See `visitorOf` in packages/web/lib/spend-limits.ts.
--
-- WITHOUT THESE TWO COLUMNS the deployment refuses every run rather than
-- guessing at its budget: `usageSince` cannot select them, and a spend limiter
-- that cannot count fails closed. If a deployment starts answering "cannot
-- reach the database that keeps the count", this file is what it is asking for.
alter table runs add column if not exists usd     numeric not null default 0;
alter table runs add column if not exists visitor text;

-- The budget's own query: today's rows, in order. Without this it is a
-- sequential scan of every run ever, on the request path of the one endpoint
-- that spends money.
create index if not exists runs_started_idx on runs (started_at);

-- RLS on with no public policy: the secret key bypasses it, the publishable key
-- gets nothing. A map is private until someone decides otherwise.
alter table runs enable row level security;
alter table run_spans enable row level security;

-- ─────────────────────────────────────────────────────────── the claim
--
-- THE ONE DECISION THAT CANNOT BE MADE IN THE APPLICATION.
--
-- Every limit in packages/web/lib/spend-limits.ts is a read, a decision and a
-- write, and between the read and the write is a hole you can drive a shell
-- loop through: fifty requests fired together all SELECT the same empty day,
-- all decide there is budget, and all start. At a $0.41 run cap and a $5.00 day
-- cap that is $20.50 spent against a limit of five, and every one of the fifty
-- was individually correct about what it read.
--
-- No ordering trick closes it from outside. A client timestamp is not insertion
-- order; a sequence number is assigned before commit, so a lower one can land
-- after a higher one; and under READ COMMITTED two transactions that both
-- SELECT before either INSERTs cannot see each other however the rows are
-- sorted. The count and the insert have to happen inside one transaction that
-- no other claim can interleave with, which is what this function is.
--
-- `pg_advisory_xact_lock` is what serializes them. Transaction-scoped, so it is
-- released on commit AND on rollback and no error path can leak it; taken
-- before the count, so a claim either sees another claim's row or waits for it.
-- Every claim in the deployment queues on one lock. That is the intent: the
-- decision is inherently serial, it holds the lock for one indexed count and
-- one insert, and the thing being protected is a request that then runs for
-- four minutes.
--
-- IT RETURNS FACTS, NOT SENTENCES. `limit` names which one bound and the three
-- counts come back beside it, so every word a visitor reads is still written in
-- spend-limits.ts where it is tested. A refusal written here would be a second
-- copy of those sentences, in a language with no tests, that an operator
-- upgrades separately from the code that quotes them.
--
-- NULL MEANS OFF, for each of the four, matching `Limits` in spend-limits.ts.
create or replace function claim_run(
  p_id          uuid,
  p_domain      text,
  p_queries     int,
  p_started_at  timestamptz,
  p_visitor     text,
  p_since       timestamptz,
  p_window_ms   bigint,
  p_run_cap     numeric,
  p_day_cap     numeric,
  p_per_visitor int,
  p_at_once     int
) returns jsonb
language plpgsql
as $$
declare
  v_spent      numeric := 0;
  v_in_flight  int     := 0;
  v_by_visitor int     := 0;
begin
  perform pg_advisory_xact_lock(hashtext('open-kb.claim-run'));

  -- One pass over today's rows, three answers. A run still running is held at
  -- the full run cap rather than at the zero in its column, because a run that
  -- has spent something and recorded nothing counted as free is the other half
  -- of the same bug. It settles to its real cost when it ends. This mirrors
  -- `count()` in spend-limits.ts line for line, including that a running row
  -- older than the window still holds its cap against the day while no longer
  -- holding a concurrency slot: it is a run whose instance died, it did spend,
  -- and nothing can now say how much.
  select
    coalesce(sum(case when status = 'running' then coalesce(p_run_cap, 0) else coalesce(usd, 0) end), 0),
    count(*) filter (
      where status = 'running'
        and p_started_at - started_at <= make_interval(secs => p_window_ms / 1000.0)
    ),
    count(*) filter (where p_visitor is not null and visitor = p_visitor)
  into v_spent, v_in_flight, v_by_visitor
  from runs
  where started_at >= p_since;

  -- Ordered by how long the answer stays true, longest first, so a visitor
  -- given a reason is given the durable one. Same order as spendGate.
  if p_per_visitor is not null and v_by_visitor >= p_per_visitor then
    return jsonb_build_object('ok', false, 'limit', 'visitor',
      'by_visitor', v_by_visitor, 'spent_usd', v_spent, 'in_flight', v_in_flight);
  end if;

  if p_day_cap is not null and v_spent + coalesce(p_run_cap, 0) > p_day_cap then
    return jsonb_build_object('ok', false, 'limit', 'day',
      'by_visitor', v_by_visitor, 'spent_usd', v_spent, 'in_flight', v_in_flight);
  end if;

  if p_at_once is not null and v_in_flight >= p_at_once then
    return jsonb_build_object('ok', false, 'limit', 'at-once',
      'by_visitor', v_by_visitor, 'spent_usd', v_spent, 'in_flight', v_in_flight);
  end if;

  -- THE ROW IS THE CLAIM. It exists before this transaction commits, so the
  -- next claim to take the lock counts it. `createRun` upserts the same id
  -- immediately afterwards with the same values, which is why this is `do
  -- nothing` rather than a second source of truth.
  insert into runs (id, domain, queries, status, started_at, usd, visitor)
  values (p_id, p_domain, p_queries, 'running', p_started_at, 0, p_visitor)
  on conflict (id) do nothing;

  return jsonb_build_object('ok', true,
    'by_visitor', v_by_visitor, 'spent_usd', v_spent, 'in_flight', v_in_flight);
end;
$$;

-- The secret key only. The publishable key reaches PostgREST too, and RLS does
-- not protect a function from being CALLED — an anon caller would see zero rows
-- through RLS, find the day empty, and be told to go ahead.
revoke execute on function claim_run(uuid, text, int, timestamptz, text, timestamptz, bigint, numeric, numeric, int, int) from public, anon, authenticated;

-- PostgREST caches the list of callable functions. Without this the first call
-- after an upgrade answers 404 and the deployment refuses every run until the
-- cache happens to reload.
notify pgrst, 'reload schema';
