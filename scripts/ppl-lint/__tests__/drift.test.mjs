/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the multi-version drift classifier.
 *
 * Run with plain Node (no Gradle, no cluster, no OSD checkout):
 *
 *   node --test scripts/ppl-lint/__tests__/drift.test.mjs
 *
 * The classifier is the part of the multi-version contract that decides what an
 * engineer is told to do, so every drift class and every remediation branch is
 * pinned here. Observations are hand-written rather than gathered from a
 * cluster; the live-engine plumbing is exercised by the CI workflow itself.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRIFT_CLASSES,
  REMEDIATIONS,
  classifyDrift,
  formatDriftReport,
  parseVersion,
  suggestParserRules,
  versionInAppliesTo,
} from '../drift.mjs';

/** A trigger case that agrees on all three sides, used as the mutation base. */
function agreeingTrigger(overrides = {}) {
  return {
    ruleId: 'union-min-datasets',
    version: '3.7.0',
    queryName: 'union-single-dataset',
    role: 'trigger',
    query: 'union [ source=t ]',
    expected: { detectorCount: 1, severity: 'error', backendKind: 'rejection' },
    observed: {
      detectorCount: 1,
      severities: ['error'],
      backendRejected: true,
      backendType: 'IllegalArgumentException',
      backendReason: 'Union command requires at least two datasets. Provided: 1',
    },
    wiring: { appliesTo: { minVersion: '3.7.0', engine: 'calcite' }, runtimeOnly: true },
    ...overrides,
  };
}

/** A control case that agrees on all three sides. */
function agreeingControl(overrides = {}) {
  return {
    ruleId: 'union-min-datasets',
    version: '3.7.0',
    queryName: 'union-two-datasets-control',
    role: 'control',
    query: 'union [ source=t ] [ source=t ]',
    expected: { detectorCount: 0, backendKind: 'result-shape' },
    observed: { detectorCount: 0, severities: [], backendRejected: false },
    wiring: { appliesTo: { minVersion: '3.7.0', engine: 'calcite' } },
    ...overrides,
  };
}

// --- the quiet path -----------------------------------------------------------

test('agreement produces no drift', () => {
  assert.equal(classifyDrift(agreeingTrigger()), null);
  assert.equal(classifyDrift(agreeingControl()), null);
});

test('a rule out of version scope on an engine that also accepts is silent', () => {
  // union-min-datasets does not apply below 3.7, and a 3.6 engine that accepts
  // the query is not drift — it is the reason the version window exists.
  const drift = classifyDrift(
    agreeingTrigger({
      version: '3.6.0',
      observed: { detectorCount: 0, severities: [], backendRejected: false },
    })
  );
  assert.equal(drift, null);
});

// --- grammar moved ------------------------------------------------------------

test('a missing parser rule is reported as update-detector, not as a silent detector', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      requiredParserRules: ['unionCommand', 'unionDataset'],
      parserRuleNames: ['unionStatement', 'unionDataset', 'pplCommands'],
      observed: { detectorCount: 0, severities: [], backendRejected: true },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.GRAMMAR_RULE_MISSING);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_DETECTOR);
  assert.match(drift.remediation.target, /union_min_datasets\.ts$/);
  // The likely rename is named so the engineer does not diff 259 rule names.
  assert.match(drift.remediation.detail, /unionStatement/);
  assert.match(drift.evidence, /no parser rule/);
});

