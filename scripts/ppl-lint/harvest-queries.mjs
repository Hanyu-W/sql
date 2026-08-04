/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Harvest PPL queries out of OSD's own lint test suite into a discovery corpus.
 *
 * ## Why this exists
 *
 * The enforced contract corpus is hand-written and therefore small — around one
 * trigger and one control per rule. That is right for an enforced contract (every
 * expectation is a reviewed claim) but it is too thin to answer the question that
 * decides a remediation: when an engine starts accepting a query a rule flags, is
 * the behavior FULLY gone on that version, or only PARTIALLY?
 *
 * `classifyRelaxationScope` in drift.mjs needs several triggers per rule to tell
 * those apart, because they need opposite actions — version-scope the rule away
 * (full) versus narrow the detector (partial). With one pinned trigger, a partial
 * engine fix is indistinguishable from a total one, and the advice that follows
 * ships a false negative.
 *
 * OSD's lint tests already contain that variety: whoever wrote each detector wrote
 * several queries that should fire and several that should not, grouped by rule.
 * `invalid-capture-group-name` has three distinct reasons a name is invalid
 * (hyphen, leading digit, all digits) in OSD's tests versus one in the contract.
 * Harvesting them costs nothing and is exactly the input the rollup needs.
 *
 * ## What this does NOT do
 *
 * It does not produce expectations, and the discovery corpus never fails a build.
 * A harvested query carries no pinned verdict — `label-discovery.mjs` derives its
 * role by running the real detectors, and the engine supplies the other half. That
 * is deliberate: auto-deriving an expectation from current behavior can only ever
 * confirm current behavior, locking in whatever the detector does today, bugs and
 * all. Promotion into the enforced corpus stays a human writing a spec entry.
 *
 * ## Attribution
 *
 * A query is attributed to a rule by the innermost enclosing `describe('<id>')`
 * whose title is a known catalog rule id (OSD's tests are organized that way, see
 * `__tests__/silent_failure_rules.test.ts`). A query with no such ancestor is
 * recorded with `ruleId: null` and skipped by the labeler unless `--keep-unowned`
 * is passed — guessing an owner from a filename would attribute queries to the
 * wrong rule, which is worse than dropping them.
 *
 * Usage:
 *   node scripts/ppl-lint/harvest-queries.mjs \
 *     --osd <path to OSD checkout> \
 *     --catalog-rules <comma list | @file of rule ids> \
 *     --index opensearch-sql_test_index_account \
 *     --out discovery-corpus.json
 */

import fs from 'fs';
import path from 'path';

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[ppl-lint-harvest] ${message}`);
}

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-harvest] FATAL: ${message}`);
  process.exit(2);
}

const LINT_TEST_ROOT = 'packages/osd-monaco/src/ppl/lint';

/**
 * Benchmarks and repro captures are excluded. Bench files hold deliberately
 * pathological queries built to be slow rather than to be right or wrong, and
 * they would dominate the corpus with near-duplicates.
 */
const EXCLUDED_FILE_PATTERNS = [/\.bench\.test\.ts$/, /\.verify\.test\.ts$/];
const EXCLUDED_DIRS = new Set([
  '__fixtures__',
  '__snapshots__',
  'fixtures',
  'generated',
  'target',
]);

function parseArgs(argv) {
  const args = {
    osd: '',
    out: 'discovery-corpus.json',
    index: '',
    catalogRules: [],
    keepUnowned: false,
    maxPerRule: 40,
    specsOut: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fatal(`${arg} requires a value`);
      return value;
    };
    if (arg === '--osd') args.osd = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--index') args.index = next();
    else if (arg === '--catalog-rules') args.catalogRules = readRuleList(next());
    else if (arg === '--keep-unowned') args.keepUnowned = true;
    else if (arg === '--max-per-rule') args.maxPerRule = Number(next());
    else if (arg === '--specs-out') args.specsOut = next();
    else fatal(`unknown argument "${arg}"`);
  }
  if (!args.osd) fatal('--osd <path to OSD checkout> is required');
  return args;
}

