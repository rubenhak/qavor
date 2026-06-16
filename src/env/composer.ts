import path from 'node:path';
import type { RegistryEntry, WorkspaceRegistry } from '../manifest/discovery.js';
import type { LoadedDocument, PositionResolver } from '../manifest/loader.js';
import type {
  EnvBlock,
  EnvMap,
  EnvSpec,
  Requirement,
  ServiceManifest,
  StatefulEnvBlock,
} from '../manifest/types/index.js';
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

export interface UnitCompositionInput {
  /** Active run mode for the target unit. */
  mode: RunMode;
  /** Registry entry of the service/stateful whose env to resolve. */
  target: RegistryEntry;
  /** Workspace registry, used to resolve `require:` dependencies by name. */
  registry: WorkspaceRegistry;
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
  const layers = await collectOwnEnvLayers({
    env: input.service.env,
    mode: input.mode,
    manifestDir: path.dirname(input.serviceDoc.file),
    file: input.serviceDoc.file,
    position: input.serviceDoc.position,
    layerPrefix: 'service',
  });
  await loadWorkspaceDotenv(layers, input.workspaceRoot);
  appendCliLayers(layers, input.cliEnv);
  return interpolateLayers(layers, issues);
}

/**
 * Compose env for any unit (service or stateful) by name, resolving the full
 * documented precedence chain including `require:` dependencies. Mirrors
 * {@link composeServiceEnv} but additionally walks the dependency graph:
 *
 *   1. Required deps (recursive, lowest precedence). Service deps contribute
 *      their full composed env; stateful deps contribute only `env.publish`.
 *   2. The unit's own env (common → mode → .env → .env.<mode>/.env.container).
 *   3. Workspace `.env`.
 *   4. CLI `--env KEY=VAL`.
 */
