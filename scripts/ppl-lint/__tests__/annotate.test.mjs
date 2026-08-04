/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnnotations,
  buildRequiredAnnotations,
  contractRepoPath,
  findExpectationLine,
  findRuleIdLine,
  formatAnnotation,
} from '../annotate.mjs';

/** A contract shaped like the real ones, with two version-scoped expectations. */
const CONTRACT = `{
  "schemaVersion": 3,
  "ruleId": "invalid-capture-group-name",
  "queries": {
    "trigger": { "role": "trigger", "query": "source={{index}} | rex ..." }
  },
  "expectations": [
    {
      "version": ">=3.4.0 <3.7.0",
      "engine": "calcite",
      "queries": {}
    },
    {
      "version": ">=3.7.0",
      "engine": "calcite",
      "queries": {}
    }
  ]
}
`;

const readStub = (text) => () => text;
const REQUIRED_MANIFEST = `{
  "schemaVersion": 4,
  "contracts": [
    "invalid-capture-group-name.spec.json"
  ],
  "defaultError": [
    "invalid-capture-group-name.spec.json"
  ]
}
`;
const readRequired = (_dir, file) =>
  file === 'manifest.json'
    ? REQUIRED_MANIFEST
    : file === 'invalid-capture-group-name.spec.json'
      ? CONTRACT
      : undefined;

test('anchors on the expectation entry that drifted, not the first one', () => {
  assert.equal(findExpectationLine(CONTRACT, '>=3.7.0'), 14);
  assert.equal(findExpectationLine(CONTRACT, '>=3.4.0 <3.7.0'), 9);
});

test('an ambiguous or absent range yields no line rather than a wrong one', () => {
  // A wrong line number sends the reader to edit the wrong expectation, which is
  // worse than making them find it: prefer no anchor.
  const duplicated = CONTRACT.replace('">=3.4.0 <3.7.0"', '">=3.7.0"');
  assert.equal(findExpectationLine(duplicated, '>=3.7.0'), undefined);
  assert.equal(findExpectationLine(CONTRACT, '>=9.9.9'), undefined);
  assert.equal(findExpectationLine(undefined, '>=3.7.0'), undefined);
  assert.equal(findExpectationLine(CONTRACT, undefined), undefined);
});

test('incidental whitespace does not defeat the anchor', () => {
  const spaced = CONTRACT.replace('"version": ">=3.7.0"', '"version":    ">=3.7.0"');
  assert.equal(typeof findExpectationLine(spaced, '>=3.7.0'), 'number');
});

test('falls back to the ruleId line for rule-wide findings', () => {
  assert.equal(findRuleIdLine(CONTRACT), 3);
});

test('a drift with no expectation range still anchors at the rule', () => {
  // grammar-rule-missing is a fact about the rule on that engine, so it carries no
  // expectationRange — it must still land on the file at a usable line.
  const annotations = buildAnnotations(
    {
      drifts: [
        {
          ruleId: 'invalid-capture-group-name',
          version: '3.8.0',
          driftClass: 'grammar-rule-missing',
          enforced: true,
          contractFile: 'invalid-capture-group-name.spec.json',
          evidence: 'the candidate grammar has no parser rule(s) "rexCommand"',
          remediation: { action: 'update-detector', detail: 'Re-anchor the detector.' },
        },
      ],
    },
    { contractsDir: '/w/contracts', workspace: '/w', readFile: readStub(CONTRACT) }
  );
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].line, 3);
  assert.equal(annotations[0].level, 'error');
});

test('inconclusive findings are warnings, never errors', () => {
  // "We could not check" must not sit in the error list beside real drift, or the
  // reader edits a rule because a leg timed out.
  const annotations = buildAnnotations(
    {
      inconclusive: [
        {
          ruleId: 'field-validation',
          version: '3.6.0',
          enforced: true,
          file: 'field-validation.spec.json',
          reasons: ['unknown-field-existence (no engine verdict)'],
        },
      ],
    },
    { contractsDir: '/w/contracts', workspace: '/w', readFile: readStub(CONTRACT) }
  );
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].level, 'warning');
  assert.match(annotations[0].message, /NOT a lint finding/);
  assert.match(annotations[0].message, /Do not edit the rule/);
});

test('a non-enforced drift is a warning so it cannot be read as blocking', () => {
  const annotations = buildAnnotations(
    {
      drifts: [
        {
          ruleId: 'head-without-sort',
          version: '3.8.0',
          driftClass: 'detector-noisy',
          enforced: false,
          contractFile: 'head-without-sort.spec.json',
          evidence: 'evidence',
          remediation: { action: 'update-detector', detail: 'detail' },
        },
      ],
    },
    { contractsDir: '/w/contracts', workspace: '/w', readFile: readStub(CONTRACT) }
  );
  assert.equal(annotations[0].level, 'warning');
});

