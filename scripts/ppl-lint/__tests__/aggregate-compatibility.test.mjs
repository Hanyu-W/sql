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

import { resolveBackendOracle } from '../contract-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'aggregate-compatibility.mjs');
const REPOSITORY = path.resolve(HERE, '..', '..', '..');
const CONTRACTS = path.join(
  REPOSITORY,
  'integ-test',
  'src',
  'test',
  'resources',
  'ppl-lint',
  'contracts'
);
const WORKFLOW = path.join(
  REPOSITORY,
  '.github',
  'workflows',
  'ppl-lint-multiversion-validation.yml'
);
const RULE_IDS = JSON.parse(
  fs.readFileSync(path.join(CONTRACTS, 'manifest.json'), 'utf8')
).contracts.map((file) => file.replace(/\.spec\.json$/, ''));
const CONFIGURATIONS = [
  {
    id: '2.19.6-compiled',
    label: '2.19.6 compiled',
    engineVersion: '2.19.6',
    surface: 'compiled-simplified',
    executionBackend: 'standard',
    engineMode: 'legacy',
    artifactName: 'ppl-lint-observation-2.19.6-compiled',
    exportRuntimeBundle: false,
  },
  {
    id: 'latest-release-runtime',
    label: 'Latest release (3.8.0) runtime',
    engineVersion: '3.8.0',
    surface: 'runtime-bundle',
    executionBackend: 'standard',
    engineMode: 'calcite',
    artifactName: 'ppl-lint-observation-latest-release-runtime',
    exportRuntimeBundle: true,
  },
  {
    id: 'pr-build-runtime',
    label: 'PR runtime',
    engineVersion: '3.8.0-SNAPSHOT',
    surface: 'runtime-bundle',
    executionBackend: 'standard',
    engineMode: 'calcite',
    artifactName: 'ppl-lint-observation-pr-build-runtime',
    exportRuntimeBundle: true,
  },
];
const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function version(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match.slice(1, 4).map(Number);
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function applicable(spec, configuration) {
  const appliesTo = spec.wiring.appliesTo || {};
  const surfaces =
    spec.grammarSurface === 'both'
      ? ['compiled-simplified', 'runtime-bundle']
      : [spec.grammarSurface || 'runtime-bundle'];
  if (!surfaces.includes(configuration.surface)) return false;
  const actual = version(configuration.engineVersion);
  if (appliesTo.minVersion && compare(actual, version(appliesTo.minVersion)) < 0) return false;
  if (appliesTo.maxVersion && compare(actual, version(appliesTo.maxVersion)) > 0) return false;
  return !appliesTo.engine || appliesTo.engine === configuration.engineMode;
}

function rangeMatches(range, engineVersion) {
  const actual = version(engineVersion);
  return String(range || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
      const comparison = compare(actual, version(match[2]));
      return (
        (!match[1] && comparison === 0) ||
        (match[1] === '=' && comparison === 0) ||
        (match[1] === '>=' && comparison >= 0) ||
        (match[1] === '<=' && comparison <= 0) ||
        (match[1] === '>' && comparison > 0) ||
        (match[1] === '<' && comparison < 0)
      );
    });
}

function loadSpecs() {
  return new Map(
    JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'manifest.json'), 'utf8')).contracts.map(
      (file) => {
        const spec = JSON.parse(fs.readFileSync(path.join(CONTRACTS, file), 'utf8'));
        return [spec.ruleId, spec];
      }
    )
  );
}

function selectedExpectation(spec, configuration) {
  return spec.expectations.find(
    (expectation) =>
      rangeMatches(expectation.version, configuration.engineVersion) &&
      (!expectation.engine || expectation.engine === configuration.engineMode)
  );
}

function target(configuration, grammarHash) {
  return {
    schemaVersion: 2,
    sqlSha: 'candidate-sql-sha',
    engineVersion: configuration.engineVersion,
    grammarHash,
    grammarBundle:
      configuration.surface === 'runtime-bundle' ? 'ppl-grammar-bundle.json' : '',
    executionBackend: 'standard',
    storage: 'lucene',
    shardCount: 1,
  };
}

