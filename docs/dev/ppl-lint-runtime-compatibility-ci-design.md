# PPL Lint Runtime Compatibility CI

- **Status:** Proposed revision for the SQL PPL lint CI
- **Last updated:** 2026-08-04
- **Scope:** `.github/workflows/ppl-lint-multiversion-validation.yml`

## 1. Decision

The multi-version workflow validates PPL lint compatibility only against
standard OpenSearch runtime grammar bundles:

```text
OpenSearch 3.6 release ─┐
OpenSearch 3.7 release ─┼─> Aggregate rule compatibility
SQL pull request build ─┘
```

The workflow does not run:

- the compiled-simplified grammar surface for pre-3.6 engines;
- the analytics engine or composite/Parquet storage;
- syntax-channel features;
- AI action tests.

Analytics coverage is deferred until that engine and its fixtures provide a
stable CI contract. Pre-3.6 coverage is removed because those engines cannot
export the runtime grammar bundle consumed by the production lint path.

The required single-version workflow remains responsible for proving that all
active shipping detectors agree with the standard SQL pull request build. The
multi-version workflow explains where each rule works and fails its final
aggregation job when a declared-supported version drifts.

## 2. Rule Inventory

The active inventory currently contains **12 detector rules**, not 13.
`command-suggestion` was removed from this effort and must not be silently
reintroduced as a lint rule. The final table is generated from
`manifest.json`. CI also asserts that the current inventory is exactly these 12
rules, so adding a future reviewed rule requires an intentional guard and test
update.

| Rule | Declared compatibility |
| --- | --- |
| `agg-on-text` | Calcite, OpenSearch >= 3.7 |
| `division-by-zero` | All runtime-bundle versions |
| `enabled-false-object` | Calcite, OpenSearch >= 3.7 |
| `field-validation` | All runtime-bundle versions |
| `invalid-capture-group-name` | OpenSearch >= 3.4 |
| `multisearch-min-subsearch` | OpenSearch >= 3.4 |
| `replace-wildcard-asymmetry` | Calcite, OpenSearch >= 3.4 |
| `rex-scan-cost` | All runtime-bundle versions |
| `type-mismatch-numeric` | Calcite, OpenSearch >= 3.7 |
| `union-min-datasets` | Calcite, OpenSearch >= 3.7 |
| `unsupported-window-function-in-eventstats` | OpenSearch >= 3.4 |
| `wildcard-source-zero-match` | All runtime-bundle versions |

## 3. Workflow Shape

### 3.1 Plan

`Plan matrix` resolves:

- released engines: `3.6.0` and `3.7.0`;
- the OSD repository and revision;
- the discovery engine, currently the newest released engine.

There is no compiled-surface input or analytics target.

### 3.2 Observe released engines

One `Observe engine <version>` job runs per released engine. Each job:

1. starts the official OpenSearch distribution containing its matching SQL
   plugin;
2. runs the contract queries in observe-only mode;
3. exports that engine's runtime grammar bundle;
4. uploads `target.json`, `backend-report.json`, and
   `ppl-grammar-bundle.json`.

An expectation mismatch is observation data, not a job failure.

### 3.3 Observe the pull request build

`Observe engine pr-build` runs the same corpus against the standard Gradle test
cluster built from the pull request. It exports the same artifact shape as the
released legs.

### 3.4 Aggregate rule compatibility

`Aggregate rule compatibility` is the only fan-in job. It:

1. waits for the released and pull request observation jobs;
2. downloads every `ppl-lint-leg-*` artifact;
3. bootstraps OSD once;
4. runs the production headless lint detector against each engine's runtime
   grammar bundle;
5. compares declared compatibility with observed detector and backend results;
6. writes `drift-report.json`;
7. publishes the Markdown compatibility table in the GitHub step summary;
8. uploads the mandatory `ppl-lint-multiversion-drift` artifact and
   supplemental `ppl-lint-multiversion-evidence` artifact;
9. fails if the aggregate result recorded supported-version drift.

The job display name is intentionally explicit. A reader should not have to
infer that a job named "detect" is the final aggregation.

## 4. Expected Versus Actual Compatibility

The aggregate summary has one row per active rule:

| Rule | Expected compatibility | 3.6 actual | 3.7 actual | PR build actual |
| --- | --- | --- | --- | --- |
| `agg-on-text` | Calcite, >= 3.7 | expected n/a | compatible | compatible |
| `division-by-zero` | all versions | compatible | compatible | compatible |

Each actual cell uses one of these states:

| State | Meaning |
| --- | --- |
| `compatible` | Detector output and backend behavior match the contract. |
| `expected n/a` | The engine is outside `wiring.appliesTo`, such as 3.6 for a rule with `minVersion: 3.7.0`. |
| `drift` | The engine is declared compatible but detector or backend behavior differs. |
| `inconclusive` | A fixture, query, or detector execution did not produce a trustworthy verdict. |

`minVersion` is part of the expected result, not a workaround applied after
the fact. If a rule is intentionally unsupported on 3.6 and declares
`minVersion: 3.7.0`, the 3.6 cell is `expected n/a` and does not count as
drift.

The JSON report retains query-level evidence and remediation details. The
Markdown table is the concise compatibility view, not a replacement for the
machine-readable report.

## 5. Failure Semantics

Compatibility aggregation is write-first and then enforcing:

- observation jobs record detector and backend mismatches without failing;
- expected out-of-scope versions do not fail the workflow;
- an inconclusive rule produces an `inconclusive` cell and annotation;
- one rule cannot prevent results for the other rules;
- the fan-in writes the complete table and `drift-report.json`;
- the artifact upload runs even when the aggregate result is failing;
- only after those outputs exist does supported-version drift or an enforced
  inconclusive result fail the final aggregation job.

This ordering is required. A bare `Process completed with exit code 1` before
the table exists is not an actionable compatibility result.

Structural failures remain errors because no truthful table can be produced:

- a planned engine leg uploads no artifacts;
- JSON artifacts are malformed;
- target identity conflicts with report identity;
- the contract manifest is malformed;
- `drift-report.json` cannot be written.

The artifact upload must require `drift-report.json`. An artifact named
`ppl-lint-multiversion-drift` that contains only raw target files is not a drift
report and must not be presented as one.

## 6. Outputs

Every run produces:

- a GitHub step-summary table with expected and actual compatibility;
- `drift-report.json`;
- one detector report and detector log per engine leg;
- target manifests that identify the exact engine and grammar hash.

The required PPL lint workflow remains the stable branch-protection signal.
The multi-version aggregation job is also red on declared-supported drift, with
the table and artifact serving as the evidence for adjusting `minVersion`,
narrowing a detector, or updating a backend oracle after review.

## 7. Deferred Coverage

Analytics-engine validation may return only after:

- its feature build is immutable for the duration of a run;
- all required fixtures can be represented or explicitly scoped;
- route attestation is stable;
- a rule-specific analytics limitation cannot invalidate unrelated rules.

Compiled-simplified coverage may return only if pre-3.6 support becomes a
shipping requirement. It must be a separate workflow because it tests OSD's
checked-in grammar rather than the SQL runtime grammar bundle.
