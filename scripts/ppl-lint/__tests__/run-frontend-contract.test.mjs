/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertActiveShippingContracts,
  buildCensus,
  buildFrontendExecutionError,
  evaluateFrontendAssertions,
  selectManifestContractNames,
} from '../run-frontend-contract.mjs';

const SCRIPT = fileURLToPath(new URL('../run-frontend-contract.mjs', import.meta.url));

const RANGE = {
  startLine: 1,
  startColumn: 11,
  endLine: 1,
  endColumn: 14,
};

test('exact lint assertions materialize the effective deterministic edit', () => {
  const result = evaluateFrontendAssertions({
    channel: 'lint',
    query: 'source=t | bad',
    matches: [
      {
        ruleId: 'example-rule',
        severity: 'warning',
        message: 'Replace bad.',
        range: RANGE,
        fix: {
          title: 'Replace bad',
          text: 'good',
          expectedText: 'bad',
        },
      },
    ],
    frontendOracle: {
      severity: 'warning',
      messageEquals: 'Replace bad.',
      deterministicFix: {
        offered: true,
        title: 'Replace bad',
        text: 'good',
        range: RANGE,
        expectedText: 'bad',
        appliedQuery: 'source=t | good',
      },
    },
  });

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.assertions, {
    severity: true,
    message: true,
    deterministicFix: true,
  });
  assert.deepEqual(result.deterministicFixActual, {
    offered: true,
    title: 'Replace bad',
    text: 'good',
    range: RANGE,
    expectedText: 'bad',
    appliedQuery: 'source=t | good',
  });
});

test('exact message mismatches are field-specific', () => {
  const result = evaluateFrontendAssertions({
    channel: 'lint',
    query: 'source=t | bad',
    matches: [
      {
        ruleId: 'example-rule',
        severity: 'warning',
        message: 'Different message.',
        range: RANGE,
      },
    ],
    frontendOracle: {
      messageEquals: 'Expected message.',
      deterministicFix: { offered: false },
    },
  });

  assert.deepEqual(result.mismatches.map(({ field }) => field), ['message']);
});

test('deterministic expectedText must match the source slice', () => {
  const result = evaluateFrontendAssertions({
    channel: 'lint',
    query: 'source=t | bad',
    matches: [
      {
        message: 'Replace bad.',
        range: RANGE,
        fix: {
          title: 'Replace bad',
          text: 'good',
          expectedText: 'stale',
        },
      },
    ],
    frontendOracle: {
      deterministicFix: {
        offered: true,
        title: 'Replace bad',
        text: 'good',
        range: RANGE,
        expectedText: 'stale',
        appliedQuery: 'source=t | good',
      },
    },
  });

  assert.equal(result.deterministicFixMatched, false);
  assert.equal(result.deterministicFixActual.expectedTextMatchesSource, false);
});

test('a frontend execution error remains a complete report row', () => {
  assert.deepEqual(
    buildFrontendExecutionError({
      ruleId: 'example-rule',
      channel: 'lint',
      queryName: 'trigger',
      role: 'trigger',
      query: 'source=t | bad',
      expected: 0,
      surface: 'runtime-bundle',
      executionBackend: 'standard',
      error: new Error('detector crashed'),
    }),
    {
      ruleId: 'example-rule',
      channel: 'lint',
      queryName: 'trigger',
      role: 'trigger',
      query: 'source=t | bad',
      expected: 0,
      actual: 0,
      severities: [],
      severityMatched: true,
      messageMatched: true,
      assertions: { execution: false },
      mismatches: [
        {
          field: 'execution',
          expected: 'completed',
          actual: 'detector crashed',
        },
      ],
      outcome: 'error',
      error: 'detector crashed',
      surface: 'runtime-bundle',
      executionBackend: 'standard',
      backendOracleStatus: 'error',
    }
  );
});

