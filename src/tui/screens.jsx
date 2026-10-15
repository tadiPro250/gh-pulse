import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { mergeStatus } from '../ai/actions.js';
import { detailLines, diffLines } from './format.js';
import { Keys, Rule, Spinner, TopBar, Viewport, scrollLabel, useScroll } from './ui.jsx';

// Loads something async, reloadable with force=true.
function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true });
  const load = (force = false) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    fn(force).then(
      (value) => setState({ value, loading: false }),
      (err) => setState({ error: err.message, loading: false }),
    );
  };
  useEffect(() => load(false), deps);
  return { ...state, reload: () => load(true) };
}

function Body({ state, lines, scroll, height, label }) {
  if (state.error) return <Box height={height}><Text color="red">{`  ✗ ${state.error}  (r to retry)`}</Text></Box>;
  if (!state.value) return <Box height={height}><Text>{'  '}<Spinner /> <Text dimColor>{label}</Text></Text></Box>;
  return (
    <Box paddingLeft={1} height={height}>
      <Viewport lines={lines} offset={scroll.offset} height={height} />
    </Box>
  );
}

export function DetailScreen({ item, getDetail, width, height, active, onAction }) {
  const state = useAsync((force) => getDetail(item, force), [item.url]);
  const lines = useMemo(() => (state.value ? detailLines(state.value, width - 3) : []), [state.value, width]);
  const bodyH = height - 3;
  const scroll = useScroll(lines.length, bodyH);
  const mergeable = mergeStatus(state.value).ok;

  useInput(
    (input, key) => {
      if (key.escape || input === 'q' || key.leftArrow || key.backspace) return onAction('back');
      if (scroll.handle(input, key)) return;
      if (input === 'r') return state.reload();
      if (input === 'm' && mergeable) return onAction('ai', item, { focus: 'merge' });
      const byKey = { o: 'open', y: 'copy', a: 'ai', e: 'ai', f: 'ai', d: 'diff', c: 'checkout' };
      if (byKey[input]) onAction(byKey[input], item);
    },
    { isActive: active },
  );

  const keys = [['↑↓', 'scroll'], ['a', 'AI'], ...(mergeable ? [['m', 'merge']] : []), ['o', 'browser'], ...(item.kind === 'pr' ? [['d', 'diff']] : []), ['esc', 'back']];
  return (
    <Box flexDirection="column" height={height}>
      <TopBar item={item} right={state.loading && state.value ? <Spinner /> : null} />
      <Rule width={width} />
      <Body state={state} lines={lines} scroll={scroll} height={bodyH} label="loading details…" />
      <Keys keys={keys} right={state.value ? scrollLabel(scroll, bodyH, lines.length) : null} />
    </Box>
  );
}

