import pino, { type Logger as PinoLogger } from 'pino';
import prettyFactory from 'pino-pretty';

export type Logger = PinoLogger;

export interface LoggerOptions {
  json: boolean;
  verbose: boolean;
}

let rootLogger: Logger | null = null;

export function configureLogger(opts: LoggerOptions): Logger {
  const level = opts.verbose ? 'debug' : 'info';
  // Logs always go to stderr so stdout stays clean for user output (tables in
  // human mode, NDJSON payloads in --json mode). Pretty-print only on a TTY.
  const stderrIsTty = Boolean(process.stderr.isTTY);
  if (opts.json || !stderrIsTty) {
    rootLogger = pino({ level }, pino.destination({ fd: 2, sync: true }));
  } else {
    // pino-pretty is built in-process here (not via `transport:`) so it writes
    // synchronously on the main thread. `transport:` always spins pino-pretty up
    // on a worker thread, which formats/writes asynchronously — a log call
    // returns before its line actually lands on fd 2. That races against any
    // child process spawned right after with `stdio: 'inherit'` (declarative
    // steps stream raw command output straight to the same fd), so the two
    // sources land on the terminal out of order. Formatting in-process makes a
    // log call's write happen before it returns, so it stays ordered relative
    // to inherited child stdio.
    const stream = prettyFactory({
      destination: 2,
      colorize: stderrIsTty,
      translateTime: false,
      // `level` is dropped too: qavor's own log calls fold severity into the
      // message itself (a `✗`/`✓` marker, or plain wording), so the `INFO:`/
      // `ERROR:` tag pino-pretty would otherwise prepend is redundant noise.
      ignore: 'pid,hostname,time,level',
      messageFormat: '{msg}',
      singleLine: false,
      sync: true,
    });
    rootLogger = pino({ level }, stream);
  }
  return rootLogger;
}

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: 'info' });
  }
  return rootLogger;
}

/**
 * Silence all logger output until the returned resume function is called.
 *
 * The alternate-screen / streaming live views own the terminal while they
 * animate, positioning the cursor with absolute escape sequences. A stray
 * stderr log line written mid-animation (e.g. `prepare: starting`) scrolls the
 * screen out from under the view and makes it flicker as the next frame
 * repaints. While such a view is active we suspend logging entirely and restore
 * the previous level when it tears down. Idempotent: calling resume twice is a
 * no-op.
 */
export function suspendLogging(): () => void {
  const logger = getLogger();
  const previousLevel = logger.level;
  logger.level = 'silent';
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    logger.level = previousLevel;
  };
}

/**
 * Plain stdout output for human-readable mode. Bypasses pino so tabular
 * output (`status`, `ps`, `env`) renders without log decorations.
 */
export function emit(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * JSON-mode output. Always one JSON object per line on stdout.
 */
export function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
