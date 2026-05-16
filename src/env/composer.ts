import path from 'node:path';
import type { LoadedDocument } from '../manifest/loader.js';
import type { EnvMap, EnvSpec, ServiceManifest } from '../manifest/types/index.js';
import { ManifestError, UserError } from '../util/exit-codes.js';
import { loadDotenvFile } from './dotenv.js';

export type RunMode = 'native' | 'docker';

export interface ResolvedValue {
  /** Final resolved string value (post-interpolation, post-defaults). */
  value: string;
  /** Provenance trail, most-recent-wins is the last entry. */
  provenance: Provenance[];
  /** True when the originating envSpec marks this var as secret. */
  secret: boolean;
  /** True when the originating envSpec marks this var as required. */
  required: boolean;
}

export interface Provenance {
  file: string;
  line: number;
  /** Human-readable layer label. */
  layer: string;
  /** Pre-interpolation raw value. */
  raw: string;
}

export interface ResolvedEnv {
  /** Ordered map (Map preserves insertion order for first-seen keys). */
  values: Map<string, ResolvedValue>;
  /** Validation issues raised during resolution. Empty when ok. */
  issues: ManifestComposeIssue[];
}

export interface ManifestComposeIssue {
  file: string;
  line: number;
  message: string;
}

export interface ServiceCompositionInput {
  /** Active run mode for the service. */
  mode: RunMode;
  /** The service's loaded doc (used for positions). */
  serviceDoc: LoadedDocument;
  /** The service manifest body (typed). */
  service: ServiceManifest;
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** CLI --env KEY=VAL entries. */
  cliEnv?: Record<string, string>;
}

/**
 * Compose env for a service per the MVP precedence (later wins):
 *
 *   1. Service own env.common
 *   2. Service own env.<mode>
 *   3. <manifestDir>/.env
 *   4. <manifestDir>/.env.<mode>
 *   5. <workspaceRoot>/.env
 *   6. CLI --env KEY=VAL
 *
 * Returns a ResolvedEnv with full provenance per key. Required env without
 * a value raises an issue (caller decides what to do).
 */
export async function composeServiceEnv(input: ServiceCompositionInput): Promise<ResolvedEnv> {
  const issues: ManifestComposeIssue[] = [];
  const layers: LayerEntry[] = [];

  const manifestDir = path.dirname(input.serviceDoc.file);
  const env = input.service.env;
  const positionFor = input.serviceDoc.position;

  if (env?.common) {
    pushEnvMap(
      layers,
      env.common,
      'service.env.common',
      input.serviceDoc.file,
      positionFor,
      '/env/common',
    );
  }
  if (input.mode === 'native' && env?.native) {
    pushEnvMap(
      layers,
      env.native,
      'service.env.native',
      input.serviceDoc.file,
      positionFor,
      '/env/native',
    );
  } else if (input.mode === 'docker' && env?.docker) {
    pushEnvMap(
      layers,
      env.docker,
      'service.env.docker',
      input.serviceDoc.file,
      positionFor,
      '/env/docker',
    );
  }
  // .env next to manifest
  const baseDotenv = await loadDotenvFile(path.join(manifestDir, '.env'));
  for (const e of baseDotenv) {
    layers.push({
      key: e.key,
      raw: e.value,
      layer: 'service.env',
      file: e.file,
      line: e.line,
      spec: null,
    });
  }
  // .env.<mode> next to manifest
  const modeDotenvFile = path.join(
    manifestDir,
    input.mode === 'native' ? '.env.native' : '.env.docker',
  );
  const modeDotenv = await loadDotenvFile(modeDotenvFile);
  for (const e of modeDotenv) {
    layers.push({
      key: e.key,
      raw: e.value,
      layer: `service.env.${input.mode}`,
      file: e.file,
      line: e.line,
      spec: null,
    });
  }
  // Workspace .env
  const wsEnv = await loadDotenvFile(path.join(input.workspaceRoot, '.env'));
  for (const e of wsEnv) {
    layers.push({
      key: e.key,
      raw: e.value,
      layer: 'workspace.env',
      file: e.file,
      line: e.line,
      spec: null,
    });
  }
  // CLI overrides
  if (input.cliEnv) {
    for (const [k, v] of Object.entries(input.cliEnv)) {
      layers.push({
        key: k,
        raw: v,
        layer: 'cli.--env',
        file: '<cli>',
        line: 0,
        spec: null,
      });
    }
  }

  return interpolateLayers(layers, issues);
}

interface LayerEntry {
  key: string;
  raw: string;
  layer: string;
  file: string;
  line: number;
  spec: EnvSpec | null;
}

function pushEnvMap(
  layers: LayerEntry[],
  map: EnvMap,
  layerLabel: string,
  file: string,
  positionFor: LoadedDocument['position'],
  basePath: string,
): void {
  for (const [key, val] of Object.entries(map)) {
    const valuePath = `${basePath}/${key}`;
    const pos = positionFor(valuePath);
    if (isEnvSpec(val)) {
      const spec = val as EnvSpec;
      const concrete =
        typeof spec.value !== 'undefined'
          ? spec.value
          : typeof spec.default !== 'undefined'
            ? spec.default
            : undefined;
      if (typeof concrete === 'undefined') {
        // Required envSpec with no value/default contributes a placeholder layer so
        // the resolver can flag the missing required at the end.
        layers.push({
          key,
          raw: '',
          layer: layerLabel,
          file,
          line: pos.line,
          spec,
        });
        continue;
      }
      layers.push({
        key,
        raw: String(concrete),
        layer: layerLabel,
        file,
        line: pos.line,
        spec,
      });
    } else {
      layers.push({
        key,
        raw: String(val),
        layer: layerLabel,
        file,
        line: pos.line,
        spec: null,
      });
    }
  }
}

