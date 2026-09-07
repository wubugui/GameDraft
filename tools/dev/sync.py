"""DVC/OSS/git orchestration tasks."""

from __future__ import annotations

import subprocess

from tools.dev import bootstrap, creds, proxyenv
from tools.dev.paths import project_python, repo_root

RUNTIME_TARGET = "public/resources/runtime.dvc"
EDITOR_TARGET = "resources/editor_projects.dvc"
VENDOR_TARGET = "resources/vendor_archives.dvc"
#: 配音原始音源库(~70MB,只有 tools/voice_workbench 用)。**不在默认拉取集里**,
#: 理由见 pull() 的 docstring。
AUDIO_SOURCES_TARGET = "resources/audio_sources.dvc"
#: 音频工作台的候选素材池(~200MB,只有 tools/audio_editor 用)。挑中的料经工作台
#: 导出到 runtime/audio 才算成品;这一份是**还没挑完**的候选与对照批次,重生成要花钱
#: 且抽卡结果不可复现,所以也托管起来。与配音音源同一个开关(--audio / init-audio):
#: 两份都是"只有音频工作侧要"的大素材,再拆一个开关只会让人记不住。
AUDIO_IMPORTED_TARGET = "tools/audio_editor/imported.dvc"

#: 全部 DVC 托管目标。push/commit 面向这一份,但都按"这台机器上真有的"过滤——
#: 可选目标(--audio)没拉过时,本机缓存里根本没有那份 blob。
ALL_DVC_TARGETS = [
    RUNTIME_TARGET,
    EDITOR_TARGET,
    VENDOR_TARGET,
    AUDIO_SOURCES_TARGET,
    AUDIO_IMPORTED_TARGET,
]

#: `dvc add` 的工作区路径,与上面一一对应(DVC 约定:去掉 .dvc 后缀就是被跟踪的目录)。
COMMIT_DVC_ADD_PATHS = [target[: -len(".dvc")] for target in ALL_DVC_TARGETS]
COMMIT_GIT_ADD_PATHS = [
    ".dvc",
    ".dvcignore",
    ".gitignore",
    "public/assets",
    "public/resources",
    "resources",
    "src",
    "tools",
    "scripts",
    "config",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "README.md",
    "bootstrap.sh",
    "dev.sh",
    "scripts/pull-all.sh",
    "scripts/push-all.sh",
    "scripts/commit-all.sh",
]


def run_project_python(args: list[str], check: bool = True) -> int:
    proc = subprocess.run([str(project_python()), *args], cwd=str(repo_root()), check=False)
    if check and proc.returncode != 0:
        raise SystemExit(
            f"{' '.join(args[:2])} failed with exit code {proc.returncode}"
        )
    return proc.returncode


def sync_dvc_cache(action: str, *targets: str) -> None:
    script = repo_root() / "scripts" / "sync-dvc-cache.py"
    run_project_python([str(script), action, *targets])


def pull_dvc_target(target: str) -> None:
    with proxyenv.without_proxy():
        sync_dvc_cache("pull", target)
        run_project_python(["-m", "dvc", "checkout", target])


def target_is_in_local_cache(target: str) -> bool:
    """目标的内容在不在本机 DVC 缓存里。

    push 侧会把每个目标的 root oid 当目录清单展开(scripts/sync-dvc-cache.py 的
    collect_required_oids_from_local),缓存里没有那份 .dir blob 就直接抛
    FileNotFoundError。可选目标(--audio)在没拉过的机器上恒定是这种状态,
    所以在送进去之前先问一句——**缓存里没有 = 本机压根没有可推的东西**,
    不是"推丢了"。
    """
    root = repo_root()
    dvcfile = root / target
    if not dvcfile.is_file():
        return False

    import yaml  # dvc 的依赖;放函数里,免得没装 dvc 的机器连 import 都过不去

    outs = (yaml.safe_load(dvcfile.read_text(encoding="utf-8")) or {}).get("outs") or []
    if not outs:
        return False
    for out in outs:
        oid = out.get("md5") or ""
        if not oid:
            return False
        if not (root / ".dvc" / "cache" / "files" / "md5" / oid[:2] / oid[2:]).exists():
            return False
    return True


def _partition_available(items: list[str], available) -> tuple[list[str], list[str]]:
    present = [item for item in items if available(item)]
    return present, [item for item in items if item not in present]


def init_runtime(install_deps_after: bool = False) -> int:
    bootstrap.ensure_local_python()
    creds.assert_credentials()
    pull_dvc_target(VENDOR_TARGET)
    pull_dvc_target(RUNTIME_TARGET)
    if install_deps_after:
        from tools.dev import deps

        deps.install_deps()
    print("Runtime resources are ready.")
    return 0


