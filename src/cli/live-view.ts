import { emit, suspendLogging } from '../util/logger.js';
import {
  colorEnabled,
  type Glyphs,
  glyphs,
  type Palette,
  palette,
  SPINNER_UNICODE,
} from '../util/style.js';

/**
 * Generic live progress view for fan-out commands.
 *
 * Every multi-repo verb (`status`, `clone`, `sync`, `commit`, `push`, …) shares
 * one presentation model: a fixed list of rows, each pending until its task
 * resolves, animated with a spinner and a running counter. This module owns the
 * terminal machinery (alternate-screen TUI, a scrolling window that follows the
 * completion frontier, a streaming fallback, and a static one-pass render);
 * callers supply only a {@link LiveRenderer} that knows how to draw their rows.
 *
 * The render strategy is chosen automatically:
 *   - **alt-screen TUI** when stdout is a TTY with a known size — takes over the
 *     screen, draws the whole table up front, animates in place, then restores
 *     the terminal (scrollback intact) and prints the final table.
 *   - **streaming** when stdout is a TTY but its size is unknown — appends each
 *     row as it resolves with one animated status line pinned at the bottom.
 *   - **static** when the view is disabled (`--json`, `--verbose`) or stdout is
 *     not a TTY — a single render at {@link LiveView.finish}.
 */

// ── Layout primitives ───────────────────────────────────────────────────────

/**
 * A column's width: a fixed number of visible columns, `'label'` to use the
 * width computed from the row labels (the repo-name column), or `'flex'` to
 * absorb the remaining terminal width. At most one `'flex'` column is supported.
 */
export type ColumnWidth = number | 'label' | 'flex';

export interface LiveColumn {
  header: string;
  width: ColumnWidth;
}

export interface LiveLayout {
  /** Resolved visible width per column, in column order. */
  widths: number[];
  /** Width chosen for any `'label'` columns. */
  labelWidth: number;
  /** Terminal columns this layout was computed for. */
  termCols: number;
}

/** Per-frame context handed to a renderer when it builds a row's cells. */
export interface RowContext {
  layout: LiveLayout;
  c: Palette;
  g: Glyphs;
  /** Current spinner glyph (uncolored); colorize it however you like. */
  spinner: string;
}

/**
 * Caller-supplied drawing logic. The engine handles positioning and animation;
 * the renderer only decides what a header, a row, and the summary look like.
 */
export interface LiveRenderer<R> {
  columns: LiveColumn[];
  /**
   * Build the exact-width, colorized cells for one row. `result === null` means
   * the row is still pending (draw a spinner + placeholders).
   */
  cells(label: string, result: R | null, ctx: RowContext): string[];
  /** Optional summary footer lines printed after the final table. */
  summary?(results: ReadonlyArray<R | null>, c: Palette): string[];
}

export interface LiveViewOptions {
  /** When false (e.g. `--json`/`--verbose`), skip the TUI and render once at finish. */
  enabled: boolean;
  /** Footer verb shown while work is in flight, e.g. `'inspecting'`, `'cloning'`. */
  verb: string;
}

export interface LiveView<R> {
  /** Mark row `index` resolved with its data and repaint just that row. */
  resolve(index: number, result: R): void;
  /** Stop animating, finalize the table, and append the summary footer. */
  finish(): void;
}

const REPO_MIN = 4; // 'REPO'
const REPO_MAX = 30;
const GAP = '  ';

