import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';

export class HUD {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private container: Container;

  private coinBg: Graphics;
  private coinText: Text;
  private questText: Text;
  private questBg: Graphics;

  private healthTrack: Graphics;
  private healthFill: Graphics;
  private healthText: Text;

  private ruleHintBg: Graphics;
  private ruleHintText: Text;
  private hasRuleSlots: boolean = false;

  private mapNameText: Text;
  private onResizeBound: () => void;
  private sceneEnterCb: (p: { sceneId: string; sceneName?: string }) => void;
  private resolveDisplay: ((s: string) => string) | null = null;

  private currencyCb: (p: { newTotal: number }) => void;
  private questAcceptedCb: (p: { title: string }) => void;
  private questCompletedCb: (p: { title: string }) => void;
  private healthCb: (p: { current: number; max: number }) => void;
  private healthCurrent: number = 100;
  private healthMax: number = 100;
  private zoneEnterCb: () => void;
  private zoneExitCb: () => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

    this.container = new Container();

    this.coinBg = new Graphics();
    this.coinBg.roundRect(0, 0, 120, 28, UITheme.panel.borderRadiusSmall);
    this.coinBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
    this.coinBg.x = 10;
    this.coinBg.y = 10;
    this.container.addChild(this.coinBg);

    this.coinText = new Text({
      text: `${this.strings.get('hud', 'coins')} 0`,
      style: { fontSize: 13, fill: UITheme.colors.gold, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 200 },
    });
    this.coinText.x = 20;
    this.coinText.y = 15;
    this.container.addChild(this.coinText);

    // 血条（死亡系绳：濒死被信号拽回、永不真死）——铜钱下方常驻
    this.healthTrack = new Graphics();
    this.healthTrack.roundRect(0, 0, 120, 12, 3);
    this.healthTrack.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
    this.healthTrack.x = 10;
    this.healthTrack.y = 44;
    this.container.addChild(this.healthTrack);

    this.healthFill = new Graphics();
    this.healthFill.x = 11;
    this.healthFill.y = 45;
    this.container.addChild(this.healthFill);

    this.healthText = new Text({
      text: '',
      style: { fontSize: 11, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui },
    });
    this.healthText.x = 136;
    this.healthText.y = 43;
    this.container.addChild(this.healthText);
    this.renderHealth();

    this.questBg = new Graphics();
    this.questBg.roundRect(0, 0, 220, 28, UITheme.panel.borderRadiusSmall);
    this.questBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
    this.questBg.x = this.renderer.screenWidth - 230;
    this.questBg.y = 10;
    this.questBg.visible = false;
    this.container.addChild(this.questBg);

