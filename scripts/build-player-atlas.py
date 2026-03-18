from pathlib import Path

from PIL import Image


FRAME_WIDTH = 32
FRAME_HEIGHT = 48
COLS = 5
ROWS = 2


def build_atlas(src_path: Path, out_path: Path) -> None:
    image = Image.open(src_path).convert("RGBA")
    width, height = image.size
    atlas = Image.new("RGBA", (FRAME_WIDTH * COLS, FRAME_HEIGHT * ROWS), (0, 0, 0, 0))

    for idx in range(COLS * ROWS):
        col = idx % COLS
        row = idx // COLS

        left = round(col * width / COLS)
        top = round(row * height / ROWS)
        right = round((col + 1) * width / COLS)
        bottom = round((row + 1) * height / ROWS)

        cell = image.crop((left, top, right, bottom))
        bbox = cell.getchannel("A").getbbox() or (0, 0, cell.width, cell.height)
        sprite = cell.crop(bbox)

        scale = min((FRAME_WIDTH - 2) / sprite.width, (FRAME_HEIGHT - 2) / sprite.height)
        scaled_size = (
            max(1, round(sprite.width * scale)),
            max(1, round(sprite.height * scale)),
        )
        sprite = sprite.resize(scaled_size, Image.Resampling.LANCZOS)

        frame = Image.new("RGBA", (FRAME_WIDTH, FRAME_HEIGHT), (0, 0, 0, 0))
        paste_x = (FRAME_WIDTH - sprite.width) // 2
        paste_y = FRAME_HEIGHT - sprite.height
        frame.alpha_composite(sprite, (paste_x, paste_y))

        atlas.alpha_composite(frame, (col * FRAME_WIDTH, row * FRAME_HEIGHT))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(out_path)


def main() -> None:
    source = Path(r"d:\GameDev\GameDraft\assets\images\characters\player_hero_source.png")
    targets = [
        Path(r"d:\GameDev\GameDraft\public\assets\images\characters\player_hero.png"),
        Path(r"d:\GameDev\GameDraft\assets\images\characters\player_hero.png"),
    ]

    for target in targets:
        build_atlas(source, target)
        print(f"saved: {target}")


if __name__ == "__main__":
    main()
