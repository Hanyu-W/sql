/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Assemble the PPL lint validation run manifest and the compact per-rule PR
 * summary in the result job (design §3.3, §4.4, T10).
 *
 * Inputs (env; identity fields may be empty on a partial run):
 *   SQL_SHA, OSD_REF, OSD_SHA, EVENT_NAME, SCHEDULE,
 *   BACKEND_RESULT, DETECTOR_RESULT, GITHUB_STEP_SUMMARY.
 * Artifact files under ./artifacts (downloaded from both jobs):
 *   target.json (engineVersion + grammarHash), backend-report.json,
 *   detector-report.json.
 *
 * Outputs:
 *   run-manifest.json in the workspace root; a markdown table appended to
 *   $GITHUB_STEP_SUMMARY.
 */

import fs from 'fs';
import path from 'path';

import {
  classifyBackendReportRow,
  indexBackendReport,
  normalizeTarget,
} from './contract-schema.mjs';

const ARTIFACTS = 'artifacts';

function readJson(file, errors) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    errors.push(`required artifact is missing: ${file}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ppl-lint-manifest] could not parse ${file}: ${error.message}`);
    errors.push(`required artifact is malformed: ${file}: ${error.message}`);
  }
  return undefined;
}

function main() {
  const artifactErrors = [];
  const targetRaw = readJson(path.join(ARTIFACTS, 'target.json'), artifactErrors) || {};
  const detector =
    readJson(path.join(ARTIFACTS, 'detector-report.json'), artifactErrors) || {};
  const backend =
    readJson(path.join(ARTIFACTS, 'backend-report.json'), artifactErrors) || [];

  let target = {};
  try {
    target = normalizeTarget(targetRaw);
  } catch (error) {
    artifactErrors.push(`invalid target.json: ${error.message}`);
  }
  const executionBackend = target.executionBackend || '';
  if (target.schemaVersion !== 2 || target.legacy) {
    artifactErrors.push(
      `required workflow target schemaVersion must be 2, got ${JSON.stringify(target.schemaVersion)}`
    );
  }
  if (executionBackend !== 'standard') {
    artifactErrors.push(
      `required workflow target executionBackend must be "standard", got ${JSON.stringify(executionBackend)}`
    );
  }
  if (!target.sqlSha) {
    artifactErrors.push('target sqlSha must be non-empty');
  } else if (process.env.SQL_SHA && target.sqlSha !== process.env.SQL_SHA) {
    artifactErrors.push(
      `target sqlSha ${JSON.stringify(target.sqlSha)} does not match workflow SQL_SHA ${JSON.stringify(process.env.SQL_SHA)}`
    );
  }
  if (detector.schemaVersion !== 2) {
    artifactErrors.push(
      `detector schemaVersion must be 2, got ${JSON.stringify(detector.schemaVersion)}`
    );
  }
  if (detector.executionBackend !== executionBackend) {
    artifactErrors.push(
      `detector executionBackend ${JSON.stringify(detector.executionBackend)} does not match target ${JSON.stringify(executionBackend)}`
    );
  }
  for (const field of ['engineVersion', 'grammarHash']) {
    if (detector[field] !== target[field]) {
      artifactErrors.push(
        `detector ${field} ${JSON.stringify(detector[field])} does not match target ${JSON.stringify(target[field])}`
      );
    }
  }
  if (!['runtime-bundle', 'compiled-simplified'].includes(detector.surface)) {
    artifactErrors.push(
      `detector surface must be "runtime-bundle" or "compiled-simplified", got ` +
        `${JSON.stringify(detector.surface)}`
    );
  }
  if (!Array.isArray(detector.defaultErrorRules)) {
    artifactErrors.push('detector defaultErrorRules must be an array');
  }

  let backendByKey = new Map();
  try {
    backendByKey = indexBackendReport(backend, target);
  } catch (error) {
    artifactErrors.push(`invalid backend-report.json: ${error.message}`);
  }
  if (backendByKey.size === 0) {
    artifactErrors.push('backend-report.json must be a non-empty array');
  }
  if (!Array.isArray(detector.results) || detector.results.length === 0) {
    artifactErrors.push('detector-report.json must contain a non-empty results array');
  }
  const detectorKeys = new Set();
  for (const entry of Array.isArray(detector.results) ? detector.results : []) {
    const key = `${entry.ruleId}::${entry.queryName}`;
    if (!entry.ruleId || !entry.queryName) {
      artifactErrors.push(`detector-report.json contains an invalid row ${JSON.stringify(entry)}`);
      continue;
    }
    if (detectorKeys.has(key)) {
      artifactErrors.push(`detector-report.json contains duplicate row ${key}`);
    }
    detectorKeys.add(key);
    if (entry.executionBackend !== executionBackend) {
      artifactErrors.push(
        `detector row ${key} executionBackend ${JSON.stringify(entry.executionBackend)} does not match target ${JSON.stringify(executionBackend)}`
      );
    }
    if (!backendByKey.has(key)) {
      artifactErrors.push(`detector row ${key} has no matching backend row`);
    }
    if (!Number.isInteger(entry.expected) || !Number.isInteger(entry.actual)) {
      artifactErrors.push(`detector row ${key} must contain integer expected/actual counts`);
    } else if (entry.actual !== entry.expected) {
      artifactErrors.push(
        `detector row ${key} count mismatch: expected ${entry.expected}, got ${entry.actual}`
      );
    }
    if (entry.severityMatched !== true) {
      artifactErrors.push(`detector row ${key} did not match its severity assertion`);
    }
    if (entry.messageMatched !== true) {
      artifactErrors.push(`detector row ${key} did not match its message assertion`);
    }
  }
  for (const [key, entry] of backendByKey) {
    if (!detectorKeys.has(key)) {
      artifactErrors.push(`backend row ${key} has no matching detector row`);
    }
    const state = classifyBackendReportRow(entry);
    if (state.status !== 'observed' || entry.outcome !== 'pass') {
      artifactErrors.push(
        `backend row ${key} did not pass its oracle (outcome=${JSON.stringify(entry.outcome)})`
      );
    }
  }

  const eventName = process.env.EVENT_NAME || '';
  const osdRef = process.env.OSD_REF || 'main';
  const osdRepo = process.env.OSD_REPO || 'opensearch-project/OpenSearch-Dashboards';
  const isUpstreamMain = osdRepo === 'opensearch-project/OpenSearch-Dashboards' && osdRef === 'main';
  const mode =
    eventName === 'pull_request'
      ? 'sql-pr-validation'
      : eventName === 'schedule'
        ? 'nightly'
        : !isUpstreamMain
          ? 'osd-branch-evidence'
          : 'manual';

  const backendResult = process.env.BACKEND_RESULT || 'unknown';
  const detectorResult = process.env.DETECTOR_RESULT || 'unknown';
  const passed =
    backendResult === 'success' && detectorResult === 'success' && artifactErrors.length === 0;

  // The selected validation set is the set of rules the detector run actually
  // evaluated (post schedule filtering).
  const validationSet = Array.from(
    new Set((detector.results || []).map((r) => r.ruleId))
  ).sort();

  const manifest = {
    schemaVersion: 2,
    mode,
    // A workflow_dispatch osd_ref run is pre-merge evidence, never a
    // branch-protection result (design §4.1.1, T11).
    requiredCheck: eventName === 'pull_request',
    event: eventName,
    schedule: process.env.SCHEDULE || detector.schedule || 'pr',
    sqlSha: process.env.SQL_SHA || '',
    osdRepo,
    osdRef,
    osdSha: process.env.OSD_SHA || '',
    engineVersion: target.engineVersion || detector.engineVersion || '',
    grammarHash: target.grammarHash || detector.grammarHash || '',
    executionBackend,
    differential: !!detector.differential,
    validationSet,
    result: {
      backend: backendResult,
      detector: detectorResult,
      artifactErrors,
      passed,
    },
  };

  fs.writeFileSync('run-manifest.json', JSON.stringify(manifest, null, 2));

  writeSummary(manifest, detector, backend);

  if (artifactErrors.length > 0) {
    throw new Error(`invalid PPL lint artifacts:\n- ${artifactErrors.join('\n- ')}`);
  }
}

