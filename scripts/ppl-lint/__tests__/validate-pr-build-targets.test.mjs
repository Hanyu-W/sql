/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validatePrBuildArtifacts,
  validatePrBuildTargetPair,
} from '../validate-pr-build-targets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'validate-pr-build-targets.mjs');
const tmpDirs = [];

function standardTarget(overrides = {}) {
  return {
    schemaVersion: 2,
    sqlSha: 'candidate-sql-sha',
    engineVersion: '3.8.0-SNAPSHOT',
    grammarHash: 'sha256:candidate-grammar',
    grammarBundle: 'ppl-grammar-bundle.json',
    executionBackend: 'standard',
    storage: 'lucene',
    shardCount: 1,
    ...overrides,
  };
}

function analyticsTarget(overrides = {}) {
  return {
    schemaVersion: 2,
    sqlSha: 'candidate-sql-sha',
    engineVersion: '3.8.0-SNAPSHOT',
    grammarHash: 'sha256:candidate-grammar',
    grammarBundle: 'ppl-grammar-bundle.json',
    executionBackend: 'analytics',
    storage: 'composite-parquet',
    shardCount: 1,
    analyticsStack: { source: 'https://example.test/analytics-build' },
    routeAttestation: {
      pluginsVerified: true,
      clusterSettingsVerified: true,
      fixtureIndicesVerified: true,
      explainVerified: true,
      profiledExecutionVerified: true,
    },
    ...overrides,
  };
}

function backendReport(executionBackend, queryNames = ['trigger', 'control']) {
  return queryNames.map((queryName) => ({
    ruleId: 'test-rule',
    queryName,
    role: queryName === 'control' ? 'control' : 'trigger',
    query:
      queryName === 'control'
        ? 'source=test-index | head 1'
        : 'source=test-index | head 0',
    executionBackend,
    rejected: queryName !== 'control',
    observed: {
      httpStatus: queryName === 'control' ? 200 : 400,
      rejected: queryName !== 'control',
    },
  }));
}

function writeContractCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-lint-target-contracts-'));
  tmpDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 3, contracts: ['test-rule.spec.json'] })
  );
  fs.writeFileSync(
    path.join(dir, 'test-rule.spec.json'),
    JSON.stringify({
      schemaVersion: 3,
      ruleId: 'test-rule',
      schedule: 'pr',
      queries: {
        trigger: { role: 'trigger', query: 'source={{index}} | head 0' },
        control: { role: 'control', query: 'source={{index}} | head 1' },
      },
    })
  );
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matching standard and analytics PR-build targets pass', () => {
  const pair = validatePrBuildTargetPair(standardTarget(), analyticsTarget());
  assert.equal(pair.standard.executionBackend, 'standard');
  assert.equal(pair.analytics.executionBackend, 'analytics');
});

test('the two PR-build target roles require their exact backend identities', () => {
  assert.throws(
    () => validatePrBuildTargetPair(analyticsTarget(), analyticsTarget()),
    /standard PR-build target executionBackend must be "standard"/
  );
  assert.throws(
    () => validatePrBuildTargetPair(standardTarget(), standardTarget()),
    /analytics PR-build target executionBackend must be "analytics"/
  );
});

test('both PR-build targets require the same non-empty SQL SHA', () => {
  assert.throws(
    () => validatePrBuildTargetPair(standardTarget({ sqlSha: '' }), analyticsTarget()),
    /both report a non-empty SQL SHA/
  );
  assert.throws(
    () =>
      validatePrBuildTargetPair(
        standardTarget(),
        analyticsTarget({ sqlSha: 'different-sql-sha' })
      ),
    /report different values for SQL SHA/
  );
});

test('both PR-build targets require the same engine version', () => {
  assert.throws(
    () =>
      validatePrBuildTargetPair(
        standardTarget(),
        analyticsTarget({ engineVersion: '3.9.0-SNAPSHOT' })
      ),
    /report different values for engine version/
  );
});

