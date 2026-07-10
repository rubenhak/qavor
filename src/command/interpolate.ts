import { RuntimeFailure } from '../util/exit-codes.js';

/**
 * `${VAR}` interpolation for declarative step fields (compose/docker steps).
 *
 * Shell `cmd` steps never pass through here — the shell expands their
 * variables at run time. Declarative steps have no shell, so qavor substitutes
 * `${VAR}` itself against the step's spawn env (composed service env over
 * `process.env`, plus the injected `QAVOR_*` values), mirroring the env
 * composer's semantics: unresolved names fail closed, and the reserved
 * `${secret:NAME}` syntax fails closed at v0.
 */
const INTERP_RE = /\$\{([^}]+)\}/g;
const SECRET_PREFIX = 'secret:';

export type EnvLookup = Record<string, string | undefined>;

/** Interpolate `${VAR}` refs in one string; fails closed on unresolved names. */
export function interpolateValue(value: string, env: EnvLookup, context: string): string {
  return value.replace(INTERP_RE, (_, name: string) => {
    if (name.startsWith(SECRET_PREFIX)) {
      throw new RuntimeFailure(
        `\${${name}} in ${context}: secret interpolation is reserved and fails closed at v0.`,
      );
    }
    const resolved = env[name];
    if (typeof resolved === 'undefined') {
      throw new RuntimeFailure(`Unresolved \${${name}} in ${context}.`);
    }
    return resolved;
  });
}

/**
 * Deep-interpolate every string inside a declarative step body (arrays and
 * nested objects included). Numbers and booleans pass through untouched.
 * Returns a new value; never mutates the manifest-held step.
 */
export function interpolateDeep<T>(value: T, env: EnvLookup, context: string): T {
  if (typeof value === 'string') return interpolateValue(value, env, context) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => interpolateDeep(v, env, context)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateDeep(v, env, context);
    }
    return out as T;
  }
  return value;
}
