// What the AI menu offers for one PR or issue, best fit first. Pure: built from
// the item, its details and the review threads, so it's easy to test.
import { summarizeChecks } from '../detail.js';

// kind: 'agent' (a coding agent edits your clone), 'chat' (the AI answers),
// 'merge' (gh pr merge, no AI), 'custom' (your own prompt, either way),
// 'compose' (write a comment), 'gh' (a PR change, no AI), 'local' (pulse only).
const CHAT = {
  explainPr: { label: 'Explain this PR', prompt: 'Explain what this pull request changes and why, in plain language. Then list anything that still has to happen before it can merge.' },
  blocking: { label: "What's blocking it?", prompt: 'What is stopping this pull request from merging right now? List each blocker with who or what it is waiting on, and what I should do about it.' },
  summarizeReview: { label: 'Summarize the review', prompt: 'Summarize the review feedback on this PR: what each reviewer asked for, what is already addressed, and what is still open.' },
  review: { label: 'Review this PR', prompt: 'Review this pull request. Point out bugs, risky changes and missing tests, citing file names. Be concrete and brief.' },
  summarizeChanges: { label: 'Summarize the changes', prompt: 'Summarize the changes in this PR file by file, in a few bullets. Flag anything surprising.' },
  draftReview: { label: 'Draft a review comment', prompt: 'Draft a short, constructive review comment I could post on this PR, based on the diff and discussion.' },
  explainIssue: { label: 'Explain this issue', prompt: 'Explain what this issue is about in plain language: the problem, why it matters, and any constraints from the discussion.' },
  todo: { label: 'What do I need to do?', prompt: 'Tell me exactly what I need to do to resolve this issue, as a short checklist. Mention files or areas of the code if the context shows them.' },
  discussion: { label: 'Summarize the discussion', prompt: 'Summarize the discussion so far: who wants what, what was decided, and what is still open.' },
  reply: { label: 'Draft a reply', prompt: 'Draft a short reply I could post as a comment, moving this forward. Match the tone of the thread.' },
};

const chat = (id, why) => ({ id, kind: 'chat', ...CHAT[id], why });
const agent = (task, label, why) => ({ id: task, kind: 'agent', task, label, why });

