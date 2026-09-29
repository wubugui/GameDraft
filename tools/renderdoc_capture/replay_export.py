"""Pre-UI qrenderdoc Python script for bounded, machine-readable RDC replay.

This runs inside RenderDoc's embedded Python via ``qrenderdoc --python``. The
official binary contains this module but not a standalone ``renderdoc.pyd``.
All output is evidence keyed by RenderDoc event/resource IDs; no conclusion is
inferred from an action's name alone.
"""

import json
import os
from pathlib import Path
import sys
import traceback

REQUEST_ENV = "GAMEDRAFT_RENDERDOC_ANALYSIS_REQUEST"


def text(value):
    try:
        return str(value)
    except Exception:
        return "<unprintable>"


def field(obj, name, default=None):
    try:
        return getattr(obj, name)
    except Exception:
        return default


def fields(obj, names):
    result = {}
    for name in names:
        value = field(obj, name)
        if value is not None:
            if isinstance(value, (bool, int, float, str)):
                result[name] = value
            else:
                result[name] = text(value)
    return result


def resource_id(value):
    return text(value)


def enum_flags(rd, flags):
    names = []
    for name in ("Drawcall", "Dispatch", "Copy", "Clear", "Present", "PushMarker",
                 "PopMarker", "SetMarker", "PassBoundary", "MultiAction", "MeshDispatch"):
        flag = field(rd.ActionFlags, name)
        if flag is not None:
            try:
                if flags & flag:
                    names.append(name)
            except Exception:
                pass
    return names


def safe_name(obj):
    return text(field(obj, "customName") or field(obj, "name") or "")


def flat_actions(rd, roots, max_actions):
    records = []
    markers = []
    stack = [(a, None, 0) for a in reversed(list(roots))]
    count = 0
    truncated = False
    while stack:
        action, parent, depth = stack.pop()
        count += 1
        if len(records) >= max_actions:
            truncated = True
            break
        eid = int(field(action, "eventId", 0))
        flags = enum_flags(rd, field(action, "flags", 0))
        children = list(field(action, "children", []))
        rec = {
            "eventId": eid,
            "actionId": int(field(action, "actionId", 0)),
            "parentEventId": parent,
            "depth": depth,
            "name": safe_name(action),
            "flags": flags,
            "numIndices": int(field(action, "numIndices", 0)),
            "numInstances": int(field(action, "numInstances", 0)),
            "childCount": len(children),
        }
        records.append(rec)
        if "PushMarker" in flags or "PassBoundary" in flags:
            markers.append({
                "eventId": eid,
                "parentEventId": parent,
                "label": rec["name"],
                "kind": "passBoundary" if "PassBoundary" in flags else "markerRegion",
                "childCount": len(children),
            })
        for child in reversed(children):
            stack.append((child, eid, depth + 1))
    return records, markers, truncated, count


def resource_catalog(controller):
    descriptions = []
    for item in controller.GetResources():
        descriptions.append({
            "resourceId": resource_id(field(item, "resourceId")),
            "name": text(field(item, "name", "")),
            "type": text(field(item, "type", "")),
        })
    names = {item["resourceId"]: item["name"] for item in descriptions}
    textures = []
    texture_objects = {}
    for item in controller.GetTextures():
        rid = resource_id(field(item, "resourceId"))
        texture_objects[rid] = item
        fmt = field(item, "format")
        try:
            format_name = fmt.Name()
        except Exception:
            format_name = text(field(fmt, "type", "unknown"))
        textures.append({
            "resourceId": rid,
            "name": names.get(rid, ""),
            "width": int(field(item, "width", 0)),
            "height": int(field(item, "height", 0)),
            "depth": int(field(item, "depth", 0)),
            "arraysize": int(field(item, "arraysize", 0)),
            "mips": int(field(item, "mips", 0)),
            "samples": int(field(item, "msSamp", 0)),
            "byteSize": int(field(item, "byteSize", 0)),
            "format": format_name,
            "type": text(field(item, "type", "")),
        })
    buffers = []
    buffer_objects = {}
    for item in controller.GetBuffers():
        rid = resource_id(field(item, "resourceId"))
        buffer_objects[rid] = item
        buffers.append({
            "resourceId": rid,
            "name": names.get(rid, ""),
            "length": int(field(item, "length", 0)),
        })
    return {"all": descriptions, "textures": textures, "buffers": buffers}, texture_objects, buffer_objects


