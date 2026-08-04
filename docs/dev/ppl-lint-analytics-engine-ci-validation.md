# Analytics Engine Coverage for PPL Lint CI Validation

- **Status:** Deferred; not part of PPL lint pull-request or multi-version CI
- **Last updated:** 2026-07-28
- **Scope:** PPL lint contract validation in
  `.github/workflows/ppl-lint-rule-validation.yml` and
  `.github/workflows/ppl-lint-multiversion-validation.yml`

> **Decision update (2026-08-04):** Analytics-engine lint validation is
> deferred because the feature build and composite/Parquet fixture surface are
> not stable enough for this compatibility workflow. The active design is
> [PPL Lint Runtime Compatibility CI](ppl-lint-runtime-compatibility-ci-design.md),
> which covers standard runtime-bundle engines only. This document is retained
> as future design context and is not an implementation commitment.

## 1. Summary

The PPL lint CI contract currently compares OpenSearch Dashboards (OSD)
detectors with the standard SQL execution route only. It does not prove that
the same lint diagnostics are correct when a query is routed through the
analytics engine and executed by DataFusion over composite/Parquet storage.

This design adds analytics-engine coverage by:

1. Running the existing `PplLintRuleValidationIT` corpus against a dedicated,
   full-stack analytics-engine test cluster.
2. Making execution backend an explicit contract and artifact dimension,
   separate from OpenSearch version, Calcite applicability, and grammar
   surface.
3. Failing if the analytics lane silently falls back to the standard route.
4. Running the OSD detector comparison against both standard and analytics
   backend reports while bootstrapping OSD only once.
5. Shipping the lane as non-enforcing observation first, then adding it to the
   stable required result after its artifacts, expectations, and reliability
   meet the promotion criteria in this document.

The initial implementation covers the SQL pull request build on one shard. It
does not add a Cartesian product of analytics backends, released OpenSearch
versions, grammar surfaces, and shard counts.

## 2. Current State

### 2.1 Required PPL lint validation

`.github/workflows/ppl-lint-rule-validation.yml` is a three-job pipeline:

```text
backend-validation
    -> detector-validation
        -> validation-result
```

- `backend-validation` runs `PplLintRuleValidationIT` against the ordinary
  Gradle `integTest` cluster. That cluster installs SQL, Job Scheduler, and
  Geospatial, but not the analytics-engine stack.
- The integration test executes every scheduled trigger and control query
  against `POST /_plugins/_ppl`, then exports:
  - `ppl-grammar-bundle.json`
  - `target.json`
  - `backend-report.json`
- `detector-validation` bootstraps OSD, runs its production headless PPL lint
  API against the exported grammar, and compares detector output with the
  backend report.
- `validation-result` uses `if: always()` and fails unless both producer jobs
  succeeded. This is the stable branch-protection check.

The multi-version companion workflow repeats the same contract against
released standard engines and the pull request build. Its current dimensions
are OpenSearch version and grammar surface.

### 2.2 Existing analytics-engine support

The repository already contains most of the required test infrastructure:

- `integ-test/build.gradle` can download the analytics engine, Arrow,
  composite engine, Parquet data format, and Lucene/DataFusion backend plugin
  ZIPs.
- The full analytics stack is already configured for
  `analyticsEngineProfileIT` and `analyticsEngineSecurityIT`.
- `-Dtests.analytics.parquet_indices=true` makes helper-created fixtures use
  composite/Parquet storage.
- `SQLIntegTestCase` applies the corresponding cluster defaults before fixture
  creation.
- `PPLIntegTestCase.isAnalyticsParquetIndicesEnabled()` exposes the active
  route to tests.
- `integTestRemote` already forwards the analytics fixture properties.
- `CalciteAnalyticsDatetimeWireFormatIT` demonstrates route attestation using
  explain output: analytics plans contain
  `LogicalTableScan(table=[[opensearch,` and not
  `CalciteLogicalIndexScan`.

### 2.3 Gap in the existing analytics workflow

`.github/workflows/analytics-engine-compat.yml` runs only
`AnalyticsEngineCompatIT`. Its purpose is plugin coexistence. Its PPL assertion
uses the `rest` row source, which is explicitly excluded from analytics
routing. The workflow can therefore pass without executing a PPL query through
DataFusion.

