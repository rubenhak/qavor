import type { Command } from 'commander';
import { composeUnitEnv, parseCliEnv, type ResolvedEnv } from '../../env/composer.js';
import {
  buildWorkspaceRegistry,
  type RegistryEntry,
  reportRegistryIssues,
} from '../../manifest/discovery.js';
import type { ProjectManifest } from '../../manifest/types/index.js';
import { resolveJobs } from '../../util/concurrency.js';
import { ManifestError, UserError } from '../../util/exit-codes.js';
import { emit, emitJson } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions } from '../options.js';

type OutputFormat = 'pretty' | 'export' | 'dotenv';
const FORMATS: OutputFormat[] = ['pretty', 'export', 'dotenv'];

export function registerResolveEnv(program: Command): void {
  program
    .command('resolve-env')
    .description(
      'Resolve the full environment for a service (including require: deps), ready to print or source.',
    )
    .option('--only <name>', 'Name of the service whose env to resolve.')
    .option('--mode <mode>', 'native | docker (default: native).', 'native')
    .option(
      '--format <format>',
      `Output format: ${FORMATS.join(' | ')} (default: pretty). Use 'export' to source into a shell.`,
      'pretty',
    )
    .option('--env <kv...>', 'Layer KEY=VAL on top of the composed env.')
    .addHelpText(
      'after',
      [
        '',
        'Source the resolved env into the current shell:',
        '  eval "$(qavor resolve-env --only auth --format export)"',
        '  # or, with process substitution:',
        '  source <(qavor resolve-env --only auth --format export)',
        '',
        "Note: 'export' and 'dotenv' formats emit real secret values so the shell can",
        "use them; 'pretty' and --json redact secrets.",
      ].join('\n'),
    )
    .action(
      async (
        opts: { only?: string; mode: string; format: string; env?: string[] },
        cmd: Command,
      ) => {
        const root = inheritRootOptions(cmd);
        if (!opts.only) throw new UserError('resolve-env requires --only <service-name>.');
        if (opts.mode !== 'native' && opts.mode !== 'docker') {
          throw new UserError(`--mode must be 'native' or 'docker'.`);
        }
        const mode = opts.mode;
        if (!FORMATS.includes(opts.format as OutputFormat)) {
          throw new UserError(`--format must be one of: ${FORMATS.join(', ')}.`);
        }
        const format = opts.format as OutputFormat;

        const ws = await resolveWorkspace();
        const projectDoc = await readProjectManifest(ws.projectManifestFile);
        const repos = resolveRepos({
          workspaceRoot: ws.paths.root,
          project: projectDoc.data as unknown as ProjectManifest,
          projectRepoPath: ws.projectRepoPath,
        });
        const repoMap = new Map(repos.map((r) => [r.name, r.dir]));
        repoMap.set('__project__', ws.projectRepoPath);
        const registry = await buildWorkspaceRegistry({
          workspaceRoot: ws.paths.root,
          repos: repoMap,
          concurrency: resolveJobs(root.jobs),
          offline: root.offline,
          refresh: root.refresh,
        });
        if (reportRegistryIssues(registry.issues)) {
          throw new ManifestError(
            `Workspace has ${registry.issues.length} manifest issue(s); fix them before resolving env.`,
          );
        }

        const target: RegistryEntry | undefined = registry.byName.get(opts.only);
        if (!target) {
          throw new UserError(`'${opts.only}' was not found in the workspace.`);
        }
        if (target.kind !== 'service') {
          throw new UserError(
            `'${opts.only}' is a ${target.kind} manifest, which has no resolvable environment. Use a service name.`,
          );
        }

        const cliEnv = opts.env ? parseCliEnv(opts.env) : undefined;
        const composeArgs: Parameters<typeof composeUnitEnv>[0] = {
          mode,
          target,
          registry,
          workspaceRoot: ws.paths.root,
        };
        if (cliEnv) composeArgs.cliEnv = cliEnv;
        const resolved = await composeUnitEnv(composeArgs);

        if (root.json) {
          emitJsonOutput(opts.only, mode, resolved);
          return;
        }
        if (format === 'export' || format === 'dotenv') {
          emitSourceable(resolved, format);
          return;
        }
        emitPretty(opts.only, mode, resolved);
      },
    );
}

function emitJsonOutput(name: string, mode: string, resolved: ResolvedEnv): void {
  emitJson({
    name,
    mode,
    issues: resolved.issues,
    env: [...resolved.values].map(([key, v]) => ({
      key,
      value: v.secret ? '<redacted>' : v.value,
      secret: v.secret,
      required: v.required,
      provenance: v.provenance.map((p) => ({
        file: p.file,
        line: p.line,
        layer: p.layer,
        raw: v.secret ? '<redacted>' : p.raw,
      })),
    })),
  });
}

function emitPretty(name: string, mode: string, resolved: ResolvedEnv): void {
  if (resolved.issues.length > 0) {
    emit('Issues:');
    for (const i of resolved.issues) emit(`  ${i.file}:${i.line}: ${i.message}`);
    emit('');
  }
  emit(`Resolved environment for ${name} (mode=${mode}):`);
  for (const [k, v] of resolved.values) {
    const printed = v.secret ? '<redacted>' : v.value;
    emit(`  ${k} = ${printed}`);
    for (const p of v.provenance) {
      const rawPrinted = v.secret ? '<redacted>' : p.raw;
      emit(`    via ${p.layer} (${p.file}:${p.line}) = ${rawPrinted}`);
    }
  }
}

/**
 * Emit a shell-sourceable representation. Fails closed (ManifestError) when the
 * env has unresolved issues so a broken env is never sourced. Secret values are
 * emitted in the clear — that is the whole point of sourcing.
 */
function emitSourceable(resolved: ResolvedEnv, format: OutputFormat): void {
  if (resolved.issues.length > 0) {
    const lines = resolved.issues.map((i) => `${i.file}:${i.line}: ${i.message}`);
    throw new ManifestError(
      `Refusing to emit a sourceable env with unresolved issues:\n  ${lines.join('\n  ')}`,
    );
  }
  for (const [key, v] of resolved.values) {
    if (format === 'export') {
      emit(`export ${key}=${shellQuote(v.value)}`);
    } else {
      emit(`${key}=${shellQuote(v.value)}`);
    }
  }
}

/** Single-quote a value for safe POSIX shell sourcing. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
