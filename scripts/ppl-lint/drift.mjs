/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drift classification for the multi-version PPL lint contract.
 *
 * The contract runs every default-error lint rule against SEVERAL engine
 * versions. Detecting that a rule disagrees with an engine is only half the
 * job — a bare "expected 1 diagnostic, got 0" tells an engineer that something
 * moved but not what to do about it. This module turns one observed
 * (expected vs detector vs backend) triple into:
 *
 *   1. a drift CLASS — which of the known ways engine/linter can diverge; and
 *   2. a REMEDIATION — the concrete linter-side action, one of:
 *        disable-rule       the engine no longer has the behavior; stop shipping
 *                           the diagnostic (or scope it to older versions)
 *        version-scope-rule the behavior is version-bounded; fix appliesTo
 *        update-detector    the detector's own logic/anchor is now wrong
 *        update-contract    the linter is right; the pinned expectation is stale
 *
 * The classifier is deliberately pure and side-effect free so it can be unit
 * tested without a cluster (see __tests__/drift.test.mjs). The runner supplies
 * observations; this module decides nothing about how they were gathered.
 *
 * Naming: a "trigger" query is one the rule is supposed to flag; a "control" is
 * a near-identical valid query it must stay silent on. `role` distinguishes them.
 */

/** Every drift class this module can emit, with a stable one-line meaning. */
export const DRIFT_CLASSES = {
  GRAMMAR_RULE_MISSING: 'grammar-rule-missing',
  EXECUTION_BACKEND_DIVERGENCE: 'execution-backend-divergence',
  BACKEND_ORACLE_MISMATCH: 'backend-oracle-mismatch',
  ENGINE_RELAXED: 'engine-relaxed',
  ENGINE_PARTIALLY_RELAXED: 'engine-partially-relaxed',
  ENGINE_TIGHTENED: 'engine-tightened',
  ENGINE_MESSAGE_CHANGED: 'engine-message-changed',
  DETECTOR_SILENT: 'detector-silent',
  DETECTOR_NOISY: 'detector-noisy',
  DETECTOR_COUNT_MISMATCH: 'detector-count-mismatch',
  DETECTOR_MESSAGE_MISMATCH: 'detector-message-mismatch',
  VERSION_SCOPE_TOO_NARROW: 'version-scope-too-narrow',
  SEVERITY_MISMATCH: 'severity-mismatch',
};

/** Remediation actions, phrased as what the linter engineer changes. */
export const REMEDIATIONS = {
  ALIGN_EXECUTION_BACKENDS: 'align-execution-backends',
  DISABLE_RULE: 'disable-rule',
  VERSION_SCOPE_RULE: 'version-scope-rule',
  UPDATE_DETECTOR: 'update-detector',
  UPDATE_CONTRACT: 'update-contract',
  REVIEW_BACKEND_ORACLE: 'review-backend-oracle',
};

/** OSD paths an engineer edits, kept in one place so a move is a one-line fix. */
const OSD_PATHS = {
  catalog: 'packages/osd-monaco/src/ppl/lint/rules_catalog.json',
  ruleDir: 'packages/osd-monaco/src/ppl/lint/rules/',
  ruleIndex: 'packages/osd-monaco/src/ppl/lint/rule_index.ts',
};

/**
 * Path of the detector implementation for a rule.
 *
 * Most rules follow the snake_case-of-the-id convention, but not all: the
 * catalog id `unsupported-window-function-in-eventstats` lives in
 * `unsupported_window_function.ts`. A remediation that names a file the engineer
 * cannot open is worse than one that names a directory, so a contract may pin the
 * real path via `detectorPath` and we fall back to the convention otherwise.
 */
function detectorFile(ruleId, detectorPath) {
  if (detectorPath) {
    return detectorPath;
  }
  return `${OSD_PATHS.ruleDir}${String(ruleId).replace(/-/g, '_')}.ts`;
}

/**
 * Cheap edit-distance, used only to suggest "did the grammar rename X to Y?".
 * Bounded by the shorter string, so it is O(n*m) on short identifiers.
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[n];
}

/** Split a camelCase parser rule name into lower-case tokens. */
function camelTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Best candidates for a parser rule that vanished from the candidate grammar.
 *
 * Ranked by how a real ANTLR rename tends to look, strongest signal first:
 *   0. containment            `unionCommand` -> `unionCommandNew`
 *   1. same leading token     `unionCommand` -> `unionStatement`
 *   2. near spelling          `rexCommand`   -> `regexCommand`
 *
 * The leading token carries the identity of the rule; the trailing one is
 * usually a generic suffix (`Command`, `Clause`, `Expression`) shared by most of
 * the grammar, so matching on it alone would suggest dozens of unrelated rules.
 * That is why only the FIRST token counts, and why an unrelated rule returns
 * nothing rather than a plausible-looking wrong guess.
 */
