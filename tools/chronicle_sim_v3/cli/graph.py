"""csim graph *  —  P1 子集：show / validate / format。

编辑命令（add-node / connect / set-param / pack-as-subgraph）留 P2-10。
"""
from __future__ import annotations

import json
from pathlib import Path

import typer

from tools.chronicle_sim_v3.engine.graph import GraphLoader

app = typer.Typer(no_args_is_help=True, help="Graph 文件管理与校验")


def _loader() -> GraphLoader:
    import tools.chronicle_sim_v3.nodes  # noqa: F401  注册

    return GraphLoader()


@app.command("show")
def show_cmd(path: Path = typer.Argument(..., help="graph yaml 路径")) -> None:
    spec = _loader().load(path)
    out = {
        "id": spec.id,
        "title": spec.title,
        "inputs": list(spec.inputs.keys()),
        "outputs": list(spec.outputs.keys()),
        "result": dict(spec.result),
        "nodes": {
            nid: {
                "kind": n.kind,
                "in": list(n.in_.keys()),
                "params": list(n.params.keys()),
            }
            for nid, n in spec.nodes.items()
        },
    }
    typer.echo(json.dumps(out, ensure_ascii=False, indent=2))


@app.command("validate")
def validate_cmd(path: Path = typer.Argument(...)) -> None:
    loader = _loader()
    spec = loader.load(path)
    errors = loader.validate(spec)
    if not errors:
        typer.echo("OK")
        return
    for e in errors:
        typer.echo(f"  - {e}", err=True)
    raise typer.Exit(code=1)


@app.command("format")
def format_cmd(path: Path = typer.Argument(...)) -> None:
    """canonical 重写（幂等）。"""
    loader = _loader()
    spec = loader.load(path)
    loader.write(spec, path)
    typer.echo(f"已规范化写出: {path}")


@app.command("dot")
def dot_cmd(path: Path = typer.Argument(...)) -> None:
    """输出 graphviz dot（节点图）。"""
    spec = _loader().load(path)
    lines = ["digraph G {", "  rankdir=LR;"]
    for nid, n in spec.nodes.items():
        lines.append(f'  "{nid}" [label="{nid}\\n{n.kind}"];')
    from tools.chronicle_sim_v3.engine.graph import _extract_nodes_refs

    for nid, n in spec.nodes.items():
        for src, port in _extract_nodes_refs(n.in_):
            lines.append(f'  "{src}" -> "{nid}" [label="{port}"];')
    lines.append("}")
    typer.echo("\n".join(lines))


# ============================================================================
# 编辑命令
# ============================================================================


@app.command("new")
def new_cmd(
    name: str = typer.Argument(..., help="新 graph id"),
    out: Path = typer.Option(..., "--out", help="目标 yaml 路径"),
) -> None:
    """新建一个空 graph yaml 骨架。"""
    if out.exists():
        typer.echo(f"已存在: {out}", err=True)
        raise typer.Exit(code=1)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        f"schema: chronicle_sim_v3/graph@1\nid: {name}\nspec:\n  nodes: {{}}\n",
        encoding="utf-8",
    )
    typer.echo(f"已创建: {out}")


@app.command("add-node")
def add_node_cmd(
    path: Path = typer.Argument(...),
    kind: str = typer.Option(..., "--kind"),
    nid: str = typer.Option(..., "--id", help="节点 id"),
) -> None:
    """加节点（kind 必须已注册）。"""
    loader = _loader()
    spec = loader.load(path)
    if nid in spec.nodes:
        typer.echo(f"节点 id {nid!r} 已存在", err=True)
        raise typer.Exit(code=1)
    from tools.chronicle_sim_v3.engine.registry import get_node_class

    get_node_class(kind)  # 验证 kind 注册
    from tools.chronicle_sim_v3.engine.graph import NodeRef

    spec.nodes[nid] = NodeRef(kind=kind)
    loader.write(spec, path)
    typer.echo(f"已加节点 {nid} (kind={kind})")


@app.command("remove-node")
def remove_node_cmd(
    path: Path = typer.Argument(...),
    nid: str = typer.Argument(...),
) -> None:
    """删节点。"""
    loader = _loader()
    spec = loader.load(path)
    if nid not in spec.nodes:
        typer.echo(f"节点 {nid!r} 不存在", err=True)
        raise typer.Exit(code=1)
    spec.nodes.pop(nid)
    # 同时清空指向被删节点的 edges
    spec.edges = [e for e in spec.edges if not (e.src.startswith(nid + ".") or e.dst.startswith(nid + "."))]
    loader.write(spec, path)
    typer.echo(f"已删节点 {nid}")


