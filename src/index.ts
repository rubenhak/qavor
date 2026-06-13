import process from 'node:process';
import { Command } from 'commander';
import { registerDiscover } from './cli/commands/discover.js';
import { registerDoctor } from './cli/commands/doctor.js';
import { registerEnv } from './cli/commands/env.js';
import { registerGitCommands } from './cli/commands/git.js';
import { registerInit } from './cli/commands/init.js';
import { registerPrepare } from './cli/commands/prepare.js';
import { registerRunCommands } from './cli/commands/run.js';
import { registerValidate } from './cli/commands/validate.js';
import { registerWorkspace } from './cli/commands/workspace.js';
import { ExitCode, QavorError } from './util/exit-codes.js';
import { configureLogger, getLogger } from './util/logger.js';

const PKG_VERSION = '0.1.0';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('qavor')
    .description(
      'A CLI for managing a constellation of related repositories as one cohesive developer workspace.',
    )
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
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      configureLogger({ json: Boolean(opts.json), verbose: Boolean(opts.verbose) });
    });
  registerInit(program);
  registerDiscover(program);
  registerWorkspace(program);
  registerValidate(program);
  registerGitCommands(program);
  registerPrepare(program);
  registerEnv(program);
  registerRunCommands(program);
  registerDoctor(program);
  return program;
}

async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
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
