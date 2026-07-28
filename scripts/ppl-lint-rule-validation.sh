#!/usr/bin/env bash
#
# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Local developer entry point for the PPL lint rule validation contract.
#
# Runs both halves of the cross-repository check from a SQL checkout, in the same
# order as CI (design §3.1):
#   1. Backend: runs the Gradle integration test against a live /_plugins/_ppl
#      endpoint on the SQL plugin built from this checkout, and — while the
#      cluster is alive — exports the candidate runtime grammar bundle
#      (ppl-grammar-bundle.json), a target manifest (target.json), and the
#      observed backend report (backend-report.json).
#   2. Detector: bootstraps an OpenSearch-Dashboards (OSD) checkout, deserializes
#      the candidate bundle through OSD's headless lint API, runs the real
#      detectors against the same queries, and asserts the detector-vs-backend
#      differential.
#
# The backend half must run first: the detector half lints against the bundle it
# exports. Use SKIP_BACKEND=1 only if you already have the three artifacts.
#
# Usage:
#   # OSD main detector check plus SQL backend IT (fetches OSD into .ci/)
#   ./scripts/ppl-lint-rule-validation.sh
#
#   # Reuse an existing OSD checkout (skips clone + bootstrap if node_modules present)
#   OSD_SOURCE_PATH=../OpenSearch-Dashboards ./scripts/ppl-lint-rule-validation.sh
#
#   # Reproduce a CI run against a specific OSD revision
#   OSD_REF=<sha-from-run-manifest> ./scripts/ppl-lint-rule-validation.sh
#
#   # Skip one half (detector needs the backend artifacts to exist already)
#   SKIP_BACKEND=1 ./scripts/ppl-lint-rule-validation.sh
#   SKIP_DETECTOR=1 ./scripts/ppl-lint-rule-validation.sh
#
#   # Run the full nightly corpus (all rules + coverage assertion)
#   PPL_LINT_SCHEDULE=nightly ./scripts/ppl-lint-rule-validation.sh
#
#   # Run the same corpus through composite/Parquet + DataFusion
#   RUN_ANALYTICS=1 ./scripts/ppl-lint-rule-validation.sh
#
#   # Pass local analytics plugin ZIP overrides through to Gradle
#   RUN_ANALYTICS=1 ./scripts/ppl-lint-rule-validation.sh \
#     -PanalyticsEngineZip=/path/to/analytics-engine.zip

set -euo pipefail

SQL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SQL_ROOT"

OSD_REPO_URL="${OSD_REPO_URL:-https://github.com/opensearch-project/OpenSearch-Dashboards.git}"
OSD_REF="${OSD_REF:-main}"
DEFAULT_OSD_CHECKOUT="$SQL_ROOT/.ci/OpenSearch-Dashboards"
CONTRACT_DIR="$SQL_ROOT/integ-test/src/test/resources/ppl-lint/contracts"
DETECTOR_SCRIPT="$SQL_ROOT/scripts/ppl-lint/run-frontend-contract.mjs"
IT_CLASS="org.opensearch.sql.calcite.remote.PplLintRuleValidationIT"
# pr (fast, blocking subset) or nightly (full corpus + coverage assertion).
PPL_LINT_SCHEDULE="${PPL_LINT_SCHEDULE:-pr}"
RUN_ANALYTICS="${RUN_ANALYTICS:-0}"

# Candidate artifacts the backend half exports and the detector half consumes.
GRAMMAR_BUNDLE="$SQL_ROOT/ppl-grammar-bundle.json"
TARGET_MANIFEST="$SQL_ROOT/target.json"
BACKEND_REPORT="$SQL_ROOT/backend-report.json"
DETECTOR_REPORT="$SQL_ROOT/detector-report.json"

log() { echo "[ppl-lint-rule-validation] $*"; }

