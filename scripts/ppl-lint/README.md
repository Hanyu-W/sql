# PPL lint rule validation

A cross-repository GitHub Actions check that proves the OpenSearch Dashboards
(OSD) PPL lint detectors and runtime syntax validation still agree with the SQL
backend on the **same candidate runtime grammar** built by a SQL pull request.

PPL language behavior lives in SQL; PPL lint detectors live in OSD. A SQL change
can silently invalidate an OSD rule (a parser refactor stops a detector matching,
or a semantic change makes a flagged query valid) without touching OSD. Neither
repository's own unit tests catch that. This check does.

- **Design:** `ppl-lint-ci-validation-design.md`
- **Analytics rollout:** [`docs/dev/ppl-lint-analytics-engine-ci-validation.md`](../../docs/dev/ppl-lint-analytics-engine-ci-validation.md)
- **Workflow:** [`.github/workflows/ppl-lint-rule-validation.yml`](../../.github/workflows/ppl-lint-rule-validation.yml)
- **Contracts:** [`integ-test/src/test/resources/ppl-lint/contracts/`](../../integ-test/src/test/resources/ppl-lint/contracts)

## The pipeline

Three jobs run in a line; artifacts are the only bridge between them.

```
backend-validation ──(target.json, ppl-grammar-bundle.json, backend-report.json)──▶
    detector-validation ──▶ validation-result (the single required check)
```

1. **backend-validation** (OpenSearch CI container). Builds the SQL PR, starts
   the Gradle test cluster, runs each contract's trigger/control queries against
   `POST /_plugins/_ppl`, and — while the cluster is alive — exports:
   - `ppl-grammar-bundle.json` — the candidate runtime grammar (`GET /_plugins/_ppl/_grammar`);
   - `target.json` — schema-v2 engine, grammar, execution-backend, storage, and route identity;
   - `backend-report.json` — the observed HTTP behavior and execution backend per query.
2. **detector-validation** (`ubuntu-latest`). Checks out and bootstraps OSD as a
   Node code dependency (no OSD server, no Monaco, no browser), then runs
   [`run-frontend-contract.mjs`](run-frontend-contract.mjs). That runner
   deserializes the candidate bundle through OSD's production headless APIs and
   runs each query with either the real lint detectors or the shared runtime
   syntax listener on the **candidate** grammar. It then asserts the
   frontend-vs-backend differential.
3. **validation-result**. `if: always()`, `needs: [backend-validation,
   detector-validation]`. Fails unless both succeeded — so a skipped detector
   (because the backend failed first) still reds the check instead of looking
   green. It writes the per-rule PR summary and uploads `run-manifest.json`. This
   is the **only** job repo admins pin to branch protection.

## Workflow inputs and modes

| Trigger | Mode | OSD ref | Enforcing? |
| --- | --- | --- | --- |
| `pull_request` | SQL PR validation | `main` | **Yes** — the required check |
| `workflow_dispatch` (`osd_ref`) | OSD-branch evidence | the given commit/branch | No — pre-merge evidence only |
| `schedule` (nightly) | full corpus + coverage | `main` | No |

The required PR corpus contains 12 detector contracts. The nightly mode runs
the same active corpus plus four dormant report-only contracts across the
supported version and execution-backend matrix.

`workflow_dispatch` inputs:

- `osd_repo` — the OSD repository to check out, for validating an unmerged change
  that lives on a fork. Defaults to `opensearch-project/OpenSearch-Dashboards`.
  The `osd_ref` must exist in this repo (a purely local commit cannot be fetched).
- `osd_ref` — an OSD commit or branch to validate instead of `main`. Resolved to
  an immutable commit SHA and recorded in the run manifest. A manual run **cannot**
  satisfy branch protection; merge the OSD change first, then rerun the required
  `pull_request` check against OSD `main`.
- `schedule` — `pr` (reviewed blocking contracts) or `nightly` (all active contracts).

To validate an OSD change that is not yet merged, push it to a branch on your OSD
fork and dispatch with `osd_repo=<you>/OpenSearch-Dashboards` and
`osd_ref=<branch-or-sha>`.

