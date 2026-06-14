/**
 * Zero-dependency terminal styling: ANSI colors + Unicode glyphs with ASCII
 * fallbacks. We deliberately avoid a color dependency (chalk/picocolors) — the
 * locked toolchain in AGENTS.md §4 has none, and a handful of escape codes do
 * not justify a new top-level dep.
 *
 * Color follows the de-facto conventions modern CLIs honor:
 *   - `NO_COLOR` (any value) disables color — https://no-color.org
 *   - `FORCE_COLOR` (anything but `0`) forces it on, even when piped
 *   - otherwise color is on only when the target stream is a TTY
 */

function streamColorEnabled(stream: NodeJS.WriteStream): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '0') return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(stream.isTTY);
}

/** Whether colorized output is appropriate for stdout (the user-output stream). */
export function colorEnabled(): boolean {
  return streamColorEnabled(process.stdout);
}

/** Whether the stderr stream (progress / spinners) can use color + glyphs. */
export function stderrColorEnabled(): boolean {
  return streamColorEnabled(process.stderr);
}

type Sgr = (s: string) => string;

const wrap =
  (open: number, close: number): Sgr =>
  (s: string): string =>
    `\x1b[${open}m${s}\x1b[${close}m`;

/**
 * Style helpers. Each conditionally applies its escape based on `enabled`, so
 * call-sites stay terse: `c.green(text)` is a no-op string passthrough when
 * color is disabled (piped output, `NO_COLOR`, `--json`).
 */
export interface Palette {
  bold: Sgr;
  dim: Sgr;
  red: Sgr;
  green: Sgr;
  yellow: Sgr;
  blue: Sgr;
  magenta: Sgr;
  cyan: Sgr;
  gray: Sgr;
}

const identity: Sgr = (s) => s;

const ACTIVE: Palette = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

const INERT: Palette = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  blue: identity,
  magenta: identity,
  cyan: identity,
  gray: identity,
};

export function palette(enabled: boolean): Palette {
  return enabled ? ACTIVE : INERT;
}

/**
 * Status glyphs with ASCII fallbacks. Emoji land only when the terminal can
 * render them (we gate on color support as a reasonable proxy for a modern,
 * UTF-8 TTY); otherwise we degrade to plain ASCII so piped/CI output stays
 * legible.
 */
export interface Glyphs {
  clean: string;
  dirty: string;
  ahead: string;
  behind: string;
  diverged: string;
  detached: string;
  noUpstream: string;
  missing: string;
  arrowUp: string;
  arrowDown: string;
}

const EMOJI: Glyphs = {
  clean: '✓',
  dirty: '●',
  ahead: '⬆',
  behind: '⬇',
  diverged: '⇅',
  detached: '⚠',
  noUpstream: '∅',
  missing: '⊘',
  arrowUp: '↑',
  arrowDown: '↓',
};

const ASCII: Glyphs = {
  clean: 'ok',
  dirty: '*',
  ahead: '^',
  behind: 'v',
  diverged: 'x',
  detached: '!',
  noUpstream: '-',
  missing: '?',
  arrowUp: '+',
  arrowDown: '-',
};

export function glyphs(unicode: boolean): Glyphs {
  return unicode ? EMOJI : ASCII;
}

/** Animated spinner frames (Braille dots). ASCII fallback is a simple bar. */
export const SPINNER_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_ASCII = ['-', '\\', '|', '/'];

/** Visible width of a string, ignoring ANSI SGR escape sequences. */
export function visibleWidth(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point.
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
