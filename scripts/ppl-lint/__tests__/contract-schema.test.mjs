/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertContractSchema,
  assertExactQueryCoverage,
  assertShippingFrontendOracles,
  classifyBackendReportRow,
  contractChannel,
  indexBackendReport,
  normalizeFrontendOracle,
  normalizeLintWiring,
  normalizeTarget,
  resolveBackendOracle,
} from '../contract-schema.mjs';

const QUERY = {
  detectorCount: 1,
  severity: 'error',
  matchMessage: 'bad query',
  backend: { kind: 'rejection', httpStatus: 400, body: { status: 400 } },
};

function spec(schemaVersion, queryExpectation = QUERY) {
  return {
    schemaVersion,
    ruleId: 'example-rule',
    queries: {
      trigger: { role: 'trigger', query: 'source={{index}} | bad' },
      control: { role: 'control', query: 'source={{index}} | head 1' },
    },
    expectations: [
      {
        version: '>=3.7.0',
        queries: {
          trigger: queryExpectation,
          control: {
            detectorCount: 0,
            ...(schemaVersion === 3
              ? { backend: { kind: 'result-shape', httpStatus: 200 } }
              : {
                  backends: {
                    standard: { kind: 'result-shape', httpStatus: 200 },
                    analytics: { kind: 'result-shape', httpStatus: 200 },
                  },
                }),
          },
        },
      },
    ],
  };
}

test('target schema v2 requires and preserves explicit standard or analytics identity', () => {
  for (const executionBackend of ['standard', 'analytics']) {
    const target = normalizeTarget({
      schemaVersion: 2,
      engineVersion: '3.8.0-SNAPSHOT',
      grammarHash: 'sha256:abc',
      grammarBundle: 'ppl-grammar-bundle.json',
      executionBackend,
      storage: executionBackend === 'analytics' ? 'composite-parquet' : 'lucene',
      shardCount: 1,
      ...(executionBackend === 'analytics'
        ? {
            analyticsStack: { source: 'https://example.test/analytics-build' },
            routeAttestation: {
              pluginsVerified: true,
              clusterSettingsVerified: true,
              fixtureIndicesVerified: true,
              explainVerified: true,
              profiledExecutionVerified: true,
            },
          }
        : {}),
    });
    assert.equal(target.executionBackend, executionBackend);
    assert.equal(target.legacy, false);
  }
});

test('unversioned targets cannot infer a standard execution identity', () => {
  assert.throws(
    () =>
      normalizeTarget({
        engineVersion: '3.7.0',
        grammarHash: 'sha256:legacy',
      }),
    /target\.schemaVersion is required/
  );
});

test('unknown target schema and execution backend are rejected', () => {
  assert.throws(
    () =>
      normalizeTarget({
        schemaVersion: 3,
        engineVersion: '3.8.0',
        grammarHash: 'sha256:x',
        executionBackend: 'standard',
        storage: 'lucene',
      }),
    /Unsupported target schemaVersion 3/
  );
  assert.throws(
    () =>
      normalizeTarget({
        schemaVersion: 2,
        engineVersion: '3.8.0',
        grammarHash: 'sha256:x',
        executionBackend: 'experimental',
      }),
    /must be "standard" or "analytics"/
  );
});

test('schema v3 resolves a standard oracle and never falls back for analytics', () => {
  const contract = spec(3);
  const standard = resolveBackendOracle(contract, QUERY, 'standard');
  const analytics = resolveBackendOracle(contract, QUERY, 'analytics');

  assert.equal(standard.status, 'applicable');
  assert.equal(standard.oracle, QUERY.backend);
  assert.deepEqual(standard.detector, analytics.detector);
  assert.equal(analytics.status, 'coverage-missing');
  assert.equal(analytics.oracle, undefined);
  assert.match(analytics.reason, /standard-only/);
});

