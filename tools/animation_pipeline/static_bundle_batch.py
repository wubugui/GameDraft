"""静态动画包批产驱动：一张图 → 抠图 → 单帧动画包 → 发布。

分三步，**每步都可单独跑、都不隐式推进下一步**（程序驱动、agent 当裁判：
`stage` 只出候选与目验图，`publish` 才动 `public/resources/runtime`）：

    stage    源图 → (可选抠图) → 单帧动画包 staging + 棋盘格目验图
    review   把 staging 的目验图路径列出来（给人/agent 看图用）
    publish  staging → public/resources/runtime/animation/<bundleId>/（带备份与哈希核验）

为什么抠图是可选的:
  - 志怪设定稿 `setup.png` 是**平灰底 RGB**，必须抠（`--matte fusion`）;
  - 已上线的展示图 PNG **本来就带 alpha、就是游戏当前在用的源**，重抠 = 换源，
    违反素材管线不变量①，所以这类一律 `--no-matte` 逐像素原样进包。

用法：

    .tools/venv/bin/python -m tools.animation_pipeline.static_bundle_batch stage \\
        --jobs jobs.json --out-root tmp/static_bundles
    .tools/venv/bin/python -m tools.animation_pipeline.static_bundle_batch publish \\
        --staging tmp/static_bundles/<bundleId> [--backup-root tmp/static_bundles/_backup]

jobs.json = [{"source": "...png", "bundleId": "x_anim", "bodyHeight": 150,
              "matte": true, "placeholder": true, "footAnchorX": 0.5,
              "aliases": ["stand"], "note": "..."}]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
from typing import Any

import numpy as np
from PIL import Image

from tools.animation_pipeline import workbench_stages as stages

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ANIMATION_ROOT = REPO_ROOT / "public" / "resources" / "runtime" / "animation"
CHECKER_SIZE = 16


def _checkerboard(width: int, height: int) -> np.ndarray:
    """棋盘底：抠图判读的标准背景（纯色底会把同色残留藏起来）。"""
    ys, xs = np.mgrid[0:height, 0:width]
    cells = ((ys // CHECKER_SIZE) + (xs // CHECKER_SIZE)) % 2
    board = np.where(cells == 0, 210, 150).astype(np.uint8)
    return np.dstack([board, board, board])


def _review_sheet(rgba: np.ndarray) -> Image.Image:
    """左=棋盘格合成（看残留/缺口），右=alpha 灰度（看半透边与内部空洞）。"""
    height, width = rgba.shape[:2]
    alpha = rgba[:, :, 3:4].astype(np.float32) / 255.0
    composed = (rgba[:, :, :3].astype(np.float32) * alpha
                + _checkerboard(width, height).astype(np.float32) * (1.0 - alpha))
    alpha_map = np.repeat(rgba[:, :, 3:4], 3, axis=2)
    sheet = np.concatenate(
        [composed.astype(np.uint8), alpha_map], axis=1)
    image = Image.fromarray(sheet, mode="RGB")
    # 目验图不参与产物，缩到看得清即可（长边 1200）
    longest = max(image.size)
    if longest > 1200:
        ratio = 1200 / longest
        image = image.resize(
            (max(1, int(image.width * ratio)), max(1, int(image.height * ratio))),
            Image.LANCZOS,
        )
    return image


def _alpha_health(rgba: np.ndarray) -> dict[str, float]:
    """抠图体检数值。判读铁律：halo 不可信、holes 才可信（见 matting-toolbox 卡）。"""
    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    solid = alpha > 0.95
    semi = (alpha > 0.05) & (alpha <= 0.95)
    total = float(alpha.size)
    filled = float((alpha > 0.05).sum())
    holes = 0.0
    if filled > 0:
        # 主体内部的洞：实心区域内被半透/全透打穿的像素占比
        from scipy.ndimage import binary_fill_holes

        filled_mask = binary_fill_holes(solid)
        holes = float((filled_mask & ~solid).sum()) / max(filled, 1.0)
    return {
        "coverage": filled / total,
        "semiTransparentRatio": float(semi.sum()) / max(filled, 1.0),
        "holeRatio": holes,
    }


def _load_source(path: Path, *, matte_method: str | None) -> tuple[np.ndarray, dict[str, Any]]:
    with Image.open(path) as image:
        source_mode = image.mode
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    rgba = np.ascontiguousarray(rgba)
    provenance: dict[str, Any] = {"sourceMode": source_mode, "matted": False}
    if matte_method is None:
        if rgba[:, :, 3].min() == 255:
            provenance["warning"] = (
                "源图不带透明通道且未开抠图：整幅矩形都会成为角色形体")
        return rgba, provenance
    matted, matte_prov = stages.matte_rgba_with_provenance(rgba, matte_method)
    provenance["matted"] = True
    provenance["matting"] = matte_prov
    return matted, provenance


def _stage_one(job: dict[str, Any], out_root: Path) -> dict[str, Any]:
    source = Path(str(job["source"]))
    if not source.is_absolute():
        source = REPO_ROOT / source
    bundle_id = stages.safe_bundle_id(str(job["bundleId"]))
    body_height = float(job["bodyHeight"])
    matte_method = str(job.get("matte") or "").strip() or None
    if job.get("matte") is True:
        matte_method = "fusion"
    if job.get("matte") is False:
        matte_method = None

    rgba, provenance = _load_source(source, matte_method=matte_method)
    health = _alpha_health(rgba)
    atlas, anim, meta = stages.pack_static_single_frame(
        rgba,
        body_height=body_height,
        aliases=[str(a) for a in (job.get("aliases") or [])],
        foot_anchor_x=(float(job["footAnchorX"]) if job.get("footAnchorX") is not None else None),
        texels_per_world=float(job.get("texelsPerWorld") or stages.SHIPPED_TEXELS_PER_WORLD),
    )
    meta["sourceProvenance"] = provenance
    meta["sourceAlphaHealth"] = health
    if job.get("note"):
        meta["note"] = str(job["note"])

    out_dir = out_root / bundle_id
    if out_dir.exists():
        shutil.rmtree(out_dir)
    manifest = stages.write_h_static_bundle_stage(
        out_dir, atlas, anim, meta,
        source_c_png=source,
        bundle_id=bundle_id,
        placeholder=bool(job.get("placeholder", True)),
    )
    sheet_path = out_dir / "review_sheet.png"
    _review_sheet(rgba).save(sheet_path, format="PNG")
    manifest["reviewSheet"] = str(sheet_path)
    manifest["sourceAlphaHealth"] = health
    manifest["sourceProvenance"] = provenance
    return manifest


def _cmd_stage(args: argparse.Namespace) -> int:
    jobs = json.loads(Path(args.jobs).read_text(encoding="utf-8"))
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("jobs 文件必须是非空数组")
    out_root = Path(args.out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    failures = 0
    for job in jobs:
        try:
            results.append({"ok": True, **_stage_one(job, out_root)})
        except Exception as exc:  # noqa: BLE001 - 批处理逐条报错，不让一条炸掉整批
            failures += 1
            results.append({
                "ok": False, "bundleId": job.get("bundleId"),
                "error": f"{type(exc).__name__}: {exc}",
            })
            print(f"[FAIL] {job.get('bundleId')}: {exc}", file=sys.stderr)
    report = out_root / "batch_report.json"
    report.write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "staged": sum(1 for r in results if r.get("ok")),
        "failed": failures,
        "report": str(report),
    }, ensure_ascii=False, indent=2))
    return 1 if failures else 0


def _cmd_review(args: argparse.Namespace) -> int:
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    rows = [
        {
            "bundleId": item.get("bundleId"),
            "reviewSheet": item.get("reviewSheet"),
            "cell": item.get("atlas"),
            "bodyHeight": item.get("authoredBodyHeight"),
            "health": item.get("sourceAlphaHealth"),
        }
        for item in report if item.get("ok")
    ]
    rows.sort(key=lambda r: -(float((r.get("health") or {}).get("holeRatio") or 0)))
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


def _cmd_publish(args: argparse.Namespace) -> int:
    staging = Path(args.staging).resolve()
    manifest_path = staging / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"staging 目录缺 manifest.json: {staging}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("stage") != "H_STATIC_BUNDLE":
        raise ValueError("只发布 H_STATIC_BUNDLE staging 目录")
    bundle_id = stages.safe_bundle_id(str(manifest["bundleId"]))
    target = RUNTIME_ANIMATION_ROOT / bundle_id

    published: list[dict[str, Any]] = []
    backup_dir: Path | None = None
    if target.exists():
        # 覆盖游戏在用文件前必须有返修路径（素材管线红线）
        backup_root = Path(args.backup_root or (staging.parent / "_backup"))
        backup_dir = backup_root / bundle_id
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
        shutil.copytree(target, backup_dir)
    target.mkdir(parents=True, exist_ok=True)
    for artifact in manifest["artifacts"]:
        name = str(artifact["file"])
        src = staging / name
        dst = target / name
        shutil.copyfile(src, dst)
        digest = stages._sha256(dst)
        if digest != artifact["sha256"]:
            raise RuntimeError(f"发布后哈希不符：{dst}")
        published.append({"path": name, "sha256": digest, "size": dst.stat().st_size})
    print(json.dumps({
        "bundleId": bundle_id,
        "targetRoot": str(target),
        "files": published,
        "backup": str(backup_dir) if backup_dir else None,
        "placeholder": bool(manifest.get("placeholder")),
        "nextStep": "跑 ./dev.sh bake-normals <bundleId> 烘法线，再跑素材审计与 validate-data",
    }, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    stage = sub.add_parser("stage", help="批量出单帧动画包 staging + 目验图")
    stage.add_argument("--jobs", required=True)
    stage.add_argument("--out-root", required=True)
    stage.set_defaults(handler=_cmd_stage)

    review = sub.add_parser("review", help="列出目验图与体检数值（洞多的排前面）")
    review.add_argument("--report", required=True)
    review.set_defaults(handler=_cmd_review)

    publish = sub.add_parser("publish", help="staging → runtime（带备份与哈希核验）")
    publish.add_argument("--staging", required=True)
    publish.add_argument("--backup-root")
    publish.set_defaults(handler=_cmd_publish)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.handler(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
