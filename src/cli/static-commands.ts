/**
 * Names of the built-in (statically registered) top-level commands. Dynamic
 * manifest commands that collide with one of these are not registered as
 * `qavor <name>` (the built-in wins); `qavor commands` flags them as shadowed.
 * The startup discovery also uses this set to skip the registry build when the
 * invoked subcommand is plainly a built-in.
 */
export const STATIC_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'init',
  'discover',
  'workspace',
  'manifests',
  'validate',
  'git',
  'env',
  'resolve-env',
  'resolve-manifest',
  'doctor',
  'commands',
  'help',
]);
