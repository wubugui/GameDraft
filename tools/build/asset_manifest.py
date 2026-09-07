"""生成打包抽取清单：哪些 ``public/`` 下的文件要进游戏产物。

**只读。** 本模块不会写、移动或删除开发树里的任何文件。裁剪包体一律通过"不抽取"
实现——清单是一份白名单，没进清单的文件原样留在开发树里，不受任何影响。

清单怎么来
==========

四个来源取并集，再减去兜底排除规则：

1. **文本配置全量**：``public/assets/**`` 整棵树。它是游戏数据（约 1 MB），运行时
   大量按数据驱动动态加载（场景 id、对话图 id 都是运行期才知道的字符串），静态
   证明闭包不可能完备，而它小到不值得冒漏文件的风险。
2. **JSON 引用闭包**：走 :func:`asset_reference_audit.audit_project_assets` 收集的
   ``resolved_media`` / ``resolved_text``。与素材审计**同一套引用语义**，不另写一份
   会漂的扫描器。
3. **传递闭包**：被引用的文件自己还引用别人——动画包 ``anim.json`` 里的
   ``spritesheet``、光照载荷 ``lighting.json`` 旁按 ``shading.mode`` 要读的那张 probe
   图集等。见 ``_EXPANDERS``。
4. **规则显式包含**：代码里写死路径、或运行期拼出来的资源（UI 图标、光照载荷入口、
   小游戏贴图……）。这类静态扫描抓不到，只能在 ``manifest_rules.json`` 里登记。

最后减去 ``never_extract``：明确不进包的 authoring-only 目录（编辑器预览、参考图、
备份、生成脚本与日志）。这是**兜底**，不是主力——正常情况下它们本来就不在前四项里。

光照载荷为什么走展开器而不是 glob
==================================

2026-09-05 事故：运行时 09-02 把 probe 正式档切到 ``atlas_bin.bin``，规则文件还按前一天的
口径把它当"只有 F2 才读"的调试载荷排除在发行档之外 → 发行包 28 个场景角色照明整份失效，
构建/验收/审计三道门全绿。根因是"运行时读什么"散在三处各自维护。现在只有一处：
``src/core/lightingPayloadFiles.ts`` 是运行时的真相源，本模块的 ``PROBE_ATLAS_FILE_BY_MODE``
等表是它的镜像，``tests/test_asset_manifest.py`` 解析那份 TS 源码逐字比对——两边漂了立刻红。
展开器 ``_expand_lighting_payload`` 读每份 ``lighting.json`` 自己的 ``shading.mode`` 决定抽哪张
图集；mode 要的图集磁盘上没有时记进 ``ManifestReport.problems``，``--strict`` 据此停包。

漏抽取怎么发现
==============

静态清单不可能证明完备。真正的保险有两道：产物验收门（``scripts/verify_build.mjs``，
含对着开发树的光照载荷平价核对）和全场景抓取扫描（``scripts/scene_sweep.mjs`` →
``tools/build/scene_sweep.py``：无头把每个场景真跑一遍，记下运行时**实际请求**的每个
资源，反向核对清单）。清单漏了什么，那里会当场露馅。

用法::

    python -m tools.build.asset_manifest --out .build/manifest.json
    python -m tools.build.asset_manifest --report-unpicked   # 看什么没进包
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

_THIS = Path(__file__).resolve()
_PROJECT_ROOT_DEFAULT = _THIS.parent.parent.parent
if str(_PROJECT_ROOT_DEFAULT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT_DEFAULT))

from tools.editor.shared.asset_reference_audit import audit_project_assets  # noqa: E402
from tools.editor.shared.project_paths import ProjectPaths  # noqa: E402

RULES_PATH = _THIS.parent / "manifest_rules.json"

# ---------------------------------------------------------------------------
# 光照烘焙载荷：运行时到底读哪些文件
#
# **镜像自 ``src/core/lightingPayloadFiles.ts``**（运行时的唯一真相源）。
# ``tests/test_asset_manifest.py`` 解析那份 TS 源码逐字比对下面几张表：两边有一个
# 名字/缺省值不同，测试立刻红——这就是 2026-09-05 那类"运行时改了、打包没跟上"的防线。
# ---------------------------------------------------------------------------

#: ``lighting.json`` 的 ``shading.mode`` → 进场景要拉的那张 probe 图集
PROBE_ATLAS_FILE_BY_MODE: dict[int, str] = {1: "atlas_l1.bin", 2: "atlas_l2.bin", 3: "atlas_bin.bin"}
#: 载荷没写 / 写了不认识的 mode 时的缺省：八面体（2026-09-02 正式档）
DEFAULT_PROBE_MODE = 3
#: 进场景必读；缺任何一个整份载荷作废
LIGHTING_PAYLOAD_CORE = ("lighting.json", "probes_valid.bin", "ground_d.png")
#: 场景侧几何场（SceneLightingSystem）。⚠ skyvis.png 2026-09-07 起不在其中——
#: 它只是离线烘 albedo 的输入，运行时不读、发行包不带。
LIGHTING_GEOMETRY_FILES = ("geometry.json", "normal.png", "albedo.png")
#: 可选：老载荷没有；缺了**静默降级**——所以开发树里有就必须进包
LIGHTING_PAYLOAD_OPTIONAL = ("skyao_probe.bin",)
#: 只有 F2 调试面板切 RT 才读；发行档刻意不带
LIGHTING_PAYLOAD_DEBUG_ONLY = ("vol_rad.bin", "vol_emit.bin")

#: 载荷目录里的两个入口文件（规则文件只登记它们，其余由展开器带出）
_LIGHTING_ENTRY_RE = re.compile(
    r"^resources/runtime/scenes/[^/]+/lighting/[^/]+/(lighting|geometry)\.json$"
)


def probe_mode_of(shading_mode: object) -> int:
    """``shading.mode`` → 实际生效的 mode。与 TS ``probeModeOf`` 同一条规则：
    只认整数 1 / 2，其余（含缺省、3、字符串、布尔）一律回缺省八面体。"""
    if isinstance(shading_mode, bool):      # bool 是 int 的子类，True in (1, 2) 会误判
        return DEFAULT_PROBE_MODE
    if isinstance(shading_mode, int) and shading_mode in (1, 2):
        return shading_mode
    return DEFAULT_PROBE_MODE


def probe_atlas_file_for_mode(shading_mode: object) -> str:
    return PROBE_ATLAS_FILE_BY_MODE[probe_mode_of(shading_mode)]


@dataclass
class ManifestReport:
    """清单结果 + 够人复核的来源归因。"""

    project_root: Path
    #: 相对 ``public/`` 的 POSIX 路径，已排序去重
    files: list[str] = field(default_factory=list)
    #: path -> 它因为哪一条来源进的清单（复核用；一个文件只记第一个命中的来源）
    origin: dict[str, str] = field(default_factory=dict)
    #: 被 never_extract 规则挡下来的（本来会进清单的）
    excluded_by_rule: list[str] = field(default_factory=list)
    #: 引用了但磁盘上没有——素材审计的 issue，这里原样带出来，打包前必须清零
    audit_issue_count: int = 0
    #: 展开器发现的"运行时会读、磁盘上却没有"的硬伤（例如载荷 mode 要的图集没烘）。
    #: 与审计 issue 同等级：``--strict`` 下打包停下。
    problems: list[str] = field(default_factory=list)
    total_bytes: int = 0

    def add(self, rel: str, origin: str) -> None:
        if rel in self.origin:
            return
        self.origin[rel] = origin


def _load_rules(path: Path = RULES_PATH) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"抽取规则文件不存在：{path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _public_rel(project_root: Path, p: Path) -> str | None:
    """磁盘路径 → 相对 ``public/`` 的 POSIX 路径；不在 public 下返回 None。"""
    try:
        rel = p.resolve().relative_to((project_root / "public").resolve())
    except (OSError, ValueError):
        return None
    return rel.as_posix()


def _iter_public_files(project_root: Path, sub: str) -> list[Path]:
    root = project_root / "public" / sub
    if not root.is_dir():
        return []
    return [p for p in root.rglob("*") if p.is_file()]


def _matches_any(rel: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(rel, pat) for pat in patterns)


# --------------------------------------------------------------------------
# 传递闭包展开器
# --------------------------------------------------------------------------

def _note_problem(problems: list[str], msg: str) -> None:
    """同一份载荷会从 lighting.json / geometry.json 两个入口各展开一次——同一条只记一次。"""
    if msg not in problems:
        problems.append(msg)


def _expand_animation_package(project_root: Path, rel: str, problems: list[str]) -> list[str]:
    """``animation/<pkg>/anim.json`` → 同目录下它引用的精灵图。

    ``anim.json`` 的 ``spritesheet`` 是相对包目录的文件名（见
    ``public/resources/runtime/animation/*/anim.json``）。``atlas.meta.json``
    是烘包期产物，运行时不读，故不跟着抽取。
    """
    del problems  # 动画包读不出来由素材审计负责报，这里不重复
    if not rel.endswith("/anim.json"):
        return []
    disk = project_root / "public" / rel
    try:
        data = json.loads(disk.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, dict):
        return []
    out: list[str] = []
    pkg_dir = rel.rsplit("/", 1)[0]
    for key in ("spritesheet", "atlas", "texture", "image"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            name = val.strip().lstrip("/")
            cand = project_root / "public" / pkg_dir / name
            if cand.is_file():
                out.append(f"{pkg_dir}/{name}")
    return out


def _expand_derived_siblings(project_root: Path, rel: str, problems: list[str]) -> list[str]:
    """代码从**已知文件名派生**出来的旁挂文件——JSON 里永远搜不到它们。

    两条派生规则，各自对应 src 里的唯一实现源：

    * ``<img>.png`` → ``<img>.normal.png``
      —— ``spriteNormalAtlas.normalAtlasUrlFor()``。角色/热点的法线贴图，缺了退平面法线。
    * ``<dir>/anim.json`` → ``<dir>/sockets.json``
      —— ``animationSockets.socketsJsonUrlForAnim()``。挂点表，走 ``loadOptionalJson``
      探测，绝大多数动画包没有；**缺了是静默的**，所以更得靠清单带上。
    """
    del problems  # 派生旁挂文件缺席是常态（可选 sidecar），不是问题
    out: list[str] = []
    if rel.endswith(".png") and not rel.endswith(".normal.png"):
        cand = f"{rel[:-len('.png')]}.normal.png"
        if (project_root / "public" / cand).is_file():
            out.append(cand)
    if rel.endswith("/anim.json"):
        cand = f"{rel.rsplit('/', 1)[0]}/sockets.json"
        if (project_root / "public" / cand).is_file():
            out.append(cand)
    return out


def _expand_lighting_payload(project_root: Path, rel: str, problems: list[str]) -> list[str]:
    """``scenes/<id>/lighting/<背景基名>/{lighting,geometry}.json`` → 运行时进场景会读的同目录文件。

    唯一实现源：``src/core/CharacterLightingSystem.load``（角色侧）与
    ``src/core/SceneLightingSystem.load``（场景侧），文件名表见本模块顶部（镜像自
    ``src/core/lightingPayloadFiles.ts``）。

    * 核心三件 + 几何场三件 + 可选 skyao：磁盘上有就抽（缺席由运行时自己降级，不算问题）；
    * probe 图集：**只抽 ``shading.mode`` 指定的那一张**（进场景只拉这一张，另两张是 F2 切档
      才读，由 dev 档的规则另行带上）。mode 要的那张磁盘上没有 = 进场景必 404、整份载荷作废，
      记进 ``problems`` 让 ``--strict`` 停包——带着这种状态打出去的包一定是黑的。
    * ``skyvis_grid.bin`` / ``gi_hitmap.bin`` / ``vol_*.bin`` 不在这里：前两个运行时不读，
      后两个只有 F2 切 RT 才读（dev 档规则单独带）。
    """
    if not _LIGHTING_ENTRY_RE.match(rel):
        return []
    pay_dir = rel.rsplit("/", 1)[0]
    disk_dir = project_root / "public" / pay_dir
    out: list[str] = []
    for name in (*LIGHTING_PAYLOAD_CORE, *LIGHTING_GEOMETRY_FILES, *LIGHTING_PAYLOAD_OPTIONAL):
        if (disk_dir / name).is_file():
            out.append(f"{pay_dir}/{name}")
    meta_path = disk_dir / "lighting.json"
    if not meta_path.is_file():
        return out
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        _note_problem(problems, f"{pay_dir}/lighting.json 读不出来（{e}）—— 运行时会把这份载荷整个忽略")
        return out
    shading = meta.get("shading") if isinstance(meta, dict) else None
    mode = shading.get("mode") if isinstance(shading, dict) else None
    atlas = probe_atlas_file_for_mode(mode)
    if (disk_dir / atlas).is_file():
        out.append(f"{pay_dir}/{atlas}")
    else:
        _note_problem(
            problems,
            f"{pay_dir}/lighting.json 的 shading.mode={mode!r} 要读 {atlas}，磁盘上没有"
            " —— 进场景必 404、角色照明整份作废；重烘该场景或改 mode",
        )
    return out


_EXPANDERS = (_expand_animation_package, _expand_derived_siblings, _expand_lighting_payload)


_BUNDLE_ID_RE = re.compile(r'"bundleId"\s*:\s*"([^"]+)"')


def _collect_id_conventions(project_root: Path) -> dict[str, str]:
    """数据里写的是**标识符**、路径由代码按约定拼出来的那些资源。

    素材审计只认"值本身就是路径"的字段，这类 id→路径的约定它一概抓不到，而漏掉就是
    运行时 404。目前只有一条：

    * ``bundleId`` → ``animation/<bundleId>/anim.json``
      —— ``ActionRegistry.ts:1363`` 的 ``setPlayerAvatar`` 只给 bundleId 时按此拼。

    拼出来的 ``anim.json`` 再经传递闭包带出 ``atlas.png`` / ``atlas.normal.png`` /
    ``sockets.json``，所以这里只需登记入口文件。
    """
    out: dict[str, str] = {}
    assets = project_root / "public" / "assets"
    if not assets.is_dir():
        return out
    for jp in assets.rglob("*.json"):
        try:
            txt = jp.read_text(encoding="utf-8")
        except OSError:
            continue
        for m in _BUNDLE_ID_RE.finditer(txt):
            rel = f"resources/runtime/animation/{m.group(1)}/anim.json"
            if (project_root / "public" / rel).is_file():
                out.setdefault(rel, "id 约定（bundleId）")
    return out


#: 短 id → 资源的**注册表**：(相对 public 的 JSON, 来源说明, 从 JSON 里取出全部资源引用的函数)。
#: 注册表本身是作者写的内容——登记了就可能被任何一条 `showOverlayImage` / 道具引用到；
#: 素材审计只在**某处真引用了那个短 id**时才解析它，登记但暂未引用的条目原本进不了清单，
#: 于是 dev 服能显示（整个 public/ 都在）、包里静默不出图。注册表登记 = 引用。
_REGISTRY_FILES: tuple[tuple[str, str, object], ...] = (
    (
        "assets/data/overlay_images.json",
        "注册表 overlay_images（短 id → 图，Game.ts resolveOverlayImage）",
        lambda data: list(data.values()) if isinstance(data, dict) else [],
    ),
    (
        "assets/data/prop_presets.json",
        "注册表 prop_presets（image 字段，src/data/propPresets.ts）",
        lambda data: [v.get("image") for v in data.values() if isinstance(v, dict)] if isinstance(data, dict) else [],
    ),
)


def _collect_registry_targets(project_root: Path) -> dict[str, str]:
    """注册表里登记的每一个资源路径（磁盘上存在的）。返回 path -> 来源说明。"""
    out: dict[str, str] = {}
    for rel_json, why, pick in _REGISTRY_FILES:
        jp = project_root / "public" / rel_json
        if not jp.is_file():
            continue
        try:
            data = json.loads(jp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue   # 注册表本身坏了由素材审计 / validate-data 报
        for val in pick(data):  # type: ignore[operator]
            if not isinstance(val, str):
                continue
            rel = val.strip().replace("\\", "/").lstrip("/")
            if not rel.startswith("resources/runtime/"):
                continue
            if (project_root / "public" / rel).is_file():
                out.setdefault(rel, why)
    return out


def _expand_transitively(project_root: Path, seeds: list[str], problems: list[str]) -> dict[str, str]:
    """对种子集反复跑展开器直到不动点。返回 新增path -> 来源说明。"""
    found: dict[str, str] = {}
    frontier = list(seeds)
    seen = set(seeds)
    while frontier:
        nxt: list[str] = []
        for rel in frontier:
            for exp in _EXPANDERS:
                for child in exp(project_root, rel, problems):
                    if child in seen:
                        continue
                    seen.add(child)
                    found[child] = f"传递闭包 ← {rel}"
                    nxt.append(child)
        frontier = nxt
    return found


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def build_manifest(
    project_root: Path,
    rules: dict | None = None,
    *,
    target: str = "release",
) -> ManifestReport:
    """按目标档位生成清单。

    ``target`` 决定在公共规则之上叠加哪一组：``dev`` 保留调试专用载荷（F2 光影切档的
    体积档 ``vol_*.bin`` 等，每场景 20–27 MB），``release`` 把它们排除。两档的
    **游戏内容完全一致**，差的只是调试设施。
    """
    project_root = project_root.resolve()
    rules = rules if rules is not None else _load_rules()
    paths = ProjectPaths(project_root)
    report = ManifestReport(project_root=project_root)

    targets = rules.get("targets", {})
    if target not in targets:
        raise ValueError(f"未知 target {target!r}；可用：{sorted(targets)}")
    tgt = targets[target]

    always: list[str] = list(rules.get("always_extract", [])) + list(tgt.get("always_extract", []))
    never: list[str] = list(rules.get("never_extract", [])) + list(tgt.get("never_extract", []))

    # 1. 文本配置全量
    for p in _iter_public_files(project_root, "assets"):
        rel = _public_rel(project_root, p)
        if rel:
            report.add(rel, "文本配置全量（public/assets）")

    # 2. JSON 引用闭包（与素材审计同一套语义）
    audit = audit_project_assets(project_root)
    report.audit_issue_count = len(audit.issues)
    for disk in sorted(audit.resolved_media) + sorted(audit.resolved_text):
        rel = _public_rel(project_root, disk)
        if rel:
            report.add(rel, "JSON 引用")

    # 2b. id→路径约定（数据里写的是标识符，路径由代码拼）
    for rel, why in sorted(_collect_id_conventions(project_root).items()):
        report.add(rel, why)

    # 2c. 注册表闭包（登记 = 引用；见 _REGISTRY_FILES）
    for rel, why in sorted(_collect_registry_targets(project_root).items()):
        report.add(rel, why)

    # 3. 传递闭包
    for rel, why in sorted(_expand_transitively(project_root, list(report.origin), report.problems).items()):
        report.add(rel, why)

    # 4. 规则显式包含
    all_public = [
        p for p in (project_root / "public").rglob("*") if p.is_file()
    ] if (project_root / "public").is_dir() else []
    for p in all_public:
        rel = _public_rel(project_root, p)
        if rel and rel not in report.origin and _matches_any(rel, always):
            report.add(rel, "规则 always_extract")

    # 传递闭包要再跑一轮：规则引入的入口（anim.json / lighting.json）还要往下展开
    for rel, why in sorted(_expand_transitively(project_root, list(report.origin), report.problems).items()):
        report.add(rel, why)

    # 5. 兜底排除
    picked = sorted(report.origin)
    kept: list[str] = []
    for rel in picked:
        if _matches_any(rel, never):
            report.excluded_by_rule.append(rel)
            del report.origin[rel]
        else:
            kept.append(rel)

    report.files = kept
    report.total_bytes = 0
    for rel in kept:
        p = project_root / "public" / rel
        try:
            report.total_bytes += p.stat().st_size
        except OSError:
            pass
    # paths 只用于类型/根解析校验，保持引用避免 lint 误报未使用
    assert paths.runtime_root.name == "runtime"
    return report


def unpicked_summary(project_root: Path, report: ManifestReport) -> list[tuple[str, int, int]]:
    """没进清单的文件，按前两级目录归组：(组名, 文件数, 字节数)，按体积降序。

    **纯报告。** 给人看"包体省在哪、有没有省错"，不驱动任何删除动作。
    """
    picked = set(report.files)
    groups: dict[str, list[int]] = {}
    pub = project_root / "public"
    if not pub.is_dir():
        return []
    for p in pub.rglob("*"):
        if not p.is_file():
            continue
        rel = _public_rel(project_root, p)
        if rel is None or rel in picked:
            continue
        parts = rel.split("/")
        key = "/".join(parts[:3]) if len(parts) > 3 else "/".join(parts[:-1]) or "(根)"
        slot = groups.setdefault(key, [0, 0])
        slot[0] += 1
        try:
            slot[1] += p.stat().st_size
        except OSError:
            pass
    rows = [(k, v[0], v[1]) for k, v in groups.items()]
    rows.sort(key=lambda r: r[2], reverse=True)
    return rows


def format_report(report: ManifestReport, *, unpicked: list[tuple[str, int, int]] | None = None) -> str:
    mb = report.total_bytes / 1024 / 1024
    by_origin: dict[str, int] = {}
    for origin in report.origin.values():
        key = origin.split(" ← ")[0]
        by_origin[key] = by_origin.get(key, 0) + 1
    lines = [
        f"[asset_manifest] root={report.project_root}",
        f"  抽取文件数: {len(report.files)}",
        f"  抽取体积:   {mb:.1f} MB",
        f"  素材审计 issue: {report.audit_issue_count}（>0 表示有引用指向不存在的文件，打包前必须清零）",
        "  来源分布:",
    ]
    for k, v in sorted(by_origin.items(), key=lambda kv: -kv[1]):
        lines.append(f"    {k}: {v}")
    if report.problems:
        lines.append(f"  ✖ 展开器发现 {len(report.problems)} 处硬伤（运行时会读、磁盘上没有）:")
        for msg in report.problems[:20]:
            lines.append(f"    - {msg}")
        if len(report.problems) > 20:
            lines.append(f"    ... 另 {len(report.problems) - 20} 条")
    if report.excluded_by_rule:
        lines.append(f"  被 never_extract 挡下: {len(report.excluded_by_rule)}")
        for rel in report.excluded_by_rule[:10]:
            lines.append(f"    - {rel}")
        if len(report.excluded_by_rule) > 10:
            lines.append(f"    ... 另 {len(report.excluded_by_rule) - 10} 条")
    if unpicked is not None:
        lines.append("  未抽取（留在开发树，不受影响）按目录:")
        for key, cnt, size in unpicked[:25]:
            lines.append(f"    {size / 1024 / 1024:9.1f} MB  {cnt:5d} 文件  {key}")
        if len(unpicked) > 25:
            lines.append(f"    ... 另 {len(unpicked) - 25} 组")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project_root", nargs="?", default=".")
    ap.add_argument("--out", help="把清单 JSON 写到这里（不传则只打印报告）")
    ap.add_argument("--target", default="release", choices=("dev", "release"),
                    help="档位：dev 保留调试载荷，release 只带玩家要用的")
    ap.add_argument("--report-unpicked", action="store_true", help="列出没进包的目录与体积")
    ap.add_argument(
        "--strict", action="store_true",
        help="素材审计有 issue、或展开器发现运行时要读的文件不在磁盘上时以非 0 退出（打包管线里应当开）",
    )
    args = ap.parse_args(argv)

    root = Path(args.project_root).resolve()
    report = build_manifest(root, target=args.target)
    unpicked = unpicked_summary(root, report) if args.report_unpicked else None
    print(format_report(report, unpicked=unpicked))

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "target": args.target,
            "totalBytes": report.total_bytes,
            "files": report.files,
            "origin": report.origin,
            "excludedByRule": report.excluded_by_rule,
            "auditIssueCount": report.audit_issue_count,
            "problems": report.problems,
        }
        # newline="\n"：Windows 上默认会把 \n 翻成 \r\n，产物 JSON 保持 LF
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
        print(f"  → 清单已写入 {out}")

    if args.strict and (report.audit_issue_count or report.problems):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
