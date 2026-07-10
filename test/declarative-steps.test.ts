import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runServiceCommand } from '../src/command/command.js';
import { composeArgv } from '../src/command/compose-step.js';
import { dockerRunArgv } from '../src/command/docker-step.js';
import { interpolateDeep, interpolateValue } from '../src/command/interpolate.js';
import { buildWorkspaceRegistry, type WorkspaceRegistry } from '../src/manifest/discovery.js';
import { type LoadedDocument, loadManifestFile } from '../src/manifest/loader.js';
import { stripStepOrigins } from '../src/manifest/resolve.js';
import { serviceCommandSteps } from '../src/manifest/runtime.js';
import { composeStepOf, stepOriginDir } from '../src/manifest/steps.js';
import type { ComposeStep, DockerStep, ServiceManifest } from '../src/manifest/types/index.js';
import { validateDocument } from '../src/manifest/validator.js';
import { getLogger } from '../src/util/logger.js';
import type { WorkspacePaths } from '../src/workspace/paths.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

async function validateService(dir: string, runtimeYaml: string[]): Promise<boolean> {
  const file = path.join(dir, 'qavor.yaml');
  await fs.writeFile(
    file,
    ['kind: service', 'name: svc', 'runtime:', '  native:', ...runtimeYaml, ''].join('\n'),
  );
  const docs = await loadManifestFile(file);
  return validateDocument(docs[0]!).ok;
}

