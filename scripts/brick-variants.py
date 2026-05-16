#!/usr/bin/env python3
"""BRICK pet — chair persona variants.

Same chunky terracotta silhouette across all 6, dressed up with
hats / glasses / mustaches to suggest different chair archetypes.

Layout: 32x32 grid, 16px per cell, 512 per tile, 3x2 gallery.
"""

import argparse

PX = 16
GRID = 32
TILE = PX * GRID  # 512


# -------- rect helpers --------

def rect(parts, x, y, w, h, color):
    parts.append(
        f'<rect x="{x*PX}" y="{y*PX}" width="{w*PX}" height="{h*PX}" fill="{color}"/>'
    )

def row(parts, r, c1, c2, color):
    rect(parts, c1, r, c2 - c1 + 1, 1, color)

def col_(parts, c, r1, r2, color):
    rect(parts, c, r1, 1, r2 - r1 + 1, color)

def px(parts, c, r, color):
    rect(parts, c, r, 1, 1, color)

def fill_shape(parts, shape, color):
    for r, c1, c2 in shape:
        row(parts, r, c1, c2, color)


# ============================================================
# BRICK base (no eyes / no accessories — those layer on top)
# ============================================================

BASE   = '#a35a32'
HI     = '#ce8a5a'
SH     = '#6e3814'
DEEP   = '#3e1c08'
EYE    = '#1a0805'
BELT   = '#5a2a10'
BUCKLE = '#cfb56a'

BODY = [
    (10, 12, 19),
    (11, 11, 20),
    (12, 10, 21),
    (13, 10, 21),
    (14, 10, 21),
    (15, 10, 21),
    (16, 10, 21),
    (17, 10, 21),
    (18, 10, 21),
    (19, 10, 21),
    (20, 11, 20),
]


def draw_brick_body(parts):
    fill_shape(parts, BODY, BASE)
    # Stubby legs
    rect(parts, 12, 21, 2, 2, BASE)
    rect(parts, 18, 21, 2, 2, BASE)
    # Foot bottom edges
    row(parts, 22, 12, 13, DEEP)
    row(parts, 22, 18, 19, DEEP)
    # Highlight (top-left)
    for c, r in [(12, 10), (13, 10), (11, 11), (12, 11), (10, 12), (11, 12)]:
        px(parts, c, r, HI)
    # Shadow (bottom-right)
    for c, r in [(20, 17), (21, 17), (20, 18), (21, 18), (19, 19), (20, 19), (20, 20)]:
        px(parts, c, r, SH)
    px(parts, 19, 21, SH)
    # Tool belt
    row(parts, 17, 10, 21, BELT)
    px(parts, 15, 17, BUCKLE)
    px(parts, 16, 17, BUCKLE)


def draw_brick_brows(parts, color=EYE):
    # Determined inward-angled brows
    px(parts, 12, 12, color)
    px(parts, 13, 13, color)
    px(parts, 19, 12, color)
    px(parts, 18, 13, color)


def draw_brick_eyes(parts, color=EYE):
    px(parts, 13, 14, color)
    px(parts, 18, 14, color)


# ============================================================
# HATS
# ============================================================

# All hats live in rows 7-10 — total avatar grows by only 3 rows
# (16 vs the un-hatted 13), preserving BRICK's chunky-square silhouette.
# The brim sits at row 10, overlapping the body's top edge so the hat
# reads as worn, not floating.

def hat_top(parts):
    """Compact black top hat with cream band."""
    CROWN = '#15101c'
    CROWN_H = '#3a3445'
    BAND = '#f1dfc4'
    BRIM = '#0a0612'
    # Crown — 6 wide × 3 tall
    rect(parts, 13, 7, 6, 3, CROWN)
    # Top-left sheen
    px(parts, 13, 7, CROWN_H)
    px(parts, 14, 7, CROWN_H)
    # Cream band at bottom of crown
    row(parts, 9, 13, 18, BAND)
    px(parts, 17, 9, '#c9b58a')
    # Brim — wider than crown
    row(parts, 10, 10, 21, BRIM)


