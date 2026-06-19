import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildWorkspaceRegistry } from '../src/manifest/discovery.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

/**
 * Lay out one repo on disk with a set of `<subdir>/qavor.yaml` manifests, then
 * build the workspace registry rooted at it. Returns the collected issues.
 */
async function buildRegistry(
  manifests: Record<string, string>,
): Promise<Awaited<ReturnType<typeof buildWorkspaceRegistry>>> {
  const repo = await makeTempDir('qavor-xref-');
  for (const [subdir, body] of Object.entries(manifests)) {
    const dir = path.join(repo, subdir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'qavor.yaml'), body);
  }
  try {
    return await buildWorkspaceRegistry({
      workspaceRoot: repo,
      repos: new Map([['repo', repo]]),
    });
  } finally {
    await cleanup(repo);
  }
}

test('cross-ref: missing require service dependency is reported', async () => {
  const reg = await buildRegistry({
    auth: ['kind: service', 'name: auth', 'require:', '  - service: ghost', ''].join('\n'),
  });
  assert.ok(
    reg.issues.some((i) => i.message.includes("service 'ghost'") && i.path === '/require/0'),
    `expected a missing-service issue, got ${JSON.stringify(reg.issues)}`,
  );
});

test('cross-ref: resolvable require deps produce no issues', async () => {
  const reg = await buildRegistry({
    auth: ['kind: service', 'name: auth', 'require:', '  - service: token-issuer', ''].join('\n'),
    issuer: ['kind: service', 'name: token-issuer', ''].join('\n'),
    pg: ['kind: service', 'name: postgres', 'mode: docker-compose', ''].join('\n'),
    db: ['kind: service', 'name: db', 'require:', '  - service: postgres', ''].join('\n'),
  });
  assert.equal(reg.issues.length, 0, `expected no issues, got ${JSON.stringify(reg.issues)}`);
});

test('cross-ref: optional missing dependency is allowed', async () => {
  const reg = await buildRegistry({
    auth: [
      'kind: service',
      'name: auth',
      'require:',
      '  - service: ghost',
      '    optional: true',
      '',
    ].join('\n'),
  });
  assert.equal(
    reg.issues.length,
    0,
    `optional deps must not error, got ${JSON.stringify(reg.issues)}`,
  );
});

test('cross-ref: undefined profile reference is reported', async () => {
  const reg = await buildRegistry({
    auth: ['kind: service', 'name: auth', 'profiles: [nope]', ''].join('\n'),
  });
  assert.ok(
    reg.issues.some((i) => i.message.includes("profile 'nope'") && i.path === '/profiles/0'),
    `expected a missing-profile issue, got ${JSON.stringify(reg.issues)}`,
  );
});

test('cross-ref: defined profile reference resolves', async () => {
  const reg = await buildRegistry({
    auth: ['kind: service', 'name: auth', 'profiles: [base]', ''].join('\n'),
    base: ['kind: profile', 'name: base', ''].join('\n'),
  });
  assert.equal(reg.issues.length, 0, `expected no issues, got ${JSON.stringify(reg.issues)}`);
});

test('cross-ref: undefined require group is reported, declared group resolves', async () => {
  const missing = await buildRegistry({
    auth: ['kind: service', 'name: auth', 'require:', '  - group: backend', ''].join('\n'),
  });
  assert.ok(
    missing.issues.some((i) => i.message.includes("group 'backend'")),
    `expected a missing-group issue, got ${JSON.stringify(missing.issues)}`,
  );

  const declared = await buildRegistry({
    auth: [
      'kind: service',
      'name: auth',
      'groups: [backend]',
      'require:',
      '  - group: backend',
      '',
    ].join('\n'),
  });
  assert.equal(
    declared.issues.length,
    0,
    `declared group must resolve, got ${JSON.stringify(declared.issues)}`,
  );
});
