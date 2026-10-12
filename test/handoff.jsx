// Launch pipeline test for "Send to AI": a fake agent (node one-liner) runs in
// a throwaway "clone" whose git remote points at the issue's repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/index.jsx';
import { loadConfig } from '../src/state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const config = loadConfig();
config.refreshSeconds = 0;
const app0 = render(<App config={config} persist={false} />);
const until = async (app, pred, label, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred(app.lastFrame() ?? '')) return; await sleep(100); }
  throw new Error(`timed out waiting for: ${label}\n${app.lastFrame()}`);
};
await until(app0, (f) => f.includes('synced'), 'load');
app0.stdin.write('5'); await sleep(300); // Issues
const repo = (app0.lastFrame().match(/([\w.-]+\/[\w.-]+)#\d+/) ?? [])[1];
app0.unmount();
if (!repo) throw new Error('no assigned issue to test with');

const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-clone-'));
fs.mkdirSync(path.join(clone, '.git'));
fs.writeFileSync(path.join(clone, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/${repo}.git\n`);
config.clones = { [repo]: clone };
config.ai.agent = 'custom-cli';
config.ai.providers['custom-cli'] = {
  command: process.execPath,
  agentArgs: ['-e', "require('fs').writeFileSync('agent-ran.txt', process.argv.at(-1))", '{prompt}'],
};

const app = render(<App config={config} persist={false} />);
await until(app, (f) => f.includes('synced'), 'load');
app.stdin.write('5'); await sleep(300);
app.stdin.write('a');
await until(app, (f) => f.includes('Work on this issue') && f.includes('assigned to you'), 'AI menu');
console.log(app.lastFrame());
app.stdin.write('3'); // "Work on this issue" is the third suggestion for an issue assigned to you
await until(app, (f) => f.includes('Custom CLI') && f.includes('Implement this issue') && f.includes('You are working') && !f.includes('searching'), 'handoff ready');
for (const ch of 'add a test too') app.stdin.write(ch);
await sleep(300);
console.log(app.lastFrame());
app.stdin.write('\r');
await until(app, (f) => f.includes(' done ·') || f.includes("couldn't launch") || f.includes('exited'), 'agent finished', 15000);
console.log('\n--- after launch ---\n' + app.lastFrame().split('\n').slice(-2).join('\n'));
const ran = path.join(clone, 'agent-ran.txt');
console.log('\nagent ran in clone:', fs.existsSync(ran));
const arg = fs.readFileSync(ran, 'utf8');
const taskFile = arg.match(/file (.+?) and carry/)?.[1];
console.log('agent got task-file prompt:', JSON.stringify(arg));
console.log('task file includes notes:', fs.readFileSync(taskFile, 'utf8').includes('add a test too'));
app.unmount();
fs.rmSync(clone, { recursive: true, force: true });
process.exit(0);
