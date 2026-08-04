/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertActiveShippingContracts,
  buildCensus,
  buildFrontendExecutionError,
  evaluateFrontendAssertions,
  selectManifestContractNames,
} from '../run-frontend-contract.mjs';

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
