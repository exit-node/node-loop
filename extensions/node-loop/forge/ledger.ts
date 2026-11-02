/**
 * Pure parser from a run's `ledger.md` text to the forge State JSON.
 *
 * Grammar and State shape live in docs/CONTRACT.md ("Ledger grammar", "Forge view").
 * The parser is tolerant: a malformed line, an unknown subject or an unknown event is skipped,
 * so a half-written last line or a hand edit never breaks the view.
 *
 * Status vocabularies the contract leaves open are fixed here:
 * - run.status: none (no events) | running | done | blocked
 * - plan.status: pending | scouting | scouted | drafting | drafted | revised | approved.
 *   Scout events fold into plan.status because State carries no scout field; the page draws
 *   the scout channel from it.
 * - council.status: pending | running | verify | clean | fix
 * - seat status: pending | running | done; findings is null until the seat finishes.
 * - node round: 0 while queued, otherwise the round of the latest event that carried one.
 */

export type RunStatus = "none" | "running" | "done" | "blocked";
export type PlanStatus = "pending" | "scouting" | "scouted" | "drafting" | "drafted" | "revised" | "approved";
export type NodeStatus = "queued" | "pouring" | "review" | "kickback" | "passed" | "merged" | "ruled" | "blocked";
export type CouncilStatus = "pending" | "running" | "verify" | "clean" | "fix";
export type SeatStatus = "pending" | "running" | "done";

export interface RunMeta {
  id: string;
  repo: string;
  goal: string;
}

export interface PlanNode {
  id: string;
  wave: number;
  deps: string[];
  status: NodeStatus;
  round: number;
}

export interface Seat {
  n: number;
  status: SeatStatus;
  findings: number | null;
}

export interface State {
  run: { id: string; repo: string; goal: string; status: RunStatus };
  plan: { status: PlanStatus };
  nodes: PlanNode[];
  council: { status: CouncilStatus; seats: Seat[] };
  /** Timestamp of the last valid ledger event, null when there is none. */
  updatedAt: string | null;
}

