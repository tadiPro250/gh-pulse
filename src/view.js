// Turns raw GitHub data into display rows. Shared by the TUI and the plain
// text output, so both always agree on ordering, labels and colors.
import { webUrl } from './github.js';
import { ago, ageDays, ciState, freshness, isTeamRequest, myPrStatus, reviewRequestedAt, sinceMyReview, until } from './model.js';

export const SECTION_KEYS = ['review', 'reviewed', 'mine', 'assigned', 'mentions'];

// The list sections in the TUI sidebar, in order. Any of them can be hidden (config.hiddenSections).
export const LIST_SECTIONS = [
  ['review', 'Review', 'PRs waiting on your review'],
  ['reviewed', 'Follow-up', 'PRs you reviewed that changed since'],
  ['mine', 'My PRs', 'your open PRs and what blocks them'],
  ['assigned', 'Issues', 'issues assigned to you'],
  ['mentions', 'Mentions', 'threads that mention you'],
  ['inbox', 'Inbox', 'unread notifications'],
];

// Why is this item on my plate? Fed to the AI as context.
export const ROLES = {
  review: 'Your review was requested on this pull request.',
  reviewed: 'You already reviewed this pull request and it has changed since.',
  mine: 'You are the author of this pull request.',
  assigned: 'This issue is assigned to you.',
  mentions: 'You were mentioned in this thread.',
  inbox: 'This showed up in your GitHub notifications.',
};

// row: { id, section, kind, repo, number, url, flag, ref, title, author, meta: [[text, tone?], ...] }
export function buildView(data, { all = false, singleRepo = false, seen = null, settings }) {
  const login = data.login;
  const shown = new Set();

  const row = (section, node, kind, meta) => {
    shown.add(node.id);
    return {
      id: node.id,
      section,
      kind,
      repo: node.repository.nameWithOwner,
      number: node.number,
      url: node.url,
      flag: freshness(node, seen),
      ref: singleRepo ? `#${node.number}` : `${node.repository.nameWithOwner}#${node.number}`,
      title: node.title,
      author: node.author?.login ?? 'ghost',
      meta,
    };
  };

  const review = data.review
    .map((pr) => ({ pr, since: reviewRequestedAt(pr, login) }))
    .sort((a, b) => new Date(a.since) - new Date(b.since))
    .map(({ pr, since }) => {
      const days = ageDays(since);
      return Object.assign(row('review', pr, 'pr', [
        [`@${pr.author?.login ?? 'ghost'}`],
        [`waiting ${ago(since)}`, days >= settings.staleReviewDays ? 'bad' : days >= 1 ? 'warn' : 'dim'],
        [`+${pr.additions} −${pr.deletions}`, 'dim'],
        ...ciMeta(pr),
        ...(pr.isDraft ? [['draft', 'dim']] : []),
        ...(isTeamRequest(pr, login) ? [['via team', 'dim']] : []),
      ]), { waitingDays: days });
    });

  const withActivity = data.reviewed.map((pr) => ({ pr, s: sinceMyReview(pr, login) })).filter(({ s }) => s && (all || s.active));
  const quiet = data.reviewed.length - withActivity.length;
  const reviewed = withActivity.map(({ pr, s }) =>
    row('reviewed', pr, 'pr', [
      [`@${pr.author?.login ?? 'ghost'}`],
      s.newCommits
        ? [`${s.newCommits} new commit${s.newCommits > 1 ? 's' : ''}`, 'warn']
        : s.active
          ? [`activity ${ago(pr.updatedAt)} ago`, 'ok']
          : ['no changes', 'dim'],
      [`you ${reviewVerb(s.myState)} ${ago(s.reviewedAt)} ago`, 'dim'],
      ...ciMeta(pr),
    ]),
  );

  const mine = data.mine
    .map((pr) => ({ pr, status: myPrStatus(pr) }))
    .sort((a, b) => a.status.rank - b.status.rank || new Date(b.pr.updatedAt) - new Date(a.pr.updatedAt))
    .map(({ pr, status }) => {
      const approvals = pr.latestReviews?.nodes?.filter((r) => r.state === 'APPROVED').length ?? 0;
      return Object.assign(row('mine', pr, 'pr', [
        [status.label, status.tone],
        ...(approvals ? [[`${approvals} ✓`, 'good']] : []),
        ...ciMeta(pr),
        [`updated ${ago(pr.updatedAt)}`, 'dim'],
      ]), { status });
    });

  const assigned = data.assigned.map((is) => {
    const due = is.milestone?.dueOn;
    const overdue = due && new Date(due) < Date.now();
    const soon = due && !overdue && new Date(due) - Date.now() < 7 * 864e5;
    const comments = is.comments.totalCount;
    return Object.assign(row('assigned', is, 'issue', [
      ...(due ? [[overdue ? `overdue ${ago(due)}` : `due in ${until(due)}`, overdue ? 'bad' : soon ? 'warn' : 'dim']] : []),
      ...is.labels.nodes.slice(0, 2).map((l) => [l.name, labelTone(l.name)]),
      [`updated ${ago(is.updatedAt)}`, 'dim'],
      ...(comments ? [[`${comments} comment${comments > 1 ? 's' : ''}`, 'dim']] : []),
      ...(is.milestone ? [[is.milestone.title.slice(0, 24), 'accent']] : []),
    ]), { dueAt: due ?? null });
  });

  const mentions = data.mentions
    .filter((n) => !shown.has(n.id))
    .map((n) =>
      row('mentions', n, n.__typename === 'PullRequest' ? 'pr' : 'issue', [
        [n.__typename === 'PullRequest' ? 'PR' : 'issue', 'dim'],
        [`@${n.author?.login ?? 'ghost'}`],
        [`updated ${ago(n.updatedAt)}`, 'dim'],
      ]),
    );

  return [
    { key: 'review', title: 'Needs your review', short: 'Review', rows: review, total: data.totals.review, empty: 'no review requests — nice' },
    {
      key: 'reviewed',
      title: 'Follow up on your reviews',
      short: 'Follow-up',
      note: quiet && !all ? `${quiet} quiet hidden` : 'changed since you reviewed',
      rows: reviewed,
      empty: 'nothing changed since your reviews',
    },
    { key: 'mine', title: 'Your pull requests', short: 'My PRs', rows: mine, total: data.totals.mine, empty: 'no open PRs' },
    { key: 'assigned', title: 'Assigned issues', short: 'Issues', rows: assigned, total: data.totals.assigned, empty: 'no issues assigned to you' },
    { key: 'mentions', title: 'Mentions', short: 'Mentions', note: `last ${settings.mentionDays}d`, rows: mentions, empty: 'no recent mentions' },
  ];
}

