/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQL-owned detector-validation runner for the PPL lint rule validation CI.
 *
 * This script is executed from inside an OpenSearch-Dashboards (OSD) checkout,
 * for example:
 *
 *   cd .ci/OpenSearch-Dashboards
 *   PPL_LINT_CONTRACT_DIR=<abs path to contracts dir> \
 *   PPL_LINT_SCHEDULE=pr \
 *   PPL_LINT_GRAMMAR_BUNDLE=<abs path to ppl-grammar-bundle.json> \
 *   PPL_LINT_TARGET_MANIFEST=<abs path to target.json> \
 *   PPL_LINT_BACKEND_REPORT=<abs path to backend-report.json> \
 *   PPL_LINT_REPORT=<abs path to detector-report.json> \
 *   node -r ./src/setup_node_env \
 *     "$GITHUB_WORKSPACE/scripts/ppl-lint/run-frontend-contract.mjs"
 *
 * `node -r ./src/setup_node_env` installs OSD's process-wide auto-transpilation
 * hook (`@osd/optimizer`'s `registerNodeAutoTranspilation`), which transpiles
 * `src/plugins/**` and `packages/osd-monaco/src/**` TypeScript on `require()`
 * regardless of where the entry script lives. That is what lets this SQL-owned
 * `.mjs` load OSD's Node-safe headless lint API without OSD's own Jest.
 *
 * This is the detector half of a schema-v3/v4 cross-repository differential
 * contract (see integ-test/src/test/resources/ppl-lint/contracts/*.spec.json).
 * Unlike the earlier PoC — which linted with the compiled analyzer or a
 * hand-rolled reparse against OSD `main`'s checked-in grammar — it lints against
 * the *candidate* runtime grammar bundle the SQL backend job exported, via OSD's
 * production headless API (`headless_ppl_lint`). Both halves therefore validate
 * the exact same candidate grammar (design §4.3).
 *
 * It asserts, per contract:
 *   1. Wiring: the OSD catalog entry deep-equals the contract's `wiring` block,
 *      so a silently removed/retyped/re-gated/re-severitied detector reds the
 *      build.
 *   2. Detector: for the single version expectation that matches the candidate
 *      backend version, each query emits exactly the contracted number of
 *      `ruleId` diagnostics at the contracted severity.
 *   3. Differential (when PPL_LINT_BACKEND_REPORT is supplied): the observed
 *      backend behavior for each query agrees with the observed detector output
 *      — a trigger the detector flags is one the backend rejected; a control the
 *      detector passes is one the backend accepted (design §3.2, §4.3).
 *   4. Coverage (nightly only): every enabled catalog rule has a contract file.
 *
 * ## Two grammar surfaces
 *
 * OSD ships lint on TWO surfaces, and a user gets whichever one their session
 * resolves to:
 *
 *   runtime-bundle       the candidate grammar the engine exported. Requires
 *                        `GET /_plugins/_ppl/_grammar`, which landed in 3.6.
 *   compiled-simplified  OSD's own checked-in grammar, used whenever the runtime
 *                        bundle is unavailable — no dataset selected, an engine
 *                        below 3.6, or a bundle that has not loaded yet. This is
 *                        `lintRuntimePPLQuery`'s fallback path, and it runs
 *                        detector logic the runtime path does not (see
 *                        field_validation's text-side pass).
 *
 * `PPL_LINT_SURFACE` selects which one this run validates; it defaults to
 * `runtime-bundle`, so the required check is unchanged. The compiled surface is
 * an EXPLICIT opt-in, never a silent fallback: the whole point of the required
 * check is that a missing bundle is a hard failure rather than a quiet
 * downgrade to OSD's own grammar (which would validate the wrong thing).
 *
 * The compiled surface is what makes pre-3.6 engine legs meaningful. It also
 * carries a mandatory caveat: `runtimeOnly` rules (multisearch/union/replace
 * arity) are SKIPPED on it by `lint_runner` because the productions they walk do
 * not exist in the compiled grammar. A compiled leg therefore reports them as
 * `not-applicable` rather than as zero diagnostics, so the aggregator cannot
 * mistake a deliberately-inert rule for a detector that regressed.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import {
  assertContractSchema,
  assertExactQueryCoverage,
  classifyBackendReportRow,
  contractChannel,
  indexBackendReport,
  normalizeLintWiring,
  normalizeTarget,
  resolveBackendOracle,
} from './contract-schema.mjs';

// OSD's Node-safe headless lint API (design §4.3). Deep-path module; resolved
// against the OSD checkout root, not this script's SQL-repo location.
const HEADLESS_MODULE = 'src/plugins/data/public/antlr/opensearch_ppl/headless_ppl_lint';
const SYNTAX_MODULE =
  'src/plugins/data/public/antlr/opensearch_ppl/runtime_validation_core';
// The COMPILED-simplified surface: OSD's own checked-in grammar, used when the
// engine cannot export a runtime bundle. See `PPL_LINT_SURFACE` below.
const ANALYZER_MODULE = 'packages/osd-monaco/src/ppl/ppl_language_analyzer';
// The Monaco-free engine barrel (@osd/monaco/ppl-lint) exposes the catalog; the
// detector registry is a deep import used only for the wiring registration check.
const CATALOG_MODULE = 'packages/osd-monaco/ppl-lint';
// Source-path fallback for the catalog. The `ppl-lint` subpath is a built export
// that only exists on checkouts that ship it; the compiled surface deliberately
// supports older checkouts (that is the coverage it adds), so fall back to the
// source module, which `setup_node_env` transpiles on require anyway.
const CATALOG_SOURCE_MODULE = 'packages/osd-monaco/src/ppl/lint/catalog';
const DETECTOR_REGISTRY_MODULE = 'packages/osd-monaco/target/ppl/lint/detector_registry.js';

/**
 * Which grammar surface this run validates. Defaults to `runtime-bundle` so the
 * required check's behavior is unchanged; `compiled-simplified` is an explicit
 * opt-in for legs whose engine cannot export a bundle.
 */
const SURFACE = (() => {
  const requested = process.env.PPL_LINT_SURFACE || 'runtime-bundle';
  if (requested !== 'runtime-bundle' && requested !== 'compiled-simplified') {
    // A typo must not silently select the default: that would report compiled
    // results under a runtime-bundle label, or vice versa.
    // eslint-disable-next-line no-console
    console.error(
      `[ppl-lint-frontend] FATAL: PPL_LINT_SURFACE must be "runtime-bundle" or ` +
        `"compiled-simplified", got "${requested}".`
    );
    process.exit(2);
  }
  return requested;
})();

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[ppl-lint-detector-contract] ${message}`);
}

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-detector-contract] FATAL: ${message}`);
  process.exit(2);
}

