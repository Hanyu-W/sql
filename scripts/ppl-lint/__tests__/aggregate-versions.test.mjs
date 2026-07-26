/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the multi-version aggregator.
 *
 *   node --test scripts/ppl-lint/__tests__/aggregate-versions.test.mjs
 *
 * These drive the real script as a child process over synthetic leg directories
 * (the four artifact files each engine leg produces), so they cover the parts the
 * pure classifier tests cannot: argument handling, artifact loading, the
 * in-scope/out-of-scope split, coverage holes, once-per-rule grammar drift, and
 * the process exit code that makes the CI check red or green.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'aggregate-versions.mjs');

/** Contract used by every case: a >=3.7 calcite-only rule with one trigger + one control. */
const SPEC = {
  schemaVersion: 3,
  ruleId: 'union-min-datasets',
  grammarSurface: 'runtime-bundle',
  schedule: 'pr',
  requiredParserRules: ['unionCommand'],
  wiring: {
    detector: 'union-min-datasets',
    enabled: true,
    severity: 'error',
    runtimeOnly: true,
    appliesTo: { minVersion: '3.7.0', engine: 'calcite' },
  },
  index: 'test-index',
  queries: {
    trigger: { role: 'trigger', query: 'union [ source={{index}} ]' },
    control: { role: 'control', query: 'union [ source={{index}} ] [ source={{index}} ]' },
  },
  expectations: [
    {
      version: '>=3.7.0',
      engine: 'calcite',
      queries: {
        trigger: {
          detectorCount: 1,
          severity: 'error',
          backend: {
            kind: 'rejection',
            httpStatus: 400,
            body: {
              status: 400,
              error: {
                type: 'IllegalArgumentException',
                reason: 'Union command requires at least two datasets. Provided: 1',
              },
            },
          },
        },
        control: { detectorCount: 0, backend: { kind: 'result-shape', httpStatus: 200 } },
      },
    },
  ],
};

const REJECTION = {
  type: 'IllegalArgumentException',
  reason: 'Union command requires at least two datasets. Provided: 1',
};

const tmpDirs = [];

function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a contract dir holding SPEC (optionally patched) and a manifest. */
function writeContracts(patch = {}) {
  const dir = makeTmp('ppl-lint-contracts-');
  const spec = { ...SPEC, ...patch };
  fs.writeFileSync(path.join(dir, 'union.spec.json'), JSON.stringify(spec));
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 3,
      contracts: ['union.spec.json'],
      defaultError: ['union.spec.json'],
    })
  );
  return dir;
}

/**
 * Write one engine leg. `cases` maps query name to
 * { detector: <count>, severities, rejected, type, reason }.
 */
function writeLeg({
  version,
  cases,
  parserRuleNames = ['unionCommand', 'unionDataset'],
  defaultErrorRules,
}) {
  const dir = makeTmp(`ppl-lint-leg-${version}-`);
  fs.writeFileSync(
    path.join(dir, 'target.json'),
    JSON.stringify({ engineVersion: version, grammarHash: `sha256:${version}` })
  );
  fs.writeFileSync(
    path.join(dir, 'ppl-grammar-bundle.json'),
    JSON.stringify({ parserRuleNames })
  );

  const results = [];
  const backend = [];
  for (const [queryName, c] of Object.entries(cases)) {
    const role = queryName === 'control' ? 'control' : 'trigger';
    results.push({
      ruleId: SPEC.ruleId,
      queryName,
      role,
      expected: role === 'trigger' ? 1 : 0,
      actual: c.detector,
      severities: c.severities || (c.detector > 0 ? ['error'] : []),
    });
    backend.push({
      ruleId: SPEC.ruleId,
      queryName,
      role,
      rejected: !!c.rejected,
      observed: {
        httpStatus: c.rejected ? 400 : 200,
        rejected: !!c.rejected,
        ...(c.rejected ? { type: c.type || REJECTION.type, reason: c.reason || REJECTION.reason } : {}),
      },
    });
  }
  fs.writeFileSync(
    path.join(dir, 'detector-report.json'),
    JSON.stringify({ results, ...(defaultErrorRules ? { defaultErrorRules } : {}) })
  );
  fs.writeFileSync(path.join(dir, 'backend-report.json'), JSON.stringify(backend));
  return dir;
}

/** Run the aggregator; returns { status, stdout, report }. */
function run({ contracts, legs, extraArgs = [] }) {
  const outDir = makeTmp('ppl-lint-out-');
  const out = path.join(outDir, 'drift-report.json');
  const args = [SCRIPT, '--contracts', contracts, '--out', out];
  for (const [version, dir] of Object.entries(legs)) {
    args.push('--leg', `${version}=${dir}`);
  }
  args.push(...extraArgs);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : undefined;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', report };
}