The `analyticsEngineCompat` cluster is also intentionally smaller than the
stack required for real analytics execution. It does not install the composite
engine, Parquet data format, or both analytics backends.

### 2.4 Terminology

The following dimensions must remain independent:

| Dimension | Examples | Meaning |
| --- | --- | --- |
| Engine version | `3.7.0`, `3.8.0-SNAPSHOT` | OpenSearch/SQL product version |
| Grammar surface | `runtime-bundle`, `compiled-simplified` | Grammar used by OSD lint |
| Lint/planner applicability | `engine: "calcite"` | Existing OSD rule applicability |
| Execution backend | `standard`, `analytics` | SQL execution route selected at runtime |
| Storage | `lucene`, `composite-parquet` | Fixture storage that drives routing |

Analytics uses Calcite planning, so treating `analytics` as another value of
the existing `engine` field would be incorrect. Treating it as another engine
version would also cause the drift analyzer to recommend version scoping for a
backend-specific difference.

## 3. Problem Statement

A lint rule is presented to users before query execution. OSD currently has no
analytics-route signal in the lint context, so the same detector result applies
whether the selected index later uses the standard or analytics route.

The current CI can miss these failures:

1. A detector reports an error for a query that the analytics backend accepts.
   This is a false positive for analytics users.
2. A detector is silent for a query rejected only by the analytics route. This
   is a false negative for analytics users.
3. A control query passes on the standard route but fails on analytics.
4. An analytics test is configured incorrectly and silently executes on the
   standard route, producing a vacuous green result.
5. Standard and analytics observations are stored under the same product
   version, causing aggregation to overwrite or misclassify one of them.
6. A required job consumes mutable `feature-datafusion/latest` artifacts, so a
   rerun can test a different stack without recording that change.

## 4. Goals and Non-Goals

### 4.1 Goals

- Run every scheduled PPL lint trigger and control against the pull request's
  analytics route.
- Reuse the existing contract corpus and Java integration-test oracle.
- Use byte-identical query text, the same SQL commit, the same runtime grammar,
  the same OSD commit, and the same frontend lint context for both backends.
- Represent execution backend in contracts, reports, manifests, summaries, and
  aggregation keys.
- Prove that the analytics plugin stack is installed, fixtures are
  composite/Parquet, routing selected analytics, and DataFusion executed a
  canary query.
- Distinguish backend-route divergence from version drift.
- Fail closed on missing reports, missing expectations, route fallback,
  incomplete matrices, or inconsistent grammar identity.
- Produce enough artifacts to reproduce infrastructure and semantic failures.
- Keep pull request wall-clock growth bounded by running backend jobs in
  parallel and bootstrapping OSD once.

### 4.2 Non-goals

- Replacing the existing broad analytics compatibility, security, or profile
  suites.
- Running the entire PPL integration-test suite in the lint validation job.
- Adding browser, Monaco, or a running OSD server.
- Performance or benchmark validation.
- Testing every released OpenSearch version with every analytics stack in the
  first release.
- Adding multi-shard analytics coverage to the required lint check.
- Automatically accepting known analytics limitations through broad Gradle
  exclusions or JUnit assumptions.
- Changing production routing solely to make the test easier.

## 5. Design Invariants

The implementation must preserve these invariants:

1. **Same SQL candidate:** both backend lanes build the same checked-out SQL
   commit.
2. **Same grammar:** both lanes export a runtime bundle. Their engine version
   and grammar hash must match before detector validation starts.
3. **Same OSD candidate:** both detector comparisons use one resolved OSD SHA
   and one OSD bootstrap.
4. **Same queries:** standard, analytics, and detector passes read the same
   contract files and substitute the same index names.
5. **Explicit identity:** every target and report names its execution backend.
   Missing or conflicting identity is an infrastructure failure.
6. **Proven route:** setting `tests.analytics.parquet_indices=true` is not
   sufficient evidence. The analytics lane must attest the installed plugins,
   index settings, explain plan, and a profiled execution.
7. **No semantic retry:** downloads and cluster startup may be retried within
   bounded limits. Contract queries and assertions are executed once.
8. **No vacuous pass:** missing queries, reports, detector rows, route evidence,
   or planned matrix legs fail or become an explicit non-applicable result.
9. **No implicit fallback:** the analytics lane must never count a standard
   route result as analytics coverage.
