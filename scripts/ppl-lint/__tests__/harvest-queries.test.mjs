/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the discovery-corpus harvester.
 *
 *   node --test scripts/ppl-lint/__tests__/harvest-queries.test.mjs
 *
 * The harvester's job is to attribute a query to the rule that owns it and to hand
 * the labeler something the cluster can actually run. Both have a wrong-answer mode
 * that is worse than dropping the query: a misattributed query produces a
 * "disagreement" for a rule that never claimed anything about it, and an
 * unremapped index produces a rejection that reads as engine behavior. Those two
 * failure modes are what these tests pin.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  findTestFiles,
  harvestContext,
  harvestFile,
  referencedIdentifiers,
  remapIndex,
  ruleFromDescribeTitle,
  toRunnerSpecs,
} from '../harvest-queries.mjs';

const RULES = [
  'invalid-capture-group-name',
  'field-validation',
  'rex-scan-cost',
  'head-without-sort',
  'division-by-zero',
];

test('test discovery recurses through current rule locations and excludes generated data', () => {
  const osd = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-lint-harvest-'));
  const lintRoot = path.join(osd, 'packages/osd-monaco/src/ppl/lint');
  const files = [
    'rules/inline_rule.test.ts',
    'rules/__tests__/nested_rule.test.tsx',
    '__tests__/catalog.test.ts',
    'rules/__fixtures__/fixture.test.ts',
    'rules/__snapshots__/snapshot.test.ts',
    'generated/generated.test.ts',
    'rules/slow.bench.test.ts',
    'rules/manual.verify.test.ts',
  ];
  try {
    for (const file of files) {
      const absolute = path.join(lintRoot, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, '');
    }
    assert.deepEqual(
      findTestFiles(osd).map((file) => path.relative(lintRoot, file)),
      [
        '__tests__/catalog.test.ts',
        'rules/__tests__/nested_rule.test.tsx',
        'rules/inline_rule.test.ts',
      ]
    );
  } finally {
    fs.rmSync(osd, { recursive: true, force: true });
  }
});

// --- attribution -------------------------------------------------------------

test('an exact describe title names its rule', () => {
  assert.equal(ruleFromDescribeTitle('rex-scan-cost', RULES), 'rex-scan-cost');
});

test('a suffixed title still names its rule', () => {
  // OSD's real titles: `describe('rex-scan-cost (compiled surface)')`. Requiring an
  // exact match dropped ~75% of harvestable queries.
  assert.equal(ruleFromDescribeTitle('rex-scan-cost (compiled surface)', RULES), 'rex-scan-cost');
  assert.equal(
    ruleFromDescribeTitle('field-validation alternate-source suppression', RULES),
    'field-validation'
  );
});

test('a title that merely mentions a rule mid-sentence does NOT claim it', () => {
  // Prefix-only matching is the guard: this describe sits under some OTHER rule and
  // must not steal attribution, or its queries get judged against the wrong rule.
  assert.equal(ruleFromDescribeTitle('does not fire on rex-scan-cost candidates', RULES), null);
});

test('a longer rule id wins over a prefix of itself', () => {
  const rules = ['field-validation', 'field-validation-shape'];
  assert.equal(ruleFromDescribeTitle('field-validation-shape cases', rules), 'field-validation-shape');
});

test('a rule id must end at a word boundary', () => {
  assert.equal(ruleFromDescribeTitle('head-without-sorting quirks', RULES), null);
});

test('the innermost rule-owning describe wins', () => {
  const source = `
    describe('PPL silent-failure lint rules (compiled surface)', () => {
      describe('division-by-zero', () => {
        it('flags it', () => {
          expect(ids('source=logs | eval x = a / 0')).toContain('division-by-zero');
        });
      });
    });
  `;
  const out = harvestFile(source, { file: 't.ts', knownRules: RULES });
  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, 'division-by-zero');
});

test('a query with no rule-owning ancestor is recorded unattributed, not guessed', () => {
  const source = `
    describe('some unrelated suite', () => {
      it('x', () => { lint('source=logs | head 10'); });
    });
  `;
  const out = harvestFile(source, { file: 't.ts', knownRules: RULES });
  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, null);
});

// --- extraction --------------------------------------------------------------

test('JS string escapes are unescaped to the runtime query', () => {
  // A test source containing '(?<n>\\\\d+)' is the 4 chars `\\d+` at runtime, which
  // is what the detector and the engine both see. Leaving the JS layer escaped
  // sends a different query than the test actually linted.
  const source = String.raw`
    describe('invalid-capture-group-name', () => {
      it('x', () => { lint('source=logs | rex field=m "(?<bad-name>\\d+)"'); });
    });
  `;
  const out = harvestFile(source, { file: 't.ts', knownRules: RULES });
  assert.equal(out.length, 1);
  assert.equal(out[0].query, 'source=logs | rex field=m "(?<bad-name>\\d+)"');
});

