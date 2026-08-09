"""翻译层：把工程口径（信号 id / trace type）译成策划看得懂的一句话。

这是整个工具的核心价值——策划不 debug 状态机，他们问的是"我刚才那下系统听见没"
"现在卡在等什么"。翻译不准就等于没做。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from tools.narrative_debugger.model import BROADCAST_PREFIX, Emitter, NarrativeIndex, Transition

VERDICT_OK = "ok"
VERDICT_BLOCKED = "blocked"
VERDICT_DANGLING = "dangling"
VERDICT_STALE = "stale"
VERDICT_INFO = "info"

# 编辑器占位信号（与 NarrativeStateManager.DEFAULT_DRAFT_SIGNAL 对齐）
DRAFT_SIGNAL = "__draft__"

# 私有信号在每一处露面时都跟着的那半句。收在一个常量里：这句话说不一致，
# 策划就会以为界面上的「私有」和时间线上的「私有」是两回事。
PRIVATE_NOTE = "私有信号：只推动发射方实体自己的图"
# 列表里的记号。用汉字不用图标：两个窗的清单前面已经被运行时圆点占满，
# 再加一种形状只会更难认。
PRIVATE_MARK = "［私有］"

# 运行时那两条 fail-loud 丢弃的原文里，信号名夹在半角引号中间
# （NarrativeStateManager.processTrigger：`私有信号 "xxx" 的发射点没有 owner 上下文` /
# `私有信号 "xxx" 的发射方 npc:yyy 没有任何 wrapper 图`）。
# issue trace 只带 code + message，不带 triggerKey——名字只能从这句话里取，
# 取不到就退回不点名的说法，绝不编一个信号名出来。
_PRIVATE_SIGNAL_NAME_RE = re.compile(r'私有信号\s*"([^"]+)"')
_PRIVATE_OWNER_RE = re.compile(r"的发射方\s*(\S+?)\s*没有")

# "玩家真的动手那一下"的来源。broadcast / stateAction 是系统内部推的，不算。
CONCRETE_EMITTER_KINDS = {"dialogue", "zone", "hotspot", "pressureHold", "minigame"}

# 这些 issue 已经有对应的人话事件说过了，不再重复播报英文原文
_ISSUE_ALREADY_SAID = {"signal.unlistened", "stateCommand.debugOnly"}
_ISSUE_HEADLINE = {
    "scenario.boundary.stateCommand": "这一跳被拦住了（跨场景边界）",
    "transition.target.missing": "有条路指向了不存在的状态",
    "transition.from.missing": "有条路的起点状态不存在",
    "setState.target.missing": "要跳过去的状态不存在",
    "condition.ctxFactory.threw": "条件判断出错了，这一步被保守挡下",
}


@dataclass(frozen=True)
class TimelineEntry:
    """时间线上的一行。verdict 决定图标与颜色。

    merge_key 非空时，hub 会去替换最近一条同 key 的行——用来把
    "信号发出"和"结果如何"这两条技术事件合成策划眼里的一件事。
    """

    at: str
    headline: str
    detail: str
    verdict: str
    signal: str = ""
    graph_id: str = ""
    state_id: str = ""
    merge_key: str = ""
    raw: str = ""
    """工程原文（英文报错等）。只进 tooltip，不摆在正文里。"""

    def as_dict(self) -> dict[str, Any]:
        return {
            "at": self.at,
            "headline": self.headline,
            "detail": self.detail,
            "verdict": self.verdict,
            "signal": self.signal,
            "graphId": self.graph_id,
            "stateId": self.state_id,
        }


@dataclass(frozen=True)
class WaitingItem:
    """当前状态的一个出口——"在等什么"。

    action 是下钻到底的"玩家该做什么"：主线的出口信号几乎都是
    ``state:子图:末态`` 派生的，直接说"等某子图走完"对策划等于没说，
    要一路追到发这个信号的对话/区域才算答案。
    """

    signal: str
    what: str
    where: str
    blocked_by: str
    to_label: str
    action: str = ""
    action_where: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "what": self.what,
            "where": self.where,
            "blockedBy": self.blocked_by,
            "toLabel": self.to_label,
            "action": self.action,
            "actionWhere": self.action_where,
        }


def signal_phrase(index: NarrativeIndex, signal: str) -> tuple[str, str]:
    """信号 → (要发生的事, 在哪儿)。找不到发射端就退回信号原名，绝不编。"""
    if not signal:
        return ("（这条路不靠信号，是自动判定的）", "")
    if signal == DRAFT_SIGNAL:
        # 编辑器留的占位（NarrativeStateManager.DEFAULT_DRAFT_SIGNAL），
        # 是合法的"还没接线"状态，不是 bug——但也别把内部标记摆给策划看。
        return ("这条路还没接线（编辑器里的占位）", "")
    if signal.startswith(BROADCAST_PREFIX):
        body = signal[len(BROADCAST_PREFIX):]
        graph_id, _, state_id = body.rpartition(":")
        node = index.state(graph_id, state_id)
        if node is not None:
            return (f"「{node.graph_label}」走到「{node.display}」", "")
        return (f"「{graph_id}」走到「{state_id}」", "")
    emitters = index.emitters_for(signal)
    if not emitters:
        # 查不到发射端就照实说，绝不编一个来源出来
        return (_with_private_note(index, signal, f"有人打出了信号「{signal}」"), "")
    # 同一信号常有多个发射端（两根压力条、多段梦境对话），挑答得出地点的那个：
    # 取第一个会把"在哪儿"白白丢掉，而那正是策划卡住时唯一想知道的。
    primary = next((e for e in emitters if e.scene), emitters[0])
    return (_with_private_note(index, signal, _emitter_phrase(primary)), primary.scene)


def _with_private_note(index: NarrativeIndex, signal: str, phrase: str) -> str:
    """私有信号必须当面说清投递面。

    不说的话，同一条信号名挂在一百个箱子上，策划看到「点那个箱子」会以为随便哪个都行——
    而运行时只推发射的那一个（`allowedGraphIds`）。这半句是本机制在界面上唯一的现身处。
    """
    if not index.is_private_signal(signal):
        return phrase
    return f"{phrase}（{PRIVATE_NOTE}）"


def _emitter_phrase(emitter: Emitter) -> str:
    """一句话说清"要做什么"。有谁说谁，有台词报台词——策划问的就是这两样。"""
    if emitter.kind == "dialogue":
        # 策划问的是"我该干什么"。对话末尾那句旁白对他没用——真正的动作是
        # 去哪儿找谁把这段说了；只有玩家选项才是他自己按下去的那一下，值得报原话。
        if emitter.actor and emitter.trigger_kind == "npc":
            head = f"找「{emitter.actor}」说话"
        elif emitter.trigger_kind == "hotspot":
            head = f"点「{emitter.actor or emitter.label}」把那段说完"
        elif emitter.trigger_kind == "zone":
            head = "走进那片区域，把那段说完"
        elif emitter.trigger_kind == "sceneEnter":
            head = "进这个场景，那段戏会自己演"
        elif emitter.trigger_kind == "chained":
            head = f"把这个场景里那串戏往下走（到「{emitter.label}」这段）"
        else:
            head = f"把对话「{emitter.label}」走完"
        if emitter.line_kind == "choice" and emitter.line:
            return f"{head}，选「{_clip(emitter.line, 20)}」"
        return head
    if emitter.kind == "zone":
        # zone 在场景数据里常常只有 id 没有名字。不编一个，但要提示这是可以去补的
        name = emitter.label
        if _looks_like_id(name):
            return f"走进那片区域（这块儿还没起名：{name}）"
        return f"走进「{name}」"
    if emitter.kind == "hotspot":
        return f"点「{emitter.label}」"
    if emitter.kind == "pressureHold":
        return f"按住那个条：{_clip(emitter.label, 22)}"
    if emitter.kind == "minigame":
        return emitter.detail or f"玩「{emitter.label}」"
    if emitter.kind == "stateAction":
        return f"「{emitter.label}」这一步执行时"
    if emitter.kind == "broadcast":
        return f"「{emitter.label}」走完"
    return emitter.detail or emitter.signal


def _looks_like_id(text: str) -> bool:
    """像内部 id（z_xxx / new_zone_2 / 全 ASCII）而不是人起的名字。"""
    stripped = text.strip()
    if not stripped:
        return True
    if stripped.startswith(("z_", "new_", "zone_")):
        return True
    return stripped.isascii()


def _clip(text: str, limit: int = 18) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def player_action_for(
    index: NarrativeIndex,
    signal: str,
    *,
    max_depth: int = 4,
    _seen: set[str] | None = None,
) -> tuple[str, str]:
    """一路下钻到"玩家要做的那个动作"。返回 (动作, 在哪儿)；追不到返回 ("","")。

    主线出口是 ``state:子图:末态``；那个末态又靠子图内某条 transition 的信号到达；
    那个信号才可能是对话/区域发的。中间可能还套一层子图，所以要递归。
    """
    seen = _seen if _seen is not None else set()
    if not signal or signal == DRAFT_SIGNAL or signal in seen or max_depth <= 0:
        return ("", "")
    seen.add(signal)

    if not signal.startswith(BROADCAST_PREFIX):
        emitters = index.emitters_for(signal)
        # 压力条和小游戏也是玩家真的动手那一下，跟对话/区域同等具体
        concrete = [e for e in emitters if e.kind in CONCRETE_EMITTER_KINDS]
        if concrete:
            # 同一个信号常有多个发射端（如两根压力条），其中可能有一根是数据里
            # 没人启动的死条。优先挑答得出地点的那个，否则会白白丢掉"在哪儿"。
            best = next((e for e in concrete if e.scene), concrete[0])
            return (_emitter_phrase(best), best.scene)
        for emitter in emitters:
            if emitter.kind == "stateAction" and emitter.source_id in index.states:
                node = index.states[emitter.source_id]
                for t in index.by_to.get(node.key, []):
                    found = player_action_for(index, t.signal, max_depth=max_depth - 1, _seen=seen)
                    if found[0]:
                        return found
        return ("", "")

    body = signal[len(BROADCAST_PREFIX):]
    graph_id, _, state_id = body.rpartition(":")
    node = index.state(graph_id, state_id)
    if node is None:
        return ("", "")
    for t in index.by_to.get(node.key, []):
        found = player_action_for(index, t.signal, max_depth=max_depth - 1, _seen=seen)
        if found[0]:
            return found
    return ("", "")


def waiting_items(index: NarrativeIndex, graph_id: str, state_id: str) -> list[WaitingItem]:
    """当前状态在等什么。空列表 = 这是末态（或没接出口）。"""
    items: list[WaitingItem] = []
    for t in index.exits(graph_id, state_id):
        if t.is_reactive:
            # 反应式不吃信号：问 signal 只会得到"这条路还没接线"，而线明明接在条件上。
            # 要答的是"玩家做什么能让条件成立"——顺着条件里那个状态往上游钻。
            what, where = "条件一满足就自动往下走（不用再点什么）", ""
            action, action_where = _reactive_action(index, t)
        else:
            what, where = signal_phrase(index, t.signal)
            action, action_where = player_action_for(index, t.signal)
        target = index.state(t.graph_id, t.to_state)
        items.append(
            WaitingItem(
                signal=t.signal,
                what=what,
                where=where,
                blocked_by=index.describe_conditions(t.conditions) if t.has_conditions else "",
                to_label=target.display if target else t.to_state,
                action=action,
                action_where=action_where,
            )
        )
    return items


def _reactive_action(index: NarrativeIndex, t: Transition) -> tuple[str, str]:
    """反应式转移在等条件成立；顺着条件里的 (图, 状态) 往上游钻到玩家真动手那一下。"""
    for cond in _narrative_leaves(t.conditions):
        graph_id, state_id = cond
        found = player_action_for(index, f"{BROADCAST_PREFIX}{graph_id}:{state_id}")
        if found[0]:
            return found
    return ("", "")


def _narrative_leaves(node: Any) -> list[tuple[str, str]]:
    """条件树里的 {narrative, state} 叶子（含 all/any/not 嵌套）。"""
    out: list[tuple[str, str]] = []
    if isinstance(node, dict):
        graph_id = node.get("narrative")
        if isinstance(graph_id, str) and isinstance(node.get("state"), str):
            out.append((graph_id.strip(), str(node["state"]).strip()))
        for value in node.values():
            out.extend(_narrative_leaves(value))
    elif isinstance(node, (list, tuple)):
        for item in node:
            out.extend(_narrative_leaves(item))
    return out


def transition_phrase(index: NarrativeIndex, t: Transition) -> str:
    src = index.state(t.graph_id, t.from_state)
    dst = index.state(t.graph_id, t.to_state)
    graph_label = src.graph_label if src else t.graph_id
    return (
        f"「{graph_label}」从「{src.display if src else t.from_state}」"
        f"走到「{dst.display if dst else t.to_state}」"
    )


class TraceTranslator:
    """把运行时 trace 流译成时间线。

    trace 是逐条到达的技术事件（signal.received / signal.processed / ...），
    策划要的是聚合后的一句话：那一下有没有被听见、走没走、为什么没走。
    """

    def __init__(self, index: NarrativeIndex) -> None:
        self.index = index
        self._blocked_notes: dict[str, list[str]] = {}

    def _blocked_reason(self, event: dict[str, Any]) -> str:
        """把 transition.blocked 的 failing 索引翻回具体缺什么。"""
        graph_id = str(event.get("graphId") or "")
        transition_id = str(event.get("transitionId") or "")
        transition = self.index.by_transition_id.get((graph_id, transition_id))
        if transition is None:
            # 活计图实例 id 可能带后缀；退回按原型图找同名 transition
            for (gid, tid), t in self.index.by_transition_id.items():
                if tid == transition_id and graph_id.startswith(gid):
                    transition = t
                    break
        if transition is None:
            return str(event.get("message") or "")
        payload = event.get("payload") or {}
        failing = payload.get("failing")
        parts = self.index.condition_parts(transition.conditions)
        if isinstance(failing, list) and failing and parts:
            picked = [parts[i] for i in failing if isinstance(i, int) and 0 <= i < len(parts)]
            picked = [p for p in picked if p]
            if picked:
                return "、".join(picked)
        return self.index.describe_conditions(transition.conditions) or str(event.get("message") or "")

    def translate(self, event: dict[str, Any], at: str) -> TimelineEntry | None:
        kind = str(event.get("type") or "")
        signal = str(event.get("triggerKey") or "")
        graph_id = str(event.get("graphId") or "")
        state_id = str(event.get("stateId") or "")

        if kind == "signal.received":
            what, where = signal_phrase(self.index, signal)
            detail = f"在{where}" if where else ""
            self._blocked_notes.pop(signal, None)
            return TimelineEntry(
                at=at,
                headline=_lead(what),
                detail=detail or "……",
                verdict=VERDICT_INFO,
                signal=signal,
                merge_key=f"sig:{signal}",
            )

        if kind == "signal.processed":
            payload = event.get("payload") or {}
            matched = payload.get("matchedGraphIds") or []
            what, where = signal_phrase(self.index, signal)
            head = _lead(what)
            blocked = self._blocked_notes.pop(signal, [])
            if matched:
                names = "、".join(self._graph_name(g) for g in matched[:3])
                return TimelineEntry(
                    at=at,
                    headline=head,
                    detail=f"「{names}」往前走了一步",
                    verdict=VERDICT_OK,
                    signal=signal,
                    merge_key=f"sig:{signal}",
                )
            if blocked:
                return TimelineEntry(
                    at=at,
                    headline=head,
                    detail="有人在听，但条件没过：" + "；".join(blocked[:2]),
                    verdict=VERDICT_BLOCKED,
                    signal=signal,
                    merge_key=f"sig:{signal}",
                )
            if self.index.is_dangling(signal):
                return TimelineEntry(
                    at=at,
                    headline=head,
                    detail=f"没有任何人在听「{signal}」——多半是改名后忘了同步",
                    verdict=VERDICT_DANGLING,
                    signal=signal,
                    merge_key=f"sig:{signal}",
                )
            return TimelineEntry(
                at=at,
                headline=head,
                detail=self._why_not_matched(signal) or "有人在听，但现在不该它响",
                verdict=VERDICT_STALE,
                signal=signal,
                merge_key=f"sig:{signal}",
            )

        if kind == "transition.blocked":
            # 既攒着（等同一信号的 signal.processed 并成一行），也立刻出一行——
            # 万一后续没有 processed（嵌套排空里被吞），这条最有价值的信息也不会丢。
            note = self._blocked_reason(event)
            if note:
                self._blocked_notes.setdefault(signal, []).append(note)
            what, _ = signal_phrase(self.index, signal)
            return TimelineEntry(
                at=at,
                headline=_lead(what),
                detail=f"有人在听，但条件没过：{note}" if note else "有人在听，但条件没过",
                verdict=VERDICT_BLOCKED,
                signal=signal,
                graph_id=graph_id,
                merge_key=f"sig:{signal}",
            )

        if kind == "signal.ignored":
            message = str(event.get("message") or "")
            # 私有信号那两种丢弃：issue 那一条已经把「没有实体上下文」说成人话了
            # （它先到），这里再来一行只是把同一件事说两遍。
            if "private signal without owner context" in message:
                return None
            if "stale transition" in message:
                return TimelineEntry(
                    at=at,
                    headline="来晚了一步",
                    detail=f"{self._graph_name(graph_id)} 已经不在那个状态上了",
                    verdict=VERDICT_STALE,
                    signal=signal,
                    graph_id=graph_id,
                )
            what, _ = signal_phrase(self.index, signal)
            return TimelineEntry(
                at=at,
                headline=_lead(what) if signal else "这一下被忽略了",
                detail="这一下被跳过了" + (f"：{self._why_not_matched(signal)}" if signal else ""),
                verdict=VERDICT_STALE,
                signal=signal,
                raw=message,
            )

        if kind == "state.changed":
            node = self.index.state(graph_id, state_id or str(event.get("to") or ""))
            if node is None:
                return None
            return TimelineEntry(
                at=at,
                headline=f"进入「{node.display}」",
                detail=node.graph_label,
                verdict=VERDICT_OK,
                graph_id=graph_id,
                state_id=node.state_id,
            )

        if kind == "state.command":
            message = str(event.get("message") or "")
            if "applying" not in message:
                return None
            node = self.index.state(graph_id, state_id)
            where = node.display if node else state_id
            return TimelineEntry(
                at=at,
                headline=f"（调试）直接跳到「{where}」",
                detail=self._graph_name(graph_id),
                verdict=VERDICT_INFO,
                graph_id=graph_id,
                state_id=state_id,
            )

        if kind == "run.lifecycle":
            return TimelineEntry(
                at=at,
                headline=f"活计「{self._graph_name(graph_id)}」{_run_phrase(event)}",
                detail="",
                verdict=VERDICT_INFO,
                graph_id=graph_id,
            )

        if kind == "issue":
            payload = event.get("payload") or {}
            code = str(payload.get("code") or "")
            # 这些 issue 的人话版已经由对应的信号事件说过了，再来一条英文原文只是噪音
            if code in _ISSUE_ALREADY_SAID:
                return None
            # 英文原文对策划没用，只说清"哪张图、哪个状态出的事"；
            # 原文留给 raw，界面挂 tooltip 给需要贴给程序的人。
            where = self._where_phrase(graph_id, state_id)
            raw = str(payload.get("message") or event.get("message") or "")
            if code in ("signal.private.noOwner", "signal.private.ownerNoGraph"):
                # 私有信号仅有的两种丢弃，也是调试器要消灭的那个"静默没反应"：
                # 必须当场点名是哪条信号、为什么被丢，而不是让人去 tooltip 里读英文 code。
                # 名字只能从 raw 里取（issue trace 不带 triggerKey），取不到就不点名，不编。
                hit = _PRIVATE_SIGNAL_NAME_RE.search(raw)
                name = hit.group(1) if hit else ""
                subject = f"私有信号「{name}」" if name else "这条私有信号"
                if code == "signal.private.noOwner":
                    headline = f"{subject}的发射点没有实体上下文，被丢弃了"
                    detail = ("私有信号只推发射方 owner 自己的图；发射点（场景 onEnter 之类）"
                              "答不出是哪个实体发的，运行时就直接丢——不会回落成全局广播。")
                else:
                    who = _owner_from_message(raw)
                    headline = f"{subject}的发射方身上没有绑 wrapper 图，被丢弃了"
                    detail = (f"发射方是 {who}，" if who else "") + \
                        "它名下一张 wrapper 图都没有，这条信号谁都收不到——多半是这个实体本来就不该发它。"
                return TimelineEntry(
                    at=at,
                    headline=headline,
                    detail=detail,
                    verdict=VERDICT_DANGLING,
                    signal=name,
                    graph_id=graph_id,
                    state_id=state_id,
                    raw=raw,
                )
            known = code in _ISSUE_HEADLINE
            # 认识的错误说人话；不认识的**也要把原文摆出来**——
            # 只说"这儿有个接线问题"却把内容藏进 tooltip，那是把信息藏起来，不是人话化。
            detail = where if known else " ".join(x for x in (where, raw or code) if x)
            return TimelineEntry(
                at=at,
                headline=_ISSUE_HEADLINE.get(code, "这儿有个接线问题（原文附后，可截给程序）"),
                detail=detail or code,
                verdict=VERDICT_DANGLING,
                graph_id=graph_id,
                state_id=state_id,
                raw=raw,
            )

        return None

    def player_action_entry(self, action: str, label: str, at: str) -> TimelineEntry | None:
        """玩家动手那一行。先记下"你做了什么"，结论等一会儿再补。"""
        if action == "hotspot":
            headline = f"你点了「{label}」"
        elif action == "npc":
            headline = f"你找「{label}」说话"
        elif action == "dialogue":
            headline = f"开始演「{label}」这段" if label else "开始演一段对话"
        elif action == "zone":
            headline = f"你走进了「{self._zone_name(label)}」"
        elif action == "pressureHold":
            headline = f"你按住了那个条：{self._hold_prompt(label)}"
        elif action == "minigame":
            headline = f"进了小游戏「{label}」" if label else "进了一个小游戏"
        else:
            return None
        return TimelineEntry(
            at=at,
            headline=headline,
            detail="……",
            verdict=VERDICT_INFO,
            merge_key=f"act:{action}:{label}:{at}",
        )

    def silent_action_entry(self, entry: TimelineEntry) -> TimelineEntry:
        """等了一会儿没有任何信号跟上——照实说，别让策划以为是工具没接上。"""
        return TimelineEntry(
            at=entry.at,
            headline=entry.headline,
            detail="这一下没往叙事里传：要么这里根本没挂发信号的动作，要么没走到那一句",
            verdict=VERDICT_STALE,
            merge_key=entry.merge_key,
        )

    def _zone_name(self, zone_id: str) -> str:
        if not zone_id:
            return "一片区域"
        return f"{zone_id}（这块儿还没起名）" if _looks_like_id(zone_id) else zone_id

    def _hold_prompt(self, hold_id: str) -> str:
        for emitters in self.index.emitters.values():
            for emitter in emitters:
                if emitter.kind == "pressureHold" and emitter.source_id == hold_id:
                    return _clip(emitter.label, 24)
        return hold_id or "（不知道是哪根）"

    def _graph_name(self, graph_id: str) -> str:
        return self.index.graph_labels.get(graph_id, graph_id)

    def _where_phrase(self, graph_id: str, state_id: str) -> str:
        if not graph_id:
            return ""
        node = self.index.state(graph_id, state_id) if state_id else None
        if node is not None:
            return f"在「{node.graph_label}」的「{node.display}」这一步"
        return f"在「{self._graph_name(graph_id)}」这条线上"

    def _why_not_matched(self, signal: str) -> str:
        listeners = self.index.listeners.get(signal, [])
        if not listeners:
            return ""
        parts: list[str] = []
        for t in listeners[:2]:
            src = self.index.state(t.graph_id, t.from_state)
            parts.append(
                f"{self._graph_name(t.graph_id)} 要停在「{src.display if src else t.from_state}」才吃这一下"
            )
        return "；".join(parts)


def _owner_from_message(message: str) -> str:
    """`…的发射方 npc:npc_x 没有任何 wrapper 图` → `npc:npc_x`。取不到就空，不编。"""
    hit = _PRIVATE_OWNER_RE.search(message)
    return hit.group(1) if hit else ""


def _lead(what: str) -> str:
    if what.startswith("在对话"):
        return f"你{what}"
    if what.startswith("走进"):
        return f"你{what}"
    return what


def _run_phrase(event: dict[str, Any]) -> str:
    message = str(event.get("message") or "")
    if "started" in message:
        return "开工了"
    if "reset" in message:
        return "重来了"
    if "settled" in message:
        return "结了"
    if "suspended" in message:
        return "挂起了"
    if "discarded" in message:
        return "被弃了"
    if "reverted" in message:
        return "退回了一步"
    return message