/** Rule ids either inline (`a,b,c`) or from a file (`@path`), one per line or JSON. */
function readRuleList(value) {
  if (!value.startsWith('@')) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const file = value.slice(1);
  if (!fs.existsSync(file)) fatal(`--catalog-rules file not found: ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Accept both a bare id list and OSD's rules_catalog.json shape.
      return parsed.map((e) => (typeof e === 'string' ? e : e && e.id)).filter(Boolean);
    }
  } catch {
    // not JSON; fall through to line-delimited
  }
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/** Every lint test file under the lint package, excluding generated test data. */
export function findTestFiles(osdRoot) {
  const files = [];
  const root = path.join(osdRoot, LINT_TEST_ROOT);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          visit(path.join(dir, entry.name));
        }
        continue;
      }
      const name = entry.name;
      if (!name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) continue;
      if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(name))) continue;
      files.push(path.join(dir, name));
    }
  };
  if (fs.existsSync(root)) visit(root);
  return files.sort();
}

/**
 * Track which `describe(...)` blocks enclose a given offset, so a query can be
 * attributed to the rule whose block it sits in.
 *
 * Brace counting is enough here and a real TS parser is not worth the dependency:
 * these are test files whose describes are conventional `describe('x', () => {`
 * calls. The failure mode of miscounting is a query attributed to an outer block
 * (or to none), which the `ruleId: null` path already handles safely — never a
 * query attributed to a rule that does not own it, because titles must match a
 * known catalog id.
 */
function buildDescribeScopes(source) {
  const scopes = [];
  const describeRe = /\bdescribe(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = describeRe.exec(source)) !== null) {
    const title = match[2];
    // Find the block's opening brace after the describe call, then its matching
    // close, ignoring braces inside strings and comments.
    const braceStart = source.indexOf('{', match.index + match[0].length);
    if (braceStart === -1) continue;
    const end = matchBrace(source, braceStart);
    scopes.push({ title, start: braceStart, end: end === -1 ? source.length : end });
  }
  return scopes;
}

/** Index of the `}` matching the `{` at `open`, or -1. Skips strings/comments. */
function matchBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the closing quote of the string starting at `start`. */
function skipString(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return source.length;
}

/**
 * PPL query literals. Anchored on the commands that can open a PPL statement, so
 * arbitrary strings in a test file are not mistaken for queries. `search` and
 * `source=`/`index=` are the real openers; `describe` is deliberately absent
 * because it collides with the test function of the same name.
 */
const QUERY_RE = /(['"`])((?:source\s*=|index\s*=|search\s+)(?:\\.|(?!\1).)*)\1/g;

/**
 * A harvested literal is a JS string literal, so its escapes are JS-level. The
 * detectors want the RUNTIME string: `'(?<bad-name>\\\\d+)'` in a test source is
 * the four characters `\\d+` on the wire... which is itself a regex escape the
 * engine sees. Unescaping the JS layer (and only that layer) is what makes a
 * harvested query identical to what the test actually linted.
 */
function unescapeJsString(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (all, esc) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        return '\0';
      case 'x':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      case 'u':
        return esc[1] === '{'
          ? String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
          : String.fromCharCode(parseInt(esc.slice(1), 16));
      default:
        // Covers \\ \' \" \` and any other single-character escape.
        return esc;
    }
  });
}

/**
 * Rewrite the test's index onto the backend fixture's index.
 *
 * OSD's unit tests lint against invented sources (`source=logs`, `search
 * accounts`) that do not exist in the SQL integ-test cluster. A harvested query
 * must name a real index or the engine rejects it for a reason that has nothing to
 * do with the rule — which would read as "the engine rejects this" and be counted
 * as a trigger holding.
 *
 * Only the leading source/index/search clause is rewritten. Subsearch sources
 * inside the query body are rewritten too, since those are equally invented.
 * Returns null when no rewrite was possible, so the caller can drop the query
 * rather than send an unresolvable index to the cluster.
 */
