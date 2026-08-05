# PPL Lint Runtime Compatibility CI

- **Status:** Draft implementation design
- **Last updated:** 2026-08-04
- **Scope:** `.github/workflows/ppl-lint-multiversion-validation.yml`

## 1. Decision

The multi-surface workflow validates the 12 active PPL lint detectors against
exactly three standard-engine configurations:

```text
OpenSearch 2.19.6 + OSD compiled-simplified fallback grammar --+
Latest eligible GA + its exported runtime grammar -------------+--> Aggregate rule compatibility
SQL pull request build + its exported runtime grammar ----------+
```

The fixed `2.19.6` leg covers the checked-in grammar OSD uses when an engine
cannot export a runtime grammar bundle. The planner reads the SQL pull request's
default `opensearch.version`, normalizes prerelease/build suffixes, and selects
the highest exact-semver OpenSearch release tag at or below that target for the
GA runtime leg. The PR leg validates the candidate runtime grammar built by the
change under review.

The workflow does not run:

- the analytics engine or composite/Parquet storage;
- syntax-channel features;
- AI action tests.

Analytics coverage is deferred until that engine and its fixtures provide a
stable CI contract. The required single-version workflow remains responsible
for proving that all active detectors agree with the standard SQL pull request
build. The multi-surface workflow explains compatibility across shipping grammar
surfaces and fails its final aggregation job when declared support drifts.

## 2. Rule Inventory

The active inventory contains **12 detector rules**, not 13.
`command-suggestion` is not a lint rule and must not be silently reintroduced.
The final table is generated from `manifest.json`, and CI asserts the exact
inventory so adding a future reviewed rule requires an intentional guard and
test update.

| Rule | Grammar surface | Declared scope |
| --- | --- | --- |
| `agg-on-text` | Both | Calcite, OpenSearch >= 3.7 |
| `division-by-zero` | Both | All versions and engine modes |
| `enabled-false-object` | Both | Calcite, OpenSearch >= 3.7 |
| `field-validation` | Both | All versions and engine modes |
| `invalid-capture-group-name` | Runtime bundle | OpenSearch >= 3.4 |
| `multisearch-min-subsearch` | Runtime bundle | OpenSearch >= 3.4 |
| `replace-wildcard-asymmetry` | Runtime bundle | Calcite, OpenSearch >= 3.4 |
| `rex-scan-cost` | Both | All versions and engine modes |
| `type-mismatch-numeric` | Both | Calcite, OpenSearch >= 3.7 |
| `union-min-datasets` | Runtime bundle | Calcite, OpenSearch >= 3.7 |
| `unsupported-window-function-in-eventstats` | Both | OpenSearch >= 3.4 |
| `wildcard-source-zero-match` | Both | All versions and engine modes |

Four preserved default-off contracts remain in `dormantContracts`. They do not
count toward the 12-rule active inventory.

## 3. Workflow Shape

### 3.1 Plan configurations

`Plan compatibility matrix` resolves:

- the fixed compiled-fallback target, `2.19.6`;
- the highest official GA release at or below the normalized PR target;
- the raw and normalized PR target from `build.gradle`;
- the OSD repository and revision;
- immutable configuration IDs, surfaces, engine modes, and artifact names.

Only exact `X.Y.Z` release tags are eligible. The plan is uploaded as
`compatibility-plan.json` and drives the released-engine matrix.

### 3.2 Observe released configurations

One `Observe engine <version> (<surface>)` matrix job runs for each released
configuration:

1. start the matching official OpenSearch distribution, which includes its SQL
   plugin;
2. run the same contract corpus in observe-only mode;
3. record `target.json` and `backend-report.json`;
4. export `ppl-grammar-bundle.json` only for the runtime-bundle configuration;
5. upload the observation even when a semantic mismatch is found.

The `2.19.6` configuration records backend behavior but intentionally has no
runtime bundle. Its detector pass uses OSD's compiled-simplified fallback
grammar. The selected GA configuration exports and uses that release's runtime
bundle.

