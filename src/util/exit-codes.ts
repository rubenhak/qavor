/**
 * Exit code contract for the qavor CLI. Documented in docs/exit-codes.md.
 *
 *   0  - OK
 *   1  - User error (bad arguments, command misuse)
 *   2  - Manifest error (validation, parse, cross-ref)
 *   3  - Runtime error (subprocess failure, IO failure, supervisor failure)
 *  10+ - Reserved for future use
 */
export const ExitCode = {
  Ok: 0,
  UserError: 1,
  ManifestError: 2,
  RuntimeError: 3,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class QavorError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = ExitCode.RuntimeError) {
    super(message);
    this.name = 'QavorError';
    this.exitCode = exitCode;
  }
}

export class UserError extends QavorError {
  constructor(message: string) {
    super(message, ExitCode.UserError);
    this.name = 'UserError';
  }
}

export class ManifestError extends QavorError {
  constructor(message: string) {
    super(message, ExitCode.ManifestError);
    this.name = 'ManifestError';
  }
}

export class RuntimeFailure extends QavorError {
  constructor(message: string) {
    super(message, ExitCode.RuntimeError);
    this.name = 'RuntimeFailure';
  }
}
