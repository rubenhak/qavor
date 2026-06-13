import type { Command } from 'commander';
import { type ExecutionMode, type ExecutionPlan, planExecution } from '../util/concurrency.js';
import { UserError } from '../util/exit-codes.js';

/**
 * Shared shape of root-level CLI options resolved at every command.
 */
export interface RootOptions {
  json: boolean;
  verbose: boolean;
  jobs: number | undefined;
  /** `--serial`: force fan-out commands to run one task at a time. */
  serial: boolean;
  /** `--parallel`: force fan-out commands to run with bounded concurrency. */
  parallel: boolean;
  /** Path override for the workspace pointer file. */
  config: string | undefined;
}

export function rootOptions(cmd: Command): RootOptions {
  const opts = cmd.opts();
  return {
    json: Boolean(opts.json),
    verbose: Boolean(opts.verbose),
    jobs: typeof opts.jobs === 'string' ? Number.parseInt(opts.jobs, 10) : undefined,
    serial: Boolean(opts.serial),
    parallel: Boolean(opts.parallel),
    config: typeof opts.config === 'string' ? opts.config : undefined,
  };
}

/**
 * Walk up to root program to extract effective root options. Subcommands
 * receive their own options object via commander; we ascend to the program
 * to pick up `--json`, `--verbose`, `--jobs`, `--serial`, `--parallel`.
 */
export function inheritRootOptions(cmd: Command): RootOptions {
  let current: Command | null = cmd;
  while (current?.parent) current = current.parent;
  if (!current)
    return {
      json: false,
      verbose: false,
      jobs: undefined,
      serial: false,
      parallel: false,
      config: undefined,
    };
  return rootOptions(current);
}

/**
 * Resolve how a fan-out command should run, combining its own default mode
 * with the user's `--serial` / `--parallel` / `--jobs` overrides. Conflicting
 * overrides surface as a {@link UserError}.
 */
export function resolveExecutionPlan(root: RootOptions, defaultMode: ExecutionMode): ExecutionPlan {
  try {
    return planExecution({
      defaultMode,
      serial: root.serial,
      parallel: root.parallel,
      jobs: root.jobs,
    });
  } catch (err) {
    throw new UserError(err instanceof Error ? err.message : String(err));
  }
}
