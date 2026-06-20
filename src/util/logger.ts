import pino, { type Logger as PinoLogger } from 'pino';

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
    rootLogger = pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          destination: 2,
          colorize: stderrIsTty,
          translateTime: false,
          ignore: 'pid,hostname,time',
          messageFormat: '{msg}',
          singleLine: false,
          sync: true,
        },
      },
    });
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