function loadContractFile(file) {
  try {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertContractSchema(spec);
    const grammarSurface = spec.grammarSurface || 'runtime-bundle';
    if (!['runtime-bundle', 'compiled-simplified', 'both'].includes(grammarSurface)) {
      throw new Error(
        `[${spec.ruleId}] grammarSurface must be "runtime-bundle", ` +
          `"compiled-simplified", or "both", got ${JSON.stringify(grammarSurface)}.`
      );
    }
    if (!Array.isArray(spec.expectations) || spec.expectations.length === 0) {
      throw new TypeError(`[${spec.ruleId}] expectations must be a non-empty array.`);
    }
    for (const expectation of spec.expectations) {
      assertExactQueryCoverage(spec, expectation);
      for (const queryExpectation of Object.values(expectation.queries)) {
        // Validate every declared oracle, including ranges not selected by this
        // target. Missing route coverage is a supported state; malformed route
        // names and oracle kinds are not.
        resolveBackendOracle(spec, queryExpectation, 'standard');
        resolveBackendOracle(spec, queryExpectation, 'analytics');
      }
    }
    return { file, spec };
  } catch (error) {
    fatal(`Invalid contract ${file}: ${error.message}`);
  }
  return undefined; // unreachable
}

/** Load every *.spec.json under the contract dir, honoring manifest.json if present. */
function loadContracts() {
  const dir = process.env.PPL_LINT_CONTRACT_DIR;
  const single = process.env.PPL_LINT_CONTRACT_FILE;

  if (single) {
    if (!fs.existsSync(single)) {
      fatal(`Contract file not found: ${single}`);
    }
    const contract = loadContractFile(single);
    return {
      contracts: [contract],
      manifest: { contracts: [path.basename(single)] },
      manifestPath: '',
    };
  }

  if (!dir) {
    fatal('Set PPL_LINT_CONTRACT_DIR (a directory of *.spec.json) or PPL_LINT_CONTRACT_FILE.');
  }
  if (!fs.existsSync(dir)) {
    fatal(`Contract directory not found: ${dir}`);
  }

  const manifestPath = path.join(dir, 'manifest.json');
  let files;
  let manifest;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      fatal(`Invalid contract manifest ${manifestPath}: ${error.message}`);
    }
    if (!Array.isArray(manifest.contracts)) {
      fatal(`manifest.json must have a "contracts" array of file names.`);
    }
    if (new Set(manifest.contracts).size !== manifest.contracts.length) {
      fatal(`manifest.json "contracts" contains duplicate file names.`);
    }
    files = manifest.contracts.map((name) => path.join(dir, name));
  } else {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.spec.json'))
      .sort()
      .map((f) => path.join(dir, f));
  }

  const contracts = files.map((file) => {
    if (!fs.existsSync(file)) {
      fatal(`Contract referenced by manifest not found: ${file}`);
    }
    return loadContractFile(file);
  });
  return { contracts, manifest: manifest || { contracts: files.map(path.basename) }, manifestPath };
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

  // Prefer the built subpath (what the required check uses); fall back to source
  // so a checkout without the built export can still run the compiled surface.
  const catalogModule =
    resolveOsd(CATALOG_MODULE, { optional: true }) || resolveOsd(CATALOG_SOURCE_MODULE);
  const { getBundledCatalog } = catalogModule;
  const registry = resolveOsd(DETECTOR_REGISTRY_MODULE, { optional: true });
  if (typeof getBundledCatalog !== 'function') {
    fatal(`getBundledCatalog not found in ${CATALOG_MODULE} or ${CATALOG_SOURCE_MODULE}.`);
  }
  const getDetector = registry && registry.getDetector;

  // On the compiled surface the headless bundle API is not needed at all, and
  // requiring it would make this mode unusable on an OSD checkout that predates
  // it — precisely the older-version coverage the mode exists to provide.
  if (SURFACE === 'compiled-simplified') {
    const { PPLLanguageAnalyzer } = resolveOsd(ANALYZER_MODULE);
    if (typeof PPLLanguageAnalyzer !== 'function') {
      fatal(`PPLLanguageAnalyzer not found in ${ANALYZER_MODULE}.`);
    }
    const analyzer = new PPLLanguageAnalyzer();
    return {
      surface: SURFACE,
      // Same (query, grammar, context) shape as the bundle path so the main loop
      // does not branch per surface; `grammar` is unused here.
      lintQuery: (query, _grammar, context) => {
        const analysis = analyzer.analyzeLint(query, context);
        return (analysis && analysis.result) || { diagnostics: [] };
      },
      getBundledCatalog,
      getDetector,
      osdRoot,
    };
  }

  const headless = resolveOsd(HEADLESS_MODULE);
  const { deserializeBundleOrThrow, lintQueryWithBundle } = headless;
  if (typeof deserializeBundleOrThrow !== 'function' || typeof lintQueryWithBundle !== 'function') {
    fatal(
      `Headless lint API not found in ${HEADLESS_MODULE}. ` +
        `Expected exports deserializeBundleOrThrow + lintQueryWithBundle. ` +
        `Is the OSD checkout on a branch that ships the headless API (design §4.3)?`
    );
  }
  const syntaxModule = resolveOsd(SYNTAX_MODULE, { optional: true });
  const validateSyntax =
    syntaxModule && typeof syntaxModule.validateQueryWithBundle === 'function'
      ? syntaxModule.validateQueryWithBundle
      : undefined;

  return {
    surface: SURFACE,
    deserializeBundleOrThrow,
    lintQuery: lintQueryWithBundle,
    validateSyntax,
    getBundledCatalog,
    getDetector,
    osdRoot,
  };
}

