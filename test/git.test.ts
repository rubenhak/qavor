import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

test('qavor clone: clones the repos listed in the project manifest', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-clone-');
  try {
    const init = await runCli(['init', fixtures.projectRepo, '--into', ws]);
    assert.equal(init.exitCode, 0, `init failed: ${init.stderr}`);
    const clone = await runCli(['clone'], { cwd: ws });
    assert.equal(clone.exitCode, 0, `clone failed: ${clone.stderr}`);
    const webStat = await fs.stat(path.join(ws, 'web.git'));
    const authStat = await fs.stat(path.join(ws, 'auth.git'));
    assert.ok(webStat.isDirectory());
    assert.ok(authStat.isDirectory());
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor status: reports per-repo branch + dirty count', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-status-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['clone'], { cwd: ws });
    // dirty the web repo
    await fs.writeFile(path.join(ws, 'web.git', 'extra.txt'), 'hello');
    const status = await runCli(['status', '--json'], { cwd: ws });
    assert.equal(status.exitCode, 0, `status failed: ${status.stderr}`);
    const parsed = JSON.parse(status.stdout);
    const web = parsed.repos.find((r: { repo: string }) => r.repo === 'web');
    assert.ok(web, 'expected web entry');
    assert.equal(web.dirty, 1);
    assert.equal(web.branch, 'main');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor clone: --repo selector clones only the requested repo', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-clone-sel-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    const r = await runCli(['clone', '--repo', 'web'], { cwd: ws });
    assert.equal(r.exitCode, 0, `selective clone failed: ${r.stderr}`);
    await fs.stat(path.join(ws, 'web.git'));
    let authExists = true;
    try {
      await fs.stat(path.join(ws, 'auth.git'));
    } catch {
      authExists = false;
    }
    assert.equal(authExists, false, 'auth.git should not have been cloned');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
