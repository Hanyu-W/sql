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
 *   PPL_LINT_CONTRACT_DIR=<abs path to contracts dir> \
 *   PPL_LINT_SCHEDULE=pr \
 *   PPL_SQL_VERSION=<opensearch test version> \
 *   PPL_LINT_REPORT=<abs path to frontend-report.json> \
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
 *
 * This adapter is the frontend half of a schema-v2 cross-repository differential
 * contract (see integ-test/src/test/resources/ppl-lint/contracts/*.spec.json).
 * It asserts three things per rule:
 *   1. Wiring: the OSD catalog entry deep-equals the contract's `wiring` block,
 *      so a silently removed/retyped/regated detector reds the build.
 *   2. Diagnostics: for each case the analyzer emits exactly the contracted
 *      number of `ruleId` diagnostics (the differential the backend half pins to
 *      live-engine behavior).
 *   3. Coverage (nightly only): every enabled catalog rule has a contract file.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const RULE_MODULE = 'packages/osd-monaco/src/ppl/ppl_language_analyzer';
const CATALOG_MODULE = 'packages/osd-monaco/src/ppl/lint/catalog';
const DETECTOR_REGISTRY_MODULE = 'packages/osd-monaco/src/ppl/lint/detector_registry';
const LINT_RUNNER_MODULE = 'packages/osd-monaco/src/ppl/lint/lint_runner';
const RULE_INDEX_MODULE = 'packages/osd-monaco/src/ppl/lint/rule_index';
const GRAMMAR_MODULE = 'packages/osd-antlr-grammar/target/index.js';
// Explain lint lives only on OSD branches that ship the explain rule class; the
// adapter feature-detects it and skips explain cases when it is absent.
const RUN_EXPLAIN_MODULE = 'packages/osd-monaco/src/ppl/lint/explain/run_explain_lint';

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[ppl-lint-frontend-contract] ${message}`);
}

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-frontend-contract] FATAL: ${message}`);
  process.exit(2);
}

/** Load every *.spec.json under the contract dir, honoring manifest.json if present. */
function loadContracts() {
  const dir = process.env.PPL_LINT_CONTRACT_DIR;
  const single = process.env.PPL_LINT_CONTRACT_FILE;

  if (single) {
    if (!fs.existsSync(single)) {
      fatal(`Contract file not found: ${single}`);
    }
    return [{ file: single, spec: JSON.parse(fs.readFileSync(single, 'utf8')) }];
  }

  if (!dir) {
    fatal('Set PPL_LINT_CONTRACT_DIR (a directory of *.spec.json) or PPL_LINT_CONTRACT_FILE.');
  }
  if (!fs.existsSync(dir)) {
    fatal(`Contract directory not found: ${dir}`);
  }

  const manifestPath = path.join(dir, 'manifest.json');
  let files;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.contracts)) {
      fatal(`manifest.json must have a "contracts" array of file names.`);
    }
    files = manifest.contracts.map((name) => path.join(dir, name));
  } else {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.spec.json'))
      .sort()
      .map((f) => path.join(dir, f));
  }

  return files.map((file) => {
    if (!fs.existsSync(file)) {
      fatal(`Contract referenced by manifest not found: ${file}`);
    }
    return { file, spec: JSON.parse(fs.readFileSync(file, 'utf8')) };
  });
}

function loadOsd() {
  const osdRoot = process.cwd();
  const require = createRequire(path.join(osdRoot, 'noop.js'));

  const resolveOsd = (relativeModule, { optional = false } = {}) => {
    const absolute = path.join(osdRoot, relativeModule);
    const exists =
      fs.existsSync(absolute) ||
      fs.existsSync(`${absolute}.ts`) ||
      fs.existsSync(`${absolute}.js`);
    if (!exists) {
      if (optional) {
        return undefined;
      }
      fatal(
        `Expected OSD module not found under the checkout root: ${relativeModule}\n` +
          `Resolved OSD root: ${osdRoot}\n` +
          `Run this script from the OSD checkout (e.g. cd .ci/OpenSearch-Dashboards) after bootstrap.`
      );
    }
    try {
      return require(absolute);
    } catch (error) {
      if (optional) {
        return undefined;
      }
      throw error;
    }
  };

  const { PPLLanguageAnalyzer } = resolveOsd(RULE_MODULE);
  const { getBundledCatalog } = resolveOsd(CATALOG_MODULE);
  const { getDetector } = resolveOsd(DETECTOR_REGISTRY_MODULE);
  const { runLint } = resolveOsd(LINT_RUNNER_MODULE);
  const ruleIndex = resolveOsd(RULE_INDEX_MODULE);
  const grammar = resolveOsd(GRAMMAR_MODULE, { optional: true });
  const explain = resolveOsd(RUN_EXPLAIN_MODULE, { optional: true });

  if (typeof PPLLanguageAnalyzer !== 'function') {
    fatal(`PPLLanguageAnalyzer was not a constructor when loaded from ${RULE_MODULE}.`);
  }

  return { PPLLanguageAnalyzer, getBundledCatalog, getDetector, runLint, ruleIndex, grammar, explain, osdRoot };
}