test('analytics targets fail closed on storage and route attestation', () => {
  const base = {
    schemaVersion: 2,
    engineVersion: '3.8.0',
    grammarHash: 'sha256:x',
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
  };
  assert.equal(normalizeTarget(base).executionBackend, 'analytics');
  assert.throws(
    () => normalizeTarget({ ...base, storage: 'lucene' }),
    /storage must be "composite-parquet"/
  );
  const withoutStack = { ...base };
  delete withoutStack.analyticsStack;
  assert.throws(
    () => normalizeTarget(withoutStack),
    /analyticsStack must be a JSON object/
  );
  assert.throws(
    () =>
      normalizeTarget({
        ...base,
        routeAttestation: { ...base.routeAttestation, explainVerified: false },
      }),
    /explainVerified must be true/
  );
});

test('schema-v2 standard targets require explicit storage and shard identity', () => {
  const base = {
    schemaVersion: 2,
    engineVersion: '3.8.0',
    grammarHash: 'sha256:x',
    executionBackend: 'standard',
    storage: 'lucene',
    shardCount: 1,
  };
  assert.equal(normalizeTarget(base).executionBackend, 'standard');
  assert.throws(
    () => normalizeTarget({ ...base, storage: undefined }),
    /storage must be "lucene"/
  );
  assert.throws(
    () => normalizeTarget({ ...base, shardCount: undefined }),
    /shardCount must be a positive integer/
  );
});

test('schema v4 selects only the requested backend oracle', () => {
  const queryExpectation = {
    detectorCount: 1,
    severity: 'warning',
    backends: {
      standard: { kind: 'rejection', httpStatus: 400, body: { status: 400 } },
      analytics: { kind: 'advisory', httpStatus: 200 },
    },
  };
  const contract = spec(4, queryExpectation);

  const standard = resolveBackendOracle(contract, queryExpectation, 'standard');
  const analytics = resolveBackendOracle(contract, queryExpectation, 'analytics');
  assert.equal(standard.oracle, queryExpectation.backends.standard);
  assert.equal(analytics.oracle, queryExpectation.backends.analytics);
  assert.deepEqual(standard.detector, analytics.detector);
});

test('schema v4 reports missing route coverage without using another backend oracle', () => {
  const queryExpectation = {
    detectorCount: 1,
    severity: 'error',
    backends: {
      standard: { kind: 'rejection', httpStatus: 400 },
    },
  };
  const analytics = resolveBackendOracle(spec(4, queryExpectation), queryExpectation, 'analytics');

  assert.equal(analytics.status, 'coverage-missing');
  assert.equal(analytics.oracle, undefined);
  assert.match(analytics.reason, /no analytics backend oracle/);
});

test('not-applicable is explicit while an absent oracle is coverage-missing', () => {
  const notApplicable = {
    detectorCount: 1,
    backends: {
      analytics: {
        kind: 'not-applicable',
        reason: 'fixture is unsupported',
        owner: '@analytics-team',
        issue: 'https://example.test/issues/1',
      },
    },
  };
  const missing = {
    detectorCount: 1,
    backends: {},
  };

  assert.equal(
    resolveBackendOracle(spec(4, notApplicable), notApplicable, 'analytics').status,
    'not-applicable'
  );
  assert.equal(
    resolveBackendOracle(spec(4, missing), missing, 'analytics').status,
    'coverage-missing'
  );
  assert.throws(
    () =>
      resolveBackendOracle(
        spec(4, {
          detectorCount: 1,
          backends: { analytics: { kind: 'not-applicable' } },
        }),
        { detectorCount: 1, backends: { analytics: { kind: 'not-applicable' } } },
        'analytics'
      ),
    /backend oracle\.reason/
  );
  assert.throws(
    () => {
      const oracle = {
        detectorCount: 1,
        backends: {
          analytics: {
            kind: 'not-applicable',
            reason: 'fixture is unsupported',
            issue: 'https://example.test/issues/1',
          },
        },
      };
      return resolveBackendOracle(spec(4, oracle), oracle, 'analytics');
    },
    /backend oracle\.owner/
  );
});

test('unknown contract schema and backend oracle kind are rejected', () => {
  assert.throws(() => assertContractSchema(spec(5)), /expected 3 or 4/);
  const queryExpectation = {
    detectorCount: 1,
    backends: { analytics: { kind: 'maybe' } },
  };
  assert.throws(
    () => resolveBackendOracle(spec(4, queryExpectation), queryExpectation, 'analytics'),
    /unknown analytics backend oracle.kind/
  );
  const unknownBackend = {
    detectorCount: 1,
    backends: { experimental: { kind: 'advisory' } },
  };
  assert.throws(
    () => resolveBackendOracle(spec(4, unknownBackend), unknownBackend, 'analytics'),
    /backends key must be "standard" or "analytics"/
  );
});

