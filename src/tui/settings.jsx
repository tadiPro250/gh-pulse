// Settings: everything in config.json, plus GitHub profiles and AI linking.
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { envTokenOverride, listAccounts, switchAccount } from '../accounts.js';
import { CATALOG, KIND_LABELS } from '../ai/catalog.js';
import { canAgent, canChat, createChat, listModels, resolve, status } from '../ai/index.js';
import { runInteractive } from '../ai/providers/cli.js';
import { ghInteractive } from '../gh.js';
import { getSecret, mask, secretsPath, setSecret } from '../secrets.js';
import { configPath, loadConfig } from '../state.js';
import { DEFAULT_THEME, THEMES, accent, parseHex, presetFor, themeName } from '../theme.js';
import { LIST_SECTIONS } from '../view.js';
import { clearWhichCache } from '../which.js';
import { HOME_STATS } from './home.jsx';
import { Clickable } from './mouse.jsx';
import { Keys, Rule, Spinner, TopBar, editText } from './ui.jsx';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const STATUS_TONE = { installed: 'green', linked: 'green', local: 'green', 'pick a model': 'yellow', 'not linked': 'gray', 'not installed': 'gray', 'not set up': 'gray' };
// ● ready  ◐ almost (needs one more step)  ○ off
export const statusIcon = (label) => (STATUS_TONE[label] === 'green' ? '●' : STATUS_TONE[label] === 'yellow' ? '◐' : '○');
const list = (v) => (v?.length ? v.join(', ') : '');
const parseList = (s, sep = /[,\s]+/) => s.split(sep).map((x) => x.trim()).filter(Boolean);
export const cycle = (values, current, d) => values[(values.indexOf(current) + d + values.length) % values.length] ?? values[0];