function writeHealthyArtifacts(root) {
  const specs = loadSpecs();
  for (const configuration of CONFIGURATIONS) {
    const directory = path.join(root, configuration.artifactName);
    fs.mkdirSync(directory, { recursive: true });
    const grammarHash =
      configuration.surface === 'runtime-bundle'
        ? `sha256:${configuration.id}`
        : 'sha256:compiled-grammar';
    const backendTarget = target(
      configuration,
      configuration.surface === 'runtime-bundle' ? grammarHash : ''
    );
    const detectorTarget = target(configuration, grammarHash);
    const detectorResults = [];
    const backendResults = [];

    for (const spec of specs.values()) {
      if (!applicable(spec, configuration)) continue;
      const expectation = selectedExpectation(spec, configuration);
      assert.ok(expectation, `fixture expectation for ${spec.ruleId} on ${configuration.id}`);
      for (const [queryName, queryDefinition] of Object.entries(spec.queries)) {
        const resolved = resolveBackendOracle(
          spec,
          expectation.queries[queryName],
          'standard'
        );
        assert.equal(resolved.status, 'applicable');
        const rejected = resolved.oracle.kind === 'rejection';
        const error = resolved.oracle.body && resolved.oracle.body.error;
        detectorResults.push({
          ruleId: spec.ruleId,
          queryName,
          role: queryDefinition.role || 'trigger',
          expected: resolved.detector.count,
          actual: resolved.detector.count,
          severities:
            resolved.detector.count > 0 && resolved.detector.severity
              ? [resolved.detector.severity]
              : [],
          severityMatched: true,
          messageMatched: true,
          executionBackend: 'standard',
        });
        backendResults.push({
          ruleId: spec.ruleId,
          queryName,
          role: queryDefinition.role || 'trigger',
          rejected,
          executionBackend: 'standard',
          observed: {
            rejected,
            httpStatus: resolved.oracle.httpStatus,
            ...(error && error.type ? { type: error.type } : {}),
            ...(error && error.reason ? { reason: error.reason } : {}),
          },
        });
      }
    }

    fs.writeFileSync(path.join(directory, 'target.json'), JSON.stringify(backendTarget));
    fs.writeFileSync(
      path.join(directory, 'detector-target.json'),
      JSON.stringify(detectorTarget)
    );
    fs.writeFileSync(
      path.join(directory, 'backend-report.json'),
      JSON.stringify(backendResults)
    );
    fs.writeFileSync(
      path.join(directory, 'detector-report.json'),
      JSON.stringify({
        schemaVersion: 2,
        engineVersion: configuration.engineVersion,
        grammarHash,
        executionBackend: 'standard',
        surface: configuration.surface,
        results: detectorResults,
      })
    );
    if (configuration.surface === 'runtime-bundle') {
      fs.writeFileSync(
        path.join(directory, 'ppl-grammar-bundle.json'),
        JSON.stringify({ grammarHash })
      );
    }
    fs.writeFileSync(path.join(directory, 'backend-command.txt'), 'backend command\n');
    fs.writeFileSync(path.join(directory, 'detector-command.txt'), 'detector command\n');
  }
}

function createFixture() {
  const directory = temporaryDirectory('ppl-lint-compatibility-');
  const artifacts = path.join(directory, 'legs');
  fs.mkdirSync(artifacts);
  writeHealthyArtifacts(artifacts);
  const plan = {
    schemaVersion: 1,
    sqlSha: 'candidate-sql-sha',
    prTargetVersion: '3.8.0-SNAPSHOT',
    normalizedPrTarget: '3.8.0',
    latestEligibleGa: '3.8.0',
    osd: { repository: 'example/osd', ref: 'main' },
    configurations: CONFIGURATIONS,
  };
  const planFile = path.join(directory, 'compatibility-plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  return { directory, artifacts, planFile };
}

function run(fixture) {
  const reportFile = path.join(fixture.directory, 'drift-report.json');
  const summaryFile = path.join(fixture.directory, 'summary.md');
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--plan',
      fixture.planFile,
      '--contracts',
      CONTRACTS,
      '--artifacts',
      fixture.artifacts,
      '--osd-sha',
      'osd-sha',
      '--out',
      reportFile,
      '--summary',
      summaryFile,
    ],
    { encoding: 'utf8' }
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: fs.existsSync(reportFile)
      ? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
      : undefined,
    summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '',
  };
}

function editBackend(fixture, configurationId, ruleId, queryName, patch) {
  const configuration = CONFIGURATIONS.find((entry) => entry.id === configurationId);
  const file = path.join(
    fixture.artifacts,
    configuration.artifactName,
    'backend-report.json'
  );
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const row = report.find(
    (entry) => entry.ruleId === ruleId && entry.queryName === queryName
  );
  Object.assign(row, patch);
  Object.assign(row.observed, patch.observed || {});
  fs.writeFileSync(file, JSON.stringify(report));
}

test('emits exactly 12 rules, 3 configurations, and 36 complete cells', () => {
  const result = run(createFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.schemaVersion, 3);
  assert.equal(result.report.inventory.ruleCount, 12);
  assert.deepEqual(result.report.inventory.ruleIds, [...RULE_IDS].sort());
  assert.equal(result.report.configurations.length, 3);
  assert.equal(result.report.matrix.length, 36);
  assert.deepEqual(result.report.result, {
    status: 'pass',
    cellCount: 36,
    compatible: 28,
    notApplicable: 8,
    drift: 0,
    inconclusive: 0,
    exitCode: 0,
  });
  assert.equal(
    result.summary.split('\n').filter((line) => /^\| `[a-z0-9-]+` \|/.test(line))
      .length,
    12
  );
});