test('backend oracle payloads fail closed when required shapes are malformed', () => {
  const cases = [
    {
      oracle: { kind: 'rejection', body: { status: 400 } },
      expected: /httpStatus/,
    },
    {
      oracle: { kind: 'rejection', httpStatus: 400 },
      expected: /\.body must be a JSON object/,
    },
    {
      oracle: {
        kind: 'rejection',
        httpStatus: 400,
        body: { status: '400' },
      },
      expected: /\.body\.status must be an integer/,
    },
    {
      oracle: {
        kind: 'rejection',
        httpStatus: 400,
        body: { status: 500 },
      },
      expected: /\.httpStatus must equal .*\.body\.status/,
    },
    {
      oracle: {
        kind: 'result-shape',
        httpStatus: 201,
      },
      expected: /\.httpStatus must be 200/,
    },
    {
      oracle: {
        kind: 'advisory',
        httpStatus: 204,
      },
      expected: /\.httpStatus must be 200/,
    },
    {
      oracle: {
        kind: 'result-shape',
        httpStatus: 200,
        expect: { datarowsNonEmpty: 'yes' },
      },
      expected: /datarowsNonEmpty must be a boolean/,
    },
    {
      oracle: {
        kind: 'result-shape',
        httpStatus: 200,
        expect: { datarowsCount: -1 },
      },
      expected: /datarowsCount must be a non-negative integer/,
    },
  ];

  for (const { oracle, expected } of cases) {
    const queryExpectation = {
      detectorCount: 1,
      backends: { analytics: oracle },
    };
    assert.throws(
      () => resolveBackendOracle(spec(4, queryExpectation), queryExpectation, 'analytics'),
      expected
    );
  }
});

test('selected expectation query keys must exactly equal top-level query keys', () => {
  const contract = spec(3);
  assert.deepEqual(
    assertExactQueryCoverage(contract, contract.expectations[0]),
    ['control', 'trigger']
  );

  const missing = structuredClone(contract.expectations[0]);
  delete missing.queries.control;
  assert.throws(
    () => assertExactQueryCoverage(contract, missing),
    /missing from expectation: control/
  );

  const extra = structuredClone(contract.expectations[0]);
  extra.queries.unknown = QUERY;
  assert.throws(
    () => assertExactQueryCoverage(contract, extra),
    /not present in contract\.queries: unknown/
  );

  assert.throws(
    () =>
      assertExactQueryCoverage(
        { ...contract, queries: {} },
        { ...contract.expectations[0], queries: {} }
      ),
    /contract\.queries must not be empty/
  );
});

test('non-verdict backend states are never coerced to acceptance', () => {
  assert.deepEqual(classifyBackendReportRow({ rejected: false }), {
    status: 'observed',
    rejected: false,
  });
  for (const outcome of ['not-applicable', 'coverage-missing', 'error']) {
    assert.equal(
      classifyBackendReportRow({ outcome, rejected: false }).status,
      outcome
    );
    assert.equal(
      classifyBackendReportRow({ outcome, rejected: false }).rejected,
      undefined
    );
  }
  assert.equal(classifyBackendReportRow({ outcome: 'pass' }).status, 'error');
});

test('backend report indexing rejects duplicate keys', () => {
  const target = normalizeTarget({
    schemaVersion: 2,
    engineVersion: '3.8.0',
    grammarHash: 'sha256:x',
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
  });
  const row = {
    ruleId: 'example-rule',
    queryName: 'trigger',
    executionBackend: 'analytics',
    rejected: true,
  };
  assert.throws(() => indexBackendReport([row, { ...row }], target), /duplicate backend report key/);
  assert.throws(() => indexBackendReport({}, target), /must be a JSON array/);
});

