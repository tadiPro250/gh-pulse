// Write a comment on a PR or issue: type it, pull in a .md or text file, add
// images by URL, or have the AI draft or polish it, then post it with gh.
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSystemPrompt } from '../ai/context.js';
import { MAX_BODY, attachment, cleanDraft, draftPrompt } from '../comment.js';
import { postComment } from '../github.js';
import { copyToClipboard, openUrl } from '../system.js';
import { accent } from '../theme.js';
import { useChatProvider } from './ai.jsx';
import { markdownLines, wrapInput } from './format.js';
import { Clickable } from './mouse.jsx';
import { Keys, Rule, Spinner, TopBar, Viewport, editText, useScroll } from './ui.jsx';

const FIELDS = ['body', 'attach', 'ai'];

// Text plus a ref that's current before the next render, for keys that
// arrive in one chunk (a pasted path and ⏎ together).
function useTyped() {
  const ref = useRef('');
  const [value, setValue] = useState('');
  const set = (f) => {
    ref.current = typeof f === 'function' ? f(ref.current) : f;
    setValue(ref.current);
  };
  return [value, set, ref];
}

// A one-line field: ⏎ submits, even at the end of a pasted chunk.
function typeLine(set, input, key, submit) {
  if (key.return) return submit();
  if (!key.ctrl && !key.meta && /[\r\n]$/.test(input)) {
    editText(set, input.replace(/[\r\n]+$/, ''), key);
    return submit();
  }
  return editText(set, input, key);
}