test('uses surface before version when a compiled pair has multiple exclusions', () => {
  const { report } = run(createFixture());
  assert.equal(
    report.matrix.find(
      (entry) =>
        entry.ruleId === 'invalid-capture-group-name' &&
        entry.configurationId === '2.19.6-compiled'
    ).expected.reason,
    'surface'
  );
  assert.equal(
    report.matrix.find(
      (entry) =>
        entry.ruleId === 'agg-on-text' &&
        entry.configurationId === '2.19.6-compiled'
    ).expected.reason,
    'version'
  );
});

test('classifies a one-trigger full engine relaxation and keeps the complete table', () => {
  const fixture = createFixture();
  editBackend(
    fixture,
    'latest-release-runtime',
    'wildcard-source-zero-match',
    'missing-wildcard-source',
    {
      rejected: false,
      observed: { rejected: false, httpStatus: 200, type: undefined, reason: undefined },
    }
  );
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.equal(result.report.matrix.length, 36);
  const cell = result.report.matrix.find(
    (entry) =>
      entry.ruleId === 'wildcard-source-zero-match' &&
      entry.configurationId === 'latest-release-runtime'
  );
  assert.equal(cell.classification, 'full-engine-relaxation');
  assert.deepEqual(cell.triggerSummary, {
    contracted: 1,
    acceptedByBackend: 1,
    rejectedByBackend: 0,
    missing: 0,
  });
  assert.equal(
    result.report.findings.find(
      (entry) =>
        entry.ruleId === 'wildcard-source-zero-match' &&
        entry.configurationId === 'latest-release-runtime'
    ).remediation.action,
    'scope-rule-version'
  );
});

test('classifies partial relaxation separately and never recommends version scoping', () => {
  const fixture = createFixture();
  editBackend(
    fixture,
    'latest-release-runtime',
    'union-min-datasets',
    'union-single-dataset',
    {
      rejected: false,
      observed: { rejected: false, httpStatus: 200, type: undefined, reason: undefined },
    }
  );
  const result = run(fixture);
  const finding = result.report.findings.find(
    (entry) =>
      entry.ruleId === 'union-min-datasets' &&
      entry.configurationId === 'latest-release-runtime'
  );
  assert.equal(finding.classification, 'partial-engine-relaxation');
  assert.equal(finding.remediation.action, 'narrow-detector');
  assert.ok(
    !result.report.findings.some(
      (entry) =>
        entry.ruleId === 'union-min-datasets' &&
        entry.remediation.action === 'scope-rule-version'
    )
  );
});

test('a detector regression writes JSON and every summary row before exiting nonzero', () => {
  const fixture = createFixture();
  const configuration = CONFIGURATIONS[1];
  const file = path.join(
    fixture.artifacts,
    configuration.artifactName,
    'detector-report.json'
  );
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.results.find(
    (entry) =>
      entry.ruleId === 'rex-scan-cost' && entry.queryName === 'parse-text-field'
  ).actual = 0;
  fs.writeFileSync(file, JSON.stringify(report));

  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.equal(result.report.matrix.length, 36);
  assert.equal(
    result.report.matrix.find(
      (entry) =>
        entry.ruleId === 'rex-scan-cost' &&
        entry.configurationId === 'latest-release-runtime'
    ).classification,
    'detector-regression'
  );
  assert.equal(
    result.summary
      .split('### Blocking findings')[0]
      .split('\n')
      .filter((line) => /^\| `[a-z0-9-]+` \|/.test(line)).length,
    12
  );
  assert.match(result.stderr, /after writing the complete report/);
});

test('a missing observation preserves the full column as inconclusive', () => {
  const fixture = createFixture();
  fs.rmSync(
    path.join(
      fixture.artifacts,
      CONFIGURATIONS[1].artifactName
    ),
    { recursive: true }
  );
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.equal(result.report.matrix.length, 36);
  const column = result.report.matrix.filter(
    (entry) => entry.configurationId === 'latest-release-runtime'
  );
  assert.equal(column.length, 12);
  assert.ok(column.every((entry) => entry.status === 'inconclusive'));
  assert.equal(result.report.result.inconclusive, 12);
});

test('workflow uploads the mandatory report before the only enforcement step', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const upload = workflow.indexOf('- name: Upload drift report');
  const evidence = workflow.indexOf('- name: Upload compatibility evidence');
  const enforce = workflow.indexOf('- name: Fail after publishing compatibility results');
  assert.ok(upload > 0 && evidence > upload && enforce > evidence);
  const reportStep = workflow.slice(upload, evidence);
  assert.match(reportStep, /path: drift-report\.json/);
  assert.match(reportStep, /if-no-files-found: error/);
  assert.equal(
    (workflow.match(/- name: Fail after publishing compatibility results/g) || [])
      .length,
    1
  );
});
