// Headless TUI test: drives the real app against live gh data, with chat
// pointed at a mock OpenAI-compatible server. Run with GH_PULSE_HOME set to a
// scratch folder (npm test does) so your real config is never touched.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/index.jsx';
import { loadConfig } from '../src/state.js';
import { theme } from '../src/theme.js';
import { dispatchMouse, setKeyInjector } from '../src/tui/mouse.jsx';

// Whoever runs the tests: Settings must list their active gh account.
const me = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const json = JSON.parse(body);
    requests.push(json);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    send({ reasoning_content: 'Checking the dashboard.' });
    const answer = '1. **labelproof#551** — changes requested; address the review first.\n2. Then `#545`, it is assigned and active.';
    for (const piece of answer.match(/.{1,10}/gs)) { send({ content: piece }); await sleep(10); }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, r));

const config = loadConfig();
config.refreshSeconds = 0;
config.theme = 'pink';
config.ai.providers['custom-api'] = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-model' };
config.ai.chat = 'custom-api';

const app = render(<App config={config} persist={false} />);
const until = async (pred, label, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred(app.lastFrame() ?? '')) return; await sleep(100); }
  throw new Error(`timed out waiting for: ${label}\n${app.lastFrame()}`);
};
const KEYS = { down: '\x1b[B', up: '\x1b[A', right: '\x1b[C', ctrlU: '\x15', enter: '\r', esc: '\x1b', tab: '\t', pgdn: '\x1b[6~' };
const press = async (k, wait = 200) => { app.stdin.write(KEYS[k] ?? k); await sleep(wait); };
const show = (t) => console.log(`\n===== ${t} =====\n${app.lastFrame()}`);
const selectedLine = () => (app.lastFrame() ?? '').split('\n').find((l) => l.includes('❯')) ?? '';

await until((f) => f.includes('synced'), 'load');
show('home');

// AI menu on a PR with requested changes: that suggestion comes first.
await press('a');
await until((f) => f.includes('Work on the requested changes') && f.includes('changes requested'), 'PR AI menu');
show('AI menu (PR, changes requested)');
console.log('first suggestion:', selectedLine().trim().slice(0, 50));
await press('enter');
await until((f) => f.includes('You are working') && /Workspace.*✓/.test(f) && f.includes('Address requested changes'), 'agent screen');
for (const ch of 'keep the diff small') app.stdin.write(ch);
await sleep(300);
show('agent (fix PR)');
await press('esc');
await until((f) => f.includes('Work on the requested changes'), 'back to the menu');
await press('esc');

await press('tab');
for (const ch of 'what first?') app.stdin.write(ch);
await sleep(300);
show('typed in home chat');
await press('enter');
await until((f) => f.includes('assigned and active.') && !f.includes('esc stops'), 'home chat answer');
show('home chat answer');
await press('esc');

await press('7');
show('inbox grouped (auto-collapsed)');
await press('enter');
show('inbox: first repo expanded');
await press('v');
show('inbox ungrouped');

await press('3');
show('my PRs');

await press('8');
// The sidebar always shows @login, so wait for the loaded account rows (host column) instead.
await until((f) => f.split('\n').some((l) => l.includes(me) && l.includes('github.com')), 'settings accounts');
show('settings');

// Arrow keys arriving in one burst (a held key) must all count.
app.stdin.write(KEYS.down.repeat(10));
await sleep(300);
console.log('10 downs in one burst →', selectedLine().trim().slice(0, 30));
app.stdin.write(KEYS.up.repeat(10));
await sleep(300);
console.log('10 ups in one burst →', selectedLine().trim().slice(0, 30));

// Theme: cycle a preset, reject a bad hex, accept a good one.
// Walk down to the row rather than counting, since rows above it vary per machine.
for (let i = 0; i < 10 && !selectedLine().includes('Accent color'); i++) await press('down', 80);
await press('right');
await until((f) => f.includes('■ Rose'), 'theme preset');
console.log('accent after preset:', theme.accent);
await press('down');
await press('enter');
await press('ctrlU');
for (const ch of 'zz') app.stdin.write(ch);
await sleep(200);
await press('enter');
await until((f) => f.includes("isn't a hex color"), 'bad hex rejected');
await press('ctrlU');
for (const ch of '#f80') app.stdin.write(ch);
await sleep(200);
await press('enter');
await until((f) => f.includes('■ #ff8800'), 'custom hex');
console.log('accent after hex:', theme.accent);
show('settings: custom theme');

for (let i = 0; i < 3; i++) await press('down', 80);
await press('enter');
show('provider panel');
await press('esc');

await press('?');
show('help');
await press('esc');

