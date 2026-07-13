#!/usr/bin/env python3
"""agent_docs 机械体检 + 索引生成。

用法:
  python3 agent_docs/_meta/audit.py           # 体检 + 重生成 INDEX.md / paths-triggers.json
  python3 agent_docs/_meta/audit.py --check   # 只读门禁模式:不写任何文件,索引过期也算 error

体检范围(机械可判定的那半;语义漂移由治理 skill 的两条证据管线负责):
  - frontmatter 合法性(本文件的解析器就是 schema.md 的权威实现)
  - id/文件名/域目录/类型子目录 一致性;id 全库唯一
  - authority 锚点可解析(文件存在 / glob 命中 / 文件#符号 命中)
  - verified_by 测试文件存在
  - triggers 非空(decision 豁免)
  - method 新鲜度分诊信号(last_used 缺失或过旧 → info)
  - inbox 偏差记录的 target 指向存在的文档
退出码:有 error 则 1,否则 0(warn/info 不影响)。
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

META_DIR = Path(__file__).resolve().parent
DOCS_ROOT = META_DIR.parent
REPO_ROOT = DOCS_ROOT.parent
INBOX_DIR = META_DIR / "inbox"

DOMAINS = ("runtime", "editor-tools", "content", "asset-pipeline", "meta")
TYPES = ("norm", "method", "mechanism", "recipe", "decision")
TYPE_SUBDIR = {"method": "methods", "mechanism": "mechanisms", "recipe": "recipes", "decision": "decisions"}
STATUSES = ("active", "suspect", "superseded")
INDEX_TYPE_ORDER = ("norm", "method", "mechanism", "recipe", "decision")
TYPE_LABEL = {"norm": "规范", "method": "工作法", "mechanism": "机制卡", "recipe": "配方", "decision": "决策记录"}
METHOD_STALE_DAYS = 60
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DECISION_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-(.+)$")

GENERATED_HEADER = "<!-- 生成文件,禁止手写;由 agent_docs/_meta/audit.py 重生成 -->"


@dataclass
class Issue:
    severity: str  # error | warn | info
    where: str
    message: str


@dataclass
class Doc:
    path: Path
    meta: dict = field(default_factory=dict)

    @property
    def rel(self) -> str:
        return self.path.relative_to(DOCS_ROOT).as_posix()


# ---------- 受限 YAML 子集解析(schema.md 的权威实现) ----------

def _clean_scalar(raw: str) -> str:
    s = raw.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        s = s[1:-1]
    return s


def _parse_inline_list(raw: str) -> list[str] | None:
    s = raw.strip()
    if not (s.startswith("[") and s.endswith("]")):
        return None
    inner = s[1:-1].strip()
    if not inner:
        return []
    return [_clean_scalar(x) for x in inner.split(",")]


def parse_frontmatter(text: str) -> dict | None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        return None

    meta: dict = {}
    i = 1
    current_key: str | None = None       # 顶层块列表归属键
    nest_key: str | None = None          # 一层嵌套(如 triggers)
    nest_child: str | None = None        # 嵌套内块列表归属键
    while i < end:
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()

        if stripped.startswith("- "):
            item = _clean_scalar(stripped[2:])
            if indent >= 4 and nest_key and nest_child:
                meta[nest_key][nest_child].append(item)
            elif current_key:
                meta[current_key].append(item)
            else:
                return None
            continue

        if ":" not in stripped:
            return None
        key, _, rest = stripped.partition(":")
        key = key.strip()
        rest = rest.strip()

        if indent == 0:
            nest_key = nest_child = None
            if rest == "":
                # 可能是块列表或嵌套块;先占位,由后续行决定
                meta[key] = []
                current_key = key
                nest_key = key  # 若后续出现缩进 key:,再切换为 dict
            else:
                inline = _parse_inline_list(rest)
                meta[key] = inline if inline is not None else _clean_scalar(rest)
                current_key = None
        elif indent == 2 and nest_key:
            # 嵌套键:把占位 list 升级成 dict
            if isinstance(meta.get(nest_key), list) and not meta[nest_key]:
                meta[nest_key] = {}
            if not isinstance(meta.get(nest_key), dict):
                return None
            current_key = None
            if rest == "":
                meta[nest_key][key] = []
                nest_child = key
            else:
                inline = _parse_inline_list(rest)
                meta[nest_key][key] = inline if inline is not None else _clean_scalar(rest)
                nest_child = None
        else:
            return None
    return meta


# ---------- 校验 ----------

def check_anchor(anchor: str) -> bool:
    """authority 锚点:文件 / glob / 文件#符号。"""
    if "#" in anchor:
        file_part, _, symbol = anchor.partition("#")
        p = REPO_ROOT / file_part
        if not p.is_file() or not symbol:
            return False
        try:
            return symbol in p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return False
    if any(ch in anchor for ch in "*?["):
        matches = [m for m in REPO_ROOT.glob(anchor) if ".claude" not in m.parts]
        return len(matches) > 0
    return (REPO_ROOT / anchor).exists()