/** Truncate a plain string to at most `width` visible columns (no padding). */
export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 0) return '';
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/** Truncate/pad a plain string to exactly `width` visible columns. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length === width) return text;
  if (text.length < width) return text + ' '.repeat(width - text.length);
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

function labelWidthFor(labels: readonly string[]): number {
  const longest = labels.reduce((m, n) => Math.max(m, n.length), REPO_MIN);
  return Math.min(REPO_MAX, longest);
}

function computeLayout(
  columns: LiveColumn[],
  labels: readonly string[],
  termCols: number,
): LiveLayout {
  const labelWidth = labelWidthFor(labels);
  const widths = columns.map((col) =>
    col.width === 'label' ? labelWidth : col.width === 'flex' ? 0 : col.width,
  );
  const flexIndex = columns.findIndex((col) => col.width === 'flex');
  const gaps = GAP.length * Math.max(0, columns.length - 1);
  const fixed = widths.reduce((sum, w) => sum + w, 0) + gaps;
  if (flexIndex >= 0) widths[flexIndex] = Math.max(0, termCols - fixed);
  return { widths, labelWidth, termCols };
}

function joinCells(cells: string[]): string {
  return cells.join(GAP).trimEnd();
}

function headerLine(columns: LiveColumn[], layout: LiveLayout, c: Palette): string {
  return joinCells(columns.map((col, i) => c.dim(c.bold(fit(col.header, layout.widths[i] ?? 0)))));
}

const SPINNER_FRAMES = SPINNER_UNICODE.length;
const spinAt = (frame: number): string => SPINNER_UNICODE[frame % SPINNER_FRAMES] ?? '';
const FRAME_MS = 90;

// ── ANSI control sequences used by the live views ───────────────────────────
const ALT_ENTER = '\x1b[?1049h'; // switch to the alternate screen buffer
const ALT_LEAVE = '\x1b[?1049l'; // restore the previous screen + scrollback
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J';
const CLEAR_LINE = '\r\x1b[2K'; // carriage-return + clear current line
// Synchronized-output mode (DEC private mode 2026): the terminal buffers
// everything between begin/end and presents it as one atomic frame, so a
// multi-line repaint never shows half-drawn. Unsupported terminals ignore it.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const at = (row: number, col = 1): string => `\x1b[${row};${col}H`; // absolute move

/** Static, single-pass render used for the non-TTY / disabled / final path. */
function renderStatic<R>(
  labels: readonly string[],
  renderer: LiveRenderer<R>,
  states: ReadonlyArray<R | null>,
): void {
  const c = palette(colorEnabled());
  const g = glyphs(colorEnabled());
  if (labels.length === 0) {
    emit(c.dim('Nothing to report.'));
    return;
  }
  const layout = computeLayout(renderer.columns, labels, process.stdout.columns ?? 80);
  const ctx: RowContext = { layout, c, g, spinner: '' };
  emit(headerLine(renderer.columns, layout, c));
  for (const [i, label] of labels.entries()) {
    emit(joinCells(renderer.cells(label, states[i] ?? null, ctx)));
  }
  if (renderer.summary) for (const line of renderer.summary(states, c)) emit(line);
}

/**
 * Alternate-screen TUI. Takes over the screen while running so the full table
 * can be drawn up front and animated in place at any size, then restores the
 * user's terminal (scrollback intact) and prints the final table on exit.
 *
 * When there are more rows than fit on screen, the window scrolls to follow the
 * completion frontier — it keeps the lowest (furthest-down) updated row visible,
 * so you watch progress march down a large list rather than staring at a static
 * first page.
 */
