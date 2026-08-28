"""生成 Tauri 打包要的应用图标（占位）。

`tauri.conf.json` 的 `bundle.icon` 列了三个文件，缺任何一个 `tauri build` **直接失败**。
这里先出一版能过构建、也不难看的占位：民俗纸灯笼的极简剪影，配色跟 UI 那套
（纸黄 #e8d9b0 / 夜底 #0b0d10）对齐。

正式图标出来之后，把 `src-tauri/icons/` 下的文件换掉即可，本脚本不用再跑；
留着是为了让"图标怎么来的"这件事有据可查，而不是几个来历不明的二进制。

    python src-tauri/make_icons.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "icons"
BG = (11, 13, 16, 255)        # #0b0d10 夜底
PAPER = (232, 217, 176, 255)  # #e8d9b0 纸黄
EMBER = (201, 122, 60, 255)   # 灯芯暖橙


def draw_icon(size: int) -> Image.Image:
    """按比例画，任何尺寸都成立——不是把一张图缩上去，免得小尺寸糊成一团。"""
    # 4x 超采样再缩：直接在 32px 上画圆角矩形会有明显锯齿
    s = size * 4
    img = Image.new("RGBA", (s, s), BG)
    d = ImageDraw.Draw(img)

    # 圆角底板
    pad = s * 0.06
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=s * 0.18, fill=BG)

    # 灯笼主体（椭圆）
    cx = s / 2
    body_w, body_h = s * 0.46, s * 0.52
    top = s * 0.26
    d.ellipse([cx - body_w / 2, top, cx + body_w / 2, top + body_h], fill=PAPER)

    # 上下箍
    cap_w, cap_h = s * 0.26, s * 0.055
    d.rectangle([cx - cap_w / 2, top - cap_h, cx + cap_w / 2, top], fill=PAPER)
    d.rectangle([cx - cap_w / 2, top + body_h, cx + cap_w / 2, top + body_h + cap_h], fill=PAPER)

    # 提绳与穗子
    d.line([cx, s * 0.10, cx, top - cap_h], fill=PAPER, width=max(2, int(s * 0.018)))
    d.line([cx, top + body_h + cap_h, cx, s * 0.90], fill=EMBER, width=max(2, int(s * 0.022)))

    # 灯芯：中间一道暖色竖纹，小尺寸下也认得出这是个灯笼
    d.ellipse(
        [cx - body_w * 0.10, top + body_h * 0.28, cx + body_w * 0.10, top + body_h * 0.72],
        fill=EMBER,
    )
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for n in (32, 128, 256):
        draw_icon(n).save(OUT / f"{n}x{n}.png")
    # Windows 的 .ico 要多尺寸内嵌，任务栏/资源管理器各取所需
    draw_icon(256).save(
        OUT / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    for p in sorted(OUT.iterdir()):
        print(f"  {p.name:16} {p.stat().st_size:>7} bytes")


if __name__ == "__main__":
    main()
