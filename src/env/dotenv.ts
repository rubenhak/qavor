import fs from 'node:fs/promises';
import { pathExists } from '../util/fs.js';

/**
 * Parse a .env file with one KEY=VALUE per line. Returns ordered entries so
 * callers can build provenance line-by-line. Minimal subset of the dotenv
 * format: comments via `#`, optional `export ` prefix, double or single
 * quoted values, and continuation via line-by-line append (no multi-line).
 *
 * We intentionally do not interpolate here — qavor's env composer owns
 * interpolation across the full chain.
 */
export interface DotenvEntry {
  key: string;
  value: string;
  file: string;
  line: number;
}

export async function loadDotenvFile(file: string): Promise<DotenvEntry[]> {
  if (!(await pathExists(file))) return [];
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out: DotenvEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1);
    // strip optional inline comment when value is unquoted
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    } else {
      const quote = value[0] as '"' | "'";
      const closing = value.lastIndexOf(quote);
      if (closing > 0) value = value.slice(1, closing);
    }
    out.push({ key, value, file, line: i + 1 });
  }
  return out;
}