def _as_list(v) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str) and v:
        return [v]
    return []


def expected_location_ok(doc: Doc, issues: list[Issue]) -> None:
    rel_parts = doc.path.relative_to(DOCS_ROOT).parts
    meta = doc.meta
    domain, dtype, doc_id = meta.get("domain"), meta.get("type"), meta.get("id")
    stem = doc.path.stem
    if domain not in DOMAINS:
        issues.append(Issue("error", doc.rel, f"domain 非法: {domain!r}"))
        return
    if dtype not in TYPES:
        issues.append(Issue("error", doc.rel, f"type 非法: {dtype!r}"))
        return
    if rel_parts[0] != domain:
        issues.append(Issue("error", doc.rel, f"所在域目录 {rel_parts[0]!r} 与 domain: {domain!r} 不一致"))
    if dtype == "norm":
        if len(rel_parts) != 2 or rel_parts[1] != "norms.md":
            issues.append(Issue("error", doc.rel, "type: norm 必须位于 <域>/norms.md"))
        if doc_id != f"{domain}-norms":
            issues.append(Issue("error", doc.rel, f"norm 的 id 须为 {domain}-norms,当前 {doc_id!r}"))
        return
    subdir = TYPE_SUBDIR[dtype]
    if len(rel_parts) != 3 or rel_parts[1] != subdir:
        issues.append(Issue("error", doc.rel, f"type: {dtype} 必须位于 <域>/{subdir}/ 下"))
    if dtype == "decision":
        m = DECISION_FILE_RE.match(stem)
        if not m:
            issues.append(Issue("error", doc.rel, "decision 文件名须为 YYYY-MM-DD-<id>.md"))
        elif m.group(2) != doc_id:
            issues.append(Issue("error", doc.rel, f"文件名 id 段 {m.group(2)!r} 与 id: {doc_id!r} 不一致"))
    else:
        if stem != doc_id:
            issues.append(Issue("error", doc.rel, f"文件名 {stem!r} 与 id: {doc_id!r} 不一致"))