run_backend() {
  local backend="standard"
  local gradle_args=(
    :integ-test:integTest
    --tests "$IT_CLASS"
  )
  if [[ "$RUN_ANALYTICS" == "1" ]]; then
    backend="analytics"
    gradle_args=(:integ-test:analyticsEnginePplLintIT)
    # The checked-in schema-v3 contracts intentionally have no analytics
    # oracles yet. Execute them once and retain their raw observations without
    # borrowing the standard route's oracle.
    gradle_args+=(-Dppl.lint.observe.only=true)
  fi

  log "Running $backend backend integration test: $IT_CLASS (schedule=$PPL_LINT_SCHEDULE)"
  gradle_args+=(
    -Dppl.lint.schedule="$PPL_LINT_SCHEDULE"
    -Dppl.lint.execution_backend="$backend"
    -Dppl.lint.sql_sha="$(git rev-parse HEAD)"
    -Dppl.lint.report="$BACKEND_REPORT"
    -Dppl.lint.grammar.bundle="$GRAMMAR_BUNDLE"
    -Dppl.lint.target="$TARGET_MANIFEST"
  )
  ./gradlew "${gradle_args[@]}" "$@"
  log "Backend integration test passed. Exported: $(basename "$GRAMMAR_BUNDLE"), $(basename "$TARGET_MANIFEST")."
}

run_detector() {
  local osd_checkout="$1"

  if [[ ! -f "$GRAMMAR_BUNDLE" ]]; then
    log "ERROR: $GRAMMAR_BUNDLE not found. Run the backend half first (do not set SKIP_BACKEND=1)."
    exit 2
  fi

  if [[ ! -d "$osd_checkout/node_modules" ]]; then
    log "Bootstrapping OSD at $osd_checkout (this can take a while)..."
    (cd "$osd_checkout" && yarn osd bootstrap)
  else
    log "Reusing bootstrapped OSD at $osd_checkout (node_modules present)."
  fi

  log "Running detector validation against the candidate bundle (schedule=$PPL_LINT_SCHEDULE)..."
  (
    cd "$osd_checkout"
    PPL_LINT_CONTRACT_DIR="$CONTRACT_DIR" \
      PPL_LINT_SCHEDULE="$PPL_LINT_SCHEDULE" \
      PPL_LINT_GRAMMAR_BUNDLE="$GRAMMAR_BUNDLE" \
      PPL_LINT_TARGET_MANIFEST="$TARGET_MANIFEST" \
      PPL_LINT_BACKEND_REPORT="$BACKEND_REPORT" \
      PPL_LINT_REPORT="$DETECTOR_REPORT" \
      PPL_LINT_OBSERVE_ONLY="$RUN_ANALYTICS" \
      PPL_LINT_OBSERVE_ANALYTICS="$RUN_ANALYTICS" \
      node -r ./src/setup_node_env "$DETECTOR_SCRIPT"
  )
  log "Detector validation passed."
}

if [[ "${SKIP_BACKEND:-0}" != "1" ]]; then
  run_backend "$@"
else
  log "SKIP_BACKEND=1 — skipping the SQL backend integration test (using existing artifacts)."
fi

if [[ "${SKIP_DETECTOR:-0}" != "1" ]]; then
  if [[ -n "${OSD_SOURCE_PATH:-}" ]]; then
    OSD_CHECKOUT="$(cd "$OSD_SOURCE_PATH" && pwd)"
    log "Using existing OSD checkout: $OSD_CHECKOUT"
  else
    OSD_CHECKOUT="$DEFAULT_OSD_CHECKOUT"
    if [[ ! -d "$OSD_CHECKOUT/.git" ]]; then
      log "Cloning OSD ($OSD_REF) into $OSD_CHECKOUT ..."
      mkdir -p "$(dirname "$OSD_CHECKOUT")"
      git clone --depth 1 --branch "$OSD_REF" "$OSD_REPO_URL" "$OSD_CHECKOUT" 2>/dev/null ||
        git clone "$OSD_REPO_URL" "$OSD_CHECKOUT"
    fi
    log "Checking out OSD ref: $OSD_REF"
    git -C "$OSD_CHECKOUT" fetch --depth 1 origin "$OSD_REF" 2>/dev/null || true
    git -C "$OSD_CHECKOUT" checkout "$OSD_REF" 2>/dev/null ||
      git -C "$OSD_CHECKOUT" checkout FETCH_HEAD
  fi

  OSD_SHA="$(git -C "$OSD_CHECKOUT" rev-parse HEAD)"
  log "OSD revision under test: $OSD_SHA"

  run_detector "$OSD_CHECKOUT"
else
  log "SKIP_DETECTOR=1 — skipping the OSD detector contract."
fi

log "Done."
