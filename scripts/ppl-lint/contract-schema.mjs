/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const EXECUTION_BACKENDS = new Set(['standard', 'analytics']);
const CONTRACT_SCHEMA_VERSIONS = new Set([3, 4]);
const APPLICABLE_BACKEND_KINDS = new Set(['rejection', 'result-shape', 'advisory']);
const CONTRACT_CHANNELS = new Set(['lint', 'syntax']);
const QUERY_ROLES = new Set(['trigger', 'control', 'suppression-control']);
const LINT_FRONTEND_FIELDS = new Set(['count', 'severity', 'matchMessage']);
const SYNTAX_FRONTEND_FIELDS = new Set([
  'count',
  'code',
  'fixText',
  'matchMessage',
  'rawMessage',
  'totalErrors',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function assertOptionalString(value, label) {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new TypeError(`${label} must be a non-empty string when present.`);
  }
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not valid for this contract channel.`);
    }
  }
}

export function contractChannel(spec) {
  requireObject(spec, 'contract');
  const channel = spec.channel === undefined ? 'lint' : spec.channel;
  if (!CONTRACT_CHANNELS.has(channel)) {
    throw new Error(
      `contract.channel must be "lint" or "syntax", got ${describe(channel)}.`
    );
  }
  return channel;
}

/**
 * Normalize legacy detector fields and channel-specific frontend assertions.
 *
 * Callers continue to receive `count`, `severity`, and `matchMessage` for lint
 * contracts while syntax contracts can assert stable parser error identity,
 * quick-fix text, raw-message preservation, and the total syntax error census.
 */
export function normalizeFrontendOracle(spec, queryExpectation) {
  const channel = contractChannel(spec);
  requireObject(queryExpectation, `[${spec.ruleId}] query expectation`);

  const hasLegacy = Object.prototype.hasOwnProperty.call(
    queryExpectation,
    'detectorCount'
  );
  const hasFrontend = Object.prototype.hasOwnProperty.call(
    queryExpectation,
    'frontend'
  );
  if (hasLegacy && hasFrontend) {
    throw new Error(
      `[${spec.ruleId}] query expectation must use either detectorCount or frontend, not both.`
    );
  }

  if (channel === 'lint') {
    const frontend = hasFrontend
      ? requireObject(queryExpectation.frontend, `[${spec.ruleId}] frontend`)
      : {
          count: queryExpectation.detectorCount,
          severity: queryExpectation.severity,
          matchMessage: queryExpectation.matchMessage,
        };
    assertKnownKeys(frontend, LINT_FRONTEND_FIELDS, `[${spec.ruleId}] frontend`);
    requireNonNegativeInteger(frontend.count, `[${spec.ruleId}] frontend.count`);
    assertOptionalString(frontend.severity, `[${spec.ruleId}] frontend.severity`);
    if (
      frontend.matchMessage !== undefined &&
      typeof frontend.matchMessage !== 'string'
    ) {
      throw new TypeError(
        `[${spec.ruleId}] frontend.matchMessage must be a string when present.`
      );
    }
    if (
      hasFrontend &&
      (queryExpectation.severity !== undefined ||
        queryExpectation.matchMessage !== undefined)
    ) {
      throw new Error(
        `[${spec.ruleId}] severity and matchMessage must be nested under frontend when frontend is present.`
      );
    }
    return {
      channel,
      count: frontend.count,
      severity: frontend.severity,
      matchMessage: frontend.matchMessage,
    };
  }

  if (hasLegacy) {
    throw new Error(
      `[${spec.ruleId}] syntax contracts must use frontend instead of detectorCount.`
    );
  }
  const frontend = requireObject(
    queryExpectation.frontend,
    `[${spec.ruleId}] frontend`
  );
  assertKnownKeys(frontend, SYNTAX_FRONTEND_FIELDS, `[${spec.ruleId}] frontend`);
  requireNonNegativeInteger(frontend.count, `[${spec.ruleId}] frontend.count`);
  requireNonEmptyString(frontend.code, `[${spec.ruleId}] frontend.code`);
  assertOptionalString(frontend.fixText, `[${spec.ruleId}] frontend.fixText`);
  if (
    frontend.matchMessage !== undefined &&
    typeof frontend.matchMessage !== 'string'
  ) {
    throw new TypeError(
      `[${spec.ruleId}] frontend.matchMessage must be a string when present.`
    );
  }
  if (frontend.rawMessage !== undefined && typeof frontend.rawMessage !== 'boolean') {
    throw new TypeError(`[${spec.ruleId}] frontend.rawMessage must be a boolean.`);
  }
  if (frontend.totalErrors !== undefined) {
    requireNonNegativeInteger(
      frontend.totalErrors,
      `[${spec.ruleId}] frontend.totalErrors`
    );
  }
  for (const field of ['severity', 'matchMessage']) {
    if (Object.prototype.hasOwnProperty.call(queryExpectation, field)) {
      throw new Error(
        `[${spec.ruleId}] syntax ${field} must be nested under frontend.`
      );
    }
  }
  return { channel, ...frontend };
}

export function normalizeLintWiring(ruleId, wiring, label = 'wiring') {
  requireNonEmptyString(ruleId, `${label}.id`);
  requireObject(wiring, label);
  const appliesTo =
    wiring.appliesTo === undefined ? {} : requireObject(wiring.appliesTo, `${label}.appliesTo`);
  const normalizedAppliesTo = {};
  for (const key of ['minVersion', 'maxVersion', 'engine']) {
    assertOptionalString(appliesTo[key], `${label}.appliesTo.${key}`);
    if (appliesTo[key] !== undefined) {
      normalizedAppliesTo[key] = appliesTo[key];
    }
  }
  for (const key of [
    'runtimeOnly',
    'needsContext',
    'needsExplain',
    'sourceScoped',
  ]) {
    if (wiring[key] !== undefined && typeof wiring[key] !== 'boolean') {
      throw new TypeError(`${label}.${key} must be a boolean when present.`);
    }
  }
  if (typeof wiring.enabled !== 'boolean') {
    throw new TypeError(`${label}.enabled must be a boolean.`);
  }
  return {
    id: ruleId,
    detector: requireNonEmptyString(wiring.detector, `${label}.detector`),
    enabled: wiring.enabled,
    severity: requireNonEmptyString(wiring.severity, `${label}.severity`),
    appliesTo: normalizedAppliesTo,
    runtimeOnly: wiring.runtimeOnly === true,
    needsContext: wiring.needsContext === true,
    needsExplain: wiring.needsExplain === true,
    sourceScoped: wiring.sourceScoped === true,
  };
}

function assertBackendOracle(oracle, ruleId, executionBackend) {
  const label = `[${ruleId}] ${executionBackend} backend oracle`;
  requireObject(oracle, label);
  const kind = requireNonEmptyString(oracle.kind, `${label}.kind`);

  if (kind === 'not-applicable') {
    const reason = requireNonEmptyString(oracle.reason, `${label}.reason`);
    if (reason.trim().length === 0) {
      throw new TypeError(`${label}.reason must not be blank.`);
    }
    requireNonEmptyString(oracle.owner, `${label}.owner`);
    requireNonEmptyString(oracle.issue, `${label}.issue`);
    return kind;
  }
  if (!APPLICABLE_BACKEND_KINDS.has(kind)) {
    throw new Error(`[${ruleId}] unknown ${executionBackend} backend oracle.kind "${kind}".`);
  }

  if (!Number.isInteger(oracle.httpStatus) || oracle.httpStatus < 100 || oracle.httpStatus > 599) {
    throw new TypeError(`${label}.httpStatus must be an integer from 100 through 599.`);
  }
  if ((kind === 'result-shape' || kind === 'advisory') && oracle.httpStatus !== 200) {
    throw new TypeError(`${label}.httpStatus must be 200.`);
  }
  if (kind === 'rejection') {
    const body = requireObject(oracle.body, `${label}.body`);
    if (!Number.isInteger(body.status)) {
      throw new TypeError(`${label}.body.status must be an integer.`);
    }
    if (body.status !== oracle.httpStatus) {
      throw new TypeError(`${label}.httpStatus must equal ${label}.body.status.`);
    }
    if (body.error !== undefined) {
      const error = requireObject(body.error, `${label}.body.error`);
      assertOptionalString(error.type, `${label}.body.error.type`);
      assertOptionalString(error.reason, `${label}.body.error.reason`);
    }
  }
  if (kind === 'result-shape' && oracle.expect !== undefined) {
    const expect = requireObject(oracle.expect, `${label}.expect`);
    if (
      expect.datarowsNonEmpty !== undefined &&
      typeof expect.datarowsNonEmpty !== 'boolean'
    ) {
      throw new TypeError(`${label}.expect.datarowsNonEmpty must be a boolean.`);
    }
    if (expect.datarowsCount !== undefined) {
      requireNonNegativeInteger(expect.datarowsCount, `${label}.expect.datarowsCount`);
    }
    assertOptionalString(expect.columnAllNull, `${label}.expect.columnAllNull`);
  }
  return kind;
}

export function assertExecutionBackend(value, label = 'executionBackend') {
  if (!EXECUTION_BACKENDS.has(value)) {
    throw new Error(
      `${label} must be "standard" or "analytics", got ${describe(value)}.`
    );
  }
  return value;
}

/**
 * Validate target.json and return the identity consumed by report readers.
 *
 * Execution identity is never inferred. Every producer in the current
 * workflows writes schemaVersion 2, so an unversioned target is an incomplete
 * artifact rather than a compatibility mode.
 */
export function normalizeTarget(target) {
  requireObject(target, 'target');

  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(target, 'schemaVersion');
  if (!hasSchemaVersion) {
    throw new Error('target.schemaVersion is required; expected 2.');
  }

  if (target.schemaVersion !== 2) {
    throw new Error(
      `Unsupported target schemaVersion ${describe(target.schemaVersion)}; expected 2.`
    );
  }
  const executionBackend = assertExecutionBackend(
    target.executionBackend,
    'target.executionBackend'
  );
  requireNonEmptyString(target.engineVersion, 'target.engineVersion');
  if (typeof target.grammarHash !== 'string') {
    throw new TypeError('target.grammarHash must be a string.');
  }
  if (
    Object.prototype.hasOwnProperty.call(target, 'grammarBundle') &&
    typeof target.grammarBundle !== 'string'
  ) {
    throw new TypeError('target.grammarBundle must be a string when present.');
  }
  if (
    Object.prototype.hasOwnProperty.call(target, 'sqlSha') &&
    typeof target.sqlSha !== 'string'
  ) {
    throw new TypeError('target.sqlSha must be a string when present.');
  }
  if (!Number.isInteger(target.shardCount) || target.shardCount < 1) {
    throw new Error('target.shardCount must be a positive integer.');
  }
  if (executionBackend === 'analytics') {
    if (target.storage !== 'composite-parquet') {
      throw new Error(
        `analytics target.storage must be "composite-parquet", got ${describe(target.storage)}.`
      );
    }
    const analyticsStack = requireObject(
      target.analyticsStack,
      'analytics target.analyticsStack'
    );
    requireNonEmptyString(
      analyticsStack.source,
      'analytics target.analyticsStack.source'
    );
    const attestation = requireObject(
      target.routeAttestation,
      'analytics target.routeAttestation'
    );
    for (const check of [
      'pluginsVerified',
      'clusterSettingsVerified',
      'fixtureIndicesVerified',
      'explainVerified',
      'profiledExecutionVerified',
    ]) {
      if (attestation[check] !== true) {
        throw new Error(`analytics target.routeAttestation.${check} must be true.`);
      }
    }
  } else if (target.storage !== 'lucene') {
    throw new Error(
      `standard target.storage must be "lucene", got ${describe(target.storage)}.`
    );
  }

  return {
    schemaVersion: 2,
    executionBackend,
    engineVersion: target.engineVersion,
    grammarHash: target.grammarHash,
    grammarBundle: target.grammarBundle || '',
    sqlSha: target.sqlSha || '',
    storage: target.storage || (executionBackend === 'standard' ? 'lucene' : ''),
    shardCount: target.shardCount,
    analyticsStack: target.analyticsStack,
    routeAttestation: target.routeAttestation,
    legacy: false,
  };
}

export function assertContractSchema(spec) {
  requireObject(spec, 'contract');
  if (!CONTRACT_SCHEMA_VERSIONS.has(spec.schemaVersion)) {
    throw new Error(
      `Unsupported contract schemaVersion ${describe(spec.schemaVersion)}; expected 3 or 4.`
    );
  }
  requireNonEmptyString(spec.ruleId, 'contract.ruleId');
  const channel = contractChannel(spec);
  if (spec.wiring !== undefined) {
    const wiring = requireObject(spec.wiring, `[${spec.ruleId}] contract.wiring`);
    if (channel === 'syntax') {
      const keys = Object.keys(wiring);
      if (keys.length !== 1 || keys[0] !== 'code') {
        throw new Error(
          `[${spec.ruleId}] syntax wiring must contain only the stable error code.`
        );
      }
      requireNonEmptyString(wiring.code, `[${spec.ruleId}] contract.wiring.code`);
    } else if (Object.prototype.hasOwnProperty.call(wiring, 'code')) {
      throw new Error(`[${spec.ruleId}] lint wiring must not contain syntax code.`);
    }
  }
  if (spec.queries !== undefined) {
    requireObject(spec.queries, `[${spec.ruleId}] contract.queries`);
    for (const [queryName, query] of Object.entries(spec.queries)) {
      requireObject(query, `[${spec.ruleId}] contract.queries.${queryName}`);
      const role = query.role === undefined ? 'trigger' : query.role;
      if (!QUERY_ROLES.has(role)) {
        throw new Error(
          `[${spec.ruleId}] query "${queryName}" has invalid role ${describe(role)}.`
        );
      }
      if (role === 'suppression-control' && channel !== 'syntax') {
        throw new Error(
          `[${spec.ruleId}] suppression-control is valid only for syntax contracts.`
        );
      }
    }
  }
  return spec.schemaVersion;
}

/**
 * Require a selected expectation to cover every top-level query exactly once.
 * JSON object keys are unique after parsing, so set equality establishes the
 * one-to-one query identity needed by both backend and detector readers.
 */
export function assertExactQueryCoverage(spec, expectation) {
  assertContractSchema(spec);
  requireObject(spec.queries, `[${spec.ruleId}] contract.queries`);
  requireObject(expectation, `[${spec.ruleId}] selected expectation`);
  requireObject(expectation.queries, `[${spec.ruleId}] selected expectation.queries`);

  const contractKeys = Object.keys(spec.queries).sort();
  const expectationKeys = Object.keys(expectation.queries).sort();
  if (contractKeys.length === 0) {
    throw new Error(`[${spec.ruleId}] contract.queries must not be empty.`);
  }
  const contractSet = new Set(contractKeys);
  const expectationSet = new Set(expectationKeys);
  const missing = contractKeys.filter((key) => !expectationSet.has(key));
  const extra = expectationKeys.filter((key) => !contractSet.has(key));

  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) {
      details.push(`missing from expectation: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      details.push(`not present in contract.queries: ${extra.join(', ')}`);
    }
    throw new Error(`[${spec.ruleId}] query coverage must be exact (${details.join('; ')}).`);
  }
  return contractKeys;
}

