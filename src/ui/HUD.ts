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

  private ruleHintBg: Graphics;
  private ruleHintText: Text;
  private hasRuleSlots: boolean = false;

  private mapNameText: Text;
  private onResizeBound: () => void;
  private sceneEnterCb: (p: { sceneId: string; sceneName?: string }) => void;

  private currencyCb: (p: { newTotal: number }) => void;
  private questAcceptedCb: (p: { title: string }) => void;
  private questCompletedCb: (p: { title: string }) => void;
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
      this.mapNameText.text = p.sceneName ?? p.sceneId ?? '';
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

    this.eventBus.on('scene:enter', this.sceneEnterCb);
    this.eventBus.on('currency:changed', this.currencyCb);
    this.eventBus.on('quest:accepted', this.questAcceptedCb);
    this.eventBus.on('quest:completed', this.questCompletedCb);
    this.eventBus.on('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.on('zone:ruleUnavailable', this.zoneExitCb);
  }

  setCoins(amount: number): void {
    this.coinText.text = `${this.strings.get('hud', 'coins')} ${amount}`;
    this.coinBg.clear();
    this.coinBg.roundRect(0, 0, this.coinText.width + 20, 28, UITheme.panel.borderRadiusSmall);
    this.coinBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
  }

  setQuestHint(title: string): void {
    if (title) {
      this.questText.text = `${this.strings.get('hud', 'current')}${title}`;
      this.questBg.clear();
      this.questBg.roundRect(0, 0, this.questText.width + 20, 28, UITheme.panel.borderRadiusSmall);
      this.questBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
      this.questBg.visible = true;
    } else {
      this.questText.text = '';
      this.questBg.visible = false;
    }
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

  destroy(): void {
    window.removeEventListener('resize', this.onResizeBound);
    this.eventBus.off('scene:enter', this.sceneEnterCb);
    this.eventBus.off('currency:changed', this.currencyCb);
    this.eventBus.off('quest:accepted', this.questAcceptedCb);
    this.eventBus.off('quest:completed', this.questCompletedCb);
    this.eventBus.off('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.off('zone:ruleUnavailable', this.zoneExitCb);
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
