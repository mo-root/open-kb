import { readFileSync } from "node:fs"
import { graphOf, summaryOf } from "./packages/web/lib/kb-from-run"
const res = JSON.parse(readFileSync("runs/sweep-brightdata-com-202608042230.json","utf8"))
const run: any = { id: "x", result: res }
const g: any = graphOf(run)
const s: any = summaryOf(run)
console.log(JSON.stringify({ nodes: g.nodes.length, edges: g.edges.length, dangling: g.dangling.length, orphans: g.orphans.length, summary: { counts: s.counts, unplaced: s.unplaced, noise: s.noise, edges: s.edges, notes: s.notes, segments: s.segments?.length } }, null, 1))
