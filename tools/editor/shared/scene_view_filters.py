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
           "entity_is_cutscene_only", "group_phases", "in_phase", "passes_cutscene",
           "passes_plane", "passes_phase", "passes_group_box_filters",
           "passes_view_filters", "scene_day_night_enabled",
           "phase_backgrounds", "phase_primary_background", "declared_background_images"]

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


def scene_day_night_enabled(scene: object) -> bool:
    """时段轴的**场景总闸**：`scene.dayNight.enabled` 是不是恰好为 `True`。

    口径抄自运行时 `SceneManager.entityInPhase` 的首行
    （`this.currentScene?.dayNight?.enabled !== true` 就直接放行）：
    **只有显式 `true` 才算开**，缺键 / `{}` / 任何真值字符串都算没开
    ——否则旧场景一到夜里就空了。

    两套画布共用这一份，各写各的读法就会漂（一边认 truthy 一边认 `is True`，
    表现为同一份场景在两个画布上时段过滤一个生效一个不生效）。
    """
    dn = (scene if isinstance(scene, dict) else {}).get("dayNight")
    return isinstance(dn, dict) and dn.get("enabled") is True


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
    #: **场景总闸**：当前场景的 `scene.dayNight.enabled` 是否为 `true`。
    #: 为假时整套时段判定不生效、恒显 —— 口径抄自运行时
    #: `SceneManager.entityInPhase` 的首行（那道闸在实体/分组两级判定**之前**）。
    #:
    #: 缺省必须是 `True` 而不是 `False`：传 `False` 会让所有没显式传这个字段的
    #: 既有调用方瞬间失去时段过滤，那是静默行为翻转。缺省 `True` = 与本字段
    #: 加入之前逐字一致。
    day_night_enabled: bool = True

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


def in_phase(phase_id: str, phases: list[str] | None,
             fallback: object = None) -> bool:
    """`src/utils/dayTime.ts` 的 `isEntityInPhase` 的**逐条镜像**，别在别处另写一份。

    三重 fail-open 必须原样继承（写白名单比对时最容易漏掉后两条）：

    - `phases` 空 / 未写 → 用 `fallback`；
    - `fallback` 也空 → 恒 `True`（不施加限制，不是"全部隐藏"）；
    - `phase_id` 取不到 → 恒 `True`（宁可画布上多几个，绝不静默清空整场景）。
    """
    lst = phases if phases else fallback
    if not lst:
        return True
    if not phase_id:
        return True
    return phase_id in lst


def group_phases(group: object) -> list[str] | None:
    """所属分组的「时段归属」。无组 / 组无定义 / 空数组一律 `None`（= 不施加限制）。

    口径抄自运行时 `SceneManager.currentSceneGroupPhases`：只认 `entityGroups`
    里的显式定义；**只在成员身上出现的兼容标签组没有定义，按无条件组处理**。
    """
    return norm_id_list((group if isinstance(group, dict) else {}).get("phases"))


def passes_phase(kind: str, ent: object, axes: ViewAxes,
                 group: object = None) -> bool:
    """时段轴。判定与运行时 `SceneManager.entityInPhase` 同式：

        in_phase(实体.phases, 当前时段, 组.phases ?? 种类缺省)
        and in_phase(组.phases, 当前时段, 无)

    展开成人话 = **三级就近取用（自己 → 组 → 种类缺省）+ 组是整体限制**：

    - 实体自己写了 phases → 实体的 ∩ 组的（组仍是一道整体闸，取交集）；
    - 实体没写、组写了 → 跟组走（组的时段就是成员的缺省来源）；
    - 都没写 → **种类缺省，这是与位面轴唯一的形状差别**：
      NPC = 「街上有人」的那几段（清单为空时不施加限制）；热点 / 区域 = 全时段
      （门、路牌夜里当然还在）。
    - 分组自己的缺省 = **不施加限制**。分组是异构容器，可能同时装着人和门，
      借用 NPC 那条「只在白日」的缺省会让一个装着门和路牌的组夜里整组消失。

    `group` 传 `None`（调用方拿不到分组信息）时行为与"没有分组这回事"完全一致 ——
    第二个 `in_phase` 恒 `True`，第一个的 fallback 落回种类缺省。

    最前面还有一道**场景总闸**（`axes.day_night_enabled`）：场景没开日夜时整套时段
    判定不生效、恒显，与运行时 `SceneManager.entityInPhase` 的首行同位置。少了它就是
    「没开日夜的场景里配了 phases，画布按时段藏、运行时恒显」——又一处画布骗人。

    ⚠ 本函数里**不许出现时段 id 字面量**（'夜' / 'night' 之类）。哪几段算「白天有人」
    由内容侧在 `game_config.dayNight.phases[].daylight` 上标，代码只认这个语义角色
    （2026-08-18「整条街一个人都没有」事故后的硬契约）。
    """
    if not axes.day_night_enabled:
        return True
    if axes.phase_id is None:
        return True
    own = norm_id_list((ent if isinstance(ent, dict) else {}).get("phases"))
    grp = group_phases(group)
    kind_default = (axes.npc_default_phases
                    if str(kind).strip().lower() == "npc" else None)
    return (in_phase(axes.phase_id, own, grp if grp is not None else kind_default)
            and in_phase(axes.phase_id, grp, None))


