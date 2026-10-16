#!/usr/bin/env python3
"""Render the extension icons (purple tile, white chat bubble with log lines).

Pure standard library so it runs anywhere: python3 scripts/make_icons.py
"""

import os
import struct
import zlib

PURPLE = (145, 71, 255)
WHITE = (255, 255, 255)
SUPERSAMPLE = 4
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, a, b, c):
    def side(p, q):
        return (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1])
    d1, d2, d3 = side(a, b), side(b, c), side(c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def sample(u, v):
    """Return (rgb, alpha) for a point in unit coordinates."""
    if not in_round_rect(u, v, 0.0, 0.0, 1.0, 1.0, 0.22):
        return None
    # Chat bubble with a tail at the bottom left.
    bubble = in_round_rect(u, v, 0.17, 0.2, 0.83, 0.7, 0.1) or in_triangle(
        u, v, (0.26, 0.66), (0.42, 0.66), (0.24, 0.84)
    )
    if not bubble:
        return PURPLE
    # Three log lines inside the bubble.
    for top, right in ((0.3, 0.72), (0.415, 0.64), (0.53, 0.7)):
        if in_round_rect(u, v, 0.28, top, right, top + 0.065, 0.032):
            return PURPLE
    return WHITE


def render(size):
    rows = []
    n = SUPERSAMPLE
    for y in range(size):
        row = bytearray([0])  # PNG filter type: none
        for x in range(size):
            r = g = b = a = 0
            for sy in range(n):
                for sx in range(n):
                    hit = sample((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size)
                    if hit:
                        r += hit[0]
                        g += hit[1]
                        b += hit[2]
                        a += 1
            if a:
                row += bytes((r // a, g // a, b // a, 255 * a // (n * n)))
            else:
                row += bytes(4)
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(png(size, render(size)))
        print(path)


if __name__ == "__main__":
    main()