/**
 * Resolve only the route-specific backend oracle. Detector count, severity, and
 * message assertions remain on the shared query expectation and are returned
 * unchanged for either execution backend.
 */
export function resolveBackendOracle(spec, queryExpectation, executionBackend) {
  const schemaVersion = assertContractSchema(spec);
  assertExecutionBackend(executionBackend);
  const frontend = normalizeFrontendOracle(spec, queryExpectation);
  const detector = {
    count: frontend.count,
    severity: frontend.severity,
    matchMessage: frontend.matchMessage,
  };

  let oracle;
  let missingReason;
  if (schemaVersion === 3) {
    if (executionBackend === 'standard') {
      oracle = queryExpectation.backend;
      missingReason = 'schema-v3 query has no backend oracle';
    } else {
      missingReason =
        'schema-v3 backend oracles are standard-only; no analytics oracle is defined';
    }
  } else {
    if (
      Object.prototype.hasOwnProperty.call(queryExpectation, 'backends') &&
      !isObject(queryExpectation.backends)
    ) {
      throw new TypeError(`[${spec.ruleId}] backends must be a JSON object.`);
    }
    for (const backend of Object.keys(queryExpectation.backends || {})) {
      assertExecutionBackend(backend, `[${spec.ruleId}] backends key`);
    }
    oracle = queryExpectation.backends && queryExpectation.backends[executionBackend];
    missingReason = `schema-v4 query has no ${executionBackend} backend oracle`;
  }

  if (oracle === undefined) {
    return {
      status: 'coverage-missing',
      executionBackend,
      detector,
      frontend,
      oracle: undefined,
      reason: missingReason,
    };
  }

  const kind = assertBackendOracle(oracle, spec.ruleId, executionBackend);
  if (kind === 'not-applicable') {
    return {
      status: 'not-applicable',
      executionBackend,
      detector,
      frontend,
      oracle,
      reason: oracle.reason,
    };
  }

  return {
    status: 'applicable',
    executionBackend,
    detector,
    frontend,
    oracle,
    reason: undefined,
  };
}