def pipeline_snapshot(rd, controller, eid):
    controller.SetFrameEvent(eid, False)
    pipe = controller.GetPipelineState()
    targets = []
    for index, target in enumerate(pipe.GetOutputTargets()):
        rid = field(target, "resource")
        if rid is not None and rid != rd.ResourceId.Null():
            targets.append({"slot": index, "resourceId": resource_id(rid)})
    depth = field(pipe.GetDepthTarget(), "resource")
    shaders = {}
    for stage_name in ("Vertex", "Pixel", "Compute", "Mesh", "Amplification"):
        stage = field(rd.ShaderStage, stage_name)
        if stage is None:
            continue
        try:
            shader = pipe.GetShader(stage)
            if shader != rd.ResourceId.Null():
                shaders[stage_name] = resource_id(shader)
        except Exception:
            continue
    descriptor_ids = []
    descriptor_truncated = False
    try:
        for binding in pipe.GetAllUsedDescriptors(True):
            for slot in ("descriptor", "sampler"):
                desc = field(binding, slot)
                rid = field(desc, "resource" if slot == "descriptor" else "object")
                if rid is not None and rid != rd.ResourceId.Null():
                    descriptor_ids.append(resource_id(rid))
            if len(descriptor_ids) >= 128:
                descriptor_truncated = True
                break
    except Exception:
        pass
    output = {
        "eventId": eid,
        "graphicsPipelineId": resource_id(pipe.GetGraphicsPipelineObject()),
        "computePipelineId": resource_id(pipe.GetComputePipelineObject()),
        "shaders": shaders,
        "outputTargets": targets,
        "depthTargetId": resource_id(depth) if depth is not None and depth != rd.ResourceId.Null() else None,
        "boundResourceIds": sorted(set(descriptor_ids)),
        "boundResourcesTruncated": descriptor_truncated,
    }
    return output


def sample_events(records, max_pipelines):
    ids = [a["eventId"] for a in records if "Drawcall" in a["flags"] or "Dispatch" in a["flags"]]
    if len(ids) <= max_pipelines:
        return ids, False
    if max_pipelines == 1:
        return [ids[-1]], True
    indices = sorted(set(round(i * (len(ids) - 1) / (max_pipelines - 1)) for i in range(max_pipelines)))
    return [ids[i] for i in indices], True


def debug_messages(controller):
    result = []
    for msg in controller.GetDebugMessages():
        result.append({
            "eventId": int(field(msg, "eventId", 0)),
            "messageId": int(field(msg, "messageID", 0)),
            "description": text(field(msg, "description", "")),
            "category": text(field(msg, "category", "")),
            "severity": text(field(msg, "severity", "")),
            "source": text(field(msg, "source", "")),
        })
    return result


def export_textures(rd, controller, request, output, catalog, texture_objects, preferred_ids, report):
    if not request["textures"] and not request["rawTextures"]:
        return
    wanted = request["textureIds"] or (preferred_ids + [t["resourceId"] for t in catalog["textures"]])
    wanted = list(dict.fromkeys(wanted))
    selected = [rid for rid in wanted if rid in texture_objects]
    missing = [rid for rid in request["textureIds"] if rid not in texture_objects]
    for rid in missing:
        report["unsupported"].append({"feature": "textureExport", "resourceId": rid, "reason": "resource ID not present in capture"})
    total = 0
    exported = 0
    asset_dir = output / "assets" / "textures"
    for rid in selected:
        if exported >= 8:
            report["truncated"].append({"feature": "textureExport", "reason": "8-texture limit"})
            break
        desc = texture_objects[rid]
        width = int(field(desc, "width", 0))
        height = int(field(desc, "height", 0))
        estimate = width * height * 8
        if estimate <= 0 or total + estimate > request["maxExportBytes"]:
            report["truncated"].append({"feature": "textureExport", "resourceId": rid, "reason": "export byte budget"})
            continue
        asset_dir.mkdir(parents=True, exist_ok=True)
        exported += 1
        prefix = "texture_%02d" % exported
        if request["textures"]:
            path = asset_dir / (prefix + ".png")
            try:
                save = rd.TextureSave()
                save.resourceId = field(desc, "resourceId")
                save.destType = rd.FileType.PNG
                save.alpha = rd.AlphaMapping.Preserve
                save.mip = 0
                save.slice.sliceIndex = 0
                controller.SaveTexture(save, str(path))
                if not path.is_file() or path.stat().st_size == 0:
                    raise RuntimeError("SaveTexture did not create a non-empty PNG")
                report["exports"]["textures"].append({"resourceId": rid, "format": "png", "path": str(path.relative_to(output)), "bytes": path.stat().st_size})
                total += path.stat().st_size
            except Exception as exc:
                report["unsupported"].append({"feature": "texturePng", "resourceId": rid, "reason": text(exc)})
        if request["rawTextures"]:
            try:
                data = controller.GetTextureData(field(desc, "resourceId"), rd.Subresource())
                if len(data) + total > request["maxExportBytes"]:
                    report["truncated"].append({"feature": "textureRaw", "resourceId": rid, "reason": "export byte budget"})
                    continue
                path = asset_dir / (prefix + ".bin")
                path.write_bytes(data)
                report["exports"]["textures"].append({"resourceId": rid, "format": "raw-mip0", "path": str(path.relative_to(output)), "bytes": len(data)})
                total += len(data)
            except Exception as exc:
                report["unsupported"].append({"feature": "textureRaw", "resourceId": rid, "reason": text(exc)})


