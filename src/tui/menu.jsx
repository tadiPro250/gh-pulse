// The one AI entry point for a PR or issue: suggested actions that fit its
// state (fix requested changes, fix CI, explain, review…), merge when it's
// ready, and a custom prompt that either the chat or an agent can take.
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { actionsFor, mergeStatus } from '../ai/actions.js';
import { agentProviderId, chatProviderId, resolve } from '../ai/index.js';
import { fetchReviewThreads, summarizeChecks } from '../detail.js';
import { mergeMethods, mergePr } from '../github.js';
import { fit } from '../render.js';
import { accent } from '../theme.js';
import { Clickable } from './mouse.jsx';
import { Keys, Rule, Spinner, TopBar, editText, toneColor } from './ui.jsx';

const BADGES = { agent: ['agent', 'good'], chat: ['ask', 'ok'], merge: ['merge', 'accent'], custom: ['custom', 'dim'] };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// One line of state, so the suggestions make sense at a glance.
function statusSegments(item, d, login) {
  if (!d) return [['loading…', 'dim']];
  const segs = [[d.isDraft ? 'draft' : d.state.toLowerCase(), d.state === 'OPEN' ? 'good' : 'dim']];
  if (item.kind === 'pr') {
    const decision = { APPROVED: ['approved', 'good'], CHANGES_REQUESTED: ['changes requested', 'bad'], REVIEW_REQUIRED: ['review required', 'warn'] }[d.reviewDecision];
    if (decision) segs.push(decision);
    const c = summarizeChecks(d.statusCheckRollup);
    if (c.total) segs.push([`checks ${c.passed}/${c.total}`, c.failed.length ? 'bad' : c.pending.length ? 'warn' : 'good']);
    if (d.mergeable === 'CONFLICTING') segs.push(['conflicts', 'bad']);
    const m = mergeStatus(d);
    segs.push([m.ok ? 'ready to merge' : `can't merge: ${m.why}`, m.ok ? 'good' : 'dim']);
  } else {
    const mine = (d.assignees ?? []).some((a) => a.login === login);
    segs.push([mine ? 'assigned to you' : d.assignees?.length ? `assigned to @${d.assignees[0].login}` : 'unassigned', mine ? 'accent' : 'dim']);
    if (d.comments?.length) segs.push([`${d.comments.length} comment${d.comments.length > 1 ? 's' : ''}`, 'dim']);
    if (d.milestone?.dueOn) segs.push([`due ${d.milestone.dueOn.slice(0, 10)}`, 'warn']);
  }
  return segs;
}

