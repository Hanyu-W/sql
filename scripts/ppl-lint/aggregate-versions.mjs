/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-version aggregation for the PPL lint contract.
 *
 * The single-version workflow answers "do the OSD detectors and this engine
 * agree?". This script answers the question that actually protects users: "does
 * every default-ERROR rule still agree with EVERY supported engine version, and
 * if not, what should the linter engineer change?"
 *
 * Inputs: one `--leg <version>=<dir>` per engine version, where <dir> holds that
 * leg's `target.json`, `backend-report.json`, `detector-report.json` and
 * `ppl-grammar-bundle.json` (the same four files the single-version jobs already
 * produce — this script adds no new producer).
 *
 * Output: a `drift-report.json` plus a markdown remediation report. Exits
 * non-zero when any ENFORCED rule drifted on any version, so the check is red
 * exactly when a shipped default-error rule disagrees with a supported engine.
 *
 * Usage:
 *   node scripts/ppl-lint/aggregate-versions.mjs \
 *     --contracts integ-test/src/test/resources/ppl-lint/contracts \
 *     --leg 3.6.0=legs/3.6.0 --leg 3.7.0=legs/3.7.0 --leg 3.8.0=legs/3.8.0 \
 *     --out drift-report.json [--summary $GITHUB_STEP_SUMMARY] [--all-rules]
 *
 * By default only the manifest's `defaultError` set is enforced; `--all-rules`
 * widens the report (still only enforcing `defaultError`) for nightly coverage.
 */

import fs from 'fs';
import path from 'path';

