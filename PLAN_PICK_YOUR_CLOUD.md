# Plan: "Pick your cloud" challenges

Status: **approved and built** (P2–P3), with the defaults in §7.

---

## 1. The idea

Today every design challenge is tied to one provider. A "pick your cloud"
challenge has **one brief, one set of stress tests, and one shape of correct
answer**. At the start you choose **AWS, Azure or Google Cloud**, and the
palette, lane names, facts and sources switch to that provider's services.

What it teaches: the *pattern* is the same everywhere ("a synchronous standby in
another zone"), even though the names differ (RDS Multi-AZ, PostgreSQL
zone-redundant HA, Cloud SQL HA). The debrief shows the equivalents side by
side, **and where they genuinely differ**, so the game never implies the
services are identical when they aren't.

---

## 2. Core design decision: resolve, don't rebuild

A multi-provider file is a normal challenge plus **per-provider overlays**. One
pure function turns it into an ordinary single-provider challenge:

```
resolveProvider(multiChallenge, 'azure')  ->  a plain CanvasChallenge (or slot Challenge)
```

Everything downstream is **unchanged**: the canvas and slot engines, screens,
stress-test sequence, scoring and debrief. The new code is the overlay format,
the resolver, a provider picker, and a cross-cloud section in the debrief.

The validator runs the existing checks **once per provider**: reference designs
must pass and counter-examples must fail exactly what they claim, on AWS, Azure
*and* Google Cloud. A difference that breaks a design on one cloud is caught at
build time.

---

## 3. Data model (sketch, canvas mode)

```yaml
type: challenge
mode: canvas
id: zone-resilient-checkout
providers: [aws, azure, gcp]        # replaces `provider: aws`

brief: |
  Shared business story. {provider} and {region} tokens are filled per provider.

layout:                             # abstract lane ids; labels per provider
  regions:
    - id: r1
      zones: [r1-a, r1-b]
labels:
  aws:   { r1: "us-east-1",   r1-a: "us-east-1a",    r1-b: "us-east-1b" }
  azure: { r1: "East US 2",   r1-a: "Zone 1",        r1-b: "Zone 2" }
  gcp:   { r1: "us-central1", r1-a: "us-central1-a", r1-b: "us-central1-b" }

palette:                            # behavior shared across providers...
  - id: db
    scope: zonal
    roles: [write-store]
    cost: 2
    as:                             # ...names and facts per provider
      aws:   { label: "RDS for PostgreSQL instance", short: "RDS", facts: [...] }
      azure: { label: "Azure Database for PostgreSQL flexible server", short: "PostgreSQL", facts: [...] }
      gcp:   { label: "Cloud SQL for PostgreSQL instance", short: "Cloud SQL", facts: [...] }
    differences: |                  # required: what isn't equivalent
      Azure also offers same-zone HA, which doesn't survive a zone outage...

link_facts: { aws: {...}, azure: {...}, gcp: {...} }
sources:    { aws: [...], azure: [...], gcp: [...] }   # every provider fully sourced

stress_tests: [...]                 # shared, labels may use {zone:r1-a}
reference_designs: [...]            # shared (abstract ids), checked on every provider
counter_examples: [...]             # shared, checked on every provider
overrides:                          # optional, only for real, sourced differences
  gcp:
    palette:
      web: { capacity: 3 }          # say, if a provider's component behaves differently
    reference_designs: [...]        # a provider can have its own reference if the shape truly differs
```

- **Shared by default, overridden only where sourced.** If a provider's service
  behaves differently, the override *is* the lesson, and the validator checks
  that provider's designs separately.
- **`differences` is required on every palette item.** Writing "none that
  matter here" is fine. The point is that the author has to think about it.
- The same overlay idea works for **slot challenges** (options with
  per-provider labels and facts).

---

## 4. Player experience

- **Queue:** one card per challenge, with **AWS · Azure · GCP** chips. Chips you've
  completed are ticked.
- **Start:** a provider picker (three large radio buttons, each with a one-line
  description) before the canvas opens. To change provider, restart the challenge.
- **Debrief** adds a **"Same design on other clouds"** table: each component in
  your design next to its equivalents, plus the authored `differences` notes and
  each provider's doc links.
- **Progress:** one entry per challenge (best score across providers, so replays
  still only earn improvement), plus a new optional `providers` list for the
  ticked chips. Old saves stay valid.

---

## 5. Milestones

| # | Deliverable | Done when |
|---|---|---|
| P1 | This plan | You approve it |
| P2 | Overlay schema, `resolveProvider()`, per-provider validation, provider picker, progress chips; one canvas challenge on all three clouds ("zone-resilient checkout", mostly reusing already-verified sources) | Tests and build pass; a design that fails on only one provider breaks the build; playable on all three |
| P3 | Cross-cloud debrief table; slot-mode overlays; one slot challenge (a static-content spike using CloudFront / Front Door / Cloud CDN, with new sources); template + AUTHORING section | Both modes playable on all three providers; docs updated |

About half the size of the canvas work, because the resolver keeps every
existing engine and screen as-is.

---

## 6. Risks

- **False equivalence**, the big one. Guard: required `differences` notes,
  per-provider sources, and sourced overrides for real behavioral differences.
  The debrief shows differences next to the equivalents, never hidden.
- **Brief wording that only fits one cloud.** Guard: `{provider}`, `{region}` and
  `{zone:…}` tokens, and the validator fails on unresolved tokens.
- **Authoring effort** (three sets of facts and sources). Guard: shared behavior
  written once; overlays hold only names, facts and sources.

---

## 7. Open questions (my default in **bold**)

1. **Resolve to the existing format** (no engine or screen changes). **Yes.**
2. **Pick the provider at the start**; to switch, restart. **Yes.**
3. **One progress entry per challenge** (best score across providers, no extra XP for replaying on another cloud) plus ticked provider chips. **Yes.** The alternative is separate XP per provider, which would inflate ranks.
4. **Allow per-provider overrides only for sourced, real differences**, validated per provider. **Yes.**
5. **Canvas first (P2), slot mode in P3.** **Yes.**
6. **Existing single-provider challenges stay as they are.** **Yes.**
