# Sandbox cache checks: judging the database's read load in the design sandbox

Date: 2026-10-28
Status: draft for review

## Purpose

Cycle 1 (PR #27) added an opt-in `read_load` rule to the canvas engine, a
`cache` role, and one scored challenge per cloud. The design sandbox still
treats its three cache parts as `neutral`: the engine contracts them away, so a
web server linked to a cache is judged as if the cache were not there, and the
sandbox cannot show that a lost or unlinked cache overloads the database.

This cycle switches the sandbox's cache parts to the `cache` role and has the
sandbox's generated checks carry `read_load`, so a learner can practise the
same lesson freely, with feedback and no score.

Out of scope: queues, CDNs, object storage (all stay `neutral`), an editable
layout, mixed-cloud designs, and any change to the cycle-1 challenges.

## Decisions (agreed in brainstorming)

- Reads are judged only when the design contains a cache part. A design with no
  cache gets exactly today's checks and results.
- Once a design has a cache, every generated check carries `read_load` at the
  spike level (3x reads), independent of the check's own capacity test.
- The engine rule is reused unchanged. The sandbox does not compute database
  reads itself.
- The sandbox's cache parts are corrected to say only what each cloud's own
  pages state (provider-docs rule, below).

## Provider-docs rule

Each provider's own documentation is the only source of truth. A capability,
scope or failure behavior documented for one cloud is never assumed for
another. A fact a page does not state is not in the content. This cycle's two
content corrections come straight from that rule:

- **Google Cloud:** the sandbox cache fact says the Basic tier "is a single node
  in one zone". Google's "Redis tier capabilities" page says one Redis node, no
  replication and no cross-zone replication, but does not say "in one zone". The
  zone comes from the "Create and manage Redis instances" page, where you choose
  a zone when you create an instance. The fact is reworded to what those pages
  state.
- **AWS:** "A cache node runs in one Availability Zone" is cited today only to
  the AutoFailover page, which implies it. The "Choosing regions and
  availability zones" page states that each node is placed in one zone, chosen
  by you or by ElastiCache. That page is added to the AWS sandbox's sources and
  the fact reworded to match.
- **Azure:** the Azure cache fact set (high availability gives at least two
  nodes in different zones, asynchronous replication, failover timing) is
  already stated by "Reliability in Azure Managed Redis". It is re-checked
  against the page during implementation, and changed only if a claim is not
  stated.

All wording stays in our own words. The three cycle-1 challenge files are not
touched.

## Design

### Schema (`src/schema/sandbox.ts`)

A sandbox file's extra palette parts may have roles `[neutral]` or `[cache]`.
Any other role list is refused, and the refusal message says which two are
allowed. The cycle-1 palette rule (a `cache` part carries no other role) still
applies through the shared palette item schema. Part scopes do not change:
AWS ElastiCache node zonal, Azure Managed Redis regional, Google Cloud
Memorystore for Redis node zonal, exactly as in the cycle-1 challenges.

`schemas/sandbox.json` is regenerated.

### Content (`content/sandbox/*.yaml`)

In each of the three files, the cache part's `roles` becomes `[cache]` and its
facts are corrected as above. SQS, the CDN and the storage parts stay
`[neutral]`. The sandbox files' `sources` gain any page a changed fact now
relies on, with `retrieved: 2026-10-28`.

### Constants and checks (`src/game/sandbox.ts`)

Two scenario constants sit beside `SPIKE`: `READ_HIT = 0.9` (the share of reads
a live, linked cache answers) and `DB_READS = 1` (the most reads the database
can take, in multiples of normal). They are scenario numbers, not provider
facts, and the learner is told so.

`sandboxChecks()` changes as follows.

- **Gate:** a read-load check applies only when the design contains a `cache`
  part, a `serve` part and a `write-store` part. Reads are then judged by adding
  `read_load: { traffic: SPIKE, hit: READ_HIT, db_capacity: DB_READS }` to every
  generated check's `check` object, including the spike check. This respects the
  schema rule that `read_load` needs both `serve` and `write-store` in `reach`.
- **No cache:** unchanged, byte for byte.
- **Cache but no web server or no database:** the cache is inert and is
  treated exactly as a neutral part is today: contracted away by
  `withoutNeutral()`, never occupying a zone for a "Lose <zone>" check, and
  never getting a "Lose any one cache" check. A design without both a web server
  and a database therefore gets byte-for-byte the checks and results it gets
  now. One helper, `readsJudged(c, d)`, holds the rule (the design has a cache,
  a `serve` part and a `write-store` part), and both the check generator and the
  neutral contraction use it.
- **Zone and region checks:** once reads are judged, a zone holding only a
  cache is occupied (the cache is no longer neutral), so it gets a "Lose <zone>"
  check.
- **"Lose any one cache":** generated only when reads are judged.
- **Labels:** every check that carries `read_load` says so in its label
  ("Lose us-east-1a, reads at 3x"), so the learner sees what is being judged.

`withoutNeutral()` is unchanged. Cache parts are no longer neutral, so they stay
in the judged design and the engine sees the real web-server-to-cache links.
`isNeutral()` still returns true for the remaining neutral parts, and a part
with no roles in the palette stays treated as not neutral (existing behavior).

`runCheck()` and `validateDesign()` need no change: they already evaluate and
replay through the engine and editor rules, and `cache` is already in the role
list.

### Screen (`src/screens/SandboxScreen.tsx`)

- The existing note under the checks currently reads "Queues, caches, CDNs and
  object storage aren't judged by these checks yet." It becomes "Queues, CDNs
  and object storage aren't judged by these checks yet.", and is shown only when
  the design contains a neutral part (as today).
- When reads are judged, a second short note states the two scenario numbers in
  plain words: reads are judged at 3x normal; a linked cache that is up answers
  9 in 10 of that server's reads; the database can read 1x normal. It says these
  are scenario numbers, not measurements.
- When the design has a cache but reads are not judged (no web server or no
  database), a short note says a cache is judged once the design has a web
  server and a database.

### Saved designs and import/export

Designs store part types and links, not roles, so saved and exported designs
load unchanged. A saved design that already contains a cache now gets read-load
verdicts it did not get before. That is expected and needs no migration. The
export/import format does not change.

## Review focus

Inputs the spec implies that a happy path would not exercise:

1. A design with no cache: checks and results identical to before this change.
2. A cache linked from only some web servers: only those servers are shielded,
   and the reason names the others.
3. The only cache in a zone no one named, lost with that zone.
4. A cache but no database, or no web server: the cache is inert, so checks and
   results are identical to the same design without it.
5. A cache linked only from the database, or reached straight from users: it
   shields nothing, and the reason is the cycle-1 reason.
6. A sandbox file whose extra part has `[cache, neutral]`, `[serve]`, or an
   empty role list: refused with a message naming the allowed roles.
7. Multi-region sandbox designs: a cache in one region, web servers in another;
   losing the cache's region.
8. A saved design from before this change that contains a cache: still opens.

## Testing

- `tests/sandbox-roles.test.ts`: `neutral` and `cache` both allowed; other role
  lists refused; the refusal message names the allowed roles.
- `tests/sandbox-checks.test.ts` (or the existing sandbox test file): cases 1
  to 5, 7 and 8 above against each cloud's real sandbox file, with exact reason
  strings for the failing cases.
- A per-cloud test that the sandbox cache part carries `cache`, the right scope
  (AWS zonal, Azure regional, Google Cloud zonal) and cites its own cloud's docs
  host only.
- `tests/sandbox-ui.test.tsx`: the neutral note no longer mentions caches; the
  scenario-numbers note appears only when the gate holds.
- Whole suite, `tsc`, `oxlint`, `npm run schemas`, link check and content load,
  as in cycle 1.
- A browser pass on all three sandboxes (build a checkout with a cache, see the
  read-load reason, link it, rerun, lose a zone and a cache), with seeded test
  progress cleared afterwards.

## Not decided here

Nothing is left open for this cycle. A candidate follow-up from cycle 1 stays
out of scope: the shared async-link reason text in the engine says "could be
missing recent writes", which Google's pages only imply.