/** Coerce "3.8.0-SNAPSHOT" / "3.8" to a comparable [major, minor, patch]. */
function parseVersion(v) {
  if (!v) return undefined;
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v));
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function versionGte(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return true; // unknown → do not skip
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

/**
 * Assert the OSD catalog entry deep-equals the contract's `wiring` block. This is
 * the primary OSD-drift tripwire: if a detector is removed, retyped, re-gated or
 * its severity changed, this fails before any query runs.
 */
function checkWiring(spec, catalog, getDetector, failures) {
  const { ruleId, wiring } = spec;
  const entry = catalog.find((c) => c.id === ruleId);
  if (!entry) {
    failures.push(`[${ruleId}] not present in the OSD bundled catalog.`);
    return undefined;
  }
  if (!wiring) {
    return entry; // no wiring block to assert
  }

  const checks = [
    ['detector', wiring.detector, entry.detector],
    ['enabled', wiring.enabled, entry.enabled],
    ['severity', wiring.severity, entry.severity],
    ['runtimeOnly', !!wiring.runtimeOnly, !!entry.runtimeOnly],
    ['needsContext', !!wiring.needsContext, !!entry.needsContext],
    ['needsExplain', !!wiring.needsExplain, !!entry.needsExplain],
  ];
  for (const [name, expected, actual] of checks) {
    if (expected !== undefined && expected !== actual) {
      failures.push(`[${ruleId}] wiring.${name} expected ${JSON.stringify(expected)} but catalog has ${JSON.stringify(actual)}.`);
    }
  }

  if (wiring.appliesTo) {
    const a = entry.appliesTo || {};
    for (const key of ['minVersion', 'maxVersion', 'engine']) {
      if (wiring.appliesTo[key] !== undefined && wiring.appliesTo[key] !== a[key]) {
        failures.push(`[${ruleId}] wiring.appliesTo.${key} expected ${JSON.stringify(wiring.appliesTo[key])} but catalog has ${JSON.stringify(a[key])}.`);
      }
    }
  }

  if (wiring.detector && typeof getDetector(wiring.detector) !== 'function') {
    failures.push(`[${ruleId}] has no registered detector "${wiring.detector}".`);
  }

  return entry;
}

/**
 * Build the per-case lint context. Derives `fields`/`typeMap` from the
 * `deriveFromMapping` block (a single source shared with the backend seeding),
 * and sets an enable override for default-off rules that declare `forceEnable`.
 */
function buildContext(spec, sqlVersion) {
  const fc = spec.frontendContext || {};
  const context = {
    isCalcite: fc.isCalcite !== false,
    dataSourceVersion: sqlVersion,
    grammarSurface: spec.grammarSurface === 'runtime-bundle' ? 'runtime-bundle' : 'compiled-simplified',
  };

  const mapping = fc.deriveFromMapping;
  if (mapping && typeof mapping === 'object') {
    const fields = new Set();
    const typeMap = new Map();
    for (const [name, type] of Object.entries(mapping)) {
      fields.add(name);
      typeMap.set(name, type);
    }
    context.fields = fields;
    context.typeMap = typeMap;
  }
  if (Array.isArray(fc.disabledObjectFields) && fc.disabledObjectFields.length > 0) {
    context.disabledObjectFields = new Set(fc.disabledObjectFields);
  }
  if (Array.isArray(fc.visibleIndices) && fc.visibleIndices.length > 0) {
    context.visibleIndices = fc.visibleIndices.map((i) => i.split('{{index}}').join(spec.index));
  }
  if (fc.settings && typeof fc.settings === 'object') {
    context.settings = fc.settings;
  }
  if (fc.forceEnable) {
    context.overrides = { [spec.ruleId]: { enabled: true } };
  }
  return context;
}

/** Count diagnostics for this rule via the compiled-simplified analyzer. */
function lintCompiled(analyzer, query, context, ruleId) {
  const result = analyzer.lint(query, context);
  return result.diagnostics.filter((d) => d.ruleId === ruleId);
}

/**
 * Count diagnostics for a runtime-only rule by parsing with the exported runtime
 * grammar and running the detector registry directly. This exercises OSD-main's
 * runtime grammar, NOT the cluster-versioned bundle production fetches, so it is
 * a wiring/coverage check rather than a true cluster-grammar fidelity check.
 * Returns undefined when the runtime grammar can't reach the rule on this OSD
 * checkout (the rule's parser rules are absent) so the caller can skip cleanly.
 */
function lintRuntime(osd, spec, query, context, ruleId) {
  const { grammar, runLint, ruleIndex } = osd;
  if (!grammar || !grammar.OpenSearchPPLParser || !grammar.OpenSearchPPLLexer) {
    return undefined;
  }
  const antlr = requireAntlr(osd.osdRoot);
  if (!antlr) {
    return undefined;
  }
  const { OpenSearchPPLLexer, OpenSearchPPLParser } = grammar;

  const runtimeMap = new Map();
  const names = OpenSearchPPLParser.ruleNames || [];
  for (let i = 0; i < names.length; i++) {
    runtimeMap.set(names[i], i);
  }

  // The exported runtime grammar on this OSD checkout may predate the command a
  // runtime-only rule keys off (union/multisearch/replace are absent on the
  // legacy `opensearch_ppl` grammar). Detecting the absence here lets the caller
  // record a clean skip — the wiring assertion already ran — instead of a false
  // "0 diagnostics" failure.
  const required = spec.requiredParserRules || [];
  for (const name of required) {
    if (!runtimeMap.has(name)) {
      return undefined;
    }
  }

  const input = antlr.CharStream.fromString(query);
  const lexer = new OpenSearchPPLLexer(input);
  const tokenStream = new antlr.CommonTokenStream(lexer);
  const parser = new OpenSearchPPLParser(tokenStream);
  parser.removeErrorListeners();
  const tree = parser.root ? parser.root() : parser.pplStatement && parser.pplStatement();
  if (!tree) {
    return undefined;
  }

  const ruleNameToIndex = ruleIndex.createRuntimeRuleNameToIndex(runtimeMap);

  const diagnostics = runLint(tree, {
    ruleNameToIndex,
    dataSourceVersion: context.dataSourceVersion,
    context: { ...context, grammarSurface: 'runtime-bundle' },
  });
  return diagnostics.filter((d) => d.ruleId === ruleId);
}

let cachedAntlr;
function requireAntlr(osdRoot) {
  if (cachedAntlr !== undefined) {
    return cachedAntlr || undefined;
  }
  try {
    const require = createRequire(path.join(osdRoot, 'noop.js'));
    cachedAntlr = require('antlr4ng');
  } catch {
    cachedAntlr = null;
  }
  return cachedAntlr || undefined;
}

function main() {
  const schedule = process.env.PPL_LINT_SCHEDULE || 'pr';
  const sqlVersion = process.env.PPL_SQL_VERSION;
  const reportPath = process.env.PPL_LINT_REPORT;

  const osd = loadOsd();
  const { PPLLanguageAnalyzer, getBundledCatalog, getDetector, osdRoot } = osd;
  const catalog = getBundledCatalog();
  const analyzer = new PPLLanguageAnalyzer();

  const contracts = loadContracts();
  const failures = [];
  const report = { osdRoot, schedule, sqlVersion, results: [] };

  log(`OSD root: ${osdRoot}`);
  log(`schedule=${schedule} PPL_SQL_VERSION=${sqlVersion || '(unset)'} contracts=${contracts.length}`);

  for (const { file, spec } of contracts) {
    const ruleId = spec.ruleId;
    const index = spec.index;

    // A contract runs on PR only when scheduled for PR; nightly runs everything.
    const contractSchedule = spec.schedule || 'pr';
    if (schedule === 'pr' && contractSchedule !== 'pr') {
      log(`SKIP ${ruleId} (schedule=${contractSchedule}, running ${schedule}) — ${path.basename(file)}`);
      continue;
    }

    const entry = checkWiring(spec, catalog, getDetector, failures);
    if (!entry) {
      continue;
    }

    const context = buildContext(spec, sqlVersion);
    const isRuntime = context.grammarSurface === 'runtime-bundle';

    for (const testCase of spec.cases || []) {
      const query = testCase.query.split('{{index}}').join(index);
      const fe = testCase.frontend || {};
      const expected = fe.diagnosticCount;

      // Per-case version/engine gate mirrors the backend so both halves skip
      // identically instead of disagreeing on a self-suppressed rule.
      if (testCase.minVersionRequired && !versionGte(sqlVersion, testCase.minVersionRequired)) {
        log(`SKIP ${ruleId}/${testCase.id} (needs >= ${testCase.minVersionRequired}, have ${sqlVersion || 'unknown'})`);
        continue;
      }
      if (testCase.engineRequired === 'calcite' && context.isCalcite !== true) {
        log(`SKIP ${ruleId}/${testCase.id} (needs calcite engine)`);
        continue;
      }

      let matches;
      if (testCase.explainFixture) {
        matches = lintExplain(osd, spec, testCase, context, ruleId);
        if (matches === undefined) {
          log(`SKIP ${ruleId}/${testCase.id} (explain lint unavailable on this OSD checkout)`);
          continue;
        }
      } else if (isRuntime) {
        matches = lintRuntime(osd, spec, query, context, ruleId);
        if (matches === undefined) {
          // Runtime grammar can't reach this rule on this OSD checkout: the
          // wiring assertion above still ran, so record a skip (not a failure).
          log(`SKIP ${ruleId}/${testCase.id} (runtime grammar rule absent on this OSD checkout; wiring asserted)`);
          report.results.push({ ruleId, caseId: testCase.id, query, expected, actual: null, skipped: 'runtime-grammar-absent' });
          continue;
        }
      } else {
        matches = lintCompiled(analyzer, query, context, ruleId);
      }

      const actual = matches.length;
      const ok = actual === expected;

      log(`  ${ok ? 'PASS' : 'FAIL'} ${ruleId}/${testCase.id}: expected ${expected}, got ${actual} — ${query}`);

      const severityOk =
        !fe.severity || actual === 0 || matches.every((m) => m.severity === fe.severity);
      const messageOk =
        !fe.matchMessage || matches.some((m) => (m.message || '').includes(fe.matchMessage));

      report.results.push({ ruleId, caseId: testCase.id, query, expected, actual, severities: matches.map((m) => m.severity) });

      if (!ok) {
        failures.push(`[${ruleId}/${testCase.id}] expected ${expected} "${ruleId}" diagnostic(s), got ${actual} for: ${query}`);
      }
      if (!severityOk) {
        failures.push(`[${ruleId}/${testCase.id}] expected severity "${fe.severity}" for: ${query}`);
      }
      if (!messageOk) {
        failures.push(`[${ruleId}/${testCase.id}] expected message to contain "${fe.matchMessage}" for: ${query}`);
      }
    }
  }

  // Nightly-only coverage: every enabled catalog rule must have a contract file.
  if (schedule === 'nightly') {
    const covered = new Set(contracts.map(({ spec }) => spec.ruleId));
    for (const rule of catalog) {
      if (rule.enabled && !covered.has(rule.id)) {
        failures.push(`[coverage] enabled catalog rule "${rule.id}" has no contract file.`);
      }
    }
  }

  if (reportPath) {
    report.failures = failures;
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      log(`wrote report to ${reportPath}`);
    } catch (error) {
      log(`WARN: could not write report to ${reportPath}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[ppl-lint-frontend-contract] FAIL: ${failures.length} problem(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }

  log(`PASS: all contracts agreed with the OSD analyzer (schedule=${schedule}).`);
}

/**
 * Explain-case handling. Loads the captured plan fixture and runs the OSD explain
 * lint over it. Returns undefined when the explain rule class is not present on
 * this OSD checkout (feature-detected via the optional module).
 */
function lintExplain(osd, spec, testCase, context, ruleId) {
  if (!osd.explain || typeof osd.explain.runExplainLint !== 'function') {
    return undefined;
  }
  const dir = process.env.PPL_LINT_CONTRACT_DIR;
  if (!dir) {
    return undefined;
  }
  const fixturePath = path.join(dir, testCase.explainFixture);
  if (!fs.existsSync(fixturePath)) {
    return undefined;
  }
  const plan = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const query = testCase.query.split('{{index}}').join(spec.index);
  const diagnostics = osd.explain.runExplainLint(plan, {
    query,
    overrides: context.overrides,
    dataSourceVersion: context.dataSourceVersion,
    isCalcite: context.isCalcite,
  });
  return (diagnostics || []).filter((d) => d.ruleId === ruleId);
}

main();
