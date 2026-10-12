"""Turns the frames saved by record.jsx into a GIF.

usage: python scripts/demo/render.py <frames.json> <out.gif>
needs: Pillow, fontTools and ffmpeg on PATH. Picks a monospace font that ships
with Windows, macOS or Linux; pass --font / --fallback to use others.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

BG = (30, 30, 46)
FG = (205, 214, 244)
CHROME = (24, 24, 37)
# The 16 terminal colors (a Catppuccin-like dark palette; magenta is pulse's pink).
ANSI = [
    (69, 71, 90), (243, 139, 168), (166, 227, 161), (249, 226, 175),
    (137, 180, 250), (245, 163, 215), (148, 226, 213), (186, 194, 222),
    (127, 132, 156), (243, 139, 168), (166, 227, 161), (249, 226, 175),
    (137, 180, 250), (245, 163, 215), (148, 226, 213), (230, 233, 245),
]
SGR = re.compile(r"\x1b\[([0-9;]*)m")

# Monospace font for the text, and a font with the symbols it may lack (❯ ● ▸ …).
MONO_FONTS = [
    r"C:\Windows\Fonts\CascadiaMono.ttf",
    r"C:\Windows\Fonts\consola.ttf",
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
]
SYMBOL_FONTS = [
    r"C:\Windows\Fonts\seguisym.ttf",
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
]


def first_font(paths):
    return next((p for p in paths if os.path.exists(p)), paths[0])


def color256(n):
    if n < 16:
        return ANSI[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return (v, v, v)


def parse(frame, cols, rows):
    """ANSI text -> rows x cols grid of (char, fg, bg, bold, dim)."""
    grid = [[(" ", None, None, False, False)] * cols for _ in range(rows)]
    fg = bg = None
    bold = dim = inverse = False
    for y, line in enumerate(frame.split("\n")[:rows]):
        x = 0
        pos = 0
        for m in list(SGR.finditer(line)) + [None]:
            text = line[pos:m.start()] if m else line[pos:]
            for ch in text:
                if x < cols:
                    f, b = (bg or BG, fg or FG) if inverse else (fg, bg)
                    grid[y][x] = (ch, f, b, bold, dim)
                x += 1
            if not m:
                break
            pos = m.end()
            codes = [int(c) if c else 0 for c in m.group(1).split(";")]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c == 0:
                    fg = bg = None
                    bold = dim = inverse = False
                elif c == 1:
                    bold = True
                elif c == 2:
                    dim = True
                elif c == 22:
                    bold = dim = False
                elif c == 7:
                    inverse = True
                elif c == 27:
                    inverse = False
                elif 30 <= c <= 37:
                    fg = ANSI[c - 30]
                elif 90 <= c <= 97:
                    fg = ANSI[c - 90 + 8]
                elif c == 39:
                    fg = None
                elif 40 <= c <= 47:
                    bg = ANSI[c - 40]
                elif 100 <= c <= 107:
                    bg = ANSI[c - 100 + 8]
                elif c == 49:
                    bg = None
                elif c in (38, 48) and i + 1 < len(codes):
                    if codes[i + 1] == 5 and i + 2 < len(codes):
                        col = color256(codes[i + 2])
                        i += 2
                    elif codes[i + 1] == 2 and i + 4 < len(codes):
                        col = tuple(codes[i + 2:i + 5])
                        i += 4
                    else:
                        col = None
                    if c == 38:
                        fg = col
                    else:
                        bg = col
                i += 1
    return grid


def mix(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("out")
    ap.add_argument("--font", default=first_font(MONO_FONTS))
    ap.add_argument("--fallback", default=first_font(SYMBOL_FONTS))
    ap.add_argument("--size", type=int, default=15)
    args = ap.parse_args()

    data = json.load(open(args.frames, encoding="utf-8"))
    cols, rows = data["columns"], data["rows"]

    regular = ImageFont.truetype(args.font, args.size)
    bold = ImageFont.truetype(args.font, args.size)
    try:
        bold.set_variation_by_name("Bold")
    except Exception:
        pass
    fallback = ImageFont.truetype(args.fallback, args.size)
    has_glyph = set(TTFont(args.font, fontNumber=0).getBestCmap().keys())

    cw = round(regular.getlength("M"))
    ch = round(args.size * 1.32)
    pad, bar = 18, 34
    width, height = cols * cw + pad * 2, rows * ch + pad * 2 + bar
    ascent = regular.getmetrics()[0]
    baseline = (ch - args.size) // 2

    tmp = tempfile.mkdtemp(prefix="pulse-demo-")
    listing = []
    for n, f in enumerate(data["frames"]):
        img = Image.new("RGB", (width, height), BG)
        d = ImageDraw.Draw(img)
        # Window chrome: a title bar with the three traffic-light dots.
        d.rectangle([0, 0, width, bar], fill=CHROME)
        for i, dot in enumerate([(243, 139, 168), (249, 226, 175), (166, 227, 161)]):
            cx = pad + i * 20
            d.ellipse([cx, bar // 2 - 6, cx + 12, bar // 2 + 6], fill=dot)
        title = "pulse"
        d.text(((width - regular.getlength(title)) / 2, bar // 2 - ascent // 2 - 2), title, font=regular, fill=(127, 132, 156))

        for y, line in enumerate(parse(f["frame"], cols, rows)):
            py = bar + pad + y * ch
            for x, (c, fg, bg, is_bold, is_dim) in enumerate(line):
                px = pad + x * cw
                if bg:
                    d.rectangle([px, py, px + cw, py + ch], fill=bg)
                if c == " ":
                    continue
                color = fg or FG
                if is_dim:
                    color = mix(color, bg or BG, 0.45)
                # Box-drawing lines span the whole cell, so draw them instead of
                # using the glyph (which leaves gaps with the taller line height).
                if c == "│":
                    d.line([px + cw // 2, py, px + cw // 2, py + ch], fill=color, width=1)
                    continue
                if c == "─":
                    d.line([px, py + ch // 2, px + cw, py + ch // 2], fill=color, width=1)
                    continue
                font = (bold if is_bold else regular) if ord(c) in has_glyph else fallback
                d.text((px, py + baseline), c, font=font, fill=color)
        path = os.path.join(tmp, f"{n:04d}.png")
        img.save(path)
        listing.append(f"file '{path}'\nduration {f['ms'] / 1000:.3f}\n")
    listing.append(f"file '{path}'\n")  # concat needs the last file twice to honor its duration

    list_file = os.path.join(tmp, "list.txt")
    with open(list_file, "w", encoding="utf-8") as fh:
        fh.write("".join(listing).replace("\\", "/"))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list_file,
            "-vf", "split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none",
            "-fps_mode", "vfr", "-loop", "0", args.out,
        ],
        check=True,
    )
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{args.out}: {width}x{height}, {len(data['frames'])} frames, {os.path.getsize(args.out) / 1e6:.2f} MB")


if __name__ == "__main__":
    sys.exit(main())
