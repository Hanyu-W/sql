/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertContractSchema,
  assertExactQueryCoverage,
  classifyBackendReportRow,
  indexBackendReport,
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
