export const UITheme = {
  colors: {
    panelBg: 0x111122,
    panelBgAlt: 0x1a1a2e,
    dialogueBg: 0x0e0e1a,
    encounterBg: 0x1a0a0a,
    mainMenuBg: 0x0a0a14,
    detailBg: 0x181830,
    bookBg: 0x1a1a1a,

    panelBorder: 0x444466,
    encounterBorder: 0x664444,
    borderSubtle: 0x333344,
    borderMid: 0x333355,
    borderActive: 0x555577,
    bookBorder: 0x666666,

    overlay: 0x000000,

    rowBg: 0x222233,
    rowBgDark: 0x1a1a2e,
    rowBgInactive: 0x151520,
    rowHover: 0x2a2a4e,
    encounterRow: 0x221111,
    encounterHover: 0x332222,

    title: 0xffcc88,
    body: 0xdddddd,
    bodyMuted: 0xccbbaa,
    bodyDim: 0xbbbbcc,
    subtle: 0xaaaacc,
    hint: 0x555566,
    disabled: 0x666666,
    section: 0x888899,
    link: 0x8888aa,
    buttonText: 0xccccdd,

    gold: 0xffcc66,
    orange: 0xffaa44,
    green: 0x88cc88,
    greenBright: 0x88ddaa,
    red: 0xff8866,
    redDot: 0xff6644,

    sliderTrack: 0x333344,
    sliderFill: 0x5588cc,
    sliderHandle: 0x88aacc,
    dangerBg: 0x442222,
    dangerBorder: 0x665544,

    ruleUnverified: 0xccaa44,
    ruleEffective: 0x66cc66,
    ruleQuestionable: 0xcc6644,
    ruleCollecting: 0xbbaa77,
    ruleDesc: 0x999988,
    ruleSource: 0x777766,
    ruleProgress: 0x888877,
    ruleName: 0xddccaa,
    progressBg: 0x333333,
    progressFill: 0xccaa44,

    mapCurrent: 0xffcc44,
    mapCurrentBorder: 0xffee88,
    mapUnlocked: 0x557799,
    mapUnlockedBorder: 0x6688aa,
    mapUnlockedText: 0xaabbcc,
    mapLocked: 0x333344,
    mapLockedText: 0x444455,

    questMain: 0xffcc66,
    questSide: 0xaaddcc,
    questCompleted: 0x777788,
    questDesc: 0xaaaaaa,
    questDescDim: 0x999999,

    notifQuest: 0xffcc66,
    notifRule: 0x88ddaa,
    notifItem: 0xdddddd,
    notifWarning: 0xff8866,
    notifError: 0xff6666,
    notifInfo: 0xaaaacc,

    choiceEnabled: 0xdddddd,
    choiceDisabled: 0x666666,
    choiceRule: 0xffaa44,
    choiceRuleDisabled: 0x886633,
    choiceLog: 0x88bbdd,

    bookLabel: 0xeeddcc,
    pickupText: 0xffcc44,

    bodyLight: 0xcccccc,
    descText: 0xaaaaaa,
    descTextDim: 0x999999,
    hintMid: 0x888888,
    hintLight: 0x777777,
    pageInfo: 0x666677,
    disabledDark: 0x555555,
    encounterSpecial: 0xddaa88,
    goldDim: 0xccaa66,
    hudRuleHint: 0x1a0e0e,
  },

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
  },

  fonts: {
    ui: 'sans-serif' as const,
    display: 'serif' as const,
  },

  panel: {
    borderRadius: 8,
    borderRadiusMed: 6,
    borderRadiusSmall: 4,
    padding: 20,
    borderWidth: 1,
  },

  animation: {
    fadeInDuration: 150,
  },
} as const;

/** Animate alpha from 0 to 1 (fire-and-forget). */
export function fadeIn(
  target: { alpha: number },
  duration: number = UITheme.animation.fadeInDuration,
): void {
  target.alpha = 0;
  const start = performance.now();
  const tick = () => {
    const t = Math.min((performance.now() - start) / duration, 1);
    target.alpha = t;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
