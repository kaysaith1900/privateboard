#!/usr/bin/env python3
"""Abstract 8-bit mascot pets — Claude-pet inspired.

Design language:
- 32x32 grid (chunky pixels), 16px per cell, 512x512 per tile.
- Each pet is a single confident silhouette + minimal expression.
- Restrained 3-tone palette per pet + 1 accent.
- No human features. No clutter. Reads at 32px.
- Renders 6 pets into a 3x2 gallery on a deep warm-dark canvas.
"""

import argparse

PX = 16
GRID = 32
TILE = PX * GRID  # 512


# ============================================================
# RECT HELPERS
# ============================================================

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
# PET 1 · SLATE — the Listener
# Half-dome shape, dusty slate blue. Two dot eyes. Floating glow above.
# ============================================================
def pet_slate(parts):
    BASE = '#5a6f88'
    HI   = '#8294aa'
    SH   = '#3a4e64'
    DEEP = '#202d3e'
    EYE  = '#15101c'
    ACC  = '#bcdae6'

    body = [
        (8,  14, 17),
        (9,  12, 19),
        (10, 11, 20),
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
        (21, 11, 20),
        (22, 12, 19),
    ]
    fill_shape(parts, body, BASE)

    # Highlight (top-left soft glow)
    for c, r in [(12, 10), (13, 10), (14, 10), (12, 11), (13, 11),
                 (11, 12), (12, 12), (11, 13)]:
        px(parts, c, r, HI)

    # Shadow (bottom-right rim)
    for c, r in [(20, 17), (21, 17), (20, 18), (21, 18),
                 (20, 19), (21, 19), (19, 20), (20, 20),
                 (18, 21), (19, 21)]:
        px(parts, c, r, SH)
    # Deep shadow at bottom edge
    row(parts, 22, 13, 18, DEEP)

    # Eyes — two simple dots, slightly off-center for character
    rect(parts, 13, 15, 2, 2, EYE)
    rect(parts, 17, 15, 2, 2, EYE)

    # Floating glow accent above
    px(parts, 15, 5, ACC)
    px(parts, 16, 5, ACC)
    px(parts, 14, 6, ACC)
    px(parts, 17, 6, ACC)
    px(parts, 15, 6, '#ffffff')
    px(parts, 16, 6, '#ffffff')


# ============================================================
# PET 2 · SPARK — the Sparker
# Teardrop pointing up, warm terracotta. Sleepy eye-lines. Star above.
# ============================================================
def pet_spark(parts):
    BASE = '#d8714a'
    HI   = '#eda07a'
    SH   = '#a14a28'
    DEEP = '#5e2912'
    EYE  = '#2a1410'
    ACC  = '#ffd870'
    ACC2 = '#fff5b0'

    body = [
        (8,  15, 16),
        (9,  14, 17),
        (10, 13, 18),
        (11, 13, 18),
        (12, 12, 19),
        (13, 12, 19),
        (14, 11, 20),
        (15, 11, 20),
        (16, 11, 20),
        (17, 11, 20),
        (18, 11, 20),
        (19, 12, 19),
        (20, 12, 19),
        (21, 13, 18),
        (22, 14, 17),
    ]
    fill_shape(parts, body, BASE)

    # Highlight — left rim curve
    for c, r in [(12, 11), (12, 12), (12, 13), (11, 14), (11, 15),
                 (11, 16), (12, 17), (12, 18), (13, 19)]:
        px(parts, c, r, HI)
    # Specular pop at top-left
    px(parts, 13, 11, ACC2)
    px(parts, 14, 11, HI)

    # Shadow — bottom-right curve
    for c, r in [(20, 16), (20, 17), (20, 18), (19, 19), (19, 20),
                 (18, 21), (17, 22)]:
        px(parts, c, r, SH)
    px(parts, 18, 22, DEEP)
    px(parts, 17, 22, DEEP)

    # Sleepy / content eye lines (closed crescents)
    row(parts, 15, 13, 14, EYE)
    px(parts, 14, 14, EYE)
    row(parts, 15, 17, 18, EYE)
    px(parts, 17, 14, EYE)

    # Tiny smirk
    px(parts, 15, 17, EYE)
    px(parts, 16, 17, EYE)

    # Star sparkle above
    px(parts, 15, 4, ACC)
    px(parts, 16, 4, ACC)
    px(parts, 14, 5, ACC)
    px(parts, 17, 5, ACC)
    px(parts, 15, 5, ACC2)
    px(parts, 16, 5, ACC2)
    # Small companion sparkle
    px(parts, 22, 8, ACC)
    px(parts, 8,  10, ACC)


