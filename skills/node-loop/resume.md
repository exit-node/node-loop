# Resuming a node-loop run

Read by the orchestrator at `SKILL.md` step 2 when the user asks to resume.
The ledger is the only state you trust; files and branches confirm it.

## 1. Pick the run

Use the run dir the user named.
Otherwise take the newest `ledger.md` under `${NODE_LOOP_HOME:-$HOME/.omp/node-loop}/<repo-slug>/*/`, where `<repo-slug>` is the basename of `git rev-parse --show-toplevel`.
Show the user the run id, the first line of `goal.md` and the last ledger line.
A ledger ending in `run done` has nothing to resume: give the `report.md` path and stop.

Done when `RUN` is set and the user has seen which run resumes.

## 2. Restore the checkout

`source "$RUN/meta.env"`, then `git checkout "$RUN_BRANCH"` in `REPO`.
A dirty working tree stops the resume: show `git status --short` and let the user decide.

Done when `RUN_BRANCH` is checked out with a clean tree.

## 3. Replay the ledger

The last ledger line per subject gives its next action.
Agents from the previous session are gone; every re-dispatch is a fresh agent whose name carries a `b` suffix (`Impl02r2b`), because the old `omp/task/<name>` branches still exist.

| Subject | Last event | Next action |
|---|---|---|
| scout | none, or `start` | `SKILL.md` step 3; keep existing `scout/*.md` files and dispatch only the missing areas |
| plan | none, or `start` | step 4 from the dispatch |
| plan | `done` or `revised` | step 4 approval gate: show `plan.md` again |
| plan | `approved` | write any missing `queued` lines, then waves |
| plan node | `queued` | step 5 in its wave |
| plan node | `implement round=K agent=A` | if `omp/task/A` has commits beyond its merge-base with `RUN_BRANCH`, step 6 from item 2 with that branch; otherwise log `implement round=K agent=<new name>` and re-dispatch round K |
| plan node | `review round=K` | if `reviews/<id>-rK.json` exists, step 6 item 6 with it; otherwise step 6 item 5 on the existing package |
| plan node | `pass` or `ruled` | `git cherry "$RUN_BRANCH" <branch>`: lines starting `+` are not landed yet, so run step 7 from item 2; when all lines start `-`, finish step 7 items 4 and 5 that are missing |
| plan node | `fail` or `fence` | step 8 |
| plan node | `merged` | nothing |
| plan node | `blocked` | ask the user, as in step 9 |
| council | `start` or `verify` | step 10: dispatch a fresh chair |
| council | `done` | step 10 verdict handling, or step 11 when this was the second council |

Done when every subject has its next action written down.

## 4. Rebuild the todo list

`init` the full list from the replay: `Scout`, `Plan`, one `Wave W` phase per wave with `<id>: <state>` items, `Council`, `Finish`.
Then mark finished phases and merged items `done` and blocked items `block`.

Done when the todo list matches the ledger; continue at the earliest next action from step 3.