export function SettingsScreen({ config, updateConfig, archivedCount = 0, width, height, active, onAction, onSwitched, suspendTerminal, toast }) {
  const [accounts, setAccounts] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(null); // { id, label, value }
  const [panel, setPanel] = useState(null); // provider id
  const [, bump] = useState(0);

  const loadAccounts = () => listAccounts().then(setAccounts, (e) => toast(e.message, 'bad'));
  useEffect(() => void loadAccounts(), []);

  const set = (fn) =>
    updateConfig((c) => {
      fn(c);
      return c;
    });

  const rows = useMemo(() => {
    const R = [];
    const header = (label) => R.push({ kind: 'header', label });

    header('Profile');
    if (!accounts) R.push({ kind: 'info', label: 'reading gh auth status…' });
    for (const a of accounts ?? []) {
      R.push({
        kind: 'account',
        id: `acct:${a.host}/${a.login}`,
        label: a.login,
        value: a.host,
        hint: a.active ? 'active' : !a.ok ? 'token invalid' : '⏎ switch',
        tone: a.active ? 'green' : a.ok ? null : 'red',
        enter: async () => {
          if (a.active) return;
          try {
            await switchAccount(a);
            toast(`switched to @${a.login}`, 'good');
            await loadAccounts();
            onSwitched();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      });
    }
    R.push({
      kind: 'action',
      id: 'acct:add',
      label: '+ add account',
      hint: 'gh auth login',
      enter: () => suspendTerminal(() => ghInteractive(['auth', 'login'])).then(loadAccounts),
    });
    const override = envTokenOverride();
    if (override) R.push({ kind: 'info', label: `⚠ $${override} overrides the account above`, tone: 'yellow' });

    header('Theme');
    const custom = parseHex(config.theme) && !presetFor(config.theme);
    const themeIds = [...THEMES.map((t) => t.id), ...(custom ? [config.theme] : [])];
    R.push({
      kind: 'select',
      id: 'theme',
      label: 'Accent color',
      value: themeName(config.theme),
      swatch: true,
      hint: 'previews live',
      change: (d) => set((c) => (c.theme = cycle(themeIds, c.theme ?? DEFAULT_THEME, d))),
    });
    R.push({
      kind: 'text',
      id: 'theme:hex',
      label: 'Custom hex',
      value: custom ? config.theme : '—',
      hint: 'e.g. #ff8800',
      edit: {
        value: custom ? config.theme : '#',
        save: (v) => {
          const hex = parseHex(v);
          if (!hex) {
            toast(`"${v}" isn't a hex color · try #ff8800`, 'bad');
            return false;
          }
          set((c) => (c.theme = hex));
        },
      },
    });

    header('AI');
    const ready = CATALOG.filter((p) => status(config, p.id).ready).map((p) => resolve(config, p.id));
    const chatIds = ['', ...ready.filter(canChat).map((p) => p.id)];
    const agentIds = ['', ...ready.filter((p) => canAgent(p) || canChat(p)).map((p) => p.id)];
    const name = (id) => (id ? resolve(config, id).name : 'auto (first that works)');
    R.push({
      kind: 'select',
      id: 'ai:chat',
      label: 'Chat with',
      value: name(config.ai.chat),
      hint: 'answers your questions',
      change: (d) => set((c) => (c.ai.chat = cycle(chatIds, c.ai.chat, d))),
    });
    R.push({
      kind: 'select',
      id: 'ai:agent',
      label: 'Send to AI with',
      value: name(config.ai.agent),
      hint: 'edits code in your clone (f)',
      change: (d) => set((c) => (c.ai.agent = cycle(agentIds, c.ai.agent, d))),
    });
    for (const kind of ['cli', 'api', 'ide']) {
      R.push({ kind: 'sub', label: { cli: 'Coding agents', api: 'APIs & local models', ide: 'Editors' }[kind] });
      for (const p of CATALOG.filter((x) => x.kind === kind)) {
        const st = status(config, p.id);
        const isChat = config.ai.chat === p.id;
        const isAgent = config.ai.agent === p.id;
        R.push({
          kind: 'provider',
          id: `prov:${p.id}`,
          label: p.name,
          value: `${statusIcon(st.label)} ${st.label}`,
          tone: STATUS_TONE[st.label],
          tags: [isChat && 'chat', isAgent && 'send to AI'].filter(Boolean),
          hint: `${p.vendor} · ⏎ set up`,
          enter: () => setPanel(p.id),
        });
      }
    }

    header('Dashboard');
    const numeric = (id, label, values, get, put, fmt = String) =>
      R.push({ kind: 'select', id, label, value: fmt(get(config)), change: (d) => set((c) => put(c, cycle(values, get(c), d))) });
    numeric('refresh', 'Auto-refresh', [0, 30, 60, 120, 300, 600, 1800], (c) => c.refreshSeconds, (c, v) => (c.refreshSeconds = v), (v) => (v ? `${v}s` : 'off'));
    numeric('limit', 'Items per section', [10, 20, 30, 50, 75, 100], (c) => c.limit, (c, v) => (c.limit = v));
    numeric('mentions', 'Mentions window', [1, 3, 7, 14, 30], (c) => c.mentionDays, (c, v) => (c.mentionDays = v), (v) => `${v} days`);
    numeric('stale', 'Stale review after', [1, 2, 3, 5, 7, 14], (c) => c.staleReviewDays, (c, v) => (c.staleReviewDays = v), (v) => `${v} days`);
    numeric('group', 'Group inbox by repo', [true, false], (c) => c.groupInbox, (c, v) => (c.groupInbox = v), (v) => (v ? 'on' : 'off'));
    numeric('mouse', 'Mouse', [true, false], (c) => c.mouse !== false, (c, v) => (c.mouse = v), (v) => (v ? 'on' : 'off'));
    R.at(-1).hint = 'off: drag to select text';
    R.push({
      kind: 'action',
      id: 'unarchive',
      label: 'Archived items',
      value: archivedCount ? String(archivedCount) : 'none',
      hint: archivedCount ? '⏎ show them all again' : 'archive from an item’s AI menu (a)',
      enter: () => onAction('unarchiveAll'),
    });

    header('Show');
    // Toggle `id` in the list at c[field]; `all` keeps the list in its canonical order.
    const toggle = (field, id, all) => set((c) => {
      const on = new Set(c[field] ?? []);
      on.has(id) ? on.delete(id) : on.add(id);
      c[field] = all.filter((x) => on.has(x));
    });
    R.push({ kind: 'sub', label: 'Sidebar sections' });
    const sectionIds = LIST_SECTIONS.map(([k]) => k);
    for (const [key, short, about] of LIST_SECTIONS) {
      const shown = !(config.hiddenSections ?? []).includes(key);
      R.push({ kind: 'select', id: `show:${key}`, label: `  ${short}`, value: shown ? 'shown' : 'hidden', tone: shown ? undefined : 'gray', hint: about, change: () => toggle('hiddenSections', key, sectionIds) });
    }
    R.push({ kind: 'sub', label: 'Numbers on Home' });
    const statIds = HOME_STATS.map((st) => st.id);
    for (const st of HOME_STATS) {
      const shown = (config.homeStats ?? []).includes(st.id);
      R.push({ kind: 'select', id: `stat:${st.id}`, label: `  ${st.label}`, value: shown ? 'shown' : 'hidden', tone: shown ? undefined : 'gray', hint: st.about, change: () => toggle('homeStats', st.id, statIds) });
    }

    header('Scope');
    const text = (id, label, get, put, hint, sep) =>
      R.push({ kind: 'text', id, label, value: list(get(config)) || '(all)', hint, edit: { value: list(get(config)), save: (v) => set((c) => put(c, parseList(v, sep))) } });
    text('repos', 'Only repos', (c) => c.repos, (c, v) => (c.repos = v), 'owner/name, …');
    text('orgs', 'Only orgs', (c) => c.orgs, (c, v) => (c.orgs = v), 'org or user, …');
    text('exclude', 'Hide repos', (c) => c.excludeRepos, (c, v) => (c.excludeRepos = v), 'owner/name, …');

    header('Workspace');
    text('roots', 'Clone folders', (c) => c.workspaceRoots, (c, v) => (c.workspaceRoots = v), 'where your clones live · ; between', /;/);
    const clones = Object.entries(config.clones ?? {});
    if (clones.length) R.push({ kind: 'info', label: `remembered: ${clones.map(([r]) => r.split('/')[1]).join(', ')}` });

    header('Files');
    R.push({
      kind: 'action',
      id: 'file:config',
      label: 'Edit config.json',
      hint: configPath(),
      enter: async () => {
        const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
        await suspendTerminal(() => runInteractive({ file: editor, args: [configPath()] }, process.cwd()));
        updateConfig(() => loadConfig());
        toast('config reloaded', 'good');
      },
    });
    R.push({ kind: 'info', label: `API keys: ${secretsPath()}` });
    R.push({ kind: 'action', id: 'setup', label: 'Run setup again', hint: 'the welcome walkthrough', enter: () => onAction('setup') });
    return R;
  }, [config, accounts, archivedCount]);

  const selectable = rows.map((r, i) => (r.enter || r.change || r.edit ? i : -1)).filter((i) => i >= 0);
  const pos = clamp(cursor, 0, selectable.length - 1);
  const row = rows[selectable[pos]];
  // Functional, so a held arrow key never acts on a stale position.
  const move = (d) => setCursor((c) => clamp(clamp(c, 0, selectable.length - 1) + d, 0, selectable.length - 1));

  const activate = (r) => {
    if (r.enter) return r.enter();
    if (r.edit) return setEditing({ ...r.edit, label: r.label });
    if (r.change) return r.change(1);
  };

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return) {
          if (editing.save(editing.value) === false) return; // invalid: keep editing
          setEditing(null);
          toast(`saved ${editing.label.toLowerCase()}`, 'good');
        } else if (key.escape) setEditing(null);
        else editText((f) => setEditing((e) => ({ ...e, value: typeof f === 'function' ? f(e.value) : f })), input, key);
        return;
      }
      if (key.escape) return onAction('gotoSection', 0);
      if (/^[1-8]$/.test(input)) return onAction('gotoSection', Number(input) - 1);
      if (input === 'q') return onAction('quit');
      if (input === '?') return onAction('help');
      if (key.upArrow || input === 'k') return move(-1);
      if (key.downArrow || input === 'j') return move(1);
      if (key.pageDown) return move(8);
      if (key.pageUp) return move(-8);
      if (input === 'R') {
        clearWhichCache();
        bump((n) => n + 1);
        return toast('re-detected installed tools');
      }
      // ←→ change a ‹ value ›; anywhere else they switch sections, like on every other screen.
      if ((key.leftArrow || key.rightArrow) && row?.change) return row.change(key.leftArrow ? -1 : 1);
      if (key.leftArrow || input === 'h') return onAction('prevSection');
      if (key.rightArrow || input === 'l') return onAction('nextSection');
      if (key.return && row) return activate(row);
    },
    { isActive: active && !panel },
  );

  if (panel) {
    return (
      <ProviderPanel
        id={panel}
        config={config}
        updateConfig={updateConfig}
        width={width}
        height={height}
        active={active}
        toast={toast}
        onBack={() => {
          setPanel(null);
          bump((n) => n + 1);
        }}
      />
    );
  }

  // Click: highlight a row; click it again to open/edit it. On a ‹ value ›,
  // the arrows step it and the theme dots pick a color directly.
  const clickRow = (r, index, isSel, { x, double }, labelW) => {
    if (editing) return;
    const at = selectable.indexOf(index);
    if (at < 0) return false;
    setCursor(at);
    if (r.kind === 'select') {
      const valueText = r.swatch ? `■ ${r.value}` : String(r.value ?? '');
      const left = 3 + labelW; // "‹ " starts here
      const right = left + 2 + valueText.length; // " ›"
      if (x >= left && x < left + 2) return r.change(-1);
      if (x >= right && x < right + 2) return r.change(1);
      const dots = right + 2 + 3;
      if (r.swatch && x >= dots && x < dots + THEMES.length * 2) return set((c) => (c.theme = THEMES[Math.floor((x - dots) / 2)].id));
    }
    if (isSel || double) activate(r);
  };

  const bodyH = height - 3 - (editing ? 1 : 0);
  const selIndex = selectable[pos] ?? 0;
  const offset = clamp(selIndex - Math.floor(bodyH / 2), 0, Math.max(0, rows.length - bodyH));
  const labelW = Math.min(32, Math.max(18, ...rows.filter((r) => r.label && r.id).map((r) => r.label.length + (r.kind === 'provider' ? 2 : 0)))) + 2;
  const valueW = Math.max(16, ...rows.filter((r) => r.kind === 'provider').map((r) => r.value.length + 2));

  return (
    <Box flexDirection="column" height={height}>
      <Text bold>{' Settings'}</Text>
      <Rule width={width} />
      <Box flexDirection="column" height={bodyH}>
        {rows.slice(offset, offset + bodyH).map((r, i) => {
          const isSel = offset + i === selIndex;
          if (r.kind === 'header') return <Text key={`h${r.label}`} bold color={accent()}>{` ${r.label}`}</Text>;
          if (r.kind === 'sub') return <Text key={`s${r.label}`} dimColor>{`   ${r.label}`}</Text>;
          if (r.kind === 'info') return <Text key={`i${r.label}`} color={r.tone} dimColor={!r.tone} wrap="truncate">{`     ${r.label}`}</Text>;
          const indent = r.kind === 'provider' ? '  ' : '';
          const index = offset + i;
          return (
            <Clickable key={r.id} onClick={(m) => clickRow(r, index, isSel, m, labelW)}>
              <Text wrap="truncate">
                <Text color={accent()} bold>{isSel ? ' ❯ ' : '   '}</Text>
                <Text bold={isSel}>{`${indent}${r.label}`.padEnd(labelW)}</Text>
                <Text color={accent()}>{r.kind === 'select' && isSel ? '‹ ' : '  '}</Text>
                <Text color={r.swatch ? accent() : r.tone} bold={isSel && r.kind !== 'provider'}>
                  {r.swatch ? `■ ${r.value}` : String(r.value ?? '').padEnd(r.kind === 'provider' ? valueW : 0)}
                </Text>
                {r.kind === 'select' ? <Text color={accent()}>{isSel ? ' ›' : '  '}</Text> : null}
                {r.swatch ? <Swatches current={config.theme} /> : null}
                {r.tags?.length ? <Text color={accent()}>{r.tags.join(' · ')}</Text> : null}
                {isSel && r.hint ? <Text dimColor>{`${r.tags?.length ? '  ' : '   '}${r.hint}`}</Text> : null}
              </Text>
            </Clickable>
          );
        })}
      </Box>
      {editing ? (
        <Text wrap="truncate">
          <Text color={accent()} bold>{` ${editing.label}: `}</Text>
          <Text>{editing.value}</Text>
          <Text inverse> </Text>
          <Text dimColor>   ⏎ save  esc cancel</Text>
        </Text>
      ) : null}
      <Keys keys={[['↑↓', 'move'], ['⏎', row?.change ? 'change' : 'open'], ['←→', row?.change ? 'change' : 'sections'], ['R', 'rescan tools'], ['esc', 'home']]} />
    </Box>
  );
}

