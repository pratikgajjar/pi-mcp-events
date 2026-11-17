#!/usr/bin/env python3
"""Render a captured pi terminal session (tmux capture-pane -e) to a PNG.

Usage: render.py <capture.ansi> <out.png> [title]

The text is the exact program output. Adapted from
github.com/pratikgajjar/recall scripts/demo/render.py.
"""

import html
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

CHROMIUM = os.environ.get("CHROMIUM", "/Applications/Chromium.app/Contents/MacOS/Chromium")
FG, BG = "#c9d1d9", "#161b22"
PALETTE = ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
           "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"]


def page(title: str, body: str, cols: int) -> str:
    return f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;background:#0d1117}}
.w{{margin:28px;border-radius:10px;background:{BG};border:1px solid #30363d;
   box-shadow:0 18px 50px rgba(0,0,0,.55);overflow:hidden;display:inline-block}}
.t{{height:34px;background:#21262d;display:flex;align-items:center;padding:0 14px;gap:8px}}
.t i{{width:12px;height:12px;border-radius:50%;display:block}}
.t span{{color:#8b949e;font:13px -apple-system,system-ui,sans-serif;margin-left:10px}}
pre{{margin:0;padding:18px 22px 22px;color:{FG};
    font:14px/1.5 "JetBrains Mono","SF Mono",Menlo,monospace;white-space:pre-wrap;width:{cols}ch}}
.l{{display:block;margin:0 -22px;padding:0 22px}}
.p{{color:#8b949e}} .c{{color:#e6edf3;font-weight:600}}
.d{{color:#6e7681}} .m{{color:#e3b341;font-weight:600}}
.r{{color:#56d4dd}} .b{{color:#e6edf3;font-weight:600}}
</style><div class="w"><div class="t"><i style="background:#ff5f57"></i>
<i style="background:#febc2e"></i><i style="background:#28c840"></i>
<span>{html.escape(title)}</span></div><pre>{body}</pre></div>"""


def screenshot(doc: str, out_png: str, cols: int, rows: float) -> None:
    """Capture the page. 8.43 px is the advance of a 14 px SF Mono cell."""
    width = int(cols * 8.43) + 44 + 56 + 2
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "page.html"
        f.write_text(doc)
        height = 56 + 34 + 40 + int(rows * 14 * 1.5) + 4
        subprocess.run([CHROMIUM, "--headless=new", "--hide-scrollbars",
                        "--force-device-scale-factor=2", f"--window-size={width},{height}",
                        f"--screenshot={out_png}", f.as_uri()], check=True, capture_output=True)


def sgr_colour(params: list[int], i: int) -> tuple[str | None, int]:
    """Read a 38/48 extended colour at params[i]; return (css, next index)."""
    if params[i + 1] == 2:
        r, g, b = params[i + 2:i + 5]
        return f"rgb({r},{g},{b})", i + 5
    n = params[i + 2]
    if n < 16:
        return PALETTE[n], i + 3
    if n < 232:
        n -= 16
        v = [0, 95, 135, 175, 215, 255]
        return f"rgb({v[n // 36]},{v[n // 6 % 6]},{v[n % 6]})", i + 3
    g = 8 + 10 * (n - 232)
    return f"rgb({g},{g},{g})", i + 3


def ansi_lines(text: str) -> list[str]:
    """Convert tmux `capture-pane -e` output to HTML lines. A background that
    is still set at the end of a line fills the whole line, as in the terminal."""
    st = {"fg": None, "bg": None, "b": False, "dim": False, "it": False}
    out = []
    for raw in text.split("\n"):
        parts, pos = [], 0
        for m in re.finditer(r"\x1b\[([0-9;]*)m", raw):
            parts.append((raw[pos:m.start()], dict(st)))
            ps = [int(x) if x else 0 for x in m.group(1).split(";")] or [0]
            i = 0
            while i < len(ps):
                p = ps[i]
                if p == 0:
                    st.update(fg=None, bg=None, b=False, dim=False, it=False)
                elif p == 1:
                    st["b"] = True
                elif p == 2:
                    st["dim"] = True
                elif p == 3:
                    st["it"] = True
                elif p == 22:
                    st["b"] = st["dim"] = False
                elif p == 23:
                    st["it"] = False
                elif p == 39:
                    st["fg"] = None
                elif p == 49:
                    st["bg"] = None
                elif 30 <= p <= 37 or 90 <= p <= 97:
                    st["fg"] = PALETTE[p - 30 if p < 90 else p - 82]
                elif 40 <= p <= 47:
                    st["bg"] = PALETTE[p - 40]
                elif p in (38, 48):
                    css, i = sgr_colour(ps, i)
                    st["fg" if p == 38 else "bg"] = css
                    continue
                i += 1
            pos = m.end()
        parts.append((raw[pos:], dict(st)))
        spans = []
        for txt, s in parts:
            if not txt:
                continue
            css = []
            if s["fg"]:
                css.append(f"color:{s['fg']}")
            if s["bg"] and s["bg"] != st["bg"]:
                css.append(f"background:{s['bg']}")
            if s["b"]:
                css.append("font-weight:700")
            if s["dim"]:
                css.append("opacity:.6")
            if s["it"]:
                css.append("font-style:italic")
            t = html.escape(txt)
            spans.append(f'<span style="{";".join(css)}">{t}</span>' if css else t)
        line = "".join(spans) or " "
        bg = f' style="background:{st["bg"]}"' if st["bg"] else ""
        out.append(f'<span class="l"{bg}>{line}</span>')
    return out


def render(capture: str, out_png: str, title: str) -> None:
    text = Path(capture).read_text().rstrip("\n")
    # Start at the pi banner: drop the shell prompt and the launch command.
    raw = text.split("\n")
    start = next((i for i, l in enumerate(raw) if "\u2580\u2580\u2588" in re.sub(r"\x1b\[[0-9;]*m", "", l)), 0)
    text = "\n".join(raw[start:])
    lines = ansi_lines(text)
    # Fold runs of blank lines: the TUI pads between blocks.
    folded, prev = [], None
    for l in lines:
        empty = not re.sub("<[^>]+>", "", l).strip()
        key = re.search(r'class="l"( style="[^"]*")?', l).group(1) if empty else None
        if empty and key == prev:
            continue
        prev = key if empty else None
        folded.append(l)
    while folded and not re.sub("<[^>]+>", "", folded[0]).strip():
        folded.pop(0)
    cols = max(len(re.sub(r"\x1b\[[0-9;]*m", "", l)) for l in text.split("\n"))
    screenshot(page(title, "".join(folded), cols), out_png, cols, len(folded))


if __name__ == "__main__":
    src, dst = sys.argv[1], os.path.abspath(sys.argv[2])
    render(src, dst, sys.argv[3] if len(sys.argv) > 3 else "pi")
    print(dst)
