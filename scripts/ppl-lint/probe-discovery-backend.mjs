/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run the discovery corpus against a live engine and record each verdict.
 *
 * This is the engine half of the discovery pipeline, and it deliberately does NOT
 * go through `PplLintRuleValidationIT`. The IT is an assertion harness built around
 * reviewed contract files: it selects a pinned expectation per query and compares
 * against it. Discovery queries have no pinned expectation by design, so there is
 * nothing for the IT to assert and no reason to pay for a Gradle test-cluster run.
 * All that is needed is `POST /_plugins/_ppl` per query and the verdict recorded —
 * which is what this does, in the same report shape the aggregator and the labeler
 * already read.
 *
 * Emits `[{ ruleId, queryName, executionBackend, rejected, outcome, observed:
 * { httpStatus, type, reason } }]`, matching `backend-report.json` so
 * `label-discovery.mjs` can read either source without a special case.
 *
 * The `outcome` field carries the distinction everything downstream depends on:
 *
 *   observed  the engine answered; `rejected` is a real verdict
 *   error     no answer arrived (timeout, connection refused, unparseable body)
 *
 * Never collapse `error` into `rejected: false`. That coercion is what turns a
 * network blip into "the engine now ACCEPTS this query" and generates a
 * false-positive finding against a healthy rule.
 *
 * Usage:
 *   node scripts/ppl-lint/probe-discovery-backend.mjs \
 *     --corpus discovery-corpus.json \
 *     --endpoint http://localhost:9200 \
 *     --out discovery-backend-report.json [--timeout-ms 15000] [--concurrency 4]
 */

import fs from 'fs';

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[ppl-lint-probe] ${message}`);
}

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[ppl-lint-probe] FATAL: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    corpus: '',
    endpoint: 'http://localhost:9200',
    out: 'discovery-backend-report.json',
    timeoutMs: 15000,
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fatal(`${arg} requires a value`);
      return value;
    };
    if (arg === '--corpus') args.corpus = next();
    else if (arg === '--endpoint') args.endpoint = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--timeout-ms') args.timeoutMs = Number(next());
    else if (arg === '--concurrency') args.concurrency = Math.max(1, Number(next()));
    else fatal(`unknown argument "${arg}"`);
  }
  if (!args.corpus) fatal('--corpus is required');
  return args;
}

/**
 * Read one PPL response into a verdict.
 *
 * A 2xx is acceptance. A 4xx/5xx is rejection, and the engine's `error.type` /
 * `error.reason` are extracted because the labeler's uninformative-rejection filter
 * keys on them — a rejection for an unknown field must not be read as evidence
 * about a lint rule.
 *
 * Exported so the mapping is unit-testable without a cluster.
 */
export function readResponse({ status, bodyText }) {
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    body = undefined;
  }
  const error = (body && body.error) || {};
  const rejected = status >= 400;
  return {
    outcome: 'observed',
    rejected,
    observed: {
      httpStatus: status,
      rejected,
      ...(rejected
        ? {
            type: error.type || undefined,
            // Truncated: engine reasons can embed a whole stack trace, and the full
            // text bloats the report without adding signal for the filter.
            reason: typeof error.reason === 'string' ? error.reason.slice(0, 500) : undefined,
          }
        : {}),
    },
  };
}

/** One query against the engine. Never throws: a failure becomes `outcome: error`. */
async function probeOne({ endpoint, query, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/_plugins/_ppl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return readResponse({ status: response.status, bodyText });
  } catch (error) {
    // No verdict. Recorded as such rather than guessed at — see the header note.
    return {
      outcome: 'error',
      observed: undefined,
      error: String((error && error.message) || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `tasks` with at most `limit` in flight, preserving input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8'));
  const queries = corpus.queries || [];
  if (queries.length === 0) fatal(`corpus ${args.corpus} has no queries`);

  log(`probing ${queries.length} query(s) against ${args.endpoint} (concurrency ${args.concurrency})`);

  const report = await mapLimit(queries, args.concurrency, async (entry, i) => {
    const verdict = await probeOne({
      endpoint: args.endpoint,
      query: entry.query,
      timeoutMs: args.timeoutMs,
    });
    return {
      ruleId: entry.ruleId,
      // Must match the name `label-discovery.mjs` derives, or every row misses its
      // detector counterpart and the whole corpus reads as unobserved.
      queryName: entry.name || `discovery-${i}`,
      role: 'discovery',
      query: entry.query,
      executionBackend: 'standard',
      ...verdict,
    };
  });

  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  const errors = report.filter((r) => r.outcome === 'error').length;
  const rejected = report.filter((r) => r.rejected === true).length;
  log(
    `wrote ${args.out}: ${report.length} probed, ${rejected} rejected, ` +
      `${report.length - rejected - errors} accepted, ${errors} unobserved`
  );
  if (errors > 0) {
    // A warning, not a failure: discovery is best-effort and the labeler already
    // withholds findings for unobserved queries. Saying nothing would let a leg
    // that mostly failed look like a leg that mostly agreed.
    log(`WARN: ${errors} query(s) produced no verdict; those yield no findings.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('probe-discovery-backend.mjs')) {
  main().catch((error) => fatal(String((error && error.stack) || error)));
}
