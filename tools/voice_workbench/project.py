"""工作台工程:切片清单 + 处理参数。纯数据 + 存取,不碰音频。

工程文件是**编辑器专用 sidecar**(运行时永不加载),存 ``tools/voice_workbench/projects/``。
它只描述"从哪条源的哪一段、切出叫什么名字的产物、用什么参数",
不复制音频、不缓存结果——重开工程重新渲染,结果必然一致。

导出产物是**唯一进游戏的东西**;工程与源库都不进游戏。这条边界写在这里,
是因为下一个人最容易犯的错是"图省事直接引用源库里的文件"。
"""
from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

from tools.atomic_io import retry_transient

from .dsp import (
    DEFAULT_MIN_SILENCE_S,
    DEFAULT_SPLIT_THRESHOLD_DB,
    DEFAULT_TARGET_LUFS,
    DEFAULT_TRUE_PEAK_CEILING_DB,
)

PROJECT_VERSION = 1

#: 产物文件名的合法字符:中文照收(项目里全是中文 id),但挡掉路径分隔符与保留字符
_BAD_NAME_CHARS = re.compile(r'[\\/:*?"<>|\r\n\t]')


def sanitize_name(name: str) -> str:
    """把用户输入清成能当文件名的样子(去路径分隔符、去首尾空白与点)。"""
    s = _BAD_NAME_CHARS.sub("_", str(name or "")).strip().strip(".")
    return s or "未命名"


def sanitize_tag(tag: str) -> str:
    """标签:去空白与逗号(逗号是界面上的分隔符),空标签一律丢掉。"""
    return str(tag or "").replace(",", " ").replace("，", " ").strip()


def clean_tags(tags) -> list[str]:
    """清洗一组标签:去空、去重、**保序**(顺序是人排的,按字母排会打乱他的分组直觉)。"""
    out: list[str] = []
    for t in tags or []:
        s = sanitize_tag(t)
        if s and s not in out:
            out.append(s)
    return out


@dataclass
class Slice:
    """一条产物:源的 [start, end) 段 + 这一条自己的处理参数。"""

    source: str
    start: float
    end: float
    name: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    enabled: bool = True
    #: 逐条可关:某句气声重、降噪会啃掉,就单独关掉它
    denoise: bool = True
    #: 归一化之前的手动增益。正常留 0——要靠它才对得齐,说明该重录那条
    gain_db: float = 0.0
    #: 淡入淡出**默认 0:工具绝不主动动用户的音频边界**。
    #: 用户已经手工剪好的片段,任何"顺手加一点淡出"都是没被要求的改动;
    #: 需要的人自己填(自动切分出来的新切片才会预填一点,那种切口是机器切的)。
    fade_in_s: float = 0.0
    fade_out_s: float = 0.0
    note: str = ""
    #: 分类标签(自由词表,顺序即人排的顺序)。**不进渲染指纹**——
    #: 打个标签不该让产物变"已过时"
    tags: list[str] = field(default_factory=list)

    @property
    def seconds(self) -> float:
        return max(0.0, self.end - self.start)

    def has_tag(self, tag: str) -> bool:
        return sanitize_tag(tag) in self.tags

    def to_json(self) -> dict:
        d = asdict(self)
        if not self.tags:
            # 空标签不写出去:老工程不带这个键,写进去会让"什么都没干"的工程凭空变脏
            d.pop("tags", None)
        return d

    @staticmethod
    def from_json(d: dict) -> "Slice":
        return Slice(
            source=str(d.get("source", "")),
            start=float(d.get("start") or 0.0),
            end=float(d.get("end") or 0.0),
            name=sanitize_name(d.get("name") or ""),
            id=str(d.get("id") or uuid.uuid4().hex[:12]),
            enabled=d.get("enabled", True) is not False,
            denoise=d.get("denoise", True) is not False,
            gain_db=float(d.get("gain_db") or 0.0),
            fade_in_s=float(d.get("fade_in_s") or 0.0),
            fade_out_s=float(d.get("fade_out_s") or 0.0),
            note=str(d.get("note") or ""),
            tags=clean_tags(d.get("tags")),
        )


