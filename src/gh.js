import { spawn } from 'node:child_process';

// Run `gh` and capture stdout. `input` is written to stdin when given.
export function gh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      reject(err.code === 'ENOENT' ? new Error('gh not found on PATH — install it from https://cli.github.com') : err);
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      const err = new Error(stderr.trim() || `gh ${args[0]} exited with ${code}`);
      err.stdout = stdout;
      reject(err);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// Run `gh` attached to the terminal (pagers, prompts, colors).
export function ghInteractive(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function graphql(query, variables) {
  let out;
  try {
    out = await gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }));
  } catch (err) {
    // Partial failures (e.g. an SSO-protected org) still return usable data.
    const body = tryParse(err.stdout);
    if (body?.data) return { data: body.data, warnings: body.errors?.map((e) => e.message) ?? [] };
    throw err;
  }
  const body = JSON.parse(out);
  return { data: body.data, warnings: body.errors?.map((e) => e.message) ?? [] };
}

export async function currentRepo() {
  try {
    return (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim();
  } catch {
    throw new Error('--here: not inside a GitHub repository');
  }
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