/** Load the candidate grammar bundle + deserialize it once (fail loud; CI has no fallback). */
function loadCandidateGrammar(osd, target) {
  const bundlePath = process.env.PPL_LINT_GRAMMAR_BUNDLE;
  if (!bundlePath) {
    fatal(
      'PPL_LINT_GRAMMAR_BUNDLE is not set. Detector validation lints against the candidate ' +
        'runtime grammar bundle exported by the backend job; there is no compiled fallback.'
    );
  }
  if (!fs.existsSync(bundlePath)) {
    fatal(`Candidate grammar bundle not found: ${bundlePath}`);
  }
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch (error) {
    fatal(`Could not parse grammar bundle ${bundlePath}: ${error.message}`);
  }
  if (bundle.grammarHash !== target.grammarHash) {
    fatal(
      `Candidate grammar hash ${JSON.stringify(bundle.grammarHash)} does not match target ` +
        `${JSON.stringify(target.grammarHash)}.`
    );
  }
  if (target.grammarBundle && path.basename(bundlePath) !== target.grammarBundle) {
    fatal(
      `Candidate grammar filename "${path.basename(bundlePath)}" does not match target ` +
        `"${target.grammarBundle}".`
    );
  }
  try {
    return osd.deserializeBundleOrThrow(bundle);
  } catch (error) {
    fatal(`Could not deserialize candidate grammar bundle: ${error.message}`);
  }
  return undefined; // unreachable
}

/** Read and validate the target identity written beside the grammar bundle. */
function loadTarget() {
  const targetPath = process.env.PPL_LINT_TARGET_MANIFEST;
  if (!targetPath) {
    fatal('PPL_LINT_TARGET_MANIFEST is required.');
  }
  if (!fs.existsSync(targetPath)) {
    fatal(`Target manifest not found: ${targetPath}`);
  }
  try {
    return normalizeTarget(JSON.parse(fs.readFileSync(targetPath, 'utf8')));
  } catch (error) {
    fatal(`Invalid target manifest ${targetPath}: ${error.message}`);
  }
  return undefined; // unreachable
}

/** Index the backend report by `${ruleId}::${queryName}` for the differential. */
function loadBackendReport(target) {
  const reportPath = process.env.PPL_LINT_BACKEND_REPORT;
  if (!reportPath) {
    return undefined;
  }
  if (!fs.existsSync(reportPath)) {
    fatal(`Backend report not found: ${reportPath}`);
  }
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    fatal(`Could not parse backend report ${reportPath}: ${error.message}`);
  }
  try {
    return indexBackendReport(entries, target);
  } catch (error) {
    fatal(`Invalid backend report ${reportPath}: ${error.message}`);
  }
  return undefined; // unreachable
}

/** Coerce "3.8.0-SNAPSHOT" / "3.8" to a comparable [major, minor, patch]. */
function parseVersion(v) {
  if (!v) return undefined;
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v));
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Test a space-separated semver range (e.g. ">=3.6.0 <3.8.0") against the
 * candidate backend version. An empty range or an unknown version matches (do
 * not over-filter). Mirrors PplLintRuleValidationIT.versionMatchesRange.
 */
