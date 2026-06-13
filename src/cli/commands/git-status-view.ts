import { emit } from '../../util/logger.js';
import {
  colorEnabled,
  type Glyphs,
  glyphs,
  type Palette,
  palette,
  SPINNER_UNICODE,
} from '../../util/style.js';

export interface StatusRow {
  repo: string;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  last_commit: string | null;
  last_commit_subject: string | null;
}

export interface StatusView {
  /** Mark repo `index` resolved with its data and repaint just that row. */
  resolve(index: number, row: StatusRow): void;
  /** Stop animating, finalize the table, and append the summary footer. */
  finish(rows: StatusRow[]): void;
}

// Fixed column widths so a single resolved row can be repainted in place
// without having to re-measure (and therefore repaint) its neighbors. Each is
// at least as wide as its header label. SUBJECT takes whatever width is left.
const ICON_W = 1;
const BRANCH_W = 16;
const SYNC_W = 8;
const CHANGES_W = 7;
const COMMIT_W = 7;
const GAP = '  ';
const REPO_MIN = 4; // 'REPO'
const REPO_MAX = 30;
const HEADERS = ['', 'REPO', 'BRANCH', 'SYNC', 'CHANGES', 'COMMIT', 'SUBJECT'];

interface Layout {
  repoW: number;
  subjectW: number;
}

/** Truncate a plain string to at most `width` visible columns (no padding). */
function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 0) return '';
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/** Truncate/pad a plain string to exactly `width` visible columns. */
function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length === width) return text;
  if (text.length < width) return text + ' '.repeat(width - text.length);
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

function fixedWidth(repoW: number): number {
  return (
    ICON_W + repoW + BRANCH_W + SYNC_W + CHANGES_W + COMMIT_W + GAP.length * (HEADERS.length - 1)
  );
}

function computeLayout(repoNames: string[], termCols: number): Layout {
  const longest = repoNames.reduce((m, n) => Math.max(m, n.length), REPO_MIN);
  const repoW = Math.min(REPO_MAX, longest);
  const subjectW = Math.max(0, termCols - fixedWidth(repoW));
  return { repoW, subjectW };
}

/** Build the 7 exact-width, colorized cells for one resolved repo row. */
function rowCells(r: StatusRow, c: Palette, g: Glyphs, layout: Layout): string[] {
  const { repoW, subjectW } = layout;
  const repo = c.bold(fit(r.repo, repoW));

  const detached = r.branch === null;
  const dirty = r.dirty > 0;
  const diverged = r.ahead > 0 && r.behind > 0;

  let icon: string;
  if (detached) icon = c.yellow(g.detached);
  else if (diverged) icon = c.magenta(g.diverged);
  else if (dirty) icon = c.yellow(g.dirty);
  else if (r.behind > 0) icon = c.blue(g.behind);
  else if (r.ahead > 0) icon = c.blue(g.ahead);
  else icon = c.green(g.clean);

  const branch = detached
    ? c.yellow(fit('(detached)', BRANCH_W))
    : c.cyan(fit(r.branch ?? '', BRANCH_W));

  // SYNC mixes two colors, so build it from a colored display + a plain copy
  // used only to compute the trailing pad.
  let sync: string;
  if (r.ahead === 0 && r.behind === 0) {
    sync = c.dim(fit('·', SYNC_W));
  } else {
    const plain: string[] = [];
    const colored: string[] = [];
    if (r.ahead > 0) {
      plain.push(`${g.arrowUp}${r.ahead}`);
      colored.push(c.green(`${g.arrowUp}${r.ahead}`));
    }
    if (r.behind > 0) {
      plain.push(`${g.arrowDown}${r.behind}`);
      colored.push(c.red(`${g.arrowDown}${r.behind}`));
    }
    const pad = Math.max(0, SYNC_W - plain.join(' ').length);
    sync = colored.join(' ') + ' '.repeat(pad);
  }

  const changes = dirty
    ? c.yellow(fit(`${g.dirty} ${r.dirty}`, CHANGES_W))
    : c.dim(fit(g.clean, CHANGES_W));
  const commit = c.dim(fit(r.last_commit ?? '—', COMMIT_W));
  const subject = fit((r.last_commit_subject ?? '').split('\n')[0] ?? '', subjectW);
  return [icon, repo, branch, sync, changes, commit, subject];
}

function joinCells(cells: string[]): string {
  return cells.join(GAP).trimEnd();
}

function headerLine(c: Palette, layout: Layout): string {
  const widths = [ICON_W, layout.repoW, BRANCH_W, SYNC_W, CHANGES_W, COMMIT_W, layout.subjectW];
  return joinCells(HEADERS.map((h, i) => c.dim(c.bold(fit(h, widths[i] ?? 0)))));
}

