/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  assertContractSchema,
  assertExactQueryCoverage,
  classifyBackendReportRow,
  indexBackendReport,
  normalizeTarget,
  resolveBackendOracle,
} from './contract-schema.mjs';

const ACTIVE_RULE_IDS = [
  'agg-on-text',
  'division-by-zero',
  'enabled-false-object',
  'field-validation',
  'invalid-capture-group-name',
  'multisearch-min-subsearch',
  'replace-wildcard-asymmetry',
  'rex-scan-cost',
  'type-mismatch-numeric',
  'union-min-datasets',
  'unsupported-window-function-in-eventstats',
  'wildcard-source-zero-match',
];

function fatal(message) {
  process.stderr.write(`[ppl-lint-compatibility] FATAL: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { out: 'drift-report.json', summary: '', osdSha: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (value === undefined) fatal(`${key} requires a value`);
    if (key === '--plan') args.plan = value;
    else if (key === '--contracts') args.contracts = value;
    else if (key === '--artifacts') args.artifacts = value;
    else if (key === '--osd-sha') args.osdSha = value;
    else if (key === '--out') args.out = value;
    else if (key === '--summary') args.summary = value;
    else fatal(`unknown argument ${JSON.stringify(key)}`);
  }
  for (const field of ['plan', 'contracts', 'artifacts']) {
    if (!args[field]) fatal(`--${field} is required`);
  }
  return args;
}

function readRequiredJson(file) {
  if (!fs.existsSync(file)) fatal(`required JSON file not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fatal(`could not parse ${file}: ${error.message}`);
  }
}

function readOptionalJson(file) {
  if (!fs.existsSync(file)) {
    return { value: undefined, error: `missing ${path.basename(file)}` };
  }
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), error: undefined };
  } catch (error) {
    return { value: undefined, error: `invalid ${path.basename(file)}: ${error.message}` };
  }
}

function readOptionalText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value || ''));
  return match ? match.slice(1, 4).map((part) => Number(part || 0)) : undefined;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function inVersionRange(version, minVersion, maxVersion) {
  const actual = parseVersion(version);
  if (!actual) return false;
  const min = parseVersion(minVersion);
  const max = parseVersion(maxVersion);
  if (min && compareVersion(actual, min) < 0) return false;
  if (max && compareVersion(actual, max) > 0) return false;
  return true;
}

function matchesExpectationRange(range, version) {
  if (!range || !String(range).trim()) return true;
  const actual = parseVersion(version);
  if (!actual) return false;
  for (const token of String(range).trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(token);
    if (!match) return false;
    const expected = parseVersion(match[2]);
    const comparison = compareVersion(actual, expected);
    const operator = match[1] || '=';
    if (
      !(
        (operator === '>=' && comparison >= 0) ||
        (operator === '<=' && comparison <= 0) ||
        (operator === '>' && comparison > 0) ||
        (operator === '<' && comparison < 0) ||
        (operator === '=' && comparison === 0)
      )
    ) {
      return false;
    }
  }
  return true;
}

function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.configurations)) {
    fatal('compatibility plan must be schemaVersion 1 with a configurations array');
  }
  if (plan.configurations.length !== 3) {
    fatal(`compatibility plan must contain exactly 3 configurations, found ${plan.configurations.length}`);
  }
  const ids = new Set();
  for (const configuration of plan.configurations) {
    for (const field of [
      'id',
      'label',
      'engineVersion',
      'surface',
      'executionBackend',
      'engineMode',
      'artifactName',
    ]) {
      if (typeof configuration[field] !== 'string' || !configuration[field]) {
        fatal(`plan configuration ${JSON.stringify(configuration.id)} has invalid ${field}`);
      }
    }
    if (!['compiled-simplified', 'runtime-bundle'].includes(configuration.surface)) {
      fatal(`plan configuration ${configuration.id} has unknown surface ${configuration.surface}`);
    }
    if (!['calcite', 'legacy'].includes(configuration.engineMode)) {
      fatal(
        `plan configuration ${configuration.id} has unknown engine mode ` +
          configuration.engineMode
      );
    }
    if (ids.has(configuration.id)) fatal(`duplicate plan configuration ${configuration.id}`);
    ids.add(configuration.id);
  }
}

