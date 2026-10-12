import fs from 'node:fs';
import path from 'node:path';

// Resolve a command on PATH without spawning anything (fast enough to run on
// every settings render). Returns the absolute path or null.
const cache = new Map();

export function which(cmd) {
  if (!cmd) return null;
  if (cache.has(cmd)) return cache.get(cmd);
  let found = null;
  if (path.isAbsolute(cmd)) {
    found = fs.existsSync(cmd) ? cmd : null;
  } else {
    const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';')] : [''];
    outer: for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = path.join(dir, cmd + ext);
        try {
          if (fs.statSync(candidate).isFile()) {
            // On Windows an extensionless file next to a .cmd is usually a sh script; prefer the real one.
            if (process.platform === 'win32' && !ext) continue;
            found = candidate;
            break outer;
          }
        } catch {}
      }
    }
  }
  cache.set(cmd, found);
  return found;
}

export function clearWhichCache() {
  cache.clear();
}

// Windows can only run .cmd/.bat through a shell.
export const needsShell = (file) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(file ?? '');

// Quote for cmd.exe when we have to go through a shell.
export function shellQuote(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
