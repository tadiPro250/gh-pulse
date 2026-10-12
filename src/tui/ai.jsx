import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { chatPresetsFor } from '../ai/actions.js';
import { buildSystemPrompt } from '../ai/context.js';
import { chatProviderId, createChat } from '../ai/index.js';
import { CHAT_KEYS, ChatPanel, useChat } from './chat.jsx';
import { Keys, Rule, Spinner, TopBar } from './ui.jsx';

const s = (text, style) => ({ text, ...style });

// Shown wherever a chat would be when nothing is linked yet.
export function setupLines(reason) {
  return [
    [s('No AI linked', { bold: true, color: 'yellow' }), ...(reason ? [s(`  ${reason}`, { dim: true })] : [])],
    [s('Press '), s('s', { bold: true }), s(' → AI and pick one: a coding agent, an API key, or a local model.', { dim: true })],
  ];
}

export function useChatProvider(config, providerId) {
  return useMemo(() => {
    const id = providerId ?? chatProviderId(config);
    if (!id) return { provider: null, error: null };
    try {
      return { provider: createChat(config, id), error: null };
    } catch (err) {
      return { provider: null, error: err.message };
    }
  }, [config, providerId]);
}

export function AiScreen({ item, login, config, getDetail, getDiff, initialPrompt, providerId, width, height, active, onAction }) {
  const { provider, error } = useChatProvider(config, providerId);
  const [detail, setDetail] = useState(null);
  // Same suggestions as the AI menu, so the quick prompts fit this item's state.
  const presets = useMemo(() => chatPresetsFor({ item, detail, login }), [item, detail, login]);
  const [system, setSystem] = useState(null);
  const [contextError, setContextError] = useState(null);

  // Gather the item (and the diff, for PRs) into the system prompt.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detail = await getDetail(item);
        if (!cancelled) setDetail(detail);
        const diff = item.kind === 'pr' ? await getDiff(item).catch(() => null) : null;
        if (!cancelled) setSystem(buildSystemPrompt({ login, item, detail, diff, maxChars: config.ai.maxContextChars }));
      } catch (err) {
        if (!cancelled) setContextError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.url]);

  // Open with the most useful question already asked.
  const chat = useChat({ provider, system, autoPrompt: initialPrompt ?? presets[0].prompt });

  const placeholder = contextError
    ? [[s(`✗ couldn't load ${item.ref}: ${contextError}`, { color: 'red' })]]
    : !provider
      ? setupLines(error)
      : [[s(`reading ${item.ref}…`, { dim: true })]];

  const status = chat.streaming ? (
    <Text>
      <Spinner /> <Text dimColor>generating</Text>
    </Text>
  ) : provider ? (
    <Text dimColor>{provider.name}</Text>
  ) : (
    <Text color="yellow">no AI linked</Text>
  );

  return (
    <Box flexDirection="column" height={height}>
      <TopBar item={item} label="AI" right={status} />
      <Rule width={width} />
      <ChatPanel
        chat={chat}
        system={system}
        presets={presets}
        placeholder={placeholder}
        inputHint={provider ? 'ask anything about this…' : 'esc, then s to link an AI'}
        width={width}
        height={height - 3}
        active={active}
        onEscape={() => onAction('back')}
      />
      <Keys keys={[...CHAT_KEYS(chat.streaming, presets.length), ['esc', chat.streaming ? 'stop' : 'back']]} />
    </Box>
  );
}
