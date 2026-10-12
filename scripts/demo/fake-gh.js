// Stand-in for src/gh.js used only by the demo recording (npm run demo).
// Answers every gh call with made-up data for a fictional "acme" org, so the
// README GIF never shows anyone's real repos or notifications.

const now = Date.now();
const at = (hours) => new Date(now - hours * 3600e3).toISOString();
const login = 'mona';
let seq = 0;

const pr = (repo, number, title, author, over = {}) => ({
  id: `PR_${++seq}`,
  number,
  title,
  url: `https://github.com/${repo}/pull/${number}`,
  isDraft: false,
  createdAt: at(over.ageHours ?? 50),
  updatedAt: at(over.updatedHours ?? 3),
  author: { login: author },
  repository: { nameWithOwner: repo },
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  additions: 120,
  deletions: 30,
  labels: { nodes: [] },
  reviewRequests: { totalCount: 0 },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { committedDate: at(4), statusCheckRollup: { state: over.ci ?? 'SUCCESS' } } }] },
  timelineItems: { nodes: [{ createdAt: at(over.requestedHours ?? 30), requestedReviewer: { login } }] },
  ...over,
});

const issue = (repo, number, title, author, over = {}) => ({
  id: `I_${++seq}`,
  number,
  title,
  url: `https://github.com/${repo}/issues/${number}`,
  createdAt: at(over.ageHours ?? 120),
  updatedAt: at(over.updatedHours ?? 6),
  author: { login: author },
  repository: { nameWithOwner: repo },
  labels: { nodes: [] },
  comments: { totalCount: 4 },
  milestone: null,
  ...over,
});

const DASHBOARD = {
  viewer: { login },
  review: {
    issueCount: 3,
    nodes: [
      pr('acme/web', 90, 'Bump vite to 7', 'bob', { requestedHours: 74, additions: 48, deletions: 41 }),
      pr('acme/api', 563, 'Add rate limiting to the public API', 'priya', { requestedHours: 20, additions: 312, deletions: 18, ci: 'PENDING' }),
      pr('acme/cli', 77, 'Support --json on every command', 'lee', { requestedHours: 3, additions: 205, deletions: 64 }),
    ],
  },
  reviewed: {
    issueCount: 1,
    nodes: [
      pr('acme/web', 84, 'Dark mode for the settings page', 'sam', {
        latestReviews: { nodes: [{ author: { login }, state: 'CHANGES_REQUESTED', submittedAt: at(26) }] },
        recent: { nodes: [{ commit: { committedDate: at(5) } }, { commit: { committedDate: at(4) } }] },
      }),
    ],
  },
  mine: {
    issueCount: 4,
    nodes: [
      pr('acme/api', 551, 'Validate webhook payloads', login, {
        reviewDecision: 'CHANGES_REQUESTED',
        latestReviews: { nodes: [{ author: { login: 'sam' }, state: 'CHANGES_REQUESTED', submittedAt: at(5) }] },
        updatedHours: 5,
      }),
      pr('acme/web', 88, 'Lazy-load the dashboard charts', login, { ci: 'FAILURE', updatedHours: 9 }),
      pr('acme/cli', 71, 'Shell completions for zsh and fish', login, { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', updatedHours: 2 }),
      pr('acme/api', 549, 'Cache org lookups', login, { reviewRequests: { totalCount: 2 }, updatedHours: 30 }),
    ],
  },
  assigned: {
    issueCount: 3,
    nodes: [
      issue('acme/api', 545, 'Retry failed webhook deliveries', 'priya', { milestone: { title: 'v2.4', dueOn: new Date(now + 3 * 864e5).toISOString() } }),
      issue('acme/web', 91, 'Settings page flickers on Safari', 'bob', { updatedHours: 20 }),
      issue('acme/cli', 66, 'Document the config file', 'lee', { updatedHours: 70 }),
    ],
  },
  mentions: {
    issueCount: 2,
    nodes: [
      { __typename: 'Issue', ...issue('acme/infra', 210, 'Postgres upgrade plan', 'jo', { updatedHours: 8 }) },
      { __typename: 'PullRequest', ...issue('acme/web', 89, 'New onboarding flow', 'sam', { updatedHours: 30 }), url: 'https://github.com/acme/web/pull/89' },
    ],
  },
};

const note = (repo, type, number, title, reason, hours) => ({
  id: String(++seq),
  reason,
  unread: true,
  updated_at: at(hours),
  subject: { title, type, url: `https://api.github.com/repos/${repo}/${type === 'PullRequest' ? 'pulls' : 'issues'}/${number}` },
  repository: { full_name: repo, html_url: `https://github.com/${repo}` },
});

const NOTIFICATIONS = [
  note('acme/api', 'PullRequest', 551, 'Validate webhook payloads', 'comment', 5),
  note('acme/api', 'PullRequest', 563, 'Add rate limiting to the public API', 'review_requested', 20),
  note('acme/api', 'Issue', 545, 'Retry failed webhook deliveries', 'assign', 26),
  note('acme/api', 'Issue', 552, 'Webhook signature docs are outdated', 'subscribed', 40),
  note('acme/web', 'PullRequest', 90, 'Bump vite to 7', 'review_requested', 74),
  note('acme/web', 'PullRequest', 88, 'Lazy-load the dashboard charts', 'ci_activity', 9),
  note('acme/web', 'PullRequest', 89, 'New onboarding flow', 'mention', 30),
  note('acme/web', 'Issue', 91, 'Settings page flickers on Safari', 'assign', 20),
  note('acme/cli', 'PullRequest', 77, 'Support --json on every command', 'review_requested', 3),
  note('acme/cli', 'PullRequest', 71, 'Shell completions for zsh and fish', 'author', 2),
  note('acme/infra', 'Issue', 210, 'Postgres upgrade plan', 'mention', 8),
];

const DETAIL = {
  number: 551,
  title: 'Validate webhook payloads',
  body: 'Rejects webhook payloads that fail schema validation instead of crashing the worker.',
  author: { login },
  state: 'OPEN',
  labels: [],
  assignees: [{ login }],
  milestone: null,
  comments: [],
  createdAt: at(50),
  updatedAt: at(5),
  url: 'https://github.com/acme/api/pull/551',
  isDraft: false,
  reviewRequests: [],
  reviews: [{ author: { login: 'sam' }, state: 'CHANGES_REQUESTED', body: 'Looks good overall. Please add a null check before reading `payload.repository`.', submittedAt: at(5) }],
  files: [{ path: 'src/webhooks/validate.ts', additions: 84, deletions: 12 }],
  additions: 120,
  deletions: 30,
  changedFiles: 3,
  baseRefName: 'main',
  headRefName: 'validate-webhooks',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'lint', conclusion: 'SUCCESS' }],
};