function versionMatchesRange(range, version) {
  if (!range || !range.trim()) return true;
  const have = parseVersion(version);
  if (!have) return true;
  for (const token of range.trim().split(/\s+/)) {
    let op = '=';
    let ver = token;
    if (token.startsWith('>=')) {
      op = '>=';
      ver = token.slice(2);
    } else if (token.startsWith('<=')) {
      op = '<=';
      ver = token.slice(2);
    } else if (token.startsWith('>')) {
      op = '>';
      ver = token.slice(1);
    } else if (token.startsWith('<')) {
      op = '<';
      ver = token.slice(1);
    } else if (token.startsWith('=')) {
      op = '=';
      ver = token.slice(1);
    }
    const cmp = compareVersion(have, parseVersion(ver) || [0, 0, 0]);
    const ok =
      (op === '>=' && cmp >= 0) ||
      (op === '<=' && cmp <= 0) ||
      (op === '>' && cmp > 0) ||
      (op === '<' && cmp < 0) ||
      (op === '=' && cmp === 0);
    if (!ok) return false;
  }
  return true;
}

/**
 * Select the single expectation that applies to the candidate version + engine.
 * Exactly one must match (design §5.3): zero means the rule test does not cover
 * this version; more than one means overlapping ranges. Both fail.
 */
function selectExpectation(spec, version, isCalcite, failures, { allowMissing = false } = {}) {
  const expectations = spec.expectations || [];
  const matches = expectations.filter((exp) => {
    if (!versionMatchesRange(exp.version, version)) return false;
    if (exp.engine === 'calcite' && isCalcite !== true) return false;
    return true;
  });
  if (matches.length === 1) {
    return matches[0];
  }
  const label = version || 'unknown';
  if (matches.length === 0) {
    if (!allowMissing) {
      failures.push(`[${spec.ruleId}] no version expectation matches backend version ${label}.`);
    }
  } else {
    fatal(
      `[${spec.ruleId}] ${matches.length} expectations match backend version ${label} ` +
        '(exactly one required).'
    );
  }
  return undefined;
}

/**
 * Assert the OSD catalog entry deep-equals the contract's `wiring` block. This is
 * the primary OSD-drift tripwire: if a detector is removed, retyped, re-gated or
 * its severity changed, this fails before any query runs.
 */
function checkWiring(spec, catalog, getDetector, failures) {
  const { ruleId, wiring } = spec;
  if (contractChannel(spec) === 'syntax') {
    return { id: ruleId, syntaxCode: wiring && wiring.code };
  }
  const entry = catalog.find((c) => c.id === ruleId);
  if (!entry) {
    failures.push(`[${ruleId}] not present in the OSD bundled catalog.`);
    return undefined;
  }
  if (!wiring) {
    return entry; // no wiring block to assert
  }

  let expected;
  let actual;
  try {
    expected = normalizeLintWiring(ruleId, wiring, `[${ruleId}] contract.wiring`);
    actual = normalizeLintWiring(ruleId, entry, `[${ruleId}] catalog`);
  } catch (error) {
    failures.push(error.message);
    return entry;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    failures.push(
      `[${ruleId}] normalized wiring mismatch: contract=${JSON.stringify(expected)} ` +
        `catalog=${JSON.stringify(actual)}.`
    );
  }

  if (wiring.detector && typeof getDetector === 'function' && typeof getDetector(wiring.detector) !== 'function') {
    failures.push(`[${ruleId}] has no registered detector "${wiring.detector}".`);
  }

  return entry;
}

/**
 * Build the per-contract lint context passed to `lintQueryWithBundle`. Derives
 * `fields`/`typeMap` from the `deriveFromMapping` block (a single source shared
 * with the backend seeding), pins `dataSourceVersion`/`knownVersion` to the
 * candidate backend version so version filtering matches the backend, and sets
 * an enable override for default-off rules that declare `forceEnable`.
 */
