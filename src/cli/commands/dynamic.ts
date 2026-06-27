import type { Command } from 'commander';
import { runServiceCommand } from '../../command/command.js';
import { parseCliEnv } from '../../env/composer.js';
import { reportRegistryIssues } from '../../manifest/discovery.js';
import { type LoadedDocument, loadManifestFile } from '../../manifest/loader.js';
import { serviceCommandNames } from '../../manifest/runtime.js';
import type { ServiceManifest } from '../../manifest/types/index.js';
import { runFanOut } from '../../util/concurrency.js';
import { RuntimeFailure, UserError } from '../../util/exit-codes.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { inheritRootOptions, resolveExecutionPlan } from '../options.js';
import { loadServicesContext } from '../services-context.js';
import { STATIC_COMMAND_NAMES } from '../static-commands.js';
import { type CommandRow, createCommandView } from './command-view.js';

/** Commander-safe command token: avoids whitespace/odd chars in command names. */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Whether a discovered command name can be exposed as its own `qavor <name>`
 * subcommand: it must be a safe token and must not shadow a built-in command.
 */
export function isRegistrableCommand(name: string): boolean {
  return SAFE_NAME.test(name) && !STATIC_COMMAND_NAMES.has(name);
}

/**
 * Register one `qavor <command>` subcommand per discovered manifest command.
 * Every command shares the same fan-out, env composition, and live-view
 * machinery — only the command name differs.
 */
export function registerDynamicCommands(program: Command, commandNames: readonly string[]): void {
  for (const name of [...new Set(commandNames)].sort()) {
    if (!isRegistrableCommand(name)) continue;
    program
      .command(name)
      .description(`Run \`runtime.native.${name}\` across services that declare it.`)
      .option('--only <name...>', 'Limit to specific service names.')
      .option('--env <kv...>', 'Override env values, KEY=VAL.')
      .action((opts: { only?: string[]; env?: string[] }, cmd: Command) =>
        runDynamicCommand(name, opts, cmd),
      );
  }
}

async function runDynamicCommand(
  command: string,
  opts: { only?: string[]; env?: string[] },
  cmd: Command,
): Promise<void> {
  const root = inheritRootOptions(cmd);
  const plan = resolveExecutionPlan(root, 'parallel');
  const logger = getLogger();
  const ctx = await loadServicesContext({ concurrency: plan.concurrency });
  reportRegistryIssues(ctx.registry.issues);

  let services = ctx.services;
  if (opts.only && opts.only.length > 0) {
    const set = new Set(opts.only);
    services = services.filter((s) => set.has(s.name));
    const missing = [...set].filter((n) => !services.some((s) => s.name === n));
    if (missing.length > 0) {
      throw new UserError(`Unknown service(s): ${missing.join(', ')}`);
    }
  }

  const cliEnv = opts.env ? parseCliEnv(opts.env) : undefined;

  // Live table on stdout: one row per service, each pending with a spinner until
  // its command resolves. Auto-disabled for --json, non-TTY, and --verbose (where
  // the command's raw output shares the terminal); those fall back to a single
  // static render in `finish`.
  const view = createCommandView(
    command,
    services.map((s) => s.name),
    { enabled: !root.json && !root.verbose },
  );

  const rows = await runFanOut(
    services,
    async (entry, index): Promise<CommandRow> => {
      const docs = await loadManifestFile(entry.file);
      const serviceDoc = docs[entry.docIndex] as LoadedDocument;
      const service = entry.data as unknown as ServiceManifest;
      const runOpts: Parameters<typeof runServiceCommand>[0] = {
        command,
        paths: ctx.ws.paths,
        serviceDoc,
        service,
        logger,
        verbose: root.verbose,
        serial: plan.mode === 'serial',
      };
      if (cliEnv) runOpts.cliEnv = cliEnv;
      let row: CommandRow;
      try {
        const res = await runServiceCommand(runOpts);
        row =
          res.status === 'ok'
            ? { service: res.serviceName, outcome: 'ran', status: 'ok' }
            : {
                service: res.serviceName,
                outcome: 'skip',
                status: 'skipped',
                detail: `no ${command} command`,
              };
      } catch (err) {
        row = {
          service: entry.name,
          outcome: 'fail',
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      view.resolve(index, row);
      return row;
    },
    plan,
  );

  if (root.json) {
    emitJson({
      command,
      results: rows.map((r) => ({
        serviceName: r.service,
        status: r.outcome === 'ran' ? 'ok' : r.outcome === 'skip' ? 'skipped' : 'failed',
        ...(r.outcome === 'fail' && r.detail ? { error: r.detail } : {}),
      })),
    });
  } else {
    view.finish();
  }

  if (rows.some((r) => r.outcome === 'fail')) {
    throw new RuntimeFailure(`Some services failed to run '${command}'.`);
  }
}

/**
 * `qavor commands` — list the dynamic commands declared across the workspace and
 * which services declare each. A command that collides with a built-in (or is an
 * unsafe token) is flagged as shadowed: it is reachable only by editing the
 * manifest to rename it.
 */
export function registerCommandsList(program: Command): void {
  program
    .command('commands')
    .description('List dynamic commands declared across the workspace.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const ctx = await loadServicesContext();
      reportRegistryIssues(ctx.registry.issues);

      const byCommand = new Map<string, string[]>();
      for (const entry of ctx.services) {
        const service = entry.data as unknown as ServiceManifest;
        for (const name of serviceCommandNames(service)) {
          const list = byCommand.get(name) ?? [];
          list.push(entry.name);
          byCommand.set(name, list);
        }
      }

      const commands = [...byCommand.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, services]) => ({
          command: name,
          services: [...services].sort(),
          registered: isRegistrableCommand(name),
        }));

      if (root.json) {
        emitJson({ commands });
        return;
      }
      if (commands.length === 0) {
        emit('(no commands declared in any service manifest)');
        return;
      }
      const headers = ['COMMAND', 'SERVICES'];
      const data = commands.map((c) => [
        c.registered ? c.command : `${c.command} (shadowed)`,
        c.services.join(', '),
      ]);
      const widths = headers.map((h, i) =>
        Math.max(h.length, ...data.map((row) => (row[i] ?? '').length)),
      );
      const fmt = (row: string[]): string =>
        row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
      emit(fmt(headers));
      for (const row of data) emit(fmt(row));
    });
}