// Mouse: feed the same events the terminal's click/wheel reports turn into.
setKeyInjector((k) => app.stdin.write(k));
const pointAt = (text, dx = 0) => {
  const lines = (app.lastFrame() ?? '').split('\n');
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen\n${app.lastFrame()}`);
  return { x: lines[y].indexOf(text) + dx, y };
};
const click = async (text, dx = 0) => {
  dispatchMouse({ button: 'left', ...pointAt(text, dx) });
  await sleep(450); // > double-click window, so each call is a single click
};
await click('5 Issues');
await until((f) => f.includes('Assigned issues'), 'click sidebar tab');
await click('#545');
console.log('click selects a row:', selectedLine().includes('#545'));
await click('#545');
await until((f) => f.includes('← esc') && f.includes('OPEN'), 'second click opens it');
await click('← esc');
await until((f) => f.includes('Assigned issues'), 'click ← esc goes back');
const before = selectedLine();
dispatchMouse({ button: 'wheelDown', ...pointAt('#545') });
dispatchMouse({ button: 'wheelDown', ...pointAt('#545') });
await sleep(300);
console.log('wheel moves the cursor:', before !== selectedLine(), '|', selectedLine().trim().slice(0, 50));
await click('? all keys');
await until((f) => f.includes('Everywhere'), 'click a key hint');
await press('esc');

await click('8 Settings');
await click('Accent color');
await click('○', 10); // the sixth dot
await until((f) => f.includes('■ Green'), 'click a theme dot');
console.log('theme dot click:', theme.accent);

await click('1 Home');
await click('tab to type');
await until((f) => f.includes('ask about your day'), 'click focuses the chat');
await click('Inbox digest');
await until(() => requests.length >= 2, 'click a quick prompt');
console.log('quick prompt click sent:', requests[1].messages.at(-1).content.slice(0, 40));

// AI menu on an issue: explain-style suggestions, then a custom prompt to the chat.
await until((f) => !f.includes('esc stops'), 'quick prompt answered');
await press('esc');
await press('5');
await press('a');
await until((f) => f.includes('Explain this issue') && f.includes('Custom prompt'), 'issue AI menu');
for (let i = 0; i < 5; i++) await press('down', 80);
for (const ch of 'who else touched this?') app.stdin.write(ch);
await sleep(300);
show('AI menu (issue, custom prompt)');
const sentBefore = requests.length;
await press('enter');
await until(() => requests.length > sentBefore, 'custom prompt sent to chat');
console.log('custom prompt sent:', requests.at(-1).messages.at(-1).content);

// A long custom prompt wraps onto more lines instead of running off the edge.
await until((f) => !f.includes('esc stops'), 'custom prompt answered');
await press('esc');
await until((f) => f.includes('Custom prompt'), 'back to the issue menu');
while (!selectedLine().includes('Custom prompt')) await press('down', 80);
const long = 'please read every comment on this issue and tell me which ones still need an answer from me, oldest first';
for (const ch of 'who else touched this? and ' + long) app.stdin.write(ch);
await sleep(400);
show('AI menu: long custom prompt wraps');
const frame = app.lastFrame();
if (!frame.includes('oldest first') || !frame.includes('who else touched')) throw new Error('custom prompt did not wrap:\n' + frame);

// Comment composer: type, attach a markdown file, let the AI draft it, undo. Never posts.
await press('ctrlU');
while (!selectedLine().includes('Leave a comment')) await press('down', 80);
await press('enter');
await until((f) => f.includes('write your comment'), 'composer');
for (const ch of 'First line') app.stdin.write(ch);
await press('enter');
for (const ch of 'second line') app.stdin.write(ch);
await sleep(200);
const md = path.join(process.env.GH_PULSE_HOME, 'note.md');
fs.writeFileSync(md, '## From a file\n- point one\n');
await press('tab');
for (const ch of `"${md}"`) app.stdin.write(ch);
await press('enter');
await until((f) => f.includes('## From a file') && f.includes('added: note.md'), 'attached markdown');
show('composer: typed + attached');
await press('tab');
for (const ch of 'thank them') app.stdin.write(ch);
const drafts = requests.length;
await press('enter');
await until((f) => f.includes('AI draft ready'), 'AI draft');
const asked = requests.at(-1).messages.at(-1).content;
console.log('draft request has my text + instructions:', requests.length > drafts && asked.includes('thank them') && asked.includes('second line'));
show('composer: AI draft');
await press('\x1a'); // ctrl+z
await until((f) => f.includes('second line') && f.includes('back to your text'), 'undo the AI draft');
await press('esc');
await until((f) => f.includes('esc again'), 'discard asks first');
await press('esc');
await until((f) => f.includes('Leave a comment'), 'back to the menu without posting');

const sys = requests[0]?.messages[0]?.content ?? '';
console.log('\n===== home chat request =====');
console.log('roles:', requests[0]?.messages.map((m) => m.role).join(' → '));
console.log('system mentions sections:', ['Your pull requests', 'Assigned issues', 'Notifications'].every((s) => sys.includes(s)), '| chars:', sys.length);
app.unmount();
server.close();
process.exit(0);
