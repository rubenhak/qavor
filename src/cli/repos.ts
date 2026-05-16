import { isDirectory } from '../util/fs.js';
import type { ResolvedRepo } from '../workspace/repos.js';

/**
 * Filter resolved repos by the `--repo` CLI selector. Empty selector means
 * "all repos". Throws when a name is given that isn't in the project.
 */
export function selectRepos(all: ResolvedRepo[], selector?: string[]): ResolvedRepo[] {
  if (!selector || selector.length === 0) return all;
  const set = new Set(selector);
  const out: ResolvedRepo[] = [];
  for (const r of all) {
    if (set.has(r.name)) {
      out.push(r);
      set.delete(r.name);
    }
  }
  if (set.size > 0) {
    throw new Error(`Unknown repo${set.size > 1 ? 's' : ''}: ${[...set].join(', ')}`);
  }
  return out;
}

export async function reposPresent(repos: ResolvedRepo[]): Promise<ResolvedRepo[]> {
  const out: ResolvedRepo[] = [];
  for (const r of repos) {
    if (await isDirectory(r.dir)) out.push(r);
  }
  return out;
}
