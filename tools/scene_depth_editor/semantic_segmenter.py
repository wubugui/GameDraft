from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from PIL import Image


StatusCallback = Callable[[str], None]


SEGMENTATION_MODEL_OPTIONS = {
    "segformer_b2": "nvidia/segformer-b2-finetuned-ade-512-512",
    "segformer_b5": "nvidia/segformer-b5-finetuned-ade-640-640",
}


DEFAULT_FOREGROUND_KEYWORDS = (
    "table",
    "chair",
    "armchair",
    "seat",
    "sofa",
    "curtain",
    "screen",
    "screen door",
    "door",
    "pillar",
    "column",
    "cabinet",
    "counter",
    "bar",
    "railing",
    "fence",
    "stair",
    "bench",
    "person",
)


@dataclass(slots=True)
class SegmentationResult:
    label_map: np.ndarray
    class_labels: dict[int, str]
    preview_image: Image.Image

    def present_class_ids(self) -> list[int]:
        ids = np.unique(self.label_map).tolist()
        ids.sort()
        return ids

    def default_foreground_ids(self) -> list[int]:
        result: list[int] = []
        for class_id in self.present_class_ids():
            label = self.class_labels.get(class_id, f"class_{class_id}").lower()
            if any(keyword in label for keyword in DEFAULT_FOREGROUND_KEYWORDS):
                result.append(class_id)
        return result

    def build_mask_for_class_ids(self, class_ids: list[int]) -> Image.Image:
        if not class_ids:
            return Image.new("L", (self.label_map.shape[1], self.label_map.shape[0]), color=0)
        selected = np.isin(self.label_map, class_ids)
        return Image.fromarray((selected.astype(np.uint8) * 255), mode="L")


class SemanticSegmenter:
    def __init__(self) -> None:
        self._model_id: str | None = None
        self._processor = None
        self._model = None

    def segment(
        self,
        image: Image.Image,
        model_id: str,
        status: StatusCallback | None = None,
    ) -> SegmentationResult:
        torch = self._ensure_model(model_id, status)

        if status:
            status("正在执行语义分割...")

        rgb = image.convert("RGB")
        inputs = self._processor(images=rgb, return_tensors="pt")

        with torch.inference_mode():
            outputs = self._model(**inputs)

        post_processed = self._processor.post_process_semantic_segmentation(
            outputs,
            target_sizes=[rgb.size[::-1]],
        )[0]
        label_map = post_processed.detach().cpu().numpy().astype(np.int32)
        preview = self._build_preview(label_map)
        class_labels = {
            int(class_id): str(label)
            for class_id, label in self._model.config.id2label.items()
        }

        if status:
            status("语义分割完成。")

        return SegmentationResult(
            label_map=label_map,
            class_labels=class_labels,
            preview_image=preview,
        )

    def _build_preview(self, label_map: np.ndarray) -> Image.Image:
        height, width = label_map.shape
        color_image = np.zeros((height, width, 3), dtype=np.uint8)
        unique_ids = np.unique(label_map)
        for class_id in unique_ids:
            color_image[label_map == class_id] = self._color_for_class_id(int(class_id))
        return Image.fromarray(color_image, mode="RGB")

    def _color_for_class_id(self, class_id: int) -> tuple[int, int, int]:
        return (
            (class_id * 67 + 53) % 256,
            (class_id * 97 + 101) % 256,
            (class_id * 139 + 29) % 256,
        )

    def _ensure_model(self, model_id: str, status: StatusCallback | None):
        if self._model_id == model_id and self._processor is not None and self._model is not None:
            import torch

            return torch

        try:
            import torch
            from transformers import AutoImageProcessor, SegformerForSemanticSegmentation
        except Exception as exc:  # pragma: no cover - runtime dependency guard
            raise RuntimeError(
                "缺少语义分割依赖。请先执行：\n"
                "python -m pip install -r tools\\scene_depth_editor\\requirements.txt"
            ) from exc

        if status:
            status(f"正在加载语义分割模型：{model_id}")

        self._processor = AutoImageProcessor.from_pretrained(model_id)
        self._model = SegformerForSemanticSegmentation.from_pretrained(model_id)
        self._model.eval()
        self._model_id = model_id
        return torch

