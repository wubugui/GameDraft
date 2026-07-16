#!/usr/bin/env python3
"""agent_docs 治理台 CLI —— 治理类业务的统一入口(客户端无关)。

agent 遇到任何治理类业务(治理/建库/收编/炼化/体检…)先访问本 CLI,现场发现并取用
权威流程文件;各客户端只需安装一个指向本 CLI 的薄壳技能,新增治理流程零接线。

用法:
  python3 agent_docs/_meta/cli.py list             # 列出所有治理流程
  python3 agent_docs/_meta/cli.py route "一句话"    # 按业务描述匹配流程
  python3 agent_docs/_meta/cli.py get <id>         # 打印流程权威正文(照做)
  python3 agent_docs/_meta/cli.py audit [args...]  # 代理 audit.py(体检/索引/--check/--paths)
  python3 agent_docs/_meta/cli.py install          # 一键安装/修复客户端薄壳(幂等)
      [--client cursor|claude ...]                 #   只装指定客户端(缺目录会创建)
      [--dir <skills目录>]                          #   其它客户端:装到指定技能目录下

流程注册即文件:`_meta/<id>-skill.md` + frontmatter(id/title/summary/triggers 平铺关键词),
本 CLI 自动发现;权威正文只在该文件维护,禁止复制进任何壳。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

META_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(META_DIR))
from audit import parse_frontmatter  # noqa: E402  (schema 权威解析器,单一实现)


REPO_ROOT = META_DIR.parent.parent
KNOWN_CLIENTS = {"cursor": ".cursor/skills", "claude": ".claude/skills"}
LEGACY_SHELLS = ("agent-docs-governance", "agent-docs-intake")
SHELL_NAME = "agent-docs-cli"
SHELL_CONTENT = """---
name: agent-docs-cli
description: >-
  agent_docs 公共知识库治理台 CLI 的统一入口。凡遇治理类业务——治理 agent 文档/一键治理/
  更新知识库/建库/蒸馏记忆/govern agent docs/收编方法论/炼化经验/这个坑入库/记到库里/
  intake——先跑 python3 agent_docs/_meta/cli.py,从中现场发现并取用权威流程文件照做。
  本壳不含任何流程内容。
---

# agent-docs-cli(薄壳)

治理类业务统一走 CLI,现场发现流程,不要凭记忆发挥:

```
python3 agent_docs/_meta/cli.py list             # 列出所有治理流程
python3 agent_docs/_meta/cli.py route "一句话"    # 按业务描述匹配流程
python3 agent_docs/_meta/cli.py get <id>         # 打印权威正文,读它并严格照做
python3 agent_docs/_meta/cli.py audit [...]      # 机械体检/索引/--paths 查必读卡
```

权威正文全部在 `agent_docs/_meta/<id>-skill.md`;本壳与 CLI 都不复制正文。
"""

GATE_BEGIN = "<!-- agent-docs-gate:begin"
GATE_END = "<!-- agent-docs-gate:end -->"
GATE_CONTENT = """<!-- agent-docs-gate:begin (由 agent_docs/_meta/cli.py install 维护,勿手改) -->
## §A 开工先查公共知识库(agent_docs)

- 动手前按任务域读 `agent_docs/INDEX.md` 对应条目;确定要改的文件后跑
  `python3 agent_docs/_meta/audit.py --paths <files...>` 取必读机制卡,先读卡再动手。
- 治理类业务(治理/建库/收编方法论/炼化/intake)统一入口:`python3 agent_docs/_meta/cli.py`。
- 发现库内文档与现实打架:收尾往 `agent_docs/_meta/inbox/` 丢一条三行偏差记录(零门槛)。
<!-- agent-docs-gate:end -->"""
GATE_FILES = ("CLAUDE.md", "AGENTS.md")  # 2026-07-11 用户批准的接线面

HOOK_COMMAND = 'python3 "${CLAUDE_PROJECT_DIR:-.}/agent_docs/_meta/hooks/paths_reminder.py"'
HOOK_MARK = "paths_reminder.py"
HOOK_ENTRY = {
    "matcher": "Edit|Write|NotebookEdit",
    "hooks": [{
        "type": "command",
        "command": HOOK_COMMAND,
        "timeout": 10,
        "statusMessage": "agent_docs 必读卡检查",
    }],
}
HOOK_GUIDE = f"""主动发现·强制层接法(编辑命中登记路径 → 提醒读必读卡):

