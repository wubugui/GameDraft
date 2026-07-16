#!/usr/bin/env python3
"""把《寻狗记》Demo 生成素材包（GeneratedDemoAssets_20260606）入库到 runtime 资源目录。

用法（仓库根目录）：
    .tools/venv/bin/python scripts/ingest_demo_assets.py [--src /path/to/GeneratedDemoAssets_20260606] [--dry-run]

职责：
1. 场景背景 → public/resources/runtime/scenes/<sceneId>/background.png（直拷）。
2. 角色立绘（黑底）→ 抠图 → 单帧动画包 public/resources/runtime/animation/<bundle>/{atlas.png, anim.json}。
3. 尸体/道具抠图 → public/resources/runtime/images/{corpses,props}/demo/。
4. 整幅插画（黑底全屏用）→ public/resources/runtime/images/illustrations/demo/（直拷）。
5. 辉光特效（黑底）→ 亮度转 alpha → public/resources/runtime/images/ui_vfx/。
6. 音频 → public/resources/runtime/audio/demo/（直拷，含占位标注见 docs/demo_missing_assets.md）。

幂等：重复运行覆盖输出；不修改源素材。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import deque
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNTIME = REPO_ROOT / "public" / "resources" / "runtime"

# 近黑判定阈值：像素 max(r,g,b) <= 此值才可能被当作背景（从边界泛洪可达才会被抠掉）
BLACK_KEY_THRESHOLD = 26

# ---------------------------------------------------------------------------
# 映射表
# ---------------------------------------------------------------------------

# (源相对路径, 场景 id)
SCENES: list[tuple[str, str]] = [
    ("scenes/scene_01_wujin_street.png", "雾津街头"),
    ("scenes/scene_03_zhuang_lingtang.png", "庄家灵堂"),
    ("scenes/scene_04_yizhuang.png", "义庄"),
    ("scenes/scene_05_yanwangling_night_road.png", "阎王岭山口"),
    ("scenes/scene_06_city_gate_mist_road.png", "城门口"),
    ("scenes/scene_08_well_ruined_shrine.png", "枯井土地庙"),
    ("scenes/scene_09_chenghuang_temple_night.png", "城隍庙夜"),
    ("scenes/scene_10_popo_courtyard.png", "婆子家院"),
]

# (源相对路径, 动画包目录名, worldHeight 世界单位)
CHARACTERS: list[tuple[str, str, int]] = [
    ("characters/char_05_old_woman.png", "npc_popo_anim", 135),
    ("characters/char_06_yizhuang_keeper.png", "npc_yizhuang_keeper_anim", 150),
    ("characters/char_07_teahouse_owner.png", "npc_teahouse_owner_anim", 150),
    ("characters/char_09_coolie_a.png", "npc_coolie_a_anim", 150),
    ("characters/char_10_coolie_b.png", "npc_coolie_b_anim", 150),
    ("characters/char_11_coolie_c.png", "npc_coolie_c_anim", 150),
    ("characters/char_12_soul_calling_employer.png", "npc_employer_anim", 150),
    # 关二狗道士装：仅单帧（无行走帧，终幕用作立绘/化身占位）
    ("characters/char_02_guangergou_fake_taoist.png", "player_taoist_anim", 155),
]

# 抠图后放场景里的尸体/物件贴图 (源相对路径, 输出文件名)；输出到 images/corpses/demo/
CORPSE_CUTOUTS: list[tuple[str, str]] = [
    ("corpses/corpse_01_bride_fullbody.png", "bride_fullbody.png"),
    ("corpses/corpse_03_yizhuang_old_master.png", "yizhuang_old_master.png"),
    ("corpses/corpse_04_yizhuang_outlander.png", "yizhuang_outlander.png"),
    ("corpses/corpse_05_two_corpses_grappling.png", "two_corpses_grappling.png"),
    ("corpses/corpse_06_chenghuang_unknown_woman.png", "chenghuang_unknown_woman.png"),
    ("corpses/supp_04_outlander_half_rise_lunge.png", "outlander_half_rise.png"),
    ("corpses/supp_05_yizhuang_success_lie_flat.png", "two_corpses_lie_flat.png"),
]

# 抠图后用作场景内/浮层道具 (源相对路径, 输出文件名)；输出到 images/props/demo/
PROP_CUTOUTS: list[tuple[str, str]] = [
    ("props/prop_04_yellow_joss_paper.png", "yellow_joss_paper.png"),
    ("props/prop_07_foreign_crate_iron_box.png", "foreign_crate.png"),
    ("props/supp_09_delivery_bundle_payment.png", "delivery_bundle.png"),
    ("props/prop_09_chenghuang_offerings.png", "chenghuang_offerings.png"),
    ("characters/char_14_crowd_sheet.png", "crowd_sheet.png"),
]

# 整幅展示（cutscene showImg 全屏，黑底即为画框）→ images/illustrations/demo/
ILLUSTRATIONS: list[tuple[str, str]] = [
    ("corpses/corpse_02_bride_face_closeup.png", "bride_face_closeup.png"),
    ("corpses/supp_02_well_nonhuman_face_closeup.png", "well_nonhuman_face.png"),
    ("representative_generated_20260607/01_back_corpse_illustration.png", "back_corpse.png"),
    ("representative_generated_20260607/02_river_paper_illustration.png", "river_paper.png"),
    ("representative_generated_20260607/03_dock_box_illustration.png", "dock_box.png"),
    ("representative_generated_20260607/04_well_face_illustration.png", "well_face.png"),
    ("representative_generated_20260607/05_forest_name_call_illustration.png", "forest_name_call.png"),
    ("representative_generated_20260607/06_yizhuang_corpses_illustration.png", "yizhuang_corpses.png"),
    ("representative_generated_20260607/07_chenghuang_lamp_illustration.png", "chenghuang_lamp.png"),
    ("props/prop_01_zombie_suppression_kit.png", "zombie_suppression_kit.png"),
    ("props/prop_02_soul_calling_map.png", "soul_calling_map.png"),
    ("props/prop_03_fake_taoist_kit.png", "fake_taoist_kit.png"),
    ("props/prop_05_compass_silver_map_book.png", "compass_silver_map_book.png"),
    ("props/prop_06_clara_notebook_photo.png", "clara_notebook_photo.png"),
    ("props/supp_01_river_ghost_hand_paper.png", "river_ghost_hand.png"),
    ("props/supp_08_ankle_grab_scratch_closeup.png", "ankle_scratch.png"),
    ("ui_vfx/supp_07_demo_end_panel.png", "demo_end_panel.png"),
]

# 亮度→alpha 的辉光浮层 → images/ui_vfx/。crop 为 (左,上,右,下) 的宽高比例，None 表示整幅。
GLOW_OVERLAYS: list[tuple[str, str, tuple[float, float, float, float] | None]] = [
    # 原图是三联画稿（月牙光/香粉微尘/烛火），Axiu 信号浮层取中联微尘
    ("ui_vfx/vfx_01_axiu_signal.png", "axiu_signal_glow.png", (0.34, 0.08, 0.66, 0.95)),
    ("ui_vfx/vfx_01_axiu_signal.png", "axiu_lamp_glow.png", (0.68, 0.05, 1.0, 0.98)),
    ("ui_vfx/vfx_04_horror_edge_flash.png", "horror_edge_flash.png", None),
]

# 音频直拷 → audio/demo/<目标名>。可用性备注见 docs/demo_missing_assets.md。
AUDIO: list[tuple[str, str]] = [
    ("audio/amb_03_riverbank_loop.wav", "amb_riverbank_loop.wav"),
    ("audio/amb_04_dock_water_crowd_loop.wav", "amb_dock_water_crowd_loop.wav"),
    ("audio/amb_05_night_forest_loop.wav", "amb_night_forest_loop.wav"),
    ("audio/amb_06_yizhuang_room_tone.wav", "amb_yizhuang_room_tone.wav"),
    ("audio/amb_07_chenghuang_temple_loop.wav", "amb_chenghuang_temple_loop.wav"),
    ("audio/amb_08_light_rain_loop.wav", "amb_light_rain_loop.wav"),
    ("audio/sfx_01_force_swallowed_thud.wav", "sfx_force_swallowed_thud.wav"),
    ("audio/sfx_02_bride_face_silence_heartbeat.wav", "sfx_heartbeat_bed.wav"),
    ("audio/sfx_03_paper_hand_rustle.wav", "sfx_paper_hand_rustle.wav"),
    ("audio/sfx_04_underwater_grab.wav", "sfx_underwater_grab.wav"),
    ("audio/sfx_05_well_cry_stop.wav", "sfx_well_cry_stop.wav"),
    ("audio/sfx_10_abnormal_breath.wav", "sfx_abnormal_breath.wav"),
    ("audio/sfx_11_bone_dull_knock_set.wav", "sfx_bone_dull_knock.wav"),
    ("audio/sfx_12_ink_line_snap.wav", "sfx_ink_line_snap.wav"),
    ("audio/sfx_13_stone_press_rebound.wav", "sfx_stone_press.wav"),
    ("audio/sfx_14_axiu_faint_hum.wav", "sfx_axiu_faint_hum.wav"),
    ("audio/sfx_15_lamp_oil_flame.wav", "sfx_lamp_oil_flame.wav"),
    ("audio/sfx_16_night_bird_startle.wav", "sfx_night_bird_startle.wav"),
    ("audio/sfx_17_rice_scatter_circle.wav", "sfx_rice_scatter.wav"),
    ("audio/sfx_18_hold_silence_pull_loop.wav", "sfx_hold_pressure_loop.wav"),
    ("audio/sfx_19_ui_paper_choice_tick.wav", "sfx_ui_paper_tick.wav"),
    ("audio/sfx_20_axiu_tiny_signal.wav", "sfx_axiu_tiny_signal.wav"),
    ("audio/sfx_21_corpse_cloth_creak.wav", "sfx_corpse_cloth_creak.wav"),
    ("audio/sfx_22_well_childlike_cry_loop.wav", "sfx_well_childlike_cry_loop.wav"),
    ("audio_bgm_candidates/bgm_candidate_01_piano_horror.mp3", "bgm_placeholder_dread_piano.mp3"),
    ("audio_bgm_candidates/bgm_candidate_02_dark_shadows.mp3", "bgm_placeholder_dark_shadows.mp3"),
    ("audio_bgm_candidates/bgm_candidate_03_fragments_of_bangkok.mp3", "bgm_placeholder_low_tension.mp3"),
]


# ---------------------------------------------------------------------------
# 图像处理
# ---------------------------------------------------------------------------

def key_out_black_background(im: Image.Image, threshold: int = BLACK_KEY_THRESHOLD) -> Image.Image:
    """从图像边界出发，把可达的近黑像素抠成透明（不动主体内部的暗色）。"""
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()

    def is_near_black(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return a != 0 and max(r, g, b) <= threshold

    visited = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_near_black(x, y) and not visited[y * w + x]:
                visited[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_near_black(x, y) and not visited[y * w + x]:
                visited[y * w + x] = 1
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx] and is_near_black(nx, ny):
                visited[ny * w + nx] = 1
                queue.append((nx, ny))
    return rgba


def crop_to_content(im: Image.Image) -> Image.Image:
    bbox = im.getbbox()
    return im.crop(bbox) if bbox else im


def luminance_to_alpha(im: Image.Image) -> Image.Image:
    """黑底辉光图：alpha = max(r,g,b)，保留原色。适合叠加在场景上的光效。"""
    rgba = im.convert("RGBA")
    r, g, b, _ = rgba.split()
    alpha = Image.merge("RGB", (r, g, b)).convert("L")
    rgba.putalpha(alpha)
    return rgba


def build_single_frame_anim_manifest(width: int, height: int, world_height: int) -> dict:
    return {
        "spritesheet": "atlas.png",
        "cols": 1,
        "rows": 1,
        "states": {"idle": {"frames": [0], "frameRate": 1, "loop": True}},
        "worldHeight": world_height,
        "cellWidth": width,
        "cellHeight": height,
        "atlasFrames": [
            {"width": width, "height": height, "contentWidth": width, "contentHeight": height}
        ],
    }


# ---------------------------------------------------------------------------
# 入库步骤
# ---------------------------------------------------------------------------

def ensure_parent(path: Path, dry: bool) -> None:
    if not dry:
        path.parent.mkdir(parents=True, exist_ok=True)


def ingest_scenes(src_root: Path, dry: bool) -> None:
    for rel, scene_id in SCENES:
        src = src_root / rel
        dst = RUNTIME / "scenes" / scene_id / "background.png"
        print(f"[scene] {rel} -> {dst.relative_to(REPO_ROOT)}")
        ensure_parent(dst, dry)
        if not dry:
            shutil.copyfile(src, dst)


def ingest_characters(src_root: Path, dry: bool) -> None:
    for rel, bundle, world_height in CHARACTERS:
        src = src_root / rel
        out_dir = RUNTIME / "animation" / bundle
        print(f"[char ] {rel} -> {out_dir.relative_to(REPO_ROOT)} (worldHeight={world_height})")
        if dry:
            continue
        out_dir.mkdir(parents=True, exist_ok=True)
        cut = crop_to_content(key_out_black_background(Image.open(src)))
        cut.save(out_dir / "atlas.png")
        manifest = build_single_frame_anim_manifest(cut.width, cut.height, world_height)
        (out_dir / "anim.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def ingest_cutouts(src_root: Path, entries: list[tuple[str, str]], out_sub: str, dry: bool) -> None:
    for rel, out_name in entries:
        src = src_root / rel
        dst = RUNTIME / "images" / out_sub / out_name
        print(f"[cut  ] {rel} -> {dst.relative_to(REPO_ROOT)}")
        ensure_parent(dst, dry)
        if not dry:
            cut = crop_to_content(key_out_black_background(Image.open(src)))
            cut.save(dst)


def ingest_copies(src_root: Path, entries: list[tuple[str, str]], out_sub: str, dry: bool) -> None:
    for rel, out_name in entries:
        src = src_root / rel
        dst = RUNTIME / "images" / out_sub / out_name
        print(f"[copy ] {rel} -> {dst.relative_to(REPO_ROOT)}")
        ensure_parent(dst, dry)
        if not dry:
            shutil.copyfile(src, dst)


def ingest_glows(src_root: Path, dry: bool) -> None:
    for rel, out_name, crop in GLOW_OVERLAYS:
        src = src_root / rel
        dst = RUNTIME / "images" / "ui_vfx" / out_name
        print(f"[glow ] {rel} -> {dst.relative_to(REPO_ROOT)}")
        ensure_parent(dst, dry)
        if dry:
            continue
        im = Image.open(src)
        if crop is not None:
            l, t, r, b = crop
            im = im.crop((int(im.width * l), int(im.height * t), int(im.width * r), int(im.height * b)))
        luminance_to_alpha(im).save(dst)


def ingest_audio(src_root: Path, dry: bool) -> None:
    for rel, out_name in AUDIO:
        src = src_root / rel
        dst = RUNTIME / "audio" / "demo" / out_name
        print(f"[audio] {rel} -> {dst.relative_to(REPO_ROOT)}")
        ensure_parent(dst, dry)
        if not dry:
            shutil.copyfile(src, dst)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", default=r"D:\sucai\GeneratedDemoAssets_20260606")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    src_root = Path(args.src)
    if not src_root.is_dir():
        print(f"素材根目录不存在: {src_root}", file=sys.stderr)
        return 1

    missing = [
        rel
        for table in (
            [r for r, _ in SCENES],
            [r for r, _, _ in CHARACTERS],
            [r for r, _ in CORPSE_CUTOUTS],
            [r for r, _ in PROP_CUTOUTS],
            [r for r, _ in ILLUSTRATIONS],
            [r for r, _ in GLOW_OVERLAYS],
            [r for r, _ in AUDIO],
        )
        for rel in table
        if not (src_root / rel).is_file()
    ]
    if missing:
        print("以下源文件缺失，请先核对素材包：", file=sys.stderr)
        for rel in missing:
            print(f"  - {rel}", file=sys.stderr)
        return 1

    ingest_scenes(src_root, args.dry_run)
    ingest_characters(src_root, args.dry_run)
    ingest_cutouts(src_root, CORPSE_CUTOUTS, "corpses/demo", args.dry_run)
    ingest_cutouts(src_root, PROP_CUTOUTS, "props/demo", args.dry_run)
    ingest_copies(src_root, ILLUSTRATIONS, "illustrations/demo", args.dry_run)
    ingest_glows(src_root, args.dry_run)
    ingest_audio(src_root, args.dry_run)
    print("入库完成。" + ("（dry-run，未写文件）" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
