/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Assign roles to harvested queries and report detector/engine disagreements.
 *
 * ## Why roles are derived, not authored
 *
 * A trigger is a query the rule's detector fires on; a control is one it stays
 * silent on. That is mechanically checkable, so it is checked rather than declared:
 * the enforced corpus's hand-set `role` field carries a reviewer's intent, but for
 * a harvested corpus of 100+ queries hand-labelling is both the bottleneck and a
 * source of error. This script reads the detector report the OSD runner already
 * produces and labels from it.
 *
 * Deriving roles is safe. Deriving EXPECTATIONS would not be: an expectation
 * auto-set from current behavior can only ever confirm current behavior, locking in
 * whatever the detector does today including its bugs. So this script pins nothing
 * and never fails a build. It emits findings.
 *
 * ## The finding it exists for
 *
 * With both halves observed, the interesting cell needs no expected output at all:
 *
 *     detector   engine     meaning
 *     silent     rejects    possible FALSE NEGATIVE
 *     fires      accepts    possible FALSE POSITIVE
 *     fires      rejects    agreement
 *     silent     accepts    agreement
 *
 * "Possible", not "confirmed", and the asymmetry is deliberate. A false positive
 * is nearly conclusive: the engine ran the query fine and the linter called it
 * broken. A false negative is much weaker — the engine may have rejected the query
 * for a reason that has nothing to do with this rule (an unknown field, an index
 * that does not exist, a command the version predates), in which case the linter
 * was right to stay quiet. Both are reported, ranked, and neither is ever asserted.
 *
 * ## What this feeds
 *
 * `classifyRelaxationScope` needs several triggers per rule to tell a FULL engine
 * fix (version-scope the rule away) from a PARTIAL one (narrow the detector). This
 * corpus is where that trigger variety comes from. For that use it needs only
 * "does any trigger still get rejected" — a single counterexample settles the
 * question, which is why no pinned verdict is required.
 *
 * Usage:
 *   node scripts/ppl-lint/label-discovery.mjs \
 *     --corpus discovery-corpus.json \
 *     --detector discovery-detector-report.json \
 *     --backend discovery-backend-report.json \
 *     --fixture-fields account-fields.json \
 *     --out discovery-findings.json [--summary $GITHUB_STEP_SUMMARY]
 */

import fs from 'fs';

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[ppl-lint-discovery] ${message}`);
}

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-discovery] FATAL: ${message}`);
  process.exit(2);
}

/** Roles a harvested query can be assigned. */
export const ROLES = {
  TRIGGER: 'trigger',
  CONTROL: 'control',
  UNKNOWN: 'unknown',
};

/** Finding kinds, ranked by how conclusive they are. */
export const FINDINGS = {
  FALSE_POSITIVE: 'possible-false-positive',
  FALSE_NEGATIVE: 'possible-false-negative',
};

function parseArgs(argv) {
  const args = {
    corpus: '',
    detector: '',
    backend: '',
    fixtureFields: '',
    out: 'discovery-findings.json',
    summary: '',
    version: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fatal(`${arg} requires a value`);
      return value;
    };
    if (arg === '--corpus') args.corpus = next();
    else if (arg === '--detector') args.detector = next();
    else if (arg === '--backend') args.backend = next();
    else if (arg === '--fixture-fields') args.fixtureFields = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--summary') args.summary = next();
    else if (arg === '--version') args.version = next();
    else fatal(`unknown argument "${arg}"`);
  }
  if (!args.corpus) fatal('--corpus is required');
  if (!args.detector) fatal('--detector is required');
  return args;
}