export function suggestParserRules(missingRule, availableRules, limit = 3) {
  const missing = String(missingRule);
  const lower = missing.toLowerCase();
  const missingHead = camelTokens(missing)[0];
  const scored = [];
  for (const candidate of availableRules) {
    const cl = String(candidate).toLowerCase();
    let score;
    if (cl.includes(lower) || lower.includes(cl)) {
      score = 0; // containment: strongest signal of a rename
    } else if (missingHead && camelTokens(candidate)[0] === missingHead) {
      score = 1; // same subject, renamed suffix
    } else {
      // Only very near spellings survive this tier. A looser budget scaled to
      // name length lets long names match unrelated same-suffix rules
      // (`unionCommand` vs `binCommand` differ by 4 edits but are unrelated), so
      // the cap is absolute: typo-or-insertion distance, nothing more.
      const distance = editDistance(lower, cl);
      if (distance > 2) continue;
      score = 1 + distance;
    }
    scored.push({ candidate, score });
  }
  scored.sort((a, b) => a.score - b.score || String(a.candidate).localeCompare(String(b.candidate)));
  return scored.slice(0, limit).map((s) => s.candidate);
}

/** Parse "3.8.0-SNAPSHOT" / "3.7" into [major, minor, patch]; undefined if unparseable. */
export function parseVersion(value) {
  if (!value) return undefined;
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value));
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

export function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * True when `version` falls inside the catalog's `appliesTo` window. An absent
 * bound is open-ended, and an unparseable version is treated as in-range so an
 * unrecognized engine build never silently drops coverage.
 */
export function versionInAppliesTo(appliesTo, version) {
  const have = parseVersion(version);
  if (!have) return true;
  const min = parseVersion(appliesTo && appliesTo.minVersion);
  const max = parseVersion(appliesTo && appliesTo.maxVersion);
  if (min && compareVersion(have, min) < 0) return false;
  // maxVersion is treated as inclusive, matching the OSD catalog's own reading.
  if (max && compareVersion(have, max) > 0) return false;
  return true;
}

/** Human-readable one-liner for the observed pair, reused across messages. */
function describeObservation(observed) {
  const detector = observed.detectorCount > 0 ? `flagged (${observed.detectorCount})` : 'silent';
  let backend = 'accepted';
  if (observed.backendRejected) {
    const type = observed.backendType ? ` ${observed.backendType}` : '';
    backend = `rejected${type}`;
  } else if (observed.backendRejected === undefined) {
    backend = 'not observed';
  }
  return `detector ${detector}, engine ${backend}`;
}

function describeBackendVerdict(observed) {
  if (!observed || typeof observed.backendRejected !== 'boolean') {
    return 'did not produce a verdict';
  }
  if (!observed.backendRejected) {
    return 'ACCEPTED';
  }
  const type = observed.backendType ? ` (${observed.backendType})` : '';
  return `REJECTED${type}`;
}

function executionBackendRemediation(ruleId, detectorPath) {
  return {
    action: REMEDIATIONS.ALIGN_EXECUTION_BACKENDS,
    target: `analytics backend and ${detectorFile(ruleId, detectorPath)}`,
    detail:
      `Keep the OpenSearch version bounds unchanged. Review the route-specific backend oracles, ` +
      `then either align analytics behavior with standard, narrow the detector to behavior common ` +
      `to both routes, disable the rule for every route, or add a reliable execution-backend signal ` +
      `to the lint context before emitting route-specific diagnostics.`,
  };
}

/**
 * Compare the two execution routes for one query on the same engine candidate.
 * This is deliberately separate from product-version drift: a route difference
 * cannot justify changing an OpenSearch version range.
 */
export function classifyExecutionBackendDivergence({
  ruleId,
  version,
  queryName,
  role = 'trigger',
  query,
  standardObserved,
  analyticsObserved,
  standardLeg,
  analyticsLeg,
  grammarHash,
  detectorPath,
}) {
  if (
    !standardObserved ||
    !analyticsObserved ||
    typeof standardObserved.backendRejected !== 'boolean' ||
    typeof analyticsObserved.backendRejected !== 'boolean' ||
    standardObserved.backendRejected === analyticsObserved.backendRejected
  ) {
    return null;
  }

  const where = `${ruleId} @ ${version} [${queryName}]`;
  return {
    ruleId,
    version,
    driftVersion: version,
    queryName,
    role,
    query,
    executionBackend: 'analytics',
    baselineExecutionBackend: 'standard',
    executionBackends: ['standard', 'analytics'],
    driftClass: DRIFT_CLASSES.EXECUTION_BACKEND_DIVERGENCE,
    evidence:
      `${where}: standard ${describeBackendVerdict(standardObserved)} while analytics ` +
      `${describeBackendVerdict(analyticsObserved)} on the same engine candidate and runtime ` +
      `grammar${grammarHash ? ` (${grammarHash})` : ''}` +
      `${standardLeg || analyticsLeg ? `; legs ${standardLeg || 'standard'} / ${analyticsLeg || 'analytics'}` : ''}.`,
    remediation: executionBackendRemediation(ruleId, detectorPath),
  };
}

