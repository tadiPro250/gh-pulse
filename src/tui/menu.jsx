// The one AI entry point for a PR or issue: suggested actions that fit its
// state (fix requested changes, fix CI, explain, review…), merge when it's
// ready, a custom prompt that either the chat or an agent can take, and the
// things you do yourself (comment, re-review, draft, close, delete branch, archive).
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { actionsFor, branchDeletion, mergeStatus } from '../ai/actions.js';
import { agentProviderId, chatProviderId, resolve } from '../ai/index.js';
import { fetchHumanReviewers, fetchReviewThreads, summarizeChecks } from '../detail.js';
import { branchInfo, closePr, deleteBranch, mergeMethods, mergePr, requestReview, setDraft } from '../github.js';
import { fit } from '../render.js';
import { accent } from '../theme.js';
import { Clickable } from './mouse.jsx';
import { Keys, Rule, Spinner, TextArea, TopBar, editText, toneColor } from './ui.jsx';

const BADGES = { agent: ['agent', 'good'], chat: ['ask', 'ok'], merge: ['merge', 'accent'], custom: ['custom', 'dim'], compose: ['write', 'accent'], gh: ['pr', 'warn'], local: ['pulse', 'dim'] };
const MANAGE = new Set(['compose', 'gh', 'local']);
// These ask for a second ⏎ before they run.
const CONFIRM = { merge: 'merge', close: 'close it', deleteBranch: 'delete the branch' };
// The branch may already be gone (repos can delete it on merge).
const alreadyGone = (err) => /Reference does not exist|Not Found/.test(err.message);
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