test('a contract can pin a detector path that breaks the naming convention', () => {
  // unsupported-window-function-in-eventstats lives in
  // unsupported_window_function.ts, so the derived name would not exist.
  const drift = classifyDrift(
    agreeingTrigger({
      ruleId: 'unsupported-window-function-in-eventstats',
      detectorPath: 'packages/osd-monaco/src/ppl/lint/rules/unsupported_window_function.ts',
      wiring: { appliesTo: {} },
      observed: {
        detectorCount: 0,
        severities: [],
        backendRejected: true,
        backendType: 'CalciteUnsupportedException',
        backendReason: 'Unexpected window function: rank',
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.DETECTOR_SILENT);
  assert.equal(
    drift.remediation.target,
    'packages/osd-monaco/src/ppl/lint/rules/unsupported_window_function.ts'
  );
});

test('grammar-rule check is skipped when the contract declares no required rules', () => {
  const drift = classifyDrift(
    agreeingTrigger({ parserRuleNames: ['somethingElse'], requiredParserRules: undefined })
  );
  assert.equal(drift, null);
});

// --- engine behavior flips ----------------------------------------------------

test('engine relaxation with a still-firing detector demands version scoping', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      version: '3.9.0',
      observed: {
        detectorCount: 1,
        severities: ['error'],
        backendRejected: false,
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.ENGINE_RELAXED);
  assert.equal(drift.remediation.action, REMEDIATIONS.VERSION_SCOPE_RULE);
  // Both escape hatches are spelled out: bound the version, or disable outright.
  assert.match(drift.remediation.detail, /maxVersion/);
  assert.match(drift.remediation.detail, /"enabled": false/);
  assert.match(drift.evidence, /now ACCEPTS/);
});

test('engine relaxation with an already-silent detector only needs a re-pin', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      version: '3.9.0',
      observed: { detectorCount: 0, severities: [], backendRejected: false },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.ENGINE_RELAXED);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_CONTRACT);
  assert.match(drift.remediation.detail, /no linter change/);
});

test('engine tightening on a control with a silent detector is a false negative', () => {
  const drift = classifyDrift(
    agreeingControl({
      observed: {
        detectorCount: 0,
        severities: [],
        backendRejected: true,
        backendType: 'IllegalArgumentException',
        backendReason: 'Union command now requires matching schemas.',
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.ENGINE_TIGHTENED);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_DETECTOR);
  assert.match(drift.remediation.detail, /false NEGATIVE/);
  assert.match(drift.evidence, /matching schemas/);
});

test('engine tightening the detector already catches only needs a re-pin', () => {
  const drift = classifyDrift(
    agreeingControl({
      observed: {
        detectorCount: 1,
        severities: ['error'],
        backendRejected: true,
        backendType: 'IllegalArgumentException',
        backendReason: 'nope',
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.ENGINE_TIGHTENED);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_CONTRACT);
});

// --- wording drift ------------------------------------------------------------

test('a reworded rejection is update-contract and points at quoted copy', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      observed: {
        detectorCount: 1,
        severities: ['error'],
        backendRejected: true,
        backendType: 'IllegalArgumentException',
        backendReason: 'union requires >= 2 datasets, got 1',
      },
      expectedBackend: {
        body: {
          error: {
            type: 'IllegalArgumentException',
            reason: 'Union command requires at least two datasets. Provided: 1',
          },
        },
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.ENGINE_MESSAGE_CHANGED);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_CONTRACT);
  assert.match(drift.evidence, /error\.reason/);
  assert.match(drift.remediation.detail, /quotes the old engine wording/);
});

test('a reworded rejection does not mask a detector that stopped firing', () => {
  // Regression: this branch used to return before the detector-silent check, so a
  // simultaneous rewording + detector regression reported "the detector's verdict
  // is unaffected, no rule change is required". Re-pinning the string would have
  // turned the check green over a rule that no longer fires at all.
  const drift = classifyDrift(
    agreeingTrigger({
      observed: {
        detectorCount: 0,
        severities: [],
        backendRejected: true,
        backendType: 'IllegalArgumentException',
        backendReason: 'union requires >= 2 datasets, got 1',
      },
      expectedBackend: {
        body: {
          error: {
            type: 'IllegalArgumentException',
            reason: 'Union command requires at least two datasets. Provided: 1',
          },
        },
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.DETECTOR_SILENT);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_DETECTOR);
});

test('a detector firing where appliesTo excludes the version is a false positive', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      version: '3.6.0', // below the rule's 3.7 minVersion
      observed: { detectorCount: 1, severities: ['error'], backendRejected: false },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.DETECTOR_NOISY);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_DETECTOR);
  // The version filter's unknown-version behavior is why this reaches users.
  assert.match(drift.remediation.detail, /version is unknown/);
});

test('an unobserved engine verdict is never treated as acceptance', () => {
  // backendRejected: undefined means "we never got an answer". It must not select
  // the engine-relaxed branch, which would advise disabling a healthy rule.
  const drift = classifyDrift(
    agreeingTrigger({
      observed: { detectorCount: 1, severities: ['error'], backendRejected: undefined },
    })
  );
  assert.equal(drift, null);
});

test('a changed exception type is reported even when the reason is unchanged', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      observed: {
        detectorCount: 1,
        severities: ['error'],
        backendRejected: true,
        backendType: 'SyntaxCheckException',
        backendReason: 'Union command requires at least two datasets. Provided: 1',
      },
      expectedBackend: {
        body: {
          error: {
            type: 'IllegalArgumentException',
            reason: 'Union command requires at least two datasets. Provided: 1',
          },
        },
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.ENGINE_MESSAGE_CHANGED);
  assert.match(drift.evidence, /error\.type/);
});

