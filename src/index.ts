import process from 'node:process';
import { Command } from 'commander';
import { version as PKG_VERSION } from '../package.json';
import { registerDiscover } from './cli/commands/discover.js';
import { registerDoctor } from './cli/commands/doctor.js';
import { registerCommandsList, registerDynamicCommands } from './cli/commands/dynamic.js';
import { registerEnv } from './cli/commands/env.js';
import { registerGitCommands } from './cli/commands/git.js';
import { registerInit } from './cli/commands/init.js';
import { registerManifests } from './cli/commands/manifests.js';
import { registerResolveEnv } from './cli/commands/resolve-env.js';
import { registerResolveManifest } from './cli/commands/resolve-manifest.js';
import { registerRunCommands } from './cli/commands/run.js';
import { registerValidate } from './cli/commands/validate.js';
import { registerWorkspace } from './cli/commands/workspace.js';
import { loadServicesContext } from './cli/services-context.js';
import { STATIC_COMMAND_NAMES } from './cli/static-commands.js';
import { serviceCommandNames } from './manifest/runtime.js';
import type { ServiceManifest } from './manifest/types/index.js';
import { ExitCode, QavorError } from './util/exit-codes.js';
import { configureLogger, getLogger } from './util/logger.js';

function buildProgram(dynamicCommands: readonly string[]): Command {
  const program = new Command();
  program
    .name('qavor')
    .description(
      'A CLI for managing a constellation of related repositories as one cohesive developer workspace.',
    )
    // Surface root-level flags (--json, --jobs, --serial, --parallel, …) in
    // every subcommand's --help under a "Global Options" section. Inherited.
    .configureHelp({ showGlobalOptions: true })
    .version(PKG_VERSION, '-V, --version')
    .option('--json', 'Emit machine-readable JSON output. One object per line on stdout.')
    .option('-v, --verbose', 'Enable debug-level logging on stderr.')
    .option('-c, --config <path>', 'Override the path to the workspace pointer file.')
    .option('-j, --jobs <n>', 'Maximum concurrency for fan-out operations.', (raw) => {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--jobs must be a positive integer (got '${raw}').`);
      }
      return raw;
    })
    .option('--serial', 'Run fan-out operations one repo/service at a time.')
    .option('--parallel', 'Run fan-out operations with bounded concurrency (see --jobs).')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      configureLogger({ json: Boolean(opts.json), verbose: Boolean(opts.verbose) });
    });
  registerInit(program);
  registerDiscover(program);
  registerWorkspace(program);
  registerManifests(program);
  registerValidate(program);
  registerGitCommands(program);
  registerEnv(program);
  registerResolveEnv(program);
  registerResolveManifest(program);
  registerRunCommands(program);
  registerDoctor(program);
  registerCommandsList(program);
  // Manifest-defined commands (prepare, update_libraries, lint, …) are discovered
  // at startup and registered last so a built-in always wins a name collision.
  registerDynamicCommands(program, dynamicCommands);
  return program;
}

const VALUE_FLAGS = new Set(['-c', '--config', '-j', '--jobs']);

/** The first non-flag token in argv, i.e. the intended subcommand. */
function firstSubcommand(argv: string[]): string | undefined {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

/**
 * Discover the dynamic command names declared in the current workspace so they
 * can be registered as `qavor <command>` subcommands. Skipped (returns `[]`)
 * when the invoked subcommand is plainly a built-in, so the common path pays no
 * registry-build cost. Any failure (no workspace, unreadable manifests) falls
 * back to the static surface; the command's own action reports real errors.
 */
async function discoverCommandNames(argv: string[]): Promise<string[]> {
  const sub = firstSubcommand(argv);
  if (sub !== undefined && sub !== 'help' && STATIC_COMMAND_NAMES.has(sub)) return [];
  try {
    const ctx = await loadServicesContext();
    const names = new Set<string>();
    for (const entry of ctx.services) {
      for (const name of serviceCommandNames(entry.data as unknown as ServiceManifest)) {
        names.add(name);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

async function main(argv: string[]): Promise<number> {
  const dynamicCommands = await discoverCommandNames(argv);
  const program = buildProgram(dynamicCommands);
  try {
    await program.parseAsync(argv, { from: 'node' });
    return ExitCode.Ok;
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown): number {
  // commander surfaces help/version exits via thrown CommanderError; respect them.
  const e = err as { code?: string; exitCode?: number; message?: string };
  if (e && (e.code === 'commander.helpDisplayed' || e.code === 'commander.help'))
    return ExitCode.Ok;
  if (e && e.code === 'commander.version') return ExitCode.Ok;
  if (e && typeof e.code === 'string' && e.code.startsWith('commander.')) {
    process.stderr.write(`${e.message ?? 'command error'}\n`);
    return ExitCode.UserError;
  }
  if (err instanceof QavorError) {
    process.stderr.write(`${err.message}\n`);
    return err.exitCode;
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Fall back to the logger so JSON mode produces structured output.
  try {
    const logger = getLogger();
    logger.error({ err: message }, 'unhandled error');
  } catch {
    process.stderr.write(`${message}\n`);
  }
  return ExitCode.RuntimeError;
}

const code = await main(process.argv);
process.exit(code);
