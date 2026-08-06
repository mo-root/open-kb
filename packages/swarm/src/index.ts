/**
 * The swarm's tools layer: what a lead and its investigators may DO, as data
 * in and data out. No provider call happens here that did not arrive through a
 * port, and no tool ever throws at a model — a failure is a sentence a reader
 * can act on, carried in the return value.
 *
 * Layered on the kernel (@open-kb/core): the evidence store proves quotes, the
 * ledger prices work, the board holds the questions, the breaker remembers
 * what failed. This package is env-free like core — credentials arrive through
 * ports, never through process.env.
 */

export {
  RunEvidence,
  MAX_STORED_BYTES,
  originKey,
  recallProbePool,
  strongerTier,
  type RecordInput,
  type CiteOutcome,
  type ProvenanceTier,
} from "./run-evidence.js"

export {
  MapState,
  nodeKey,
  pageTierByWriter,
  SWARM_NODE_KINDS,
  SWARM_RELATIONS,
  type Contribution,
  type MapNode,
  type MapEdge,
  type EntityRow,
  type EntityEdgeRow,
} from "./map.js"

export {
  readTool,
  recallTool,
  rememberTool,
  linksOf,
  SLICE,
  commercialDowngradeHint,
  directoryDowngradeHint,
  type ReadInput,
  type ReadReturn,
  type ReadCtx,
  type RecallInput,
  type RecallReturn,
  type RecallCtx,
  type SearchTrace,
  type EvidenceRef,
  type RememberNodeInput,
  type RememberEdgeInput,
  type RetractInput,
  type RememberInput,
  type RememberReturn,
  type RememberCtx,
} from "./tools-free.js"

export {
  searchTool,
  fetchTool,
  MAX_QUERIES,
  MAX_URLS,
  PENDING_AFTER_MS,
  type PaidCtx,
  type SearchInput,
  type SearchItem,
  type SearchRow,
  type SearchReturn,
  type SwarmFetchMode,
  type FetchInput,
  type FetchDoc,
  type FetchDocOk,
  type FetchDocFail,
  type FetchDocPending,
  type FetchReturn,
} from "./tools-paid.js"

export {
  runLead,
  runInvestigator,
  estimateTokens,
  LEAD_EST_OUT_TOKENS,
  LEAD_TURN_CAP,
  INVESTIGATOR_TURN_CAP,
  TIER_DEADLINE_MS,
  DIGEST_TOKEN_CAP,
  type ModelPricing,
  type AgentHooks,
  type SwarmAgentDeps,
  type LeadDeps,
  type InvestigatorDeps,
  type LeadRunner,
  type LeadTurnOutcome,
  type InvestigatorDigest,
} from "./agent.js"

export {
  runSwarm,
  seedMission,
  DEFAULT_CEILING_USD,
  DEFAULT_LANES,
  DEFAULT_WALL_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_STILLBORN_MS,
  WALL_WARN_BEFORE_MS,
  type SwarmOptions,
  type SwarmRun,
  type SwarmEnding,
  type SwarmEndReason,
  type SwarmTally,
  type MissionLanding,
} from "./orchestrator.js"

export { serializeSwarmRun, type SerializedSwarmRun } from "./serialize.js"

export { FamilyLedger, type FamilyEvent } from "./family-ledger.js"

export {
  familyProfileFrom,
  seedFamilyMissions,
  DEFAULT_FAMILY_FLOOR,
  FAMILY_FLOOR_MAX,
  type FamilyProfile,
} from "./seed-families.js"

export {
  sweepSeedMissions,
  fromSweepArgv,
  validateSweepRun,
  DEFAULT_VERIFY_COUNT,
  DEFAULT_RECALL_GAP_THRESHOLD,
  GAP_CLUSTER_CAP,
  GAP_CLUSTER_SIZE,
  RECALL_GAP_NAMES,
  type SweepEntityLike,
  type SweepProbeLike,
  type SweepRunLike,
  type SweepSeedOptions,
} from "./from-sweep.js"

export {
  spawnTool,
  proposeTool,
  reviewTool,
  nextTool,
  finishTool,
  newRunControl,
  GATE_REFUSAL_TAIL,
  type RunControl,
  type NextCondition,
  type FinishState,
  type GateReading,
  type GateRecord,
  type ControlCtx,
  type SpawnInput,
  type SpawnReturn,
  type ProposeInput,
  type ProposeReturn,
  type ReviewInput,
  type ReviewOutcomeRow,
  type ReviewReturn,
  type NextInput,
  type NextReturn,
  type FinishInput,
  type FinishReturn,
} from "./tools-control.js"