test('backend divergence annotations name both execution routes', () => {
  const annotations = buildAnnotations(
    {
      drifts: [
        {
          ruleId: 'invalid-capture-group-name',
          version: '3.8.0',
          executionBackend: 'analytics',
          executionBackends: ['standard', 'analytics'],
          driftClass: 'execution-backend-divergence',
          enforced: true,
          contractFile: 'invalid-capture-group-name.spec.json',
          evidence: 'standard rejected while analytics accepted',
          remediation: { action: 'align-execution-backends', detail: 'Align route behavior.' },
        },
      ],
    },
    { contractsDir: '/w/contracts', workspace: '/w', readFile: readStub(CONTRACT) }
  );
  assert.match(annotations[0].title, /standard vs analytics/);
  assert.match(annotations[0].title, /execution-backend-divergence/);
});

test('an unvalidated rule has no file to point at', () => {
  const annotations = buildAnnotations(
    { missingContracts: [{ ruleId: 'sort-on-eval-field', reason: 'has no contract file' }] },
    { contractsDir: '/w/contracts', workspace: '/w', readFile: readStub(CONTRACT) }
  );
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].file, undefined);
  assert.equal(annotations[0].level, 'error');
  assert.match(annotations[0].message, /manifest\.defaultError/);
});

test('paths are repo-relative so GitHub can render them inline', () => {
  // An absolute path still annotates the run, but never attaches to the diff.
  assert.equal(
    contractRepoPath('/w/integ-test/res/contracts', 'a.spec.json', '/w'),
    'integ-test/res/contracts/a.spec.json'
  );
  // No workspace (a local run): absolute is the honest answer.
  assert.equal(contractRepoPath('/w/c', 'a.spec.json', undefined), '/w/c/a.spec.json');
});

test('workflow-command metacharacters are escaped', () => {
  const line = formatAnnotation({
    level: 'error',
    file: 'a,b:c.json',
    line: 12,
    title: 'has: comma, and colon',
    message: 'first\nsecond 100% done',
  });
  // Commas/colons in properties would otherwise terminate the property list.
  assert.match(line, /file=a%2Cb%3Ac\.json/);
  assert.match(line, /title=has%3A comma%2C and colon/);
  // Newlines must survive as %0A or the annotation is truncated to one line.
  assert.match(line, /first%0Asecond 100%25 done/);
  assert.ok(line.startsWith('::error '));
});

test('an unreadable contract still produces a file-less annotation', () => {
  const annotations = buildAnnotations(
    {
      drifts: [
        {
          ruleId: 'r',
          version: '3.8.0',
          driftClass: 'detector-silent',
          enforced: true,
          contractFile: 'gone.spec.json',
          evidence: 'evidence',
          remediation: { action: 'update-detector', detail: 'detail' },
        },
      ],
    },
    { contractsDir: '/w/c', workspace: '/w', readFile: () => undefined }
  );
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].line, undefined);
  assert.equal(annotations[0].file, 'c/gone.spec.json');
});

test('required-lane failures anchor to their contract and census findings to the manifest', () => {
  const annotations = buildRequiredAnnotations(
    {
      detectorFailures: [
        '[invalid-capture-group-name/trigger] expected 1 diagnostic, got 0',
      ],
      censusProblems: ['active lint contracts do not equal enabled catalog rules'],
      censusEnforced: false,
    },
    {
      contractsDir: '/w/integ-test/resources/contracts',
      workspace: '/w',
      readFile: readRequired,
    }
  );

  assert.equal(annotations.length, 2);
  assert.deepEqual(
    {
      level: annotations[0].level,
      file: annotations[0].file,
      line: annotations[0].line,
    },
    {
      level: 'error',
      file: 'integ-test/resources/contracts/invalid-capture-group-name.spec.json',
      line: 3,
    }
  );
  assert.equal(annotations[1].level, 'warning');
  assert.equal(annotations[1].file, 'integ-test/resources/contracts/manifest.json');
  assert.match(annotations[1].message, /REPORT ONLY/);
});

test('required artifact row failures recover the rule identity for an inline annotation', () => {
  const annotations = buildRequiredAnnotations(
    {
      artifactErrors: [
        'backend row invalid-capture-group-name::trigger did not pass its oracle (outcome="fail")',
      ],
    },
    {
      contractsDir: '/w/contracts',
      workspace: '/w',
      readFile: readRequired,
    }
  );

  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].file, 'contracts/invalid-capture-group-name.spec.json');
  assert.match(annotations[0].title, /invalid-capture-group-name\/trigger/);
});

test('required job failures without a contract identity remain file-less', () => {
  const annotations = buildRequiredAnnotations(
    { backendResult: 'failure', detectorResult: 'skipped' },
    { contractsDir: '/w/contracts', workspace: '/w', readFile: readRequired }
  );
  assert.equal(annotations.length, 2);
  assert.ok(annotations.every((annotation) => annotation.file === undefined));
});

test('a clean report emits nothing', () => {
  assert.deepEqual(buildAnnotations({}, { contractsDir: '/w/c', workspace: '/w' }), []);
  assert.deepEqual(buildRequiredAnnotations({}, { contractsDir: '/w/c', workspace: '/w' }), []);
});