10. **One detector oracle:** detector count and severity remain route
    independent until OSD exposes an execution-backend lint context.
11. **Complete contracts:** every selected expectation names exactly the same
    query keys as the contract's top-level `queries` map. Duplicate or missing
    report rows are infrastructure failures.
12. **Strict artifacts:** requested targets and reports must exist, parse, and
    agree on execution identity. Writers and consumers fail rather than degrade
    to an identity-free or differential-free run.

## 6. Target Identity

`target.json` currently records only engine version, grammar hash, and bundle
name. It will move to schema version 2 and include execution identity:

```json
{
  "schemaVersion": 2,
  "sqlSha": "...",
  "engineVersion": "3.8.0-SNAPSHOT",
  "grammarHash": "sha256:...",
  "grammarBundle": "ppl-grammar-bundle.json",
  "executionBackend": "analytics",
  "storage": "composite-parquet",
  "shardCount": 1,
  "analyticsStack": {
    "source": "immutable feature-build URL",
    "buildId": "...",
    "components": [
      {
        "name": "analytics-engine",
        "version": "3.8.0-SNAPSHOT",
        "sha256": "..."
      }
    ]
  },
  "routeAttestation": {
    "pluginsVerified": true,
    "clusterSettingsVerified": true,
    "fixtureIndicesVerified": true,
    "explainVerified": true,
    "profiledExecutionVerified": true
  }
}
```

For the standard route:

```json
{
  "executionBackend": "standard",
  "storage": "lucene",
  "shardCount": 1
}
```

The backend report, detector report, drift report, and run manifest will also
carry `executionBackend`. Aggregation keys become:

```text
(leg label, engine version, grammar surface, execution backend)
```

The leg label remains the presentation key because multiple legs can share the
same engine version.

## 7. Contract Schema

### 7.1 Schema version 4

Detector expectations are shared, while backend oracles are keyed by execution
backend:

```json
{
  "schemaVersion": 4,
  "ruleId": "union-min-datasets",
  "index": "opensearch-sql_test_index_account",
  "queries": {
    "union-single-dataset": {
      "role": "trigger",
      "query": "union [ source={{index}} ]"
    },
    "union-two-datasets-control": {
      "role": "control",
      "query": "union [ source={{index}} ] [ source={{index}} ]"
    }
  },
  "grammarSurface": "runtime-bundle",
  "schedule": "pr",
  "backendFixture": {
    "indices": ["ACCOUNT"],
    "clusterSettings": {
      "calcite": true,
      "calciteFallback": false
    }
  },
  "frontendContext": {
    "isCalcite": true
  },
  "expectations": [
    {
      "version": ">=3.7.0",
      "engine": "calcite",
      "queries": {
        "union-single-dataset": {
          "detectorCount": 1,
          "severity": "error",
          "backends": {
            "standard": {
              "kind": "rejection",
              "httpStatus": 400,
              "body": {
                "status": 400,
                "error": {
                  "type": "IllegalArgumentException",
                  "reason": "Union command requires at least two datasets. Provided: 1"
                }
              }
            },
            "analytics": {
              "kind": "rejection",
              "httpStatus": 400,
              "body": {
                "status": 400,
                "error": {
                  "type": "IllegalArgumentException"
                }
              }
            }
          }
        },
        "union-two-datasets-control": {
          "detectorCount": 0,
          "backends": {
            "standard": {
              "kind": "result-shape",
              "httpStatus": 200,
              "expect": {
                "datarowsNonEmpty": true
              }
            },
            "analytics": {
              "kind": "result-shape",
              "httpStatus": 200,
              "expect": {
                "datarowsNonEmpty": true
              }
            }
          }
        }
      }
    }
  ]
}
```

The existing `engine` field keeps its current meaning. It is not renamed to
avoid mixing this work with an unrelated contract migration.

### 7.2 Compatibility and migration

- A schema version 3 `backend` object is read as `backends.standard`. It is not
  used as an implicit analytics oracle.
- Observation can begin before every analytics oracle is reviewed. In
  observation mode, a missing analytics oracle executes the query once and
  records `coverage-missing` plus the raw backend result; it does not score that
  result against the standard oracle. Infrastructure and route-attestation
  failures still fail the lane.