function loadContracts(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = readRequiredJson(manifestPath);
  if (!Array.isArray(manifest.contracts)) fatal(`${manifestPath} contracts must be an array`);
  const contracts = new Map();
  for (const file of manifest.contracts) {
    const specPath = path.join(dir, file);
    const spec = readRequiredJson(specPath);
    try {
      assertContractSchema(spec);
      if (!Array.isArray(spec.expectations) || spec.expectations.length === 0) {
        throw new Error('expectations must be a non-empty array');
      }
      for (const expectation of spec.expectations) {
        assertExactQueryCoverage(spec, expectation);
      }
    } catch (error) {
      fatal(`invalid ${specPath}: ${error.message}`);
    }
    if (contracts.has(spec.ruleId)) fatal(`duplicate active rule id ${spec.ruleId}`);
    contracts.set(spec.ruleId, { file, spec });
  }
  const actual = [...contracts.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(ACTIVE_RULE_IDS)) {
    fatal(
      `active manifest must contain exactly the approved 12 rules; expected ` +
        `${JSON.stringify(ACTIVE_RULE_IDS)}, got ${JSON.stringify(actual)}`
    );
  }
  return contracts;
}

function expectedScope(spec, configuration) {
  const appliesTo = (spec.wiring && spec.wiring.appliesTo) || {};
  const declaredSurface = spec.grammarSurface || 'runtime-bundle';
  const surfaces =
    declaredSurface === 'both'
      ? ['compiled-simplified', 'runtime-bundle']
      : [declaredSurface];
  const expected = {
    applicable: true,
    engine: appliesTo.engine || 'any',
    minVersion: appliesTo.minVersion || null,
    maxVersion: appliesTo.maxVersion || null,
    surfaces,
  };

  if (!surfaces.includes(configuration.surface)) {
    return { ...expected, applicable: false, reason: 'surface' };
  }
  if (
    !inVersionRange(
      configuration.engineVersion,
      appliesTo.minVersion,
      appliesTo.maxVersion
    )
  ) {
    return { ...expected, applicable: false, reason: 'version' };
  }
  if (appliesTo.engine && appliesTo.engine !== configuration.engineMode) {
    return { ...expected, applicable: false, reason: 'engine' };
  }
  return expected;
}

function selectExpectation(spec, configuration) {
  const matches = spec.expectations.filter(
    (expectation) =>
      matchesExpectationRange(expectation.version, configuration.engineVersion) &&
      (!expectation.engine || expectation.engine === configuration.engineMode)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function indexDetectorReport(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.results)) {
    throw new Error('detector-report.json must contain a results array');
  }
  const rows = new Map();
  for (const row of report.results) {
    if (!row || typeof row.ruleId !== 'string' || typeof row.queryName !== 'string') {
      throw new Error('detector report rows require ruleId and queryName');
    }
    const key = `${row.ruleId}::${row.queryName}`;
    if (rows.has(key)) throw new Error(`duplicate detector row ${key}`);
    rows.set(key, row);
  }
  return rows;
}

