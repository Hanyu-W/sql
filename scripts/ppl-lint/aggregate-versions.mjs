/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-version aggregation for the PPL lint contract.
 *
 * The single-version workflow answers "do the OSD detectors and this engine
 * agree?". This script answers the question that actually protects users: "does
 * every default-ERROR rule still agree with EVERY supported engine version, and
 * if not, what should the linter engineer change?"
 *
 * Inputs: one `--leg <version>=<dir>` per engine version, where <dir> holds that
 * leg's `target.json`, `backend-report.json`, `detector-report.json` and
 * `ppl-grammar-bundle.json` (the same four files the single-version jobs already
 * produce — this script adds no new producer).
 *
 * Output: a `drift-report.json` plus a markdown remediation report. Exits
 * non-zero when any ENFORCED rule drifted on any version, so the check is red
 * exactly when a shipped default-error rule disagrees with a supported engine.
 *
 * Usage:
 *   node scripts/ppl-lint/aggregate-versions.mjs \
 *     --contracts integ-test/src/test/resources/ppl-lint/contracts \
 *     --leg 3.6.0=legs/3.6.0 --leg 3.7.0=legs/3.7.0 --leg 3.8.0=legs/3.8.0 \
 *     --out drift-report.json [--summary $GITHUB_STEP_SUMMARY] [--all-rules]
 *
 * By default only the manifest's `defaultError` set is enforced; `--all-rules`
 * widens the report (still only enforcing `defaultError`) for nightly coverage.
 */

import fs from 'fs';
import path from 'path';

import { emitAnnotations } from './annotate.mjs';
import {
  assertContractSchema,
  assertExactQueryCoverage,
  assertExecutionBackend,
  classifyBackendReportRow,
  contractChannel,
  indexBackendReport,
  normalizeTarget,
  resolveBackendOracle,
} from './contract-schema.mjs';
import {
  classifyDrift,
  classifyExecutionBackendDivergence,
  classifyGrammarDrift,
  classifyRelaxationScope,
  DRIFT_CLASSES,
  formatDriftReport,
  versionInAppliesTo,
} from './drift.mjs';

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[ppl-lint-multiversion] ${message}`);
}

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-multiversion] FATAL: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    legs: [],
    contracts: '',
    out: 'drift-report.json',
    summary: '',
    allRules: false,
    observeAnalytics: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fatal(`${arg} requires a value`);
      return value;
    };
    if (arg === '--leg') {
      const raw = next();
      const eq = raw.indexOf('=');
      if (eq <= 0) fatal(`--leg expects <version>=<dir>, got "${raw}"`);
      args.legs.push({ version: raw.slice(0, eq), dir: raw.slice(eq + 1) });
    } else if (arg === '--contracts') {
      args.contracts = next();
    } else if (arg === '--out') {
      args.out = next();
    } else if (arg === '--summary') {
      args.summary = next();
    } else if (arg === '--all-rules') {
      args.allRules = true;
    } else if (arg === '--observe-analytics') {
      args.observeAnalytics = true;
    } else {
      fatal(`unknown argument "${arg}"`);
    }
  }
  if (args.legs.length === 0) fatal('at least one --leg <version>=<dir> is required');
  if (!args.contracts) fatal('--contracts <dir> is required');
  return args;
}

function readJson(file, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    if (optional) return undefined;
    fatal(`expected file not found: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (optional) return undefined;
    fatal(`could not parse ${file}: ${error.message}`);
  }
  return undefined;
}

function artifactFatal(file, error) {
  fatal(`invalid ${file}: ${error.message}`);
}

function reportRowKey(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`${label} row must be a JSON object`);
  }
  if (typeof entry.ruleId !== 'string' || entry.ruleId.length === 0) {
    throw new TypeError(`${label} row.ruleId must be a non-empty string`);
  }
  if (typeof entry.queryName !== 'string' || entry.queryName.length === 0) {
    throw new TypeError(`${label} row.queryName must be a non-empty string`);
  }
  return `${entry.ruleId}::${entry.queryName}`;
}

function rowExecutionBackend(entry, target, label, key) {
  const hasIdentity = Object.prototype.hasOwnProperty.call(entry, 'executionBackend');
  if (!hasIdentity && !target.legacy) {
    throw new Error(`${label} row ${key} is missing executionBackend for a schema-v2 target`);
  }
  const executionBackend = hasIdentity
    ? assertExecutionBackend(entry.executionBackend, `${label} row ${key}.executionBackend`)
    : 'standard';
  if (executionBackend !== target.executionBackend) {
    throw new Error(
      `${label} row ${key} executionBackend "${executionBackend}" does not match target ` +
        `"${target.executionBackend}"`
    );
  }
  return executionBackend;
}

function validateOptionalRowIdentity(entry, target, label, key) {
  for (const field of ['engineVersion', 'grammarHash']) {
    if (
      Object.prototype.hasOwnProperty.call(entry, field) &&
      entry[field] !== target[field]
    ) {
      throw new Error(
        `${label} row ${key} ${field} ${JSON.stringify(entry[field])} does not match target ` +
          `${JSON.stringify(target[field])}`
      );
    }
  }
}

function normalizeDetectorReport(detector, target) {
  if (!detector || typeof detector !== 'object' || Array.isArray(detector)) {
    throw new TypeError('detector report must be a JSON object');
  }

  const hasIdentity = Object.prototype.hasOwnProperty.call(detector, 'executionBackend');
  if (!hasIdentity && !target.legacy) {
    throw new Error('detector report is missing executionBackend for a schema-v2 target');
  }
  const executionBackend = hasIdentity
    ? assertExecutionBackend(detector.executionBackend, 'detector report.executionBackend')
    : 'standard';
  if (executionBackend !== target.executionBackend) {
    throw new Error(
      `detector report executionBackend "${executionBackend}" does not match target ` +
        `"${target.executionBackend}"`
    );
  }
  if (!target.legacy && detector.schemaVersion !== 2) {
    throw new Error(
      `detector report schemaVersion ${JSON.stringify(detector.schemaVersion)} does not match ` +
        'schema-v2 target'
    );
  }
  for (const field of ['engineVersion', 'grammarHash']) {
    const hasField = Object.prototype.hasOwnProperty.call(detector, field);
    if (!hasField && !target.legacy) {
      throw new Error(`detector report is missing ${field} for a schema-v2 target`);
    }
    if (hasField && detector[field] !== target[field]) {
      throw new Error(
        `detector report ${field} ${JSON.stringify(detector[field])} does not match target ` +
          `${JSON.stringify(target[field])}`
      );
    }
  }
  if (!Array.isArray(detector.results)) {
    throw new TypeError('detector report.results must be a JSON array');
  }
  if (!['runtime-bundle', 'compiled-simplified'].includes(detector.surface)) {
    throw new Error(
      `detector report.surface must be "runtime-bundle" or "compiled-simplified", got ` +
        `${JSON.stringify(detector.surface)}`
    );
  }
  if (!Array.isArray(detector.defaultErrorRules)) {
    throw new TypeError('detector report.defaultErrorRules must be a JSON array');
  }
  for (const field of ['enabledRules', 'requiredSyntaxFeatures', 'activeContractRules']) {
    if (detector[field] === undefined) continue;
    if (!Array.isArray(detector[field])) {
      throw new TypeError(`detector report.${field} must be a JSON array`);
    }
    const values = new Set();
    for (const value of detector[field]) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`detector report.${field} entries must be non-empty strings`);
      }
      if (values.has(value)) {
        throw new Error(`detector report.${field} contains duplicate rule "${value}"`);
      }
      values.add(value);
    }
  }
  const census = new Set();
  for (const ruleId of detector.defaultErrorRules) {
    if (typeof ruleId !== 'string' || ruleId.length === 0) {
      throw new TypeError('detector report.defaultErrorRules entries must be non-empty strings');
    }
    if (census.has(ruleId)) {
      throw new Error(`detector report.defaultErrorRules contains duplicate rule "${ruleId}"`);
    }
    census.add(ruleId);
  }

  const results = new Map();
  for (const entry of detector.results) {
    const key = reportRowKey(entry, 'detector report');
    rowExecutionBackend(entry, target, 'detector report', key);
    validateOptionalRowIdentity(entry, target, 'detector report', key);
    if (results.has(key)) {
      throw new Error(`duplicate detector report key "${key}"`);
    }
    if (!entry.notApplicable && entry.outcome !== 'not-applicable') {
      if (!Number.isInteger(entry.expected) || entry.expected < 0) {
        throw new TypeError(`detector report row ${key}.expected must be a non-negative integer`);
      }
      if (!Number.isInteger(entry.actual) || entry.actual < 0) {
        throw new TypeError(`detector report row ${key}.actual must be a non-negative integer`);
      }
      if (!Array.isArray(entry.severities)) {
        throw new TypeError(`detector report row ${key}.severities must be a JSON array`);
      }
      if (typeof entry.severityMatched !== 'boolean') {
        throw new TypeError(`detector report row ${key}.severityMatched must be a boolean`);
      }
      if (typeof entry.messageMatched !== 'boolean') {
        throw new TypeError(`detector report row ${key}.messageMatched must be a boolean`);
      }
      for (const field of [
        'deterministicFixMatched',
        'fixMatched',
        'rawMessageMatched',
        'totalErrorsMatched',
      ]) {
        if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
          throw new TypeError(`detector report row ${key}.${field} must be a boolean`);
        }
      }
      if (entry.assertions !== undefined) {
        if (
          !entry.assertions ||
          typeof entry.assertions !== 'object' ||
          Array.isArray(entry.assertions)
        ) {
          throw new TypeError(`detector report row ${key}.assertions must be a JSON object`);
        }
        for (const [field, matched] of Object.entries(entry.assertions)) {
          if (typeof matched !== 'boolean') {
            throw new TypeError(
              `detector report row ${key}.assertions.${field} must be a boolean`
            );
          }
        }
      }
      if (entry.mismatches !== undefined && !Array.isArray(entry.mismatches)) {
        throw new TypeError(`detector report row ${key}.mismatches must be a JSON array`);
      }
    }
    results.set(key, entry);
  }
  return { ...detector, executionBackend, resultsByKey: results };
}