def hat_fedora(parts):
    """Compact brown fedora with crease."""
    CROWN = '#3e2010'
    CROWN_H = '#5a3520'
    CREASE = '#1f0a04'
    BAND = '#15101c'
    BRIM = '#2a1408'
    # Crown — 8 wide × 3 tall
    rect(parts, 12, 7, 8, 3, CROWN)
    # Center crease
    px(parts, 15, 7, CREASE)
    px(parts, 16, 7, CREASE)
    # Left highlight
    col_(parts, 12, 7, 8, CROWN_H)
    # Band
    row(parts, 9, 12, 19, BAND)
    # Brim — extends past crown for tilt feel
    row(parts, 10, 9, 22, BRIM)


def hat_hardhat(parts):
    """Yellow safety hard hat — low rounded dome."""
    YEL = '#f5b820'
    YEL_H = '#fdd86a'
    YEL_D = '#a87a08'
    # Dome — rounded
    body = [
        (7, 13, 18),
        (8, 11, 20),
        (9, 11, 20),
    ]
    fill_shape(parts, body, YEL)
    # Highlight (top-left)
    px(parts, 13, 7, YEL_H)
    px(parts, 14, 7, YEL_H)
    px(parts, 12, 8, YEL_H)
    # Center ridge crest (signature hard-hat detail)
    col_(parts, 15, 7, 9, YEL_D)
    col_(parts, 16, 8, 9, YEL_D)
    # Brim
    row(parts, 10, 10, 21, YEL_D)


def hat_captain(parts):
    """Navy peaked captain's cap — short crown + visor."""
    NAV = '#1a2848'
    NAV_H = '#3a4a6a'
    GOLD = '#cfa040'
    GOLD_H = '#ffd870'
    DARK = '#0a0e1a'
    WHITE = '#f1dfc4'
    # Crown — 8 wide × 2 tall
    rect(parts, 12, 7, 8, 2, NAV)
    # Highlight on crown
    px(parts, 12, 7, NAV_H)
    px(parts, 13, 7, NAV_H)
    # Band — white with gold trim
    row(parts, 9, 11, 20, WHITE)
    row(parts, 9, 13, 18, GOLD)
    px(parts, 13, 9, GOLD_H)
    # Insignia (center)
    px(parts, 15, 9, DARK)
    px(parts, 16, 9, DARK)
    # Visor (peaked, slightly wider)
    row(parts, 10, 10, 21, DARK)


def hat_beret(parts):
    """Forest-green slouchy beret with stem."""
    GRN = '#3a5a2a'
    GRN_H = '#5a8044'
    GRN_D = '#1f3818'
    # Slouchy oval — tilts to the right
    body = [
        (7, 13, 19),
        (8, 11, 21),
        (9, 11, 20),
    ]
    fill_shape(parts, body, GRN)
    # Stem (nub on top)
    px(parts, 16, 6, GRN)
    # Highlight (left curve)
    px(parts, 13, 7, GRN_H)
    px(parts, 12, 8, GRN_H)
    # Shadow (right slouch)
    px(parts, 19, 8, GRN_D)
    px(parts, 20, 8, GRN_D)
    px(parts, 21, 8, GRN_D)
    # Brim tuck (hugs head)
    row(parts, 10, 10, 21, GRN_D)


# ============================================================
# GLASSES
# ============================================================

def glasses_round(parts):
    """Thin gold round wire frames around the existing eyes."""
    G = '#c9a040'
    GH = '#ffd870'
    # Left eye ring (eye sits at col 13, row 14)
    px(parts, 13, 13, G)   # top
    px(parts, 13, 15, G)   # bottom
    px(parts, 12, 14, G)   # left
    px(parts, 14, 14, G)   # right
    # Right eye ring (eye sits at col 18, row 14)
    px(parts, 18, 13, G)
    px(parts, 18, 15, G)
    px(parts, 17, 14, G)
    px(parts, 19, 14, G)
    # Bridge
    px(parts, 15, 14, G)
    px(parts, 16, 14, G)
    # Sheen
    px(parts, 13, 13, GH)
    px(parts, 18, 13, GH)


