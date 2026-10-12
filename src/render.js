// Plain-text rendering (pulse --print, pipes) and the column layout shared with the TUI.
import { styleText } from 'node:util';
import { ansiAccent, theme } from './theme.js';
import { reasonLabel } from './view.js';

export const TONES = {
  bad: 'red',
  warn: 'yellow',
  good: 'green',
  ok: 'cyan',
  dim: 'gray',
  get accent() {
    return theme.accent;
  },
};

// tone: a TONES key, a styleText format, or an array of them. 'accent' may be a hex color.
export const paint = (tone, s) => {
  const tones = [tone].flat().filter(Boolean);
  const accented = tones.includes('accent');
  const fmt = tones.filter((t) => t !== 'accent').map((t) => TONES[t] ?? t);
  const out = fmt.length ? styleText(fmt, String(s)) : String(s);
  return accented ? ansiAccent(out) : out;
};

export function fit(s, w) {
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w);
}

// "owner/a-very-long-repo#123" -> "owner/a-very-lo…#123": the number must survive.
export function fitRef(s, w) {
  const hash = s.lastIndexOf('#');
  if (s.length <= w || hash <= 0) return fit(s, w);
  const num = s.slice(hash);
  return fit(s.slice(0, hash), w - num.length).trimEnd() + num;
}

// Segments are ordered by importance: keep as many as fit, truncating the
// first one if even it is too long.
export function fitMeta(segments, budget) {
  const kept = [];
  let used = 0;
  for (const [text, tone] of segments) {
    const cost = (kept.length ? 3 : 0) + text.length;
    if (used + cost > budget) {
      if (!kept.length) kept.push([fit(text, Math.max(8, budget)).trimEnd(), tone]);
      break;
    }
    kept.push([text, tone]);
    used += cost;
  }
  return kept;
}

// Column widths for a list of rows. `gutter` is whatever precedes the ref
// (index numbers, cursor, freshness flag).
export function layoutRows(rows, width, gutter) {
  if (!rows.length) return { refW: 0, titleW: 0, metaBudget: 0 };
  const refW = Math.min(36, Math.max(...rows.map((r) => r.ref.length)));
  const metaW = Math.max(...rows.map((r) => r.meta.map(([t]) => t).join(' · ').length));
  const prefixW = gutter + refW + 2;
  const longestTitle = Math.max(...rows.map((r) => r.title.length));
  // Titles get whatever meta leaves over, but never less than ~40% of the line.
  const titleW = Math.max(10, Math.min(longestTitle, Math.max(width - prefixW - metaW - 3, Math.floor(width * 0.4))));
  return { refW, titleW, metaBudget: Math.max(0, width - prefixW - titleW - 3) };
}

const FLAGS = {
  new: () => paint('cyan', '●'),
  updated: () => paint('yellow', '●'),
};

// rows: [{ n, flag, ref, title, meta }]
export function renderSection({ title, note, rows, total = rows.length, empty = 'nothing here' }) {
  const out = [];
  const count = total > 0 ? paint('dim', ` ${total}`) : '';
  out.push(` ${paint(['bold', 'accent'], '▌')} ${paint('bold', title.toUpperCase())}${count}${note ? paint('dim', `  ${note}`) : ''}`);

  if (!rows.length) {
    out.push(paint('dim', `     ✓ ${empty}`), '');
    return out.join('\n');
  }

  const width = Math.max(60, process.stdout.columns || 120);
  const nW = Math.max(...rows.map((r) => String(r.n).length));
  const { refW, titleW, metaBudget } = layoutRows(rows, width, 2 + nW + 3);

  for (const r of rows) {
    const flag = r.flag ? FLAGS[r.flag]() : ' ';
    const meta = fitMeta(r.meta, metaBudget).map(([t, tone]) => paint(tone, t)).join(paint('dim', ' · '));
    out.push(
      `  ${paint('dim', String(r.n).padStart(nW))} ${flag} ${paint('cyan', fitRef(r.ref, refW))}  ${fit(r.title, titleW)}  ${meta}`,
    );
  }
  if (total > rows.length) out.push(paint('dim', `     … ${total - rows.length} more (raise --limit)`));
  out.push('');
  return out.join('\n');
}

export function renderHeader({ login, scope, notifications }) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const left = `${paint(['bold', 'accent'], ' pulse')}  ${paint('bold', '@' + login)}${scope ? paint('dim', `  ·  ${scope}`) : ''}${paint('dim', `  ·  ${time}`)}`;
  let right = '';
  if (notifications) {
    const n = notifications.length;
    right = n ? `${paint('yellow', '✉')} ${n} unread${paint('dim', ` (${summarizeReasons(notifications)})`)}` : paint('dim', '✉ inbox zero');
  }
  return `${left}${right ? '    ' + right : ''}\n`;
}

export function summarizeReasons(list) {
  const counts = {};
  for (const n of list) counts[reasonLabel(n.reason)] = (counts[reasonLabel(n.reason)] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
}

export function renderFooter(hasFlags) {
  const cmds = ['open', 'view', 'diff', 'co'].map((c) => `${paint('bold', c)} ${paint('dim', '<n>')}`).join(paint('dim', '  '));
  const legend = hasFlags ? `   ${FLAGS.new()} ${paint('dim', 'new')}  ${FLAGS.updated()} ${paint('dim', 'updated since last run')}` : '';
  return ` ${paint('dim', 'pulse')} ${cmds}${legend}`;
}
