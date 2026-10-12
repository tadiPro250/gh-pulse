// Left navigation: brand, account, sections with counts, AI + sync status.
import { Box, Text } from 'ink';
import { ago } from '../model.js';
import { accent } from '../theme.js';
import { Clickable } from './mouse.jsx';
import { Spinner, useTick } from './ui.jsx';

export const SIDEBAR_W = 24;

// onSelect(i): a section was clicked. onAction: 'help' / 'settings' from the footer.
export function Sidebar({ sections, current, visited, login, aiName, loading, fetchedAt, height, scopeText, onSelect, onAction }) {
  useTick(30000);
  const synced = fetchedAt ? (ago(fetchedAt) === 'now' ? 'synced just now' : `synced ${ago(fetchedAt)} ago`) : 'not synced yet';
  const inner = SIDEBAR_W - 3;
  const cut = (s, w = inner) => (s.length > w ? s.slice(0, w - 1) + '…' : s);

  return (
    <Box flexDirection="column" width={SIDEBAR_W} height={height} borderStyle="single" borderTop={false} borderLeft={false} borderBottom={false} borderColor="gray">
      <Text bold color={accent()}>{' ◆ pulse'}</Text>
      <Text bold>{` ${cut('@' + (login ?? '…'))}`}</Text>
      {scopeText ? <Text dimColor>{` ${cut(scopeText)}`}</Text> : null}
      <Text> </Text>
      {sections.map((s, i) => {
        const selected = i === current;
        const n = s.count;
        const fresh = s.rows?.some((r) => r.flag && !visited.has(r.id));
        const urgent = n > 0 && s.urgent;
        const label = `${i + 1} ${s.short}`;
        const countText = n === null || n === undefined ? '' : String(n);
        const pad = Math.max(1, inner - label.length - countText.length - 1);
        if (s.key === 'settings') {
          return (
            <Box key={s.key} flexDirection="column">
              <Text> </Text>
              <Clickable onClick={() => onSelect?.(i)}>
                <Text inverse={selected} bold={selected} color={selected ? accent() : undefined}>
                  {` ${label}`.padEnd(inner + 1)}
                </Text>
              </Clickable>
            </Box>
          );
        }
        if (selected) {
          return (
            <Clickable key={s.key} onClick={() => onSelect?.(i)}>
              <Text inverse bold color={accent()}>
                {` ${label}${' '.repeat(pad)}${countText} `}
              </Text>
            </Clickable>
          );
        }
        return (
          <Clickable key={s.key} onClick={() => onSelect?.(i)}>
            <Text>
              <Text dimColor={n === 0}>{` ${label}${' '.repeat(pad)}`}</Text>
              <Text color={urgent ? 'yellow' : undefined} dimColor={n === 0}>
                {countText}
              </Text>
              {fresh ? <Text color="cyan">●</Text> : ' '}
            </Text>
          </Clickable>
        );
      })}
      <Box flexGrow={1} />
      <Clickable onClick={() => onAction?.('settings')}>
        <Text dimColor>{' AI'}</Text>
        <Text color={aiName ? 'green' : 'yellow'} wrap="truncate">{` ${cut(aiName ?? 'not linked (s)')}`}</Text>
      </Clickable>
      <Text> </Text>
      <Text wrap="truncate">
        {loading ? (
          <Text>
            {' '}
            <Spinner /> <Text dimColor>syncing</Text>
          </Text>
        ) : (
          <Text dimColor>{` ${synced}`}</Text>
        )}
      </Text>
      <Clickable onClick={({ x }) => (x < 8 ? onAction?.('help') : false)}>
        <Text dimColor>{' ? help  q quit'}</Text>
      </Clickable>
    </Box>
  );
}
