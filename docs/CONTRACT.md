# node-loop build contract

Single source of truth for names, file layout, schemas and the ledger grammar.
Every skill, agent, script and the extension follows this file; change it here first.

## Glossary

- **node**: one unit of planned work. The smallest change one fresh agent can implement and one reviewer can pass or fail from the diff alone. Always written "plan node" or `nodes/NN-slug.md` in prose, never bare "node", so agents never read it as Node.js.
- **fence**: a node's owned paths plus its out-of-scope list. Leading word in every prompt.
- **creep**: a change the node did not ask for. **shrink**: a stub, TODO, weakened or skipped test, or unmet acceptance item.
- **kickback**: a failed review, fence check or leak check; the orchestrator dispatches a new, fresh implementer.
- **wave**: the set of plan nodes whose dependencies have all passed; they run in parallel.
- **run dir**: per-run state folder, outside the repo.
- **orchestrator**: the main omp session running the `node-loop` skill.

## Repository layout

```
package.json                     name "node-loop"; omp.extensions -> ["extensions/node-loop/index.ts"]
.omp-plugin/marketplace.json     catalog for /marketplace add exit-node/node-loop
skills/node-loop/SKILL.md        orchestrator procedure
skills/node-loop/resume.md       resume procedure, read when the user says resume
skills/node-loop/scripts/        preflight, run-init, ledger, fence-check, leak-check, review-package (bash + git only)
skills/node-spec/SKILL.md        what a plan node is, sizing rules, smells
skills/node-spec/template.md     plan node file template
skills/node-council/SKILL.md     chair procedure: dispatch seats, verify findings
agents/node-planner.md
agents/node-implementer.md
agents/node-reviewer.md
agents/council-chair.md
agents/council-seat-1.md  council-seat-2.md  council-seat-3.md
extensions/node-loop/index.ts    keyword hook, /exitnode command, setup, wiring
extensions/node-loop/setup.ts    role pickers, isolation settings
extensions/node-loop/forge/      ledger parser, localhost server, page
docs/CONTRACT.md                 this file
README.md
```

## Model roles

Agents reference roles only. `exitnode setup` writes them; the user keeps them current.