- Enforcement requires `backends.analytics` for every selected query.
- An unknown execution backend is a contract error.
- An unknown schema version is a contract error.
- More than one version/planner expectation match remains an error.
- A selected expectation must name exactly the top-level contract query set.
- The Java test and Node runner must implement identical selection behavior.

An explicit non-applicable form is permitted only when the fixture cannot
meaningfully exercise analytics:

```json
{
  "kind": "not-applicable",
  "reason": "Fixture field type cannot be represented by composite/Parquet storage",
  "owner": "@analytics-team",
  "issue": "https://github.com/opensearch-project/sql/issues/..."
}
```

Rules in the required `defaultError` set cannot be promoted while their
analytics oracle is non-applicable. For other rules, non-applicable entries
remain visible in the report and require an owner and issue.

### 7.3 Differential policy

| Case | Detector requirement | Backend requirement |
| --- | --- | --- |
| Control | Zero diagnostics | Every applicable backend accepts |
| Rejection trigger | Expected diagnostic count and severity | Every applicable backend rejects with its reviewed error shape |
| Advisory trigger | Expected diagnostic count and severity | Backend matches its reviewed acceptance/result-shape oracle |
| Missing backend oracle | Not scored | Coverage failure |
| Backend transport error | Not scored | Infrastructure/inconclusive failure, never acceptance |

If an error rule fires while analytics accepts the trigger, the result is
`execution-backend-divergence`. The remediation must not recommend changing an
OpenSearch version range. Because OSD currently lacks backend context, the
choices are to make the rule valid for both routes, narrow the detector to
behavior common to both, disable it, or first add a reliable backend signal to
the OSD lint context.

## 8. Analytics Test Cluster and Gradle Task

### 8.1 Chosen approach

Add a dedicated Gradle-managed cluster and task:

```text
testClusters.analyticsEnginePplLint
:integ-test:analyticsEnginePplLintIT
```

The cluster will install:

- Job Scheduler
- Arrow Base
- Arrow Flight RPC
- Analytics Engine
- Composite Engine
- Parquet Data Format
- Analytics Backend Lucene
- Analytics Backend DataFusion
- The SQL plugin built from the current checkout

It will reuse the native-access, Netty, and experimental feature settings used
by the existing full-stack profile/security clusters. Shared cluster
configuration should be extracted into a small Gradle helper if that can be
done without changing those tasks' behavior.

The task will:

- Depend on all analytics plugin downloads and SQL `bundlePlugin`.
- Filter to `PplLintRuleValidationIT`.
- Set `tests.analytics.parquet_indices=true`.
- Set `tests.analytics.num_shards=1`.
- Set `ppl.lint.execution_backend=analytics`.
- Forward the existing `ppl.lint.*` paths and schedule.
- Run as a non-root user in CI.

Example invocation:

```bash
./gradlew :integ-test:analyticsEnginePplLintIT \
  -Dppl.lint.execution_backend=analytics \
  -Dppl.lint.schedule=nightly \
  -Dppl.lint.observe.only=true \
  -Dppl.lint.report="$PWD/leg/backend-report.json" \
  -Dppl.lint.grammar.bundle="$PWD/leg/ppl-grammar-bundle.json" \
  -Dppl.lint.target="$PWD/leg/target.json"
```

The task sets the analytics fixture properties itself so a caller cannot
accidentally request an analytics report while creating Lucene fixtures.

### 8.2 Why not the alternatives

**Reuse `analyticsEngineCompatIT`:** rejected because its cluster lacks the full
execution stack and its test intentionally avoids analytics routing.

**Provision an external cluster and use `integTestRemote`:** the remote task is
a valid future path for released analytics stacks, but it requires separate
cluster lifecycle, plugin installation, and SQL-plugin provenance checks. A
managed cluster is simpler and guarantees that the SQL plugin comes from the
current checkout.

**Run the full PPL integration suite:** rejected for the required lint check.
It adds unrelated capability exclusions, runtime, and flakiness without
improving the detector contract.

## 9. Route Attestation

The analytics integration test will perform attestation before scoring any
contract:

1. Query `/_cat/plugins?format=json` and require every plugin in the full stack.
2. Verify plugin versions are compatible with the OpenSearch/SQL version.
3. Read cluster settings and require composite data format defaults.
4. Read settings for every fixture index and require:
   - `index.pluggable.dataformat.enabled=true`
   - `index.pluggable.dataformat=composite`
   - `index.composite.primary_data_format=parquet`
