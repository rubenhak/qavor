import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { parse } from 'yaml';
import { cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

/** Create a git repo populated with the given relative-path → contents map. */
async function makeSingleRepo(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir('qavor-single-');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'qavor-test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Qavor Test'], { cwd: dir });
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const CASE1_ROOT = `kind: project
name: my-app
standalone: true
---
kind: service
name: api
mode: native
runtime:
  native:
    enabled: true
    run:
      cmd: node .
`;

const CASE2_ROOT = `kind: project
name: my-platform
standalone: true
`;

function serviceManifest(name: string): string {
  return `kind: service
name: ${name}
mode: native
runtime:
  native:
    enabled: true
    run:
      cmd: node .
`;
}

function serviceNames(manifestsJson: string): string[] {
  const parsed = JSON.parse(manifestsJson) as {
    repos: { files: { manifests: { kind: string; name: string }[] }[] }[];
  };
  const out: string[] = [];
  for (const repo of parsed.repos) {
    for (const file of repo.files) {
      for (const m of file.manifests) if (m.kind === 'service') out.push(m.name);
    }
  }
  return out.sort();
}

test('single-repo: case 1 (one top-level service) is detected with no init', async () => {
  const repo = await makeSingleRepo({ 'qavor.yaml': CASE1_ROOT });
  try {
    const r = await runCli(['manifests', '--json'], { cwd: repo });
    assert.equal(r.exitCode, 0, `manifests failed: ${r.stderr}`);
    assert.deepEqual(serviceNames(r.stdout), ['api']);

    // Lazy bootstrap created the in-repo state dir and recorded the layout.
    const meta = JSON.parse(await fs.readFile(path.join(repo, '.qavor', 'workspace.json'), 'utf8'));
    assert.equal(meta.layout, 'single-repo');
    assert.equal(meta.project_name, 'my-app');

    // The repo-root .gitignore ignores the state dir.
    const gi = await fs.readFile(path.join(repo, '.gitignore'), 'utf8');
    assert.match(gi, /^\.qavor\/$/m);
  } finally {
    await cleanup(repo);
  }
});

test('single-repo: case 2 (services in sub-directories) are all discovered', async () => {
  const repo = await makeSingleRepo({
    'qavor.yaml': CASE2_ROOT,
    'services/gateway/qavor.yaml': serviceManifest('gateway'),
    'services/worker/qavor.yaml': serviceManifest('worker'),
  });
  try {
    const r = await runCli(['manifests', '--json'], { cwd: repo });
    assert.equal(r.exitCode, 0, `manifests failed: ${r.stderr}`);
    assert.deepEqual(serviceNames(r.stdout), ['gateway', 'worker']);
  } finally {
    await cleanup(repo);
  }
});

test('single-repo: git status operates on the repo itself', async () => {
  const repo = await makeSingleRepo({ 'qavor.yaml': CASE1_ROOT });
  try {
    await fs.writeFile(path.join(repo, 'extra.txt'), 'hello');
    const r = await runCli(['git', 'status', '--json'], { cwd: repo });
    assert.equal(r.exitCode, 0, `status failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as {
      repos: { repo: string; dirty: number; branch: string }[];
    };
    assert.equal(parsed.repos.length, 1);
    const self = parsed.repos[0]!;
    assert.equal(self.repo, 'my-app');
    assert.equal(self.branch, 'main');
    assert.ok(self.dirty >= 1, 'expected a dirty working tree');
  } finally {
    await cleanup(repo);
  }
});

test('single-repo: discover scaffolds services for Dockerfile sub-dirs', async () => {
  const repo = await makeSingleRepo({
    'qavor.yaml': CASE2_ROOT,
    'services/api/Dockerfile': 'FROM scratch\n',
    'services/plain/README.md': 'no dockerfile here\n',
  });
  try {
    const r = await runCli(['discover'], { cwd: repo });
    assert.equal(r.exitCode, 0, `discover failed: ${r.stderr}`);

    // api ships a Dockerfile → a service manifest is scaffolded.
    const api = parse(await fs.readFile(path.join(repo, 'services', 'api', 'qavor.yaml'), 'utf8'));
    assert.equal(api.kind, 'service');
    assert.equal(api.name, 'api');

    // plain has no Dockerfile → left untouched.
    await assert.rejects(fs.access(path.join(repo, 'services', 'plain', 'qavor.yaml')));

    // repositories is never written for a standalone project.
    const rootDocs = await fs.readFile(path.join(repo, 'qavor.yaml'), 'utf8');
    assert.doesNotMatch(rootDocs, /repositories:/);
  } finally {
    await cleanup(repo);
  }
});

test('single-repo: a non-standalone project with no pointer errors clearly', async () => {
  const repo = await makeSingleRepo({
    'qavor.yaml': 'kind: project\nname: broken\nrepositories:\n  - web\n',
  });
  try {
    const r = await runCli(['manifests'], { cwd: repo });
    assert.notEqual(r.exitCode, 0, 'expected failure without a workspace pointer');
    assert.match(r.stderr, /no .*workspaces.* pointer|qavor init/i);
  } finally {
    await cleanup(repo);
  }
});

test('single-repo: schema rejects standalone + repositories together', async () => {
  const repo = await makeSingleRepo({
    'qavor.yaml': 'kind: project\nname: bad\nstandalone: true\nrepositories:\n  - web\n',
  });
  try {
    const r = await runCli(['validate', path.join(repo, 'qavor.yaml')], { cwd: repo });
    assert.notEqual(r.exitCode, 0, 'expected schema validation failure');
  } finally {
    await cleanup(repo);
  }
});
