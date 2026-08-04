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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'assemble-run-manifest.mjs');
const tmpDirs = [];

function makeRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-lint-manifest-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'artifacts'));
  return dir;
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, 'artifacts', name), JSON.stringify(value));
}

function validArtifacts(dir) {
  writeJson(dir, 'target.json', {
    schemaVersion: 2,
    sqlSha: 'candidate-sql-sha',
    engineVersion: '3.8.0-SNAPSHOT',
    grammarHash: 'sha256:test',
    grammarBundle: 'ppl-grammar-bundle.json',
    executionBackend: 'standard',
    storage: 'lucene',
    shardCount: 1,
  });
  writeJson(dir, 'backend-report.json', [
    {
      ruleId: 'advisory-rule',
      queryName: 'trigger',
      role: 'trigger',
      executionBackend: 'standard',
      rejected: false,
      observed: { httpStatus: 200, rejected: false, response: { datarows: [] } },
      outcome: 'pass',
    },
  ]);
  writeJson(dir, 'detector-report.json', {
    schemaVersion: 2,
    executionBackend: 'standard',
    engineVersion: '3.8.0-SNAPSHOT',
    grammarHash: 'sha256:test',
    surface: 'runtime-bundle',
    defaultErrorRules: ['advisory-rule'],
    results: [
      {
        ruleId: 'advisory-rule',
        queryName: 'trigger',
        role: 'trigger',
        expected: 1,
        actual: 1,
        severities: ['warning'],
        severityMatched: true,
        messageMatched: true,
        executionBackend: 'standard',
      },
    ],
  });
}

function run(dir, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKEND_RESULT: 'success',
      DETECTOR_RESULT: 'success',
      SQL_SHA: 'candidate-sql-sha',
      ...extraEnv,
    },
  });
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('valid standard artifacts produce a passing schema-v2 manifest', () => {
  const dir = makeRun();
  validArtifacts(dir);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.executionBackend, 'standard');
  assert.equal(manifest.result.passed, true);
  assert.deepEqual(manifest.result.artifactErrors, []);
});

test('a missing report fails closed while still writing the manifest', () => {
  const dir = makeRun();
  validArtifacts(dir);
  fs.rmSync(path.join(dir, 'artifacts', 'backend-report.json'));
  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required artifact is missing/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run-manifest.json'), 'utf8'));
  assert.equal(manifest.result.passed, false);
});

test('detector rows must have unique identities matching the target', () => {
  const dir = makeRun();
  validArtifacts(dir);
  const file = path.join(dir, 'artifacts', 'detector-report.json');
  const detector = JSON.parse(fs.readFileSync(file, 'utf8'));
  detector.results.push({ ...detector.results[0] });
  fs.writeFileSync(file, JSON.stringify(detector));

  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate row advisory-rule::trigger/);
});

test('a backend row without a real verdict cannot render as acceptance', () => {
  const dir = makeRun();
  validArtifacts(dir);
  writeJson(dir, 'backend-report.json', [
    {
      ruleId: 'advisory-rule',
      queryName: 'trigger',
      role: 'trigger',
      executionBackend: 'standard',
      outcome: 'error',
      error: 'connect timeout',
    },
  ]);

  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not pass its oracle/);
});

test('an accepted advisory trigger is summarized from its backend outcome, not its role', () => {
  const dir = makeRun();
  validArtifacts(dir);
  const summary = path.join(dir, 'summary.md');
  const result = run(dir, { GITHUB_STEP_SUMMARY: summary });
  assert.equal(result.status, 0, result.stderr);
  const markdown = fs.readFileSync(summary, 'utf8');
  assert.match(markdown, /advisory-rule.*accepted.*Pass/);
});

test('detector severity and message mismatches fail the manifest and summary', () => {
  for (const field of ['severityMatched', 'messageMatched']) {
    const dir = makeRun();
    validArtifacts(dir);
    const file = path.join(dir, 'artifacts', 'detector-report.json');
    const detector = JSON.parse(fs.readFileSync(file, 'utf8'));
    detector.results[0][field] = false;
    fs.writeFileSync(file, JSON.stringify(detector));
    const summary = path.join(dir, 'summary.md');

    const result = run(dir, { GITHUB_STEP_SUMMARY: summary });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`did not match its ${field === 'severityMatched' ? 'severity' : 'message'}`));
    assert.match(fs.readFileSync(summary, 'utf8'), /advisory-rule.*accepted.*Fail/);
  }
});

test('syntax-specific frontend mismatches fail artifact validation', () => {
  for (const field of ['fixMatched', 'rawMessageMatched', 'totalErrorsMatched']) {
    const dir = makeRun();
    validArtifacts(dir);
    const file = path.join(dir, 'artifacts', 'detector-report.json');
    const detector = JSON.parse(fs.readFileSync(file, 'utf8'));
    detector.results[0][field] = false;
    fs.writeFileSync(file, JSON.stringify(detector));

    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not match its (fix|raw-message|total-error) assertion/);
  }
});
