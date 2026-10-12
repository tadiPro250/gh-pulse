import { currentRepo, ghInteractive } from './gh.js';
import { fetchDashboard, fetchNotifications, markThreadsRead } from './github.js';
import { paint, renderFooter, renderHeader, renderSection } from './render.js';
import { configPath, loadConfig, loadState, mergeSeen, needsSetup, saveState } from './state.js';
import { applyTheme } from './theme.js';
import { openUrl } from './system.js';
import { SECTION_KEYS, buildView, notificationRows } from './view.js';

const HELP = () => `
${paint(['bold', 'accent'], 'pulse')} — everything on GitHub that's waiting on you

${paint('bold', 'Usage')}
  pulse                     interactive dashboard (press ? inside for keys)
  pulse setup               walk through setup again (GitHub, AI, theme, dashboard)
  pulse --print             print the dashboard once and exit
  pulse reviews             print only PRs waiting on your review (incl. re-reviews)
  pulse prs                 print only your open PRs
  pulse issues              print only issues assigned to you
  pulse mentions            print only recent mentions
  pulse notifs [--clear]    print unread notifications (--clear marks them read)

  pulse open <n>            open item <n> from the last printed list in the browser
  pulse view <n>            show item <n> in the terminal
  pulse diff <n>            show the diff of PR <n>
  pulse co <n>              check out PR <n> (run inside that repo)
  pulse config              print the config file path

${paint('bold', 'Options')}
  -R, --repo <owner/name>   limit to a repo (repeatable)
  -o, --org <name>          limit to an org or user (repeatable)
      --here                limit to the repo in the current directory
  -w, --watch [seconds]     reprint continuously (with --print or a section)
  -n, --limit <n>           max items per section (default 30)
      --days <n>            mentions lookback window (default 7)
  -a, --all                 also show reviewed PRs with no new activity
      --json                print raw data as JSON
`;

const SECTIONS = {
  reviews: ['review', 'reviewed'],
  review: ['review', 'reviewed'],
  prs: ['mine'],
  mine: ['mine'],
  issues: ['assigned'],
  mentions: ['mentions'],
};

