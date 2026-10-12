// Builds what the model sees: who you are, why the item is on your plate,
// and the item itself (body, comments, reviews, checks, diff).
import { summarizeChecks } from '../detail.js';
import { ROLES } from '../view.js';

export function buildSystemPrompt({ login, item, detail, diff, maxChars = 24000 }) {
  const role = ROLES[item.section] ?? ROLES.inbox;
  const context = renderContext(detail, diff, maxChars);
  return [
    `You are an assistant inside "pulse", a terminal dashboard for GitHub work. The user is @${login}.`,
    `${role}${item.reason ? ` (notification reason: ${item.reason})` : ''}`,
    'Answer about the item below. Be concise and specific; refer to people by @handle and files by path. Use short markdown (lists, `code`). If the context does not contain the answer, say so instead of guessing.',
    '',
    '--- ITEM ---',
    context,
  ].join('\n');
}

function renderContext(d, diff, maxChars) {
  const isPr = d.kind === 'pr';
  const parts = [];
  parts.push(`${isPr ? 'Pull request' : 'Issue'} ${d.repo}#${d.number}: ${d.title}`);
  parts.push(`URL: ${d.url}`);
  parts.push(`State: ${d.state}${d.isDraft ? ' (draft)' : ''} · opened by @${d.author?.login} on ${d.createdAt?.slice(0, 10)} · updated ${d.updatedAt?.slice(0, 10)}`);
  if (d.labels?.length) parts.push(`Labels: ${d.labels.map((l) => l.name).join(', ')}`);
  if (d.assignees?.length) parts.push(`Assignees: ${d.assignees.map((a) => '@' + a.login).join(', ')}`);
  if (d.milestone) parts.push(`Milestone: ${d.milestone.title}${d.milestone.dueOn ? ` (due ${d.milestone.dueOn.slice(0, 10)})` : ''}`);

  if (isPr) {
    parts.push(`Branch: ${d.headRefName} → ${d.baseRefName} · +${d.additions} −${d.deletions} in ${d.changedFiles} files`);
    parts.push(`Review decision: ${d.reviewDecision || 'none'} · mergeable: ${d.mergeable}`);
    const requested = (d.reviewRequests ?? []).map((r) => '@' + (r.login ?? r.slug ?? r.name)).join(', ');
    if (requested) parts.push(`Review requested from: ${requested}`);
    const checks = summarizeChecks(d.statusCheckRollup);
    if (checks.total) {
      parts.push(
        `Checks: ${checks.passed} passed, ${checks.failed.length} failed, ${checks.pending.length} pending` +
          (checks.failed.length ? ` — failing: ${checks.failed.map((c) => c.name).join(', ')}` : ''),
      );
    }
  }

  parts.push('', '## Description', d.body?.trim() || '(no description)');

  const thread = [
    ...(d.comments ?? []).map((c) => ({ at: c.createdAt, text: `@${c.author?.login} commented:\n${c.body}` })),
    ...(d.reviews ?? [])
      .filter((r) => r.body || r.state !== 'COMMENTED')
      .map((r) => ({ at: r.submittedAt, text: `@${r.author?.login} reviewed (${r.state})${r.body ? `:\n${r.body}` : ''}` })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  if (thread.length) parts.push('', '## Discussion (oldest first)', ...thread.map((t) => `[${t.at?.slice(0, 10)}] ${t.text}`));

  if (isPr && d.files?.length) {
    parts.push('', '## Changed files', ...d.files.map((f) => `${f.path} (+${f.additions} −${f.deletions})`));
  }

  let text = parts.join('\n');
  // The diff gets whatever budget is left; the discussion matters more.
  if (diff) {
    const room = maxChars - text.length - 200;
    if (room > 1000) text += `\n\n## Diff${diff.length > room ? ' (truncated)' : ''}\n${diff.slice(0, room)}`;
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
  return text;
}
