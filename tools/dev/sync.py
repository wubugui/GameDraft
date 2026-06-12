"""DVC/OSS/git orchestration tasks, ported from scripts/*.ps1.

Covers: init-runtime, init-editor, pull (pull-all), push (push-all),
commit (commit-all), configure-oss, upload-bootstrap.
"""

from __future__ import annotations

import subprocess

from tools.dev import bootstrap, creds, proxyenv
from tools.dev.paths import project_python, repo_root

RUNTIME_TARGET = "public/resources/runtime.dvc"
EDITOR_TARGET = "resources/editor_projects.dvc"
VENDOR_TARGET = "resources/vendor_archives.dvc"

# Ported verbatim from scripts/commit-all.ps1, plus the cross-platform entries.
COMMIT_DVC_ADD_PATHS = [
    "public/resources/runtime",
    "resources/editor_projects",
    "resources/vendor_archives",
]
COMMIT_GIT_ADD_PATHS = [
    ".dvc",
    ".dvcignore",
    ".gitignore",
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
    "pull-all.sh",
    "push-all.sh",
    "commit-all.sh",
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


def init_runtime(install_deps_after: bool = False) -> int:
    bootstrap.ensure_local_python()
    creds.assert_credentials()
    pull_dvc_target(RUNTIME_TARGET)
    if install_deps_after:
        from tools.dev import deps

        deps.install_deps()
    print("Runtime resources are ready.")
    return 0


def init_editor() -> int:
    bootstrap.ensure_local_python()
    creds.assert_credentials()
    pull_dvc_target(EDITOR_TARGET)
    print("Editor project resources are ready.")
    return 0


def pull(editor: bool = False, vendor: bool = False, git_proxy: str = "") -> int:
    # Mask once at entry so nested without_proxy() blocks do not restore
    # inherited HTTP(S)_PROXY mid-run (see scripts/no-proxy.ps1 notes).
    proxyenv.mask_proxy_env()
    rc = proxyenv.run_git_with_temp_proxy(["pull"], git_proxy)
    if rc != 0:
        raise SystemExit(f"git pull failed with exit code {rc}")

    bootstrap.ensure_local_python()
    creds.assert_credentials()
    pull_dvc_target(RUNTIME_TARGET)
    if editor:
        pull_dvc_target(EDITOR_TARGET)
    if vendor:
        pull_dvc_target(VENDOR_TARGET)
    return 0


def push(git_proxy: str = "") -> int:
    proxyenv.mask_proxy_env()
    bootstrap.ensure_local_python()
    creds.assert_credentials()

    with proxyenv.without_proxy():
        run_project_python(["-m", "dvc", "status"])
        sync_dvc_cache("push", RUNTIME_TARGET, EDITOR_TARGET, VENDOR_TARGET)

    rc = proxyenv.run_git_with_temp_proxy(["push"], git_proxy)
    if rc != 0:
        raise SystemExit(f"git push failed with exit code {rc}")
    return 0


def commit(message: str) -> int:
    bootstrap.ensure_local_python()
    run_project_python(["-m", "dvc", "add", *COMMIT_DVC_ADD_PATHS])
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


def upload_bootstrap(
    bucket: str = "gamedraft-assets",
    endpoint: str = "https://oss-cn-shanghai.aliyuncs.com",
    prefix: str = "gamedraft/bootstrap",
    archive_name: str = "python311-dvc-win-x64.zip",
) -> int:
    creds.assert_credentials()
    archive = repo_root() / "resources" / "vendor_archives" / archive_name
    key = prefix.rstrip("/") + "/" + archive_name
    script = repo_root() / "scripts" / "upload-bootstrap.py"
    with proxyenv.without_proxy():
        run_project_python(
            [str(script), "--bucket", bucket, "--endpoint", endpoint, "--file", str(archive), "--key", key]
        )
    return 0