def passes_group_box_filters(group: object, axes: ViewAxes) -> bool:
    """画布上那个**分组框自己**显不显。**只有时段这一条轴管它。**

    为什么框也要吃时段轴：组切到自己时段之外时成员会整批隐去，框却还在，
    画布上留一个"框在、人没了"的空框 —— 用户会以为成员数据丢了。

    为什么位面轴与过场轴**不许**管它：分组 dict 里没有 `planes` / `cutsceneIds`，
    走 `passes_plane` 就落进「缺省实体」那一支，在 exclusive（独立世界型）位面视图下
    判为不存在 —— 一切到梦境位面，全场分组框集体消失，而整组位移的唯一入口就是这个框。
    这正是 `FILTERED_KINDS` 那段注释警告的坑，别顺手把它并进 `passes_view_filters`。

    场景总闸同样管它：`dayNight.enabled` 不为真时组的 `phases` 一个字都不生效
    （成员在这种场景里恒显，框自然也不该消失），与 `passes_phase` 首行同源。
    """
    if not axes.day_night_enabled:
        return True
    if axes.phase_id is None:
        return True
    return in_phase(axes.phase_id, group_phases(group), None)


def passes_view_filters(kind: str, ent: object, axes: ViewAxes,
                        group: object = None) -> bool:
    """**合成一个判定**。三条轴串成一串 and，顺序照抄运行时。

    过场绑定判定排在时段/位面**之后**，故仅过场实体**同样吃**时段与位面过滤 ——
    画布不得为了"方便编辑"擅自放行。

    `group` = 该实体所属分组的 dict（`entityGroups` 里那一条），拿不到就传 `None`。
    分组的时段归属**并进时段轴这一个判定**里（见 `passes_phase`），不另开一条并行的
    apply —— 再加一条轴时同样并进来。

    `kind` 不在 `FILTERED_KINDS` 里的一律放行（理由见该常量）。
    """
    if str(kind).strip().lower() not in FILTERED_KINDS:
        return True
    return (passes_plane(ent, axes)
            and passes_phase(kind, ent, axes, group)
            and passes_cutscene(ent, axes))


# ---------------------------------------------------------------------------
# 时段外观（背景那一半）
#
# 三条轴管的是「实体显不显」,这一段管的是「**背景是哪张**」——同一个时段视图的另一半。
# 制作人 2026-08-30 定的模型是**夜靠换一张夜原画**得到,所以切到夜视图只藏实体、
# 背景还是白天那张 = 画布上是「白天的街 + 夜里的人」,那种画面策划照着排位必然排歪。
#
# 口径必须与运行时 `src/utils/sceneAppearance.ts::resolveSceneAppearance` 逐字一致
# （对账测试:`tools/editor/tests/test_phase_background_parity.py`）。
# ---------------------------------------------------------------------------

def phase_backgrounds(scene: object, phase_id: str) -> list:
    """场景在 `phase_id` 时段的背景层列表。

    与运行时同式:变体的 `backgrounds` **非空**才顶掉基底(空数组 = 没配 = 沿用白天),
    场景总闸没开或该时段没配变体时直接返回顶层那份。
    """
    base = scene.get("backgrounds") if isinstance(scene, dict) else None
    base = base if isinstance(base, list) else []
    pid = str(phase_id or "").strip()
    if not pid or not scene_day_night_enabled(scene):
        return base
    tv = scene.get("timeVariants") if isinstance(scene, dict) else None
    v = tv.get(pid) if isinstance(tv, dict) else None
    if not isinstance(v, dict):
        return base
    over = v.get("backgrounds")
    return over if isinstance(over, list) and over else base


def phase_primary_background(scene: object, phase_id: str) -> str:
    """该时段的**主背景图名** —— 烘焙产物按它索引（见 `bakeKeyFromBackground`）。

    取不到时回落 `background.png`,与运行时 `primaryBackgroundImage` 的缺省同口径。
    """
    layers = phase_backgrounds(scene, phase_id)
    first = layers[0] if layers else None
    img = first.get("image") if isinstance(first, dict) else None
    if isinstance(img, str) and img.strip():
        return img.strip()
    base = scene.get("backgrounds") if isinstance(scene, dict) else None
    b0 = base[0] if isinstance(base, list) and base else None
    img0 = b0.get("image") if isinstance(b0, dict) else None
    return img0.strip() if isinstance(img0, str) and img0.strip() else "background.png"


def declared_background_images(scene: object) -> set[str]:
    """这个场景**允许**出现的主背景图名白名单。

    镜像运行时 `AssetManager.loadSceneData` 的那道闸:`background.png` 恒在,
    再加上场景自己在 `timeVariants` 里声明过的时段背景。**不是把闸拆了** ——
    白名单从数据里来,任意文件名照旧拒绝。

    编辑器这边少了这一条的症状:夜背景在游戏里加载得好好的,画布却判它"名字不对"
    而画一张占位灰底 —— 编辑器骗人的一种。
    """
    out = {"background.png"}
    tv = scene.get("timeVariants") if isinstance(scene, dict) else None
    for v in (tv or {}).values() if isinstance(tv, dict) else ():
        if not isinstance(v, dict):
            continue
        layers = v.get("backgrounds")
        b0 = layers[0] if isinstance(layers, list) and layers else None
        img = b0.get("image") if isinstance(b0, dict) else None
        if isinstance(img, str) and img.strip():
            out.add(img.strip())
    return out