import {
  classifyDrift,
  classifyGrammarDrift,
  formatDriftReport,
  versionInAppliesTo,
} from './drift.mjs';

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[ppl-lint-multiversion] ${message}`);
}

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-multiversion] FATAL: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { legs: [], contracts: '', out: 'drift-report.json', summary: '', allRules: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fatal(`${arg} requires a value`);
      return value;
    };
    if (arg === '--leg') {
      const raw = next();
      const eq = raw.indexOf('=');
      if (eq <= 0) fatal(`--leg expects <version>=<dir>, got "${raw}"`);
      args.legs.push({ version: raw.slice(0, eq), dir: raw.slice(eq + 1) });
    } else if (arg === '--contracts') {
      args.contracts = next();
    } else if (arg === '--out') {
      args.out = next();
    } else if (arg === '--summary') {
      args.summary = next();
    } else if (arg === '--all-rules') {
      args.allRules = true;
    } else {
      fatal(`unknown argument "${arg}"`);
    }
  }
  if (args.legs.length === 0) fatal('at least one --leg <version>=<dir> is required');
  if (!args.contracts) fatal('--contracts <dir> is required');
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

/** Load the contract corpus, keyed by ruleId, plus the manifest's enforced sets. */
function loadContracts(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const specs = new Map();
  for (const name of manifest.contracts || []) {
    const spec = readJson(path.join(dir, name));
    specs.set(spec.ruleId, { spec, file: name });
  }
  // `defaultError` is the multi-version enforced set: every rule that ships
  // enabled at error severity. Fall back to `enforced` for older manifests so
  // this script still runs against an un-migrated corpus.
  const enforcedFiles = new Set(manifest.defaultError || manifest.enforced || []);
  const enforcedRules = new Set();
  for (const [ruleId, { file }] of specs) {
    if (enforcedFiles.has(file)) enforcedRules.add(ruleId);
  }
  return { specs, enforcedRules, manifest };
}

/**
 * Read one engine version's four artifacts. A leg whose backend never came up
 * is fatal rather than skipped: silently dropping a version would turn a broken
 * matrix into a green check, which is the failure mode this whole contract
 * exists to prevent.
 */
function loadLeg({ version, dir }) {
  const target = readJson(path.join(dir, 'target.json'));
  const detector = readJson(path.join(dir, 'detector-report.json'));
  const backendRaw = readJson(path.join(dir, 'backend-report.json'));
  const bundle = readJson(path.join(dir, 'ppl-grammar-bundle.json'), { optional: true });

  const backend = new Map();
  for (const entry of Array.isArray(backendRaw) ? backendRaw : []) {
    backend.set(`${entry.ruleId}::${entry.queryName}`, entry);
  }

  // The engine's self-reported version wins over the matrix label, so a matrix
  // typo (asking for 3.7.0 and getting 3.8.0) cannot silently mislabel results.
  const reported = target.engineVersion || '';
  if (reported && !reported.startsWith(version.split('-')[0])) {
    log(
      `WARN: leg "${version}" reported engineVersion "${reported}"; using the reported value for ` +
        `version comparisons.`
    );
  }

  return {
    version: reported || version,
    label: version,
    dir,
    grammarHash: target.grammarHash || '',
    parserRuleNames: bundle && Array.isArray(bundle.parserRuleNames) ? bundle.parserRuleNames : undefined,
    detector,
    backend,
  };
}

/**
 * Compare the OSD catalog's default-error census (recorded by each detector leg)
 * against the contracts this run knows about. Returns one entry per rule that
 * ships enabled at error severity with no contract, or whose contract the
 * manifest does not list under `defaultError`.
 *
 * Legs can disagree if they ran against different OSD checkouts, so the union is
 * used: a rule that is default-error on ANY validated OSD ref must be accounted
 * for.
 */
function auditDefaultErrorCensus(legs, specs, enforcedRules) {
  const census = new Set();
  let sawCensus = false;
  for (const leg of legs) {
    const rules = leg.detector && leg.detector.defaultErrorRules;
    if (!Array.isArray(rules)) continue;
    sawCensus = true;
    for (const ruleId of rules) census.add(ruleId);
  }
  if (!sawCensus) {
    log(
      "WARN: no detector leg reported a defaultErrorRules census, so the manifest's defaultError set " +
        'could not be cross-checked against the OSD catalog. Re-run with a detector build that emits it.'
    );
    return [];
  }

  const missing = [];
  for (const ruleId of [...census].sort()) {
    if (!specs.has(ruleId)) {
      missing.push({ ruleId, reason: 'no contract file' });
    } else if (!enforcedRules.has(ruleId)) {
      missing.push({
        ruleId,
        reason: 'contract exists but is not listed under manifest.defaultError',
      });
    }
  }
  return missing;
}

/**
 * Check an out-of-scope rule for the one drift that still matters there: the
 * engine rejects a trigger query, but the rule's `appliesTo` excludes this
 * version, so users on it see no diagnostic for a real error. Everything else
 * about an out-of-scope rule is intentional silence.
 *
 * The trigger queries come from the spec's own `queries` map (there is no
 * expectation to read on this path), and the backend observation from this leg's
 * report; `classifyDrift` decides, so the "too narrow" wording stays in one place.
 */
function classifyOutOfScope({ spec, ruleId, leg, classify }) {
  const found = [];
  for (const [queryName, queryDef] of Object.entries(spec.queries || {})) {
    if ((queryDef.role || 'trigger') !== 'trigger') continue;
    const backendEntry = leg.backend.get(`${ruleId}::${queryName}`);
    if (!backendEntry) continue; // this leg never ran the query
    const observedBackend = backendEntry.observed || {};
    const detectorResult = (leg.detector.results || []).find(
      (r) => r.ruleId === ruleId && r.queryName === queryName
    );
    const drift = classify({
      ruleId,
      version: leg.version,
      queryName,
      role: 'trigger',
      query: queryDef.query.split('{{index}}').join(spec.index),
      // Out of scope means the rule is expected to stay silent here.
      expected: { detectorCount: 0 },
      observed: {
        detectorCount: detectorResult ? detectorResult.actual : 0,
        severities: detectorResult ? detectorResult.severities || [] : [],
        backendRejected: !!backendEntry.rejected,
        backendType: observedBackend.type,
        backendReason: observedBackend.reason,
      },
      wiring: spec.wiring,
      detectorPath: spec.detectorPath,
      // Deliberately no parser-rule check here: a grammar that lacks the rule is
      // expected on an engine the command predates.
    });
    if (drift) found.push(drift);
  }
  return found;
}

/**
 * Pick the contract expectation that applies to a version, reusing the same
 * "exactly one must match" rule as the two single-version halves. Returns
 * undefined when the corpus does not cover this version — reported separately as
 * a coverage hole, not as behavioral drift.
 */
function selectExpectation(spec, version, versionMatchesRange) {
  const matches = (spec.expectations || []).filter((exp) => versionMatchesRange(exp.version, version));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Minimal semver-range test, kept byte-compatible with the other two halves. */
function makeRangeMatcher() {
  const parse = (v) => {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : undefined;
  };
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  return (range, version) => {
    if (!range || !String(range).trim()) return true;
    const have = parse(version);
    if (!have) return true;
    for (const token of String(range).trim().split(/\s+/)) {
      let op = '=';
      let ver = token;
      for (const candidate of ['>=', '<=', '>', '<', '=']) {
        if (token.startsWith(candidate)) {
          op = candidate;
          ver = token.slice(candidate.length);
          break;
        }
      }
      const c = cmp(have, parse(ver) || [0, 0, 0]);
      const ok =
        (op === '>=' && c >= 0) ||
        (op === '<=' && c <= 0) ||
        (op === '>' && c > 0) ||
        (op === '<' && c < 0) ||
        (op === '=' && c === 0);
      if (!ok) return false;
    }
    return true;
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const versionMatchesRange = makeRangeMatcher();
  const { specs, enforcedRules, manifest } = loadContracts(args.contracts);
  const legs = args.legs.map(loadLeg);

  log(`contracts=${specs.size} enforced(default-error)=${enforcedRules.size} legs=${legs.length}`);
  for (const leg of legs) {
    log(
      `  leg ${leg.label}: engine=${leg.version} grammar=${(leg.grammarHash || '—').slice(0, 19)} ` +
        `detectorResults=${(leg.detector.results || []).length} backendCases=${leg.backend.size}`
    );
  }

  const drifts = [];
  const coverageHoles = [];
  const matrix = []; // one row per rule × version, for the summary table

  // A rule that ships enabled at error severity but has no contract file is
  // invisible to this whole check. Compare the manifest's declared set against
  // the census each detector leg recorded from the OSD catalog it linted with, so
  // a new default-error rule cannot land unvalidated.
  const missingContracts = auditDefaultErrorCensus(legs, specs, enforcedRules);

  for (const [ruleId, { spec, file }] of specs) {
    const isEnforced = enforcedRules.has(ruleId);
    if (!isEnforced && !args.allRules) continue;

    // A rule the catalog does not apply to an engine version ships nothing to
    // users there, so it needs no expectation for it. Only a rule that IS in
    // scope and has no expectation is a genuine hole.
    const appliesTo = (spec.wiring && spec.wiring.appliesTo) || {};

    for (const leg of legs) {
      const inScope = versionInAppliesTo(appliesTo, leg.version);

      // A parser rule that vanished from the grammar is one fact about this
      // rule on this engine, not one per query — raise it once and move on, so
      // the report shows the single edit to make instead of the same paragraph
      // repeated for every case.
      if (inScope) {
        const grammarDrift = classifyGrammarDrift({
          ruleId,
          version: leg.version,
          requiredParserRules: spec.requiredParserRules,
          detectorPath: spec.detectorPath,
          parserRuleNames: leg.parserRuleNames,
        });
        if (grammarDrift) {
          drifts.push({ ...grammarDrift, enforced: isEnforced, contractFile: file });
          matrix.push({ ruleId, version: leg.version, status: 'drift', drifts: 1 });
          continue;
        }
      }

      const expectation = selectExpectation(spec, leg.version, versionMatchesRange);
      if (!expectation) {
        if (!inScope) {
          // Deliberately out of scope on this engine. Still run the classifier
          // for the one case that matters — an engine that rejects a trigger the
          // rule has been scoped away from (a missed diagnostic).
          const outOfScopeDrifts = classifyOutOfScope({
            spec,
            ruleId,
            leg,
            classify: classifyDrift,
          });
          for (const drift of outOfScopeDrifts) {
            drifts.push({ ...drift, enforced: isEnforced, contractFile: file });
          }
          matrix.push({
            ruleId,
            version: leg.version,
            status: outOfScopeDrifts.length > 0 ? 'drift' : 'out-of-scope',
            drifts: outOfScopeDrifts.length,
          });
          continue;
        }
        // In scope on this engine but nothing pins its behavior there.
        coverageHoles.push({ ruleId, file, version: leg.version, enforced: isEnforced });
        matrix.push({ ruleId, version: leg.version, status: 'uncovered', drifts: 0 });
        continue;
      }

      let ruleDrifts = 0;
      for (const [queryName, expected] of Object.entries(expectation.queries || {})) {
        const queryDef = (spec.queries || {})[queryName];
        if (!queryDef) continue; // the single-version halves already fail on this
        const query = queryDef.query.split('{{index}}').join(spec.index);
        const role = queryDef.role || 'trigger';

        const detectorResult = (leg.detector.results || []).find(
          (r) => r.ruleId === ruleId && r.queryName === queryName
        );
        const backendEntry = leg.backend.get(`${ruleId}::${queryName}`);
        const observedBackend = backendEntry && backendEntry.observed;

        const drift = classifyDrift({
          ruleId,
          version: leg.version,
          queryName,
          role,
          query,
          expected: {
            detectorCount: expected.detectorCount,
            severity: expected.severity,
            backendKind: expected.backend && expected.backend.kind,
          },
          observed: {
            detectorCount: detectorResult ? detectorResult.actual : 0,
            severities: detectorResult ? detectorResult.severities || [] : [],
            backendRejected: backendEntry ? !!backendEntry.rejected : undefined,
            backendType: observedBackend ? observedBackend.type : undefined,
            backendReason: observedBackend ? observedBackend.reason : undefined,
          },
          wiring: spec.wiring,
          detectorPath: spec.detectorPath,
          parserRuleNames: leg.parserRuleNames,
          requiredParserRules: spec.requiredParserRules,
          expectedBackend: expected.backend,
        });

        if (drift) {
          drifts.push({ ...drift, enforced: isEnforced, contractFile: file });
          ruleDrifts++;
        }
      }
      matrix.push({
        ruleId,
        version: leg.version,
        status: ruleDrifts === 0 ? 'agree' : 'drift',
        drifts: ruleDrifts,
      });
    }
  }

  const enforcedDrifts = drifts.filter((d) => d.enforced);
  const enforcedHoles = coverageHoles.filter((h) => h.enforced);

  const report = {
    schemaVersion: 1,
    legs: legs.map((l) => ({
      label: l.label,
      engineVersion: l.version,
      grammarHash: l.grammarHash,
    })),
    enforcedRules: [...enforcedRules].sort(),
    missingContracts,
    manifestDescription: manifest.description || '',
    matrix,
    drifts,
    coverageHoles,
    result: {
      driftCount: drifts.length,
      enforcedDriftCount: enforcedDrifts.length,
      enforcedCoverageHoles: enforcedHoles.length,
      missingContractCount: missingContracts.length,
      passed:
        enforcedDrifts.length === 0 &&
        enforcedHoles.length === 0 &&
        missingContracts.length === 0,
    },
  };

  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(`wrote ${args.out}`);

  const markdown = renderMarkdown(report, drifts, coverageHoles, legs);
  // eslint-disable-next-line no-console
  console.log(markdown);
  if (args.summary) {
    try {
      fs.appendFileSync(args.summary, markdown + '\n');
    } catch (error) {
      log(`WARN: could not write summary to ${args.summary}: ${error.message}`);
    }
  }

  if (!report.result.passed) {
    // eslint-disable-next-line no-console
    console.error(
      `[ppl-lint-multiversion] FAIL: ${enforcedDrifts.length} drift(s), ` +
        `${enforcedHoles.length} coverage hole(s) and ${missingContracts.length} unvalidated ` +
        `default-error rule(s).`
    );
    process.exit(1);
  }
  log(
    `PASS: every default-error rule agrees with all ${legs.length} engine version(s)` +
      (drifts.length > 0 ? ` (${drifts.length} non-enforced finding(s) reported)` : '') +
      '.'
  );
}

/** Rule × version agreement matrix followed by the grouped remediation report. */
function renderMarkdown(report, drifts, coverageHoles, legs) {
  const lines = [];
  lines.push('## PPL lint multi-version validation');
  lines.push('');
  lines.push(
    `Engine versions: ${legs.map((l) => `\`${l.version}\``).join(', ')} — ` +
      `**${report.result.passed ? 'PASS' : 'FAIL'}** ` +
      `(${report.result.enforcedDriftCount} enforced drift(s), ` +
      `${report.result.enforcedCoverageHoles} coverage hole(s))`
  );
  lines.push('');

  const versions = legs.map((l) => l.version);
  const rules = [...new Set(report.matrix.map((m) => m.ruleId))].sort();
  lines.push(`| Rule | ${versions.map((v) => `\`${v}\``).join(' | ')} |`);
  lines.push(`| ---- | ${versions.map(() => '----').join(' | ')} |`);
  const cell = {
    agree: 'agree',
    drift: 'DRIFT',
    uncovered: 'not covered',
    'out-of-scope': 'n/a (out of scope)',
  };
  for (const ruleId of rules) {
    const cells = versions.map((version) => {
      const row = report.matrix.find((m) => m.ruleId === ruleId && m.version === version);
      if (!row) return '—';
      return row.status === 'drift' ? `**DRIFT** (${row.drifts})` : cell[row.status];
    });
    lines.push(`| \`${ruleId}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');

  if ((report.missingContracts || []).length > 0) {
    lines.push('### Unvalidated default-error rules');
    lines.push('');
    for (const entry of report.missingContracts) {
      lines.push(
        `- \`${entry.ruleId}\` ships enabled at error severity but ${entry.reason}, so no engine ` +
          `version validates it. FIX: add \`${entry.ruleId}.spec.json\` under ` +
          `integ-test/src/test/resources/ppl-lint/contracts/ with a trigger + control query and list ` +
          `it in manifest.json under \`defaultError\`. If the rule should not be default-error, lower ` +
          `its severity or disable it in packages/osd-monaco/src/ppl/lint/rules_catalog.json.`
      );
    }
    lines.push('');
  }

  if (coverageHoles.length > 0) {
    lines.push('### Coverage holes');
    lines.push('');
    for (const hole of coverageHoles) {
      lines.push(
        `- \`${hole.ruleId}\` has no expectation matching engine \`${hole.version}\`` +
          `${hole.enforced ? ' (ENFORCED — this rule ships to users on that engine unpinned)' : ''}. ` +
          `FIX (${hole.file}): add an \`expectations[]\` entry whose \`version\` range covers ` +
          `\`${hole.version}\`, or narrow the rule's \`appliesTo\` so it does not apply there.`
      );
    }
    lines.push('');
  }

  lines.push('### Remediation');
  lines.push('');
  lines.push('```');
  lines.push(formatDriftReport(drifts));
  lines.push('```');
  return lines.join('\n');
}

main();