interface Event {
  ts: string;
  subject: string;
  event: string;
  keys: Record<string, string>;
  text: string;
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const NODE_RE = /^[0-9]{2}-[a-z0-9-]+$/;
const SEAT_RE = /^seat-([123])$/;
// Plan node events from the grammar; anything else on a plan node subject is skipped.
// Lookups use Object.hasOwn: a hand-edited `constructor` or `toString` event must not match Object.prototype.
const NODE_EVENTS: Record<string, true> = {
  queued: true,
  implement: true,
  review: true,
  fence: true,
  fail: true,
  pass: true,
  merged: true,
  ruled: true,
  blocked: true,
};

/** Splits one ledger line into its parts; returns null for anything that is not an event. */
function parseLine(line: string): Event | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  // Free text is everything after the first " -- "; it may itself contain "--".
  const cut = trimmed.indexOf(" -- ");
  const head = cut === -1 ? trimmed : trimmed.slice(0, cut);
  const text = cut === -1 ? "" : trimmed.slice(cut + 4).trim();
  const tokens = head.split(/\s+/);
  if (tokens.length < 3) return null;
  const [ts, subject, event, ...rest] = tokens;
  if (!TS_RE.test(ts)) return null;
  const keys: Record<string, string> = {};
  for (const token of rest) {
    const eq = token.indexOf("=");
    if (eq <= 0 || eq === token.length - 1) continue;
    keys[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { ts, subject, event, keys, text };
}

/** Parses a non-negative integer key; returns the fallback when absent or malformed. */
function int(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  return Number(value);
}

/** Builds the forge State from ledger text. `meta` supplies run id, repo slug and goal. */
export function parseLedger(text: string, meta: RunMeta): State {
  const state: State = {
    run: { id: meta.id, repo: meta.repo, goal: meta.goal, status: "none" },
    plan: { status: "pending" },
    nodes: [],
    council: {
      status: "pending",
      seats: [1, 2, 3].map((n) => ({ n, status: "pending", findings: null })),
    },
    updatedAt: null,
  };
  // Insertion order of the map is the order plan nodes first appear in the ledger.
  const nodes = new Map<string, PlanNode>();
  let runGoal = "";

  const nodeFor = (id: string): PlanNode => {
    let node = nodes.get(id);
    if (!node) {
      // A plan node seen before its `queued` event lands in wave 1 until `queued` says otherwise.
      node = { id, wave: 1, deps: [], status: "queued", round: 0 };
      nodes.set(id, node);
    }
    return node;
  };

  for (const line of text.split(/\r?\n/)) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (!applyEvent(state, ev, nodeFor, (goal) => (runGoal = goal))) continue;
    // Any accepted event means the run exists, even if `run start` was lost.
    if (state.run.status === "none") state.run.status = "running";
    state.updatedAt = ev.ts;
  }

  if (state.run.goal === "" && runGoal !== "") state.run.goal = runGoal;
  state.nodes = [...nodes.values()];
  return state;
}

/** Applies one event to the state; returns false when the event is not part of the grammar. */
function applyEvent(
  state: State,
  ev: Event,
  nodeFor: (id: string) => PlanNode,
  setGoal: (goal: string) => void,
): boolean {
  const { subject, event, keys } = ev;

  if (subject === "run") {
    if (event === "start") {
      state.run.status = "running";
      // `run start` free text carries the goal; goal.md wins when the caller supplied it.
      if (ev.text) setGoal(ev.text);
    } else if (event === "done") state.run.status = "done";
    else if (event === "blocked") state.run.status = "blocked";
    else return false;
    return true;
  }

  if (subject === "scout") {
    if (event === "start") state.plan.status = "scouting";
    else if (event === "done") state.plan.status = "scouted";
    else return false;
    return true;
  }

  if (subject === "plan") {
    if (event === "start") state.plan.status = "drafting";
    else if (event === "done") state.plan.status = "drafted";
    else if (event === "revised") state.plan.status = "revised";
    else if (event === "approved") state.plan.status = "approved";
    else return false;
    return true;
  }

  if (subject === "council") {
    if (event === "start") {
      // A second council run after fix nodes starts with empty crucibles.
      state.council.status = "running";
      for (const seat of state.council.seats) {
        seat.status = "pending";
        seat.findings = null;
      }
    } else if (event === "verify") state.council.status = "verify";
    else if (event === "done") state.council.status = keys.verdict === "fix" ? "fix" : "clean";
    else return false;
    return true;
  }

  const seatMatch = SEAT_RE.exec(subject);
  if (seatMatch) {
    const seat = state.council.seats[Number(seatMatch[1]) - 1];
    if (event === "start") {
      seat.status = "running";
      seat.findings = null;
    } else if (event === "done") {
      seat.status = "done";
      seat.findings = int(keys.findings, 0);
    } else return false;
    return true;
  }

  if (!NODE_RE.test(subject) || !Object.hasOwn(NODE_EVENTS, event)) return false;

  const node = nodeFor(subject);
  // Events without a round key keep the node's current round.
  const round = int(keys.round, node.round);
  switch (event) {
    case "queued":
      node.wave = int(keys.wave, node.wave);
      node.deps = !keys.deps || keys.deps === "-" ? [] : keys.deps.split(",").filter(Boolean);
      node.status = "queued";
      node.round = 0;
      break;
    case "implement":
      node.status = "pouring";
      node.round = int(keys.round, node.round + 1);
      break;
    case "review":
      node.status = "review";
      node.round = round;
      break;
    case "fence":
    case "fail":
      node.status = "kickback";
      node.round = round;
      break;
    case "pass":
      node.status = "passed";
      node.round = round;
      break;
    case "merged":
      node.status = "merged";
      break;
    case "ruled":
      node.status = "ruled";
      node.round = round;
      break;
    case "blocked":
      node.status = "blocked";
      node.round = round;
      break;
  }
  return true;
}