export function remapIndex(query, targetIndex) {
  if (!targetIndex) return query;
  // A WILDCARD source is left alone. `wildcard-source-zero-match` exists precisely
  // to flag a pattern matching no visible index, so rewriting `source=\`nope-*\``
  // to a concrete index destroys the only thing the rule detects — the query became
  // a control and the rule reported zero triggers. More generally, a wildcard is
  // part of the query's meaning rather than an incidental index name, and the
  // engine resolves a non-matching pattern on its own without erroring.
  if (/\bsource\s*=\s*`?[^\s`|,]*\*/.test(query) || /\bindex\s*=\s*`?[^\s`|,]*\*/.test(query)) {
    return query;
  }
  let out = query
    .replace(/\bsource\s*=\s*`[^`]+`/g, `source=${targetIndex}`)
    .replace(/\bsource\s*=\s*[A-Za-z_][\w.*-]*/g, `source=${targetIndex}`)
    .replace(/\bindex\s*=\s*`[^`]+`/g, `index=${targetIndex}`)
    .replace(/\bindex\s*=\s*[A-Za-z_][\w.*-]*/g, `index=${targetIndex}`);
  // `search <index>` — the bare-index form. Only the opener, and only when the
  // token is not already a keyword-led clause.
  out = out.replace(/^(\s*search\s+)(?!source\s*=|index\s*=)([A-Za-z_][\w.*-]*)/, `$1${targetIndex}`);
  return out;
}

/**
 * Does this query reference fields the backend fixture will not have?
 *
 * A harvested query naming `durationNano` against the `account` index is rejected
 * for an unknown field, not for the rule's condition. Counting that as "the engine
 * still rejects" would fake a partial fix and send someone to narrow a healthy
 * detector — the same class of vacuous result the enforced contract's
 * control-also-rejected guard exists to prevent.
 *
 * This cannot be decided statically, so it is not decided here: the query is
 * harvested with the field names it mentions recorded, and the labeler drops the
 * ones the fixture cannot satisfy. Extracting identifiers is best-effort and
 * deliberately over-broad (it will include command keywords), because the labeler
 * intersects against the fixture's real field list rather than trusting this.
 */
export function referencedIdentifiers(query) {
  const ids = new Set();
  for (const match of query.matchAll(/\b([A-Za-z_][\w.]*)\b/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}

/**
 * The rule a `describe(...)` title names, or null.
 *
 * OSD's titles are not bare ids — a rule-scoped suite reads
 * `describe('rex-scan-cost (compiled surface)')` or
 * `describe('field-validation alternate-source suppression')`. Requiring an exact
 * match dropped ~75% of harvestable queries, all of them from files dedicated to a
 * single rule, so the title is matched as a PREFIX at a word boundary.
 *
 * Prefix-only is the point: matching a rule id anywhere in the title would let
 * `describe('does not fire on rex-scan-cost candidates')`, nested under a
 * different rule, steal the attribution. A title that merely mentions another rule
 * mid-sentence is not that rule's suite. Longest match wins, so
 * `field-validation-shape` is preferred over `field-validation` when both exist.
 */
export function ruleFromDescribeTitle(title, knownRules) {
  const text = String(title || '');
  let best = null;
  for (const ruleId of knownRules) {
    if (!text.startsWith(ruleId)) continue;
    // Must end at a word boundary: `head-without-sorting` is not `head-without-sort`.
    const after = text.charAt(ruleId.length);
    if (after && /[\w-]/.test(after)) continue;
    if (!best || ruleId.length > best.length) best = ruleId;
  }
  return best;
}

/**
 * Harvest the lint CONTEXT a test file declares, not just its queries.
 *
 * Seven of nineteen rules are `needsContext: true` — they self-suppress without a
 * `typeMap`, and `enabled-false-object` additionally needs `disabledObjectFields`.
 * Harvesting their queries without their context produced 26 `rex-scan-cost`
 * queries and zero triggers: the detector never ran, which is indistinguishable in
 * the report from a rule that fired on nothing.
 *
 * The context is taken from the file rather than invented because the OSD test
 * author wrote it to make exactly these queries fire. A hand-written substitute
 * would be a guess about which field types each query depends on, and a wrong guess
 * silently suppresses the detector again.
 *
 * Parses the conventional shapes those files use:
 *   const typeMap = new Map<string, string>([ ['age', 'long'], ... ]);
 *   disabledObjectFields: new Set(['raw']),
 *
 * Regex rather than a TS parser for the same reason as `buildDescribeScopes`: these
 * are conventional declarations, and the failure mode is an empty context, which
 * leaves the rule visibly at zero triggers rather than producing a wrong verdict.
 */
export function harvestContext(source) {
  const typeMap = {};
  // Every `['name', 'type']` pair inside a `new Map...([ ... ])` initializer. Scoped
  // to Map literals so unrelated tuple arrays in the file are not picked up.
  for (const mapMatch of source.matchAll(/new Map\s*(?:<[^>]*>)?\s*\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const pair of mapMatch[1].matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)) {
      typeMap[pair[1]] = pair[2];
    }
  }

  const disabledObjectFields = [];
  for (const match of source.matchAll(/disabledObjectFields:\s*new Set\s*\(\s*\[([^\]]*)\]/g)) {
    for (const item of match[1].matchAll(/'([^']+)'/g)) {
      disabledObjectFields.push(item[1]);
    }
  }

  return {
    typeMap,
    disabledObjectFields: [...new Set(disabledObjectFields)],
  };
}

