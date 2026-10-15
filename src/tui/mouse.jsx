// Mouse support. The terminal reports clicks and wheel turns as SGR escape
// sequences on stdin; a proxy stream strips them out before Ink sees the input
// and routes them to whichever <Clickable> is under the pointer.
import { Box } from 'ink';
import { Readable } from 'node:stream';
import { useEffect, useRef } from 'react';

const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'; // button events, SGR coordinates
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL = /\x1b\[<[\d;]*$/;

const regions = new Set();
// Settings → Mouse toggles this; refresh() re-applies it to the terminal.
export const mouseState = { enabled: true, refresh: () => {} };
let injectKeys = null; // feeds synthetic keystrokes to Ink (wheel fallback, key-bar clicks)
let lastClick = { at: 0, x: -1, y: -1 };

export function setKeyInjector(fn) {
  injectKeys = fn;
}

export function sendKeys(keys) {
  injectKeys?.(keys);
}

// handlers: { onClick({ x, y, double, button }), onWheel(dir) } with x/y relative
// to the element. Return false from a handler to let the next region try.
export function useMouse(ref, handlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const region = { ref, latest };
    regions.add(region);
    return () => regions.delete(region);
  }, []);
}

export function Clickable({ onClick, onWheel, children, ...boxProps }) {
  const ref = useRef(null);
  useMouse(ref, { onClick, onWheel });
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0} {...boxProps}>
      {children}
    </Box>
  );
}

function rectOf(node) {
  if (!node?.yogaNode) return null;
  let x = 0;
  let y = 0;
  for (let n = node; n; n = n.parentNode) {
    if (!n.yogaNode) continue;
    x += n.yogaNode.getComputedLeft();
    y += n.yogaNode.getComputedTop();
  }
  return { x, y, w: node.yogaNode.getComputedWidth(), h: node.yogaNode.getComputedHeight() };
}

// ev: { x, y } (0-based screen cells), button: left | middle | right | wheelUp | wheelDown
export function dispatchMouse(ev) {
  const hits = [];
  for (const r of regions) {
    const rect = rectOf(r.ref.current);
    if (rect && rect.w > 0 && rect.h > 0 && ev.x >= rect.x && ev.x < rect.x + rect.w && ev.y >= rect.y && ev.y < rect.y + rect.h) hits.push({ r, rect });
  }
  // The smallest region under the pointer is the most specific one.
  hits.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);

  const wheel = ev.button === 'wheelUp' ? -1 : ev.button === 'wheelDown' ? 1 : 0;
  if (wheel) {
    for (const { r } of hits) if (r.latest.current.onWheel && r.latest.current.onWheel(wheel) !== false) return;
    return sendKeys(wheel < 0 ? '\x1b[A' : '\x1b[B'); // no wheel handler: act like the arrow keys
  }
  if (ev.button !== 'left') return;
  const now = Date.now();
  const double = now - lastClick.at < 400 && lastClick.x === ev.x && lastClick.y === ev.y;
  lastClick = { at: now, x: ev.x, y: ev.y };
  for (const { r, rect } of hits) {
    const fn = r.latest.current.onClick;
    if (fn && fn({ x: ev.x - rect.x, y: ev.y - rect.y, double, button: ev.button }) !== false) return;
  }
}

function decode(b, x, y) {
  if (b & 32) return null; // motion
  const base = b & ~(4 | 8 | 16); // drop shift/meta/ctrl
  const button = base === 64 ? 'wheelUp' : base === 65 ? 'wheelDown' : ['left', 'middle', 'right'][base];
  return button ? { button, x: x - 1, y: y - 1 } : null;
}

// A stdin stand-in for Ink. While Ink has raw mode on, it reads the real stdin,
// turns mouse reporting on and forwards everything except mouse sequences.
// When Ink hands the terminal to a child process (raw mode off), it stops
// reading and turns mouse reporting off so the child gets a clean terminal.
export function createMouseStdin({ stdin = process.stdin, stdout = process.stdout, enabled = () => mouseState.enabled } = {}) {
  const proxy = new Readable({ read() {} });
  let pending = '';
  let reading = false;
  let reporting = false;

  const report = (on) => {
    if (on === reporting || !stdout.isTTY) return;
    reporting = on;
    stdout.write(on ? MOUSE_ON : MOUSE_OFF);
  };

  const onData = (chunk) => {
    let s = pending + chunk.toString('utf8');
    pending = '';
    const partial = s.match(PARTIAL);
    if (partial) {
      pending = partial[0];
      s = s.slice(0, partial.index);
    }
    const events = [];
    const rest = s.replace(SGR, (_, b, x, y, kind) => {
      if (kind === 'M') {
        const ev = decode(Number(b), Number(x), Number(y));
        if (ev) events.push(ev);
      }
      return '';
    });
    if (rest) proxy.push(rest);
    for (const ev of events) dispatchMouse(ev);
  };

  proxy.isTTY = Boolean(stdin.isTTY);
  proxy.setRawMode = (on) => {
    // Turn reporting off *before* leaving raw mode: Windows' ConPTY drops the
    // "mouse off" sequence once the console is back in cooked mode.
    if (!on) report(false);
    stdin.setRawMode?.(on);
    if (on && !reading) {
      reading = true;
      stdin.on('data', onData);
      stdin.resume();
    } else if (!on && reading) {
      reading = false;
      stdin.removeListener('data', onData);
      stdin.pause();
    }
    report(on && enabled());
    return proxy;
  };
  proxy.ref = () => (stdin.ref?.(), proxy);
  proxy.unref = () => (stdin.unref?.(), proxy);
  mouseState.refresh = () => report(reading && enabled());
  proxy.restore = () => report(false);

  setKeyInjector((keys) => proxy.push(keys));
  process.on('exit', () => {
    if (reporting) stdout.write(MOUSE_OFF);
  });
  return proxy;
}

// Clickable key hints: maps a Keys-bar label to the keystroke it stands for.
const KEY_SEQUENCES = { '⏎': '\r', esc: '\x1b', tab: '\t', space: ' ', 'any key': '\x1b', 'ctrl+t': '\x14', 'ctrl+o': '\x0f', 'ctrl+l': '\x0c', 'ctrl+s': '\x13', 'ctrl+p': '\x10', 'ctrl+z': '\x1a', 'ctrl+b': '\x02', pgup: '\x1b[5~', pgdn: '\x1b[6~' };
export function keySequence(label) {
  if (KEY_SEQUENCES[label]) return KEY_SEQUENCES[label];
  if (label.length === 1 && /[\x21-\x7e]/.test(label)) return label;
  return null; // ranges like ↑↓, 1-8 aren't a single key
}
