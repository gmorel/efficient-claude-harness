/**
 * Resolve the per-run in-place snapshot path via git (worktree-safe).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Path to `coder-lane-last.json` for a repo or linked worktree root.
 * Uses `git rev-parse --git-path`; falls back to `<dir>/.git/...` if git fails.
 */
export function coderLaneSnapshotPath(dir, gitBin = 'git') {
  const fallback = path.join(dir, '.git', 'coder-lane-last.json');
  const r = spawnSync(gitBin, ['-C', dir, 'rev-parse', '--git-path', 'coder-lane-last.json'], { encoding: 'utf8' });
  const out = (r.status === 0 ? r.stdout : '').trim();
  if (!out) return fallback;
  return path.isAbsolute(out) ? out : path.resolve(dir, out);
}