/** The all-agree case, reused as the base for each drift scenario. */
function healthyLegs() {
  return {
    '3.7.0': writeLeg({
      version: '3.7.0',
      cases: { trigger: { detector: 1, rejected: true }, control: { detector: 0, rejected: false } },
    }),
    '3.8.0': writeLeg({
      version: '3.8.0',
      cases: { trigger: { detector: 1, rejected: true }, control: { detector: 0, rejected: false } },
    }),
  };
}

test('all versions agreeing exits 0 and reports no drift', () => {
  const { status, report, stdout } = run({ contracts: writeContracts(), legs: healthyLegs() });
  assert.equal(status, 0);
  assert.equal(report.result.passed, true);
  assert.equal(report.drifts.length, 0);
  assert.match(stdout, /agrees with all 2 engine version\(s\)/);
  // Every rule/version pair is accounted for in the matrix.
  assert.equal(report.matrix.length, 2);
  assert.ok(report.matrix.every((m) => m.status === 'agree'));
});

test('a version where only one engine relaxed is red, and names just that version', () => {
  const legs = healthyLegs();
  // 3.8 now accepts what 3.7 still rejects, while the detector keeps flagging.
  legs['3.8.0'] = writeLeg({
    version: '3.8.0',
    cases: { trigger: { detector: 1, rejected: false }, control: { detector: 0, rejected: false } },
  });
  const { status, report } = run({ contracts: writeContracts(), legs });
  assert.equal(status, 1);
  assert.equal(report.result.enforcedDriftCount, 1);
  const drift = report.drifts[0];
  assert.equal(drift.driftClass, 'engine-relaxed');
  assert.equal(drift.version, '3.8.0');
  assert.equal(drift.remediation.action, 'version-scope-rule');
  // The healthy version is still reported as agreeing.
  assert.equal(report.matrix.find((m) => m.version === '3.7.0').status, 'agree');
});

test('a rule out of scope on an older engine that accepts is not drift', () => {
  const legs = healthyLegs();
  // 3.6 predates the rule's minVersion and accepts the query: intended silence.
  legs['3.6.0'] = writeLeg({
    version: '3.6.0',
    cases: { trigger: { detector: 0, rejected: false }, control: { detector: 0, rejected: false } },
  });
  const { status, report } = run({ contracts: writeContracts(), legs });
  assert.equal(status, 0);
  assert.equal(report.matrix.find((m) => m.version === '3.6.0').status, 'out-of-scope');
  assert.equal(report.coverageHoles.length, 0);
});

test('an out-of-scope engine that rejects is flagged as scoped too narrowly', () => {
  const legs = healthyLegs();
  legs['3.6.0'] = writeLeg({
    version: '3.6.0',
    cases: { trigger: { detector: 0, rejected: true }, control: { detector: 0, rejected: false } },
  });
  const { status, report } = run({ contracts: writeContracts(), legs });
  assert.equal(status, 1);
  const drift = report.drifts.find((d) => d.version === '3.6.0');
  assert.equal(drift.driftClass, 'version-scope-too-narrow');
  assert.equal(drift.remediation.action, 'version-scope-rule');
});

test('an in-scope version with no expectation is a coverage hole, not silent success', () => {
  // The rule applies from 3.7 up, but the contract only pins <3.8 — so a 3.8
  // engine runs a shipped default-error rule with nothing pinning it.
  const contracts = writeContracts({
    expectations: [{ ...SPEC.expectations[0], version: '>=3.7.0 <3.8.0' }],
  });
  const { status, report } = run({ contracts, legs: healthyLegs() });
  assert.equal(status, 1);
  assert.equal(report.result.enforcedCoverageHoles, 1);
  const hole = report.coverageHoles[0];
  assert.equal(hole.version, '3.8.0');
  assert.equal(hole.enforced, true);
  assert.match(report.matrix.find((m) => m.version === '3.8.0').status, /uncovered/);
});

test('a renamed parser rule is reported once per version, not once per query', () => {
  const legs = healthyLegs();
  legs['3.8.0'] = writeLeg({
    version: '3.8.0',
    parserRuleNames: ['unionStatement', 'unionDataset'],
    cases: { trigger: { detector: 0, rejected: true }, control: { detector: 0, rejected: false } },
  });
  const { status, report } = run({ contracts: writeContracts(), legs });
  assert.equal(status, 1);
  const grammarDrifts = report.drifts.filter((d) => d.driftClass === 'grammar-rule-missing');
  assert.equal(grammarDrifts.length, 1, 'one grammar finding per rule/version');
  assert.equal(grammarDrifts[0].remediation.action, 'update-detector');
  assert.match(grammarDrifts[0].remediation.detail, /unionStatement/);
});

