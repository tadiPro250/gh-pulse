import { Box, Text, useAnimation } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { TONES } from '../render.js';
import { accent } from '../theme.js';
import { Clickable, keySequence, sendKeys } from './mouse.jsx';

export const toneColor = (tone) => TONES[tone] ?? tone;

export function Line({ segs }) {
  if (!segs?.length || segs.every((x) => !x.text)) return <Text> </Text>; // empty Text has no height
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text key={i} color={toneColor(s.color)} bold={s.bold} dimColor={s.dim} italic={s.italic}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function Viewport({ lines, offset, height }) {
  const visible = lines.slice(offset, offset + height);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map((l, i) => (
        <Line key={offset + i} segs={l} />
      ))}
    </Box>
  );
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Scroll state for a Viewport. With `follow`, stays pinned to the bottom as
// lines are appended (chat streaming) until the user scrolls up.
export function useScroll(count, height, { follow = false } = {}) {
  const [offset, setOffset] = useState(0);
  const max = Math.max(0, count - height);
  const pinned = useRef(follow);

  useEffect(() => {
    setOffset((o) => (pinned.current ? max : clamp(o, 0, max)));
  }, [max]);

  const scrollTo = (next) => {
    setOffset((o) => {
      const v = clamp(typeof next === 'function' ? next(o) : next, 0, max);
      pinned.current = follow && v >= max;
      return v;
    });
  };

  // Returns true when the key was a scroll key. `letters` enables j/k/g/G/space.
  const handle = (input, key, { letters = true } = {}) => {
    const page = Math.max(1, height - 2);
    if (key.upArrow || (letters && input === 'k')) scrollTo((o) => o - 1);
    else if (key.downArrow || (letters && input === 'j')) scrollTo((o) => o + 1);
    else if (key.pageUp || (letters && input === 'b')) scrollTo((o) => o - page);
    else if (key.pageDown || (letters && input === ' ')) scrollTo((o) => o + page);
    else if (key.home || (letters && input === 'g')) scrollTo(0);
    else if (key.end || (letters && input === 'G')) scrollTo(max);
    else return false;
    return true;
  };

  return { offset: clamp(offset, 0, max), max, handle, scrollTo };
}

export function scrollLabel({ offset, max }, height, count) {
  if (count <= height) return 'all';
  if (offset === 0) return 'top';
  if (offset >= max) return 'end';
  return `${Math.round((offset / max) * 100)}%`;
}

export function Spinner({ color }) {
  const { frame } = useAnimation({ interval: 80 });
  const chars = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  return <Text color={color ?? accent()}>{chars[frame % chars.length]}</Text>;
}

// Re-render periodically so relative times ("2m ago") stay current.
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function Rule({ width }) {
  return <Text dimColor>{'─'.repeat(Math.max(0, width))}</Text>;
}

// keys: [['↑↓', 'move'], ['⏎', 'open'], ...]
// A row whose left side truncates so the right side never overlaps it.
export function Split({ left, right }) {
  return (
    <Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">{left}</Text>
      </Box>
      {right ? (
        <Box flexShrink={0} paddingLeft={2}>
          <Text>{right} </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// Each hint is also a button: clicking "⏎ open" presses ⏎.
export function Keys({ keys, right }) {
  const left = keys.map(([k, label], i) => (
    <Text key={i}>
      <Text bold>{` ${k}`}</Text>
      <Text dimColor>{` ${label} `}</Text>
    </Text>
  ));
  const onClick = ({ x }) => {
    let at = 0;
    for (const [k, label] of keys) {
      const w = k.length + label.length + 3;
      if (x < at + w) {
        const seq = keySequence(k);
        if (!seq) return false;
        return void sendKeys(seq);
      }
      at += w;
    }
    return false;
  };
  return (
    <Clickable onClick={onClick}>
      <Split left={left} right={right ? <Text dimColor>{right}</Text> : null} />
    </Clickable>
  );
}

// Breadcrumb bar shown at the top of every non-list screen.
export function TopBar({ item, label, right }) {
  const left = (
    <>
      <Text dimColor> ← esc  </Text>
      {label ? <Text bold color={accent()}>{label}  </Text> : null}
      {item ? <Text color="cyan">{`${item.repo}#${item.number ?? ''}`}</Text> : null}
      {item ? <Text dimColor>{`  ${item.title}`}</Text> : null}
    </>
  );
  // "← esc" is a back button.
  return (
    <Clickable onClick={({ x }) => (x < 8 ? void sendKeys('') : false)}>
      <Split left={left} right={right} />
    </Clickable>
  );
}

// Minimal single-line text input, driven by the screen's useInput. Uses
// functional updates so keys arriving in one chunk aren't lost.
// Returns true when the key edited the value.
export function editText(setValue, input, key) {
  if (key.backspace || key.delete) {
    setValue((v) => v.slice(0, -1));
    return true;
  }
  if (key.ctrl && input === 'u') {
    setValue('');
    return true;
  }
  if (input && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape) {
    setValue((v) => v + input.replace(/[\r\n]+/g, ' '));
    return true;
  }
  return false;
}
