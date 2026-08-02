import type { AssetRef } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext } from '../../data/types';
import { TEXT_URLS } from '../../core/projectPaths';
import { MinigameSessionManagerBase } from '../minigameSession';
import type {
  ObjectExamineAmbience,
  ObjectExamineBackgroundPreset,
  ObjectExamineInstance,
  ObjectExamineResult,
  ObjectExamineStillPresentation,
  ResolvedObjectExamineAmbience,
} from './types';
import {
  OBJECT_EXAMINE_CINNABAR_MARK_URL,
  OBJECT_EXAMINE_CRITTER_SPRITES,
  resolveObjectExamineAmbience,
  resolveObjectExamineBackgroundUrl,
} from './types';
import { ObjectExamineScene } from './ObjectExamineScene';

/** F2 检视 Tab：会话内/下次启动都会吃到的 presentation 覆盖（不写盘）。 */
export interface ObjectExamineDebugOverrides {
  /** null = 跟随实例 */
  backgroundPreset: ObjectExamineBackgroundPreset | null;
  /** 覆盖生效时忽略实例 backgroundImage，否则 preset 切不过去 */
  ignoreBackgroundImage: boolean;
  /** null = 跟随实例 */
  upright: boolean | null;
  showHotspotDebug: boolean;
}

export type ObjectExamineAudioHooks = {
  playSfx: (id: string, volume?: number) => void;
  addAmbient: (id: string) => void;
  removeAmbient: (id: string) => void;
};

export type ObjectExamineSmellHooks = {
  setSmell: (
    scent: string,
    intensity?: number,
    dir?: number,
    flicker?: boolean,
  ) => void;
  clearSmell: () => void;
};

export type ObjectExamineInventoryHooks = {
  hasItem: (itemId: string) => boolean;
  listBagItems: () => Array<{ id: string; name: string; count: number }>;
};

/**
 * 物件检视会话：借用 MinigameSession 壳（状态压栈 / Esc / 资源 scope / 动作批锁），
 * 语义是专注检视而非胜负小游戏。
 */
export class ObjectExamineManager extends MinigameSessionManagerBase<
  ObjectExamineInstance,
  ObjectExamineScene,
  ObjectExamineResult
