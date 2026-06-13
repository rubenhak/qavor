import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  buildFixtureRepos,
  cleanup,
  makeEmptyGitRepo,
  makeGitRepo,
  makeTempDir,
  runCli,
} from './helpers/fixtures.js';

/**
 * Build a workspace from the project fixture (which references `web`), then
 * drop extra git repos at the workspace root that the project does not yet know
 * about.
 */
async function setupWorkspace(): Promise<{
  fixtures: Awaited<ReturnType<typeof buildFixtureRepos>>;
  ws: string;
}> {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-ws-');
  await runCli(['init', fixtures.projectRepo, '--into', ws]);
  return { fixtures, ws };
}

test('qavor discover: scaffolds manifests and registers new repos', async () => {
  const { fixtures, ws } = await setupWorkspace();
  try {
    // A git repo at the workspace root with no qavor.yaml.
    await makeEmptyGitRepo(path.join(ws, 'billing.git'));
    // A second one that already carries a service manifest.
    await makeGitRepo(path.join(ws, 'auth.git'), 'auth');
    // A non-git directory at the root must be ignored.
    await fs.mkdir(path.join(ws, 'scratch'), { recursive: true });

    const r = await runCli(['discover'], { cwd: ws });
    assert.equal(r.exitCode, 0, `discover failed: ${r.stderr}`);

    // billing got a default service manifest.
    const billingManifest = await fs.readFile(path.join(ws, 'billing.git', 'qavor.yaml'), 'utf8');
    const billing = parse(billingManifest);
    assert.deepEqual(billing, { kind: 'service', name: 'billing', description: 'billing' });

    // auth's existing manifest is untouched (still describes the toy service).
    const authManifest = parse(await fs.readFile(path.join(ws, 'auth.git', 'qavor.yaml'), 'utf8'));
    assert.equal(authManifest.kind, 'service');
    assert.match(authManifest.description, /toy/i);

    // The project manifest now references both new repos by name.
    const project = parse(await fs.readFile(path.join(fixtures.projectRepo, 'qavor.yaml'), 'utf8'));
    const names = project.repositories.map((e: unknown) =>
      typeof e === 'string' ? e : (e as { name: string }).name,
    );
    assert.ok(names.includes('billing'), `expected billing in ${JSON.stringify(names)}`);
    assert.ok(names.includes('auth'), `expected auth in ${JSON.stringify(names)}`);
    // The non-git dir is not registered.
    assert.ok(!names.includes('scratch'));
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor discover: is idempotent and --dry-run writes nothing', async () => {
  const { fixtures, ws } = await setupWorkspace();
  try {
    await makeEmptyGitRepo(path.join(ws, 'billing.git'));

    const dry = await runCli(['discover', '--dry-run'], { cwd: ws });
    assert.equal(dry.exitCode, 0, `dry-run failed: ${dry.stderr}`);
    // Nothing written on dry-run.
    await assert.rejects(fs.access(path.join(ws, 'billing.git', 'qavor.yaml')));
    const projectBefore = await fs.readFile(path.join(fixtures.projectRepo, 'qavor.yaml'), 'utf8');
    assert.ok(!projectBefore.includes('billing'));

    // First real run mutates; second is a no-op on the project manifest.
    const first = await runCli(['discover'], { cwd: ws });
    assert.equal(first.exitCode, 0, first.stderr);
    const afterFirst = await fs.readFile(path.join(fixtures.projectRepo, 'qavor.yaml'), 'utf8');

    const second = await runCli(['discover'], { cwd: ws });
    assert.equal(second.exitCode, 0, second.stderr);
    const afterSecond = await fs.readFile(path.join(fixtures.projectRepo, 'qavor.yaml'), 'utf8');
    assert.equal(afterFirst, afterSecond, 'second discover must not re-add references');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor discover --json: reports scaffolded repos', async () => {
  const { fixtures, ws } = await setupWorkspace();
  try {
    await makeEmptyGitRepo(path.join(ws, 'billing.git'));
    const r = await runCli(['--json', 'discover'], { cwd: ws });
    assert.equal(r.exitCode, 0, r.stderr);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.projectUpdated, true);
    const billing = payload.repos.find((x: { name: string }) => x.name === 'billing');
    assert.ok(billing);
    assert.equal(billing.manifestCreated, true);
    assert.equal(billing.referenceAdded, true);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
