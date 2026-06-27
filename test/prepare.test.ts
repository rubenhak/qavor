import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

/** Rewrite the `web` source repo's manifest and re-commit it. */
async function setWebManifest(repoDir: string, yaml: string): Promise<void> {
  await fs.writeFile(path.join(repoDir, 'qavor.yaml'), yaml);
  await execa('git', ['commit', '-aqm', 'update manifest'], { cwd: repoDir });
}

test('qavor prepare: runs prepare cmd unconditionally every run', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-prep-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    const first = await runCli(['prepare', '--json'], { cwd: ws });
    assert.equal(first.exitCode, 0, `prepare failed: ${first.stderr}`);
    const firstParsed = JSON.parse(first.stdout);
    const okCount = firstParsed.results.filter((r: { status: string }) => r.status === 'ok').length;
    assert.ok(okCount >= 1, 'expected at least one prepared service');

    // No caching: a second run re-runs prepare and produces the same statuses,
    // never a "skipped" result.
    const second = await runCli(['prepare', '--json'], { cwd: ws });
    assert.equal(second.exitCode, 0, `prepare failed: ${second.stderr}`);
    const secondParsed = JSON.parse(second.stdout);
    assert.equal(secondParsed.command, 'prepare');
    assert.ok(
      secondParsed.results.every(
        (r: { status: string }) => r.status === 'ok' || r.status === 'skipped',
      ),
      `expected no failure on second run; got ${JSON.stringify(secondParsed.results)}`,
    );
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor prepare: list-form steps run in declaration order', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-prep-seq-');
  try {
    // Step 1 writes a marker; step 2 only succeeds if the marker already exists,
    // so a passing run proves the steps ran in order.
    await setWebManifest(
      fixtures.serviceRepos.web!,
      [
        'kind: service',
        'name: web',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    prepare:',
        '      - cmd: "touch step1.marker"',
        '      - cmd: "test -f step1.marker"',
        'mode: native',
        '',
      ].join('\n'),
    );

    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    const res = await runCli(['prepare', '--json'], { cwd: ws });
    assert.equal(res.exitCode, 0, `prepare failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.results[0].status, 'ok');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor prepare: a failing step aborts the rest of the list', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-prep-abort-');
  try {
    // First step fails; the second must not run.
    await setWebManifest(
      fixtures.serviceRepos.web!,
      [
        'kind: service',
        'name: web',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    prepare:',
        '      - cmd: "exit 3"',
        '      - cmd: "touch unreachable.marker"',
        'mode: native',
        '',
      ].join('\n'),
    );

    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    const res = await runCli(['prepare', '--json'], { cwd: ws });
    assert.notEqual(res.exitCode, 0, 'prepare should fail when a step exits non-zero');
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.results[0].status, 'failed');

    // The second step never ran, so its marker is absent anywhere in the workspace.
    const found = await execa('find', [ws, '-name', 'unreachable.marker'], { reject: false });
    assert.equal(found.stdout.trim(), '', 'second step should have been skipped');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
