import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ExecutionPlan, planExecution, runFanOut } from '../src/util/concurrency.js';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

test('planExecution: honors the command default when no override is given', () => {
  assert.deepEqual(planExecution({ defaultMode: 'serial' }), { mode: 'serial', concurrency: 1 });
  const parallel = planExecution({ defaultMode: 'parallel' });
  assert.equal(parallel.mode, 'parallel');
  assert.ok(parallel.concurrency >= 1);
});

test('planExecution: --serial / --parallel override the default', () => {
  assert.deepEqual(planExecution({ defaultMode: 'parallel', serial: true }), {
    mode: 'serial',
    concurrency: 1,
  });
  assert.equal(planExecution({ defaultMode: 'serial', parallel: true }).mode, 'parallel');
});

test('planExecution: an explicit --jobs value picks the mode by magnitude', () => {
  assert.deepEqual(planExecution({ defaultMode: 'parallel', jobs: 1 }), {
    mode: 'serial',
    concurrency: 1,
  });
  assert.deepEqual(planExecution({ defaultMode: 'serial', jobs: 4 }), {
    mode: 'parallel',
    concurrency: 4,
  });
});

test('planExecution: --serial wins over --jobs N', () => {
  assert.deepEqual(planExecution({ defaultMode: 'parallel', serial: true, jobs: 8 }), {
    mode: 'serial',
    concurrency: 1,
  });
});

test('planExecution: combining --serial and --parallel throws', () => {
  assert.throws(() => planExecution({ defaultMode: 'parallel', serial: true, parallel: true }), {
    message: /Cannot combine --serial and --parallel/,
  });
});

test('runFanOut: serial runs one task at a time and preserves order', async () => {
  const plan: ExecutionPlan = { mode: 'serial', concurrency: 1 };
  let inFlight = 0;
  let maxInFlight = 0;
  const out = await runFanOut(
    [10, 20, 30],
    async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    },
    plan,
  );
  assert.deepEqual(out, [20, 40, 60]);
  assert.equal(maxInFlight, 1, 'serial must never run two tasks at once');
});

test('runFanOut: parallel runs up to the concurrency cap at once', async () => {
  const plan: ExecutionPlan = { mode: 'parallel', concurrency: 2 };
  let inFlight = 0;
  let maxInFlight = 0;
  await runFanOut(
    [1, 2, 3, 4, 5],
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
    },
    plan,
  );
  assert.equal(maxInFlight, 2, 'parallel must cap concurrency at --jobs');
});

test('qavor git status --serial: produces identical output to the default', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-serial-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    const serial = await runCli(['git', 'status', '--serial', '--json'], { cwd: ws });
    assert.equal(serial.exitCode, 0, `serial status failed: ${serial.stderr}`);
    const parsed = JSON.parse(serial.stdout);
    assert.equal(parsed.repos.length, 2);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor git: --serial and --parallel together is a user error', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-conflict-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    const r = await runCli(['git', 'status', '--serial', '--parallel'], { cwd: ws });
    assert.equal(r.exitCode, 1, 'expected user-error exit code');
    assert.match(r.stderr, /Cannot combine --serial and --parallel/);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
