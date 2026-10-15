import { Box, Text, render, useApp, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatProviderId, resolve } from '../ai/index.js';
import { fetchDetail, fetchDiff } from '../detail.js';
import { currentRepo, ghInteractive } from '../gh.js';
import { fetchDashboard, fetchNotifications, markThreadsRead } from '../github.js';
import { isArchived, loadState, mergeSeen, saveConfig, saveState, setArchived } from '../state.js';
import { copyToClipboard, openUrl } from '../system.js';
import { applyTheme } from '../theme.js';
import { LIST_SECTIONS, SECTION_KEYS, buildView, notificationRows } from '../view.js';
import { AiScreen } from './ai.jsx';
import { ComposeScreen } from './compose.jsx';
import { HandoffScreen } from './handoff.jsx';
import { HomeScreen } from './home.jsx';
import { ListScreen } from './list.jsx';
import { MenuScreen } from './menu.jsx';
import { createMouseStdin, mouseState } from './mouse.jsx';
import { DetailScreen, DiffScreen, HelpScreen } from './screens.jsx';
import { SettingsScreen } from './settings.jsx';
import { SetupScreen } from './setup.jsx';
import { SIDEBAR_W, Sidebar } from './sidebar.jsx';
import { toneColor } from './ui.jsx';

export async function runTui(props) {
  const stdin = process.stdin.isTTY ? createMouseStdin() : process.stdin;
  const app = render(<App {...props} />, { stdin, alternateScreen: true, exitOnCtrlC: true });
  await app.waitUntilExit();
  stdin.restore?.();
}

// Fetches the dashboard + notifications, refreshes on an interval, and keeps
// the "new since last session" baseline stable for the whole session.
function useDashboard(scope, settings, refreshSeconds) {
  const [state, setState] = useState({ loading: true, error: null, data: null, notifications: null, seen: null, fetchedAt: null });
  const baseline = useRef(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [data, notifications] = await Promise.all([fetchDashboard(scope, settings), fetchNotifications(scope).catch(() => null)]);
      const saved = loadState();
      const account = saved.accounts[data.login];
      if (baseline.current?.login !== data.login) baseline.current = { login: data.login, seen: account?.seen ?? null };
      saved.accounts[data.login] = { seen: mergeSeen(account?.seen, SECTION_KEYS.flatMap((k) => data[k])), lastRun: new Date().toISOString() };
      saveState(saved);
      setState({ loading: false, error: null, data, notifications, seen: baseline.current.seen, fetchedAt: Date.now() });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    } finally {
      inFlight.current = false;
    }
  }, [scope, settings]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!refreshSeconds) return;
    const t = setInterval(load, refreshSeconds * 1000);
    return () => clearInterval(t);
  }, [load, refreshSeconds]);

  const dropNotifications = (ids) =>
    setState((s) => ({ ...s, notifications: s.notifications?.filter((n) => !ids.includes(n.id)) ?? null }));

  return { ...state, reload: load, dropNotifications };
}