def export_buffers(controller, request, output, catalog, buffer_objects, report):
    if not request["buffers"]:
        return
    wanted = request["bufferIds"] or [b["resourceId"] for b in catalog["buffers"]]
    wanted = list(dict.fromkeys(wanted))
    missing = [rid for rid in request["bufferIds"] if rid not in buffer_objects]
    for rid in missing:
        report["unsupported"].append({"feature": "bufferExport", "resourceId": rid, "reason": "resource ID not present in capture"})
    asset_dir = output / "assets" / "buffers"
    total = 0
    exported = 0
    for rid in wanted:
        if rid not in buffer_objects:
            continue
        if exported >= 16:
            report["truncated"].append({"feature": "bufferExport", "reason": "16-buffer limit"})
            break
        desc = buffer_objects[rid]
        length = int(field(desc, "length", 0))
        budget = request["maxExportBytes"] - total
        amount = min(length, 2 * 1024 * 1024, budget)
        if amount <= 0:
            report["truncated"].append({"feature": "bufferExport", "resourceId": rid, "reason": "export byte budget"})
            break
        try:
            data = controller.GetBufferData(field(desc, "resourceId"), 0, amount)
            asset_dir.mkdir(parents=True, exist_ok=True)
            exported += 1
            path = asset_dir / ("buffer_%02d.bin" % exported)
            path.write_bytes(data)
            total += len(data)
            report["exports"]["buffers"].append({"resourceId": rid, "path": str(path.relative_to(output)), "bytes": len(data), "sourceLength": length, "truncated": len(data) < length})
        except Exception as exc:
            report["unsupported"].append({"feature": "bufferExport", "resourceId": rid, "reason": text(exc)})


def color_values(value):
    col = field(value, "col")
    floats = field(col, "floatValue", [])
    try:
        return [float(floats[i]) for i in range(4)]
    except Exception:
        return []


def pixel_history(rd, controller, specs, texture_objects, report):
    for spec in specs:
        rid, xs, ys = spec.rsplit(":", 2)
        x, y = int(xs), int(ys)
        desc = texture_objects.get(rid)
        if desc is None or x >= int(field(desc, "width", 0)) or y >= int(field(desc, "height", 0)):
            report["unsupported"].append({"feature": "pixelHistory", "resourceId": rid, "x": x, "y": y, "reason": "resource ID missing or coordinates outside texture"})
            continue
        try:
            history = controller.PixelHistory(field(desc, "resourceId"), x, y, rd.Subresource(), rd.CompType.Typeless)
            entries = []
            for item in history:
                if len(entries) >= 10000:
                    report["truncated"].append({"feature": "pixelHistory", "resourceId": rid, "reason": "10000-entry limit"})
                    break
                passed = bool(item.Passed())
                entries.append({
                    "eventId": int(field(item, "eventId", 0)),
                    "passed": passed,
                    "preColor": color_values(field(item, "preMod")),
                    "postColor": color_values(field(item, "postMod")),
                    "shaderOutputColor": color_values(field(item, "shaderOut")),
                    "primitiveId": int(field(item, "primitiveID", 0)),
                    "unboundPixelShader": bool(field(item, "unboundPS", False)),
                })
            report["pixelHistory"].append({"resourceId": rid, "x": x, "y": y, "entries": entries})
        except Exception as exc:
            report["unsupported"].append({"feature": "pixelHistory", "resourceId": rid, "x": x, "y": y, "reason": text(exc)})


