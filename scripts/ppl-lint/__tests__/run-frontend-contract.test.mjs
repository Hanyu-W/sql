/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertActiveShippingContracts,
  buildCensus,
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
      aiAction: { offered: false },
    },
    decideAction: ({ hasDeterministicFix }) => ({
      kind: hasDeterministicFix ? 'deterministic' : 'ai',
      commandId: 'ppl.lint.aiFix',
    }),
  });

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.assertions, {
    severity: true,
    message: true,
    deterministicFix: true,
    aiAction: true,
    actionDecision: true,
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

test('deterministic fixes require the production helper to choose the deterministic action', () => {
  const result = evaluateFrontendAssertions({
    channel: 'lint',
    query: 'source=t | bad',
    matches: [
      {
        severity: 'warning',
        message: 'Replace bad.',
        range: RANGE,
        fix: { title: 'Replace bad', text: 'good', expectedText: 'bad' },
      },
    ],
    frontendOracle: {
      deterministicFix: {
        offered: true,
        title: 'Replace bad',
        text: 'good',
        range: RANGE,
        expectedText: 'bad',
        appliedQuery: 'source=t | good',
      },
      aiAction: { offered: false },
    },
    decideAction: () => ({ kind: 'none' }),
  });

  assert.equal(result.deterministicFixMatched, true);
  assert.equal(result.aiActionMatched, true);
  assert.equal(result.actionDecisionMatched, false);
  assert.equal(
    result.mismatches.find(({ field }) => field === 'actionDecision')?.actual[0],
    'none'
  );
});

test('AI action identity and exact messages produce field-specific mismatches', () => {
  let decisionInput;
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
      aiAction: { offered: true, commandId: 'ppl.lint.aiFix' },
    },
    decideAction: (input) => {
      decisionInput = input;
      return { kind: 'ai', commandId: 'wrong.command' };
    },
  });

  assert.deepEqual(
    result.mismatches.map(({ field }) => field),
    ['message', 'aiAction']
  );
  assert.deepEqual(result.aiActionActual, {
    offered: true,
    commandId: 'wrong.command',
  });
  assert.equal(decisionInput.enableAIFeatures, true);
  assert.equal(decisionInput.hasAiFixHandler, true);
  assert.equal(decisionInput.aiAgentAvailableForSource, true);
  assert.equal(decisionInput.aiFixEligible, true);
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

test('AI assertions fail closed when the production decision export is unavailable', () => {
  const result = evaluateFrontendAssertions({
    channel: 'lint',
    query: 'source=t',
    matches: [],
    frontendOracle: { aiAction: { offered: false } },
  });

  assert.equal(result.aiActionMatched, false);
  assert.equal(result.mismatches[0].field, 'aiAction');
  assert.equal(result.aiActionActual.unavailable, true);
});

test('AI assertions report production decision errors instead of passing absence', () => {
  const result = evaluateFrontendAssertions({
    channel: 'lint',
    query: 'source=t | bad',
    matches: [{ message: 'Bad', range: RANGE }],
    frontendOracle: { aiAction: { offered: false } },
    decideAction: () => {
      throw new Error('decision failed');
    },
  });

  assert.equal(result.aiActionMatched, false);
  assert.match(result.aiActionActual.error, /decision failed/);
  assert.equal(result.mismatches[0].field, 'aiAction');
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

test('shipping census rejects duplicate detector IDs and syntax features in the catalog', () => {
  const syntaxContract = {
    file: 'command-suggestion.spec.json',
    spec: {
      schemaVersion: 4,
      ruleId: 'command-suggestion',
      channel: 'syntax',
    },
  };
  const census = buildCensus(
    [syntaxContract],
    {
      contracts: ['command-suggestion.spec.json'],
      defaultError: [],
      requiredSyntaxFeatures: ['command-suggestion.spec.json'],
    },
    [
      { id: 'command-suggestion', enabled: false, severity: 'error' },
      { id: 'duplicate-rule', enabled: false, severity: 'info' },
      { id: 'duplicate-rule', enabled: false, severity: 'info' },
    ]
  );

  assert.ok(census.problems.some((problem) => /duplicate rule IDs/.test(problem)));
  assert.ok(
    census.problems.some((problem) => /outside the detector catalog/.test(problem))
  );
});
