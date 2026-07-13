#!/usr/bin/env python3
"""GameDraft「JSON=语言」工具链:启动刷新式 schema 生成器。

    python3 tools/json_lang/build.py [--watch] [--validate] [--check]

像 IDE 建索引一样:从权威代码 + 真实数据现场重算,输出
tools/json_lang/out/gamedraft-data.schema.json(生成物,不入库)。
.vscode/settings.json 的 json.schemas 指向该文件;.vscode/tasks.json 在
folderOpen 时以 --watch 常驻 → IDE 开着十天半个月,agent/编辑器改了 JSON
或权威代码,几秒内枚举自动跟上,无对账门、无入库漂移。

--watch     常驻:纯 stdlib mtime 轮询(数据文件+五个权威源),变化→指纹稳定后全量重算
--validate  用 jsonschema(若可用)把全部数据文件过一遍生成的 schema,列出违例
--check     有 tripwire warning 时以非零码退出(权威源形状变化的报警器)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import extract as _extract_mod
    from extract import extract_language_spec
    from id_universes import collect_id_universes
    from lint import lint_dialogue_graphs
    from schema_build import build_schema
else:  # python3 -m tools.json_lang.build
    from . import extract as _extract_mod
    from .extract import extract_language_spec
    from .id_universes import collect_id_universes
    from .lint import lint_dialogue_graphs
    from .schema_build import build_schema

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).resolve().parent / "out"
SCHEMA_NAME = "gamedraft-data.schema.json"

# 与 .vscode/settings.json 的 fileMatch 保持一致
DATA_GLOBS = (
    "public/assets/data/**/*.json",
    "public/assets/scenes/*.json",
    "public/assets/dialogues/graphs/*.json",
)


# watch 模式同时盯权威源:agent 做 L2 加 action / 加条件叶时,schema 跟着刷
AUTHORITY_FILES = (
    _extract_mod.ACTION_EDITOR_PY,
    _extract_mod.ENTITY_REFACTOR_PY,
    _extract_mod.ACTION_MANIFEST_TS,
    _extract_mod.EVAL_CONDITION_TS,
    _extract_mod.TYPES_TS,
)


def _rebuild(root: Path) -> dict:
    """一次全量重算;内容没变不重写(避免语言服务缓存空转),写盘走原子替换。"""
    spec = extract_language_spec(root)
    ud = collect_id_universes(root)
    schema = build_schema(spec, ud)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / SCHEMA_NAME
    text = json.dumps(schema, ensure_ascii=False, indent=2) + "\n"
    if not (out_path.exists() and out_path.read_text(encoding="utf-8") == text):
        tmp = out_path.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, out_path)

    summary = {
        "actionTypes": len(set(spec.action_types) | set(spec.param_manifest)),
        "conditionLeaves": spec.condition_leaves,
        "universes": {k: len(v) for k, v in sorted(ud.ids.items())},
        "labeledUniverses": sorted(ud.labels),
        "actionHostKeys": ud.action_host_keys,
        "warnings": spec.warnings,
    }
    (OUT_DIR / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {"spec": spec, "schema": schema, "summary": summary, "out_path": out_path}


def _fingerprint(root: Path) -> dict[str, tuple[int, int]]:
    """被 watch 文件集的 (mtime_ns, size) 快照;文件增删也会引起快照差异。"""
    fp: dict[str, tuple[int, int]] = {}
    paths: list[Path] = [root / rel for rel in AUTHORITY_FILES]
    for pattern in DATA_GLOBS:
        paths.extend(root.glob(pattern))
    for p in paths:
        try:
            st = p.stat()
            fp[str(p)] = (st.st_mtime_ns, st.st_size)
        except OSError:
            pass  # 轮询间隙被删除——缺席本身就是快照差异
    return fp


def _watch(root: Path, interval: float) -> int:
    fp = _fingerprint(root)
    dirty = False  # 上次重算失败(如权威源改到一半)时保持脏,下一轮继续试
    print(f"[json_lang] watch 中:{len(fp)} 个文件,每 {interval:g}s 轮询(Ctrl+C 退出)")
    while True:
        try:
            time.sleep(interval)
            cur = _fingerprint(root)
            if cur != fp or dirty:
                # 编辑器 save_all/agent 批量写是一波连写:等指纹在两次快扫间稳定再重算
                while True:
                    time.sleep(0.3)
                    nxt = _fingerprint(root)
                    if nxt == cur:
                        break
                    cur = nxt
                fp = cur
                try:
                    r = _rebuild(root)
                    dirty = False
                    stamp = time.strftime("%H:%M:%S")
                    print(f"[json_lang] {stamp} 重算完成 actions={r['summary']['actionTypes']} "
                          f"宇宙非空={sum(1 for n in r['summary']['universes'].values() if n)}")
                    for w in r["spec"].warnings:
                        print(f"[json_lang] WARNING: {w}")
                except Exception as e:  # 半写状态/权威源形状变化:不退出,下轮自动重试
                    dirty = True
                    print(f"[json_lang] 重算失败(保持上一版 schema,下轮重试): {e}")
        except KeyboardInterrupt:
            return 0


def _validate_all(schema: dict, root: Path) -> list[str]:
    try:
        import jsonschema
    except ImportError:
        return ["(跳过:当前 python 环境没有 jsonschema 包;可用 .tools/venv 的解释器跑)"]
    validator = jsonschema.Draft7Validator(schema)
    problems: list[str] = []
    for pattern in DATA_GLOBS:
        for f in sorted(root.glob(pattern)):
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
            except Exception as e:
                problems.append(f"{f.relative_to(root)}: 不是合法 JSON({e})")
                continue
            for err in validator.iter_errors(doc):
                loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
                problems.append(f"{f.relative_to(root)} @ {loc}: {err.message[:160]}")
    return problems


def main(argv: list[str] | None = None) -> int:
    # watch 日志重定向到文件/管道时也要即时可见(块缓冲会让日志迟到几 KB)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=REPO_ROOT)
    ap.add_argument("--watch", action="store_true", help="常驻轮询,数据/权威源变化时自动重算")
    ap.add_argument("--interval", type=float, default=2.0, help="watch 轮询间隔秒数(默认 2)")
    ap.add_argument("--validate", action="store_true", help="用生成的 schema 校验全部数据文件")
    ap.add_argument("--lint", action="store_true", help="对话图连边 lint(悬垂=error/不可达=warning),有 error 退出码非零")
    ap.add_argument("--check", action="store_true", help="有 tripwire warning 时退出码非零")
    args = ap.parse_args(argv)
    if args.watch and (args.validate or args.check or args.lint):
        ap.error("--watch 与 --validate/--lint/--check 互斥(校验请用一次性运行)")
    root: Path = args.root

    r = _rebuild(root)
    spec, schema, summary = r["spec"], r["schema"], r["summary"]

    print(f"[json_lang] schema → {r['out_path'].relative_to(root)}")
    print(f"[json_lang] actions={summary['actionTypes']} 条件叶={len(spec.condition_leaves)} "
          f"宇宙非空={sum(1 for n in summary['universes'].values() if n)}/{len(summary['universes'])}")
    for w in spec.warnings:
        print(f"[json_lang] WARNING: {w}")

    if args.watch:
        return _watch(root, max(0.5, args.interval))

    if args.validate:
        problems = _validate_all(schema, root)
        if problems:
            print(f"[json_lang] 校验发现 {len(problems)} 处:")
            for p in problems:
                print(f"  - {p}")
        else:
            print("[json_lang] 全部数据文件通过 schema 校验")

    exit_code = 0
    if args.lint:
        lint_issues = lint_dialogue_graphs(root)
        if lint_issues:
            print(f"[json_lang] 对话图 lint 发现 {len(lint_issues)} 处:")
            for it in lint_issues:
                print(f"  - [{it.severity}] {it.file}: {it.message}")
            if any(it.severity == "error" for it in lint_issues):
                exit_code = 1
        else:
            print("[json_lang] 对话图连边 lint 全部通过")

    if args.check and spec.warnings:
        exit_code = 1
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
