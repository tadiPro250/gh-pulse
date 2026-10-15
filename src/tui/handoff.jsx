// "Send to AI": hand a PR (fix review feedback / CI / conflicts) or an issue
// (implement it) to a coding agent running in your local clone.
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { CATALOG } from '../ai/catalog.js';
import { canAgent, canChat, resolve, status } from '../ai/index.js';
import { agentCommand, openInEditor, runInteractive } from '../ai/providers/cli.js';
import { TASKS, buildTaskPrompt, tasksFor } from '../ai/tasks.js';
import { defaultCloneTarget, findClone, isClone } from '../clones.js';
import { fetchReviewThreads } from '../detail.js';
import { copyToClipboard } from '../system.js';
import { accent, ansiAccent } from '../theme.js';
import { plainLines } from './format.js';
import { Clickable } from './mouse.jsx';
import { Keys, Rule, Spinner, TextArea, TopBar, Viewport, editText, scrollLabel, textAreaHeight, useScroll } from './ui.jsx';

const FIELDS = ['agent', 'task', 'workspace', 'notes'];

// Agents that can edit code first, then chat-only models (which can only plan).
function agentOptions(config) {
  const ready = CATALOG.map((p) => resolve(config, p.id)).filter((p) => status(config, p.id).ready);
  const agents = ready.filter(canAgent).map((p) => ({ id: p.id, name: p.name, kind: p.kind, planOnly: false }));
  const planners = ready.filter((p) => !canAgent(p) && canChat(p)).map((p) => ({ id: p.id, name: p.model ? `${p.name} · ${p.model}` : p.name, kind: p.kind, planOnly: true }));
  return [...agents, ...planners];
}

