from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote


HOST_VERSION = "0.3"

DEFAULT_APPS: list[dict[str, Any]] = [
    {
        "id": "governance-core",
        "label": "Governance Core",
        "kind": "builtin",
        "status": "ready",
        "description": "治理包、审计统计、资源索引和 prompt 模板。",
        "tools": ["governance.scan", "governance.read_resource", "governance.quote_selection"],
        "resources": ["governance://audit/stats", "governance://workpacks"],
        "defaultEnabled": True,
    },
    {
        "id": "source-browser",
        "label": "Source Browser",
        "kind": "builtin",
        "status": "ready",
        "description": "按 path:line 打开源码、skill、workflow 和 agent 证据。",
        "tools": ["governance.open_source", "governance.read_file"],
        "resources": ["governance://artifacts", "governance://issues"],
        "defaultEnabled": True,
    },
    {
        "id": "patch-gate",
        "label": "Patch Gate",
        "kind": "builtin",
        "status": "guarded",
        "description": "写入、补丁、回滚和人工审批边界。",
        "tools": ["governance.propose_patch", "governance.apply_patch", "governance.create_checkpoint"],
        "resources": ["governance://policy/write-gates"],
        "defaultEnabled": True,
    },
    {
        "id": "agent-runner",
        "label": "Agent Runner",
        "kind": "builtin",
        "status": "ready",
        "description": "Codex、Claude、Local agent session 的启动、流式输出和审计刷新。",
        "tools": ["governance.run_agent", "governance.read_job", "governance.cancel_job"],
        "resources": ["governance://agent/jobs"],
        "defaultEnabled": True,
    },
    {
        "id": "app-registry",
        "label": "App Registry",
        "kind": "builtin",
        "status": "ready",
        "description": "把外部 MCP server、命令或 URL 注册成治理台应用。",
        "tools": ["governance.list_apps", "governance.add_app", "governance.enable_app"],
        "resources": ["governance://apps"],
        "defaultEnabled": True,
    },
]


def build_governance_hub(
    root: Path,
    registry: dict[str, Any],
    payload: dict[str, Any] | None = None,
    jobs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = payload if isinstance(payload, dict) else {}
    app_state = load_app_state(root)
    apps = _apps_with_state(app_state)
    enabled_app_ids = [app["id"] for app in apps if app.get("enabled")]
    canvas_state = _canvas_state(registry, payload)
    tools = _tools(enabled_app_ids)
    prompts = _prompts(registry)
    resources = _resources(registry, canvas_state, jobs or {}, apps, tools, prompts)
    return {
        "kind": "gamedraft.governance.host",
        "version": HOST_VERSION,
        "host": {
            "role": "mcp-host",
            "name": "GameDraft Skill/Workflow Governance Canvas",
            "workspace": str(root.resolve()),
            "api": {
                "hub": "/api/governance/hub",
                "apps": "/api/governance/apps",
                "jobs": "/api/governance/job",
                "runAgent": "/api/governance/run",
                "source": "/governance/source",
            },
            "contract": [
                "Agent sees this hub snapshot as its structured workspace context.",
                "Resources are stable IDs for governance data, not screenshots.",
                "Write tools require explicit runMode=fix and host-side audit refresh.",
                "External apps are registered here before an agent can rely on them.",
            ],
        },
        "canvas": canvas_state,
        "apps": apps,
        "enabledApps": enabled_app_ids,
        "resources": resources,
        "tools": tools,
        "prompts": prompts,
        "jobSummary": _job_summary(jobs or {}),
    }


def compact_hub_for_prompt(hub: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": hub.get("kind"),
        "version": hub.get("version"),
        "host": hub.get("host"),
        "canvas": hub.get("canvas"),
        "enabled_apps": [
            {
                "id": app.get("id"),
                "label": app.get("label"),
                "kind": app.get("kind"),
                "status": app.get("status"),
                "description": app.get("description"),
                "tools": app.get("tools", []),
            }
            for app in hub.get("apps", [])
            if isinstance(app, dict) and app.get("enabled")
        ],
        "resources": [
            {
                "uri": item.get("uri"),
                "title": item.get("title"),
                "kind": item.get("kind"),
                "summary": item.get("summary"),
                "count": item.get("count"),
            }
            for item in hub.get("resources", [])
            if isinstance(item, dict)
        ],
        "tools": [
            {
                "name": item.get("name"),
                "title": item.get("title"),
                "sideEffect": item.get("sideEffect"),
                "requiresApproval": item.get("requiresApproval"),
                "description": item.get("description"),
            }
            for item in hub.get("tools", [])
            if isinstance(item, dict)
        ],
        "prompts": [
            {
                "name": item.get("name"),
                "title": item.get("title"),
                "description": item.get("description"),
            }
            for item in hub.get("prompts", [])
            if isinstance(item, dict)
        ],
    }


def load_app_state(root: Path) -> dict[str, Any]:
    path = _app_state_path(root)
    default_enabled = [app["id"] for app in DEFAULT_APPS if app.get("defaultEnabled")]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"enabled": default_enabled, "custom": []}
    enabled = data.get("enabled") if isinstance(data.get("enabled"), list) else default_enabled
    custom = data.get("custom") if isinstance(data.get("custom"), list) else []
    return {"enabled": [str(item) for item in enabled], "custom": [item for item in custom if isinstance(item, dict)]}


