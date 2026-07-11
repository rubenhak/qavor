import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { composeUnitEnv, toEnvObject } from '../src/env/composer.js';
import { buildWorkspaceRegistry, type WorkspaceRegistry } from '../src/manifest/discovery.js';
import { loadManifestFile } from '../src/manifest/loader.js';
import {
  normalizeCommandValue,
  serviceCommandNames,
  serviceCommandSteps,
} from '../src/manifest/runtime.js';
import { composeStepOf, isCmdStep, stepOriginDir } from '../src/manifest/steps.js';
import type { ProfileManifest, ServiceManifest } from '../src/manifest/types/index.js';
import { validateDocument } from '../src/manifest/validator.js';
import { cleanup, makeTempDir, repoRoot, runCli } from './helpers/fixtures.js';

/**
 * Hermetic guardrail for the service library under `library/`. No docker is
 * required — live bring-up is exercised manually (see library/README.md).
 */
const libraryDir = path.join(repoRoot, 'library');
const TEMPLATES = ['kind', 'mysql', 'postgresql', 'redisearch'] as const;
/** Verbs every template must declare, uniformly. */
const VERBS = ['up', 'down', 'status', 'logs', 'purge'] as const;
/** Templates that ship a sibling compose file (kind is pure CLI). */
const COMPOSE_TEMPLATES = new Set(['mysql', 'postgresql', 'redisearch']);

async function buildRegistry(repo: string, cache: string): Promise<WorkspaceRegistry> {
  return buildWorkspaceRegistry({
    workspaceRoot: repo,
    repos: new Map([['repo', repo]]),
    env: { ...process.env, XDG_CACHE_HOME: cache },
  });
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
}

test('library sweep: every template is a valid profile + ready service pair', async () => {
  const names = new Set<string>();
  for (const template of TEMPLATES) {
    const file = path.join(libraryDir, template, 'qavor.yaml');
    const docs = await loadManifestFile(file);
    assert.equal(docs.length, 2, `${template}: expected profile + service documents`);

    const [profileDoc, serviceDoc] = docs;
    for (const doc of docs) {
      const res = validateDocument(doc!);
      assert.ok(
        res.ok,
        `${template}: ${JSON.stringify(res.ok ? [] : res.issues.map((i) => i.message))}`,
      );
    }

    const profile = profileDoc!.data as unknown as ProfileManifest;
    assert.equal(profileDoc!.kind, 'profile');
    assert.equal(profile.name, `lib-${template}`, `${template}: profile name convention`);
    assert.ok(profile.description, `${template}: profile needs a description`);
    assert.ok(!names.has(profile.name), `${template}: duplicate profile name`);
    names.add(profile.name);

    const service = serviceDoc!.data as unknown as ServiceManifest;
    assert.equal(serviceDoc!.kind, 'service');
    assert.deepEqual(service.profiles, [profile.name], `${template}: service references profile`);

    // Uniform verb set, each with a description; reserved lifecycle probes present.
    const backend = profile.runtime?.native as Record<string, unknown> | undefined;
    assert.ok(backend?.enabled === true, `${template}: runtime.native.enabled`);
    for (const verb of [...VERBS, 'check_installed', 'install']) {
      const command = backend?.[verb] as { description?: string } | undefined;
      assert.ok(command, `${template}: missing '${verb}'`);
      assert.ok(command.description, `${template}: '${verb}' needs a description`);
      assert.ok(
        normalizeCommandValue(command).length > 0,
        `${template}: '${verb}' needs operations`,
      );
    }

    // Every parameter is a long-form envSpec with a description, plus either
    // a default or (for a resolve-time-derived value) a cmd.
    const common = (profile.env?.common ?? {}) as Record<string, unknown>;
    assert.ok(Object.keys(common).length > 0, `${template}: env.common parameters expected`);
    for (const [key, spec] of Object.entries(common)) {
      assert.ok(
        typeof spec === 'object' &&
          spec !== null &&
          ('default' in spec || 'cmd' in spec) &&
          'description' in spec,
        `${template}: ${key} must be long-form with (default or cmd) + description`,
      );
    }
    assert.ok(profile.env?.publish, `${template}: publish contract expected`);

    if (COMPOSE_TEMPLATES.has(template)) {
      await fs.access(path.join(libraryDir, template, 'docker-compose.yaml'));
    }
  }
});

