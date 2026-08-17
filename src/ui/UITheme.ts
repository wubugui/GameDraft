export const UITheme = {
  colors: {
    // 面板底：**逐块量过设计稿**（行囊内部 #191611、规矩本右页 #191714、
    // 对话框内部 #13120f、暂停牌内 #150f09、活计空白 #0d0b07），比目测暗得多。
    // 中途按目测抬到过 0x1c1712，是错的——底一抬亮，木框与底的反差就塌了，
    // 远看只剩内金线那一条，稿子里那"看得见的一圈厚木"就没了。改这几个值前先量一次稿子。
    panelBg: 0x171410,
    panelBgAlt: 0x1b1712,
    dialogueBg: 0x12100d,
    // 遭遇底：太黑的话叠上 0.92 alpha + 纸纹 + 暗角之后「偏红」就读不出来了，
    // 在夜景里尤其。抬一档，让「出事了」这层意思从材质里透出来。
    encounterBg: 0x2a1113,
    mainMenuBg: 0x150f09,
    detailBg: 0x1d1811,
    bookBg: 0x181513,

    panelBorder: 0x4a3a24,
    encounterBorder: 0x664444,
    borderSubtle: 0x342a1c,
    borderMid: 0x3a2e1e,
    borderActive: 0x6b5636,
    bookBorder: 0x6b5a3e,

    /**
     * 内金细线：木框内侧那一圈。设计稿里每块大面板都有，是「木框 + 一线金」这套
     * 观感的第二根支柱——只有木框没有它，面板会退回成一块糊在一起的暗板。
     */
    hairline: 0xa8874f,
    /** 标题两侧那条向外渐隐的横线 */
    titleRule: 0x7a6338,

    /**
     * 选中态琥珀：列表行/菜单项/按钮被选中时整条铺的暖光。
     * 设计稿里选中不是「换个深色」而是「点亮一档」，两个色配 borderSelected 一起用。
     */
    // ⚠ 这两个值被 `drawSelectedRow` 铺满整条，**很容易过曝**：
    // 首版 0x59421d + 0.95 alpha 铺出来像贴了荧光笔，文字被衬到反白。
    // 稿子里选中只是「点亮一档」——真正说明"选中"的是 borderSelected 那圈金描边，
    // 填充只做一层暖光。改值前先看一眼 tmp/ui_mockups_2026-08-03/02 与 11 的选中项。
    selectedFill: 0x4a381c,
    selectedFillDim: 0x2c2113,
    borderSelected: 0xc9a05a,

    overlay: 0x000000,

    rowBg: 0x241d13,
    rowBgDark: 0x1c160e,
    rowBgInactive: 0x17120b,
    rowHover: 0x342713,
    encounterRow: 0x221111,
    encounterHover: 0x332222,

    title: 0xffcc88,
    /** 主角说话人名：同一暖色系里提亮一档，与 NPC 的 title 拉开而不跳出配色 */
    speakerSelf: 0xfff0d8,
    // ── 语义灰五档（2026-08-17 批2a 收敛）────────────────────────────────
    // 前史：这批灰原本是冷蓝灰（bbbbcc / aaaacc / 555566 / 888899 / 8888aa / ccccdd），
    // 是 debug 配色的残留，在暖近黑 + 旧木的画面里每一处都发蓝，先统一挪进了暖灰；
    // 挪暖后灰域又膨胀到 14 档 + 同值双名，相邻档肉眼不可分——审查主诉
    // 「文字没有重点」的令牌层根因。收敛为五档，旧名去向见各键注释。
    /** 主文（并入原 bodyLight 0xcccccc） */
    body: 0xdddddd,
    /** 次主文/强调次级（并入原 bodyDim 0xc4bbad、buttonText 0xd6cec0） */
    bodyMuted: 0xccbbaa,
    /** 说明/描述（并入原 subtle 0xb0a690、ruleDesc 0x999988、同值双名 questDesc） */
    descText: 0xa9a094,
    /**
     * 注/弱提示（并入原 section 0x8f8672、ruleSource 0x777766、ruleProgress 0x888877、
     * descTextDim 0x8e867a、pageInfo 0x6b6355、同值双名 questDescDim；
     * 旧 hint 0x5c5346 / hintLight 0x736b5e 对比度塌陷是审查主诉，统一提亮到这档）
     */
    hintMid: 0x857c6e,
    /** 禁用/占位（并入原 disabledDark 0x555555）。原值 0x666666 是暖木配色里的中性灰残留，换同明度暖灰 */
    disabled: 0x6b6355,

    gold: 0xffcc66,
    orange: 0xffaa44,
    // ⚠ green/greenBright 在 UI 里**已停用**（正绿在暖近黑上像 web 徽标）。
    // toast 图标、状态字一律走 title/ruleEffective。留着只为不破坏历史调用点的编译。
    green: 0x8fae72,
    greenBright: 0x9dbb86,
    red: 0xff8866,
    /** 「新/未读」小圆点：原来是纯红 0xff6644，在整屏暖木里是唯一一点正红，收进琥珀 */
    redDot: 0xd9a052,

    // 滑条/滚动条：原本是冷灰蓝（0x333344 / 0x88aacc），在暖木配色里是唯一一处
    // 蓝调，一眼就露出「debug 控件」的底。改成暗木槽 + 琥珀滑块。
    sliderTrack: 0x2a2118,
    sliderFill: 0xb98d4f,
    sliderHandle: 0xb98d4f,
    dangerBg: 0x442222,
    dangerBorder: 0x665544,

    // 规矩状态色：原来是 web 味的纯绿 0x66cc66 / 纯红 0xcc6644，
    // 而行底又由 dimColor 从状态色现算 → 整行都带正绿/正红色相，
    // 在这套暖近黑里像 success/danger 徽标。脱饱和成苔绿与砖红。
    ruleUnverified: 0xccaa44,
    ruleEffective: 0x8fae72,
    ruleQuestionable: 0xb0644a,
    ruleCollecting: 0xbbaa77,
    // （原 ruleDesc/ruleSource/ruleProgress 三档灰已并入 descText/hintMid，见语义灰五档）
    ruleName: 0xddccaa,
    /** 进度空槽：原来是中性冷灰 0x333333，在暖木面板上一眼像 debug 控件 */
    progressBg: 0x261e14,
    progressFill: 0xccaa44,

    // 地图节点：原来「已解锁」是冷蓝（557799/6688aa/aabbcc），在这套暖木配色里
    // 是全屏最跳的一处。改成旧木色系，只留「当前」用琥珀点亮。
    mapCurrent: 0xffcc44,
    mapCurrentBorder: 0xffee88,
    mapUnlocked: 0x4a3a24,
    mapUnlockedBorder: 0x6b5a3e,
    mapUnlockedText: 0xccbbaa,
    mapLocked: 0x241d16,
    mapLockedText: 0x4f4538,

    questMain: 0xffcc66,
    /** 支线：留一点青以便与主线拉开，但压暗压灰，不再是发亮的薄荷色 */
    questSide: 0x8fb8a8,
    questCompleted: 0x7a7264,
    // （原 questDesc/questDescDim 是 descText/descTextDim 的同值双名，已随批2a 收敛删除）

    notifQuest: 0xffcc66,
    /** 「学到规矩」：原来是薄荷绿 0x88ddaa，toast 的书图标跟着 tint 成绿的，
     *  在整屏暖木里是唯一一点冷色。收进苔金——仍与「接到活计」的琥珀区分得开。 */
    notifRule: 0xb9b06a,
    notifItem: 0xdddddd,
    notifWarning: 0xff8866,
    notifError: 0xff6666,
    notifInfo: 0xb0a690,

    choiceEnabled: 0xdddddd,
    choiceDisabled: 0x666666,
    choiceRule: 0xffaa44,
    choiceRuleDisabled: 0x886633,
    /** 回顾里的旁白/系统行：原来是天蓝 0x88bbdd，收进暖灰青 */
    choiceLog: 0x9fb3a8,

    bookLabel: 0xeeddcc,
    pickupText: 0xffcc44,

    encounterSpecial: 0xddaa88,
    /** 暗金：数值/链接类交互字（原 link 档并入——交互色归琥珀族，MenuUI 的 JSON 链接是先例） */
    goldDim: 0xccaa66,
    hudRuleHint: 0x1a0e0e,
  },

  /*
   * ⚠ 这里曾有一套 `paperInk`（米白纸页的墨字色板，审查批3a 的"商业档案观感"）。
   * **2026-08-17 连同亮底纸页一起撤销**——理由见 `components/ArchiveBookView` 顶部注释
   * （一句话：面板底实测 (9,8,6)，那张纸亮 248 倍，在夜戏里它自己是全屏最亮的光源）。
   * 撤销它同时消掉了"两套色板永远要同步"这笔维护账：全站文档色板现在只有
   * `RichContent.RICH_DARK` 一套。要找旧值去 git 历史，别在这儿重建第二套。
   */

  alpha: {
    panelBg: 0.95,
    overlay: 0.5,
    overlayDark: 0.6,
    overlayLight: 0.4,
    dialogueBg: 0.92,
    hudBg: 0.8,
    hudBgDark: 0.85,
    rowBg: 0.8,
    rowBgLight: 0.6,
    rowHover: 0.9,
    encounterBg: 0.92,
    notifBg: 0.85,
    pickupBg: 0.7,
    hitArea: 0.001,
    slotBg: 0.7,
    bookSpine: 0.9,
    /** 内金细线：压到三成才是设计稿里那种「若有若无的一线」，拉满会变成廉价描边 */
    hairline: 0.34,
    /** 标题两侧横线 */
    titleRule: 0.75,
  },

  /**
   * 标题字距。设计稿里所有中文标题都拉开了字距（「行 囊」「暂 停」），
   * 这是这套观感里最省力也最见效的一处——不拉字距，标题就是一坨。
   */
  letterSpacing: {
    title: 4,
    display: 8,
    /** 小节头/序号/提示行的轻字距：全站原散落的 `letterSpacing: 1` 硬编码收敛于此 */
    hint: 1,
  },

  /**
   * 行距倍率（2026-08-17 批2a 新增）。用法：`Math.round(fontSize * UITheme.lineHeight.body)`。
   * 存量行距各有论证，不强制回改；新代码与顺手可换处取这里，别再手写魔法数。
   */
  lineHeight: {
    tight: 1.3,
    body: 1.5,
    loose: 1.6,
  },

  /**
   * 字族。**开发阶段用系统已装的中文字族**（macOS 自带），零打包、零构建步骤——
   * 上线前再换成可商用授权的打包字体（届时只改这两个值，130 处调用点不动）。
   * 末位一律留系统通用族兜底，换机器/换平台缺字时不至于渲染失败。
   */
  fonts: {
    /**
     * 正文 / 对白 / 列表：**宋体**。
     * 设计稿 01 第 7 节「字体建议」写的就是「正文：宋体/思源宋体（清晰易读）」，
     * 稿子里的正文也确实是宋体（横细竖粗、收笔有三角衬线）。
     */
    ui: '"Songti SC", STSong, "Kaiti SC", STKaiti, serif' as const,
    /**
     * 标题 / 书名 / 说书：**楷体**。
     * 同一节写的是「标题：楷体/仿宋（有手写感，笔画稳重）」。
     * 此前用的报隶（Baoli SC）在 hero 字号下笔画发圆，读起来像 POP 体、还自带光晕感，
     * 与稿子那种稳重手写完全两回事——审查一眼就点了这条。
     */
    display: '"Kaiti SC", STKaiti, "Songti SC", serif' as const,
  },

  panel: {
    borderRadius: 8,
    borderRadiusMed: 6,
    borderRadiusSmall: 4,
    padding: 20,
    borderWidth: 1,
  },

  /**
   * 间距阶梯。此前全站是散落的绝对坐标（`py+50`、`cy += 26`…），没有节奏可言。
   * 组件层一律取这里，不再手写数字。4 的倍数，够用且好心算。
   */
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 32,
  },

  /**
   * 字号阶梯。收敛此前散在 ~130 个调用点的 13 种硬编码字号。新代码只准用这七档。
   *
   * **档位值按设计稿实测换算到 1024×768 画布**（2026-08-04 重定）：
   * 稿子主菜单标题字高 ~105px、按钮字 ~26px、对话正文 ~30px、面板大标题 ~44px。
   * 首版把这套定成了 11~24/48 的**桌面软件尺度**——制作人原话「哪有游戏里的字体那么小的，
   * 你以为看数据库呢」。游戏 UI 的字要照海报排，不是照表格排。**别再往小调**。
   */
  fontSize: {
    /** 角标、次要计数 */
    micro: 14,
    /** 列表行小字、说明 */
    small: 16,
    /** 正文默认（描述、台词行） */
    body: 20,
    /** 强调正文、按钮字、选项 */
    bodyLarge: 25,
    /** 条目名、说话人名、选中行主文字 */
    title: 30,
    /** 面板大标题（行囊、规矩本） */
    display: 44,
    /** 全屏巨标题（主菜单） */
    hero: 96,
  },

  /**
   * 动效。此前全站只有一个 150ms 线性 fadeIn，没有缓动、没有位移。
   * duration 三档 + 两条缓动曲线，够覆盖面板开关/行悬停/提示进出。
   */
  motion: {
    /** 悬停、按下这类即时反馈 */
    fast: 90,
    /** 面板开关、提示进出 */
    normal: 150,
    /** 大面板、过场式切换 */
    slow: 260,
    /** 进场：先快后缓，收得住 */
    easeOut: (t: number): number => 1 - Math.pow(1 - t, 3),
    /** 双向：两头缓中间快 */
    easeInOut: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  },

  /**
   * UI 层内的堆叠次序。
   *
   * **写了就生效，不需要手动开 `sortableChildren`**：Pixi v8 的 zIndex setter 会走
   * `sortMixin.depthOfChildModified()`，它自动把父容器的 `sortableChildren` 置 true
   * （`node_modules/pixi.js/lib/scene/container/container-mixins/sortMixin.mjs`）。
   * `Renderer` 只显式给 `entityLayer` 开过，但 uiLayer 会因为子节点写 zIndex 而自动开启。
   *
   * 排序是稳定的：没设 zIndex 的元素都是 0，彼此之间仍按添加顺序叠放；**只有显式设了值的
   * 会整体上浮**。所以给 toast 设 `z.toast` 的效果是「toast 恒在所有面板之上」——
   * 包括在 toast 之后才打开的面板，这正是要的。
   *
   * ⚠ 反过来说：随手给某个面板设 `z.panel` 就会让它压过所有未设值的元素。
   * 加新值之前先想清楚它该压过谁。
   */
  z: {
    panel: 10,
    overlay: 5,
    toast: 50,
    /** 任务横幅：与 toast 同带不同车道，但真撞上时大事（新任务）压过流水播报 */
    banner: 51,
    tooltip: 60,
    debug: 100,
  },

  /**
   * 顶中浮层的**车道表**。场景名 / 引导提示条 / 任务横幅 / 事件 toast 四家共用屏幕顶带，
   * 此前各写各的 y（10 / 44 / 50 / 96）：toast 从 50 起往下堆，一条就盖住 44 的引导条、
   * 两条就压进 96 的横幅（审查 P1：重叠是必然不是偶发）。
   * 车道在这里一处定死、四家只取不算——toast 车道排在横幅之下，堆叠向下延伸永不上侵。
   */
  topLanes: {
    sceneName: 10,
    guidance: 44,
    banner: 96,
    toast: 160,
  },

  animation: {
    fadeInDuration: 150,
  },
} as const;

/** Animate alpha from 0 to 1 (fire-and-forget). */
export function fadeIn(
  target: { alpha: number; destroyed?: boolean },
  duration: number = UITheme.animation.fadeInDuration,
): void {
  target.alpha = 0;
  const start = performance.now();
  const tick = () => {
    // 目标（Pixi 容器）可能在动画期间被销毁：立即停表，避免 rAF 链残留与写已销毁对象
    if (target.destroyed) return;
    const t = Math.min((performance.now() - start) / duration, 1);
    target.alpha = t;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
