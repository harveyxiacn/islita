#!/usr/bin/env python3
"""Prepare the bundled desktop-pet skins from v-pet/ into static/pet/.

The artwork is provided by the project owner, who attests that these
derivative character images are licensed for commercial use. The script never
modifies v-pet/; it writes square, opaque WebP "sticker cards" that the pet
panel rounds with CSS. Speech bubbles, watermarks and meme labels are painted
out where they would otherwise dominate a 5.5rem pet portrait.

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


if __name__ == "__main__":
    main()
