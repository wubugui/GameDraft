"""三条视图轴的判定 —— **新老画布共用这一份**，零 Qt。

语义与硬契约见 `agent_docs/editor-tools/mechanisms/scene-view-filter-axes.md`，
这里只放实现。抽出来的理由就是那张卡反复强调的那条：

> 后置显隐轴**必须合成一个判定**再落显隐。每条轴各自遍历、各自写显隐 =
> 后跑的把先跑的结论冲掉（切位面会把时段藏起来的实体放出来）。

新画布如果自己再写一份，"合成一个判定"这件事就会变成两份实现各自维护 ——
那正是本次重建要消灭的东西。所以判定只有这一处，两个画布都调它。

## 三条轴不在同一层（这是最容易搞错的地方）

- **过场轴**决定实体**存不存在**：仅过场实体不加载，改选择触发场景重载。
- **位面轴 / 时段轴**决定已加载实体**显不显**：后置显隐开关。

把过场轴降级成显隐会绕过重载路上的 staging 清理与撤销提交，属于静默丢数据。
"""
from __future__ import annotations

from dataclasses import dataclass, field

__all__ = ["FILTERED_KINDS", "ViewAxes", "norm_id_list", "entity_cutscene_ids",
           "entity_is_cutscene_only", "passes_cutscene", "passes_plane", "passes_phase",
           "passes_view_filters"]

#: **受三条轴管辖的实体族**。名单之外的一律恒显。
#:
#: 这不是可选优化，而是老画布的既有语义：显隐只施加于「登记过的实体」
#: （`_record_entity_view` 只登记热点/NPC/区域），出生点、光环境曲线、透视轴这些
#: 场景级结构件从来不登记，`refresh_entity_presence` 对它们直接 return。
#:
#: 忘了这道闸的后果不是"多藏一点"而是**语义反了**：出生点的 dict 里当然没有
#: `planes`，于是 `passes_plane` 走「缺省实体」那一支，在 exclusive（独立世界型）
#: 位面视图下判为不存在 —— 一切开梦境位面，出生点全体消失、没法编辑。
FILTERED_KINDS = frozenset({"hotspot", "npc", "zone"})


def norm_id_list(raw: object) -> list[str] | None:
    """``planes`` / ``phases`` 归一：非空字符串列表，或 ``None``（= 缺省，不受该轴限制）。

    空列表按 ``None`` 处理 —— "写了个空数组"和"没写"在作者意图上是一回事。
    """
    if not isinstance(raw, list):
        return None
    xs = [str(p).strip() for p in raw if str(p).strip()]
    return xs or None


def entity_cutscene_ids(ent: object) -> tuple[str, ...]:
    d = ent if isinstance(ent, dict) else {}
    raw = d.get("cutsceneIds")
    if not isinstance(raw, list):
        return ()
    return tuple(str(c).strip() for c in raw if str(c).strip())


def entity_is_cutscene_only(ent: object) -> bool:
    """绑了过场的实体**默认就是"仅过场"**，除非 `cutsceneOnly` 显式写了 false。

    口径抄自运行时（`src/data/types.ts`：「有值时默认作为仅过场实体，除非
    cutsceneOnly 显式为 false」）与老画布（`scene_editor._entity_is_cutscene_only`）。

    写成 `is True`（缺省判成"共享实体、永远显示"）的后果是**语义反了**：
    新画布对同一份场景 JSON 显示出比老画布多的实体，多出来的正是"只在过场里
    存在"的那些。策划照着这块骗人的画布排位、改坐标，改动会落到真实数据上
    但在正常游戏里看不到效果；反过来也会误以为这些实体在普通场景里存在，
    据此规划走位与遮挡。
    """
    d = ent if isinstance(ent, dict) else {}
    if not entity_cutscene_ids(d):
        return False
    return d.get("cutsceneOnly", True) is not False


@dataclass(frozen=True, slots=True)
class ViewAxes:
    """三条视图轴的当前状态。全为缺省时等于"什么都不过滤"。"""

    #: 过场编辑上下文；``""`` = 不加载任何仅过场实体
    cutscene_id: str = ""
    #: 位面视图；``None`` = 不按位面过滤
    plane_id: str | None = None
    #: 该位面的世界模型是否"独立世界型"（缺省实体在它里面不存在）
    plane_exclusive: bool = False
    #: 时段视图；``None`` = 不按时段过滤
    phase_id: str | None = None
    #: 「街上有人」的那几段（`ProjectModel.daylight_phase_ids()`），
    #: 即未写 phases 的 NPC 的缺省归属
    npc_default_phases: tuple[str, ...] = field(default=())

    @property
    def any_active(self) -> bool:
        return bool(self.cutscene_id or self.plane_id or self.phase_id)


def passes_cutscene(ent: object, axes: ViewAxes) -> bool:
    """过场轴：**决定存不存在**。

    没有绑定过场 → 一直在；绑定了但不是"仅过场" → 也一直在；
    仅过场实体只在选中它所属的那段过场时存在。
    """
    bindings = entity_cutscene_ids(ent)
    if not bindings:
        return True
    if not entity_is_cutscene_only(ent):
        return True
    ctx = str(axes.cutscene_id or "").strip()
    return bool(ctx) and ctx in bindings


def passes_plane(ent: object, axes: ViewAxes) -> bool:
    if axes.plane_id is None:
        return True
    planes = norm_id_list((ent if isinstance(ent, dict) else {}).get("planes"))
    if planes is None:
        # 缺省实体：shared 位面存在 / exclusive（独立世界型）不存在
        return not axes.plane_exclusive
    return axes.plane_id in planes


def passes_phase(kind: str, ent: object, axes: ViewAxes) -> bool:
    """时段轴。**缺省按实体种类分叉**，这是与位面轴唯一的形状差别：

    - NPC 未写 phases → 只在「街上有人」的段。该清单为空时**不施加限制**
      （与运行时 fail-open 同口径：宁可多显示，绝不静默清空整场景）。
    - 热点 / 区域未写 phases → 全时段都在（门、路牌夜里当然还在）。
    """
    if axes.phase_id is None:
        return True
    phases = norm_id_list((ent if isinstance(ent, dict) else {}).get("phases"))
    if phases is None:
        if str(kind).strip().lower() != "npc":
            return True
        return (not axes.npc_default_phases) or axes.phase_id in axes.npc_default_phases
    return axes.phase_id in phases


def passes_view_filters(kind: str, ent: object, axes: ViewAxes) -> bool:
    """**合成一个判定**。三条轴串成一串 and，顺序照抄运行时。

    过场绑定判定排在时段/位面**之后**，故仅过场实体**同样吃**时段与位面过滤 ——
    画布不得为了"方便编辑"擅自放行。

    `kind` 不在 `FILTERED_KINDS` 里的一律放行（理由见该常量）。
    """
    if str(kind).strip().lower() not in FILTERED_KINDS:
        return True
    return (passes_plane(ent, axes)
            and passes_phase(kind, ent, axes)
            and passes_cutscene(ent, axes))
