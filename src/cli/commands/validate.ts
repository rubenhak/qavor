import type { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import pMap from 'p-map';
import { isDirectory, isFile } from '../../util/fs.js';
import { loadManifestFile } from '../../manifest/loader.js';
import { validateDocument, formatIssue, type ValidationIssue } from '../../manifest/validator.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { inheritRootOptions } from '../options.js';
import { ManifestError, UserError } from '../../util/exit-codes.js';
import { resolveJobs } from '../../util/concurrency.js';

export function registerValidate(program: Command): void {
  program
    .command('validate')
    .description('Validate one or more qavor manifest files. Targets a file or a directory.')
    .argument('<path>', 'Path to a qavor.yaml file, a directory containing one, or a directory of multiple manifests.')
    .action(async (target: string, _opts: unknown, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const logger = getLogger();
      const abs = path.resolve(target);
      const files: string[] = [];
      if (await isFile(abs)) {
        files.push(abs);
      } else if (await isDirectory(abs)) {
        const direct = path.join(abs, 'qavor.yaml');
        if (await isFile(direct)) files.push(direct);
        // Also scan one level deep into qavor/ if present.
        try {
          const entries = await fs.readdir(abs, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) {
              const child = path.join(abs, e.name, 'qavor.yaml');
              if (await isFile(child)) files.push(child);
            }
            if (e.isFile() && e.name === 'qavor.yaml') {
              // already added if direct
            }
          }
        } catch {
          /* ignore */
        }
      } else {
        throw new UserError(`Path not found: ${abs}`);
      }
      if (files.length === 0) throw new UserError(`No qavor.yaml files found under ${abs}.`);

      const jobs = resolveJobs(root.jobs);
      const issues: ValidationIssue[] = [];
      await pMap(
        files,
        async (file) => {
          try {
            const docs = await loadManifestFile(file);
            for (const d of docs) {
              const r = validateDocument(d);
              if (!r.ok) issues.push(...r.issues);
            }
          } catch (err) {
            issues.push({
              file,
              line: 1,
              column: 1,
              kind: 'unknown',
              path: '',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        { concurrency: jobs },
      );

      if (root.json) {
        emitJson({ ok: issues.length === 0, files: files.length, issues });
      } else {
        if (issues.length === 0) {
          emit(`OK — ${files.length} file(s) validated.`);
        } else {
          emit(`FAILED — ${issues.length} issue(s) across ${files.length} file(s):`);
          for (const i of issues) emit(`  ${formatIssue(i)}`);
        }
      }
      if (issues.length > 0) {
        logger.debug({ count: issues.length }, 'validation failed');
        throw new ManifestError(`Validation failed with ${issues.length} issue(s).`);
      }
    });
}
