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

    if card.declarations:
        print(f"  黑盒声明 {len(card.declarations)} 处（只是画布标注，运行时不执行）：")
        for d in card.declarations:
            print(f"    · {d.composition_label} / 元素「{d.element_label}」({d.element_kind})")
    if card.state_reads:
        print(f"  另有 {len(card.state_reads)} 处条件在读这个状态（不是信号接收）：")
        for s in card.state_reads[:10]:
            who = f"{s.kind_label}「{s.container_id}」" if s.container_id else s.kind_label
            print(f"    · {who} — {s.where}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("signal", nargs="?", default="", help="信号 id（省略则配合 --list/--problems）")
    ap.add_argument("--root", type=Path, default=REPO_ROOT)
    ap.add_argument("--list", action="store_true", help="列出全部信号与两侧计数")
    ap.add_argument("--problems", action="store_true", help="只列两侧对不齐的信号")
    ap.add_argument("--json", action="store_true", help="结构化输出")
    ap.add_argument("--quiet", action="store_true", help="不打印文件/指针")
    args = ap.parse_args(argv)

    index = build_index(from_disk(args.root))

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
