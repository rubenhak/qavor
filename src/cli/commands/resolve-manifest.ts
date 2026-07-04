import type { Command } from 'commander';
import { stringify } from 'yaml';
import { buildWorkspaceRegistry, reportRegistryIssues } from '../../manifest/discovery.js';
import { findManifest } from '../../manifest/resolve.js';
import type { ManifestKind, ProjectManifest } from '../../manifest/types/index.js';
import { resolveJobs } from '../../util/concurrency.js';
import { UserError } from '../../util/exit-codes.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions } from '../options.js';

/** Sentinel repo key for the project repo when it is not listed in `repositories:`. */
const PROJECT_KEY = '__project__';

const KINDS: ManifestKind[] = ['workspaces', 'project', 'service', 'profile'];
type OutputFormat = 'yaml' | 'json';
const FORMATS: OutputFormat[] = ['yaml', 'json'];

export function registerResolveManifest(program: Command): void {
  program
    .command('resolve-manifest')
    .description(
      'Resolve a manifest by kind and name — flatten its profiles and print the effective definition.',
    )
    .requiredOption('--name <name>', 'Name of the manifest to resolve.')
    .option(`--kind <kind>`, `Disambiguate by kind: ${KINDS.join(' | ')}.`)
    .option('--format <format>', `Output format: ${FORMATS.join(' | ')} (default: yaml).`, 'yaml')
    .addHelpText(
      'after',
      [
        '',
        'Resolve a service with all referenced profiles merged in:',
        '  qavor resolve-manifest --kind service --name auth',
        '',
        'Inspect a profile chain as JSON:',
        '  qavor resolve-manifest --kind profile --name python_application --format json',
        '',
        'Manifest issues are reported on stderr; the resolved document is written to stdout.',
      ].join('\n'),
    )
    .action(async (opts: { name: string; kind?: string; format: string }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const logger = getLogger();

      let kind: ManifestKind | undefined;
      if (opts.kind !== undefined) {
        if (!KINDS.includes(opts.kind as ManifestKind)) {
          throw new UserError(`--kind must be one of: ${KINDS.join(', ')}.`);
        }
        kind = opts.kind as ManifestKind;
      }
      if (!FORMATS.includes(opts.format as OutputFormat)) {
        throw new UserError(`--format must be one of: ${FORMATS.join(', ')}.`);
      }
      // The global --json flag implies JSON output for machine consumers.
      const format: OutputFormat = root.json ? 'json' : (opts.format as OutputFormat);

      const ws = await resolveWorkspace();
      const projectDoc = await readProjectManifest(ws.projectManifestFile);
      const repos = resolveRepos({
        workspaceRoot: ws.paths.root,
        project: projectDoc.data as unknown as ProjectManifest,
        projectRepoPath: ws.projectRepoPath,
      });
      const repoMap = new Map(repos.map((r) => [r.name, r.dir]));
      if (!repos.some((r) => r.isProjectRepo)) repoMap.set(PROJECT_KEY, ws.projectRepoPath);

      const registry = await buildWorkspaceRegistry({
        workspaceRoot: ws.paths.root,
        repos: repoMap,
        concurrency: resolveJobs(root.jobs),
        offline: root.offline,
        refresh: root.refresh,
      });
      // Surface manifest issues on stderr but keep going — this command exists to
      // help debug those very issues, so it must not fail closed on them.
      reportRegistryIssues(registry.issues);

      // Profiles are flattened into the entry at registry-build time, so the
      // registry already holds the effective definition; this command merely
      // prints it.
      const target = findManifest(registry, opts.name, kind);
      logger.debug(
        { kind: target.kind, name: target.name, profiles: target.appliedProfiles ?? [] },
        'manifest resolved',
      );

      if (format === 'json') {
        emitJson(target.data);
        return;
      }
      // stringify always ends with a trailing newline; emit adds one of its own,
      // so trim to avoid a blank line.
      emit(stringify(target.data).replace(/\n$/, ''));
    });
}