> {
  protected readonly indexUrl = TEXT_URLS.objectExamineIndex;
  protected readonly dataSubdir = 'object_examine';
  protected readonly scopePrefix = 'examine:object';
  protected readonly systemLabel = 'ObjectExamineManager';

  private eventBus!: EventBus;
  private actionExecutor: ActionExecutor | null = null;
  private resolveTextFn: ((s: string) => string) | null = null;
  private getString: ((ns: string, key: string) => string) | null = null;
  private audioHooks: ObjectExamineAudioHooks | null = null;
  private smellHooks: ObjectExamineSmellHooks | null = null;
  private inventoryHooks: ObjectExamineInventoryHooks | null = null;

  /** 当前会话的原始实例（未合并 debug 覆盖），供热切后回算 */
  private sessionBaseInstance: ObjectExamineInstance | null = null;
  private debugBackgroundPreset: ObjectExamineBackgroundPreset | null = null;
  private debugIgnoreBackgroundImage = false;
  private debugUpright: boolean | null = null;
  private debugShowHotspotDebug = false;
  /** F2 氛围覆盖（不写盘）；null 字段表示跟实例 */
  private debugAmbienceOverride: Partial<ObjectExamineAmbience> | null = null;
  /** 托底热切世代：丢弃过期的 async 换图结果 */
  private debugBgApplyEpoch = 0;
  /** 本会话是否施加过 smell（退场需 clearSmell） */
  private sessionSmellOwned = false;
  private sessionAmbientId: string | null = null;

  init(ctx: GameContext): void {
    super.init(ctx);
    this.eventBus = ctx.eventBus;
  }

  bindRuntime(deps: {
    renderer: Renderer;
    inputManager: InputManager;
    stateController: GameStateController;
    actionExecutor: ActionExecutor;
    resolveDisplayText: (s: string) => string;
    getString: (ns: string, key: string) => string;
    audio?: ObjectExamineAudioHooks;
    smell?: ObjectExamineSmellHooks;
    inventory?: ObjectExamineInventoryHooks;
  }): void {
    this.renderer = deps.renderer;
    this.inputManager = deps.inputManager;
    this.stateController = deps.stateController;
    this.actionExecutor = deps.actionExecutor;
    this.resolveTextFn = deps.resolveDisplayText;
    this.getString = deps.getString;
    this.audioHooks = deps.audio ?? null;
    this.smellHooks = deps.smell ?? null;
    this.inventoryHooks = deps.inventory ?? null;
  }

  protected runtimeReady(): boolean {
    return (
      super.runtimeReady() &&
      !!this.actionExecutor &&
      !!this.resolveTextFn &&
      !!this.getString
    );
  }

  protected validateInstance(inst: ObjectExamineInstance): boolean {
    if (!inst?.id) {
      this.warnSession('instance missing id');
      return false;
    }
    if (!inst.presentation || inst.presentation.kind !== 'still') {
      this.warnSession(`instance "${inst.id}" needs presentation.kind="still"`);
      return false;
    }
    if (!inst.presentation.image?.trim()) {
      this.warnSession(`instance "${inst.id}" missing presentation.image`);
      return false;
    }
    if (!Array.isArray(inst.hotspots)) {
      this.warnSession(`instance "${inst.id}" missing hotspots array`);
      return false;
    }
    return true;
  }

  protected createScene(_inst: ObjectExamineInstance): ObjectExamineScene {
    const gs = this.getString!;
    return new ObjectExamineScene(
      this.renderer!,
      this.assetManager,
      this.actionExecutor!,
      this.eventBus,
      this.resolveTextFn!,
      {
        observe: gs('objectExamine', 'observe') || '仔细看看',
        allFound: gs('objectExamine', 'allFound') || '这上面能看出的蹊跷，似乎都翻过了。',
        exit: gs('objectExamine', 'exit') || '放下',
        hint: gs('objectExamine', 'hint') || '凑近些……再近些。',
        continue: gs('objectExamine', 'continue') || '……看够了，退开一步。',
        bag: gs('objectExamine', 'bag') || '摸摸囊',
        holding: gs('objectExamine', 'holding') || '手里捏着：{item}',
        noUse: gs('objectExamine', 'noUse') || '使不上……',
        shadeTitle: gs('objectExamine', 'shadeTitle') || '隐约觉着不对',
      },
      (result) => this.publishResult(result),
      () => this.teardownSession(),
      () => this.restoreMinigameStateAfterAction(),
      {
        playSfx: (id, volume) => this.audioHooks?.playSfx(id, volume),
        addAmbient: (id) => this.audioHooks?.addAmbient(id),
        removeAmbient: (id) => this.audioHooks?.removeAmbient(id),
        hasItem: (itemId) => this.inventoryHooks?.hasItem(itemId) ?? false,
        listBagItems: () => this.inventoryHooks?.listBagItems() ?? [],
      },
    );
  }

  protected prepareInstance(inst: ObjectExamineInstance): ObjectExamineInstance {
    this.sessionBaseInstance = inst;
    return this.mergeDebugPresentation(inst);
  }

  protected onSceneLoaded(inst: ObjectExamineInstance): void {
    this.scene?.setShowHotspotDebug(this.debugShowHotspotDebug);
    this.applySessionSmell(inst);
    this.applySessionAmbient(inst);
    if (this.debugAmbienceOverride) {
      this.scene?.setAmbienceOverride(this.debugAmbienceOverride);
    }
  }

  protected onTeardown(): void {
    this.clearSessionSmell();
    this.clearSessionAmbient();
    this.sessionBaseInstance = null;
  }

  protected loadSceneContent(scene: ObjectExamineScene, inst: ObjectExamineInstance): Promise<void> {
    return scene.load(inst);
  }

  protected tickScene(scene: ObjectExamineScene, dt: number): void {
    scene.update(dt);
  }

  getDebugOverrides(): ObjectExamineDebugOverrides {
    return {
      backgroundPreset: this.debugBackgroundPreset,
      ignoreBackgroundImage: this.debugIgnoreBackgroundImage,
      upright: this.debugUpright,
      showHotspotDebug: this.debugShowHotspotDebug,
    };
  }

  getDebugAmbienceOverride(): Partial<ObjectExamineAmbience> | null {
    return this.debugAmbienceOverride ? { ...this.debugAmbienceOverride } : null;
  }

  getResolvedAmbience(): ResolvedObjectExamineAmbience {
    const base = this.sessionBaseInstance?.ambience ?? this.scene?.getInstanceAmbience() ?? null;
    return resolveObjectExamineAmbience(base, this.debugAmbienceOverride);
  }

  /** 清掉 F2 覆盖，下次启动跟实例；若会话中则热切回实例配置。 */
  resetDebugPresentationOverrides(): void {
    this.debugBackgroundPreset = null;
    this.debugIgnoreBackgroundImage = false;
    this.debugUpright = null;
    void this.reapplyDebugPresentationToActive();
  }

  resetDebugAmbienceOverrides(): void {
    this.debugAmbienceOverride = null;
    this.scene?.setAmbienceOverride(null);
  }

  setDebugAmbiencePatch(patch: Partial<ObjectExamineAmbience>): void {
    this.debugAmbienceOverride = { ...(this.debugAmbienceOverride ?? {}), ...patch };
    this.scene?.setAmbienceOverride(this.debugAmbienceOverride);
  }

  setDebugBackgroundPreset(preset: ObjectExamineBackgroundPreset): void {
    this.debugBackgroundPreset = preset;
    this.debugIgnoreBackgroundImage = true;
    void this.reapplyDebugPresentationToActive();
  }

  setDebugUpright(upright: boolean): void {
    this.debugUpright = upright;
    void this.reapplyDebugPresentationToActive();
  }

  setDebugShowHotspotDebug(show: boolean): void {
    this.debugShowHotspotDebug = show;
    this.scene?.setShowHotspotDebug(show);
  }

  setDebugDistanceIndex(index: number): void {
    this.scene?.setDistanceIndexForDebug(index);
  }

  setDebugBackgroundBrightness(brightness: number): void {
    if (this.sessionBaseInstance?.presentation?.kind === 'still') {
      this.sessionBaseInstance = {
        ...this.sessionBaseInstance,
        presentation: {
          ...this.sessionBaseInstance.presentation,
          backgroundBrightness: brightness,
        },
      };
    }
    this.scene?.setBackgroundBrightnessForDebug(brightness);
  }

  setDebugBackgroundScale(scale: number): void {
    if (this.sessionBaseInstance?.presentation?.kind === 'still') {
      this.sessionBaseInstance = {
        ...this.sessionBaseInstance,
        presentation: {
          ...this.sessionBaseInstance.presentation,
          backgroundScale: scale,
        },
      };
    }
    this.scene?.setBackgroundScaleForDebug(scale);
  }

  setDebugContactAoIntensity(intensity: number): void {
    if (this.sessionBaseInstance?.presentation?.kind === 'still') {
      this.sessionBaseInstance = {
        ...this.sessionBaseInstance,
        presentation: {
          ...this.sessionBaseInstance.presentation,
          contactAoIntensity: intensity,
        },
      };
    }
    this.scene?.setContactAoIntensityForDebug(intensity);
  }

  setDebugContactAoScale(scale: number): void {
    if (this.sessionBaseInstance?.presentation?.kind === 'still') {
      this.sessionBaseInstance = {
        ...this.sessionBaseInstance,
        presentation: {
          ...this.sessionBaseInstance.presentation,
          contactAoScale: scale,
        },
      };
    }
    this.scene?.setContactAoScaleForDebug(scale);
  }

  abortActiveSession(): void {
    if (!this.isActive) return;
    this.scene?.abort();
  }

  private mergeDebugPresentation(inst: ObjectExamineInstance): ObjectExamineInstance {
    if (inst.presentation?.kind !== 'still') return inst;
    const presentation: ObjectExamineStillPresentation = { ...inst.presentation };
    if (this.debugIgnoreBackgroundImage) {
      delete presentation.backgroundImage;
    }
    if (this.debugBackgroundPreset != null) {
      presentation.backgroundPreset = this.debugBackgroundPreset;
    }
    if (this.debugUpright != null) {
      presentation.upright = this.debugUpright;
    }
    return { ...inst, presentation };
  }

  private async reapplyDebugPresentationToActive(): Promise<void> {
    if (!this.scene || !this.sessionBaseInstance) return;
    const merged = this.mergeDebugPresentation(this.sessionBaseInstance);
    if (merged.presentation.kind !== 'still') return;
    const epoch = ++this.debugBgApplyEpoch;
    const scene = this.scene;
    this.scene.setUprightForDebug(merged.presentation.upright === true);
    const url = resolveObjectExamineBackgroundUrl(merged.presentation);
    await scene.setBackgroundUrlForDebug(
      url,
      {
        backgroundPreset: merged.presentation.backgroundPreset ?? 'softGlow',
        backgroundImage: merged.presentation.backgroundImage,
        clearBackgroundImage: this.debugIgnoreBackgroundImage,
      },
      { isCancelled: () => epoch !== this.debugBgApplyEpoch || this.scene !== scene },
    );
  }

  private applySessionSmell(inst: ObjectExamineInstance): void {
    this.clearSessionSmell();
    const smell = inst.smell;
    if (!smell?.scent?.trim() || !this.smellHooks) return;
    this.smellHooks.setSmell(smell.scent, smell.intensity, smell.dir, smell.flicker);
    this.sessionSmellOwned = true;
  }

  private clearSessionSmell(): void {
    if (!this.sessionSmellOwned) return;
    this.sessionSmellOwned = false;
    this.smellHooks?.clearSmell();
  }

  private applySessionAmbient(inst: ObjectExamineInstance): void {
    this.clearSessionAmbient();
    const id = inst.audio?.ambient?.trim();
    if (!id || !this.audioHooks) return;
    this.audioHooks.addAmbient(id);
    this.sessionAmbientId = id;
  }

  private clearSessionAmbient(): void {
    if (!this.sessionAmbientId) return;
    this.audioHooks?.removeAmbient(this.sessionAmbientId);
    this.sessionAmbientId = null;
  }

  protected buildInstanceManifestRefs(inst: ObjectExamineInstance): AssetRef[] {
    const refs: AssetRef[] = [];
    if (inst.presentation?.kind === 'still' && inst.presentation.image?.trim()) {
      refs.push({
        type: 'texture',
        path: inst.presentation.image,
        label: `物件检视: ${inst.id}`,
      });
    }
    if (inst.presentation?.kind === 'still') {
      const bg = resolveObjectExamineBackgroundUrl(inst.presentation);
      refs.push({ type: 'texture', path: bg, label: `物件检视托底: ${inst.id}` });
    }
    refs.push({
      type: 'texture',
      path: OBJECT_EXAMINE_CINNABAR_MARK_URL,
      label: '物件检视朱砂点',
    });
    const ambience = resolveObjectExamineAmbience(inst.ambience);
    if (ambience.flyingFlies.enabled) {
      refs.push({ type: 'texture', path: OBJECT_EXAMINE_CRITTER_SPRITES.fly, label: '物件检视苍蝇' });
    }
    if (ambience.crawlers.enabled && ambience.crawlers.maggots.enabled) {
      refs.push({ type: 'texture', path: OBJECT_EXAMINE_CRITTER_SPRITES.maggot, label: '物件检视蛆虫' });
    }
    if (ambience.crawlers.enabled && ambience.crawlers.centipede.enabled) {
      refs.push({ type: 'texture', path: OBJECT_EXAMINE_CRITTER_SPRITES.centipede, label: '物件检视蜈蚣' });
    }
    if (ambience.crawlers.enabled && ambience.crawlers.beetles.enabled) {
      refs.push({ type: 'texture', path: OBJECT_EXAMINE_CRITTER_SPRITES.beetle, label: '物件检视甲虫' });
    }
    return refs;
  }

  private publishResult(result: ObjectExamineResult): void {
    this.lastResult = result;
    this.eventBus.emit('objectExamine:result', result);
  }

  getDebugVisualState(): Record<string, unknown> | null {
    return this.scene?.getDebugVisualState() ?? null;
  }

  getDebugStatusText(): string {
    const ov = this.getDebugOverrides();
    const live = this.getDebugVisualState();
    const amb = this.getResolvedAmbience();
    const lines = [
      `会话: ${this.isActive ? '进行中' : '空闲'}`,
      `托底覆盖: ${ov.backgroundPreset ?? '（跟随实例）'}${ov.ignoreBackgroundImage ? ' · 忽略自定义图' : ''}`,
      `竖放覆盖: ${ov.upright == null ? '（跟随实例）' : ov.upright ? '竖放' : '横放'}`,
      `热区描边: ${ov.showHotspotDebug ? '开' : '关'}`,
      `氛围: 微晃${amb.headSway.enabled ? `开×${amb.headSway.amplitude.toFixed(2)}` : '关'} 呼吸${amb.breathing.enabled ? `开×${amb.breathing.strength.toFixed(2)}` : '关'} 烛${amb.candlelight.enabled ? '开' : '关'} 月${amb.moonlight.enabled ? '开' : '关'} 云${amb.cloudShadow.enabled ? '开' : '关'} 尘${amb.dust.enabled ? `开 密${amb.dust.density.toFixed(2)}/强${amb.dust.intensity.toFixed(2)}/径${amb.dust.radius.toFixed(2)}` : '关'} 蝇${amb.flyingFlies.enabled ? `开×${amb.flyingFlies.count}` : '关'} 爬${amb.crawlers.enabled ? '开' : '关'}`,
    ];
    if (live) {
      lines.push(
        `实例: ${String(live.instanceId || '—')}`,
        `生效 upright: ${live.upright ? '是' : '否'} · 托底: ${String(live.backgroundPreset || '—')}`,
        `亮度: ${Number(live.backgroundBrightness ?? 1).toFixed(2)} · 铺开: ${Number(live.backgroundScale ?? 1).toFixed(2)}`,
        `物体AO黑区: 强度 ${Number(live.contactAoIntensity ?? 1).toFixed(2)} · 模糊半径 ${Number(live.contactAoScale ?? 1).toFixed(2)}`,
        `DOF blur: ${Number(live.bgDofBlur ?? 0).toFixed(1)}`,
        `探入档: ${String(live.distanceIndex)} / ${Number(live.distanceSteps) - 1}`,
        `已发现(真): ${Array.isArray(live.foundHotspotIds) ? live.foundHotspotIds.length : 0}`,
      );
    }
    return lines.join('\n');
  }
}