| Role | Agent(s) | Default (author's machine) |
|---|---|---|
| `node-plan` | node-planner | anthropic/claude-opus-5-5 |
| `node-implement` | node-implementer | anthropic/claude-sonnet-5-5 |
| `node-review` | node-reviewer | openai-codex/gpt-6.1-sol |
| `node-chair` | council-chair | anthropic/claude-opus-5-5 |
| `council-seat-1` | council-seat-1 | anthropic/claude-opus-5-5 |
| `council-seat-2` | council-seat-2 | openai-codex/gpt-6.1-sol |
| `council-seat-3` | council-seat-3 | muse-code/muse-wonder-full-1.0 |

Author defaults are this project's own picks; setup offers one only when omp resolves it for you.

Required omp settings: `task.isolation.enabled: true`, `task.isolation.merge: branch`, `task.isolation.apply: false`.
`apply: false` keeps each implementer's work on its `omp/task/<id>` branch; the orchestrator lands it only after review passes.

Preflight (`scripts/preflight`) fails if any role above is missing from `omp config get modelRoles`, if a role's value (without a thinking suffix) is not a `selector` in `omp models --json`, or if any isolation setting differs, and prints the problem plus `Run: exitnode setup`.
Reason: omp silently falls back to the parent session's model when an agent's role is missing, and an unresolvable id fails mid-run.

## Agents

All agents: `structured: true`, `spawns: ""` except council-chair, explicit `tools`, `model: "@<role>"`, `autoloadSkills` where listed.
Every agent writes prose to files in the run dir and yields only the JSON below.

| Agent | tools | autoloadSkills | spawns |
|---|---|---|---|
| node-planner | read, grep, glob, bash, write | node-spec | "" |
| node-implementer | read, grep, glob, bash, edit, write | node-spec | "" |
| node-reviewer | read, grep, glob, bash, write | node-spec | "" |
| council-chair | read, grep, glob, bash, write, task | node-council | council-seat-1, council-seat-2, council-seat-3 |
| council-seat-N | read, grep, glob, bash, write | (none) | "" |

Isolation: an implementer works only in its own checkout (its working directory) and translates any absolute path in its plan node to that checkout.
The reviewer runs acceptance commands only in a throwaway worktree, never in its starting directory, which is the main checkout.

### Output schemas

node-planner:
```json
{ "status": "planned|needs-input",
  "questions": ["string"],
  "nodes": [{ "id": "NN-slug", "deps": ["NN-slug"], "wave": 1 }] }
```

node-implementer:
```json
{ "status": "done|blocked", "report": "abs path to reports/NN-slug.md", "concerns": ["string"] }
```

node-reviewer:
```json
{ "verdict": "pass|fail",
  "scope": { "creep": ["string"], "shrink": ["string"] },
  "findings": [{ "severity": "blocker|major|nit", "file": "path", "line": 0,
                 "claim": "string", "evidence": "string" }],
  "review": "abs path to reviews/NN-slug-rK.md" }
```
Rule: `verdict` is `fail` when any blocker or major exists or `scope.creep`/`scope.shrink` is non-empty.

council-seat-N:
```json
{ "findings": [{ "severity": "blocker|major|nit",
                 "category": "bug|security|creep|shrink|design|test",
                 "file": "path", "line": 0, "claim": "string", "evidence": "string" }] }
```

council-chair:
```json
{ "verdict": "clean|fix",
  "verified": [{ "seat": [1], "severity": "blocker|major|nit", "category": "string",
                 "file": "path", "line": 0, "claim": "string", "check": "how it was confirmed in code" }],
  "rejected": [{ "seat": [2], "claim": "string", "why": "string" }],
  "fix_nodes": ["abs path to nodes/NN-slug.md written for each verified blocker/major group"],
  "report": "abs path to council/verdict.md" }
```

## Run dir

`$NODE_LOOP_HOME` (default `~/.omp/node-loop`) `/<repo-slug>/<run-id>/`
- `repo-slug`: basename of `git rev-parse --show-toplevel`.
- `run-id`: `YYYYMMDD-HHMM-<goal-slug>` (goal slug: lowercase, `[a-z0-9-]`, max 32 chars).

| File | Writer | Reader |
|---|---|---|
| `goal.md` | run-init (user goal verbatim) | planner, chair |
| `meta.env` | run-init: `REPO=`, `BASE_BRANCH=`, `RUN_BRANCH=`, `BASE_SHA=` | scripts, orchestrator |
| `scout/*.md` | scouts | planner only |
| `brief.md` (max ~150 lines: conventions, commands, architecture map) | planner | every agent |
| `plan.md` (goal restated, node table, waves, risks) | planner | user, orchestrator |
| `nodes/NN-slug.md` | planner (and chair for fix nodes) | implementer, reviewer |
| `contracts.md` (append-only, `## NN-slug` sections) | orchestrator on merge | implementers of dependent nodes, own deps' sections only |
| `reports/NN-slug.md` (append-only, `## Round K`) | implementer | reviewer, next implementer |
| `reviews/NN-slug-rK.md` (review package: log, stat, diff -U10) | review-package | reviewer |
| `reviews/NN-slug-rK.patch` (plain diff base..branch) | review-package | next implementer on kickback |
| `reviews/NN-slug-rK-leak.patch` (tracked diff of a leak into REPO, when one happens; the leaked changes are stashed as `node-loop-leak-NN-slug-rK`) | leak-check | user, orchestrator |
| `reviews/NN-slug-rK.json` | orchestrator (reviewer verdict) | orchestrator |
| `council/seat-N.json`, `council/verdict.md` | chair | orchestrator, user |
| `parking.md` (append-only: out-of-fence ideas) | any agent | user at the end |
| `rulings.md` (leftover findings with one-line ruling) | orchestrator | user at the end |
| `ledger.md` | `scripts/ledger` only | orchestrator, forge |
| `report.md` | orchestrator at finish | user |

## Plan node file (`nodes/NN-slug.md`)

`NN` is two digits, ordered by wave then dependency. Sections, in order, exact headings:

```
# NN-slug: <one-sentence goal>
## Goal
## Fence
- path/exact.ts            exact file
- src/auth/                directory prefix: everything below
- src/**/*.test.ts         bash pattern; * also matches /
## Out of scope
## Contract
Consumes: <interfaces from deps' contracts.md sections, or "none">
Exposes: <interfaces later nodes rely on, or "none">
## Acceptance
- [ ] checkable statement - `exact command proving it`
## Depends on
NN-slug, NN-slug | none
```

`fence-check` reads only the list items under `## Fence` (first token of each `- ` line).

Acceptance commands and every path are repo-relative and run from the root of the implementer's checkout: no absolute path, no `cd`.

## Ledger grammar (`ledger.md`)

One event per line, written only by `scripts/ledger`:

```
<ISO-8601 UTC, seconds, Z> <subject> <event>[ key=value]...[ -- free text]
```

- Values contain no spaces; free text after ` -- ` is display-only.
- Subjects: `run`, `scout`, `plan`, `council`, `seat-1`, `seat-2`, `seat-3`, or a plan node id matching `^[0-9]{2}-[a-z0-9-]+$`.

| Subject | Events (keys) |
|---|---|
| run | `start` (branch, base), `done`, `blocked` |
| scout | `start` (n), `done` |
| plan | `start`, `done` (nodes, waves), `approved`, `revised` |
| plan node | `queued` (wave, deps=a,b or deps=-), `implement` (round, agent), `review` (round), `fence` (round, paths=<count>, text=<comma-joined paths>), `fail` (round, blockers, majors), `pass` (round), `merged` (commits=a1b2c3d..d4e5f6a), `ruled` (round, findings), `blocked` (round) |
| council | `start`, `verify`, `done` (verdict=clean\|fix, blockers) |
| seat-N | `start`, `done` (findings) |

`round` starts at 1. A `fail`/`fence` event is a kickback; the next `implement` carries `round+1`. Cap: round 4 never starts; after round-3 `fail` the orchestrator writes `ruled` or `blocked`.

A `fence` also covers a leak into REPO found by `leak-check`; its paths are the leaked ones.

Example:
```
2026-10-26T14:02:11Z run start branch=node-loop/20261026-1402-auth base=3f2a9c1 -- add magic-link login
2026-10-26T14:05:40Z plan done nodes=3 waves=2
2026-10-26T14:07:02Z plan approved
2026-10-26T14:07:03Z 01-schema queued wave=1 deps=-
2026-10-26T14:07:04Z 01-schema implement round=1 agent=Impl01
2026-10-26T14:12:30Z 01-schema review round=1
2026-10-26T14:14:10Z 01-schema fail round=1 blockers=1 majors=0 -- token not hashed
2026-10-26T14:14:12Z 01-schema implement round=2 agent=Impl01b
2026-10-26T14:20:00Z 01-schema pass round=2
2026-10-26T14:20:05Z 01-schema merged commits=a1b2c3d..d4e5f6a
```

## Scripts (`skills/node-loop/scripts/`, bash + git, `set -euo pipefail`, no other deps)

| Script | Usage | Output / exit |
|---|---|---|
| `preflight` | `preflight` | prints `ok` or each problem + `Run: exitnode setup`; exit 1 on problems |
| `run-init` | `run-init "<goal>"` (in target repo) | refuses dirty tree or detached HEAD; creates run dir + `RUN_BRANCH=node-loop/<run-id>` from HEAD and checks it out; writes `goal.md`, `meta.env`, empty files; ledger `run start`; prints run dir abs path |
| `ledger` | `ledger <run-dir> <subject> <event> [k=v...] [-- text]` | validates subject/event/keys against the grammar; appends; exit 2 on invalid |
| `fence-check` | `fence-check <node-file> <base> <head>` | prints each changed path outside the fence; exit 1 if any, 0 if clean |
| `review-package` | `review-package <run-dir> <node-id> <round> <base> <head>` | writes `reviews/<id>-r<round>.md` and `.patch`; prints the `.md` path |
| `leak-check` | `leak-check <run-dir> <node-id> <round>` | REPO clean: exit 0, silent; leak: writes `reviews/<id>-r<round>-leak.patch`, prints the leaked paths, stashes them as `node-loop-leak-<id>-r<round>`; exit 1 on leak, 2 on usage or input error |

## Orchestrator flow (owned by `skills/node-loop`)

1. `preflight`; stop on failure.
2. `run-init`; resume instead when the user says resume: rebuild `todo` from `ledger.md`.
3. Scouts (bundled `scout`, parallel, read-only) write `scout/*.md`.
4. `node-planner` writes `brief.md`, `plan.md`, `nodes/*.md`. The orchestrator posts the plan to the user as information and continues without waiting; ledger `plan approved` marks it final. Planner `needs-input` questions still wait for answers.
5. Per wave: dispatch one `node-implementer` per ready plan node, `isolated: true`, all in one `task` call. Context field: run dir, node path, brief path, report path, dep contract sections, and on round > 1 the previous `.patch` and review paths.
6. On each result: `leak-check` first (exit 1: a leak into REPO, stashed and recorded as `fence`, kicked back with `FENCE_VIOLATIONS`, no reviewer); then `fence-check` on `branchBaseSha..branchName` (fail = automatic kickback, no reviewer); else `review-package` then `node-reviewer` (not isolated, reads package + node + report).
7. Pass: cherry-pick the branch commits onto `RUN_BRANCH`, append Exposes to `contracts.md`, ledger `merged`. Cherry-pick conflict = kickback on the new base with `CONFLICT_PATHS`.
8. Fail: new fresh `node-implementer` (never revive the old agent), round+1, max 3 rounds. It gets exactly one findings key: `PREV_VERDICT` (review fail), `FENCE_VIOLATIONS` (fence or leak), `CONFLICT_PATHS` (cherry-pick conflict), or none for an empty diff; plus `PREV_PATCH` when a diff exists. Nits never kick back; they go to `report.md`.
9. After round 3 fails: each open finding gets a ruling in `rulings.md` (reviewer wrong, or real but nothing depends on it) or the run stops and asks the user (real and a later node depends on it). No silent drops.
10. All plan nodes merged: `council-chair` (not isolated) reviews `BASE_SHA..RUN_BRANCH`. `verdict: fix` → its fix nodes enter the loop as a new wave; second council run after fixes, then stop.
11. Write `report.md` (merged nodes, rulings, nits, parking, council result); ledger `run done`.

Progress: the orchestrator mirrors the ledger into the omp `todo` list (phases Scout, Plan, Wave N with one item per plan node, Council, Finish) and posts a 3-line status every ~5 minutes during long waves.

## Extension (`extensions/node-loop/`)

- `input` hook, interactive source only: if trimmed text's first word is exactly `exitnode`:
  - `exitnode setup` → run setup, `handled: true`
  - `exitnode view` → start forge, open browser, `handled: true`
  - `exitnode` or `exitnode <rest>` → return `{ text: "/skill:node-loop <rest>" }`
- `/exitnode [setup|view|<goal>]` slash command: same routing.
- Setup: one picker per role in the roles table; choices come from `omp models --json` (the catalog `--model` resolves against), so every offered id is one omp accepts. If that command cannot be read, setup stops and says so. Author defaults are offered only when that catalog lists them for the user. Shared-provider review and repeated council models produce a warning in the confirm, never a block. Current value preselected; then isolation settings; one summary confirm; writes global settings only after confirm. The settings registry is imported dynamically, and when it or a write method is missing, setup prints the exact config lines instead.
- Forge: `startForge(): Promise<{ url: string }>` exported from `forge/server.ts`; idempotent (second call returns the running URL).

## Forge view

- Server: `127.0.0.1`, port 4747 or next free; `GET /` page, `GET /state` JSON, `GET /events` SSE pushing the full state JSON on every ledger change (fs.watch with 1 s poll fallback).
- Run selection: newest-modified `ledger.md` under `$NODE_LOOP_HOME/*/*/`; switches automatically when a newer run appears.
- State JSON: `{ run: { id, repo, goal, status }, plan: { status }, nodes: [{ id, wave, deps, status: queued|pouring|review|kickback|passed|merged|ruled|blocked, round }], council: { status, seats: [{ n, status, findings }] }, updatedAt }`.
- Page: single self-contained HTML (inline CSS/JS/SVG, no network). Flat black background. Plan nodes as channels left→right by wave with dependency joins. Running node: molten metal flowing along its channel with a standing glow at the pour front. Passed/merged: cooled grey. Kickback: metal recedes, glow flickers red, re-pours. Council: three crucibles filling as seats finish. `prefers-reduced-motion`: static glow, no flow.
