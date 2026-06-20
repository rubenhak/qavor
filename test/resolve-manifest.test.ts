import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { RegistryEntry, WorkspaceRegistry } from '../src/manifest/discovery.js';
import { loadManifestFile } from '../src/manifest/loader.js';
import { findManifest, resolveManifest } from '../src/manifest/resolve.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

async function makeEntry(
  workspaceRoot: string,
  subdir: string,
  manifest: string,
): Promise<RegistryEntry> {
  const dir = path.join(workspaceRoot, subdir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'qavor.yaml'), manifest);
  const docs = await loadManifestFile(path.join(dir, 'qavor.yaml'));
  const doc = docs[0]!;
  const data = doc.data as { name?: string };
  return {
    kind: doc.kind as RegistryEntry['kind'],
    name: typeof data.name === 'string' ? data.name : '',
    file: doc.file,
    docIndex: doc.docIndex,
    dir,
    data: doc.data,
    position: doc.position,
  };
}

function registryOf(entries: RegistryEntry[]): WorkspaceRegistry {
  const byName = new Map<string, RegistryEntry>();
  for (const e of entries) if (e.name) byName.set(e.name, e);
  return { byName, entries, issues: [] };
}

test('resolve-manifest: profile env/runtime/mode merged below the service own values', async () => {
  const ws = await makeTempDir('qavor-resolve-manifest-');
  try {
    const profile = await makeEntry(
      ws,
      'profiles',
      [
        'kind: profile',
        'name: python_application',
        'mode: docker',
        'runtime:',
        '  native: { enabled: true, run: { cmd: "uv run app" } }',
        'env:',
        '  common: { LOG_LEVEL: info, RUNTIME: python }',
        '',
      ].join('\n'),
    );
    const service = await makeEntry(
      ws,
      'auth',
      [
        'kind: service',
        'name: auth',
        'profiles: [python_application]',
        'mode: native',
        'runtime:',
        '  native: { run: { cmd: "uv run uvicorn app:app" } }',
        'env:',
        '  common: { LOG_LEVEL: debug, PORT: 8080 }',
        '',
      ].join('\n'),
    );
    const resolved = resolveManifest(service, registryOf([profile, service]));

    // profiles: is baked in and removed.
    assert.equal('profiles' in resolved.data, false);
    assert.deepEqual(resolved.appliedProfiles, ['python_application']);

    // mode: own value wins.
    assert.equal(resolved.data.mode, 'native');

    // env: deep-merged, own wins per key, profile-only keys survive.
    const env = resolved.data.env as { common: Record<string, unknown> };
    assert.equal(env.common.LOG_LEVEL, 'debug');
    assert.equal(env.common.PORT, 8080);
    assert.equal(env.common.RUNTIME, 'python');

    // runtime: deep-merged at the step level, own cmd wins.
    const runtime = resolved.data.runtime as {
      native: { enabled: boolean; run: { cmd: string } };
    };
    assert.equal(runtime.native.enabled, true);
    assert.equal(runtime.native.run.cmd, 'uv run uvicorn app:app');
  } finally {
    await cleanup(ws);
  }
});

test('resolve-manifest: chained profiles resolve with later entries winning', async () => {
  const ws = await makeTempDir('qavor-resolve-manifest-');
  try {
    const base = await makeEntry(
      ws,
      'base',
      ['kind: profile', 'name: base', 'env: { common: { A: base, B: base } }', ''].join('\n'),
    );
    const mid = await makeEntry(
      ws,
      'mid',
      [
        'kind: profile',
        'name: mid',
        'profiles: [base]',
        'env: { common: { B: mid, C: mid } }',
        '',
      ].join('\n'),
    );
    const service = await makeEntry(
      ws,
      'svc',
      [
        'kind: service',
        'name: svc',
        'profiles: [mid]',
        'env: { common: { C: svc, D: svc } }',
        '',
      ].join('\n'),
    );
    const resolved = resolveManifest(service, registryOf([base, mid, service]));
    const env = resolved.data.env as { common: Record<string, unknown> };
    assert.equal(env.common.A, 'base');
    assert.equal(env.common.B, 'mid');
    assert.equal(env.common.C, 'svc');
    assert.equal(env.common.D, 'svc');
    assert.deepEqual(resolved.appliedProfiles, ['base', 'mid']);
  } finally {
    await cleanup(ws);
  }
});

