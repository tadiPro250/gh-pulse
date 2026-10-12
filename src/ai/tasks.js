// Prompts for the home chat (whole dashboard as context) and for tasks handed
// to a coding agent ("send to AI": fix review feedback, CI, conflicts, issues).
import { summarizeChecks } from '../detail.js';

export const HOME_PRESETS = [
  { label: 'What first?', prompt: 'Looking at everything on my plate, what should I work on first today and why? Give me an ordered list of at most 5 items.' },
  { label: 'Inbox digest', prompt: 'Summarize my unread notifications: group them by repo, call out anything that needs a reply or decision from me, and say what I can safely ignore.' },
  { label: "What's blocked?", prompt: 'Which of my pull requests are blocked, and on what (reviews, CI, conflicts, requested changes)? For each, the one thing that would unblock it.' },
];

export function buildHomeSystemPrompt({ login, tabs, maxChars = 24000 }) {
  const lines = [
    `You are an assistant inside "pulse", a terminal dashboard for GitHub work. The user is @${login}.`,
    'Below is everything currently waiting on them, grouped by section. Each line is: ref — title — status details.',
    'Help them prioritize and understand their work. Be concise; refer to items by their ref (owner/repo#123). If something is not in the data, say so.',
    '',
  ];
  for (const t of tabs) {
    lines.push(`## ${t.title ?? t.short} (${t.rows.length})`);
    for (const r of t.rows) {
      const repoRef = r.number ? `${r.repo}#${r.number}` : r.repo;
      lines.push(`- ${repoRef} — ${r.title} — ${t.key === 'inbox' ? r.reason : r.meta.map(([m]) => m).join(', ')}`);
    }
    if (!t.rows.length) lines.push('(none)');
    lines.push('');
  }
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}

export const TASKS = {
  'review-feedback': { label: 'Address requested changes', kinds: ['pr'] },
  'fix-ci': { label: 'Fix failing checks', kinds: ['pr'] },
  conflicts: { label: 'Resolve merge conflicts', kinds: ['pr'] },
  implement: { label: 'Implement this issue', kinds: ['issue'] },
  custom: { label: 'Custom prompt', kinds: ['pr', 'issue'] },
};

// Task choices for an item, the most fitting one first.
export function tasksFor(item, detail) {
  const ids = Object.keys(TASKS).filter((id) => TASKS[id].kinds.includes(item.kind));
  if (item.kind !== 'pr' || !detail) return ids;
  const checks = summarizeChecks(detail.statusCheckRollup);
  const rank = (id) => {
    if (id === 'conflicts') return detail.mergeable === 'CONFLICTING' ? 0 : 5;
    if (id === 'review-feedback') return detail.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 3;
    if (id === 'fix-ci') return checks.failed.length ? 2 : 4;
    return 9;
  };
  return ids.sort((a, b) => rank(a) - rank(b));
}

export function buildTaskPrompt({ task, item, detail: d, threads = [], notes = '', login }) {
  const isPr = item.kind === 'pr';
  const out = [];

  if (task === 'custom') {
    out.push(notes.trim() || '(write your instructions in the Notes field)');
    out.push('', `## Context: ${isPr ? 'pull request' : 'issue'} ${item.repo}#${item.number} — ${d.title}`, d.url);
    if (isPr) out.push(`Branch: ${d.headRefName} → ${d.baseRefName} (already checked out)`);
    out.push('', d.body?.trim() || '(no description)');
    return out.join('\n');
  }

  out.push(
    isPr
      ? `You are working in a local clone of ${item.repo}, on the branch of pull request #${item.number} "${d.title}" (${d.headRefName} → ${d.baseRefName}). The branch is already checked out.`
      : `You are working in a local clone of ${item.repo}, on its default branch.`,
  );

  if (task === 'review-feedback') {
    out.push('', 'Reviewers requested changes on this PR. Address every unresolved review comment below.');
    // Review bots mostly leave boilerplate ("no access", "unable to review"); keep humans.
    const isBot = (login = '') => /\[bot\]$|-ai$|^copilot-|^coderabbit|^gemini-code-assist|^sourcery/i.test(login);
    const verdicts = (d.reviews ?? []).filter(
      (r) => r.state === 'CHANGES_REQUESTED' || (r.body?.trim() && r.state === 'COMMENTED' && !isBot(r.author?.login)),
    );
    if (verdicts.length) {
      out.push('', '## Review summaries');
      for (const r of verdicts) out.push(`- @${r.author?.login} (${r.state.toLowerCase().replace(/_/g, ' ')}): ${r.body?.trim() || '(no summary)'}`);
    }
    const open = threads.filter((t) => !t.resolved);
    out.push('', `## Unresolved review threads (${open.length})`);
    if (!open.length) out.push('(none inline — work from the review summaries and discussion)');
    open.forEach((t, i) => {
      out.push('', `### ${i + 1}. ${t.path}${t.line ? `:${t.line}` : ''}${t.outdated ? ' (outdated — the code has moved since)' : ''}`);
      for (const c of t.comments) out.push(`@${c.author}: ${c.body.trim()}`);
      if (t.hunk) out.push('```diff', t.hunk.split('\n').slice(-8).join('\n'), '```');
    });
    const comments = (d.comments ?? []).slice(-8);
    if (comments.length) {
      out.push('', '## Recent conversation');
      for (const c of comments) out.push(`- @${c.author?.login}: ${c.body.trim().slice(0, 600)}`);
    }
  }

  if (task === 'fix-ci') {
    const checks = summarizeChecks(d.statusCheckRollup);
    out.push('', 'CI is failing on this PR. Find out why and fix it.', '', '## Failing checks');
    for (const c of checks.failed) out.push(`- ${c.name} (${c.result.toLowerCase()})${c.url ? ` — ${c.url}` : ''}`);
    if (!checks.failed.length) out.push('(none reported right now — run the test suite locally to confirm)');
    out.push('', `Read the logs with \`gh run list --branch ${d.headRefName}\` and \`gh run view <id> --log-failed\`, then reproduce locally.`);
  }

  if (task === 'conflicts') {
    out.push('', `This PR has merge conflicts with ${d.baseRefName}. Merge the latest ${d.baseRefName} into the branch and resolve every conflict, keeping the intent of both sides. Run the tests afterwards.`);
  }

  if (task === 'implement') {
    out.push('', `Implement issue #${item.number}: "${d.title}".`, d.url, '', '## Issue', d.body?.trim() || '(no description)');
    const comments = d.comments ?? [];
    if (comments.length) {
      out.push('', '## Discussion');
      for (const c of comments) out.push(`- @${c.author?.login}: ${c.body.trim().slice(0, 800)}`);
    }
  }

  if (isPr && task !== 'review-feedback') out.push('', '## PR description', d.body?.trim().slice(0, 3000) || '(no description)');

  out.push('', '## How to work');
  if (task === 'implement') out.push(`- Create a branch named \`pulse/issue-${item.number}\` first.`);
  out.push(
    '- Keep changes focused on this task and match the existing code style.',
    task === 'review-feedback'
      ? "- If you disagree with a review comment, don't change the code for it; explain why in your summary instead."
      : '- If something is ambiguous, pick the most conservative interpretation and say so in your summary.',
    "- Run the project's tests and linters if it has them.",
    '- Commit with a clear message. Do not push; the user will review and push.',
    `- Finish with a short summary of what you changed${task === 'review-feedback' ? ', per review comment' : ''}.`,
  );
  if (notes.trim()) out.push('', `## Extra instructions from @${login}`, notes.trim());
  return out.join('\n');
}
