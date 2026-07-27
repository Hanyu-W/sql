# PPL lint rule validation

A required, cross-repository GitHub Actions check that proves the OpenSearch
Dashboards (OSD) PPL lint detectors and the SQL backend still agree — on the
**same candidate runtime grammar** built by a SQL pull request.

PPL language behavior lives in SQL; PPL lint detectors live in OSD. A SQL change
can silently invalidate an OSD rule (a parser refactor stops a detector matching,
or a semantic change makes a flagged query valid) without touching OSD. Neither
repository's own unit tests catch that. This check does.

- **Design:** `ppl-lint-ci-validation-design.md`
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
   - `target.json` — `{ engineVersion, grammarHash, grammarBundle }`;
   - `backend-report.json` — the observed HTTP behavior per query.
2. **detector-validation** (`ubuntu-latest`). Checks out and bootstraps OSD as a
   Node code dependency (no OSD server, no Monaco, no browser), then runs
   [`run-frontend-contract.mjs`](run-frontend-contract.mjs). That runner
   deserializes the candidate bundle through OSD's production headless lint API
   (`src/plugins/data/public/antlr/opensearch_ppl/headless_ppl_lint`) and lints
   each query with the **real** detectors on the **candidate** grammar. It then
   asserts the detector-vs-backend differential.
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

`workflow_dispatch` inputs:

- `osd_repo` — the OSD repository to check out, for validating an unmerged change
  that lives on a fork. Defaults to `opensearch-project/OpenSearch-Dashboards`.
  The `osd_ref` must exist in this repo (a purely local commit cannot be fetched).
- `osd_ref` — an OSD commit or branch to validate instead of `main`. Resolved to
  an immutable commit SHA and recorded in the run manifest. A manual run **cannot**
  satisfy branch protection; merge the OSD change first, then rerun the required
  `pull_request` check against OSD `main`.
- `schedule` — `pr` (fast blocking subset) or `nightly` (full corpus).

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
| `PPL_LINT_TARGET_MANIFEST` | `target.json` (engine version + grammar hash) |
| `PPL_LINT_BACKEND_REPORT` | `backend-report.json` (enables the differential) |
| `PPL_LINT_REPORT` | where to write `detector-report.json` |
| `PPL_LINT_CONTRACT_FILE` | (optional) run a single spec instead of the dir |

## Contract format (schema v3)

One JSON file per rule under `contracts/`, listed in `manifest.json`. Each file
has a top-level `queries` map (each `{ role: "trigger"|"control", query }`) and a
version-scoped `expectations[]`. Exactly one expectation must match the candidate
backend version (zero or more than one fails before any query runs).

```jsonc
{
  "schemaVersion": 3,
  "ruleId": "union-min-datasets",
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
          "detectorCount": 1, "severity": "error",
          "backend": { "kind": "rejection", "httpStatus": 400, "body": { "status": 400, "error": { "type": "IllegalArgumentException" } } }
        },
        "union-two-datasets-control": {
          "detectorCount": 0,
          "backend": { "kind": "result-shape", "httpStatus": 200, "expect": { "datarowsNonEmpty": true } }
        }
      }
    }
  ]
}
```

`backend.kind` is one of `rejection` (contracted 4xx + error type/reason),
`result-shape` (200 with datarow expectations), or `advisory` (soft 200-only
oracle). When a behavior changes in a new version, keep **both** version-scoped
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

- `enforced` — reviewed error rules with a deterministic backend rejection and a
  valid negative control. These block `validation-result` on the single-version
  check: `invalid-capture-group-name`,
  `unsupported-window-function-in-eventstats`, `multisearch-min-subsearch`,
  `union-min-datasets`, `replace-wildcard-asymmetry`.
- `defaultError` — every rule that ships **enabled at error severity** in OSD's
  `rules_catalog.json`. This is the set the **multi-version** check enforces (see
  below). It is a superset of `enforced`, adding `field-validation` and
  `flat-object-subfield`.
- `pendingReview` — error rules awaiting Peng/Chen usefulness review before
  joining `enforced`. Empty: `field-validation` and `flat-object-subfield` are now
  pinned across versions by the multi-version check, but stay out of the
  single-version `enforced` set because their backend oracle is a semantic
  `Field [...] not found.` rejection they share with each other rather than a
  rule-unique grammar rejection.
- `nonEnforcing` — warning/info/advisory/result-shape rules. They run on the
  nightly schedule for coverage and never block a PR.

## Multi-version validation

The check above validates **one** engine: the build from the PR. But a lint rule
ships to every user, and each user's cluster is on whatever version they run. A
rule that is correct on `main` can be a false positive on 3.6 or a false negative
on 3.7, and the single-version check cannot see it.

[`ppl-lint-multiversion-validation.yml`](../../.github/workflows/ppl-lint-multiversion-validation.yml)
validates every `defaultError` rule against several engine versions at once, and
reports **what to change in the linter** when one disagrees.

```
observe (matrix: 3.6.0, 3.7.0 released images  +  pr-build)
    └── each leg exports the same 4 artifacts as the single-version check
detect (one OSD bootstrap, one detector pass per leg's grammar)
    └── aggregate-versions.mjs → drift-report.json + remediation report
```

Released legs run the official `opensearchproject/opensearch:<version>` image,
which bundles the matching `opensearch-sql` plugin, so no old branch is built. The
`pr-build` leg is the same Gradle test cluster the single-version check uses. Both
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
matrix is keyed on the **leg label**, not the version.

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

Drift classes: `grammar-rule-missing` (a parser rule the detector walks was
renamed or removed — the finding names the closest current rule names),
`engine-relaxed` / `engine-tightened` (the engine's verdict flipped),
`engine-message-changed` (same verdict, reworded error), `detector-silent` /
`detector-noisy` (false negative / false positive), `version-scope-too-narrow`
(the engine rejects but the rule is scoped away from that version, so users see no
diagnostic), and `severity-mismatch`.

Four guards keep the check from passing vacuously. Each exists because "we could
not check" must never render as "it is fine":

- A rule that is default-error in OSD's catalog but has no contract file fails the
  run. The detector runner records the catalog's default-error census in
  `detector-report.json`, and the aggregate step compares it against
  `manifest.defaultError` — so a new error rule cannot land unvalidated.
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