export function DiffScreen({ item, getDiff, width, height, active, onAction }) {
  const state = useAsync((force) => getDiff(item, force), [item.url]);
  const lines = useMemo(() => (state.value ? diffLines(state.value) : []), [state.value]);
  const files = useMemo(() => lines.map((l, i) => (l[0]?.text.startsWith('▌ ') ? i : -1)).filter((i) => i >= 0), [lines]);
  const bodyH = height - 3;
  const scroll = useScroll(lines.length, bodyH);

  useInput(
    (input, key) => {
      if (key.escape || input === 'q' || key.leftArrow || key.backspace) return onAction('back');
      if (scroll.handle(input, key)) return;
      // ] / [ jump between files
      if (input === ']') scroll.scrollTo((o) => files.find((f) => f > o) ?? o);
      if (input === '[') scroll.scrollTo((o) => [...files].reverse().find((f) => f < o) ?? 0);
      if (input === 'a' || input === 'e') onAction('ai', item);
      if (input === 'o') onAction('open', item);
      if (input === 'r') state.reload();
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" height={height}>
      <TopBar item={item} label="diff" right={files.length ? <Text dimColor>{`${files.length} files`}</Text> : null} />
      <Rule width={width} />
      <Body state={state} lines={lines} scroll={scroll} height={bodyH} label="loading diff…" />
      <Keys
        keys={[['↑↓', 'scroll'], ['[ ]', 'files'], ['a', 'AI'], ['esc', 'back']]}
        right={state.value ? scrollLabel(scroll, bodyH, lines.length) : null}
      />
    </Box>
  );
}

const HELP = [
  ['Everywhere', [
    ['←→  1–8', 'switch section'],
    ['s', 'settings · accounts, AI, theme'],
    ['r', 'refresh'],
    ['q', 'quit'],
  ]],
  ['Items', [
    ['⏎', 'details'],
    ['a', 'AI · suggestions that fit the item, or your own prompt'],
    ['m', 'merge (PRs that are ready)'],
    ['o  y', 'browser · copy link'],
    ['d  c', 'diff · check out (PRs)'],
  ]],
  ['Lists', [
    ['/', 'filter'],
    ['v', 'group by repo'],
    ['z', 'fold all repos'],
    ['m  M', 'mark read · everything (Inbox)'],
    ['t', 'show quiet PRs (Follow-up)'],
  ]],
  ['Chat', [
    ['tab', 'type (Home) · cycle quick prompts'],
    ['1–9', 'quick prompt'],
    ['ctrl+t', 'show thinking'],
    ['ctrl+o', 'show what the AI sees'],
    ['ctrl+l', 'clear'],
    ['esc', 'stop · back'],
  ]],
  ['AI menu', [
    ['⏎  1–9', 'run a suggestion'],
    ['agent', 'a coding agent edits your clone (you push)'],
    ['ask', 'the chat answers about the item'],
    ['merge', 'gh pr merge · ←→ method, b delete branch, ⏎ twice'],
    ['custom', 'type a prompt · tab: ask or agent'],
    ['write', 'leave a comment (opens the composer)'],
    ['pr', 're-review (←→ who) · draft / ready · close (⏎ twice)'],
    ['', 'delete branch: merged PRs whose branch nothing else uses'],
    ['pulse', 'archive: hidden until new activity · Settings restores'],
  ]],
  ['Comment', [
    ['type  ⏎', 'write · new line (markdown works)'],
    ['tab', 'body → attach → ask AI'],
    ['attach', '.md or text file path, or an image URL'],
    ['ask AI', 'drafts it, or rewrites what you wrote · ctrl+z undo'],
    ['ctrl+p', 'preview'],
    ['ctrl+s', 'post'],
    ['ctrl+b', 'finish in the browser (copies it) · for local images'],
  ]],
  ['Agent', [
    ['↑↓  ←→', 'pick field · change it'],
    ['type', 'notes for the agent'],
    ['C', 'clone the repo'],
    ['⏎', 'launch · checks out the branch, runs the agent in your clone'],
  ]],
  ['Reading', [
    ['↑↓ space b', 'scroll'],
    ['g  G', 'top · bottom'],
    ['[  ]', 'prev · next file (diff)'],
  ]],
  ['Mouse', [
    ['click', 'select a tab, row or setting'],
    ['click again', 'open it (or double-click)'],
    ['wheel', 'scroll'],
    ['key hints', 'click one to press it'],
    ['shift+drag', 'select text (or Settings → Mouse off)'],
  ]],
  ['Markers', [
    ['●', 'cyan new · yellow updated'],
  ]],
];

const HELP_LINES = HELP.flatMap(([title, rows]) => [
  [{ text: title, bold: true, color: 'accent' }],
  ...rows.map(([k, v]) => [{ text: `  ${k.padEnd(12)}`, bold: true }, { text: v, dim: true }]),
  [],
]);

export function HelpScreen({ width, height, active, onAction }) {
  const bodyH = height - 3;
  const scroll = useScroll(HELP_LINES.length, bodyH);
  useInput(
    (input, key) => {
      if (!scroll.handle(input, key)) onAction('back');
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column" height={height}>
      <TopBar label="help" />
      <Rule width={width} />
      <Box paddingLeft={1} height={bodyH}>
        <Viewport lines={HELP_LINES} offset={scroll.offset} height={bodyH} />
      </Box>
      <Keys keys={[['↑↓', 'scroll'], ['any key', 'back']]} right={scrollLabel(scroll, bodyH, HELP_LINES.length)} />
    </Box>
  );
}
