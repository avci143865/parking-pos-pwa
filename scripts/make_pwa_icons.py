"""Generate all app logos from logo.jpg (repo root).

Outputs (in static/):
  pwa-icon-192.png / pwa-icon-512.png  (purpose "any")
  pwa-maskable-192.png / pwa-maskable-512.png  (purpose "maskable", ~10% safe padding)
  logo.png  (in-app brand, 256px)
  favicon.svg  (SVG wrapper with embedded JPEG so browser tabs match too)

Usage:
    python scripts/make_pwa_icons.py [path/to/logo.jpg]
"""
from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
MASK_PAD = 0.10  # maskable safe-zone padding on each side


def load_square(src: Path) -> Image.Image:
    img = Image.open(src).convert("RGB")
    w, h = img.size
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def corner_bg(img: Image.Image) -> tuple[int, int, int]:
    small = img.resize((8, 8)).convert("RGB")
    corners = [
        small.getpixel((0, 0)), small.getpixel((7, 0)),
        small.getpixel((0, 7)), small.getpixel((7, 7)),
    ]
    return tuple(sum(c[i] for c in corners) // len(corners) for i in range(3))


def write_png(img: Image.Image, path: Path, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
    print(f"wrote {path.name} {size}x{size}")


def write_maskable(square: Image.Image, path: Path, size: int) -> None:
    bg = corner_bg(square)
    pad = int(square.width * MASK_PAD)
    canvas = Image.new("RGB", (square.width + 2 * pad, square.height + 2 * pad), bg)
    canvas.paste(square, (pad, pad))
    write_png(canvas, path, size)


def write_favicon_svg(square: Image.Image, path: Path) -> None:
    buf = io.BytesIO()
    square.resize((96, 96), Image.LANCZOS).save(buf, "JPEG", quality=78)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
        f'<image href="data:image/jpeg;base64,{b64}" x="0" y="0" width="64" height="64"/>'
        "</svg>"
    )
    path.write_text(svg, encoding="utf-8")
    print(f"wrote {path.name} ({len(svg) // 1024} KB)")


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "logo.jpg"
    if not src.is_file():
        raise SystemExit(f"logo not found: {src}")
    STATIC.mkdir(parents=True, exist_ok=True)
    square = load_square(src)
    print(f"source {src.name}: {Image.open(src).size} -> square {square.size}")
    write_png(square, STATIC / "pwa-icon-192.png", 192)
    write_png(square, STATIC / "pwa-icon-512.png", 512)
    write_maskable(square, STATIC / "pwa-maskable-192.png", 192)
    write_maskable(square, STATIC / "pwa-maskable-512.png", 512)
    write_png(square, STATIC / "logo.png", 256)
    write_favicon_svg(square, STATIC / "favicon.svg")


if __name__ == "__main__":
    main()