export function backendReportKey(entry) {
  requireObject(entry, 'backend report row');
  const ruleId = requireNonEmptyString(entry.ruleId, 'backend report row.ruleId');
  const queryName = requireNonEmptyString(entry.queryName, 'backend report row.queryName');
  return `${ruleId}::${queryName}`;
}

/**
 * Read the backend observation state without coercing a missing verdict to
 * acceptance. Explicit infrastructure/coverage states take precedence even if
 * a malformed row also happens to contain `rejected`.
 */
export function classifyBackendReportRow(entry) {
  requireObject(entry, 'backend report row');
  if (entry.outcome === 'not-applicable' || entry.kind === 'not-applicable') {
    return { status: 'not-applicable', rejected: undefined };
  }
  if (entry.outcome === 'coverage-missing' || entry.kind === 'coverage-missing') {
    return { status: 'coverage-missing', rejected: undefined };
  }
  if (entry.outcome === 'error' || typeof entry.rejected !== 'boolean') {
    return { status: 'error', rejected: undefined };
  }
  return { status: 'observed', rejected: entry.rejected };
}

/**
 * Validate and index the historical bare-array backend report.
 *
 * Every row carries the same explicit backend identity as its schema-v2 target.
 */
export function indexBackendReport(entries, targetIdentity) {
  if (!Array.isArray(entries)) {
    throw new TypeError('backend report must be a JSON array.');
  }
  requireObject(targetIdentity, 'normalized target identity');
  assertExecutionBackend(
    targetIdentity.executionBackend,
    'normalized target identity.executionBackend'
  );

  const byKey = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const key = backendReportKey(entry);
    const hasIdentity = Object.prototype.hasOwnProperty.call(entry, 'executionBackend');
    if (!hasIdentity) {
      throw new Error(
        `backend report row ${key} is missing executionBackend for a schema-v2 target.`
      );
    }
    const rowBackend = assertExecutionBackend(
      entry.executionBackend,
      `backend report row ${key}.executionBackend`
    );
    if (rowBackend !== targetIdentity.executionBackend) {
      throw new Error(
        `backend report row ${key} executionBackend "${rowBackend}" does not match ` +
          `target "${targetIdentity.executionBackend}".`
      );
    }
    if (byKey.has(key)) {
      throw new Error(`duplicate backend report key "${key}".`);
    }
    byKey.set(key, entry);
  }
  return byKey;
}
