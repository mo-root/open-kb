import { getStoredRun, isCompleted, type CompletedRun } from "./runs"

/**
 * The lookup every `/api/kb/[id]*` route starts with, and the two refusals it
 * can end in.
 *
 * WHY IT IS SHARED. Four routes — the envelope, the graph, one note, the zip —
 * each opened with the same two lines and the same sentence, which was fine
 * while there was one way to miss. There are two now: an id that names no run
 * at all, and an id that names a run which FAILED. Those deserve different
 * answers, and four hand-written copies of a two-branch refusal is four places
 * for the wording to drift apart — the clients render `error` verbatim, so a
 * reader hitting the note route and the graph route on the same dead id would
 * be told two different things about one fact.
 *
 * WHY A FAILED RUN IS STILL A 404 HERE. It is not an error and not a 500: the
 * request was well formed and the server understood it perfectly. There is
 * simply no knowledge base at that id, and there never will be — the run that
 * would have built one died. 404 is the honest status; what changes is that the
 * body says which of the two things happened, instead of implying the id was
 * wrong when it was not.
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
    return {
      refusal: Response.json(
        {
          error: `run ${id} failed, so it built no knowledge base — ask /api/run/${id} why`,
          status: run.status,
        },
        { status: 404 },
      ),
    }
  }
  return { run }
}