def check_doc(doc: Doc, issues: list[Issue]) -> None:
    meta = doc.meta
    for f in ("id", "title", "domain", "type", "summary", "status", "last_governed"):
        if not meta.get(f):
            issues.append(Issue("error", doc.rel, f"缺必填字段 {f}"))
    if meta.get("status") and meta["status"] not in STATUSES:
        issues.append(Issue("error", doc.rel, f"status 非法: {meta['status']!r}"))
    if meta.get("last_governed") and not DATE_RE.match(str(meta["last_governed"])):
        issues.append(Issue("error", doc.rel, "last_governed 须为 YYYY-MM-DD"))
    expected_location_ok(doc, issues)

    dtype = meta.get("type")
    anchors = _as_list(meta.get("authority"))
    if dtype in ("mechanism", "recipe") and not anchors:
        issues.append(Issue("error", doc.rel, f"type: {dtype} 必须带 authority 锚点"))
    for a in anchors:
        if not check_anchor(a):
            issues.append(Issue("error", doc.rel, f"authority 锚点失配: {a}"))
    for t in _as_list(meta.get("verified_by")):
        if not (REPO_ROOT / t).is_file():
            issues.append(Issue("error", doc.rel, f"verified_by 文件不存在: {t}"))

    triggers = meta.get("triggers")
    trig_lists = []
    if isinstance(triggers, dict):
        trig_lists = [x for k in ("paths", "topics", "tasks") for x in _as_list(triggers.get(k))]
    if dtype != "decision" and not trig_lists:
        issues.append(Issue("error", doc.rel, "triggers 为空(paths/topics/tasks 至少一项)——答不出'谁、何时、为何读我'的内容不配入库"))

    if dtype == "method":
        lu = meta.get("last_used")
        if not lu:
            issues.append(Issue("info", doc.rel, "method 未记录 last_used(治理 run 分诊信号缺失)"))
        elif DATE_RE.match(str(lu)):
            days = (date.today() - datetime.strptime(str(lu), "%Y-%m-%d").date()).days
            if days > METHOD_STALE_DAYS:
                issues.append(Issue("info", doc.rel, f"method 已 {days} 天未使用 → 治理 run 应分诊(标疑或盖章)"))
        else:
            issues.append(Issue("error", doc.rel, "last_used 须为 YYYY-MM-DD"))


def check_inbox(doc_ids: set[str], issues: list[Issue]) -> int:
    if not INBOX_DIR.is_dir():
        return 0
    pending = 0
    for p in sorted(INBOX_DIR.glob("*.md")):
        if p.name == "README.md":
            continue
        pending += 1
        meta = parse_frontmatter(p.read_text(encoding="utf-8"))
        rel = p.relative_to(DOCS_ROOT).as_posix()
        if meta is None:
            issues.append(Issue("warn", rel, "偏差记录 frontmatter 不合法"))
            continue
        target = meta.get("target")
        if not target:
            issues.append(Issue("warn", rel, "偏差记录缺 target"))
        elif target != "missing" and target not in doc_ids:
            issues.append(Issue("warn", rel, f"偏差记录 target 指向不存在的文档: {target!r}"))
    if pending:
        issues.append(Issue("info", "_meta/inbox", f"{pending} 条偏差记录待治理 run 蒸馏"))
    return pending


# ---------- 索引生成 ----------