function backendOracleRemediation(executionBackend) {
  return {
    action: REMEDIATIONS.REVIEW_BACKEND_ORACLE,
    target: `${executionBackend} backend and this contract file`,
    detail:
      `Review the captured raw response and determine whether the backend regressed or the reviewed ` +
      `${executionBackend} oracle is stale. Restore the backend behavior when the status/result change ` +
      `is unintended; update the oracle only after confirming the new behavior is intentional. Keep ` +
      `the OpenSearch version bounds unchanged.`,
  };
}

function classifyAnalyticsOracleMismatch({
  ruleId,
  version,
  queryName,
  role,
  query,
  observed,
  expectedRejected,
  detectorPath,
  reason,
}) {
  const expected = expectedRejected ? 'REJECTION' : 'ACCEPTANCE';
  return {
    ruleId,
    version,
    driftVersion: version,
    queryName,
    role,
    query,
    executionBackend: 'analytics',
    executionBackends: ['analytics'],
    driftClass: DRIFT_CLASSES.BACKEND_ORACLE_MISMATCH,
    evidence:
      `${ruleId} @ ${version} [${queryName}]: analytics ${describeBackendVerdict(observed)}, ` +
      `but ${reason || `its reviewed oracle requires ${expected}`}.`,
    remediation: backendOracleRemediation('analytics'),
  };
}

/**
 * Report a parser rule the detector walks that the candidate grammar no longer
 * defines. Exported so a caller can raise it ONCE per rule/version — the fact is
 * a property of the grammar, not of any single query, and repeating it per query
 * buries the one edit an engineer has to make. `classifyDrift` still calls it so
 * a caller that does not hoist the check keeps the diagnosis.
 */
export function classifyGrammarDrift({
  ruleId,
  version,
  requiredParserRules,
  parserRuleNames,
  observed = {},
  queryName,
  role = 'trigger',
  query,
  detectorPath,
  executionBackend = 'standard',
}) {
  if (!Array.isArray(requiredParserRules) || !Array.isArray(parserRuleNames)) {
    return null;
  }
  const available = new Set(parserRuleNames);
  const missing = requiredParserRules.filter((rule) => !available.has(rule));
  if (missing.length === 0) {
    return null;
  }
  const missingList = missing.map((r) => `"${r}"`).join(', ');
  const suggestions = [...new Set(missing.flatMap((rule) => suggestParserRules(rule, parserRuleNames)))];
  const at = queryName ? ` [${queryName}]` : '';
  return {
    ruleId,
    version,
    driftVersion: version,
    queryName,
    role,
    query,
    executionBackend,
    driftClass: DRIFT_CLASSES.GRAMMAR_RULE_MISSING,
    evidence:
      `${ruleId} @ ${version} (${executionBackend})${at}: the candidate grammar has no parser rule(s) ${missingList}, ` +
      `which this rule's detector walks.` +
      (observed && observed.detectorCount !== undefined ? ` ${describeObservation(observed)}.` : ''),
    remediation: {
      action: REMEDIATIONS.UPDATE_DETECTOR,
      target: detectorFile(ruleId, detectorPath),
      detail:
        `The engine grammar renamed or removed ${missingList}. ` +
        (suggestions.length > 0
          ? `Closest rule(s) now in the grammar: ${suggestions.map((r) => `"${r}"`).join(', ')}. `
          : '') +
        `Re-anchor the detector (and ${OSD_PATHS.ruleIndex} if the name is listed there) onto the ` +
        `current rule name, then update this contract's requiredParserRules. If the command itself ` +
        `is gone from the engine, disable the rule instead.`,
    },
  };
}

/**
 * Decide, for ONE rule on ONE engine version, whether an observed relaxation is
 * total or partial — the difference between "scope the rule away from this
 * version" and "narrow the detector".
 *
 * `classifyDrift` sees a single query, so it cannot tell these apart: one trigger
 * that the engine now accepts looks identical whether the rule's other triggers
 * still fail or not. Acting on that one query is actively harmful in the partial
 * case, because scoping the rule out of the version drops the diagnostics that
 * are STILL correct — turning a partial engine fix into a false negative on the
 * shapes that remain broken. That is why this runs over the whole rule.
 *
 * Inputs are the per-trigger verdicts the caller already gathered:
 *   relaxed   engine ACCEPTS a trigger the contract pinned as rejected
 *   holding   engine still REJECTS the trigger
 * Triggers with no usable verdict are passed as neither, and are reported as the
 * reason a verdict is being withheld rather than silently treated as `holding`
 * (which would read a dead leg as a partial fix and narrow a healthy detector).
 *
 * Returns null when nothing relaxed — the caller's per-query drifts stand on
 * their own. Otherwise returns ONE rule-level drift that supersedes the
 * per-query `engine-relaxed` findings, so the report shows a single decision
 * instead of one "scope this away" paragraph per trigger.
 *
 * @param {object} input
 * @param {string[]} input.relaxedTriggers  trigger names the engine now accepts
 * @param {string[]} input.holdingTriggers  trigger names the engine still rejects
 * @param {string[]} [input.unobservedTriggers] triggers with no comparable verdict
 * @param {boolean} [input.detectorFlagged] did the detector fire on any relaxed trigger
 */
