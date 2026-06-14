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

/**
 * Outcome of a per-repo mutating action (clone/sync/commit/push):
 *   - `ok`      — succeeded, nothing changed (e.g. already present, up to date).
 *   - `changed` — succeeded and changed the repo (cloned, pulled, committed, pushed).
 *   - `skip`    — intentionally not run (e.g. optional repo, nothing to commit).
 *   - `fail`    — the action errored.
 */
export type ActionOutcome = 'ok' | 'changed' | 'skip' | 'fail';

export interface ActionRow {
  repo: string;
  outcome: ActionOutcome;
  /** Short status word shown in the STATUS column, e.g. `'cloned'`, `'pushed'`. */
  status: string;
  /** Optional detail or error message shown in the trailing column. */
  detail?: string;
}

export type ActionView = LiveView<ActionRow>;

const ICON_W = 1;
const STATUS_W = 10;

const COLUMNS: LiveColumn[] = [
  { header: '', width: ICON_W },
  { header: 'REPO', width: 'label' satisfies ColumnWidth },
  { header: 'STATUS', width: STATUS_W },
  { header: 'DETAIL', width: 'flex' satisfies ColumnWidth },
];

function outcomeIcon(outcome: ActionOutcome, c: Palette, g: Glyphs): string {
  switch (outcome) {
    case 'changed':
      return c.green(g.clean);
    case 'ok':
      return c.dim(g.clean);
    case 'skip':
      return c.dim(g.noUpstream);
    case 'fail':
      return c.red(g.diverged);
  }
}

function statusCell(row: ActionRow, c: Palette): string {
  const text = fit(row.status, STATUS_W);
  switch (row.outcome) {
    case 'changed':
      return c.green(text);
    case 'ok':
      return c.dim(text);
    case 'skip':
      return c.yellow(text);
    case 'fail':
      return c.red(text);
  }
}

function resolvedCells(
  row: ActionRow,
  c: Palette,
  g: Glyphs,
  repoW: number,
  detailW: number,
): string[] {
  const detailText = (row.detail ?? '').split('\n')[0] ?? '';
  const detail =
    row.outcome === 'fail' ? c.red(fit(detailText, detailW)) : c.dim(fit(detailText, detailW));
  return [outcomeIcon(row.outcome, c, g), c.bold(fit(row.repo, repoW)), statusCell(row, c), detail];
}

function pendingCells(
  repo: string,
  spinner: string,
  c: Palette,
  repoW: number,
  detailW: number,
): string[] {
  return [
    c.cyan(spinner),
    c.bold(fit(repo, repoW)),
    c.dim(fit('…', STATUS_W)),
    c.dim(fit('working…', detailW)),
  ];
}

const renderer: LiveRenderer<ActionRow> = {
  columns: COLUMNS,
  cells(label: string, row: ActionRow | null, ctx: RowContext): string[] {
    const repoW = ctx.layout.widths[1] ?? 0;
    const detailW = ctx.layout.widths[3] ?? 0;
    if (row === null) return pendingCells(label, ctx.spinner, ctx.c, repoW, detailW);
    return resolvedCells(row, ctx.c, ctx.g, repoW, detailW);
  },
  summary(rows, c): string[] {
    const present = rows.filter((r): r is ActionRow => r !== null);
    const total = present.length;
    const count = (o: ActionOutcome): number => present.filter((r) => r.outcome === o).length;
    const bits = [`${total} repo${total === 1 ? '' : 's'}`];
    const changedN = count('changed');
    const okN = count('ok');
    const skipN = count('skip');
    const failN = count('fail');
    if (changedN) bits.push(c.green(`${changedN} changed`));
    if (okN) bits.push(c.dim(`${okN} unchanged`));
    if (skipN) bits.push(c.yellow(`${skipN} skipped`));
    if (failN) bits.push(c.red(`${failN} failed`));
    return ['', c.dim('Summary: ') + bits.join(c.dim('  ·  '))];
  },
};

export function createActionView(
  repoNames: string[],
  opts: { enabled: boolean; verb: string },
): ActionView {
  return createLiveView(repoNames, renderer, { enabled: opts.enabled, verb: opts.verb });
}