    this.questText = new Text({
      text: '',
      style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 210 },
    });
    this.questText.x = this.renderer.screenWidth - 220;
    this.questText.y = 15;
    this.container.addChild(this.questText);

    this.ruleHintBg = new Graphics();
    this.ruleHintBg.roundRect(0, 0, 160, 28, UITheme.panel.borderRadiusSmall);
    this.ruleHintBg.fill({ color: UITheme.colors.hudRuleHint, alpha: UITheme.alpha.hudBgDark });
    this.ruleHintBg.x = (this.renderer.screenWidth - 160) / 2;
    this.ruleHintBg.y = this.renderer.screenHeight - 50;
    this.ruleHintBg.visible = false;
    this.container.addChild(this.ruleHintBg);

    this.ruleHintText = new Text({
      text: this.strings.get('hud', 'ruleUseHint'),
      style: { fontSize: 13, fill: UITheme.colors.orange, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: 150 },
    });
    this.ruleHintText.x = (this.renderer.screenWidth - this.ruleHintText.width) / 2;
    this.ruleHintText.y = this.renderer.screenHeight - 45;
    this.ruleHintText.visible = false;
    this.container.addChild(this.ruleHintText);

    this.mapNameText = new Text({
      text: '',
      style: { fontSize: 12, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 400 },
    });
    this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
    this.mapNameText.y = 10;
    this.container.addChild(this.mapNameText);

    this.renderer.uiLayer.addChild(this.container);

    this.layout();
    this.onResizeBound = () => this.layout();
    window.addEventListener('resize', this.onResizeBound);

    this.sceneEnterCb = (p) => {
      const raw = p.sceneName ?? p.sceneId ?? '';
      this.mapNameText.text = this.r(raw);
      this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
    };

    this.currencyCb = (p) => {
      this.coinText.text = `${this.strings.get('hud', 'coins')} ${p.newTotal}`;
      this.coinBg.clear();
      this.coinBg.roundRect(0, 0, this.coinText.width + 20, 28, UITheme.panel.borderRadiusSmall);
      this.coinBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
    };
    this.questAcceptedCb = (p) => {
      this.setQuestHint(p.title);
    };
    this.questCompletedCb = () => {
      this.setQuestHint('');
    };
    this.zoneEnterCb = () => { this.updateRuleHint(true); };
    this.zoneExitCb = () => { this.updateRuleHint(false); };
    this.healthCb = (p) => {
      this.healthCurrent = p.current;
      this.healthMax = p.max;
      this.renderHealth();
    };

    this.eventBus.on('scene:enter', this.sceneEnterCb);
    this.eventBus.on('currency:changed', this.currencyCb);
    this.eventBus.on('quest:accepted', this.questAcceptedCb);
    this.eventBus.on('quest:completed', this.questCompletedCb);
    this.eventBus.on('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.on('zone:ruleUnavailable', this.zoneExitCb);
    this.eventBus.on('player:healthChanged', this.healthCb);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  setCoins(amount: number): void {
    this.coinText.text = `${this.strings.get('hud', 'coins')} ${amount}`;
    this.coinBg.clear();
    this.coinBg.roundRect(0, 0, this.coinText.width + 20, 28, UITheme.panel.borderRadiusSmall);
    this.coinBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
  }

  setQuestHint(title: string): void {
    if (title) {
      this.questText.text = `${this.strings.get('hud', 'current')}${this.r(title)}`;
      this.questBg.clear();
      this.questBg.roundRect(0, 0, this.questText.width + 20, 28, UITheme.panel.borderRadiusSmall);
      this.questBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
      this.questBg.visible = true;
    } else {
      this.questText.text = '';
      this.questBg.visible = false;
    }
  }

  /** 玩家视角：HUD 当前显示的任务追踪文字（玩家可见），供 getPlayerView。 */
  getQuestHintText(): string {
    return this.questText.text;
  }

  setRuleHintVisible(visible: boolean): void {
    this.hasRuleSlots = visible;
    this.ruleHintBg.visible = visible;
    this.ruleHintText.visible = visible;
  }

  private updateRuleHint(hasSlots: boolean): void {
    this.setRuleHintVisible(hasSlots);
  }

  private layout(): void {
    this.questBg.x = this.renderer.screenWidth - 230;
    this.questText.x = this.renderer.screenWidth - 220;
    this.ruleHintBg.x = (this.renderer.screenWidth - 160) / 2;
    this.ruleHintBg.y = this.renderer.screenHeight - 50;
    this.ruleHintText.x = (this.renderer.screenWidth - this.ruleHintText.width) / 2;
    this.ruleHintText.y = this.renderer.screenHeight - 45;
    this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
  }

  private renderHealth(): void {
    const W = 120;
    const ratio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
    const critical = ratio <= 0.33;
    this.healthFill.clear();
    if (ratio > 0) {
      this.healthFill.roundRect(0, 0, Math.max(2, (W - 2) * ratio), 10, 2);
      this.healthFill.fill({ color: critical ? 0xe23b3b : 0x9e3030, alpha: 0.95 });
    }
    this.healthText.text = `${Math.round(this.healthCurrent)}/${Math.round(this.healthMax)}`;
    this.healthText.style.fill = critical ? 0xe23b3b : UITheme.colors.subtle;
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResizeBound);
    this.eventBus.off('scene:enter', this.sceneEnterCb);
    this.eventBus.off('currency:changed', this.currencyCb);
    this.eventBus.off('quest:accepted', this.questAcceptedCb);
    this.eventBus.off('quest:completed', this.questCompletedCb);
    this.eventBus.off('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.off('zone:ruleUnavailable', this.zoneExitCb);
    this.eventBus.off('player:healthChanged', this.healthCb);
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