## Local reproduction

From the SQL checkout:

```bash
# Backend IT (exports the bundle) then detector check against OSD main.
./scripts/ppl-lint-rule-validation.sh

# Reuse an already-bootstrapped OSD checkout.
OSD_SOURCE_PATH=../OpenSearch-Dashboards ./scripts/ppl-lint-rule-validation.sh

# Reproduce a specific CI run's OSD revision (from run-manifest.json).
OSD_REF=<osdSha> ./scripts/ppl-lint-rule-validation.sh

# Full nightly corpus + coverage assertion.
PPL_LINT_SCHEDULE=nightly ./scripts/ppl-lint-rule-validation.sh

# Run the corpus through the full composite/Parquet + DataFusion stack.
# The published default stack is Linux/x64; other platforms need compatible
# local plugin artifacts and -PnativeLibPath.
RUN_ANALYTICS=1 ./scripts/ppl-lint-rule-validation.sh

# Use locally built analytics plugins (all trailing arguments pass to Gradle).
RUN_ANALYTICS=1 ./scripts/ppl-lint-rule-validation.sh \
  -PanalyticsEngineZip=/path/to/analytics-engine.zip \
  -PnativeLibPath=/path/to/native/release

# Re-run only one half (detector needs the backend artifacts to exist).
SKIP_DETECTOR=1 ./scripts/ppl-lint-rule-validation.sh
SKIP_BACKEND=1  ./scripts/ppl-lint-rule-validation.sh
```

The backend half writes `ppl-grammar-bundle.json`, `target.json`, and
`backend-report.json` to the SQL repo root; the detector half consumes them and
writes `detector-report.json`.

### Runner environment contract

`run-frontend-contract.mjs` is run from inside the OSD checkout with
`node -r ./src/setup_node_env` and reads:

| Env var | Meaning |
| --- | --- |
| `PPL_LINT_CONTRACT_DIR` | directory of `*.spec.json` + `manifest.json` |
| `PPL_LINT_SCHEDULE` | `pr` or `nightly` |
| `PPL_LINT_GRAMMAR_BUNDLE` | candidate `ppl-grammar-bundle.json` (required; no compiled fallback) |
| `PPL_LINT_TARGET_MANIFEST` | schema-v2 `target.json` (engine, grammar, execution backend, and storage identity) |
| `PPL_LINT_BACKEND_REPORT` | `backend-report.json` (enables the differential) |
| `PPL_LINT_REPORT` | where to write `detector-report.json` |
| `PPL_LINT_CONTRACT_FILE` | (optional) run a single spec instead of the dir |

## Contract format (schema v3 and v4)

One JSON file per rule or syntax feature under `contracts/`, listed in
`manifest.json`. Each file has `channel: "lint"|"syntax"` (missing defaults to
`lint`), a top-level `queries` map, and version-scoped `expectations[]`.
`suppression-control` is syntax-only: the frontend must retain a raw syntax error
without producing the contracted friendly rewrite.

```jsonc
{
  "schemaVersion": 4,
  "ruleId": "union-min-datasets",
  "channel": "lint",
  "grammarSurface": "runtime-bundle",
  "schedule": "pr",
  "wiring": { "detector": "union-min-datasets", "enabled": true, "severity": "error", ... },
  "backendFixture": { "indices": ["ACCOUNT"], "clusterSettings": { "calcite": true, "calciteFallback": false } },
  "frontendContext": { "isCalcite": true },
  "index": "opensearch-sql_test_index_account",
  "queries": {
    "union-single-dataset":       { "role": "trigger", "query": "| union [ source={{index}} ]" },
    "union-two-datasets-control": { "role": "control", "query": "| union [ source={{index}} ] [ source={{index}} ]" }
  },
  "expectations": [
    {
      "version": ">=3.7.0",
      "engine": "calcite",
      "queries": {
        "union-single-dataset": {
          "frontend": { "count": 1, "severity": "error" },
          "backends": {
            "standard": { "kind": "rejection", "httpStatus": 400, "body": { "status": 400, "error": { "type": "IllegalArgumentException" } } },
            "analytics": { "kind": "rejection", "httpStatus": 400, "body": { "status": 400, "error": { "type": "IllegalArgumentException" } } }
          }
        },
        "union-two-datasets-control": {
          "frontend": { "count": 0 },
          "backends": {
            "standard": { "kind": "result-shape", "httpStatus": 200, "expect": { "datarowsNonEmpty": true } },
            "analytics": { "kind": "result-shape", "httpStatus": 200, "expect": { "datarowsNonEmpty": true } }
          }
        }
      }
    }
  ]
}
```