5. Run one valid explain canary per fixture index:

   ```text
   source=<fixture-index> | head 1
   ```

   Require `LogicalTableScan(table=[[opensearch,` and reject
   `CalciteLogicalIndexScan`.
6. Run the same canary with `profile=true` and require at least one successful
   execution stage. Record every `execution_type`. Before required promotion,
   pin and require the exact DataFusion-specific marker exposed by the locked
   analytics stack. A generic non-empty profile is sufficient only for the
   observation lane.
7. Write the attestation outcome into `target.json`.

Invalid trigger queries may fail before DataFusion execution. Such results are
observations from an analytics-configured, route-attested environment, not
claims that DataFusion executed the invalid query. The canary proves that each
fixture is capable of analytics execution. A static
`cluster.pluggable.dataformat=composite` startup setting is also required so
query-initial parse failures see the same routing configuration as valid
queries.

Attestation uses assertions, not JUnit assumptions. A missing plugin or legacy
explain plan fails the lane.

## 10. CI Workflow

### 10.1 Final required topology

```text
Get-CI-Image-Tag
    |-------------------------------|
    v                               v
standard-backend-validation    analytics-backend-validation
    |                               |
    |---- standard artifacts        |---- analytics artifacts
                    \               /
                     v             v
                  detector-validation
             (one OSD checkout/bootstrap,
              two backend comparisons)
                           |
                           v
                   validation-result
```

The backend jobs run in parallel. The analytics job uses JDK 25 to match the
existing analytics compatibility workflow; the standard job keeps its current
JDK.

Artifacts use distinct names and directories:

```text
ppl-lint-backend-standard/
ppl-lint-backend-analytics/
ppl-lint-backend-standard-logs/
ppl-lint-backend-analytics-logs/
```

Before linting, `detector-validation` verifies:

- Both target manifests exist.
- Both backend reports are non-empty.
- Both targets report the expected execution backend.
- Both targets report the same engine version and grammar hash.
- Analytics route attestation is complete.
- Every requested report exists, is non-empty, contains no duplicate identities,
  and agrees with its target's execution backend.

It then invokes `run-frontend-contract.mjs` twice against the same OSD checkout
and runtime grammar:

```text
standard backend report  -> detector-standard-report.json
analytics backend report -> detector-analytics-report.json
```

The duplicate detector pass costs seconds; the OSD bootstrap dominates the
job. Two explicit invocations are lower risk than redesigning the runner to
accept an arbitrary report collection. The result job also compares normalized
detector rows: rule/query identity, count, severity, and any asserted message
match. Equal counts alone are not sufficient parity.

`validation-result` continues to use `if: always()` and becomes red unless all
three validation jobs succeeded. A skipped detector caused by either backend
failure therefore cannot appear green.

### 10.2 Multi-version workflow

The first analytics leg is `pr-build-analytics`. It is not added to every
released version:

| Leg | Version | Grammar surface | Execution backend |
| --- | --- | --- | --- |
| Existing released legs | Released matrix | Runtime/compiled as configured | Standard |
| `pr-build` | Pull request build | Runtime bundle | Standard |
| `pr-build-analytics` | Pull request build | Runtime bundle | Analytics |

`aggregate-versions.mjs` must understand the backend dimension before this leg
is added. It reports backend divergence separately and never turns an
analytics-only difference into version-scoping advice.

The discovery corpus remains standard-only in the initial implementation. It
has no reviewed oracle and should not expand the analytics rollout's cost or
diagnostic surface.

### 10.3 Local entry point

`scripts/ppl-lint-rule-validation.sh` will gain an opt-in analytics mode, for
example `RUN_ANALYTICS=1`. It will support the existing local ZIP override
properties. Standard local behavior remains unchanged.

## 11. Artifact Provenance

The current Gradle default uses a mutable
`feature-datafusion/latest/linux/x64` URL. This is acceptable for early
observation but not for a required check.

Before promotion:

1. Add a checked-in compatibility lock describing the immutable analytics
   feature build for the current OpenSearch line.
2. Add a Gradle property such as `analyticsFeatureBuildBase` so CI can pass the
   immutable base while local development can retain the current default.
