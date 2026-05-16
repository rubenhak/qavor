import { execa } from 'execa';
import type { HookCommands, Hooks } from '../manifest/types/index.js';
import { RuntimeFailure } from './exit-codes.js';
import type { Logger } from './logger.js';

const HOOK_EVENTS = [
  'pre_clone',
  'post_clone',
  'pre_prepare',
  'post_prepare',
  'pre_run',
  'post_run',
  'pre_stop',
  'post_stop',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface RunHooksOptions {
  hooks: Hooks | undefined;
  event: HookEvent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  logger: Logger;
}

function toList(cmds: HookCommands | undefined): string[] {
  if (!cmds) return [];
  return Array.isArray(cmds) ? [...cmds] : [cmds];
}

export async function runHooks(opts: RunHooksOptions): Promise<void> {
  const cmds = toList(opts.hooks?.[opts.event]);
  if (cmds.length === 0) return;
  for (const cmd of cmds) {
    opts.logger.info({ event: opts.event, cmd }, 'hook: running');
    try {
      await execa('/bin/sh', ['-c', cmd], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdout: 'inherit',
        stderr: 'inherit',
        ...(opts.signal ? { cancelSignal: opts.signal } : {}),
      });
    } catch (err) {
      throw new RuntimeFailure(
        `Hook ${opts.event} failed (${cmd}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