function altScreenView<R>(
  labels: readonly string[],
  renderer: LiveRenderer<R>,
  verb: string,
  c: Palette,
  g: Glyphs,
  initialCols: number,
  initialRows: number,
): LiveView<R> {
  const stream = process.stdout;
  const n = labels.length;
  const states: (R | null)[] = labels.map(() => null);
  let done = 0;
  let frame = 0;
  // The deepest (highest-index) row resolved so far. The viewport scrolls to
  // keep this row visible, so the window follows the completion frontier down
  // the table. Monotonic, so the view only ever scrolls downward.
  let maxResolved = -1;
  let scrollTop = 0;
  // Set by resolve(), consumed by the animation timer: at least one row gained
  // its result since the last frame, so the next tick repaints the whole window
  // rather than just animating spinners.
  let dirty = false;

  // Geometry (recomputed on resize). Layout: row 1 header, rows 2..1+visible
  // (a scrolling window over the full list), row 2+visible footer.
  let termCols = initialCols;
  let termRows = initialRows;
  let layout = computeLayout(renderer.columns, labels, termCols);
  let visible = Math.min(n, Math.max(1, termRows - 2));

  // Scroll so the lowest updated row sits at the bottom edge of the window,
  // clamped to the list bounds. When everything fits, never scroll.
  const desiredScroll = (): number => {
    if (n <= visible) return 0;
    return Math.max(0, Math.min(maxResolved - visible + 1, n - visible));
  };

  const rowLine = (i: number): string => {
    const ctx: RowContext = { layout, c, g, spinner: spinAt(frame) };
    return joinCells(renderer.cells(labels[i] ?? '', states[i] ?? null, ctx));
  };

  const footerLine = (): string => {
    const sp = c.cyan(spinAt(frame));
    const counter = c.bold(`${done}/${n}`);
    let label: string;
    if (done >= n) {
      label = 'done';
    } else if (n > visible) {
      const from = scrollTop + 1;
      const to = Math.min(scrollTop + visible, n);
      label = `${verb}… · showing ${from}–${to} of ${n}`;
    } else {
      label = `${verb}…`;
    }
    const prefix = spinAt(frame).length + 1 + `${done}/${n}`.length + 1;
    return `${sp} ${counter} ${c.dim(truncate(label, Math.max(0, termCols - prefix - 1)))}`;
  };

  // Draw every row in the current window: screen row `2 + slot` shows item
  // `scrollTop + slot` (blank past the end of the list).
  const drawWindow = (): string => {
    let buf = '';
    for (let slot = 0; slot < visible; slot++) {
      const idx = scrollTop + slot;
      buf += `${at(2 + slot)}\x1b[2K${idx < n ? rowLine(idx) : ''}`;
    }
    return buf;
  };

  const fullRedraw = (): void => {
    stream.write(
      `${SYNC_BEGIN}${CLEAR_SCREEN}${at(1)}\x1b[2K${headerLine(renderer.columns, layout, c)}${drawWindow()}${at(2 + visible)}\x1b[2K${footerLine()}${SYNC_END}`,
    );
  };

  // Suspend logging for the lifetime of the TUI: stray stderr log lines would
  // scroll the alternate screen and make the animated view flicker.
  const resumeLogging = suspendLogging();
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stream.write(`${ALT_LEAVE}${CURSOR_SHOW}`);
    resumeLogging();
  };
  const onSignal = (): void => {
    restore();
    process.exit(130);
  };
  const onResize = (): void => {
    termCols = stream.columns || termCols;
    termRows = stream.rows || termRows;
    layout = computeLayout(renderer.columns, labels, termCols);
    visible = Math.min(n, Math.max(1, termRows - 2));
    scrollTop = desiredScroll();
    fullRedraw();
  };

  stream.write(`${ALT_ENTER}${CURSOR_HIDE}`);
  fullRedraw();
  process.once('exit', restore);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  stream.on('resize', onResize);

  // All painting happens here, on a fixed cadence. Driving paints from a single
  // timer (rather than from each resolve) coalesces a burst of resolutions — a
  // fan-out where many items finish near-instantly — into one repaint per frame
  // instead of dozens of full-window redraws back-to-back, which is what made
  // the view flicker.
  const timer = setInterval(() => {
    frame += 1;
    const newScroll = desiredScroll();
    const scrolled = newScroll !== scrollTop;
    let seq = SYNC_BEGIN;
    if (dirty || scrolled) {
      // Rows resolved (or the frontier scrolled) since the last frame: repaint
      // the whole visible window so the new results all appear together.
      scrollTop = newScroll;
      dirty = false;
      for (let slot = 0; slot < visible; slot++) {
        const idx = scrollTop + slot;
        seq += `${at(2 + slot)}\x1b[2K${idx < n ? rowLine(idx) : ''}`;
      }
    } else {
      // Steady state: only repaint still-pending rows to animate their spinner.
      for (let slot = 0; slot < visible; slot++) {
        const idx = scrollTop + slot;
        if (idx < n && states[idx] == null) seq += `${at(2 + slot)}\x1b[2K${rowLine(idx)}`;
      }
    }
    seq += `${at(2 + visible)}\x1b[2K${footerLine()}${SYNC_END}`;
    stream.write(seq);
  }, FRAME_MS);
  timer.unref?.();

  return {
    resolve(index, result) {
      if (index < 0 || index >= n) return;
      // Record only; the animation timer paints. See its comment above.
      states[index] = result;
      done += 1;
      if (index > maxResolved) maxResolved = index;
      dirty = true;
    },
    finish() {
      clearInterval(timer);
      stream.off('resize', onResize);
      process.removeListener('exit', restore);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      restore(); // back to the normal screen, scrollback intact
      renderStatic(labels, renderer, states); // print the complete final table
    },
  };
}