export function MenuScreen({ item, login, config, getDetail, focus, draft, onDraft, archived, width, height, active, onAction, toast }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [threads, setThreads] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [custom, setCustom] = useState(draft?.custom ?? '');
  const [customMode, setCustomMode] = useState(draft?.mode ?? 'chat'); // 'chat' | 'agent'
  const [methods, setMethods] = useState(null);
  const [methodIdx, setMethodIdx] = useState(0);
  const [confirming, setConfirming] = useState(null); // option id waiting for a second ⏎
  const [busy, setBusy] = useState(false);
  const [branch, setBranch] = useState(null); // github.branchInfo for the head branch
  const [deleteOnMerge, setDeleteOnMerge] = useState(false);
  const [reviewerIdx, setReviewerIdx] = useState(0); // 0 = everyone
  const [humans, setHumans] = useState(null); // reviewers who are people, not apps

  useEffect(() => {
    getDetail(item).then(setDetail, (e) => setError(e.message));
    if (item.kind === 'pr') {
      fetchReviewThreads(item).then(setThreads, () => {});
      fetchHumanReviewers(item).then(setHumans, () => {});
    }
  }, [item.url]);
  const reload = () => getDetail(item, true).then(setDetail, () => {});

  // Deleting the branch is only offered once we know it's safe.
  const wantsBranch = detail?.kind === 'pr' && !detail.isCrossRepository && (detail.state === 'MERGED' || mergeStatus(detail).ok);
  const loadBranch = () => branchInfo(item.repo, detail.headRefName).then(setBranch, () => setBranch(null));
  useEffect(() => {
    if (wantsBranch) loadBranch();
  }, [wantsBranch, detail?.headRefName]);
  const canDeleteOnMerge = branchDeletion(detail, branch, { merging: true }).ok;

  const options = useMemo(() => actionsFor({ item, detail, threads, login, branch, archived, humans }), [item, detail, threads, login, branch, archived, humans]);
  const hasMerge = options.some((o) => o.kind === 'merge');
  useEffect(() => {
    if (hasMerge && !methods) mergeMethods(item.repo).then(setMethods, () => setMethods(['merge']));
  }, [hasMerge]);
  // Land on the row we left (back from the chat or agent), or on "merge" when
  // opened with m on a ready PR, once it appears. Only once, so moving isn't undone.
  const landOn = draft?.selId ?? focus;
  const landed = useRef(!landOn);
  useEffect(() => {
    if (landed.current || !options.some((o) => o.id === landOn)) return;
    landed.current = true;
    setCursor(options.findIndex((o) => o.id === landOn));
  }, [landOn, options.length]);

  const pos = clamp(cursor, 0, options.length - 1);
  const sel = options[pos];

  // This screen unmounts while the chat or agent is on top; hand the prompt
  // back to its stack entry so it's still here on return.
  const latest = useRef(null);
  latest.current = { custom, mode: customMode, selId: sel?.id };
  useEffect(() => () => onDraft?.(latest.current), []);
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
    setConfirming(null);
    setCursor((c) => clamp(clamp(c, 0, options.length - 1) + d, 0, options.length - 1));
  };

  // Runs a gh change with a spinner; `done` gets the result, failures are toasted.
  const act = async (what, fn, done) => {
    setBusy(true);
    let out;
    try {
      out = await fn();
    } catch (err) {
      toast(`${what} failed: ${err.message.split('\n')[0]}`, 'bad');
      return;
    } finally {
      setBusy(false);
      setConfirming(null);
    }
    await done?.(out);
  };

  const merge = () =>
    act(
      'merge',
      async () => {
        await mergePr(item, method);
        if (!deleteOnMerge || !canDeleteOnMerge) return '';
        const name = detail.headRefName;
        return deleteBranch(item.repo, name).then(
          () => ` · deleted ${name}`,
          (err) => (alreadyGone(err) ? ` · ${name} was already deleted` : ` · couldn't delete ${name}`),
        );
      },
      (extra) => {
        toast(`merged ${item.ref} (${method})${extra}`, 'good');
        onAction('changed', item);
      },
    );

  const reviewers = sel?.id === 'rereview' ? sel.reviewers : [];
  const chosenReviewers = reviewerIdx && reviewers[reviewerIdx - 1] ? [reviewers[reviewerIdx - 1]] : reviewers;

  const runGh = (o) => {
    if (o.id === 'rereview') {
      return act('re-review request', () => requestReview(item, chosenReviewers), async () => {
        toast(`asked ${chosenReviewers.map((l) => '@' + l).join(', ')} to review ${item.ref} again`, 'good');
        setReviewerIdx(0);
        await reload();
      });
    }
    if (o.id === 'draft' || o.id === 'ready') {
      const draft = o.id === 'draft';
      return act(draft ? 'convert to draft' : 'mark ready', () => setDraft(item, draft), async () => {
        toast(draft ? `${item.ref} is a draft now` : `${item.ref} is ready for review`, 'good');
        await reload();
        onAction('refresh');
      });
    }
    if (o.id === 'close') {
      return act('close', () => closePr(item), () => {
        toast(`closed ${item.ref}`, 'good');
        onAction('changed', item);
      });
    }
    if (o.id === 'deleteBranch') {
      const name = detail.headRefName;
      const del = () => deleteBranch(item.repo, name).catch((err) => {
        if (!alreadyGone(err)) throw err;
      });
      return act('delete branch', del, async () => {
        toast(`deleted ${name} · the PR page can restore it`, 'good');
        await loadBranch();
      });
    }
  };

  const run = (o) => {
    if (!o || busy) return;
    if (CONFIRM[o.id] && confirming !== o.id) return setConfirming(o.id);
    if (o.kind === 'chat') return onAction('chat', item, { prompt: o.prompt });
    if (o.kind === 'agent') return onAction('agent', item, { task: o.task });
    if (o.kind === 'merge') return merge();
    if (o.kind === 'compose') return onAction('compose', item);
    if (o.kind === 'local') return onAction(o.id, item);
    if (o.kind === 'gh') return runGh(o);
    if (o.kind === 'custom') {
      if (!custom.trim()) return toast('type your prompt first', 'warn');
      return customMode === 'chat' ? onAction('chat', item, { prompt: custom.trim() }) : onAction('agent', item, { task: 'custom', notes: custom.trim() });
    }
  };

  const step = (d) => {
    if (sel?.kind === 'merge' && methods?.length) {
      setConfirming(null);
      setMethodIdx((i) => (i + d + methods.length) % methods.length);
    }
    if (sel?.id === 'rereview' && reviewers.length > 1) setReviewerIdx((i) => (i + d + reviewers.length + 1) % (reviewers.length + 1));
    if (sel?.kind === 'custom') setCustomMode((m) => (m === 'chat' ? 'agent' : 'chat'));
  };

  useInput(
    (input, key) => {
      if (busy) return;
      if (key.escape) return confirming ? setConfirming(null) : onAction('back');
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
      if (input === 'b' && sel?.kind === 'merge' && canDeleteOnMerge) {
        setConfirming(null);
        return setDeleteOnMerge((v) => !v);
      }
      if (input === 'j') return move(1);
      if (input === 'k') return move(-1);
    },
    { isActive: active },
  );

  const labelW = Math.min(32, Math.max(...options.map((o) => o.label.length)) + 2);
  const clickOption = (i, { double }) => {
    if (i === pos || double) return run(options[i]);
    setConfirming(null);
    setCursor(i);
  };

  // What happens on ⏎, said once for the highlighted row.
  const detailFor = (o) => {
    if (confirming === o.id) return o.kind === 'merge' ? `⏎ again to merge into ${detail?.baseRefName ?? 'base'}` : `⏎ again to ${CONFIRM[o.id]}`;
    if (o.kind === 'chat') return chatName ? `${chatName} answers` : 'no AI linked · s → AI';
    if (o.kind === 'agent') return agentName ? `${agentName} works in your clone` : 'no agent linked · a chat model will plan it';
    if (o.kind === 'merge') return canDeleteOnMerge ? '←→ method · b branch' : '←→ method';
    if (o.kind === 'custom') return customMode === 'chat' ? 'tab: give it to an agent' : 'tab: ask instead';
    if (o.id === 'rereview') return reviewers.length > 1 ? '←→ who' : '';
    return '';
  };
  const rereviewWho = reviewerIdx ? '@' + reviewers[reviewerIdx - 1] : 'everyone';
  // The custom prompt wraps beside its label: the row's head is this wide.
  const customHead = 3 + String(options.length).length + 1 + 8 + 15 + 2 + 5 + 3;
  const promptW = Math.max(10, width - customHead);
  const numW = String(options.length).length + 1;
  const firstManage = options.findIndex((o) => MANAGE.has(o.kind));
  const groupLabel = item.kind === 'pr' ? 'this PR' : 'this issue';

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
        const head = (
          <>
            <Text color={accent()} bold>{isSel ? ' ❯ ' : '   '}</Text>
            <Text dimColor>{`${i + 1}`.padEnd(numW)}</Text>
            <Text color={toneColor(tone)} bold>{fit(badge, 8)}</Text>
          </>
        );
        const hint = isSel ? detailFor(o) : '';
        const waiting = confirming === o.id;
        const hintText = hint ? <Text color={waiting ? 'yellow' : undefined} dimColor={!waiting}>{`   ${hint}`}</Text> : null;
        const row =
          o.kind === 'custom' ? (
            <Box>
              <Box width={customHead} flexShrink={0}>
                <Text wrap="truncate">
                  {head}
                  <Text bold={isSel}>{fit(o.label, 15)}</Text>
                  <Text color={accent()}>{isSel ? '‹ ' : '  '}</Text>
                  <Text bold>{fit(customMode === 'chat' ? 'ask' : 'agent', 5)}</Text>
                  <Text color={accent()}>{isSel ? ' › ' : '   '}</Text>
                </Text>
              </Box>
              <Box flexDirection="column" width={promptW}>
                {custom ? (
                  <TextArea value={custom} width={promptW} maxLines={6} cursor={isSel} />
                ) : (
                  <Text wrap="truncate">
                    {isSel ? <Text dimColor>type your prompt</Text> : null}
                    {isSel ? <Text inverse> </Text> : null}
                    {hintText}
                  </Text>
                )}
              </Box>
            </Box>
          ) : (
            <Text wrap="truncate">
              {head}
              <Text bold={isSel}>{fit(o.label, labelW)}</Text>
              {o.kind === 'merge' ? (
                <>
                  <Text color={accent()}>{isSel ? '‹ ' : '  '}</Text>
                  <Text bold>{methods ? method : '…'}</Text>
                  <Text color={accent()}>{isSel ? ' ›' : '  '}</Text>
                  {canDeleteOnMerge ? <Text color={deleteOnMerge ? 'yellow' : undefined} dimColor={!deleteOnMerge}>{deleteOnMerge ? '  + delete branch' : '  keep branch'}</Text> : null}
                  {o.why ? <Text color="green">{`  ${o.why}`}</Text> : null}
                </>
              ) : o.id === 'rereview' && isSel && reviewers.length > 1 ? (
                <>
                  <Text color={accent()}>{'‹ '}</Text>
                  <Text bold>{rereviewWho}</Text>
                  <Text color={accent()}>{' ›'}</Text>
                  {!reviewerIdx ? <Text dimColor>{`  ${o.why}`}</Text> : null}
                </>
              ) : o.why ? (
                <Text dimColor>{o.why}</Text>
              ) : null}
              {hintText}
            </Text>
          );
        return (
          <Box key={o.id} flexDirection="column">
            {i === firstManage ? <Text dimColor wrap="truncate">{`   ── ${groupLabel} ${'─'.repeat(Math.max(0, width - 8 - groupLabel.length))}`}</Text> : null}
            <Clickable onClick={(m) => clickOption(i, m)}>{row}</Clickable>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Keys
        keys={[
          ['⏎', confirming ? 'confirm' : sel?.kind === 'merge' ? 'merge' : 'go'],
          ['↑↓', 'choose'],
          [`1-${Math.min(9, options.length)}`, 'pick'],
          ...(sel?.kind === 'merge'
            ? [['←→', 'method'], ...(canDeleteOnMerge ? [['b', deleteOnMerge ? 'keep branch' : 'delete branch']] : [])]
            : sel?.kind === 'custom'
              ? [['tab', 'ask / agent']]
              : sel?.id === 'rereview' && reviewers.length > 1
                ? [['←→', 'who']]
                : []),
          ['esc', confirming ? 'cancel' : 'back'],
        ]}
      />
    </Box>
  );
}
