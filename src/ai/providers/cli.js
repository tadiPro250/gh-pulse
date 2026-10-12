// Command-line AIs: headless chat (prompt in, streamed text out) and
// interactive agent sessions launched inside a repo.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsShell, shellQuote } from '../../which.js';
import { TASK_PROMPT_TEMPLATE } from '../catalog.js';

const TMP = path.join(os.tmpdir(), 'gh-pulse');

export function writeTemp(name, text) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${Date.now()}-${name}`);
  fs.writeFileSync(file, text);
  return file;
}

// Fill {placeholders}; nested arrays are optional groups (dropped if any value is empty).
export function expandArgs(template, vars) {
  const fill = (s) => {
    let missing = false;
    const out = s.replace(/\{(\w+)\}/g, (_, k) => {
      if (!vars[k]) missing = true;
      return vars[k] ?? '';
    });
    return missing ? null : out;
  };
  const args = [];
  for (const part of template) {
    if (Array.isArray(part)) {
      const filled = part.map(fill);
      if (!filled.includes(null)) args.push(...filled);
    } else {
      args.push(fill(part) ?? part.replace(/\{\w+\}/g, ''));
    }
  }
  return args;
}

export function spawnTool(file, args, options = {}) {
  if (needsShell(file)) {
    return spawn([shellQuote(file), ...args.map(shellQuote)].join(' '), { ...options, shell: true, windowsHide: true });
  }
  return spawn(file, args, { ...options, windowsHide: true });
}

function transcript(messages) {
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1) return turns[0].content;
  return (
    turns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`).join('\n\n') +
    '\n\nReply to the last User message.'
  );
}

// Claude Code's stream-json: one JSON object per line; text arrives as
// stream_event → content_block_delta.
function parseClaudeLine(line) {
  if (!line.trim()) return [];
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
    const d = msg.event.delta;
    if (d.type === 'text_delta') return [{ type: 'text', text: d.text }];
    if (d.type === 'thinking_delta') return [{ type: 'thinking', text: d.thinking }];
  }
  if (msg.type === 'result' && msg.is_error) return [{ type: 'error', text: msg.result || msg.subtype || 'Claude Code reported an error' }];
  return [];
}

export function cliChatProvider({ file, chat, model, name }) {
  async function* stream(messages, signal) {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const convo = transcript(messages);
    const vars = { model };
    let stdin = null;
    if (chat.input === 'stdin-transcript') {
      vars.systemFile = writeTemp('system.md', system);
      stdin = convo;
    } else if (chat.input === 'stdin-full') {
      stdin = `${system}\n\n---\n\n${convo}`;
    } else {
      vars.promptFile = writeTemp('chat.md', `${system}\n\n---\n\n${convo}`);
    }

    const child = spawnTool(file, expandArgs(chat.args, vars), { cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
    yield* streamProcess(child, chat.parse, signal, name);
  }
  return { stream };
}

async function* streamProcess(child, parse, signal, name) {
  const queue = [];
  let done = false;
  let error = null;
  let wake = null;
  let buffer = '';
  let stderr = '';
  const push = (ev) => {
    queue.push(ev);
    wake?.();
  };

  child.stdout.on('data', (d) => {
    if (parse !== 'claude-stream-json') return push({ type: 'text', text: d.toString() });
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      for (const ev of parseClaudeLine(buffer.slice(0, nl))) push(ev);
      buffer = buffer.slice(nl + 1);
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  child.on('error', (err) => {
    error = err.code === 'ENOENT' ? new Error(`${name} is not installed`) : err;
    done = true;
    wake?.();
  });
  child.on('close', (code) => {
    if (code && !signal?.aborted && !error) {
      const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      error = new Error(`${name} exited with ${code}${tail ? `: ${tail}` : ''}`);
    }
    done = true;
    wake?.();
  });
  const onAbort = () => child.kill();
  signal?.addEventListener('abort', onAbort);

  try {
    for (;;) {
      if (queue.length) {
        const ev = queue.shift();
        if (ev.type === 'error') throw new Error(ev.text);
        yield ev;
        continue;
      }
      if (done) break;
      await new Promise((r) => (wake = r));
      wake = null;
    }
    if (error) throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!done) child.kill();
  }
}

// Command line for an interactive agent session. Short prompts are passed
// inline (visible in the agent's UI); long ones go through a task file.
export function agentCommand({ file, agent, model, prompt }) {
  const promptFile = writeTemp('task.md', prompt);
  const inline = agent.inlinePrompt && !needsShell(file) && prompt.length < 6000;
  const promptArg = inline ? prompt : TASK_PROMPT_TEMPLATE.replace('{promptFile}', promptFile);
  return { file, args: expandArgs(agent.args, { model, prompt: promptArg, promptFile }), promptFile };
}

export function runInteractive({ file, args }, cwd) {
  return new Promise((resolve) => {
    const child = spawnTool(file, args, { cwd, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// Editors: open the folder, detached, and return immediately.
export function openInEditor(file, folder) {
  const child = spawnTool(file, [folder], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
