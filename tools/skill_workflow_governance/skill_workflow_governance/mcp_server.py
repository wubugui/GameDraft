from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from .hub import build_governance_hub, load_app_state, update_app_state


PROTOCOL_VERSION = "2025-03-26"


def main(argv: list[str] | None = None) -> int:
    root = Path(argv[0]).resolve() if argv else Path.cwd().resolve()
    server = GovernanceMcpServer(root)
    return server.serve()


class GovernanceMcpServer:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def serve(self) -> int:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError as exc:
                self._write_error(None, -32700, f"Invalid JSON: {exc}")
                continue
            if isinstance(message, list):
                for item in message:
                    self._handle_message(item)
            else:
                self._handle_message(message)
        return 0

    def _handle_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            self._write_error(None, -32600, "Invalid request")
            return
        request_id = message.get("id")
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if request_id is None:
            return
        try:
            result = self._dispatch(method, params)
        except Exception as exc:  # noqa: BLE001 - MCP errors must stay on stdout as JSON-RPC.
            self._write_error(request_id, -32000, str(exc))
            return
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "initialize":
            return {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "resources": {"listChanged": True},
                    "tools": {"listChanged": True},
                    "prompts": {"listChanged": True},
                },
                "serverInfo": {"name": "gamedraft-governance", "version": "0.3"},
            }
        if method == "ping":
            return {}
        if method == "resources/list":
            hub = self._hub()
            return {
                "resources": [
                    {
                        "uri": str(resource.get("uri") or ""),
                        "name": str(resource.get("title") or resource.get("uri") or ""),
                        "description": str(resource.get("summary") or ""),
                        "mimeType": "application/json",
                    }
                    for resource in hub.get("resources", [])
                    if isinstance(resource, dict)
                ]
            }
        if method == "resources/templates/list":
            return {
                "resourceTemplates": [
                    {
                        "uriTemplate": "governance://source/{path}",
                        "name": "Project source path",
                        "description": "Read a project file/path as a governance source element, including related issues, workpacks, artifacts, and recommended follow-up resources.",
                        "mimeType": "application/json",
                    },
                    {
                        "uriTemplate": "governance://workpack/{id}",
                        "name": "Governance workpack",
                        "description": "Read one executable governance workpack by id.",
                        "mimeType": "application/json",
                    },
                    {
                        "uriTemplate": "governance://issue/{id}",
                        "name": "Governance issue",
                        "description": "Read one audit issue/evidence item by id.",
                        "mimeType": "application/json",
                    },
                    {
                        "uriTemplate": "governance://artifact/{id}",
                        "name": "Governance artifact",
                        "description": "Read one scanned skill/workflow/agent artifact by id.",
                        "mimeType": "application/json",
                    },
                ]
            }
        if method == "resources/read":
            uri = str(params.get("uri") or "")
            return {"contents": [{"uri": uri, "mimeType": "application/json", "text": self._resource_text(uri)}]}
        if method == "tools/list":
            hub = self._hub()
            return {
                "tools": [
                    {
                        "name": str(tool.get("name") or ""),
                        "description": str(tool.get("description") or tool.get("title") or ""),
                        "inputSchema": _tool_schema(str(tool.get("name") or "")),
                    }
                    for tool in hub.get("tools", [])
                    if isinstance(tool, dict) and tool.get("enabled")
                ]
            }
        if method == "tools/call":
            return self._call_tool(str(params.get("name") or ""), params.get("arguments") if isinstance(params.get("arguments"), dict) else {})
        if method == "prompts/list":
            hub = self._hub()
            return {
                "prompts": [
                    {
                        "name": str(prompt.get("name") or ""),
                        "description": str(prompt.get("description") or prompt.get("title") or ""),
                    }
                    for prompt in hub.get("prompts", [])
                    if isinstance(prompt, dict)
                ]
            }
        if method == "prompts/get":
            name = str(params.get("name") or "")
            prompt = self._find_prompt(name)
            return {
                "description": str(prompt.get("description") or prompt.get("title") or name),
                "messages": [
                    {
                        "role": "user",
                        "content": {"type": "text", "text": str(prompt.get("message") or prompt.get("description") or "")},
                    }
                ],
            }
        raise ValueError(f"Unsupported MCP method: {method}")

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name == "governance.scan":
            script = self.root / "tools" / "skill_workflow_governance" / "govern.py"
            result = subprocess.run(
                [sys.executable, str(script), "audit"],
                cwd=str(self.root),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
            text = (result.stdout or "") + (result.stderr or "")
            return _tool_text({"exitCode": result.returncode, "output": text})
        if name == "governance.read_resource":
            return _tool_text(json.loads(self._resource_text(str(arguments.get("uri") or "governance://hub"))))
        if name == "governance.list_apps":
            return _tool_text({"apps": self._hub().get("apps", [])})
        if name in {"governance.add_app", "governance.enable_app"}:
            payload = dict(arguments)
            if name == "governance.enable_app" and "action" not in payload:
                payload["action"] = "enable"
            if name == "governance.add_app" and "action" not in payload:
                payload["action"] = "add"
            state = update_app_state(self.root, payload)
            return _tool_text({"state": state, "apps": self._hub().get("apps", [])})
        raise ValueError(f"Tool is not implemented by this MCP server: {name}")

    def _resource_text(self, uri: str) -> str:
        registry = self._registry()
        hub = build_governance_hub(self.root, registry)
        if uri in {"", "governance://hub"}:
            return json.dumps(hub, ensure_ascii=False, indent=2)
        if uri == "governance://dashboard/elements":
            return json.dumps({"elements": hub.get("resources", [])}, ensure_ascii=False, indent=2)
        if uri == "governance://audit/stats":
            return json.dumps(registry.get("stats") or {}, ensure_ascii=False, indent=2)
        if uri == "governance://workpacks":
            return json.dumps({"workpacks": registry.get("workpacks", [])}, ensure_ascii=False, indent=2)
        if uri == "governance://issues":
            return json.dumps({"issues": registry.get("issues", [])}, ensure_ascii=False, indent=2)
        if uri == "governance://artifacts":
            return json.dumps({"artifacts": registry.get("artifacts", [])}, ensure_ascii=False, indent=2)
        if uri == "governance://tools":
            return json.dumps({"tools": hub.get("tools", [])}, ensure_ascii=False, indent=2)
        if uri == "governance://prompts":
            return json.dumps({"prompts": hub.get("prompts", [])}, ensure_ascii=False, indent=2)
        if uri == "governance://apps":
            return json.dumps({"state": load_app_state(self.root), "apps": hub.get("apps", [])}, ensure_ascii=False, indent=2)
        if uri.startswith("governance://workpack/"):
            pack_id = _uri_tail(uri)
            for pack in registry.get("workpacks", []):
                if isinstance(pack, dict) and str(pack.get("id") or "") == pack_id:
                    return json.dumps(pack, ensure_ascii=False, indent=2)
        if uri.startswith("governance://issue/"):
            issue_id = _uri_tail(uri)
            item = _find_by_id(registry.get("issues", []), issue_id)
            if item is not None:
                return json.dumps(item, ensure_ascii=False, indent=2)
        if uri.startswith("governance://artifact/"):
            artifact_id = _uri_tail(uri)
            item = _find_by_id(registry.get("artifacts", []), artifact_id)
            if item is not None:
                return json.dumps(item, ensure_ascii=False, indent=2)
        if uri.startswith("governance://app/"):
            app_id = _uri_tail(uri)
            item = _find_by_id(hub.get("apps", []), app_id)
            if item is not None:
                return json.dumps(item, ensure_ascii=False, indent=2)
        if uri.startswith("governance://tool/"):
            name = _uri_tail(uri)
            item = _find_by_key(hub.get("tools", []), "name", name)
            if item is not None:
                return json.dumps(item, ensure_ascii=False, indent=2)
        if uri.startswith("governance://prompt/"):
            name = _uri_tail(uri)
            item = _find_by_key(hub.get("prompts", []), "name", name)
            if item is not None:
                return json.dumps(item, ensure_ascii=False, indent=2)
        if uri.startswith("governance://source/"):
            return json.dumps(_source_payload(self.root, _uri_tail(uri), registry), ensure_ascii=False, indent=2)
        if uri.startswith("governance://stat/") or uri.startswith("governance://view/"):
            for resource in hub.get("resources", []):
                if isinstance(resource, dict) and resource.get("uri") == uri:
                    return json.dumps(resource, ensure_ascii=False, indent=2)
        for resource in hub.get("resources", []):
            if isinstance(resource, dict) and resource.get("uri") == uri:
                return json.dumps(resource, ensure_ascii=False, indent=2)
        raise ValueError(f"Unknown resource: {uri}")

    def _find_prompt(self, name: str) -> dict[str, Any]:
        for prompt in self._hub().get("prompts", []):
            if isinstance(prompt, dict) and prompt.get("name") == name:
                return prompt
        raise ValueError(f"Unknown prompt: {name}")

    def _hub(self) -> dict[str, Any]:
        return build_governance_hub(self.root, self._registry())

    def _registry(self) -> dict[str, Any]:
        path = self.root / "tools" / "skill_workflow_governance" / "out" / "registry.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, payload: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def _write_error(self, request_id: Any, code: int, message: str) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def _tool_text(value: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2)}]}


def _uri_tail(uri: str) -> str:
    return unquote(uri.rsplit("/", 1)[-1])


def _find_by_id(rows: object, item_id: str) -> dict[str, Any] | None:
    return _find_by_key(rows, "id", item_id)


def _find_by_key(rows: object, key: str, value: str) -> dict[str, Any] | None:
    if not isinstance(rows, list):
        return None
    for row in rows:
        if isinstance(row, dict) and str(row.get(key) or "") == value:
            return row
    return None


def _source_payload(root: Path, rel_path: str, registry: dict[str, Any] | None = None) -> dict[str, Any]:
    registry = registry if isinstance(registry, dict) else {}
    source_uri = _resource_uri("source", rel_path)
    issues = [
        issue
        for issue in registry.get("issues", [])
        if isinstance(issue, dict) and str(issue.get("path") or "") == rel_path
    ]
    artifacts = [
        artifact
        for artifact in registry.get("artifacts", [])
        if isinstance(artifact, dict) and str(artifact.get("path") or "") == rel_path
    ]
    issue_ids = {str(issue.get("id") or "") for issue in issues}
    workpacks: list[dict[str, Any]] = []
    for pack in registry.get("workpacks", []):
        if not isinstance(pack, dict):
            continue
        paths = pack.get("paths") if isinstance(pack.get("paths"), list) else []
        pack_issue_ids = pack.get("issue_ids") if isinstance(pack.get("issue_ids"), list) else []
        if rel_path in {str(path) for path in paths} or issue_ids.intersection(str(item) for item in pack_issue_ids):
            workpacks.append(_compact_workpack(pack))
    summary = (
        f"Governance source path with {len(issues)} issue(s), "
        f"{len(workpacks)} workpack(s), and {len(artifacts)} artifact(s)."
    )
    if not issues and not workpacks and not artifacts:
        summary = "Project source path with no current audit relationships."
    payload: dict[str, Any] = {
        "uri": source_uri,
        "kind": "source",
        "title": rel_path,
        "summary": summary,
        "path": rel_path,
        "root": str(root),
        "exists": False,
        "registryGeneratedAt": registry.get("generated_at"),
        "agentUse": {
            "whenPastedAlone": (
                "Interpret this URI as a governance dashboard source element. "
                "Explain what file/path it points to, why it appears in the audit, "
                "which issues/workpacks reference it, and what the likely next action is."
            ),
            "recommendedFlow": [
                "Read this source resource first.",
                "Read related.workpacks[*].uri for the executable governance context.",
                "Read related.issues[*].uri for exact evidence.",
                "Do not modify files unless the user explicitly asks for fix work.",
                "After fixes, rerun python3 -B tools/skill_workflow_governance/govern.py audit.",
            ],
            "fallbackFiles": [
                "tools/skill_workflow_governance/out/agent-context-current.md",
                "tools/skill_workflow_governance/out/registry.json",
            ],
        },
    }
    next_resources: list[dict[str, str]] = [
        {
            "uri": "governance://hub",
            "reason": "Read the overall governance host contract and available resources.",
        },
        {
            "uri": "governance://dashboard/elements",
            "reason": "Find all dashboard elements that can be referenced by URI.",
        },
    ]
    next_resources.extend(
        {"uri": str(pack.get("uri") or ""), "reason": "Read the related executable governance workpack."}
        for pack in workpacks[:10]
        if pack.get("uri")
    )
    next_resources.extend(
        {"uri": _resource_uri("issue", issue.get("id")), "reason": "Read exact audit evidence for this source path."}
        for issue in issues[:20]
        if issue.get("id")
    )
    next_resources.extend(
        {"uri": _resource_uri("artifact", artifact.get("id")), "reason": "Read the scanned governance artifact metadata."}
        for artifact in artifacts[:5]
        if artifact.get("id")
    )
    payload["nextResources"] = _dedupe_resource_refs(next_resources)
    payload["related"] = {
        "artifacts": [_compact_artifact(artifact) for artifact in artifacts[:5]],
        "issues": [_compact_issue(issue) for issue in issues[:20]],
        "workpacks": workpacks[:10],
        "issueCount": len(issues),
        "workpackCount": len(workpacks),
        "artifactCount": len(artifacts),
    }
    try:
        disk = (root / rel_path).resolve()
        disk.relative_to(root.resolve())
    except (OSError, ValueError):
        payload["error"] = "path is outside project root"
        return payload
    payload["diskPath"] = str(disk)
    payload["exists"] = disk.exists()
    if not disk.is_file():
        return payload
    try:
        text = disk.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        payload["error"] = str(exc)
        return payload
    lines = text.splitlines()
    payload["lineCount"] = len(lines)
    payload["preview"] = "\n".join(lines[:120])
    payload["truncated"] = len(lines) > 120
    return payload


def _resource_uri(kind: str, value: object) -> str:
    return f"governance://{kind}/{quote(str(value or '').strip(), safe='')}"


def _compact_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    path = str(artifact.get("path") or "")
    artifact_id = str(artifact.get("id") or "")
    item: dict[str, Any] = {
        "id": artifact_id,
        "uri": _resource_uri("artifact", artifact_id),
        "sourceUri": _resource_uri("source", path) if path else "",
        "type": artifact.get("type"),
        "title": artifact.get("title"),
        "path": path,
        "source": artifact.get("source"),
        "summary": artifact.get("summary"),
    }
    tags = artifact.get("tags")
    if isinstance(tags, list):
        item["tags"] = tags
    return item


def _compact_issue(issue: dict[str, Any]) -> dict[str, Any]:
    path = str(issue.get("path") or "")
    issue_id = str(issue.get("id") or "")
    artifact_id = str(issue.get("artifact_id") or "")
    return {
        "id": issue_id,
        "uri": _resource_uri("issue", issue_id),
        "artifactId": artifact_id,
        "artifactUri": _resource_uri("artifact", artifact_id) if artifact_id else "",
        "sourceUri": _resource_uri("source", path) if path else "",
        "severity": issue.get("severity"),
        "category": issue.get("category"),
        "path": path,
        "line": issue.get("line"),
        "title": issue.get("title"),
        "evidence": issue.get("evidence"),
        "suggestion": issue.get("suggestion"),
    }


def _compact_workpack(pack: dict[str, Any]) -> dict[str, Any]:
    pack_id = str(pack.get("id") or "")
    issue_ids = _string_list(pack.get("issue_ids"))
    paths = _string_list(pack.get("paths"))
    return {
        "id": pack_id,
        "uri": _resource_uri("workpack", pack_id),
        "priority": pack.get("priority"),
        "title": pack.get("title"),
        "kind": pack.get("kind"),
        "summary": pack.get("summary"),
        "next": pack.get("next"),
        "issueCount": pack.get("issue_count"),
        "artifactCount": pack.get("artifact_count"),
        "issueUris": [_resource_uri("issue", issue_id) for issue_id in issue_ids[:20]],
        "sourceUris": [_resource_uri("source", path) for path in paths[:20]],
    }


def _dedupe_resource_refs(items: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for item in items:
        uri = str(item.get("uri") or "")
        if not uri or uri in seen:
            continue
        seen.add(uri)
        result.append(item)
    return result


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item]


def _tool_schema(name: str) -> dict[str, Any]:
    if name == "governance.read_resource":
        return {"type": "object", "properties": {"uri": {"type": "string"}}, "required": ["uri"]}
    if name == "governance.add_app":
        return {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "endpoint": {"type": "string"},
                "kind": {"type": "string"},
            },
            "required": ["label", "endpoint"],
        }
    if name == "governance.enable_app":
        return {"type": "object", "properties": {"id": {"type": "string"}, "action": {"type": "string"}}, "required": ["id"]}
    return {"type": "object", "properties": {}}
