// Pure text → styled-line conversion for the TUI. A line is an array of
// segments: { text, color?, bold?, dim?, italic? }.
import { summarizeChecks } from '../detail.js';
import { ago } from '../model.js';

const seg = (text, style = {}) => ({ text, ...style });

export function wrap(text, width) {
  width = Math.max(10, width);
  const out = [];
  for (const raw of text.split('\n')) {
    if (raw.length <= width) {
      out.push(raw);
      continue;
    }
    // Continuation lines line up under the text of a list item.
    const indent = ' '.repeat(Math.min(raw.match(/^\s*(?:[-*•☐☑]|\d+\.)?\s*/)[0].length, width / 2));
    let line = '';
    for (const word of raw.split(/(\s+)/)) {
      if ((line + word).length > width && line.trim()) {
        out.push(line.trimEnd());
        line = indent + word.trimStart();
      } else {
        line += word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = indent + line.slice(width);
      }
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out;
}

// Breaks typed text into lines of at most `width`, at spaces when it can.
// Unlike wrap() above it keeps every space and empty line, so it matches what
// was typed and the cursor lands where the next character will go.
export function wrapInput(text, width) {
  width = Math.max(1, width);
  const out = [];
  for (const para of text.split('\n')) {
    let rest = para;
    while (rest.length > width) {
      const space = rest.lastIndexOf(' ', width - 1); // the space stays on this line
      const cut = space > 0 ? space + 1 : width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return out;
}

function cleanMarkdown(md) {
  return (md ?? '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[image: $1]')
    .replace(/<img[^>]*>/gi, '[image]')
    .replace(/<\/?(details|summary|p|div|sup|sub|b|i|em|strong|span|picture|source|kbd|code)[^>]*>/gi, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image: $1]')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Inline `code` spans get highlighted; state carries across wrapped lines.
function inline(text, base, state) {
  const parts = text.split('`');
  return parts
    .map((p, i) => {
      if (i > 0) state.code = !state.code;
      return p ? seg(p, state.code ? { ...base, color: 'yellow' } : base) : null;
    })
    .filter(Boolean);
}

export function markdownLines(md, width, base = {}) {
  const lines = [];
  let fence = false;
  const state = { code: false };
  for (const raw of cleanMarkdown(md).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      lines.push([seg('  ' + raw.replace(/\t/g, '  '), { color: 'cyan' })]);
      continue;
    }
    state.code = false;
    const heading = raw.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      for (const l of wrap(heading[1], width)) lines.push([seg(l, { bold: true, color: 'accent' })]);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      lines.push([seg('─'.repeat(Math.min(width, 40)), { dim: true })]);
      continue;
    }
    if (/^\s*>/.test(raw)) {
      for (const l of wrap(raw.replace(/^\s*>\s?/, ''), width - 2)) lines.push([seg('│ ', { dim: true }), ...inline(l, { ...base, dim: true }, state)]);
      continue;
    }
    const text = raw
      .replace(/^(\s*)[-*+] \[ \]/, '$1☐')
      .replace(/^(\s*)[-*+] \[[xX]\]/, '$1☑')
      .replace(/^(\s*)[-*+] /, '$1• ');
    if (/^\s*\|/.test(text)) {
      lines.push([seg(text, { ...base, dim: /^\s*\|[\s|:-]+\|\s*$/.test(text) })]); // tables: don't wrap
      continue;
    }
    for (const l of wrap(text, width)) lines.push(inline(l, base, state));
  }
  return lines;
}

const rule = (label, width) => [seg(`── ${label} `, { color: 'accent', bold: true }), seg('─'.repeat(Math.max(0, width - label.length - 4)), { dim: true })];

const STATE_COLORS = { OPEN: 'green', CLOSED: 'red', MERGED: 'magenta' };
const REVIEW_COLORS = { APPROVED: 'green', CHANGES_REQUESTED: 'red', COMMENTED: 'gray', DISMISSED: 'gray', PENDING: 'yellow' };

export function detailLines(d, width) {
  const isPr = d.kind === 'pr';
  const L = [];
  for (const l of wrap(d.title, width)) L.push([seg(l, { bold: true })]);
  L.push([
    seg(d.isDraft ? 'DRAFT' : d.state, { color: d.isDraft ? 'gray' : STATE_COLORS[d.state], bold: true }),
    seg(`  ${isPr ? 'pull request' : 'issue'} · @${d.author?.login} opened ${ago(d.createdAt)} ago · updated ${ago(d.updatedAt)} ago`, { dim: true }),
  ]);
  const facts = [];
  if (d.labels?.length) facts.push(['labels', d.labels.map((l) => l.name).join(', ')]);
  if (d.assignees?.length) facts.push(['assignees', d.assignees.map((a) => '@' + a.login).join(', ')]);
  if (d.milestone) facts.push(['milestone', `${d.milestone.title}${d.milestone.dueOn ? ` (due ${d.milestone.dueOn.slice(0, 10)})` : ''}`]);
  if (isPr) {
    facts.push(['branch', `${d.headRefName} → ${d.baseRefName}`]);
    facts.push(['changes', `+${d.additions} −${d.deletions} in ${d.changedFiles} file${d.changedFiles === 1 ? '' : 's'}`]);
    const requested = (d.reviewRequests ?? []).map((r) => '@' + (r.login ?? r.slug ?? r.name));
    facts.push(['review', `${(d.reviewDecision || 'none').toLowerCase().replace(/_/g, ' ')}${requested.length ? ` · waiting on ${requested.join(', ')}` : ''}`]);
    if (d.mergeable === 'CONFLICTING') facts.push(['merge', 'has conflicts', 'red']);
    const checks = summarizeChecks(d.statusCheckRollup);
    if (checks.total) {
      const color = checks.failed.length ? 'red' : checks.pending.length ? 'yellow' : 'green';
      const failing = checks.failed.length ? ` — failing: ${checks.failed.map((c) => c.name).join(', ')}` : '';
      facts.push(['checks', `${checks.passed}/${checks.total} passed${checks.pending.length ? `, ${checks.pending.length} running` : ''}${failing}`, color]);
    }
  }
  for (const [k, v, color] of facts) {
    const [first, ...rest] = wrap(v, width - 12);
    L.push([seg(k.padEnd(11), { dim: true }), seg(first, color ? { color } : {})]);
    for (const r of rest) L.push([seg(' '.repeat(11)), seg(r, color ? { color } : {})]);
  }

  L.push([], rule('description', width));
  L.push(...(d.body?.trim() ? markdownLines(d.body, width) : [[seg('no description', { dim: true, italic: true })]]));

  const thread = [
    ...(d.comments ?? []).map((c) => ({ at: c.createdAt, who: c.author?.login, body: c.body })),
    ...(d.reviews ?? [])
      .filter((r) => r.body || r.state !== 'COMMENTED')
      .map((r) => ({ at: r.submittedAt, who: r.author?.login, body: r.body, review: r.state })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  L.push([], rule(`discussion (${thread.length})`, width));
  if (!thread.length) L.push([seg('no comments yet', { dim: true, italic: true })]);
  for (const t of thread) {
    L.push([
      seg(`@${t.who}`, { bold: true, color: 'cyan' }),
      ...(t.review ? [seg(` ${t.review.toLowerCase().replace(/_/g, ' ')}`, { color: REVIEW_COLORS[t.review] })] : []),
      seg(` · ${ago(t.at)} ago`, { dim: true }),
    ]);
    if (t.body?.trim()) L.push(...markdownLines(t.body, width - 2).map((l) => [seg('  '), ...l]));
    L.push([]);
  }

  if (isPr && d.files?.length) {
    L.push(rule(`files (${d.files.length})`, width));
    const w = Math.max(...d.files.map((f) => `+${f.additions}`.length));
    for (const f of d.files) {
      L.push([seg(`+${f.additions}`.padStart(w + 1), { color: 'green' }), seg(` −${f.deletions}`.padEnd(7), { color: 'red' }), seg(f.path)]);
    }
  }
  return L;
}

export function diffLines(diff) {
  const L = [];
  for (const raw of diff.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    if (line.startsWith('diff --git')) {
      if (L.length) L.push([]);
      L.push([seg(line.replace(/^diff --git a\/(\S+) b\/.*/, '▌ $1'), { bold: true, color: 'accent' })]);
    } else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
      L.push([seg(line, { dim: true })]);
    } else if (line.startsWith('@@')) {
      L.push([seg(line, { color: 'cyan' })]);
    } else if (line.startsWith('+')) {
      L.push([seg(line, { color: 'green' })]);
    } else if (line.startsWith('-')) {
      L.push([seg(line, { color: 'red' })]);
    } else {
      L.push([seg(line)]);
    }
  }
  return L;
}

// Chat transcript. Thinking is collapsed unless showThinking.
export function chatLines(messages, width, { showThinking = false } = {}) {
  const L = [];
  for (const m of messages) {
    if (m.role === 'user') {
      L.push([seg('you ›', { bold: true, color: 'cyan' })]);
      for (const l of wrap(m.content, width - 2)) L.push([seg('  ' + l)]);
    } else {
      L.push([seg('ai ›', { bold: true, color: 'accent' }), ...(m.error ? [seg(' error', { color: 'red' })] : [])]);
      if (m.thinking) {
        if (showThinking) for (const l of wrap(m.thinking, width - 2)) L.push([seg('  ' + l, { dim: true, italic: true })]);
        else L.push([seg('  ▸ thought it through · ctrl+t to read', { dim: true, italic: true })]);
      }
      if (m.error) for (const l of wrap(m.error, width - 2)) L.push([seg('  ' + l, { color: 'red' })]);
      else if (m.content) L.push(...markdownLines(m.content, width - 2).map((l) => [seg('  '), ...l]));
      else if (!m.thinking) L.push([seg('  …', { dim: true })]);
    }
    L.push([]);
  }
  return L;
}

export function plainLines(text, width, style = {}) {
  return wrap(text, width).map((l) => [seg(l, style)]);
}
