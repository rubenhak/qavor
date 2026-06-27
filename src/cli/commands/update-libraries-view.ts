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
 * Outcome of running a service's `runtime.native.update_libraries`:
 *   - `ran`  — the update command ran and succeeded.
 *   - `skip` — the service declares no update command; nothing to do.
 *   - `fail` — the update command errored (non-zero exit / spawn failure).
 */
export type UpdateLibrariesOutcome = 'ran' | 'skip' | 'fail';

export interface UpdateLibrariesRow {
  service: string;
  outcome: UpdateLibrariesOutcome;
  /** Short status word shown in the STATUS column, e.g. `'updated'`. */
  status: string;
  /** Optional detail or error message shown in the trailing column. */
  detail?: string;
}

export type UpdateLibrariesView = LiveView<UpdateLibrariesRow>;

const ICON_W = 1;
const STATUS_W = 11;

const COLUMNS: LiveColumn[] = [
  { header: '', width: ICON_W },
  { header: 'SERVICE', width: 'label' satisfies ColumnWidth },
  { header: 'STATUS', width: STATUS_W },
  { header: 'DETAIL', width: 'flex' satisfies ColumnWidth },
];

function outcomeIcon(outcome: UpdateLibrariesOutcome, c: Palette, g: Glyphs): string {
  switch (outcome) {
    case 'ran':
      return c.green(g.clean);
    case 'skip':
      return c.dim(g.noUpstream);
    case 'fail':
      return c.red(g.diverged);
  }
}

function statusCell(row: UpdateLibrariesRow, c: Palette): string {
  const text = fit(row.status, STATUS_W);
  switch (row.outcome) {
    case 'ran':
      return c.green(text);
    case 'skip':
      return c.dim(text);
    case 'fail':
      return c.red(text);
  }
}

function resolvedCells(
  row: UpdateLibrariesRow,
  c: Palette,
  g: Glyphs,
  serviceW: number,
  detailW: number,
): string[] {
  const detailText = (row.detail ?? '').split('\n')[0] ?? '';
  const detail =
    row.outcome === 'fail' ? c.red(fit(detailText, detailW)) : c.dim(fit(detailText, detailW));
  return [
    outcomeIcon(row.outcome, c, g),
    c.bold(fit(row.service, serviceW)),
    statusCell(row, c),
    detail,
  ];
}

function pendingCells(
  service: string,
  spinner: string,
  c: Palette,
  serviceW: number,
  detailW: number,
): string[] {
  return [
    c.cyan(spinner),
    c.bold(fit(service, serviceW)),
    c.dim(fit('…', STATUS_W)),
    c.dim(fit('updating…', detailW)),
  ];
}

const renderer: LiveRenderer<UpdateLibrariesRow> = {
  columns: COLUMNS,
  cells(label: string, row: UpdateLibrariesRow | null, ctx: RowContext): string[] {
    const serviceW = ctx.layout.widths[1] ?? 0;
    const detailW = ctx.layout.widths[3] ?? 0;
    if (row === null) return pendingCells(label, ctx.spinner, ctx.c, serviceW, detailW);
    return resolvedCells(row, ctx.c, ctx.g, serviceW, detailW);
  },
  summary(rows, c): string[] {
    const present = rows.filter((r): r is UpdateLibrariesRow => r !== null);
    const total = present.length;
    const count = (o: UpdateLibrariesOutcome): number =>
      present.filter((r) => r.outcome === o).length;
    const bits = [`${total} service${total === 1 ? '' : 's'}`];
    const ranN = count('ran');
    const skipN = count('skip');
    const failN = count('fail');
    if (ranN) bits.push(c.green(`${ranN} updated`));
    if (skipN) bits.push(c.dim(`${skipN} skipped`));
    if (failN) bits.push(c.red(`${failN} failed`));
    return ['', c.dim('Summary: ') + bits.join(c.dim('  ·  '))];
  },
};

export function createUpdateLibrariesView(
  serviceNames: string[],
  opts: { enabled: boolean },
): UpdateLibrariesView {
  return createLiveView(serviceNames, renderer, { enabled: opts.enabled, verb: 'updating' });
}