export function MenuScreen({ item, login, config, getDetail, focus, width, height, active, onAction, toast }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [threads, setThreads] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [custom, setCustom] = useState('');
  const [customMode, setCustomMode] = useState('chat'); // 'chat' | 'agent'
  const [methods, setMethods] = useState(null);
  const [methodIdx, setMethodIdx] = useState(0);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDetail(item).then(setDetail, (e) => setError(e.message));
    if (item.kind === 'pr') fetchReviewThreads(item).then(setThreads, () => {});
  }, [item.url]);

  const options = useMemo(() => actionsFor({ item, detail, threads, login }), [item, detail, threads, login]);
  const hasMerge = options.some((o) => o.kind === 'merge');
  useEffect(() => {
    if (hasMerge && !methods) mergeMethods(item.repo).then(setMethods, () => setMethods(['merge']));
  }, [hasMerge]);
  // Opened with "merge" (m on a ready PR): land on it once it appears.
  useEffect(() => {
    if (focus && options.some((o) => o.id === focus)) setCursor(options.findIndex((o) => o.id === focus));
  }, [focus, options.length]);

  const pos = clamp(cursor, 0, options.length - 1);
  const sel = options[pos];
  const method = methods?.[methodIdx] ?? 'squash';
  const chatName = (() => {
    const id = chatProviderId(config);
    return id ? resolve(config, id).name : null;
  })();
  const agentName = (() => {
    const id = agentProviderId(config);
    return id ? resolve(config, id).name : null;
  })();

  const move = (d) => {
    setConfirmMerge(false);
    setCursor((c) => clamp(clamp(c, 0, options.length - 1) + d, 0, options.length - 1));
  };

  const merge = async () => {
    if (!confirmMerge) return setConfirmMerge(true);
    setBusy(true);
    try {
      await mergePr(item, method);
      toast(`merged ${item.ref} (${method})`, 'good');
      onAction('merged', item);
    } catch (err) {
      setBusy(false);
      setConfirmMerge(false);
      toast(`merge failed: ${err.message.split('\n')[0]}`, 'bad');
    }
  };

  const run = (o) => {
    if (!o || busy) return;
    if (o.kind === 'chat') return onAction('chat', item, { prompt: o.prompt });
    if (o.kind === 'agent') return onAction('agent', item, { task: o.task });
    if (o.kind === 'merge') return merge();
    if (o.kind === 'custom') {
      if (!custom.trim()) return toast('type your prompt first', 'warn');
      return customMode === 'chat' ? onAction('chat', item, { prompt: custom.trim() }) : onAction('agent', item, { task: 'custom', notes: custom.trim() });
    }
  };

  const step = (d) => {
    if (sel?.kind === 'merge' && methods?.length) {
      setConfirmMerge(false);
      setMethodIdx((i) => (i + d + methods.length) % methods.length);
    }
    if (sel?.kind === 'custom') setCustomMode((m) => (m === 'chat' ? 'agent' : 'chat'));
  };

  useInput(
    (input, key) => {
      if (busy) return;
      if (key.escape) return confirmMerge ? setConfirmMerge(false) : onAction('back');
      if (key.upArrow) return move(-1);
      if (key.downArrow) return move(1);
      if (key.leftArrow || key.rightArrow) return step(key.leftArrow ? -1 : 1);
      if (key.tab && sel?.kind === 'custom') return step(1);
      if (key.return) return run(sel);
      // On the custom row, typing goes into the prompt.
      if (sel?.kind === 'custom') return editText(setCustom, input, key);
      if (/^[1-9]$/.test(input) && options[Number(input) - 1]) {
        setCursor(Number(input) - 1);
        return run(options[Number(input) - 1]);
      }
      if (input === 'j') return move(1);
      if (input === 'k') return move(-1);
    },
    { isActive: active },
  );

  const labelW = Math.min(32, Math.max(...options.map((o) => o.label.length)) + 2);
  const clickOption = (i, { double }) => {
    if (i === pos || double) return run(options[i]);
    setConfirmMerge(false);
    setCursor(i);
  };

  // What happens on ⏎, said once for the highlighted row.
  const detailFor = (o) => {
    if (o.kind === 'chat') return chatName ? `${chatName} answers` : 'no AI linked · s → AI';
    if (o.kind === 'agent') return agentName ? `${agentName} works in your clone` : 'no agent linked · a chat model will plan it';
    if (o.kind === 'merge') return confirmMerge ? `⏎ again to merge into ${detail?.baseRefName ?? 'base'}` : '←→ method';
    return customMode === 'chat' ? 'tab: give it to an agent' : 'tab: ask instead';
  };

  return (
    <Box flexDirection="column" height={height}>
      <TopBar item={item} label="AI" right={busy || (!detail && !error) ? <Spinner /> : null} />
      <Rule width={width} />
      <Text wrap="truncate">
        {' '}
        {error ? (
          <Text color="red">{`✗ ${error}`}</Text>
        ) : (
          statusSegments(item, detail, login).map(([t, tone], i) => (
            <Text key={i}>
              {i ? <Text dimColor> · </Text> : null}
              <Text color={toneColor(tone)}>{t}</Text>
            </Text>
          ))
        )}
      </Text>
      <Text> </Text>
      {options.map((o, i) => {
        const isSel = i === pos;
        const [badge, tone] = BADGES[o.kind];
        return (
          <Clickable key={o.id} onClick={(m) => clickOption(i, m)}>
            <Text wrap="truncate">
              <Text color={accent()} bold>{isSel ? ' ❯ ' : '   '}</Text>
              <Text dimColor>{`${i + 1} `}</Text>
              <Text color={toneColor(tone)} bold>{fit(badge, 8)}</Text>
              <Text bold={isSel}>{o.kind === 'custom' ? fit(o.label, 15) : fit(o.label, labelW)}</Text>
              {o.kind === 'custom' ? (
                <>
                  <Text color={accent()}>{isSel ? '‹ ' : '  '}</Text>
                  <Text bold>{customMode === 'chat' ? 'ask' : 'agent'}</Text>
                  <Text color={accent()}>{isSel ? ' › ' : '   '}</Text>
                  {custom ? <Text>{custom}</Text> : <Text dimColor>{isSel ? 'type your prompt' : ''}</Text>}
                  {isSel ? <Text inverse> </Text> : null}
                </>
              ) : o.kind === 'merge' ? (
                <>
                  <Text color={accent()}>{isSel ? '‹ ' : '  '}</Text>
                  <Text bold>{methods ? method : '…'}</Text>
                  <Text color={accent()}>{isSel ? ' ›' : '  '}</Text>
                  {o.why ? <Text color="green">{`  ${o.why}`}</Text> : null}
                </>
              ) : o.why ? (
                <Text dimColor>{o.why}</Text>
              ) : null}
              {isSel ? <Text color={o.kind === 'merge' && confirmMerge ? 'yellow' : undefined} dimColor={!(o.kind === 'merge' && confirmMerge)}>{`   ${detailFor(o)}`}</Text> : null}
            </Text>
          </Clickable>
        );
      })}
      <Box flexGrow={1} />
      <Keys
        keys={[
          ['⏎', sel?.kind === 'merge' ? (confirmMerge ? 'confirm merge' : 'merge') : 'go'],
          ['↑↓', 'choose'],
          [`1-${Math.min(9, options.length)}`, 'pick'],
          ...(sel?.kind === 'merge' ? [['←→', 'method']] : sel?.kind === 'custom' ? [['tab', 'ask / agent']] : []),
          ['esc', confirmMerge ? 'cancel' : 'back'],
        ]}
      />
    </Box>
  );
}