export function classifyRelaxationScope({
  ruleId,
  version,
  relaxedTriggers = [],
  holdingTriggers = [],
  unobservedTriggers = [],
  detectorFlagged = false,
  wiring,
  detectorPath,
  executionBackend = 'standard',
}) {
  if (relaxedTriggers.length === 0) {
    return null;
  }

  const where = `${ruleId} @ ${version}`;
  const base = {
    ruleId,
    version,
    driftVersion: version,
    role: 'trigger',
    executionBackend,
    scope: {
      relaxed: [...relaxedTriggers],
      holding: [...holdingTriggers],
      unobserved: [...unobservedTriggers],
    },
  };
  // How thin is the basis for a "fully relaxed" claim? A rule with ONE pinned
  // trigger that relaxes proves only that one shape changed; calling that "the
  // behavior is gone" is a much bigger inference than the data supports. The
  // count goes in the evidence either way so the reader can judge it, rather
  // than the tool quietly presenting 1-of-1 as though it were 5-of-5.
  const observed = relaxedTriggers.length + holdingTriggers.length;
  const basis = `${relaxedTriggers.length} of ${observed} observed trigger(s) relaxed`;

  if (executionBackend === 'analytics') {
    return {
      ...base,
      driftClass: DRIFT_CLASSES.EXECUTION_BACKEND_DIVERGENCE,
      executionBackends: ['analytics'],
      evidence:
        `${where}: analytics accepted ${basis}; this is route-specific behavior, not product-version drift.`,
      remediation: executionBackendRemediation(ruleId, detectorPath),
    };
  }

  // --- Partial: some triggers relaxed, others still rejected ------------------
  // The engine fixed part of the condition. Scoping the rule out of this version
  // would ship a false negative on everything in `holding`, so the action is to
  // narrow the detector to the shapes that still fail.
  if (holdingTriggers.length > 0) {
    return {
      ...base,
      driftClass: DRIFT_CLASSES.ENGINE_PARTIALLY_RELAXED,
      evidence:
        `${where}: engine ${version} now ACCEPTS ${relaxedTriggers.length} of this rule's triggers ` +
        `(${relaxedTriggers.join(', ')}) but still REJECTS ${holdingTriggers.length} ` +
        `(${holdingTriggers.join(', ')}) — a PARTIAL fix, ${basis}.`,
      remediation: {
        action: REMEDIATIONS.UPDATE_DETECTOR,
        target: detectorFile(ruleId, detectorPath),
        detail:
          `Do NOT scope "${ruleId}" away from ${version}: the engine still rejects ` +
          `${holdingTriggers.join(', ')}, so a maxVersion below ${version} would drop diagnostics that ` +
          `are still correct and ship a false NEGATIVE there. Narrow the detector so it stops matching ` +
          `the now-valid shape(s) (${relaxedTriggers.join(', ')}) while still flagging the rest, then ` +
          `re-pin the ${version} expectation for the relaxed trigger(s) to detectorCount 0.`,
      },
    };
  }

  // --- Full: every observed trigger relaxed -----------------------------------
  // Nothing the rule claims is still true on this engine. Version-scoping is now
  // the right action — with the caveat that "every observed trigger" is only as
  // strong as the trigger count, which the evidence states.
  return {
    ...base,
    driftClass: DRIFT_CLASSES.ENGINE_RELAXED,
    evidence:
      `${where}: engine ${version} now ACCEPTS every observed trigger for this rule ` +
      `(${relaxedTriggers.join(', ')}) — a FULL fix, ${basis}` +
      (unobservedTriggers.length > 0
        ? `; ${unobservedTriggers.length} trigger(s) produced no verdict (${unobservedTriggers.join(', ')}) ` +
          `and were NOT counted`
        : '') +
      '.',
    remediation: detectorFlagged
      ? {
          action: REMEDIATIONS.VERSION_SCOPE_RULE,
          target: OSD_PATHS.catalog,
          detail:
            `Every trigger this contract pins is now valid on ${version}, so "${ruleId}" is a FALSE ` +
            `POSITIVE there. Set appliesTo.maxVersion just below ${version} to keep protecting users on ` +
            `older engines; if no supported engine rejects any trigger any more, set "enabled": false and ` +
            `drop the detector. Then re-pin the ${version} expectations to detectorCount 0.` +
            (observed < 2
              ? ` NOTE: this rule pins only ${observed} trigger, so "fully relaxed" rests on a single ` +
                `observation — confirm with more shapes of the same condition before scoping the rule away.`
              : '') +
            (unobservedTriggers.length > 0
              ? ` NOTE: ${unobservedTriggers.length} trigger(s) produced no verdict on this leg; re-run it ` +
                `before acting, since one of them may still reject.`
              : ''),
        }
      : {
          action: REMEDIATIONS.UPDATE_CONTRACT,
          target: 'this contract file',
          detail:
            `The detector already stays silent on ${version}, so no linter change is needed. Re-pin the ` +
            `${version} expectations to detectorCount 0 / backend.kind "result-shape" to record the ` +
            `engine's new behavior.`,
        },
  };
}

