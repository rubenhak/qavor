import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { composeServiceEnv, parseCliEnv } from '../src/env/composer.js';
import { loadManifestFile } from '../src/manifest/loader.js';
import type { ServiceManifest } from '../src/manifest/types/index.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

async function setup(opts: {
  manifest: string;
  dotenv?: string;
  dotenvNative?: string;
  workspaceDotenv?: string;
}): Promise<{
  workspaceRoot: string;
  manifestFile: string;
  cleanupFn: () => Promise<void>;
}> {
  const ws = await makeTempDir('qavor-env-');
  const manifestFile = path.join(ws, 'svc', 'qavor.yaml');
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await fs.writeFile(manifestFile, opts.manifest);
  if (opts.dotenv) await fs.writeFile(path.join(ws, 'svc', '.env'), opts.dotenv);
  if (opts.dotenvNative) await fs.writeFile(path.join(ws, 'svc', '.env.native'), opts.dotenvNative);
  if (opts.workspaceDotenv) await fs.writeFile(path.join(ws, '.env'), opts.workspaceDotenv);
  return { workspaceRoot: ws, manifestFile, cleanupFn: () => cleanup(ws) };
}

test('env: precedence common < native < .env < .env.native < workspace .env < cli', async () => {
  const { workspaceRoot, manifestFile, cleanupFn } = await setup({
    manifest: [
      'kind: service',
      'name: alpha',
      'env:',
      '  common: { A: c1, B: c1, C: c1, D: c1, E: c1, F: c1 }',
      '  native: { B: n1, C: n1, D: n1, E: n1, F: n1 }',
      'runtime:',
      '  native:',
      '    enabled: true',
      '    run: { cmd: "true" }',
      '',
    ].join('\n'),
    dotenv: 'C=env\nD=env\nE=env\nF=env\n',
    dotenvNative: 'D=envn\nE=envn\nF=envn\n',
    workspaceDotenv: 'E=ws\nF=ws\n',
  });
  try {
    const docs = await loadManifestFile(manifestFile);
    const composed = await composeServiceEnv({
      mode: 'native',
      serviceDoc: docs[0]!,
      service: docs[0]?.data as unknown as ServiceManifest,
      workspaceRoot,
      cliEnv: { F: 'cli' },
    });
    assert.equal(composed.values.get('A')?.value, 'c1');
    assert.equal(composed.values.get('B')?.value, 'n1');
    assert.equal(composed.values.get('C')?.value, 'env');
    assert.equal(composed.values.get('D')?.value, 'envn');
    assert.equal(composed.values.get('E')?.value, 'ws');
    assert.equal(composed.values.get('F')?.value, 'cli');
    assert.equal(composed.issues.length, 0);
  } finally {
    await cleanupFn();
  }
});

test('env: interpolation against prior layers', async () => {
  const { workspaceRoot, manifestFile, cleanupFn } = await setup({
    manifest: [
      'kind: service',
      'name: alpha',
      'env:',
      '  common: { HOST: localhost, PORT: 8080, URL: "http://${HOST}:${PORT}/api" }',
      'runtime:',
      '  native:',
      '    enabled: true',
      '    run: { cmd: "true" }',
      '',
    ].join('\n'),
  });
  try {
    const docs = await loadManifestFile(manifestFile);
    const composed = await composeServiceEnv({
      mode: 'native',
      serviceDoc: docs[0]!,
      service: docs[0]?.data as unknown as ServiceManifest,
      workspaceRoot,
    });
    assert.equal(composed.values.get('URL')?.value, 'http://localhost:8080/api');
  } finally {
    await cleanupFn();
  }
});

test('env: missing required envSpec fails', async () => {
  const { workspaceRoot, manifestFile, cleanupFn } = await setup({
    manifest: [
      'kind: service',
      'name: alpha',
      'env:',
      '  common:',
      '    SECRET_VALUE:',
      '      required: true',
      '      description: "must be supplied via .env or CLI"',
      'runtime:',
      '  native:',
      '    enabled: true',
      '    run: { cmd: "true" }',
      '',
    ].join('\n'),
  });
  try {
    const docs = await loadManifestFile(manifestFile);
    const composed = await composeServiceEnv({
      mode: 'native',
      serviceDoc: docs[0]!,
      service: docs[0]?.data as unknown as ServiceManifest,
      workspaceRoot,
    });
    assert.ok(composed.issues.length > 0, 'expected an issue for missing required env');
  } finally {
    await cleanupFn();
  }
});

test('env: ${secret:...} fails closed at v0', async () => {
  const { workspaceRoot, manifestFile, cleanupFn } = await setup({
    manifest: [
      'kind: service',
      'name: alpha',
      'env:',
      '  common: { PWD: "${secret:DB_PW}" }',
      'runtime:',
      '  native:',
      '    enabled: true',
      '    run: { cmd: "true" }',
      '',
    ].join('\n'),
  });
  try {
    const docs = await loadManifestFile(manifestFile);
    const composed = await composeServiceEnv({
      mode: 'native',
      serviceDoc: docs[0]!,
      service: docs[0]?.data as unknown as ServiceManifest,
      workspaceRoot,
    });
    assert.ok(
      composed.issues.some((i) => i.message.includes('reserved')),
      'secret syntax should fail closed',
    );
  } finally {
    await cleanupFn();
  }
});

test('parseCliEnv: parses KEY=VAL pairs', () => {
  const parsed = parseCliEnv(['A=1', 'B=hello world', 'C=']);
  assert.equal(parsed.A, '1');
  assert.equal(parsed.B, 'hello world');
  assert.equal(parsed.C, '');
});

test('parseCliEnv: rejects missing equals', () => {
  assert.throws(() => parseCliEnv(['ABC']));
});
