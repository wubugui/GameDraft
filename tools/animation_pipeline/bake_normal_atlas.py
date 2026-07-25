"""离线烘焙 sprite 法线图集(atlas.png → atlas.normal.png)。

法线是图集像素的**确定性派生物**(只由 alpha 剪影决定),因此归产线、不归运行时:
运行时只负责加载这张图,加载不到就退化为 shader 内的平面法线常量
(`CharacterShadingFilter` 的 `uHasNrm=0` 分支),**禁止在加载期现场烘焙**。

算法与历史运行时实现(已删除的 `src/rendering/spriteNormalAtlas.ts` 中的 `bakeCell`)
逐步等价,以保证换成离线产物后画面不变:

    mask  = alpha > 0.05
    dist  = EDT(mask)                       # 到最近剪影外像素的欧氏距离
    prof  = gaussian(sqrt(dist/dmax), σ=3) * mask
    h     = prof * cw * 0.35                # 高度场(像素单位)
    n     = normalize(gx, -gy, -6.0)        # np.gradient:内部中心差分、边缘单侧
    RGBA  = (nx*.5+.5, ny*.5+.5, -nz/|n|, prof)

产物为 RGBA8 PNG,空白区填平面法线 (128,128,255,0),与历史实现一致。

覆盖两类消费方(与运行时三个挂滤镜的调用点一一对应):
  - 动画图集 `animation/<id>/atlas.png`,按 anim.json 的 cols×rows 逐格烘;
  - 热点展示图 `hotspot.displayImage.image`,单张静图按 1×1 格烘。

用法:
    ./dev.sh bake-normals                # 全烘(跳过已最新的)
    ./dev.sh bake-normals --force        # 全部重烘
    ./dev.sh bake-normals <anim_id> ...  # 只烘指定动画图集
    ./dev.sh bake-normals --only-images  # 只烘热点展示图
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter

# 与历史运行时实现同值,改动即改画面,不要随手调
ALPHA_THRESHOLD = 0.05
BLUR_SIGMA = 3.0
BLUR_TRUNCATE = 4.0
HEIGHT_SCALE = 0.35
NZ = -6.0

NORMAL_SUFFIX = ".normal.png"

# 法线是低频量(算完还要过 σ=3 高斯),没必要在源分辨率上算:直接降采样后再烘,
# 边长各降 DOWNSCALE 倍 → 像素数与烘焙耗时降 DOWNSCALE² 倍,产物体积同比缩小。
#
# 之所以能这么降而画面基本不变:着色器按**归一化 uv**(uNrmRect)采法线图,与像素尺寸无关;
# 且本算法对尺度不敏感——高度场 h = prof × cellW × 0.35 正比于 cell 宽,梯度取的是
# h 的差分,cell 缩 s 倍时 h 与像素间距同时缩 s 倍,**梯度不变**。唯一必须跟着缩的是
# 高斯 σ(按同一 s),否则模糊半径相对剪影变大、法线被抹平。见 _sigma_for()。
#
# 分辨率下限由**动画帧间稳定性**决定,不是静态清晰度:法线逐帧独立算,格子太小(如 1/16 的
# ~13×12/角色)时相邻帧法线量化跳变 → 游戏里着色闪烁。1/4(~54×51/角色)鼓包法线平滑且帧间稳,
# 实测不闪;更省可试 1/8。别再往 1/16 降(会闪)。
DEFAULT_DOWNSCALE = 4


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _round_half_up(a: np.ndarray) -> np.ndarray:
    """JS Math.round 语义(.5 向上),避免 np.round 的银行家舍入带来 ±1 漂移。"""
    return np.floor(a + 0.5)


def _sigma_for(downscale: int) -> float:
    """高斯 σ 必须随降采样同比缩,模糊半径才相对剪影不变(尺度等价的唯一前提)。"""
    return BLUR_SIGMA / downscale


def bake_cell(alpha_cell: np.ndarray, out_cell: np.ndarray, sigma: float) -> None:
    """就地把一个 cell 的法线写进 out_cell(H×W×4 uint8 视图)。"""
    mask = alpha_cell > ALPHA_THRESHOLD
    if not mask.any():
        return  # 空 cell 保留调用方填好的平面法线默认值

    dist = distance_transform_edt(mask)
    dmax = max(float(dist.max()), 1e-6)
    prof0 = np.sqrt(dist / dmax)
    blurred = gaussian_filter(
        prof0, sigma=sigma, mode="reflect", truncate=BLUR_TRUNCATE
    )
    prof = blurred * mask

    cw = alpha_cell.shape[1]
    hpx = prof * cw * HEIGHT_SCALE
    gy, gx = np.gradient(hpx)

    nx, ny = gx, -gy
    length = np.sqrt(nx * nx + ny * ny + NZ * NZ)

    out_cell[..., 0] = _round_half_up((nx / length * 0.5 + 0.5) * 255)
    out_cell[..., 1] = _round_half_up((ny / length * 0.5 + 0.5) * 255)
    out_cell[..., 2] = _round_half_up((-NZ / length) * 255)
    out_cell[..., 3] = _round_half_up(np.clip(prof, 0.0, 1.0) * 255)


def bake_image(
    atlas_path: Path, cols: int, rows: int, downscale: int = DEFAULT_DOWNSCALE
) -> Image.Image:
    """把一张图集烘成法线图;cols=rows=1 即整图单帧(静态 sprite)。

    downscale>1 时先把 alpha 面积平均降采样再烘(见 DEFAULT_DOWNSCALE 注释);
    整图统一缩放,归一化 uv 布局与源图集完全一致,着色器无需任何改动。
    """
    src = Image.open(atlas_path).convert("RGBA")
    alpha_band = src.getchannel("A")

    if downscale > 1:
        # 面积平均(BOX)而非最近邻:细肢体不会整段消失,只是变淡
        w = max(src.width // downscale, cols)
        h = max(src.height // downscale, rows)
        alpha_band = alpha_band.resize((w, h), Image.BOX)
    else:
        w, h = src.size

    alpha = np.asarray(alpha_band, dtype=np.float64) / 255.0
    sigma = _sigma_for(downscale)

    # 空区默认平面法线(朝相机),避免边界采样读到零向量
    out = np.empty((h, w, 4), dtype=np.uint8)
    out[..., 0] = 128
    out[..., 1] = 128
    out[..., 2] = 255
    out[..., 3] = 0

    # ⚠⚠ 格边界必须与**运行时逐字一致**。运行时的 strideW = 纹理宽 / cols(浮点,**不取整**,
    # 见 SpriteEntity 切帧与 resolveAnimationSet.effectiveCellPixelSize),帧 k 的归一化起点
    # 因此正好是 k/cols;而着色器拿到的 uNrmRect 又是按**源图集**尺寸归一化的。
    #
    # 老写法 `cw = w // cols` 再按 `k*cw` 铺放是**整数截断**:w 不能被 cols 整除时,格子全部
    # 左靠、右侧留下未用像素,**误差随帧序号线性累积**。后果(真踩过):
    #   · idle 动画一直在切帧 → 角色**根本没动**,内部像素却逐帧采到不同位置 = 闪烁;
    #   · 镜像查表 ul=1-ul 从另一端取,误差方向相反 → **同一角色朝左/朝右法线明显不同**。
    # 实测 46 张在用图集里 33 张中招,最严重的偏移达格宽的 42%。
    # 现在按 round(k*w/cols) 定边界:格宽最多差 1px,但边界落点与运行时采样点精确对齐。
    xs = [round(c * w / cols) for c in range(cols + 1)]
    ys = [round(r * h / rows) for r in range(rows + 1)]
    if min(xs[i + 1] - xs[i] for i in range(cols)) <= 0 \
            or min(ys[i + 1] - ys[i] for i in range(rows)) <= 0:
        raise ValueError(f"{atlas_path.name}: 网格 {cols}x{rows} 大于图集尺寸 {w}x{h}")

    for r in range(rows):
        y0, y1 = ys[r], ys[r + 1]
        for c in range(cols):
            x0, x1 = xs[c], xs[c + 1]
            cell = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
            bake_cell(alpha[y0:y1, x0:x1], cell, sigma)
            out[y0:y1, x0:x1] = cell

    return Image.fromarray(out, mode="RGBA")


def _grid_from_anim(anim: dict) -> tuple[int, int]:
    cols = int(anim.get("cols") or 0)
    rows = int(anim.get("rows") or 0)
    if cols <= 0 or rows <= 0:
        raise ValueError("anim.json 缺 cols/rows")
    return cols, rows


def discover(root: Path, only: list[str]) -> list[Path]:
    anim_root = root / "public/resources/runtime/animation"
    dirs = sorted(d for d in anim_root.iterdir() if (d / "anim.json").is_file())
    if only:
        wanted = set(only)
        dirs = [d for d in dirs if d.name in wanted]
        missing = wanted - {d.name for d in dirs}
        if missing:
            raise SystemExit(f"找不到这些图集: {', '.join(sorted(missing))}")
    return dirs


def resolve_bake_config(anim: dict, cli_downscale: int | None) -> tuple[bool, int]:
    """从 anim.json 的 normalBake 配置 + CLI 覆盖解析(是否烘焙, 降采样)。

    per-animation 配置(`anim.json` 的 `normalBake: {enabled, downscale}`)是权威;
    显式传 CLI --downscale 时全局覆盖降采样(用于统一重烘)。未配 → 默认(启用, DEFAULT_DOWNSCALE)。
    """
    nb = anim.get("normalBake") if isinstance(anim.get("normalBake"), dict) else {}
    enabled = nb.get("enabled") is not False   # 缺省启用;仅显式 false 关闭
    if cli_downscale is not None:
        ds = cli_downscale
    else:
        d = nb.get("downscale")
        ds = int(d) if isinstance(d, (int, float)) and not isinstance(d, bool) and d >= 1 else DEFAULT_DOWNSCALE
    return enabled, max(1, ds)


def bake_one(anim_dir: Path, force: bool, cli_downscale: int | None = None) -> str:
    anim = json.loads((anim_dir / "anim.json").read_text(encoding="utf-8"))
    sheet = anim.get("spritesheet") or "atlas.png"
    atlas_path = anim_dir / Path(sheet).name
    if not atlas_path.is_file():
        return f"跳过 {anim_dir.name}: 找不到 {atlas_path.name}"

    enabled, downscale = resolve_bake_config(anim, cli_downscale)
    out_path = normal_path_for(atlas_path)
    if not enabled:
        # 该动画关闭法线:删掉已有法线图,运行时回退平面法线
        if out_path.is_file():
            out_path.unlink()
            return f"禁用(已删法线) {anim_dir.name}"
        return f"禁用 {anim_dir.name}"
    if (
        not force
        and out_path.is_file()
        and out_path.stat().st_mtime >= atlas_path.stat().st_mtime
    ):
        return f"最新 {anim_dir.name}"

    cols, rows = _grid_from_anim(anim)
    img = bake_image(atlas_path, cols, rows, downscale)
    img.save(out_path, optimize=True)
    kb = out_path.stat().st_size / 1024
    src_w, src_h = Image.open(atlas_path).size
    return (
        f"烘好 {anim_dir.name}  {cols}x{rows} 格  "
        f"{src_w}x{src_h}→{img.width}x{img.height}  {kb:.0f}KB"
    )


def normal_path_for(image_path: Path) -> Path:
    """foo.png → foo.normal.png(运行时 normalAtlasUrlFor 的同一约定)。"""
    return image_path.with_name(image_path.with_suffix("").name + NORMAL_SUFFIX)


def discover_hotspot_images(root: Path) -> list[Path]:
    """场景 JSON 里所有热点展示图(单张静图,运行时按 1×1 格取法线)。"""
    seen: dict[Path, None] = {}
    for scene in sorted((root / "public/assets/scenes").glob("*.json")):
        try:
            data = json.loads(scene.read_text(encoding="utf-8"))
        except Exception:
            continue
        for hotspot in data.get("hotspots", []) or []:
            image = (hotspot.get("displayImage") or {}).get("image")
            if not image:
                continue
            path = root / "public" / str(image).lstrip("/")
            if path.is_file():
                seen.setdefault(path, None)
    return list(seen)


def bake_image_file(
    image_path: Path, force: bool, downscale: int | None = None
) -> str:
    # 热点展示图无 anim.json/per-image 配置 → 用 CLI 覆盖值或默认
    downscale = downscale if downscale is not None else DEFAULT_DOWNSCALE
    out_path = normal_path_for(image_path)
    if (
        not force
        and out_path.is_file()
        and out_path.stat().st_mtime >= image_path.stat().st_mtime
    ):
        return f"最新 {image_path.name}"
    src_w, src_h = Image.open(image_path).size
    img = bake_image(image_path, 1, 1, downscale)
    img.save(out_path, optimize=True)
    kb = out_path.stat().st_size / 1024
    return (
        f"烘好 {image_path.name}  1x1 格  "
        f"{src_w}x{src_h}→{img.width}x{img.height}  {kb:.0f}KB"
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="bake-normals", description=__doc__)
    p.add_argument("anim_ids", nargs="*", help="只烘这些动画图集目录名(缺省=全部)")
    p.add_argument("--force", action="store_true", help="忽略 mtime,全部重烘")
    p.add_argument("--only-images", action="store_true", help="只烘热点展示图")
    p.add_argument("--only-atlases", action="store_true", help="只烘动画图集")
    p.add_argument(
        "--downscale",
        type=int,
        default=None,
        metavar="N",
        help=f"全局覆盖降采样 1/N(不传则用每个动画 anim.json 的 normalBake.downscale,缺省 {DEFAULT_DOWNSCALE})",
    )
    args = p.parse_args(argv)
    if args.downscale is not None and args.downscale < 1:
        p.error("--downscale 必须 ≥1")

    root = repo_root()
    baked = total = 0
    if args.downscale is not None:
        print(f"[法线] 全局覆盖降采样 1/{args.downscale}")
    else:
        print("[法线] 按各动画 anim.json 的 normalBake 配置(未配=默认启用 1/"
              f"{DEFAULT_DOWNSCALE})")

    if not args.only_images:
        dirs = discover(root, args.anim_ids)
        total += len(dirs)
        for d in dirs:
            try:
                msg = bake_one(d, args.force, args.downscale)
            except Exception as e:  # 单张失败不阻断整批
                print(f"失败 {d.name}: {e}", file=sys.stderr)
                continue
            baked += msg.startswith("烘好")
            print(msg)

    if not args.only_atlases and not args.anim_ids:
        images = discover_hotspot_images(root)
        total += len(images)
        for image in images:
            try:
                msg = bake_image_file(image, args.force, args.downscale)
            except Exception as e:
                print(f"失败 {image.name}: {e}", file=sys.stderr)
                continue
            baked += msg.startswith("烘好")
            print(msg)

    print(f"\n完成:{baked} 张新烘 / 共 {total} 张源图")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
