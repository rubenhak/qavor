import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildFixtureRepos, makeTempDir, cleanup, runCli, fileUrl } from './helpers/fixtures.js';

test('qavor init: from local project repo path is idempotent', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-ws-');
  try {
    const r1 = await runCli(['init', fixtures.projectRepo, '--into', ws], { cwd: process.cwd() });
    assert.equal(r1.exitCode, 0, `init failed: ${r1.stderr}`);
    const r2 = await runCli(['init', fixtures.projectRepo, '--into', ws], { cwd: process.cwd() });
    assert.equal(r2.exitCode, 0, `re-init failed: ${r2.stderr}`);
    const yaml = await fs.readFile(path.join(ws, 'qavor.yaml'), 'utf8');
    assert.match(yaml, /kind: workspaces/);
    assert.match(yaml, /root_project_path:/);
    const meta = JSON.parse(await fs.readFile(path.join(ws, '.qavor', 'workspace.json'), 'utf8'));
    assert.equal(meta.project_name, 'acme-platform');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor init: from a file:// URL clones the project repo', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-ws-');
  try {
    const r = await runCli(['init', fileUrl(fixtures.projectRepo), '--into', ws], { cwd: process.cwd() });
    assert.equal(r.exitCode, 0, `init failed: ${r.stderr}`);
    const expected = path.join(ws, 'project-repo.git');
    const stat = await fs.stat(expected);
    assert.ok(stat.isDirectory());
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor workspace info: prints workspace identity', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-ws-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    const r = await runCli(['workspace', 'info'], { cwd: ws });
    assert.equal(r.exitCode, 0, `info failed: ${r.stderr}`);
    assert.match(r.stdout, /Workspace root:/);
    assert.match(r.stdout, /acme-platform/);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