# ============================================================
# PET 3 · VAULT — the Skeptic
# Rounded cube, deep aubergine. Single cyan visor slit.
# ============================================================
def pet_vault(parts):
    BASE = '#3a2640'
    HI   = '#5a3e62'
    SH   = '#1f1228'
    DEEP = '#0a0512'
    VISOR= '#3ad4e0'
    VISOR_H = '#aaf0f8'
    EYE  = '#0a0512'

    body = [
        (9,  12, 19),
        (10, 11, 20),
        (11, 10, 21),
        (12, 10, 21),
        (13, 10, 21),
        (14, 10, 21),
        (15, 10, 21),
        (16, 10, 21),
        (17, 10, 21),
        (18, 10, 21),
        (19, 10, 21),
        (20, 10, 21),
        (21, 11, 20),
        (22, 12, 19),
    ]
    fill_shape(parts, body, BASE)

    # Highlight — top edge sheen
    row(parts, 9,  13, 16, HI)
    row(parts, 10, 12, 14, HI)
    px(parts, 11, 11, HI)

    # Shadow — bottom-right
    row(parts, 21, 17, 20, SH)
    row(parts, 22, 16, 19, SH)
    col_(parts, 21, 16, 20, SH)
    px(parts, 21, 21, DEEP)
    px(parts, 20, 22, DEEP)
    px(parts, 19, 22, DEEP)

    # Visor recess (darker area behind glow)
    rect(parts, 11, 14, 10, 3, EYE)
    # Cyan slit
    rect(parts, 12, 15, 8, 1, VISOR)
    # Glow accents
    px(parts, 13, 15, VISOR_H)
    px(parts, 18, 15, VISOR_H)
    # Small reflection dots
    px(parts, 12, 14, VISOR)
    px(parts, 19, 14, VISOR)

    # Tiny seam line — vertical center groove (subtle)
    px(parts, 15, 19, SH)
    px(parts, 16, 19, SH)
    px(parts, 15, 20, SH)
    px(parts, 16, 20, SH)


# ============================================================
# PET 4 · PEARL — the Empath
# Bumpy cloud blob, warm cream. Dot eyes + tiny smile + soft blush.
# ============================================================
def pet_pearl(parts):
    BASE = '#f1dfc4'
    HI   = '#fff3df'
    SH   = '#c9ad88'
    DEEP = '#8c714e'
    EYE  = '#2a1a14'
    BLUSH= '#f0a094'
    SMILE= '#a0584a'

    # Cloud-bumpy outline
    body = [
        (9,  14, 17),
        (10, 12, 19),
        (11, 11, 20),
        (12, 10, 21),
        (13, 10, 21),
        (14, 10, 21),
        (15, 9,  22),
        (16, 9,  22),
        (17, 9,  22),
        (18, 10, 21),
        (19, 10, 21),
        (20, 11, 20),
        (21, 12, 19),
        (22, 13, 18),
    ]
    fill_shape(parts, body, BASE)

    # Pearl highlight (top-left luster)
    for c, r in [(12, 10), (13, 10), (12, 11), (13, 11), (14, 11),
                 (11, 12), (12, 12), (10, 13), (11, 13), (10, 14)]:
        px(parts, c, r, HI)
    px(parts, 13, 12, '#ffffff')
    px(parts, 14, 12, '#ffffff')

    # Shadow (bottom-right)
    for c, r in [(20, 17), (21, 17), (22, 17), (20, 18), (21, 18),
                 (19, 19), (20, 19), (19, 20), (18, 21)]:
        px(parts, c, r, SH)
    px(parts, 17, 22, DEEP)
    px(parts, 18, 22, DEEP)

    # Cheek blush — soft pink ovals
    rect(parts, 11, 16, 2, 2, BLUSH)
    rect(parts, 19, 16, 2, 2, BLUSH)

    # Eyes — two simple dots
    rect(parts, 13, 14, 2, 2, EYE)
    rect(parts, 17, 14, 2, 2, EYE)
    # Tiny eye sparkle
    px(parts, 14, 14, '#ffffff')
    px(parts, 18, 14, '#ffffff')

    # Smile — a 3-pixel curve
    px(parts, 14, 17, SMILE)
    px(parts, 15, 18, SMILE)
    px(parts, 16, 18, SMILE)
    px(parts, 17, 17, SMILE)