export function ComposeScreen({ item, login, config, getDetail, getDiff, width, height, active, onAction, toast }) {
  const { provider, error: providerError } = useChatProvider(config);
  const [field, setField] = useState(0);
  const [body, setBodyState] = useState('');
  const [attachInput, setAttachInput, attachRef] = useTyped();
  const [aiInput, setAiInput, aiRef] = useTyped();
  const [attached, setAttached] = useState([]); // { label, image? }
  const [preview, setPreview] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [undo, setUndo] = useState(null); // the body before the AI rewrote it
  const [confirm, setConfirm] = useState(null); // 'discard' | 'post'
  const abortRef = useRef(null);
  // Keys can arrive faster than renders (paste + ⏎ in one chunk).
  const bodyRef = useRef('');
  const setBody = (f) => {
    bodyRef.current = typeof f === 'function' ? f(bodyRef.current) : f;
    setBodyState(bodyRef.current);
  };
  useEffect(() => () => abortRef.current?.abort(), []);

  const textW = width - 3;
  const pendingImages = attached.filter((a) => a.image);
  const lines = useMemo(() => {
    if (preview) return body.trim() ? markdownLines(body, textW) : [[{ text: 'nothing to preview yet', dim: true }]];
    const out = wrapInput(body, textW - 1).map((l) => [{ text: l }]);
    if (field === 0 && !streaming) out.at(-1).push({ text: ' ', inverse: true });
    if (!body) out[0].push({ text: ' write your comment · markdown works · ⏎ new line', dim: true });
    return out;
  }, [body, preview, textW, field, streaming]);
  const bodyH = Math.max(3, height - 6 - (attached.length ? 1 : 0));
  const scroll = useScroll(lines.length, bodyH, { follow: !preview });

  const add = () => {
    const a = attachment(attachRef.current);
    if (a.error) {
      toast(a.error, a.image ? 'warn' : 'bad');
      if (a.image) {
        setAttached((xs) => [...xs, { label: a.label, image: a.image }]);
        setAttachInput('');
      }
      return;
    }
    if (bodyRef.current.length + a.text.length > MAX_BODY) return toast(`${a.label} would make the comment longer than GitHub allows`, 'bad');
    setBody((b) => (b.trim() ? `${b.trimEnd()}\n\n${a.text}\n` : `${a.text}\n`));
    setAttached((xs) => [...xs, { label: a.label }]);
    setAttachInput('');
    toast(`added ${a.label}`, 'good');
  };

  const draft = async () => {
    if (!provider) return toast(providerError ? `AI: ${providerError}` : 'no AI linked · s → AI', 'warn');
    const before = bodyRef.current;
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const detail = await getDetail(item);
      const diff = item.kind === 'pr' ? await getDiff(item).catch(() => null) : null;
      const system = buildSystemPrompt({ login, item, detail, diff, maxChars: config.ai.maxContextChars });
      const wire = [{ role: 'system', content: system }, { role: 'user', content: draftPrompt({ item, login, instructions: aiRef.current, draft: before }) }];
      setUndo(before);
      setBody('');
      setField(0);
      for await (const chunk of provider.stream(wire, ctrl.signal)) {
        if (chunk.type !== 'thinking') setBody((b) => b + chunk.text);
      }
      setBody((b) => cleanDraft(b) + '\n');
      setAiInput('');
      toast('AI draft ready · edit it, ctrl+z undoes', 'good');
    } catch (err) {
      if (ctrl.signal.aborted) {
        setBody((b) => cleanDraft(b));
        toast('stopped the AI · ctrl+z undoes', 'warn');
      } else {
        setBody(before);
        setUndo(null);
        toast(`AI failed: ${err.message.split('\n')[0]}`, 'bad');
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const post = async () => {
    const text = bodyRef.current.trim();
    if (!text) return toast('write something first', 'warn');
    if (text.length > MAX_BODY) return toast(`too long for GitHub (${text.length}/${MAX_BODY} characters)`, 'bad');
    if (pendingImages.length && confirm !== 'post') {
      setConfirm('post');
      return toast(`${pendingImages.length} local image${pendingImages.length > 1 ? 's' : ''} can't go up from here · ctrl+b finishes in the browser, ctrl+s again posts without`, 'warn');
    }
    setPosting(true);
    try {
      await postComment(item, text);
      toast(`commented on ${item.ref}`, 'good');
      onAction('commented', item);
    } catch (err) {
      setPosting(false);
      toast(`comment failed: ${err.message.split('\n')[0]}`, 'bad');
    }
  };

  // Images need GitHub's web editor: copy what's written, open the page.
  const finishInBrowser = async () => {
    await copyToClipboard(bodyRef.current).catch(() => {});
    openUrl(item.url);
    toast('comment copied · paste it on the page and drag your images in', 'good');
  };

  useInput(
    (input, key) => {
      if (posting) return;
      if (streaming) {
        if (key.escape) abortRef.current?.abort();
        return;
      }
      if (key.escape) {
        if (preview) return setPreview(false);
        if (bodyRef.current.trim() && confirm !== 'discard') {
          setConfirm('discard');
          return toast('esc again to throw away this comment', 'warn');
        }
        return onAction('back');
      }
      if (confirm && !(key.ctrl && input === 's')) setConfirm(null);
      if (key.ctrl && input === 's') return post();
      if (key.ctrl && input === 'p') return setPreview((v) => !v);
      if (key.ctrl && input === 'b') return finishInBrowser();
      if (key.ctrl && input === 'z') {
        if (undo === null) return toast('nothing to undo', 'warn');
        setBody(undo);
        setUndo(null);
        return toast('back to your text', 'good');
      }
      if (key.tab) return setField((f) => (f + (key.shift ? FIELDS.length - 1 : 1)) % FIELDS.length);
      if (key.pageUp || key.pageDown) return scroll.handle(input, key, { letters: false });
      const name = FIELDS[field];
      if (name === 'body') {
        if (key.upArrow || key.downArrow) return scroll.handle(input, key, { letters: false });
        if (preview) return;
        return editText(setBody, input, key, { multiline: true });
      }
      if (key.upArrow) return setField((f) => Math.max(0, f - 1));
      if (key.downArrow) return setField((f) => Math.min(FIELDS.length - 1, f + 1));
      if (name === 'attach') return typeLine(setAttachInput, input, key, add);
      if (name === 'ai') return typeLine(setAiInput, input, key, draft);
    },
    { isActive: active },
  );

  const Field = ({ i, label, value, placeholder }) => {
    const focused = field === i;
    const room = width - 15;
    return (
      <Clickable onClick={() => setField(i)}>
        <Text wrap="truncate">
          <Text color={accent()} bold>{focused ? ' ❯ ' : '   '}</Text>
          <Text dimColor={!focused} bold={focused}>{label.padEnd(10)}</Text>
          {value ? <Text>{value.length > room ? '…' + value.slice(-(room - 1)) : value}</Text> : null}
          {focused ? <Text inverse> </Text> : null}
          {!value ? <Text dimColor>{focused ? placeholder : ` ${placeholder}`}</Text> : null}
        </Text>
      </Clickable>
    );
  };

  const status = posting ? (
    <Text>
      <Spinner /> <Text dimColor>posting</Text>
    </Text>
  ) : streaming ? (
    <Text>
      <Spinner /> <Text dimColor>{`${provider?.name ?? 'AI'} is writing · esc stops`}</Text>
    </Text>
  ) : (
    <Text dimColor>{preview ? 'preview' : `${body.length} chars`}</Text>
  );

  return (
    <Box flexDirection="column" height={height}>
      <TopBar item={item} label="comment" right={status} />
      <Rule width={width} />
      <Clickable paddingLeft={1} height={bodyH} onClick={() => setField(0)} onWheel={(d) => scroll.scrollTo((o) => o + d * 3)}>
        <Viewport lines={lines} offset={scroll.offset} height={bodyH} />
      </Clickable>
      <Rule width={width} />
      <Field i={1} label="Attach" value={attachInput} placeholder="path to a .md or text file, or an image URL · ⏎ adds it" />
      {attached.length ? (
        <Text wrap="truncate">
          <Text dimColor>{'             added: '}</Text>
          {attached.map((a, i) => (
            <Text key={i}>
              {i ? <Text dimColor> · </Text> : null}
              <Text color={a.image ? 'yellow' : undefined}>{a.image ? `${a.label} (needs the browser)` : a.label}</Text>
            </Text>
          ))}
        </Text>
      ) : null}
      <Field
        i={2}
        label="Ask AI"
        value={aiInput}
        placeholder={provider ? `what should it say? · ⏎ ${body.trim() ? 'rewrites your draft' : 'drafts it'}` : 'no AI linked · s → AI'}
      />
      <Keys keys={[['ctrl+s', 'post'], ['tab', 'field'], ['ctrl+p', preview ? 'edit' : 'preview'], ...(undo !== null ? [['ctrl+z', 'undo AI']] : []), ['ctrl+b', 'browser'], ['esc', 'back']]} />
    </Box>
  );
}