function readJson(file, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    if (optional) return undefined;
    fatal(`expected file not found: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (optional) return undefined;
    fatal(`could not parse ${file}: ${error.message}`);
  }
  return undefined;
}

/**
 * Reasons an engine rejection tells us nothing about the rule under test.
 *
 * This is the guard that keeps the false-negative side honest. A harvested query
 * mentions whatever fields its original OSD unit test invented, and those rarely
 * exist in the SQL integ-test index. The engine then rejects for an unknown field
 * — and reading that as "the engine rejects this, so the silent detector is a false
 * negative" would generate a finding per harvested query and bury the real ones.
 *
 * Also excluded: a command the engine version does not have. Same logic as the
 * enforced corpus's control-also-rejected guard — "unsupported command" is not
 * evidence about a rule's specific condition.
 */
export const UNINFORMATIVE_REJECTION_PATTERNS = [
  { re: /can't resolve|cannot resolve|unknown field|no such field|field \[[^\]]+\] not found/i, why: 'unknown field' },
  { re: /IndexNotFoundException|no such index|index \[[^\]]+\] (does not exist|not found)/i, why: 'missing index' },
  { re: /unsupported (command|operation)|is not supported|not yet supported/i, why: 'unsupported command' },
  { re: /SyntaxCheckException|ParseException|mismatched input|extraneous input/i, why: 'syntax error' },
];

/**
 * Is this rejection informative about the rule, or an artifact of the harvested
 * query not fitting the fixture? Returns the reason it is uninformative, or null.
 *
 * A syntax error counts as uninformative on purpose. A harvested query that the
 * grammar cannot even parse says nothing about a semantic rule — and after index
 * remapping some harvested queries genuinely are malformed (a join whose right-hand
 * index was a bare identifier the remap could not reach). Treating those as
 * evidence would be the vacuous-finding equivalent of a timed-out leg.
 */
export function uninformativeRejection(backendType, backendReason) {
  const text = `${backendType || ''} ${backendReason || ''}`;
  for (const { re, why } of UNINFORMATIVE_REJECTION_PATTERNS) {
    if (re.test(text)) return why;
  }
  return null;
}

/**
 * Label one query and decide whether it is a finding.
 *
 * `detectorCount` and `backendRejected` come from the two observation halves.
 * `backendRejected === undefined` means no verdict arrived, which is a third state:
 * the query is labelled but produces no finding, because a leg that did not answer
 * must never generate linter advice.
 */
export function labelQuery({
  ruleId,
  query,
  detectorCount,
  backendRejected,
  backendType,
  backendReason,
  severities = [],
}) {
  const fired = (detectorCount || 0) > 0;
  // An advisory diagnostic is one the engine will never contradict: `info` severity
  // marks cost or non-determinism, not an error the engine would refuse. Read from
  // the severities the detector actually EMITTED rather than from the catalog, so a
  // rule that emits mixed severities is judged on what this query produced.
  const advisory = fired && severities.length > 0 && severities.every((s) => s === 'info');
  const role = fired ? ROLES.TRIGGER : ROLES.CONTROL;
  const base = {
    ruleId,
    query,
    role,
    detectorCount: detectorCount || 0,
    backendRejected,
    severities,
  };

  // No engine verdict: label the role (which only needs the detector) but claim
  // nothing about correctness.
  if (typeof backendRejected !== 'boolean') {
    return { ...base, role: fired ? ROLES.TRIGGER : ROLES.UNKNOWN, finding: null, unobserved: true };
  }

  // Detector fires, engine accepts → the linter called a working query broken.
  // Nearly conclusive: nothing about the fixture can make a query the engine RAN
  // into a rule violation.
  //
  // EXCEPT for advisory rules. `head-without-sort` (info) and `rex-scan-cost` (info)
  // flag non-determinism and cost — things the engine executes happily and will
  // never reject. For those, "engine accepts + detector fires" is the rule working
  // exactly as designed, not a false positive. Without this the report is dominated
  // by every advisory rule's every trigger, and the real findings are unreadable.
  //
  // Severity is the discriminator because it already encodes the distinction: an
  // error/warning rule asserts the engine will refuse or mishandle the query, and
  // only such a claim can be contradicted by the engine accepting it.
  if (fired && backendRejected === false) {
    if (advisory) {
      return { ...base, finding: null, advisory: true };
    }
    return {
      ...base,
      finding: {
        kind: FINDINGS.FALSE_POSITIVE,
        evidence:
          `the engine ACCEPTED this query but "${ruleId}" emitted ${detectorCount} diagnostic(s). ` +
          `A user running this query sees an error marker on a query that works.`,
      },
    };
  }

  // Detector silent, engine rejects → possible missed diagnostic, but only if the
  // rejection is about something this rule could have caught.
  if (!fired && backendRejected === true) {
    const uninformative = uninformativeRejection(backendType, backendReason);
    if (uninformative) {
      return { ...base, finding: null, suppressed: uninformative };
    }
    return {
      ...base,
      finding: {
        kind: FINDINGS.FALSE_NEGATIVE,
        evidence:
          `the engine REJECTED this query (${backendType || 'error'}: ${backendReason || 'no reason'}) ` +
          `and "${ruleId}" stayed silent. VERIFY the rejection is this rule's condition before acting — ` +
          `a rejection for an unrelated reason is not a missed diagnostic.`,
      },
    };
  }

  return { ...base, finding: null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = readJson(args.corpus);
  const detectorReport = readJson(args.detector);
  const backendReport = readJson(args.backend, { optional: true });

  if (corpus.enforced) {
    // A corpus that claims to be enforced does not belong on this path: this script
    // pins nothing and exits zero, so running it over the enforced corpus would
    // look like validation while asserting nothing.
    fatal('--corpus is marked enforced; this script only labels the discovery corpus.');
  }

  const detectorByKey = new Map();
  for (const row of detectorReport.results || []) {
    detectorByKey.set(`${row.ruleId}::${row.queryName}`, row);
  }
  const backendByKey = new Map();
  for (const row of Array.isArray(backendReport) ? backendReport : []) {
    backendByKey.set(`${row.ruleId}::${row.queryName}`, row);
  }

  const labelled = [];
  for (const [i, entry] of (corpus.queries || []).entries()) {
    const queryName = entry.name || `discovery-${i}`;
    const key = `${entry.ruleId}::${queryName}`;
    const detectorRow = detectorByKey.get(key);
    const backendRow = backendByKey.get(key);
    // Same three-state read as the enforced aggregator: `outcome: "error"` carries
    // no verdict, and coercing that absence to "accepted" would manufacture a
    // false-positive finding out of a network blip.
    const hasVerdict =
      !!backendRow &&
      backendRow.outcome !== 'error' &&
      (typeof backendRow.rejected === 'boolean' || !!backendRow.observed);

    labelled.push({
      ...labelQuery({
        ruleId: entry.ruleId,
        query: entry.query,
        detectorCount: detectorRow ? detectorRow.actual : undefined,
        severities: (detectorRow && detectorRow.severities) || [],
        backendRejected: hasVerdict ? !!backendRow.rejected : undefined,
        backendType: backendRow && backendRow.observed ? backendRow.observed.type : undefined,
        backendReason: backendRow && backendRow.observed ? backendRow.observed.reason : undefined,
      }),
      queryName,
      source: entry.source,
      noDetectorRow: !detectorRow,
    });
  }

  const findings = labelled.filter((l) => l.finding);
  const byRule = new Map();
  for (const coverage of corpus.ruleCoverage || []) {
    byRule.set(coverage.ruleId, {
      triggers: [],
      controls: [],
      unknown: [],
      suppressed: 0,
      files: new Set(coverage.filesScanned || []),
      explicitException: coverage.explicitException || null,
    });
  }
  for (const row of labelled) {
    if (!byRule.has(row.ruleId)) {
      byRule.set(row.ruleId, {
        triggers: [],
        controls: [],
        unknown: [],
        suppressed: 0,
        files: new Set(),
        explicitException: null,
      });
    }
    const bucket = byRule.get(row.ruleId);
    if (row.source) bucket.files.add(row.source.split(':')[0]);
    if (row.suppressed) bucket.suppressed++;
    if (row.role === ROLES.TRIGGER) bucket.triggers.push(row.queryName);
    else if (row.role === ROLES.CONTROL) bucket.controls.push(row.queryName);
    else bucket.unknown.push(row.queryName);
  }

  const report = {
    schemaVersion: 1,
    kind: 'discovery-findings',
    enforced: false,
    engineVersion: args.version || detectorReport.engineVersion || null,
    surface: detectorReport.surface || null,
    // Whether an engine half was supplied at all. Without it the run yields trigger
    // counts but structurally cannot yield findings, and the report has to say which
    // of those two it is.
    differential: backendByKey.size > 0,
    stats: {
      queries: labelled.length,
      triggers: labelled.filter((l) => l.role === ROLES.TRIGGER).length,
      controls: labelled.filter((l) => l.role === ROLES.CONTROL).length,
      unknown: labelled.filter((l) => l.role === ROLES.UNKNOWN).length,
      suppressed: labelled.filter((l) => l.suppressed).length,
      // Advisory triggers the engine accepted. Counted so the number is visible: it
      // is the single largest category the filter removes, and a silent removal
      // would make the corpus look smaller than it is.
      advisory: labelled.filter((l) => l.advisory).length,
      findings: findings.length,
      falsePositives: findings.filter((f) => f.finding.kind === FINDINGS.FALSE_POSITIVE).length,
      falseNegatives: findings.filter((f) => f.finding.kind === FINDINGS.FALSE_NEGATIVE).length,
    },
    // Per-rule trigger counts are the payload the relaxation rollup consumes: a
    // rule with several triggers can distinguish a partial engine fix from a full
    // one, and a rule with one cannot.
    triggerCoverage: [...byRule]
      .map(([ruleId, b]) => ({
        ruleId,
        filesScanned: [...b.files].sort(),
        triggers: b.triggers.length,
        controls: b.controls.length,
        unknown: b.unknown.length,
        suppressed: b.suppressed,
        unattributedQueryCount: (corpus.stats && corpus.stats.unowned) || 0,
        explicitException: b.explicitException,
        coverageSatisfied:
          b.triggers.length + b.controls.length + b.unknown.length > 0 ||
          !!b.explicitException,
        // Below two triggers, "every trigger relaxed" is a single observation and
        // cannot support a version-scoping decision. Flagged so the gap is visible
        // rather than implied by a number nobody reads.
        sufficientForScopeDecision: b.triggers.length >= 2,
      }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    findings: findings.map((f) => ({
      ruleId: f.ruleId,
      kind: f.finding.kind,
      evidence: f.finding.evidence,
      query: f.query,
      source: f.source,
    })),
    labelled,
  };

  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(`wrote ${args.out}`);

  const markdown = renderMarkdown(report);
  // eslint-disable-next-line no-console
  console.log(markdown);
  if (args.summary) {
    try {
      fs.appendFileSync(args.summary, markdown + '\n');
    } catch (error) {
      log(`WARN: could not write summary to ${args.summary}: ${error.message}`);
    }
  }

  // ALWAYS exit zero. This corpus has no reviewed expectations, so a finding here
  // is a lead to investigate, not a proven defect — failing the build on it would
  // block unrelated PRs on the strength of an auto-generated guess.
  log(
    `discovery: ${report.stats.findings} finding(s) from ${report.stats.queries} query(s) ` +
      `(${report.stats.falsePositives} possible false positive(s), ` +
      `${report.stats.falseNegatives} possible false negative(s)); ` +
      `${report.stats.suppressed} rejection(s) suppressed as uninformative, ` +
      `${report.stats.advisory} advisory trigger(s) excluded. Not enforced.`
  );
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('## PPL lint discovery corpus (not enforced)');
  lines.push('');
  lines.push(
    `Engine \`${report.engineVersion || 'unknown'}\`${report.surface ? ` (${report.surface})` : ''} — ` +
      `${report.stats.queries} harvested query(s): ${report.stats.triggers} trigger, ` +
      `${report.stats.controls} control, ${report.stats.unknown} unknown. ` +
      `**${report.stats.findings} finding(s)** — these are LEADS, not failures.`
  );
  lines.push('');
  // Without an engine half there is nothing to disagree WITH, so the run can only
  // count triggers. Saying so beats printing "0 finding(s)" next to a large corpus,
  // which reads as "everything agrees" when in fact nothing was compared.
  if (!report.differential) {
    lines.push(
      '> No engine verdicts were supplied, so no agreement was checked and no finding can be ' +
        'produced. Trigger counts below are still valid — they come from the detector alone.'
    );
    lines.push('');
  }

  if (report.stats.findings > 0) {
    lines.push('### Findings');
    lines.push('');
    // False positives first: a query the engine ran successfully but the linter
    // marked broken is nearly conclusive, while a false negative may be a rejection
    // for an unrelated reason.
    const order = [FINDINGS.FALSE_POSITIVE, FINDINGS.FALSE_NEGATIVE];
    for (const kind of order) {
      const group = report.findings.filter((f) => f.kind === kind);
      if (group.length === 0) continue;
      lines.push(`#### ${kind} (${group.length})`);
      for (const f of group) {
        lines.push(`- \`${f.ruleId}\`: ${f.evidence}`);
        lines.push(`  QUERY: \`${f.query}\``);
        if (f.source) lines.push(`  HARVESTED FROM: ${f.source}`);
      }
      lines.push('');
    }
  }

  lines.push('### Trigger coverage');
  lines.push('');
  lines.push('Whether each rule has enough triggers to tell a PARTIAL engine fix from a FULL one.');
  lines.push('');
  lines.push('| Rule | Triggers | Controls | Enough for a scope decision? |');
  lines.push('| ---- | -------- | -------- | ---------------------------- |');
  for (const row of report.triggerCoverage) {
    // Zero triggers and one trigger are different problems and must not read the
    // same. No trigger at all means this corpus proves nothing about the rule —
    // usually that the harvested queries are all controls, or that the detector
    // never fired because it is gated off on this surface. One trigger means the
    // rule is observable but a "fully relaxed" verdict would rest on a single case.
    let verdict;
    if (row.triggers === 0) {
      verdict = '**none — no trigger observed**';
    } else if (row.triggers === 1) {
      verdict = '**no — 1 trigger only**';
    } else {
      verdict = 'yes';
    }
    lines.push(`| \`${row.ruleId}\` | ${row.triggers} | ${row.controls} | ${verdict} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// Importable for unit tests; only runs the CLI when executed directly.
if (process.argv[1] && process.argv[1].endsWith('label-discovery.mjs')) {
  main();
}
