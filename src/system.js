import { spawn } from 'node:child_process';

export function openUrl(url) {
  const [bin, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
}

export function copyToClipboard(text) {
  const [bin, args] =
    process.platform === 'win32'
      ? ['clip', []]
      : process.platform === 'darwin'
        ? ['pbcopy', []]
        : process.env.WAYLAND_DISPLAY
          ? ['wl-copy', []]
          : ['xclip', ['-selection', 'clipboard']];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => reject(new Error(`clipboard: ${bin} not available`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`clipboard: ${bin} exited ${code}`))));
    child.stdin.end(text);
  });
}
