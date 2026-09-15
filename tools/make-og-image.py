"""Draw the social preview card shown when the link is shared.

Deliberately a designed card rather than a screenshot. A screenshot scaled into
a 1200x630 preview renders the interface too small to read, so what people
actually see is a grey smudge; and a screenshot goes stale the moment the
interface changes, which is how the README's images ended up advertising a
version of the app that no longer exists.

This uses the app's own palette and the demo's avatar treatment, so the card
looks like the thing it links to without claiming to be a photograph of it.

    .venv/bin/python tools/make-og-image.py

Writes frontend/og.png at 1200x630, the size every major platform crops to.
"""

import json
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "frontend" / "og.png"

# The same address the build publishes to, so the card cannot advertise one
# place while the tags point at another.
SITE = json.loads((ROOT / "site.json").read_text())["url"]
SITE_LABEL = urlparse(SITE).netloc + urlparse(SITE).path.rstrip("/")

WIDTH, HEIGHT = 1200, 630

# Straight from frontend/styles.css.
NAVY = (0, 46, 93)
BLUE = (0, 98, 184)
ORANGE = (220, 109, 43)
PAPER = (244, 248, 252)
INK = (16, 38, 63)
MUTED = (88, 107, 126)
LINE = (213, 225, 237)

# The demo's avatar colours, so the card and the app agree visually.
AVATAR_COLOURS = [
    (47, 111, 159),
    (122, 81, 149),
    (188, 80, 144),
    (239, 86, 117),
    (194, 87, 26),
    (43, 122, 107),
]
INITIALS = ["AN", "BF", "CA", "DM", "EB", "FO"]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """A system font at the requested size, falling back until something loads."""
    candidates = (
        ["/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc"]
        if bold
        else ["/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc"]
    )
    for path in candidates:
        try:
            # Index 1 is the bold face in these collections.
            return ImageFont.truetype(path, size, index=1 if bold else 0)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded(draw: ImageDraw.ImageDraw, box, radius: int, fill, outline=None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def avatar(image: Image.Image, x: int, y: int, size: int, colour, initials: str) -> None:
    """The same flat treatment the demo class draws: a head and shoulders, initials over it.

    Drawn on its own tile and pasted through a rounded mask, so the shoulders —
    which are deliberately larger than the tile — are clipped by it instead of
    spilling across whatever sits underneath.
    """
    tile = Image.new("RGB", (size, size), colour)
    pen = ImageDraw.Draw(tile)
    light = tuple(min(255, channel + 46) for channel in colour)
    head = size * 0.30
    pen.ellipse((size / 2 - head / 2, size * 0.18, size / 2 + head / 2, size * 0.18 + head), fill=light)
    pen.ellipse((size * 0.14, size * 0.58, size * 0.86, size * 1.24), fill=light)

    label = font(int(size * 0.30), bold=True)
    box = pen.textbbox((0, 0), initials, font=label)
    pen.text(
        (size / 2 - (box[2] - box[0]) / 2 - box[0], size * 0.33 - (box[3] - box[1]) / 2 - box[1]),
        initials,
        font=label,
        fill=(255, 255, 255),
    )

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=18, fill=255)
    image.paste(tile, (x, y), mask)


def main() -> None:
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(image)

    # A navy band down the left, echoing the app's header.
    draw.rectangle((0, 0, 14, HEIGHT), fill=NAVY)

    left = 78
    draw.text((left, 74), "familiar", font=font(44, bold=True), fill=NAVY)
    wordmark = draw.textbbox((0, 0), "familiar", font=font(44, bold=True))
    draw.text((left + wordmark[2] - wordmark[0] + 3, 74), ".", font=font(44, bold=True), fill=ORANGE)

    draw.text((left, 150), "Know every student", font=font(68, bold=True), fill=NAVY)
    draw.text((left, 226), "before the first day.", font=font(68, bold=True), fill=NAVY)

    body = font(27)
    draw.text((left, 330), "Import your BYU course roster and learn every name", font=body, fill=INK)
    draw.text((left, 368), "with short, adaptive practice sessions.", font=body, fill=INK)

    # The claim most likely to decide whether somebody opens the link.
    pill = (left, 430, left + 470, 478)
    rounded(draw, pill, radius=24, fill=(255, 255, 255), outline=LINE, width=2)
    draw.ellipse((left + 20, 447, left + 34, 461), fill=BLUE)
    draw.text((left + 46, 443), "Your roster never leaves your device", font=font(21, bold=True), fill=BLUE)

    draw.text((left, 528), SITE_LABEL, font=font(22), fill=MUTED)

    # A roster fragment on the right, at a size that still reads in a preview.
    panel_left, panel_top, panel_right, panel_bottom = 760, 96, 1136, 534
    rounded(draw, (panel_left, panel_top, panel_right, panel_bottom), radius=26, fill=(255, 255, 255), outline=LINE, width=2)

    # Derived from the panel rather than chosen by eye: hardcoding a tile size
    # and a gap that happened not to fit left the third column hanging 8px past
    # the panel's edge. Computing it means the tiles cannot outgrow their box.
    padding, gap, columns, rows = 32, 20, 3, 2
    content = (panel_right - padding) - (panel_left + padding)
    size = (content - gap * (columns - 1)) // columns
    used = size * columns + gap * (columns - 1)
    start_x = panel_left + padding + (content - used) // 2

    label_y = panel_top + 32
    draw.text((start_x, label_y), "YOUR CLASS", font=font(16, bold=True), fill=MUTED)

    bar_height, bar_gap, caption_gap = 9, 13, 26
    block = size + bar_gap + bar_height
    start_y = label_y + 34
    caption_height = 24

    # Spread the rows to fill the panel rather than leaving a gap at the foot of
    # it. Derived for the same reason the widths are: a number picked by eye is
    # a number that stops being right the moment anything around it moves.
    available = (panel_bottom - padding) - start_y
    row_gap = max(20, (available - rows * block - caption_gap - caption_height) // (rows - 1))

    for index, (colour, initials) in enumerate(zip(AVATAR_COLOURS, INITIALS)):
        column, row = index % columns, index // columns
        x = start_x + column * (size + gap)
        y = start_y + row * (block + row_gap)
        avatar(image, x, y, size, colour, initials)
        bar_y = y + size + bar_gap
        rounded(draw, (x, bar_y, x + size, bar_y + bar_height), radius=5, fill=(233, 239, 246))
        filled = [0.86, 0.42, 0.68, 0.94, 0.30, 0.75][index]
        rounded(draw, (x, bar_y, x + int(size * filled), bar_y + bar_height), radius=5, fill=BLUE)

    caption_y = start_y + (rows - 1) * (block + row_gap) + block + caption_gap
    draw.text((start_x, caption_y), "Predicted recall, person by person", font=font(18), fill=MUTED)

    # Nothing may cross the panel it belongs to.
    right_edge = start_x + used
    caption_bottom = caption_y + 24
    assert right_edge <= panel_right - padding // 2, f"tiles reach {right_edge}, panel ends at {panel_right}"
    assert caption_bottom <= panel_bottom, f"caption reaches {caption_bottom}, panel ends at {panel_bottom}"

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    image.save(TARGET, "PNG", optimize=True)
    print(f"wrote {TARGET.relative_to(ROOT)} ({TARGET.stat().st_size // 1024} KB, {WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    main()
