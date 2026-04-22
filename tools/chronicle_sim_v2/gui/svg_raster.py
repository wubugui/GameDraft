"""将 SVG 栅格化为 PNG data URL，供 QTextBrowser 通过 <img> 显示（其富文本不支持内联 SVG）。"""
from __future__ import annotations

import base64
import sys


def svg_to_png_data_url(svg: str) -> str | None:
    """SVG 字符串 → ``data:image/png;base64,...``；失败返回 ``None``。"""
    try:
        from PySide6.QtCore import QByteArray, QBuffer, QIODevice
        from PySide6.QtGui import QImage, QPainter
        from PySide6.QtSvg import QSvgRenderer
        from PySide6.QtWidgets import QApplication
    except ImportError:
        return None

    # QPainter / QSvgRenderer 在未创建 QApplication 的部分环境下会不稳定
    app = QApplication.instance()
    if app is None:
        QApplication(sys.argv)

    data = QByteArray(svg.encode("utf-8"))
    renderer = QSvgRenderer(data)
    if not renderer.isValid():
        return None

    sz = renderer.defaultSize()
    w = max(int(sz.width()), 1)
    h = max(int(sz.height()), 1)
    scale = 2
    img = QImage(w * scale, h * scale, QImage.Format.Format_ARGB32)
    img.fill(0xFFFFFFFF)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    p.scale(float(scale), float(scale))
    renderer.render(p)
    p.end()

    ba = QByteArray()
    buf = QBuffer(ba)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    if not img.save(buf, "PNG"):
        return None
    b64 = base64.b64encode(bytes(ba)).decode("ascii")
    return f"data:image/png;base64,{b64}"