def replay(rd, request, report):
    capture = request["capture"]
    cap = rd.OpenCaptureFile()
    controller = None
    try:
        opened = cap.OpenFile(capture, "", None)
        if opened != rd.ResultCode.Succeeded:
            raise RuntimeError("OpenFile failed: %s" % text(opened))
        if not cap.LocalReplaySupport():
            report["status"] = "unsupported"
            report["unsupported"].append({"feature": "localReplay", "reason": "RenderDoc cannot replay this capture on the current GPU/API"})
            return
        opened, controller = cap.OpenCapture(rd.ReplayOptions(), None)
        if opened != rd.ResultCode.Succeeded or controller is None:
            raise RuntimeError("OpenCapture failed: %s" % text(opened))
        api = controller.GetAPIProperties()
        report["api"] = fields(api, ["pipelineType", "graphicsAPI", "degraded", "shaderDebugging", "pixelHistory"])
        report["api"]["pipelineTypeName"] = text(field(field(api, "pipelineType"), "name", field(api, "pipelineType")))
        frame = controller.GetFrameInfo()
        report["frame"] = fields(frame, ["frameNumber", "captureTime", "uncompressedFileSize", "compressedFileSize", "fileOffset", "captureDuration"])
        actions, passes, truncated, _ = flat_actions(rd, controller.GetRootActions(), request["maxActions"])
        report["actions"] = actions
        report["passes"] = passes
        if truncated:
            report["truncated"].append({"feature": "actions", "reason": "maxActions limit"})
        catalog, texture_objects, buffer_objects = resource_catalog(controller)
        report["resources"] = catalog
        ids, limited = sample_events(actions, request["maxPipelines"])
        if limited:
            report["truncated"].append({"feature": "pipelines", "reason": "representative event sampling"})
        for eid in ids:
            try:
                report["pipelines"].append(pipeline_snapshot(rd, controller, eid))
            except Exception as exc:
                report["unsupported"].append({"feature": "pipelineState", "eventId": eid, "reason": text(exc)})
        preferred_ids = []
        if report["pipelines"]:
            preferred_ids = [target["resourceId"] for target in report["pipelines"][-1]["outputTargets"]]
        output = Path(request["output"])
        export_textures(rd, controller, request, output, catalog, texture_objects, preferred_ids, report)
        export_buffers(controller, request, output, catalog, buffer_objects, report)
        pixel_history(rd, controller, request["pixels"], texture_objects, report)
        report["debugMessages"] = debug_messages(controller)
        report["summary"] = {
            "actionCount": len(actions),
            "drawCount": sum("Drawcall" in a["flags"] for a in actions),
            "dispatchCount": sum("Dispatch" in a["flags"] for a in actions),
            "passOrMarkerCount": len(passes),
            "textureCount": len(catalog["textures"]),
            "bufferCount": len(catalog["buffers"]),
            "debugMessageCount": len(report["debugMessages"]),
        }
        report["status"] = "partial" if report["truncated"] or report["unsupported"] else "ok"
    finally:
        if controller is not None:
            controller.Shutdown()
        cap.Shutdown()


def main():
    request_path = os.environ.get(REQUEST_ENV)
    if not request_path:
        print("Missing %s" % REQUEST_ENV, file=sys.stderr)
        return
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    output = Path(request["output"])
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": 1,
        "status": "error",
        "capture": {"path": request["capture"], "bytes": Path(request["capture"]).stat().st_size},
        "renderdoc": {},
        "api": {},
        "frame": {},
        "summary": {},
        "actions": [],
        "passes": [],
        "resources": {"all": [], "textures": [], "buffers": []},
        "pipelines": [],
        "debugMessages": [],
        "pixelHistory": [],
        "exports": {"textures": [], "buffers": []},
        "truncated": [],
        "unsupported": [],
        "errors": [],
    }
    try:
        import renderdoc as rd
        report["renderdoc"] = {"version": text(rd.GetVersionString()), "runner": "qrenderdoc --python"}
        replay(rd, request, report)
    except Exception as exc:
        report["status"] = "error"
        report["errors"].append({"code": "replay_failed", "message": text(exc), "traceback": traceback.format_exc(limit=8)})
    path = output / "report.json"
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(str(path))


try:
    main()
except Exception:
    traceback.print_exc()
finally:
    # qrenderdoc.cpp recognises SystemExit here and skips creating the main UI.
    sys.exit(0)
