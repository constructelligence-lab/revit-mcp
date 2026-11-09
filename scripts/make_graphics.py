#!/usr/bin/env python3
"""Regenerates the diagrams in assets/ (light and dark SVG). No dependencies: python3 scripts/make_graphics.py"""
# ── svg kit: a small, dependency-free set of helpers for clean, Apple-style diagrams ─────────────────────────
# Light and dark themes, system font stack, soft cards, Apple system colours. Every graphic is generated, so it
# can be reproduced and, where it shows data, regenerated from that data.
from __future__ import annotations

import html
from pathlib import Path

SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Inter, Helvetica, Arial, sans-serif'
MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace'

THEMES = {
    "light": dict(
        bg0="#fbfbfd", bg1="#f2f2f7", card="#ffffff", edge="#e5e5ea", text="#1d1d1f", sub="#6e6e73", faint="#aeaeb2",
        track="#e8e8ed", shadow=0.07, chip="#f5f5f7",
        blue="#007aff", green="#34c759", orange="#ff9500", pink="#ff2d55", purple="#af52de", teal="#30b0c7",
        indigo="#5856d6", yellow="#d4a000", red="#ff3b30", mint="#00a99d", cyan="#32ade6", brown="#a2845e",
        ink=dict(blue="#0062cc", green="#248a3d", orange="#b25000", pink="#d30f45", purple="#8944ab", teal="#00809a",
                 indigo="#4a48c0", yellow="#8a6500", red="#d70015", mint="#007a72", cyan="#0071a4", brown="#7f6a4d", faint="#6e6e73"),
    ),
    "dark": dict(
        bg0="#1c1c1e", bg1="#000000", card="#2c2c2e", edge="#3a3a3c", text="#f5f5f7", sub="#a1a1a6", faint="#636366",
        track="#3a3a3c", shadow=0.5, chip="#38383a",
        blue="#0a84ff", green="#30d158", orange="#ff9f0a", pink="#ff375f", purple="#bf5af2", teal="#40c8e0",
        indigo="#5e5ce6", yellow="#ffd60a", red="#ff453a", mint="#63e6e2", cyan="#64d2ff", brown="#ac8e68",
        ink=dict(blue="#0a84ff", green="#30d158", orange="#ff9f0a", pink="#ff375f", purple="#bf5af2", teal="#40c8e0",
                 indigo="#7d7aff", yellow="#ffd60a", red="#ff453a", mint="#63e6e2", cyan="#64d2ff", brown="#ac8e68", faint="#a1a1a6"),
    ),
}


def esc(s) -> str:
    return html.escape(str(s), quote=True)