// Can this PR be merged right now? { ok, why }
export function mergeStatus(d) {
  if (!d || d.kind !== 'pr' || d.state !== 'OPEN') return { ok: false, why: d?.state?.toLowerCase() ?? 'loading' };
  if (d.isDraft) return { ok: false, why: 'draft' };
  if (d.mergeable === 'CONFLICTING' || d.mergeStateStatus === 'DIRTY') return { ok: false, why: 'has conflicts' };
  if (d.reviewDecision === 'CHANGES_REQUESTED') return { ok: false, why: 'changes requested' };
  if (summarizeChecks(d.statusCheckRollup).failed.length) return { ok: false, why: 'checks failing' };
  if (d.mergeStateStatus === 'BLOCKED') return { ok: false, why: d.reviewDecision === 'REVIEW_REQUIRED' ? 'needs an approval' : 'blocked by branch rules' };
  if (d.mergeStateStatus === 'BEHIND') return { ok: false, why: `behind ${d.baseRefName}` };
  if (['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(d.mergeStateStatus)) {
    return { ok: true, why: d.reviewDecision === 'APPROVED' ? 'approved · checks pass' : 'checks pass' };
  }
  // UNKNOWN: GitHub hasn't computed it yet; fall back to the coarse fields.
  const ok = d.mergeable === 'MERGEABLE' && d.reviewDecision !== 'REVIEW_REQUIRED';
  return { ok, why: ok ? 'mergeable' : 'not mergeable yet' };
}

// Is it safe to delete this PR's head branch? `branch` is github.branchInfo();
// `merging` means it's about to be merged, so open PRs may include this one.
// Only merged work qualifies: an unmerged branch may hold the only copy.
export function branchDeletion(d, branch, { merging = false } = {}) {
  if (!d || d.kind !== 'pr' || !d.headRefName) return { ok: false, why: 'loading' };
  if (!merging && d.state !== 'MERGED') return { ok: false, why: d.state === 'CLOSED' ? 'closed without merging' : 'not merged yet' };
  if (d.isCrossRepository) return { ok: false, why: 'the branch is on a fork' };
  if (!branch) return { ok: false, why: 'checking the branch…' };
  if (!branch.exists) return { ok: false, why: 'already deleted' };
  if (branch.isDefault || d.headRefName === d.baseRefName) return { ok: false, why: 'it is the default branch' };
  if (branch.isProtected) return { ok: false, why: 'the branch is protected' };
  const others = branch.openPrs.filter((n) => n !== d.number);
  if (others.length) return { ok: false, why: `still used by #${others.join(', #')}` };
  return { ok: true, why: d.headRefName };
}

// People who reviewed before and aren't already asked again (not you, not the author).
// `humans` (detail.fetchHumanReviewers) leaves out apps and bots, which GitHub won't re-request.
export function reReviewers(d, login, humans = null) {
  const requested = new Set((d?.reviewRequests ?? []).map((r) => r.login).filter(Boolean));
  const logins = (d?.reviews ?? []).map((r) => r.author?.login).filter(Boolean);
  return [...new Set(logins)].filter((l) => l !== login && l !== d.author?.login && !requested.has(l) && !l.endsWith('[bot]') && (!humans || humans.includes(l)));
}

// Things you do to the item yourself, after the AI suggestions.
function manageActions({ item, detail: d, login, branch, archived, humans }) {
  const out = [{ id: 'comment', kind: 'compose', label: 'Leave a comment', why: 'write it, attach a file, or let the AI draft it' }];
  if (item.kind === 'pr' && d) {
    const mine = d.author?.login === login;
    if (d.state === 'OPEN' && mine) {
      const again = reReviewers(d, login, humans);
      if (again.length) out.push({ id: 'rereview', kind: 'gh', label: 'Request a re-review', reviewers: again, why: again.map((l) => '@' + l).join(', ') });
      out.push(d.isDraft
        ? { id: 'ready', kind: 'gh', label: 'Mark ready for review', why: 'reviewers get notified' }
        : { id: 'draft', kind: 'gh', label: 'Convert to draft', why: 'not ready for review yet' });
      out.push({ id: 'close', kind: 'gh', label: 'Close this PR', why: 'without merging · can be reopened' });
    }
    const del = branchDeletion(d, branch);
    if (del.ok) out.push({ id: 'deleteBranch', kind: 'gh', label: 'Delete the branch', why: `${del.why} · merged, nothing else uses it` });
  }
  out.push(archived
    ? { id: 'unarchive', kind: 'local', label: 'Unarchive', why: 'show it in your lists again' }
    : { id: 'archive', kind: 'local', label: 'Archive', why: 'hide it from pulse until there is new activity' });
  return out;
}

export function actionsFor({ item, detail: d, threads = [], login, branch = null, archived = false, humans = null }) {
  const out = [];
  if (item.kind === 'pr') {
    const mine = d ? d.author?.login === login : item.section === 'mine';
    const checks = summarizeChecks(d?.statusCheckRollup);
    const openThreads = threads.filter((t) => !t.resolved).length;
    const requesters = (d?.reviews ?? []).filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => '@' + r.author?.login);
    if (d?.mergeable === 'CONFLICTING') out.push(agent('conflicts', 'Resolve the merge conflicts', `conflicts with ${d.baseRefName}`));
    if (d?.reviewDecision === 'CHANGES_REQUESTED') {
      const who = [...new Set(requesters)].join(', ') || 'a reviewer';
      out.push(agent('review-feedback', 'Work on the requested changes', `${who} asked${openThreads ? ` · ${openThreads} open thread${openThreads > 1 ? 's' : ''}` : ''}`));
    }
    if (checks.failed.length) out.push(agent('fix-ci', 'Fix the failing checks', checks.failed.map((c) => c.name).slice(0, 3).join(', ')));
    const merge = mergeStatus(d);
    if (merge.ok) out.push({ id: 'merge', kind: 'merge', label: 'Merge this PR', why: merge.why });
    if (mine) {
      const problems = out.some((o) => o.kind === 'agent');
      if (merge.ok) out.push(chat('explainPr'));
      else if (problems) out.push(chat('blocking'), chat('explainPr'));
      else out.push(chat('explainPr'), chat('blocking'));
      if ((d?.reviews ?? []).some((r) => r.body?.trim())) out.push(chat('summarizeReview'));
    } else {
      out.push(chat('review', item.section === 'review' ? 'your review is requested' : null), chat('summarizeChanges'), chat('draftReview'));
    }
  } else {
    const assignedToMe = d ? (d.assignees ?? []).some((a) => a.login === login) : item.section === 'assigned';
    const work = agent('implement', 'Work on this issue', 'an agent implements it in your clone');
    if (assignedToMe) out.push(chat('explainIssue'), chat('todo'), work);
    else out.push(chat('explainIssue'), chat('todo'));
    out.push(chat('discussion'), chat('reply'));
    if (!assignedToMe) out.push(work);
  }
  out.push({ id: 'custom', kind: 'custom', label: 'Custom prompt' });
  return [...out, ...manageActions({ item, detail: d, login, branch, archived, humans })];
}

// The chat options alone, as quick prompts for the chat screen.
export const chatPresetsFor = (args) => actionsFor(args).filter((a) => a.kind === 'chat');
