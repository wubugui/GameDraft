// 数学公式渲染:pymdownx.arithmatex(generic 模式)把 $...$ / $$...$$ 包成
// <span class="arithmatex">\(...\)</span> / <div class="arithmatex">\[...\]</div>,
// 这里用本地 KaTeX 的 auto-render 逐页扫一遍。document$ 由 Material 提供,
// 每次页面切换(含搜索跳转)都会重新触发,不用自己监听。
document$.subscribe(({ body }) => {
  renderMathInElement(body, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
      { left: "\\[", right: "\\]", display: true },
    ],
    // 公式写错不整页报错,原样留着让人看见哪里错了
    throwOnError: false,
  });
});
