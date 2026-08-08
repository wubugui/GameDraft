"""命令行版「信号谁发谁听」（给 agent / 脚本 / 不想开工具的人）。

    python3 -m tools.narrative_xref <信号 id>      # 一条信号的两侧
    python3 -m tools.narrative_xref --list         # 全部信号一览（发/听/声明计数）
    python3 -m tools.narrative_xref --problems     # 只列两侧对不齐的
    python3 -m tools.narrative_xref <id> --json    # 结构化输出

只读，不改任何数据。与编辑器面板、调试器窗口同一套扫描口径。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .model import CHANNEL_UPSTREAM, KIND_DERIVED
from .scan import build_index
from .sources import from_disk

REPO_ROOT = Path(__file__).resolve().parents[2]

_KIND_TEXT = {
    "author": "作者信号",
    "derived": "派生信号",
    "draft": "草稿占位",
    "unknown": "未登记",
}


def _print_card(card, verbose: bool = True) -> None:
    head = f"「{card.signal}」"
    if card.label and card.label != card.signal:
        head += f"（{card.label}）"
    head += f"  {_KIND_TEXT.get(card.kind, card.kind)}"
    if card.kind == KIND_DERIVED and card.source_graph_id:
        head += f"  ← {card.source_graph_id}.{card.source_state_id}"
    print(head)
    if card.notes:
        print(f"  注释：{card.notes}")
    for diag in card.diagnostics:
        mark = {"error": "✗", "warning": "⚠", "info": "·"}.get(diag.severity, "·")
        print(f"  {mark} {diag.message}")

    reals = [e for e in card.emitters if e.channel != CHANNEL_UPSTREAM]
    ups = [e for e in card.emitters if e.channel == CHANNEL_UPSTREAM]
    print(f"  发送方 {len(reals)} 处：")
    for e in reals:
        who = f"{e.kind_label}「{e.container_label or e.container_id}」" if (e.container_label or e.container_id) else e.kind_label
        line = f"    · {who} — {e.where}" if e.where else f"    · {who}"
        if e.context:
            line += f"  {e.context}"
        print(line)
        if verbose:
            print(f"        {e.file}#{e.pointer}")
    if not reals:
        print("    （没有任何地方发出它）")
    if ups:
        print(f"  能让它发生的路 {len(ups)} 条：")
        for e in ups:
            print(f"    · {e.kind_label}「{e.container_label or e.container_id}」 — {e.where}  {e.context}")

    print(f"  接收方 {len(card.listeners)} 处：")
    for l in card.listeners:
        line = f"    · {l.composition_label} / {l.graph_label} · 转移「{l.transition_id}」：{l.from_label} → {l.to_label}"
        if l.conditions:
            line += f"  条件：{' 且 '.join(l.conditions)}"
        print(line)
        if verbose:
            print(f"        {l.file}#{l.pointer}")
    if not card.listeners:
        print("    （没有任何转移在等它）")

    if card.reactive_refs:
        print(f"  反应式转移填了它（{len(card.reactive_refs)} 处，运行时不看这个字段）：")
        for l in card.reactive_refs:
            print(f"    · {l.composition_label} / {l.graph_label} · 转移「{l.transition_id}」：{l.from_label} → {l.to_label}")
    if card.declarations:
        print(f"  黑盒声明 {len(card.declarations)} 处（只是画布标注，运行时不执行）：")
        for d in card.declarations:
            print(f"    · {d.composition_label} / 元素「{d.element_label}」({d.element_kind})")
    if card.state_reads:
        print(f"  另有 {len(card.state_reads)} 处条件在读这个状态（不是信号接收）：")
        for s in card.state_reads[:10]:
            who = f"{s.kind_label}「{s.container_id}」" if s.container_id else s.kind_label
            print(f"    · {who} — {s.where}")


def _print_state_card(card, verbose: bool = True) -> None:
    head = f"「{card.graph_label} · {card.state_label}」（{card.key}）"
    marks = [m for m, on in (("初始拍", card.is_initial), ("进入时广播", card.broadcasts),
                             ("活计图", card.run_graph)) if on]
    if marks:
        head += "  " + " / ".join(marks)
    print(head)
    for diag in card.diagnostics:
        mark = {"error": "✗", "warning": "⚠"}.get(diag.severity, "·")
        print(f"  {mark} {diag.message}")

    print(f"  怎么进来（{len(card.ways_in)}）：")
    for e in card.ways_in or []:
        print(f"    · {e.kind_label}「{e.container_label or e.container_id}」 {e.where}  {e.context}")
    if not card.ways_in:
        print("    （没有任何路能进来）" if not card.is_initial else "    （图的初始拍，一开局就停在这儿）")

    print(f"  从这儿去哪（{len(card.ways_out)}）：")
    for l in card.ways_out:
        how = l.how or ("条件满足自动走" if l.trigger else "没接触发条件")
        line = f"    · → {l.to_label}  {how}"
        if l.conditions:
            line += f"；还要满足：{' 且 '.join(l.conditions)}"
        print(line)
    if not card.ways_out:
        print("    （末态，没有出口）")

    if card.emits:
        print(f"  进出这一拍会发（{len(card.emits)}）：")
        for e in card.emits:
            print(f"    · {e.signal}  {e.where}")

    print(f"  谁在看着这一拍（{len(card.readers)}）：")
    for r in card.readers:
        who = f"{r.subject_scene}的" if r.subject_scene else ""
        kind = r.subject_kind_label or r.kind_label
        tail = f"（{r.subject_effect}）" if r.subject_effect else ""
        print(f"    · {who}{kind}「{r.subject_display}」{tail} — {r.where}")
        if verbose:
            print(f"        {r.file}#{r.pointer}")
    if not card.readers:
        print("    （没人读它）")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("signal", nargs="?", default="", help="信号 id（省略则配合 --list/--problems）")
    ap.add_argument("--root", type=Path, default=REPO_ROOT)
    ap.add_argument("--state", default="", metavar="图.态",
                    help="换个问法：这一拍怎么进来、去哪、谁在看着")
    ap.add_argument("--states", action="store_true", help="列出全部状态与引用计数")
    ap.add_argument("--list", action="store_true", help="列出全部信号与两侧计数")
    ap.add_argument("--problems", action="store_true", help="只列两侧对不齐的信号")
    ap.add_argument("--json", action="store_true", help="结构化输出")
    ap.add_argument("--quiet", action="store_true", help="不打印文件/指针")
    args = ap.parse_args(argv)

    try:
        index = build_index(from_disk(args.root))
    except Exception as exc:  # noqa: BLE001 - 命令行如实报错，不甩 traceback
        print(f"扫描失败（工程数据可能是半截的）：{exc}", file=sys.stderr)
        return 2

    if args.state:
        gid, _, sid = args.state.rpartition(".")
        if not gid or not sid:
            ap.error("状态要写成 图id.状态id")
        card = index.state_card(gid, sid)
        if args.json:
            print(json.dumps(card.to_dict(), ensure_ascii=False, indent=2))
            return 0
        _print_state_card(card, verbose=not args.quiet)
        return 0

    if args.states:
        cards = index.state_overview()
        if args.problems:
            cards = [c for c in cards if any(d.severity in ("error", "warning") for d in c.diagnostics)]
        if args.json:
            print(json.dumps({"states": [c.to_dict() for c in cards]}, ensure_ascii=False, indent=2))
            return 0
        print(f"共 {len(cards)} 个状态")
        for c in cards:
            flags = "".join({"error": "✗", "warning": "⚠", "info": "·"}.get(d.severity, "") for d in c.diagnostics)
            print(f"  {flags:2s} {c.key:<52s} 进 {len(c.ways_in):<2d} 出 {len(c.ways_out):<2d} 被看 {len(c.readers)}")
        return 0

    if args.list or args.problems:
        cards = index.overview()
        if args.problems:
            cards = [c for c in cards if any(d.severity in ("error", "warning") for d in c.diagnostics)]
        if args.json:
            print(json.dumps({"signals": [c.to_dict() for c in cards]}, ensure_ascii=False, indent=2))
            return 0
        print(f"共 {len(cards)} 条信号"
              f"（扫了 {index.stats.dialogues} 张对话图 / {index.stats.assets} 份内容资产 / "
              f"{index.stats.graphs} 张叙事图）")
        for c in cards:
            flags = "".join(
                {"error": "✗", "warning": "⚠", "info": "·"}.get(d.severity, "") for d in c.diagnostics
            )
            print(f"  {flags:2s} {c.signal:<48s} 发 {c.real_emitter_count:<3d} 听 {len(c.listeners):<3d}"
                  f" 声明 {len(c.declarations)}")
        return 0

    if not args.signal:
        ap.error("给一个信号 id，或用 --list / --problems")

    card = index.card(args.signal)
    if args.json:
        print(json.dumps(card.to_dict(), ensure_ascii=False, indent=2))
        return 0
    _print_card(card, verbose=not args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
