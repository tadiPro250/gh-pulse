// Regenerates docs/demo.gif: bundles record.jsx with src/gh.js swapped for
// fake-gh.js (so the demo never calls the real GitHub CLI), records the
// frames, then renders them with render.py. Run it with `npm run demo`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(here, '.out');
const frames = path.join(outDir, 'frames.json');
const gif = path.join(root, 'docs', 'demo.gif');

await build({
  entryPoints: [path.join(here, 'record.jsx')],
  outfile: path.join(outDir, 'record.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
  logLevel: 'warning',
  // Runs before src/state.js reads GH_PULSE_HOME: a throwaway home for config and state.
  banner: { js: "import { mkdtempSync as __mkdtemp } from 'node:fs'; import { tmpdir as __tmpdir } from 'node:os'; import { join as __join } from 'node:path'; process.env.GH_PULSE_HOME = __mkdtemp(__join(__tmpdir(), 'pulse-demo-'));" },
  plugins: [
    {
      name: 'fake-gh',
      setup(b) {
        b.onResolve({ filter: /(^|\/)gh\.js$/ }, () => ({ path: path.join(here, 'fake-gh.js') }));
      },
    },
  ],
});

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
  if (r.error || r.status !== 0) process.exit(r.status || 1);
};

// Colors are decided when ink loads, so force them in the child's environment.
run(process.execPath, [path.join(outDir, 'record.js'), frames], { FORCE_COLOR: '3' });
run(process.platform === 'win32' ? 'python' : 'python3', [path.join(here, 'render.py'), frames, gif, ...process.argv.slice(2)]);
