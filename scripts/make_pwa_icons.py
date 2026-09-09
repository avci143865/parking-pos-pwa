"""Generate PWA PNG icons without extra dependencies."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "static"


def png(width: int, height: int, pixels: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * stride : (y + 1) * stride])
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def color_at(x: int, y: int, size: int) -> tuple[int, int, int, int]:
    cx = cy = size / 2
    dx, dy = x - cx, y - cy
    r = (dx * dx + dy * dy) ** 0.5
    pad = size * 0.06
    if x < pad or y < pad or x > size - pad or y > size - pad:
        return (7, 10, 15, 255)
    # rounded-ish cyan tile
    if r > size * 0.48:
        return (7, 10, 15, 255)
    # QR-like finder squares
    s = size
    def in_finder(fx: float, fy: float) -> bool:
        ox, oy = x / s - fx, y / s - fy
        if abs(ox) > 0.14 or abs(oy) > 0.14:
            return False
        inner = abs(ox) < 0.055 and abs(oy) < 0.055
        ring = abs(ox) > 0.10 or abs(oy) > 0.10
        return inner or ring

    if in_finder(0.32, 0.32) or in_finder(0.68, 0.32) or in_finder(0.32, 0.68):
        return (255, 255, 255, 255)
    cell = int(size / 18)
    if cell and ((x // cell) + (y // cell)) % 3 == 0 and r < size * 0.36:
        return (224, 247, 250, 255)
    return (8, 145, 178, 255)


def write_icon(path: Path, size: int) -> None:
    buf = bytearray(size * size * 4)
    i = 0
    for y in range(size):
        for x in range(size):
            r, g, b, a = color_at(x, y, size)
            buf[i : i + 4] = bytes((r, g, b, a))
            i += 4
    path.write_bytes(png(size, size, bytes(buf)))


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    write_icon(ROOT / "pwa-icon-192.png", 192)
    write_icon(ROOT / "pwa-icon-512.png", 512)
    (ROOT / "logo.png").write_bytes((ROOT / "pwa-icon-192.png").read_bytes())


if __name__ == "__main__":
    main()