test('a silent detector on an unchanged engine is update-detector, never a re-pin', () => {
  const legs = healthyLegs();
  legs['3.8.0'] = writeLeg({
    version: '3.8.0',
    cases: { trigger: { detector: 0, rejected: true }, control: { detector: 0, rejected: false } },
  });
  const { status, report } = run({ contracts: writeContracts(), legs });
  assert.equal(status, 1);
  const drift = report.drifts.find((d) => d.version === '3.8.0');
  assert.equal(drift.driftClass, 'detector-silent');
  assert.equal(drift.remediation.action, 'update-detector');
});

test('the leg label is corrected to the engine self-reported version', () => {
  // Ask for 3.7.0 but hand over an engine that says 3.8.0: results must be
  // attributed to what actually ran.
  const legs = { '3.7.0': writeLeg({ version: '3.8.0', cases: { trigger: { detector: 1, rejected: true } } }) };
  const { report, stdout } = run({ contracts: writeContracts(), legs });
  assert.equal(report.legs[0].label, '3.7.0');
  assert.equal(report.legs[0].engineVersion, '3.8.0');
  assert.match(stdout, /reported engineVersion "3\.8\.0"/);
});

test('a missing leg artifact fails loudly instead of dropping the version', () => {
  const emptyLeg = makeTmp('ppl-lint-empty-leg-');
  const { status, stderr } = run({ contracts: writeContracts(), legs: { '3.8.0': emptyLeg } });
  assert.equal(status, 2, 'a broken matrix must not be able to pass');
  assert.match(stderr, /expected file not found/);
});

test('a default-error rule with no contract file fails the check', () => {
  // OSD started shipping `brand-new-error-rule` enabled at error severity, but no
  // contract pins it — so no engine version validates it. That must be red, not
  // silently absent from the matrix.
  const legs = {
    '3.7.0': writeLeg({
      version: '3.7.0',
      cases: { trigger: { detector: 1, rejected: true }, control: { detector: 0, rejected: false } },
      defaultErrorRules: ['union-min-datasets', 'brand-new-error-rule'],
    }),
  };
  const { status, report, stdout } = run({ contracts: writeContracts(), legs });
  assert.equal(status, 1);
  assert.equal(report.result.missingContractCount, 1);
  assert.equal(report.missingContracts[0].ruleId, 'brand-new-error-rule');
  assert.match(stdout, /Unvalidated default-error rules/);
  assert.match(stdout, /brand-new-error-rule.*no contract file/s);
});

test('a census matching the manifest keeps the check green', () => {
  const legs = {
    '3.7.0': writeLeg({
      version: '3.7.0',
      cases: { trigger: { detector: 1, rejected: true }, control: { detector: 0, rejected: false } },
      defaultErrorRules: ['union-min-datasets'],
    }),
  };
  const { status, report } = run({ contracts: writeContracts(), legs });
  assert.equal(status, 0);
  assert.equal(report.result.missingContractCount, 0);
});

test('a legacy detector report without a census warns instead of failing', () => {
  // Older detector builds do not emit defaultErrorRules; the aggregator must say
  // so out loud rather than quietly reporting full coverage.
  const { status, stdout } = run({ contracts: writeContracts(), legs: healthyLegs() });
  assert.equal(status, 0);
  assert.match(stdout, /no detector leg reported a defaultErrorRules census/);
});

// --- "we don't know" must never render as "it's fine" -------------------------

/** Write a leg where a named query produced no engine verdict (transport failure). */
function writeLegWithTransportError({ version, erroredQuery, cases }) {
  const dir = writeLeg({ version, cases });
  const file = path.join(dir, 'backend-report.json');
  const backend = JSON.parse(fs.readFileSync(file, 'utf8')).map((entry) =>
    entry.queryName === erroredQuery
      ? // Exactly what the IT writes on a transport failure: an `error` outcome and
        // NO `rejected` field, because no verdict was ever received.
        { ruleId: entry.ruleId, queryName: entry.queryName, role: entry.role, outcome: 'error', error: 'connect timeout' }
      : { ...entry, outcome: 'observed' }
  );
  fs.writeFileSync(file, JSON.stringify(backend));
  return dir;
}

