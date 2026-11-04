# Regenerate assets/neutrino.ico from the same orbit mark the regular console
# shows in its top-left corner. Run with the bundled Pillow:
#   <python> scripts/make-icon.py
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE = 1024
SCALE = SIZE / 32.0
BG = (21, 21, 23, 255)
STROKE = (249, 250, 251, 255)

image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=int(7 * SCALE), fill=BG)

# The orbit: an ellipse rotated -30 degrees around the centre, plus its core.
orbit = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
orbit_draw = ImageDraw.Draw(orbit)
cx = cy = SIZE / 2
rx, ry = 12.5 * SCALE, 5.1 * SCALE
width = max(2, round(1.9 * SCALE))
orbit_draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), outline=STROKE, width=width)
orbit = orbit.rotate(-30, resample=Image.Resampling.BICUBIC, center=(cx, cy))
image.alpha_composite(orbit)

core = ImageDraw.Draw(image)
r = 4.1 * SCALE
core.ellipse((cx - r, cy - r, cx + r, cy + r), outline=STROKE, width=width)

target = os.path.join(ROOT, "assets", "neutrino.ico")
image.save(
    target,
    format="ICO",
    sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print(f"wrote {target} ({os.path.getsize(target)} bytes)")
