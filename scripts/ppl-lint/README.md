# PPL lint rule validation

A cross-repository GitHub Actions check that proves the OpenSearch Dashboards
(OSD) PPL lint detectors still agree with the SQL backend on the **same
candidate runtime grammar** built by a SQL pull request.

PPL language behavior lives in SQL; PPL lint detectors live in OSD. A SQL change
can silently invalidate an OSD rule (a parser refactor stops a detector matching,
or a semantic change makes a flagged query valid) without touching OSD. Neither
repository's own unit tests catch that. This check does.

- **Multi-version design:** [`docs/dev/ppl-lint-runtime-compatibility-ci-design.md`](../../docs/dev/ppl-lint-runtime-compatibility-ci-design.md)
- **Deferred analytics design:** [`docs/dev/ppl-lint-analytics-engine-ci-validation.md`](../../docs/dev/ppl-lint-analytics-engine-ci-validation.md)
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
| `PPL_LINT_SURFACE` | `runtime-bundle` (default) or explicit `compiled-simplified` |
| `PPL_LINT_ENGINE_MODE` | optional `calcite` or `legacy` identity for compatibility filtering/context |
| `PPL_LINT_APPLICABLE_ONLY` | `1` omits contracts excluded by surface, version, or engine mode |
| `PPL_LINT_GRAMMAR_BUNDLE` | candidate `ppl-grammar-bundle.json` (required on the runtime surface) |
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
rule that is correct on `main` can be a false positive or false negative on a
released cluster, and the single-version check cannot see it.

[`ppl-lint-multiversion-validation.yml`](../../.github/workflows/ppl-lint-multiversion-validation.yml)
validates every active shipping detector against three planned configurations
and reports **what to change** when one disagrees:

- the OSD compiled-simplified fallback grammar against OpenSearch 2.19.6;
- the runtime grammar exported by the highest official GA release at or below
  the normalized SQL PR target;
- the runtime grammar exported by the SQL PR build.

```
plan configurations
    ├── observe 2.19.6 backend (compiled comparison)
    ├── observe latest eligible GA + export runtime grammar
    └── observe PR build + export runtime grammar
aggregate rule compatibility (one OSD bootstrap, three detector passes)
    └── aggregate-compatibility.mjs → 36-cell schema-v3 report
```

Released legs run official `opensearchproject/opensearch:<version>` images,
which bundle the matching `opensearch-sql` plugin, so no old branch is built.
The plan reads the default `opensearch.version` from `build.gradle`, removes its
prerelease/build suffix, and selects the highest exact-semver OpenSearch tag at
or below it. The `pr-build` leg uses a Gradle test cluster. All legs run the
**same** contract oracle (`PplLintRuleValidationIT`) with
`-Dppl.lint.observe.only=true`, which records real behavior instead of asserting
against expectations — on an older engine a mismatch is the signal being
collected, not a broken run.

The 2.19.6 leg does not request a runtime bundle. Its backend observations are
joined to a detector pass over OSD's checked-in simplified grammar. Rules with
`grammarSurface: runtime-bundle` are `n/a (surface)` there; rules outside their
`wiring.appliesTo` version range are `n/a (version)`. Surface takes precedence
when both exclusions apply. Analytics, syntax-channel, dormant-rule, discovery,
and AI action tests are not part of this workflow.

Observation jobs do not fail on compatibility differences. A failed or missing
observation remains a planned column and becomes `inconclusive`. The final
`Aggregate rule compatibility` job writes the complete expected-versus-actual
table and `drift-report.json`, uploads both report and evidence, and only then
fails for drift or inconclusive in-scope cells.

### What a drift report tells you

Every finding names a drift class, the evidence, and one remediation action:

| Action | When | What you change |
| --- | --- | --- |
| `scope-rule-version` | every contracted trigger is now accepted and controls prove support | `appliesTo.minVersion` / `maxVersion` in `rules_catalog.json` |
| `narrow-detector` | only some contracted triggers are now accepted | keep the version in scope and narrow the detector to invalid forms |
| `update-detector` | the detector regressed, went too broad, or its grammar anchor was renamed | the rule's detector `.ts` (named in the finding) |
| `update-contract` | the linter is right and only the pinned expectation is stale | the `expectations[]` entry for that version |
| `fix-test-leg` | a detector/backend row or target identity is missing or errored | repair or rerun the test leg before changing product behavior |

