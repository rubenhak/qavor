import type { Command } from 'commander';
import { runServiceCommand } from '../../command/command.js';
import { parseCliEnv } from '../../env/composer.js';
import { type RegistryEntry, reportRegistryIssues } from '../../manifest/discovery.js';
import { type LoadedDocument, loadManifestFile } from '../../manifest/loader.js';
import { serviceCommandDescription, serviceCommandNames } from '../../manifest/runtime.js';
import type { ServiceManifest } from '../../manifest/types/index.js';
import { runFanOut } from '../../util/concurrency.js';
import { RuntimeFailure, UserError } from '../../util/exit-codes.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { colorEnabled, palette } from '../../util/style.js';
import { fit, truncate } from '../live-view.js';
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

/** Everything `qavor commands` (and dynamic-command `--help`) needs about one command. */
export interface DynamicCommandInfo {
  /**
   * The manifest-declared description, taken from the first service (in name
   * order) that writes this command as `{ description, operations }`.
   * `undefined` when no declaring service sets one.
   */
  description?: string;
  /** Names of every service that declares this command, sorted. */
  services: string[];
}

/**
 * Gather every dynamic command declared across the given services: which
 * services declare each, and its description (if any service sets one).
 * Services are visited in name order so the chosen description and the
 * `services` list are both deterministic regardless of registry scan order.
 */
export function collectDynamicCommands(
  services: readonly RegistryEntry[],
): Map<string, DynamicCommandInfo> {
  const byCommand = new Map<string, DynamicCommandInfo>();
  for (const entry of [...services].sort((a, b) => a.name.localeCompare(b.name))) {
    const service = entry.data as unknown as ServiceManifest;
    for (const name of serviceCommandNames(service)) {
      const info = byCommand.get(name);
      if (info) {
        info.services.push(entry.name);
        info.description ??= serviceCommandDescription(service, name);
      } else {
        const description = serviceCommandDescription(service, name);
        byCommand.set(name, { services: [entry.name], ...(description ? { description } : {}) });
      }
    }
  }
  return byCommand;
}

/**
 * Register one `qavor <command>` subcommand per discovered manifest command.
 * Every command shares the same fan-out, env composition, and live-view
 * machinery — only the command name differs. `totalServices` is the size of
 * the whole workspace, used to render a compact "declared by all services"
 * hint in `--help` instead of spelling out every name.
 */
export function registerDynamicCommands(
  program: Command,
  commands: ReadonlyMap<string, DynamicCommandInfo>,
  totalServices: number,
): void {
  for (const name of [...commands.keys()].sort()) {
    if (!isRegistrableCommand(name)) continue;
    const info = commands.get(name);
    const description = info?.description ?? `Run \`runtime.native.${name}\` across services.`;
    program
      .command(name)
      .description(description)
      .option('--only <name...>', 'Limit to specific service names.')
      .option('--env <kv...>', 'Override env values, KEY=VAL.')
      .addHelpText('after', info ? `\n${declaredByLine(info, totalServices)}\n` : '')
      .action((opts: { only?: string[]; env?: string[] }, cmd: Command) =>
        runDynamicCommand(name, opts, cmd),
      );
  }
}

/** "Declared by …" help-text line: the full service list, or a compact "all N services". */
function declaredByLine(info: DynamicCommandInfo, totalServices: number): string {
  const declaredBy =
    totalServices > 1 && info.services.length === totalServices
      ? `all ${totalServices} services`
      : info.services.join(', ');
  return `Declared by: ${declaredBy}`;
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

/** Cap on the pretty-printed DESCRIPTION column; `--json` always carries the full text. */
const MAX_DESCRIPTION_WIDTH = 60;

/**
 * `qavor commands` — list the dynamic commands declared across the workspace,
 * their manifest-declared description (if any), and which services declare
 * each. A command that collides with a built-in (or is an unsafe token) is
 * flagged as shadowed: it is reachable only by editing the manifest to rename
 * it. Also the primary way for a skill to discover, at a glance, what a
 * workspace can run and what each command is for — hence `--json`.
 */
export function registerCommandsList(program: Command): void {
  program
    .command('commands')
    .description('List dynamic commands declared across the workspace, with descriptions.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const ctx = await loadServicesContext();
      reportRegistryIssues(ctx.registry.issues);

      const byCommand = collectDynamicCommands(ctx.services);
      const totalServices = ctx.services.length;

      const commands = [...byCommand.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, info]) => ({
          command: name,
          description: info.description ?? null,
          services: info.services,
          allServices: totalServices > 1 && info.services.length === totalServices,
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

      const c = palette(colorEnabled());
      const HEADER_COMMAND = 'COMMAND';
      const HEADER_DESCRIPTION = 'DESCRIPTION';
      const HEADER_SERVICES = 'SERVICES';

      const nameCells = commands.map((cmd) =>
        cmd.registered ? cmd.command : `${cmd.command} (shadowed)`,
      );
      const descCells = commands.map((cmd) =>
        truncate(cmd.description ?? '(no description)', MAX_DESCRIPTION_WIDTH),
      );
      const commandW = Math.max(HEADER_COMMAND.length, ...nameCells.map((s) => s.length));
      const descW = Math.max(HEADER_DESCRIPTION.length, ...descCells.map((s) => s.length));

      emit(
        c.bold(
          `${fit(HEADER_COMMAND, commandW)}  ${fit(HEADER_DESCRIPTION, descW)}  ${HEADER_SERVICES}`,
        ),
      );
      commands.forEach((cmd, i) => {
        const name = fit(nameCells[i] ?? '', commandW);
        const desc = fit(descCells[i] ?? '', descW);
        const descCell = cmd.description ? desc : c.dim(desc);
        const servicesText = cmd.allServices
          ? `all services (${cmd.services.length})`
          : cmd.services.join(', ');
        const servicesCell = cmd.allServices ? c.dim(servicesText) : servicesText;
        emit(`${name}  ${descCell}  ${servicesCell}`);
      });

      if (commands.some((cmd) => !cmd.registered)) {
        emit('');
        emit(
          c.dim(
            '(shadowed): the name collides with a built-in command; rename it in the manifest to run it as `qavor <name>`.',
          ),
        );
      }
    });
}
