// Regenerates docs/demo.gif: bundles record.jsx with src/gh.js and
// src/clones.js swapped for fakes (so the demo never calls the real GitHub CLI
// or looks at local folders), records the frames, then renders them with
// render.py. Run it with `npm run demo`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(here, '.out');
const frames = path.join(outDir, 'frames.json');
const gif = path.join(root, 'docs', 'demo.gif');
const FAKES = { 'gh.js': 'fake-gh.js', 'clones.js': 'fake-clones.js' };

await build({
  entryPoints: [path.join(here, 'record.jsx')],
  outfile: path.join(outDir, 'record.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
  logLevel: 'warning',
  plugins: [
    {
      name: 'demo-fakes',
      setup(b) {
        b.onResolve({ filter: /(^|\/)(gh|clones)\.js$/ }, (args) => ({ path: path.join(here, FAKES[path.basename(args.path)]) }));
      },
    },
  ],
});

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${path.basename(cmd)} exited with ${r.status}`);
};

// A throwaway home for config and state, so nobody's real ~/.gh-pulse is read
// or written. Colors are decided when ink loads, so force them here too.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-demo-'));
try {
  run(process.execPath, [path.join(outDir, 'record.js'), frames], { FORCE_COLOR: '3', GH_PULSE_HOME: home });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
run(process.platform === 'win32' ? 'python' : 'python3', [path.join(here, 'render.py'), frames, gif, ...process.argv.slice(2)]);
