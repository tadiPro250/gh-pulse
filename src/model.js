const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function ago(date, now = Date.now()) {
  const ms = Math.max(0, now - new Date(date));
  if (ms < MIN) return 'now';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms < 60 * DAY) return `${Math.floor(ms / (7 * DAY))}w`;
  if (ms < 365 * DAY) return `${Math.floor(ms / (30 * DAY))}mo`;
  return `${Math.floor(ms / (365 * DAY))}y`;
}

export function ageDays(date, now = Date.now()) {
  return (now - new Date(date)) / DAY;
}

// SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null (no checks)
export function ciState(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
}

// When was *I* asked to review? Falls back to the latest request (team
// requests) and then to PR creation.
export function reviewRequestedAt(pr, login) {
  const events = pr.timelineItems?.nodes?.filter((e) => e?.createdAt) ?? [];
  const mine = events.filter((e) => e.requestedReviewer?.login === login).at(-1);
  return (mine ?? events.at(-1))?.createdAt ?? pr.createdAt;
}

export function isTeamRequest(pr, login) {
  const events = pr.timelineItems?.nodes ?? [];
  return events.length > 0 && !events.some((e) => e?.requestedReviewer?.login === login);
}

// For PRs I've already reviewed: has anything happened since?
export function sinceMyReview(pr, login) {
  const mine = pr.latestReviews?.nodes?.find((r) => r.author?.login === login);
  if (!mine?.submittedAt) return null;
  const at = new Date(mine.submittedAt);
  const newCommits = (pr.recent?.nodes ?? []).filter((c) => new Date(c.commit.committedDate) > at).length;
  const active = newCommits > 0 || new Date(pr.updatedAt) - at > 2 * MIN;
  return { myState: mine.state, reviewedAt: mine.submittedAt, newCommits, active };
}

// What's the next thing that has to happen on one of my PRs?
// Lower rank = needs my attention sooner.
export function myPrStatus(pr) {
  const ci = ciState(pr);
  const decision = pr.reviewDecision;
  const pendingReviewers = pr.reviewRequests?.totalCount ?? 0;
  if (pr.isDraft) return { label: 'draft', tone: 'dim', rank: 6 };
  if (pr.mergeable === 'CONFLICTING') return { label: 'merge conflicts', tone: 'bad', rank: 0 };
  if (ci === 'FAILURE' || ci === 'ERROR') return { label: 'CI failing', tone: 'bad', rank: 0 };
  if (decision === 'CHANGES_REQUESTED') return { label: 'changes requested', tone: 'warn', rank: 1 };
  // GitHub's own verdict: nothing (checks, reviews, branch rules) stands in the way.
  if (['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeStateStatus)) return { label: 'ready to merge', tone: 'good', rank: 2 };
  if (decision === 'APPROVED' && (ci === 'PENDING' || ci === 'EXPECTED')) return { label: 'approved · CI running', tone: 'ok', rank: 3 };
  if (decision === 'APPROVED' || (!decision && !pendingReviewers && ci === 'SUCCESS'))
    return { label: 'ready to merge', tone: 'good', rank: 2 };
  if (!pendingReviewers && decision === 'REVIEW_REQUIRED') return { label: 'no reviewers assigned', tone: 'warn', rank: 1 };
  if (ci === 'PENDING' || ci === 'EXPECTED') return { label: 'CI running', tone: 'ok', rank: 4 };
  if (pendingReviewers) return { label: `awaiting review (${pendingReviewers})`, tone: 'ok', rank: 5 };
  const reviewed = pr.latestReviews?.nodes?.length ?? 0;
  if (!reviewed) return { label: 'no reviewers requested', tone: 'warn', rank: 4 };
  return { label: 'open', tone: 'dim', rank: 5 };
}

// Mark items that are new or changed since the last time the dashboard ran.
export function freshness(item, seen) {
  if (!seen) return null; // first run: nothing to compare against
  const prev = seen[item.id];
  if (!prev) return 'new';
  return new Date(item.updatedAt) > new Date(prev) ? 'updated' : null;
}

export const until = (date) => ago(Date.now(), new Date(date));
