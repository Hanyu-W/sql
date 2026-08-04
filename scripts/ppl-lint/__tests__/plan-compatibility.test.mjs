/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  createPlan,
  parseVersion,
  releaseVersions,
  selectLatestGaAtOrBelow,
} from '../plan-compatibility.mjs';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-lint-plan-'));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normalizes prerelease and build suffixes', () => {
  assert.deepEqual(parseVersion('3.8.0-SNAPSHOT'), {
    normalized: '3.8.0',
    parts: [3, 8, 0],
  });
  assert.deepEqual(parseVersion('3.8.0+build.42'), {
    normalized: '3.8.0',
    parts: [3, 8, 0],
  });
});

test('only exact semantic version tags count as official GA candidates', () => {
  const tags = [
    'a refs/tags/3.7.0',
    'b refs/tags/3.8.0-alpha1',
    'c refs/tags/3.7.1',
    'd refs/tags/v3.8.0',
    'e refs/tags/3.8.0',
  ].join('\n');
  assert.deepEqual(
    releaseVersions(tags).map((entry) => entry.version),
    ['3.7.0', '3.7.1', '3.8.0']
  );
});

test('selects the highest GA at or below the normalized PR target', () => {
  const tags = ['3.6.0', '3.7.0', '3.7.2', '3.8.0', '3.9.0'].join('\n');
  assert.equal(
    selectLatestGaAtOrBelow(tags, parseVersion('3.8.0-SNAPSHOT')),
    '3.8.0'
  );
  assert.equal(
    selectLatestGaAtOrBelow(tags, parseVersion('3.7.5-SNAPSHOT')),
    '3.7.2'
  );
});

test('plans one compiled and two runtime configurations', () => {
  const directory = temporaryDirectory();
  const buildFile = path.join(directory, 'build.gradle');
  fs.writeFileSync(
    buildFile,
    'opensearch_version = System.getProperty("opensearch.version", "3.8.0-SNAPSHOT")\n'
  );
  const plan = createPlan({
    buildFile,
    releaseTags: ['a refs/tags/3.7.0', 'b refs/tags/3.8.0'].join('\n'),
    compiledVersion: '2.19.6',
    sqlSha: 'sql-sha',
    osdRepository: 'example/OpenSearch-Dashboards',
    osdRef: 'feature',
  });

  assert.equal(plan.latestEligibleGa, '3.8.0');
  assert.deepEqual(
    plan.configurations.map((configuration) => [
      configuration.id,
      configuration.surface,
      configuration.engineVersion,
    ]),
    [
      ['2.19.6-compiled', 'compiled-simplified', '2.19.6'],
      ['latest-release-runtime', 'runtime-bundle', '3.8.0'],
      ['pr-build-runtime', 'runtime-bundle', '3.8.0-SNAPSHOT'],
    ]
  );
  assert.equal(plan.releasedTargets.include.length, 2);
});