function buildContext(spec, engineVersion) {
  const fc = spec.frontendContext || {};
  const context = {
    isCalcite: fc.isCalcite !== false,
    dataSourceVersion: engineVersion || undefined,
    // Pin the "latest verified engine" to the candidate version rather than the
    // hardcoded OSD_KNOWN_VERSION ('3.7.0'), which can mis-filter rules near a
    // version boundary (design §4.3, D-version).
    knownVersion: engineVersion || undefined,
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

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function buildCensus(contracts, manifest, catalog) {
  const problems = [];
  const byFile = new Map(
    contracts.map(({ file, spec }) => [path.basename(file), spec])
  );
  const resolveManifestRules = (field) => {
    const names = manifest[field] || [];
    if (!Array.isArray(names)) {
      problems.push(`manifest.${field} must be an array.`);
      return [];
    }
    if (new Set(names).size !== names.length) {
      problems.push(`manifest.${field} contains duplicate file names.`);
    }
    const rules = [];
    for (const name of names) {
      const spec = byFile.get(name);
      if (!spec) {
        problems.push(`manifest.${field} references inactive or missing contract "${name}".`);
      } else {
        rules.push(spec.ruleId);
      }
    }
    return rules;
  };

  const activeContractRules = contracts.map(({ spec }) => spec.ruleId).sort();
  const duplicateRuleIds = activeContractRules.filter(
    (ruleId, index) => activeContractRules.indexOf(ruleId) !== index
  );
  if (duplicateRuleIds.length > 0) {
    problems.push(`active contracts contain duplicate rule IDs: ${duplicateRuleIds.join(', ')}.`);
  }

  const activeLintRules = contracts
    .filter(({ spec }) => contractChannel(spec) === 'lint')
    .map(({ spec }) => spec.ruleId)
    .sort();
  const activeSyntaxRules = contracts
    .filter(({ spec }) => contractChannel(spec) === 'syntax')
    .map(({ spec }) => spec.ruleId)
    .sort();
  const enabledRules = catalog
    .filter((rule) => rule.enabled)
    .map((rule) => rule.id)
    .sort();
  const defaultErrorRules = catalog
    .filter((rule) => rule.enabled && rule.severity === 'error')
    .map((rule) => rule.id)
    .sort();
  const manifestDefaultErrorRules = resolveManifestRules('defaultError').sort();
  const requiredSyntaxFeatures = resolveManifestRules('requiredSyntaxFeatures').sort();

  if (activeLintRules.length !== 12) {
    problems.push(`expected 12 active lint contracts, found ${activeLintRules.length}.`);
  }
  if (requiredSyntaxFeatures.length !== 1) {
    problems.push(
      `expected one required syntax feature, found ${requiredSyntaxFeatures.length}.`
    );
  }
  if (activeContractRules.length !== 13) {
    problems.push(`expected 13 active contracts, found ${activeContractRules.length}.`);
  }
  if (!equalSets(new Set(activeSyntaxRules), new Set(requiredSyntaxFeatures))) {
    problems.push(
      `active syntax contracts ${JSON.stringify(activeSyntaxRules)} do not equal ` +
        `manifest.requiredSyntaxFeatures ${JSON.stringify(requiredSyntaxFeatures)}.`
    );
  }
  if (!equalSets(new Set(activeLintRules), new Set(enabledRules))) {
    problems.push(
      `active lint contracts ${JSON.stringify(activeLintRules)} do not equal enabled catalog ` +
        `rules ${JSON.stringify(enabledRules)}.`
    );
  }
  if (!equalSets(new Set(manifestDefaultErrorRules), new Set(defaultErrorRules))) {
    problems.push(
      `manifest.defaultError rules ${JSON.stringify(manifestDefaultErrorRules)} do not equal ` +
        `enabled error catalog rules ${JSON.stringify(defaultErrorRules)}.`
    );
  }

  return {
    enabledRules,
    defaultErrorRules,
    requiredSyntaxFeatures,
    activeContractRules,
    activeLintRules,
    activeSyntaxRules,
    manifestDefaultErrorRules,
    passed: problems.length === 0,
    problems,
  };
}

function main() {
  const schedule = process.env.PPL_LINT_SCHEDULE || 'pr';
  const reportPath = process.env.PPL_LINT_REPORT;
  const target = loadTarget();
  const backendReport = loadBackendReport(target);
  const { contracts, manifest, manifestPath } = loadContracts();

  const osd = loadOsd();
  const {
    getBundledCatalog,
    getDetector,
    lintQuery,
    validateSyntax,
    osdRoot,
    surface,
  } = osd;
  const catalog = getBundledCatalog();
  const census = buildCensus(contracts, manifest, catalog);

  // The compiled surface lints with OSD's own checked-in grammar, so there is no
  // candidate bundle to load. On the runtime surface a missing bundle stays a hard
  // failure — never a quiet downgrade to the compiled grammar.
  const grammar =
    surface === 'compiled-simplified' ? undefined : loadCandidateGrammar(osd, target);
  const engineVersion = target.engineVersion;
  const executionBackend = target.executionBackend;
  const observeAnalytics = process.env.PPL_LINT_OBSERVE_ANALYTICS === '1';
  const observeOnly =
    process.env.PPL_LINT_OBSERVE_ONLY === '1' || observeAnalytics;
  if (observeAnalytics && executionBackend !== 'analytics') {
    fatal('PPL_LINT_OBSERVE_ANALYTICS=1 requires an analytics target.');
  }

  const failures = [];
  // Contracts this surface did not score, recorded so the report says a rule was
  // skipped for surface rather than leaving its absence unexplained.
  const skippedForSurface = [];
  const report = {
    schemaVersion: 2,
    executionBackend,
    osdRoot,
    schedule,
    engineVersion,
    // Which of OSD's two lint surfaces produced these results. The aggregator
    // needs this to interpret them: a compiled leg legitimately has no verdict for
    // `runtimeOnly` rules, and mixing the two surfaces under one label would
    // report a deliberately-inert rule as a regression.
    surface,
    // Contracts whose declared `grammarSurface` excludes this run, so a reader can
    // see WHY a rule has no scored cases here.
    skippedForSurface,
    grammarHash: target.grammarHash || '',
    observeAnalytics,
    observeOnly,
    differential: !!backendReport,
    // Census of the rules that ship enabled at ERROR severity, read from the OSD
    // catalog this run linted with. The multi-version aggregator enforces its
    // `defaultError` manifest set against this list, so a rule that becomes
    // default-error in OSD without a contract file cannot slip through
    // unvalidated — and the aggregator does not need its own OSD checkout to
    // notice (design: default-error is the set users cannot opt out of).
    defaultErrorRules: catalog
      .filter((rule) => rule.enabled && rule.severity === 'error')
      .map((rule) => rule.id)
      .sort(),
    enabledRules: census.enabledRules,
    requiredSyntaxFeatures: census.requiredSyntaxFeatures,
    activeContractRules: census.activeContractRules,
    census: {
      enforced: process.env.PPL_LINT_ENFORCE_CENSUS === '1',
      manifest: manifestPath,
      ...census,
    },
    results: [],
  };
  if (!census.passed) {
    for (const problem of census.problems) {
      log(`CENSUS REPORT-ONLY: ${problem}`);
    }
    if (process.env.PPL_LINT_ENFORCE_CENSUS === '1') {
      failures.push(...census.problems.map((problem) => `[census] ${problem}`));
    }
  }

  log(`OSD root: ${osdRoot}`);
  log(
    `schedule=${schedule} engineVersion=${engineVersion} executionBackend=${executionBackend} ` +
      `grammarHash=${target.grammarHash || '(unset)'} differential=${!!backendReport} ` +
      `contracts=${contracts.length}`
  );

  for (const { file, spec } of contracts) {
    const ruleId = spec.ruleId;
    const index = spec.index;
    const channel = contractChannel(spec);
    const entry = checkWiring(spec, catalog, getDetector, failures);
    if (!entry) {
      continue;
    }

    // A contract runs on PR only when scheduled for PR; nightly runs everything.
    const contractSchedule = spec.schedule || 'pr';
    if (schedule === 'pr' && contractSchedule !== 'pr') {
      log(`SKIP ${ruleId} (schedule=${contractSchedule}, running ${schedule}) — ${path.basename(file)}`);
      continue;
    }

    // A contract declares the surface its expectations were verified against.
    // Until now that field was decorative; honoring it keeps a runtime-bundle
    // contract from being scored on a compiled leg, where its rule may legitimately
    // behave differently. `both` opts into being checked on either surface.
    const contractSurface = spec.grammarSurface || 'runtime-bundle';
    if (contractSurface !== 'both' && contractSurface !== surface) {
      log(
        `SKIP ${ruleId} (grammarSurface=${contractSurface}, running ${surface}) — ` +
          `${path.basename(file)}`
      );
      skippedForSurface.push({ ruleId, contractSurface });
      // Emit an explicit not-applicable row per query rather than dropping the rule.
      // Dropping it leaves the aggregator with no rows at all, which it correctly
      // reads as `inconclusive` — "we could not check" — and fails on. But nothing
      // went wrong here and there is nothing to re-run: this contract simply does
      // not describe this surface.
      for (const [queryName, queryDef] of Object.entries(spec.queries || {})) {
        report.results.push({
          ruleId,
          channel,
          queryName,
          role: queryDef.role || 'trigger',
          query: (queryDef.query || '').split('{{index}}').join(index),
          surface,
          executionBackend,
          outcome: 'not-applicable',
          notApplicable: `contract declares grammarSurface "${contractSurface}"`,
        });
      }
      continue;
    }

    const context = buildContext(spec, engineVersion);
    const expectation = selectExpectation(spec, engineVersion, context.isCalcite, failures, {
      allowMissing: observeOnly,
    });
    if (!expectation) {
      if (!observeOnly) {
        continue;
      }
      for (const [queryName, queryDef] of Object.entries(spec.queries || {})) {
        const role = queryDef.role || 'trigger';
        const query = queryDef.query.split('{{index}}').join(index);
        if (surface === 'compiled-simplified' && entry.runtimeOnly) {
          report.results.push({
            ruleId,
            channel,
            queryName,
            role,
            query,
            surface,
            executionBackend,
            outcome: 'not-applicable',
            notApplicable: 'runtimeOnly rule does not run on the compiled-simplified surface',
          });
          continue;
        }
        if (channel === 'syntax' && typeof validateSyntax !== 'function') {
          fatal(
            `Syntax contract "${ruleId}" requires validateQueryWithBundle from ${SYNTAX_MODULE}. ` +
              `Validate this SQL branch against the OSD headless-syntax PR.`
          );
        }
        const result =
          channel === 'syntax'
            ? validateSyntax(query, grammar)
            : lintQuery(query, grammar, context);
        const matches =
          channel === 'syntax'
            ? result.errors || []
            : (result.diagnostics || []).filter((d) => d.ruleId === ruleId);
        report.results.push({
          ruleId,
          channel,
          queryName,
          role,
          query,
          surface,
          executionBackend,
          expected: 0,
          actual: matches.length,
          severities: matches.map((m) => m.severity),
          severityMatched: true,
          messageMatched: true,
          backendOracleStatus: 'coverage-missing',
          expectationStatus: 'coverage-missing',
        });
      }
      continue;
    }

    const queries = spec.queries || {};
    const expectedQueries = expectation.queries || {};
    try {
      assertExactQueryCoverage(spec, expectation);
    } catch (error) {
      fatal(`Invalid contract ${file}: ${error.message}`);
    }
    for (const queryName of Object.keys(queries)) {
      const queryDef = queries[queryName];
      const role = queryDef.role || 'trigger';
      const query = queryDef.query.split('{{index}}').join(index);
      const expected = expectedQueries[queryName];
      let oracleSelection;
      try {
        oracleSelection = resolveBackendOracle(spec, expected, executionBackend);
      } catch (error) {
        fatal(`Invalid contract ${file} query "${queryName}": ${error.message}`);
      }
      const frontendOracle = oracleSelection.frontend;
      const expectedCount = frontendOracle.count;
      const expectedSeverity = frontendOracle.severity;
      const expectedMessage = frontendOracle.matchMessage;

      // A `runtimeOnly` rule walks grammar productions that exist only in the
      // runtime bundle, so `lint_runner` skips it on the compiled surface. Its
      // zero diagnostics here mean "deliberately inert", NOT "the detector went
      // silent" — reporting them as a count would make the aggregator classify a
      // healthy rule as detector-silent drift and send someone to fix it. Mark the
      // case not-applicable and let the aggregator exclude it.
      if (surface === 'compiled-simplified' && entry && entry.runtimeOnly) {
        log(
          `  SKIP ${ruleId}/${queryName} (${role}): runtimeOnly rule is inert on the ` +
            `compiled-simplified surface.`
        );
        report.results.push({
          ruleId,
          channel,
          queryName,
          role,
          query,
          surface,
          executionBackend,
          outcome: 'not-applicable',
          notApplicable: 'runtimeOnly rule does not run on the compiled-simplified surface',
        });
        continue;
      }

      if (channel === 'syntax' && typeof validateSyntax !== 'function') {
        fatal(
          `Syntax contract "${ruleId}" requires validateQueryWithBundle from ${SYNTAX_MODULE}. ` +
            `Validate this SQL branch against the OSD headless-syntax PR.`
        );
      }
      const result =
        channel === 'syntax'
          ? validateSyntax(query, grammar)
          : lintQuery(query, grammar, context);
      const allFrontendFindings =
        channel === 'syntax' ? result.errors || [] : result.diagnostics || [];
      const matches =
        channel === 'syntax'
          ? allFrontendFindings.filter((finding) => finding.code === frontendOracle.code)
          : allFrontendFindings.filter((finding) => finding.ruleId === ruleId);
      const actual = matches.length;
      const ok = actual === expectedCount;

      log(
        `  ${ok ? 'PASS' : 'FAIL'} ${ruleId}/${queryName} (${role}): ` +
          `expected ${expectedCount}, got ${actual} — ${query}`
      );

      const severityOk =
        channel === 'syntax' ||
        !expectedSeverity ||
        actual === 0 ||
        matches.every((m) => m.severity === expectedSeverity);
      const messageOk =
        !expectedMessage ||
        matches.some((m) => (m.message || '').includes(expectedMessage));
      const fixOk =
        channel !== 'syntax' ||
        frontendOracle.fixText === undefined ||
        matches.some((m) => m.fix && m.fix.text === frontendOracle.fixText);
      const rawMessageOk =
        channel !== 'syntax' ||
        frontendOracle.rawMessage === undefined ||
        matches.some((m) =>
          frontendOracle.rawMessage
            ? typeof m.rawMessage === 'string' && m.rawMessage.length > 0
            : m.rawMessage === undefined
        );
      const totalErrorsOk =
        channel !== 'syntax' ||
        frontendOracle.totalErrors === undefined ||
        allFrontendFindings.length === frontendOracle.totalErrors;

      const resultEntry = {
        ruleId,
        channel,
        queryName,
        role,
        query,
        expected: expectedCount,
        actual,
        severities: matches.map((m) => m.severity).filter(Boolean),
        severityMatched: severityOk,
        messageMatched: messageOk,
        fixMatched: fixOk,
        rawMessageMatched: rawMessageOk,
        totalErrorsMatched: totalErrorsOk,
        ...(channel === 'syntax'
          ? {
              code: frontendOracle.code,
              codes: allFrontendFindings.map((finding) => finding.code).filter(Boolean),
              totalErrors: allFrontendFindings.length,
            }
          : {}),
        executionBackend,
        backendOracleStatus: oracleSelection.status,
      };

      if (!ok) {
        failures.push(
          `[${ruleId}/${queryName}] expected ${expectedCount} "${ruleId}" diagnostic(s), got ${actual} for: ${query}`
        );
      }
      if (!severityOk) {
        failures.push(
          `[${ruleId}/${queryName}] expected severity "${expectedSeverity}" for: ${query}`
        );
      }
      if (!messageOk) {
        failures.push(
          `[${ruleId}/${queryName}] expected message to contain "${expectedMessage}" for: ${query}`
        );
      }
      if (!fixOk) {
        failures.push(
          `[${ruleId}/${queryName}] expected fix text "${frontendOracle.fixText}" for: ${query}`
        );
      }
      if (!rawMessageOk) {
        failures.push(
          `[${ruleId}/${queryName}] expected rawMessage=${frontendOracle.rawMessage} for: ${query}`
        );
      }
      if (!totalErrorsOk) {
        failures.push(
          `[${ruleId}/${queryName}] expected ${frontendOracle.totalErrors} total syntax error(s), ` +
            `got ${allFrontendFindings.length} for: ${query}`
        );
      }

      if (oracleSelection.status === 'not-applicable') {
        // Only the backend fixture is non-applicable. The detector still ran above and its
        // count/severity/message assertions remain ordinary, comparable frontend evidence.
        resultEntry.backendOracleReason = oracleSelection.reason;
      } else if (oracleSelection.status === 'coverage-missing') {
        resultEntry.outcome = 'coverage-missing';
        resultEntry.coverage = 'missing';
        resultEntry.reason = oracleSelection.reason;
        resultEntry.coverageMissing = oracleSelection.reason;
        if (!observeAnalytics) {
          failures.push(
            `[${ruleId}/${queryName}] ${executionBackend} backend coverage missing: ${oracleSelection.reason}.`
          );
        }
      }

      // Differential: the observed backend behavior must agree with the observed
      // detector output through the shared contract (design §3.2, §4.3). A
      // rejection-kind query the backend rejected must be one the detector flags;
      // a success/advisory query the backend accepted must be one the detector
      // passes. This catches drift the two halves would otherwise hide by both
      // pinning to the same JSON.
      if (backendReport) {
        const be = backendReport.get(`${ruleId}::${queryName}`);
        if (!be) {
          failures.push(`[${ruleId}/${queryName}] no backend report entry (backend did not run this query).`);
        } else {
          const backendObservation = classifyBackendReportRow(be);
          if (oracleSelection.status !== 'applicable') {
            // A missing or non-applicable oracle is never an acceptance claim. Keep
            // any backend observation visible, but do not coerce a missing verdict
            // through `!!be.rejected` or score a differential against another route.
            resultEntry.backendOutcome = backendObservation.status;
          } else if (backendObservation.status !== 'observed') {
            resultEntry.backendOutcome = backendObservation.status;
            failures.push(
              `[${ruleId}/${queryName}] backend report has no accepted/rejected verdict ` +
                `(outcome=${JSON.stringify(backendObservation.status)}).`
            );
          } else {
            const backendKind = oracleSelection.oracle.kind;
            const expectRejected = backendKind === 'rejection';
            const backendRejected = backendObservation.rejected;
            resultEntry.backendRejected = backendRejected;
            if (backendRejected !== expectRejected) {
              failures.push(
                `[${ruleId}/${queryName}] differential: backend ${backendRejected ? 'rejected' : 'accepted'} ` +
                  `but the contract's backend.kind="${backendKind}" expects ${expectRejected ? 'rejection' : 'acceptance'} for: ${query}`
              );
            }
            // Trigger cross-check: a trigger the detector flags must be one the engine
            // ALSO objects to — but only where the contract claims the engine objects
            // at all.
            //
            // For a `rejection` rule the two coincide: detector flags <-> engine
            // rejects, and a disagreement means one side drifted. That is the original
            // check and it is unchanged.
            //
            // An ADVISORY rule is different by design. It flags a query the engine
            // runs happily: `head-without-sort` marks non-determinism,
            // `division-by-zero` marks a silent null, `dedup-consecutive` succeeds via
            // the Calcite-to-v2 fallback. "Detector flagged, backend accepted" is that
            // rule working, not drift — so pairing the detector against `be.rejected`
            // failed every advisory trigger unconditionally. That, not runtime cost,
            // is the structural reason those contracts could only run nightly.
            //
            // The contracts already carry the distinction in `backend.kind`, so this
            // reads data that exists rather than adding a flag. Advisory triggers keep
            // full coverage from the other two assertions: the backend-kind check above
            // fires if the engine starts REJECTING a query pinned as accepted, and the
            // `detectorCount` assertion fires if the detector stops flagging it. Only
            // the pairing rule is scoped to the rules it makes sense for.
            const detectorFlagged = actual > 0;
            if (role === 'trigger' && expectRejected && detectorFlagged !== backendRejected) {
              failures.push(
                `[${ruleId}/${queryName}] differential: trigger detector ${detectorFlagged ? 'flagged' : 'passed'} ` +
                  `but backend ${backendRejected ? 'rejected' : 'accepted'} for: ${query}`
              );
            }
            // A control must pass on both sides regardless of kind: it is a valid
            // query the rule has to stay quiet on. Unlike a trigger, that claim does
            // not vary with `backend.kind`.
            if (role === 'control' && (detectorFlagged || backendRejected)) {
              failures.push(
                `[${ruleId}/${queryName}] differential: control must pass on both sides but detector ${detectorFlagged ? 'flagged' : 'passed'} ` +
                  `and backend ${backendRejected ? 'rejected' : 'accepted'} for: ${query}`
              );
            }
            if (
              role === 'suppression-control' &&
              (detectorFlagged || !backendRejected)
            ) {
              failures.push(
                `[${ruleId}/${queryName}] differential: suppression control must retain a backend ` +
                  `syntax rejection without a "${frontendOracle.code}" suggestion, but frontend ` +
                  `${detectorFlagged ? 'suggested a rewrite' : 'did not suggest a rewrite'} and ` +
                  `backend ${backendRejected ? 'rejected' : 'accepted'} for: ${query}`
              );
            }
          }
        }
      }

      report.results.push(resultEntry);
    }
  }

  if (reportPath) {
    report.failures = failures;
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      log(`wrote report to ${reportPath}`);
    } catch (error) {
      fatal(`Could not write detector report ${reportPath}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[ppl-lint-detector-contract] FAIL: ${failures.length} problem(s):\n- ${failures.join('\n- ')}`
    );
    process.exit(1);
  }

  log(`PASS: all contracts agreed with the OSD detectors on the candidate bundle (schedule=${schedule}).`);
}

main();
