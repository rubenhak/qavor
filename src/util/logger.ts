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