/**
 * Streaming fallback for terminals that don't report their size (absolute
 * positioning isn't safe there). Prints the header once, appends each row as it
 * resolves, and keeps one animated spinner line pinned at the bottom — only that
 * line is ever rewritten, so scrollback stays clean.
 */
function streamingView<R>(
  labels: readonly string[],
  renderer: LiveRenderer<R>,
  verb: string,
  c: Palette,
  g: Glyphs,
  termCols: number,
): LiveView<R> {
  const stream = process.stdout;
  const n = labels.length;
  const layout = computeLayout(renderer.columns, labels, termCols);
  const states: (R | null)[] = labels.map(() => null);
  const pending = new Set(labels.map((_l, i) => i));
  let done = 0;
  let frame = 0;

  const statusLine = (): string => {
    const sp = spinAt(frame);
    const counter = `${done}/${n}`;
    const prefixWidth = sp.length + 1 + counter.length + 1;
    let label: string;
    if (pending.size === 0) {
      label = 'done';
    } else {
      const names = [...pending]
        .slice(0, 3)
        .map((i) => labels[i])
        .join(', ');
      const more = pending.size > 3 ? `, +${pending.size - 3} more` : '';
      label = `${verb}… ${names}${more}`;
    }
    label = truncate(label, Math.max(0, termCols - prefixWidth - 1));
    return `${c.cyan(sp)} ${c.bold(counter)} ${c.dim(label)}`;
  };

  // Suspend logging while the pinned status line is live: an interleaved stderr
  // log line would land between rows and shove the status line around.
  const resumeLogging = suspendLogging();
  let cursorShown = false;
  const showCursor = (): void => {
    resumeLogging();
    if (!cursorShown) {
      cursorShown = true;
      stream.write(CURSOR_SHOW);
    }
  };
  process.once('exit', showCursor);

  stream.write(
    `${CURSOR_HIDE}${headerLine(renderer.columns, layout, c)}\n${CLEAR_LINE}${statusLine()}`,
  );

  const timer = setInterval(() => {
    frame += 1;
    stream.write(`${CLEAR_LINE}${statusLine()}`);
  }, FRAME_MS);
  timer.unref?.();

  return {
    resolve(index, result) {
      if (index < 0 || index >= n) return;
      states[index] = result;
      pending.delete(index);
      done += 1;
      const ctx: RowContext = { layout, c, g, spinner: '' };
      const row = joinCells(renderer.cells(labels[index] ?? '', result, ctx));
      stream.write(`${CLEAR_LINE}${row}\n${CLEAR_LINE}${statusLine()}`);
    },
    finish() {
      clearInterval(timer);
      stream.write(CLEAR_LINE);
      showCursor();
      process.removeListener('exit', showCursor);
      if (renderer.summary) for (const line of renderer.summary(states, c)) emit(line);
    },
  };
}

/**
 * Build a live progress view for `labels`, choosing the alt-screen TUI, the
 * streaming fallback, or a static one-pass render based on the terminal and
 * {@link LiveViewOptions.enabled}.
 */
export function createLiveView<R>(
  labels: readonly string[],
  renderer: LiveRenderer<R>,
  opts: LiveViewOptions,
): LiveView<R> {
  const n = labels.length;
  const isTty = process.stdout.isTTY === true;
  if (!opts.enabled || !isTty || n === 0) {
    const states: (R | null)[] = labels.map(() => null);
    return {
      resolve(index, result) {
        if (index >= 0 && index < n) states[index] = result;
      },
      finish() {
        renderStatic(labels, renderer, states);
      },
    };
  }

  const c = palette(true);
  const g = glyphs(true);
  const termCols = process.stdout.columns ?? 0;
  const termRows = process.stdout.rows ?? 0;
  // Alternate-screen TUI when we know the geometry; otherwise stream (absolute
  // cursor positioning needs a real size to anchor to).
  if (termCols > 0 && termRows > 2) {
    return altScreenView(labels, renderer, opts.verb, c, g, termCols, termRows);
  }
  return streamingView(labels, renderer, opts.verb, c, g, termCols || 80);
}
