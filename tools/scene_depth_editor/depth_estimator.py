from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from PIL import Image


StatusCallback = Callable[[str], None]


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

        try:
            import torch
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        except Exception as exc:  # pragma: no cover - runtime dependency guard
            raise RuntimeError(
                "缺少深度估计依赖。请先执行：\n"
                "python -m pip install -r tools\\scene_depth_editor\\requirements.txt"
            ) from exc

        # 优先从本地缓存加载，无缓存时才从网络下载
        if status:
            status("正在加载深度模型...")
        try:
            self._processor = AutoImageProcessor.from_pretrained(model_id, local_files_only=True)
            self._model = AutoModelForDepthEstimation.from_pretrained(model_id, local_files_only=True)
            if status:
                status("已从本地缓存加载模型。")
        except (OSError, ValueError) as _e:
            if status:
                status(f"本地无缓存，正在下载模型：{model_id}")
            self._processor = AutoImageProcessor.from_pretrained(model_id)
            self._model = AutoModelForDepthEstimation.from_pretrained(model_id)
            if status:
                status("模型下载完成。")
        self._model.eval()
        self._model_id = model_id
        return torch

