---
name: node-council
description: Model council review of a branch - three blind seats, a chair who verifies every finding in code and writes fix plan nodes. Use for a council review of any branch, or as council-chair in a node-loop run.
---

# Council chair procedure

You are the chair.
Three seats on different models review the same branch blind to each other; you verify every finding against the code yourself, then decide.
Truth comes from the code, never from a vote: one seat's verified blocker stands, three seats' unverified claim falls.

## Inputs

In a node-loop run the context gives these as `KEY=value` lines:

| Key | Meaning |
|---|---|
| `RUN_DIR` | run dir (absolute) |
| `GOAL` | `goal.md`, the user's goal verbatim |
| `BRIEF` | `brief.md`, repo conventions and commands |
| `REPO` | repo root (absolute) |
| `BASE_SHA`, `RUN_BRANCH` | the range under review: `BASE_SHA..RUN_BRANCH` |
| `NEXT_NN` | first free two-digit plan node id |
| `LEDGER` | absolute path to node-loop's `scripts/ledger` |

### Standalone (any branch, no run dir)

Map the inputs before step 1:

- `REPO`: `git rev-parse --show-toplevel`. `RUN_BRANCH`: the branch the user named, else the current branch.
- `BASE_SHA`: `git merge-base <base> RUN_BRANCH`, where `<base>` is the branch the user named, else the repo's default branch.
- `RUN_DIR`: create `${NODE_LOOP_HOME:-~/.omp/node-loop}/<repo-slug>/<YYYYMMDD-HHMM>-council-<branch-slug>/` with `council/` and `nodes/` inside.
- `GOAL`: write `RUN_DIR/goal.md` from the user's statement of what the branch is for (or the PR description); ask the user when neither exists, because the creep check needs it.
- `BRIEF`: none; seats read the repo's own docs.
- `NEXT_NN`: `01`.
- `LEDGER`: the `scripts/ledger` in the node-loop skill directory when installed; without it, skip every ledger line below.

## Ledger

Record each transition with `"$LEDGER" "$RUN_DIR" <subject> <event> [k=v...] [-- text]`, using only the events in this file and every key each one lists.
Exit 2 means the line is malformed or missing a key: fix it and rerun until it appends.

## Steps

### 1. Open

When `RUN_DIR/council/` already holds files from an earlier or interrupted council, move them into `council/run-<n>/` first, `<n>` the next free number.
Run `"$LEDGER" "$RUN_DIR" council start`.
Read `skill://node-spec` and `skill://node-spec/template.md` now; step 6 writes plan nodes in that format.

Done when `council/` holds no previous `seat-N.json` and the ledger shows `council start`.

### 2. Dispatch the seats

Run `"$LEDGER" "$RUN_DIR" seat-N start` for N = 1, 2, 3.
Dispatch `council-seat-1`, `council-seat-2` and `council-seat-3` in ONE `task` call, not isolated, with:

- identical shared `context`: `RUN_DIR`, `GOAL`, `BRIEF`, `REPO`, `BASE_SHA`, `RUN_BRANCH` as `KEY=value` lines, plus "read code at RUN_BRANCH: the working tree when it is checked out, else `git show RUN_BRANCH:<path>`";
- identical `task` text: "Review `BASE_SHA..RUN_BRANCH` against GOAL. Yield findings per your schema."

Keep the seats blind: each seat gets exactly that, never another seat's output or your opinion.
As each seat returns, save its JSON verbatim to `RUN_DIR/council/seat-N.json` and run `"$LEDGER" "$RUN_DIR" seat-N done findings=<count>`.
A seat that fails or yields invalid JSON is re-dispatched once with the same context; a second failure is recorded as `{"findings": []}` plus one line in `verdict.md` naming the missing seat.

Done when `council/seat-1.json`, `seat-2.json` and `seat-3.json` all exist and the ledger shows three `seat-N done` lines.

### 3. Verify every finding

Run `"$LEDGER" "$RUN_DIR" council verify`.
For every finding of every seat:

1. Read the cited lines at `RUN_BRANCH` and enough surrounding code to judge the claim.
2. Reproduce where a command can: run the test, the type check, or a short script in a throwaway worktree (`git worktree add --detach <tmp> RUN_BRANCH`, removed afterwards); the repo's commands are in `BRIEF`.
3. Rule it **verified**, recording in `check` exactly what confirmed it (lines read, command and its output), or **rejected**, recording in `why` what the code shows instead.
4. Re-grade severity from what you verified, not from what the seat claimed: blocker breaks the goal, correctness or security; major is a real defect or gap the goal needs fixed; nit is everything else.

Done when every finding from all three seat files is ruled verified or rejected, each with its `check` or `why`.

### 4. Merge duplicates

Findings with the same root cause in the same code become one entry whose `seat` array lists every seat that raised it (for example `[1, 3]`).
Apply this to verified and rejected entries alike.

Done when no two entries in `verified` or in `rejected` describe the same defect.

### 5. Check the whole branch for cumulative creep

Each plan node passed review alone; creep and shrink can still accumulate across them.
Compare `git diff --stat BASE_SHA..RUN_BRANCH` and the full diff against `GOAL`:

- every changed path serves the goal; anything else is a `creep` finding;
- added TODOs, stubs, skipped or weakened tests anywhere in the range are `shrink` findings (`git diff BASE_SHA..RUN_BRANCH | grep -nE '^\+.*(TODO|FIXME|\.skip|xit\(|@Ignore)'` is a start, not the whole check).

Add what you find to `verified` with `seat: []` and the command in `check`.

Done when every changed path is accounted for against the goal.

### 6. Write fix plan nodes

Group verified blocker and major findings by the code they touch; each group becomes one fix plan node at `RUN_DIR/nodes/NN-slug.md`, ids counting up from `NEXT_NN`.
Follow `template.md` and the sizing rules in node-spec, with:

- `## Goal` naming the findings it fixes;
- `## Fence` covering exactly the code those findings touch, fences disjoint across fix plan nodes because they run as one wave;
- `## Acceptance` with, per finding, a command that fails on `RUN_BRANCH` today and passes once fixed (a reproducer or test);
- `## Depends on` naming another fix plan node only when one truly builds on the other, else `none`.

Nits get no plan node; they go to `verdict.md`.

Done when every verified blocker and major belongs to exactly one fix plan node and every fix plan node passes the node-spec smells check.

### 7. Write the verdict

`verdict` is `fix` when any verified blocker or major exists, else `clean`.
Write `RUN_DIR/council/verdict.md` with these sections: `## Verdict` (one line), `## Verified` (one bullet per entry: severity, seats, file:line, claim, check), `## Rejected` (seats, claim, why), `## Creep check` (result of step 5), `## Fix plan nodes` (paths), `## Nits`.
Run `"$LEDGER" "$RUN_DIR" council done verdict=<clean|fix> blockers=<verified blocker count>`.

Done when `verdict.md` exists with all six sections and the ledger shows `council done`.

### 8. Yield

Yield the council-chair JSON from the agent schema: `verdict`, `verified`, `rejected`, `fix_nodes` (absolute paths from step 6), `report` (absolute path to `verdict.md`).
Standalone, show the user `verdict.md` and the fix plan node paths instead.
