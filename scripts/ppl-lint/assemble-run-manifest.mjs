/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Assemble the PPL lint validation run manifest and the compact per-rule PR
 * summary in the result job (design §3.3, §4.4, T10).
 *
 * Inputs (env, all optional so a partial run still produces a manifest):
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

const ARTIFACTS = 'artifacts';

function readJson(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[ppl-lint-manifest] could not parse ${file}: ${error.message}`);
  }
  return undefined;
}

function main() {
  const target = readJson(path.join(ARTIFACTS, 'target.json')) || {};
  const detector = readJson(path.join(ARTIFACTS, 'detector-report.json')) || {};
  const backend = readJson(path.join(ARTIFACTS, 'backend-report.json')) || [];

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
  const passed = backendResult === 'success' && detectorResult === 'success';

  // The selected validation set is the set of rules the detector run actually
  // evaluated (post schedule filtering).
  const validationSet = Array.from(
    new Set((detector.results || []).map((r) => r.ruleId))
  ).sort();

  const manifest = {
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
    differential: !!detector.differential,
    validationSet,
    result: {
      backend: backendResult,
      detector: detectorResult,
      passed,
    },
  };

  fs.writeFileSync('run-manifest.json', JSON.stringify(manifest, null, 2));

  writeSummary(manifest, detector, backend);
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
    const backendCell = be
      ? be.rejected
        ? `HTTP ${be.observed ? be.observed.httpStatus : '4xx'}`
        : 'accepted'
      : '—';
    const ok =
      r.actual === r.expected && (!be || (r.role === 'trigger' ? be.rejected : !be.rejected));
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