def glasses_horn(parts):
    """Thick black horn-rim square frames."""
    F = '#0a0512'
    H = '#3a2a30'
    # Left lens (cols 12-14, rows 13-15)
    row(parts, 13, 12, 14, F)
    row(parts, 15, 12, 14, F)
    px(parts, 12, 14, F)
    px(parts, 14, 14, F)
    # Right lens (cols 17-19, rows 13-15)
    row(parts, 13, 17, 19, F)
    row(parts, 15, 17, 19, F)
    px(parts, 17, 14, F)
    px(parts, 19, 14, F)
    # Bridge
    row(parts, 14, 15, 16, F)
    # Sheen
    px(parts, 12, 13, H)
    px(parts, 17, 13, H)


def glasses_monocle(parts):
    """Single gold monocle on the right eye, with hanging chain."""
    G = '#c9a040'
    GH = '#ffd870'
    GD = '#7a5a18'
    # Right eye ring (cols 16-19, rows 12-16) — slightly oversized
    row(parts, 12, 17, 18, G)
    row(parts, 16, 17, 18, G)
    col_(parts, 16, 13, 15, G)
    col_(parts, 19, 13, 15, G)
    px(parts, 17, 12, GH)
    # Chain hanging down + right side of body
    px(parts, 20, 14, GD)
    px(parts, 20, 15, G)
    px(parts, 21, 15, GD)
    px(parts, 21, 16, G)


def glasses_sun(parts):
    """Solid dark sunglasses with cyan reflection."""
    F = '#0a0512'
    LENS = '#15101c'
    REFLECT = '#3ad4e0'
    # Left lens
    rect(parts, 12, 13, 3, 3, LENS)
    # Right lens
    rect(parts, 17, 13, 3, 3, LENS)
    # Frame outline (top + sides accent)
    row(parts, 12, 12, 14, F)
    row(parts, 12, 17, 19, F)
    # Bridge
    row(parts, 14, 15, 16, F)
    # Reflection sparkle
    px(parts, 12, 13, REFLECT)
    px(parts, 17, 13, REFLECT)


# ============================================================
# MUSTACHES
# ============================================================

def stache_handlebar(parts, color=None):
    """Curled-up handlebar."""
    c = color or '#2a1408'
    # Center body
    row(parts, 16, 13, 18, c)
    px(parts, 14, 15, c)
    px(parts, 17, 15, c)
    # Curl-up tips
    px(parts, 12, 15, c)
    px(parts, 11, 15, c)
    px(parts, 19, 15, c)
    px(parts, 20, 15, c)
    # Highlight (one pixel sheen)
    px(parts, 15, 16, '#5a3018')
    px(parts, 16, 16, '#5a3018')


def stache_walrus(parts, color=None):
    """Big droopy walrus mustache."""
    c = color or '#2a1408'
    cd = '#15080a'
    # Big mass
    row(parts, 15, 12, 19, c)
    row(parts, 16, 11, 20, c)
    # Outer drips
    px(parts, 11, 17, c)
    px(parts, 20, 17, c)
    # Center darker (depth)
    row(parts, 16, 14, 17, cd)


def stache_pencil(parts, color=None):
    """Thin pencil-line mustache."""
    c = color or '#2a1408'
    row(parts, 15, 14, 17, c)


def stache_chevron(parts, color=None):
    """Thick straight chevron — no curl."""
    c = color or '#2a1408'
    cd = '#15080a'
    row(parts, 15, 13, 18, c)
    row(parts, 16, 13, 18, c)
    px(parts, 13, 16, cd)
    px(parts, 18, 16, cd)


def stache_horseshoe(parts, color=None):
    """Horseshoe — wraps down at corners."""
    c = color or '#2a1408'
    row(parts, 15, 13, 18, c)
    row(parts, 16, 13, 18, c)
    # Drops at corners (overrides belt visually)
    px(parts, 13, 17, c)
    px(parts, 18, 17, c)


# ============================================================
# 6 CHAIR PERSONAS
# ============================================================

def variant_classic(parts):
    """Default chair — no accessories."""
    draw_brick_body(parts)
    draw_brick_brows(parts)
    draw_brick_eyes(parts)


def variant_professor(parts):
    """Round wire glasses + handlebar mustache."""
    draw_brick_body(parts)
    draw_brick_brows(parts)
    draw_brick_eyes(parts)
    glasses_round(parts)
    stache_handlebar(parts)