def wrap(text: str, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        if line and len(line) + 1 + len(word) > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        lines.append(line)
    return lines


def text_width(s: str, size: float, mono: bool = False, weight: int = 400) -> float:
    k = 0.60 if mono else (0.56 if weight < 600 else 0.585)
    return len(s) * size * k


class Canvas:
    def __init__(self, w: int, h: int, theme: str, title: str, desc: str, radius: int = 28):
        self.w, self.h, self.t, self.name = w, h, THEMES[theme], theme
        self.title, self.desc, self.radius = title, desc, radius
        self.parts: list[str] = []
        self.defs: list[str] = []

    # primitives ---------------------------------------------------------------------------------------------
    def add(self, s: str):
        self.parts.append(s)

    def text(self, x, y, s, size=16, weight=400, fill=None, anchor="start", mono=False, opacity=None, spacing=None):
        fill = fill or self.t["text"]
        fam = MONO if mono else SANS
        extra = (f' opacity="{opacity}"' if opacity is not None else "") + (f' letter-spacing="{spacing}"' if spacing is not None else "")
        self.add(f'<text x="{x}" y="{y}" font-family=\'{fam}\' font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{extra}>{esc(s)}</text>')

    def lines(self, x, y, rows: list[str], size=15, weight=400, fill=None, anchor="start", lh=1.35, mono=False):
        for i, row in enumerate(rows):
            self.text(x, y + i * size * lh, row, size, weight, fill, anchor, mono)

    def rect(self, x, y, w, h, r=16, fill=None, stroke=None, sw=1, shadow=False, opacity=None):
        fill = fill or self.t["card"]
        attrs = f'fill="{fill}"' + (f' stroke="{stroke}" stroke-width="{sw}"' if stroke else "") + (f' opacity="{opacity}"' if opacity is not None else "") + (' filter="url(#sh)"' if shadow else "")
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" {attrs}/>')

    def card(self, x, y, w, h, r=20, fill=None):
        self.rect(x, y, w, h, r, fill=fill, stroke=self.t["edge"], shadow=True)

    def dot(self, cx, cy, r, color):
        self.add(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}"/>')

    def pill(self, x, y, label, color=None, size=13, weight=600, mono=False, pad=12, h=None, fill=None, anchor="start", text_fill=None):
        w = text_width(label, size, mono, weight) + pad * 2
        h = h or size + 14
        x0 = x - w / 2 if anchor == "middle" else (x - w if anchor == "end" else x)
        color = color or self.t["sub"]
        self.rect(x0, y, w, h, r=h / 2, fill=fill or self.t["chip"])
        self.text(x0 + w / 2, y + h / 2 + size * 0.35, label, size, weight, text_fill or color, "middle", mono)
        return w

    def badge(self, x, y, label, color, size=12):
        w = text_width(label, size, False, 700) + 18
        self.rect(x, y, w, size + 10, r=(size + 10) / 2, fill=color, opacity=0.14)
        self.text(x + w / 2, y + (size + 10) / 2 + size * 0.35, label, size, 700, color, "middle")
        return w

    def arrow(self, x1, y1, x2, y2, color=None, sw=2, head=7):
        color = color or self.t["faint"]
        import math
        a = math.atan2(y2 - y1, x2 - x1)
        bx, by = x2 - math.cos(a) * 1.5, y2 - math.sin(a) * 1.5
        self.add(f'<line x1="{x1}" y1="{y1}" x2="{bx}" y2="{by}" stroke="{color}" stroke-width="{sw}" stroke-linecap="round"/>')
        p1 = (x2 - head * math.cos(a - 0.5), y2 - head * math.sin(a - 0.5))
        p2 = (x2 - head * math.cos(a + 0.5), y2 - head * math.sin(a + 0.5))
        self.add(f'<path d="M{p1[0]:.1f} {p1[1]:.1f} L{x2} {y2} L{p2[0]:.1f} {p2[1]:.1f}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>')

    def elbow(self, x1, y1, x2, y2, color=None, sw=2):
        """Right, then up/down, then right into the target, with rounded corners."""
        color = color or self.t["faint"]
        mid = (x1 + x2) / 2
        r = min(10, abs(y2 - y1) / 2)
        sgn = 1 if y2 > y1 else -1
        d = f"M{x1} {y1} H{mid - r} Q{mid} {y1} {mid} {y1 + sgn * r} V{y2 - sgn * r} Q{mid} {y2} {mid + r} {y2} H{x2 - 2}"
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round"/>')
        self.add(f'<path d="M{x2 - 7} {y2 - 4} L{x2} {y2} L{x2 - 7} {y2 + 4}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>')

    # output -------------------------------------------------------------------------------------------------
    def svg(self) -> str:
        t = self.t
        head = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" role="img" aria-labelledby="t d">'
            f'<title id="t">{esc(self.title)}</title><desc id="d">{esc(self.desc)}</desc>'
            f'<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{t["bg0"]}"/><stop offset="1" stop-color="{t["bg1"]}"/></linearGradient>'
            f'<filter id="sh" x="-8%" y="-8%" width="116%" height="128%"><feDropShadow dx="0" dy="3" stdDeviation="7" flood-color="#000" flood-opacity="{t["shadow"]}"/></filter>'
            + "".join(self.defs)
            + "</defs>"
            f'<rect width="{self.w}" height="{self.h}" rx="{self.radius}" fill="url(#bg)"/>'
            f'<rect x=".5" y=".5" width="{self.w - 1}" height="{self.h - 1}" rx="{self.radius}" fill="none" stroke="{t["edge"]}"/>'
        )
        return head + "".join(self.parts) + "</svg>\n"


def header(c: Canvas, title: str, subtitle: str, x=56, y=82, size=40):
    c.text(x, y, title, size, 700, c.t["text"], spacing=-0.5)
    c.text(x, y + 34, subtitle, 18, 400, c.t["sub"])


def build(out: Path, name: str, make, *args):
    """make(theme) -> Canvas. Writes <name>-light.svg and <name>-dark.svg."""
    out.mkdir(parents=True, exist_ok=True)
    for theme in ("light", "dark"):
        (out / f"{name}-{theme}.svg").write_text(make(theme, *args).svg(), encoding="utf-8")


def picture(name: str, alt: str, folder="assets", width="100%") -> str:
    return (
        f'<p align="center">\n  <picture>\n'
        f'    <source media="(prefers-color-scheme: dark)" srcset="{folder}/{name}-dark.svg">\n'
        f'    <img src="{folder}/{name}-light.svg" alt="{esc(alt)}" width="{width}">\n'
        f'  </picture>\n</p>\n'
    )


def ink(c, color):
    for k, v in c.t.items():
        if v == color and k != 'ink' and k in c.t['ink']:
            return c.t['ink'][k]
    return color