test('template literals with interpolation are dropped', () => {
  // `${...}` is filled at runtime; sending the placeholder to the engine tests
  // nothing and would be reported as a syntax error.
  const source = 'describe(\'field-validation\', () => { lint(`source=${idx} | fields a`); });';
  const out = harvestFile(source, { file: 't.ts', knownRules: RULES });
  assert.equal(out.length, 0);
});

test('only PPL-opening strings are treated as queries', () => {
  const source = `
    describe('field-validation', () => {
      it('x', () => {
        expect(msg).toBe('this is not a query at all');
        lint('source=logs | fields a');
      });
    });
  `;
  const out = harvestFile(source, { file: 't.ts', knownRules: RULES });
  assert.deepEqual(
    out.map((o) => o.query),
    ['source=logs | fields a']
  );
});

test('the harvest records where each query came from', () => {
  const source = `describe('division-by-zero', () => {\n  lint('source=logs | eval x = a / 0');\n});`;
  const out = harvestFile(source, { file: 'pkg/x.test.ts', knownRules: RULES });
  assert.match(out[0].source, /^pkg\/x\.test\.ts:2$/);
});

// --- index remapping ---------------------------------------------------------

test('source= is remapped onto the fixture index', () => {
  assert.equal(
    remapIndex('source=logs | fields a', 'acct'),
    'source=acct | fields a'
  );
});

test('a backticked source is remapped', () => {
  assert.equal(remapIndex('source=`my-logs` | fields a', 'acct'), 'source=acct | fields a');
});

test('the bare `search <index>` form is remapped', () => {
  assert.equal(
    remapIndex('search accounts | eval x = balance / 0', 'acct'),
    'search acct | eval x = balance / 0'
  );
});

test('remapping is a no-op without a target index', () => {
  assert.equal(remapIndex('source=logs | fields a', ''), 'source=logs | fields a');
});

test('a WILDCARD source is left alone', () => {
  // Found by running the pipeline: rewriting `source=`nope-*`` to a concrete index
  // destroyed the only thing `wildcard-source-zero-match` detects, so its single
  // harvested query became a control and the rule reported zero triggers.
  assert.equal(remapIndex('source=`nope-*`', 'acct'), 'source=`nope-*`');
  assert.equal(remapIndex('source=logs-* | fields a', 'acct'), 'source=logs-* | fields a');
  assert.equal(remapIndex('index=a* | head 1', 'acct'), 'index=a* | head 1');
});

test('a non-wildcard source is still remapped when a wildcard appears elsewhere', () => {
  // The guard must key on a wildcard in the SOURCE, not anywhere in the query — a
  // regex or a field list containing `*` is unrelated to index resolution.
  assert.equal(
    remapIndex('source=logs | rex field=m "(?<a>.*)"', 'acct'),
    'source=acct | rex field=m "(?<a>.*)"'
  );
});

// --- context harvesting ------------------------------------------------------

test('a typeMap declaration is harvested', () => {
  // Seven of nineteen rules are needsContext and self-suppress without this. The
  // context is taken from the test file because its author wrote it to make exactly
  // these queries fire; a hand-written substitute would be a guess.
  const source = `
    const typeMap = new Map<string, string>([
      ['age', 'long'],
      ['firstname', 'text'],
      ['attributes', 'flat_object'],
    ]);
  `;
  assert.deepEqual(harvestContext(source).typeMap, {
    age: 'long',
    firstname: 'text',
    attributes: 'flat_object',
  });
});

test('disabledObjectFields is harvested', () => {
  const source = "const ctx = { typeMap, disabledObjectFields: new Set(['raw', 'blob']) };";
  assert.deepEqual(harvestContext(source).disabledObjectFields, ['raw', 'blob']);
});

test('a file with no context declaration yields an empty context', () => {
  const out = harvestContext("describe('x', () => { lint('source=a | head 1'); });");
  assert.deepEqual(out.typeMap, {});
  assert.deepEqual(out.disabledObjectFields, []);
});

test('generated specs carry the harvested context as frontendContext', () => {
  const corpus = {
    index: 'acct',
    queries: [
      {
        ruleId: 'flat-object-subfield',
        name: 'd0',
        query: 'source=acct | where attributes.x = 1',
        context: { typeMap: { attributes: 'flat_object' }, disabledObjectFields: ['raw'] },
      },
    ],
  };
  const spec = toRunnerSpecs(corpus)[0].spec;
  assert.deepEqual(spec.frontendContext.deriveFromMapping, { attributes: 'flat_object' });
  assert.deepEqual(spec.frontendContext.disabledObjectFields, ['raw']);
  // Two rules ship `enabled: false` and only run when the host overrides them.
  assert.equal(spec.frontendContext.forceEnable, true);
});

