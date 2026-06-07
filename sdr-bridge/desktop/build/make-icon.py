#!/usr/bin/env python3
"""Generate SafeT SDR app icon (radio tower + signal) as PNG + multi-res ICO.
Pure stdlib: renders one supersampled master, box-downsamples to each size."""
import math, zlib, struct, os, sys

MA = 768  # master render size (divisible by every target)
SIZES = [16, 24, 32, 48, 64, 128, 256]

BG_TOP = (0x20/255, 0x2b/255, 0x39/255)
BG_BOT = (0x0e/255, 0x13/255, 0x19/255)
BLUE   = (0x3b/255, 0x82/255, 0xf6/255)
BLUE_L = (0x8a/255, 0xb8/255, 0xff/255)
WHITE  = (0xea/255, 0xf1/255, 0xff/255)

def clamp01(x): return 0.0 if x < 0 else 1.0 if x > 1 else x
def lerp(a, b, t): return a + (b - a) * t

EX, EY = 0.5, 0.30  # signal emitter / antenna tip

def rrect_cov(nx, ny, rad):
    dx = abs(nx - 0.5) - (0.5 - rad)
    dy = abs(ny - 0.5) - (0.5 - rad)
    ox, oy = max(dx, 0.0), max(dy, 0.0)
    d = math.hypot(ox, oy) + min(max(dx, dy), 0.0) - rad
    return clamp01(0.5 - d / 0.006)

def cov_dist(dist, hw, e=0.0045):
    return clamp01(0.5 + (hw - dist) / e)

def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else clamp01((wx * vx + wy * vy) / L)
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))

RINGS = [(0.18, 1.0), (0.26, 0.7), (0.34, 0.45)]

def shade(nx, ny):
    bg = rrect_cov(nx, ny, 0.17)
    t = clamp01((ny - 0.05) / 0.9)
    r = lerp(BG_TOP[0], BG_BOT[0], t)
    g = lerp(BG_TOP[1], BG_BOT[1], t)
    b = lerp(BG_TOP[2], BG_BOT[2], t)

    def over(col, cov):
        nonlocal r, g, b
        c = clamp01(cov) * bg
        r = lerp(r, col[0], c); g = lerp(g, col[1], c); b = lerp(b, col[2], c)

    # signal arcs (behind the tower)
    vx, vy = nx - EX, ny - EY
    dist = math.hypot(vx, vy)
    updot = (-vy / dist) if dist > 1e-6 else 0.0
    gate = clamp01((updot - 0.32) / 0.16)
    if gate > 0:
        for R, alpha in RINGS:
            over(BLUE_L, cov_dist(abs(dist - R), 0.016) * gate * alpha)

    # tower legs + cross brace + base
    over(BLUE, cov_dist(seg_dist(nx, ny, 0.40, 0.72, 0.5, 0.40), 0.015))
    over(BLUE, cov_dist(seg_dist(nx, ny, 0.60, 0.72, 0.5, 0.40), 0.015))
    over(BLUE, cov_dist(seg_dist(nx, ny, 0.452, 0.58, 0.548, 0.58), 0.012))
    over(BLUE, cov_dist(seg_dist(nx, ny, 0.372, 0.72, 0.628, 0.72), 0.017))
    # mast
    over(BLUE_L, cov_dist(seg_dist(nx, ny, 0.5, 0.40, 0.5, 0.30), 0.016))
    # emitter dot
    over(WHITE, cov_dist(dist, 0.030))
    return (r, g, b, bg)

def render_master():
    n = MA * MA
    pr = [0.0] * n; pg = [0.0] * n; pb = [0.0] * n; pa = [0.0] * n
    for y in range(MA):
        ny = (y + 0.5) / MA
        row = y * MA
        for x in range(MA):
            nx = (x + 0.5) / MA
            r, g, b, a = shade(nx, ny)
            i = row + x
            pr[i] = r * a; pg[i] = g * a; pb[i] = b * a; pa[i] = a
    return pr, pg, pb, pa

def downsample(master, S):
    pr, pg, pb, pa = master
    ratio = MA // S
    inv = 1.0 / (ratio * ratio)
    out = bytearray(S * S * 4)
    o = 0
    for ty in range(S):
        for tx in range(S):
            sr = sg = sb = sa = 0.0
            by = ty * ratio
            for dy in range(ratio):
                base = (by + dy) * MA + tx * ratio
                for dx in range(ratio):
                    i = base + dx
                    sr += pr[i]; sg += pg[i]; sb += pb[i]; sa += pa[i]
            a = sa * inv
            if a > 1e-6:
                r = (sr * inv) / a; g = (sg * inv) / a; b = (sb * inv) / a
            else:
                r = g = b = 0.0
            out[o] = int(clamp01(r) * 255 + 0.5)
            out[o+1] = int(clamp01(g) * 255 + 0.5)
            out[o+2] = int(clamp01(b) * 255 + 0.5)
            out[o+3] = int(clamp01(a) * 255 + 0.5)
            o += 4
    return bytes(out)

def png_bytes(w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * stride:(y + 1) * stride])
    comp = zlib.compress(bytes(raw), 9)
    def chunk(typ, data):
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", comp) + chunk(b"IEND", b""))

def ico_bytes(items):
    n = len(items)
    out = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    body = b""
    for size, png in items:
        bsz = size if size < 256 else 0
        out += struct.pack("<BBBBHHII", bsz, bsz, 0, 0, 1, 32, len(png), offset)
        offset += len(png); body += png
    return out + body

def main(outdir, srcdir):
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(srcdir, exist_ok=True)
    master = render_master()
    pngs = {}
    for s in SIZES:
        pngs[s] = png_bytes(s, s, downsample(master, s))
    with open(os.path.join(outdir, "icon.ico"), "wb") as f:
        f.write(ico_bytes([(s, pngs[s]) for s in SIZES]))
    with open(os.path.join(outdir, "icon.png"), "wb") as f:
        f.write(pngs[256])
    with open(os.path.join(srcdir, "icon.png"), "wb") as f:
        f.write(pngs[256])
    print("wrote icon.ico (%d sizes), icon.png" % len(SIZES))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