def stage(c, x, y, w, h, color, kicker, title, lines, mono_line=None):
    c.card(x, y, w, h, 22)
    c.rect(x + 22, y + 22, 34, 6, r=3, fill=color)
    c.text(x + 22, y + 56, kicker.upper(), 12, 700, ink(c, color), spacing=1)
    c.text(x + 22, y + 86, title, 24, 700, spacing=-0.3)
    c.lines(x + 22, y + 116, lines, 15, 400, c.t["sub"], lh=1.4)
    if mono_line:
        c.pill(x + 22, y + h - 46, mono_line, c.t["sub"], 12, 500, mono=True)


def lane(c, y, color, label, sub, steps, h=96):
    t = c.t
    c.card(56, y, 1088, h, 22)
    c.rect(56, y + 18, 5, h - 36, r=2.5, fill=color)
    c.text(84, y + 40, label, 20, 700)
    c.text(84, y + 64, sub, 14, 400, t["sub"])
    x = 330
    for i, (s, strong) in enumerate(steps):
        w = text_width(s, 14, False, 600) + 30
        c.rect(x, y + h / 2 - 18, w, 36, r=18, fill=color if strong else t["chip"], opacity=0.22 if strong else None)
        c.text(x + w / 2, y + h / 2 + 5, s, 14, 600, t["text"], "middle")
        x += w
        if i < len(steps) - 1:
            c.arrow(x + 6, y + h / 2, x + 26, y + h / 2, t["faint"], 2, 6)
            x += 32


def make_render_pipeline(theme):
    W, H = 1200, 520
    c = Canvas(W, H, theme, "How revit-mcp makes a photoreal render",
               "The Revit model is exported as glTF, Blender Cycles renders it with a sun placed from the model's latitude, date and time, and the picture comes back to the assistant. Everything runs on the same machine.")
    t = c.t
    c.text(56, 84, "From a Revit model to a photoreal picture", 38, 700, spacing=-0.6)
    c.text(56, 118, "Revit cannot start its own ray tracer from outside, so the geometry leaves and the picture is made next door.", 17, 400, t["sub"])
    sw, gap, y, h = 239, 44, 160, 236
    xs = [56 + i * (sw + gap) for i in range(4)]
    stage(c, xs[0], y, sw, h, t["blue"], "1  Revit", "Your model", ["Open in Revit,", "read live.", "Nothing is uploaded."], "scene_info")
    stage(c, xs[1], y, sw, h, t["indigo"], "2  Export", "glTF 2.0", ["Geometry and material", "colours, in metres,", "Y up. Links skipped."], "export_model")
    stage(c, xs[2], y, sw, h, t["orange"], "3  Blender", "Cycles render", ["Physical sky, real glass,", "AgX colour, bloom,", "vignette. CPU or GPU."], "render_photoreal")
    stage(c, xs[3], y, sw, h, t["green"], "4  Back to you", "The picture", ["PNG still, or a turntable", "frame sequence and", "MP4 if ffmpeg is there."], "model_changed: false")
    for i in range(3):
        c.arrow(xs[i] + sw + 8, y + h / 2, xs[i + 1] - 8, y + h / 2, t["faint"], 2.5, 8)
    # sun strip
    c.card(56, 420, W - 112, 64, 18)
    c.dot(88, 452, 9, t["orange"])
    for k in range(8):
        import math
        a = k * math.pi / 4
        c.add(f'<line x1="{88 + 13 * math.cos(a):.1f}" y1="{452 + 13 * math.sin(a):.1f}" x2="{88 + 17 * math.cos(a):.1f}" y2="{452 + 17 * math.sin(a):.1f}" stroke="{t["orange"]}" stroke-width="2" stroke-linecap="round"/>')
    c.text(118, 446, "The sun is placed from the model's real latitude, the date and the time.", 16, 600)
    c.text(118, 467, "Pick a mood (golden hour, overcast) or give an exact date. Draft takes about a minute; standard and final take longer.", 14, 400, t["sub"])
    return c


def make_lanes(theme):
    W, H = 1200, 520
    c = Canvas(W, H, theme, "What revit-mcp can and cannot do to your model",
               "Reads always work. Renders and exports use a temporary view that is rolled back. Writes need two switches, a preview, an explicit apply and one undoable transaction.")
    t = c.t
    c.text(56, 84, "Read-only until you say otherwise", 38, 700, spacing=-0.6)
    c.text(56, 118, "Three kinds of request, three levels of care.", 17, 400, t["sub"])
    lane(c, 150, t["green"], "Read", "Always available", [("Ask", False), ("Live read of the open model", True), ("Answer", False)])
    lane(c, 262, t["blue"], "Render and export", "Never changes the model", [("Ask", False), ("Temporary 3D view", True), ("Image or file", False), ("View rolled back", True)])
    lane(c, 374, t["orange"], "Write", "Two tools, both previewed", [("Ask", False), ("Both switches on", True), ("Preview", False), ("apply: true", True), ("One transaction, one Ctrl+Z", True)])
    return c


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "assets"
    build(out, "render-pipeline", make_render_pipeline)
    build(out, "safety-lanes", make_lanes)
