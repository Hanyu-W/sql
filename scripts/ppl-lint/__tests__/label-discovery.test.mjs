/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for discovery-corpus labelling.
 *
 *   node --test scripts/ppl-lint/__tests__/label-discovery.test.mjs
 *
 * The labeler turns two observations into a role and, sometimes, a finding. Every
 * way it can produce a CONFIDENT finding from a non-observation is a way to send an
 * engineer after a bug that does not exist, so the three-state read and the
 * uninformative-rejection filter are pinned case by case.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FINDINGS,
  ROLES,
  labelQuery,
  renderMarkdown,
  uninformativeRejection,
} from '../label-discovery.mjs';

const base = { ruleId: 'invalid-capture-group-name', query: 'source=acct | rex field=m "(?<a-b>x)"' };

// --- role assignment ---------------------------------------------------------

test('a query the detector fires on is a trigger', () => {
  const row = labelQuery({ ...base, detectorCount: 1, backendRejected: true });
  assert.equal(row.role, ROLES.TRIGGER);
});

test('a query the detector ignores is a control', () => {
  const row = labelQuery({ ...base, detectorCount: 0, backendRejected: false });
  assert.equal(row.role, ROLES.CONTROL);
});

// --- the two findings --------------------------------------------------------

test('detector fires + engine accepts is a possible false positive', () => {
  const row = labelQuery({
    ...base,
    detectorCount: 2,
    severities: ['error', 'error'],
    backendRejected: false,
  });
  assert.equal(row.finding.kind, FINDINGS.FALSE_POSITIVE);
  assert.match(row.finding.evidence, /ACCEPTED this query/);
});

test('an ADVISORY rule the engine accepts is not a false positive', () => {
  // Found against a live 3.8 engine: `head-without-sort` and `rex-scan-cost` are
  // `info` rules that flag non-determinism and cost. The engine runs those queries
  // happily and will never reject them, so "accepted + flagged" is the rule working
  // as designed. Without this, every advisory trigger becomes a finding and buries
  // the real ones.
  const row = labelQuery({
    ...base,
    ruleId: 'head-without-sort',
    detectorCount: 1,
    severities: ['info'],
    backendRejected: false,
  });
  assert.equal(row.finding, null);
  assert.equal(row.advisory, true);
  // Still a trigger: it is exactly the kind of trigger the relaxation rollup counts.
  assert.equal(row.role, ROLES.TRIGGER);
});

test('a mixed-severity diagnostic is not treated as advisory', () => {
  // Only an ALL-info diagnostic is advisory. One error-severity marker means the
  // rule is asserting the engine will refuse the query, which acceptance contradicts.
  const row = labelQuery({
    ...base,
    detectorCount: 2,
    severities: ['info', 'error'],
    backendRejected: false,
  });
  assert.equal(row.finding.kind, FINDINGS.FALSE_POSITIVE);
});

test('an advisory rule the engine REJECTS is still evidence', () => {
  // The advisory carve-out applies only to the accepted direction. A silent detector
  // on a query the engine refused is unaffected by severity.
  const row = labelQuery({
    ...base,
    ruleId: 'head-without-sort',
    detectorCount: 0,
    severities: [],
    backendRejected: true,
    backendType: 'IllegalArgumentException',
    backendReason: 'head requires a positive integer',
  });
  assert.equal(row.finding.kind, FINDINGS.FALSE_NEGATIVE);
});

