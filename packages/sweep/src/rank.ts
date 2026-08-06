/**
 * The judge kernel LIVED here; it lives in core now (packages/core/src/judge.ts).
 *
 * Moved because the swarm needed the same bulk primitive — an investigator who
 * surfaces 40 hosts should judge them all, page-in-hand, instead of opening
 * six — and packages/swarm must not depend on packages/sweep. The function was
 * already purity-clean (core modules plus a FetchPort and an injected
 * classify), so the move changed its address and nothing else. This re-export
 * keeps the sweep's import path, and every existing test of it, unchanged.
 */
export { judgeHosts, type HostCandidate, type Judged, type JudgeDeps, type KernelStats } from "@open-kb/core"
