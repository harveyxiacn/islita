#!/usr/bin/env python3
"""Prepare the bundled desktop-pet skins from v-pet/ into static/pet/.

The artwork is provided by the project owner, who attests that these
derivative character images are licensed for commercial use. The script never
modifies v-pet/; it writes square, opaque WebP "sticker cards" that the pet
panel rounds with CSS, plus one transparent cutout for the rice cutscene.
Speech bubbles, watermarks and meme labels are painted out where they would
otherwise dominate a 5.5rem pet portrait.

Requires Pillow (pip install pillow). Run from the repository root:
    python -I scripts/prepare-pet-assets.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "v-pet"
OUT = ROOT / "static" / "pet"
TARGET = 512
WHITE = (255, 255, 255, 255)


def crop(path: Path, box: tuple[int, int, int, int]) -> Image.Image:
    return Image.open(path).convert("RGBA").crop(box)


def paint(image: Image.Image, box: tuple[int, int, int, int], color=WHITE) -> Image.Image:
    copy = image.copy()
    ImageDraw.Draw(copy).rectangle(box, fill=color)
    return copy


def content_box(image: Image.Image, background=WHITE, threshold: int = 14) -> tuple[int, int, int, int]:
    """Bounding box of pixels that differ from a flat background colour."""
    rgb = image.convert("RGB")
    mask = Image.new("L", rgb.size, 0)
    pixels = rgb.load()
    out = mask.load()
    br, bg, bb = background[:3]
    for y in range(rgb.height):
        for x in range(rgb.width):
            r, g, b = pixels[x, y]
            if abs(r - br) > threshold or abs(g - bg) > threshold or abs(b - bb) > threshold:
                out[x, y] = 255
    return mask.getbbox() or (0, 0, rgb.width, rgb.height)


def square(image: Image.Image, fill=WHITE, margin: float = 0.08) -> Image.Image:
    side = int(max(image.width, image.height) * (1 + margin * 2))
    canvas = Image.new("RGBA", (side, side), fill)
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas.resize((TARGET, TARGET), Image.LANCZOS)


def trim(image: Image.Image, background=WHITE) -> Image.Image:
    return image.crop(content_box(image, background))


def save(name: str, image: Image.Image) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    image.convert("RGB").save(path, "WEBP", quality=90, method=6)
    print(f"{path.relative_to(ROOT)}  {path.stat().st_size} bytes")


def save_rgba(name: str, image: Image.Image) -> None:
    """WebP keeps the alpha channel; the rice cutscene floats over the panel."""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    image.convert("RGBA").save(path, "WEBP", quality=90, method=6)
    print(f"{path.relative_to(ROOT)}  {path.stat().st_size} bytes")


def cutout(
    source: str,
    name: str,
    *,
    clears: tuple[tuple[int, int, int, int], ...] = (),
    dark_clears: tuple[tuple[int, int, int, int], ...] = (),
    tolerance: int = 26,
    speck: int = 40,
) -> None:
    """Remove the flat card behind an already prepared 512 × 512 sticker.

    A flood fill from the border only reaches the background connected to the
    edge, so enclosed whites (apron, rice, highlights) stay. Near-white pixels
    on the silhouette are made semi-transparent, which removes the halo that a
    hard fill leaves on a dark panel. `clears`/`dark_clears` drop the supplied
    card's calligraphy and annotation strokes; the latter only removes dark
    pixels, preserving blue line art that crosses the same rectangle.
    """
    image = Image.open(OUT / source).convert("RGB")
    width, height = image.size
    work = image.copy()
    sentinel = (255, 0, 255)

    def near_white(pixel: tuple[int, int, int]) -> bool:
        return max(255 - pixel[0], 255 - pixel[1], 255 - pixel[2]) <= tolerance // 2

    # One connected background is normal; the grid also handles a card split
    # into several white regions by a rule or a label.
    seeds = [(x, y) for x in range(0, width, 8) for y in (0, height - 1)]
    seeds += [(x, y) for y in range(0, height, 8) for x in (0, width - 1)]
    for seed in seeds:
        if work.getpixel(seed) != sentinel and near_white(image.getpixel(seed)):
            ImageDraw.floodfill(work, seed, sentinel, thresh=tolerance)

    rgba = image.convert("RGBA")
    pixels = rgba.load()
    work_pixels = work.load()
    transparent = bytearray(width * height)
    for y in range(height):
        for x in range(width):
            if work_pixels[x, y] == sentinel:
                pixels[x, y] = (0, 0, 0, 0)
                transparent[y * width + x] = 1

    # Soften the white anti-aliased rim next to the removed background.
    fringe = bytearray(width * height)
    for y in range(height):
        for x in range(width):
            if transparent[y * width + x]:
                continue
            if any(
                transparent[ny * width + nx]
                for ny in range(max(0, y - 2), min(height, y + 3))
                for nx in range(max(0, x - 2), min(width, x + 3))
            ):
                fringe[y * width + x] = 1

    for y in range(height):
        for x in range(width):
            if not fringe[y * width + x]:
                continue
            r, g, b, a = pixels[x, y]
            distance = max(255 - r, 255 - g, 255 - b)
            if distance <= 16:
                alpha = 0
            elif distance < 64:
                alpha = int(255 * (distance - 16) / 48)
            else:
                continue
            if alpha < a:
                pixels[x, y] = (r, g, b, alpha)

    draw = ImageDraw.Draw(rgba)
    for box in clears:
        draw.rectangle(box, fill=(0, 0, 0, 0))
    for box in dark_clears:
        x0, y0, x1, y1 = box
        for y in range(y0, min(y1, height)):
            for x in range(x0, min(x1, width)):
                r, g, b, a = pixels[x, y]
                if max(r, g, b) < 140:
                    pixels[x, y] = (0, 0, 0, 0)

    # Drop isolated specks (dust from JPEG compression); the two sparkles are
    # several hundred pixels each and survive.
    alpha = rgba.getchannel("A")
    alpha_pixels = alpha.load()
    seen = bytearray(width * height)
    for y in range(height):
        for x in range(width):
            if alpha_pixels[x, y] <= 8 or seen[y * width + x]:
                continue
            queue = [(x, y)]
            seen[y * width + x] = 1
            component: list[tuple[int, int]] = []
            while queue:
                cx, cy = queue.pop()
                component.append((cx, cy))
                for nx in range(max(0, cx - 1), min(width, cx + 2)):
                    for ny in range(max(0, cy - 1), min(height, cy + 2)):
                        if not seen[ny * width + nx] and alpha_pixels[nx, ny] > 8:
                            seen[ny * width + nx] = 1
                            queue.append((nx, ny))
            if len(component) < speck:
                for cx, cy in component:
                    alpha_pixels[cx, cy] = 0

    rgba.putalpha(alpha)
    save_rgba(name, rgba)


def quadrants(path: Path) -> list[Image.Image]:
    image = Image.open(path).convert("RGBA")
    w, h = image.size
    return [
        image.crop((0, 0, w // 2, h // 2)),
        image.crop((w // 2, 0, w, h // 2)),
        image.crop((0, h // 2, w // 2, h)),
        image.crop((w // 2, h // 2, w, h)),
    ]


def main() -> None:
    hachi = quadrants(SRC / "小八" / "4.jpeg")
    save("hachiware-bored.webp", square(trim(hachi[0])))
    save("hachiware-happy.webp", square(trim(hachi[1])))
    save("hachiware-pat.webp", square(trim(hachi[2])))
    save("hachiware-ok.webp", square(trim(hachi[3])))

    guitar = crop(SRC / "小八" / "3.webp", (40, 40, 480, 520))
    save("hachiware-play.webp", square(trim(guitar), margin=0.05))

    # This one has its own pink background; trim to the character and pad the
    # square with the same colour instead of forcing it onto white.
    pink = Image.open(SRC / "小八" / "7.jpg").convert("RGBA")
    save("hachiware-feed.webp", square(pink, fill=(250, 214, 224, 255), margin=0.02))

    hang = Image.open(SRC / "小八" / "6.webp").convert("RGBA")
    save("hachiware-tired.webp", square(hang, fill=(176, 214, 240, 255), margin=0.01))

    star = Image.open(SRC / "小八" / "5.png").convert("RGBA")
    save("hachiware-playful.webp", square(star, fill=(247, 241, 226, 255), margin=0.04))

    # DeepSeek 大肥鱼 has two supplied forms. The owner sorted the references
    # into Q版 (resident chibi) and 变身 (transformed); each form gets its own
    # sticker cards so the panel can switch between them at any time.
    chibi = SRC / "deepseek" / "Q版"
    transformed = SRC / "deepseek" / "变身"

    chibi_happy = crop(chibi / "2.webp", (95, 25, 595, 468))
    save("deepseek-chibi-happy.webp", square(trim(chibi_happy)))

    chibi_bored = crop(chibi / "4.webp", (175, 200, 908, 800))
    save("deepseek-chibi-bored.webp", square(trim(paint(chibi_bored, (0, 0, 360, 180)))))

    # The thought bubble is part of the supplied meme card and is illegible at
    # 5.5rem; masking its rectangle would cut the hair on its right edge.
    chibi_surprised = crop(chibi / "5.jpeg", (100, 0, 600, 555))
    save("deepseek-chibi-surprised.webp", square(trim(chibi_surprised)))

    # Crop below the large "我是吃白饭的蓝色大肥鱼！" title; the top of the hat
    # starts at about y=345. Paint out the small filename label on the right.
    chibi_feed = crop(chibi / "8.jpg", (180, 345, 1180, 1254))
    save("deepseek-chibi-feed.webp", square(trim(paint(chibi_feed, (700, 80, 1050, 210)))))

    # 9.webp has a blue collage background and no text in the upper-body crop.
    transformed_happy = crop(transformed / "9.webp", (150, 250, 1050, 1450))
    save(
        "deepseek-transformed-happy.webp",
        square(transformed_happy, fill=(150, 190, 240, 255), margin=0.02),
    )

    # The three-view sheets give a clean white reference for the other moods.
    # The first view of 11.webp ends at x=390, so keep that edge to avoid a
    # sliver of the side view. Use the upper body rather than the whole figure
    # so the card stays legible at 5.5rem.
    transformed_ok = crop(transformed / "11.webp", (0, 0, 390, 720))
    save("deepseek-transformed-ok.webp", square(trim(transformed_ok), margin=0.05))

    transformed_neutral = crop(transformed / "12.png", (0, 0, 240, 300))
    save(
        "deepseek-transformed-neutral.webp",
        square(trim(transformed_neutral), margin=0.05),
    )

    # The rice cutscene floats the same chibi over the panel scene, so the flat
    # sticker card is removed. Coordinates are in the 512 × 512 feed card: they
    # clear the supplied calligraphy and two blue annotation strokes while
    # keeping the ahoge (x ≈ 256–303, y ≈ 53–82).
    cutout(
        "deepseek-chibi-feed.webp",
        "deepseek-chibi-rice.webp",
        clears=(
            (0, 0, 400, 52),
            (0, 0, 250, 95),
            (303, 0, 512, 75),
            (0, 60, 256, 75),
            (380, 0, 512, 178),
            (468, 380, 512, 512),
        ),
        dark_clears=((0, 0, 370, 82),),
    )


if __name__ == "__main__":
    main()
