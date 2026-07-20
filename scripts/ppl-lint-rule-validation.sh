#!/usr/bin/env bash
#
# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Local developer entry point for the PPL lint rule validation contract.
#
# Runs both halves of the cross-repository check from a SQL checkout:
#   1. Frontend: loads the compiled OpenSearch-Dashboards (OSD) PPL analyzer and
#      asserts the rule's diagnostic counts against the shared contract.
#   2. Backend: runs the Gradle integration test against a live /_plugins/_ppl
#      endpoint on the SQL plugin built from this checkout.
#
# Usage:
#   # OSD main frontend check plus SQL backend IT (fetches OSD into .ci/)
#   ./scripts/ppl-lint-rule-validation.sh
#
#   # Reuse an existing OSD checkout (skips clone + bootstrap if node_modules present)
#   OSD_SOURCE_PATH=../OpenSearch-Dashboards ./scripts/ppl-lint-rule-validation.sh
#
#   # Reproduce a CI run against a specific OSD revision
#   OSD_REF=<sha-from-job-summary> ./scripts/ppl-lint-rule-validation.sh
#
#   # Skip one half
#   SKIP_BACKEND=1 ./scripts/ppl-lint-rule-validation.sh
#   SKIP_FRONTEND=1 ./scripts/ppl-lint-rule-validation.sh

set -euo pipefail

SQL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SQL_ROOT"

OSD_REPO_URL="${OSD_REPO_URL:-https://github.com/opensearch-project/OpenSearch-Dashboards.git}"
OSD_REF="${OSD_REF:-main}"
DEFAULT_OSD_CHECKOUT="$SQL_ROOT/.ci/OpenSearch-Dashboards"
CONTRACT_FILE="$SQL_ROOT/integ-test/src/test/resources/ppl-lint/unsupported-window-function-in-eventstats.spec.json"
FRONTEND_SCRIPT="$SQL_ROOT/scripts/ppl-lint/run-frontend-contract.mjs"
IT_CLASS="org.opensearch.sql.calcite.remote.PplLintRuleValidationIT"

log() { echo "[ppl-lint-rule-validation] $*"; }

resolve_opensearch_version() {
  local raw
  raw=$(grep -oE '"opensearch.version", "[^"]+"' build.gradle | head -1 |
    sed -E 's/.*"opensearch.version", "([^"]+)"/\1/')
  echo "${raw%%-*}"
}

run_frontend() {
  local osd_checkout="$1"

  if [[ ! -d "$osd_checkout/node_modules" ]]; then
    log "Bootstrapping OSD at $osd_checkout (this can take a while)..."
    (cd "$osd_checkout" && yarn osd bootstrap)
  else
    log "Reusing bootstrapped OSD at $osd_checkout (node_modules present)."
  fi

  local os_version
  os_version="$(resolve_opensearch_version)"
  log "Running frontend contract against OSD analyzer (PPL_SQL_VERSION=$os_version)..."
  (
    cd "$osd_checkout"
    PPL_LINT_CONTRACT_FILE="$CONTRACT_FILE" \
      PPL_SQL_VERSION="$os_version" \
      node -r ./src/setup_node_env "$FRONTEND_SCRIPT"
  )
}

if [[ "${SKIP_FRONTEND:-0}" != "1" ]]; then
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

  run_frontend "$OSD_CHECKOUT"
  log "Frontend contract passed."
else
  log "SKIP_FRONTEND=1 — skipping the OSD frontend contract."
fi

if [[ "${SKIP_BACKEND:-0}" != "1" ]]; then
  log "Running backend integration test: $IT_CLASS"
  ./gradlew :integ-test:integTest --tests "$IT_CLASS"
  log "Backend integration test passed."
else
  log "SKIP_BACKEND=1 — skipping the SQL backend integration test."
fi

log "Done."
