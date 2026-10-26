# NN-slug: <one-sentence goal>

<!--
Plan node file: nodes/NN-slug.md in the run dir.
NN is two digits, ordered by wave then dependency; slug is lowercase [a-z0-9-].
Keep the headings below exactly as written and in this order; scripts and agents parse them.
Delete these comments when filling the template.
-->

## Goal

<!-- Two to five sentences: what changes and why, in terms a fresh agent with only brief.md can act on. -->

## Fence

<!--
One "- " item per owned path. The first token is the path; the rest of the line is a note.
fence-check reads only these first tokens.
Include files this plan node creates.
-->
- path/exact.ts            exact file
- src/auth/                directory prefix: everything below
- src/**/*.test.ts         bash pattern; * also matches /

## Out of scope

<!-- Nearby work a reader might expect here that belongs to another plan node or to nobody. One "- " item each, naming the owner plan node when there is one. -->
- <nearby work> (owner: NN-slug or nobody)

## Contract

<!--
Consumes: interfaces taken from dependencies' sections in contracts.md, by name and signature.
Exposes: interfaces later plan nodes build against, by name and signature. On merge this line is appended to contracts.md.
Write "none" when there is nothing.
-->
Consumes: none
Exposes: none

## Acceptance

<!-- One checkable statement per item, each with the exact command that proves it. The reviewer runs these commands. -->
- [ ] checkable statement - `exact command proving it`

## Depends on

<!-- Comma-separated plan node ids, or "none". -->
none
