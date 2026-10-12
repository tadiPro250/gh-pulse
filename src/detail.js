import { gh, graphql } from './gh.js';

const ISSUE_FIELDS = 'number,title,body,author,state,labels,assignees,milestone,comments,createdAt,updatedAt,url';
const PR_FIELDS = `${ISSUE_FIELDS},isDraft,reviewRequests,reviews,files,additions,deletions,changedFiles,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`;

// Full body, comments, reviews, files and checks for one issue or PR.
export async function fetchDetail(item) {
  const isPr = item.kind === 'pr';
  const out = await gh([isPr ? 'pr' : 'issue', 'view', String(item.number), '-R', item.repo, '--json', isPr ? PR_FIELDS : ISSUE_FIELDS]);
  return { ...JSON.parse(out), kind: item.kind, repo: item.repo };
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 20) { nodes { author { login } body createdAt diffHunk } }
        }
      }
    }
  }
}`;

// Inline review comments, grouped by thread. These aren't in `gh pr view`.
export async function fetchReviewThreads(item) {
  const [owner, name] = item.repo.split('/');
  const { data } = await graphql(THREADS_QUERY, { owner, name, number: item.number });
  return (data.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((t) => ({
    resolved: t.isResolved,
    outdated: t.isOutdated,
    path: t.path,
    line: t.line ?? t.originalLine,
    hunk: t.comments.nodes[0]?.diffHunk ?? '',
    comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? 'ghost', body: c.body, at: c.createdAt })),
  }));
}

export async function fetchDiff(item) {
  return gh(['pr', 'diff', String(item.number), '-R', item.repo, '--color', 'never']);
}

// statusCheckRollup mixes CheckRuns and legacy StatusContexts.
export function summarizeChecks(rollup) {
  rollup ??= [];
  const checks = rollup.map((c) => ({
    name: c.name ?? c.context ?? 'check',
    url: c.detailsUrl ?? c.targetUrl ?? null,
    result: (c.conclusion || c.state || c.status || '').toUpperCase(),
  }));
  const failed = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(c.result));
  const pending = checks.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(c.result));
  return { total: checks.length, failed, pending, passed: checks.length - failed.length - pending.length };
}