test('every schema-v2 backend report row must carry identity matching the target', () => {
  const target = normalizeTarget({
    schemaVersion: 2,
    engineVersion: '3.8.0',
    grammarHash: 'sha256:x',
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
  });
  const base = { ruleId: 'example-rule', queryName: 'trigger', rejected: true };

  assert.throws(() => indexBackendReport([base], target), /missing executionBackend/);
  assert.throws(
    () => indexBackendReport([{ ...base, executionBackend: 'standard' }], target),
    /does not match target "analytics"/
  );
  assert.equal(
    indexBackendReport([{ ...base, executionBackend: 'analytics' }], target).get(
      'example-rule::trigger'
    ).rejected,
    true
  );
});

test('schema-v2 standard backend rows cannot omit identity', () => {
  const target = normalizeTarget({
    schemaVersion: 2,
    engineVersion: '3.7.0',
    grammarHash: 'sha256:legacy',
    executionBackend: 'standard',
    storage: 'lucene',
    shardCount: 1,
  });
  const row = { ruleId: 'example-rule', queryName: 'trigger', rejected: true };

  assert.throws(() => indexBackendReport([row], target), /missing executionBackend/);
  assert.throws(
    () => indexBackendReport([{ ...row, executionBackend: 'analytics' }], target),
    /does not match target "standard"/
  );
});

test('missing channel remains a backwards-compatible lint contract', () => {
  const contract = spec(4, {
    detectorCount: 1,
    severity: 'warning',
    backends: {
      standard: { kind: 'advisory', httpStatus: 200 },
    },
  });
  assert.equal(contractChannel(contract), 'lint');
  assert.deepEqual(
    normalizeFrontendOracle(contract, contract.expectations[0].queries.trigger),
    {
      channel: 'lint',
      count: 1,
      severity: 'warning',
      messageEquals: undefined,
      deterministicFix: undefined,
      aiAction: undefined,
    }
  );
});

test('schema-v4 lint frontend normalizes exact message, fix, and AI action oracles', () => {
  const contract = spec(4);
  const frontend = normalizeFrontendOracle(contract, {
    frontend: {
      count: 1,
      severity: 'warning',
      messageEquals: 'Use a non-zero divisor.',
      deterministicFix: {
        offered: true,
        title: 'Replace zero',
        text: '1',
        range: {
          startLine: 1,
          startColumn: 20,
          endLine: 1,
          endColumn: 21,
        },
        expectedText: '0',
        appliedQuery: 'source=t | eval x = 1',
      },
      aiAction: { offered: false },
    },
  });

  assert.deepEqual(frontend, {
    channel: 'lint',
    count: 1,
    severity: 'warning',
    messageEquals: 'Use a non-zero divisor.',
    deterministicFix: {
      offered: true,
      title: 'Replace zero',
      text: '1',
      range: {
        startLine: 1,
        startColumn: 20,
        endLine: 1,
        endColumn: 21,
      },
      expectedText: '0',
      appliedQuery: 'source=t | eval x = 1',
    },
    aiAction: { offered: false },
  });
});

test('matchMessage remains available only to schema-v3 lint contracts', () => {
  assert.equal(
    normalizeFrontendOracle(spec(3), {
      frontend: { count: 1, matchMessage: 'legacy substring' },
    }).matchMessage,
    'legacy substring'
  );
  assert.throws(
    () =>
      normalizeFrontendOracle(spec(4), {
        frontend: { count: 1, matchMessage: 'not exact' },
      }),
    /matchMessage is not valid/
  );
});

test('schema-v4 action payloads fail closed on partial or extra fields', () => {
  const contract = spec(4);
  for (const [frontend, expected] of [
    [
      { count: 1, deterministicFix: { offered: false, title: 'unexpected' } },
      /must contain only offered/,
    ],
    [
      {
        count: 1,
        deterministicFix: {
          offered: true,
          title: 'Fix',
          text: 'x',
          range: { startLine: 0, startColumn: 0, endLine: 1, endColumn: 1 },
          appliedQuery: 'x',
        },
      },
      /startLine must be a positive integer/,
    ],
    [
      {
        count: 1,
        deterministicFix: {
          offered: true,
          title: 'Fix',
          text: 'x',
          range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
          appliedQuery: 'x',
        },
      },
      /expectedText must be a string/,
    ],
    [
      {
        count: 1,
        deterministicFix: {
          offered: true,
          title: 'Fix',
          text: 'x',
          range: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 1 },
          expectedText: 'y',
          appliedQuery: 'x',
        },
      },
      /must end at or after its start/,
    ],
    [
      { count: 1, aiAction: { offered: true } },
      /commandId must be a non-empty string/,
    ],
    [
      { count: 1, aiAction: { offered: false, commandId: 'ppl.lint.aiFix' } },
      /must contain only offered/,
    ],
  ]) {
    assert.throws(() => normalizeFrontendOracle(contract, { frontend }), expected);
  }
});