/** Harvest one file into `{ ruleId, query, source }` records. */
export function harvestFile(source, { file, knownRules, index }) {
  const context = harvestContext(source);
  const scopes = buildDescribeScopes(source);
  const known = new Set(knownRules || []);
  const out = [];
  for (const match of source.matchAll(QUERY_RE)) {
    const raw = match[2];
    const query = unescapeJsString(raw);
    // Template literals with interpolation are not real queries — the `${...}` is
    // a placeholder the test fills at runtime, and sending it to the engine tests
    // nothing. Dropped rather than guessed at.
    if (/\$\{/.test(query)) continue;
    // A query must have at least one pipe or be a bare source read; anything
    // shorter is usually a fragment asserted against, not a lintable statement.
    if (query.trim().length < 8) continue;

    // Innermost enclosing describe whose title is a known rule id.
    const at = match.index;
    const enclosing = scopes
      .filter((s) => at > s.start && at < s.end)
      .sort((a, b) => b.start - a.start);
    // Innermost first: a query inside `describe('flat-object-subfield')` nested in
    // `describe('silent-failure rules')` belongs to the specific rule, not the file.
    let owner = null;
    for (const scope of enclosing) {
      owner = ruleFromDescribeTitle(scope.title, known);
      if (owner) break;
    }
    const line = source.slice(0, at).split('\n').length;

    out.push({
      ruleId: owner,
      query: index ? remapIndex(query, index) : query,
      originalQuery: query,
      identifiers: referencedIdentifiers(query),
      source: `${file}:${line}`,
      // Carried per query, not per rule: two files can test the same rule with
      // different field types, and merging them would give a query a typeMap its
      // own test never used.
      context,
    });
  }
  return out;
}

/**
 * Emit the harvested corpus as spec files the EXISTING detector runner can consume.
 *
 * `run-frontend-contract.mjs` is expectation-driven: it walks `expectations[]`,
 * scores each query against a pinned `detectorCount`, and records the real `actual`
 * count in its report either way. Discovery needs only that `actual`, so rather
 * than teach the runner a second mode — which would risk changing how the ENFORCED
 * check behaves — the corpus is written out as ordinary specs whose expectations are
 * deliberately arbitrary.
 *
 * Two consequences, both intended:
 *   - The runner will report failures for every query whose real count differs from
 *     the placeholder. Those are meaningless here and the caller discards the exit
 *     code; only `detector-report.json` is read. This is why discovery must never
 *     be wired to a required check.
 *   - `grammarSurface: 'both'` so a rule is scored on whichever surface the leg
 *     ran, and `schedule: 'nightly'` to match how the aggregate legs invoke it.
 *
 * One spec per rule, because the runner keys wiring checks off `spec.ruleId`.
 */
export function toRunnerSpecs(corpus) {
  // Grouped by rule AND by harvested context. A `needsContext` rule self-suppresses
  // without a typeMap, so a query has to be scored under the context its own test
  // declared — merging two files' contexts into one spec would hand a query field
  // types its test never used, and the resulting verdict would describe a scenario
  // nobody wrote.
  const byRule = new Map();
  for (const [i, entry] of (corpus.queries || []).entries()) {
    if (!entry.ruleId) continue;
    const contextKey = JSON.stringify(entry.context || {});
    const key = `${entry.ruleId} ${contextKey}`;
    if (!byRule.has(key)) {
      byRule.set(key, { ruleId: entry.ruleId, context: entry.context, entries: [] });
    }
    byRule.get(key).entries.push({ ...entry, name: entry.name || `discovery-${i}` });
  }

  // A rule with more than one distinct context needs more than one spec file, so
  // names are suffixed only when that happens — keeping the common case readable.
  const groupCount = new Map();
  for (const { ruleId } of byRule.values()) {
    groupCount.set(ruleId, (groupCount.get(ruleId) || 0) + 1);
  }
  const seenPerRule = new Map();

  const specs = [];
  for (const [, group] of [...byRule].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { ruleId, context } = group;
    const entries = group.entries;
    const queries = {};
    const expected = {};
    for (const entry of entries) {
      // Every query is declared a trigger: the runner needs SOME role, and the real
      // role is derived later from the detector's actual output. Calling them all
      // triggers keeps the runner from applying its control-specific cross-checks,
      // whose failures would be pure noise on a corpus with no pinned verdicts.
      queries[entry.name] = { role: 'trigger', query: entry.query };
      expected[entry.name] = { detectorCount: 0 };
    }
    const ordinal = (seenPerRule.get(ruleId) || 0) + 1;
    seenPerRule.set(ruleId, ordinal);
    const suffix = groupCount.get(ruleId) > 1 ? `.${ordinal}` : '';

    const typeMap = (context && context.typeMap) || {};
    const disabledObjectFields = (context && context.disabledObjectFields) || [];
    const frontendContext = { isCalcite: true };
    if (Object.keys(typeMap).length > 0) {
      // `deriveFromMapping` is what the runner turns into `fields` + `typeMap`, the
      // context every `needsContext` rule requires before it will emit anything.
      frontendContext.deriveFromMapping = typeMap;
    }
    // Always supplied, independent of the typeMap. `wildcard-source-zero-match`
    // reads ONLY `visibleIndices` and self-suppresses on an empty list (otherwise
    // every wildcard would false-fire "matched 0 of 0") — and its test file declares
    // no typeMap, so keying this off the mapping left the rule permanently inert.
    frontendContext.visibleIndices = ['{{index}}'];
    if (disabledObjectFields.length > 0) {
      frontendContext.disabledObjectFields = disabledObjectFields;
    }
    // Two rules ship `enabled: false` and only run when the host overrides them.
    // Without this they are inert and every harvested query reads as a control.
    frontendContext.forceEnable = true;

    specs.push({
      fileName: `${ruleId}${suffix}.discovery.spec.json`,
      spec: {
        schemaVersion: 3,
        ruleId,
        grammarSurface: 'both',
        schedule: 'nightly',
        // No `wiring` block: the runner deep-equals it against the catalog when
        // present, and a mismatch there would fail the run for a reason that has
        // nothing to do with discovery.
        index: corpus.index || undefined,
        frontendContext,
        queries,
        // A single open expectation so exactly one entry matches every engine
        // version; the pinned counts are placeholders (see the note above).
        expectations: [{ version: '', queries: expected }],
      },
    });
  }
  return specs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = findTestFiles(args.osd);
  if (files.length === 0) {
    fatal(`no lint test files found under ${args.osd}; is --osd an OSD checkout root?`);
  }

  const records = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(args.osd, file);
    records.push(
      ...harvestFile(source, { file: rel, knownRules: args.catalogRules, index: args.index })
    );
  }

  // Dedupe on (ruleId, query): the same query legitimately appears in several
  // tests, and running it repeatedly against the cluster buys nothing.
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = `${record.ruleId}::${record.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }

  const owned = unique.filter((r) => r.ruleId);
  const unowned = unique.filter((r) => !r.ruleId);

  // Cap per rule so one heavily-tested rule cannot dominate a leg's runtime. The
  // drop is LOGGED rather than silent: a truncated corpus that reads as complete
  // is how a coverage gap hides.
  const byRule = new Map();
  for (const record of owned) {
    if (!byRule.has(record.ruleId)) byRule.set(record.ruleId, []);
    byRule.get(record.ruleId).push(record);
  }
  const kept = [];
  for (const [ruleId, group] of [...byRule].sort()) {
    if (group.length > args.maxPerRule) {
      log(
        `NOTE: ${ruleId} harvested ${group.length} queries; keeping the first ${args.maxPerRule} ` +
          `(--max-per-rule). ${group.length - args.maxPerRule} dropped.`
      );
    }
    kept.push(...group.slice(0, args.maxPerRule));
  }

  // Names are assigned ONCE, here, and every downstream artifact keys off them. If
  // the detector runner and the engine probe derived names independently they could
  // disagree, and every row would silently lose its counterpart — the whole corpus
  // would read as unobserved rather than as a bug.
  kept.forEach((entry, i) => {
    entry.name = `discovery-${i}`;
  });

  const corpus = {
    schemaVersion: 1,
    kind: 'discovery',
    // Stated in the artifact itself so no downstream consumer can mistake this for
    // the enforced corpus and start failing builds on it.
    enforced: false,
    note:
      'Auto-harvested from OSD lint tests. Roles are assigned by label-discovery.mjs from real ' +
      'detector output; there are no pinned expectations and this corpus must never fail a build.',
    index: args.index || null,
    sourceFiles: files.map((f) => path.relative(args.osd, f)),
    ruleCoverage: args.catalogRules
      .map((ruleId) => {
        const entries = kept.filter((entry) => entry.ruleId === ruleId);
        return {
          ruleId,
          filesScanned: [
            ...new Set(entries.map((entry) => entry.source.split(':')[0])),
          ].sort(),
          ownedQueryCount: entries.length,
          explicitException: null,
        };
      })
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    exceptions: [],
    queries: kept,
    unowned: args.keepUnowned ? unowned : [],
    stats: {
      files: files.length,
      harvested: records.length,
      unique: unique.length,
      owned: kept.length,
      unowned: unowned.length,
      rules: byRule.size,
    },
  };

  fs.writeFileSync(args.out, JSON.stringify(corpus, null, 2));
  log(
    `wrote ${args.out}: ${kept.length} owned query(s) across ${byRule.size} rule(s) from ` +
      `${files.length} file(s); ${unowned.length} unattributed` +
      (args.keepUnowned ? ' (kept)' : ' (dropped)')
  );

  // Optional: the same corpus as spec files, so the existing detector runner can
  // produce real diagnostic counts for it without being modified.
  if (args.specsOut) {
    fs.mkdirSync(args.specsOut, { recursive: true });
    const specs = toRunnerSpecs(corpus);
    for (const { fileName, spec } of specs) {
      fs.writeFileSync(path.join(args.specsOut, fileName), JSON.stringify(spec, null, 2));
    }
    fs.writeFileSync(
      path.join(args.specsOut, 'manifest.json'),
      JSON.stringify(
        {
          schemaVersion: 3,
          description:
            'AUTO-GENERATED discovery corpus. No reviewed expectations; the pinned counts are ' +
            'placeholders. Never list these under defaultError and never wire them to a required check.',
          contracts: specs.map((s) => s.fileName),
          // Empty on purpose: `defaultError` is the ENFORCED set, and nothing here is
          // enforced. A non-empty value would make the aggregator fail the build on
          // auto-generated expectations.
          defaultError: [],
        },
        null,
        2
      )
    );
    log(`wrote ${specs.length} runner spec(s) to ${args.specsOut}`);
  }
  for (const [ruleId, group] of [...byRule].sort()) {
    log(`  ${ruleId}: ${Math.min(group.length, args.maxPerRule)}`);
  }
}

// Importable for unit tests; only runs the CLI when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('harvest-queries.mjs')) {
  main();
}