The schema-v3 report consolidates query symptoms into four rule/configuration
classifications: `detector-regression`, `full-engine-relaxation`,
`partial-engine-relaxation`, and `contract-drift`. Missing or errored evidence
is `inconclusive`, not a compatibility classification.

#### Full vs partial relaxation: scope the rule, or narrow the detector?

When an engine starts accepting a query a rule flags, the fix depends on a question
a single query cannot answer: is the behavior **fully** gone on that version, or
only **partially**?

- **Every trigger relaxed** → `full-engine-relaxation`, action
  `scope-rule-version`. Nothing
  the rule claims is still true on that engine, so bound it with `maxVersion`.
- **Some triggers relaxed, others still rejected** →
  `partial-engine-relaxation`, action `narrow-detector`. The engine fixed *part*
  of the condition. Scoping the
  rule away here would drop the diagnostics that are still correct, converting a
  partial engine fix into a shipped **false negative**. Narrow the detector so it
  stops matching the now-valid shapes while still flagging the rest.

This is decided per rule, not per query: the aggregator collects every trigger's
engine verdict for a rule on a leg, then emits **one** rule-level finding that
supersedes the per-query ones. A trigger with no verdict is counted as neither —
treating it as "still rejects" would let a timed-out leg masquerade as a partial fix
and send someone to narrow a healthy detector.

The evidence always states the contracted, accepted, rejected, and missing
trigger tally. A one-trigger rule can be fully relaxed when that trigger and its
controls produce complete evidence.

Four hard guards keep the check from passing vacuously:

- The active manifest must contain exactly the approved 12 rule IDs.
- A leg whose artifacts are missing remains in the matrix as a complete
  `inconclusive` column. A dead observe job cannot shrink the matrix into a green
  result.
- A case with no engine verdict (a transport failure, recorded by the IT as
  `outcome: "error"`) is **not** read as acceptance. Coercing it would report a
  timeout as an engine that now accepts the query — and advise disabling a
  perfectly good rule. Likewise, a contract whose fixture index failed to seed is
  reported as unusable rather than as a stream of `IndexNotFoundException`
  verdicts.
- A rule whose every case was uncomparable is reported `inconclusive` and **fails**
  — it proved nothing. Inconclusive findings say "check that leg's logs and re-run",
  never "edit the rule", because the linter is not what went wrong.

A rule that is out of scope for a surface, version, or engine mode is not
executed or compared. Its cell is `n/a` with the corresponding reason and never
blocks the job.

### Where a failure shows up in the GitHub UI

The `Aggregate rule compatibility` step summary is the primary interface. It
always contains all 12 rows and all three columns, followed by blocking findings
and remediation. `ppl-lint-multiversion-drift/drift-report.json` carries the
complete schema-v3 matrix and query cases; `ppl-lint-multiversion-evidence`
carries target identities, detector/backend reports, logs, and reproduction
commands. The final step fails only after both uploads have run.

### Running the multi-version check locally

Use the planner with an exact-semver tag list, then point the aggregator at the
three artifact directories produced by backend and detector runs:

```bash
git ls-remote --tags --refs https://github.com/opensearch-project/OpenSearch.git \
  > /tmp/opensearch-release-tags.txt
node scripts/ppl-lint/plan-compatibility.mjs \
  --build-file build.gradle \
  --release-tags /tmp/opensearch-release-tags.txt \
  --compiled-version 2.19.6 \
  --sql-sha "$(git rev-parse HEAD)" \
  --osd-repository opensearch-project/OpenSearch-Dashboards \
  --osd-ref main \
  --out compatibility-plan.json

node scripts/ppl-lint/aggregate-compatibility.mjs \
  --plan compatibility-plan.json \
  --contracts integ-test/src/test/resources/ppl-lint/contracts \
  --artifacts legs \
  --osd-sha "<checked-out OSD SHA>" \
  --out drift-report.json
```

The step summary has one row per active detector. It prints the compatibility
declared by `wiring.appliesTo` and `grammarSurface` next to each actual result.

The classifier is pure and has no cluster or OSD dependency, so its tests run
anywhere:

```bash
node --test "scripts/ppl-lint/__tests__/*.test.mjs"
```

## Discovery corpus (harvested, never enforced)

The discovery scripts remain available as standalone investigation tooling.
They are not invoked by the multi-surface compatibility workflow.

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