// flagScope: repos/orgs from the command line (they win over config), or null.
export function App({ config: initialConfig, flagScope = null, flagSettings = {}, persist = true, setup: initialSetup = false }) {
  const { exit, suspendTerminal } = useApp();
  const size = useWindowSize();
  const columns = size?.columns || 120;
  const rows = size?.rows || 32;

  const [config, setConfig] = useState(initialConfig);
  // Children read the accent while rendering, so set it before they do.
  applyTheme(config.theme);
  useEffect(() => {
    mouseState.enabled = config.mouse !== false;
    mouseState.refresh();
  }, [config.mouse]);
  const updateConfig = useCallback(
    (fn) =>
      setConfig((prev) => {
        const next = fn(structuredClone(prev)) ?? prev;
        if (persist) saveConfig(next);
        return { ...next };
      }),
    [persist],
  );

  // Re-derive scope/settings only when their values change, so config edits
  // elsewhere (AI, layout) don't refetch the dashboard.
  const scopeKey = JSON.stringify(flagScope ?? { repos: config.repos, orgs: config.orgs, excludeRepos: config.excludeRepos });
  const scope = useMemo(() => JSON.parse(scopeKey), [scopeKey]);
  const settingsKey = JSON.stringify({ limit: flagSettings.limit ?? config.limit, mentionDays: flagSettings.mentionDays ?? config.mentionDays, staleReviewDays: config.staleReviewDays });
  const settings = useMemo(() => JSON.parse(settingsKey), [settingsKey]);
  const dash = useDashboard(scope, settings, config.refreshSeconds);

  const [setup, setSetup] = useState(initialSetup); // the welcome wizard covers the whole screen
  const [sectionKey, setSectionKey] = useState('home'); // by key, so hiding a section doesn't move you
  const [ui, setUi] = useState({ cursors: {}, filter: '', filtering: false, showAll: false, grouped: {}, collapsed: {} });
  const [stack, setStack] = useState([]); // overlay screens (detail, diff, ai, handoff, help)
  const [visited, setVisited] = useState(() => new Set());
  const [toastMsg, setToastMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [archived, setArchivedMap] = useState(() => (persist ? loadState().archived : {}));
  const cache = useRef(new Map());

  const toastTimer = useRef(null);
  const toast = useCallback((text, tone = 'ok') => {
    clearTimeout(toastTimer.current);
    setToastMsg({ text, tone });
    toastTimer.current = setTimeout(() => setToastMsg(null), 5000);
  }, []);

  const singleRepo = scope.repos.length === 1 && !scope.orgs.length;
  const tabs = useMemo(() => {
    if (!dash.data) return LIST_SECTIONS.map(([key, short]) => ({ key, short, title: short, rows: [], empty: '' }));
    const built = buildView(dash.data, { all: ui.showAll, singleRepo, seen: dash.seen, settings });
    const all = [...built, { key: 'inbox', title: 'Notifications', short: 'Inbox', rows: notificationRows(dash.notifications ?? []), empty: 'inbox zero' }];
    return all.map((t) => ({ ...t, rows: t.rows.filter((r) => !isArchived(archived, r)) }));
  }, [dash.data, dash.notifications, dash.seen, ui.showAll, singleRepo, settings, archived]);

  const hidden = config.hiddenSections ?? [];
  const sections = useMemo(
    () => [
      { key: 'home', short: 'Home', count: null },
      ...tabs.filter((t) => !hidden.includes(t.key)).map((t) => ({ ...t, count: t.rows.length, urgent: ['review', 'reviewed', 'inbox'].includes(t.key) })),
      { key: 'settings', short: 'Settings', count: null },
    ],
    [tabs, hidden.join()],
  );
  const section = Math.max(0, sections.findIndex((s) => s.key === sectionKey));
  const current = sections[section];

  const cached = (key, fetch, force) => {
    if (!force && cache.current.has(key)) return cache.current.get(key);
    const p = fetch();
    cache.current.set(key, p);
    p.catch(() => cache.current.delete(key));
    return p;
  };
  const getDetail = (item, force) => cached(`detail:${item.repo}#${item.number}`, () => fetchDetail(item), force);
  const getDiff = (item, force) => cached(`diff:${item.repo}#${item.number}`, () => fetchDiff(item), force);

  const push = (screen) => setStack((s) => [...s, screen]);
  const visit = (item) => setVisited((v) => new Set(v).add(item.id));
  const goto = (i) => {
    setStack([]);
    setSectionKey(sections[(i + sections.length) % sections.length].key);
  };

  const checkout = async (item) => {
    const here = await currentRepo().catch(() => null);
    if (here?.toLowerCase() !== item.repo.toLowerCase()) {
      return toast(`run pulse inside a clone of ${item.repo} to check out · or press a → agent`, 'warn');
    }
    let code = 1;
    await suspendTerminal(async () => {
      code = await ghInteractive(['pr', 'checkout', String(item.number)]);
    });
    toast(code === 0 ? `checked out ${item.ref}` : `gh pr checkout exited with ${code}`, code === 0 ? 'good' : 'bad');
  };

  const markRead = async (items) => {
    const ids = items.map((i) => i.threadId).filter(Boolean);
    if (!ids.length) return;
    try {
      await markThreadsRead(ids);
      dash.dropNotifications(ids);
      toast(`marked ${ids.length} notification${ids.length > 1 ? 's' : ''} read`, 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const onAction = (name, item, extra) => {
    const notThread = item?.kind === 'link';
    switch (name) {
      case 'back': return setStack((s) => s.slice(0, -1));
      case 'quit': return exit();
      case 'refresh': return void dash.reload();
      case 'help': return push({ type: 'help' });
      case 'settings': return goto(sections.length - 1);
      case 'nextSection': return goto(section + 1);
      case 'prevSection': return goto(section - 1);
      case 'gotoSection': return item < sections.length ? goto(item) : undefined; // number keys past the last section
      case 'setup': return setSetup(true);
      case 'toast': return toast(item, 'warn');
      case 'toggleAll': return setUi((u) => ({ ...u, showAll: !u.showAll }));
      case 'open':
        openUrl(item.url);
        return toast(`opened ${item.ref} in your browser`);
      case 'copy':
        return void copyToClipboard(item.url).then(() => toast(`copied ${item.url}`), (err) => toast(err.message, 'bad'));
      case 'detail':
        if (notThread) return onAction('open', item);
        visit(item);
        return push({ type: 'detail', item });
      // The one AI entry point: a menu of what fits this item. `extra.focus` preselects an option.
      case 'ai':
        if (notThread || !item.number) return toast('the AI works on issues and PRs', 'warn');
        visit(item);
        return push({ type: 'menu', item, focus: extra?.focus });
      // From the menu: the chat answers a prompt…
      case 'chat':
        return push({ type: 'ai', item, prompt: extra?.prompt, providerId: extra?.providerId });
      // …or a coding agent takes a task.
      case 'agent':
        return push({ type: 'handoff', item, task: extra?.task, notes: extra?.notes });
      case 'compose':
        return push({ type: 'compose', item });
      case 'commented':
        cache.current.delete(`detail:${item.repo}#${item.number}`);
        setStack((s) => s.slice(0, -1));
        return void dash.reload();
      // Merged or closed: it leaves the lists, so drop its screens too.
      case 'changed':
        cache.current.delete(`detail:${item.repo}#${item.number}`);
        setStack((s) => s.filter((x) => x.item?.url !== item.url));
        return void dash.reload();
      case 'archive':
        setArchivedMap((a) => setArchived(a, [item.url], true, { persist }));
        setStack((s) => s.filter((x) => x.item?.url !== item.url));
        return toast(`archived ${item.ref} · it comes back when there's new activity`, 'good');
      case 'unarchive':
        setArchivedMap((a) => setArchived(a, [item.url], false, { persist }));
        return toast(`unarchived ${item.ref}`, 'good');
      case 'unarchiveAll': {
        const n = Object.keys(archived).length;
        setArchivedMap((a) => setArchived(a, Object.keys(a), false, { persist }));
        return toast(n ? `restored ${n} archived item${n > 1 ? 's' : ''}` : 'nothing is archived', 'good');
      }
      case 'diff':
        if (item.kind !== 'pr') return toast('diff is only for pull requests', 'warn');
        return push({ type: 'diff', item });
      case 'checkout':
        if (item.kind !== 'pr') return toast('checkout is only for pull requests', 'warn');
        return void checkout(item);
      case 'markRead':
        if (item.section !== 'inbox') return;
        return void markRead([item]);
      case 'markAllRead': {
        const rowsToMark = extra ?? [];
        if (!rowsToMark.length) return;
        // Requires a second press within a few seconds.
        if (confirm?.n === rowsToMark.length && Date.now() - confirm.at < 4000) {
          setConfirm(null);
          return void markRead(rowsToMark);
        }
        setConfirm({ n: rowsToMark.length, at: Date.now() });
        return toast(`press again to mark ${rowsToMark.length} notification${rowsToMark.length > 1 ? 's' : ''} read`, 'warn');
      }
    }
  };

  const onSwitched = () => {
    cache.current.clear();
    setVisited(new Set());
    setUi((u) => ({ ...u, cursors: {}, filter: '', collapsed: {} }));
    setStack([]);
    dash.reload();
  };

  const top = stack.at(-1);
  const contentW = Math.max(40, columns - SIDEBAR_W - 1);
  const contentH = rows - 1; // status line below
  const common = { width: contentW - 1, height: contentH, active: true, onAction }; // -1 for the left padding
  const login = dash.data?.login;
  const aiId = chatProviderId(config);
  const aiName = aiId ? resolve(config, aiId).name : null;

  if (setup) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <SetupScreen
          config={config}
          updateConfig={updateConfig}
          width={columns}
          height={rows - 1}
          suspendTerminal={suspendTerminal}
          toast={toast}
          onQuit={exit}
          onDone={() => {
            setSetup(false);
            goto(0);
            onSwitched();
          }}
        />
        <StatusLine toast={toastMsg} />
      </Box>
    );
  }

  let screen;
  if (top?.type === 'detail') screen = <DetailScreen key={top.item.url} {...common} item={top.item} getDetail={getDetail} />;
  else if (top?.type === 'diff') screen = <DiffScreen key={top.item.url} {...common} item={top.item} getDiff={getDiff} />;
  else if (top?.type === 'ai')
    screen = <AiScreen key={`${top.item.url}:${top.prompt ?? ''}`} {...common} item={top.item} login={login} config={config} getDetail={getDetail} getDiff={getDiff} initialPrompt={top.prompt} providerId={top.providerId} />;
  else if (top?.type === 'menu')
    screen = <MenuScreen key={top.item.url} {...common} item={top.item} login={login} config={config} getDetail={getDetail} focus={top.focus} archived={isArchived(archived, top.item)} toast={toast} />;
  else if (top?.type === 'compose')
    screen = <ComposeScreen key={top.item.url} {...common} item={top.item} login={login} config={config} getDetail={getDetail} getDiff={getDiff} toast={toast} />;
  else if (top?.type === 'handoff')
    screen = (
      <HandoffScreen
        key={top.item.url}
        {...common}
        item={top.item}
        initialTask={top.task}
        initialNotes={top.notes}
        login={login}
        config={config}
        updateConfig={updateConfig}
        getDetail={getDetail}
        suspendTerminal={suspendTerminal}
        toast={toast}
      />
    );
  else if (top?.type === 'help') screen = <HelpScreen {...common} />;
  else if (current.key === 'home') screen = <HomeScreen {...common} tabs={tabs} hidden={hidden} login={login} config={config} loading={dash.loading} hasData={Boolean(dash.data)} />;
  else if (current.key === 'settings')
    screen = <SettingsScreen {...common} config={config} updateConfig={updateConfig} archivedCount={Object.keys(archived).length} onSwitched={onSwitched} suspendTerminal={suspendTerminal} toast={toast} />;
  else
    screen = (
      <ListScreen {...common} key={current.key} tab={current} ui={ui} setUi={setUi} config={config} visited={visited} loading={dash.loading} error={dash.error} hasData={Boolean(dash.data)} />
    );

  const scopeText = [...scope.repos, ...scope.orgs.map((o) => `${o}/*`)].join(', ');
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box height={contentH}>
        <Sidebar
          sections={sections}
          current={section}
          visited={visited}
          login={login}
          aiName={aiName}
          loading={dash.loading}
          fetchedAt={dash.fetchedAt}
          height={contentH}
          scopeText={scopeText}
          onSelect={goto}
          onAction={onAction}
        />
        <Box flexDirection="column" width={contentW} paddingLeft={1}>
          {screen}
        </Box>
      </Box>
      <StatusLine toast={toastMsg} error={dash.data ? dash.error : null} warnings={dash.data?.warnings} />
    </Box>
  );
}

function StatusLine({ toast, error, warnings }) {
  if (toast) return <Text color={toneColor(toast.tone)} wrap="truncate">{` ${toast.text}`}</Text>;
  if (error) return <Text color="red" wrap="truncate">{` ✗ refresh failed: ${error}`}</Text>;
  if (warnings?.length) return <Text color="yellow" wrap="truncate">{` ⚠ ${warnings[0]}`}</Text>;
  return <Text> </Text>;
}
