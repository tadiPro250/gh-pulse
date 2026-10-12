// Headless walk through the welcome wizard: every step renders, choices land
// in the config, and finishing opens the dashboard with them applied.
import { render } from 'ink-testing-library';
import { App } from '../src/tui/index.jsx';
import { loadConfig } from '../src/state.js';
import { theme } from '../src/theme.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let config = loadConfig();
config.refreshSeconds = 0;
config.theme = 'pink';

// persist=false, so watch the config through a probe instead of the file.
const app = render(<App config={config} persist={false} setup />);
const until = async (pred, label, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred(app.lastFrame() ?? '')) return; await sleep(100); }
  throw new Error(`timed out waiting for: ${label}\n${app.lastFrame()}`);
};
const KEYS = { down: '\x1b[B', up: '\x1b[A', right: '\x1b[C', enter: '\r', esc: '\x1b', tab: '\t' };
const press = async (k, wait = 150) => { app.stdin.write(KEYS[k] ?? k); await sleep(wait); };
const show = (t) => console.log(`\n===== ${t} =====\n${app.lastFrame()}`);
const check = (cond, label) => { if (!cond) throw new Error(`${label}\n${app.lastFrame()}`); console.log(`ok  ${label}`); };

await until((f) => f.includes('Welcome to pulse') && f.includes('GitHub CLI found'), 'welcome');
show('welcome');
await press('enter');

await until((f) => f.includes('Connect GitHub') && f.includes('signed in'), 'github accounts');
show('github');
await press('tab');

await until((f) => f.includes('Bring your own AI'), 'ai step');
show('ai');
await press('tab');

await until((f) => f.includes('Make it yours'), 'look step');
await press('right');
await until((f) => f.includes('■ Rose'), 'theme changes');
check(theme.accent === '#fb7185', 'accent previews live');
show('look');
await press('tab');

await until((f) => f.includes('Your dashboard'), 'dashboard step');
// Untick Mentions (5th section) and tick "ready to merge" (4th stat).
for (let i = 0; i < 4; i++) await press('down', 60);
await press(' ');
for (let i = 0; i < 5; i++) await press('down', 60);
await press('enter');
show('dashboard');
check(/○ Mentions/.test(app.lastFrame()), 'mentions unticked');
check(/◉ ready to merge/.test(app.lastFrame()), 'ready to merge ticked');
await press('tab');

await until((f) => f.includes('Scope and workspace'), 'workspace step');
await press('enter'); // edit "Only these orgs"
await press('esc'); // cancel the edit
await press('tab');

await until((f) => f.includes("You're all set"), 'done step');
show('done');
check(app.lastFrame().includes('Sidebar     Review, Follow-up, My PRs, Issues, Inbox'), 'summary lists sections');
await press('esc');
await until((f) => f.includes('Scope and workspace'), 'esc goes back');
await press('tab');
await until((f) => f.includes('Open my dashboard'), 'done again');
for (let i = 0; i < 9; i++) await press('down', 40);
await press('enter');

await until((f) => f.includes('1 Home') && f.includes('ready to merge'), 'dashboard opens');
show('dashboard after setup');
check(!app.lastFrame().includes('Mentions'), 'mentions hidden from the sidebar');
check(app.lastFrame().includes('6 Inbox'), 'sections renumbered');

app.unmount();
process.exit(0);
