---
name: node-loop
description: exitnode loop - drive a goal through scouts, a planner, isolated implementers per plan node, cross-provider review with kickback, and a model council. Use on `exitnode <goal>`, or to resume a node-loop run.
---

# node-loop orchestrator

You are the orchestrator of one run.
Agents do the work and write it to files in the run dir; you hold paths, verdict JSON and ledger state, and you move plan nodes from one transition to the next.
Terms (plan node, fence, creep, shrink, kickback, wave) are defined in `skill://node-spec`; read it before step 4.

## Ground rules

- **Scripts.** `scripts/<name>` means `<skill dir>/scripts/<name>`, where `<skill dir>` is the `[Skill directory: ...]` path appended to this skill. Use the absolute path in every command.
- **Run state.** After step 2, every bash call starts with `RUN=<run dir>; source "$RUN/meta.env"`, giving `REPO`, `BASE_BRANCH`, `RUN_BRANCH`, `BASE_SHA`. Run git commands in `REPO` with `RUN_BRANCH` checked out.
- **Ledger.** Every transition is one line written by `scripts/ledger "$RUN" <subject> <event> k=v... [-- text]`, before you act on it. Pass every key the CONTRACT grammar lists for the event; exit 2 means the line is malformed, so fix it and rerun until it appends. Events used below are written with all their keys.
- **Paths only.** An agent's `context` and `task` carry `KEY=value` lines of absolute paths and short values, plus at most one instruction sentence. Agents read the files themselves; scout output, file contents and this conversation stay out of their prompts.
- **Fresh agents.** Every dispatch is a new agent with a new name. Kickbacks go to a fresh implementer; finished agents are never messaged or revived.

## Progress

- **Todo mirror.** The omp `todo` list mirrors the ledger with phases `Scout`, `Plan`, `Wave 1` ... `Wave N`, `Council`, `Finish`. Each wave phase holds one item per plan node reading `<id>: <state>`, for example `02-auth: review round 2`. When a plan node's state changes, `rm` its old item and `append` the new text to its wave phase; mark `merged` items `done` and `blocked` items `block`. Close a phase with `done` when its ledger work is complete.
- **Status.** While a wave runs, post a three-line status whenever a result arrives or a `wait` returns and five minutes or more have passed since the last one:

```
Wave 2 of 3: 1 merged, 2 running, 0 blocked, 14 min in
02-auth: review round 2 | 03-ui: implement round 1
Next: 02-auth verdict
```

## Steps

### 1. Preflight

Run `scripts/preflight` in the target repo.
On failure, show its output verbatim and stop; the user fixes it with `exitnode setup`.

Done when preflight printed `ok`.

### 2. Start or resume

- **New run:** run `scripts/run-init "<goal>"` in the target repo with the user's goal verbatim; its last output line is the run dir. If it refuses (dirty tree, detached HEAD), show the reason and stop. Build the todo list with `init`: `Scout`, `Plan`, `Council`, `Finish`.
- **Resume** (the user says resume, or names a run dir): follow [`resume.md`](resume.md).

Done when `$RUN/meta.env` is sourced, `RUN_BRANCH` is checked out, and the todo list matches the ledger.

### 3. Scouts

Pick two to four areas of the repo the goal touches (`git ls-files` and the top-level layout are enough to choose).
Run `scripts/ledger "$RUN" scout start n=<count>`.
Dispatch one bundled `scout` agent per area in ONE `task` call, not isolated, with `context` `GOAL=$RUN/goal.md` and `REPO=$REPO`, and per-item `task`: "Map <area> for GOAL: relevant files, entry points, conventions, test commands, risks."
Scouts are read-only, so land each report without reading it: `cp "agent://<scout id>" "$RUN/scout/<area-slug>.md"` (bash resolves `agent://` paths).
Run `scripts/ledger "$RUN" scout done` and close the `Scout` phase.

Done when one `scout/*.md` file exists per scout and the ledger shows `scout done`.

### 4. Plan and approval gate

Run `scripts/ledger "$RUN" plan start`.
Dispatch `node-planner`, not isolated, with context `RUN_DIR`, `GOAL` (`$RUN/goal.md`), `SCOUTS` (`$RUN/scout`).