test('detector silent + engine rejects is a possible false negative', () => {
  const row = labelQuery({
    ...base,
    detectorCount: 0,
    backendRejected: true,
    backendType: 'SemanticCheckException',
    backendReason: 'capture group name is invalid',
  });
  assert.equal(row.finding.kind, FINDINGS.FALSE_NEGATIVE);
  // Must tell the reader to verify the rejection is this rule's condition; the
  // engine rejecting is weaker evidence than the engine accepting.
  assert.match(row.finding.evidence, /VERIFY the rejection is this rule's condition/);
});

test('agreement in either direction is not a finding', () => {
  assert.equal(labelQuery({ ...base, detectorCount: 1, backendRejected: true }).finding, null);
  assert.equal(labelQuery({ ...base, detectorCount: 0, backendRejected: false }).finding, null);
});

// --- the three-state read ----------------------------------------------------

test('no engine verdict produces no finding', () => {
  // The trap this closes: coercing an absent verdict to `false` reads a timed-out
  // leg as "the engine accepted this" and manufactures a false-positive finding
  // against a healthy rule.
  const row = labelQuery({ ...base, detectorCount: 1, backendRejected: undefined });
  assert.equal(row.finding, null);
  assert.equal(row.unobserved, true);
});

test('a silent detector with no engine verdict is unknown, not a control', () => {
  // Calling it a control would claim the rule correctly stayed quiet, which nothing
  // observed. It also inflates control counts that the coverage table reports.
  const row = labelQuery({ ...base, detectorCount: 0, backendRejected: undefined });
  assert.equal(row.role, ROLES.UNKNOWN);
});

// --- uninformative rejections ------------------------------------------------

test('an unknown-field rejection is suppressed, not reported', () => {
  // Harvested queries name fields their original OSD test invented. Without this
  // filter every such query becomes a false-negative finding and buries the real
  // ones.
  const row = labelQuery({
    ...base,
    detectorCount: 0,
    backendRejected: true,
    backendType: 'SemanticCheckException',
    backendReason: "can't resolve Symbol(namespace=FIELD_NAME, name=durationNano)",
  });
  assert.equal(row.finding, null);
  assert.equal(row.suppressed, 'unknown field');
});

test('a syntax error is suppressed', () => {
  // After index remapping some harvested queries are genuinely malformed; a query
  // the grammar cannot parse says nothing about a semantic rule.
  const row = labelQuery({
    ...base,
    detectorCount: 0,
    backendRejected: true,
    backendType: 'SyntaxCheckException',
    backendReason: 'mismatched input <EOF>',
  });
  assert.equal(row.suppressed, 'syntax error');
});

test('an unsupported-command rejection is suppressed', () => {
  // Same reasoning as the enforced corpus's control-also-rejected guard: the
  // command not existing is not evidence about a rule's condition.
  const row = labelQuery({
    ...base,
    detectorCount: 0,
    backendRejected: true,
    backendReason: 'union is not supported in this version',
  });
  assert.equal(row.suppressed, 'unsupported command');
});

test('an on-topic rejection survives the filter', () => {
  assert.equal(
    uninformativeRejection('IllegalArgumentException', 'Union command requires at least two datasets'),
    null
  );
});

test('a rule with no observed trigger is distinguished from one with a single trigger', () => {
  // These are different problems: zero triggers means this corpus proves nothing
  // about the rule at all (every harvested query was a control, or the detector is
  // gated off on this surface), whereas one trigger means the rule is observable but
  // a "fully relaxed" verdict would rest on a single case. Rendering both as
  // "1 trigger only" hid the first, which is the more serious gap.
  const markdown = renderMarkdown({
    stats: { queries: 9, triggers: 4, controls: 5, unknown: 0, findings: 0, suppressed: 0 },
    findings: [],
    triggerCoverage: [
      { ruleId: 'none-observed', triggers: 0, controls: 4, sufficientForScopeDecision: false },
      { ruleId: 'single', triggers: 1, controls: 2, sufficientForScopeDecision: false },
      { ruleId: 'plenty', triggers: 3, controls: 2, sufficientForScopeDecision: true },
    ],
  });
  assert.match(markdown, /`none-observed` \| 0 \| 4 \| \*\*none — no trigger observed\*\*/);
  assert.match(markdown, /`single` \| 1 \| 2 \| \*\*no — 1 trigger only\*\*/);
  assert.match(markdown, /`plenty` \| 3 \| 2 \| yes/);
});

test('a run with no engine half says so instead of implying agreement', () => {
  // "0 finding(s)" beside 109 queries reads as "everything agrees". With no engine
  // verdicts nothing was compared at all, and the report has to distinguish those.
  const withoutEngine = renderMarkdown({
    differential: false,
    stats: { queries: 109, triggers: 19, controls: 0, unknown: 90, findings: 0, suppressed: 0 },
    findings: [],
    triggerCoverage: [],
  });
  assert.match(withoutEngine, /No engine verdicts were supplied/);

  const withEngine = renderMarkdown({
    differential: true,
    stats: { queries: 10, triggers: 4, controls: 6, unknown: 0, findings: 0, suppressed: 0 },
    findings: [],
    triggerCoverage: [],
  });
  assert.doesNotMatch(withEngine, /No engine verdicts were supplied/);
});

test('suppression never applies to the false-POSITIVE side', () => {
  // The filter exists to protect the weak (false-negative) direction. A query the
  // engine RAN successfully is conclusive regardless of what any error text says,
  // so an accepted query must still report even with a suppressible-looking reason.
  const row = labelQuery({
    ...base,
    detectorCount: 1,
    // Explicit rather than relying on the default: with an empty severities list the
    // advisory check cannot fire, so the test would pass for the wrong reason and
    // stop covering the suppression filter at all.
    severities: ['error'],
    backendRejected: false,
    backendReason: "can't resolve Symbol(name=whatever)",
  });
  assert.equal(row.finding.kind, FINDINGS.FALSE_POSITIVE);
});