def update_app_state(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    state = load_app_state(root)
    enabled = set(state["enabled"])
    custom = list(state["custom"])
    action = str(payload.get("action") or "").strip().lower()
    app_id = str(payload.get("id") or "").strip()

    if action == "enable" and app_id:
        enabled.add(app_id)
    elif action == "disable" and app_id:
        enabled.discard(app_id)
    elif action == "remove" and app_id:
        enabled.discard(app_id)
        custom = [app for app in custom if str(app.get("id") or "") != app_id]
    elif action == "add":
        app = _custom_app_from_payload(payload)
        if app:
            custom = [item for item in custom if str(item.get("id") or "") != app["id"]]
            custom.append(app)
            enabled.add(app["id"])

    state = {"enabled": sorted(enabled), "custom": custom}
    _save_app_state(root, state)
    return state


def _apps_with_state(state: dict[str, Any]) -> list[dict[str, Any]]:
    enabled = set(state.get("enabled") or [])
    apps: list[dict[str, Any]] = []
    for app in DEFAULT_APPS:
        item = dict(app)
        item["source"] = "builtin"
        item["enabled"] = item["id"] in enabled
        apps.append(item)
    for app in state.get("custom") or []:
        item = dict(app)
        item.setdefault("kind", "mcp")
        item.setdefault("status", "registered")
        item.setdefault("tools", [])
        item.setdefault("resources", [])
        item["source"] = "custom"
        item["enabled"] = str(item.get("id") or "") in enabled
        apps.append(item)
    return apps


def _canvas_state(registry: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    raw_canvas = payload.get("canvasState")
    canvas = raw_canvas if isinstance(raw_canvas, dict) else {}
    selected_refs = payload.get("references")
    if not isinstance(selected_refs, list):
        selected_refs = canvas.get("selectedRefs")
    if not isinstance(selected_refs, list):
        selected_refs = []
    stats = registry.get("stats") if isinstance(registry.get("stats"), dict) else {}
    return {
        "selectedRefs": selected_refs[:20],
        "provider": str(canvas.get("provider") or payload.get("provider") or ""),
        "runMode": str(payload.get("runMode") or canvas.get("runMode") or "chat"),
        "focusedResource": str(canvas.get("focusedResource") or ""),
        "filters": canvas.get("filters") if isinstance(canvas.get("filters"), dict) else {},
        "visibleView": str(canvas.get("visibleView") or "workpacks"),
        "stats": stats,
        "workpackCount": len(registry.get("workpacks") or []),
        "issueCount": int(stats.get("issue_count") or 0),
        "artifactCount": int(stats.get("artifact_count") or 0),
    }


def _resources(
    registry: dict[str, Any],
    canvas: dict[str, Any],
    jobs: dict[str, Any],
    apps: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    prompts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    workpacks = registry.get("workpacks") if isinstance(registry.get("workpacks"), list) else []
    issues = registry.get("issues") if isinstance(registry.get("issues"), list) else []
    artifacts = registry.get("artifacts") if isinstance(registry.get("artifacts"), list) else []
    stats = canvas.get("stats") if isinstance(canvas.get("stats"), dict) else {}
    resources: list[dict[str, Any]] = [
        {
            "uri": "governance://hub",
            "kind": "host",
            "title": "治理台 Host 快照",
            "summary": "完整 MCP Host / Agent Workbench 快照。",
            "count": 1,
        },
        {
            "uri": "governance://canvas/current",
            "kind": "canvas",
            "title": "当前画布状态",
            "summary": f"{len(canvas.get('selectedRefs') or [])} 个引用，视图 {canvas.get('visibleView')}",
            "count": len(canvas.get("selectedRefs") or []),
            "payload": canvas,
        },
        {
            "uri": "governance://audit/stats",
            "kind": "audit",
            "title": "审计统计",
            "summary": f"{canvas.get('artifactCount')} 个资产，{canvas.get('issueCount')} 个问题",
            "count": canvas.get("issueCount"),
            "payload": canvas.get("stats") or {},
        },
        {
            "uri": "governance://dashboard/elements",
            "kind": "element-index",
            "title": "页面元素引用索引",
            "summary": "dashboard 中所有可引用的数据元素和面板入口。",
            "count": (
                6 + len(workpacks) + len(issues) + len(artifacts)
                + len(apps) + len(tools) + len(prompts)
            ),
        },
        {
            "uri": "governance://workpacks",
            "kind": "workpack-index",
            "title": "治理包索引",
            "summary": f"{len(workpacks)} 个治理包",
            "count": len(workpacks),
        },
        {
            "uri": "governance://issues",
            "kind": "issue-index",
            "title": "证据库",
            "summary": f"{len(issues)} 条原始证据",
            "count": len(issues),
        },
        {
            "uri": "governance://artifacts",
            "kind": "artifact-index",
            "title": "资产清单",
            "summary": f"{len(artifacts)} 个 skill/workflow/agent 资产",
            "count": len(artifacts),
        },
        {
            "uri": "governance://apps",
            "kind": "app-index",
            "title": "治理台应用",
            "summary": "已注册的内置应用和外部 MCP/命令应用。",
            "count": len(apps),
        },
        {
            "uri": "governance://tools",
            "kind": "tool-index",
            "title": "治理台工具",
            "summary": "Host 暴露给 agent 的工具清单。",
            "count": len(tools),
        },
        {
            "uri": "governance://prompts",
            "kind": "prompt-index",
            "title": "治理台提示词",
            "summary": "Host 暴露给 agent 的 prompt 模板。",
            "count": len(prompts),
        },
        {
            "uri": "governance://agent/jobs",
            "kind": "job-index",
            "title": "Agent 运行记录",
            "summary": f"{len(jobs)} 个当前 console 内存中的 agent job",
            "count": len(jobs),
        },
        {
            "uri": "governance://policy/write-gates",
            "kind": "policy",
            "title": "写入权限和审批边界",
            "summary": "chat 为只读；fix 才允许写入；修复后必须自动审计。",
            "count": 3,
        },
    ]
    view_specs = [
        ("mcp-install", "MCP 安装区", "安装命令、客户端配置和 MCP 自检状态。"),
        ("cards", "统计卡片区", "页面顶部统计卡片。"),
        ("workpacks", "治理包区", "按优先级分组的可执行治理包。"),
        ("issues", "证据库区", "原始 issue / evidence 列表。"),
        ("artifacts", "资产清单区", "扫描到的 skill / workflow / script 资产。"),
    ]
    for view_id, title, summary in view_specs:
        resources.append(
            {
                "uri": f"governance://view/{_uri_part(view_id)}",
                "kind": "view",
                "title": title,
                "summary": summary,
                "count": 1,
            }
        )
    card_specs = [
        ("workpack-count", "治理包数量", len(workpacks)),
        ("issue-count", "证据项数量", stats.get("issue_count", len(issues))),
        ("error-count", "断链/错误数量", (stats.get("by_severity") or {}).get("error", 0) if isinstance(stats.get("by_severity"), dict) else 0),
        ("warn-count", "需复核数量", (stats.get("by_severity") or {}).get("warn", 0) if isinstance(stats.get("by_severity"), dict) else 0),
    ]
    for stat_id, title, value in card_specs:
        resources.append(
            {
                "uri": f"governance://stat/{_uri_part(stat_id)}",
                "kind": "stat",
                "title": title,
                "summary": str(value),
                "count": int(value or 0) if isinstance(value, (int, float)) else 0,
                "payload": {"id": stat_id, "value": value},
            }
        )
    for pack in workpacks:
        if not isinstance(pack, dict):
            continue
        resources.append(
            {
                "uri": f"governance://workpack/{_uri_part(pack.get('id'))}",
                "kind": "workpack",
                "title": str(pack.get("title") or pack.get("id") or ""),
                "summary": str(pack.get("summary") or ""),
                "count": int(pack.get("issue_count") or 0),
                "priority": pack.get("priority"),
            }
        )
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        loc = f"{issue.get('path')}:{issue.get('line')}" if issue.get("line") else str(issue.get("path") or "")
        resources.append(
            {
                "uri": f"governance://issue/{_uri_part(issue.get('id'))}",
                "kind": "issue",
                "title": str(issue.get("title") or issue.get("id") or ""),
                "summary": loc,
                "count": 1,
                "severity": issue.get("severity"),
                "category": issue.get("category"),
            }
        )
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        resources.append(
            {
                "uri": f"governance://artifact/{_uri_part(artifact.get('id'))}",
                "kind": "artifact",
                "title": str(artifact.get("title") or artifact.get("id") or ""),
                "summary": str(artifact.get("path") or ""),
                "count": 1,
                "artifactType": artifact.get("type"),
            }
        )
    source_paths: set[str] = set()
    for artifact in artifacts:
        if isinstance(artifact, dict) and artifact.get("path"):
            source_paths.add(str(artifact.get("path") or ""))
    for issue in issues:
        if isinstance(issue, dict) and issue.get("path"):
            source_paths.add(str(issue.get("path") or ""))
    for pack in workpacks:
        if not isinstance(pack, dict):
            continue
        for path in pack.get("paths") or []:
            if path:
                source_paths.add(str(path))
    for path in sorted(source_paths):
        resources.append(
            {
                "uri": f"governance://source/{_uri_part(path)}",
                "kind": "source",
                "title": path,
                "summary": "项目内源码/文档路径。",
                "count": 1,
                "path": path,
            }
        )
    for app in apps:
        if not isinstance(app, dict):
            continue
        resources.append(
            {
                "uri": f"governance://app/{_uri_part(app.get('id'))}",
                "kind": "app",
                "title": str(app.get("label") or app.get("id") or ""),
                "summary": str(app.get("description") or app.get("endpoint") or ""),
                "count": 1,
                "enabled": bool(app.get("enabled")),
            }
        )
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        resources.append(
            {
                "uri": f"governance://tool/{_uri_part(tool.get('name'))}",
                "kind": "tool",
                "title": str(tool.get("title") or tool.get("name") or ""),
                "summary": str(tool.get("description") or ""),
                "count": 1,
                "sideEffect": tool.get("sideEffect"),
                "requiresApproval": bool(tool.get("requiresApproval")),
            }
        )
    for prompt in prompts:
        if not isinstance(prompt, dict):
            continue
        resources.append(
            {
                "uri": f"governance://prompt/{_uri_part(prompt.get('name'))}",
                "kind": "prompt",
                "title": str(prompt.get("title") or prompt.get("name") or ""),
                "summary": str(prompt.get("description") or ""),
                "count": 1,
            }
        )
    for resource in resources:
        if resource.get("uri") == "governance://dashboard/elements":
            resource["count"] = len(resources)
            resource["summary"] = f"dashboard 中 {len(resources)} 个可引用的数据元素和面板入口。"
            break
    return resources


def _uri_part(value: object) -> str:
    return quote(str(value or "").strip(), safe="")


def _tools(enabled_app_ids: list[str]) -> list[dict[str, Any]]:
    tools = [
        ("governance.scan", "重新审计", "read", False, "重新生成 registry/report/dashboard。", "governance-core"),
        ("governance.read_resource", "读取资源", "read", False, "按 governance:// URI 读取结构化资源。", "governance-core"),
        ("governance.quote_selection", "引用选区", "read", False, "把当前选中的治理包/证据加入 agent 上下文。", "governance-core"),
        ("governance.open_source", "打开源码", "read", False, "按 path:line 打开源文件证据。", "source-browser"),
        ("governance.read_file", "读取文件", "read", False, "读取项目内文件片段。", "source-browser"),
        ("governance.propose_patch", "生成补丁方案", "write-plan", False, "只生成可审阅补丁计划，不写文件。", "patch-gate"),
        ("governance.apply_patch", "应用补丁", "write", True, "写入项目文件；需要 fix 模式和用户意图。", "patch-gate"),
        ("governance.create_checkpoint", "创建检查点", "write", True, "记录修复前状态，便于回看和回滚。", "patch-gate"),
        ("governance.run_agent", "启动 Agent", "process", True, "启动 Codex/Claude/Local session。", "agent-runner"),
        ("governance.read_job", "读取 Job", "read", False, "读取 agent stdout/stderr、状态和结果。", "agent-runner"),
        ("governance.cancel_job", "取消 Job", "process", True, "停止正在运行的 agent job。", "agent-runner"),
        ("governance.list_apps", "列出应用", "read", False, "列出治理台可用应用。", "app-registry"),
        ("governance.add_app", "添加应用", "write", True, "注册外部 MCP server、命令或 URL。", "app-registry"),
        ("governance.enable_app", "启用应用", "write", False, "让应用进入 agent 可感知上下文。", "app-registry"),
    ]
    enabled = set(enabled_app_ids)
    return [
        {
            "name": name,
            "title": title,
            "sideEffect": side_effect,
            "requiresApproval": approval,
            "description": description,
            "app": app,
            "enabled": app in enabled,
        }
        for name, title, side_effect, approval, description, app in tools
    ]


def _prompts(registry: dict[str, Any]) -> list[dict[str, Any]]:
    prompts = [
        {
            "name": "governance.triage",
            "title": "治理总览",
            "description": "基于当前画布解释优先级、风险和执行顺序。",
            "message": "基于当前画布，把治理包按优先级拆成可执行顺序。",
        },
        {
            "name": "governance.auto-vs-confirm",
            "title": "自动/确认分流",
            "description": "区分哪些可以自动修，哪些必须人工确认。",
            "message": "按当前引用区分：能自动修的、必须确认的、应该暂缓的。",
        },
        {
            "name": "governance.fix-plan",
            "title": "修复计划",
            "description": "生成 fix 模式可执行计划，包含验证命令。",
            "message": "为当前引用生成修复计划，要求最小改动并运行审计验证。",
        },
    ]
    workpacks = registry.get("workpacks") if isinstance(registry.get("workpacks"), list) else []
    for pack in workpacks[:6]:
        if not isinstance(pack, dict):
            continue
        prompts.append(
            {
                "name": f"governance.workpack.{pack.get('id')}",
                "title": str(pack.get("title") or pack.get("id") or ""),
                "description": str(pack.get("next") or pack.get("summary") or ""),
                "message": str(pack.get("agent_prompt") or ""),
                "ref": {"type": "workpack", "id": str(pack.get("id") or "")},
            }
        )
    return prompts


def _job_summary(jobs: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for job_id, job in list(jobs.items())[-8:]:
        rows.append(
            {
                "id": job_id,
                "provider": getattr(job, "provider", ""),
                "runMode": getattr(job, "run_mode", ""),
                "status": getattr(job, "status", ""),
                "startedAt": getattr(job, "started_at", ""),
                "endedAt": getattr(job, "ended_at", ""),
                "stdoutHref": getattr(job, "stdout_href", ""),
            }
        )
    return rows


def _custom_app_from_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    label = str(payload.get("label") or payload.get("name") or "").strip()
    endpoint = str(payload.get("endpoint") or payload.get("command") or payload.get("url") or "").strip()
    if not label or not endpoint:
        return None
    app_id = str(payload.get("id") or "").strip() or "custom-" + _slug(label)
    return {
        "id": app_id,
        "label": label,
        "kind": str(payload.get("kind") or "mcp").strip() or "mcp",
        "status": "registered",
        "description": str(payload.get("description") or endpoint).strip(),
        "endpoint": endpoint,
        "tools": [],
        "resources": [],
        "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or str(int(time.time()))


def _app_state_path(root: Path) -> Path:
    return root / "tools" / "skill_workflow_governance" / "out" / "apps.json"


def _save_app_state(root: Path, state: dict[str, Any]) -> None:
    path = _app_state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