test('the runner writes later rule rows after one frontend execution error', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-lint-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const osdRoot = path.join(root, 'osd');
  const contractDir = path.join(root, 'contracts');
  const reportPath = path.join(root, 'detector-report.json');
  const grammarPath = path.join(root, 'ppl-grammar-bundle.json');
  const targetPath = path.join(root, 'target.json');
  fs.mkdirSync(
    path.join(osdRoot, 'src/plugins/data/public/antlr/opensearch_ppl'),
    { recursive: true }
  );
  fs.mkdirSync(path.join(osdRoot, 'packages/osd-monaco'), { recursive: true });
  fs.mkdirSync(contractDir, { recursive: true });

  const wiring = (ruleId) => ({
    detector: ruleId,
    enabled: true,
    severity: 'info',
    runtimeOnly: false,
    needsContext: false,
    needsExplain: false,
    sourceScoped: false,
    appliesTo: {},
  });
  const contract = (ruleId, query) => ({
    schemaVersion: 4,
    ruleId,
    grammarSurface: 'runtime-bundle',
    schedule: 'pr',
    wiring: wiring(ruleId),
    index: 'test-index',
    queries: {
      trigger: { role: 'trigger', query },
    },
    expectations: [
      {
        version: '>=0.0.0',
        queries: {
          trigger: {
            frontend: {
              count: 0,
              deterministicFix: { offered: false },
            },
            backends: {
              standard: { kind: 'advisory', httpStatus: 200 },
              analytics: { kind: 'advisory', httpStatus: 200 },
            },
          },
        },
      },
    ],
  });
  const files = ['first-rule.spec.json', 'second-rule.spec.json'];
  fs.writeFileSync(
    path.join(contractDir, files[0]),
    JSON.stringify(contract('first-rule', 'source={{index}} | fail'))
  );
  fs.writeFileSync(
    path.join(contractDir, files[1]),
    JSON.stringify(contract('second-rule', 'source={{index}} | pass'))
  );
  fs.writeFileSync(
    path.join(contractDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 4,
      contracts: files,
      defaultError: [],
      requiredSyntaxFeatures: [],
    })
  );
  fs.writeFileSync(
    path.join(osdRoot, 'packages/osd-monaco/ppl-lint.js'),
    `const wiring = (id) => ({
      id, detector: id, enabled: true, severity: 'info', runtimeOnly: false,
      needsContext: false, needsExplain: false, sourceScoped: false, appliesTo: {}
    });
    exports.getBundledCatalog = () => [wiring('first-rule'), wiring('second-rule')];`
  );
  fs.writeFileSync(
    path.join(
      osdRoot,
      'src/plugins/data/public/antlr/opensearch_ppl/headless_ppl_lint.js'
    ),
    `exports.deserializeBundleOrThrow = (bundle) => bundle;
    exports.lintQueryWithBundle = (query) => {
      if (query.includes('| fail')) throw new Error('detector crashed');
      return { diagnostics: [] };
    };`
  );
  fs.writeFileSync(grammarPath, JSON.stringify({ grammarHash: 'sha256:test' }));
  fs.writeFileSync(
    targetPath,
    JSON.stringify({
      schemaVersion: 2,
      executionBackend: 'standard',
      engineVersion: '3.8.0-SNAPSHOT',
      grammarHash: 'sha256:test',
      storage: 'lucene',
      shardCount: 1,
    })
  );

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: osdRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PPL_LINT_CONTRACT_DIR: contractDir,
      PPL_LINT_SCHEDULE: 'pr',
      PPL_LINT_GRAMMAR_BUNDLE: grammarPath,
      PPL_LINT_TARGET_MANIFEST: targetPath,
      PPL_LINT_REPORT: reportPath,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /first-rule\/trigger.*frontend\.execution failed/s);
  assert.match(result.stdout, /PASS second-rule\/trigger/);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].outcome, 'error');
  assert.equal(report.results[0].error, 'detector crashed');
  assert.equal(report.results[1].ruleId, 'second-rule');
  assert.equal(report.results[1].actual, 0);
});

test('syntax suppression checks raw parser errors outside the suggestion code filter', () => {
  const parserErrors = [
    {
      code: 'PARSER_ERROR',
      message: 'Unexpected command.',
      rawMessage: "mismatched input 'zzzzzzzz'",
    },
  ];
  const result = evaluateFrontendAssertions({
    channel: 'syntax',
    query: 'source=t | zzzzzzzz',
    matches: [],
    allFrontendFindings: parserErrors,
    frontendOracle: {
      fixText: null,
      rawMessage: true,
      totalErrors: 1,
    },
  });

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.assertions, {
    syntaxFix: true,
    rawParserError: true,
    totalErrors: true,
  });

  const withUnexpectedFix = evaluateFrontendAssertions({
    channel: 'syntax',
    query: 'source=t | zzzzzzzz',
    matches: [],
    allFrontendFindings: [
      {
        ...parserErrors[0],
        fix: { title: 'Rewrite', text: 'where' },
      },
    ],
    frontendOracle: { fixText: null, rawMessage: true },
  });
  assert.equal(withUnexpectedFix.syntaxFixMatched, false);
  assert.equal(withUnexpectedFix.mismatches[0].field, 'syntaxFix');
});

test('dormant manifest contracts are opt-in and remain tagged report-only', () => {
  const manifest = {
    contracts: ['active.spec.json'],
    dormantContracts: ['dormant.spec.json'],
  };
  assert.deepEqual(selectManifestContractNames(manifest), [
    { name: 'active.spec.json', reportOnly: false },
  ]);
  assert.deepEqual(selectManifestContractNames(manifest, true), [
    { name: 'active.spec.json', reportOnly: false },
    { name: 'dormant.spec.json', reportOnly: true },
  ]);
  assert.throws(
    () =>
      selectManifestContractNames(
        {
          contracts: ['same.spec.json'],
          dormantContracts: ['same.spec.json'],
        },
        true
      ),
    /cannot be both active and dormant/
  );
});

test('discovery mode accepts legacy generated specs without shipping oracles', () => {
  const contract = {
    file: 'generated.discovery.spec.json',
    spec: {
      schemaVersion: 3,
      ruleId: 'generated-rule',
      queries: { trigger: { role: 'trigger', query: 'source=t' } },
      expectations: [{ version: '', queries: { trigger: { detectorCount: 0 } } }],
    },
  };

  assert.doesNotThrow(() =>
    assertActiveShippingContracts([contract], { discovery: true })
  );
  assert.throws(
    () => assertActiveShippingContracts([contract]),
    /active shipping contracts must use schemaVersion 4/
  );
});

test('shipping census rejects duplicate detector IDs', () => {
  const lintContract = {
    file: 'example.spec.json',
    spec: {
      schemaVersion: 4,
      ruleId: 'example',
    },
  };
  const census = buildCensus(
    [lintContract],
    {
      contracts: ['example.spec.json'],
      defaultError: [],
      requiredSyntaxFeatures: [],
    },
    [
      { id: 'duplicate-rule', enabled: false, severity: 'info' },
      { id: 'duplicate-rule', enabled: false, severity: 'info' },
    ]
  );

  assert.ok(census.problems.some((problem) => /duplicate rule IDs/.test(problem)));
});