def variant_detective(parts):
    """Brown fedora + pencil mustache."""
    draw_brick_body(parts)
    draw_brick_brows(parts)
    draw_brick_eyes(parts)
    stache_pencil(parts)
    hat_fedora(parts)


def variant_foreman(parts):
    """Yellow hard hat + chevron mustache."""
    draw_brick_body(parts)
    draw_brick_brows(parts)
    draw_brick_eyes(parts)
    stache_chevron(parts)
    hat_hardhat(parts)


def variant_aristocrat(parts):
    """Top hat + monocle + walrus mustache."""
    draw_brick_body(parts)
    draw_brick_brows(parts)
    draw_brick_eyes(parts)
    glasses_monocle(parts)
    stache_walrus(parts)
    hat_top(parts)


def variant_captain(parts):
    """Navy captain cap + horseshoe mustache + sunglasses."""
    draw_brick_body(parts)
    draw_brick_brows(parts)
    # Sunglasses cover eyes — don't draw the dots
    glasses_sun(parts)
    stache_horseshoe(parts)
    hat_captain(parts)


def variant_artist(parts):
    """Beret + horn-rim glasses + handlebar — bonus 7th if needed."""
    draw_brick_body(parts)
    draw_brick_brows(parts)
    draw_brick_eyes(parts)
    glasses_horn(parts)
    stache_handlebar(parts)
    hat_beret(parts)


# ============================================================
# COMPOSE GALLERY
# ============================================================

VARIANTS = [
    ('Classic',     'Default Chair',  variant_classic),
    ('Professor',   'Round + Handlebar', variant_professor),
    ('Detective',   'Fedora + Pencil',   variant_detective),
    ('Foreman',     'Hard Hat + Chevron', variant_foreman),
    ('Aristocrat',  'Top + Monocle + Walrus', variant_aristocrat),
    ('Captain',     'Cap + Shades + Horseshoe', variant_captain),
]


def render_single(fn):
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {TILE} {TILE}" '
        f'width="{TILE}" height="{TILE}" shape-rendering="crispEdges">'
    ]
    fn(parts)
    parts.append('</svg>')
    return '\n'.join(parts)


def render_gallery():
    cols = 3
    rows = 2
    pad = 48
    gap = 32
    label_h = 60
    bg = '#14121c'
    tile_bg = '#1c1827'

    W = pad * 2 + cols * TILE + (cols - 1) * gap
    H = pad * 2 + rows * (TILE + label_h) + (rows - 1) * gap

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
        f'width="{W}" height="{H}" shape-rendering="crispEdges" '
        f'font-family="ui-monospace, SFMono-Regular, Menlo, monospace">'
    ]
    parts.append(f'<rect width="{W}" height="{H}" fill="{bg}"/>')

    for idx, (name, role, fn) in enumerate(VARIANTS):
        ri = idx // cols
        ci = idx % cols
        x = pad + ci * (TILE + gap)
        y = pad + ri * (TILE + label_h + gap)

        parts.append(
            f'<rect x="{x}" y="{y}" width="{TILE}" height="{TILE}" fill="{tile_bg}"/>'
        )
        parts.append(f'<g transform="translate({x},{y})">')
        fn(parts)
        parts.append('</g>')
        parts.append(
            f'<text x="{x + TILE // 2}" y="{y + TILE + 32}" '
            f'text-anchor="middle" fill="#e6e1f0" font-size="22" '
            f'font-weight="600" letter-spacing="3">{name.upper()}</text>'
        )
        parts.append(
            f'<text x="{x + TILE // 2}" y="{y + TILE + 52}" '
            f'text-anchor="middle" fill="#7a7488" font-size="13" '
            f'letter-spacing="2">{role.upper()}</text>'
        )

    parts.append('</svg>')
    return '\n'.join(parts)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--output', default='brick-variants-gallery.svg')
    ap.add_argument('--single', help='Render a single variant by index (0-5)')
    args = ap.parse_args()

    if args.single is not None:
        idx = int(args.single)
        svg = render_single(VARIANTS[idx][2])
    else:
        svg = render_gallery()

    with open(args.output, 'w') as f:
        f.write(svg)
    print(f'Wrote {args.output}')
