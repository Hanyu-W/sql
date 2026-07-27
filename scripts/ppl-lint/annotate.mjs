/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitHub Actions annotations for the PPL lint multi-version check.
 *
 * The drift report and the job summary already say exactly what to change. The
 * problem is WHERE a developer looks first: GitHub renders workflow-command
 * annotations at the top of the run page and, when a finding names a file in the
 * pull request, inline on that file in the Files-changed view. Without them the
 * only thing above the summary is "Process completed with exit code 1", so the
 * natural next click leads into raw job logs instead of the remediation.
 *
 * This module turns findings into `::error file=…,line=…::` commands. Two rules
 * govern everything here:
 *
 *   1. An annotation must point at a line the reader can act on, or carry no line
 *      at all. A confidently wrong line number sends someone to edit the wrong
 *      expectation, which is worse than making them find it themselves.
 *   2. The annotation is a POINTER, not the report. It carries the finding and the
 *      one-line action; the summary keeps the full reasoning. Annotation text is
 *      truncated by the UI, so front-load the identity of the problem.
 *
 * Inconclusive findings are deliberately `::warning`, not `::error`: they mean
 * "we could not check", and the run is already red from the exit code. Rendering
 * them as errors next to real drift would invite exactly the response the
 * classifier works to prevent — editing a rule because a leg timed out.
 */

import fs from 'fs';
import path from 'path';

/** Escape a workflow-command property value (file/title). */
function escapeProperty(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

/** Escape a workflow-command message body; newlines must survive as %0A. */
function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * Line of the `expectations[]` entry whose `version` is `range`, 1-indexed.
 *
 * Deliberately a text scan rather than a JSON walk: JSON.parse discards line
 * information, and every consumer of this number is a human reading the file in a
 * browser. Returns undefined when the range is absent or ambiguous (appears more
 * than once), because an annotation with no line still lands on the file while a
 * wrong line actively misleads.
 */
export function findExpectationLine(contractText, range) {
  if (!contractText || !range) return undefined;
  const lines = contractText.split('\n');
  const needle = `"version": ${JSON.stringify(range)}`;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    // Match on the normalized form so incidental whitespace does not defeat it.
    if (lines[i].replace(/\s+/g, ' ').includes(needle)) hits.push(i + 1);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Line of the top-level `"ruleId"` key, used as the fallback anchor when the
 * finding is about the rule as a whole (a renamed grammar rule) rather than one
 * pinned expectation.
 */
export function findRuleIdLine(contractText) {
  if (!contractText) return undefined;
  const lines = contractText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*"ruleId"\s*:/.test(lines[i])) return i + 1;
  }
  return undefined;
}

/**
 * Repo-relative path of a contract file, for `file=`.
 *
 * GitHub only renders an annotation inline when the path is relative to the
 * repository root AND the file is in the pull request's diff. `contractsDir` is
 * an absolute path inside the workspace, so strip the workspace prefix.
 */
export function contractRepoPath(contractsDir, fileName, workspace) {
  const absolute = path.join(contractsDir, fileName);
  if (workspace && absolute.startsWith(workspace)) {
    return path.relative(workspace, absolute);
  }
  return absolute;
}

/**
 * Build the annotation list for a drift report. Pure: returns descriptors so the
 * caller decides where they are written and the tests can assert on them without
 * capturing stdout.
 */