test('schema: compose and docker steps validate; malformed steps are rejected', async () => {
  const dir = await makeTempDir();
  try {
    assert.equal(
      await validateService(dir, [
        '    up:',
        '      operations:',
        '        - cmd: echo hi',
        '        - compose: { action: up, project: p1, wait: true, timeout: 60 }',
        '        - docker: { action: up, name: c1, image: "redis:7" }',
      ]),
      true,
      'valid mixed steps must pass',
    );
    assert.equal(
      await validateService(dir, [
        '    up:',
        '      operations:',
        '        - compose: { project: p1 }', // missing action
      ]),
      false,
      'compose step without action must fail',
    );
    assert.equal(
      await validateService(dir, [
        '    up:',
        '      operations:',
        '        - docker: { action: up }', // missing name
      ]),
      false,
      'docker step without name must fail',
    );
    assert.equal(
      await validateService(dir, [
        '    up:',
        '      operations:',
        '        - compose: { action: up, bogus: 1 }',
      ]),
      false,
      'unknown compose field must fail',
    );
    assert.equal(
      await validateService(dir, [
        '    up:',
        '      operations:',
        '        - { cmd: echo hi, compose: { action: up } }',
      ]),
      false,
      'a step mixing two kinds must fail',
    );
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Argv builders
// ---------------------------------------------------------------------------

test('composeArgv: up maps every modeled flag and resolves files against assetDir', () => {
  const step: ComposeStep = {
    action: 'up',
    file: ['./docker-compose.yaml', './override.yaml'],
    project: 'proj',
    profiles: ['debug'],
    env_file: './extra.env',
    wait: true,
    timeout: 45,
    build: true,
    force_recreate: true,
    remove_orphans: true,
    args: ['--quiet-pull'],
    services: ['db'],
  };
  const argv = composeArgv(step, { assetDir: '/lib/pg', serviceName: 'pg' });
  assert.deepEqual(argv, [
    'compose',
    '-p',
    'proj',
    '-f',
    '/lib/pg/docker-compose.yaml',
    '-f',
    '/lib/pg/override.yaml',
    '--profile',
    'debug',
    '--env-file',
    '/lib/pg/extra.env',
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '45',
    '--build',
    '--force-recreate',
    '--remove-orphans',
    '--quiet-pull',
    'db',
  ]);
});

test('composeArgv: defaults — file, project from service name; down/logs flags', () => {
  const down = composeArgv({ action: 'down', volumes: true }, { assetDir: '/d', serviceName: 's' });
  assert.deepEqual(down, [
    'compose',
    '-p',
    'qavor-s',
    '-f',
    '/d/docker-compose.yaml',
    'down',
    '--volumes',
  ]);
  const logs = composeArgv(
    { action: 'logs', tail: 100, follow: true },
    { assetDir: '/d', serviceName: 's' },
  );
  assert.ok(logs.join(' ').endsWith('logs --tail 100 --follow'), logs.join(' '));
});

test('dockerRunArgv: maps container fields; requires an image', () => {
  const step: DockerStep = {
    action: 'up',
    name: 'c1',
    image: 'redis:7.4',
    ports: ['6379:6379'],
    env: { A: 'x', B: 2 },
    volumes: ['v1:/data'],
    network: 'qavor',
    restart: 'unless-stopped',
    labels: { 'qavor.managed': 'true' },
    pull: 'missing',
    healthcheck: { test: 'redis-cli ping', interval: '2s', retries: 30 },
    args: ['--memory=1g'],
    command: 'redis-server --save 60',
  };
  const argv = dockerRunArgv(step);
  assert.deepEqual(argv, [
    'run',
    '-d',
    '--name',
    'c1',
    '-p',
    '6379:6379',
    '-e',
    'A=x',
    '-e',
    'B=2',
    '-v',
    'v1:/data',
    '--network',
    'qavor',
    '--restart',
    'unless-stopped',
    '--label',
    'qavor.managed=true',
    '--pull',
    'missing',
    '--health-cmd',
    'redis-cli ping',
    '--health-interval',
    '2s',
    '--health-retries',
    '30',
    '--memory=1g',
    'redis:7.4',
    'redis-server',
    '--save',
    '60',
  ]);
  assert.throws(() => dockerRunArgv({ action: 'run', name: 'c1' }), /requires an image/);
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

test('interpolate: resolves ${VAR}, fails closed on unresolved and ${secret:…}', () => {
  const env = { PORT: '5432', NAME: 'pg' };
  assert.equal(interpolateValue('qavor-${NAME}-${PORT}', env, 't'), 'qavor-pg-5432');
  assert.throws(() => interpolateValue('${MISSING}', env, 't'), /Unresolved \$\{MISSING\}/);
  assert.throws(() => interpolateValue('${secret:TOKEN}', env, 't'), /fails closed/);

  const deep = interpolateDeep(
    { project: '${NAME}', ports: ['${PORT}:5432'], nested: { keep: 7, ok: true } },
    env,
    't',
  );
  assert.deepEqual(deep, {
    project: 'pg',
    ports: ['5432:5432'],
    nested: { keep: 7, ok: true },
  });
});

// ---------------------------------------------------------------------------
// Origin-dir annotation + end-to-end execution with a fake docker on PATH
// ---------------------------------------------------------------------------

const PROFILE_YAML = [
  'kind: profile',
  'name: lib-pg',
  'mode: native',
  'env:',
  '  common:',
  '    PG_PROJECT: { default: qavor-pg-main }',
  '    PG_TIMEOUT: { default: "45" }',
  'runtime:',
  '  native:',
  '    enabled: true',
  '    up:',
  '      description: bring up',
  '      operations:',
  '        - compose: { action: up, project: "${PG_PROJECT}", wait: true, timeout: "${PG_TIMEOUT}" }',
  '',
].join('\n');

const COMPOSE_YAML = ['services:', '  pg:', '    image: postgres', ''].join('\n');

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
}

async function buildRegistry(repo: string, cache: string): Promise<WorkspaceRegistry> {
  return buildWorkspaceRegistry({
    workspaceRoot: repo,
    repos: new Map([['repo', repo]]),
    env: { ...process.env, XDG_CACHE_HOME: cache },
  });
}

test('origin: profile-contributed steps carry the profile dir; service steps do not', async () => {
  const repo = await makeTempDir('qavor-ds-');
  // The library lives OUTSIDE the workspace repo — as it does for real
  // consumers — so discovery doesn't also register it as a local profile.
  const lib = await makeTempDir('qavor-dslib-');
  const cache = await makeTempDir('qavor-dsc-');
  try {
    await writeTree(lib, {
      'pg/qavor.yaml': PROFILE_YAML,
      'pg/docker-compose.yaml': COMPOSE_YAML,
    });
    await writeTree(repo, {
      'svc/qavor.yaml': [
        'kind: service',
        'name: pg',
        `profiles: ["file://${path.join(lib, 'pg')}"]`, // directory form
        'runtime:',
        '  native:',
        '    own: { operations: { cmd: echo own } }',
        '',
      ].join('\n'),
    });
    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = reg.entries.find((e) => e.kind === 'service' && e.name === 'pg');
    assert.ok(entry);
    const svc = entry.data as unknown as ServiceManifest;

    const upSteps = serviceCommandSteps(svc, 'up');
    assert.equal(upSteps.length, 1);
    assert.equal(stepOriginDir(upSteps[0]!), path.join(lib, 'pg'));
    // The sibling compose file is reachable from the origin dir.
    await fs.access(path.join(stepOriginDir(upSteps[0]!)!, 'docker-compose.yaml'));

    const ownSteps = serviceCommandSteps(svc, 'own');
    assert.equal(stepOriginDir(ownSteps[0]!), undefined, "service's own steps stay unannotated");

    // stripStepOrigins removes the internal annotation for user-facing dumps.
    const stripped = stripStepOrigins(entry.data) as Record<string, unknown>;
    assert.ok(!JSON.stringify(stripped).includes('"$dir"'));
    const rawStep = composeStepOf(upSteps[0]!);
    assert.ok(rawStep, 'up step should be a compose step');
  } finally {
    await cleanup(repo);
    await cleanup(lib);
    await cleanup(cache);
  }
});

test('execution: compose and docker steps interpolate env and shell out to docker', async () => {
  const repo = await makeTempDir('qavor-ds-');
  const lib = await makeTempDir('qavor-dslib-');
  const cache = await makeTempDir('qavor-dsc-');
  try {
    // A fake `docker` that records its argv and always succeeds.
    const bin = path.join(repo, 'fakebin');
    const log = path.join(repo, 'docker.log');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, {
      mode: 0o755,
    });

    await writeTree(lib, {
      'pg/qavor.yaml': PROFILE_YAML,
      'pg/docker-compose.yaml': COMPOSE_YAML,
    });
    await writeTree(repo, {
      'svc/qavor.yaml': [
        'kind: service',
        'name: pg',
        `profiles: ["file://${path.join(lib, 'pg')}"]`,
        'env: { common: { PG_PROJECT: qavor-pg-alpha } }', // consumer override
        'runtime:',
        '  native:',
        '    stop_db:',
        '      operations:',
        '        - docker: { action: stop, name: "${PG_PROJECT}-db", timeout: 5 }',
        '',
      ].join('\n'),
    });
    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = reg.entries.find((e) => e.kind === 'service' && e.name === 'pg');
    assert.ok(entry);
    const docs = await loadManifestFile(entry.file);
    const serviceDoc = docs[entry.docIndex] as LoadedDocument;
    serviceDoc.data = entry.data; // execute the flattened definition, as the CLI does

    const run = (command: string) =>
      runServiceCommand({
        command,
        paths: { root: repo } as WorkspacePaths,
        projectDir: repo,
        serviceDoc,
        service: entry.data as unknown as ServiceManifest,
        logger: getLogger(),
        cliEnv: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      });

    await run('up');
    let lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
    const upLine = lines.find((l) => l.includes(' up '));
    assert.ok(upLine, `expected a compose up invocation, got: ${lines.join(' | ')}`);
    // Consumer env override interpolated into the project; file resolved to the
    // profile's own directory; wait flags mapped.
    assert.ok(upLine.includes('-p qavor-pg-alpha'), upLine);
    assert.ok(upLine.includes(`-f ${path.join(lib, 'pg/docker-compose.yaml')}`), upLine);
    assert.ok(upLine.includes('up -d --wait --wait-timeout 45'), upLine);

    await fs.rm(log, { force: true });
    await run('stop_db');
    lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
    assert.deepEqual(lines, ['stop -t 5 qavor-pg-alpha-db']);
  } finally {
    await cleanup(repo);
    await cleanup(lib);
    await cleanup(cache);
  }
});

test('cwd: a profile-contributed cmd step runs in the consuming service dir, not the profile dir', async () => {
  const repo = await makeTempDir('qavor-ds-');
  const lib = await makeTempDir('qavor-dslib-');
  const cache = await makeTempDir('qavor-dsc-');
  try {
    // A profile whose step records its own working directory and the value of
    // $QAVOR_MANIFEST_DIR. Both output files are written relative to cwd.
    await writeTree(lib, {
      'probe/qavor.yaml': [
        'kind: profile',
        'name: lib-probe',
        'mode: native',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    probe:',
        '      operations:',
        '        - cmd: pwd > cwd.txt && printf %s "$QAVOR_MANIFEST_DIR" > origin.txt',
        '',
      ].join('\n'),
    });
    await writeTree(repo, {
      'svc/qavor.yaml': [
        'kind: service',
        'name: svc',
        `profiles: ["file://${path.join(lib, 'probe')}"]`, // directory form
        '',
      ].join('\n'),
    });
    const reg = await buildRegistry(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = reg.entries.find((e) => e.kind === 'service' && e.name === 'svc');
    assert.ok(entry);
    const docs = await loadManifestFile(entry.file);
    const serviceDoc = docs[entry.docIndex] as LoadedDocument;
    serviceDoc.data = entry.data; // run the flattened definition, as the CLI does

    await runServiceCommand({
      command: 'probe',
      paths: { root: repo } as WorkspacePaths,
      projectDir: repo,
      serviceDoc,
      service: entry.data as unknown as ServiceManifest,
      logger: getLogger(),
    });

    const serviceDir = path.join(repo, 'svc');
    const originDir = path.join(lib, 'probe');
    // The step ran with cwd = the consuming service's dir (copy-inline semantics):
    // its relative output landed there, and `pwd` recorded that dir.
    const recordedCwd = (await fs.readFile(path.join(serviceDir, 'cwd.txt'), 'utf8')).trim();
    assert.equal(await fs.realpath(recordedCwd), await fs.realpath(serviceDir));
    // It did NOT run in the profile's own (origin) dir.
    await assert.rejects(fs.access(path.join(originDir, 'cwd.txt')));
    // But $QAVOR_MANIFEST_DIR still points at the defining profile's dir so a
    // profile can reach files it ships.
    const recordedOrigin = await fs.readFile(path.join(serviceDir, 'origin.txt'), 'utf8');
    assert.equal(await fs.realpath(recordedOrigin), await fs.realpath(originDir));
  } finally {
    await cleanup(repo);
    await cleanup(lib);
    await cleanup(cache);
  }
});
