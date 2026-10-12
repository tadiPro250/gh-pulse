// API keys live in their own file so config.json can be shared or committed
// without leaking them. Stored as plain JSON (mode 0600 where the OS supports
// it) — an environment variable is always the alternative.
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from './state.js';

const FILE = path.join(DIR, 'secrets.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function getSecret(id) {
  return read()[id] ?? null;
}

export function setSecret(id, value) {
  const data = read();
  if (value) data[id] = value;
  else delete data[id];
  write(data);
}

export const mask = (key) => (key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '');
export const secretsPath = () => FILE;
