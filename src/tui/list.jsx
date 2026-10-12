import { Box, Text, useInput } from 'ink';
import { fit, fitMeta, fitRef, layoutRows } from '../render.js';
import { accent } from '../theme.js';
import { wrap } from './format.js';
import { Clickable } from './mouse.jsx';
import { Keys, Rule, Spinner, editText, toneColor } from './ui.jsx';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const PREVIEW_H = 3;
const KIND_ORDER = ['issue', 'pr', 'link'];
const KIND_LABEL = { issue: ['Issues', 'issue'], pr: ['Pull requests', 'PR'], link: ['Other', 'other'] };
const AUTO_COLLAPSE_OVER = 25;

export function filterRows(rows, filter) {
  const q = filter.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => `${r.ref} ${r.title} ${r.author ?? ''} ${r.meta.map(([t]) => t).join(' ')}`.toLowerCase().includes(q));
}

// Repo → (issues, PRs, other) → rows. Repos with the most recent activity come first.
export function groupRows(rows) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const g = groups.get(r.repo) ?? { repo: r.repo, rows: [], latest: -Infinity, first: i };
    g.rows.push(r);
    g.latest = Math.max(g.latest, r.updatedAt ? Date.parse(r.updatedAt) : -i);
    groups.set(r.repo, g);
  });
  return [...groups.values()].sort((a, b) => b.latest - a.latest || a.first - b.first);
}