/** Compact per-rule PR summary: Rule | Version | Grammar | Detector | Backend | Result. */
function writeSummary(manifest, detector, backend) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const backendByKey = new Map();
  for (const e of Array.isArray(backend) ? backend : []) {
    backendByKey.set(`${e.ruleId}::${e.queryName}`, e);
  }

  const shortHash = (h) => (h ? String(h).replace(/^sha256:/, '').slice(0, 12) : '—');

  const lines = [];
  lines.push('## PPL lint rule validation');
  lines.push('');
  lines.push(`- Mode: \`${manifest.mode}\`${manifest.requiredCheck ? ' (required)' : ' (non-enforcing)'}`);
  lines.push(`- SQL: \`${manifest.sqlSha || '—'}\``);
  lines.push(`- OSD: \`${manifest.osdSha || '—'}\` (${manifest.osdRepo} @ \`${manifest.osdRef}\`)`);
  lines.push(`- Backend version: \`${manifest.engineVersion || '—'}\``);
  lines.push(`- Execution backend: \`${manifest.executionBackend || '—'}\``);
  lines.push(`- Grammar: \`${shortHash(manifest.grammarHash)}\``);
  lines.push(
    `- Result: backend **${manifest.result.backend}**, detector **${manifest.result.detector}** → ` +
      `**${manifest.result.passed ? 'PASS' : 'FAIL'}**`
  );
  lines.push('');
  lines.push('| Rule | Query | Version | Grammar | Detector | Backend | Result |');
  lines.push('| ---- | ----- | ------- | ------- | -------- | ------- | ------ |');

  for (const r of detector.results || []) {
    const be = backendByKey.get(`${r.ruleId}::${r.queryName}`);
    const detectorCell = `${r.actual}/${r.expected}${r.severities && r.severities.length ? ` (${r.severities.join(',')})` : ''}`;
    const backendCell = !be
      ? '—'
      : typeof be.rejected !== 'boolean'
        ? be.outcome || 'no verdict'
        : be.rejected
          ? `HTTP ${be.observed ? be.observed.httpStatus : '4xx'}`
          : 'accepted';
    const ok =
      r.actual === r.expected &&
      r.severityMatched === true &&
      r.messageMatched === true &&
      !!be &&
      be.outcome === 'pass';
    lines.push(
      `| \`${r.ruleId}\` | \`${r.queryName}\` | \`${manifest.engineVersion || '—'}\` | ` +
        `\`${shortHash(manifest.grammarHash)}\` | ${detectorCell} | ${backendCell} | ${ok ? 'Pass' : 'Fail'} |`
    );
  }

  if ((detector.failures || []).length > 0) {
    lines.push('');
    lines.push('<details><summary>Failures</summary>');
    lines.push('');
    for (const f of detector.failures) {
      lines.push(`- ${f}`);
    }
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  try {
    fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ppl-lint-manifest] could not write step summary: ${error.message}`);
  }
}

main();