def init_editor() -> int:
    bootstrap.ensure_local_python()
    creds.assert_credentials()
    pull_dvc_target(VENDOR_TARGET)
    pull_dvc_target(EDITOR_TARGET)
    print("Editor project resources are ready.")
    return 0


def init_audio() -> int:
    """把两份音频素材库拉到本机:配音原始音源 + 音频工作台的候选池。

    单独一个入口而不是并进 init_editor:这 270MB 只有两个工作台用,而它们在
    源库缺席时按设计如实报「源不在本机」,并不会坏掉。
    """
    bootstrap.ensure_local_python()
    creds.assert_credentials()
    pull_dvc_target(VENDOR_TARGET)
    pull_dvc_target(AUDIO_SOURCES_TARGET)
    pull_dvc_target(AUDIO_IMPORTED_TARGET)
    print("Audio source libraries are ready (voice sources + workbench candidates).")
    return 0


def pull(editor: bool = False, audio: bool = False, git_proxy: str = "") -> int:
    """git pull + 按需拉 DVC 目标。

    默认集只有运行游戏必需的两份(vendor + runtime);编辑器工程走 --editor,
    两份音频素材库(配音音源 + 工作台候选池)走 --audio。它们之所以不并进 --editor
    (尽管两个工作台都是从主编辑器菜单起的):scripts/pull-all.sh 无条件带 --editor,
    并进去就等于把 270MB 变成事实上的默认拉取,而绝大多数人拉仓库是为了跑游戏/改数据,
    不是为了重录配音或重挑音效。
    """
    # Mask once at entry so nested without_proxy() blocks do not restore
    # inherited HTTP(S)_PROXY mid-run.
    proxyenv.mask_proxy_env()
    rc = proxyenv.run_git_with_temp_proxy(["pull"], git_proxy)
    if rc != 0:
        raise SystemExit(f"git pull failed with exit code {rc}")

    bootstrap.ensure_local_python()
    creds.assert_credentials()
    pull_dvc_target(VENDOR_TARGET)
    pull_dvc_target(RUNTIME_TARGET)
    if editor:
        pull_dvc_target(EDITOR_TARGET)
    if audio:
        pull_dvc_target(AUDIO_SOURCES_TARGET)
        pull_dvc_target(AUDIO_IMPORTED_TARGET)
    return 0


def push(git_proxy: str = "") -> int:
    proxyenv.mask_proxy_env()
    bootstrap.ensure_local_python()
    creds.assert_credentials()

    targets, missing = _partition_available(ALL_DVC_TARGETS, target_is_in_local_cache)
    for target in missing:
        print(f"Skipping {target}: not in this machine's DVC cache, nothing to push.")

    with proxyenv.without_proxy():
        run_project_python(["-m", "dvc", "status"])
        if targets:
            sync_dvc_cache("push", *targets)

    rc = proxyenv.run_git_with_temp_proxy(["push"], git_proxy)
    if rc != 0:
        raise SystemExit(f"git push failed with exit code {rc}")
    return 0


def commit(message: str) -> int:
    bootstrap.ensure_local_python()
    # 没拉过的可选目标在本机根本没有那个目录,`dvc add` 会直接报错退出;
    # 跳过它不会漏提交——不存在的目录里没有改动。
    add_paths, missing = _partition_available(
        COMMIT_DVC_ADD_PATHS, lambda path: (repo_root() / path).exists()
    )
    for path in missing:
        print(f"Skipping dvc add {path}: not present on this machine.")
    if add_paths:
        run_project_python(["-m", "dvc", "add", *add_paths])
    root = str(repo_root())
    subprocess.run(["git", "add", *COMMIT_GIT_ADD_PATHS], cwd=root, check=True)
    subprocess.run(["git", "add", "-u"], cwd=root, check=True)
    return subprocess.call(["git", "commit", "-m", message], cwd=root)


def configure_oss(
    bucket: str,
    prefix: str = "gamedraft/dvc",
    endpoint: str = "https://oss-cn-hangzhou.aliyuncs.com",
) -> int:
    bootstrap.ensure_local_python()
    key_id, key_secret = creds.ensure_credentials(prompt=False)
    with proxyenv.without_proxy():
        run_project_python(["-m", "dvc", "remote", "modify", "aliyun_oss", "url", f"oss://{bucket}/{prefix}"])
        run_project_python(["-m", "dvc", "remote", "modify", "aliyun_oss", "oss_endpoint", endpoint])
        run_project_python(["-m", "dvc", "remote", "modify", "--local", "aliyun_oss", "oss_key_id", key_id])
        run_project_python(["-m", "dvc", "remote", "modify", "--local", "aliyun_oss", "oss_key_secret", key_secret])
        run_project_python(["-m", "dvc", "remote", "list"])
    return 0