### 3.3 Observe the pull request build

`Observe engine pr-build (runtime)` runs the same corpus against the standard
Gradle test cluster built from the pull request. It exports the candidate
runtime grammar and the same target/backend artifact shape as the GA runtime
leg.

### 3.4 Aggregate rule compatibility

`Aggregate rule compatibility` is the only fan-in job. It:

1. waits for the plan and all three backend observations;
2. downloads every `ppl-lint-observation-*` artifact;
3. bootstraps OSD once at the resolved revision;
4. runs production headless lint against the compiled fallback or each runtime
   bundle, as specified by the plan;
5. applies surface, version, then engine-mode exclusions before detector
   execution;
6. compares declared compatibility with detector and backend evidence;
7. writes the complete 12 x 3 `drift-report.json`;
8. publishes the Markdown compatibility table and file-aware annotations;
9. uploads the mandatory report and supplemental evidence before enforcement;
10. fails if the recorded result contains supported-configuration drift or an
    enforced inconclusive cell.

The display name is intentionally explicit. A reader should not have to infer
that this fan-in is the final compatibility decision.

## 4. Expected Versus Actual Compatibility

The aggregate summary has one row per active rule:

| Rule | Expected compatibility | 2.19.6 compiled | Latest GA runtime | PR runtime |
| --- | --- | --- | --- | --- |
| `agg-on-text` | Both surfaces, Calcite >= 3.7 | expected n/a | compatible | compatible |
| `division-by-zero` | Both surfaces, all versions | compatible | compatible | compatible |

Each actual cell uses one of these states:

| State | Meaning |
| --- | --- |
| `compatible` | Detector output and backend behavior match the contract. |
| `expected n/a` | Surface, version, or engine mode is outside `wiring.appliesTo`. |
| `drift` | The configuration is declared compatible but observed behavior differs. |
| `inconclusive` | A fixture, query, artifact, or detector execution did not produce a trustworthy verdict. |

Applicability is part of the expected result, not a workaround applied after
observation. For example, a Calcite-only rule is expected n/a on the legacy
compiled configuration and does not count as drift there.

The JSON report retains query-level evidence and remediation details. The
Markdown table is the concise compatibility view, not a replacement for the
machine-readable report.

## 5. Failure Semantics

Compatibility aggregation is write-first and then enforcing:

- observation jobs record detector and backend mismatches without failing;
- expected out-of-scope configurations do not fail the workflow;
- one rule cannot prevent results for the remaining rules;
- detector execution errors become complete inconclusive cells;
- the fan-in writes the complete table and `drift-report.json`;
- artifact upload runs before the enforcement step;
- only after those outputs exist does supported drift or an enforced
  inconclusive result fail the job.

Structural failures remain errors because no truthful table can be produced:

- a planned observation uploads no usable artifacts;
- JSON artifacts are malformed;
- target and report identities conflict;
- the contract manifest is malformed;
- a runtime configuration has no grammar bundle;
- `drift-report.json` cannot be written.

An artifact named `ppl-lint-multiversion-drift` must contain
`drift-report.json`; raw target files alone are not a compatibility report.

## 6. Outputs

Every run produces:

- `compatibility-plan.json`;
- a GitHub step-summary table with expected and actual compatibility;
- `drift-report.json`;
- one detector report and detector log per configuration;
- target manifests that identify exact SQL, engine, surface, backend, and
  grammar identities.

The required PPL lint workflow remains the stable branch-protection signal. The
multi-surface aggregation is also red on declared-supported drift, with the
table and artifacts providing evidence for adjusting applicability, narrowing a
detector, or updating a backend oracle after review.

## 7. Deferred Coverage

Analytics-engine validation may return only after:

- its feature build is immutable for the duration of a run;
- all required fixtures can be represented or explicitly scoped;
- route attestation is stable;
- a rule-specific analytics limitation cannot invalidate unrelated rules.

Syntax-channel and AI-action behavior require separate contracts and are not
part of this detector compatibility matrix.