function buildEntries(rows, grouped, collapsed) {
  if (!grouped) return rows.map((row) => ({ type: 'row', id: row.id, row }));
  const entries = [];
  for (const g of groupRows(rows)) {
    const byKind = KIND_ORDER.map((k) => [k, g.rows.filter((r) => r.kind === k)]).filter(([, rs]) => rs.length);
    const id = `g:${g.repo}`;
    const isCollapsed = collapsed.has(id);
    entries.push({ type: 'group', id, repo: g.repo, rows: g.rows, byKind, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (const [kind, rs] of byKind) {
      if (byKind.length > 1) entries.push({ type: 'sub', id: `${id}:${kind}`, label: KIND_LABEL[kind][0], count: rs.length });
      for (const row of rs) entries.push({ type: 'row', id: row.id, row, nested: true });
    }
  }
  return entries;
}

export function isGrouped(ui, tab, config) {
  return ui.grouped[tab.key] ?? (tab.key === 'inbox' ? config.groupInbox : false);
}

export function collapsedSet(ui, tab, rows) {
  if (ui.collapsed[tab.key]) return ui.collapsed[tab.key];
  // A flooded list starts collapsed so the repo summary fits on one screen.
  const groups = groupRows(rows);
  if (rows.length > AUTO_COLLAPSE_OVER && groups.length > 1) return new Set(groups.map((g) => `g:${g.repo}`));
  return new Set();
}

// ui: { cursors, filter, filtering, showAll, grouped, collapsed }
export function ListScreen({ tab, ui, setUi, config, width, height, visited, loading, error, hasData, onAction, active }) {
  const rows = filterRows(tab.rows, ui.filter);
  const grouped = isGrouped(ui, tab, config);
  const collapsed = collapsedSet(ui, tab, rows);
  const entries = buildEntries(rows, grouped, ui.filter ? new Set() : collapsed);
  const cursor = clamp(ui.cursors[tab.key] ?? 0, 0, Math.max(0, entries.length - 1));
  const entry = entries[cursor];
  const selected = entry?.type === 'row' ? entry.row : null;
  const readyToMerge = selected?.section === 'mine' && selected.status?.rank === 2;
  const listH = Math.max(3, height - 4 - PREVIEW_H); // title, rule, [list], rule, [preview], keys

  const setCursor = (fn) =>
    setUi((u) => ({ ...u, cursors: { ...u.cursors, [tab.key]: clamp(fn(clamp(u.cursors[tab.key] ?? 0, 0, entries.length - 1)), 0, Math.max(0, entries.length - 1)) } }));
  const setFilter = (f) => setUi((u) => ({ ...u, filter: typeof f === 'function' ? f(u.filter) : f, cursors: { ...u.cursors, [tab.key]: 0 } }));
  const setCollapsed = (next) => setUi((u) => ({ ...u, collapsed: { ...u.collapsed, [tab.key]: next } }));

  // ⏎ (or a click on the highlighted entry): fold a repo group, or open a row.
  const activate = (e) => {
    if (e.type === 'group') {
      const next = new Set(collapsed);
      next.has(e.id) ? next.delete(e.id) : next.add(e.id);
      return setCollapsed(next);
    }
    if (e.type === 'row') onAction('detail', e.row);
  };
  // First click highlights, a second click (or a double click) opens.
  const clickEntry = (i, { double }) => {
    if (i === cursor || double) return activate(entries[i]);
    setCursor(() => i);
  };

  useInput(
    (input, key) => {
      if (ui.filtering) {
        if (key.return || key.downArrow) setUi((u) => ({ ...u, filtering: false }));
        else if (key.escape) setUi((u) => ({ ...u, filtering: false, filter: '' }));
        else editText(setFilter, input, key);
        return;
      }

      if (key.rightArrow || input === 'l') return onAction('nextSection');
      if (key.leftArrow || input === 'h') return onAction('prevSection');
      if (/^[1-8]$/.test(input)) return onAction('gotoSection', Number(input) - 1);

      if (key.upArrow || input === 'k') return setCursor((c) => c - 1);
      if (key.downArrow || input === 'j') return setCursor((c) => c + 1);
      if (key.pageUp) return setCursor((c) => c - listH);
      if (key.pageDown) return setCursor((c) => c + listH);
      if (key.home || input === 'g') return setCursor(() => 0);
      if (key.end || input === 'G') return setCursor(() => entries.length);

      if (input === '/') return setUi((u) => ({ ...u, filtering: true }));
      if (key.escape && ui.filter) return setFilter('');
      if (key.escape) return onAction('gotoSection', 0);
      if (input === 'q') return onAction('quit');
      if (input === 'r') return onAction('refresh');
      if (input === 's') return onAction('settings');
      if (input === '?') return onAction('help');
      if (input === 't' && tab.key === 'reviewed') return onAction('toggleAll');
      if (input === 'v') return setUi((u) => ({ ...u, grouped: { ...u.grouped, [tab.key]: !grouped }, cursors: { ...u.cursors, [tab.key]: 0 } }));
      if (input === 'z' && grouped) {
        const all = groupRows(rows).map((g) => `g:${g.repo}`);
        return setCollapsed(collapsed.size ? new Set() : new Set(all));
      }
      if (input === 'M' && tab.key === 'inbox') return onAction('markAllRead', null, rows);

      if (!entry) return;
      if (entry.type === 'group') {
        if (key.return || input === ' ') return activate(entry);
        if (input === 'm' && tab.key === 'inbox') return onAction('markAllRead', null, entry.rows);
        return;
      }
      if (!selected) return;
      if (key.return) return activate(entry);
      if (input === 'm' && readyToMerge) return onAction('ai', selected, { focus: 'merge' });
      const byKey = { o: 'open', y: 'copy', a: 'ai', e: 'ai', f: 'ai', d: 'diff', c: 'checkout', m: 'markRead' };
      if (byKey[input]) onAction(byKey[input], selected);
    },
    { isActive: active },
  );

  // Keep the cursor roughly centered once the list is taller than the viewport.
  const offset = clamp(cursor - Math.floor(listH / 2), 0, Math.max(0, entries.length - listH));
  const visible = entries.slice(offset, offset + listH);
  const shortRef = (r) => (grouped ? (r.number ? `#${r.number}` : r.subjectType ?? '—') : r.ref);
  const layoutInput = rows.map((r) => ({ ...r, ref: shortRef(r) }));
  const { refW, titleW, metaBudget } = layoutRows(layoutInput, width - 1, grouped ? 7 : 5);

  // Only what applies to the highlighted entry; ? lists the rest.
  const isGroup = entry?.type === 'group';
  const inbox = tab.key === 'inbox';
  const keys = isGroup
    ? [['⏎', entry.collapsed ? 'expand' : 'fold'], ...(inbox ? [['m', 'mark repo read']] : []), ['z', 'fold all'], ['/', 'filter'], ['?', 'all keys']]
    : [
        ['⏎', 'open'],
        ...(selected ? [['a', 'AI']] : []),
        ...(readyToMerge ? [['m', 'merge']] : []),
        ...(selected ? [['o', 'browser']] : []),
        ...(inbox && selected ? [['m', 'mark read']] : []),
        ['/', 'filter'],
        ['?', 'all keys'],
      ];

  return (
    <Box flexDirection="column" height={height}>
      {ui.filtering || ui.filter ? (
        <Text wrap="truncate">
          <Text bold>{` ${tab.title}`}</Text>
          <Text color={accent()}>{'   / '}</Text>
          <Text>{ui.filter}</Text>
          {ui.filtering ? <Text inverse> </Text> : null}
          <Text dimColor>{`  ${rows.length}/${tab.rows.length}`}</Text>
        </Text>
      ) : (
        <Text wrap="truncate">
          <Text bold>{` ${tab.title}`}</Text>
          <Text dimColor>{`  ${tab.rows.length}`}</Text>
          {tab.note ? <Text dimColor>{`  · ${tab.note}`}</Text> : null}
          {grouped ? <Text dimColor>{`  · ${groupRows(rows).length} repos`}</Text> : null}
        </Text>
      )}
      <Rule width={width} />

      <Box flexDirection="column" height={listH}>
        {!hasData && loading ? (
          <Text>
            {'  '}
            <Spinner /> <Text dimColor>loading…</Text>
          </Text>
        ) : !hasData && error ? (
          <Text color="red" wrap="wrap">{`  ✗ ${error}\n  press r to retry`}</Text>
        ) : !entries.length ? (
          <Text dimColor>{`  ✓ ${ui.filter ? 'no matches' : tab.empty}`}</Text>
        ) : (
          visible.map((e, i) => {
            const isSel = offset + i === cursor;
            if (e.type === 'sub') return <Text key={e.id} dimColor>{`      ${e.label} ${e.count}`}</Text>;
            return (
              <Clickable key={e.id} onClick={(m) => clickEntry(offset + i, m)}>
                {e.type === 'group' ? (
                  <GroupRow entry={e} selected={isSel} />
                ) : (
                  <Row row={{ ...e.row, ref: shortRef(e.row) }} nested={e.nested} selected={isSel} flag={visited.has(e.row.id) ? null : e.row.flag} {...{ refW, titleW, metaBudget }} />
                )}
              </Clickable>
            );
          })
        )}
      </Box>

      <Rule width={width} />
      <Clickable onClick={() => (entry ? activate(entry) : false)}>
        <Preview row={selected} group={entry?.type === 'group' ? entry : null} width={width} />
      </Clickable>
      <Keys keys={keys} right={entries.length > listH ? `${cursor + 1}/${entries.length}` : null} />
    </Box>
  );
}

function GroupRow({ entry, selected }) {
  const parts = entry.byKind.map(([k, rs]) => `${rs.length} ${KIND_LABEL[k][1]}${rs.length > 1 && k !== 'link' ? 's' : ''}`);
  return (
    <Text wrap="truncate">
      <Text color={accent()} bold>{selected ? ' ❯ ' : '   '}</Text>
      <Text color={accent()}>{entry.collapsed ? '▸ ' : '▾ '}</Text>
      <Text bold color={selected ? 'white' : 'cyan'}>{entry.repo}</Text>
      <Text dimColor>{`  ${entry.rows.length}  ·  ${parts.join(' · ')}`}</Text>
    </Text>
  );
}

function Row({ row, nested, selected, flag, refW, titleW, metaBudget }) {
  const meta = fitMeta(row.meta, metaBudget);
  return (
    <Text wrap="truncate">
      <Text color={accent()} bold>{selected ? ' ❯ ' : '   '}</Text>
      {nested ? '  ' : ''}
      <Text color={flag === 'new' ? 'cyan' : 'yellow'}>{flag ? '● ' : '  '}</Text>
      <Text color="cyan" bold={selected}>{fitRef(row.ref, refW)}</Text>
      <Text bold={selected}>{`  ${fit(row.title, titleW)}  `}</Text>
      {meta.map(([t, tone], i) => (
        <Text key={i}>
          {i ? <Text dimColor> · </Text> : null}
          <Text color={toneColor(tone)}>{t}</Text>
        </Text>
      ))}
    </Text>
  );
}

// Full title and every meta segment for the highlighted row — the list truncates both.
function Preview({ row, group, width }) {
  if (group) {
    const reasons = {};
    for (const r of group.rows) if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    const summary = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ');
    return (
      <Box flexDirection="column" height={PREVIEW_H} paddingLeft={1}>
        <Text bold wrap="truncate">{group.repo}</Text>
        <Text dimColor wrap="truncate">{summary || `${group.rows.length} items`}</Text>
      </Box>
    );
  }
  if (!row) return <Box height={PREVIEW_H} />;
  const title = wrap(row.title, width - 4).slice(0, PREVIEW_H - 1);
  return (
    <Box flexDirection="column" height={PREVIEW_H} paddingLeft={1}>
      {title.map((l, i) => (
        <Text key={i} bold wrap="truncate">
          {l}
        </Text>
      ))}
      <Text wrap="truncate">
        <Text dimColor>{`${row.repo}  `}</Text>
        {row.meta.map(([t, tone], i) => (
          <Text key={i}>
            {i ? <Text dimColor> · </Text> : null}
            <Text color={toneColor(tone)}>{t}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