# ============================================================
# PET 5 · BRICK — the Builder
# Squat block w/ stubby legs, terra rust. Concentrating brow + dot eyes.
# ============================================================
def pet_brick(parts):
    BASE = '#a35a32'
    HI   = '#ce8a5a'
    SH   = '#6e3814'
    DEEP = '#3e1c08'
    EYE  = '#1a0805'
    BELT = '#5a2a10'

    # Main body — chunky square w/ rounded corners
    body = [
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
    fill_shape(parts, body, BASE)
    # Stubby legs
    rect(parts, 12, 21, 2, 2, BASE)
    rect(parts, 18, 21, 2, 2, BASE)
    # Foot bottom edges
    row(parts, 22, 12, 13, DEEP)
    row(parts, 22, 18, 19, DEEP)

    # Highlight (top-left block)
    for c, r in [(12, 10), (13, 10), (11, 11), (12, 11), (10, 12), (11, 12)]:
        px(parts, c, r, HI)

    # Shadow (bottom-right)
    for c, r in [(20, 17), (21, 17), (20, 18), (21, 18), (19, 19), (20, 19), (20, 20)]:
        px(parts, c, r, SH)
    px(parts, 19, 21, SH)

    # Tool belt — single dark stripe across waist
    row(parts, 17, 10, 21, BELT)
    px(parts, 15, 17, '#cfb56a')   # buckle
    px(parts, 16, 17, '#cfb56a')

    # Determined brows — angled inward
    px(parts, 12, 12, EYE)
    px(parts, 13, 13, EYE)
    px(parts, 19, 12, EYE)
    px(parts, 18, 13, EYE)

    # Eyes — small dots, focused
    px(parts, 13, 14, EYE)
    px(parts, 18, 14, EYE)


# ============================================================
# PET 6 · NEON — the Visionary
# Tall thin pill, deep forest teal. Single magenta scan-eye + sparkles.
# ============================================================
def pet_neon(parts):
    BASE = '#1f4a4a'
    HI   = '#3e7878'
    SH   = '#0e2a2a'
    DEEP = '#031414'
    NEON = '#f03ad4'
    NEON_H = '#ffaaef'
    NEON_D = '#a01a8a'

    body = [
        (6,  14, 17),
        (7,  13, 18),
        (8,  13, 18),
        (9,  12, 19),
        (10, 12, 19),
        (11, 12, 19),
        (12, 12, 19),
        (13, 12, 19),
        (14, 12, 19),
        (15, 12, 19),
        (16, 12, 19),
        (17, 12, 19),
        (18, 12, 19),
        (19, 12, 19),
        (20, 12, 19),
        (21, 12, 19),
        (22, 13, 18),
        (23, 13, 18),
        (24, 14, 17),
    ]
    fill_shape(parts, body, BASE)

    # Highlight strip — left edge
    col_(parts, 12, 9, 16, HI)
    px(parts, 13, 8, HI)
    px(parts, 13, 9, HI)
    px(parts, 14, 7, HI)

    # Shadow — right edge, lower portion
    col_(parts, 19, 14, 21, SH)
    px(parts, 18, 22, SH)
    px(parts, 17, 23, SH)

    # Bottom shadow
    px(parts, 17, 24, DEEP)
    px(parts, 16, 24, DEEP)

    # Magenta scan-eye line
    row(parts, 13, 13, 18, NEON)
    px(parts, 14, 13, NEON_H)
    px(parts, 17, 13, NEON_H)
    # Eye glow halo
    row(parts, 12, 14, 17, NEON_D)
    row(parts, 14, 14, 17, NEON_D)

    # Sparkles in negative space
    px(parts, 9,  18, NEON)
    px(parts, 8,  19, NEON_H)
    px(parts, 22, 11, NEON)
    px(parts, 23, 12, NEON_H)
    px(parts, 24, 20, NEON)


# ============================================================
# COMPOSE GALLERY
# ============================================================

PETS = [
    ('Slate',  'The Listener',  pet_slate),
    ('Spark',  'The Sparker',   pet_spark),
    ('Vault',  'The Skeptic',   pet_vault),
    ('Pearl',  'The Empath',    pet_pearl),
    ('Brick',  'The Builder',   pet_brick),
    ('Neon',   'The Visionary', pet_neon),
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

    bg       = '#14121c'
    tile_bg  = '#1c1827'

    W = pad * 2 + cols * TILE + (cols - 1) * gap
    H = pad * 2 + rows * (TILE + label_h) + (rows - 1) * gap

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
        f'width="{W}" height="{H}" shape-rendering="crispEdges" '
        f'font-family="ui-monospace, SFMono-Regular, Menlo, monospace">'
    ]
    parts.append(f'<rect width="{W}" height="{H}" fill="{bg}"/>')

    for idx, (name, role, fn) in enumerate(PETS):
        ri = idx // cols
        ci = idx % cols
        x = pad + ci * (TILE + gap)
        y = pad + ri * (TILE + label_h + gap)

        # Tile background
        parts.append(
            f'<rect x="{x}" y="{y}" width="{TILE}" height="{TILE}" fill="{tile_bg}"/>'
        )

        # Pet (offset via transform group)
        parts.append(f'<g transform="translate({x},{y})">')
        fn(parts)
        parts.append('</g>')

        # Labels — name (large, light) + role (small, muted)
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
    ap.add_argument('-o', '--output', default='abstract-pets-gallery.svg')
    ap.add_argument('--single', help='Render a single pet by index (0-5)')
    args = ap.parse_args()

    if args.single is not None:
        idx = int(args.single)
        svg = render_single(PETS[idx][2])
    else:
        svg = render_gallery()

    with open(args.output, 'w') as f:
        f.write(svg)
    print(f'Wrote {args.output}')
