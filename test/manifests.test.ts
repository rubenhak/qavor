import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

/**
 * Build a workspace from the standard fixture and clone every referenced repo
 * so the manifest tree has services to enumerate.
 */
async function setupClonedWorkspace(): Promise<{
  base: string;
  ws: string;
}> {
  const fixtures = await buildFixtureRepos();
  const ws = await makeTempDir('qavor-ws-');
  await runCli(['init', fixtures.projectRepo, '--into', ws]);
  const clone = await runCli(['git', 'clone'], { cwd: ws });
  assert.equal(clone.exitCode, 0, `git clone failed: ${clone.stderr}`);
  return { base: fixtures.base, ws };
}

test('qavor manifests: renders a tree with every repo and service', async () => {
  const { base, ws } = await setupClonedWorkspace();
  try {
    const r = await runCli(['manifests'], { cwd: ws });
    assert.equal(r.exitCode, 0, `manifests failed: ${r.stderr}`);
    // The workspace name heads the tree.
    assert.match(r.stdout, /acme-platform/);
    // The project manifest is surfaced with its kind + repo count.
    assert.match(r.stdout, /project\s+acme-platform/);
    assert.match(r.stdout, /3 repos/);
    // Every cloned service shows up with its kind and name.
    for (const svc of ['web', 'auth', 'notes']) {
      assert.match(r.stdout, new RegExp(`service\\s+${svc}`), `missing service ${svc}`);
    }
    // No spurious "not cloned" markers once repos are cloned.
    assert.doesNotMatch(r.stdout, /not cloned/);
  } finally {
    await cleanup(base);
    await cleanup(ws);
  }
});

test('qavor manifests --json: emits a structured tree of repos and manifests', async () => {
  const { base, ws } = await setupClonedWorkspace();
  try {
    const r = await runCli(['--json', 'manifests'], { cwd: ws });
    assert.equal(r.exitCode, 0, r.stderr);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.project_name, 'acme-platform');
    assert.equal(payload.issues.length, 0);

    const projectRepo = payload.repos.find((x: { is_project_repo: boolean }) => x.is_project_repo);
    assert.ok(projectRepo, 'expected a project repo node');
    assert.equal(projectRepo.files[0].manifests[0].kind, 'project');

    const names = payload.repos.flatMap((x: { files: { manifests: { name: string }[] }[] }) =>
      x.files.flatMap((f) => f.manifests.map((m) => m.name)),
    );
    for (const svc of ['web', 'auth', 'notes', 'acme-platform']) {
      assert.ok(names.includes(svc), `expected ${svc} in ${JSON.stringify(names)}`);
    }
  } finally {
    await cleanup(base);
    await cleanup(ws);
  }
});

test('qavor manifests: marks repos that are not cloned yet', async () => {
  const fixtures = await buildFixtureRepos();
  const ws = await makeTempDir('qavor-ws-');
  try {
    // Init wires the workspace pointer but does not clone the service repos.
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    const r = await runCli(['manifests'], { cwd: ws });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /not cloned/);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor manifests: prints each manifest issue with its location and message', async () => {
  const { base, ws } = await setupClonedWorkspace();
  try {
    // Introduce a dangling cross-reference: the web service requires a
    // stateful that no manifest defines.
    const webManifest = path.join(ws, 'web.git', 'qavor.yaml');
    const original = await fs.readFile(webManifest, 'utf8');
    await fs.writeFile(webManifest, `${original.trimEnd()}\nrequire:\n  - stateful: ghost-db\n`);

    const r = await runCli(['manifests'], { cwd: ws });
    assert.equal(r.exitCode, 0, r.stderr);
    // The summary reports the count and the detail line names the offender.
    assert.match(r.stdout, /1 manifest issue\(s\) found:/);
    assert.match(r.stdout, /ghost-db/);
    assert.match(r.stdout, /web\.git\/qavor\.yaml:\d+:\d+/);
  } finally {
    await cleanup(base);
    await cleanup(ws);
  }
});

test('qavor manifests: groups multiple documents from a single multi-doc file', async () => {
  const { base, ws } = await setupClonedWorkspace();
  try {
    // Append a stateful document to the web repo's root manifest.
    const webManifest = path.join(ws, 'web.git', 'qavor.yaml');
    const original = await fs.readFile(webManifest, 'utf8');
    await fs.writeFile(
      webManifest,
      `${original.trimEnd()}\n---\nkind: stateful\nname: cache\nmode: docker-compose\n`,
    );

    const r = await runCli(['--json', 'manifests'], { cwd: ws });
    assert.equal(r.exitCode, 0, r.stderr);
    const payload = JSON.parse(r.stdout.trim());
    const webRepo = payload.repos.find((x: { name: string }) => x.name === 'web');
    assert.ok(webRepo, 'expected a web repo node');
    // Both documents live in the same file entry, in document order.
    const kinds = webRepo.files[0].manifests.map((m: { kind: string }) => m.kind);
    assert.deepEqual(kinds, ['service', 'stateful']);
  } finally {
    await cleanup(base);
    await cleanup(ws);
  }
});