export function HandoffScreen({ item, initialTask, initialNotes = '', login, config, updateConfig, getDetail, width, height, active, onAction, suspendTerminal, toast }) {
  const options = useMemo(() => agentOptions(config), [config]);
  const [agentIdx, setAgentIdx] = useState(() => Math.max(0, options.findIndex((o) => o.id === config.ai.agent)));
  const [taskId, setTaskId] = useState(initialTask ?? null);
  const [field, setField] = useState(3); // start in Notes so typing just works
  const [notes, setNotes] = useState(initialNotes);
  const [workspace, setWorkspace] = useState(null);
  const [editingPath, setEditingPath] = useState(null);
  const [detail, setDetail] = useState(null);
  const [threads, setThreads] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDetail(item).then(setDetail, (e) => setError(e.message));
    if (item.kind === 'pr') fetchReviewThreads(item).then(setThreads, () => {});
    // Scanning workspace folders reads a few hundred small files; defer past the first paint.
    setTimeout(() => setWorkspace(findClone(config, item.repo) ?? ''), 0);
  }, [item.url]);

  const tasks = useMemo(() => tasksFor(item, detail), [item, detail]);
  const task = tasks.includes(taskId) ? taskId : tasks[0];
  const stepTask = (d) => setTaskId(tasks[(tasks.indexOf(task) + d + tasks.length) % tasks.length]);
  const agent = options[agentIdx];
  const prompt = useMemo(
    () => (detail ? buildTaskPrompt({ task, item, detail, threads, notes, login }) : ''),
    [task, item, detail, threads, notes, login],
  );
  const cloneOk = workspace ? isClone(workspace, item.repo) : false;

  const previewW = width - 3;
  const lines = useMemo(() => plainLines(prompt || 'loading…', previewW), [prompt, previewW]);
  // Notes wrap under their label (column 16) instead of running off the edge.
  const notesW = width - 16;
  const notesH = textAreaHeight(notes, notesW, 5);
  const previewH = Math.max(3, height - 3 - (FIELDS.length - 1) - notesH - 2);
  const scroll = useScroll(lines.length, previewH);

  const launch = () =>
    launchUnsafe().catch((err) => {
      setBusy(false);
      toast(`couldn't launch: ${err.message}`, 'bad');
    });

  const launchUnsafe = async () => {
    if (!agent) return toast('no AI linked · s → AI', 'warn');
    if (!detail) return toast(error ? `can't load ${item.ref}: ${error}` : `still loading ${item.ref}…`, 'warn');
    if (task === 'custom' && !notes.trim()) return toast('type your prompt in Notes first', 'warn');

    // Chat-only model: it can't touch files, so ask it for a plan instead.
    if (agent.planOnly) return onAction('chat', item, { prompt, providerId: agent.id });

    if (!cloneOk) return toast(workspace ? `not a clone of ${item.repo}` : `no clone of ${item.repo} · press C`, 'warn');
    const p = resolve(config, agent.id);
    const st = status(config, agent.id);
    setBusy(true);
    updateConfig((c) => {
      c.ai.agent = agent.id;
      c.clones = { ...c.clones, [item.repo]: workspace };
      return c;
    });

    let checkoutCode = 0;
    let agentCode = null;
    await suspendTerminal(async () => {
      if (item.kind === 'pr') {
        process.stdout.write(`\n${ansiAccent('◆ pulse')}  gh pr checkout ${item.number}  \x1b[2m(in ${workspace})\x1b[0m\n\n`);
        checkoutCode = await runInteractive({ file: 'gh', args: ['pr', 'checkout', String(item.number)] }, workspace);
        if (checkoutCode !== 0) return;
      }
      if (p.kind === 'ide') return;
      const cmd = agentCommand({ file: st.path, agent: p.agent, model: p.model, prompt });
      process.stdout.write(`\n${ansiAccent('◆ pulse')}  handing ${item.ref} to ${p.name}  \x1b[2m(task saved at ${cmd.promptFile})\x1b[0m\n\n`);
      agentCode = await runInteractive(cmd, workspace);
    });
    setBusy(false);

    if (checkoutCode !== 0) return toast('checkout failed · commit or stash changes in the clone', 'bad');
    if (p.kind === 'ide') {
      openInEditor(st.path, workspace);
      await copyToClipboard(prompt).catch(() => {});
      toast(`opened ${p.name} · prompt copied, paste it into its agent`, 'good');
    } else {
      toast(agentCode === 0 ? `${p.name} done · review, then push` : `${p.name} exited with ${agentCode}`, agentCode === 0 ? 'good' : 'warn');
    }
    onAction('back');
  };

  const cloneRepo = async () => {
    const target = defaultCloneTarget(config, item.repo);
    let code = 1;
    await suspendTerminal(async () => {
      process.stdout.write(`\n${ansiAccent('◆ pulse')}  gh repo clone ${item.repo} ${target}\n\n`);
      code = await runInteractive({ file: 'gh', args: ['repo', 'clone', item.repo, target] }, process.cwd());
    });
    if (code === 0) {
      setWorkspace(target);
      toast(`cloned into ${target}`, 'good');
    } else toast(`gh repo clone exited with ${code}`, 'bad');
  };

  useInput(
    (input, key) => {
      if (busy) return;
      if (editingPath !== null) {
        if (key.return) {
          setWorkspace(editingPath.trim());
          setEditingPath(null);
        } else if (key.escape) setEditingPath(null);
        else editText((f) => setEditingPath((v) => (typeof f === 'function' ? f(v) : f)), input, key);
        return;
      }
      if (key.escape) return onAction('back');
      if (key.pageUp || key.pageDown) return scroll.handle(input, key, { letters: false });
      if (key.upArrow) return setField((f) => Math.max(0, f - 1));
      if (key.downArrow || key.tab) return setField((f) => Math.min(FIELDS.length - 1, f + 1));
      const name = FIELDS[field];
      if (key.leftArrow || key.rightArrow) {
        const d = key.leftArrow ? -1 : 1;
        if (name === 'agent' && options.length) setAgentIdx((i) => (i + d + options.length) % options.length);
        if (name === 'task') stepTask(d);
        return;
      }
      if (key.return) {
        if (name === 'workspace') return setEditingPath(workspace ?? '');
        return launch();
      }
      if (name === 'notes') return editText(setNotes, input, key);
      if (input === 'C') return cloneRepo();
      if (input === 'e' && name === 'workspace') setEditingPath(workspace ?? '');
    },
    { isActive: active },
  );

  // Each field shows a short status tag; the longer hint appears only while it's focused.
  const openThreads = threads.filter((t) => !t.resolved).length;
  const agentTag = !agent ? ['none linked', 'yellow'] : agent.planOnly ? ['plan only', 'yellow'] : agent.kind === 'ide' ? ['opens editor'] : ['✓ edits code', 'green'];
  const agentHint = !agent ? 's → AI to link one' : agent.planOnly ? "can't edit files" : agent.kind === 'ide' ? 'task goes to your clipboard' : 'you push';
  const taskTag = task === 'review-feedback' ? [`${openThreads} open thread${openThreads === 1 ? '' : 's'}`] : task === 'custom' ? ['notes = prompt'] : [];
  const workspaceTag = workspace === null ? ['searching…'] : !workspace ? ['no clone', 'yellow'] : cloneOk ? ['✓', 'green'] : ['✗ wrong repo', 'red'];
  const workspaceHint =
    editingPath !== null ? '⏎ save · esc cancel' : cloneOk ? (item.kind === 'pr' && detail ? `checks out ${detail.headRefName}` : '') : !workspace ? 'C clone · ⏎ set path' : '⏎ change';

  // Click a field to focus it; click a focused ‹ choice › to step through it.
  const clickField = (i, select, { x }) => {
    if (field !== i) return setField(i);
    if (!select) return i === 2 && setEditingPath(workspace ?? '');
    const d = x < 16 ? -1 : 1; // the "‹" sits at column 14
    if (i === 0 && options.length) setAgentIdx((n) => (n + d + options.length) % options.length);
    if (i === 1) stepTask(d);
  };

  const Field = ({ i, label, value, tag = [], hint, select }) => {
    const focused = field === i;
    return (
      <Clickable onClick={(m) => clickField(i, select, m)}>
        <Text wrap="truncate">
          <Text color={accent()} bold>{focused ? ' ❯ ' : '   '}</Text>
          <Text dimColor={!focused} bold={focused}>{label.padEnd(11)}</Text>
          <Text color={accent()}>{select && focused ? '‹ ' : '  '}</Text>
          <Text bold>{value}</Text>
          {select ? <Text color={accent()}>{focused ? ' ›' : '  '}</Text> : <Text>{'  '}</Text>}
          {tag[0] ? <Text color={tag[1]} dimColor={!tag[1]}>{`  ${tag[0]}`}</Text> : null}
          {focused && hint ? <Text dimColor>{`  · ${hint}`}</Text> : null}
        </Text>
      </Clickable>
    );
  };

  return (
    <Box flexDirection="column" height={height}>
      <TopBar item={item} label="Agent" right={busy ? <Spinner /> : null} />
      <Rule width={width} />
      <Field i={0} label="Agent" value={agent?.name ?? '—'} tag={agentTag} hint={agentHint} select />
      <Field i={1} label="Task" value={TASKS[task]?.label ?? '…'} tag={taskTag} select />
      <Field i={2} label="Workspace" value={editingPath !== null ? `${editingPath}▌` : workspace || '—'} tag={editingPath !== null ? [] : workspaceTag} hint={workspaceHint} />
      <Clickable onClick={() => setField(3)}>
        <Box>
          <Box width={16} flexShrink={0}>
            <Text color={accent()} bold>{field === 3 ? ' ❯ ' : '   '}</Text>
            <Text dimColor={field !== 3} bold={field === 3}>{'Notes'.padEnd(13)}</Text>
          </Box>
          <Box width={notesW} flexDirection="column">
            <TextArea
              value={notes}
              width={notesW}
              maxLines={5}
              cursor={field === 3}
              placeholder={task === 'custom' ? 'type your prompt' : field === 3 ? 'type extra instructions' : 'optional'}
            />
          </Box>
        </Box>
      </Clickable>
      <Text wrap="truncate">
        <Text color={accent()} bold>{' ── prompt '}</Text>
        <Text dimColor>{'─'.repeat(Math.max(0, width - 12))}</Text>
      </Text>
      <Clickable paddingLeft={1} height={previewH} onWheel={(d) => scroll.scrollTo((o) => o + d * 3)}>
        {error ? <Text color="red">{`✗ ${error}`}</Text> : <Viewport lines={lines} offset={scroll.offset} height={previewH} />}
      </Clickable>
      <Keys
        keys={[['⏎', agent?.planOnly ? 'get plan' : 'launch'], ['↑↓', 'field'], ['←→', 'change'], ['pgup/dn', 'scroll'], ['esc', 'cancel']]}
        right={scrollLabel(scroll, previewH, lines.length)}
      />
    </Box>
  );
}
