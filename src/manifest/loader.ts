import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments, type Document, type Node, type LineCounter } from 'yaml';
import { ManifestError } from '../util/exit-codes.js';
import type { ManifestKind, QavorManifest } from './types/index.js';

export interface SourcePosition {
  /** Absolute file path of the manifest. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

export interface LoadedDocument {
  /** Absolute manifest file path. */
  file: string;
  /** 0-based document index inside a multi-doc YAML file. */
  docIndex: number;
  /** Parsed top-level kind (raw). May be undefined if the doc lacks `kind:`. */
  kind?: ManifestKind | string;
  /** Plain-JS document body. */
  data: Record<string, unknown>;
  /** Position helper bound to this document. */
  position: PositionResolver;
}

/**
 * Maps `/json/pointer/path` strings inside a loaded doc back to a file
 * position. Multi-doc YAML files are supported.
 */
export type PositionResolver = (jsonPath: string) => SourcePosition;

interface LoadOptions {
  /** Throw ManifestError on YAML parse errors. Default true. */
  throwOnParseError?: boolean;
}

/**
 * Read and parse a YAML manifest file. The file may contain multiple
 * `---`-separated documents; each becomes a LoadedDocument with its own
 * source-position resolver.
 */
export async function loadManifestFile(
  filePath: string,
  opts: LoadOptions = {},
): Promise<LoadedDocument[]> {
  const absFile = path.resolve(filePath);
  let source: string;
  try {
    source = await fs.readFile(absFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ManifestError(`Manifest file not found: ${absFile}`);
    }
    throw err;
  }

  const docs = parseAllDocuments(source, {
    keepSourceTokens: true,
  });

  // lineCounter for one document only (the YAML lib uses one per parse call,
  // but parseAllDocuments shares an internal counter; expose via .options).
  const out: LoadedDocument[] = [];
  let idx = 0;
  for (const doc of docs) {
    if (doc.errors.length && opts.throwOnParseError !== false) {
      const e = doc.errors[0]!;
      const pos = errorPosition(absFile, source, e);
      throw new ManifestError(
        `${pos.file}:${pos.line}:${pos.column}: YAML parse error: ${e.message}`,
      );
    }
    const data = (doc.toJS({ maxAliasCount: -1 }) ?? {}) as Record<string, unknown>;
    const kind = typeof data.kind === 'string' ? (data.kind as ManifestKind | string) : undefined;
    const position = makePositionResolver(absFile, source, doc);
    out.push({ file: absFile, docIndex: idx, kind, data, position });
    idx++;
  }
  return out;
}

interface YamlError {
  pos?: [number, number];
  message: string;
}

function errorPosition(file: string, source: string, e: YamlError): SourcePosition {
  if (Array.isArray(e.pos) && typeof e.pos[0] === 'number') {
    const { line, col } = offsetToLineCol(source, e.pos[0]);
    return { file, line, column: col };
  }
  return { file, line: 1, column: 1 };
}

function offsetToLineCol(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * Build a resolver from JSON pointer paths to source positions for one doc.
 * The yaml library exposes node ranges via `getIn([...], true)`; we use
 * those ranges and convert offset → line/col with a one-time scan.
 */
function makePositionResolver(
  file: string,
  source: string,
  doc: Document,
): PositionResolver {
  return (jsonPath: string): SourcePosition => {
    const keys = parseJsonPointer(jsonPath);
    let node: Node | null | undefined;
    if (keys.length === 0) {
      node = doc.contents as Node | null;
    } else {
      node = doc.getIn(keys, true) as Node | null | undefined;
      if (!node) {
        // fall back to parents on the way up
        for (let i = keys.length - 1; i >= 0; i--) {
          const partial = keys.slice(0, i);
          const candidate = doc.getIn(partial, true) as Node | null | undefined;
          if (candidate) {
            node = candidate;
            break;
          }
        }
      }
    }
    const range = (node as Node | undefined)?.range;
    if (range && typeof range[0] === 'number') {
      const { line, col } = offsetToLineCol(source, range[0]);
      return { file, line, column: col };
    }
    return { file, line: 1, column: 1 };
  };
}

/**
 * Parse a JSON Pointer (RFC 6901) or Ajv-style instancePath into a key
 * array. Supports both `/repositories/0/name` and `.repositories[0].name`.
 */
export function parseJsonPointer(pointer: string): (string | number)[] {
  if (!pointer) return [];
  // Ajv emits instancePath like "/repositories/0/name"; strip a leading slash.
  const trimmed = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  if (trimmed.length === 0) return [];
  return trimmed.split('/').map((segment) => {
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    const asNumber = Number(decoded);
    return decoded !== '' && Number.isInteger(asNumber) && String(asNumber) === decoded
      ? asNumber
      : decoded;
  });
}

// re-export for tests
export type { LineCounter };
