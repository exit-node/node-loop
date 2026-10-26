---
name: node-spec
description: Plan node spec for node-loop - what a plan node is, its fence, sizing rules and smells. Use when writing, sizing, implementing or reviewing a `nodes/NN-slug.md` plan node.
---

# Plan node spec

The single definition of a plan node, shared by the planner (writes them), the implementer (builds one), the reviewer (judges one) and humans (approve the plan).
File format: [`template.md`](template.md) in this skill directory.

## What a plan node is

A plan node is the smallest change one fresh agent can implement and one reviewer can pass or fail from the diff alone.
"Fresh" means the agent starts with only `brief.md`, its plan node file, and the `contracts.md` sections of its dependencies.
Write every plan node so that context is enough.

Always say "plan node" or `nodes/NN-slug.md`, never bare "node", so nobody reads it as Node.js.

## Terms

- **fence**: the paths a plan node owns (`## Fence`) plus its `## Out of scope` list. The implementer changes only fenced paths; `scripts/fence-check` lists every changed path outside it.
- **creep**: a change the plan node did not ask for, inside or outside the fence. Ideas that occur along the way go to `parking.md`.
- **shrink**: a stub, a TODO, a weakened or skipped test, or an unmet acceptance item.
- **kickback**: a failed review or fence check; a new, fresh implementer redoes the plan node from the previous `.patch`.
- **wave**: the set of plan nodes whose dependencies have all merged; they run in parallel.

## Fence syntax

One `- ` list item per path under `## Fence`; the first token is the path, anything after it is a note.

- `path/exact.ts` matches that file.
- `src/auth/` (trailing slash) matches everything below the directory.
- `src/**/*.test.ts` is a bash pattern where `*` also matches `/`.

Fence new files too: a file the plan node creates needs its path in the fence.
Generated files the change produces (lockfiles, snapshots, migrations) belong in the fence of the plan node that produces them.

## Sizing rules

1. **Tracer bullet first.** Prefer a thin vertical slice through every layer that works end to end over a horizontal layer that works only once later plan nodes land.
2. **Contract first.** When several parallel plan nodes consume the same new types, schema or interface, put that contract in its own plan node in an earlier wave; its `Exposes:` line is what the others build against.
3. **One fresh context.** The implementer can hold the plan node, the brief, the dependency contracts and every fenced file at once.
4. **One-pass diff.** The reviewer can judge the diff in one read; the rough bar is under ~400 changed lines, excluding generated code.
5. **Ends green.** After the plan node merges alone, the build and the existing tests pass; every acceptance command passes.
6. **Disjoint fences per wave.** No path matches the fences of two plan nodes in the same wave, so their branches cherry-pick onto the run branch without conflict.

## Acceptance

Each `## Acceptance` item is one checkable statement plus the exact command that proves it, as in the template.
The reviewer runs those commands; an item without a command is judged by reading the diff, so reserve that for statements a diff answers directly ("no new public export in `src/index.ts`").

## Smells

A plan node with any of these smells gets split, merged or rewritten before the plan is approved:

- An acceptance item needs "and" more than twice: it is several plan nodes.
- Its fence overlaps a plan node in the same wave: move the shared path into an earlier contract plan node or serialise the two.
- An acceptance item cannot be checked ("works well", "is clean", "handles errors properly"): rewrite it as an observable outcome with a command.
- It only makes sense together with another plan node (neither can merge alone and stay green): merge them, or cut a contract plan node both depend on.
- Its `Consumes:` names an interface no dependency `Exposes:`: add the dependency or the missing contract plan node.

## Done when

- Planner: every plan node file follows `template.md`, passes every sizing rule, and shows none of the smells.
- Implementer: every acceptance item is checked off with its command's result in `reports/NN-slug.md`, and every changed path is inside the fence.
- Reviewer: every acceptance item, the fence, creep and shrink are judged against the diff, each with evidence.