def build_index(docs: list[Doc]) -> str:
    lines = [GENERATED_HEADER, "", "# agent_docs 索引", "",
             "> 按域 × 类型分组;每行 summary 即'读不读全文'的判断依据。",
             "> 收录标准与治理规则见 [_meta/constitution.md](_meta/constitution.md)。", ""]
    by_domain: dict[str, list[Doc]] = {}
    for d in docs:
        by_domain.setdefault(d.meta.get("domain", "?"), []).append(d)
    for domain in DOMAINS:
        group = by_domain.get(domain)
        if not group:
            continue
        lines.append(f"## {domain}")
        lines.append("")
        for dtype in INDEX_TYPE_ORDER:
            typed = sorted((d for d in group if d.meta.get("type") == dtype), key=lambda d: str(d.meta.get("id")))
            if not typed:
                continue
            lines.append(f"### {TYPE_LABEL[dtype]}")
            for d in typed:
                mark = "" if d.meta.get("status") == "active" else f"〔{d.meta.get('status')}〕"
                lines.append(f"- [{d.meta.get('title')}]({d.rel}){mark} — {d.meta.get('summary')}")
            lines.append("")
    if len(by_domain) == 0:
        lines.append("(库为空——首轮建库由治理 skill 完成)")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def build_paths_triggers(docs: list[Doc]) -> str:
    glob_map: dict[str, list[str]] = {}
    for d in docs:
        triggers = d.meta.get("triggers")
        if not isinstance(triggers, dict):
            continue
        for g in _as_list(triggers.get("paths")):
            glob_map.setdefault(g, [])
            if d.meta["id"] not in glob_map[g]:
                glob_map[g].append(d.meta["id"])
    payload = {
        "_comment": "生成文件,禁止手写。glob→必读文档id;查询:改动文件命中 glob 即应先读对应卡。",
        "map": [{"glob": g, "docs": sorted(ids)} for g, ids in sorted(glob_map.items())],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def match_paths(changed: list[str], mapping: dict) -> dict[str, list[str]]:
    """供查询模式:改动文件列表 → {文件: [必读文档id]}。"""
    out: dict[str, list[str]] = {}
    for f in changed:
        hits = [d for e in mapping.get("map", []) for d in e["docs"] if fnmatch.fnmatch(f, e["glob"])]
        if hits:
            out[f] = sorted(set(hits))
    return out


# ---------- 主流程 ----------

def collect_docs(issues: list[Issue]) -> list[Doc]:
    docs: list[Doc] = []
    seen_ids: dict[str, str] = {}
    for p in sorted(DOCS_ROOT.rglob("*.md")):
        rel_parts = p.relative_to(DOCS_ROOT).parts
        if rel_parts[0] == "_meta" or p.name in ("INDEX.md", "README.md"):
            continue
        rel = p.relative_to(DOCS_ROOT).as_posix()
        meta = parse_frontmatter(p.read_text(encoding="utf-8"))
        if meta is None:
            issues.append(Issue("error", rel, "frontmatter 缺失或不符合受限子集(见 _meta/schema.md)"))
            continue
        doc = Doc(path=p, meta=meta)
        doc_id = str(meta.get("id", ""))
        if doc_id in seen_ids:
            issues.append(Issue("error", rel, f"id 重复: {doc_id!r} 已被 {seen_ids[doc_id]} 使用"))
        elif doc_id:
            seen_ids[doc_id] = rel
        check_doc(doc, issues)
        docs.append(doc)
    return docs


def main() -> int:
    ap = argparse.ArgumentParser(description="agent_docs 机械体检 + 索引生成")
    ap.add_argument("--check", action="store_true", help="只读门禁模式:不写文件,索引过期算 error")
    ap.add_argument("--paths", nargs="*", metavar="FILE",
                    help="查询模式:传入将改动的文件路径,输出必读文档,不做体检")
    args = ap.parse_args()

    index_path = DOCS_ROOT / "INDEX.md"
    triggers_path = DOCS_ROOT / "paths-triggers.json"

    if args.paths is not None:
        mapping = json.loads(triggers_path.read_text(encoding="utf-8")) if triggers_path.is_file() else {}
        hits = match_paths(args.paths, mapping)
        if not hits:
            print("无命中:这些路径没有登记必读文档。")
        for f, ids in hits.items():
            print(f"{f} → 必读: {', '.join(ids)}")
        return 0

    issues: list[Issue] = []
    docs = collect_docs(issues)
    valid_docs = [d for d in docs if d.meta.get("id") and d.meta.get("domain") in DOMAINS]
    check_inbox({str(d.meta["id"]) for d in valid_docs}, issues)

    new_index = build_index(valid_docs)
    new_triggers = build_paths_triggers(valid_docs)
    if args.check:
        for path, content, label in ((index_path, new_index, "INDEX.md"), (triggers_path, new_triggers, "paths-triggers.json")):
            current = path.read_text(encoding="utf-8") if path.is_file() else ""
            if current != content:
                issues.append(Issue("error", label, "索引与内容不同步(去掉 --check 重生成)"))
    else:
        index_path.write_text(new_index, encoding="utf-8")
        triggers_path.write_text(new_triggers, encoding="utf-8")

    errors = [i for i in issues if i.severity == "error"]
    warns = [i for i in issues if i.severity == "warn"]
    infos = [i for i in issues if i.severity == "info"]
    for i in issues:
        print(f"[{i.severity.upper()}] {i.where}: {i.message}")
    print(f"\n文档 {len(valid_docs)} 篇;error {len(errors)} / warn {len(warns)} / info {len(infos)}"
          + ("(--check 只读)" if args.check else ";索引已重生成"))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