// Every preset as a colored dot; the current one is filled.
export function Swatches({ current }) {
  return (
    <Text>
      {'   '}
      {THEMES.map((t) => (
        <Text key={t.id} color={t.color}>
          {t.id === (current ?? DEFAULT_THEME) ? '● ' : '○ '}
        </Text>
      ))}
    </Text>
  );
}

export function ProviderPanel({ id, config, updateConfig, width, height, active, toast, onBack }) {
  const p = resolve(config, id);
  const st = status(config, id);
  const [mode, setMode] = useState(null); // 'key' | 'model' | 'url' | 'command'
  const [input, setInput] = useState('');
  const [models, setModels] = useState(null);
  const [modelCursor, setModelCursor] = useState(0);
  const [test, setTest] = useState(null); // { running, text, error }

  const setOverride = (fn) =>
    updateConfig((c) => {
      c.ai.providers = { ...c.ai.providers, [id]: fn({ ...c.ai.providers?.[id] }) };
      return c;
    });

  const savedKey = getSecret(id);
  const envKey = p.env ? process.env[p.env] : null;

  const openModels = () => {
    setMode('model');
    setInput('');
    setModels(null);
    setModelCursor(0);
    listModels(config, id).then(
      (m) => setModels(m.length ? m : []),
      (err) => {
        setModels([]);
        toast(err.message, 'bad');
      },
    );
  };

  const runTest = async () => {
    setTest({ running: true, text: '' });
    try {
      const chat = createChat(config, id);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      let text = '';
      for await (const ch of chat.stream([{ role: 'system', content: 'You are a connectivity check.' }, { role: 'user', content: 'Reply with exactly: pulse ok' }], ctrl.signal)) {
        if (ch.type === 'text') text += ch.text;
        setTest({ running: true, text });
      }
      clearTimeout(timer);
      setTest({ running: false, text: text.trim() || '(empty reply)' });
    } catch (err) {
      setTest({ running: false, error: err.message });
    }
  };

  const filtered = (models ?? []).filter((m) => m.toLowerCase().includes(input.toLowerCase()));
  const pickModel = (pick) => {
    if (pick) {
      setOverride((o) => ({ ...o, model: pick }));
      toast(`${p.name} will use ${pick}`, 'good');
    }
    setMode(null);
  };

  useInput(
    (ch, key) => {
      if (mode === 'model') {
        if (key.escape) return setMode(null);
        if (key.upArrow) return setModelCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return setModelCursor((c) => Math.min(filtered.length - 1, c + 1));
        if (key.return) return pickModel(filtered[modelCursor] ?? input.trim());
        editText(setInput, ch, key);
        return setModelCursor(0);
      }
      if (mode) {
        if (key.escape) return setMode(null);
        if (key.return) {
          const v = input.trim();
          if (mode === 'key') {
            setSecret(id, v || null);
            toast(v ? `saved API key for ${p.name}` : `removed key for ${p.name}`, 'good');
            updateConfig((c) => c); // re-render statuses
          }
          if (mode === 'url') setOverride((o) => ({ ...o, baseUrl: v }));
          if (mode === 'command') setOverride((o) => ({ ...o, command: v }));
          setMode(null);
          if (mode === 'key' && v && !p.model) openModels();
          return;
        }
        return editText(setInput, ch, key);
      }
      if (key.escape || key.leftArrow) return onBack();
      if (ch === 'k' && p.kind === 'api' && !p.local) return (setMode('key'), setInput(''));
      if (ch === 'm' && (p.kind === 'api' || p.models)) return openModels();
      if (ch === 'b' && p.kind === 'api') return (setMode('url'), setInput(p.baseUrl ?? ''));
      if (ch === 'p' && (p.kind === 'cli' || p.kind === 'ide')) return (setMode('command'), setInput(p.bin ?? ''));
      if (ch === 't' && canChat(p)) return runTest();
      if (ch === 'c' && canChat(p)) {
        updateConfig((c) => ((c.ai.chat = id), c));
        return toast(`${p.name} is now used for chat`, 'good');
      }
      if (ch === 'a' && (canAgent(p) || canChat(p))) {
        updateConfig((c) => ((c.ai.agent = id), c));
        return toast(`${p.name} is now used for Send to AI`, 'good');
      }
      if (ch === 'u') {
        setSecret(id, null);
        setOverride(() => ({}));
        updateConfig((c) => {
          if (c.ai.chat === id) c.ai.chat = '';
          if (c.ai.agent === id) c.ai.agent = '';
          return c;
        });
        return toast(`unlinked ${p.name}`);
      }
    },
    { isActive: active },
  );

  // ● in use · ○ possible (press c / a)
  const uses = [canChat(p) && ['chat', config.ai.chat === id], (canAgent(p) || canChat(p)) && ['send to AI', config.ai.agent === id]].filter(Boolean);
  const facts = [
    ['Status', `${statusIcon(st.label)} ${st.label}${st.ready ? '' : `  · ${st.hint}`}`, STATUS_TONE[st.label]],
    ...(p.kind !== 'api' ? [['Command', st.path ?? (p.bin || '(none)')]] : []),
    ...(p.kind === 'api' && !p.local ? [['API key', savedKey ? mask(savedKey) : envKey ? `from $${p.env}` : `none${p.keyUrl ? ` · get one at ${p.keyUrl}` : ''}`, savedKey || envKey ? 'green' : 'yellow']] : []),
    ...(p.kind === 'api' && (p.baseUrl || p.custom) ? [['Base URL', p.baseUrl || '(not set)']] : []),
    ...(p.kind === 'api' || p.models ? [['Model', p.model || (p.kind === 'cli' ? 'default' : '(none)')]] : []),
    ...(uses.length ? [['Used for', uses.map(([name, on]) => `${on ? '●' : '○'} ${name}`).join('   ')]] : []),
    ...(p.kind === 'cli' && !p.verified ? [['Note', 'flags unverified · override in config.json', 'yellow']] : []),
  ];

  const actions = [
    ...(p.kind === 'api' && !p.local ? [['k', 'key']] : []),
    ...(p.kind === 'api' || p.models ? [['m', 'model']] : []),
    ...(p.kind === 'api' ? [['b', 'base URL']] : []),
    ...(p.kind !== 'api' ? [['p', 'path']] : []),
    ...(canChat(p) ? [['t', 'test'], ['c', 'chat']] : []),
    ...(canAgent(p) || canChat(p) ? [['a', 'send to AI']] : []),
    ['u', 'unlink'],
    ['esc', 'back'],
  ];

  const listH = Math.max(3, height - facts.length - 9);

  return (
    <Box flexDirection="column" height={height}>
      <TopBar label={p.name} right={<Text dimColor>{`${KIND_LABELS[p.kind]} · ${p.vendor}`}</Text>} />
      <Rule width={width} />
      {facts.map(([k, v, tone]) => (
        <Text key={k} wrap="truncate">
          <Text dimColor>{`   ${k.padEnd(10)}`}</Text>
          <Text color={tone}>{v}</Text>
        </Text>
      ))}
      <Text> </Text>
      {mode === 'key' || mode === 'url' || mode === 'command' ? (
        <Text wrap="truncate">
          <Text color={accent()} bold>{`   ${{ key: 'API key', url: 'Base URL', command: 'Command' }[mode]}: `}</Text>
          <Text>{mode === 'key' ? '•'.repeat(input.length) : input}</Text>
          <Text inverse> </Text>
          <Text dimColor>{mode === 'key' ? '   paste · ⏎ save (empty removes) · esc' : '   ⏎ save · esc'}</Text>
        </Text>
      ) : null}
      {mode === 'model' ? (
        <Box flexDirection="column" height={listH + 1}>
          <Text wrap="truncate">
            <Text color={accent()} bold>{'   Model: '}</Text>
            <Text>{input}</Text>
            <Text inverse> </Text>
            <Text dimColor>{models === null ? '   loading models…' : `   ${filtered.length} · type to filter · ⏎ pick`}</Text>
          </Text>
          {filtered.slice(Math.max(0, modelCursor - listH + 1), Math.max(0, modelCursor - listH + 1) + listH).map((m) => (
            <Clickable key={m} onClick={() => pickModel(m)}>
              <Text color={m === filtered[modelCursor] ? accent() : undefined} bold={m === filtered[modelCursor]}>
                {`   ${m === filtered[modelCursor] ? '❯' : ' '} ${m}${m === p.model ? '  (current)' : ''}`}
              </Text>
            </Clickable>
          ))}
        </Box>
      ) : null}
      {test ? (
        <Text wrap="truncate">
          <Text dimColor>{'   Test      '}</Text>
          {test.running ? <Spinner /> : null}
          <Text color={test.error ? 'red' : test.running ? undefined : 'green'}>{` ${test.error ?? test.text ?? ''}`}</Text>
        </Text>
      ) : null}
      <Box flexGrow={1} />
      <Keys keys={actions} />
    </Box>
  );
}