export function buildAnnotations(report, { contractsDir, workspace, readFile = readContract } = {}) {
  const annotations = [];
  const textCache = new Map();
  const contractText = (fileName) => {
    if (!fileName) return undefined;
    if (!textCache.has(fileName)) {
      textCache.set(fileName, readFile(contractsDir, fileName));
    }
    return textCache.get(fileName);
  };

  for (const drift of report.drifts || []) {
    const file = drift.contractFile;
    const text = contractText(file);
    // `update-contract` findings are about one pinned expectation, so anchor
    // there. Everything else is about the rule, so anchor at its identity line —
    // the reader's next stop is the detector named in the message anyway.
    const line =
      (drift.expectationRange ? findExpectationLine(text, drift.expectationRange) : undefined) ??
      findRuleIdLine(text);

    annotations.push({
      level: drift.enforced ? 'error' : 'warning',
      file: file ? contractRepoPath(contractsDir, file, workspace) : undefined,
      line,
      title: `PPL lint drift: ${drift.driftClass} (${drift.ruleId} @ ${drift.version})`,
      // Message order matters: the UI truncates, so lead with what moved, then the
      // action, then where. The summary carries the full rationale.
      message: [
        drift.evidence,
        `FIX (${drift.remediation.action}): ${drift.remediation.detail}`,
        drift.query ? `QUERY: ${drift.query}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }

  for (const hole of report.coverageHoles || []) {
    const text = contractText(hole.file);
    annotations.push({
      level: hole.enforced ? 'error' : 'warning',
      file: hole.file ? contractRepoPath(contractsDir, hole.file, workspace) : undefined,
      line: findRuleIdLine(text),
      title: `PPL lint coverage hole: ${hole.ruleId} @ ${hole.version}`,
      message:
        `No expectation in this contract matches engine ${hole.version}, so nothing pins ` +
        `"${hole.ruleId}" there. Add a reviewed expectation whose version range covers ` +
        `${hole.version}; do not widen an existing range to absorb it unless the behavior is ` +
        `genuinely identical.`,
    });
  }

  // Warning, not error: the linter is not what went wrong, and the run is already
  // red from the exit code. See the module comment.
  for (const entry of report.inconclusive || []) {
    const text = contractText(entry.file);
    annotations.push({
      level: 'warning',
      file: entry.file ? contractRepoPath(contractsDir, entry.file, workspace) : undefined,
      line: findRuleIdLine(text),
      title: `PPL lint inconclusive: ${entry.ruleId} @ ${entry.version} (leg problem)`,
      message:
        `No case could be compared for "${entry.ruleId}" on engine ${entry.version}` +
        (entry.reasons && entry.reasons.length > 0 ? ` — ${entry.reasons.join('; ')}` : '') +
        `. This is NOT a lint finding: the engine or the detector run did not answer, so ` +
        `nothing was validated. Check that leg's job logs and re-run. Do not edit the rule or ` +
        `the contract on the strength of this.`,
    });
  }

  for (const missing of report.missingContracts || []) {
    const ruleId = missing.ruleId || missing;
    annotations.push({
      level: 'error',
      // A rule with no contract has no file to point at; the manifest is where the
      // reader's edit goes.
      file: undefined,
      title: `PPL lint unvalidated rule: ${ruleId}`,
      message:
        `"${ruleId}" ships enabled at error severity in OSD's rules_catalog.json but ` +
        `${missing.reason || 'has no contract in this corpus'}. A default-error rule with no ` +
        `contract is invisible to this check. Add a contract file and list it under ` +
        `manifest.defaultError, or lower the rule's severity in OSD.`,
    });
  }

  return annotations;
}

function readContract(contractsDir, fileName) {
  try {
    return fs.readFileSync(path.join(contractsDir, fileName), 'utf8');
  } catch {
    // A contract we cannot read still deserves a file-less annotation.
    return undefined;
  }
}

/** Render one descriptor as a workflow command line. */
export function formatAnnotation(annotation) {
  const props = [];
  if (annotation.file) props.push(`file=${escapeProperty(annotation.file)}`);
  if (annotation.line) props.push(`line=${annotation.line}`);
  if (annotation.title) props.push(`title=${escapeProperty(annotation.title)}`);
  const suffix = props.length > 0 ? ` ${props.join(',')}` : '';
  return `::${annotation.level}${suffix}::${escapeData(annotation.message)}`;
}

/**
 * Emit annotations for a report. No-op unless running under Actions (or forced),
 * so a local run is not spammed with workflow-command noise.
 */
export function emitAnnotations(report, options = {}) {
  const enabled = options.force || process.env.GITHUB_ACTIONS === 'true';
  if (!enabled) return [];
  const annotations = buildAnnotations(report, options);
  for (const annotation of annotations) {
    // eslint-disable-next-line no-console
    console.log(formatAnnotation(annotation));
  }
  return annotations;
}
