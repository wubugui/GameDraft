# -*- coding: utf-8 -*-
"""手册站的契约:配置能装载、公式/表格/代码/高亮真的渲出来、中文能进搜索索引、启动器命令行钉死。

不碰 handbook/docs 的真实正文(那是制作人的);渲染测试用临时 docs 目录 + 一页夹具。
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.handbook import (  # noqa: E402
    CONFIG_PATH,
    DEFAULT_PORT,
    HANDBOOK_DIR,
    build_argv,
    serve_argv,
)

mkdocs = pytest.importorskip("mkdocs")
pytest.importorskip("material")
pytest.importorskip("jieba")

FIXTURE_MD = """# 光照模型

行内公式 $L = \\rho \\sum_i E_i$,块公式:

$$
\\mathrm{surf} = \\mathrm{painting} + \\mathrm{albedo} \\times \\sum_i E_i
$$

| 量 | 单位 | 空间 |
|---|---|---|
| 灯位 | wu | M-world |

```ts
const a = 1;
```

这里有 ==高亮== 的词,还有场景声学与回音。
"""


def test_config_loads_with_zh_search_and_math():
    from mkdocs.config import load_config

    cfg = load_config(config_file=str(CONFIG_PATH))
    assert cfg["site_name"] == "GameDraft 手册"
    assert cfg["use_directory_urls"] is False, "双击 site/index.html 走 file:// 也要能翻页"
    # Material 接管的 search 插件登记名带主题前缀
    search = cfg["plugins"].get("material/search") or cfg["plugins"].get("search")
    assert search is not None, list(cfg["plugins"])
    assert set(search.config["lang"]) >= {"zh", "en"}
    names = {ext if isinstance(ext, str) else next(iter(ext)) for ext in cfg["markdown_extensions"]}
    for needed in ("pymdownx.arithmatex", "pymdownx.superfences", "pymdownx.highlight", "pymdownx.mark", "tables"):
        assert needed in names, needed
    assert cfg["theme"].name == "material"


def test_vendor_assets_present_for_offline_rendering():
    docs = HANDBOOK_DIR / "docs"
    for rel in ("assets/vendor/katex/katex.min.js", "assets/vendor/katex/katex.min.css",
                "assets/vendor/katex/contrib/auto-render.min.js", "assets/vendor/mermaid/mermaid.min.js",
                "assets/javascripts/katex-init.js", "assets/stylesheets/handbook.css"):
        assert (docs / rel).is_file(), rel
    assert any((docs / "assets/vendor/katex/fonts").glob("*.woff2")), "KaTeX 字体没带,公式会退成系统字体"


def test_build_renders_math_table_code_mark_and_indexes_chinese(tmp_path: Path):
    from mkdocs.commands.build import build
    from mkdocs.config import load_config

    docs = tmp_path / "docs"
    shutil.copytree(HANDBOOK_DIR / "docs" / "assets", docs / "assets")
    (docs / "index.md").write_text("# 手册\n", encoding="utf-8")
    (docs / "lighting.md").write_text(FIXTURE_MD, encoding="utf-8")
    site = tmp_path / "site"

    cfg = load_config(config_file=str(CONFIG_PATH), docs_dir=str(docs), site_dir=str(site))
    build(cfg)

    html = (site / "lighting.html").read_text(encoding="utf-8")
    assert 'class="arithmatex"' in html, "arithmatex 没接上,公式不会被 KaTeX 扫到"
    assert "<table>" in html and "<th>单位</th>" in html
    assert 'class="language-ts highlight"' in html and 'class="kd">const<' in html, "代码块没走 pygments 高亮"
    assert "<mark>高亮</mark>" in html
    assert "assets/vendor/katex/katex.min.css" in html and "katex-init.js" in html
    assert "mermaid.min.js" in html
    # 离线:不许有外网字体/脚本
    assert "fonts.googleapis.com" not in html
    assert "unpkg.com" not in html

    index = json.loads((site / "search" / "search_index.json").read_text(encoding="utf-8"))
    docs_texts = [d.get("text", "") + d.get("title", "") for d in index["docs"]]
    assert any("声学" in t or "回音" in t for t in docs_texts), "中文正文没进搜索索引"
    assert any(d["location"].startswith("lighting.html") for d in index["docs"])


def test_launcher_argv_are_pinned():
    py = "C:/venv/python.exe"
    assert serve_argv(py, Path("h/mkdocs.yml"), host="127.0.0.1", port=DEFAULT_PORT) == [
        py, "-m", "mkdocs", "serve", "-f", "h/mkdocs.yml".replace("/", "\\") if sys.platform == "win32" else "h/mkdocs.yml",
        "-a", f"127.0.0.1:{DEFAULT_PORT}",
    ]
    assert serve_argv(py, Path("h/mkdocs.yml"), livereload=False)[-1] == "--no-livereload"
    b = build_argv(py, Path("h/mkdocs.yml"), Path("out"))
    assert b[:5] == [py, "-m", "mkdocs", "build", "--clean"] and b[-2:] == ["-d", "out"]