function parseArgs(argv) {
  const opts = { repos: [], orgs: [], here: false, watch: 0, json: false, all: false, clear: false, print: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const number = () => {
      const v = Number(value());
      if (!Number.isInteger(v) || v <= 0) throw new Error(`${a} needs a positive number`);
      return v;
    };
    switch (a) {
      case '-R': case '--repo': opts.repos.push(value()); break;
      case '-o': case '--org': opts.orgs.push(value()); break;
      case '--here': opts.here = true; break;
      case '-w': case '--watch':
        opts.watch = /^\d+$/.test(argv[i + 1] ?? '') ? Math.max(15, Number(argv[++i])) : 60;
        break;
      case '-n': case '--limit': opts.limit = Math.min(100, number()); break;
      case '--days': opts.days = number(); break;
      case '-a': case '--all': opts.all = true; break;
      case '--json': opts.json = true; break;
      case '--clear': opts.clear = true; break;
      case '-p': case '--print': opts.print = true; break;
      case '-h': case '--help': pos.unshift('help'); break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a} (see pulse --help)`);
        pos.push(a);
    }
  }
  return { cmd: pos[0] ?? 'dash', args: pos.slice(1), opts };
}

export async function main(argv) {
  const { cmd, args, opts } = parseArgs(argv);
  switch (cmd) {
    case 'help':
      applyTheme(loadConfig().theme);
      return console.log(HELP());
    case 'config': return console.log(configPath());
    case 'open': case 'view': case 'diff': case 'co': case 'checkout':
      return act(cmd, args[0]);
    case 'notifs': case 'notifications': case 'inbox':
      return notifs(opts);
    case 'dash': {
      const interactive = process.stdout.isTTY && process.stdin.isTTY && !opts.print && !opts.json && !opts.watch;
      return interactive ? tui(opts, needsSetup()) : dashboard(opts, null);
    }
    case 'setup':
      if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error('setup needs an interactive terminal');
      return tui(opts, true);
    default:
      if (SECTIONS[cmd]) return dashboard(opts, SECTIONS[cmd]);
      if (/^\d+$/.test(cmd)) return act('open', cmd);
      throw new Error(`unknown command "${cmd}" (see pulse --help)`);
  }
}

async function resolveScope(opts) {
  const cfg = loadConfig();
  applyTheme(cfg.theme);
  const flagged = opts.repos.length || opts.orgs.length || opts.here;
  const repos = flagged ? [...opts.repos] : [...cfg.repos];
  const orgs = flagged ? [...opts.orgs] : [...cfg.orgs];
  if (opts.here) repos.push(await currentRepo());
  return {
    config: cfg,
    scope: { repos, orgs, excludeRepos: cfg.excludeRepos },
    settings: {
      limit: opts.limit ?? cfg.limit,
      mentionDays: opts.days ?? cfg.mentionDays,
      staleReviewDays: cfg.staleReviewDays,
    },
  };
}

function scopeLabel({ repos, orgs }) {
  return [...repos, ...orgs.map((o) => `${o}/*`)].join(', ');
}

async function tui(opts, setup = false) {
  const { scope, config } = await resolveScope(opts);
  const flagged = opts.repos.length || opts.orgs.length || opts.here;
  const { runTui } = await import('./tui/index.jsx');
  await runTui({ config, setup, flagScope: flagged ? scope : null, flagSettings: { limit: opts.limit, mentionDays: opts.days } });
}

// ── printed dashboard ──────────────────────────────────────────────────────

async function dashboard(opts, only) {
  const { scope, settings } = await resolveScope(opts);
  const singleRepo = scope.repos.length === 1 && !scope.orgs.length;
  let baseline; // in watch mode, keep "new" markers relative to when watching started

  const once = async () => {
    const [data, notifications] = await Promise.all([
      fetchDashboard(scope, settings),
      only ? null : fetchNotifications(scope).catch(() => null),
    ]);

    if (opts.json) {
      console.log(JSON.stringify({ ...data, notifications }, null, 2));
      return;
    }

    const state = loadState();
    const account = state.accounts[data.login];
    if (baseline === undefined) baseline = account?.seen ?? null;

    // Printed mode hides the follow-up section when there's nothing to follow up on.
    const sections = buildView(data, { all: opts.all, singleRepo, seen: baseline, settings }).filter(
      (s) => (!only || only.includes(s.key)) && (s.key !== 'reviewed' || s.rows.length || only),
    );
    let n = 0;
    for (const s of sections) for (const r of s.rows) r.n = ++n;
    const items = sections.flatMap((s) => s.rows);

    const output = [
      renderHeader({ login: data.login, scope: scopeLabel(scope), notifications }),
      ...sections.map(renderSection),
      ...data.warnings.map((w) => paint('yellow', ` ⚠ ${w}`)),
      renderFooter(items.some((i) => i.flag)),
    ].join('\n');

    if (opts.watch) process.stdout.write('\x1b[2J\x1b[H');
    console.log(output);

    state.items = items.map(({ kind, repo, number, url }) => ({ kind, repo, number, url }));
    state.accounts[data.login] = { seen: mergeSeen(account?.seen, SECTION_KEYS.flatMap((k) => data[k])), lastRun: new Date().toISOString() };
    saveState(state);
  };

  await once();
  if (!opts.watch || opts.json) return;
  for (;;) {
    await new Promise((r) => setTimeout(r, opts.watch * 1000));
    await once().catch((err) => console.error(paint('red', ` ⚠ refresh failed: ${err.message}`)));
  }
}

// ── notifications ──────────────────────────────────────────────────────────

async function notifs(opts) {
  const { scope } = await resolveScope(opts);
  const list = await fetchNotifications(scope);
  if (opts.json) return console.log(JSON.stringify(list, null, 2));

  const rows = notificationRows(list).map((r, i) => ({ ...r, n: i + 1 }));
  console.log(renderSection({ title: 'Unread notifications', rows, empty: 'inbox zero' }));
  const state = loadState();
  state.items = rows.map(({ kind, repo, number, url }) => ({ kind, repo, number, url }));
  saveState(state);

  if (opts.clear && list.length) {
    await markThreadsRead(list.map((n) => n.id));
    console.log(paint('green', ` ✓ marked ${list.length} notification${list.length > 1 ? 's' : ''} as read`));
  } else if (list.length) {
    console.log(paint('dim', ' pulse notifs --clear  marks these as read'));
  }
}

// ── actions on numbered items ─────────────────────────────────────────────

async function act(cmd, ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1) throw new Error(`usage: pulse ${cmd} <n>   (n = the number shown in the printed list)`);
  const item = loadState().items[n - 1];
  if (!item) throw new Error(`no item #${n} — run pulse --print first`);

  const sub = item.kind === 'issue' ? 'issue' : 'pr';
  const target = item.number ? [String(item.number), '-R', item.repo] : null;

  if (cmd === 'open') {
    if (target) return void (await ghInteractive([sub, 'view', ...target, '--web']));
    return openUrl(item.url);
  }
  if (!target) throw new Error(`item #${n} isn't a PR or issue — try pulse open ${n}`);
  if (cmd === 'view') return void (await ghInteractive([sub, 'view', ...target, '--comments']));
  if (item.kind !== 'pr') throw new Error(`item #${n} is an issue, not a PR`);
  if (cmd === 'diff') return void (await ghInteractive(['pr', 'diff', ...target]));
  if (cmd === 'co' || cmd === 'checkout') {
    const here = await currentRepo().catch(() => null);
    if (here?.toLowerCase() !== item.repo.toLowerCase()) {
      throw new Error(`#${n} belongs to ${item.repo}; cd into a clone of it first${here ? ` (you're in ${here})` : ''}`);
    }
    return void (await ghInteractive(['pr', 'checkout', String(item.number)]));
  }
}
