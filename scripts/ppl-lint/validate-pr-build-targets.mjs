/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  assertContractSchema,
  classifyBackendReportRow,
  indexBackendReport,
  normalizeTarget,
} from './contract-schema.mjs';

function normalizeLabeledTarget(target, label) {
  try {
    return normalizeTarget(target);
  } catch (error) {
    throw new Error(`${label} target is invalid: ${error.message}`);
  }
}

function requireMatchingNonEmptyField(standard, analytics, field, label) {
  if (
    typeof standard[field] !== 'string' ||
    standard[field].trim().length === 0 ||
    typeof analytics[field] !== 'string' ||
    analytics[field].trim().length === 0
  ) {
    throw new Error(
      `standard and analytics targets must both report a non-empty ${label}: ` +
        `standard=${JSON.stringify(standard[field])}, analytics=${JSON.stringify(analytics[field])}`
    );
  }
  if (standard[field] !== analytics[field]) {
    throw new Error(
      `standard and analytics targets report different values for ${label}: ` +
        `standard=${JSON.stringify(standard[field])}, analytics=${JSON.stringify(analytics[field])}`
    );
  }
}

export function validatePrBuildTargetPair(standardRaw, analyticsRaw) {
  const standard = normalizeLabeledTarget(standardRaw, 'standard PR-build');
  const analytics = normalizeLabeledTarget(analyticsRaw, 'analytics PR-build');

  if (standard.executionBackend !== 'standard') {
    throw new Error(
      `standard PR-build target executionBackend must be "standard", got ` +
        `${JSON.stringify(standard.executionBackend)}`
    );
  }
  if (analytics.executionBackend !== 'analytics') {
    throw new Error(
      `analytics PR-build target executionBackend must be "analytics", got ` +
        `${JSON.stringify(analytics.executionBackend)}`
    );
  }

  requireMatchingNonEmptyField(standard, analytics, 'engineVersion', 'engine version');
  requireMatchingNonEmptyField(standard, analytics, 'sqlSha', 'SQL SHA');
  requireMatchingNonEmptyField(standard, analytics, 'grammarHash', 'grammar hash');

  return { standard, analytics };
}

function expectedBackendReportKeys(contractsDir, schedule) {
  if (schedule !== 'pr' && schedule !== 'nightly') {
    throw new Error(`schedule must be "pr" or "nightly", got ${JSON.stringify(schedule)}`);
  }
  const manifest = readJson(path.join(contractsDir, 'manifest.json'), 'contract manifest');
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !Array.isArray(manifest.contracts)
  ) {
    throw new TypeError('contract manifest.contracts must be a JSON array');
  }

  const files = new Set();
  const ruleIds = new Set();
  const expectedRows = new Map();
  for (const file of manifest.contracts) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new TypeError('contract manifest entries must be non-empty strings');
    }
    if (files.has(file)) {
      throw new Error(`contract manifest contains duplicate file ${JSON.stringify(file)}`);
    }
    files.add(file);

    const spec = readJson(path.join(contractsDir, file), `contract ${file}`);
    assertContractSchema(spec);
    if (ruleIds.has(spec.ruleId)) {
      throw new Error(`contract manifest contains duplicate ruleId ${JSON.stringify(spec.ruleId)}`);
    }
    ruleIds.add(spec.ruleId);
    if (schedule === 'pr' && (spec.schedule || 'pr') !== 'pr') {
      continue;
    }
    if (
      spec.queries === null ||
      typeof spec.queries !== 'object' ||
      Array.isArray(spec.queries) ||
      Object.keys(spec.queries).length === 0
    ) {
      throw new TypeError(`[${spec.ruleId}] contract.queries must be a non-empty JSON object`);
    }
    for (const queryName of Object.keys(spec.queries)) {
      const key = `${spec.ruleId}::${queryName}`;
      if (expectedRows.has(key)) {
        throw new Error(`contract corpus contains duplicate query key ${JSON.stringify(key)}`);
      }
      const query = spec.queries[queryName];
      if (query === null || typeof query !== 'object' || Array.isArray(query)) {
        throw new TypeError(`[${spec.ruleId}] query ${JSON.stringify(queryName)} must be an object`);
      }
      expectedRows.set(key, { role: query.role || 'trigger' });
    }
  }
  if (expectedRows.size === 0) {
    throw new Error(`contract corpus selected no queries for schedule ${JSON.stringify(schedule)}`);
  }
  return expectedRows;
}