export async function composeUnitEnv(input: UnitCompositionInput): Promise<ResolvedEnv> {
  const issues: ManifestComposeIssue[] = [];
  const layers: LayerEntry[] = [];
  const visited = new Set<string>();

  // 1. Required dependencies, recursively (lowest precedence).
  await appendRequireLayers(input.target, input, visited, layers, issues);

  // 2. The unit's own env.
  layers.push(
    ...(await collectOwnEnvLayers({
      env: entryEnvBlock(input.target),
      mode: input.mode,
      manifestDir: input.target.dir,
      file: input.target.file,
      position: input.target.position,
      layerPrefix: input.target.kind,
    })),
  );
  // A stateful target surfaces its own published contract on top of its env.
  if (input.target.kind === 'stateful') {
    layers.push(
      ...(await resolveStatefulPublishLayers(
        input.target,
        input.mode,
        issues,
        `${input.target.kind}.publish`,
      )),
    );
  }

  // 3 + 4. Workspace .env then CLI overrides.
  await loadWorkspaceDotenv(layers, input.workspaceRoot);
  appendCliLayers(layers, input.cliEnv);

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

/** Env block accessor that tolerates both EnvBlock and StatefulEnvBlock. */
function entryEnvBlock(entry: RegistryEntry): EnvBlock | StatefulEnvBlock | undefined {
  return (entry.data as { env?: EnvBlock | StatefulEnvBlock }).env;
}

/**
 * Build the ordered own-env layers for a single unit (no require deps, no
 * workspace/CLI): `env.common` → `env.<mode>` → `.env` → `.env.<mode>`. For
 * docker mode both `.env.docker` and its `.env.container` alias are read (the
 * latter, when present, layers last and wins).
 */
async function collectOwnEnvLayers(args: {
  env: EnvBlock | StatefulEnvBlock | undefined;
  mode: RunMode;
  manifestDir: string;
  file: string;
  position: PositionResolver;
  layerPrefix: string;
}): Promise<LayerEntry[]> {
  const { env, mode, manifestDir, file, position, layerPrefix } = args;
  const layers: LayerEntry[] = [];

  if (env?.common) {
    pushEnvMap(layers, env.common, `${layerPrefix}.env.common`, file, position, '/env/common');
  }
  if (mode === 'native' && env?.native) {
    pushEnvMap(layers, env.native, `${layerPrefix}.env.native`, file, position, '/env/native');
  } else if (mode === 'docker' && env?.docker) {
    pushEnvMap(layers, env.docker, `${layerPrefix}.env.docker`, file, position, '/env/docker');
  }

  // .env next to the manifest.
  const baseDotenv = await loadDotenvFile(path.join(manifestDir, '.env'));
  for (const e of baseDotenv) {
    layers.push({
      key: e.key,
      raw: e.value,
      layer: `${layerPrefix}.env`,
      file: e.file,
      line: e.line,
      spec: null,
    });
  }

  // Mode-specific dotenv files (.env.container is accepted as an alias for
  // .env.docker, per docs/manifests.md).
  const modeFiles = mode === 'native' ? ['.env.native'] : ['.env.docker', '.env.container'];
  for (const name of modeFiles) {
    const entries = await loadDotenvFile(path.join(manifestDir, name));
    for (const e of entries) {
      layers.push({
        key: e.key,
        raw: e.value,
        layer: `${layerPrefix}.env.${mode}`,
        file: e.file,
        line: e.line,
        spec: null,
      });
    }
  }

  return layers;
}

/** Append workspace-root `.env` layers (precedence above unit env). */
async function loadWorkspaceDotenv(layers: LayerEntry[], workspaceRoot: string): Promise<void> {
  const wsEnv = await loadDotenvFile(path.join(workspaceRoot, '.env'));
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
}

/** Append CLI `--env KEY=VAL` overrides (highest precedence). */
function appendCliLayers(layers: LayerEntry[], cliEnv: Record<string, string> | undefined): void {
  if (!cliEnv) return;
  for (const [k, v] of Object.entries(cliEnv)) {
    layers.push({ key: k, raw: v, layer: 'cli.--env', file: '<cli>', line: 0, spec: null });
  }
}

/**
 * Recursively append env layers from a unit's `require:` dependencies. Deeper
 * (transitive) deps are pushed first so they carry the lowest precedence.
 * Service deps contribute their full composed env; stateful deps contribute
 * only their resolved `env.publish` contract. Group requirements are not
 * resolved for env composition at v0.
 */
async function appendRequireLayers(
  entry: RegistryEntry,
  ctx: UnitCompositionInput,
  visited: Set<string>,
  layers: LayerEntry[],
  issues: ManifestComposeIssue[],
): Promise<void> {
  const id = entry.name || entry.file;
  if (visited.has(id)) return;
  visited.add(id);

  const requires = (entry.data as { require?: Requirement[] }).require;
  if (!Array.isArray(requires)) return;

  for (const req of requires) {
    const ref = req.service ?? req.stateful;
    if (typeof ref !== 'string' || ref.length === 0) continue; // group requires: deferred
    // Cross-repo refs may be `<repo>:<service>`; resolve by the bare name.
    const depName = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
    const dep = ctx.registry.byName.get(depName);
    if (!dep) {
      if (!req.optional) {
        const pos = entry.position('/require');
        issues.push({
          file: pos.file,
          line: pos.line,
          message: `Required dependency '${ref}' of '${entry.name || entry.kind}' was not found in the workspace.`,
        });
      }
      continue;
    }
    // Transitive deps first (lower precedence).
    await appendRequireLayers(dep, ctx, visited, layers, issues);
    if (dep.kind === 'stateful') {
      // Stateful deps run in containers at v0 (ADR-005); use their docker env
      // unless they explicitly pin native mode.
      const depMode: RunMode =
        (dep.data as { mode?: string }).mode === 'native' ? 'native' : 'docker';
      layers.push(
        ...(await resolveStatefulPublishLayers(
          dep,
          depMode,
          issues,
          `require:${dep.name}.publish`,
        )),
      );
    } else {
      layers.push(
        ...(await collectOwnEnvLayers({
          env: entryEnvBlock(dep),
          mode: ctx.mode,
          manifestDir: dep.dir,
          file: dep.file,
          position: dep.position,
          layerPrefix: `require:${dep.name}`,
        })),
      );
    }
  }
}

/**
 * Resolve a stateful's `env.publish` map. Publish values reference the
 * stateful's own env (e.g. `${POSTGRES_HOST}`), so we first resolve the
 * stateful's private env in its own scope, then interpolate publish against
 * it — only the published keys (with their final values) are returned, so the
 * stateful's private keys never leak to dependents.
 */
async function resolveStatefulPublishLayers(
  dep: RegistryEntry,
  mode: RunMode,
  issues: ManifestComposeIssue[],
  label: string,
): Promise<LayerEntry[]> {
  const env = entryEnvBlock(dep) as StatefulEnvBlock | undefined;
  const publish = env?.publish;
  if (!publish) return [];

  const ownLayers = await collectOwnEnvLayers({
    env,
    mode,
    manifestDir: dep.dir,
    file: dep.file,
    position: dep.position,
    layerPrefix: `stateful:${dep.name}`,
  });
  const ownScope = interpolateLayers(ownLayers, []);

  const out: LayerEntry[] = [];
  for (const [key, val] of Object.entries(publish)) {
    const spec = isEnvSpec(val) ? (val as EnvSpec) : null;
    const concrete = spec ? (spec.value ?? spec.default) : val;
    if (typeof concrete === 'undefined') continue;
    const pos = dep.position(`/env/publish/${key}`);
    const { value, missing, secrets } = interpolate(String(concrete), ownScope.values, process.env);
    if (secrets.length > 0) {
      issues.push({
        file: pos.file,
        line: pos.line,
        message: `\${secret:${secrets[0]}} interpolation is reserved for v1. Configure as plain env until then.`,
      });
      continue;
    }
    if (missing.length > 0) {
      issues.push({
        file: pos.file,
        line: pos.line,
        message: `Unresolved interpolation in published ${key}: \${${missing[0]}}`,
      });
      continue;
    }
    out.push({ key, raw: value, layer: label, file: pos.file, line: pos.line, spec });
  }
  return out;
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
