// Home: what needs you right now, plus a chat that sees the whole dashboard.
import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { HOME_PRESETS, buildHomeSystemPrompt } from '../ai/tasks.js';
import { fit, fitRef } from '../render.js';
import { accent } from '../theme.js';
import { setupLines, useChatProvider } from './ai.jsx';
import { CHAT_KEYS, ChatPanel, useChat } from './chat.jsx';
import { Clickable } from './mouse.jsx';
import { Keys, toneColor } from './ui.jsx';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The prioritized "do this next" list, built from the dashboard tabs.
export function nextUp(tabs) {
  const rows = (k) => tabs.find((t) => t.key === k)?.rows ?? [];
  const out = [];
  const seen = new Set();
  const add = (row, badge, tone, why, fixable = false) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ row, badge, tone, why, fixable });
  };
  for (const r of rows('mine')) if (r.status?.rank <= 1) add(r, 'fix', 'bad', r.status.label, true);
  for (const r of rows('review')) add(r, 'review', 'warn', `${r.meta[1]?.[0] ?? 'review requested'} · by @${r.author}`);
  for (const r of rows('reviewed')) add(r, 'follow-up', 'ok', r.meta[1]?.[0] ?? 'changed since your review');
  for (const r of rows('mine')) if (r.status?.rank === 2) add(r, 'merge', 'good', r.status.label);
  for (const r of rows('assigned')) {
    const soon = r.dueAt && new Date(r.dueAt) - Date.now() < 7 * 864e5;
    if (soon || r.flag === 'new') add(r, 'issue', 'accent', soon ? r.meta[0][0] : 'newly assigned', true);
  }
  for (const r of rows('mentions')) if (r.flag) add(r, 'mention', 'dim', `@${r.author} mentioned you`);
  // Short list? Top up with the most recently active assigned issues.
  for (const r of rows('assigned')) if (out.length < 5) add(r, 'issue', 'accent', r.meta.find(([t]) => t.startsWith('updated'))?.[0] ?? 'assigned to you', true);
  return out;
}

