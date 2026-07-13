#!/usr/bin/env python3
"""Drive the TypeScript and Godot shells through one parity protocol.

The runner can launch Vite + headless Chrome itself, launches a headless Godot
process for the same capture request, validates both snapshots against the
frozen schema, and emits field-level differences.  Differences are expected
until the port is complete; schema/protocol failures are never tolerated.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import json
import os
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4


PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
CONTRACT_TOOL = PORT_ROOT / "tools/build_runtime_contracts.py"
COMMAND_CONTRACT_PATH = PORT_ROOT / "compatibility/runtime-command-contract.json"
SNAPSHOT_SCHEMA_PATH = PORT_ROOT / "compatibility/runtime-snapshot-schema.json"
DEFAULT_REPORT_PATH = PORT_ROOT / "compatibility/parity-last-report.json"
DEFAULT_GODOT = Path("/Applications/Godot.app/Contents/MacOS/Godot")
DEFAULT_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

PARITY_COMMANDS: list[dict[str, Any]] = [
    {"type": "debugClearEventTrace"},
    {"type": "setFlag", "key": "heard_teahouse_story", "value": True},
    {"type": "debugSetPlayerPosition", "x": 123.0, "y": 234.0, "snapCamera": True},
    {"type": "activatePlane", "planeId": "normal"},
    {"type": "debugSwitchScene", "sceneId": "test_room_b"},
    {"type": "debugSaveGame", "slot": 2},
    {"type": "setFlag", "key": "entered_dark_alley", "value": False},
    {"type": "debugSetPlayerPosition", "x": 50.0, "y": 60.0, "snapCamera": True},
    {"type": "debugWait", "durationMs": 40},
    {"type": "debugLoadGame", "slot": 2},
    {"type": "debugStartDialogueGraph", "graphId": "寻狗_说书人", "npcName": "张叨叨", "npcId": "storyteller_zhang", "ownerType": "npc", "ownerId": "storyteller_zhang"},
    {"type": "debugAdvanceDialogue", "maxSteps": 24},
    {"type": "debugChooseDialogueOption", "index": 0},
    {"type": "debugAdvanceDialogue", "maxSteps": 24},
    {"type": "debugExecuteAction", "action": {"type": "randomBranch", "params": {"probability": 0.5, "aboveActions": [{"type": "setFlag", "params": {"key": "parity_random_branch", "value": "above"}}], "belowActions": [{"type": "setFlag", "params": {"key": "parity_random_branch", "value": "below"}}]}}},
    {"type": "debugExecuteAction", "action": {"type": "giveCurrency", "params": {"amount": 7.5}}},
    {"type": "debugSetFixedTickMode", "enabled": True},
    {"type": "debugSwitchScene", "sceneId": "test_room_a"},
    {"type": "debugExecuteAction", "action": {"type": "damagePlayer", "params": {"amount": 75.0}}},
    {"type": "debugExecuteAction", "action": {"type": "setSmell", "params": {"scent": "powder", "intensity": 90.0, "dir": 0.5, "flicker": True}}},
    {"type": "debugStepTicks", "ticks": 120, "dtMs": 1000.0 / 60.0},
]


class ParityError(RuntimeError):
    pass


@dataclass(frozen=True)
class Capture:
    runtime: str
    ping: dict[str, Any]
    snapshot: dict[str, Any]
    transport: dict[str, Any]


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ParityError(f"cannot read JSON {path}: {exc}") from exc


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def check_contracts() -> None:
    result = subprocess.run(
        [sys.executable, str(CONTRACT_TOOL)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ParityError((result.stdout + result.stderr).strip())


def validate_snapshot(snapshot: Any, schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    def visit(value: Any, rule: dict[str, Any], path: str) -> None:
        expected_type = rule.get("type")
        if expected_type is not None:
            accepted = expected_type if isinstance(expected_type, list) else [expected_type]
            if not any(_matches_json_type(value, item) for item in accepted):
                errors.append(f"{path}: expected {'|'.join(accepted)}, got {_json_type(value)}")
                return
        if isinstance(value, dict):
            required = rule.get("required", [])
            for key in required:
                if key not in value:
                    errors.append(f"{path}/{_escape_pointer(key)}: missing required field")
            properties = rule.get("properties", {})
            for key, child in value.items():
                child_rule = properties.get(key)
                if isinstance(child_rule, dict):
                    visit(child, child_rule, f"{path}/{_escape_pointer(key)}")
                elif rule.get("additionalProperties") is False:
                    errors.append(f"{path}/{_escape_pointer(key)}: additional property is forbidden")
        elif isinstance(value, list) and isinstance(rule.get("items"), dict):
            for index, child in enumerate(value):
                visit(child, rule["items"], f"{path}/{index}")
        if isinstance(value, str) and "minLength" in rule and len(value) < int(rule["minLength"]):
            errors.append(f"{path}: shorter than minLength={rule['minLength']}")

    visit(snapshot, schema, "")
    return errors


def _matches_json_type(value: Any, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "string":
        return isinstance(value, str)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    return True


def _json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _escape_pointer(value: str) -> str:
    return str(value).replace("~", "~0").replace("/", "~1")


def _unwrap_snapshot(value: Any) -> dict[str, Any]:
    if isinstance(value, dict) and isinstance(value.get("snapshot"), dict):
        return value["snapshot"]
    if isinstance(value, dict):
        return value
    raise ParityError("snapshot payload is not an object")


def _remove_pointer(root: Any, pointer: str) -> None:
    if not pointer.startswith("/"):
        return
    segments = [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]
    current = root
    for segment in segments[:-1]:
        if not isinstance(current, dict) or segment not in current:
            return
        current = current[segment]
    if isinstance(current, dict):
        current.pop(segments[-1], None)


def _strip_object_keys(value: Any, keys: set[str]) -> None:
    if isinstance(value, dict):
        for key in list(value):
            if key in keys:
                value.pop(key, None)
            else:
                _strip_object_keys(value[key], keys)
    elif isinstance(value, list):
        for child in value:
            _strip_object_keys(child, keys)


def _value_at_pointer(root: Any, pointer: str) -> Any:
    if not pointer.startswith("/"):
        return None
    current = root
    for segment in pointer[1:].split("/"):
        key = segment.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return None
    return current


def normalize_snapshot(snapshot: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(snapshot)
    parity = schema.get("x-parity", {})
    for pointer in parity.get("ignoredValuePaths", []):
        _remove_pointer(normalized, str(pointer))
    for rule in parity.get("ignoredObjectKeysAtPaths", []):
        if not isinstance(rule, dict):
            continue
        target = _value_at_pointer(normalized, str(rule.get("path", "")))
        keys = {str(key) for key in rule.get("keys", [])}
        if target is not None and keys:
            _strip_object_keys(target, keys)
    return normalized


def diff_values(left: Any, right: Any, tolerance: float, path: str = "") -> list[dict[str, Any]]:
    differences: list[dict[str, Any]] = []
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(set(left) | set(right)):
            child_path = f"{path}/{_escape_pointer(key)}"
            if key not in left:
                differences.append({"path": child_path, "kind": "missing-left", "right": right[key]})
            elif key not in right:
                differences.append({"path": child_path, "kind": "missing-right", "left": left[key]})
            else:
                differences.extend(diff_values(left[key], right[key], tolerance, child_path))
        return differences
    if isinstance(left, list) and isinstance(right, list):
        common = min(len(left), len(right))
        for index in range(common):
            differences.extend(diff_values(left[index], right[index], tolerance, f"{path}/{index}"))
        if len(left) != len(right):
            differences.append({"path": path, "kind": "array-length", "left": len(left), "right": len(right)})
        return differences
    if (
        isinstance(left, (int, float)) and not isinstance(left, bool)
        and isinstance(right, (int, float)) and not isinstance(right, bool)
    ):
        if abs(float(left) - float(right)) > tolerance:
            differences.append({"path": path, "kind": "number", "left": left, "right": right})
        return differences
    if type(left) is not type(right):
        differences.append({"path": path, "kind": "type", "leftType": _json_type(left), "rightType": _json_type(right), "left": left, "right": right})
    elif left != right:
        differences.append({"path": path, "kind": "value", "left": left, "right": right})
    return differences


def godot_capture(godot_binary: Path, timeout: float) -> Capture:
    if not godot_binary.is_file():
        raise ParityError(f"Godot binary not found: {godot_binary}")
    request_id = f"parity-{uuid4().hex}"
    marker = f"parity:capture:{request_id}"
    commands = [dict(command, id=f"{request_id}:step:{index}", reason=f"parity-step:{index}:{command['type']}") for index, command in enumerate(PARITY_COMMANDS)]
    request = {
        "protocolVersion": 1,
        "requestId": request_id,
        "operations": [
            {"type": "ping"},
            *[{"type": "runtimeCommand", "command": command} for command in commands],
            {"type": "captureSnapshot", "command": {"id": request_id, "type": "captureSnapshot", "reason": marker}},
        ],
    }
    with tempfile.TemporaryDirectory(prefix="gamedraft-godot-parity-") as raw_temp:
        temp = Path(raw_temp)
        request_path = temp / "request.json"
        response_path = temp / "response.json"
        write_json(request_path, request)
        process = subprocess.run(
            [
                str(godot_binary), "--headless", "--path", str(PORT_ROOT),
                "--", f"--parity-request={request_path}", f"--parity-response={response_path}",
                "--parity-start-scene=dev_room", "--parity-quit",
            ],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if process.returncode != 0:
            raise ParityError(
                f"Godot parity probe exited {process.returncode}\n{process.stdout}\n{process.stderr}".strip()
            )
        response = load_json(response_path)
    if not isinstance(response, dict) or response.get("requestId") != request_id:
        raise ParityError("Godot parity response does not match request")
    results = response.get("results")
    if not isinstance(results, list) or len(results) != len(commands) + 2:
        raise ParityError("Godot parity response does not contain the scripted command sequence")
    ping = results[0]
    command_results = results[1:-1]
    capture_result = results[-1]
    if not isinstance(ping, dict) or ping.get("message") != "pong" or ping.get("ok") is not True:
        raise ParityError(f"Godot ping failed: {ping}")
    if not isinstance(capture_result, dict) or capture_result.get("ok") is not True:
        raise ParityError(f"Godot captureSnapshot failed: {capture_result}")
    checkpoints: list[dict[str, Any]] = []
    for index, result in enumerate(command_results):
        if not isinstance(result, dict) or result.get("ok") is not True or not isinstance(result.get("snapshot"), dict):
            raise ParityError(f"Godot parity command {index} failed: {result}")
        checkpoints.append(_unwrap_snapshot(result["snapshot"]))
    snapshot = _unwrap_snapshot(capture_result.get("snapshot"))
    return Capture("godot", ping, snapshot, {"response": response, "checkpoints": checkpoints})


def _http_json(url: str, *, method: str = "GET", body: Any = None, timeout: float = 5.0) -> Any:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method=method)
    if payload is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw.strip() else {}


def typescript_capture(base_url: str, timeout: float) -> Capture:
    snapshot_url = base_url.rstrip("/") + "/__gamedraft-api/runtime-debug-snapshot"
    command_url = base_url.rstrip("/") + "/__gamedraft-api/runtime-command"
    deadline = time.monotonic() + timeout
    initial: Any = None
    while time.monotonic() < deadline:
        try:
            initial = _http_json(snapshot_url)
            initial_snapshot = _unwrap_snapshot(initial)
            if initial.get("ok", True) and initial_snapshot.get("bootId") and initial_snapshot.get("inFlight", {}).get("runtimeReady") is True:
                break
        except (OSError, ValueError, ParityError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    else:
        raise ParityError("TypeScript runtime did not publish a boot snapshot")
    boot_id = str(initial_snapshot["bootId"])
    checkpoints: list[dict[str, Any]] = []
    for index, template in enumerate(PARITY_COMMANDS):
        deadline = time.monotonic() + timeout
        step_id = f"parity-step-{uuid4().hex}"
        command = dict(template, id=step_id, reason=f"parity-step:{index}:{template['type']}", targetBootId=boot_id, source="godot-parity-runner")
        _http_json(command_url, method="POST", body={"commands": [command]})
        while time.monotonic() < deadline:
            try:
                current = _http_json(snapshot_url)
                step_snapshot = _unwrap_snapshot(current)
                matching = next((item for item in step_snapshot.get("runtimeCommands", {}).get("lastResults", []) if isinstance(item, dict) and item.get("id") == step_id), None)
                if isinstance(matching, dict) and matching.get("ok") is not True:
                    raise ParityError(f"TypeScript parity step {index} failed: {matching}")
                answered = isinstance(matching, dict) and matching.get("ok") is True
                if step_snapshot.get("bootId") == boot_id and answered:
                    checkpoints.append(step_snapshot)
                    break
            except (OSError, ValueError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        else:
            raise ParityError(f"TypeScript runtime did not answer parity step {index}: {template['type']}")
    request_id = f"parity-{uuid4().hex}"
    deadline = time.monotonic() + timeout
    marker = f"parity:capture:{request_id}"
    command = {
        "id": request_id,
        "type": "captureSnapshot",
        "reason": marker,
        "targetBootId": boot_id,
        "source": "godot-parity-runner",
    }
    _http_json(command_url, method="POST", body={"commands": [command]})
    captured: Any = None
    while time.monotonic() < deadline:
        try:
            captured = _http_json(snapshot_url)
            snapshot = _unwrap_snapshot(captured)
            last_results = snapshot.get("runtimeCommands", {}).get("lastResults", [])
            command_answered = any(
                isinstance(item, dict) and item.get("id") == request_id and item.get("ok") is True
                for item in last_results
            )
            # Game.pollRuntimeCommands publishes a second `runtime-command:complete`
            # snapshot immediately after applyDevRuntimeCommand captures `marker`.
            # Either observation proves the targeted command ran; requiring only
            # the fleeting marker creates a polling race.
            if snapshot.get("bootId") == boot_id and (snapshot.get("reason") == marker or command_answered):
                break
        except (OSError, ValueError, ParityError, urllib.error.URLError):
            pass
        time.sleep(0.15)
    else:
        raise ParityError("TypeScript runtime did not answer captureSnapshot")
    ping = {"type": "ping", "ok": True, "message": "pong", "bootId": boot_id}
    return Capture("typescript", ping, snapshot, {"response": captured if isinstance(captured, dict) else {}, "checkpoints": checkpoints})


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def _wait_http(url: str, timeout: float, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ParityError(f"process exited before HTTP became ready: {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=1.0):
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.15)
    raise ParityError(f"timed out waiting for {url}")


def _terminate(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        process.wait(timeout=5)


@contextlib.contextmanager
def launched_typescript_runtime(chrome: Path, timeout: float) -> Iterator[str]:
    if not chrome.is_file():
        raise ParityError(f"Chrome binary not found: {chrome}")
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    vite_log = tempfile.NamedTemporaryFile(prefix="gamedraft-vite-", suffix=".log", delete=False)
    chrome_log = tempfile.NamedTemporaryFile(prefix="gamedraft-chrome-", suffix=".log", delete=False)
    vite_log_path = Path(vite_log.name)
    chrome_log_path = Path(chrome_log.name)
    vite_log.close()
    chrome_log.close()
    vite: subprocess.Popen[str] | None = None
    browser: subprocess.Popen[str] | None = None
    try:
        vite_stream = vite_log_path.open("w", encoding="utf-8")
        vite = subprocess.Popen(
            ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
            cwd=REPO_ROOT,
            stdout=vite_stream,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        _wait_http(base_url, timeout, vite)
        try:
            _http_json(base_url + "/__gamedraft-api/runtime-debug-snapshot", method="DELETE")
            _http_json(base_url + "/__gamedraft-api/runtime-command", method="DELETE")
        except (OSError, ValueError, urllib.error.URLError):
            pass
        profile = tempfile.mkdtemp(prefix="gamedraft-parity-chrome-")
        chrome_stream = chrome_log_path.open("w", encoding="utf-8")
        browser = subprocess.Popen(
            [
                str(chrome), "--headless=new", "--no-first-run",
                "--no-default-browser-check", "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
                "--autoplay-policy=no-user-gesture-required", f"--user-data-dir={profile}",
                base_url + "/?mode=dev&devScene=dev_room",
            ],
            cwd=REPO_ROOT,
            stdout=chrome_stream,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        yield base_url
    except Exception as exc:
        vite_tail = vite_log_path.read_text(encoding="utf-8", errors="replace")[-4000:] if vite_log_path.is_file() else ""
        chrome_tail = chrome_log_path.read_text(encoding="utf-8", errors="replace")[-4000:] if chrome_log_path.is_file() else ""
        raise ParityError(f"{exc}\n--- vite ---\n{vite_tail}\n--- chrome ---\n{chrome_tail}") from exc
    finally:
        _terminate(browser)
        _terminate(vite)
        for stream_name in ("vite_stream", "chrome_stream"):
            stream = locals().get(stream_name)
            if stream is not None:
                stream.close()
        if "profile" in locals():
            shutil.rmtree(profile, ignore_errors=True)
        vite_log_path.unlink(missing_ok=True)
        chrome_log_path.unlink(missing_ok=True)


def compare_captures(left: Capture, right: Capture, schema: dict[str, Any]) -> dict[str, Any]:
    left_errors = validate_snapshot(left.snapshot, schema)
    right_errors = validate_snapshot(right.snapshot, schema)
    tolerance = float(schema.get("x-parity", {}).get("numericTolerance", 0.0))
    differences = diff_values(
        normalize_snapshot(left.snapshot, schema),
        normalize_snapshot(right.snapshot, schema),
        tolerance,
    ) if not left_errors and not right_errors else []
    left_checkpoints = left.transport.get("checkpoints", []) if isinstance(left.transport, dict) else []
    right_checkpoints = right.transport.get("checkpoints", []) if isinstance(right.transport, dict) else []
    checkpoint_errors: list[str] = []
    for runtime, checkpoints in ((left.runtime, left_checkpoints), (right.runtime, right_checkpoints)):
        if not isinstance(checkpoints, list):
            checkpoint_errors.append(f"{runtime}: checkpoints is not an array")
            continue
        for index, checkpoint in enumerate(checkpoints):
            checkpoint_errors.extend(f"{runtime}[{index}]{error}" for error in validate_snapshot(checkpoint, schema))
    checkpoint_differences = diff_values(
        [normalize_snapshot(value, schema) for value in left_checkpoints],
        [normalize_snapshot(value, schema) for value in right_checkpoints],
        tolerance,
        "/checkpoints",
    ) if not checkpoint_errors else []
    all_differences = checkpoint_differences + differences
    return {
        "contractVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "leftRuntime": left.runtime,
        "rightRuntime": right.runtime,
        "protocol": {"leftPing": left.ping, "rightPing": right.ping},
        "schema": {"leftErrors": left_errors, "rightErrors": right_errors, "checkpointErrors": checkpoint_errors},
        "equivalent": not left_errors and not right_errors and not checkpoint_errors and not all_differences,
        "differenceCount": len(all_differences),
        "differences": all_differences,
        "snapshots": {left.runtime: left.snapshot, right.runtime: right.snapshot},
    }


def _print_report(report: dict[str, Any], report_path: Path) -> None:
    print(f"report: {report_path.relative_to(REPO_ROOT) if report_path.is_relative_to(REPO_ROOT) else report_path}")
    for side, errors in report["schema"].items():
        print(f"{side}: {'OK' if not errors else f'{len(errors)} schema errors'}")
        for error in errors[:20]:
            print(f"  {error}")
    print(f"field differences: {report['differenceCount']}")
    for item in report["differences"][:40]:
        print(f"  {item['path'] or '/'}: {item['kind']}")


def command_godot(args: argparse.Namespace) -> int:
    check_contracts()
    schema = load_json(SNAPSHOT_SCHEMA_PATH)
    capture = godot_capture(Path(args.godot), args.timeout)
    errors = validate_snapshot(capture.snapshot, schema)
    if errors:
        for error in errors:
            print(error)
        return 1
    print(f"Godot ping/captureSnapshot: PASS ({capture.snapshot.get('bootId')})")
    return 0


def command_compare(args: argparse.Namespace) -> int:
    check_contracts()
    schema = load_json(SNAPSHOT_SCHEMA_PATH)
    left = Capture(args.left_runtime, {"ok": True, "message": "offline"}, _unwrap_snapshot(load_json(Path(args.left))), {})
    right = Capture(args.right_runtime, {"ok": True, "message": "offline"}, _unwrap_snapshot(load_json(Path(args.right))), {})
    report = compare_captures(left, right, schema)
    report_path = Path(args.report).resolve()
    write_json(report_path, report)
    _print_report(report, report_path)
    return 1 if (args.require_equal and not report["equivalent"]) or any(report["schema"].values()) else 0


def command_run(args: argparse.Namespace) -> int:
    check_contracts()
    schema = load_json(SNAPSHOT_SCHEMA_PATH)
    godot = godot_capture(Path(args.godot), args.timeout)
    if args.base_url:
        typescript = typescript_capture(args.base_url, args.timeout)
    else:
        with launched_typescript_runtime(Path(args.chrome), args.timeout) as base_url:
            typescript = typescript_capture(base_url, args.timeout)
    report = compare_captures(typescript, godot, schema)
    report_path = Path(args.report).resolve()
    write_json(report_path, report)
    _print_report(report, report_path)
    return 1 if (args.require_equal and not report["equivalent"]) or any(report["schema"].values()) else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    contracts = subparsers.add_parser("contracts", help="check generated contracts against TypeScript authority")
    contracts.set_defaults(func=lambda _args: (check_contracts(), print("runtime contracts: PASS"), 0)[2])

    godot = subparsers.add_parser("godot", help="probe Godot ping and captureSnapshot")
    godot.add_argument("--godot", default=str(DEFAULT_GODOT))
    godot.add_argument("--timeout", type=float, default=30.0)
    godot.set_defaults(func=command_godot)

    compare = subparsers.add_parser("compare", help="compare two existing snapshot JSON files")
    compare.add_argument("left")
    compare.add_argument("right")
    compare.add_argument("--left-runtime", default="typescript")
    compare.add_argument("--right-runtime", default="godot")
    compare.add_argument("--report", default=str(DEFAULT_REPORT_PATH))
    compare.add_argument("--require-equal", action="store_true")
    compare.set_defaults(func=command_compare)

    run = subparsers.add_parser("run", help="drive both live runtime shells and compare snapshots")
    run.add_argument("--base-url", help="use an already-running TypeScript dev runtime instead of launching one")
    run.add_argument("--godot", default=str(DEFAULT_GODOT))
    run.add_argument("--chrome", default=str(DEFAULT_CHROME))
    run.add_argument("--timeout", type=float, default=45.0)
    run.add_argument("--report", default=str(DEFAULT_REPORT_PATH))
    run.add_argument("--require-equal", action="store_true", help="fail while field values differ")
    run.set_defaults(func=command_run)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return int(args.func(args))
    except (ParityError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
