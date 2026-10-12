// Finds local clones of a GitHub repo by reading .git/config remotes in the
// configured workspace folders (and a few usual suspects). No git calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const remoteRe = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/i;

export function workspaceRoots(config) {
  const home = os.homedir();
  const guesses = [process.cwd(), path.dirname(process.cwd()), ...['projects', 'code', 'src', 'dev', 'repos', 'Documents/GitHub'].map((d) => path.join(home, d))];
  const roots = [...(config.workspaceRoots ?? []), ...guesses].map((r) => path.resolve(r));
  return [...new Set(roots)].filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

function remotesOf(dir) {
  let gitDir = path.join(dir, '.git');
  try {
    const st = fs.statSync(gitDir);
    // Worktrees and submodules: .git is a file pointing at the real git dir.
    if (st.isFile()) gitDir = path.resolve(dir, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    return [...cfg.matchAll(/^\s*url\s*=\s*(.+)$/gm)]
      .map((m) => m[1].trim().match(remoteRe))
      .filter(Boolean)
      .map((m) => `${m[1]}/${m[2]}`.toLowerCase());
  } catch {
    return [];
  }
}

// owner/repo (lowercase) → [paths]
export function scanClones(roots, depth = 2) {
  const found = {};
  const visit = (dir, level) => {
    for (const r of remotesOf(dir)) (found[r] ??= []).push(dir);
    if (level >= depth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), level + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return found;
}

export function findClone(config, repo) {
  const remembered = config.clones?.[repo] ?? config.clones?.[repo.toLowerCase()];
  if (remembered && remotesOf(remembered).includes(repo.toLowerCase())) return remembered;
  return scanClones(workspaceRoots(config))[repo.toLowerCase()]?.[0] ?? null;
}

// Where `gh repo clone` should put a new clone.
export function defaultCloneTarget(config, repo) {
  const root = config.workspaceRoots?.[0] ?? path.dirname(process.cwd());
  return path.join(root, repo.split('/')[1]);
}

export const isClone = (dir, repo) => remotesOf(dir).includes(repo.toLowerCase());
