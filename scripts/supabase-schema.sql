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

-- RLS on with no public policy: the secret key bypasses it, the publishable key
-- gets nothing. A map is private until someone decides otherwise.
alter table runs enable row level security;
alter table run_spans enable row level security;
