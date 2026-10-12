// The accent color used across the UI. config.theme is a preset id or a hex code.

export const THEMES = [
  { id: 'pink', name: 'Pink', color: 'magenta', ansi: 35 }, // follows the terminal's palette
  { id: 'rose', name: 'Rose', color: '#fb7185' },
  { id: 'purple', name: 'Purple', color: '#a78bfa' },
  { id: 'blue', name: 'Blue', color: '#60a5fa' },
  { id: 'teal', name: 'Teal', color: '#2dd4bf' },
  { id: 'green', name: 'Green', color: '#4ade80' },
  { id: 'orange', name: 'Orange', color: '#fb923c' },
  { id: 'mono', name: 'Mono', color: 'white', ansi: 37 },
];

export const DEFAULT_THEME = 'pink';

// '#abc' / 'abc' / '#aabbcc' -> '#aabbcc', anything else -> null
export function parseHex(s) {
  const m = String(s ?? '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}

export const presetFor = (value) => THEMES.find((t) => t.id === value) ?? null;

export function themeName(value) {
  return presetFor(value)?.name ?? (parseHex(value) ? parseHex(value) : presetFor(DEFAULT_THEME).name);
}

export function themeColor(value) {
  return presetFor(value)?.color ?? parseHex(value) ?? presetFor(DEFAULT_THEME).color;
}

// Mutable so render code can read the current accent without threading props.
export const theme = { value: DEFAULT_THEME, accent: themeColor(DEFAULT_THEME) };

export function applyTheme(value) {
  theme.value = value ?? DEFAULT_THEME;
  theme.accent = themeColor(theme.value);
}

export const accent = () => theme.accent;

// Accent as a raw ANSI escape, for output written outside Ink.
export function ansiAccent(text, stream = process.stdout) {
  if (!stream.isTTY || process.env.NO_COLOR) return text;
  const preset = presetFor(theme.value);
  if (preset?.ansi) return `\x1b[${preset.ansi}m${text}\x1b[39m`;
  const hex = parseHex(theme.accent);
  if (!hex) return text;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