test('visibleIndices is supplied even with no typeMap', () => {
  // `wildcard-source-zero-match` reads ONLY visibleIndices and self-suppresses on an
  // empty list; its test file declares no typeMap, so keying this off the mapping
  // left the rule permanently inert.
  const spec = toRunnerSpecs({
    index: 'acct',
    queries: [
      { ruleId: 'wildcard-source-zero-match', name: 'd0', query: 'source=`nope-*`', context: {} },
    ],
  })[0].spec;
  assert.deepEqual(spec.frontendContext.visibleIndices, ['{{index}}']);
});

test('one rule tested under two different contexts yields two specs', () => {
  // Merging them would hand a query field types its own test never used, so the
  // verdict would describe a scenario nobody wrote.
  const corpus = {
    index: 'acct',
    queries: [
      { ruleId: 'rex-scan-cost', name: 'd0', query: 'source=acct | rex field=a ""', context: { typeMap: { a: 'text' } } },
      { ruleId: 'rex-scan-cost', name: 'd1', query: 'source=acct | rex field=b ""', context: { typeMap: { b: 'keyword' } } },
    ],
  };
  const specs = toRunnerSpecs(corpus);
  assert.equal(specs.length, 2);
  // Suffixed only when a rule actually has more than one context.
  assert.deepEqual(specs.map((s) => s.fileName).sort(), [
    'rex-scan-cost.1.discovery.spec.json',
    'rex-scan-cost.2.discovery.spec.json',
  ]);
});

test('the original query is kept alongside the remapped one', () => {
  // Needed to explain a finding: a reader has to be able to see what the OSD test
  // actually asserted before trusting a disagreement derived from the rewrite.
  const source = `describe('field-validation', () => { lint('source=logs | fields a'); });`;
  const out = harvestFile(source, { file: 't.ts', knownRules: RULES, index: 'acct' });
  assert.equal(out[0].query, 'source=acct | fields a');
  assert.equal(out[0].originalQuery, 'source=logs | fields a');
});

test('identifiers are collected for the labeler to intersect against the fixture', () => {
  const ids = referencedIdentifiers('source=acct | eval x = durationNano / 0');
  assert.ok(ids.includes('durationNano'));
  assert.ok(ids.includes('acct'));
});

// --- runner specs ------------------------------------------------------------

const CORPUS = {
  index: 'acct',
  queries: [
    { ruleId: 'division-by-zero', name: 'discovery-0', query: 'source=acct | eval x = a / 0' },
    { ruleId: 'division-by-zero', name: 'discovery-1', query: 'source=acct | eval x = a / 2' },
    { ruleId: 'head-without-sort', name: 'discovery-2', query: 'source=acct | head 5' },
    { ruleId: null, name: 'discovery-3', query: 'source=acct | fields a' },
  ],
};

test('one spec is emitted per rule, and unattributed queries are excluded', () => {
  const specs = toRunnerSpecs(CORPUS);
  assert.deepEqual(
    specs.map((s) => s.spec.ruleId),
    ['division-by-zero', 'head-without-sort']
  );
  assert.equal(Object.keys(specs[0].spec.queries).length, 2);
});

test('generated specs carry no wiring block', () => {
  // The runner deep-equals `wiring` against the OSD catalog when present. A
  // generated approximation would fail the run for a reason unrelated to discovery.
  const specs = toRunnerSpecs(CORPUS);
  assert.equal(specs[0].spec.wiring, undefined);
});

test('every generated query is declared a trigger', () => {
  // Roles are derived later from real detector output. Declaring some as controls
  // would make the runner apply control-specific cross-checks whose failures are
  // pure noise on a corpus with no pinned verdicts.
  const specs = toRunnerSpecs(CORPUS);
  for (const spec of specs) {
    for (const q of Object.values(spec.spec.queries)) {
      assert.equal(q.role, 'trigger');
    }
  }
});

test('exactly one expectation matches any engine version', () => {
  // Two matching entries make the runner report the version as uncovered; an
  // open-ended empty range is what guarantees a single match on every leg.
  const specs = toRunnerSpecs(CORPUS);
  for (const spec of specs) {
    assert.equal(spec.spec.expectations.length, 1);
    assert.equal(spec.spec.expectations[0].version, '');
  }
});

test('generated specs are scored on either grammar surface', () => {
  const specs = toRunnerSpecs(CORPUS);
  assert.ok(specs.every((s) => s.spec.grammarSurface === 'both'));
});

test('query names are preserved so the two halves can be joined', () => {
  // The detector runner and the engine probe key on these names. If they disagreed,
  // every row would lose its counterpart and the corpus would read as unobserved.
  const specs = toRunnerSpecs(CORPUS);
  assert.deepEqual(Object.keys(specs[0].spec.queries), ['discovery-0', 'discovery-1']);
});
