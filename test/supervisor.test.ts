import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildFixtureRepos, makeTempDir, cleanup, runCli } from './helpers/fixtures.js';

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

test('qavor up/ps/down: lifecycle works against the auth fixture', async () => {
  const fixtures = await buildFixtureRepos({ services: ['auth'] });
  const ws = await makeTempDir('qavor-sup-');
  try {
    const init = await runCli(['init', fixtures.projectRepo, '--into', ws]);
    assert.equal(init.exitCode, 0);
    const clone = await runCli(['clone'], { cwd: ws });
    assert.equal(clone.exitCode, 0);
    const up = await runCli(['up', 'auth', '--json'], { cwd: ws });
    assert.equal(up.exitCode, 0, `up failed: ${up.stderr}`);
    const { pid } = JSON.parse(up.stdout);
    assert.ok(typeof pid === 'number' && pid > 0);

    // The child needs a moment to write its first line.
    await sleep(500);
    const ps = await runCli(['ps', '--json'], { cwd: ws });
    const psParsed = JSON.parse(ps.stdout);
    const authEntry = psParsed.services.find((s: { service: string }) => s.service === 'auth');
    assert.ok(authEntry, 'auth should appear in ps');
    assert.equal(authEntry.status, 'running');

    const down = await runCli(['down', 'auth', '--json'], { cwd: ws });
    assert.equal(down.exitCode, 0, `down failed: ${down.stderr}`);

    // confirm the state file has been removed.
    let exists = true;
    try { await fs.access(path.join(ws, '.qavor', 'state', 'auth.json')); } catch { exists = false; }
    assert.equal(exists, false, 'state file should be cleared after down');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor up: refuses if a service has no runtime.native.run.cmd', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-norun-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['clone'], { cwd: ws });
    // Overwrite web's manifest to disable native run.
    const webManifest = path.join(ws, 'web.git', 'qavor.yaml');
    await fs.writeFile(
      webManifest,
      ['kind: service', 'name: web', 'runtime:', '  native:', '    enabled: false', ''].join('\n'),
    );
    const up = await runCli(['up', 'web'], { cwd: ws });
    assert.notEqual(up.exitCode, 0, 'up should fail when native is disabled');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
