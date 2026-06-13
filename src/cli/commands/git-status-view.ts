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

// Carriage-return + clear-to-end-of-line: resets the current (transient)
// status line in place without touching anything above it.
const CLEAR_LINE = '\r\x1b[2K';

export function createStatusView(repoNames: string[], opts: { enabled: boolean }): StatusView {
  const n = repoNames.length;
  const interactive = opts.enabled && process.stdout.isTTY === true && n > 0;

  if (!interactive) {
    return {
      resolve() {},
      finish(rows) {
        renderStatic(rows);
      },
    };
  }

  // Streaming progress: print the header once, append each repo's row the
  // instant it resolves, and keep one animated spinner line pinned at the
  // bottom. Only that single line is ever rewritten (via CLEAR_LINE), so this
  // is scroll-safe for any repo count and any terminal height — completed rows
  // become ordinary scrollback, exactly like `git clone` / `docker pull`.
  const c = palette(true);
  const g = glyphs(true);
  const stream = process.stdout;
  const termCols = process.stdout.columns || 80;
  const layout = computeLayout(repoNames, termCols);

  const pending = new Set(repoNames);
  let done = 0;
  let frame = 0;

  const statusLine = (): string => {
    const sp = SPINNER_UNICODE[frame % SPINNER_UNICODE.length] ?? '';
    const counter = `${done}/${n}`;
    const prefixWidth = sp.length + 1 + counter.length + 1; // "⠹ 3/7 "
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
      stream.write('\x1b[?25h');
    }
  };
  process.once('exit', showCursor);

  // Header (permanent scrollback) + initial status line.
  stream.write(`\x1b[?25l${headerLine(c, layout)}\n${CLEAR_LINE}${statusLine()}`);

  const timer = setInterval(() => {
    frame += 1;
    stream.write(`${CLEAR_LINE}${statusLine()}`);
  }, 90);
  timer.unref?.();

  return {
    resolve(_index, row) {
      pending.delete(row.repo);
      done += 1;
      const rowLine = joinCells(rowCells(row, c, g, layout));
      // Clear the status line, emit the completed row above it, redraw status.
      stream.write(`${CLEAR_LINE}${rowLine}\n${CLEAR_LINE}${statusLine()}`);
    },
    finish(rows) {
      clearInterval(timer);
      stream.write(CLEAR_LINE); // erase the transient status line
      showCursor();
      process.removeListener('exit', showCursor);
      for (const line of summaryLines(rows, c)) emit(line);
    },
  };
}
