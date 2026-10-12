// Drives the real pulse UI against made-up data (fake-gh.js) and a mock AI
// server, and saves each frame with how long to show it. render.py turns the
// result into docs/demo.gif. Run it with `npm run demo`.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { App } from '../../src/tui/index.jsx';
import { DEFAULTS } from '../../src/state.js';

const COLUMNS = 112;
const ROWS = 30;
const out = process.argv[2] ?? 'docs/demo-frames.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The chat answer the mock AI streams back, word by word.
const ANSWER = [
  '1. **acme/api#551** — @sam requested changes: add a null check before reading `payload.repository`. Small fix, and it unblocks the merge.',
  '2. **acme/web#88** — CI is failing on the lazy-load change; start with the test logs.',
  '3. **acme/web#90** — @bob has waited 3 days for your review.',
  '4. **acme/cli#71** is approved and green. Merge it.',
].join('\n');

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'llama3.1' }] }));
  }
  req.resume();
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ANSWER.match(/\S+\s*/g)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(45);
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

class Stdout extends EventEmitter {
  columns = COLUMNS;
  rows = ROWS;
  isTTY = true;
  last = '';
  write = (frame) => {
    this.last = frame;
    return true;
  };
}
class Stdin extends EventEmitter {
  isTTY = true;
  data = null;
  write = (data) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

// Start from the defaults (run.mjs points GH_PULSE_HOME at a temp folder), so
// nobody's real config or seen-state shows up in the recording.
const config = structuredClone(DEFAULTS);
Object.assign(config, { refreshSeconds: 0, theme: 'pink', mouse: false, repos: [], orgs: [], hiddenSections: [] });
config.ai = { ...config.ai, chat: 'ollama', agent: 'claude-code', providers: { ollama: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'llama3.1' } } };

const stdout = new Stdout();
const stdin = new Stdin();
const app = render(<App config={config} persist={false} />, { stdout, stderr: new Stdout(), stdin, debug: true, exitOnCtrlC: false, patchConsole: false });

const frames = [];
const snap = (ms) => {
  const prev = frames.at(-1);
  if (prev && prev.frame === stdout.last) prev.ms += ms;
  else frames.push({ frame: stdout.last, ms });
};
const until = async (pred, label, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred(stdout.last)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}\n${stdout.last}`);
};
const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', tab: '\t' };
// Press a key, let the UI settle, then show the result for `hold` ms.
const press = async (key, hold = 700) => {
  stdin.write(KEYS[key] ?? key);
  await sleep(250);
  snap(hold);
};
const type = async (text) => {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(40);
    snap(70);
  }
};

await until((f) => f.includes('Validate webhook payloads') && f.includes('synced'), 'dashboard');
await sleep(300);
snap(2600);

// Ask the Home chat what to do first, and watch the answer stream in.
await press('tab', 400);
await type('what should I do first?');
snap(500);
stdin.write(KEYS.enter);
const answered = () => stdout.last.includes('Merge it.') && !stdout.last.includes('esc stops');
const end = Date.now() + 15000;
while (Date.now() < end && !answered()) {
  await sleep(90);
  snap(90);
}
if (!answered()) throw new Error(`the chat answer never finished\n${stdout.last}`);
snap(3800);
await press('esc', 500);

// Walk the sections.
await press('2', 1300);
await press('down', 500);
await press('down', 900);
await press('4', 1400);
await press('down', 700);

// The AI menu on a PR with requested changes, then the coding-agent handoff.
await press('a', 300);
await until((f) => f.includes('Work on the requested changes'), 'AI menu');
snap(2600);
await press('enter', 300);
await until((f) => f.includes('Address requested changes') && !f.includes('searching'), 'agent screen');
await sleep(400);
snap(3400);
await press('esc', 300);
await press('esc', 600);

// Inbox, grouped by repo.
await press('7', 1200);
await press('z', 1300);
await press('down', 400);
await press('enter', 2400);
await press('1', 1800);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ columns: COLUMNS, rows: ROWS, frames }));
console.log(`${frames.length} frames, ${(frames.reduce((s, f) => s + f.ms, 0) / 1000).toFixed(1)}s → ${out}`);
app.unmount();
server.close();
process.exit(0);