test('resolve-manifest: later profile wins over earlier in the same list', async () => {
  const ws = await makeTempDir('qavor-resolve-manifest-');
  try {
    const first = await makeEntry(
      ws,
      'first',
      ['kind: profile', 'name: first', 'env: { common: { X: first } }', ''].join('\n'),
    );
    const second = await makeEntry(
      ws,
      'second',
      ['kind: profile', 'name: second', 'env: { common: { X: second } }', ''].join('\n'),
    );
    const service = await makeEntry(
      ws,
      'svc',
      ['kind: service', 'name: svc', 'profiles: [first, second]', ''].join('\n'),
    );
    const resolved = resolveManifest(service, registryOf([first, second, service]));
    const env = resolved.data.env as { common: Record<string, unknown> };
    assert.equal(env.common.X, 'second');
  } finally {
    await cleanup(ws);
  }
});

test('resolve-manifest: a profile cycle is reported as a manifest error', async () => {
  const ws = await makeTempDir('qavor-resolve-manifest-');
  try {
    const a = await makeEntry(
      ws,
      'a',
      ['kind: profile', 'name: a', 'profiles: [b]', ''].join('\n'),
    );
    const b = await makeEntry(
      ws,
      'b',
      ['kind: profile', 'name: b', 'profiles: [a]', ''].join('\n'),
    );
    const service = await makeEntry(
      ws,
      'svc',
      ['kind: service', 'name: svc', 'profiles: [a]', ''].join('\n'),
    );
    assert.throws(() => resolveManifest(service, registryOf([a, b, service])), /cycle detected/i);
  } finally {
    await cleanup(ws);
  }
});

test('resolve-manifest: a missing profile reference is reported', async () => {
  const ws = await makeTempDir('qavor-resolve-manifest-');
  try {
    const service = await makeEntry(
      ws,
      'svc',
      ['kind: service', 'name: svc', 'profiles: [ghost]', ''].join('\n'),
    );
    assert.throws(() => resolveManifest(service, registryOf([service])), /ghost/);
  } finally {
    await cleanup(ws);
  }
});

test('resolve-manifest: findManifest requires --kind when the name is ambiguous', async () => {
  const ws = await makeTempDir('qavor-resolve-manifest-');
  try {
    const svc = await makeEntry(ws, 'svc', ['kind: service', 'name: shared', ''].join('\n'));
    const prof = await makeEntry(ws, 'prof', ['kind: profile', 'name: shared', ''].join('\n'));
    const registry = registryOf([svc, prof]);
    assert.throws(() => findManifest(registry, 'shared'), /ambiguous/i);
    // Disambiguated lookups succeed.
    assert.equal(findManifest(registry, 'shared', 'service').kind, 'service');
    assert.equal(findManifest(registry, 'shared', 'profile').kind, 'profile');
    // Unknown names error with the available list.
    assert.throws(() => findManifest(registry, 'nope'), /No 'nope' manifest/);
  } finally {
    await cleanup(ws);
  }
});

test('resolve-manifest: a profile-free manifest passes through unchanged', async () => {
  const ws = await makeTempDir('qavor-resolve-manifest-');
  try {
    const service = await makeEntry(
      ws,
      'svc',
      ['kind: service', 'name: svc', 'env: { common: { PORT: 8080 } }', ''].join('\n'),
    );
    const resolved = resolveManifest(service, registryOf([service]));
    assert.deepEqual(resolved.appliedProfiles, []);
    assert.deepEqual(resolved.data.env, { common: { PORT: 8080 } });
  } finally {
    await cleanup(ws);
  }
});