test('active lint contracts require exact messages and explicit exclusive action modes', () => {
  const contract = spec(4);
  const expectation = structuredClone(contract.expectations[0]);
  expectation.queries.trigger = {
    frontend: {
      count: 1,
      severity: 'error',
      messageEquals: 'Exact diagnostic.',
      deterministicFix: { offered: false },
      aiAction: { offered: true, commandId: 'ppl.lint.aiFix' },
    },
    backends: {
      standard: { kind: 'rejection', httpStatus: 400, body: { status: 400 } },
      analytics: { kind: 'rejection', httpStatus: 400, body: { status: 400 } },
    },
  };
  expectation.queries.control.frontend = {
    count: 0,
    deterministicFix: { offered: false },
    aiAction: { offered: false },
  };
  delete expectation.queries.control.detectorCount;

  assert.doesNotThrow(() => assertShippingFrontendOracles(contract, expectation));

  const missingMessage = structuredClone(expectation);
  delete missingMessage.queries.trigger.frontend.messageEquals;
  assert.throws(
    () => assertShippingFrontendOracles(contract, missingMessage),
    /messageEquals is required/
  );

  const missingSeverity = structuredClone(expectation);
  delete missingSeverity.queries.trigger.frontend.severity;
  assert.throws(
    () => assertShippingFrontendOracles(contract, missingSeverity),
    /severity is required/
  );

  const simultaneousActions = structuredClone(expectation);
  simultaneousActions.queries.trigger.frontend.deterministicFix = {
    offered: true,
    title: 'Fix',
    text: 'fixed',
    range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 },
    expectedText: 'bad',
    appliedQuery: 'fixed',
  };
  assert.throws(
    () => assertShippingFrontendOracles(contract, simultaneousActions),
    /cannot offer deterministic and AI actions together/
  );
});

test('syntax frontend assertions normalize stable code, fix, raw message, and error census', () => {
  const contract = {
    schemaVersion: 4,
    ruleId: 'command-suggestion',
    channel: 'syntax',
    wiring: { code: 'UNKNOWN_COMMAND' },
    queries: {
      trigger: { role: 'trigger', query: 'source=t | wherre a > 1' },
    },
  };
  const frontend = normalizeFrontendOracle(contract, {
    frontend: {
      count: 1,
      code: 'UNKNOWN_COMMAND',
      fixText: 'where',
      matchMessage: 'where',
      rawMessage: true,
      totalErrors: 1,
    },
  });
  assert.deepEqual(frontend, {
    channel: 'syntax',
    count: 1,
    code: 'UNKNOWN_COMMAND',
    fixText: 'where',
    matchMessage: 'where',
    rawMessage: true,
    totalErrors: 1,
  });
  assert.equal(assertContractSchema(contract), 4);
});

test('active syntax contracts require explicit fix, raw-message, and total-error assertions', () => {
  const contract = {
    schemaVersion: 4,
    ruleId: 'command-suggestion',
    channel: 'syntax',
    wiring: { code: 'UNKNOWN_COMMAND' },
    queries: {
      trigger: { role: 'trigger', query: 'source=t | wherre a > 1' },
    },
  };
  const expectation = {
    queries: {
      trigger: {
        frontend: {
          count: 1,
          code: 'UNKNOWN_COMMAND',
          fixText: 'where',
          matchMessage: 'Unknown command "wherre". Did you mean "where"?',
          rawMessage: true,
          totalErrors: 1,
        },
      },
    },
  };
  assert.doesNotThrow(() => assertShippingFrontendOracles(contract, expectation));

  delete expectation.queries.trigger.frontend.fixText;
  assert.throws(
    () => assertShippingFrontendOracles(contract, expectation),
    /fixText must explicitly assert/
  );
});

