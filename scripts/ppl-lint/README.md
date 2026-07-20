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

- `osd_ref` — an OSD commit or branch to validate instead of `main`. Resolved to
  an immutable commit SHA and recorded in the run manifest. A manual run **cannot**
  satisfy branch protection; merge the OSD change first, then rerun the required
  `pull_request` check against OSD `main`.
- `schedule` — `pr` (fast blocking subset) or `nightly` (full corpus).

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
  valid negative control. These block `validation-result`. Phase one:
  `unsupported-window-function-in-eventstats`, `multisearch-min-subsearch`,
  `union-min-datasets`, `replace-wildcard-asymmetry`.
- `pendingReview` — error rules awaiting Peng/Chen usefulness review before
  joining `enforced` (currently `field-validation`).
- `nonEnforcing` — warning/info/advisory/result-shape rules. They run on the
  nightly schedule for coverage and never block a PR.

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