function summaryLines(rows: StatusRow[], c: Palette): string[] {
  const total = rows.length;
  const count = (pred: (r: StatusRow) => boolean): number => rows.filter(pred).length;
  const bits = [`${total} repo${total === 1 ? '' : 's'}`];
  const dirtyN = count((r) => r.dirty > 0);
  const aheadN = count((r) => r.ahead > 0);
  const behindN = count((r) => r.behind > 0);
  const detachedN = count((r) => r.branch === null);
  if (dirtyN) bits.push(c.yellow(`${dirtyN} dirty`));
  if (aheadN) bits.push(c.green(`${aheadN} ahead`));
  if (behindN) bits.push(c.red(`${behindN} behind`));
  if (detachedN) bits.push(c.magenta(`${detachedN} detached`));
  return ['', c.dim('Summary: ') + bits.join(c.dim('  ·  '))];
}

/** Static, single-pass render for the non-TTY / fallback path. */
function renderStatic(rows: StatusRow[]): void {
  const c = palette(colorEnabled());
  const g = glyphs(colorEnabled());
  if (rows.length === 0) {
    emit(c.dim('No repos to report.'));
    return;
  }
  const layout = computeLayout(
    rows.map((r) => r.repo),
    process.stdout.columns ?? 80,
  );
  emit(headerLine(c, layout));
  for (const row of rows) emit(joinCells(rowCells(row, c, g, layout)));
  for (const line of summaryLines(rows, c)) emit(line);
}

/** Build the 7 exact-width cells for a not-yet-resolved row (spinner + name). */
function pendingCells(repo: string, icon: string, c: Palette, layout: Layout): string[] {
  const dim = (text: string, w: number): string => c.dim(fit(text, w));
  return [
    icon,
    c.bold(fit(repo, layout.repoW)),
    dim('', BRANCH_W),
    dim('·', SYNC_W),
    dim('', CHANGES_W),
    dim('', COMMIT_W),
    c.dim(fit('checking…', layout.subjectW)),
  ];
}

const SPINNER_FRAMES = SPINNER_UNICODE.length;
const spinAt = (frame: number): string => SPINNER_UNICODE[frame % SPINNER_FRAMES] ?? '';
const ALT_FRAME_MS = 90;

// ── ANSI control sequences used by the live views ───────────────────────────
const ALT_ENTER = '\x1b[?1049h'; // switch to the alternate screen buffer
const ALT_LEAVE = '\x1b[?1049l'; // restore the previous screen + scrollback
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J';
const CLEAR_LINE = '\r\x1b[2K'; // carriage-return + clear current line
const at = (row: number, col = 1): string => `\x1b[${row};${col}H`; // absolute move

/**
 * Alternate-screen TUI. Takes over the screen while running so the full table
 * can be drawn up front and animated in place at any size, then restores the
 * user's terminal (scrollback intact) and prints the final table on exit.
 *
 * When the workspace has more repos than fit on screen, the window scrolls to
 * follow the completion frontier — it keeps the lowest (furthest-down) updated
 * repo visible, so you watch progress march down a large list rather than
 * staring at a static first page.
 *
 * Requires a known terminal size (absolute cursor positioning); callers route
 * to {@link streamingView} when dimensions are unavailable.
 */