@app.command("connect")
def connect_cmd(
    path: Path = typer.Argument(...),
    src: str = typer.Argument(..., help="src_id.port"),
    dst: str = typer.Argument(..., help="dst_id.port"),
) -> None:
    """连边：把 dst 节点的 in.<port> 设为 ${nodes.src_id.src_port}。"""
    loader = _loader()
    spec = loader.load(path)
    src_id, _, src_port = src.partition(".")
    dst_id, _, dst_port = dst.partition(".")
    if not (src_id and src_port and dst_id and dst_port):
        typer.echo("格式：src_id.port → dst_id.port", err=True)
        raise typer.Exit(code=1)
    if src_id not in spec.nodes:
        typer.echo(f"src 节点不存在: {src_id}", err=True)
        raise typer.Exit(code=1)
    if dst_id not in spec.nodes:
        typer.echo(f"dst 节点不存在: {dst_id}", err=True)
        raise typer.Exit(code=1)
    spec.nodes[dst_id].in_[dst_port] = f"${{nodes.{src_id}.{src_port}}}"
    # edges 表也补一条（去重）
    from tools.chronicle_sim_v3.engine.graph import Edge

    edge = Edge(src=src, dst=dst)
    if edge not in spec.edges:
        spec.edges.append(edge)
    loader.write(spec, path)
    typer.echo(f"已连：{src} → {dst}")


@app.command("disconnect")
def disconnect_cmd(
    path: Path = typer.Argument(...),
    src: str = typer.Argument(...),
    dst: str = typer.Argument(...),
) -> None:
    loader = _loader()
    spec = loader.load(path)
    dst_id, _, dst_port = dst.partition(".")
    if dst_id in spec.nodes and dst_port in spec.nodes[dst_id].in_:
        spec.nodes[dst_id].in_.pop(dst_port)
    spec.edges = [e for e in spec.edges if not (e.src == src and e.dst == dst)]
    loader.write(spec, path)
    typer.echo(f"已断：{src} → {dst}")


@app.command("set-param")
def set_param_cmd(
    path: Path = typer.Argument(...),
    nid: str = typer.Argument(...),
    kv: str = typer.Argument(..., help="key=value，value 自动解析为 int/bool/json"),
) -> None:
    loader = _loader()
    spec = loader.load(path)
    if nid not in spec.nodes:
        typer.echo(f"节点不存在: {nid}", err=True)
        raise typer.Exit(code=1)
    if "=" not in kv:
        typer.echo("格式：key=value", err=True)
        raise typer.Exit(code=1)
    k, _, v = kv.partition("=")
    parsed: object
    if v.lower() in ("true", "false"):
        parsed = v.lower() == "true"
    elif v.lstrip("-").isdigit():
        parsed = int(v)
    else:
        import json as _json

        try:
            parsed = _json.loads(v)
        except Exception:
            parsed = v
    spec.nodes[nid].params[k] = parsed
    loader.write(spec, path)
    typer.echo(f"已设 {nid}.params.{k} = {parsed!r}")


@app.command("set-expr")
def set_expr_cmd(
    path: Path = typer.Argument(...),
    target: str = typer.Argument(..., help="node_id.port"),
    expr: str = typer.Argument(..., help="表达式字符串"),
) -> None:
    """设节点输入端口的表达式（覆盖现有）。"""
    loader = _loader()
    spec = loader.load(path)
    nid, _, port = target.partition(".")
    if not (nid and port):
        typer.echo("格式：node_id.port", err=True)
        raise typer.Exit(code=1)
    if nid not in spec.nodes:
        typer.echo(f"节点不存在: {nid}", err=True)
        raise typer.Exit(code=1)
    spec.nodes[nid].in_[port] = expr
    loader.write(spec, path)
    typer.echo(f"已设 {nid}.in.{port} = {expr!r}")


