/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim());
  if (!match) return undefined;
  return {
    normalized: `${match[1]}.${match[2]}.${match[3]}`,
    parts: match.slice(1, 4).map(Number),
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function readPrTarget(buildFile) {
  const source = fs.readFileSync(buildFile, 'utf8');
  const match =
    /opensearch_version\s*=\s*System\.getProperty\(\s*["']opensearch\.version["']\s*,\s*["']([^"']+)["']\s*\)/.exec(
      source
    );
  if (!match) {
    fail(`could not resolve the default opensearch.version from ${buildFile}`);
  }
  const parsed = parseVersion(match[1]);
  if (!parsed) {
    fail(`default opensearch.version ${JSON.stringify(match[1])} is not semantic version X.Y.Z`);
  }
  return { raw: match[1], normalized: parsed.normalized, parts: parsed.parts };
}

export function releaseVersions(text) {
  const versions = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const refMatch = /refs\/tags\/([^\s^]+)$/.exec(line.trim());
    const candidate = refMatch ? refMatch[1] : line.trim();
    if (!/^\d+\.\d+\.\d+$/.test(candidate)) continue;
    const parsed = parseVersion(candidate);
    versions.set(parsed.normalized, parsed.parts);
  }
  return [...versions.entries()]
    .map(([version, parts]) => ({ version, parts }))
    .sort((left, right) => compareVersions(left.parts, right.parts));
}

export function selectLatestGaAtOrBelow(tags, target) {
  const eligible = releaseVersions(tags).filter(
    (release) => compareVersions(release.parts, target.parts) <= 0
  );
  if (eligible.length === 0) {
    fail(`no official GA release tag exists at or below ${target.normalized}`);
  }
  return eligible.at(-1).version;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) fail(`unexpected argument ${JSON.stringify(key)}`);
    const value = argv[++index];
    if (value === undefined) fail(`${key} requires a value`);
    args[key.slice(2)] = value;
  }
  for (const required of [
    'build-file',
    'release-tags',
    'compiled-version',
    'sql-sha',
    'osd-repository',
    'osd-ref',
    'out',
  ]) {
    if (!args[required]) fail(`--${required} is required`);
  }
  return args;
}

export function createPlan({
  buildFile,
  releaseTags,
  compiledVersion,
  sqlSha,
  osdRepository,
  osdRef,
}) {
  const target = readPrTarget(buildFile);
  const compiled = parseVersion(compiledVersion);
  if (!compiled || compiled.normalized !== compiledVersion) {
    fail(`compiled version ${JSON.stringify(compiledVersion)} must be exact semantic version X.Y.Z`);
  }
  const latestGa = selectLatestGaAtOrBelow(releaseTags, target);

  const configurations = [
    {
      id: `${compiledVersion}-compiled`,
      label: `${compiledVersion} compiled`,
      engineVersion: compiledVersion,
      surface: 'compiled-simplified',
      executionBackend: 'standard',
      engineMode: 'legacy',
      artifactName: `ppl-lint-observation-${compiledVersion}-compiled`,
      exportRuntimeBundle: false,
    },
    {
      id: 'latest-release-runtime',
      label: `Latest release (${latestGa}) runtime`,
      engineVersion: latestGa,
      surface: 'runtime-bundle',
      executionBackend: 'standard',
      engineMode: 'calcite',
      artifactName: 'ppl-lint-observation-latest-release-runtime',
      exportRuntimeBundle: true,
    },
    {
      id: 'pr-build-runtime',
      label: 'PR runtime',
      engineVersion: target.raw,
      surface: 'runtime-bundle',
      executionBackend: 'standard',
      engineMode: 'calcite',
      artifactName: 'ppl-lint-observation-pr-build-runtime',
      exportRuntimeBundle: true,
    },
  ];

  return {
    schemaVersion: 1,
    sqlSha,
    prTargetVersion: target.raw,
    normalizedPrTarget: target.normalized,
    latestEligibleGa: latestGa,
    osd: {
      repository: osdRepository,
      ref: osdRef,
    },
    configurations,
    releasedTargets: {
      include: configurations.slice(0, 2).map((configuration) => ({
        version: configuration.engineVersion,
        configuration_id: configuration.id,
        surface: configuration.surface,
        label: configuration.id.endsWith('-compiled') ? 'compiled' : 'runtime',
        export_runtime_bundle: configuration.exportRuntimeBundle,
        artifact_name: configuration.artifactName,
      })),
    },
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const plan = createPlan({
      buildFile: args['build-file'],
      releaseTags: fs.readFileSync(args['release-tags'], 'utf8'),
      compiledVersion: args['compiled-version'],
      sqlSha: args['sql-sha'],
      osdRepository: args['osd-repository'],
      osdRef: args['osd-ref'],
    });
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } catch (error) {
    process.stderr.write(`[ppl-lint-plan] ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
