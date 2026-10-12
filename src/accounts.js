import { gh } from './gh.js';

// Every account `gh` knows about, across hosts.
export async function listAccounts() {
  let out;
  try {
    out = await gh(['auth', 'status', '--json', 'hosts']);
  } catch (err) {
    // gh exits non-zero when any account has a broken token, but still prints the JSON.
    if (!err.stdout) throw err;
    out = err.stdout;
  }
  const { hosts } = JSON.parse(out);
  return Object.entries(hosts).flatMap(([host, accounts]) =>
    accounts.map((a) => ({
      host,
      login: a.login,
      active: a.active,
      ok: a.state === 'success',
      scopes: a.scopes ?? '',
      tokenSource: a.tokenSource,
    })),
  );
}

export async function switchAccount({ host, login }) {
  await gh(['auth', 'switch', '--hostname', host, '--user', login]);
}

// GH_TOKEN / GITHUB_TOKEN override whatever `gh auth switch` selects.
export const envTokenOverride = () => (process.env.GH_TOKEN ? 'GH_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null);