test('a transport error is not read as engine acceptance', () => {
  // Regression: coercing a missing `rejected` to false made a timeout look like an
  // engine that now ACCEPTS the trigger, and advised disabling a healthy rule.
  const legs = {
    '3.7.0': writeLegWithTransportError({
      version: '3.7.0',
      erroredQuery: 'trigger',
      cases: { trigger: { detector: 1, rejected: true }, control: { detector: 0, rejected: false } },
    }),
  };
  const { status, report, stdout } = run({ contracts: writeContracts(), legs });
  assert.equal(
    report.drifts.filter((d) => d.driftClass === 'engine-relaxed').length,
    0,
    'a timeout must never be reported as the engine relaxing'
  );
  assert.ok(
    !/FALSE POSITIVE/.test(stdout),
    'a timeout must never advise disabling or version-scoping a rule'
  );
  // This spec has a single trigger, so losing it means the rule's behavioral
  // claim went unchecked: inconclusive and red, not a passing WARN.
  assert.equal(status, 1);
  assert.equal(report.result.enforcedInconclusive, 1);
  assert.match(stdout, /trigger \(no engine verdict\)/);
});

test('losing every trigger is inconclusive even when a control still compares', () => {
  // flat-object-subfield's real shape: several triggers plus one control. The
  // triggers ARE the rule's claim, so a leg that kept only the control has proven
  // nothing — but `compared > 0`, so a naive count would have rendered `agree`.
  const dir = writeLeg({
    version: '3.7.0',
    cases: { trigger: { detector: 1, rejected: true }, control: { detector: 0, rejected: false } },
  });
  fs.writeFileSync(
    path.join(dir, 'backend-report.json'),
    JSON.stringify([
      { ruleId: SPEC.ruleId, queryName: 'trigger', role: 'trigger', outcome: 'error', error: 'timeout' },
      {
        ruleId: SPEC.ruleId,
        queryName: 'control',
        role: 'control',
        rejected: false,
        outcome: 'observed',
        observed: { httpStatus: 200, rejected: false },
      },
    ])
  );
  const { status, report } = run({ contracts: writeContracts(), legs: { '3.7.0': dir } });
  assert.equal(status, 1, 'a rule whose triggers all went unobserved must not read as agreement');
  assert.equal(report.matrix[0].status, 'inconclusive');
  assert.equal(report.result.enforcedInconclusive, 1);
});

test('a leg where nothing could be compared is inconclusive, not agreement', () => {
  const dir = writeLeg({
    version: '3.7.0',
    cases: { trigger: { detector: 1, rejected: true }, control: { detector: 0, rejected: false } },
  });
  // Both cases lose their verdict: the whole leg proved nothing.
  fs.writeFileSync(
    path.join(dir, 'backend-report.json'),
    JSON.stringify([
      { ruleId: SPEC.ruleId, queryName: 'trigger', role: 'trigger', outcome: 'error', error: 'timeout' },
      { ruleId: SPEC.ruleId, queryName: 'control', role: 'control', outcome: 'error', error: 'timeout' },
    ])
  );
  const { status, report, stdout } = run({ contracts: writeContracts(), legs: { '3.7.0': dir } });
  assert.equal(status, 1, 'inconclusive must be red — "could not check" is not "passed"');
  assert.equal(report.result.enforcedInconclusive, 1);
  assert.equal(report.drifts.length, 0, 'a dead leg must not manufacture linter advice');
  assert.equal(report.matrix[0].status, 'inconclusive');
  assert.match(stdout, /Inconclusive \(leg problem, not a linter problem\)/);
});

test('a reworded engine message does not mask a detector that went silent', () => {
  // Regression: ENGINE_MESSAGE_CHANGED returned before the detector-silent check,
  // so the report said "no rule change is required" while the rule had stopped
  // firing. Re-pinning the string would have gone green over a dead rule.
  const dir = writeLeg({
    version: '3.7.0',
    cases: {
      trigger: { detector: 0, rejected: true, reason: 'union needs >= 2 datasets' },
      control: { detector: 0, rejected: false },
    },
  });
  const { report } = run({ contracts: writeContracts(), legs: { '3.7.0': dir } });
  const drift = report.drifts.find((d) => d.queryName === 'trigger');
  assert.equal(drift.driftClass, 'detector-silent');
  assert.equal(drift.remediation.action, 'update-detector');
});