function validateBackendReport(raw, target, label, expectedRows) {
  let rows;
  try {
    rows = indexBackendReport(raw, target);
  } catch (error) {
    throw new Error(`${label} backend report is invalid: ${error.message}`);
  }

  const missing = [...expectedRows.keys()].filter((key) => !rows.has(key)).sort();
  const extra = [...rows.keys()].filter((key) => !expectedRows.has(key)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(', ')}`);
    if (extra.length > 0) details.push(`unexpected: ${extra.join(', ')}`);
    throw new Error(`${label} backend report query coverage is incomplete (${details.join('; ')})`);
  }

  const unusable = [];
  for (const [key, row] of rows) {
    const expected = expectedRows.get(key);
    if (row.role !== expected.role) {
      throw new Error(
        `${label} backend report row ${key}.role must be ${JSON.stringify(expected.role)}, ` +
          `got ${JSON.stringify(row.role)}`
      );
    }
    if (typeof row.query !== 'string' || row.query.length === 0) {
      throw new Error(`${label} backend report row ${key}.query must be a non-empty string`);
    }
    const status = classifyBackendReportRow(row).status;
    if (
      status === 'error' ||
      (status === 'coverage-missing' && typeof row.rejected !== 'boolean')
    ) {
      unusable.push(key);
    }
  }
  if (unusable.length > 0) {
    throw new Error(
      `${label} backend report contains rows without an engine verdict: ${unusable.sort().join(', ')}`
    );
  }
  return rows;
}

export function validatePrBuildArtifacts({
  standardTarget,
  analyticsTarget,
  standardReport,
  analyticsReport,
  contractsDir,
  schedule = 'nightly',
}) {
  const pair = validatePrBuildTargetPair(standardTarget, analyticsTarget);
  const expectedRows = expectedBackendReportKeys(contractsDir, schedule);
  const standardRows = validateBackendReport(
    standardReport,
    pair.standard,
    'standard PR-build',
    expectedRows
  );
  const analyticsRows = validateBackendReport(
    analyticsReport,
    pair.analytics,
    'analytics PR-build',
    expectedRows
  );
  for (const key of expectedRows.keys()) {
    const standard = standardRows.get(key);
    const analytics = analyticsRows.get(key);
    if (standard.query !== analytics.query) {
      throw new Error(
        `standard and analytics backend reports executed different query text for ${key}: ` +
          `standard=${JSON.stringify(standard.query)}, analytics=${JSON.stringify(analytics.query)}`
      );
    }
  }
  return { ...pair, expectedRows: expectedRows.size, standardRows, analyticsRows };
}

function parseArgs(argv) {
  const options = new Map([
    ['--standard', 'standard'],
    ['--analytics', 'analytics'],
    ['--standard-report', 'standardReport'],
    ['--analytics-report', 'analyticsReport'],
    ['--contracts', 'contracts'],
    ['--schedule', 'schedule'],
  ]);
  const args = { schedule: 'nightly' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = options.get(arg);
    if (!key) {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
    const value = argv[++i];
    if (!value) {
      throw new Error(`${arg} requires a value`);
    }
    if (seen.has(key)) {
      throw new Error(`${arg} may be specified only once`);
    }
    seen.add(key);
    args[key] = value;
  }
  for (const key of [
    'standard',
    'analytics',
    'standardReport',
    'analyticsReport',
    'contracts',
  ]) {
    if (!args[key]) {
      throw new Error(`${[...options].find(([, value]) => value === key)[0]} is required`);
    }
  }
  return args;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${label} ${file}: ${error.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { standard, analytics, expectedRows } = validatePrBuildArtifacts({
    standardTarget: readJson(args.standard, 'standard PR-build target'),
    analyticsTarget: readJson(args.analytics, 'analytics PR-build target'),
    standardReport: readJson(args.standardReport, 'standard PR-build backend report'),
    analyticsReport: readJson(args.analyticsReport, 'analytics PR-build backend report'),
    contractsDir: args.contracts,
    schedule: args.schedule,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[ppl-lint-target-pair] verified engine=${standard.engineVersion} ` +
      `sqlSha=${standard.sqlSha} grammarHash=${standard.grammarHash} ` +
      `backends=${standard.executionBackend},${analytics.executionBackend} ` +
      `backendRows=${expectedRows}`
  );
}

if (process.argv[1] && process.argv[1].endsWith('validate-pr-build-targets.mjs')) {
  try {
    main();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ppl-lint-target-pair] FATAL: ${error.message}`);
    process.exitCode = 2;
  }
}
