import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSteps } from '../src/manifest/steps.js';
import type { RuntimeStep } from '../src/manifest/types/index.js';

test('normalizeSteps: undefined yields an empty list', () => {
  assert.deepEqual(normalizeSteps(undefined), []);
});

test('normalizeSteps: a single step object yields a one-element list', () => {
  const step: RuntimeStep = { cmd: 'echo a' };
  assert.deepEqual(normalizeSteps(step), [step]);
});

test('normalizeSteps: a list of steps is returned in order as a fresh array', () => {
  const steps: [RuntimeStep, RuntimeStep] = [{ cmd: 'echo a' }, { cmd: 'echo b', cwd: 'sub' }];
  const out = normalizeSteps(steps);
  assert.deepEqual(out, steps);
  assert.notEqual(out, steps, 'should be a copy, not the same reference');
});