Legacy lint expectations using `detectorCount`, `severity`, and `matchMessage`
normalize to the same internal frontend oracle. Syntax expectations use
`frontend.code`, `fixText`, `rawMessage`, and `totalErrors`.

Schema v3's `backend` is read only as `backends.standard`; it is never an
implicit analytics oracle. Schema v4's `backends` selects the configured
`standard` or `analytics` execution backend. Missing analytics oracles are
recorded as unscored coverage during observation, including the raw backend
response needed to review a schema-v4 oracle, and are fatal before promotion to
the required check. The selected expectation must contain exactly the same query
names as the top-level `queries` map.

Each backend `kind` is one of `rejection` (contracted 4xx + error type/reason),
`result-shape` (200 with datarow expectations), or `advisory` (soft 200-only
oracle). `not-applicable` requires a reason, owner, and tracking issue. When a behavior
changes in a new version, keep **both** version-scoped
expectations so the nightly matrix proves the rule still fires on the old version
while the candidate check proves the fix on the new one.

### Pitfall: do not write pipe-first (`| command …`) trigger queries

The detector half and the backend half must run the **byte-identical** query
(design's "Same queries" requirement). OSD's runtime lint path prepends a
synthetic `source=t ` prefix to any query that starts with a pipe, so linting
`| union [ source=idx ]` actually parses `source=t | union [ source=idx ]` — a
valid *mid-pipeline* union whose implicit upstream dataset makes the detector
stay silent. The backend, receiving the raw pipe-first query, still rejects it.
The two halves then disagree even though nothing is wrong. Write triggers in a
**query-initial** form (`union [ source=idx ]`, `multisearch [ search source=idx ]`)
that both sides accept verbatim. Until SQL emits `pipeStartRuleIndex` in the
grammar bundle (design §6, D-pipe), a pipe-first trigger with a distinct start
rule cannot be validated end to end.

### The enforced set

`manifest.json` partitions the corpus:

- `enforced` — the six reviewed detector error contracts with deterministic
  backend behavior.
- `defaultError` — every rule that ships **enabled at error severity** in OSD's
  `rules_catalog.json`; it contains exactly six detector rules.
- `requiredSyntaxFeatures` — reserved for future syntax compatibility contracts;
  currently empty.
- `nonEnforcing` — oracle-quality classification for warning, info, advisory,
  and result-shape contracts. Scheduling determines whether a contract runs.
- `dormantContracts` — four preserved default-off detector contracts. They do
  not count as active shipping coverage and explicitly force-enable their rule.

The `enforced` / `nonEnforcing` split describes **oracle quality and review
status, not blocking behavior**.

## Multi-version validation

The check above validates **one** engine: the build from the PR. But a lint rule
ships to every user, and each user's cluster is on whatever version they run. A
rule that is correct on `main` can be a false positive on 3.6 or a false negative
on 3.7, and the single-version check cannot see it.

[`ppl-lint-multiversion-validation.yml`](../../.github/workflows/ppl-lint-multiversion-validation.yml)
validates every `defaultError` rule against several engine versions at once, and
reports **what to change in the linter** when one disagrees.

```
observe (matrix: released images + pr-build standard + pr-build analytics)
    └── each leg exports the same 4 artifacts as the single-version check
detect (one OSD bootstrap, one detector pass per leg's grammar)
    └── aggregate-versions.mjs → drift-report.json + remediation report
```

Released legs run the official `opensearchproject/opensearch:<version>` image,
which bundles the matching `opensearch-sql` plugin, so no old branch is built. The
`pr-build` leg is the same Gradle test cluster the single-version check uses. The
`pr-build-analytics` leg installs the full Arrow, analytics, composite, Parquet,
Lucene-backend, and DataFusion-backend stack and fails unless fixture settings,
explain output, and a profiled canary attest the route. These legs
run the **same** contract oracle (`PplLintRuleValidationIT`) with
`-Dppl.lint.observe.only=true`, which records real behavior instead of asserting
against expectations — on an older engine a mismatch is the signal being
collected, not a broken run.

**Engine floor: 3.6.0 — for the runtime-bundle surface.**
`GET /_plugins/_ppl/_grammar` landed in #5162, which is an ancestor of 3.6 but not
3.5, so a 3.5 leg cannot export a grammar bundle for the detectors to lint against.

### The two grammar surfaces

OSD ships lint on **two** surfaces, and a user gets whichever one their session
resolves to (`lintRuntimePPLQuery`):

| Surface | When the product uses it | Engine floor |
| --- | --- | --- |
| `runtime-bundle` | the engine exported a grammar bundle and it has loaded | 3.6.0 |
| `compiled-simplified` | no bundle — no dataset selected, engine below 3.6, or bundle not yet loaded | none |

The compiled surface is not a degraded copy of the runtime one: it runs detector
logic the runtime path does not (`field_validation`'s text-side pass keys off
`grammarSurface === 'compiled-simplified'`). It is also the surface with no engine
floor, so it is where old-engine coverage is possible at all.

`PPL_LINT_SURFACE` selects which surface a detector run validates. It defaults to
`runtime-bundle`, so the required check is unchanged, and the compiled surface is
an **explicit opt-in** — never a silent fallback. A missing bundle on the runtime
surface stays a hard failure, because quietly linting OSD's own grammar instead of
the candidate would validate the wrong thing.

**`runtimeOnly` rules do not run on the compiled surface.** `lint_runner` skips
them (the productions they walk are absent from the compiled grammar), so a
compiled leg reports them `not-applicable` rather than as zero diagnostics. This
distinction is load-bearing: counted as zero, a healthy rule would classify as
`detector-silent` drift and send someone to "fix" it. In the summary table those
cells read `n/a (surface)`, and a rule whose every case is inert is `n/a` — not
`agree` (it proved nothing) and not `inconclusive` (nothing went wrong, and there
is nothing to re-run).

Two legs may share an engine version while validating different surfaces, so the
matrix is keyed on the **leg label**, grammar surface, and execution backend, not
the version alone.

Each contract declares the surface(s) it was verified against, and a contract is
only scored on a matching leg — `"both"` opts into either. Judged on a surface it
never claimed, every verdict is meaningless: a runtime-bundle contract on a
compiled leg yields both `version-scope-too-narrow` ("the engine rejects but the
rule is scoped away") and a coverage hole, each about a surface the contract does
not describe. Contracts declaring `"both"` are what a pre-3.6 leg can actually
validate; the rest report `n/a (surface)`.

**Compiled-surface legs run nightly** (`COMPILED_ENGINE_VERSIONS`, default
`2.19.0` / `3.0.0` / `3.5.0`) — three more engine images is too slow for every PR.
Dispatch with `compiled_versions` to run one ad hoc, or `[]` to skip. Their observe
job omits `-Dppl.lint.grammar.bundle` (the IT then exports nothing) and writes a
`surface` marker file, which is what tells the detect job to lint them on the
compiled surface rather than treating a missing bundle as a failed export.

```bash
# A compiled-surface leg: no grammar bundle needed, so any engine version works.
PPL_LINT_SURFACE=compiled-simplified \
PPL_LINT_CONTRACT_DIR=<contracts> \
PPL_LINT_TARGET_MANIFEST=<leg>/target.json \
PPL_LINT_SCHEDULE=nightly \
PPL_LINT_REPORT=<leg>/detector-report.json \
node -r ./src/setup_node_env <sql>/scripts/ppl-lint/run-frontend-contract.mjs
```

This workflow is **non-enforcing for now**: it reports and uploads, while the
required check stays the single-version `validation-result`. Promoting it needs a
green baseline across the whole matrix first, so a rule that has already drifted
on 3.6 does not block every unrelated PR on day one.

### What a drift report tells you

Every finding names a drift class, the evidence, and one remediation action:

| Action | When | What you change |
| --- | --- | --- |
| `version-scope-rule` | the engine relaxed (or never had) the behavior on some versions | `appliesTo.minVersion` / `maxVersion` in `rules_catalog.json` — or `enabled: false` if no supported engine rejects it any more |
| `update-detector` | the detector regressed, went too broad, or its grammar anchor was renamed | the rule's detector `.ts` (named in the finding) |
| `update-contract` | the linter is right and only the pinned expectation is stale | the `expectations[]` entry for that version |
| `align-execution-backends` | standard and analytics disagree for the same SQL version and grammar | reconcile the detector with both routes or add a reliable backend signal to OSD |

Drift classes: `grammar-rule-missing` (a parser rule the detector walks was
renamed or removed — the finding names the closest current rule names),
`engine-relaxed` / `engine-partially-relaxed` / `engine-tightened` (the engine's
verdict flipped), `engine-message-changed` (same verdict, reworded error),
`detector-silent` / `detector-noisy` (false negative / false positive),
`version-scope-too-narrow` (the engine rejects but the rule is scoped away from
that version, so users see no diagnostic), `execution-backend-divergence` (same
version, different route verdict), and `severity-mismatch`. Backend divergence
never recommends changing a version range.

#### Full vs partial relaxation: scope the rule, or narrow the detector?

When an engine starts accepting a query a rule flags, the fix depends on a question
a single query cannot answer: is the behavior **fully** gone on that version, or
only **partially**?

- **Every trigger relaxed** → `engine-relaxed`, action `version-scope-rule`. Nothing
  the rule claims is still true on that engine, so bound it with `maxVersion`.
- **Some triggers relaxed, others still rejected** → `engine-partially-relaxed`,
  action `update-detector`. The engine fixed *part* of the condition. Scoping the
  rule away here would drop the diagnostics that are still correct, converting a
  partial engine fix into a shipped **false negative**. Narrow the detector so it
  stops matching the now-valid shapes while still flagging the rest.

This is decided per rule, not per query: the aggregator collects every trigger's
engine verdict for a rule on a leg, then emits **one** rule-level finding that
supersedes the per-query ones. A trigger with no verdict is counted as neither —
treating it as "still rejects" would let a timed-out leg masquerade as a partial fix
and send someone to narrow a healthy detector.

The evidence always states the tally (`2 of 3 observed trigger(s) relaxed`), and a
rule with only one pinned trigger gets an explicit warning that a "fully relaxed"
verdict rests on a single observation. That is the gap the discovery corpus below
closes.

Three hard guards keep the check from passing vacuously. The shipping census is
also recorded, but remains report-only until the paired OSD default-alignment
change lands:

- A rule that is default-error in OSD's catalog but has no contract file is
  reported in the shipping census. The detector runner records the catalog's
  default-error census in `detector-report.json`, and the aggregate step compares
  it against `manifest.defaultError`. This becomes blocking when census
  enforcement is enabled after OSD defaults are aligned.
- A leg whose artifacts are missing is a hard failure, never a silently dropped
  version. The aggregate step also checks that every version the plan asked for
  produced a report, so a dead observe job cannot shrink the matrix into a green
  "agrees with all N versions".
- A case with no engine verdict (a transport failure, recorded by the IT as
  `outcome: "error"`) is **not** read as acceptance. Coercing it would report a
  timeout as an engine that now accepts the query — and advise disabling a
  perfectly good rule. Likewise, a contract whose fixture index failed to seed is
  reported as unusable rather than as a stream of `IndexNotFoundException`
  verdicts.
- A rule whose every case was uncomparable is reported `inconclusive` and **fails**
  — it proved nothing. Inconclusive findings say "check that leg's logs and re-run",
  never "edit the rule", because the linter is not what went wrong.

A rule that is out of scope on an engine (`appliesTo` excludes it) and that the
engine also accepts is reported as `n/a (out of scope)`, not as drift — that is
the version window working. But if the engine *rejects* the trigger there, it is
`version-scope-too-narrow`.

### Where a failure shows up in the GitHub UI

Every finding is emitted twice, because the run page and the diff are two
different places a developer looks:

1. **Annotations** (top of the run page, and inline on the file in *Files
   changed* when the contract is part of the PR's diff). Each carries the drift
   class, the rule, the engine version, and the one-line action. An
   `update-contract` finding anchors on the exact `expectations[]` entry whose
   `version` range produced it — not the top of the file — so the drift appears on
   the line that caused it. Rule-wide findings (a renamed grammar rule) anchor on
   the contract's `ruleId` instead.
2. **The job summary** — the rule × version table plus the full grouped
   remediation report, which stays the authoritative account.

The required single-version lane follows the same rule: frontend and backend
failures with a `[rule/query]` identity anchor on that contract's `ruleId`.
An individual detector/query execution error is recorded as an `error` row and
does not stop the remaining contracts from running or prevent
`detector-report.json` from being uploaded. The required check still fails after
the complete report is written, with the failing rule/query named directly.
Shipping-census findings anchor on `manifest.json` and remain report-only until
the paired OSD default-alignment change lands. Artifact and job failures without
a trustworthy repository location remain file-less rather than pointing at a
guessed line.

Without the annotations the only thing above the summary is `Process completed
with exit code 1`, so the natural next click lands in raw job logs rather than the
remediation. Severity is not cosmetic:

| Finding | Level | Why |
| --- | --- | --- |
| enforced drift, coverage hole | `error` | a shipped default-error rule disagrees with a supported engine |
| non-enforced drift | `warning` | reported, but it does not block |
| `inconclusive` | `warning` | "we could not check" is a leg problem; the run is already red from the exit code, and rendering it as an error invites editing a rule because a leg timed out |
| unvalidated default-error rule | `error` (no file) | the edit goes in `manifest.json`, not a contract |

A line number is emitted only when it is unambiguous. If a contract pins the same
version range twice, or the range cannot be found, the annotation carries the file
and no line — a wrong line sends the reader to edit the wrong expectation, which
is worse than making them find it.

### Running the multi-version check locally

Each leg needs a reachable cluster. Point the observe step at any running engine:

```bash
# Observe one engine (repeat per version into its own leg dir).
mkdir -p legs/3.7.0
./gradlew :integ-test:integTestRemote \
  --tests org.opensearch.sql.calcite.remote.PplLintRuleValidationIT \
  -Dtests.rest.cluster=localhost:9200 \
  -Dppl.lint.schedule=nightly -Dppl.lint.observe.only=true \
  -Dppl.lint.report=$PWD/legs/3.7.0/backend-report.json \
  -Dppl.lint.grammar.bundle=$PWD/legs/3.7.0/ppl-grammar-bundle.json \
  -Dppl.lint.target=$PWD/legs/3.7.0/target.json

# Observe the PR build through composite/Parquet + DataFusion.
mkdir -p legs/pr-build-analytics
./gradlew :integ-test:analyticsEnginePplLintIT \
  -Dppl.lint.schedule=nightly -Dppl.lint.observe.only=true \
  -Dppl.lint.report=$PWD/legs/pr-build-analytics/backend-report.json \
  -Dppl.lint.grammar.bundle=$PWD/legs/pr-build-analytics/ppl-grammar-bundle.json \
  -Dppl.lint.target=$PWD/legs/pr-build-analytics/target.json

# Lint each leg's grammar from an OSD checkout (writes detector-report.json),
# then compare every version at once:
node scripts/ppl-lint/aggregate-versions.mjs \
  --contracts integ-test/src/test/resources/ppl-lint/contracts \
  --leg 3.6.0=legs/3.6.0 --leg 3.7.0=legs/3.7.0 \
  --out drift-report.json
```

The classifier is pure and has no cluster or OSD dependency, so its tests run
anywhere:

```bash
node --test "scripts/ppl-lint/__tests__/*.test.mjs"
```

## Discovery corpus (harvested, never enforced)

The required corpus is hand-pinned, which is what lets a mismatch red the build.
The `discovery` job builds a larger unpinned corpus to distinguish full engine
fixes from partial behavior changes.

```
harvest-queries.mjs ──▶ discovery-corpus.json ──┬──▶ run-frontend-contract.mjs ──▶ detector report
                        + discovery-specs/      └──▶ probe-discovery-backend.mjs ─▶ backend report
                                                                    │
                                                     label-discovery.mjs ──▶ findings + trigger coverage
```

1. **Harvest.** `harvest-queries.mjs` extracts PPL literals from OSD's own lint test
   suite and attributes each to the rule whose `describe(...)` block encloses it
   (matched as a prefix, so `describe('rex-scan-cost (compiled surface)')` counts).
   A query with no rule-owning ancestor is recorded unattributed and dropped rather
   than guessed at. Indices are rewritten onto the fixture index; JS string escapes
   are unescaped so the query matches what the test actually linted. The harvested
   corpus is substantially larger than the curated 12-contract required corpus.

   Each file's **lint context** is harvested alongside its queries. Seven of the
   nineteen rules are `needsContext: true` and self-suppress without a `typeMap`, so
   harvesting queries alone produced 26 `rex-scan-cost` queries and zero triggers —
   the detector never ran, which in the report is indistinguishable from a rule that
   fired on nothing. The context is taken from the test file (its `typeMap`,
   `disabledObjectFields`) because its author wrote it to make exactly those queries
   fire; a hand-written substitute would be a guess about which field types each
   query depends on, and a wrong guess silently suppresses the detector again. A rule
   tested under two different contexts gets two spec files rather than a merged one.

   A **wildcard** source is deliberately not remapped: `wildcard-source-zero-match`
   exists to flag a pattern matching no visible index, so rewriting `source=\`nope-*\``
   to a concrete index destroys the only thing it detects.
2. **Observe both halves.** `--specs-out` writes the corpus as ordinary spec files so
   the **existing** detector runner produces real diagnostic counts with no changes to
   it; a non-zero exit is expected there and ignored, because the generated
   expectations are placeholders. `probe-discovery-backend.mjs` sends each query to
   `POST /_plugins/_ppl` directly — no Gradle, no test cluster, since there is
   nothing to assert.
3. **Label and report.** `label-discovery.mjs` derives each role from real detector
   output (fired → trigger, silent → control) and reports disagreements.

Roles are derived; **expectations never are**. An auto-derived expectation could only
confirm current behavior, locking in whatever the detector does today including its
bugs. Promotion into the enforced corpus stays a human writing a spec entry.

### What it reports, and how much to trust it

| Detector | Engine | Reported as |
| --- | --- | --- |
| fires (error/warning) | accepts | `possible-false-positive` — nearly conclusive |
| fires (**info** only) | accepts | nothing — advisory rules are never contradicted by acceptance |
| silent | rejects | `possible-false-negative` — weak, verify first |
| either | no verdict | nothing; the query is labelled but claims nothing |

The asymmetry is deliberate. A query the engine *ran* successfully but the linter
called broken is unambiguous. A rejection may be for a reason unrelated to the rule,
so rejections matching an unknown field, a missing index, an unsupported command, or
a syntax error are **suppressed** rather than reported — without that filter every
harvested query naming an invented field becomes a finding and buries the real ones.
Suppression never applies to the false-positive side.

Advisory (`info`) rules are the other exclusion, and it was found by running this
against a live 3.8 engine: `head-without-sort` and `rex-scan-cost` flag
non-determinism and scan cost, which the engine executes happily and will never
reject. For those, "accepted + flagged" is the rule working as designed. Severity is
the discriminator because it already encodes the claim — only an error/warning rule
asserts the engine will refuse the query, and only such a claim can be contradicted
by acceptance. The judgement uses the severities the detector actually emitted, so a
mixed-severity diagnostic is still reported.

The report also prints per-rule trigger counts and whether each rule has enough
(≥2) to support a scope decision. That table is the direct input to the full-vs-partial
question above: a rule showing **1 trigger** cannot distinguish the two, and a rule
showing **0** was not observed at all.

Measured on the compiled surface against OSD `main`, this yields **41 triggers with
9 of 12 rules at ≥2**. The three that remain at one trigger are at the ceiling of
what OSD's tests contain — `agg-on-text`, `wildcard-source-zero-match` and
`unsupported-window-function-in-eventstats` each have exactly one trigger written
there, and their other queries are genuine controls (`stats avg(balance)` on a
numeric field is valid; `row_number` is the one window function eventstats
supports). Raising those needs queries nobody has written yet — the point where
generation, rather than harvesting, is what adds coverage.

The job prefers the **runtime-bundle** surface, exporting the engine's grammar via
`GET /_plugins/_ppl/_grammar` and falling back to the compiled surface (with a
warning) if that fails. The runtime surface matters because `lint_runner` SKIPS the
four `runtimeOnly` rules on the compiled grammar — the productions they walk do not
exist there — and three of those ship at error severity.

Those four are nonetheless still at **zero** harvested queries, and no surface fixes
that: OSD's lint tests contain no trigger for `union-min-datasets`,
`multisearch-min-subsearch` or `replace-wildcard-asymmetry` at all. The only place
they appear is a negative assertion that they no-op on the compiled surface
(`analyzer_lint.test.ts`, "runtime-only rules no-op"). Harvesting cannot invent what
was never written, so these are generation's job, not the harvester's.

This job is `continue-on-error: true` and the labeler always exits zero. A finding
here is a lead, not a proven defect; failing unrelated PRs on an auto-generated
guess would destroy the check's credibility. It runs against one engine (the newest
in the matrix) because it generates leads rather than checking version drift.

```bash
# Locally, against a running cluster and an OSD checkout:
node -e "const c=require('<osd>/packages/osd-monaco/src/ppl/lint/rules_catalog.json');
         process.stdout.write(JSON.stringify(c.map(r=>r.id)))" > /tmp/rules.json
node scripts/ppl-lint/harvest-queries.mjs --osd <osd> --catalog-rules @/tmp/rules.json \
  --index opensearch-sql_test_index_account --out /tmp/corpus.json --specs-out /tmp/specs
( cd <osd> && PPL_LINT_SURFACE=compiled-simplified PPL_LINT_CONTRACT_DIR=/tmp/specs \
  PPL_LINT_SCHEDULE=nightly PPL_LINT_REPORT=/tmp/detector.json \
  node -r ./src/setup_node_env "$PWD/../sql/scripts/ppl-lint/run-frontend-contract.mjs" || true )
node scripts/ppl-lint/probe-discovery-backend.mjs --corpus /tmp/corpus.json --out /tmp/backend.json
node scripts/ppl-lint/label-discovery.mjs --corpus /tmp/corpus.json \
  --detector /tmp/detector.json --backend /tmp/backend.json --out /tmp/findings.json
```

## Interpreting a failure

| Failure | Meaning |
| --- | --- |
| Grammar bundle export fails | The candidate SQL build does not provide a usable runtime grammar. |
| Trigger no longer parses | The grammar changed ownership of the error or regressed. |
| Detector emits no diagnostic | The detector is incompatible with the candidate parse tree. |
| Detector flags the control | The detector became too broad. |
| Backend accepts the trigger | The lint rule's premise may be fixed or stale. |
| Backend rejects the control | Query, fixture, settings, or SQL behavior regressed. |
| No version expectation matches | The rule test does not cover the candidate version. |

CI never rewrites expected results. A behavior change is an intentional, reviewed
edit to a versioned expectation **and** the corresponding OSD rule. If a SQL
change depends on an OSD rule update, merge the OSD change first, then rerun the
required SQL check against OSD `main`.

## Artifacts

Every run uploads: `run-manifest.json` (exact SQL SHA, OSD SHA, mode, backend
version, grammar hash, selected validation set), the candidate grammar bundle,
the backend and detector reports, the committed contracts used, and the job logs.
