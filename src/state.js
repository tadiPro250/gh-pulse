import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIR = process.env.GH_PULSE_HOME || path.join(os.homedir(), '.gh-pulse');
const STATE = path.join(DIR, 'state.json');
const CONFIG = path.join(DIR, 'config.json');

const DEFAULT_CONFIG = {
  repos: [], // only show these repos (owner/name)
  orgs: [], // only show these orgs/users
  excludeRepos: [], // never show these repos
  limit: 30, // max items per section
  mentionDays: 7, // how far back the mentions section looks
  staleReviewDays: 2, // highlight review requests older than this
  refreshSeconds: 120, // TUI auto-refresh interval (0 = off)
  groupInbox: true, // group notifications by repo, then issues / PRs
  mouse: true, // click and scroll with the mouse (off = the terminal's own text selection)
  theme: 'pink', // accent color: a preset (pink, rose, purple, blue, teal, green, orange, mono) or a hex code like #ff8800
  hiddenSections: [], // sidebar sections to hide: review, reviewed, mine, assigned, mentions, inbox
  homeStats: ['fix', 'review', 'assigned', 'inbox'], // the numbers under Home's greeting (see HOME_STATS in tui/home.jsx)
  workspaceRoots: [], // folders that contain your local clones (searched for "send to AI")
  clones: {}, // remembered "owner/repo": "path" pairs
  ai: {
    chat: '', // provider id for chat (empty = first one that works)
    agent: '', // provider id for "send to AI" builds/fixes
    providers: {}, // per-provider overrides: { model, baseUrl, command, chatArgs, agentArgs }
    maxContextChars: 24000, // how much of the issue/PR/diff to send
  },
};

export const DEFAULTS = DEFAULT_CONFIG;

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function write(file, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function loadConfig() {
  const user = read(CONFIG, {});
  const ai = { ...DEFAULT_CONFIG.ai, ...user.ai, providers: { ...user.ai?.providers } };
  // v0.2 config had a single OpenAI-compatible endpoint at ai.baseUrl/ai.model.
  if (user.ai?.model && !user.ai?.providers) {
    ai.providers['custom-api'] = { baseUrl: user.ai.baseUrl, model: user.ai.model };
    ai.chat ||= 'custom-api';
  }
  delete ai.baseUrl;
  delete ai.model;
  delete ai.apiKey;
  return { ...DEFAULT_CONFIG, ...user, ai };
}

export function saveConfig(config) {
  write(CONFIG, config);
}

// No config file yet (or setup was left unfinished): show the welcome wizard.
export function needsSetup() {
  if (!fs.existsSync(CONFIG)) return true;
  return read(CONFIG, {}).setupDone === false;
}

export function configPath() {
  if (!fs.existsSync(CONFIG)) write(CONFIG, DEFAULT_CONFIG);
  return CONFIG;
}

// { accounts: { [login]: { seen: { [id]: updatedAt }, lastRun } }, items: [...] }
export function loadState() {
  const s = read(STATE, {});
  return { accounts: s.accounts ?? {}, items: s.items ?? [] };
}

export function saveState(state) {
  write(STATE, state);
}

// Keep the seen map from growing forever: drop entries untouched for 60 days.
export function mergeSeen(prev = {}, items) {
  const cutoff = Date.now() - 60 * 864e5;
  const next = Object.fromEntries(Object.entries(prev).filter(([, t]) => new Date(t) > cutoff));
  for (const it of items) next[it.id] = it.updatedAt;
  return next;
}
