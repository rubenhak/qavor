import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

/** Rewrite the `web` source repo's manifest and re-commit it. */
async function setWebManifest(repoDir: string, yaml: string): Promise<void> {
  await fs.writeFile(path.join(repoDir, 'qavor.yaml'), yaml);
  await execa('git', ['commit', '-aqm', 'update manifest'], { cwd: repoDir });
}

test('dynamic commands: an arbitrary manifest command is discovered and runnable', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-dyn-');
  try {
    // `lint` is not a built-in command — it exists only because the manifest
    // declares it under runtime.native.
    await setWebManifest(
      fixtures.serviceRepos.web!,
      [
        'kind: service',
        'name: web',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    lint:',
        '      operations:',
        '        - cmd: "echo linting > lint.marker"',
        'mode: native',
        '',
      ].join('\n'),
    );
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const res = await runCli(['lint', '--json'], { cwd: ws });
    assert.equal(res.exitCode, 0, `lint failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.command, 'lint');
    assert.equal(parsed.results[0].serviceName, 'web');
    assert.equal(parsed.results[0].status, 'ok');

    // The command actually ran in the service's directory.
    const found = await execa('find', [ws, '-name', 'lint.marker'], { reject: false });
    assert.notEqual(found.stdout.trim(), '', 'lint command should have run');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor commands: lists the dynamic commands declared in the workspace', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-cmds-');
  try {
    await setWebManifest(
      fixtures.serviceRepos.web!,
      [
        'kind: service',
        'name: web',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    run:',
        '      operations:',
        '        - cmd: "sleep 1"',
        '    prepare:',
        '      operations:',
        '        - cmd: "true"',
        '    migrate:',
        '      operations:',
        '        - cmd: "true"',
        'mode: native',
        '',
      ].join('\n'),
    );
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const res = await runCli(['commands', '--json'], { cwd: ws });
    assert.equal(res.exitCode, 0, `commands failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    const names = parsed.commands.map((c: { command: string }) => c.command).sort();
    // `run` is a reserved lifecycle key, never a dynamic command.
    assert.deepEqual(names, ['migrate', 'prepare']);
    const migrate = parsed.commands.find((c: { command: string }) => c.command === 'migrate');
    assert.deepEqual(migrate.services, ['web']);
    assert.equal(migrate.registered, true);
    // Neither command is written in the `{ description, operations }` form.
    assert.equal(migrate.description, null);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor commands: surfaces a described command and detects all-services commands', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-cmds-desc-');
  try {
    await setWebManifest(
      fixtures.serviceRepos.web!,
      [
        'kind: service',
        'name: web',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    build:',
        '      description: "Compile the web bundle."',
        '      operations:',
        '        cmd: "true"',
        '    prepare:',
        '      operations:',
        '        - cmd: "true"',
        'mode: native',
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(fixtures.serviceRepos.auth!, 'qavor.yaml'),
      [
        'kind: service',
        'name: auth',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    build:',
        '      operations:',
        '        - cmd: "true"',
        'mode: native',
        '',
      ].join('\n'),
    );
    await execa('git', ['commit', '-aqm', 'update manifest'], { cwd: fixtures.serviceRepos.auth! });
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const res = await runCli(['commands', '--json'], { cwd: ws });
    assert.equal(res.exitCode, 0, `commands failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);

    // `build` is declared by both services and only `web` sets a description;
    // it should still be picked up and reported as an all-services command.
    const build = parsed.commands.find((c: { command: string }) => c.command === 'build');
    assert.equal(build.description, 'Compile the web bundle.');
    assert.deepEqual(build.services.sort(), ['auth', 'web']);
    assert.equal(build.allServices, true);

    // `prepare` is declared only by `web`, so it is not an all-services command.
    const prepare = parsed.commands.find((c: { command: string }) => c.command === 'prepare');
    assert.equal(prepare.description, null);
    assert.deepEqual(prepare.services, ['web']);
    assert.equal(prepare.allServices, false);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor <command> --help: shows the manifest description and declaring services', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-cmds-help-');
  try {
    await setWebManifest(
      fixtures.serviceRepos.web!,
      [
        'kind: service',
        'name: web',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    build:',
        '      description: "Compile the web bundle."',
        '      operations:',
        '        cmd: "true"',
        'mode: native',
        '',
      ].join('\n'),
    );
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const res = await runCli(['build', '--help'], { cwd: ws });
    assert.equal(res.exitCode, 0, `--help failed: ${res.stderr}`);
    assert.match(res.stdout, /Compile the web bundle\./);
    assert.match(res.stdout, /Declared by: web/);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('dynamic commands: an unknown command is a user error', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-unknown-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const res = await runCli(['definitely-not-a-command'], { cwd: ws });
    assert.equal(res.exitCode, 1, `expected user error; got ${res.exitCode}: ${res.stderr}`);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
