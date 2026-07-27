/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the discovery engine probe's response mapping.
 *
 *   node --test scripts/ppl-lint/__tests__/probe-discovery-backend.test.mjs
 *
 * The probe has one job that can go wrong quietly: turning an HTTP response into a
 * verdict. Reading a non-answer as acceptance is what converts a network blip into
 * "the engine now accepts this query", so the accept/reject/no-verdict split is
 * pinned here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readResponse } from '../probe-discovery-backend.mjs';

test('a 200 is acceptance', () => {
  const v = readResponse({ status: 200, bodyText: '{"datarows":[]}' });
  assert.equal(v.outcome, 'observed');
  assert.equal(v.rejected, false);
});

test('a 400 is rejection and keeps the engine type and reason', () => {
  // The labeler's uninformative-rejection filter keys on these two strings; losing
  // them would let an unknown-field rejection be reported as a missed diagnostic.
  const v = readResponse({
    status: 400,
    bodyText: JSON.stringify({
      error: { type: 'SemanticCheckException', reason: "can't resolve Symbol(name=foo)" },
    }),
  });
  assert.equal(v.rejected, true);
  assert.equal(v.observed.type, 'SemanticCheckException');
  assert.match(v.observed.reason, /can't resolve/);
});

test('a 500 is also rejection', () => {
  assert.equal(readResponse({ status: 500, bodyText: '{}' }).rejected, true);
});

test('an unparseable body still yields a verdict from the status', () => {
  // The engine answered; the body being junk does not change whether it ran the
  // query. Discarding the verdict here would lose real signal.
  const v = readResponse({ status: 200, bodyText: '<html>oops' });
  assert.equal(v.outcome, 'observed');
  assert.equal(v.rejected, false);
});

test('an enormous reason is truncated', () => {
  const v = readResponse({
    status: 400,
    bodyText: JSON.stringify({ error: { type: 'X', reason: 'y'.repeat(5000) } }),
  });
  assert.equal(v.observed.reason.length, 500);
});

test('an accepted response carries no error fields', () => {
  const v = readResponse({ status: 200, bodyText: '{"datarows":[]}' });
  assert.equal(v.observed.type, undefined);
  assert.equal(v.observed.reason, undefined);
});
