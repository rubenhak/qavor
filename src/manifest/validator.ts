import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import defsSchema from '../schema/qavor.defs.schema.json' with { type: 'json' };
import profileSchema from '../schema/qavor.profile.schema.json' with { type: 'json' };
import projectSchema from '../schema/qavor.project.schema.json' with { type: 'json' };
import serviceSchema from '../schema/qavor.service.schema.json' with { type: 'json' };
import workspacesSchema from '../schema/qavor.workspaces.schema.json' with { type: 'json' };
import type { LoadedDocument } from './loader.js';
import type { ManifestKind } from './types/index.js';

export interface ValidationIssue {
  /** Absolute file. */
  file: string;
  line: number;
  column: number;
  /** kind from the manifest, or "unknown" if missing/invalid. */
  kind: string;
  /** JSON pointer-style path within the doc. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const KIND_SCHEMA_IDS: Record<ManifestKind, string> = {
  workspaces: (workspacesSchema as { $id: string }).$id,
  project: (projectSchema as { $id: string }).$id,
  service: (serviceSchema as { $id: string }).$id,
  profile: (profileSchema as { $id: string }).$id,
};

const ALL_KINDS: ManifestKind[] = ['workspaces', 'project', 'service', 'profile'];

let ajvSingleton: Ajv2020 | null = null;
const validatorCache = new Map<ManifestKind, ValidateFunction>();

function getAjv(): Ajv2020 {
  if (ajvSingleton) return ajvSingleton;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  // Register shared defs first so per-kind schemas can resolve $refs.
  ajv.addSchema(defsSchema as object);
  ajv.addSchema(workspacesSchema as object);
  ajv.addSchema(projectSchema as object);
  ajv.addSchema(serviceSchema as object);
  ajv.addSchema(profileSchema as object);
  ajvSingleton = ajv;
  return ajv;
}

function getValidator(kind: ManifestKind): ValidateFunction {
  const cached = validatorCache.get(kind);
  if (cached) return cached;
  const ajv = getAjv();
  const id = KIND_SCHEMA_IDS[kind];
  const fn = ajv.getSchema(id);
  if (!fn) throw new Error(`Internal: schema not registered for kind=${kind}`);
  validatorCache.set(kind, fn);
  return fn;
}

export function isKnownKind(value: unknown): value is ManifestKind {
  return typeof value === 'string' && (ALL_KINDS as string[]).includes(value);
}

/**
 * Validate one loaded document against its kind-specific schema.
 */
export function validateDocument(doc: LoadedDocument): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!doc.kind) {
    const pos = doc.position('');
    issues.push({
      file: pos.file,
      line: pos.line,
      column: pos.column,
      kind: 'unknown',
      path: '',
      message: 'Missing top-level `kind:` field.',
    });
    return { ok: false, issues };
  }
  if (!isKnownKind(doc.kind)) {
    const pos = doc.position('/kind');
    issues.push({
      file: pos.file,
      line: pos.line,
      column: pos.column,
      kind: String(doc.kind),
      path: '/kind',
      message: `Unknown kind: ${doc.kind}. Expected one of: ${ALL_KINDS.join(', ')}`,
    });
    return { ok: false, issues };
  }
  const validator = getValidator(doc.kind);
  const valid = validator(doc.data);
  if (valid) return { ok: true, issues: [] };
  for (const err of validator.errors ?? []) {
    issues.push(formatAjvError(doc, err));
  }
  return { ok: false, issues };
}

function formatAjvError(doc: LoadedDocument, err: ErrorObject): ValidationIssue {
  const instancePath = err.instancePath ?? '';
  const pos = doc.position(instancePath);
  const where = instancePath || '<root>';
  let message = err.message ?? 'invalid';
  if (
    err.keyword === 'additionalProperties' &&
    err.params &&
    typeof (err.params as { additionalProperty?: string }).additionalProperty === 'string'
  ) {
    const extra = (err.params as { additionalProperty: string }).additionalProperty;
    message = `Unexpected property '${extra}'`;
  } else if (
    err.keyword === 'required' &&
    err.params &&
    typeof (err.params as { missingProperty?: string }).missingProperty === 'string'
  ) {
    const missing = (err.params as { missingProperty: string }).missingProperty;
    message = `Missing required property '${missing}'`;
  } else if (
    err.keyword === 'enum' &&
    err.params &&
    Array.isArray((err.params as { allowedValues?: unknown[] }).allowedValues)
  ) {
    const allowed = (err.params as { allowedValues: unknown[] }).allowedValues;
    message = `${message}: ${allowed.map((v) => JSON.stringify(v)).join(', ')}`;
  } else if (
    err.keyword === 'pattern' &&
    err.params &&
    typeof (err.params as { pattern?: string }).pattern === 'string'
  ) {
    message = `Value does not match pattern /${(err.params as { pattern: string }).pattern}/`;
  }
  return {
    file: pos.file,
    line: pos.line,
    column: pos.column,
    kind: String(doc.kind ?? 'unknown'),
    path: where,
    message,
  };
}

export function formatIssue(i: ValidationIssue): string {
  return `${i.file}:${i.line}:${i.column} [${i.kind}] ${i.path}: ${i.message}`;
}