@dataclass
class Settings:
    """整批共享的参数。逐条参数在 Slice 上,这里放"这一批统一怎么处理"。"""

    target_lufs: float = DEFAULT_TARGET_LUFS
    true_peak_ceiling_db: float = DEFAULT_TRUE_PEAK_CEILING_DB
    #: 峰值限幅。**默认关**(不动表演);素材动态太大、纯增益推不到"听得见"时才显式开。
    limiter: bool = False
    denoise_reduction_db: float = 12.0
    export_bits: int = 16
    #: 允许转单声道。**只在两声道确实是同一份内容时才真的转**(见 dsp.is_dual_mono):
    #: 手机双麦录的立体声是两路不同信号,求平均会梳状滤波,那种一律保持立体声。
    export_mono: bool = True
    #: 导出目录(相对仓库根)。产物是唯一进游戏的东西,所以默认落在 public 下
    export_dir: str = "public/resources/runtime/audio/voice"
    #: 纯底噪样本:哪条源的哪一段。给了降噪效果好得多
    noise_source: str = ""
    noise_start: float = 0.0
    noise_end: float = 0.0
    #: 自动切分的参数(界面上可调,存进工程好复现)
    split_threshold_db: float = DEFAULT_SPLIT_THRESHOLD_DB
    split_min_silence_s: float = DEFAULT_MIN_SILENCE_S

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> "Settings":
        base = Settings()
        if not isinstance(d, dict):
            return base
        out = {}
        for k, v in asdict(base).items():
            got = d.get(k, v)
            if isinstance(v, bool):
                out[k] = got is not False
            elif isinstance(v, float):
                try:
                    out[k] = float(got)
                except (TypeError, ValueError):
                    out[k] = v
            elif isinstance(v, int):
                try:
                    out[k] = int(got)
                except (TypeError, ValueError):
                    out[k] = v
            else:
                out[k] = str(got or "")
        return Settings(**out)

    @property
    def has_noise_sample(self) -> bool:
        return bool(self.noise_source) and self.noise_end > self.noise_start


@dataclass
class Project:
    name: str = "未命名"
    settings: Settings = field(default_factory=Settings)
    slices: list[Slice] = field(default_factory=list)

    # ------------------------------------------------------------ 切片操作

    def add_slice(self, s: Slice) -> Slice:
        self.slices.append(s)
        return s

    def remove(self, slice_id: str) -> bool:
        n = len(self.slices)
        self.slices = [s for s in self.slices if s.id != slice_id]
        return len(self.slices) != n

    def get(self, slice_id: str) -> Slice | None:
        return next((s for s in self.slices if s.id == slice_id), None)

    def update(self, slice_id: str, **changes) -> Slice | None:
        for i, s in enumerate(self.slices):
            if s.id == slice_id:
                self.slices[i] = replace(s, **changes)
                return self.slices[i]
        return None

    def slices_of(self, source_rel: str) -> list[Slice]:
        return [s for s in self.slices if s.source == source_rel]

    def sources_used(self) -> list[str]:
        """工程里用到的源(保序去重)——筛选栏的"源"那一栏就是它。"""
        out: list[str] = []
        for s in self.slices:
            if s.source and s.source not in out:
                out.append(s.source)
        return out

    def all_tags(self) -> list[str]:
        """工程里出现过的全部标签(保序去重)。标签是自由词表,没有单独的注册表——
        用没了的标签自己就消失了,不需要谁去清理。"""
        out: list[str] = []
        for s in self.slices:
            for t in s.tags:
                if t not in out:
                    out.append(t)
        return out

    def duplicate_names(self) -> list[str]:
        """重名产物:两条切片写同一个文件名 = 后导出的把先导出的盖掉,必须在导出前拦。"""
        seen: dict[str, int] = {}
        for s in self.slices:
            if s.enabled:
                seen[s.name] = seen.get(s.name, 0) + 1
        return sorted(n for n, c in seen.items() if c > 1)

    def problems(self) -> list[str]:
        """导出前的自检(人话)。返回空 = 可以导。"""
        out: list[str] = []
        for n in self.duplicate_names():
            out.append(f"产物重名：{n}（有两条以上切片要写同一个文件）")
        for s in self.slices:
            if not s.enabled:
                continue
            if s.seconds <= 0:
                out.append(f"{s.name}：起止点无效（{s.start:.2f}s → {s.end:.2f}s）")
            if not s.source:
                out.append(f"{s.name}：没有指定源文件")
        return out

    # ------------------------------------------------------------ 存取

    def to_json(self) -> dict:
        return {
            "version": PROJECT_VERSION,
            "name": self.name,
            "settings": self.settings.to_json(),
            "slices": [s.to_json() for s in self.slices],
        }

    @staticmethod
    def from_json(d: dict) -> "Project":
        if not isinstance(d, dict):
            return Project()
        return Project(
            name=str(d.get("name") or "未命名"),
            settings=Settings.from_json(d.get("settings") or {}),
            slices=[Slice.from_json(x) for x in (d.get("slices") or []) if isinstance(x, dict)],
        )

    def save(self, path: Path) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(
            json.dumps(self.to_json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        retry_transient(os.replace, tmp, p)
        return p

    @staticmethod
    def load(path: Path) -> "Project":
        p = Path(path)
        try:
            return Project.from_json(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as ex:
            raise ValueError(f"工程读不了：{p.name}（{ex}）") from ex


def projects_dir(tool_root: Path) -> Path:
    return Path(tool_root) / "projects"