/**
 * Classify one query's outcome on one engine version.
 *
 * Returns `null` when the detector, the engine and the pinned expectation all
 * agree — the overwhelmingly common case. Otherwise returns a single drift
 * object; checks run most-specific-first so the reported cause is the root one
 * (a renamed grammar rule explains a silent detector, not the other way round).
 *
 * @param {object} input
 * @param {string} input.ruleId
 * @param {string} input.version            engine version under test, e.g. "3.7.0"
 * @param {string} input.queryName
 * @param {string} input.role               'trigger' | 'control'
 * @param {string} input.query              the query as sent to both halves
 * @param {object} input.expected           { detectorCount, severity, backendKind }
 * @param {object} input.observed           { detectorCount, severities, backendRejected, backendType, backendReason }
 * @param {object} [input.wiring]           OSD catalog entry (appliesTo, runtimeOnly, ...)
 * @param {string[]} [input.parserRuleNames] candidate grammar's parser rule names
 * @param {string[]} [input.requiredParserRules] grammar rules the detector walks
 * @param {object} [input.expectedBackend]  contract's pinned rejection body
 * @param {boolean} [input.controlAlsoRejected] true when this rule's control query was
 *   ALSO rejected on this engine, i.e. the command itself is unsupported here
 */
export function classifyDrift(input) {
  const {
    ruleId,
    version,
    queryName,
    role = 'trigger',
    query,
    expected = {},
    observed = {},
    wiring,
    parserRuleNames,
    requiredParserRules,
    expectedBackend,
    detectorPath,
    controlAlsoRejected,
    executionBackend = 'standard',
  } = input;

  const detectorFlagged = (observed.detectorCount || 0) > 0;
  const expectFlagged = (expected.detectorCount || 0) > 0;
  const backendRejected = observed.backendRejected;
  const where = `${ruleId} @ ${version} (${executionBackend}) [${queryName}]`;
  const base = { ruleId, version, queryName, role, query, driftVersion: version, executionBackend };

  // --- 1. Did the grammar move out from under the detector? -------------------
  // A detector that walks a parser rule the candidate grammar no longer defines
  // cannot fire at all. This is the root cause of an otherwise baffling silent
  // detector, so it is checked before any behavioral comparison.
  const grammarDrift = classifyGrammarDrift({
    ruleId,
    version,
    requiredParserRules,
    parserRuleNames,
    observed,
    queryName,
    role,
    query,
    detectorPath,
    executionBackend,
  });
  if (grammarDrift) {
    return grammarDrift;
  }

  // --- 2. Is the rule even in scope for this engine version? ------------------
  // A rule whose appliesTo excludes this version is intentionally inert here.
  // That is only correct if the engine also does not exhibit the behavior; if the
  // engine rejects the trigger, the version window is too narrow and users on
  // this version get no diagnostic.
  const inScope = versionInAppliesTo(wiring && wiring.appliesTo, version);
  const expectRejection = expected.backendKind === 'rejection';
  if (!inScope) {
    // A trigger the engine rejects normally means the version window is too
    // narrow. But if the rule's CONTROL — a valid query using the same command —
    // is rejected too, the command itself does not exist on this engine yet, and
    // the rejection says nothing about the rule's specific condition. Widening
    // appliesTo there would ship a diagnostic that claims a precise cause for
    // what is really "unsupported command", so that case is correctly silent:
    // the version window is doing its job.
    if (role === 'trigger' && backendRejected === true && controlAlsoRejected !== true) {
      if (executionBackend === 'analytics') {
        return classifyAnalyticsOracleMismatch({
          ruleId,
          version,
          queryName,
          role,
          query,
          observed,
          expectedRejected: false,
          detectorPath,
          reason: 'the standard product-version rule is inactive for this engine candidate',
        });
      }
      return {
        ...base,
        driftClass: DRIFT_CLASSES.VERSION_SCOPE_TOO_NARROW,
        evidence:
          `${where}: engine ${version} rejects this trigger, but the rule's appliesTo ` +
          `(${JSON.stringify((wiring && wiring.appliesTo) || {})}) excludes ${version}, so no diagnostic ` +
          `is shown to users on that version.`,
        remediation: {
          action: REMEDIATIONS.VERSION_SCOPE_RULE,
          target: OSD_PATHS.catalog,
          detail:
            `Widen "${ruleId}".appliesTo to include ${version} (lower minVersion / raise maxVersion) so the ` +
            `diagnostic reaches users on engines that actually reject the query.`,
        },
      };
    }
    // Out of scope but the detector fired anyway. `appliesTo` is applied by OSD's
    // version filter, which runs a rule when the cluster version is UNKNOWN — so a
    // user whose version could not be resolved sees a diagnostic the catalog says
    // does not apply to them. If the engine accepts the query, that is a false
    // positive reaching exactly the users the version window was meant to protect.
    if (detectorFlagged) {
      return {
        ...base,
        driftClass: DRIFT_CLASSES.DETECTOR_NOISY,
        evidence:
          `${where}: the rule's appliesTo (${JSON.stringify((wiring && wiring.appliesTo) || {})}) ` +
          `excludes ${version}, yet the detector emitted ${observed.detectorCount} diagnostic(s) ` +
          `(${describeObservation(observed)}).`,
        remediation: {
          action: REMEDIATIONS.UPDATE_DETECTOR,
          target: detectorFile(ruleId, detectorPath),
          detail:
            `A rule out of scope for ${version} must stay silent there. Check that the detector honors ` +
            `the version context rather than deciding on its own, and remember OSD's version filter runs ` +
            `a rule when the cluster version is unknown — so this also fires for users whose version ` +
            `could not be resolved.` +
            (backendRejected === true && executionBackend === 'standard'
              ? ` The engine does reject this query, so widening appliesTo in ${OSD_PATHS.catalog} may be` +
                ` the right fix instead.`
              : ''),
        },
      };
    }
    // Out of scope and the engine agrees it is a non-issue: nothing to report.
    return null;
  }

  // --- 3. Behavioral flips: the engine changed its verdict --------------------

  // 3a. The engine now ACCEPTS what the contract pinned as a rejection. Any
  // diagnostic the linter still emits is a false positive shipped to users —
  // the single most damaging drift, so it is reported even when the detector
  // count happens to match the stale expectation.
  if (role === 'trigger' && expectRejection && backendRejected === false) {
    if (executionBackend === 'analytics') {
      return classifyAnalyticsOracleMismatch({
        ruleId,
        version,
        queryName,
        role,
        query,
        observed,
        expectedRejected: true,
        detectorPath,
      });
    }
    return {
      ...base,
      // A single relaxed trigger cannot tell a full fix from a partial one, and the
      // two need OPPOSITE actions (scope the rule away vs narrow the detector). The
      // caller aggregates every trigger through `classifyRelaxationScope` and drops
      // the findings carrying this marker in favour of that one rule-level verdict.
      // Kept as a finding rather than returning null so a caller that does not
      // aggregate still reports the relaxation instead of silently passing.
      supersededBy: DRIFT_CLASSES.ENGINE_PARTIALLY_RELAXED,
      driftClass: DRIFT_CLASSES.ENGINE_RELAXED,
      evidence:
        `${where}: engine ${version} now ACCEPTS a query the contract pinned as rejected ` +
        `(${describeObservation(observed)}). The engine gained support for this construct.`,
      remediation: detectorFlagged
        ? {
            action: REMEDIATIONS.VERSION_SCOPE_RULE,
            target: OSD_PATHS.catalog,
            detail:
              `"${ruleId}" is now a FALSE POSITIVE on ${version}. Bound it to the versions that still ` +
              `reject: set appliesTo.maxVersion just below ${version}. If no supported engine rejects it ` +
              `any more, set "enabled": false (disable-rule) and drop the detector. Then re-pin this ` +
              `contract's ${version} expectation to detectorCount 0 / backend.kind "result-shape".`,
          }
        : {
            action: REMEDIATIONS.UPDATE_CONTRACT,
            target: 'this contract file',
            detail:
              `The detector already stays silent on ${version}, so no linter change is needed. Re-pin the ` +
              `${version} expectation to detectorCount 0 / backend.kind "result-shape" to record the ` +
              `engine's new behavior.`,
          },
    };
  }

  // 3b. The engine now REJECTS what the contract pinned as valid. A control that
  // started failing means the linter is silently missing a real error.
  if (!expectRejection && backendRejected === true) {
    if (executionBackend === 'analytics') {
      return classifyAnalyticsOracleMismatch({
        ruleId,
        version,
        queryName,
        role,
        query,
        observed,
        expectedRejected: false,
        detectorPath,
      });
    }
    return {
      ...base,
      driftClass: DRIFT_CLASSES.ENGINE_TIGHTENED,
      evidence:
        `${where}: engine ${version} now REJECTS a query the contract pinned as valid ` +
        `(${observed.backendType || 'error'}: ${observed.backendReason || 'no reason'}). ` +
        `${describeObservation(observed)}.`,
      remediation: detectorFlagged
        ? {
            action: REMEDIATIONS.UPDATE_CONTRACT,
            target: 'this contract file',
            detail:
              `The detector already flags this, so the linter is correct and only the pinned expectation ` +
              `is stale. Re-pin the ${version} expectation to backend.kind "rejection" with the observed ` +
              `error.type/reason, and pick a genuinely valid query for the control.`,
          }
        : {
            action: REMEDIATIONS.UPDATE_DETECTOR,
            target: detectorFile(ruleId, detectorPath),
            detail:
              `The engine rejects this but the linter is silent — a false NEGATIVE on ${version}. Extend ` +
              `the detector to cover this shape (or, if the rejection belongs to a different rule, add a ` +
              `contract case under that rule). Then re-pin this expectation.`,
          },
    };
  }

  // --- 4. Same verdict, different wording ------------------------------------
  // The engine still rejects, but the error type/reason moved. The pinned body —
  // and any detector text that quotes the engine wording — is stale. Worth
  // flagging because linter messages and quick-fix copy are written against these
  // strings.
  //
  // Requires the detector to still agree with the expectation (`detectorMatches`).
  // Without that condition a reworded message would MASK a detector that went
  // silent at the same time: the report would say "the detector's verdict is
  // unaffected, no rule change required", the engineer would re-pin the string,
  // and the check would go green over a rule that no longer fires. When both moved
  // at once, the silent detector is the more serious story and step 5 tells it.
  const detectorMatches = (observed.detectorCount || 0) === (expected.detectorCount || 0);
  if (backendRejected === true && expectRejection && expectedBackend && detectorMatches) {
    const expectedError = (expectedBackend.body && expectedBackend.body.error) || {};
    const statusChanged =
      expectedBackend.httpStatus !== undefined &&
      observed.backendStatus !== undefined &&
      expectedBackend.httpStatus !== observed.backendStatus;
    const typeChanged =
      expectedError.type !== undefined &&
      observed.backendType !== undefined &&
      expectedError.type !== observed.backendType;
    const reasonChanged =
      expectedError.reason !== undefined &&
      observed.backendReason !== undefined &&
      expectedError.reason !== observed.backendReason;
    if (statusChanged) {
      return {
        ...base,
        driftClass: DRIFT_CLASSES.BACKEND_ORACLE_MISMATCH,
        evidence:
          `${where}: the backend still rejects the query, but its HTTP status changed from ` +
          `${expectedBackend.httpStatus} to ${observed.backendStatus}.`,
        remediation: backendOracleRemediation(executionBackend),
      };
    }
    if (typeChanged || reasonChanged) {
      const parts = [];
      if (typeChanged) parts.push(`error.type "${expectedError.type}" -> "${observed.backendType}"`);
      if (reasonChanged)
        parts.push(`error.reason "${expectedError.reason}" -> "${observed.backendReason}"`);
      return {
        ...base,
        driftClass: DRIFT_CLASSES.ENGINE_MESSAGE_CHANGED,
        evidence:
          `${where}: engine ${version} still rejects the query but reworded the failure — ${parts.join('; ')}.`,
        remediation: {
          action: REMEDIATIONS.UPDATE_CONTRACT,
          target: 'this contract file',
          detail:
            `The detector's verdict is unaffected, so no rule change is required. Update the ${version} ` +
            `expectation's backend.body to the observed wording. Also check whether "${ruleId}"'s message ` +
            `or quick-fix copy in ${detectorFile(ruleId, detectorPath)} quotes the old engine wording.`,
        },
      };
    }
  }

  // Result-shape assertions and other detailed backend oracles can change while
  // the coarse accepted/rejected verdict stays the same. The Java observer
  // records that assertion failure explicitly; it must not be treated as
  // agreement merely because a boolean verdict is still available.
  if (observed.backendOutcome === 'observed-mismatch' || observed.backendOutcome === 'fail') {
    if (executionBackend === 'analytics') {
      return classifyAnalyticsOracleMismatch({
        ruleId,
        version,
        queryName,
        role,
        query,
        observed,
        expectedRejected: expectRejection,
        detectorPath,
        reason: `its reviewed backend oracle did not match: ${
          observed.backendMismatch || 'unspecified assertion mismatch'
        }`,
      });
    }
    return {
      ...base,
      driftClass: DRIFT_CLASSES.BACKEND_ORACLE_MISMATCH,
      evidence:
        `${where}: the backend kept the same coarse verdict but failed its detailed oracle — ` +
        `${observed.backendMismatch || 'unspecified assertion mismatch'}.`,
      remediation: backendOracleRemediation(executionBackend),
    };
  }

  // --- 5. Detector-only disagreements ----------------------------------------
  // The engine behaved as pinned, so any mismatch is on the linter side.
  if (expectFlagged && !detectorFlagged) {
    return {
      ...base,
      driftClass: DRIFT_CLASSES.DETECTOR_SILENT,
      evidence:
        `${where}: expected ${expected.detectorCount} diagnostic(s) but the detector produced none, ` +
        `while the engine behaved as pinned (${describeObservation(observed)}).`,
      remediation: {
        action: REMEDIATIONS.UPDATE_DETECTOR,
        target: detectorFile(ruleId, detectorPath),
        detail:
          `The engine still exhibits the behavior, so the rule is still wanted — the detector regressed. ` +
          `Check, in order: (1) appliesTo/minVersion vs engine ${version}; (2) runtimeOnly — a runtimeOnly ` +
          `rule only fires when the lint context's grammarSurface is "runtime-bundle"; (3) required lint ` +
          `context (fields/typeMap) that the detector self-suppresses without; (4) the detector's own ` +
          `traversal. Do NOT re-pin the expectation to 0 — that would hide a false negative.`,
      },
    };
  }

  if (!expectFlagged && detectorFlagged) {
    const engineAgrees = backendRejected === true;
    return {
      ...base,
      driftClass: DRIFT_CLASSES.DETECTOR_NOISY,
      evidence:
        `${where}: expected no diagnostic but the detector emitted ${observed.detectorCount} ` +
        `(${describeObservation(observed)}).`,
      remediation: engineAgrees
        ? {
            action: REMEDIATIONS.UPDATE_CONTRACT,
            target: 'this contract file',
            detail:
              `The engine rejects this query too, so the diagnostic is arguably correct and the ` +
              `expectation is what is wrong. Re-pin the ${version} expectation, or choose a control query ` +
              `the engine actually accepts.`,
          }
        : {
            action: REMEDIATIONS.UPDATE_DETECTOR,
            target: detectorFile(ruleId, detectorPath),
            detail:
              `The engine ACCEPTS this query, so the diagnostic is a false positive on ${version}. Narrow ` +
              `the detector so it stops matching this shape; if the whole rule no longer applies to any ` +
              `supported engine, disable it in ${OSD_PATHS.catalog}.`,
          },
    };
  }

  if (observed.detectorCount !== expected.detectorCount) {
    return {
      ...base,
      driftClass: DRIFT_CLASSES.DETECTOR_COUNT_MISMATCH,
      evidence:
        `${where}: expected exactly ${expected.detectorCount} diagnostic(s), but the detector ` +
        `emitted ${observed.detectorCount} while the backend behaved as pinned.`,
      remediation: {
        action: REMEDIATIONS.UPDATE_DETECTOR,
        target: detectorFile(ruleId, detectorPath),
        detail:
          `Restore the detector to emit exactly ${expected.detectorCount} diagnostic(s) for this ` +
          `query, or re-pin detectorCount only after confirming the changed multiplicity is intentional.`,
      },
    };
  }

  // --- 6. Right verdict, wrong severity/message ------------------------------
  if (
    expected.severity &&
    detectorFlagged &&
    (observed.severityMatched === false ||
      (Array.isArray(observed.severities) &&
        observed.severities.length > 0 &&
        !observed.severities.every((s) => s === expected.severity)))
  ) {
    return {
      ...base,
      driftClass: DRIFT_CLASSES.SEVERITY_MISMATCH,
      evidence:
        `${where}: expected severity "${expected.severity}" but the detector emitted ` +
        `${JSON.stringify(observed.severities)}.`,
      remediation: {
        action: REMEDIATIONS.UPDATE_DETECTOR,
        target: OSD_PATHS.catalog,
        detail:
          `Restore "${ruleId}".severity to "${expected.severity}" in the catalog, or — if the downgrade was ` +
          `deliberate — re-pin this contract and note that the rule left the enforced default-error set.`,
      },
    };
  }

  if (expected.matchMessage && observed.messageMatched !== true) {
    return {
      ...base,
      driftClass: DRIFT_CLASSES.DETECTOR_MESSAGE_MISMATCH,
      evidence:
        `${where}: the detector diagnostic no longer contains the contracted message fragment ` +
        `${JSON.stringify(expected.matchMessage)}.`,
      remediation: {
        action: REMEDIATIONS.UPDATE_DETECTOR,
        target: detectorFile(ruleId, detectorPath),
        detail:
          `Restore the diagnostic message asserted by this contract, or update matchMessage only ` +
          `after reviewing the new user-facing wording.`,
      },
    };
  }

  return null;
}