test('library portability: shell steps are POSIX sh (no bashisms, no shell overrides)', async () => {
  const bashisms = [/\[\[/, /pipefail/, /echo -e/, /\bfunction /];
  for (const template of TEMPLATES) {
    const docs = await loadManifestFile(path.join(libraryDir, template, 'qavor.yaml'));
    const profile = docs[0]!.data as unknown as ProfileManifest;
    const backend = (profile.runtime?.native ?? {}) as Record<string, unknown>;
    for (const [name, command] of Object.entries(backend)) {
      if (name === 'enabled') continue;
      for (const step of normalizeCommandValue(command)) {
        if (!isCmdStep(step)) continue;
        assert.equal(step.shell, undefined, `${template}/${name}: no shell overrides`);
        for (const re of bashisms) {
          assert.ok(!re.test(step.cmd), `${template}/${name}: bashism ${re} in: ${step.cmd}`);
        }
      }
    }
  }
});

test('library mode A: remote directory stub flattens; steps resolve against the library dir', async () => {
  const repo = await makeTempDir('qavor-lib-');
  const cache = await makeTempDir('qavor-libc-');
  try {
    const stubs = TEMPLATES.map((t) =>
      [
        'kind: service',
        `name: ${t === 'kind' ? 'kind-cluster' : t}`,
        `profiles: ["file://${path.join(libraryDir, t)}"]`,
      ].join('\n'),
    ).join('\n---\n');
    await writeTree(repo, { 'infra/qavor.yaml': stubs });

    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));

    for (const template of TEMPLATES) {
      const name = template === 'kind' ? 'kind-cluster' : template;
      const entry = reg.entries.find((e) => e.kind === 'service' && e.name === name);
      assert.ok(entry, `${template}: service entry`);
      assert.deepEqual(entry.appliedProfiles, [`lib-${template}`]);
      const svc = entry.data as unknown as ServiceManifest;
      assert.deepEqual(
        serviceCommandNames(svc)
          .filter((n) => (VERBS as readonly string[]).includes(n))
          .sort(),
        [...VERBS].sort(),
        `${template}: uniform verbs`,
      );
      const upSteps = serviceCommandSteps(svc, 'up');
      assert.equal(stepOriginDir(upSteps[0]!), path.join(libraryDir, template));
      if (COMPOSE_TEMPLATES.has(template)) {
        const composeStep = upSteps.map((s) => composeStepOf(s)).find((s) => s);
        assert.ok(composeStep, `${template}: up must contain a compose step`);
        await fs.access(path.join(stepOriginDir(upSteps[0]!)!, 'docker-compose.yaml'));
      }
    }
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('library mode B: vendoring the template files registers profile + service as-is', async () => {
  const repo = await makeTempDir('qavor-lib-');
  const cache = await makeTempDir('qavor-libc-');
  try {
    await fs.cp(path.join(libraryDir, 'mysql'), path.join(repo, 'infra/mysql'), {
      recursive: true,
    });
    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = reg.entries.find((e) => e.kind === 'service' && e.name === 'mysql');
    assert.ok(entry, 'vendored service registers');
    assert.deepEqual(entry.appliedProfiles, ['lib-mysql']);
    const steps = serviceCommandSteps(entry.data as unknown as ServiceManifest, 'up');
    // The vendored profile's dir is inside the workspace repo now.
    assert.equal(stepOriginDir(steps[0]!), path.join(repo, 'infra/mysql'));
    await fs.access(path.join(repo, 'infra/mysql/docker-compose.yaml'));
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('library env: defaults apply, stub overrides win, instance derives names', async () => {
  const repo = await makeTempDir('qavor-lib-');
  const cache = await makeTempDir('qavor-libc-');
  try {
    await writeTree(repo, {
      'infra/qavor.yaml': [
        'kind: service',
        'name: mysql',
        `profiles: ["file://${path.join(libraryDir, 'mysql')}"]`,
        'env:',
        '  common:',
        '    MYSQL_INSTANCE: alpha',
        '    MYSQL_PORT: 3307',
        '',
      ].join('\n'),
    });
    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = reg.entries.find((e) => e.kind === 'service' && e.name === 'mysql');
    assert.ok(entry);
    const env = toEnvObject(
      await composeUnitEnv({
        mode: 'native',
        target: entry,
        registry: reg,
        workspaceRoot: repo,
      }),
    );
    assert.equal(env.MYSQL_PORT, '3307', 'stub override wins');
    assert.equal(env.MYSQL_DATABASE, 'app', 'template default applies');
    assert.equal(env.MYSQL_PROJECT, 'qavor-mysql-alpha', 'derived from overridden instance');
    assert.equal(env.MYSQL_URL, 'mysql://app:app@127.0.0.1:3307/app', 'publish interpolates');
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('library overrides: $append extends up; $unset drops purge', async () => {
  const repo = await makeTempDir('qavor-lib-');
  const cache = await makeTempDir('qavor-libc-');
  try {
    await writeTree(repo, {
      'infra/qavor.yaml': [
        'kind: service',
        'name: mysql',
        `profiles: ["file://${path.join(libraryDir, 'mysql')}"]`,
        'runtime:',
        '  native:',
        '    up:',
        '      operations:',
        '        $append:',
        '          - cmd: echo seed schema',
        '    purge:',
        '      operations: { $unset: true }',
        '',
      ].join('\n'),
    });
    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = reg.entries.find((e) => e.kind === 'service' && e.name === 'mysql');
    assert.ok(entry);
    const svc = entry.data as unknown as ServiceManifest;

    const upSteps = serviceCommandSteps(svc, 'up');
    assert.equal(upSteps.length, 3, 'base network + compose steps plus appended seed');
    const last = upSteps[upSteps.length - 1]!;
    assert.ok(isCmdStep(last) && last.cmd === 'echo seed schema');
    assert.equal(stepOriginDir(last), undefined, 'appended step belongs to the stub');
    assert.ok(stepOriginDir(upSteps[0]!), 'inherited steps keep the library origin');

    assert.ok(!serviceCommandNames(svc).includes('purge'), '$unset drops purge');
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('library publish: dependents receive the contract, not template internals', async () => {
  const repo = await makeTempDir('qavor-lib-');
  const cache = await makeTempDir('qavor-libc-');
  try {
    await writeTree(repo, {
      'infra/qavor.yaml': [
        'kind: service',
        'name: mysql',
        `profiles: ["file://${path.join(libraryDir, 'mysql')}"]`,
        '',
      ].join('\n'),
      'app/qavor.yaml': ['kind: service', 'name: app', 'require:', '  - service: mysql', ''].join(
        '\n',
      ),
    });
    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const app = reg.entries.find((e) => e.kind === 'service' && e.name === 'app');
    assert.ok(app);
    const resolved = await composeUnitEnv({
      mode: 'native',
      target: app,
      registry: reg,
      workspaceRoot: repo,
    });
    const env = toEnvObject(resolved);
    assert.equal(env.MYSQL_URL, 'mysql://app:app@127.0.0.1:3306/app');
    assert.equal(env.MYSQL_HOST, '127.0.0.1');
    assert.equal(env.MYSQL_ROOT_PASSWORD, undefined, 'unpublished internals must not leak');
    const urlEntry = resolved.values.get('MYSQL_URL');
    assert.equal(urlEntry?.secret, true, 'published URL carries the secret flag');
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('library CLI smoke: qavor validate library passes', async () => {
  const res = await runCli(['validate', 'library'], { cwd: repoRoot });
  assert.equal(res.exitCode, 0, res.stderr);
});