test('syntax supports explicit fix absence and requires frontend code to match wiring', () => {
  const contract = {
    schemaVersion: 4,
    ruleId: 'command-suggestion',
    channel: 'syntax',
    wiring: { code: 'UNKNOWN_COMMAND' },
    queries: {
      suppressed: { role: 'suppression-control', query: 'source=t | zzzzzzzz' },
    },
  };
  assert.deepEqual(
    normalizeFrontendOracle(contract, {
      frontend: {
        count: 0,
        code: 'UNKNOWN_COMMAND',
        fixText: null,
        rawMessage: true,
        totalErrors: 1,
      },
    }),
    {
      channel: 'syntax',
      count: 0,
      code: 'UNKNOWN_COMMAND',
      fixText: null,
      rawMessage: true,
      totalErrors: 1,
    }
  );
  assert.throws(
    () =>
      normalizeFrontendOracle(contract, {
        frontend: { count: 0, code: 'OTHER_ERROR' },
      }),
    /does not match contract\.wiring\.code/
  );
});

test('lint and syntax frontend fields cannot cross channels', () => {
  assert.throws(
    () =>
      normalizeFrontendOracle(spec(4), {
        frontend: { count: 1, code: 'UNKNOWN_COMMAND' },
      }),
    /code is not valid/
  );
  const syntax = {
    schemaVersion: 4,
    ruleId: 'command-suggestion',
    channel: 'syntax',
    wiring: { code: 'UNKNOWN_COMMAND' },
    queries: {
      trigger: { role: 'trigger', query: 'source=t | wherre a > 1' },
    },
  };
  assert.throws(
    () => normalizeFrontendOracle(syntax, { detectorCount: 1 }),
    /must use frontend/
  );
  assert.throws(
    () =>
      assertContractSchema({
        ...syntax,
        wiring: { code: 'UNKNOWN_COMMAND', detector: 'command-suggestion' },
      }),
    /must contain only/
  );
});

test('suppression-control is syntax-only', () => {
  assert.throws(
    () =>
      assertContractSchema({
        ...spec(4),
        queries: {
          suppressed: {
            role: 'suppression-control',
            query: 'source=t | zzzzzzzz',
          },
        },
      }),
    /valid only for syntax/
  );
  assert.doesNotThrow(() =>
    assertContractSchema({
      schemaVersion: 4,
      ruleId: 'command-suggestion',
      channel: 'syntax',
      wiring: { code: 'UNKNOWN_COMMAND' },
      queries: {
        suppressed: {
          role: 'suppression-control',
          query: 'source=t | zzzzzzzz',
        },
      },
    })
  );
});

test('normalized wiring exposes omitted version, engine, and source scope gates', () => {
  const catalog = normalizeLintWiring('example-rule', {
    detector: 'example-rule',
    enabled: true,
    severity: 'warning',
    appliesTo: { minVersion: '3.7.0', engine: 'calcite' },
    sourceScoped: true,
  });
  const omittedVersion = normalizeLintWiring('example-rule', {
    detector: 'example-rule',
    enabled: true,
    severity: 'warning',
    appliesTo: { engine: 'calcite' },
    sourceScoped: true,
  });
  const omittedEngine = normalizeLintWiring('example-rule', {
    detector: 'example-rule',
    enabled: true,
    severity: 'warning',
    appliesTo: { minVersion: '3.7.0' },
    sourceScoped: true,
  });
  const omittedSourceScope = normalizeLintWiring('example-rule', {
    detector: 'example-rule',
    enabled: true,
    severity: 'warning',
    appliesTo: { minVersion: '3.7.0', engine: 'calcite' },
  });

  assert.notDeepEqual(omittedVersion, catalog);
  assert.notDeepEqual(omittedEngine, catalog);
  assert.notDeepEqual(omittedSourceScope, catalog);
  assert.equal(omittedSourceScope.sourceScoped, false);
});
