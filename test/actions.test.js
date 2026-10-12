// Unit checks for the AI menu's suggestions and the merge rules.
import assert from 'node:assert/strict';
import { actionsFor, mergeStatus } from '../src/ai/actions.js';
import { mergeArgs } from '../src/github.js';

const pr = (over = {}) => ({
  kind: 'pr', state: 'OPEN', isDraft: false, author: { login: 'me' }, baseRefName: 'main',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: [], reviews: [], ...over,
});
const item = { kind: 'pr', repo: 'o/r', number: 7, section: 'mine' };
const ids = (args) => actionsFor({ login: 'me', ...args }).map((a) => a.id);

// Ready PR: merge first, always a custom prompt last.
assert.deepEqual(ids({ item, detail: pr() }), ['merge', 'explainPr', 'custom']);
assert.equal(mergeStatus(pr()).ok, true);

// Changes requested: work on them first, no merge.
const cr = pr({ reviewDecision: 'CHANGES_REQUESTED', reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'rev' }, body: 'fix x' }] });
const crActions = actionsFor({ item, detail: cr, login: 'me', threads: [{ resolved: false }, { resolved: true }] });
assert.equal(crActions[0].id, 'review-feedback');
assert.match(crActions[0].why, /@rev asked · 1 open thread/);
assert.ok(!crActions.some((a) => a.kind === 'merge'));

// Conflicts and failing CI, most urgent first.
const broken = pr({ mergeable: 'CONFLICTING', statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] });
assert.deepEqual(ids({ item, detail: broken }).slice(0, 2), ['conflicts', 'fix-ci']);

// Blocked states explain why.
assert.equal(mergeStatus(pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })).why, 'needs an approval');
assert.equal(mergeStatus(pr({ mergeStateStatus: 'BEHIND' })).why, 'behind main');
assert.equal(mergeStatus(pr({ isDraft: true })).ok, false);

// Someone else's PR: review-style suggestions.
assert.deepEqual(ids({ item: { ...item, section: 'review' }, detail: pr({ author: { login: 'bob' }, mergeStateStatus: 'BLOCKED' }) }), ['review', 'summarizeChanges', 'draftReview', 'custom']);

// Issues: explain first; "work on it" moves up when it's assigned to you.
const issue = { kind: 'issue', repo: 'o/r', number: 3, section: 'assigned' };
assert.deepEqual(ids({ item: issue, detail: { kind: 'issue', assignees: [{ login: 'me' }] } }), ['explainIssue', 'todo', 'implement', 'discussion', 'reply', 'custom']);
assert.deepEqual(ids({ item: { ...issue, section: 'mentions' }, detail: { kind: 'issue', assignees: [] } }).at(-2), 'implement');

assert.deepEqual(mergeArgs(item, 'squash'), ['pr', 'merge', '7', '-R', 'o/r', '--squash']);
console.log('actions: all checks passed');
