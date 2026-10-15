// Building a comment: attachments from files or URLs, and the AI's draft.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_BODY = 65536; // GitHub's limit for one comment
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MARKDOWN = /\.(md|markdown|mdx|txt)$/i;

// Drag-and-drop into a terminal pastes quoted or escaped paths.
export function cleanPath(raw) {
  let p = raw.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\ /g, ' ');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

// What an attachment adds to the comment: { text } to insert, or { error }.
// Local images can't be uploaded: GitHub has no API for comment attachments.
export function attachment(raw, { cwd = process.cwd(), read = fs.readFileSync } = {}) {
  const ref = cleanPath(raw);
  if (!ref) return { error: 'type a file path or an image URL' };
  if (/^https?:\/\//i.test(ref)) {
    const name = decodeURIComponent(ref.split(/[?#]/)[0].split('/').pop() || 'image');
    return IMAGE.test(ref.split(/[?#]/)[0]) || /user-attachments|githubusercontent/.test(ref)
      ? { text: `![${name.replace(IMAGE, '')}](${ref})`, label: name }
      : { text: ref, label: ref };
  }
  const file = path.resolve(cwd, ref);
  const name = path.basename(file);
  if (IMAGE.test(file)) return { image: file, label: name, error: `GitHub can't take image uploads from the terminal · use an image URL, or ctrl+b to finish in the browser` };
  let buf;
  try {
    buf = read(file);
  } catch (err) {
    return { error: err.code === 'ENOENT' ? `no file at ${file}` : err.code === 'EISDIR' ? `${name} is a folder` : err.message };
  }
  if (buf.includes(0)) return { error: `${name} isn't a text file` };
  const text = buf.toString('utf8').replace(/\r\n/g, '\n').trimEnd();
  if (MARKDOWN.test(file)) return { text, label: name };
  // Logs, diffs, code: keep them readable as a code block.
  const lang = path.extname(file).slice(1).replace(/^(patch)$/, 'diff');
  return { text: `\`\`\`${lang}\n${text}\n\`\`\``, label: name };
}

// What the AI is asked; it writes only the comment, so it can go straight in.
export function draftPrompt({ item, login, instructions, draft }) {
  return [
    `Write a comment that @${login} will post on this ${item.kind === 'pr' ? 'pull request' : 'issue'}.`,
    instructions.trim() ? `What it should say: ${instructions.trim()}` : 'Make it useful: move the discussion forward, be specific and brief.',
    draft.trim() ? `Here is my draft so far. Improve it, keep my points, links and images, and match my voice:\n\n${draft.trim()}` : '',
    'Reply with only the comment in GitHub markdown: no preamble, no sign-off, not wrapped in quotes or a code fence.',
  ].filter(Boolean).join('\n\n');
}

// Models sometimes wrap the whole reply in a fence or think out loud first.
export function cleanDraft(text) {
  const t = text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '').trim();
  const fenced = t.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : t;
}