test('both PR-build targets require the same non-empty grammar hash', () => {
  assert.throws(
    () => validatePrBuildTargetPair(standardTarget(), analyticsTarget({ grammarHash: ' ' })),
    /both report a non-empty grammar hash/
  );
  assert.throws(
    () =>
      validatePrBuildTargetPair(
        standardTarget(),
        analyticsTarget({ grammarHash: 'sha256:different-grammar' })
      ),
    /report different values for grammar hash/
  );
});

test('target schema validation runs before pair identity comparison', () => {
  assert.throws(
    () =>
      validatePrBuildTargetPair(
        standardTarget({ schemaVersion: 1 }),
        analyticsTarget()
      ),
    /standard PR-build target is invalid: Unsupported target schemaVersion/
  );
});

test('paired backend reports require exact, usable query coverage', () => {
  const base = {
    standardTarget: standardTarget(),
    analyticsTarget: analyticsTarget(),
    standardReport: backendReport('standard'),
    analyticsReport: backendReport('analytics'),
    contractsDir: writeContractCorpus(),
  };
  const result = validatePrBuildArtifacts(base);
  assert.equal(result.expectedRows, 2);

  assert.throws(
    () =>
      validatePrBuildArtifacts({
        ...base,
        analyticsReport: backendReport('analytics', ['trigger']),
      }),
    /analytics PR-build backend report query coverage is incomplete.*test-rule::control/
  );
  assert.throws(
    () =>
      validatePrBuildArtifacts({
        ...base,
        standardReport: [
          ...backendReport('standard'),
          { ...backendReport('standard')[0] },
        ],
      }),
    /duplicate backend report key/
  );

  const errored = backendReport('analytics');
  errored[0] = { ...errored[0], outcome: 'error' };
  assert.throws(
    () => validatePrBuildArtifacts({ ...base, analyticsReport: errored }),
    /contains rows without an engine verdict: test-rule::trigger/
  );

  const unobservedCoverageGap = backendReport('analytics');
  unobservedCoverageGap[0] = {
    ...unobservedCoverageGap[0],
    outcome: 'coverage-missing',
  };
  delete unobservedCoverageGap[0].rejected;
  assert.throws(
    () =>
      validatePrBuildArtifacts({
        ...base,
        analyticsReport: unobservedCoverageGap,
      }),
    /contains rows without an engine verdict: test-rule::trigger/
  );

  const changedQuery = backendReport('analytics');
  changedQuery[0] = { ...changedQuery[0], query: 'source=different-index | head 0' };
  assert.throws(
    () => validatePrBuildArtifacts({ ...base, analyticsReport: changedQuery }),
    /executed different query text for test-rule::trigger/
  );
});

test('the CLI reads and validates both PR-build artifact sets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-lint-target-pair-'));
  tmpDirs.push(dir);
  const standardFile = path.join(dir, 'standard.json');
  const analyticsFile = path.join(dir, 'analytics.json');
  const standardReportFile = path.join(dir, 'standard-report.json');
  const analyticsReportFile = path.join(dir, 'analytics-report.json');
  fs.writeFileSync(standardFile, JSON.stringify(standardTarget()));
  fs.writeFileSync(analyticsFile, JSON.stringify(analyticsTarget()));
  fs.writeFileSync(standardReportFile, JSON.stringify(backendReport('standard')));
  fs.writeFileSync(analyticsReportFile, JSON.stringify(backendReport('analytics')));

  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--standard',
      standardFile,
      '--analytics',
      analyticsFile,
      '--standard-report',
      standardReportFile,
      '--analytics-report',
      analyticsReportFile,
      '--contracts',
      writeContractCorpus(),
      '--schedule',
      'nightly',
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified engine=3\.8\.0-SNAPSHOT/);
  assert.match(result.stdout, /backends=standard,analytics/);
  assert.match(result.stdout, /backendRows=2/);
});
