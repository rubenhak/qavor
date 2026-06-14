#!/usr/bin/env tsx
/**
 * Generates TypeScript types from docs/schemas/*.json into
 * src/manifest/types/generated.ts via json-schema-to-typescript.
 *
 * Run via `pnpm gen:types`. CI runs `pnpm gen:types:check` to ensure the
 * checked-in file is in sync with the schemas.
 *
 * Approach: build a single wrapper schema that pulls every per-kind schema
 * into one tree, then compile once so shared $defs (envBlock, runtimeBlock,
 * hooks, requirement, …) are emitted exactly once.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type JSONSchema } from 'json-schema-to-typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const schemaDir = path.join(repoRoot, 'docs', 'schemas');
const outputPath = path.join(repoRoot, 'src', 'manifest', 'types', 'generated.ts');

const KINDS = [
  { id: 'Workspaces', file: 'qavor.workspaces.schema.json' },
  { id: 'Project', file: 'qavor.project.schema.json' },
  { id: 'Service', file: 'qavor.service.schema.json' },
  { id: 'Stateful', file: 'qavor.stateful.schema.json' },
  { id: 'Profile', file: 'qavor.profile.schema.json' },
] as const;

interface RawSchema {
  $id?: string;
  $defs?: Record<string, unknown>;
  [k: string]: unknown;
}

async function loadSchema(file: string): Promise<RawSchema> {
  const raw = await fs.readFile(path.join(schemaDir, file), 'utf8');
  return JSON.parse(raw) as RawSchema;
}

/**
 * Rewrite `https://qavor.dev/schemas/qavor.defs.schema.json#/$defs/<name>`
 * refs to `#/$defs/<name>`, and rewrite per-kind `$ref`s into local refs
 * after they've been inlined in the wrapper.
 */
function rewriteRefs(node: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, mapping));
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    // If a node has a $ref, drop sibling keywords. json-schema-to-typescript
    // creates duplicate types for ref-with-description-sibling otherwise.
    if (typeof obj.$ref === 'string') {
      const ref = obj.$ref;
      const remapped =
        mapping.get(ref) ??
        ref.replace(
          /^https:\/\/qavor\.dev\/schemas\/qavor\.defs\.schema\.json#\/\$defs\//,
          '#/$defs/',
        );
      return { $ref: remapped };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = rewriteRefs(v, mapping);
    }
    return out;
  }
  return node;
}

async function buildWrapper(): Promise<JSONSchema> {
  const defs = await loadSchema('qavor.defs.schema.json');
  const sharedDefs = (defs.$defs ?? {}) as Record<string, unknown>;

  const wrapperDefs: Record<string, unknown> = { ...sharedDefs };
  const refMap = new Map<string, string>();

  for (const kind of KINDS) {
    const schema = await loadSchema(kind.file);
    const typeName = `${kind.id}Manifest`;
    const cleaned: Record<string, unknown> = { ...schema };
    delete cleaned.$schema;
    delete cleaned.$id;
    if (typeof cleaned.title === 'string') {
      cleaned.title = typeName;
    } else {
      cleaned.title = typeName;
    }

    // Hoist a per-kind schema's local $defs into the wrapper's $defs,
    // namespaced to avoid collisions (e.g. project's RepoEntry).
    const localDefs = (cleaned.$defs ?? {}) as Record<string, unknown>;
    delete cleaned.$defs;
    for (const [name, defValue] of Object.entries(localDefs)) {
      const namespaced = `${kind.id}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      wrapperDefs[namespaced] = defValue;
      const oldRef = `#/$defs/${name}`;
      refMap.set(oldRef, `#/$defs/${namespaced}`);
    }

    wrapperDefs[typeName] = cleaned;
  }

  const wrapper: RawSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://qavor.dev/internal/wrapper.schema.json',
    title: 'QavorManifest',
    oneOf: KINDS.map((k) => ({ $ref: `#/$defs/${k.id}Manifest` })),
    $defs: wrapperDefs,
  };

  return rewriteRefs(wrapper, refMap) as JSONSchema;
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  const wrapper = await buildWrapper();

  const generated = await compile(wrapper, 'QavorManifest', {
    bannerComment: '',
    additionalProperties: false,
    strictIndexSignatures: true,
    declareExternallyReferenced: true,
    style: { singleQuote: true, semi: true, trailingComma: 'all', printWidth: 100 },
  });

  const header = [
    '/* eslint-disable */',
    '// AUTO-GENERATED — do not edit by hand.',
    '// Source: docs/schemas/*.json',
    '// Regenerate with `pnpm gen:types`.',
    '',
  ].join('\n');

  const out = `${header + generated.trimEnd()}\n`;

  if (checkMode) {
    let existing = '';
    try {
      existing = await fs.readFile(outputPath, 'utf8');
    } catch {
      // missing file means out-of-sync
    }
    const a = createHash('sha256').update(existing).digest('hex');
    const b = createHash('sha256').update(out).digest('hex');
    if (a !== b) {
      console.error('Types are out of sync with schemas. Run `pnpm gen:types`.');
      process.exit(1);
    }
    console.log('Types are in sync.');
    return;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, out, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
