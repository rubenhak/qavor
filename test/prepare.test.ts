import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

test('qavor prepare: runs prepare cmd; --force re-runs even on cache hit', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-prep-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['clone'], { cwd: ws });
    const first = await runCli(['prepare', '--json'], { cwd: ws });
    assert.equal(first.exitCode, 0, `prepare failed: ${first.stderr}`);
    const firstParsed = JSON.parse(first.stdout);
    const okCount = firstParsed.results.filter((r: { status: string }) => r.status === 'ok').length;
    assert.ok(okCount >= 1, 'expected at least one prepared service');

    const second = await runCli(['prepare', '--json'], { cwd: ws });
    const secondParsed = JSON.parse(second.stdout);
    assert.ok(
      secondParsed.results.some((r: { status: string }) => r.status === 'skipped'),
      'expected a cache-skip on second prepare run',
    );

    const third = await runCli(['prepare', '--json', '--force'], { cwd: ws });
    const thirdParsed = JSON.parse(third.stdout);
    assert.ok(
      thirdParsed.results.every(
        (r: { status: string }) => r.status === 'ok' || r.status === 'no-prepare-cmd',
      ),
      `--force should invalidate cache; got ${JSON.stringify(thirdParsed.results)}`,
    );

    const cacheFile = path.join(ws, '.qavor', 'cache', 'prepare', 'web.json');
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.ok(typeof cached.hash === 'string' && cached.hash.length === 64);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