function altScreenView(
  repoNames: string[],
  c: Palette,
  g: Glyphs,
  initialCols: number,
  initialRows: number,
): StatusView {
  const stream = process.stdout;
  const n = repoNames.length;
  const states: { repo: string; row: StatusRow | null }[] = repoNames.map((repo) => ({
    repo,
    row: null,
  }));
  let done = 0;
  let frame = 0;
  // The deepest (highest-index) repo resolved so far. The viewport scrolls to
  // keep this row visible, so the window follows the completion frontier down
  // the table. Monotonic, so the view only ever scrolls downward.
  let maxResolved = -1;
  let scrollTop = 0;

  // Geometry (recomputed on resize). Layout: row 1 header, rows 2..1+visible
  // repos (a scrolling window over the full list), row 2+visible footer.
  let termCols = initialCols;
  let termRows = initialRows;
  let layout = computeLayout(repoNames, termCols);
  let visible = Math.min(n, Math.max(1, termRows - 2));

  // Scroll so the lowest updated repo sits at the bottom edge of the window,
  // clamped to the list bounds. When everything fits, never scroll.
  const desiredScroll = (): number => {
    if (n <= visible) return 0;
    return Math.max(0, Math.min(maxResolved - visible + 1, n - visible));
  };

  const rowLine = (i: number): string => {
    const st = states[i];
    if (!st) return '';
    const cells = st.row
      ? rowCells(st.row, c, g, layout)
      : pendingCells(st.repo, c.cyan(spinAt(frame)), c, layout);
    return joinCells(cells);
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
      label = `inspecting… · showing ${from}–${to} of ${n}`;
    } else {
      label = 'inspecting…';
    }
    const prefix = spinAt(frame).length + 1 + `${done}/${n}`.length + 1;
    return `${sp} ${counter} ${c.dim(truncate(label, Math.max(0, termCols - prefix - 1)))}`;
  };

  // Draw every row in the current window: screen row `2 + slot` shows repo
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
      `${CLEAR_SCREEN}${at(1)}\x1b[2K${headerLine(c, layout)}${drawWindow()}${at(2 + visible)}\x1b[2K${footerLine()}`,
    );
  };

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stream.write(`${ALT_LEAVE}${CURSOR_SHOW}`);
  };
  const onSignal = (): void => {
    restore();
    process.exit(130);
  };
  const onResize = (): void => {
    termCols = stream.columns || termCols;
    termRows = stream.rows || termRows;
    layout = computeLayout(repoNames, termCols);
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

  const timer = setInterval(() => {
    frame += 1;
    // Repaint only the spinner glyph (column 1) of still-pending visible rows,
    // plus the footer. No full-row or full-table repaint → minimal output.
    const spinner = c.cyan(spinAt(frame));
    let seq = '';
    for (let slot = 0; slot < visible; slot++) {
      const idx = scrollTop + slot;
      if (idx < n && states[idx]?.row == null) seq += at(2 + slot, 1) + spinner;
    }
    seq += `${at(2 + visible)}\x1b[2K${footerLine()}`;
    stream.write(seq);
  }, ALT_FRAME_MS);
  timer.unref?.();

  return {
    resolve(index, row) {
      const st = states[index];
      if (!st) return;
      st.row = row;
      done += 1;
      if (index > maxResolved) maxResolved = index;
      const newScroll = desiredScroll();
      if (newScroll !== scrollTop) {
        // The frontier moved into/under the window edge: scroll and repaint the
        // whole window (the row↔screen-line mapping shifted).
        scrollTop = newScroll;
        stream.write(`${drawWindow()}${at(2 + visible)}\x1b[2K${footerLine()}`);
        return;
      }
      // No scroll: rewrite just this row (if currently visible) + footer.
      let seq = '';
      const slot = index - scrollTop;
      if (slot >= 0 && slot < visible) seq += `${at(2 + slot)}\x1b[2K${rowLine(index)}`;
      seq += `${at(2 + visible)}\x1b[2K${footerLine()}`;
      stream.write(seq);
    },
    finish(rows) {
      clearInterval(timer);
      stream.off('resize', onResize);
      process.removeListener('exit', restore);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      restore(); // back to the normal screen, scrollback intact
      renderStatic(rows); // print the complete final table into scrollback
    },
  };
}

/**
 * Streaming fallback for terminals that don't report their size (absolute
 * positioning isn't safe there). Prints the header once, appends each row as
 * it resolves, and keeps one animated spinner line pinned at the bottom — only
 * that line is ever rewritten, so scrollback stays clean.
 */
function streamingView(repoNames: string[], c: Palette, g: Glyphs, termCols: number): StatusView {
  const stream = process.stdout;
  const n = repoNames.length;
  const layout = computeLayout(repoNames, termCols);
  const pending = new Set(repoNames);
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
      const names = [...pending].slice(0, 3).join(', ');
      const more = pending.size > 3 ? `, +${pending.size - 3} more` : '';
      label = `waiting on ${names}${more}`;
    }
    label = truncate(label, Math.max(0, termCols - prefixWidth - 1));
    return `${c.cyan(sp)} ${c.bold(counter)} ${c.dim(label)}`;
  };

  let cursorShown = false;
  const showCursor = (): void => {
    if (!cursorShown) {
      cursorShown = true;
      stream.write(CURSOR_SHOW);
    }
  };
  process.once('exit', showCursor);

  stream.write(`${CURSOR_HIDE}${headerLine(c, layout)}\n${CLEAR_LINE}${statusLine()}`);

  const timer = setInterval(() => {
    frame += 1;
    stream.write(`${CLEAR_LINE}${statusLine()}`);
  }, ALT_FRAME_MS);
  timer.unref?.();

  return {
    resolve(_index, row) {
      pending.delete(row.repo);
      done += 1;
      stream.write(
        `${CLEAR_LINE}${joinCells(rowCells(row, c, g, layout))}\n${CLEAR_LINE}${statusLine()}`,
      );
    },
    finish(rows) {
      clearInterval(timer);
      stream.write(CLEAR_LINE);
      showCursor();
      process.removeListener('exit', showCursor);
      for (const line of summaryLines(rows, c)) emit(line);
    },
  };
}

export function createStatusView(repoNames: string[], opts: { enabled: boolean }): StatusView {
  const n = repoNames.length;
  const isTty = process.stdout.isTTY === true;
  if (!opts.enabled || !isTty || n === 0) {
    return {
      resolve() {},
      finish(rows) {
        renderStatic(rows);
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
    return altScreenView(repoNames, c, g, termCols, termRows);
  }
  return streamingView(repoNames, c, g, termCols || 80);
}