function makeLegKey({ label, version, surface, executionBackend }) {
  return [label, version, surface, executionBackend]
    .map((part) => encodeURIComponent(part))
    .join('::');
}

function legFields(leg) {
  return {
    version: leg.version,
    leg: leg.label,
    legKey: leg.key,
    executionBackend: leg.executionBackend,
  };
}

function findingKey(finding) {
  const backend = Array.isArray(finding.executionBackends)
    ? finding.executionBackends.join('-vs-')
    : finding.executionBackend || 'standard';
  return [
    finding.legKey || finding.leg || finding.version,
    backend,
    finding.ruleId,
    finding.queryName || '<rule>',
    finding.driftClass,
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join('::');
}

function reportItemKey(item, kind) {
  return [
    item.legKey || item.leg || item.version,
    item.executionBackend || 'standard',
    item.ruleId,
    item.queryName || '<rule>',
    kind,
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join('::');
}

/** Load the contract corpus, keyed by ruleId, plus the manifest's enforced sets. */
function loadContracts(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const specs = new Map();
  const contractNames = manifest.contracts || [];
  if (!Array.isArray(contractNames)) {
    fatal(`${path.join(dir, 'manifest.json')} contracts must be an array`);
  }
  if (new Set(contractNames).size !== contractNames.length) {
    fatal(`${path.join(dir, 'manifest.json')} contracts contains duplicate file names`);
  }
  for (const name of contractNames) {
    const spec = readJson(path.join(dir, name));
    try {
      assertContractSchema(spec);
      if (!Array.isArray(spec.expectations) || spec.expectations.length === 0) {
        throw new TypeError(`[${spec.ruleId}] expectations must be a non-empty array`);
      }
      for (const expectation of spec.expectations) {
        assertExactQueryCoverage(spec, expectation);
        for (const queryExpectation of Object.values(expectation.queries)) {
          resolveBackendOracle(spec, queryExpectation, 'standard');
          resolveBackendOracle(spec, queryExpectation, 'analytics');
        }
      }
    } catch (error) {
      artifactFatal(path.join(dir, name), error);
    }
    if (specs.has(spec.ruleId)) {
      fatal(`contract manifest contains duplicate ruleId "${spec.ruleId}"`);
    }
    specs.set(spec.ruleId, { spec, file: name });
  }
  // `defaultError` is the multi-version enforced set: every rule that ships
  // enabled at error severity. Fall back to `enforced` for older manifests so
  // this script still runs against an un-migrated corpus.
  const enforcedFiles = new Set(manifest.defaultError || manifest.enforced || []);
  for (const file of enforcedFiles) {
    if (!contractNames.includes(file)) {
      fatal(`manifest.defaultError references inactive or missing contract "${file}"`);
    }
  }
  const requiredSyntaxFiles = manifest.requiredSyntaxFeatures || [];
  if (!Array.isArray(requiredSyntaxFiles)) {
    fatal('manifest.requiredSyntaxFeatures must be an array');
  }
  if (new Set(requiredSyntaxFiles).size !== requiredSyntaxFiles.length) {
    fatal('manifest.requiredSyntaxFeatures contains duplicate file names');
  }
  for (const file of requiredSyntaxFiles) {
    const entry = [...specs.values()].find((candidate) => candidate.file === file);
    if (!entry) {
      fatal(`manifest.requiredSyntaxFeatures references inactive or missing contract "${file}"`);
    }
    if (contractChannel(entry.spec) !== 'syntax') {
      fatal(`manifest.requiredSyntaxFeatures entry "${file}" is not a syntax contract`);
    }
  }
  const enforcedRules = new Set();
  for (const [ruleId, { file }] of specs) {
    if (enforcedFiles.has(file)) enforcedRules.add(ruleId);
  }
  return { specs, enforcedRules, manifest };
}

/**
 * Read one engine version's four artifacts. A leg whose backend never came up
 * is fatal rather than skipped: silently dropping a version would turn a broken
 * matrix into a green check, which is the failure mode this whole contract
 * exists to prevent.
 */
function loadLeg({ version, dir }) {
  const targetFile = path.join(dir, 'target.json');
  const detectorFile = path.join(dir, 'detector-report.json');
  const backendFile = path.join(dir, 'backend-report.json');
  const targetRaw = readJson(targetFile);
  const detectorRaw = readJson(detectorFile);
  const backendRaw = readJson(path.join(dir, 'backend-report.json'));
  const bundle = readJson(path.join(dir, 'ppl-grammar-bundle.json'), { optional: true });

  let target;
  let detector;
  let backend;
  try {
    target = normalizeTarget(targetRaw);
  } catch (error) {
    artifactFatal(targetFile, error);
  }
  try {
    detector = normalizeDetectorReport(detectorRaw, target);
  } catch (error) {
    artifactFatal(detectorFile, error);
  }
  try {
    backend = indexBackendReport(backendRaw, target);
    for (const [key, entry] of backend) {
      validateOptionalRowIdentity(entry, target, 'backend report', key);
    }
  } catch (error) {
    artifactFatal(backendFile, error);
  }
  if (
    bundle &&
    Object.prototype.hasOwnProperty.call(bundle, 'grammarHash') &&
    bundle.grammarHash !== target.grammarHash
  ) {
    fatal(
      `grammar bundle ${path.join(dir, 'ppl-grammar-bundle.json')} reports ` +
        `${JSON.stringify(bundle.grammarHash)} but target reports ` +
        `${JSON.stringify(target.grammarHash)}`
    );
  }

  // The engine's self-reported version wins over the matrix label, so a matrix
  // typo (asking for 3.7.0 and getting 3.8.0) cannot silently mislabel results.
  const reported = target.engineVersion || '';
  if (reported && !reported.startsWith(version.split('-')[0])) {
    log(
      `WARN: leg "${version}" reported engineVersion "${reported}"; using the reported value for ` +
        `version comparisons.`
    );
  }

  const leg = {
    version: reported || version,
    label: version,
    dir,
    grammarHash: target.grammarHash || '',
    sqlSha: target.sqlSha || '',
    executionBackend: target.executionBackend,
    targetSchemaVersion: target.schemaVersion,
    legacyTarget: target.legacy,
    // Which of OSD's two lint surfaces this leg validated. Older detector reports
    // predate the field; they were all runtime-bundle runs.
    surface: detector.surface || 'runtime-bundle',
    parserRuleNames: bundle && Array.isArray(bundle.parserRuleNames) ? bundle.parserRuleNames : undefined,
    detector,
    backend,
  };
  leg.key = makeLegKey(leg);
  return leg;
}

function pairBackendLegs(legs) {
  const identities = new Set();
  for (const leg of legs) {
    if (identities.has(leg.key)) {
      fatal(`duplicate leg identity "${leg.key}"`);
    }
    identities.add(leg.key);
  }

  const runtimeLegs = legs.filter((leg) => leg.surface === 'runtime-bundle');
  const standards = runtimeLegs.filter((leg) => leg.executionBackend === 'standard');
  const analyticsLegs = runtimeLegs.filter((leg) => leg.executionBackend === 'analytics');
  const usedStandards = new Set();
  const pairs = [];
  const neutralLabel = (label) => String(label).replace(/[-_](?:standard|analytics)$/i, '');

  for (const analytics of analyticsLegs) {
    const labelPeers = standards.filter(
      (standard) => neutralLabel(standard.label) === neutralLabel(analytics.label)
    );
    const candidates =
      labelPeers.length > 0
        ? labelPeers
        : standards.filter((standard) => standard.version === analytics.version);
    if (candidates.length === 0) {
      if (standards.length > 0) {
        fatal(
          `analytics leg "${analytics.key}" has no standard peer for engine ` +
            `${analytics.version}`
        );
      }
      continue;
    }

    const sameLabel = candidates.filter((standard) => standard.label === analytics.label);
    const sameGrammar = candidates.filter(
      (standard) => standard.grammarHash === analytics.grammarHash
    );
    let standard;
    if (sameLabel.length === 1) {
      standard = sameLabel[0];
    } else if (sameGrammar.length === 1) {
      standard = sameGrammar[0];
    } else if (candidates.length === 1) {
      standard = candidates[0];
    } else {
      fatal(
        `analytics leg "${analytics.key}" has ${candidates.length} possible standard peers for ` +
          `${analytics.version}; use an unambiguous label/grammar identity`
      );
    }

    if (standard.version !== analytics.version) {
      fatal(
        `paired standard/analytics legs report different engine versions: ` +
          `${standard.label}=${JSON.stringify(standard.version)}, ` +
          `${analytics.label}=${JSON.stringify(analytics.version)}`
      );
    }
    if (!standard.sqlSha || !analytics.sqlSha) {
      fatal(
        `paired standard/analytics legs must both report a non-empty SQL SHA: ` +
          `${standard.label}=${JSON.stringify(standard.sqlSha)}, ` +
          `${analytics.label}=${JSON.stringify(analytics.sqlSha)}`
      );
    }
    if (standard.sqlSha !== analytics.sqlSha) {
      fatal(
        `paired standard/analytics legs report different SQL SHAs: ` +
          `${standard.label}=${JSON.stringify(standard.sqlSha)}, ` +
          `${analytics.label}=${JSON.stringify(analytics.sqlSha)}`
      );
    }
    if (!standard.grammarHash || !analytics.grammarHash) {
      fatal(
        `paired standard/analytics legs for ${analytics.version} must both report a runtime grammar hash`
      );
    }
    if (standard.grammarHash !== analytics.grammarHash) {
      fatal(
        `paired standard/analytics legs for ${analytics.version} have different grammar hashes: ` +
          `${standard.label}=${JSON.stringify(standard.grammarHash)}, ` +
          `${analytics.label}=${JSON.stringify(analytics.grammarHash)}`
      );
    }
    if (usedStandards.has(standard.key)) {
      fatal(
        `standard leg "${standard.key}" matches more than one analytics leg; duplicate backend leg identity`
      );
    }
    usedStandards.add(standard.key);
    const pair = {
      key: `${standard.key}::${analytics.key}`,
      standard,
      analytics,
      engineVersion: analytics.version,
      grammarHash: analytics.grammarHash,
    };
    assertDetectorParity(pair);
    pairs.push(pair);
  }
  return pairs;
}

function detectorParityValue(entry) {
  return {
    channel: entry.channel || 'lint',
    role: entry.role || 'trigger',
    query: entry.query || '',
    expected: entry.expected,
    actual: entry.actual,
    severities: [...(entry.severities || [])].sort(),
    severityMatched:
      typeof entry.severityMatched === 'boolean' ? entry.severityMatched : undefined,
    messageMatched:
      typeof entry.messageMatched === 'boolean' ? entry.messageMatched : undefined,
    fixMatched: typeof entry.fixMatched === 'boolean' ? entry.fixMatched : undefined,
    rawMessageMatched:
      typeof entry.rawMessageMatched === 'boolean' ? entry.rawMessageMatched : undefined,
    totalErrorsMatched:
      typeof entry.totalErrorsMatched === 'boolean' ? entry.totalErrorsMatched : undefined,
    deterministicFixMatched:
      typeof entry.deterministicFixMatched === 'boolean'
        ? entry.deterministicFixMatched
        : undefined,
    assertions: entry.assertions,
    mismatches: entry.mismatches,
    deterministicFix: entry.deterministicFix,
    code: entry.code,
    codes: entry.codes,
    totalErrors: entry.totalErrors,
  };
}

/**
 * Both detector passes use the same OSD checkout, grammar, contracts, and lint
 * context. Any route-qualified difference is therefore a harness defect, not a
 * backend observation.
 */
function assertDetectorParity(pair) {
  const standard = pair.standard.detector.resultsByKey;
  const analytics = pair.analytics.detector.resultsByKey;
  const keys = new Set([...standard.keys(), ...analytics.keys()]);
  for (const key of keys) {
    const standardRow = standard.get(key);
    const analyticsRow = analytics.get(key);
    if (standardRow?.reportOnly === true || analyticsRow?.reportOnly === true) {
      continue;
    }
    if (!standardRow || !analyticsRow) {
      fatal(
        `detector parity failed for ${key}: standard row=${!!standardRow}, ` +
          `analytics row=${!!analyticsRow}`
      );
    }
    const standardValue = detectorParityValue(standardRow);
    const analyticsValue = detectorParityValue(analyticsRow);
    if (JSON.stringify(standardValue) !== JSON.stringify(analyticsValue)) {
      fatal(
        `detector parity failed for ${key}: standard=${JSON.stringify(standardValue)}, ` +
          `analytics=${JSON.stringify(analyticsValue)}`
      );
    }
  }
}

function backendVerdict(entry) {
  if (!entry) {
    return {
      backendRejected: undefined,
      backendType: undefined,
      backendReason: undefined,
    };
  }
  const state = classifyBackendReportRow(entry);
  const observedBackend = entry && entry.observed;
  const rowRejected =
    typeof entry.rejected === 'boolean' ? entry.rejected : undefined;
  const observedRejected =
    observedBackend && typeof observedBackend.rejected === 'boolean'
      ? observedBackend.rejected
      : undefined;
  if (
    typeof rowRejected === 'boolean' &&
    typeof observedRejected === 'boolean' &&
    rowRejected !== observedRejected
  ) {
    fatal(
      `backend report row ${reportRowKey(entry, 'backend report')} has conflicting ` +
        `rejected verdicts`
    );
  }
  const explicitRejected =
    typeof observedRejected === 'boolean' ? observedRejected : rowRejected;
  const usableRawObservation =
    state.status === 'observed' || state.status === 'coverage-missing';
  return {
    backendRejected:
      usableRawObservation && typeof explicitRejected === 'boolean'
        ? explicitRejected
        : undefined,
    backendStatus: observedBackend ? observedBackend.httpStatus : undefined,
    backendType: observedBackend ? observedBackend.type : undefined,
    backendReason: observedBackend ? observedBackend.reason : undefined,
    backendOutcome: entry.outcome,
    backendMismatch: entry.error,
  };
}

function indexDivergentCases(pairs) {
  const cases = new Map();
  for (const pair of pairs) {
    for (const [rowKey, standardEntry] of pair.standard.backend) {
      const analyticsEntry = pair.analytics.backend.get(rowKey);
      if (!analyticsEntry) continue;
      const standardObserved = backendVerdict(standardEntry);
      const analyticsObserved = backendVerdict(analyticsEntry);
      if (
        typeof standardObserved.backendRejected !== 'boolean' ||
        typeof analyticsObserved.backendRejected !== 'boolean' ||
        standardObserved.backendRejected === analyticsObserved.backendRejected
      ) {
        continue;
      }
      const value = { pair, rowKey, standardObserved, analyticsObserved };
      cases.set(`${pair.standard.key}::${rowKey}`, value);
      cases.set(`${pair.analytics.key}::${rowKey}`, value);
    }
  }
  return cases;
}

/**
 * Compare the OSD catalog's default-error census (recorded by each detector leg)
 * against the contracts this run knows about. Returns one entry per rule that
 * ships enabled at error severity with no contract, or whose contract the
 * manifest does not list under `defaultError`.
 *
 * Legs can disagree if they ran against different OSD checkouts, so the union is
 * used: a rule that is default-error on ANY validated OSD ref must be accounted
 * for.
 */
function auditDefaultErrorCensus(legs, specs, enforcedRules) {
  const census = new Set();
  let sawCensus = false;
  for (const leg of legs) {
    const rules = leg.detector && leg.detector.defaultErrorRules;
    if (!Array.isArray(rules)) continue;
    sawCensus = true;
    for (const ruleId of rules) census.add(ruleId);
  }
  if (!sawCensus) {
    log(
      "WARN: no detector leg reported a defaultErrorRules census, so the manifest's defaultError set " +
        'could not be cross-checked against the OSD catalog. Re-run with a detector build that emits it.'
    );
    return [];
  }

  const missing = [];
  for (const ruleId of [...census].sort()) {
    if (!specs.has(ruleId)) {
      missing.push({ ruleId, reason: 'no contract file' });
    } else if (!enforcedRules.has(ruleId)) {
      missing.push({
        ruleId,
        reason: 'contract exists but is not listed under manifest.defaultError',
      });
    }
  }
  for (const ruleId of [...enforcedRules].sort()) {
    if (!census.has(ruleId)) {
      missing.push({
        ruleId,
        reason: 'listed under manifest.defaultError but not enabled at error severity in OSD',
      });
    }
  }
  return missing;
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function auditShippingCensus(legs, specs, manifest) {
  const reports = legs
    .map((leg) => leg.detector)
    .filter(
      (detector) =>
        Array.isArray(detector.enabledRules) &&
        Array.isArray(detector.activeContractRules) &&
        Array.isArray(detector.requiredSyntaxFeatures)
    );
  if (reports.length === 0) {
    return {
      available: false,
      enforced: false,
      passed: false,
      problems: [
        'detector reports predate the active shipping census; rerun with the channel-aware frontend runner',
      ],
    };
  }

  const activeRules = new Set(specs.keys());
  const activeLintRules = new Set(
    [...specs.entries()]
      .filter(([, { spec }]) => contractChannel(spec) === 'lint')
      .map(([ruleId]) => ruleId)
  );
  const activeSyntaxRules = new Set(
    [...specs.entries()]
      .filter(([, { spec }]) => contractChannel(spec) === 'syntax')
      .map(([ruleId]) => ruleId)
  );
  const requiredSyntaxRules = new Set(
    (manifest.requiredSyntaxFeatures || [])
      .map((file) => [...specs.entries()].find(([, entry]) => entry.file === file))
      .filter(Boolean)
      .map(([ruleId]) => ruleId)
  );
  const enabledRules = new Set(reports.flatMap((report) => report.enabledRules));
  const reportedActiveRules = new Set(
    reports.flatMap((report) => report.activeContractRules)
  );
  const reportedSyntaxRules = new Set(
    reports.flatMap((report) => report.requiredSyntaxFeatures)
  );
  const problems = [];

  if (activeLintRules.size !== 12) {
    problems.push(`expected 12 active lint contracts, found ${activeLintRules.size}`);
  }
  if (requiredSyntaxRules.size !== 0) {
    problems.push(`expected no required syntax features, found ${requiredSyntaxRules.size}`);
  }
  if (activeRules.size !== 12) {
    problems.push(`expected 12 active contracts, found ${activeRules.size}`);
  }
  if (!setsEqual(activeLintRules, enabledRules)) {
    problems.push(
      `active lint rules ${JSON.stringify([...activeLintRules].sort())} do not equal enabled OSD ` +
        `rules ${JSON.stringify([...enabledRules].sort())}`
    );
  }
  if (!setsEqual(activeSyntaxRules, requiredSyntaxRules)) {
    problems.push(
      `active syntax rules ${JSON.stringify([...activeSyntaxRules].sort())} do not equal manifest ` +
        `required syntax features ${JSON.stringify([...requiredSyntaxRules].sort())}`
    );
  }
  if (!setsEqual(activeRules, reportedActiveRules)) {
    problems.push('detector report activeContractRules does not match this manifest');
  }
  if (!setsEqual(requiredSyntaxRules, reportedSyntaxRules)) {
    problems.push('detector report requiredSyntaxFeatures does not match this manifest');
  }

  return {
    available: true,
    enforced: reports.some(
      (report) => report.census && report.census.enforced === true
    ),
    enabledRules: [...enabledRules].sort(),
    activeContractRules: [...activeRules].sort(),
    activeLintRules: [...activeLintRules].sort(),
    requiredSyntaxFeatures: [...requiredSyntaxRules].sort(),
    passed: problems.length === 0,
    problems,
  };
}

/**
 * Read one backend report entry into an observation, distinguishing "the engine
 * accepted this" from "we never got an answer".
 *
 * This distinction is load-bearing. The IT marks a transport-level failure
 * `outcome: "error"` and, having never received a verdict, writes no `rejected`
 * field. Coercing that absence to `false` would report a timeout as an engine
 * that now ACCEPTS a query it used to reject — which reads as an engine
 * relaxation and would advise disabling a perfectly good rule. Anything that is
 * not a real observed verdict becomes `undefined`, which the classifier treats as
 * "not observed" rather than as acceptance.
 *
 * Returns `{ observed, usable }`: `usable` is false when this case produced no
 * comparable engine verdict, so the caller can refuse to call it agreement.
 */
function readBackendObservation(backendEntry, detectorResult) {
  const verdict = backendVerdict(backendEntry);
  const hasVerdict = typeof verdict.backendRejected === 'boolean';
  const detectorUsable = !!detectorResult && detectorResult.outcome !== 'error';

  return {
    usable: hasVerdict && detectorUsable,
    observed: {
      detectorCount: detectorResult ? detectorResult.actual : 0,
      severities: detectorResult ? detectorResult.severities || [] : [],
      backendRejected: verdict.backendRejected,
      backendStatus: verdict.backendStatus,
      backendType: verdict.backendType,
      backendReason: verdict.backendReason,
      backendOutcome: verdict.backendOutcome,
      backendMismatch: verdict.backendMismatch,
      severityMatched: detectorResult ? detectorResult.severityMatched : undefined,
      messageMatched: detectorResult ? detectorResult.messageMatched : undefined,
      deterministicFixMatched: detectorResult
        ? detectorResult.deterministicFixMatched
        : undefined,
      fixMatched: detectorResult ? detectorResult.fixMatched : undefined,
      rawMessageMatched: detectorResult ? detectorResult.rawMessageMatched : undefined,
      totalErrorsMatched: detectorResult
        ? detectorResult.totalErrorsMatched
        : undefined,
      assertions: detectorResult ? detectorResult.assertions : undefined,
      mismatches: detectorResult ? detectorResult.mismatches : undefined,
    },
  };
}

function unusableObservationReason(detectorResult) {
  if (!detectorResult) {
    return 'no detector result';
  }
  if (detectorResult.outcome === 'error') {
    const message =
      typeof detectorResult.error === 'string' && detectorResult.error.length > 0
        ? detectorResult.error
        : 'unknown frontend execution error';
    return `frontend execution failed: ${message}`;
  }
  return 'no engine verdict';
}

function failedExtendedFrontendAssertions(entry, frontendOracle) {
  if (!entry) {
    return [];
  }
  const failures = new Set();
  for (const field of [
    'deterministicFixMatched',
    'fixMatched',
    'rawMessageMatched',
    'totalErrorsMatched',
  ]) {
    if (entry[field] === false) {
      failures.add(field);
    }
  }
  for (const [field, matched] of Object.entries(entry.assertions || {})) {
    if (
      matched === false &&
      field !== 'count' &&
      field !== 'severity' &&
      (field !== 'message' || frontendOracle.messageEquals !== undefined)
    ) {
      failures.add(field);
    }
  }
  for (const mismatch of entry.mismatches || []) {
    const field = mismatch && mismatch.field;
    if (
      typeof field === 'string' &&
      field !== 'count' &&
      field !== 'severity' &&
      (field !== 'message' || frontendOracle.messageEquals !== undefined)
    ) {
      failures.add(field);
    }
  }
  return [...failures].sort();
}

/**
 * Pick the contract expectation that applies to a version, reusing the same
 * "exactly one must match" rule as the two single-version halves. Returns
 * undefined when the corpus does not cover this version — reported separately as
 * a coverage hole, not as behavioral drift.
 *
 * The `engine` filter matters as much as the version range: both single-version
 * halves (`PplLintRuleValidationIT.selectExpectation` and
 * `run-frontend-contract.mjs`) drop `engine: "calcite"` entries when Calcite is
 * off. Omitting it here would make a contract that pins one range per engine match
 * TWICE and be misreported as an uncovered version. Every leg in this workflow
 * runs with Calcite enabled (the observation legs do not disable it), so a
 * calcite-scoped expectation is in play; a contract's `frontendContext.isCalcite:
 * false` opts out.
 */
function selectExpectation(spec, version, versionMatchesRange) {
  const isCalcite = !((spec.frontendContext || {}).isCalcite === false);
  const matches = (spec.expectations || []).filter((exp) => {
    if (!versionMatchesRange(exp.version, version)) return false;
    if (exp.engine === 'calcite' && !isCalcite) return false;
    return true;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Minimal semver-range test, kept byte-compatible with the other two halves. */
function makeRangeMatcher() {
  const parse = (v) => {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : undefined;
  };
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  return (range, version) => {
    if (!range || !String(range).trim()) return true;
    const have = parse(version);
    if (!have) return true;
    for (const token of String(range).trim().split(/\s+/)) {
      let op = '=';
      let ver = token;
      for (const candidate of ['>=', '<=', '>', '<', '=']) {
        if (token.startsWith(candidate)) {
          op = candidate;
          ver = token.slice(candidate.length);
          break;
        }
      }
      const c = cmp(have, parse(ver) || [0, 0, 0]);
      const ok =
        (op === '>=' && c >= 0) ||
        (op === '<=' && c <= 0) ||
        (op === '>' && c > 0) ||
        (op === '<' && c < 0) ||
        (op === '=' && c === 0);
      if (!ok) return false;
    }
    return true;
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const versionMatchesRange = makeRangeMatcher();
  const { specs, enforcedRules, manifest } = loadContracts(args.contracts);
  const legs = args.legs.map(loadLeg);
  const backendPairs = pairBackendLegs(legs);
  const divergentCases = indexDivergentCases(backendPairs);

  log(`contracts=${specs.size} enforced(default-error)=${enforcedRules.size} legs=${legs.length}`);
  for (const leg of legs) {
    log(
      `  leg ${leg.label} (${leg.executionBackend}): engine=${leg.version} ` +
        `grammar=${(leg.grammarHash || '—').slice(0, 19)} ` +
        `detectorResults=${(leg.detector.results || []).length} backendCases=${leg.backend.size}`
    );
  }

  const drifts = [];
  const coverageHoles = [];
  // Rule/version pairs where no case could actually be compared (a leg that lost
  // its engine verdicts or its detector rows). Tracked separately from drift
  // because the answer is "re-run / fix the leg", not "edit the linter".
  const inconclusive = [];
  // Cases a leg's grammar surface cannot express (a `runtimeOnly` rule on a
  // compiled-simplified leg). Recorded so the report can say WHY a cell is blank,
  // but never a failure: the rule is inert there by design.
  const notApplicable = [];
  const matrix = []; // one row per rule × backend-qualified leg, for the summary table
  const addDrift = (drift, leg, extra = {}) => {
    const enriched = {
      ...drift,
      ...legFields(leg),
      ...extra,
      executionBackend: drift.executionBackend || leg.executionBackend,
    };
    enriched.key = findingKey(enriched);
    drifts.push(enriched);
    return enriched;
  };

  // A rule that ships enabled at error severity but has no contract file is
  // invisible to this whole check. Compare the manifest's declared set against
  // the census each detector leg recorded from the OSD catalog it linted with, so
  // a new default-error rule cannot land unvalidated.
  const missingContracts = auditDefaultErrorCensus(legs, specs, enforcedRules);
  const shippingCensus = auditShippingCensus(legs, specs, manifest);
  const blockCensusDrift = !shippingCensus.available || shippingCensus.enforced;
  shippingCensus.blocking = blockCensusDrift;
  const blockingShippingCensusProblems = blockCensusDrift
    ? shippingCensus.problems
    : [];
  for (const entry of missingContracts) {
    entry.blocking = blockCensusDrift;
  }
  if (!shippingCensus.passed) {
    for (const problem of shippingCensus.problems) {
      log(`CENSUS ${blockCensusDrift ? 'ENFORCED' : 'REPORT-ONLY'}: ${problem}`);
    }
  }

  for (const [ruleId, { spec, file }] of specs) {
    const isEnforced = enforcedRules.has(ruleId);
    if (!isEnforced && !args.allRules) continue;

    // A rule the catalog does not apply to an engine version ships nothing to
    // users there, so it needs no expectation for it. Only a rule that IS in
    // scope and has no expectation is a genuine hole.
    const appliesTo = (spec.wiring && spec.wiring.appliesTo) || {};

    for (const leg of legs) {
      // A contract only speaks for the surface(s) it declares. Judge it on any
      // other leg and every verdict is meaningless: a runtime-bundle contract on a
      // compiled leg yields "the engine rejects but the rule is scoped away"
      // (version-scope-too-narrow) and "no expectation covers this engine"
      // (coverage hole) — both about a surface the contract never claimed to
      // describe. Checked FIRST, before scope, grammar and coverage, because all
      // three of those produce confident findings from an irrelevant comparison.
      const contractSurface = spec.grammarSurface || 'runtime-bundle';
      const legSurface = leg.surface || 'runtime-bundle';
      if (contractSurface !== 'both' && contractSurface !== legSurface) {
        notApplicable.push({
          ruleId,
          ...legFields(leg),
          surface: legSurface,
          reason: `contract declares grammarSurface "${contractSurface}"`,
        });
        matrix.push({
          ruleId,
          ...legFields(leg),
          status: 'not-applicable',
          drifts: 0,
        });
        continue;
      }

      const inScope = versionInAppliesTo(appliesTo, leg.version);
      if (!inScope) {
        notApplicable.push({
          ruleId,
          ...legFields(leg),
          surface: legSurface,
          kind: 'applies-to',
          reason: `wiring.appliesTo excludes engine ${leg.version}`,
        });
        matrix.push({
          ruleId,
          ...legFields(leg),
          status: 'out-of-scope',
          drifts: 0,
        });
        continue;
      }

      // A parser rule that vanished from the grammar is one fact about this
      // rule on this engine, not one per query — raise it once and move on, so
      // the report shows the single edit to make instead of the same paragraph
      // repeated for every case.
      if (inScope) {
        const grammarDrift = classifyGrammarDrift({
          ruleId,
          version: leg.version,
          requiredParserRules: spec.requiredParserRules,
          detectorPath: spec.detectorPath,
          parserRuleNames: leg.parserRuleNames,
          executionBackend: leg.executionBackend,
        });
        if (grammarDrift) {
          addDrift(grammarDrift, leg, { enforced: isEnforced, contractFile: file });
          matrix.push({ ruleId, ...legFields(leg), status: 'drift', drifts: 1 });
          continue;
        }
      }

      const expectation = selectExpectation(spec, leg.version, versionMatchesRange);
      if (!expectation) {
        // In scope on this engine but nothing pins its behavior there.
        coverageHoles.push({
          ruleId,
          file,
          ...legFields(leg),
          enforced: isEnforced,
          reason: 'no version expectation matches this engine',
        });
        matrix.push({ ruleId, ...legFields(leg), status: 'uncovered', drifts: 0 });
        continue;
      }

      let ruleDrifts = 0;
      let compared = 0;
      // Triggers are counted separately from controls. A trigger is the rule's
      // entire behavioral claim ("this query is flagged"); a control only says the
      // rule stays quiet nearby. So a rule that lost every trigger but kept one
      // control has proven nothing about itself, even though `compared` is
      // non-zero — flat-object-subfield has 3 triggers and 1 control, and would
      // otherwise render `agree` off the control alone.
      let triggersExpected = 0;
      let triggersCompared = 0;
      // Cases this leg's surface cannot express. Counted separately from `unusable`
      // because the two need opposite advice: not-applicable is expected and needs
      // no action, unusable means something did not answer and needs a re-run.
      let ruleNotApplicable = 0;
      let ruleCoverageHoles = 0;
      const unusable = [];
      // Per-trigger engine verdicts for this rule on this leg, so a relaxation can
      // be judged across the WHOLE rule rather than one query at a time. A single
      // relaxed trigger cannot distinguish a full engine fix (scope the rule away)
      // from a partial one (narrow the detector), and those actions are opposites —
      // acting on the per-query view ships a false negative in the partial case.
      // `unobserved` is kept apart from `holding` on purpose: a trigger that never
      // answered must not be counted as "still rejects", or a timed-out leg would
      // read as a partial fix and send someone to narrow a healthy detector.
      const relaxedTriggers = [];
      const holdingTriggers = [];
      const unobservedTriggers = [];
      let relaxedDetectorFlagged = false;
      const perQueryDrifts = [];
      for (const [queryName, expected] of Object.entries(expectation.queries || {})) {
        const queryDef = (spec.queries || {})[queryName];
        if (!queryDef) {
          // The contract references a query it does not define. The single-version
          // halves fail on this, but skipping it silently here would shrink the
          // compared set without saying so.
          unusable.push(`${queryName} (not defined in the contract's queries map)`);
          continue;
        }
        const query = queryDef.query.split('{{index}}').join(spec.index);
        const role = queryDef.role || 'trigger';
        if (role === 'trigger') {
          triggersExpected++;
        }

        let oracleSelection;
        try {
          oracleSelection = resolveBackendOracle(spec, expected, leg.executionBackend);
        } catch (error) {
          artifactFatal(`${file} query "${queryName}"`, error);
        }
        const rowKey = `${ruleId}::${queryName}`;
        const detectorResult = leg.detector.resultsByKey.get(rowKey);
        const backendEntry = leg.backend.get(rowKey);
        if (
          detectorResult &&
          !detectorResult.notApplicable &&
          detectorResult.outcome !== 'not-applicable'
        ) {
          if (detectorResult.expected !== oracleSelection.detector.count) {
            fatal(
              `detector report row ${rowKey} expected=${JSON.stringify(detectorResult.expected)} ` +
                `does not match contract detectorCount=${oracleSelection.detector.count}`
            );
          }
          if ((detectorResult.role || 'trigger') !== role) {
            fatal(
              `detector report row ${rowKey} role=${JSON.stringify(detectorResult.role)} ` +
                `does not match contract role=${JSON.stringify(role)}`
            );
          }
        }
        if (detectorResult && detectorResult.outcome === 'error') {
          unusable.push(`${queryName} (${unusableObservationReason(detectorResult)})`);
          if (role === 'trigger') {
            unobservedTriggers.push(queryName);
          }
          continue;
        }

        if (oracleSelection.status === 'coverage-missing') {
          const { usable } = readBackendObservation(backendEntry, detectorResult);
          if (!usable) {
            unusable.push(`${queryName} (${unusableObservationReason(detectorResult)})`);
            if (role === 'trigger') {
              unobservedTriggers.push(queryName);
            }
            continue;
          }
          coverageHoles.push({
            ruleId,
            queryName,
            file,
            ...legFields(leg),
            enforced: isEnforced,
            reason: oracleSelection.reason,
            kind: 'backend-oracle',
          });
          ruleCoverageHoles++;
          continue;
        }
        if (oracleSelection.status === 'not-applicable') {
          const backendState = backendEntry
            ? classifyBackendReportRow(backendEntry)
            : { status: 'error' };
          if (!detectorResult || backendState.status !== 'not-applicable') {
            unusable.push(
              `${queryName} (${
                !detectorResult
                  ? 'no detector result'
                  : 'backend did not report not-applicable'
              })`
            );
            continue;
          }
          notApplicable.push({
            ruleId,
            queryName,
            ...legFields(leg),
            surface: leg.surface,
            reason: oracleSelection.reason,
            kind: 'backend-oracle',
          });
          ruleNotApplicable++;
          if (isEnforced) {
            coverageHoles.push({
              ruleId,
              queryName,
              file,
              ...legFields(leg),
              enforced: true,
              reason:
                `default-error rule is not applicable on ${leg.executionBackend}: ` +
                `${oracleSelection.reason}`,
              kind: 'backend-oracle',
              issue: oracleSelection.oracle.issue,
              owner: oracleSelection.oracle.owner,
            });
            ruleCoverageHoles++;
          }
          continue;
        }

        // A case the surface cannot express at all (a `runtimeOnly` rule on a
        // compiled-simplified leg) is excluded rather than compared. Its zero
        // diagnostics are `lint_runner` deliberately skipping the rule, so
        // comparing them against a non-zero expectation would classify a healthy
        // rule as detector-silent and send someone to fix it. This is NOT the same
        // as `inconclusive`: nothing went wrong, and there is nothing to re-run.
        if (detectorResult && detectorResult.notApplicable) {
          notApplicable.push({
            ruleId,
            queryName,
            ...legFields(leg),
            surface: leg.surface,
            reason: detectorResult.notApplicable,
          });
          ruleNotApplicable++;
          continue;
        }
        const failedFrontendAssertions = failedExtendedFrontendAssertions(
          detectorResult,
          oracleSelection.frontend
        );
        if (failedFrontendAssertions.length > 0) {
          addDrift(
            {
              ruleId,
              version: leg.version,
              driftVersion: leg.version,
              queryName,
              role,
              query,
              driftClass: 'frontend-contract-mismatch',
              evidence:
                `${ruleId} @ ${leg.version} [${queryName}]: frontend assertion(s) failed: ` +
                failedFrontendAssertions.join(', '),
              frontendAssertions: failedFrontendAssertions,
              frontendMismatches: detectorResult.mismatches || [],
              remediation: {
                action: 'update-detector',
                target:
                  spec.detectorPath ||
                  `packages/osd-monaco/src/ppl/lint/rules/${ruleId.replace(/-/g, '_')}.ts`,
                detail:
                  `Reproduce this contract query against the reported OSD commit and candidate ` +
                  `grammar. Restore the exact message/action/fix behavior, or update the contract ` +
                  `only after confirming an intentional product change.`,
              },
            },
            leg,
            {
              enforced: isEnforced,
              contractFile: file,
              expectationRange: expectation.version,
              expectationEngine: expectation.engine,
            }
          );
          ruleDrifts++;
          compared++;
          if (role === 'trigger') {
            triggersCompared++;
          }
          continue;
        }
        const { observed, usable } = readBackendObservation(backendEntry, detectorResult);
        if (!usable) {
          // No comparable pair, so there is nothing to classify. Attempting it
          // anyway would turn a dead leg into linter advice: a case with no engine
          // verdict and no detector row looks exactly like "the detector went
          // silent", and the report would tell the engineer to go fix a detector
          // that is fine. Record it as not compared and move on.
          unusable.push(`${queryName} (${unusableObservationReason(detectorResult)})`);
          if (role === 'trigger') {
            unobservedTriggers.push(queryName);
          }
          continue;
        }
        compared++;
        const pairedDivergence = divergentCases.get(`${leg.key}::${rowKey}`);
        if (role === 'trigger') {
          triggersCompared++;
          // Bucket this trigger by what the ENGINE did, but only where the contract
          // pinned a rejection — a trigger pinned as accepted (an advisory rule like
          // head-without-sort, whose queries are all valid PPL) never "relaxes", and
          // counting it as relaxed would fabricate a full-fix verdict for a rule the
          // engine was never rejecting in the first place.
          const pinnedRejection = oracleSelection.oracle.kind === 'rejection';
          if (
            pinnedRejection &&
            (!pairedDivergence || leg.executionBackend === 'standard')
          ) {
            if (observed.backendRejected === false) {
              relaxedTriggers.push(queryName);
              if ((observed.detectorCount || 0) > 0) relaxedDetectorFlagged = true;
            } else if (observed.backendRejected === true) {
              holdingTriggers.push(queryName);
            }
          }
        }

        const drift =
          pairedDivergence && leg.executionBackend === 'analytics'
            ? null
            : classifyDrift({
              ruleId,
              version: leg.version,
              queryName,
              role,
              query,
              expected: {
                detectorCount: oracleSelection.detector.count,
                severity: oracleSelection.detector.severity,
                matchMessage: oracleSelection.detector.matchMessage,
                backendKind: oracleSelection.oracle.kind,
              },
              observed,
              wiring: spec.wiring,
              detectorPath: spec.detectorPath,
              parserRuleNames: leg.parserRuleNames,
              requiredParserRules: spec.requiredParserRules,
              expectedBackend: oracleSelection.oracle,
              executionBackend: leg.executionBackend,
            });

        if (drift) {
          // `expectationRange` is what the annotation anchors to: the version
          // string identifies WHICH `expectations[]` entry produced this finding,
          // so a `update-contract` annotation can land on that entry's line rather
          // than at the top of the file.
          // Buffered rather than pushed: a relaxation finding is only final once
          // every trigger has been seen, because the rule-level rollup below
          // replaces the per-query ones with a single full-vs-partial verdict.
          perQueryDrifts.push({
            ...drift,
            enforced: isEnforced,
            contractFile: file,
            expectationRange: expectation.version,
            expectationEngine: expectation.engine,
          });
        }
      }

      // Every trigger has now been observed, so a relaxation can be judged for the
      // rule as a whole. This supersedes the per-query `engine-relaxed` findings —
      // they each said "scope this rule away from this version", which is the wrong
      // action whenever another trigger still rejects.
      const relaxationScope =
        leg.executionBackend === 'standard'
          ? classifyRelaxationScope({
              ruleId,
              version: leg.version,
              relaxedTriggers,
              holdingTriggers,
              unobservedTriggers,
              detectorFlagged: relaxedDetectorFlagged,
              wiring: spec.wiring,
              detectorPath: spec.detectorPath,
              executionBackend: leg.executionBackend,
            })
          : null;
      const kept = relaxationScope
        ? perQueryDrifts.filter((d) => d.supersededBy !== DRIFT_CLASSES.ENGINE_PARTIALLY_RELAXED)
        : perQueryDrifts;
      for (const drift of kept) {
        addDrift(drift, leg);
        ruleDrifts++;
      }
      if (relaxationScope) {
        addDrift(relaxationScope, leg, {
          enforced: isEnforced,
          contractFile: file,
          expectationRange: expectation.version,
          expectationEngine: expectation.engine,
        });
        ruleDrifts++;
      }
      // "agree" has to mean "we compared the rule's claim and it held". A rule
      // whose every case lost its engine verdict (a timed-out leg) or its detector
      // row (a runner that died mid-corpus) has proven nothing — and so has one
      // that lost every TRIGGER while keeping a control, since the triggers are
      // where the rule's behavior actually lives. Calling either agreement is the
      // vacuous pass this check exists to prevent.
      // A rule the surface cannot express at all is `n/a`, not `inconclusive`:
      // nothing failed and there is nothing to re-run, so it must not fail the run.
      // Checked BEFORE the inconclusive test, which would otherwise catch it
      // (compared === 0) and demand a re-run that could never change the outcome.
      if (unusable.length > 0) {
        inconclusive.push({
          ruleId,
          file,
          ...legFields(leg),
          enforced: isEnforced,
          reasons: unusable,
        });
        matrix.push({
          ruleId,
          ...legFields(leg),
          status: 'inconclusive',
          drifts: ruleDrifts,
        });
      } else if (ruleCoverageHoles > 0) {
        matrix.push({
          ruleId,
          ...legFields(leg),
          status: ruleDrifts > 0 ? 'drift' : 'uncovered',
          drifts: ruleDrifts,
        });
      } else if (compared === 0 && ruleNotApplicable > 0) {
        matrix.push({
          ruleId,
          ...legFields(leg),
          status: 'not-applicable',
          drifts: 0,
        });
      } else if (compared === 0 || (triggersExpected > 0 && triggersCompared === 0)) {
        inconclusive.push({
          ruleId,
          file,
          ...legFields(leg),
          enforced: isEnforced,
          reasons: unusable,
        });
        matrix.push({
          ruleId,
          ...legFields(leg),
          status: 'inconclusive',
          drifts: ruleDrifts,
        });
      } else {
        matrix.push({
          ruleId,
          ...legFields(leg),
          status: ruleDrifts === 0 ? 'agree' : 'drift',
          drifts: ruleDrifts,
        });
      }
    }

    const contractSurface = spec.grammarSurface || 'runtime-bundle';
    if (contractSurface === 'runtime-bundle' || contractSurface === 'both') {
      for (const pair of backendPairs) {
        for (const [queryName, queryDef] of Object.entries(spec.queries || {})) {
          const rowKey = `${ruleId}::${queryName}`;
          const divergent = divergentCases.get(`${pair.analytics.key}::${rowKey}`);
          if (!divergent || divergent.pair.key !== pair.key) continue;

          const query = queryDef.query.split('{{index}}').join(spec.index);
          const drift = classifyExecutionBackendDivergence({
            ruleId,
            version: pair.engineVersion,
            queryName,
            role: queryDef.role || 'trigger',
            query,
            standardObserved: divergent.standardObserved,
            analyticsObserved: divergent.analyticsObserved,
            standardLeg: pair.standard.label,
            analyticsLeg: pair.analytics.label,
            grammarHash: pair.grammarHash,
            detectorPath: spec.detectorPath,
          });
          if (!drift) continue;

          const expectation = selectExpectation(spec, pair.engineVersion, versionMatchesRange);
          addDrift(drift, pair.analytics, {
            enforced: isEnforced,
            contractFile: file,
            expectationRange: expectation && expectation.version,
            expectationEngine: expectation && expectation.engine,
            pairKey: pair.key,
            standardLeg: pair.standard.label,
            standardLegKey: pair.standard.key,
            analyticsLeg: pair.analytics.label,
            analyticsLegKey: pair.analytics.key,
          });

          for (const row of matrix) {
            if (
              row.ruleId === ruleId &&
              (row.legKey === pair.standard.key || row.legKey === pair.analytics.key)
            ) {
              row.status = 'drift';
              row.drifts += 1;
            }
          }
        }
      }
    }
  }

  for (const collection of [drifts, coverageHoles, inconclusive, notApplicable, matrix]) {
    for (const entry of collection) {
      const contract = specs.get(entry.ruleId);
      entry.channel = contract ? contractChannel(contract.spec) : 'lint';
    }
  }
  for (const drift of drifts) {
    if (drift.channel !== 'syntax') continue;
    drift.remediation = {
      action: 'review-syntax-validation',
      target:
        'OSD runtime_validation_core and the syntax contract expectation',
      detail:
        `Reproduce "${drift.ruleId}" with the candidate runtime grammar. Update the shared OSD ` +
        `parser/listener core if UNKNOWN_COMMAND identity, suppression, or quick-fix behavior ` +
        `regressed; update this contract only after confirming an intentional syntax UX change. ` +
        `Do not change detector catalog appliesTo metadata for a syntax-channel failure.`,
    };
  }

  const isObservedAnalyticsFinding = (entry) =>
    args.observeAnalytics &&
    (entry.executionBackend === 'analytics' ||
      (Array.isArray(entry.executionBackends) &&
        entry.executionBackends.includes('analytics'))) &&
    (entry.driftClass === DRIFT_CLASSES.EXECUTION_BACKEND_DIVERGENCE ||
      entry.driftClass === DRIFT_CLASSES.BACKEND_ORACLE_MISMATCH ||
      entry.kind === 'backend-oracle');
  for (const drift of drifts) {
    drift.blocking =
      (!!drift.enforced || args.allRules) && !isObservedAnalyticsFinding(drift);
  }
  for (const hole of coverageHoles) {
    hole.blocking =
      (!!hole.enforced || args.allRules) && !isObservedAnalyticsFinding(hole);
  }
  const enforcedDrifts = drifts.filter((d) => d.blocking);
  const enforcedHoles = coverageHoles.filter((h) => h.blocking);
  // `--all-rules` makes drift, missing coverage, and inconclusive observations
  // blocking for every active shipping rule in the manifest.
  const enforcedInconclusive = inconclusive.filter((i) => i.enforced || args.allRules);
  const blockingMissingContracts = missingContracts.filter((entry) => entry.blocking);
  for (const row of matrix) {
    row.key = reportItemKey(row, 'matrix');
  }
  for (const hole of coverageHoles) {
    hole.key = reportItemKey(hole, 'coverage-hole');
  }
  for (const entry of inconclusive) {
    entry.key = reportItemKey(entry, 'inconclusive');
  }
  for (const entry of notApplicable) {
    entry.key = reportItemKey(entry, 'not-applicable');
  }

  const report = {
    schemaVersion: 2,
    keyDimensions: ['leg', 'engineVersion', 'grammarSurface', 'executionBackend'],
    legs: legs.map((l) => ({
      key: l.key,
      label: l.label,
      engineVersion: l.version,
      grammarHash: l.grammarHash,
      sqlSha: l.sqlSha,
      surface: l.surface,
      executionBackend: l.executionBackend,
    })),
    backendPairs: backendPairs.map((pair) => ({
      key: pair.key,
      engineVersion: pair.engineVersion,
      grammarHash: pair.grammarHash,
      standardLegKey: pair.standard.key,
      analyticsLegKey: pair.analytics.key,
    })),
    enforcedRules: [...enforcedRules].sort(),
    missingContracts,
    shippingCensus,
    manifestDescription: manifest.description || '',
    matrix,
    drifts,
    coverageHoles,
    inconclusive,
    notApplicable,
    result: {
      driftCount: drifts.length,
      enforcedDriftCount: enforcedDrifts.length,
      enforcedCoverageHoles: enforcedHoles.length,
      observedAnalyticsFindings:
        drifts.filter((d) => d.enforced && !d.blocking).length +
        coverageHoles.filter((h) => h.enforced && !h.blocking).length,
      missingContractCount: missingContracts.length,
      blockingMissingContractCount: blockingMissingContracts.length,
      blockingShippingCensusProblems: blockingShippingCensusProblems.length,
      enforcedInconclusive: enforcedInconclusive.length,
      // An inconclusive default-error rule fails too: "we could not check" must
      // never render as "it is fine".
      passed:
        enforcedDrifts.length === 0 &&
        enforcedHoles.length === 0 &&
        blockingMissingContracts.length === 0 &&
        blockingShippingCensusProblems.length === 0 &&
        enforcedInconclusive.length === 0,
    },
  };

  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(`wrote ${args.out}`);

  // Emitted BEFORE the summary on purpose. GitHub renders annotations at the top
  // of the run page, which is where a developer looks first; without them the only
  // thing above the summary is "Process completed with exit code 1" and the
  // natural next click goes to raw logs instead of the remediation. When the
  // contract is part of the PR's diff these also attach inline to the exact
  // expectation that drifted.
  emitAnnotations(report, {
    contractsDir: args.contracts,
    workspace: process.env.GITHUB_WORKSPACE,
  });

  const markdown = renderMarkdown(report, drifts, coverageHoles, legs, specs);
  // eslint-disable-next-line no-console
  console.log(markdown);
  if (args.summary) {
    try {
      fs.appendFileSync(args.summary, markdown + '\n');
    } catch (error) {
      log(`WARN: could not write summary to ${args.summary}: ${error.message}`);
    }
  }

  if (!report.result.passed) {
    // eslint-disable-next-line no-console
    console.error(
      `[ppl-lint-multiversion] FAIL: ${enforcedDrifts.length} drift(s), ` +
        `${enforcedHoles.length} coverage hole(s), ${blockingMissingContracts.length} unvalidated ` +
        `default-error rule(s), ${blockingShippingCensusProblems.length} shipping census problem(s), ` +
        `and ${enforcedInconclusive.length} inconclusive rule/version pair(s).`
    );
    process.exit(1);
  }
  log(
    `PASS: every ${args.allRules ? 'active shipping' : 'default-error'} rule agrees with all ` +
      `${legs.length} engine version(s)` +
      (drifts.length > 0 ? ` (${drifts.length} non-enforced finding(s) reported)` : '') +
      '.'
  );
}

function expectedCompatibility(spec) {
  const appliesTo = (spec.wiring && spec.wiring.appliesTo) || {};
  const scope = [];
  if (appliesTo.engine) {
    scope.push(
      appliesTo.engine === 'calcite'
        ? 'Calcite'
        : appliesTo.engine.charAt(0).toUpperCase() + appliesTo.engine.slice(1)
    );
  }
  if (appliesTo.minVersion && appliesTo.maxVersion) {
    scope.push(`>= ${appliesTo.minVersion}, <= ${appliesTo.maxVersion}`);
  } else if (appliesTo.minVersion) {
    scope.push(`>= ${appliesTo.minVersion}`);
  } else if (appliesTo.maxVersion) {
    scope.push(`<= ${appliesTo.maxVersion}`);
  } else {
    scope.push('all versions');
  }
  return scope.join(', ');
}

function actualCompatibility(row) {
  if (!row) return 'not evaluated';
  if (row.status === 'agree') return 'compatible';
  if (row.status === 'out-of-scope') return 'expected n/a';
  if (row.status === 'drift') return row.drifts > 1 ? `**drift** (${row.drifts})` : '**drift**';
  if (row.status === 'uncovered' || row.status === 'inconclusive') {
    return '**inconclusive**';
  }
  if (row.status === 'not-applicable') return 'expected n/a';
  return `**${row.status}**`;
}

/** Expected-vs-actual compatibility table followed by the detailed remediation report. */
function renderMarkdown(report, drifts, coverageHoles, legs, specs) {
  const lines = [];
  lines.push('## PPL lint multi-version validation');
  lines.push('');
  // Every reason the run can be red belongs in the headline. Reporting only
  // drifts and holes made a FAIL caused solely by inconclusive rules read as
  // "0 drifts, 0 holes — FAIL", which looks like a reporting bug rather than the
  // real cause.
  const reasons = [
    `${report.result.enforcedDriftCount} enforced drift(s)`,
    `${report.result.enforcedCoverageHoles} coverage hole(s)`,
  ];
  if (report.result.observedAnalyticsFindings) {
    reasons.push(`${report.result.observedAnalyticsFindings} analytics observation(s)`);
  }
  if (report.result.enforcedInconclusive) {
    reasons.push(`${report.result.enforcedInconclusive} inconclusive`);
  }
  if (report.result.missingContractCount) {
    reasons.push(`${report.result.missingContractCount} unvalidated rule(s)`);
  }
  if (report.result.blockingShippingCensusProblems) {
    reasons.push(
      `${report.result.blockingShippingCensusProblems} shipping census problem(s)`
    );
  }
  const compatibilityLegs = legs.filter(
    (leg) =>
      leg.executionBackend === 'standard' &&
      (leg.surface || 'runtime-bundle') === 'runtime-bundle'
  );
  lines.push(
    `Standard runtime-bundle engines: ${
      compatibilityLegs
        .map((leg) =>
          leg.label === leg.version
            ? `\`${leg.version}\``
            : `\`${leg.label}\` → \`${leg.version}\``
        )
        .join(', ') || 'none'
    } — **${report.result.passed ? 'PASS' : 'FAIL'}** (${reasons.join(', ')})`
  );
  lines.push('');

  const columns = compatibilityLegs.map((leg) => ({
    key: leg.key,
    heading:
      leg.label === leg.version
        ? `\`${leg.version}\` actual`
        : `\`${leg.label}\` actual<br>(\`${leg.version}\`)`,
  }));
  const rules = [...specs.entries()]
    .filter(([, entry]) => contractChannel(entry.spec) === 'lint')
    .sort(([left], [right]) => left.localeCompare(right));
  lines.push(
    `| Rule | Expected compatibility | ${columns.map((column) => column.heading).join(' | ')} |`
  );
  lines.push(`| ---- | ---- | ${columns.map(() => '----').join(' | ')} |`);
  for (const [ruleId, { spec }] of rules) {
    const cells = columns.map((column) => {
      const row = report.matrix.find((m) => m.ruleId === ruleId && m.legKey === column.key);
      return actualCompatibility(row);
    });
    lines.push(
      `| \`${ruleId}\` | ${expectedCompatibility(spec)} | ${cells.join(' | ')} |`
    );
  }
  lines.push('');

  if ((report.inconclusive || []).length > 0) {
    lines.push('### Inconclusive (leg problem, not a linter problem)');
    lines.push('');
    for (const entry of report.inconclusive) {
      lines.push(
        `- \`${entry.ruleId}\` on engine \`${entry.version}\` (${entry.executionBackend}): ` +
          `no case could be compared — ` +
          `${entry.reasons.join('; ')}. This is NOT a lint finding: the engine or the detector run ` +
          `did not answer, so nothing was validated. Check that leg's job logs (an unreachable ` +
          `cluster, an index that failed to seed, or a detector runner that died mid-corpus) and ` +
          `re-run. Do not edit the rule or the contract on the strength of this.`
      );
    }
    lines.push('');
  }

  if ((report.missingContracts || []).length > 0) {
    lines.push('### Unvalidated default-error rules');
    lines.push('');
    for (const entry of report.missingContracts) {
      lines.push(
        `- \`${entry.ruleId}\` ships enabled at error severity but ${entry.reason}, so no engine ` +
          `version validates it. FIX: add \`${entry.ruleId}.spec.json\` under ` +
          `integ-test/src/test/resources/ppl-lint/contracts/ with a trigger + control query and list ` +
          `it in manifest.json under \`defaultError\`. If the rule should not be default-error, lower ` +
          `its severity or disable it in packages/osd-monaco/src/ppl/lint/rules_catalog.json.`
      );
    }
    lines.push('');
  }

  if (report.shippingCensus && !report.shippingCensus.passed) {
    lines.push('### Shipping census');
    lines.push('');
    for (const problem of report.shippingCensus.problems || []) {
      lines.push(
        `- ${report.shippingCensus.blocking ? '**ENFORCED:**' : '**REPORT ONLY:**'} ${problem}. ` +
          `Align \`manifest.json\` with the approved OSD shipping catalog.`
      );
    }
    lines.push('');
  }

  if (coverageHoles.length > 0) {
    lines.push('### Coverage holes');
    lines.push('');
    for (const hole of coverageHoles) {
      const query = hole.queryName ? ` query \`${hole.queryName}\`` : '';
      const fix =
        hole.kind === 'backend-oracle'
          ? `add a reviewed \`${hole.executionBackend}\` backend oracle for this query`
          : `add an \`expectations[]\` entry whose \`version\` range covers \`${hole.version}\`, ` +
            `or narrow the rule's \`appliesTo\` so it does not apply there`;
      lines.push(
        `- \`${hole.ruleId}\`${query} has no ${hole.executionBackend} coverage for engine ` +
          `\`${hole.version}\`` +
          `${hole.enforced ? ' (ENFORCED — this rule ships to users on that engine unpinned)' : ''}. ` +
          `${hole.reason ? `${hole.reason}. ` : ''}` +
          `FIX (${hole.file}): ${fix}.`
      );
    }
    lines.push('');
  }

  lines.push('### Remediation');
  lines.push('');
  lines.push('```');
  lines.push(formatDriftReport(drifts));
  lines.push('```');
  return lines.join('\n');
}

main();
