/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQL-owned frontend contract adapter for the PPL lint rule validation CI.
 *
 * This script is executed from inside an OpenSearch-Dashboards (OSD) checkout,
 * for example:
 *
 *   cd .ci/OpenSearch-Dashboards
 *   PPL_LINT_CONTRACT_FILE=<abs path to contract .json> \
 *   PPL_SQL_VERSION=<opensearch test version> \
 *   node -r ./src/setup_node_env \
 *     "$GITHUB_WORKSPACE/scripts/ppl-lint/run-frontend-contract.mjs"
 *
 * `node -r ./src/setup_node_env` installs OSD's process-wide auto-transpilation
 * hook (`@osd/optimizer`'s `registerNodeAutoTranspilation`), which transpiles
 * `packages/osd-monaco/src/**` TypeScript on `require()` regardless of where the
 * entry script lives. That is what lets this SQL-owned `.mjs` load the compiled
 * OSD analyzer without OSD's own Jest.
 *
 * The analyzer, catalog and detector registry are NOT re-exported from the
 * `@osd/monaco` package barrel, so they are loaded via their deep module paths.
 * Because this is an ES module, `require` is obtained with `createRequire`, and
 * the modules are resolved against the OSD checkout root (process.cwd()) rather
 * than the location of this script (which lives in the SQL repo, not OSD).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const RULE_MODULE = 'packages/osd-monaco/src/ppl/ppl_language_analyzer';
const CATALOG_MODULE = 'packages/osd-monaco/src/ppl/lint/catalog';
const DETECTOR_REGISTRY_MODULE = 'packages/osd-monaco/src/ppl/lint/detector_registry';

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-frontend-contract] FAIL: ${message}`);
  process.exit(1);
}

function loadContract() {
  const contractFile = process.env.PPL_LINT_CONTRACT_FILE;
  if (!contractFile) {
    fail('PPL_LINT_CONTRACT_FILE is not set.');
  }
  if (!fs.existsSync(contractFile)) {
    fail(`Contract file not found: ${contractFile}`);
  }
  try {
    return JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  } catch (error) {
    fail(`Could not parse contract file ${contractFile}: ${error.message}`);
    return undefined; // unreachable
  }
}

function loadOsdAnalyzer() {
  // Resolve the OSD compiled analyzer from the checkout root. In CI this script
  // runs after `cd .ci/OpenSearch-Dashboards`, so process.cwd() is that root.
  const osdRoot = process.cwd();
  const require = createRequire(path.join(osdRoot, 'noop.js'));

  const resolveOsd = (relativeModule) => {
    const absolute = path.join(osdRoot, relativeModule);
    if (!fs.existsSync(`${absolute}.ts`) && !fs.existsSync(`${absolute}.js`)) {
      fail(
        `Expected OSD module not found under the checkout root: ${relativeModule}\n` +
          `Resolved OSD root: ${osdRoot}\n` +
          `Run this script from the OSD checkout (e.g. cd .ci/OpenSearch-Dashboards) after bootstrap.`
      );
    }
    return require(absolute);
  };

  const { PPLLanguageAnalyzer } = resolveOsd(RULE_MODULE);
  const { getBundledCatalog } = resolveOsd(CATALOG_MODULE);
  const { getDetector } = resolveOsd(DETECTOR_REGISTRY_MODULE);

  if (typeof PPLLanguageAnalyzer !== 'function') {
    fail(`PPLLanguageAnalyzer was not a constructor when loaded from ${RULE_MODULE}.`);
  }
  return { PPLLanguageAnalyzer, getBundledCatalog, getDetector, osdRoot };
}

function assertRuleIsWiredUp(ruleId, getBundledCatalog, getDetector) {
  const entry = getBundledCatalog().find((candidate) => candidate.id === ruleId);
  if (!entry) {
    fail(`Rule "${ruleId}" is not present in the OSD bundled catalog.`);
  }
  if (!entry.enabled) {
    fail(`Rule "${ruleId}" is present but disabled in the OSD bundled catalog.`);
  }
  if (entry.severity !== 'error') {
    fail(`Rule "${ruleId}" severity is "${entry.severity}", expected "error".`);
  }
  if (typeof getDetector(entry.detector) !== 'function') {
    fail(`Rule "${ruleId}" has no registered detector "${entry.detector}".`);
  }
  return entry;
}

function main() {
  const contract = loadContract();
  const ruleId = contract.ruleId;
  const index = contract.index;
  const sqlVersion = process.env.PPL_SQL_VERSION;

  const { PPLLanguageAnalyzer, getBundledCatalog, getDetector, osdRoot } = loadOsdAnalyzer();

  const entry = assertRuleIsWiredUp(ruleId, getBundledCatalog, getDetector);

  // eslint-disable-next-line no-console
  console.log(
    `[ppl-lint-frontend-contract] OSD root: ${osdRoot}\n` +
      `[ppl-lint-frontend-contract] rule "${ruleId}" enabled=${entry.enabled} severity=${entry.severity} detector="${entry.detector}"\n` +
      `[ppl-lint-frontend-contract] PPL_SQL_VERSION=${sqlVersion || '(unset)'}\n` +
      `[ppl-lint-frontend-contract] running ${contract.cases.length} case(s) against index "${index}"`
  );

  const analyzer = new PPLLanguageAnalyzer();
  const failures = [];

  for (const testCase of contract.cases) {
    const query = testCase.query.split('{{index}}').join(index);
    const result = analyzer.lint(query, {
      dataSourceVersion: sqlVersion,
      isCalcite: true,
    });
    const matches = result.diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId);

    // eslint-disable-next-line no-console
    console.log(
      `[ppl-lint-frontend-contract]   ${testCase.id}: expected ${testCase.frontendDiagnosticCount}, ` +
        `got ${matches.length} — ${query}`
    );

    try {
      assert.strictEqual(
        matches.length,
        testCase.frontendDiagnosticCount,
        `case "${testCase.id}": expected ${testCase.frontendDiagnosticCount} "${ruleId}" ` +
          `diagnostic(s) but received ${matches.length} for query: ${query}`
      );
    } catch (error) {
      failures.push(error.message);
    }
  }

  if (failures.length > 0) {
    fail(`${failures.length} case(s) failed:\n- ${failures.join('\n- ')}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ppl-lint-frontend-contract] PASS: all ${contract.cases.length} case(s) matched for "${ruleId}".`
  );
}

main();
