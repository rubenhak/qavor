import type { Command } from 'commander';

/**
 * Shared shape of root-level CLI options resolved at every command.
 */
export interface RootOptions {
  json: boolean;
  verbose: boolean;
  jobs: number | undefined;
  /** Path override for the workspace pointer file. */
  config: string | undefined;
}

export function rootOptions(cmd: Command): RootOptions {
  const opts = cmd.opts();
  return {
    json: Boolean(opts.json),
    verbose: Boolean(opts.verbose),
    jobs: typeof opts.jobs === 'string' ? Number.parseInt(opts.jobs, 10) : undefined,
    config: typeof opts.config === 'string' ? opts.config : undefined,
  };
}

/**
 * Walk up to root program to extract effective root options. Subcommands
 * receive their own options object via commander; we ascend to the program
 * to pick up `--json`, `--verbose`, `--jobs`.
 */
export function inheritRootOptions(cmd: Command): RootOptions {
  let current: Command | null = cmd;
  while (current?.parent) current = current.parent;
  if (!current) return { json: false, verbose: false, jobs: undefined, config: undefined };
  return rootOptions(current);
}
