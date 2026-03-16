import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';

export class HUD {
  private renderer: Renderer;
  private eventBus: EventBus;
  private container: Container;

  private coinText: Text;
  private questText: Text;
  private questBg: Graphics;

  private ruleHintBg: Graphics;
  private ruleHintText: Text;
  private hasRuleSlots: boolean = false;

  private mapNameText: Text;
  private sceneEnterCb: (p: { sceneId: string; sceneName?: string }) => void;

  private currencyCb: (p: { newTotal: number }) => void;
  private questAcceptedCb: (p: { title: string }) => void;
  private questCompletedCb: (p: { title: string }) => void;
  private zoneEnterCb: () => void;
  private zoneExitCb: () => void;

  constructor(renderer: Renderer, eventBus: EventBus) {
    this.renderer = renderer;
    this.eventBus = eventBus;

    this.container = new Container();

    const coinBg = new Graphics();
    coinBg.roundRect(0, 0, 120, 28, 4);
    coinBg.fill({ color: 0x0e0e1a, alpha: 0.8 });
    coinBg.x = 10;
    coinBg.y = 10;
    this.container.addChild(coinBg);

    this.coinText = new Text({
      text: '铜钱: 0',
      style: { fontSize: 13, fill: 0xffcc66, fontFamily: 'sans-serif' },
    });
    this.coinText.x = 20;
    this.coinText.y = 15;
    this.container.addChild(this.coinText);

    this.questBg = new Graphics();
    this.questBg.roundRect(0, 0, 220, 28, 4);
    this.questBg.fill({ color: 0x0e0e1a, alpha: 0.8 });
    this.questBg.x = this.renderer.screenWidth - 230;
    this.questBg.y = 10;
    this.questBg.visible = false;
    this.container.addChild(this.questBg);

    this.questText = new Text({
      text: '',
      style: { fontSize: 12, fill: 0xaaaacc, fontFamily: 'sans-serif' },
    });
    this.questText.x = this.renderer.screenWidth - 220;
    this.questText.y = 15;
    this.container.addChild(this.questText);

    this.ruleHintBg = new Graphics();
    this.ruleHintBg.roundRect(0, 0, 160, 28, 4);
    this.ruleHintBg.fill({ color: 0x1a0e0e, alpha: 0.85 });
    this.ruleHintBg.x = (this.renderer.screenWidth - 160) / 2;
    this.ruleHintBg.y = this.renderer.screenHeight - 50;
    this.ruleHintBg.visible = false;
    this.container.addChild(this.ruleHintBg);

    this.ruleHintText = new Text({
      text: '[F] 使用规矩',
      style: { fontSize: 13, fill: 0xffaa44, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    this.ruleHintText.x = (this.renderer.screenWidth - this.ruleHintText.width) / 2;
    this.ruleHintText.y = this.renderer.screenHeight - 45;
    this.ruleHintText.visible = false;
    this.container.addChild(this.ruleHintText);

    this.mapNameText = new Text({
      text: '',
      style: { fontSize: 12, fill: 0x8888aa, fontFamily: 'sans-serif' },
    });
    this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
    this.mapNameText.y = 10;
    this.container.addChild(this.mapNameText);

    this.renderer.uiLayer.addChild(this.container);

    this.sceneEnterCb = (p) => {
      this.mapNameText.text = p.sceneName ?? p.sceneId ?? '';
      this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
    };

    this.currencyCb = (p) => {
      this.coinText.text = `铜钱: ${p.newTotal}`;
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
    this.coinText.text = `铜钱: ${amount}`;
  }

  setQuestHint(title: string): void {
    if (title) {
      this.questText.text = `当前：${title}`;
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

  destroy(): void {
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
