"""GameDraft 工程统一路径解析入口。

迁移后约定（权威布局）：

- ``public/assets``：仅文本/配置类资源（``data``、``scenes`` 的 JSON、``dialogues``、
  ``data/filters`` 等）。**不再承载任何媒体**。
- ``public/resources/runtime``：所有运行时媒体（图片、音频、场景背景/深度图、
  动画包、小玩法贴图等）。
- ``resources/editor_projects``：所有编辑器/工具工程、缓存、布局、素材收件箱等
  DVC 托管的工程数据。

所有路径解析、文件选择器默认目录、URL ↔ 磁盘互转都应当通过 :class:`ProjectPaths`
提供的语义化接口获取，避免硬编码 ``public/...`` 在各工具中漂移。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable
from urllib.parse import unquote


# 三大根目录在仓库内的固定后缀（相对 project_root）
_REL_ASSETS = ("public", "assets")
_REL_RUNTIME = ("public", "resources", "runtime")
_REL_EDITOR_PROJECTS = ("resources", "editor_projects")
_REL_EDITOR_DATA = ("resources", "editor_projects", "editor_data")

# URL 前缀（带不带前导斜杠都允许）
_URL_PREFIX_RUNTIME = ("/resources/runtime/", "resources/runtime/")
_URL_PREFIX_ASSETS = ("/assets/", "assets/")
_URL_PREFIX_EDITOR_PROJECTS = (
    "/resources/editor_projects/", "resources/editor_projects/",
)


# ---------------------------------------------------------------------------
# default_dir kind 枚举
# ---------------------------------------------------------------------------
# 为方便其它模块引用，统一定义为常量字符串集合。新增类别只要在 ProjectPaths
# 中实现解析即可，无需散落在各工具里再写一遍。
DIR_KIND_RUNTIME_ROOT = "runtime_root"
DIR_KIND_RUNTIME_IMAGES = "runtime_images"
DIR_KIND_RUNTIME_IMAGES_ILLUSTRATIONS = "runtime_images_illustrations"
DIR_KIND_RUNTIME_IMAGES_BACKGROUNDS = "runtime_images_backgrounds"
DIR_KIND_RUNTIME_IMAGES_MINIGAMES = "runtime_images_minigames"
DIR_KIND_RUNTIME_IMAGES_NPCS = "runtime_images_npcs"
DIR_KIND_RUNTIME_IMAGES_CHARACTERS = "runtime_images_characters"
DIR_KIND_RUNTIME_AUDIO = "runtime_audio"
DIR_KIND_RUNTIME_ANIMATION = "runtime_animation"
DIR_KIND_RUNTIME_SCENES = "runtime_scenes"
DIR_KIND_SCENE_RUNTIME = "scene_runtime"
DIR_KIND_SCENE_JSON_DIR = "scene_json_dir"
DIR_KIND_DATA = "data"
DIR_KIND_DIALOGUES = "dialogues"
DIR_KIND_FILTERS = "filters"
DIR_KIND_EDITOR_PROJECTS = "editor_projects"
DIR_KIND_EDITOR_DATA = "editor_data"
DIR_KIND_EDITOR_ANIMATION_PROJECT = "editor_animation_project"
DIR_KIND_EDITOR_ASSET_INBOX = "editor_asset_inbox"
DIR_KIND_EDITOR_ANIMVIDEO = "editor_animvideo"
DIR_KIND_EDITOR_SCENE_WORKSPACE = "editor_scene_workspace"
DIR_KIND_EDITOR_ASSET_BROWSER_CACHE = "editor_asset_browser_cache"
DIR_KIND_EDITOR_MISC_MEDIA = "editor_misc_media"

# 媒体子目录在 default_dir 中的相对位置（与 asset_ingest 分类一致）
_MEDIA_SUBDIRS = {
    DIR_KIND_RUNTIME_IMAGES: ("images",),
    DIR_KIND_RUNTIME_IMAGES_ILLUSTRATIONS: ("images", "illustrations"),
    DIR_KIND_RUNTIME_IMAGES_BACKGROUNDS: ("images", "backgrounds"),
    DIR_KIND_RUNTIME_IMAGES_MINIGAMES: ("images", "minigames"),
    DIR_KIND_RUNTIME_IMAGES_NPCS: ("images", "npcs"),
    DIR_KIND_RUNTIME_IMAGES_CHARACTERS: ("images", "characters"),
    DIR_KIND_RUNTIME_AUDIO: ("audio",),
    DIR_KIND_RUNTIME_ANIMATION: ("animation",),
    DIR_KIND_RUNTIME_SCENES: ("scenes",),
}

_EDITOR_SUBDIRS = {
    DIR_KIND_EDITOR_ANIMATION_PROJECT: ("animation",),
    DIR_KIND_EDITOR_ASSET_INBOX: ("asset_inbox",),
    DIR_KIND_EDITOR_ANIMVIDEO: ("animvideo",),
    DIR_KIND_EDITOR_SCENE_WORKSPACE: ("scene",),
    DIR_KIND_EDITOR_ASSET_BROWSER_CACHE: ("asset_browser_cache",),
}

# URL kind 取值：'media' 必须落到 runtime；'text' 必须落到 assets；'any' 两者皆可
URL_KIND_MEDIA = "media"
URL_KIND_TEXT = "text"
URL_KIND_ANY = "any"
_URL_KINDS = frozenset({URL_KIND_MEDIA, URL_KIND_TEXT, URL_KIND_ANY})


def _normalize_rel(rel: str) -> str | None:
    """返回去掉前后斜杠、URL 解码、并禁止 ``..`` 的相对路径；非法返回 ``None``。"""
    s = unquote(rel).strip().replace("\\", "/")
    if not s:
        return None
    s = s.lstrip("/")
    if not s:
        return None
    parts = [p for p in s.split("/") if p]
    if any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def _starts_with_any(s: str, prefixes: Iterable[str]) -> str | None:
    for pre in prefixes:
        if s.startswith(pre):
            return s[len(pre):]
    return None


@dataclass(frozen=True)
class ProjectPaths:
    """工程根目录下统一的路径策略。

    实例化只需要 ``project_root``（含 ``public/`` 与 ``resources/`` 子树的仓库根）。
    所有派生路径均按迁移后的权威布局返回。

    解析约定：

    * ``url_to_disk(url, kind='media')`` 仅接受落到 ``runtime_root`` 下的 URL/短名；
      明确 ``/assets/...`` 的媒体引用会被拒绝（返回 ``None``）。
    * ``url_to_disk(url, kind='text')`` 仅接受 ``/assets/...`` 等文本配置引用。
    * ``url_to_disk(url, kind='any')`` 同时接受两类（用于过渡或混合字段）。

    路径内不允许 ``..`` 跨层。
    """

    project_root: Path

    # ------------------------------------------------------------------ roots
    @property
    def assets_root(self) -> Path:
        return self.project_root.joinpath(*_REL_ASSETS)

    @property
    def runtime_root(self) -> Path:
        return self.project_root.joinpath(*_REL_RUNTIME)

    @property
    def editor_projects_root(self) -> Path:
        return self.project_root.joinpath(*_REL_EDITOR_PROJECTS)

    @property
    def editor_data_root(self) -> Path:
        return self.project_root.joinpath(*_REL_EDITOR_DATA)

    # --------------------------------------------------- text/config layout
    @property
    def data_dir(self) -> Path:
        return self.assets_root / "data"

    @property
    def scenes_dir(self) -> Path:
        return self.assets_root / "scenes"

    @property
    def dialogues_dir(self) -> Path:
        return self.assets_root / "dialogues"

    @property
    def filters_dir(self) -> Path:
        return self.data_dir / "filters"

    # ---------------------------------------------------- runtime media tree
    @property
    def runtime_images_dir(self) -> Path:
        return self.runtime_root / "images"

    @property
    def runtime_audio_dir(self) -> Path:
        return self.runtime_root / "audio"

    @property
    def runtime_animation_dir(self) -> Path:
        return self.runtime_root / "animation"

    @property
    def runtime_scenes_dir(self) -> Path:
        return self.runtime_root / "scenes"

    # -------------------------------------------------------------- scenes
    def scene_json_path(self, scene_id: str) -> Path:
        sid = (scene_id or "").strip()
        if not sid or "/" in sid or "\\" in sid:
            raise ValueError(f"非法 scene_id: {scene_id!r}")
        return self.scenes_dir / f"{sid}.json"

    def scene_runtime_dir(self, scene_id: str) -> Path:
        sid = (scene_id or "").strip()
        if not sid or "/" in sid or "\\" in sid:
            raise ValueError(f"非法 scene_id: {scene_id!r}")
        return self.runtime_scenes_dir / sid

    def scene_runtime_asset(self, scene_id: str, ref: str) -> Path:
        """场景 JSON 内的相对资源（``backgrounds[].image``、深度图等）落到 runtime 下。

        ``ref`` 可以是单文件名也可以是相对子路径；以 ``/`` 开头的完整 URL 走
        :meth:`url_to_disk` 解析。
        """
        r = (ref or "").strip()
        if not r:
            raise ValueError("scene_runtime_asset 需要 ref")
        if r.startswith("/") or r.startswith("resources/") or r.startswith("assets/"):
            disk = self.url_to_disk(r, kind=URL_KIND_MEDIA)
            if disk is None:
                raise ValueError(f"scene_runtime_asset: 媒体 URL 无法解析 {r!r}")
            return disk
        rel = _normalize_rel(r)
        if rel is None:
            raise ValueError(f"非法 scene 资源相对路径: {ref!r}")
        return self.scene_runtime_dir(scene_id) / rel

    # --------------------------------------------------------- url -> disk
    def url_to_disk(self, url: str, kind: str = URL_KIND_MEDIA) -> Path | None:
        """把 URL/短名解析为本机绝对路径；不存在/越权返回 ``None``。

        ``kind``：

        * ``'media'``：仅接受落到 ``runtime_root`` 下；明确指向 ``assets/`` 的 URL 拒绝。
          无前缀短路径（例如 ``images/backgrounds/x.png`` 或 ``audio/y.wav``）按
          媒体根解析，与 ``[img:...]`` 历史短名一致。
        * ``'text'``：仅接受落到 ``assets_root`` 下；指向 runtime 媒体的 URL 拒绝。
        * ``'any'``：媒体与文本规则都允许；本机绝对路径直接返回。
        """
        if kind not in _URL_KINDS:
            raise ValueError(f"未知 url kind: {kind!r}")
        if not url:
            return None
        s = url.strip().replace("\\", "/")
        if not s:
            return None

        # 本机绝对路径
        try:
            cand = Path(s)
        except (OSError, ValueError):
            cand = None
        if cand is not None and cand.is_absolute():
            return cand

        # http(s) 不解析为本地资源
        low = s.lower()
        if low.startswith("http://") or low.startswith("https://"):
            return None

        # editor_projects 段
        rel_ep = _starts_with_any(s, _URL_PREFIX_EDITOR_PROJECTS)
        if rel_ep is not None:
            if kind not in (URL_KIND_ANY, URL_KIND_TEXT):
                # editor_projects 视为文本/工程数据，不可作为媒体引用
                return None
            rel = _normalize_rel(rel_ep)
            if rel is None:
                return None
            return self.editor_projects_root.joinpath(*rel.split("/"))

        rel_runtime = _starts_with_any(s, _URL_PREFIX_RUNTIME)
        rel_assets = _starts_with_any(s, _URL_PREFIX_ASSETS)

        if rel_runtime is not None:
            if kind == URL_KIND_TEXT:
                return None
            rel = _normalize_rel(rel_runtime)
            if rel is None:
                return None
            return self.runtime_root.joinpath(*rel.split("/"))

        if rel_assets is not None:
            if kind == URL_KIND_MEDIA:
                return None
            rel = _normalize_rel(rel_assets)
            if rel is None:
                return None
            return self.assets_root.joinpath(*rel.split("/"))

        # 无前缀短名：媒体按 runtime_root 拼，文本按 assets_root 拼
        rel = _normalize_rel(s)
        if rel is None:
            return None
        if kind == URL_KIND_TEXT:
            return self.assets_root.joinpath(*rel.split("/"))
        if kind == URL_KIND_MEDIA:
            return self.runtime_root.joinpath(*rel.split("/"))
        # any：默认按媒体处理
        return self.runtime_root.joinpath(*rel.split("/"))

    # --------------------------------------------------------- disk -> url
    def disk_to_runtime_url(self, path: Path) -> str | None:
        """工程内 runtime 文件 → ``/resources/runtime/...``，不在则 ``None``。"""
        try:
            rp = path.resolve()
            base = self.runtime_root.resolve()
        except OSError:
            return None
        try:
            rel = rp.relative_to(base)
        except ValueError:
            return None
        return "/resources/runtime/" + PurePosixPath(*rel.parts).as_posix()

    def disk_to_assets_url(self, path: Path) -> str | None:
        """工程内 assets 文本配置文件 → ``/assets/...``，不在则 ``None``。"""
        try:
            rp = path.resolve()
            base = self.assets_root.resolve()
        except OSError:
            return None
        try:
            rel = rp.relative_to(base)
        except ValueError:
            return None
        return "/assets/" + PurePosixPath(*rel.parts).as_posix()

    def disk_to_public_url(self, path: Path) -> str | None:
        """优先 runtime URL，再尝试 assets URL；都不在则 ``None``。"""
        u = self.disk_to_runtime_url(path)
        if u is not None:
            return u
        return self.disk_to_assets_url(path)

    # ------------------------------------------------------ default dirs
    def default_dir(self, kind: str, scene_id: str | None = None) -> Path:
        """统一文件选择器/打开文件夹的起始目录。

        新增类别请优先在此扩展，并在 ``DIR_KIND_*`` 常量里登记，避免散落在各工具里。
        """
        if kind == DIR_KIND_RUNTIME_ROOT:
            return self.runtime_root
        if kind in _MEDIA_SUBDIRS:
            return self.runtime_root.joinpath(*_MEDIA_SUBDIRS[kind])
        if kind == DIR_KIND_SCENE_RUNTIME:
            if not scene_id:
                # 无 scene_id 时回退到 runtime/scenes 根
                return self.runtime_scenes_dir
            return self.scene_runtime_dir(scene_id)
        if kind == DIR_KIND_SCENE_JSON_DIR:
            return self.scenes_dir
        if kind == DIR_KIND_DATA:
            return self.data_dir
        if kind == DIR_KIND_DIALOGUES:
            return self.dialogues_dir
        if kind == DIR_KIND_FILTERS:
            return self.filters_dir
        if kind == DIR_KIND_EDITOR_PROJECTS:
            return self.editor_projects_root
        if kind == DIR_KIND_EDITOR_DATA:
            return self.editor_data_root
        if kind in _EDITOR_SUBDIRS:
            return self.editor_data_root.joinpath(*_EDITOR_SUBDIRS[kind])
        if kind == DIR_KIND_EDITOR_MISC_MEDIA:
            return self.editor_projects_root / "misc_media"
        raise ValueError(f"未知 default_dir kind: {kind!r}")

    def default_dir_existing_or_root(
        self, kind: str, scene_id: str | None = None,
    ) -> Path:
        """``default_dir`` 的便利封装：目标目录存在返回它，否则向上回退到 project_root。"""
        d = self.default_dir(kind, scene_id=scene_id)
        if d.is_dir():
            return d
        cur = d.parent
        root_resolved = self.project_root.resolve()
        while True:
            if cur.is_dir():
                return cur
            try:
                if cur.resolve() == root_resolved or cur == cur.parent:
                    break
            except OSError:
                break
            cur = cur.parent
        return self.project_root

    # ------------------------------------------------------------- helpers
    def is_under_runtime(self, path: Path) -> bool:
        try:
            path.resolve().relative_to(self.runtime_root.resolve())
            return True
        except (OSError, ValueError):
            return False

    def is_under_assets(self, path: Path) -> bool:
        try:
            path.resolve().relative_to(self.assets_root.resolve())
            return True
        except (OSError, ValueError):
            return False

    def is_under_editor_projects(self, path: Path) -> bool:
        try:
            path.resolve().relative_to(self.editor_projects_root.resolve())
            return True
        except (OSError, ValueError):
            return False