- **`needs-input`:** ask the user the `questions` verbatim, append their answers word for word to `goal.md` under `## Answers`, and dispatch a fresh planner with the same context.
- **`planned`:** run `scripts/ledger "$RUN" plan done nodes=<count> waves=<count>`.

Show the user the `plan.md` path and its plan node table, and ask for approval.
This gate is hard: only the user's explicit approval opens it.
On change requests, run `scripts/ledger "$RUN" plan revised -- <one-line summary>` and dispatch a fresh planner with the same context plus `PLAN_FEEDBACK=<the user's words verbatim>` in its task, then show the plan again.
On approval, run `scripts/ledger "$RUN" plan approved`, then for every plan node `scripts/ledger "$RUN" <id> queued wave=<W> deps=<a,b or ->`, and append one `Wave W` phase per wave with items `<id>: queued`.

Done when the ledger shows `plan approved` and one `queued` line per plan node file in `nodes/`.

### 5. Dispatch a wave

The wave's ready plan nodes are those whose dependencies are all merged.
For each, run `scripts/ledger "$RUN" <id> implement round=1 agent=Impl<NN>r1`, then dispatch all of them in ONE `task` call, `agent: node-implementer`, `isolated: true`, `name: Impl<NN>r<K>`, with:

- shared `context`: `RUN_DIR`, `BRIEF` (`$RUN/brief.md`), `CONTRACTS` (`$RUN/contracts.md`), `PARKING` (`$RUN/parking.md`);
- per-item `task`: `NODE`, `REPORT` (`$RUN/reports/<id>.md`), `ROUND`, `DEP_SECTIONS` (the plan node's `Depends on` ids, or `none`), and the sentence "Implement the plan node in NODE inside its fence."

The working tree must be clean on `RUN_BRANCH` before every isolated dispatch, since each implementer starts from its current HEAD.

Done when every ready plan node of the wave has an `implement` ledger line and a running implementer.

### 6. Check each implementer result

Handle each result as it arrives; other plan nodes keep running.

1. `status: blocked`: run `scripts/ledger "$RUN" <id> blocked round=<K> -- <first concern>`, show the user the concerns, and continue with plan nodes that do not depend on this one.
2. Find the work: `BRANCH` and `BASE` are the result's `branchName` (`omp/task/<agent id>`) and `branchBaseSha`. When the result lacks them, use `git branch --list 'omp/task/*'` to find the agent's branch and `BASE=$(git merge-base "$RUN_BRANCH" "$BRANCH")`. Set `HEAD=$(git rev-parse "$BRANCH")`. A branch with no commits beyond `BASE` is shrink: run `scripts/ledger "$RUN" <id> fail round=<K> blockers=1 majors=0 -- empty diff` and kick back (step 8) without `PREV_PATCH`; the next implementer reads `REPORT`.
3. Run `scripts/fence-check "$RUN/nodes/<id>.md" "$BASE" "$HEAD"`. On exit 1: run `scripts/ledger "$RUN" <id> fence round=<K> paths=<count> -- <comma-joined paths>`, run `scripts/review-package` as in item 4 only to capture the `.patch`, and kick back (step 8) with `FENCE_VIOLATIONS`. No reviewer sees a fence failure.
4. Run `PACKAGE=$(scripts/review-package "$RUN" <id> <K> "$BASE" "$HEAD")` and `scripts/ledger "$RUN" <id> review round=<K>`.
5. Dispatch `node-reviewer`, not isolated, `name: Rev<NN>r<K>`, with `RUN_DIR`, `BRIEF`, `NODE`, `REPORT`, `ROUND`, `PACKAGE`, `BASE`, `HEAD`. Save its JSON verbatim to `$RUN/reviews/<id>-r<K>.json`.
6. The verdict is `fail` when any blocker or major exists or `scope.creep` or `scope.shrink` is non-empty, whatever the reviewer wrote. Pass goes to step 7. Fail: run `scripts/ledger "$RUN" <id> fail round=<K> blockers=<count> majors=<count> -- <top claim>` and go to step 8.
7. Nits never fail a plan node; they reach `report.md` from the saved JSON.

Done when the plan node has a saved verdict and a `pass` or `fail` path chosen, or a `fence` or `blocked` ledger line.

### 7. Pass: land the work

1. Run `scripts/ledger "$RUN" <id> pass round=<K>`.
2. On `RUN_BRANCH`, note `PRE=$(git rev-parse HEAD)` and run `git cherry-pick "$BASE..$HEAD"`.
3. On conflict: `git cherry-pick --abort`, run `scripts/ledger "$RUN" <id> fail round=<K> blockers=1 majors=0 -- cherry-pick conflict: <paths>`, and kick back (step 8). The next implementer starts on the new `RUN_BRANCH` HEAD.
4. Append to `contracts.md` a `## <id>` section holding the plan node's `Exposes:` line.
5. Run `scripts/ledger "$RUN" <id> merged commits=<first short sha>..<last short sha>` from `git log --reverse --format=%h "$PRE..HEAD"`.

Done when the commits are on `RUN_BRANCH`, `contracts.md` has the `## <id>` section, and the ledger shows `merged`.
When every plan node of the wave is merged or blocked, close the wave phase and dispatch the next wave (step 5).

### 8. Fail: kick back

After a `fail` or `fence` at round K:

- K < 3: run `scripts/ledger "$RUN" <id> implement round=<K+1> agent=Impl<NN>r<K+1>` and dispatch a fresh `node-implementer` exactly as in step 5, one item, with `ROUND=<K+1>`, `PREV_PATCH=$RUN/reviews/<id>-r<K>.patch`, and either `PREV_VERDICT=$RUN/reviews/<id>-r<K>.json` or `FENCE_VIOLATIONS=<comma-joined paths>`. Then continue at step 6.
- K = 3: round 4 never starts; go to step 9.

Done when the plan node has a new `implement` line or has reached step 9.

### 9. Rule leftover findings

For a plan node that failed round 3, read each open blocker, major, creep and shrink item against the code and give it one ruling:

- **reviewer wrong**: the code shows the claim false;
- **real, nothing depends on it**: no later plan node's `Consumes:`, fence or acceptance relies on it.

When every item gets one of these rulings, append one line per item to `rulings.md` (`<id> r3 <file:line> <ruling>: <one-line reason>`), run `scripts/ledger "$RUN" <id> ruled round=3 findings=<count>`, then land the round-3 work through step 7 (items 2 to 5) if its fence check was clean.
When any item is real and a later plan node depends on it, or the round-3 fence check failed, run `scripts/ledger "$RUN" <id> blocked round=3`, stop dispatching its dependants, and ask the user how to proceed.

Done when every open item is in `rulings.md` or the user has been asked about it.

### 10. Council

When every plan node is merged, or the user chose to continue past the blocked ones, run the council: dispatch `council-chair`, not isolated, with `RUN_DIR`, `GOAL`, `BRIEF`, `REPO`, `BASE_SHA`, `RUN_BRANCH`, `NEXT_NN` (one above the highest existing plan node number), and `LEDGER` (absolute path to `scripts/ledger`).
The chair writes the `council` and `seat-N` ledger lines itself.

- `verdict: clean`: go to step 11.
- `verdict: fix`: queue each fix plan node with `scripts/ledger "$RUN" <id> queued wave=<next W> deps=<a,b or ->`, append its `Wave W` phase, and run it through steps 5 to 9. When those merge, run the council once more; its verdict is final, and any remaining verified findings go to `report.md`.

Done when the ledger shows a `council done` line after the last merge, and at most two council runs happened.

### 11. Finish

Write `$RUN/report.md` with these sections:

1. `## Result`: goal, `RUN_BRANCH`, `BASE_SHA..RUN_BRANCH`, final council verdict.
2. `## Plan nodes`: one row per plan node with rounds used, outcome (merged, ruled, blocked) and commit range.
3. `## Rulings`: every line of `rulings.md`.
4. `## Nits`: every nit from `reviews/*.json` and `council/verdict.md`.
5. `## Parking`: every line of `parking.md`.
6. `## Cleanup`: the `git branch -D` command for the merged `omp/task/*` branches.

Run `scripts/ledger "$RUN" run done` (or `run blocked -- <reason>` when a plan node stayed blocked), close the `Finish` phase, and give the user the `report.md` path and `RUN_BRANCH`.

Done when `report.md` has all six sections and the ledger's last line is `run done` or `run blocked`.
