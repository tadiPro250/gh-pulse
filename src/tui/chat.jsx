// A streaming chat panel: transcript, quick prompts and an input line.
// Used by the Home screen (dashboard as context) and per-item AI screens.
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { accent } from '../theme.js';
import { chatLines, plainLines } from './format.js';
import { Clickable } from './mouse.jsx';
import { Rule, Spinner, Viewport, editText, useScroll } from './ui.jsx';

// Some models inline their reasoning as <think>…</think> instead of a separate field.
function splitThinking(m) {
  const t = m.content.match(/^\s*<think>([\s\S]*?)(?:<\/think>|$)/);
  if (!t) return m;
  return { ...m, thinking: (m.thinking ?? '') + t[1], content: m.content.slice(t[0].length).trimStart() };
}

export function useChat({ provider, system, autoPrompt }) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef(null);
  const autoSent = useRef(false);

  const send = async (text) => {
    if (!text?.trim() || streaming || !system || !provider) return;
    const history = [...messages.filter((m) => !m.error).map(splitThinking), { role: 'user', content: text.trim() }];
    setMessages([...history, { role: 'assistant', content: '', thinking: '' }]);
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const updateLast = (fn) => setMessages((ms) => [...ms.slice(0, -1), fn(ms.at(-1))]);
    try {
      const wire = [{ role: 'system', content: system }, ...history.map(({ role, content }) => ({ role, content }))];
      for await (const chunk of provider.stream(wire, ctrl.signal)) {
        if (chunk.type === 'thinking') updateLast((m) => ({ ...m, thinking: m.thinking + chunk.text }));
        else updateLast((m) => ({ ...m, content: m.content + chunk.text }));
      }
    } catch (err) {
      if (ctrl.signal.aborted) updateLast((m) => ({ ...m, content: `${m.content}${m.content ? '\n\n' : ''}_(stopped)_` }));
      else updateLast((m) => ({ ...m, error: err.message }));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  useEffect(() => {
    if (autoPrompt && system && provider && !autoSent.current) {
      autoSent.current = true;
      send(autoPrompt);
    }
  }, [system, provider, autoPrompt]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    messages,
    streaming,
    send,
    stop: () => abortRef.current?.abort(),
    clear: () => !streaming && setMessages([]),
  };
}

// placeholder: styled lines shown before the first message (or when no provider)
// onFocus: the panel was clicked while inactive (Home uses it to move focus into the chat).
export function ChatPanel({ chat, system, presets, placeholder, inputHint, width, height, active, onEscape, onFocus }) {
  const [input, setInputState] = useState('');
  const [presetIdx, setPresetIdx] = useState(-1);
  const [showThinking, setShowThinking] = useState(false);
  const [showContext, setShowContext] = useState(false);
  // Keys can arrive faster than renders (paste + Enter in one chunk), so the
  // ref is the source of truth for what has been typed.
  const inputRef = useRef('');
  const setInput = (f) => {
    inputRef.current = typeof f === 'function' ? f(inputRef.current) : f;
    setInputState(inputRef.current);
  };

  const textW = width - 3;
  const lines = useMemo(() => {
    if (showContext) return plainLines(system ?? 'building context…', textW);
    if (!chat.messages.length) return placeholder ?? [];
    return chatLines(chat.messages.map(splitThinking), textW, { showThinking });
  }, [showContext, system, chat.messages, showThinking, textW, placeholder]);

  const bodyH = Math.max(2, height - 3); // [body], rule, presets, input
  const chatScroll = useScroll(showContext ? 0 : lines.length, bodyH, { follow: true });
  const contextScroll = useScroll(showContext ? lines.length : 0, bodyH);
  const scroll = showContext ? contextScroll : chatScroll;

  // Quick prompts are laid out as " 1 label  2 label …"; a click sends the one under the pointer.
  const clickPreset = (x) => {
    let at = 0;
    for (const p of presets.map((p, i) => ({ ...p, w: String(i + 1).length + p.label.length + 3 }))) {
      if (x < at + p.w) return void chat.send(p.prompt);
      at += p.w;
    }
    return false;
  };

  useInput(
    (ch, key) => {
      if (key.escape) {
        if (chat.streaming) chat.stop();
        else if (showContext) setShowContext(false);
        else onEscape?.();
        return;
      }
      if (key.ctrl && ch === 'o') return setShowContext((v) => !v);
      if (key.ctrl && ch === 't') return setShowThinking((v) => !v);
      if (key.ctrl && ch === 'l') return chat.clear();
      if (scroll.handle(ch, key, { letters: false })) return;
      if (key.return) {
        chat.send(inputRef.current);
        setInput('');
        setPresetIdx(-1);
        return;
      }
      if (key.tab && presets.length) {
        const next = (presetIdx + 1) % presets.length;
        setPresetIdx(next);
        setInput(presets[next].prompt);
        return;
      }
      // Digits pick a quick prompt when nothing has been typed yet.
      if (!inputRef.current && /^[1-9]$/.test(ch) && presets[Number(ch) - 1]) return chat.send(presets[Number(ch) - 1].prompt);
      editText(setInput, ch, key);
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" height={height}>
      <Clickable paddingLeft={1} height={bodyH} onClick={() => (active ? false : onFocus?.())} onWheel={(d) => scroll.scrollTo((o) => o + d * 3)}>
        <Viewport lines={lines} offset={scroll.offset} height={bodyH} />
      </Clickable>
      <Rule width={width} />
      <Clickable onClick={({ x }) => clickPreset(x)}>
        <Text wrap="truncate">
          {presets.map((p, i) => (
            <Text key={p.label}>
              <Text bold>{` ${i + 1}`}</Text>
              <Text dimColor={i !== presetIdx} color={i === presetIdx ? accent() : undefined}>{` ${p.label} `}</Text>
            </Text>
          ))}
          {showContext ? <Text color={accent()}> · context sent to the AI</Text> : null}
        </Text>
      </Clickable>
      <Clickable onClick={() => onFocus?.()}>
        <Text wrap="truncate">
          <Text color={active ? accent() : 'gray'} bold>
            {' › '}
          </Text>
          {chat.streaming ? (
            <Text>
              <Spinner /> <Text dimColor>thinking · esc stops</Text>
            </Text>
          ) : input ? (
            <Text>{input.length > width - 6 ? '…' + input.slice(-(width - 7)) : input}</Text>
          ) : (
            <Text dimColor>{inputHint}</Text>
          )}
          {active && !chat.streaming ? <Text inverse> </Text> : null}
        </Text>
      </Clickable>
    </Box>
  );
}

// The rest (ctrl+o context, ctrl+l clear) are on the help screen.
export const CHAT_KEYS = (streaming, n) => [
  ['⏎', 'send'],
  [`1-${n}`, 'quick prompt'],
  ['↑↓', 'scroll'],
  ['ctrl+t', 'thinking'],
];