export function notificationRows(list) {
  return list.map((n) => {
    const repo = n.repository.full_name;
    const number = Number(n.subject.url?.match(/\/(?:pulls|issues)\/(\d+)$/)?.[1]) || null;
    const kind = n.subject.type === 'PullRequest' ? 'pr' : n.subject.type === 'Issue' ? 'issue' : 'link';
    const tone = ['review_requested', 'mention', 'assign', 'security_alert'].includes(n.reason) ? 'warn' : 'dim';
    return {
      id: n.id,
      threadId: n.id,
      section: 'inbox',
      reason: n.reason,
      updatedAt: n.updated_at,
      subjectType: n.subject.type,
      kind,
      repo,
      number,
      url: webUrl(n.subject.url, n.repository.html_url),
      flag: null,
      ref: number ? `${repo}#${number}` : repo,
      title: n.subject.title,
      meta: [[reasonLabel(n.reason), tone], [ago(n.updated_at), 'dim'], ...(kind === 'link' ? [[n.subject.type, 'dim']] : [])],
    };
  });
}

const REASONS = {
  review_requested: 'review',
  mention: 'mention',
  team_mention: 'team',
  assign: 'assigned',
  author: 'yours',
  comment: 'comment',
  ci_activity: 'ci',
  state_change: 'state',
  subscribed: 'watching',
  manual: 'subscribed',
  security_alert: 'security',
  approval_requested: 'approval',
  invitation: 'invite',
};

export const reasonLabel = (r) => REASONS[r] ?? r.replace(/_/g, ' ');

function ciMeta(pr) {
  const ci = ciState(pr);
  if (ci === 'SUCCESS') return [['CI ✓', 'good']];
  if (ci === 'FAILURE' || ci === 'ERROR') return [['CI ✗', 'bad']];
  if (ci === 'PENDING' || ci === 'EXPECTED') return [['CI …', 'warn']];
  return [];
}

function reviewVerb(state) {
  return { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'were dismissed' }[state] ?? 'reviewed';
}

function labelTone(name) {
  const n = name.toLowerCase();
  if (/bug|crit|urgent|p0|p1|security|blocker/.test(n)) return 'bad';
  if (/feat|enhance/.test(n)) return 'ok';
  return 'dim';
}
