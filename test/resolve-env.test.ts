import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { composeUnitEnv } from '../src/env/composer.js';
import type { RegistryEntry, WorkspaceRegistry } from '../src/manifest/discovery.js';
import { loadManifestFile } from '../src/manifest/loader.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

/**
 * Write a `<dir>/qavor.yaml` and any sibling dotenv files, then load it into a
 * RegistryEntry so we can exercise composeUnitEnv without a full workspace.
 */
async function makeEntry(
  workspaceRoot: string,
  subdir: string,
  manifest: string,
  dotenvs: Record<string, string> = {},
): Promise<RegistryEntry> {
  const dir = path.join(workspaceRoot, subdir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'qavor.yaml'), manifest);
  for (const [name, body] of Object.entries(dotenvs)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  const docs = await loadManifestFile(path.join(dir, 'qavor.yaml'));
  const doc = docs[0]!;
  const data = doc.data as { name?: string; kind?: string };
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

test('resolve-env: require service deps flow at lowest precedence', async () => {
  const ws = await makeTempDir('qavor-resolve-');
  try {
    const dep = await makeEntry(
      ws,
      'token-issuer',
      [
        'kind: service',
        'name: token-issuer',
        'env:',
        '  common: { ISSUER_URL: http://issuer:9000, SHARED: from-dep }',
        '',
      ].join('\n'),
    );
    const target = await makeEntry(
      ws,
      'auth',
      [
        'kind: service',
        'name: auth',
        'require:',
        '  - service: token-issuer',
        'env:',
        '  common: { PORT: 8080, SHARED: from-self }',
        '',
      ].join('\n'),
    );
    const resolved = await composeUnitEnv({
      mode: 'native',
      target,
      registry: registryOf([dep, target]),
      workspaceRoot: ws,
    });
    assert.equal(resolved.issues.length, 0);
    // Dep value flows through.
    assert.equal(resolved.values.get('ISSUER_URL')?.value, 'http://issuer:9000');
    assert.equal(resolved.values.get('PORT')?.value, '8080');
    // Own env wins over the dep for a shared key.
    assert.equal(resolved.values.get('SHARED')?.value, 'from-self');
  } finally {
    await cleanup(ws);
  }
});

test('resolve-env: only env.publish flows from a backing-service dep', async () => {
  const ws = await makeTempDir('qavor-resolve-');
  try {
    const pg = await makeEntry(
      ws,
      'postgres',
      [
        'kind: service',
        'name: postgres',
        'mode: docker-compose',
        'env:',
        '  common: { POSTGRES_DB: auth, POSTGRES_PASSWORD: topsecret }',
        '  docker: { POSTGRES_HOST: mypostgres, POSTGRES_PORT: 5432 }',
        '  publish:',
        '    POSTGRES_HOST: "${POSTGRES_HOST}"',
        '    POSTGRES_URL: "postgres://auth@${POSTGRES_HOST}:${POSTGRES_PORT}/auth"',
        '',
      ].join('\n'),
    );
    const target = await makeEntry(
      ws,
      'auth',
      [
        'kind: service',
        'name: auth',
        'require:',
        '  - service: postgres',
        'env:',
        '  common: { PORT: 8080 }',
        '',
      ].join('\n'),
    );
    const resolved = await composeUnitEnv({
      mode: 'native',
      target,
      registry: registryOf([pg, target]),
      workspaceRoot: ws,
    });
    assert.equal(resolved.issues.length, 0);
    // Published, interpolated against the backing service's docker env.
    assert.equal(resolved.values.get('POSTGRES_HOST')?.value, 'mypostgres');
    assert.equal(
      resolved.values.get('POSTGRES_URL')?.value,
      'postgres://auth@mypostgres:5432/auth',
    );
    // Private keys never leak to the dependent.
    assert.equal(resolved.values.get('POSTGRES_PASSWORD'), undefined);
    assert.equal(resolved.values.get('POSTGRES_DB'), undefined);
  } finally {
    await cleanup(ws);
  }
});

test('resolve-env: .env.container overrides docker env in qavor.yaml', async () => {
  const ws = await makeTempDir('qavor-resolve-');
  try {
    const target = await makeEntry(
      ws,
      'web',
      [
        'kind: service',
        'name: web',
        'env:',
        '  common: { A: c1 }',
        '  docker: { A: d1, B: d1 }',
        '',
      ].join('\n'),
      { '.env.container': 'B=fromcontainer\n' },
    );
    const resolved = await composeUnitEnv({
      mode: 'docker',
      target,
      registry: registryOf([target]),
      workspaceRoot: ws,
    });
    assert.equal(resolved.values.get('A')?.value, 'd1');
    assert.equal(resolved.values.get('B')?.value, 'fromcontainer');
  } finally {
    await cleanup(ws);
  }
});

test('resolve-env: missing non-optional require dep raises an issue', async () => {
  const ws = await makeTempDir('qavor-resolve-');
  try {
    const target = await makeEntry(
      ws,
      'auth',
      [
        'kind: service',
        'name: auth',
        'require:',
        '  - service: ghost',
        'env:',
        '  common: { PORT: 8080 }',
        '',
      ].join('\n'),
    );
    const resolved = await composeUnitEnv({
      mode: 'native',
      target,
      registry: registryOf([target]),
      workspaceRoot: ws,
    });
    assert.ok(
      resolved.issues.some((i) => i.message.includes("'ghost'")),
      'expected an issue for the missing dependency',
    );
  } finally {
    await cleanup(ws);
  }
});

test('resolve-env: transitive require deps resolve recursively without cycling', async () => {
  const ws = await makeTempDir('qavor-resolve-');
  try {
    const c = await makeEntry(
      ws,
      'c',
      ['kind: service', 'name: c', 'env: { common: { DEEP: from-c } }', ''].join('\n'),
    );
    const b = await makeEntry(
      ws,
      'b',
      [
        'kind: service',
        'name: b',
        'require: [ { service: c }, { service: a } ]', // a<->b cycle guarded by visited set
        'env: { common: { MID: from-b } }',
        '',
      ].join('\n'),
    );
    const a = await makeEntry(
      ws,
      'a',
      [
        'kind: service',
        'name: a',
        'require: [ { service: b } ]',
        'env: { common: { TOP: from-a } }',
        '',
      ].join('\n'),
    );
    const resolved = await composeUnitEnv({
      mode: 'native',
      target: a,
      registry: registryOf([a, b, c]),
      workspaceRoot: ws,
    });
    assert.equal(resolved.issues.length, 0);
    assert.equal(resolved.values.get('DEEP')?.value, 'from-c');
    assert.equal(resolved.values.get('MID')?.value, 'from-b');
    assert.equal(resolved.values.get('TOP')?.value, 'from-a');
  } finally {
    await cleanup(ws);
  }
});
