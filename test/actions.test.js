// Unit checks for the AI menu's suggestions, the merge rules, PR actions and
// the comment composer's helpers.
import assert from 'node:assert/strict';
import { actionsFor, branchDeletion, mergeStatus, reReviewers } from '../src/ai/actions.js';
import { attachment, cleanDraft, cleanPath, draftPrompt } from '../src/comment.js';
import { deleteBranchArgs, draftArgs, mergeArgs, reReviewArgs } from '../src/github.js';
import { isArchived } from '../src/state.js';
import { wrapInput } from '../src/tui/format.js';

const pr = (over = {}) => ({
  kind: 'pr', state: 'OPEN', isDraft: false, author: { login: 'me' }, baseRefName: 'main',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: [], reviews: [], ...over,
});
const item = { kind: 'pr', repo: 'o/r', number: 7, section: 'mine' };
const all = (args) => actionsFor({ login: 'me', ...args }).map((a) => a.id);
// The AI part of the menu, up to the custom prompt.
const ids = (args) => { const a = all(args); return a.slice(0, a.indexOf('custom') + 1); };

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

// After the AI part: your own actions. An open PR of yours can be commented on,
// re-reviewed, drafted, closed and archived.
const reviewed = pr({ reviews: [{ author: { login: 'rev' } }, { author: { login: 'rev' } }, { author: { login: 'me' } }, { author: { login: 'ci[bot]' } }], reviewRequests: [] });
assert.deepEqual(all({ item, detail: reviewed }).slice(3), ['comment', 'rereview', 'draft', 'close', 'archive']);
assert.deepEqual(reReviewers(reviewed, 'me'), ['rev']);
assert.deepEqual(reReviewers(pr({ ...reviewed, reviewRequests: [{ login: 'rev' }] }), 'me'), [], 'already asked');
assert.ok(all({ item, detail: pr({ isDraft: true }) }).includes('ready'));
// Someone else's PR: comment and archive only; archived items offer unarchive.
assert.deepEqual(all({ item, detail: pr({ author: { login: 'bob' } }), archived: true }).slice(-2), ['comment', 'unarchive']);
// Issues can be commented on and archived too.
assert.deepEqual(all({ item: issue, detail: { kind: 'issue', assignees: [] } }).slice(-2), ['comment', 'archive']);

// Deleting a branch: only merged work, on this repo, nothing else using it.
const branch = { exists: true, isDefault: false, isProtected: false, openPrs: [] };
const merged = pr({ state: 'MERGED', number: 7, headRefName: 'feat' });
assert.equal(branchDeletion(merged, branch).ok, true);
assert.ok(all({ item, detail: merged, branch }).includes('deleteBranch'));
assert.equal(branchDeletion(pr({ state: 'CLOSED', headRefName: 'feat' }), branch).why, 'closed without merging');
assert.equal(branchDeletion(pr({ headRefName: 'feat' }), branch).why, 'not merged yet');
assert.equal(branchDeletion(pr({ headRefName: 'feat', number: 7 }), { ...branch, openPrs: [7] }, { merging: true }).ok, true, 'its own PR is fine while merging');
assert.equal(branchDeletion(merged, { ...branch, openPrs: [9] }).why, 'still used by #9');
assert.equal(branchDeletion({ ...merged, isCrossRepository: true }, branch).why, 'the branch is on a fork');
assert.equal(branchDeletion(merged, { ...branch, isProtected: true }).ok, false);
assert.equal(branchDeletion(merged, { ...branch, isDefault: true }).ok, false);
assert.equal(branchDeletion(merged, { ...branch, exists: false }).why, 'already deleted');
assert.equal(branchDeletion(merged, null).ok, false);

assert.deepEqual(draftArgs(item, true), ['pr', 'ready', '7', '-R', 'o/r', '--undo']);
assert.deepEqual(draftArgs(item, false), ['pr', 'ready', '7', '-R', 'o/r']);
assert.deepEqual(reReviewArgs(item, ['a', 'b']).slice(-4), ['-f', 'reviewers[]=a', '-f', 'reviewers[]=b']);
assert.equal(deleteBranchArgs('o/r', 'feat/a b')[3], 'repos/o/r/git/refs/heads/feat/a%20b');

// Archived items come back once they're updated after the archive.
const arch = { 'u1': '2026-01-02T00:00:00Z' };
assert.equal(isArchived(arch, { url: 'u1', updatedAt: '2026-01-01T00:00:00Z' }), true);
assert.equal(isArchived(arch, { url: 'u1', updatedAt: '2026-01-03T00:00:00Z' }), false);
assert.equal(isArchived(arch, { url: 'u2' }), false);

// Typed input wraps at spaces and keeps what was typed, newlines included.
assert.deepEqual(wrapInput('hello there world', 11), ['hello ', 'there world']);
assert.deepEqual(wrapInput('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
assert.deepEqual(wrapInput('a\n\nb', 10), ['a', '', 'b']);
assert.ok(wrapInput('x '.repeat(50), 7).every((l) => l.length <= 7));
assert.equal(wrapInput('a b c d e f', 4).join(''), 'a b c d e f');

// Comment attachments: markdown goes in as is, other text as a code block,
// image URLs as images, local images can't be uploaded.
const files = { '/w/notes.md': '# Hi\r\nthere\n', '/w/err.log': 'boom', '/w/bin.dat': 'a\0b' };
const read = (f) => {
  const key = f.replace(/\\/g, '/').replace(/^[A-Z]:/, '');
  if (!(key in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  return Buffer.from(files[key]);
};
const at = (raw) => attachment(raw, { cwd: '/w', read });
assert.equal(at('notes.md').text, '# Hi\nthere');
assert.equal(at('"notes.md"').text, '# Hi\nthere', 'quoted drag-and-drop path');
assert.equal(at('err.log').text, '```log\nboom\n```');
assert.match(at('bin.dat').error, /isn't a text file/);
assert.match(at('missing.md').error, /no file at/);
assert.ok(at('shot.png').image && at('shot.png').error);
assert.equal(at('https://x.io/a/cat.png?raw=1').text, '![cat](https://x.io/a/cat.png?raw=1)');
assert.equal(at('https://example.com/page').text, 'https://example.com/page');
assert.equal(cleanPath("'my file.md'"), 'my file.md');

assert.equal(cleanDraft('<think>hmm</think>\n```markdown\nLooks good!\n```'), 'Looks good!');
assert.equal(cleanDraft('Plain reply'), 'Plain reply');
assert.match(draftPrompt({ item, login: 'me', instructions: 'thank them', draft: 'thx' }), /thank them[\s\S]*my draft so far[\s\S]*thx/);
assert.doesNotMatch(draftPrompt({ item, login: 'me', instructions: '', draft: '' }), /draft so far/);
console.log('actions: all checks passed');
