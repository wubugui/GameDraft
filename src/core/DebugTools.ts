import { Container, Graphics } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from './EventBus';
import type { Player } from '../entities/Player';
import type { InventoryManager } from '../systems/InventoryManager';
import type { DebugPanelUI } from '../ui/DebugPanelUI';

export interface DebugToolsDeps {
  renderer: Renderer;
  eventBus: EventBus;
  player: Player;
  inventoryManager: InventoryManager;
  debugPanelUI: DebugPanelUI;
  getCurrentSceneId: () => string | undefined;
  fallbackScene: string;
  reloadScene: (sceneId: string) => void;
}

export class DebugTools {
  private deps: DebugToolsDeps;
  private positionDebugMode = false;
  private positionDebugKeyHandler: (e: KeyboardEvent) => void = () => {};
  private positionDebugPointerHandler: (e: PointerEvent) => void = () => {};
  private showCollisionsDebug = false;
  private collisionDebugOverlay: Container | null = null;

  constructor(deps: DebugToolsDeps) {
    this.deps = deps;
  }

  init(): void {
    this.setupPositionDebugTool();
    this.setupDebugPanelSections();
  }

  update(_dt: number): void {
    if (this.showCollisionsDebug) this.updateCollisionOverlay();
  }

  private setupPositionDebugTool(): void {
    const { renderer, eventBus } = this.deps;
    const canvas = renderer.app.canvas as HTMLCanvasElement;
    if (!canvas) return;

    this.positionDebugKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'F10') {
        e.preventDefault();
        this.positionDebugMode = !this.positionDebugMode;
        const msg = this.positionDebugMode ? 'Position debug: ON (click to log world x,y)' : 'Position debug: OFF';
        console.log(msg);
        eventBus.emit('notification:show', { text: msg, type: 'info' });
      }
    };
    window.addEventListener('keydown', this.positionDebugKeyHandler);

    this.positionDebugPointerHandler = (e: PointerEvent) => {
      if (!this.positionDebugMode) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = renderer.app.screen.width / rect.width;
      const scaleY = renderer.app.screen.height / rect.height;
      const stageX = (e.clientX - rect.left) * scaleX;
      const stageY = (e.clientY - rect.top) * scaleY;
      const world = renderer.worldContainer.toLocal({ x: stageX, y: stageY });
      const x = Math.round(world.x);
      const y = Math.round(world.y);
      const text = `x: ${x}, y: ${y}`;
      console.log(text);
      eventBus.emit('notification:show', { text, type: 'info' });
    };
    canvas.addEventListener('pointerdown', this.positionDebugPointerHandler);
  }

  private setupDebugPanelSections(): void {
    const { debugPanelUI, player, inventoryManager, renderer } = this.deps;

    debugPanelUI.addSection('Quick Actions', () => ({
      text: 'Debug shortcuts for development.',
      actions: [
        {
          label: 'Reload Scene',
          fn: () => {
            const id = this.deps.getCurrentSceneId() ?? this.deps.fallbackScene;
            this.deps.reloadScene(id);
            debugPanelUI.log(`Reloaded scene: ${id}`);
          },
        },
        {
          label: '+100 Coins',
          fn: () => { inventoryManager.addCoins(100); debugPanelUI.log('Added 100 coins'); },
        },
        {
          label: 'Refresh',
          fn: () => debugPanelUI.refresh(),
        },
      ],
    }));

    debugPanelUI.addSection('Collisions', () => {
      const count = player.getCollisions().length;
      const enabled = player.collisionsEnabledState;
      return {
        text: `Count: ${count}\nEnabled: ${enabled}`,
        actions: [
          {
            label: this.showCollisionsDebug ? 'Hide Collisions' : 'Show Collisions',
            fn: () => {
              this.showCollisionsDebug = !this.showCollisionsDebug;
              if (!this.showCollisionsDebug && this.collisionDebugOverlay) {
                renderer.foregroundLayer.removeChild(this.collisionDebugOverlay);
                this.collisionDebugOverlay.destroy({ children: true });
                this.collisionDebugOverlay = null;
              }
              debugPanelUI.log(`Collision display: ${this.showCollisionsDebug ? 'on' : 'off'}`);
            },
          },
          {
            label: enabled ? 'Disable Collisions' : 'Enable Collisions',
            fn: () => {
              player.setCollisionsEnabled(!enabled);
              debugPanelUI.log(`Collisions: ${enabled ? 'disabled' : 'enabled'}`);
            },
          },
        ],
      };
    });
  }

  private updateCollisionOverlay(): void {
    const { player, renderer } = this.deps;
    const rects = player.getCollisions();
    if (rects.length === 0 && !this.collisionDebugOverlay) return;
    if (!this.collisionDebugOverlay) {
      this.collisionDebugOverlay = new Container();
      renderer.foregroundLayer.addChild(this.collisionDebugOverlay);
    }
    const g = this.collisionDebugOverlay.children[0] as Graphics | undefined;
    let graphics: Graphics;
    if (g) {
      graphics = g;
      graphics.clear();
    } else {
      graphics = new Graphics();
      this.collisionDebugOverlay.addChild(graphics);
    }
    for (const r of rects) {
      graphics.rect(r.x, r.y, r.width, r.height);
      graphics.fill({ color: 0xff0000, alpha: 0.35 });
      graphics.rect(r.x, r.y, r.width, r.height);
      graphics.stroke({ color: 0xff4444, width: 1 });
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.positionDebugKeyHandler);
    const canvas = this.deps.renderer.app?.canvas as HTMLCanvasElement | undefined;
    if (canvas) canvas.removeEventListener('pointerdown', this.positionDebugPointerHandler);

    if (this.collisionDebugOverlay?.parent) {
      this.collisionDebugOverlay.parent.removeChild(this.collisionDebugOverlay);
    }
    this.collisionDebugOverlay?.destroy({ children: true });
    this.collisionDebugOverlay = null;
  }
}
