// The welcome walkthrough, shown on first run (no config yet), by `pulse setup`,
// or from Settings → Run setup again. Every change is saved as you go, so the
// theme previews live and quitting halfway keeps what you picked.
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { envTokenOverride, listAccounts, switchAccount } from '../accounts.js';
import { CATALOG } from '../ai/catalog.js';
import { agentProviderId, canAgent, canChat, chatProviderId, resolve, status } from '../ai/index.js';
import { ghInteractive } from '../gh.js';
import { DEFAULT_THEME, THEMES, accent, parseHex, presetFor, themeName } from '../theme.js';
import { LIST_SECTIONS } from '../view.js';
import { clearWhichCache, which } from '../which.js';
import { HOME_STATS } from './home.jsx';
import { Clickable } from './mouse.jsx';
import { ProviderPanel, STATUS_TONE, Swatches, cycle, statusIcon } from './settings.jsx';
import { Keys, Rule, editText } from './ui.jsx';

const STEPS = [
  ['welcome', 'Welcome'],
  ['github', 'GitHub'],
  ['ai', 'AI'],
  ['look', 'Look'],
  ['dashboard', 'Dashboard'],
  ['workspace', 'Workspace'],
  ['done', 'Done'],
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const list = (v) => (v?.length ? v.join(', ') : '');
const parseList = (s, sep = /[,\s]+/) => s.split(sep).map((x) => x.trim()).filter(Boolean);

export function SetupScreen({ config, updateConfig, width, height, suspendTerminal, toast, onDone, onQuit }) {
  const [step, setStep] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(null); // { label, value, save }
  const [panel, setPanel] = useState(null); // provider id, while its setup panel is open
  const [accounts, setAccounts] = useState(null);
  const [accountsError, setAccountsError] = useState(null);
  const [scan, setScan] = useState(0); // bumped by R to re-detect gh and installed AIs

  const loadAccounts = () =>
    listAccounts().then(
      (a) => (setAccounts(a), setAccountsError(null)),
      (err) => (setAccounts([]), setAccountsError(err.message)),
    );
  useEffect(() => void loadAccounts(), [scan]);
  // Mark setup as in progress, so quitting halfway brings it back next time.
  useEffect(() => void updateConfig((c) => ((c.setupDone = false), c)), []);

  const set = (fn) => updateConfig((c) => (fn(c), c));
  const key = STEPS[step][0];
  const go = (d) => {
    setStep((s) => clamp(s + d, 0, STEPS.length - 1));
    setCursor(0);
    setEditing(null);
  };
  const finish = () => {
    updateConfig((c) => ((c.setupDone = true), c));
    onDone();
  };

  const ghPath = useMemo(() => which('gh'), [scan]);
  const active = accounts?.find((a) => a.active && a.ok);
  const providerName = (id) => (id ? resolve(config, id).name : null);

  const page = useMemo(() => {
    const R = [];
    const next = (label = 'Continue', hint) => R.push({ kind: 'action', id: 'next', label: `${label} →`, hint, next: true, enter: () => go(1) });
    const info = (label, tone) => R.push({ kind: 'info', label, tone });
    const sub = (label) => R.push({ kind: 'sub', label });

    if (key === 'welcome') {
      if (ghPath) info(`✓ GitHub CLI found · ${ghPath}`, 'green');
      else {
        info('✗ The GitHub CLI (gh) is not installed. pulse needs it to read GitHub.', 'red');
        info('  Install it from https://cli.github.com, then press R here.', 'yellow');
      }
      next('Get started');
      return {
        title: 'Welcome to pulse',
        intro: [
          "Everything on GitHub that's waiting on you (reviews, your PRs, issues, mentions, notifications) in one terminal dashboard.",
          'This takes about a minute: connect GitHub, pick an AI, choose how it looks. You can change any of it later in Settings.',
        ],
        rows: R,
      };
    }

    if (key === 'github') {
      if (!accounts) info('reading gh auth status…');
      if (accountsError) info(`✗ ${accountsError}`, 'red');
      for (const a of accounts ?? []) {
        R.push({
          kind: 'action',
          id: `acct:${a.host}/${a.login}`,
          label: `@${a.login}`,
          value: a.host,
          tone: a.active && a.ok ? 'green' : a.ok ? undefined : 'red',
          badge: a.active ? (a.ok ? '● signed in' : '✗ token invalid') : a.ok ? '' : '✗ token invalid',
          hint: a.active ? 'pulse will use this account' : '⏎ use this account',
          enter: async () => {
            if (a.active) return;
            try {
              await switchAccount(a);
              toast(`switched to @${a.login}`, 'good');
              await loadAccounts();
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        });
      }
      R.push({
        kind: 'action',
        id: 'login',
        label: accounts?.length ? '+ Add another account' : '+ Sign in to GitHub',
        hint: 'runs gh auth login in this terminal',
        enter: () => (ghPath ? suspendTerminal(() => ghInteractive(['auth', 'login'])).then(loadAccounts) : toast('install gh first: https://cli.github.com', 'bad')),
      });
      const override = envTokenOverride();
      if (override) info(`⚠ $${override} is set, so it decides the account, not gh`, 'yellow');
      next('Continue', active ? null : 'you can sign in later from Settings');
      return {
        title: 'Connect GitHub',
        intro: ['pulse reads GitHub through the gh CLI, as whichever account gh is signed in with. Pick one, or sign in.'],
        rows: R,
      };
    }

    if (key === 'ai') {
      const all = CATALOG.map((p) => ({ p: resolve(config, p.id), st: status(config, p.id) }));
      const ready = all.filter((x) => x.st.ready);
      const chatIds = ['', ...ready.filter((x) => canChat(x.p)).map((x) => x.p.id)];
      const agentIds = ['', ...ready.filter((x) => canAgent(x.p) || canChat(x.p)).map((x) => x.p.id)];
      const auto = (id) => (id ? `auto · ${providerName(id)}` : 'none linked yet');
      R.push({
        kind: 'select',
        id: 'ai:chat',
        label: 'Chat with',
        value: providerName(config.ai.chat) ?? auto(chatProviderId(config)),
        hint: 'answers questions about your PRs and your day',
        change: (d) => set((c) => (c.ai.chat = cycle(chatIds, c.ai.chat, d))),
      });
      R.push({
        kind: 'select',
        id: 'ai:agent',
        label: 'Hand code work to',
        value: providerName(config.ai.agent) ?? auto(agentProviderId(config)),
        hint: 'fixes PRs and works on issues in your local clone',
        change: (d) => set((c) => (c.ai.agent = cycle(agentIds, c.ai.agent, d))),
      });
      const row = ({ p, st }) =>
        R.push({
          kind: 'action',
          id: `prov:${p.id}`,
          label: p.name,
          value: `${statusIcon(st.label)} ${st.label}`,
          tone: STATUS_TONE[st.label],
          hint: `${p.vendor} · ⏎ ${st.ready ? 'details' : 'set up'}`,
          enter: () => setPanel(p.id),
        });
      if (ready.length) {
        sub('Ready to use');
        ready.forEach(row);
      }
      sub('Link an API key or a local model');
      all.filter((x) => !x.st.ready && x.p.kind === 'api').forEach(row);
      const missing = all.filter((x) => !x.st.ready && x.p.kind !== 'api' && !x.p.custom).map((x) => x.p.name);
      if (missing.length) {
        sub('Not installed');
        info(`${missing.join(', ')}`);
        info('install any of these, then press R to detect it');
      }
      next('Continue', ready.length ? null : 'AI is optional; pulse works without it');
      return {
        title: 'Bring your own AI',
        intro: [
          'pulse can chat about your PRs and hand work to a coding agent. Coding agents use their own login; APIs need a key.',
          ready.length ? `Found ${ready.length} ready to use on this machine.` : 'Nothing is linked yet. Link one below, or skip it.',
        ],
        rows: R,
      };
    }

    if (key === 'look') {
      const custom = parseHex(config.theme) && !presetFor(config.theme);
      const themeIds = [...THEMES.map((t) => t.id), ...(custom ? [config.theme] : [])];
      R.push({
        kind: 'select',
        id: 'theme',
        label: 'Accent color',
        value: themeName(config.theme),
        swatch: true,
        change: (d) => set((c) => (c.theme = cycle(themeIds, c.theme ?? DEFAULT_THEME, d))),
      });
      R.push({
        kind: 'text',
        id: 'theme:hex',
        label: 'Or a custom hex',
        value: custom ? config.theme : '—',
        hint: 'e.g. #ff8800',
        edit: {
          value: custom ? config.theme : '#',
          save: (v) => {
            const hex = parseHex(v);
            if (!hex) return toast(`"${v}" isn't a hex color · try #ff8800`, 'bad'), false;
            set((c) => (c.theme = hex));
          },
        },
      });
      R.push({
        kind: 'select',
        id: 'mouse',
        label: 'Mouse',
        value: config.mouse !== false ? 'on' : 'off',
        hint: config.mouse !== false ? 'click and scroll · hold Shift to select text' : "the terminal's own text selection",
        change: () => set((c) => (c.mouse = c.mouse === false)),
      });
      next();
      return { title: 'Make it yours', intro: ['Pick an accent color. The whole UI follows it, starting with this screen.'], rows: R, preview: true };
    }

    if (key === 'dashboard') {
      const toggle = (field, id, all) =>
        set((c) => {
          const on = new Set(c[field] ?? []);
          on.has(id) ? on.delete(id) : on.add(id);
          c[field] = all.filter((x) => on.has(x));
        });
      sub('Sections in the sidebar');
      const sectionIds = LIST_SECTIONS.map(([k]) => k);
      for (const [k, short, about] of LIST_SECTIONS) {
        const on = !(config.hiddenSections ?? []).includes(k);
        R.push({ kind: 'check', id: `show:${k}`, label: short, on, hint: about, enter: () => toggle('hiddenSections', k, sectionIds) });
      }
      sub('Numbers at the top of Home');
      const statIds = HOME_STATS.map((s) => s.id);
      for (const st of HOME_STATS) {
        const on = (config.homeStats ?? []).includes(st.id);
        R.push({ kind: 'check', id: `stat:${st.id}`, label: st.label, on, hint: st.about, enter: () => toggle('homeStats', st.id, statIds) });
      }
      sub('Freshness');
      const pick = (id, label, values, get, put, fmt, hint) =>
        R.push({ kind: 'select', id, label, value: fmt(get(config)), hint, change: (d) => set((c) => put(c, cycle(values, get(c), d))) });
      pick('refresh', 'Auto-refresh', [0, 30, 60, 120, 300, 600, 1800], (c) => c.refreshSeconds, (c, v) => (c.refreshSeconds = v), (v) => (v ? `every ${v}s` : 'off'), 'r refreshes any time');
      pick('mentions', 'Mentions from the last', [1, 3, 7, 14, 30], (c) => c.mentionDays, (c, v) => (c.mentionDays = v), (v) => `${v} days`);
      pick('stale', 'Flag reviews waiting', [1, 2, 3, 5, 7, 14], (c) => c.staleReviewDays, (c, v) => (c.staleReviewDays = v), (v) => `${v}+ days`, 'shown in red');
      next();
      return { title: 'Your dashboard', intro: ['Choose what you want to see. ⏎ or space ticks a box; Home and Settings are always there.'], rows: R };
    }

    if (key === 'workspace') {
      const text = (id, label, get, put, hint, sep) =>
        R.push({ kind: 'text', id, label, value: list(get(config)) || '(all)', hint, edit: { value: list(get(config)), save: (v) => set((c) => put(c, parseList(v, sep))) } });
      text('orgs', 'Only these orgs', (c) => c.orgs, (c, v) => (c.orgs = v), 'org or user names, comma separated');
      text('exclude', 'Hide these repos', (c) => c.excludeRepos, (c, v) => (c.excludeRepos = v), 'owner/name, comma separated');
      R.at(-1).value = list(config.excludeRepos) || '(none)';
      text('roots', 'Clone folders', (c) => c.workspaceRoots, (c, v) => (c.workspaceRoots = v), 'where your clones live, e.g. D:\\code · ; between', /;/);
      R.at(-1).value = list(config.workspaceRoots) || '(not set)';
      next();
      return {
        title: 'Scope and workspace',
        intro: [
          "Both optional. Leave the filters empty to see everything you're involved in.",
          'Clone folders are where pulse looks for your local clones when an AI agent works on a PR or issue.',
        ],
        rows: R,
      };
    }

    // done
    const chatId = chatProviderId(config);
    const agentId = agentProviderId(config);
    const shown = LIST_SECTIONS.filter(([k]) => !(config.hiddenSections ?? []).includes(k)).map(([, short]) => short);
    const stats = HOME_STATS.filter((s) => (config.homeStats ?? []).includes(s.id)).map((s) => s.label);
    const fact = (label, value, tone) => R.push({ kind: 'fact', label, value, tone });
    fact('GitHub', active ? `@${active.login} on ${active.host}` : 'not signed in · Settings → Profile', active ? 'green' : 'yellow');
    fact('Chat', providerName(chatId) ?? 'no AI linked · Settings → AI', chatId ? 'green' : 'yellow');
    fact('Code work', providerName(agentId) ?? 'no agent linked', agentId ? 'green' : 'gray');
    fact('Accent', themeName(config.theme));
    fact('Sidebar', shown.join(', ') || 'Home only');
    fact('Home shows', stats.join(', ') || 'just Next up');
    R.push({ kind: 'blank' });
    sub('A few keys to know');
    info('←→ or 1-8   switch sections        ⏎  open a PR or issue');
    info('a           AI menu on any item     tab  chat on Home');
    info('s           Settings                ?    every key');
    R.push({ kind: 'blank' });
    R.push({ kind: 'action', id: 'finish', label: 'Open my dashboard →', next: true, enter: finish });
    return { title: "You're all set", intro: ['Saved to your config. Settings has all of this and more.'], rows: R };
  }, [key, config, accounts, accountsError, ghPath, scan]);

  const rows = page.rows;
  const selectable = rows.map((r, i) => (r.enter || r.change || r.edit ? i : -1)).filter((i) => i >= 0);
  const pos = clamp(cursor, 0, selectable.length - 1);
  const row = rows[selectable[pos]];
  const move = (d) => setCursor((c) => clamp(clamp(c, 0, selectable.length - 1) + d, 0, selectable.length - 1));

  const activate = (r) => {
    if (r.enter) return r.enter();
    if (r.edit) return setEditing({ ...r.edit, label: r.label });
    if (r.change) return r.change(1);
  };

  useInput(
    (input, k) => {
      if (editing) {
        if (k.return) {
          if (editing.save(editing.value) === false) return;
          setEditing(null);
        } else if (k.escape) setEditing(null);
        else editText((f) => setEditing((e) => ({ ...e, value: typeof f === 'function' ? f(e.value) : f })), input, k);
        return;
      }
      if (k.escape) return step === 0 ? finish() : go(-1);
      if (k.tab) return k.shift ? go(-1) : step === STEPS.length - 1 ? finish() : go(1);
      if (k.upArrow || input === 'k') return move(-1);
      if (k.downArrow || input === 'j') return move(1);
      if (input === 'R') {
        clearWhichCache();
        setScan((n) => n + 1);
        return toast('re-detected gh and installed AIs');
      }
      if ((k.leftArrow || k.rightArrow) && row?.change) return row.change(k.leftArrow ? -1 : 1);
      if (input === ' ' && row?.kind === 'check') return row.enter();
      if (k.return && row) return activate(row);
    },
    { isActive: !panel },
  );

  const w = Math.min(width - 4, 88);
  const left = Math.max(0, Math.floor((width - w) / 2));

  if (panel) {
    return (
      <Box height={height} paddingLeft={left} paddingTop={1}>
        <Box flexDirection="column" width={w}>
          <ProviderPanel id={panel} config={config} updateConfig={updateConfig} width={w} height={height - 1} active toast={toast} onBack={() => setPanel(null)} />
        </Box>
      </Box>
    );
  }

  const introLines = page.intro.length + page.intro.reduce((n, l) => n + Math.floor(l.length / w), 0);
  const previewH = page.preview ? 7 : 0;
  const bodyH = Math.max(3, height - 7 - introLines - previewH - (editing ? 1 : 0));
  const selIndex = selectable[pos] ?? 0;
  const offset = clamp(selIndex - Math.floor(bodyH / 2), 0, Math.max(0, rows.length - bodyH));
  const labelW = Math.min(30, Math.max(14, ...rows.filter((r) => r.id && r.kind !== 'check').map((r) => r.label.length))) + 2;

  const clickRow = (r, index, isSel, { double }) => {
    if (editing) return;
    const at = selectable.indexOf(index);
    if (at < 0) return false;
    setCursor(at);
    if (r.kind === 'check' || isSel || double) activate(r);
  };

  const keys = [
    ['↑↓', 'move'],
    ...(row?.change ? [['←→', 'change']] : []),
    ['⏎', row?.kind === 'check' ? 'tick' : row?.next ? 'continue' : row?.change ? 'change' : row?.edit ? 'edit' : 'select'],
    ...(step < STEPS.length - 1 ? [['tab', 'next step']] : []),
    ['esc', step === 0 ? 'skip setup' : 'back'],
    ...(['welcome', 'github', 'ai'].includes(key) ? [['R', 'rescan']] : []),
  ];

  return (
    <Box height={height} paddingLeft={left}>
      <Box flexDirection="column" width={w} height={height}>
        <Box>
          <Box flexGrow={1}>
            <Text>
              <Text bold color={accent()}>{' ◆ pulse'}</Text>
              <Text dimColor>{'  setup'}</Text>
            </Text>
          </Box>
          <Text dimColor>{`step ${step + 1} of ${STEPS.length} `}</Text>
        </Box>
        <Progress step={step} />
        <Rule width={w} />
        <Text bold color={accent()}>{` ${page.title}`}</Text>
        {page.intro.map((l, i) => (
          <Text key={i} dimColor>{` ${l}`}</Text>
        ))}
        <Text> </Text>
        <Box flexDirection="column" height={bodyH}>
          {rows.slice(offset, offset + bodyH).map((r, i) => {
            const index = offset + i;
            const isSel = index === selIndex;
            if (r.kind === 'blank') return <Text key={`b${index}`}> </Text>;
            if (r.kind === 'sub') return <Text key={`s${index}`} bold>{` ${r.label}`}</Text>;
            if (r.kind === 'info') return <Text key={`i${index}`} color={r.tone} dimColor={!r.tone}>{`   ${r.label}`}</Text>;
            if (r.kind === 'fact')
              return (
                <Text key={`f${index}`} wrap="truncate">
                  <Text dimColor>{`   ${r.label.padEnd(12)}`}</Text>
                  <Text color={r.tone}>{r.value}</Text>
                </Text>
              );
            return (
              <Clickable key={r.id} onClick={(m) => clickRow(r, index, isSel, m)}>
                <Text wrap="truncate">
                  <Text color={accent()} bold>{isSel ? ' ❯ ' : '   '}</Text>
                  {r.kind === 'check' ? (
                    <Text>
                      <Text color={r.on ? accent() : 'gray'}>{r.on ? '◉ ' : '○ '}</Text>
                      <Text bold={isSel} dimColor={!r.on}>{r.label.padEnd(labelW - 2)}</Text>
                    </Text>
                  ) : r.next ? (
                    <Text bold color={isSel ? accent() : undefined} inverse={isSel}>{` ${r.label} `}</Text>
                  ) : (
                    <Text>
                      <Text bold={isSel}>{r.label.padEnd(labelW)}</Text>
                      <Text color={accent()}>{r.kind === 'select' && isSel ? '‹ ' : '  '}</Text>
                      <Text color={r.swatch ? accent() : r.tone} bold={isSel && r.kind === 'select'}>
                        {r.swatch ? `■ ${r.value}` : String(r.value ?? '')}
                      </Text>
                      {r.kind === 'select' ? <Text color={accent()}>{isSel ? ' ›' : '  '}</Text> : null}
                      {r.badge ? <Text color={r.tone}>{`  ${r.badge}`}</Text> : null}
                      {r.swatch ? <Swatches current={config.theme} /> : null}
                    </Text>
                  )}
                  {isSel && r.hint ? <Text dimColor>{`   ${r.hint}`}</Text> : null}
                </Text>
              </Clickable>
            );
          })}
        </Box>
        {page.preview ? <Preview /> : null}
        {editing ? (
          <Text wrap="truncate">
            <Text color={accent()} bold>{` ${editing.label}: `}</Text>
            <Text>{editing.value}</Text>
            <Text inverse> </Text>
            <Text dimColor>   ⏎ save  esc cancel</Text>
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <Keys keys={keys} />
      </Box>
    </Box>
  );
}

// Welcome ─ GitHub ─ AI ─ … with finished steps checked off.
function Progress({ step }) {
  return (
    <Text wrap="truncate">
      {' '}
      {STEPS.map(([id, label], i) => (
        <Text key={id}>
          {i ? <Text dimColor>{' ─ '}</Text> : null}
          <Text color={i === step ? accent() : i < step ? 'green' : undefined} bold={i === step} dimColor={i > step}>
            {i < step ? `✓ ${label}` : label}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

// A tiny mock of the dashboard in the current accent.
function Preview() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" width={58} marginLeft={3}>
      <Text>
        <Text bold color={accent()}>{' ◆ pulse      '}</Text>
        <Text bold>{'Good morning, '}</Text>
        <Text bold color={accent()}>@you</Text>
      </Text>
      <Text>
        <Text inverse bold color={accent()}>{' 1 Home      '}</Text>
        <Text>{'  '}</Text>
        <Text bold color="red">2</Text>
        <Text>{' to fix  '}</Text>
        <Text bold color="yellow">3</Text>
        <Text>{' to review'}</Text>
      </Text>
      <Text>
        <Text>{' 2 Review   3 '}</Text>
        <Text color={accent()} bold>{' ❯ '}</Text>
        <Text color="red" bold>{'fix  '}</Text>
        <Text color="cyan">api#551</Text>
        <Text>{'  Validate payloads'}</Text>
      </Text>
      <Text>
        <Text>{' 3 My PRs   7 '}</Text>
        <Text color={accent()} bold>{'── Ask pulse '}</Text>
        <Text dimColor>{'─────────────────'}</Text>
      </Text>
    </Box>
  );
}
