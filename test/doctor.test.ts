import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message?: string;
  hint?: string;
}

async function setWebManifest(repoDir: string, yaml: string): Promise<void> {
  await fs.writeFile(path.join(repoDir, 'qavor.yaml'), yaml);
  await execa('git', ['commit', '-aqm', 'update manifest'], { cwd: repoDir });
}

test('qavor doctor: check_installed/install written as { description, operations } are still read', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-doctor-');
  try {
    await setWebManifest(
      fixtures.serviceRepos.web!,
      [
        'kind: service',
        'name: web',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    check_installed:',
        '      description: "Check node is installed."',
        '      operations:',
        '        cmd: "node --version"',
        '    install:',
        '      description: "Install node."',
        '      operations:',
        '        cmd: "echo install node first"',
        'mode: native',
        '',
      ].join('\n'),
    );
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const res = await runCli(['doctor', '--json'], { cwd: ws });
    assert.equal(res.exitCode, 0, `doctor failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout) as { checks: Check[]; ok: boolean };
    const check = parsed.checks.find((c) => c.name === 'service web: check_installed');
    // Before the fix, the described-command object was misread as a bare step
    // (undefined `cmd`), so this either warned "no check_installed.cmd" or failed.
    assert.equal(check?.status, 'ok', JSON.stringify(check));
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