@app.command("rename")
def rename_cmd(
    path: Path = typer.Argument(...),
    old: str = typer.Argument(...),
    new: str = typer.Argument(...),
) -> None:
    loader = _loader()
    spec = loader.load(path)
    if old not in spec.nodes:
        typer.echo(f"节点不存在: {old}", err=True)
        raise typer.Exit(code=1)
    if new in spec.nodes:
        typer.echo(f"新名已被占用: {new}", err=True)
        raise typer.Exit(code=1)
    spec.nodes[new] = spec.nodes.pop(old)
    # 把所有 ${nodes.old.X} 替换成 ${nodes.new.X}（in_ / params / when）
    import re

    pat = re.compile(r"\$\{\s*nodes\." + re.escape(old) + r"\.")
    rep = "${nodes." + new + "."

    def _sub(value):
        if isinstance(value, str):
            return pat.sub(rep, value)
        if isinstance(value, dict):
            return {k: _sub(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_sub(v) for v in value]
        return value

    for n in spec.nodes.values():
        n.in_ = _sub(n.in_)
        n.params = _sub(n.params)
        if n.when:
            n.when = _sub(n.when)
    spec.edges = [
        type(e)(
            src=e.src.replace(old + ".", new + ".") if e.src.startswith(old + ".") else e.src,
            dst=e.dst.replace(old + ".", new + ".") if e.dst.startswith(old + ".") else e.dst,
        )
        for e in spec.edges
    ]
    loader.write(spec, path)
    typer.echo(f"已重命名 {old} → {new}")


@app.command("pack-as-subgraph")
def pack_as_subgraph_cmd(
    path: Path = typer.Argument(...),
    select: str = typer.Option(..., "--select", help="逗号分隔的 node id 列表"),
    name: str = typer.Option(..., "--name", help="新子图 id（也是文件名）"),
    out_dir: Path = typer.Option(
        Path("data/subgraphs"), "--out-dir",
        help="子图 yaml 输出目录（默认 data/subgraphs）",
    ),
) -> None:
    """把选中节点抽成独立子图 yaml。

    简化版：
    - 把选中节点搬到子图，子图 inputs 暴露所有外部依赖端口
    - 子图 outputs 暴露所有被外部引用的端口
    - 原图替换为一个 flow.subgraph 节点
    """
    loader = _loader()
    spec = loader.load(path)
    selected = [s.strip() for s in select.split(",") if s.strip()]
    missing = [s for s in selected if s not in spec.nodes]
    if missing:
        typer.echo(f"未知节点: {missing}", err=True)
        raise typer.Exit(code=1)
    sel_set = set(selected)

    # 找到外部依赖（被选中节点引用了非选中节点的端口）
    from tools.chronicle_sim_v3.engine.graph import (
        Edge,
        GraphSpec,
        NodeRef,
        _extract_nodes_refs,
    )

    external_inputs: set[tuple[str, str]] = set()  # (src_id, src_port)
    for nid in selected:
        for src, port in _extract_nodes_refs(spec.nodes[nid].in_):
            if src not in sel_set:
                external_inputs.add((src, port))
        for src, port in _extract_nodes_refs(spec.nodes[nid].params):
            if src not in sel_set:
                external_inputs.add((src, port))
    # 找到外部使用（非选中节点引用了选中节点的端口）
    exposed_outputs: set[tuple[str, str]] = set()
    for nid, n in spec.nodes.items():
        if nid in sel_set:
            continue
        for src, port in _extract_nodes_refs(n.in_) + _extract_nodes_refs(n.params):
            if src in sel_set:
                exposed_outputs.add((src, port))
    # 顶层 result 中引用选中节点的也算
    for _, expr in spec.result.items():
        if isinstance(expr, str):
            for src, port in _extract_nodes_refs(expr):
                if src in sel_set:
                    exposed_outputs.add((src, port))

    # 构造子图
    sub_nodes = {nid: spec.nodes[nid] for nid in selected}
    # 子图内部对外部依赖的引用替换为 ${inputs.<unique_name>}
    in_map = {}  # (src_id, port) → input_name
    for i, (src, port) in enumerate(sorted(external_inputs)):
        in_map[(src, port)] = f"in_{src}_{port}"
    if in_map:
        import re

        for n in sub_nodes.values():
            for k, v in list(n.in_.items()):
                if isinstance(v, str):
                    new_v = v
                    for (s, p), ipath in in_map.items():
                        new_v = new_v.replace(f"${{nodes.{s}.{p}}}", f"${{inputs.{ipath}}}")
                    n.in_[k] = new_v
            for k, v in list(n.params.items()):
                if isinstance(v, str):
                    new_v = v
                    for (s, p), ipath in in_map.items():
                        new_v = new_v.replace(f"${{nodes.{s}.{p}}}", f"${{inputs.{ipath}}}")
                    n.params[k] = new_v

    sub_result = {
        f"out_{src}_{port}": f"${{nodes.{src}.{port}}}"
        for src, port in sorted(exposed_outputs)
    }
    sub_spec = GraphSpec(
        **{
            "schema": "chronicle_sim_v3/graph@1",
            "id": name,
            "nodes": sub_nodes,
            "result": sub_result,
        }
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    sub_path = out_dir / f"{name}.yaml"
    loader.write(sub_spec, sub_path)
    typer.echo(f"已写子图: {sub_path}")

    # 在原图：删除选中节点，插入一个 flow.subgraph 节点
    for nid in selected:
        spec.nodes.pop(nid)
    sg_id = f"sub_{name}"
    sg_inputs = {ipath: f"${{nodes.{src}.{port}}}" for (src, port), ipath in in_map.items()}
    spec.nodes[sg_id] = NodeRef(
        kind="flow.subgraph",
        params={"ref": f"${{subgraph:{name}}}", "inputs": sg_inputs},
    )
    # 原图中所有引用 ${nodes.<sel_node>.<port>} 替换为 ${nodes.<sg_id>.out.out_<sel>_<port>}
    import re

    def _rewrite(value):
        if isinstance(value, str):
            for s, p in exposed_outputs:
                value = value.replace(
                    f"${{nodes.{s}.{p}}}",
                    f"${{nodes.{sg_id}.out.out_{s}_{p}}}",
                )
            return value
        if isinstance(value, dict):
            return {k: _rewrite(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_rewrite(v) for v in value]
        return value

    for n in spec.nodes.values():
        if n.kind == "flow.subgraph" and n.params.get("ref") == f"${{subgraph:{name}}}":
            continue
        n.in_ = _rewrite(n.in_)
        n.params = _rewrite(n.params)
    spec.result = {k: _rewrite(v) for k, v in spec.result.items()}
    spec.edges = []  # 简化：edges 表清空，让 GraphLoader 下次自动从 in_ 重建
    loader.write(spec, path)
    typer.echo(f"已替换原图：插入 {sg_id} (flow.subgraph)")