脚本 = agent_docs/_meta/hooks/paths_reminder.py(客户端无关,异常静默零退出,绝不阻断)
  - 通用模式:after-edit 事件里调 `python3 <脚本> <被编辑文件路径> [会话id]`,
    命中输出纯文本提醒(把它注入模型上下文),未命中无输出;给会话id才做一次性去重。
  - Claude Code 模式:PostToolUse hook 收 stdin JSON,输出 additionalContext JSON,
    由 `cli.py install` 自动接进 .claude/settings.json:
{json.dumps({"hooks": {"PostToolUse": [HOOK_ENTRY]}}, ensure_ascii=False, indent=2)}
"""


def ensure_claude_hook() -> None:
    """把强制层 hook 幂等接进 .claude/settings.json(只增不改,坏 JSON 不碰)。"""
    settings = REPO_ROOT / ".claude" / "settings.json"
    if not settings.parent.is_dir():
        print("- 跳过 hook(.claude 目录不存在)")
        return
    data: dict = {}
    if settings.is_file():
        try:
            data = json.loads(settings.read_text(encoding="utf-8"))
        except Exception:
            print(f"✗ 跳过 hook:{settings} 不是合法 JSON,请先修复(坏 settings 会禁用全部配置)")
            return
    post = data.setdefault("hooks", {}).setdefault("PostToolUse", [])
    if any(HOOK_MARK in h.get("command", "") for e in post for h in e.get("hooks", [])):
        print(f"✓ hook 已是最新: {settings}")
        return
    post.append(HOOK_ENTRY)
    settings.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✓ hook 已接线: {settings}(新接需重开会话或 /hooks 重载生效)")


def ensure_gate(path: Path) -> None:
    """在自动载入的指令文件中安装/刷新闸门块(只动标记块,不碰其余内容)。"""
    if not path.is_file():
        print(f"- 跳过(文件不存在): {path.name}")
        return
    text = path.read_text(encoding="utf-8")
    if GATE_BEGIN in text and GATE_END in text:
        start = text.index(GATE_BEGIN)
        end = text.index(GATE_END) + len(GATE_END)
        new = text[:start] + GATE_CONTENT + text[end:]
        label = "闸门已是最新" if new == text else "闸门已刷新"
    else:
        new = text.rstrip() + "\n\n" + GATE_CONTENT + "\n"
        label = "闸门已接线(追加于末尾,可手动挪到更靠前的位置)"
    if new != text:
        path.write_text(new, encoding="utf-8")
    print(f"✓ {label}: {path.name}")


def cmd_install(rest: list[str]) -> int:
    clients, custom_dirs = [], []
    i = 0
    while i < len(rest):
        if rest[i] == "--print":
            print(SHELL_CONTENT, end=""); return 0
        if rest[i] == "--print-gate":
            print(GATE_CONTENT); return 0
        if rest[i] == "--print-hook":
            print(HOOK_GUIDE, end=""); return 0
        if rest[i] == "--client" and i + 1 < len(rest):
            clients.append(rest[i + 1]); i += 2
        elif rest[i] == "--dir" and i + 1 < len(rest):
            custom_dirs.append(Path(rest[i + 1])); i += 2
        else:
            print(f"未知参数 {rest[i]!r}(可用: --client cursor|claude / --dir <skills目录> / --print / --print-gate)"); return 1

    targets: list[Path] = list(custom_dirs)
    if clients:
        for c in clients:
            if c not in KNOWN_CLIENTS:
                print(f"未知客户端 {c!r}(已知: {', '.join(KNOWN_CLIENTS)});其它客户端请用 --dir"); return 1
            targets.append(REPO_ROOT / KNOWN_CLIENTS[c])
    if not clients and not custom_dirs:
        targets += [REPO_ROOT / p for p in KNOWN_CLIENTS.values() if (REPO_ROOT / p).parent.is_dir()]
        if not targets:
            print("未发现已知客户端目录(.cursor/.claude);用 --client 或 --dir 指定。"); return 1

    for skills_dir in targets:
        shell = skills_dir / SHELL_NAME / "SKILL.md"
        old = shell.read_text(encoding="utf-8") if shell.is_file() else None
        if old == SHELL_CONTENT:
            print(f"✓ 已是最新: {shell}")
        else:
            shell.parent.mkdir(parents=True, exist_ok=True)
            shell.write_text(SHELL_CONTENT, encoding="utf-8")
            print(f"✓ {'已修复' if old is not None else '已安装'}: {shell}")
        for legacy in LEGACY_SHELLS:
            legacy_dir = skills_dir / legacy
            if legacy_dir.is_dir():
                for p in sorted(legacy_dir.rglob("*"), reverse=True):
                    p.unlink() if p.is_file() else p.rmdir()
                legacy_dir.rmdir()
                print(f"✓ 已清理旧分流程壳: {legacy_dir}")
    if not custom_dirs:
        for name in GATE_FILES:
            ensure_gate(REPO_ROOT / name)
        ensure_claude_hook()
    print("\n若你的客户端不是 Cursor/Claude Code:`install --dir <你的技能目录>`;格式不同则")
    print("`install --print` 取薄壳、`install --print-gate` 取开工闸门块、`install --print-hook`")
    print("取强制层 hook 接法,按你客户端的机制自行适配(规则见 _meta/install-prompt.md)。")
    print("自检: python3 agent_docs/_meta/cli.py list")
    return 0


def load_flows() -> list[dict]:
    flows = []
    for p in sorted(META_DIR.glob("*-skill.md")):
        meta = parse_frontmatter(p.read_text(encoding="utf-8"))
        if not meta or not meta.get("id"):
            continue
        meta["_path"] = p
        flows.append(meta)
    return flows


def rel(p: Path) -> str:
    try:
        return p.relative_to(META_DIR.parent.parent).as_posix()
    except ValueError:
        return str(p)


def cmd_list(flows: list[dict]) -> int:
    print("agent_docs 治理流程(取正文: cli.py get <id>):\n")
    for f in flows:
        trig = ", ".join(f.get("triggers") or [])
        print(f"  {f['id']:<12} {f.get('title', '')}")
        print(f"  {'':<12} {f.get('summary', '')}")
        print(f"  {'':<12} 触发词: {trig}")
        print(f"  {'':<12} 正文: {rel(f['_path'])}\n")
    print("另:机械体检/索引/按改动路径查必读卡 → cli.py audit [--check | --paths <files...>]")
    return 0


def cmd_get(flows: list[dict], fid: str) -> int:
    for f in flows:
        if f["id"] == fid or f["_path"].stem == fid:
            print(f["_path"].read_text(encoding="utf-8"), end="")
            return 0
    print(f"未找到流程 {fid!r}。可用流程:")
    for f in flows:
        print(f"  - {f['id']}")
    return 1


def cmd_route(flows: list[dict], query: str) -> int:
    q = query.lower()
    scored = []
    for f in flows:
        keys = [str(k) for k in (f.get("triggers") or [])] + [str(f.get("title", "")), str(f.get("summary", ""))]
        score = sum(1 for k in keys if k and k.lower() in q)
        score += sum(1 for k in (f.get("triggers") or []) if str(k).lower() and str(k).lower() in q) * 2
        if score:
            scored.append((score, f))
    if not scored:
        print("没有流程直接命中;全部候选如下,自行判断(拿不准就先读 constitution.md):\n")
        return cmd_list(flows)
    scored.sort(key=lambda x: -x[0])
    print("匹配到的流程(按相关度;取正文照做: cli.py get <id>):\n")
    for score, f in scored:
        print(f"  {f['id']:<12} {f.get('title', '')} — {f.get('summary', '')}")
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "audit":
        return subprocess.call([sys.executable, str(META_DIR / "audit.py"), *rest])
    if cmd == "install":
        return cmd_install(rest)
    flows = load_flows()
    if cmd == "list":
        return cmd_list(flows)
    if cmd == "get":
        if not rest:
            print("用法: cli.py get <id>"); return 1
        return cmd_get(flows, rest[0])
    if cmd == "route":
        if not rest:
            print('用法: cli.py route "业务一句话"'); return 1
        return cmd_route(flows, " ".join(rest))
    print(f"未知子命令 {cmd!r}(可用: list / route / get / audit)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