3. Verify SHA-256 for every downloaded plugin ZIP before cluster startup.
4. Record the immutable source, build ID, component versions, and hashes in
   `target.json`.
5. Fail if installed plugin versions do not match the locked tuple.

If an immutable artifact source cannot be provided, the analytics lane remains
non-enforcing.

## 12. Failure Semantics

| Failure | Classification | CI behavior |
| --- | --- | --- |
| Plugin download or checksum failure | Infrastructure | Retry download at most three times, then fail lane |
| Cluster does not become healthy | Infrastructure | Fail and upload cluster logs/thread dump |
| Required plugin absent or wrong version | Infrastructure | Fail before contracts |
| Fixture is not composite/Parquet | Route attestation | Fail before contracts |
| Explain/profile canary uses standard route | Route attestation | Fail before contracts |
| Standard and analytics grammar hashes differ | Candidate identity | Fail detector job |
| Missing/empty backend or detector report | Incomplete run | Fail; never aggregate survivors only |
| Missing analytics expectation | Coverage hole | Fail once analytics enforcement is enabled |
| Contract query transport timeout | Inconclusive run | Fail; never treat as backend acceptance |
| Trigger/control behavior differs from oracle | Semantic drift | Report backend, query, observed status/type, and remediation |
| Standard and analytics behavior differ | Execution-backend divergence | Report separately; do not suggest version scoping |
| Detector output differs between backend passes | Harness/context defect | Fail detector job |

Semantic assertions are never retried. A retry could hide a nondeterministic
backend or detector defect.

## 13. Diagnostics and Resource Bounds

The analytics job will use:

- A 30-minute GitHub job timeout.
- A bounded OpenSearch heap consistent with current workflows.
- One Netty direct arena and the existing native-access flags.
- One primary shard for required contract coverage.
- No credentials or fork secrets.
- `permissions: contents: read`.

Always upload on failure:

- `target.json` and analytics stack identity.
- Backend and detector reports.
- JUnit XML and HTML reports.
- Gradle test reports.
- Installed plugin list.
- Effective cluster and fixture index settings.
- Fixture mapping hashes and any fields stripped by the analytics fixture
  helper.
- OpenSearch and test-cluster logs.
- Detector logs.
- Thread dumps for startup or query timeout.

Reports must distinguish `accepted`, `rejected`, `error`, and
`not-applicable`. An absent `rejected` field is not equivalent to acceptance.

## 14. Test Plan

### 14.1 Harness unit tests

Add Node tests for:

- Schema version 3 compatibility and schema version 4 backend selection.
- Unknown or missing execution backend.
- Missing analytics oracle.
- Duplicate target identities.
- Same version with standard and analytics legs.
- Standard/analytics grammar mismatch.
- Backend transport error not being read as acceptance.
- Analytics divergence producing backend remediation, not version scoping.
- Detector parity between standard and analytics passes.
- Non-applicable handling and required-rule coverage holes.
- Summary and annotation output naming the execution backend.

### 14.2 Java integration coverage

Verify:

- The standard `PplLintRuleValidationIT` behavior is unchanged.
- The analytics task installs the full stack.
- ACCOUNT and FLAT_OBJECT fixtures are composite/Parquet or fail explicitly.
- Explain and profile canaries attest the analytics route.
- Every scheduled contract emits one backend result per expected query.
- Report entries include `executionBackend`.
- A forced missing-plugin or standard-route configuration fails attestation.

### 14.3 Workflow validation

Use `workflow_dispatch` to validate:

- Canonical OSD `main`.
- An explicit OSD branch/SHA.
- A successful dual-backend run.
- An intentionally wrong analytics oracle.
- An intentionally missing analytics artifact.
- A backend failure that skips detector work but still makes the final result
  red.

No production branch-protection change is made during this validation.

## 15. Rollout

### Phase 1: Identity and observation

- Add execution-backend identity to targets and reports.
- Add the schema version 4 reader with version 3 compatibility.
- Make artifact consumers fail closed on missing, malformed, duplicate, or
  conflicting identities.
- Add backend-aware aggregation and divergence remediation before introducing
  an analytics leg.
- Add the managed analytics Gradle task and route attestation.
- Add `pr-build-analytics` to the non-required multi-version workflow.
- Missing analytics oracles are recorded as unscored coverage gaps during
  observation. Infrastructure, identity, completeness, and attestation failures
  remain red. Do not use `continue-on-error` inside the producer lane.

