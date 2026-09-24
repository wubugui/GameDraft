#!/usr/bin/env python3
"""本机 Blender 禁用门(制作人 2026-09-24 定):Blender 一律走局域网 Hub,本机不许运行任何 Blender。

规则正文只在 agent_docs/asset-pipeline/norms.md 不变量 7;这里只放拦截用的摘要和机械检测。
接线在**用户级** ~/.claude/settings.json 的 PreToolUse(Bash|PowerShell),对本机所有项目生效
(Maz543 / FeiTing / DreamRiteDemo 等也用 Blender)。

拦的是"在本机跑起来 / 弄一份新的来跑":
  · 在命令位置执行 blender / blender.exe / blender-launcher.exe(直接路径、PATH 上的、
    先赋给变量再 "$B" / & $B / Start-Process -FilePath $B 调用的都算);
  · 脚本里用 subprocess / os.system 之类起 blender.exe;
  · 下载 Blender(download.blender.org、blender-x.y.z-windows 包、winget/choco/scoop 装 blender);
  · pip install bpy(独立 bpy 模块等于本地 Blender)。
不拦:ls / Get-ChildItem / 查进程 / 杀进程 / 改名这类只看不跑的;往 Hub 提交任务的脚本。

命中 → exit 2,stderr 回给 agent。任何异常 fail-open(exit 0),绝不因门自身 bug 卡住工作。
自检:`python no_local_blender.py --selftest`。
"""

from __future__ import annotations

import json
import re
import sys

RULE = (
    "【Blender 一律走 Hub·制作人 2026-09-24 定】本机禁止运行 Blender(任何版本、任何路径,"
    "含下载新的一份、pip install bpy)。改走局域网 Hub:http://denghong01:8765 的 backend=blender"
    "(已装 4.5.0 / 4.5.13 / 5.2.2,build hash 与原本机那几份一致),用 inference-hub-generation 技能"
    "(先读 /guide.md 的 Blender 一节;项目打 ZIP 上传、产物写 HUB_OUTPUT_DIR、按 file ID 下载)。"
    "正文 E:/GameDev/GameDraft/agent_docs/asset-pipeline/norms.md 不变量 7。"
    "这不是误报可绕的门:别换写法、别换路径、别去下新的 Blender。"
)

# .local-disabled = 被替身顶掉后改名留在原处的原件,跑它同样算违规
BIN = r"blender(?:-launcher)?(?:\.exe)?(?:\.local-disabled)?"
# 语句开头可能出现的"前缀",之后紧跟的第一个 token 才是被执行的程序
PREFIX = (
    r"^(?:[({]\s*|\$\(\s*|!\s*)*"
    r"(?:(?:then|do|else|time|nohup|exec|call|env|sudo)\s+|timeout\s+\S+\s+|"
    r"cmd(?:\.exe)?\s+/[ck]\s+|start\s+(?:\"[^\"]*\"\s+)?|Invoke-Expression\s+|iex\s+|"
    r"&\s*|\.\s+|[A-Za-z_]\w*=\S*\s+)*"
)
EXEC_PATH = re.compile(PREFIX + r"""['"]?[^'"\s;|&=]*?(?<![\w-])""" + BIN + r"""['"]?(?=\s|$|\))""", re.I)
START_PROCESS = re.compile(r"Start-Process\b[^;\n]*?(?:-FilePath\s+)?['\"]?[^'\"\s;]*" + BIN + r"(?![\w_])", re.I)
# 语句中途的 PowerShell 调用运算符 / 块内调用:foreach (...) { & 'x\blender.exe' ... }
INLINE_CALL = re.compile(r"""(?:^|[\s{(])&\s*['"]?[^'"\s;|]*?(?<![\w-])""" + BIN + r"""['"]?(?=\s|$|\))""", re.I)
PY_SPAWN = re.compile(r"(subprocess|Popen|check_call|check_output|os\.system|os\.spawn|os\.exec|execFile|spawnSync|child_process)", re.I)
BIN_LITERAL = re.compile(r"(?<![\w-])blender(?:-launcher)?\.exe", re.I)
DOWNLOAD = re.compile(
    r"download\.blender\.org|blender-\d+\.\d+(?:\.\d+)?-(?:windows|linux|macos)[\w.-]*\.(?:zip|msi|exe|tar\.\w+|dmg)"
    r"|\b(?:winget|choco|scoop)\s+install\b[^;\n|]*\bblender\b"
    r"|\bpip3?\s+install\b[^;\n|]*(?<![\w-])bpy(?![\w-])"
    r"|-m\s+pip\s+install\b[^;\n|]*(?<![\w-])bpy(?![\w-])",
    re.I,
)
ASSIGN_HEAD = re.compile(r"(?:^|[\s;(&|])\$?(?P<v>[A-Za-z_]\w*)\s*=(?!=)")
ASSIGN_VALUE_HAS_BIN = re.compile(r"""\s*\(?\s*(?:Resolve-Path\s+(?:-LiteralPath\s+)?)?['"]?[^;\n&|\s]*?(?<![\w-])""" + BIN + r"(?![\w])", re.I)


def blender_vars(cmd: str) -> set[str]:
    """变量名 → 右值紧接着就是 blender 可执行路径(B=/x/blender.exe、$b = (Resolve-Path '...blender.exe').Path)。"""
    return {m.group("v") for m in ASSIGN_HEAD.finditer(cmd) if ASSIGN_VALUE_HAS_BIN.match(cmd, m.end())}


def statements(cmd: str):
    for line in re.split(r"\r?\n", cmd):
        for part in re.split(r"&&|\|\||;|\|", line):
            s = part.strip()
            if s:
                yield s


