import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

test('qavor prepare: runs prepare cmd unconditionally every run', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-prep-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    const first = await runCli(['prepare', '--json'], { cwd: ws });
    assert.equal(first.exitCode, 0, `prepare failed: ${first.stderr}`);
    const firstParsed = JSON.parse(first.stdout);
    const okCount = firstParsed.results.filter((r: { status: string }) => r.status === 'ok').length;
    assert.ok(okCount >= 1, 'expected at least one prepared service');

    // No caching: a second run re-runs prepare and produces the same statuses,
    // never a "skipped" result.
    const second = await runCli(['prepare', '--json'], { cwd: ws });
    assert.equal(second.exitCode, 0, `prepare failed: ${second.stderr}`);
    const secondParsed = JSON.parse(second.stdout);
    assert.ok(
      secondParsed.results.every(
        (r: { status: string }) => r.status === 'ok' || r.status === 'no-prepare-cmd',
      ),
      `expected no skip on second run; got ${JSON.stringify(secondParsed.results)}`,
    );
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
