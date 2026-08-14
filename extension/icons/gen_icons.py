"""Generates the extension's toolbar/store icons. Run once with
`python gen_icons.py` whenever the mark needs to change; the PNGs it
writes are what actually ships, not this script."""
from PIL import Image, ImageDraw

ACCENT = (26, 115, 232, 255)  # #1a73e8, matches the CSS accent
FOLD_SHADE = (17, 84, 178, 255)  # slightly darker, for the folded corner
WHITE = (255, 255, 255, 255)
LINE = (194, 213, 245, 255)  # faint accent-tinted lines inside the note

SIZE = 512  # master render, downsampled for crisp small sizes


def render():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background: rounded square in the accent color.
    pad = 8
    radius = 108
    draw.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=radius, fill=ACCENT)

    # Note card: white rounded rect with a folded top-right corner.
    note_pad = 128
    fold = 84
    x0, y0, x1, y1 = note_pad, note_pad - 10, SIZE - note_pad + 20, SIZE - note_pad + 30
    note_radius = 28

    draw.rounded_rectangle([x0, y0, x1, y1], radius=note_radius, fill=WHITE)
    # Re-square the corners that should stay sharp once the fold triangle
    # covers the top-right, by drawing the fold on top.
    draw.polygon([(x1 - fold, y0), (x1, y0), (x1, y0 + fold)], fill=FOLD_SHADE)
    draw.polygon(
        [(x1 - fold, y0), (x1, y0 + fold), (x1 - fold, y0 + fold)],
        fill=(255, 255, 255, 60),
    )

    # Note lines.
    line_x0 = x0 + 36
    line_x1 = x1 - 36
    for i, ly in enumerate([y0 + 90, y0 + 140, y0 + 190]):
        width = line_x1 - (20 if i == 2 else 0) - line_x0
        draw.rounded_rectangle([line_x0, ly, line_x0 + width, ly + 20], radius=10, fill=LINE)

    return img


def main():
    master = render()
    for size in (128, 48, 16):
        master.resize((size, size), Image.LANCZOS).save(f"icon{size}.png")
    print("wrote icon128.png, icon48.png, icon16.png")


if __name__ == "__main__":
    main()
