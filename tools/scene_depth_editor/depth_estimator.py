from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable

from PIL import Image


StatusCallback = Callable[[str], None]

# 本机统一代理(GitHub/PyPI/HuggingFace 走它；OSS 绕过)。
# 自动安装依赖与下载模型时临时挂上；可用环境变量 SCENE_DEPTH_PROXY 覆盖。
DEP_PROXY = os.environ.get("SCENE_DEPTH_PROXY", "http://127.0.0.1:7078")
_DEPS = ["torch", "torchvision", "transformers"]
_PROXY_ENV_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")


def _import_depth_deps() -> None:
    """尝试导入深度估计依赖；缺失则抛 ImportError。

    含 torchvision：AutoImageProcessor 处理 Depth Anything 时依赖它，
    且只在运行时才报错——必须在这里一并校验，自动安装的闸门才能捕获它。
    """
    import torch  # noqa: F401
    import torchvision  # noqa: F401
    from transformers import (  # noqa: F401
        AutoImageProcessor,
        AutoModelForDepthEstimation,
    )


def _pip_install_depth_deps(status: StatusCallback | None) -> None:
    """用本工具的 Python 自动安装 torch/transformers，临时挂 DEP_PROXY 代理，流式回报进度。"""
    env = os.environ.copy()
    for k in _PROXY_ENV_KEYS:
        env[k] = DEP_PROXY
    cmd = [sys.executable, "-m", "pip", "install", "--proxy", DEP_PROXY, *_DEPS]
    if status:
        status(f"缺少依赖，正在自动安装(代理 {DEP_PROXY})：{' '.join(_DEPS)} …可能需几分钟")
    proc = subprocess.Popen(
        cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        tail.append(line)
        del tail[:-8]
        if status:
            status("安装依赖：" + line[:90])
    if proc.wait() != 0:
        raise RuntimeError("pip 安装失败：\n" + "\n".join(tail[-6:]))


class _ProxyEnv:
    """临时给本进程挂上代理(供 HuggingFace 下载模型用)，退出时还原。"""

    def __enter__(self) -> "_ProxyEnv":
        self._old = {k: os.environ.get(k) for k in _PROXY_ENV_KEYS}
        for k in _PROXY_ENV_KEYS:
            os.environ[k] = DEP_PROXY
        return self

    def __exit__(self, *exc: object) -> bool:
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


MODEL_OPTIONS = {
    "small": "LiheYoung/depth-anything-small-hf",
    "base": "LiheYoung/depth-anything-base-hf",
}


@dataclass(slots=True)
class DepthResult:
    image: Image.Image
    min_value: float
    max_value: float
    raw_normalized: object  # numpy float32 ndarray [0,1], near=bright(high)


class DepthEstimator:
    def __init__(self) -> None:
        self._model_id: str | None = None
        self._processor = None
        self._model = None

    def generate_depth(
        self,
        image: Image.Image,
        model_id: str,
        status: StatusCallback | None = None,
    ) -> DepthResult:
        torch = self._ensure_model(model_id, status)
        from torch.nn.functional import interpolate

        if status:
            status("正在推理深度图...")

        rgb = image.convert("RGB")
        inputs = self._processor(images=rgb, return_tensors="pt")

        with torch.inference_mode():
            outputs = self._model(**inputs)
            predicted_depth = outputs.predicted_depth

        prediction = interpolate(
            predicted_depth.unsqueeze(1),
            size=rgb.size[::-1],
            mode="bicubic",
            align_corners=False,
        ).squeeze()

        prediction = prediction.detach().cpu().numpy()
        min_value = float(prediction.min())
        max_value = float(prediction.max())

        if max_value - min_value < 1e-8:
            import numpy as np
            normalized = np.full(prediction.shape, 0.5, dtype=np.float32)
            depth_image = Image.new("L", rgb.size, color=128)
        else:
            normalized = (prediction - min_value) / (max_value - min_value)
            depth_image = Image.fromarray((normalized * 255.0).clip(0, 255).astype("uint8"), mode="L")
            normalized = normalized.astype("float32")

        if status:
            status("深度图生成完成。")

        return DepthResult(depth_image, min_value=min_value, max_value=max_value,
                           raw_normalized=normalized)

    def _ensure_model(self, model_id: str, status: StatusCallback | None):
        if self._model_id == model_id and self._processor is not None and self._model is not None:
            import torch

            return torch

        # 1) 依赖：缺则自动安装(挂代理)，再重试导入
        try:
            _import_depth_deps()
        except Exception:
            try:
                _pip_install_depth_deps(status)
            except Exception as exc:
                raise RuntimeError(
                    "自动安装深度估计依赖失败(检查 7078 代理是否开着)。也可手动执行：\n"
                    f"{sys.executable} -m pip install --proxy {DEP_PROXY} {' '.join(_DEPS)}"
                ) from exc
            try:
                _import_depth_deps()
            except Exception as exc:
                raise RuntimeError("依赖已安装但仍无法导入，请重启工具后重试。") from exc

        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        # 2) 模型：优先本地缓存；无缓存时挂代理自动下载
        if status:
            status("正在加载深度模型...")
        try:
            self._processor = AutoImageProcessor.from_pretrained(model_id, local_files_only=True)
            self._model = AutoModelForDepthEstimation.from_pretrained(model_id, local_files_only=True)
            if status:
                status("已从本地缓存加载模型。")
        except (OSError, ValueError):
            if status:
                status(f"本地无缓存，正在下载模型(代理 {DEP_PROXY})：{model_id}")
            with _ProxyEnv():
                self._processor = AutoImageProcessor.from_pretrained(model_id)
                self._model = AutoModelForDepthEstimation.from_pretrained(model_id)
            if status:
                status("模型下载完成。")
        self._model.eval()
        self._model_id = model_id
        return torch