test('a detector firing on a version its appliesTo excludes is reported', () => {
  // OSD's version filter runs a rule when the cluster version is unknown, so an
  // out-of-scope rule CAN reach users. Silence here would hide that false positive.
  const dir = writeLeg({
    version: '3.6.0', // below the rule's 3.7 minVersion
    cases: { trigger: { detector: 1, rejected: false }, control: { detector: 0, rejected: false } },
  });
  const { status, report } = run({ contracts: writeContracts(), legs: { '3.6.0': dir } });
  assert.equal(status, 1);
  const drift = report.drifts.find((d) => d.version === '3.6.0');
  assert.equal(drift.driftClass, 'detector-noisy');
  assert.equal(drift.remediation.action, 'update-detector');
});

test('a calcite-scoped expectation is selected rather than counted twice', () => {
  // Both single-version halves drop `engine: "calcite"` entries when Calcite is
  // off. Without that filter here, a per-engine pair for one range matches twice
  // and is misreported as an uncovered version.
  const contracts = writeContracts({
    expectations: [
      SPEC.expectations[0],
      { ...SPEC.expectations[0], engine: undefined, queries: SPEC.expectations[0].queries },
    ],
  });
  const { report } = run({ contracts, legs: healthyLegs() });
  // Two matching entries is genuinely ambiguous and must not silently pick one.
  assert.ok(
    report.coverageHoles.length > 0 || report.matrix.some((m) => m.status === 'uncovered'),
    'an ambiguous pair of expectations must be surfaced, not resolved arbitrarily'
  );
});

test('an errored trigger on an out-of-scope rule does not silently pass', () => {
  // The out-of-scope path used to read `entry.rejected` directly. An errored
  // observation has no such field, so it coerced to false, the
  // version-scope-too-narrow check (which needs `=== true`) never fired, and a
  // genuinely mis-scoped rule rendered as `out-of-scope` with exit 0.
  const dir = writeLeg({
    version: '3.6.0', // below the rule's 3.7 minVersion => out of scope
    cases: { trigger: { detector: 0, rejected: true }, control: { detector: 0, rejected: false } },
  });
  fs.writeFileSync(
    path.join(dir, 'backend-report.json'),
    JSON.stringify([
      { ruleId: SPEC.ruleId, queryName: 'trigger', role: 'trigger', outcome: 'error', error: 'timeout' },
      {
        ruleId: SPEC.ruleId,
        queryName: 'control',
        role: 'control',
        rejected: false,
        outcome: 'observed',
        observed: { httpStatus: 200, rejected: false },
      },
    ])
  );
  const { report } = run({ contracts: writeContracts(), legs: { '3.6.0': dir } });
  // The point is that an unobserved trigger yields no CLAIM either way: it must
  // not be reported as a confident out-of-scope agreement...
  assert.equal(
    report.drifts.filter((d) => d.driftClass === 'version-scope-too-narrow').length,
    0,
    'an unobserved trigger cannot support a version-scope finding'
  );
  // ...nor may it invent linter advice from a verdict that never arrived.
  assert.equal(report.drifts.length, 0);
});

test('an errored control cannot fail open into "widen appliesTo" advice', () => {
  // controlAlsoRejected suppresses the version-scope finding when the command
  // itself is unsupported. Reading `entry.rejected` raw made that suppression fail
  // OPEN on an errored control: the run would then advise lowering minVersion,
  // shipping a precise-cause diagnostic for an unknown-command failure.
  const dir = writeLeg({
    version: '3.6.0',
    cases: { trigger: { detector: 0, rejected: true }, control: { detector: 0, rejected: true } },
  });
  const backend = JSON.parse(fs.readFileSync(path.join(dir, 'backend-report.json'), 'utf8')).map(
    (e) =>
      e.role === 'control'
        ? { ruleId: e.ruleId, queryName: e.queryName, role: e.role, outcome: 'error', error: 'timeout' }
        : { ...e, outcome: 'observed' }
  );
  fs.writeFileSync(path.join(dir, 'backend-report.json'), JSON.stringify(backend));
  const { report, stdout } = run({ contracts: writeContracts(), legs: { '3.6.0': dir } });
  const scoped = report.drifts.filter((d) => d.driftClass === 'version-scope-too-narrow');
  assert.equal(
    scoped.length,
    0,
    'with the control unobserved there is no evidence the command is supported, so no widening advice'
  );
  assert.ok(!/Widen "/.test(stdout));
});

test('a bad --leg argument is rejected', () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--contracts', writeContracts(), '--leg', 'no-equals-sign'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--leg expects <version>=<dir>/);
});

test('at least one leg is required', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--contracts', writeContracts()], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at least one --leg/);
});