// The numbers Home can show under the greeting; config.homeStats picks which.
// count({ tab, items }) gets a section's row count and the Next up list.
export const HOME_STATS = [
  { id: 'fix', label: 'to fix', tone: 'bad', about: 'your PRs with conflicts, failing CI or requested changes', count: ({ items }) => items.filter((i) => i.badge === 'fix').length },
  { id: 'review', label: 'to review', tone: 'warn', about: 'review requests', count: ({ tab }) => tab('review') },
  { id: 'reviewed', label: 'to follow up', tone: 'ok', about: 'PRs that changed since you reviewed', count: ({ tab }) => tab('reviewed') },
  { id: 'merge', label: 'ready to merge', tone: 'good', about: 'your approved, green PRs', count: ({ items }) => items.filter((i) => i.badge === 'merge').length },
  { id: 'mine', label: 'open PRs', tone: null, about: 'all your open PRs', count: ({ tab }) => tab('mine') },
  { id: 'assigned', label: 'issues', tone: null, about: 'issues assigned to you', count: ({ tab }) => tab('assigned') },
  { id: 'mentions', label: 'mentions', tone: null, about: 'recent mentions', count: ({ tab }) => tab('mentions') },
  { id: 'inbox', label: 'unread', tone: 'warn', about: 'unread notifications', count: ({ tab }) => tab('inbox') },
];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function HomeScreen({ tabs, hidden = [], login, config, loading, hasData, width, height, active, onAction }) {
  const [focus, setFocus] = useState('list');
  const [cursor, setCursor] = useState(0);
  // Hidden sections stay out of Next up too; the chat still sees everything.
  const items = useMemo(() => nextUp(tabs.filter((t) => !hidden.includes(t.key))), [tabs, hidden.join()]);
  const { provider, error } = useChatProvider(config);
  const system = useMemo(() => (hasData ? buildHomeSystemPrompt({ login, tabs, maxChars: config.ai.maxContextChars }) : null), [tabs, login, hasData]);
  const chat = useChat({ provider, system });

  const tab = (k) => tabs.find((t) => t.key === k)?.rows.length ?? 0;
  // [number, label, tone when non-zero]
  const stats = HOME_STATS.filter((st) => (config.homeStats ?? []).includes(st.id)).map((st) => [st.count({ tab, items }), st.label, st.tone]);

  const listH = clamp(items.length || 1, 1, Math.max(1, Math.min(8, height - 14)));
  const chatH = Math.max(5, height - 4 - listH - 2); // greeting, stats, rule, [list], rule, [chat], keys
  const sel = items[clamp(cursor, 0, Math.max(0, items.length - 1))];
  const offset = clamp(cursor - listH + 1, 0, Math.max(0, items.length - listH));

  useInput(
    (input, key) => {
      if (key.tab) return setFocus('chat');
      if (key.rightArrow || input === 'l') return onAction('nextSection');
      if (key.leftArrow || input === 'h') return onAction('prevSection');
      if (/^[1-8]$/.test(input)) return onAction('gotoSection', Number(input) - 1);
      if (input === 's') return onAction('settings');
      if (input === 'r') return onAction('refresh');
      if (input === '?') return onAction('help');
      if (input === 'q') return onAction('quit');
      if (key.upArrow || input === 'k') return setCursor((c) => clamp(c - 1, 0, items.length - 1));
      if (key.downArrow || input === 'j') return setCursor((c) => clamp(c + 1, 0, items.length - 1));
      if (!sel) return;
      if (key.return) return onAction('detail', sel.row);
      if (input === 'm' && sel.badge === 'merge') return onAction('ai', sel.row, { focus: 'merge' });
      // a opens the AI menu; e and f are kept as aliases from older versions.
      const byKey = { a: 'ai', e: 'ai', f: 'ai', o: 'open', d: 'diff', y: 'copy' };
      if (byKey[input]) onAction(byKey[input], sel.row);
    },
    { isActive: active && focus === 'list' },
  );

  const s = (text, style) => ({ text, ...style });
  const placeholder = !provider ? setupLines(error) : [[s('It can see your whole dashboard. Pick a quick prompt below or type.', { dim: true })]];

  // Repo name without the owner keeps refs short enough to leave room for titles.
  const shortRef = (r) => (r.number ? `${r.repo.split('/')[1]}#${r.number}` : r.repo);
  const badgeW = 10;
  const refW = Math.min(28, Math.max(8, ...items.map((i) => shortRef(i.row).length)));
  const whyW = Math.min(24, Math.max(0, ...items.map((i) => i.why.length)));
  const titleW = Math.max(10, width - 4 - badgeW - refW - whyW - 6);

  const listKeys = [['⏎', 'open'], ['a', 'AI'], ...(sel?.badge === 'merge' ? [['m', 'merge']] : []), ['tab', 'chat'], ['?', 'all keys']];
  const chatKeys = [...CHAT_KEYS(chat.streaming, HOME_PRESETS.length), ['esc', chat.streaming ? 'stop' : 'list']];

  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate">
        <Text bold>{` ${greeting()}, `}</Text>
        <Text bold color={accent()}>{login ? `@${login}` : '…'}</Text>
        {loading && !hasData ? <Text dimColor>  · loading…</Text> : null}
      </Text>
      <Text wrap="truncate">
        {!stats.length ? ' ' : null}
        {stats.map(([n, label, tone], i) => (
          <Text key={i} dimColor={!n}>
            {i ? '   ' : ' '}
            <Text bold color={n ? toneColor(tone) : undefined}>{n}</Text>
            {` ${label}`}
          </Text>
        ))}
      </Text>
      <SectionRule label="Next up" width={width} />
      <Box flexDirection="column" height={listH}>
        {!items.length ? (
          <Text dimColor>{hasData ? '  ✓ nothing needs you right now' : '  …'}</Text>
        ) : (
          items.slice(offset, offset + listH).map((it, i) => {
            const selected = focus === 'list' && offset + i === cursor;
            // First click highlights, a second click (or a double click) opens.
            const onClick = ({ double }) => {
              if (selected || double) return onAction('detail', it.row);
              setFocus('list');
              setCursor(offset + i);
            };
            return (
              <Clickable key={it.row.id} onClick={onClick}>
                <Text wrap="truncate">
                  <Text color={accent()} bold>{selected ? ' ❯ ' : '   '}</Text>
                  <Text color={toneColor(it.tone)} bold>{fit(it.badge, badgeW)}</Text>
                  <Text color="cyan" bold={selected}>{fitRef(shortRef(it.row), refW)}</Text>
                  <Text bold={selected}>{`  ${fit(it.row.title, titleW)}  `}</Text>
                  <Text color={toneColor(it.tone)}>{fit(it.why, whyW)}</Text>
                </Text>
              </Clickable>
            );
          })
        )}
      </Box>
      <SectionRule label="Ask pulse" right={provider ? provider.name : 'no AI linked'} width={width} />
      <ChatPanel
        chat={chat}
        system={system}
        presets={HOME_PRESETS}
        placeholder={placeholder}
        inputHint={provider ? (focus === 'chat' ? 'ask about your day…' : 'tab to type') : 's to link an AI'}
        width={width}
        height={chatH}
        active={active && focus === 'chat'}
        onEscape={() => setFocus('list')}
        onFocus={() => setFocus('chat')}
      />
      <Keys keys={focus === 'list' ? listKeys : chatKeys} />
    </Box>
  );
}

function SectionRule({ label, right, width }) {
  const tail = right;
  const used = label.length + 4 + (tail ? tail.length + 3 : 0);
  return (
    <Text wrap="truncate">
      <Text color={accent()} bold>{`── ${label} `}</Text>
      <Text dimColor>{'─'.repeat(Math.max(0, width - used))}</Text>
      {tail ? <Text dimColor>{` ${tail} `}</Text> : null}
    </Text>
  );
}