function loadEvidence(configuration, artifactsRoot, sqlSha) {
  const dir = path.join(artifactsRoot, configuration.artifactName);
  const errors = [];
  const backendTargetRead = readOptionalJson(path.join(dir, 'target.json'));
  const detectorTargetRead = readOptionalJson(path.join(dir, 'detector-target.json'));
  const detectorRead = readOptionalJson(path.join(dir, 'detector-report.json'));
  const backendRead = readOptionalJson(path.join(dir, 'backend-report.json'));
  const bundleRead =
    configuration.surface === 'runtime-bundle'
      ? readOptionalJson(path.join(dir, 'ppl-grammar-bundle.json'))
      : { value: undefined, error: undefined };

  let backendTarget;
  let detectorTarget;
  let detectorRows = new Map();
  let backendRows = new Map();

  for (const item of [backendTargetRead, detectorTargetRead, detectorRead, backendRead, bundleRead]) {
    if (item.error) errors.push(item.error);
  }
  if (backendTargetRead.value) {
    try {
      backendTarget = normalizeTarget(backendTargetRead.value);
    } catch (error) {
      errors.push(`invalid target.json: ${error.message}`);
    }
  }
  if (detectorTargetRead.value) {
    try {
      detectorTarget = normalizeTarget(detectorTargetRead.value);
    } catch (error) {
      errors.push(`invalid detector-target.json: ${error.message}`);
    }
  }
  if (detectorRead.value) {
    try {
      detectorRows = indexDetectorReport(detectorRead.value);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (backendRead.value && backendTarget) {
    try {
      backendRows = indexBackendReport(backendRead.value, backendTarget);
    } catch (error) {
      errors.push(`invalid backend-report.json: ${error.message}`);
    }
  }

  if (backendTarget) {
    if (
      !backendTarget.engineVersion.startsWith(
        configuration.engineVersion.replace(/[-+].*$/, '')
      )
    ) {
      errors.push(
        `target engine ${backendTarget.engineVersion} does not match planned ` +
          configuration.engineVersion
      );
    }
    if (backendTarget.executionBackend !== configuration.executionBackend) {
      errors.push(
        `target backend ${backendTarget.executionBackend} does not match planned ` +
          configuration.executionBackend
      );
    }
    if (sqlSha && backendTarget.sqlSha && backendTarget.sqlSha !== sqlSha) {
      errors.push(`target SQL SHA ${backendTarget.sqlSha} does not match planned ${sqlSha}`);
    }
  }
  if (detectorTarget && detectorRead.value) {
    for (const field of ['engineVersion', 'grammarHash', 'executionBackend']) {
      if (detectorRead.value[field] !== detectorTarget[field]) {
        errors.push(
          `detector report ${field} ${JSON.stringify(detectorRead.value[field])} does not match ` +
            `detector target ${JSON.stringify(detectorTarget[field])}`
        );
      }
    }
    if (detectorRead.value.surface !== configuration.surface) {
      errors.push(
        `detector surface ${JSON.stringify(detectorRead.value.surface)} does not match planned ` +
          configuration.surface
      );
    }
  }
  if (
    bundleRead.value &&
    detectorTarget &&
    bundleRead.value.grammarHash !== detectorTarget.grammarHash
  ) {
    errors.push('runtime grammar bundle hash does not match detector target');
  }

  return {
    dir,
    errors: [...new Set(errors)],
    backendTarget,
    detectorTarget,
    detectorReport: detectorRead.value,
    detectorRows,
    backendRows,
    backendCommand: readOptionalText(path.join(dir, 'backend-command.txt')),
    detectorCommand: readOptionalText(path.join(dir, 'detector-command.txt')),
  };
}

function detectorActual(row, evidence) {
  if (evidence.errors.length > 0 && !evidence.detectorReport) {
    return { outcome: 'error', error: evidence.errors.join('; ') };
  }
  if (!row) return { outcome: 'missing' };
  if (row.outcome === 'error') {
    return { outcome: 'error', error: row.error || 'frontend execution failed' };
  }
  if (row.outcome === 'not-applicable' || row.notApplicable) {
    return { outcome: 'error', error: row.notApplicable || 'unexpected not-applicable row' };
  }
  return {
    outcome: 'observed',
    count: row.actual,
    severities: row.severities || [],
    diagnostics: row.diagnostics || [],
  };
}

function backendActual(row, evidence) {
  if (evidence.errors.length > 0 && evidence.backendRows.size === 0) {
    return { outcome: 'error', error: evidence.errors.join('; ') };
  }
  if (!row) return { outcome: 'missing' };
  const state = classifyBackendReportRow(row);
  if (state.status !== 'observed') {
    return {
      outcome: state.status === 'error' ? 'error' : 'error',
      error: row.error || `backend outcome was ${state.status}`,
    };
  }
  const observed = row.observed || {};
  return {
    outcome: 'observed',
    rejected: state.rejected,
    httpStatus: observed.httpStatus,
    errorType: observed.type,
    errorReason: observed.reason,
  };
}

function expectedCase(spec, queryExpectation) {
  const resolved = resolveBackendOracle(spec, queryExpectation, 'standard');
  if (resolved.status !== 'applicable') {
    throw new Error(resolved.reason || 'standard backend oracle is not applicable');
  }
  const expectedBackend = {
    kind: resolved.oracle.kind,
    httpStatus: resolved.oracle.httpStatus,
  };
  const error = resolved.oracle.body && resolved.oracle.body.error;
  if (error && error.type) expectedBackend.errorType = error.type;
  if (error && error.reason) expectedBackend.errorReason = error.reason;
  return {
    detector: {
      count: resolved.detector.count,
      ...(resolved.detector.severity ? { severity: resolved.detector.severity } : {}),
      ...(resolved.detector.matchMessage
        ? { message: resolved.detector.matchMessage }
        : {}),
      ...(resolved.detector.messageEquals
        ? { message: resolved.detector.messageEquals }
        : {}),
    },
    backend: expectedBackend,
    frontend: resolved.frontend,
  };
}

function compareDetector(expected, actual, row) {
  if (actual.outcome !== 'observed') return [];
  const differences = [];
  if (actual.count !== expected.count) differences.push('detector.count');
  if (expected.severity && row.severityMatched === false) differences.push('detector.severity');
  if (expected.message && row.messageMatched === false) differences.push('detector.message');
  for (const field of [
    'deterministicFixMatched',
    'fixMatched',
    'rawMessageMatched',
    'totalErrorsMatched',
  ]) {
    if (row[field] === false) differences.push(`detector.${field}`);
  }
  for (const [field, matched] of Object.entries(row.assertions || {})) {
    if (matched === false && !['count', 'severity'].includes(field)) {
      differences.push(`detector.${field}`);
    }
  }
  return [...new Set(differences)];
}

function compareBackend(expected, actual, row) {
  if (actual.outcome !== 'observed') return [];
  const differences = [];
  const expectedRejected = expected.kind === 'rejection';
  if (actual.rejected !== expectedRejected) differences.push('backend.rejected');
  if (
    Number.isInteger(expected.httpStatus) &&
    actual.httpStatus !== expected.httpStatus
  ) {
    differences.push('backend.httpStatus');
  }
  if (expected.errorType && actual.errorType !== expected.errorType) {
    differences.push('backend.errorType');
  }
  if (expected.errorReason && actual.errorReason !== expected.errorReason) {
    differences.push('backend.errorReason');
  }
  if (row.outcome === 'observed-mismatch' || row.error) {
    differences.push('backend.result');
  }
  return [...new Set(differences)];
}

function aggregateActual(cases, side) {
  const actuals = cases.map((entry) => entry.actual[side]);
  const errored = actuals.find((actual) => actual.outcome === 'error');
  if (errored) return { outcome: 'error', error: errored.error };
  if (actuals.some((actual) => actual.outcome === 'missing')) return { outcome: 'missing' };
  if (side === 'detector') {
    return {
      outcome: 'observed',
      diagnosticCount: actuals.reduce((sum, actual) => sum + (actual.count || 0), 0),
    };
  }
  const rejected = actuals.filter((actual) => actual.rejected === true).length;
  return { outcome: 'observed', rejected, observedCases: actuals.length };
}

function reasonForIncomplete(cases, evidence) {
  for (const entry of cases) {
    if (entry.actual.detector.outcome !== 'observed') {
      return {
        code:
          entry.actual.detector.outcome === 'missing'
            ? 'missing-detector-row'
            : 'detector-error',
        message:
          entry.actual.detector.error ||
          `No detector result was produced for ${entry.ruleId}::${entry.queryName}.`,
      };
    }
    if (entry.actual.backend.outcome !== 'observed') {
      return {
        code:
          entry.actual.backend.outcome === 'missing'
            ? 'missing-backend-row'
            : 'backend-error',
        message:
          entry.actual.backend.error ||
          `No backend result was produced for ${entry.ruleId}::${entry.queryName}.`,
      };
    }
  }
  return {
    code: 'invalid-leg-identity',
    message: evidence.errors.join('; ') || 'The configuration did not produce trustworthy evidence.',
  };
}

function classifyCell(cases) {
  const triggerCases = cases.filter((entry) => entry.role === 'trigger');
  const rejectionTriggers = triggerCases.filter(
    (entry) => entry.expected.backend.kind === 'rejection'
  );
  const accepted = rejectionTriggers.filter(
    (entry) =>
      entry.actual.backend.outcome === 'observed' &&
      entry.actual.backend.rejected === false
  );
  const rejected = rejectionTriggers.filter(
    (entry) =>
      entry.actual.backend.outcome === 'observed' &&
      entry.actual.backend.rejected === true
  );
  const controls = cases.filter((entry) => entry.role !== 'trigger');
  const controlsProveSupport = controls.every(
    (entry) =>
      entry.actual.backend.outcome === 'observed' &&
      entry.differences.every((difference) => !difference.startsWith('backend.'))
  );
  const detectorDifferences = cases.flatMap((entry) =>
    entry.differences.filter((difference) => difference.startsWith('detector.'))
  );
  const backendDifferences = cases.flatMap((entry) =>
    entry.differences.filter((difference) => difference.startsWith('backend.'))
  );

  const triggerSummary = {
    contracted: rejectionTriggers.length,
    acceptedByBackend: accepted.length,
    rejectedByBackend: rejected.length,
    missing: rejectionTriggers.filter(
      (entry) => entry.actual.backend.outcome !== 'observed'
    ).length,
  };
  if (
    rejectionTriggers.length > 0 &&
    accepted.length === rejectionTriggers.length &&
    controlsProveSupport
  ) {
    return { classification: 'full-engine-relaxation', triggerSummary };
  }
  if (accepted.length > 0 && rejected.length > 0) {
    return { classification: 'partial-engine-relaxation', triggerSummary };
  }
  if (backendDifferences.length === 0 && detectorDifferences.length > 0) {
    return { classification: 'detector-regression', triggerSummary };
  }
  if (backendDifferences.length > 0) {
    return { classification: 'contract-drift', triggerSummary };
  }
  return { classification: undefined, triggerSummary };
}

function remediation(classification) {
  if (classification === 'detector-regression') {
    return {
      action: 'update-detector',
      scope: 'detector-only',
      detail: 'Backend behavior is unchanged; keep appliesTo unchanged.',
    };
  }
  if (classification === 'full-engine-relaxation') {
    return {
      action: 'scope-rule-version',
      scope: 'appliesTo',
      detail:
        'Every contracted trigger is accepted and controls remain supported; stop applying ' +
        'this rule to this version range.',
    };
  }
  if (classification === 'partial-engine-relaxation') {
    return {
      action: 'narrow-detector',
      scope: 'detector-only',
      detail: 'Keep the rule active for this version and narrow it to the forms the backend still rejects.',
    };
  }
  return {
    action: 'update-contract',
    scope: 'oracle',
    detail: 'Confirm the backend behavior change is intentional before updating the pinned contract.',
  };
}

function expectedDescription(spec) {
  const appliesTo = (spec.wiring && spec.wiring.appliesTo) || {};
  const parts = [];
  if (appliesTo.engine) {
    parts.push(appliesTo.engine === 'calcite' ? 'Calcite' : appliesTo.engine);
  }
  if (appliesTo.minVersion && appliesTo.maxVersion) {
    parts.push(`>= ${appliesTo.minVersion}, <= ${appliesTo.maxVersion}`);
  } else if (appliesTo.minVersion) {
    parts.push(`>= ${appliesTo.minVersion}`);
  } else if (appliesTo.maxVersion) {
    parts.push(`<= ${appliesTo.maxVersion}`);
  } else {
    parts.push('all versions');
  }
  parts.push((spec.grammarSurface || 'runtime-bundle') === 'both' ? 'both' : 'runtime only');
  return parts.join('; ');
}

function markdownCell(row) {
  if (row.status === 'n/a') return `n/a (${row.expected.reason})`;
  if (row.status === 'drift') return '**drift**';
  if (row.status === 'inconclusive') return '**inconclusive**';
  return 'compatible';
}

function renderMarkdown(report, contracts) {
  const lines = [
    `## PPL lint compatibility: ${report.result.status.toUpperCase()}`,
    '',
    `SQL: \`${report.candidate.sqlSha.slice(0, 9)}\`  `,
    `OSD: \`${report.candidate.osd.repository} @ ${report.candidate.osd.sha || report.candidate.osd.ref}\`  `,
    `Rules: ${report.inventory.ruleCount}  `,
    `Configurations: ${report.configurations.length}  `,
    `Blocking results: ${report.result.drift} drift, ${report.result.inconclusive} inconclusive`,
    '',
    `| Rule | Expected compatibility | ${report.configurations
      .map((configuration) => configuration.label)
      .join(' | ')} |`,
    `| --- | --- | ${report.configurations.map(() => '---').join(' | ')} |`,
  ];
  for (const ruleId of ACTIVE_RULE_IDS) {
    const spec = contracts.get(ruleId).spec;
    const cells = report.configurations.map((configuration) =>
      markdownCell(
        report.matrix.find(
          (entry) =>
            entry.ruleId === ruleId && entry.configurationId === configuration.id
        )
      )
    );
    lines.push(
      `| \`${ruleId}\` | ${expectedDescription(spec)} | ${cells.join(' | ')} |`
    );
  }
  lines.push('');

  const blocking = report.findings.filter((finding) => finding.blocking);
  if (blocking.length > 0) {
    lines.push('### Blocking findings', '');
    lines.push('| Rule | Configuration | Classification | Evidence | Action |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const finding of blocking) {
      const evidence =
        finding.reason?.message ||
        `${finding.evidence.triggerSummary.acceptedByBackend}/` +
          `${finding.evidence.triggerSummary.contracted} contracted triggers accepted`;
      lines.push(
        `| \`${finding.ruleId}\` | ${finding.configurationLabel} | ` +
          `${finding.classification || 'inconclusive'} | ${evidence.replace(/\|/g, '\\|')} | ` +
          `${finding.remediation.detail.replace(/\|/g, '\\|')} |`
      );
    }
    lines.push('');
  }
  lines.push('### Published evidence', '');
  lines.push('| Output | Location |');
  lines.push('| --- | --- |');
  lines.push('| Full table | `Aggregate rule compatibility` step summary |');
  lines.push('| Machine-readable report | `ppl-lint-multiversion-drift/drift-report.json` |');
  lines.push('| Detector logs and target identities | `ppl-lint-multiversion-evidence` |');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = readRequiredJson(args.plan);
  validatePlan(plan);
  const contracts = loadContracts(args.contracts);
  const evidenceByConfiguration = new Map(
    plan.configurations.map((configuration) => [
      configuration.id,
      loadEvidence(configuration, args.artifacts, plan.sqlSha),
    ])
  );
  const configurations = plan.configurations.map((configuration) => {
    const evidence = evidenceByConfiguration.get(configuration.id);
    return {
      id: configuration.id,
      label: configuration.label,
      engineVersion:
        (evidence.backendTarget && evidence.backendTarget.engineVersion) ||
        configuration.engineVersion,
      surface: configuration.surface,
      executionBackend: configuration.executionBackend,
      engineMode: configuration.engineMode,
      grammar: {
        source:
          configuration.surface === 'runtime-bundle'
            ? 'engine-runtime-bundle'
            : 'osd-compiled',
        hash: (evidence.detectorTarget && evidence.detectorTarget.grammarHash) || null,
      },
    };
  });

  const matrix = [];
  const cases = [];
  const findings = [];

  for (const ruleId of ACTIVE_RULE_IDS) {
    const { spec } = contracts.get(ruleId);
    for (const configuration of plan.configurations) {
      const expected = expectedScope(spec, configuration);
      if (!expected.applicable) {
        matrix.push({
          ruleId,
          configurationId: configuration.id,
          status: 'n/a',
          expected,
          actual: null,
        });
        continue;
      }

      const evidence = evidenceByConfiguration.get(configuration.id);
      const expectation = selectExpectation(spec, configuration);
      if (!expectation) {
        const reason = {
          code: 'missing-contract-expectation',
          message:
            `No unique expectation covers ${ruleId} on ${configuration.engineVersion} ` +
            `(${configuration.engineMode}).`,
        };
        const cell = {
          ruleId,
          configurationId: configuration.id,
          status: 'inconclusive',
          expected,
          actual: {
            detector: { outcome: 'missing' },
            backend: { outcome: 'missing' },
          },
          reason,
        };
        matrix.push(cell);
        findings.push({
          ruleId,
          configurationId: configuration.id,
          configurationLabel: configuration.label,
          blocking: true,
          reason,
          remediation: {
            action: 'fix-test-leg',
            scope: 'contract',
            detail: 'Add or correct the reviewed expectation, then rerun compatibility validation.',
          },
          reproduction: {
            detectorCommand: evidence.detectorCommand,
            backendCommand: evidence.backendCommand,
          },
        });
        continue;
      }

      const cellCases = [];
      for (const [queryName, queryDefinition] of Object.entries(spec.queries || {})) {
        const key = `${ruleId}::${queryName}`;
        const detectorRow = evidence.detectorRows.get(key);
        const backendRow = evidence.backendRows.get(key);
        let expectedEvidence;
        try {
          expectedEvidence = expectedCase(spec, expectation.queries[queryName]);
        } catch (error) {
          fatal(`invalid ${ruleId}::${queryName} expectation: ${error.message}`);
        }
        const actual = {
          detector: detectorActual(detectorRow, evidence),
          backend: backendActual(backendRow, evidence),
        };
        const differences = [
          ...compareDetector(expectedEvidence.detector, actual.detector, detectorRow || {}),
          ...compareBackend(expectedEvidence.backend, actual.backend, backendRow || {}),
        ];
        const entry = {
          key: `${configuration.id}::${ruleId}::${queryName}`,
          ruleId,
          configurationId: configuration.id,
          queryName,
          role: queryDefinition.role || 'trigger',
          query: String(queryDefinition.query || '').split('{{index}}').join(spec.index),
          expected: {
            detector: expectedEvidence.detector,
            backend: expectedEvidence.backend,
          },
          actual,
          differences,
        };
        cases.push(entry);
        cellCases.push(entry);
      }

      const actual = {
        detector: aggregateActual(cellCases, 'detector'),
        backend: aggregateActual(cellCases, 'backend'),
      };
      const incomplete =
        evidence.errors.length > 0 ||
        cellCases.some(
          (entry) =>
            entry.actual.detector.outcome !== 'observed' ||
            entry.actual.backend.outcome !== 'observed'
        );
      if (incomplete) {
        const reason = reasonForIncomplete(cellCases, evidence);
        matrix.push({
          ruleId,
          configurationId: configuration.id,
          status: 'inconclusive',
          expected,
          actual,
          reason,
          caseKeys: cellCases.map((entry) => entry.key),
        });
        findings.push({
          ruleId,
          configurationId: configuration.id,
          configurationLabel: configuration.label,
          blocking: true,
          reason,
          evidence: { caseKeys: cellCases.map((entry) => entry.key) },
          remediation: {
            action: 'fix-test-leg',
            scope: 'test-leg',
            detail: 'Fix or rerun this test leg before recommending a product change.',
          },
          reproduction: {
            detectorCommand: evidence.detectorCommand,
            backendCommand: evidence.backendCommand,
          },
        });
        continue;
      }

      const classification = classifyCell(cellCases);
      if (classification.classification) {
        matrix.push({
          ruleId,
          configurationId: configuration.id,
          status: 'drift',
          expected,
          actual,
          classification: classification.classification,
          triggerSummary: classification.triggerSummary,
          caseKeys: cellCases.map((entry) => entry.key),
        });
        findings.push({
          ruleId,
          configurationId: configuration.id,
          configurationLabel: configuration.label,
          classification: classification.classification,
          blocking: true,
          evidence: {
            caseKeys: cellCases.map((entry) => entry.key),
            triggerSummary: classification.triggerSummary,
          },
          remediation: remediation(classification.classification),
          reproduction: {
            detectorCommand: evidence.detectorCommand,
            backendCommand: evidence.backendCommand,
          },
        });
      } else {
        matrix.push({
          ruleId,
          configurationId: configuration.id,
          status: 'compatible',
          expected,
          actual,
          caseKeys: cellCases.map((entry) => entry.key),
        });
      }
    }
  }

  const compatible = matrix.filter((entry) => entry.status === 'compatible').length;
  const notApplicable = matrix.filter((entry) => entry.status === 'n/a').length;
  const drift = matrix.filter((entry) => entry.status === 'drift').length;
  const inconclusive = matrix.filter((entry) => entry.status === 'inconclusive').length;
  const cellCount = matrix.length;
  if (
    cellCount !== ACTIVE_RULE_IDS.length * configurations.length ||
    compatible + notApplicable + drift + inconclusive !== cellCount
  ) {
    fatal('internal matrix accounting invariant failed');
  }

  const report = {
    schemaVersion: 3,
    candidate: {
      sqlSha: plan.sqlSha,
      osd: {
        repository: plan.osd.repository,
        ref: plan.osd.ref,
        sha: args.osdSha,
      },
    },
    inventory: {
      ruleCount: ACTIVE_RULE_IDS.length,
      ruleIds: ACTIVE_RULE_IDS,
    },
    configurations,
    matrix,
    cases,
    findings,
    result: {
      status: drift + inconclusive === 0 ? 'pass' : 'fail',
      cellCount,
      compatible,
      notApplicable,
      drift,
      inconclusive,
      exitCode: drift + inconclusive === 0 ? 0 : 1,
    },
  };

  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderMarkdown(report, contracts);
  process.stdout.write(`${markdown}\n`);
  if (args.summary) fs.appendFileSync(args.summary, `${markdown}\n`);
  if (report.result.exitCode !== 0) {
    process.stderr.write(
      `Rule compatibility validation failed after writing the complete report: ` +
        `${drift} drift, ${inconclusive} inconclusive.\n`
    );
    process.exitCode = report.result.exitCode;
  }
}

main();
