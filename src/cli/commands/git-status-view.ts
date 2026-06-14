import type { Glyphs, Palette } from '../../util/style.js';
import {
  type ColumnWidth,
  createLiveView,
  fit,
  type LiveColumn,
  type LiveRenderer,
  type LiveView,
  type RowContext,
} from '../live-view.js';

export interface StatusRow {
  repo: string;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  last_commit: string | null;
  last_commit_subject: string | null;
  /** GitHub visibility via `gh`, or null when unavailable/not GitHub. */
  visibility: string | null;
  /** True when the repo is enumerated in the manifest but not yet cloned. */
  missing: boolean;
}

/** The status view is just a {@link LiveView} specialized to {@link StatusRow}. */
export type StatusView = LiveView<StatusRow>;

// Fixed column widths. Each is at least as wide as its header label; REPO sizes
// to the repo names (`'label'`) and SUBJECT takes whatever width is left
// (`'flex'`). Declared once here and reused when building each row's cells.
const ICON_W = 1;
const BRANCH_W = 16;
const SYNC_W = 8;
const CHANGES_W = 7;
const COMMIT_W = 7;
const VIS_W = 10;

// Columns are assembled per-view because the VISIBILITY column is opt-in (see
// `createStatusView`). The SUBJECT (`'flex'`) column is always last, so its
// layout index shifts by one when visibility is shown — callers read it back via
// `subjectIndex`.
function buildColumns(showVisibility: boolean): LiveColumn[] {
  const cols: LiveColumn[] = [
    { header: '', width: ICON_W },
    { header: 'REPO', width: 'label' satisfies ColumnWidth },
    { header: 'BRANCH', width: BRANCH_W },
    { header: 'SYNC', width: SYNC_W },
    { header: 'CHANGES', width: CHANGES_W },
    { header: 'COMMIT', width: COMMIT_W },
  ];
  if (showVisibility) cols.push({ header: 'VISIBILITY', width: VIS_W });
  cols.push({ header: 'SUBJECT', width: 'flex' satisfies ColumnWidth });
  return cols;
}

/** Colorize a repo's visibility into an exact-width cell. */
function visibilityCell(v: string | null, c: Palette): string {
  if (!v) return c.dim(fit('—', VIS_W));
  if (v === 'public') return c.green(fit(v, VIS_W));
  if (v === 'private') return c.yellow(fit(v, VIS_W));
  if (v === 'internal') return c.blue(fit(v, VIS_W));
  return c.dim(fit(v, VIS_W));
}

/** Build the exact-width, colorized cells for one resolved repo row. */
function resolvedCells(
  r: StatusRow,
  c: Palette,
  g: Glyphs,
  repoW: number,
  subjectW: number,
  showVisibility: boolean,
): string[] {
  const repo = c.bold(fit(r.repo, repoW));

  // A repo enumerated in the manifest but not cloned: render a dim placeholder
  // row so the gap is visible without implying a (nonexistent) working tree.
  if (r.missing) {
    return [
      c.red(g.missing),
      repo,
      c.dim(fit('—', BRANCH_W)),
      c.dim(fit('·', SYNC_W)),
      c.dim(fit('—', CHANGES_W)),
      c.dim(fit('—', COMMIT_W)),
      ...(showVisibility ? [c.dim(fit('—', VIS_W))] : []),
      c.dim(fit('not cloned', subjectW)),
    ];
  }

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
  return [
    icon,
    repo,
    branch,
    sync,
    changes,
    commit,
    ...(showVisibility ? [visibilityCell(r.visibility, c)] : []),
    subject,
  ];
}

/** Build the exact-width cells for a not-yet-resolved row (spinner + name). */
function pendingCells(
  repo: string,
  spinner: string,
  c: Palette,
  repoW: number,
  subjectW: number,
  showVisibility: boolean,
): string[] {
  const dim = (text: string, w: number): string => c.dim(fit(text, w));
  return [
    c.cyan(spinner),
    c.bold(fit(repo, repoW)),
    dim('', BRANCH_W),
    dim('·', SYNC_W),
    dim('', CHANGES_W),
    dim('', COMMIT_W),
    ...(showVisibility ? [dim('', VIS_W)] : []),
    c.dim(fit('checking…', subjectW)),
  ];
}

/** Build the renderer for a status view, with VISIBILITY column opt-in. */
function buildRenderer(showVisibility: boolean): LiveRenderer<StatusRow> {
  const columns = buildColumns(showVisibility);
  // SUBJECT is always the last column; its layout index is the flex column.
  const subjectIndex = columns.length - 1;
  return {
    columns,
    cells(label: string, row: StatusRow | null, ctx: RowContext): string[] {
      const repoW = ctx.layout.widths[1] ?? 0;
      const subjectW = ctx.layout.widths[subjectIndex] ?? 0;
      if (row === null) {
        return pendingCells(label, ctx.spinner, ctx.c, repoW, subjectW, showVisibility);
      }
      return resolvedCells(row, ctx.c, ctx.g, repoW, subjectW, showVisibility);
    },
    summary(rows, c): string[] {
      const present = rows.filter((r): r is StatusRow => r !== null);
      const total = present.length;
      const count = (pred: (r: StatusRow) => boolean): number => present.filter(pred).length;
      const bits = [`${total} repo${total === 1 ? '' : 's'}`];
      const dirtyN = count((r) => !r.missing && r.dirty > 0);
      const aheadN = count((r) => !r.missing && r.ahead > 0);
      const behindN = count((r) => !r.missing && r.behind > 0);
      const detachedN = count((r) => !r.missing && r.branch === null);
      const missingN = count((r) => r.missing);
      if (dirtyN) bits.push(c.yellow(`${dirtyN} dirty`));
      if (aheadN) bits.push(c.green(`${aheadN} ahead`));
      if (behindN) bits.push(c.red(`${behindN} behind`));
      if (detachedN) bits.push(c.magenta(`${detachedN} detached`));
      if (missingN) bits.push(c.red(`${missingN} missing`));
      return ['', c.dim('Summary: ') + bits.join(c.dim('  ·  '))];
    },
  };
}

export function createStatusView(
  repoNames: string[],
  opts: { enabled: boolean; showVisibility?: boolean },
): StatusView {
  const renderer = buildRenderer(opts.showVisibility ?? false);
  return createLiveView(repoNames, renderer, { enabled: opts.enabled, verb: 'inspecting' });
}
