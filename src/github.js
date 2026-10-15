import { gh, graphql } from './gh.js';

const PR_FIELDS = `
  id number title url isDraft createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  reviewDecision mergeable mergeStateStatus
  additions deletions
  labels(first: 5) { nodes { name } }
  reviewRequests(first: 1) { totalCount }
  latestReviews(first: 50) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } ... on Team { slug } } } }
  }
`;

const ISSUE_FIELDS = `
  id number title url createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  labels(first: 5) { nodes { name } }
  comments { totalCount }
  milestone { title dueOn }
`;

const QUERY = `
fragment pr on PullRequest { ${PR_FIELDS} }
fragment issue on Issue { ${ISSUE_FIELDS} }
query($review: String!, $reviewed: String!, $mine: String!, $assigned: String!, $mentions: String!, $limit: Int!) {
  viewer { login }
  review: search(query: $review, type: ISSUE, first: $limit) { issueCount nodes { ...pr } }
  reviewed: search(query: $reviewed, type: ISSUE, first: $limit) {
    issueCount
    nodes { ...pr ... on PullRequest { recent: commits(last: 30) { nodes { commit { committedDate } } } } }
  }
  mine: search(query: $mine, type: ISSUE, first: $limit) { issueCount nodes { ...pr } }
  assigned: search(query: $assigned, type: ISSUE, first: $limit) { issueCount nodes { ...issue } }
  mentions: search(query: $mentions, type: ISSUE, first: $limit) {
    issueCount
    nodes { __typename ...issue ... on PullRequest { id number title url createdAt updatedAt author { login } repository { nameWithOwner } } }
  }
}`;

// Search qualifiers that restrict every query to the chosen repos/orgs.
export function scopeQualifiers({ repos, orgs, excludeRepos }) {
  return [
    ...repos.map((r) => `repo:${r}`),
    ...orgs.map((o) => `org:${o}`),
    ...excludeRepos.map((r) => `-repo:${r}`),
  ].join(' ');
}

export async function fetchDashboard(scope, { limit, mentionDays }) {
  const quals = scopeQualifiers(scope);
  const since = new Date(Date.now() - mentionDays * 864e5).toISOString().slice(0, 10);
  const q = (s) => `${s} archived:false ${quals}`.trim();
  const { data, warnings } = await graphql(QUERY, {
    review: q('is:open is:pr review-requested:@me sort:created-asc'),
    reviewed: q('is:open is:pr reviewed-by:@me -author:@me -review-requested:@me sort:updated-desc'),
    mine: q('is:open is:pr author:@me sort:updated-desc'),
    assigned: q('is:open is:issue assignee:@me sort:updated-desc'),
    mentions: q(`is:open mentions:@me -author:@me updated:>=${since} sort:updated-desc`),
    limit,
  });
  const nodes = (key) => (data[key]?.nodes ?? []).filter((n) => n?.id);
  return {
    login: data.viewer.login,
    review: nodes('review'),
    reviewed: nodes('reviewed'),
    mine: nodes('mine'),
    assigned: nodes('assigned'),
    mentions: nodes('mentions'),
    totals: Object.fromEntries(['review', 'reviewed', 'mine', 'assigned', 'mentions'].map((k) => [k, data[k]?.issueCount ?? 0])),
    warnings,
  };
}

export async function fetchNotifications(scope) {
  const single = scope.repos.length === 1 && !scope.orgs.length;
  const path = single ? `repos/${scope.repos[0]}/notifications` : 'notifications';
  const list = JSON.parse(await gh(['api', `${path}?per_page=50`]));
  return list.filter((n) => {
    const repo = n.repository.full_name;
    const owner = repo.split('/')[0];
    if (scope.excludeRepos.includes(repo)) return false;
    if (!scope.repos.length && !scope.orgs.length) return true;
    return scope.repos.includes(repo) || scope.orgs.includes(owner);
  });
}

export async function markThreadsRead(ids) {
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) await gh(['api', '-X', 'PATCH', `notifications/threads/${queue.shift()}`, '--silent']);
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
}

// API URL (api.github.com/repos/o/r/pulls/1) -> web URL (github.com/o/r/pull/1)
export function webUrl(apiUrl, repoUrl) {
  if (!apiUrl) return repoUrl;
  const m = apiUrl.match(/\/repos\/([^/]+\/[^/]+)\/(pulls|issues|discussions|releases|commits)\/([^/]+)$/);
  if (!m) return repoUrl;
  // Release API URLs carry a numeric id, not the tag, so link the releases page.
  if (m[2] === 'releases') return `https://github.com/${m[1]}/releases`;
  const kind = { pulls: 'pull', issues: 'issues', discussions: 'discussions', commits: 'commit' }[m[2]];
  return `https://github.com/${m[1]}/${kind}/${m[3]}`;
}

// Merge methods the repo allows, the usual default first.
export async function mergeMethods(repo) {
  const j = JSON.parse(await gh(['repo', 'view', repo, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed']));
  const methods = [j.squashMergeAllowed && 'squash', j.mergeCommitAllowed && 'merge', j.rebaseMergeAllowed && 'rebase'].filter(Boolean);
  return methods.length ? methods : ['merge'];
}

export const mergeArgs = (item, method) => ['pr', 'merge', String(item.number), '-R', item.repo, `--${method}`];

export function mergePr(item, method) {
  return gh(mergeArgs(item, method));
}

const prOrIssue = (item) => (item.kind === 'pr' ? 'pr' : 'issue');

// The body goes over stdin, so long comments and any characters are fine.
export function postComment(item, body) {
  return gh([prOrIssue(item), 'comment', String(item.number), '-R', item.repo, '--body-file', '-'], body);
}

export function closePr(item) {
  return gh(['pr', 'close', String(item.number), '-R', item.repo]);
}

// draft = true converts to a draft; false marks it ready for review.
export const draftArgs = (item, draft) => ['pr', 'ready', String(item.number), '-R', item.repo, ...(draft ? ['--undo'] : [])];
export function setDraft(item, draft) {
  return gh(draftArgs(item, draft));
}

// Asking someone who already reviewed again is how GitHub re-requests a review.
export const reReviewArgs = (item, logins) => [
  'api', '-X', 'POST', `repos/${item.repo}/pulls/${item.number}/requested_reviewers`, '--silent',
  ...logins.flatMap((l) => ['-f', `reviewers[]=${l}`]),
];
export function requestReview(item, logins) {
  return gh(reReviewArgs(item, logins));
}

const BRANCH_QUERY = `
query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    ref(qualifiedName: $ref) {
      name
      branchProtectionRule { id }
      associatedPullRequests(states: OPEN, first: 5) { nodes { number } }
    }
  }
}`;

// What deleting a PR's head branch would touch: does it still exist, is it
// the default or protected, and which open PRs still use it?
export async function branchInfo(repo, branch) {
  const [owner, name] = repo.split('/');
  const { data } = await graphql(BRANCH_QUERY, { owner, name, ref: `refs/heads/${branch}` });
  const r = data.repository;
  return {
    exists: Boolean(r?.ref),
    isDefault: r?.defaultBranchRef?.name === branch,
    isProtected: Boolean(r?.ref?.branchProtectionRule),
    openPrs: r?.ref?.associatedPullRequests?.nodes.map((n) => n.number) ?? [],
  };
}

// Deletes the branch on GitHub only; local clones are left alone.
export const deleteBranchArgs = (repo, branch) => ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, '--silent'];
export function deleteBranch(repo, branch) {
  return gh(deleteBranchArgs(repo, branch));
}
