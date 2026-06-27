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
 * Outcome of running a dynamic command for one service:
 *   - `ran`  — the command ran and succeeded.
 *   - `skip` — the service does not declare this command; nothing to do.
 *   - `fail` — the command errored (non-zero exit / spawn failure).
 */
export type CommandOutcome = 'ran' | 'skip' | 'fail';

export interface CommandRow {
  service: string;
  outcome: CommandOutcome;
  /** Short status word shown in the STATUS column, e.g. `'ok'`. */
  status: string;
  /** Optional detail or error message shown in the trailing column. */
  detail?: string;
}

export type CommandView = LiveView<CommandRow>;

const ICON_W = 1;
const STATUS_W = 11;

const COLUMNS: LiveColumn[] = [
  { header: '', width: ICON_W },
  { header: 'SERVICE', width: 'label' satisfies ColumnWidth },
  { header: 'STATUS', width: STATUS_W },
  { header: 'DETAIL', width: 'flex' satisfies ColumnWidth },
];

function outcomeIcon(outcome: CommandOutcome, c: Palette, g: Glyphs): string {
  switch (outcome) {
    case 'ran':
      return c.green(g.clean);
    case 'skip':
      return c.dim(g.noUpstream);
    case 'fail':
      return c.red(g.diverged);
  }
}

function statusCell(row: CommandRow, c: Palette): string {
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
  row: CommandRow,
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
    c.dim(fit('running…', detailW)),
  ];
}

const renderer: LiveRenderer<CommandRow> = {
  columns: COLUMNS,
  cells(label: string, row: CommandRow | null, ctx: RowContext): string[] {
    const serviceW = ctx.layout.widths[1] ?? 0;
    const detailW = ctx.layout.widths[3] ?? 0;
    if (row === null) return pendingCells(label, ctx.spinner, ctx.c, serviceW, detailW);
    return resolvedCells(row, ctx.c, ctx.g, serviceW, detailW);
  },
  summary(rows, c): string[] {
    const present = rows.filter((r): r is CommandRow => r !== null);
    const total = present.length;
    const count = (o: CommandOutcome): number => present.filter((r) => r.outcome === o).length;
    const bits = [`${total} service${total === 1 ? '' : 's'}`];
    const ranN = count('ran');
    const skipN = count('skip');
    const failN = count('fail');
    if (ranN) bits.push(c.green(`${ranN} ran`));
    if (skipN) bits.push(c.dim(`${skipN} skipped`));
    if (failN) bits.push(c.red(`${failN} failed`));
    return ['', c.dim('Summary: ') + bits.join(c.dim('  ·  '))];
  },
};

/**
 * Live table for a dynamic command run: one row per service. `command` is the
 * footer verb shown while work is in flight (e.g. `prepare… `).
 */
export function createCommandView(
  command: string,
  serviceNames: string[],
  opts: { enabled: boolean },
): CommandView {
  return createLiveView(serviceNames, renderer, { enabled: opts.enabled, verb: command });
}