### Phase 2: Baseline and review

- Capture real analytics observations for the full contract corpus.
- Add reviewed analytics oracles.
- Resolve every default-error non-applicable case.
- Pin immutable analytics artifacts and verify their checksums.
- Pin the DataFusion-specific profile execution marker.
- Measure runtime and infrastructure reliability.

Promotion requires:

- Every scheduled contract has a reviewed analytics oracle.
- No `defaultError` contract is non-applicable.
- No unexplained semantic divergence remains.
- At least 25 consecutive green observation runs.
- At least 50 total runs with less than 1% infrastructure failure.
- Analytics job p95 runtime is at most 15 minutes.
- Artifact provenance is immutable and recorded.

### Phase 3: Required check

- Add `analytics-backend-validation` to the required single-version workflow.
- Make detector validation require both backend artifacts.
- Make `validation-result` require standard backend, analytics backend, and
  detector success.
- Update the run manifest and PR summary to show both routes.

There is no silent repository-variable bypass after promotion. An emergency
rollback requires an explicit workflow/branch-protection change and a tracking
issue.

### Phase 4: Optional expansion

After the required lane is stable, evaluate:

- Matching released analytics stacks.
- A scheduled three-shard analytics leg.
- Analytics execution for the discovery corpus.
- Consolidating or retiring redundant parts of
  `analytics-engine-compat.yml`.

These are separate changes and are not prerequisites for initial enforcement.

## 16. Planned File Changes

| File | Change |
| --- | --- |
| `integ-test/build.gradle` | Add the full-stack analytics lint cluster/task and artifact lock inputs |
| `PplLintRuleValidationIT.java` | Select backend-specific oracles, attest route, and emit backend identity |
| `integ-test/src/test/resources/ppl-lint/contracts/*.spec.json` | Migrate to schema version 4 and add analytics oracles |
| `integ-test/src/test/resources/ppl-lint/contracts/manifest.json` | Bump schema metadata and document analytics coverage |
| `scripts/ppl-lint/run-frontend-contract.mjs` | Select the active backend oracle and emit backend identity |
| `scripts/ppl-lint/contract-schema.mjs` | Share strict Node schema, identity, and backend-oracle selection |
| `scripts/ppl-lint/aggregate-versions.mjs` | Key and render legs by execution backend |
| `scripts/ppl-lint/drift.mjs` | Add execution-backend divergence and remediation |
| `scripts/ppl-lint/annotate.mjs` | Attach backend-specific findings to contract declarations |
| `scripts/ppl-lint/assemble-run-manifest.mjs` | Record both targets and job results |
| `scripts/ppl-lint/__tests__/*` | Cover schema, identity, aggregation, and remediation changes |
| `.github/workflows/ppl-lint-multiversion-validation.yml` | Add the observation leg |
| `.github/workflows/ppl-lint-rule-validation.yml` | Add the required lane after promotion |
| `scripts/ppl-lint-rule-validation.sh` | Add opt-in local analytics reproduction |
| `scripts/ppl-lint/README.md` | Document backend-aware contracts and commands |
| Analytics compatibility lock (path TBD) | Pin immutable plugin URLs, versions, and SHA-256 values before required promotion |

## 17. Success Criteria

The work is complete when:

1. A pull request can produce standard and analytics observations from the same
   SQL commit and grammar.
2. CI proves the analytics route instead of relying on a configuration flag.
3. Every scheduled contract has an explicit analytics result.
4. Reports cannot confuse backend divergence with version drift.
5. Missing analytics coverage cannot pass as agreement.
6. The required result fails when either backend or the OSD detector contract
   fails.
7. A failed run includes enough immutable identity and logs to reproduce the
   target that was tested.

## 18. Open Questions

1. Which system owns publishing and retaining immutable analytics feature-build
   tuples for required CI?
2. Should the artifact compatibility lock live in this repository or be
   generated by the OpenSearch feature-build pipeline?
3. Which current contract queries produce intentional analytics behavior
   differences once the first observation run is available?
4. Will OSD eventually expose a reliable execution-backend signal to lint
   context? If so, detector expectations may later become backend-aware.
5. After the full semantic lane is required, does the smaller coexistence smoke
   workflow still provide enough independent value to keep?
