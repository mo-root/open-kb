import { getStoredRun, isCompleted, type CompletedRun } from "./runs"

/**
 * The lookup every `/api/kb/[id]*` route starts with, and the three refusals
 * it can end in.
 *
 * WHY IT IS SHARED. Four routes — the envelope, the graph, one note, the zip —
 * each opened with the same two lines and the same sentence, which was fine
 * while there was one way to miss. There are three now: an id that names no
 * run at all, an id that names a run which is still RUNNING, and an id that
 * names a run which FAILED. Those deserve different answers, and four
 * hand-written copies of a refusal is four places for the wording to drift
 * apart — the clients render `error` verbatim, so a reader hitting the note
 * route and the graph route on the same id would be told two different things
 * about one fact.
 *
 * WHY A NON-COMPLETED RUN IS STILL A 404 HERE, EVEN WHILE RUNNING. It is not
 * an error and not a 500: the request was well formed and the server
 * understood it perfectly. There is simply no knowledge base at that id yet.
 * For a failed run there never will be — the run that would have built one
 * died. For a running run there may be one soon, and the body says so rather
 * than claiming a death that has not happened; see app/kb/[id]/page.tsx's own
 * "THREE STATES, NOT TWO" comment, which made the same distinction for the
 * human-facing route. 404 is the honest status either way; what changes is
 * that the body says which of the three things is true, instead of implying
 * the id was wrong when it was not.
 *
 * The run's own failure sentence is deliberately NOT repeated here. This is the
 * KB surface, and `GET /api/run/[id]` is the one that answers "why" — pointing
 * at it beats copying a bounded notice into a second body where nothing renders
 * it, and it keeps one authority for what a reader is told about a failure.
 */
export type KbLookup = { run: CompletedRun } | { refusal: Response }

export async function findKb(id: string): Promise<KbLookup> {
  const run = await getStoredRun(id)
  if (!run) {
    return { refusal: Response.json({ error: "no such knowledge base" }, { status: 404 }) }
  }
  if (!isCompleted(run)) {
    // THREE STATES, NOT TWO — the same fix app/kb/[id]/page.tsx already made
    // for the human-facing route (see its own comment there). A run that is
    // still `running` has not failed; it has simply not finished yet, and a
    // knowledge base at this id may exist a minute from now. Before this,
    // every non-completed run — running or failed alike — got the one
    // hardcoded "run X failed" sentence, which is a false statement for the
    // running case: a caller polling this route mid-sweep (or any external
    // API consumer that is not the web app, which only ever calls this route
    // after `isCompleted`) was told their run had died while it was still
    // working.
    const error =
      run.status === "running"
        ? `run ${id} is still running — no knowledge base yet — ask /api/run/${id} for progress`
        : `run ${id} failed, so it built no knowledge base — ask /api/run/${id} why`
    return {
      refusal: Response.json({ error, status: run.status }, { status: 404 }),
    }
  }
  return { run }
}
