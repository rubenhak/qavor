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

test('qavor discover: registers repos and scaffolds only Dockerfile repos', async () => {
  const { fixtures, ws } = await setupWorkspace();
  try {
    // A git repo at the workspace root with no qavor.yaml and no Dockerfile:
    // it should be registered but never scaffolded.
    await makeEmptyGitRepo(path.join(ws, 'billing.git'));
    // A git repo that ships a Dockerfile but no qavor.yaml: it should be
    // scaffolded with a docker-mode service manifest.
    await makeEmptyGitRepo(path.join(ws, 'gateway.git'));
    await fs.writeFile(path.join(ws, 'gateway.git', 'Dockerfile'), 'FROM scratch\n');
    // A repo that already carries a service manifest.
    await makeGitRepo(path.join(ws, 'auth.git'), 'auth');
    // A non-git directory at the root must be ignored.
    await fs.mkdir(path.join(ws, 'scratch'), { recursive: true });

    const r = await runCli(['discover'], { cwd: ws });
    assert.equal(r.exitCode, 0, `discover failed: ${r.stderr}`);

    // billing has no Dockerfile, so no manifest is written.
    await assert.rejects(fs.access(path.join(ws, 'billing.git', 'qavor.yaml')));

    // gateway has a Dockerfile, so a docker-mode service manifest is scaffolded.
    const gateway = parse(await fs.readFile(path.join(ws, 'gateway.git', 'qavor.yaml'), 'utf8'));
    assert.equal(gateway.kind, 'service');
    assert.equal(gateway.name, 'gateway');
    assert.equal(gateway.mode, 'docker');
    assert.equal(gateway.runtime.docker.enabled, true);

    // auth's existing manifest is untouched (still describes the toy service).
    const authManifest = parse(await fs.readFile(path.join(ws, 'auth.git', 'qavor.yaml'), 'utf8'));
    assert.equal(authManifest.kind, 'service');
    assert.match(authManifest.description, /toy/i);

    // The project manifest references every discovered repo by name, regardless
    // of whether a manifest was scaffolded.
    const project = parse(await fs.readFile(path.join(fixtures.projectRepo, 'qavor.yaml'), 'utf8'));
    const names = project.repositories.map((e: unknown) =>
      typeof e === 'string' ? e : (e as { name: string }).name,
    );
    assert.ok(names.includes('billing'), `expected billing in ${JSON.stringify(names)}`);
    assert.ok(names.includes('gateway'), `expected gateway in ${JSON.stringify(names)}`);
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

test('qavor discover --json: reports registered and scaffolded repos', async () => {
  const { fixtures, ws } = await setupWorkspace();
  try {
    // No Dockerfile: registered but not scaffolded.
    await makeEmptyGitRepo(path.join(ws, 'billing.git'));
    // Dockerfile present: registered and scaffolded.
    await makeEmptyGitRepo(path.join(ws, 'gateway.git'));
    await fs.writeFile(path.join(ws, 'gateway.git', 'Dockerfile'), 'FROM scratch\n');

    const r = await runCli(['--json', 'discover'], { cwd: ws });
    assert.equal(r.exitCode, 0, r.stderr);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.projectUpdated, true);

    const billing = payload.repos.find((x: { name: string }) => x.name === 'billing');
    assert.ok(billing);
    assert.equal(billing.manifestCreated, false);
    assert.equal(billing.referenceAdded, true);

    const gateway = payload.repos.find((x: { name: string }) => x.name === 'gateway');
    assert.ok(gateway);
    assert.equal(gateway.manifestCreated, true);
    assert.equal(gateway.referenceAdded, true);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