function isEnvSpec(v: unknown): v is EnvSpec {
  return Boolean(
    v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      ('value' in (v as object) ||
        'default' in (v as object) ||
        'required' in (v as object) ||
        'secret' in (v as object) ||
        'type' in (v as object) ||
        'pattern' in (v as object) ||
        'description' in (v as object)),
  );
}

const INTERP_RE = /\$\{([^}]+)\}/g;
const SECRET_PREFIX = 'secret:';

function interpolateLayers(layers: LayerEntry[], issues: ManifestComposeIssue[]): ResolvedEnv {
  // Resolve layer-by-layer, later wins. We interpolate against the
  // running map plus process.env for `${VAR}` references.
  const values = new Map<string, ResolvedValue>();
  for (const entry of layers) {
    const isRequiredPlaceholder =
      !entry.raw &&
      entry.spec?.required === true &&
      typeof entry.spec?.value === 'undefined' &&
      typeof entry.spec?.default === 'undefined';
    if (isRequiredPlaceholder) {
      // Track the required flag on the key without writing a non-empty value.
      const prior = values.get(entry.key);
      const provenance = prior ? prior.provenance.slice() : [];
      provenance.push({ file: entry.file, line: entry.line, layer: entry.layer, raw: '' });
      values.set(entry.key, {
        value: prior?.value ?? '',
        provenance,
        secret: Boolean(entry.spec?.secret) || (prior?.secret ?? false),
        required: true,
      });
      continue;
    }
    const { value, missing, secrets } = interpolate(entry.raw, values, process.env);
    if (secrets.length > 0) {
      // v0 fails closed on ${secret:...}; ADR-reserved syntax.
      issues.push({
        file: entry.file,
        line: entry.line,
        message: `\${secret:${secrets[0]}} interpolation is reserved for v1. Configure as plain env until then.`,
      });
      continue;
    }
    if (missing.length > 0) {
      issues.push({
        file: entry.file,
        line: entry.line,
        message: `Unresolved interpolation in ${entry.key}: \${${missing[0]}}`,
      });
      continue;
    }
    const prior = values.get(entry.key);
    const provenance = prior ? prior.provenance.slice() : [];
    provenance.push({ file: entry.file, line: entry.line, layer: entry.layer, raw: entry.raw });
    values.set(entry.key, {
      value,
      provenance,
      secret: Boolean(entry.spec?.secret) || (prior?.secret ?? false),
      required: Boolean(entry.spec?.required) || (prior?.required ?? false),
    });
  }
  // Surface missing-required errors after the full chain.
  for (const [key, val] of values) {
    if (val.required && (val.value === '' || typeof val.value === 'undefined')) {
      const last = val.provenance[val.provenance.length - 1];
      issues.push({
        file: last?.file ?? '<unknown>',
        line: last?.line ?? 0,
        message: `Required env ${key} has no value.`,
      });
    }
  }
  return { values, issues };
}

function interpolate(
  raw: string,
  resolved: Map<string, ResolvedValue>,
  procEnv: NodeJS.ProcessEnv,
): { value: string; missing: string[]; secrets: string[] } {
  if (!raw) return { value: raw, missing: [], secrets: [] };
  const missing: string[] = [];
  const secrets: string[] = [];
  const value = raw.replace(INTERP_RE, (_m, expr: string) => {
    const trimmed = expr.trim();
    if (trimmed.startsWith(SECRET_PREFIX)) {
      secrets.push(trimmed.slice(SECRET_PREFIX.length));
      return '';
    }
    const fromResolved = resolved.get(trimmed);
    if (fromResolved) return fromResolved.value;
    const fromProc = procEnv[trimmed];
    if (typeof fromProc === 'string') return fromProc;
    missing.push(trimmed);
    return '';
  });
  return { value, missing, secrets };
}

/**
 * Parse `KEY=VAL` strings from --env into a record. Quote stripping is the
 * caller's responsibility (commander gives us the raw string).
 */
export function parseCliEnv(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new UserError(`Invalid --env value '${item}'. Expected KEY=VALUE.`);
    const key = item.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new UserError(`Invalid env key '${key}' in --env. Use UPPER_SNAKE_CASE.`);
    }
    out[key] = item.slice(eq + 1);
  }
  return out;
}

/**
 * Convenience: take a ResolvedEnv and produce a plain string→string object
 * suitable for execa's `env` option. Secrets remain in plaintext (the child
 * process needs them); only the printable representations elsewhere should
 * redact.
 */
export function toEnvObject(resolved: ResolvedEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of resolved.values) out[k] = v.value;
  return out;
}

/**
 * Throw if there are any unrecoverable issues so callers can fail fast.
 */
export function assertNoIssues(resolved: ResolvedEnv): void {
  if (resolved.issues.length === 0) return;
  const lines = resolved.issues.map((i) => `${i.file}:${i.line}: ${i.message}`);
  throw new ManifestError(`Environment composition failed:\n  ${lines.join('\n  ')}`);
}