def violation(cmd: str) -> str | None:
    if DOWNLOAD.search(cmd):
        return "下载 / 安装本地 Blender 或 bpy"
    vars_ = blender_vars(cmd)
    var_exec = None
    if vars_:
        alt = "|".join(re.escape(v) for v in vars_)
        var_exec = re.compile(PREFIX + r"""['"]?\$\{?(?:env:)?(?:""" + alt + r""")\}?['"]?(?=\s|$|\))(?!\s*=)""", re.I)
        var_sp = re.compile(r"Start-Process\b[^;\n]*?\$(?:" + alt + r")\b", re.I)
    for s in statements(cmd):
        if EXEC_PATH.search(s) or EXEC_PATH.search(re.sub(r"^.*?\{\s*", "", s)) or INLINE_CALL.search(s):
            return f"在本机执行 Blender:{s[:160]}"
        if START_PROCESS.search(s):
            return f"Start-Process 起本机 Blender:{s[:160]}"
        if var_exec is not None and (var_exec.search(s) or var_exec.search(re.sub(r"^.*?\{\s*", "", s)) or var_sp.search(s)):
            return f"经变量执行本机 Blender:{s[:160]}"
    for line in cmd.splitlines():
        if BIN_LITERAL.search(line) and PY_SPAWN.search(line):
            return f"脚本里起本机 Blender 进程:{line.strip()[:160]}"
    return None


def main() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
        data = json.loads(sys.stdin.read() or "{}")
        if data.get("tool_name") not in ("Bash", "PowerShell"):
            return 0
        cmd = (data.get("tool_input") or {}).get("command") or ""
        why = violation(cmd)
        if not why:
            return 0
        sys.stderr.write(f"已拦截:{why}\n{RULE}\n")
        return 2
    except Exception:
        return 0


SELFTEST_BLOCK = [
    '"/e/GameDev/GameDraft/.tools/blender/blender-5.2.2-windows-x64/blender.exe" -b --version',
    'B=/e/x/blender-5.2.2-windows-x64/blender.exe && "$B" -b --factory-startup -P scripts/build_all.py -- --render r.png 2>&1 | tail',
    "cd /e/a; B=/e/x/blender.exe; \"$B\" -b -P s.py",
    "& 'E:\\Maz543\\testcar\\work\\tools\\blender-4.5.13-windows-x64\\blender.exe' -b --python-exit-code 1 --python x.py",
    "& '.\\work\\tools\\blender-4.5.13-windows-x64\\blender.exe' -b 'o.blend' --python-expr \"import bpy\"",
    "$taskBlender = (Resolve-Path '.tools\\blender\\blender-4.5.0-windows-x64\\blender.exe').Path\n$p = Start-Process -FilePath $taskBlender -ArgumentList @('--background','--python','x.py') -PassThru",
    "Start-Process -FilePath '.tools/blender/blender-4.5.0-windows-x64/blender.exe' -ArgumentList '--background'",
    "blender -b scene.blend -P render.py",
    "& 'E:\\FeiTing\\.tools\\blender\\blender-4.5.0-windows-x64\\blender.exe.local-disabled' -b",
    "Copy-Item x\\blender.exe.local-disabled y\\b.exe; B=/e/x/blender.exe.local-disabled; \"$B\" -b",
    "foreach ($c in $cs) { & 'E:\\M\\blender-4.5.13-windows-x64\\blender.exe' --background --python x.py }",
    "for f in a b; do { \"/e/x/blender.exe\" -b -P $f; }; done",
    "& ../face-cloth-v4/tools/blender-4.5.0-windows-x64/blender.exe --background --threads 4 --python export.py",
    "curl -L -o blender.zip https://download.blender.org/release/Blender5.2/blender-5.2.2-windows-x64.zip",
    "pip install bpy==4.5.0",
    "python -m pip install fake-bpy-module bpy",
    "python -c \"import subprocess; subprocess.run([r'E:/x/blender.exe', '-b'])\"",
    "winget install BlenderFoundation.Blender",
    "if true; then \"$BL\" -b; fi; BL=/e/x/blender-launcher.exe",
    "sed -i 's/oinfo = t.n(\"X\")\\n  col/c/' a.py && B=/e/x/blender-5.2.2-windows-x64/blender.exe && \"$B\" -b -P s.py",
]
SELFTEST_ALLOW = [
    "cd /e/GameDev/GameDraft/artifact/Blender_阎王岭山口; ls renders",
    "ls -la /e/GameDev/GameDraft/.tools/blender/",
    "Get-ChildItem 'C:\\Program Files\\Blender Foundation' -ErrorAction SilentlyContinue",
    "Get-Process blender -ErrorAction SilentlyContinue | Stop-Process",
    "tasklist //FI \"IMAGENAME eq blender.exe\"",
    "Get-CimInstance Win32_Process -Filter \"Name='blender.exe'\" | Stop-Process",
    "sh scripts/py.sh artifact/Blender_阎王岭山口/hub/run_on_hub.py --render out.png",
    "cat > main.py <<'EOF'\nimport bpy\nprint(bpy.app.version_string)\nEOF",
    "grep -rn blender.exe tools/",
    "curl -sS --noproxy '*' http://denghong01:8765/v1/blender/versions",
    "pip install fake-bpy-module-latest",
    "Rename-Item blender.exe blender.exe.disabled",
    "$exe = 'E:\\x\\blender-5.2.2-windows-x64\\blender.exe'; Test-Path $exe",
]


def selftest() -> int:
    bad = 0
    for c in SELFTEST_BLOCK:
        if not violation(c):
            print("MISSED:", c); bad += 1
    for c in SELFTEST_ALLOW:
        v = violation(c)
        if v:
            print("FALSE POSITIVE:", c, "->", v); bad += 1
    print("selftest", "ok" if not bad else f"{bad} failures")
    return 1 if bad else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