// --- detector-only disagreement ----------------------------------------------

test('a silent detector on an unchanged engine names the three silent-failure causes', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      observed: {
        detectorCount: 0,
        severities: [],
        backendRejected: true,
        backendType: 'IllegalArgumentException',
        backendReason: 'Union command requires at least two datasets. Provided: 1',
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.DETECTOR_SILENT);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_DETECTOR);
  assert.match(drift.remediation.detail, /runtimeOnly/);
  assert.match(drift.remediation.detail, /typeMap/);
  // Guard the anti-vacuous instruction: never silence the contract instead.
  assert.match(drift.remediation.detail, /Do NOT re-pin/);
});

test('a noisy detector the engine disagrees with is a false positive', () => {
  const drift = classifyDrift(
    agreeingControl({
      observed: { detectorCount: 2, severities: ['error', 'error'], backendRejected: false },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.DETECTOR_NOISY);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_DETECTOR);
  assert.match(drift.remediation.detail, /false positive/);
});

test('a noisy detector the engine agrees with points at the expectation', () => {
  const drift = classifyDrift(
    agreeingControl({
      observed: {
        detectorCount: 1,
        severities: ['error'],
        backendRejected: true,
        backendType: 'IllegalArgumentException',
        backendReason: 'bad query',
      },
      // Engine tightening is the more specific story when the pinned kind is not
      // a rejection, so pin the kind as rejection to isolate the noisy branch.
      expected: { detectorCount: 0, backendKind: 'rejection' },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.DETECTOR_NOISY);
  assert.equal(drift.remediation.action, REMEDIATIONS.UPDATE_CONTRACT);
});

// --- severity ----------------------------------------------------------------

test('a downgraded severity is caught even when the count is right', () => {
  const drift = classifyDrift(
    agreeingTrigger({ observed: { ...agreeingTrigger().observed, severities: ['warning'] } })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.SEVERITY_MISMATCH);
  assert.match(drift.remediation.detail, /Restore "union-min-datasets"\.severity/);
});

// --- version scoping --------------------------------------------------------

test('an unsupported command is not mistaken for a too-narrow version window', () => {
  // Real case from CI: on 3.6 the `union` command does not exist, so BOTH the
  // trigger and the control fail with SyntaxCheckException. Judging the trigger
  // alone said "widen appliesTo to 3.6" — which would ship a diagnostic claiming a
  // precise cause ("requires at least two datasets") for what is really
  // "unsupported command". A rejected control means the version window is right.
  const drift = classifyDrift(
    agreeingTrigger({
      version: '3.6.0',
      observed: {
        detectorCount: 0,
        severities: [],
        backendRejected: true,
        backendType: 'SyntaxCheckException',
        backendReason: 'Invalid Query',
      },
      controlAlsoRejected: true,
    })
  );
  assert.equal(drift, null);
});

test('an out-of-scope rule on an engine that rejects is scoped too narrowly', () => {
  const drift = classifyDrift(
    agreeingTrigger({
      version: '3.6.0', // below the rule's 3.7 minVersion
      observed: {
        detectorCount: 0,
        severities: [],
        backendRejected: true,
        backendType: 'IllegalArgumentException',
        backendReason: 'Union command requires at least two datasets. Provided: 1',
      },
    })
  );
  assert.equal(drift.driftClass, DRIFT_CLASSES.VERSION_SCOPE_TOO_NARROW);
  assert.equal(drift.remediation.action, REMEDIATIONS.VERSION_SCOPE_RULE);
  assert.match(drift.remediation.detail, /minVersion/);
});

// --- helpers -----------------------------------------------------------------

test('version parsing tolerates snapshot and short forms', () => {
  assert.deepEqual(parseVersion('3.8.0-SNAPSHOT'), [3, 8, 0]);
  assert.deepEqual(parseVersion('3.7'), [3, 7, 0]);
  assert.equal(parseVersion(''), undefined);
  assert.equal(parseVersion(undefined), undefined);
});

test('appliesTo bounds are inclusive and open-ended when absent', () => {
  assert.equal(versionInAppliesTo({ minVersion: '3.7.0' }, '3.7.0'), true);
  assert.equal(versionInAppliesTo({ minVersion: '3.7.0' }, '3.6.9'), false);
  assert.equal(versionInAppliesTo({ maxVersion: '3.8.0' }, '3.8.0'), true);
  assert.equal(versionInAppliesTo({ maxVersion: '3.8.0' }, '3.9.0'), false);
  assert.equal(versionInAppliesTo({}, '3.9.0'), true);
  // An unparseable engine version must never silently drop coverage.
  assert.equal(versionInAppliesTo({ minVersion: '3.7.0' }, 'weird-build'), true);
});

test('rename suggestions prefer containment then near spellings', () => {
  assert.deepEqual(suggestParserRules('unionCommand', ['unionCommandNew', 'zzz'], 3), [
    'unionCommandNew',
  ]);
  assert.deepEqual(suggestParserRules('rexCommand', ['regexCommand'], 3), ['regexCommand']);
  // Nothing remotely similar: say nothing rather than guess.
  assert.deepEqual(suggestParserRules('rexCommand', ['whereClause', 'sortCommand'], 3), []);
});

// --- report ------------------------------------------------------------------

test('the report groups by action, most urgent first', () => {
  const drifts = [
    classifyDrift(
      agreeingTrigger({
        observed: {
          detectorCount: 1,
          severities: ['error'],
          backendRejected: true,
          backendType: 'X',
          backendReason: 'new wording',
        },
        expectedBackend: { body: { error: { type: 'X', reason: 'old wording' } } },
      })
    ),
    classifyDrift(
      agreeingTrigger({
        version: '3.9.0',
        observed: { detectorCount: 1, severities: ['error'], backendRejected: false },
      })
    ),
  ];
  const report = formatDriftReport(drifts);
  assert.match(report, /2 finding\(s\) across 2 engine version\(s\)/);
  assert.ok(
    report.indexOf(REMEDIATIONS.VERSION_SCOPE_RULE) < report.indexOf(REMEDIATIONS.UPDATE_CONTRACT),
    'version scoping (a live false positive) must be listed before a stale-string re-pin'
  );
  assert.match(report, /QUERY: union \[ source=t \]/);
});

test('an empty drift list reports agreement', () => {
  assert.match(formatDriftReport([]), /No engine\/linter drift detected/);
});