/**
 * Render drifts as the PR-facing remediation report. Grouped by remediation
 * action so the reader sees the decision first ("two rules need version
 * scoping") rather than a flat wall of query failures.
 */
export function formatDriftReport(drifts) {
  if (drifts.length === 0) {
    return 'No engine/linter drift detected.';
  }
  const byAction = new Map();
  for (const drift of drifts) {
    const action = drift.remediation.action;
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action).push(drift);
  }

  const lines = [
    `PPL lint drift: ${drifts.length} finding(s) across ${new Set(drifts.map((d) => d.version)).size} engine version(s).`,
    '',
  ];
  // Most urgent action first: a false positive already reaching users outranks a
  // stale pinned string.
  const order = [
    REMEDIATIONS.ALIGN_EXECUTION_BACKENDS,
    REMEDIATIONS.DISABLE_RULE,
    REMEDIATIONS.VERSION_SCOPE_RULE,
    REMEDIATIONS.UPDATE_DETECTOR,
    REMEDIATIONS.REVIEW_BACKEND_ORACLE,
    REMEDIATIONS.UPDATE_CONTRACT,
  ];
  for (const action of order) {
    const group = byAction.get(action);
    if (!group || group.length === 0) continue;
    lines.push(`## ${action} (${group.length})`);
    for (const drift of group) {
      const backend =
        Array.isArray(drift.executionBackends) && drift.executionBackends.length > 1
          ? drift.executionBackends.join(' vs ')
          : drift.executionBackend || 'standard';
      lines.push(`- [${drift.driftClass}] [${backend}] ${drift.evidence}`);
      lines.push(`  FIX (${drift.remediation.target}): ${drift.remediation.detail}`);
      // A rule-level finding (e.g. a grammar rename) has no single query behind it.
      if (drift.query) {
        lines.push(`  QUERY: ${drift.query}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