const THREADS = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            isOutdated: false,
            path: 'src/webhooks/validate.ts',
            line: 42,
            originalLine: 42,
            comments: { nodes: [{ author: { login: 'sam' }, body: 'This can be null for org-level events.', createdAt: at(5), diffHunk: '@@ -40,3 +40,4 @@\n+  const repo = payload.repository.full_name;' }] },
          },
        ],
      },
    },
  },
};

const AUTH = { hosts: { 'github.com': [{ login, active: true, state: 'success', scopes: 'repo, read:org', tokenSource: 'keyring' }] } };

export async function gh(args) {
  const cmd = args.join(' ');
  if (cmd.startsWith('auth status')) return JSON.stringify(AUTH);
  if (cmd.startsWith('api notifications') || /^api repos\/.+\/notifications/.test(cmd)) return JSON.stringify(NOTIFICATIONS);
  if (/^(pr|issue) view/.test(cmd)) return JSON.stringify({ ...DETAIL, number: Number(args[2]) });
  if (cmd.startsWith('pr diff')) return '--- a/src/webhooks/validate.ts\n+++ b/src/webhooks/validate.ts\n@@ -40,3 +40,4 @@\n+  const repo = payload.repository.full_name;\n';
  if (cmd.startsWith('repo view')) return JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false, nameWithOwner: 'acme/api' });
  return '';
}

export async function ghInteractive() {
  return 0;
}

export async function graphql(query) {
  if (query.includes('reviewThreads')) return { data: THREADS, warnings: [] };
  return { data: DASHBOARD, warnings: [] };
}

export async function currentRepo() {
  return 'acme/api';
}
