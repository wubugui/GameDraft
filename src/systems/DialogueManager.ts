import { Story } from 'inkjs';
import type { Choice } from 'inkjs/engine/Choice';
import type { EventBus } from '../core/EventBus';
import type { FlagStore, FlagValue } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { InventoryManager } from './InventoryManager';
import type { ActionDef, IGameSystem, GameContext, DialogueLine, DialogueChoice } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import { bindInkExternals } from '../data/inkExternals';
import type { SceneManager } from './SceneManager';
import type { RulesManager } from './RulesManager';
function parseTagValue(s: string): string | number | boolean {
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  if (!isNaN(n) && s.trim() !== '') return n;
  return s;
}

function parseInkQuotedString(s: string, start: number): { value: string; end: number } | null {
  const q = s[start];
  if (q !== '"' && q !== "'") return null;
  let i = start + 1;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') {
        out += '\n';
        i += 2;
        continue;
      }
      if (n === 't') {
        out += '\t';
        i += 2;
        continue;
      }
      if (n === 'r') {
        out += '\r';
        i += 2;
        continue;
      }
      if (n === '\\' || n === '"' || n === "'") {
        out += n;
        i += 2;
        continue;
      }
      out += n;
      i += 2;
      continue;
    }
    if (c === q) {
      return { value: out, end: i + 1 };
    }
    out += c;
    i += 1;
  }
  return null;
}

/** setFlag / appendFlag：第一个 `:` 分键值；值可整体用引号包裹。 */
function parseSetFlagTagParam(paramStr: string): { key: string; value: FlagValue } | null {
  const idx = paramStr.indexOf(':');
  if (idx <= 0) return null;
  const key = paramStr.slice(0, idx).trim();
  if (!key) return null;
  const rest = paramStr.slice(idx + 1);
  const trimmed = rest.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const parsed = parseInkQuotedString(trimmed, 0);
    if (parsed !== null && parsed.end === trimmed.length) {
      return { key, value: parsed.value };
    }
    console.warn(
      `DialogueManager: 标签值的引号未闭合或格式非法，将按无引号规则解析: ${trimmed.slice(0, 48)}`,
    );
  }
  return { key, value: parseTagValue(trimmed) as FlagValue };
}

export class DialogueManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private assetManager: AssetManager;
  private inventoryManager: InventoryManager;
  private sceneManager: SceneManager;
  private rulesManager: RulesManager;
  private strings: StringsProvider | null = null;
  private story: Story | null = null;
  /** 非 Ink：预置台词队列（与 `story` 互斥） */
  private scriptedRemaining: DialogueLine[] | null = null;
  private active: boolean = false;
  private currentNpcName: string = '';
  private currentInkPath: string = '';
  /**
   * 非空台词上的 `# action:` 在本句展示并**由玩家点击推进之后**再执行（与下一句 `Continue` 之前刷新）。
   * 避免叠图等效果在台词尚未点过时触发。
   */
  private deferredDialogueActions: ActionDef[] = [];
  /**
   * 玩家在选项上确认后紧接着的 `advance` 须照常 `prepareBeat` 清空上一拍；
   * 从台词点击继续且下一拍仅有选项时则应保留最后一行在底栏（否则选项上方台词被先清空）。
   */
  private advanceFromChoice = false;
  /** 与 `Game.start({ devMode })` 同步；为 true 时 Ink `# action:` 解析问题会弹游戏内通知 */
  private devModeInkActionAlerts = false;

  constructor(
    eventBus: EventBus,
    flagStore: FlagStore,
    actionExecutor: ActionExecutor,
    assetManager: AssetManager,
    inventoryManager: InventoryManager,
    sceneManager: SceneManager,
    rulesManager: RulesManager,
  ) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
    this.assetManager = assetManager;
    this.inventoryManager = inventoryManager;
    this.sceneManager = sceneManager;
    this.rulesManager = rulesManager;
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
  }

  /** 由 Game 在 `start` 里根据 `?mode=dev` 等设置 */
  configureDevModeInkActionAlerts(enabled: boolean): void {
    this.devModeInkActionAlerts = !!enabled;
  }

  private reportInkActionProblem(detail: string): void {
    console.warn(`DialogueManager: ${detail}`);
    if (this.devModeInkActionAlerts) {
      this.eventBus.emit('notification:show', {
        text: `[开发] ${detail}`,
        type: 'warning',
      });
    }
  }

  update(_dt: number): void {}
  serialize(): object {
    if (!this.active || !this.story) return { active: false };
    return {
      active: true,
      inkPath: this.currentInkPath,
      npcName: this.currentNpcName,
    };
  }

  deserialize(data: any): void {
    if (this.active) {
      this.endDialogue();
    }
    this.active = false;
    this.advanceFromChoice = false;
    this.story = null;
    this.scriptedRemaining = null;
    this.currentNpcName = '';
    this.currentInkPath = '';
  }

  async startDialogue(inkPath: string, npcName: string, knotName?: string): Promise<void> {
    if (!inkPath?.trim()) return;
    this.scriptedRemaining = null;
    const jsonPath = inkPath.replace(/\.ink$/, '.ink.json');
    const jsonStr = await this.assetManager.loadText(jsonPath);

    this.story = new Story(jsonStr);
    bindInkExternals(this.story, {
      flagStore: this.flagStore,
      inventory: this.inventoryManager,
      resolveActorName: (id) => this.resolveActorNameForInk(id),
    });

    this.currentInkPath = inkPath;
    this.currentNpcName = npcName;
    this.active = true;

    if (knotName) {
      this.story.ChoosePathString(knotName);
    }

    this.eventBus.emit('dialogue:start', { npcName });
    this.deferredDialogueActions = [];
    await this.advance();
  }

  /**
   * 不加载 Ink，按顺序播放 `lines`（每条点击继续）；与对话 UI / EventBridge 流程一致。
   */
  startScriptedDialogue(lines: DialogueLine[]): void {
    if (!lines.length) return;
    this.story = null;
    this.currentInkPath = '';
    this.scriptedRemaining = lines.slice(1);
    this.active = true;
    this.currentNpcName = String(lines[0].speaker ?? '').trim();
    this.eventBus.emit('dialogue:start', { npcName: this.currentNpcName });
    this.eventBus.emit('dialogue:line', {
      speaker: lines[0].speaker,
      text: lines[0].text,
      tags: lines[0].tags ?? [],
    });
    if (lines.length === 1) {
      this.scheduleEnd();
    }
  }

  async advance(): Promise<void> {
    if (!this.active) return;

    const fromChoice = this.advanceFromChoice;
    this.advanceFromChoice = false;
    const choiceOnly =
      this.story !== null &&
      !this.story.canContinue &&
      this.story.currentChoices.length > 0;
    /** 从台词点到「仅选项」时跳过清空，保留上一句在对话底栏；选完选项后的推进仍清空。 */
    const skipPrepareBeat = choiceOnly && !fromChoice;
    if (!skipPrepareBeat) {
      /** 先清 UI 上一句，再执行推迟的 action / Continue，避免旧台词与叠图同屏。 */
      this.eventBus.emit('dialogue:prepareBeat', {});
    }

    if (this.scriptedRemaining !== null) {
      if (this.scriptedRemaining.length === 0) {
        this.scriptedRemaining = null;
        this.endDialogue();
        return;
      }
      const line = this.scriptedRemaining.shift()!;
      this.eventBus.emit('dialogue:line', line);
      if (this.scriptedRemaining.length === 0) {
        this.scheduleEnd();
      }
      return;
    }

    if (!this.story) return;

    await this.flushDeferredDialogueActions();

    if (this.story.canContinue) {
      const rawText = this.story.Continue() ?? '';
      const tags = this.story.currentTags ?? [];

      const text = this.normalizeInkSourceNewlines(rawText.trim());

      if (!text) {
        await this.processActionTags(tags);
        await this.advance();
        return;
      }

      this.queueDeferredActionTags(tags);

      const filteredTags = tags.filter(
        t => !t.startsWith('action:') && !t.startsWith('speaker:'),
      );
      const line = this.parseLine(text, tags, filteredTags);
      this.eventBus.emit('dialogue:line', line);

      if (!this.story.canContinue && this.story.currentChoices.length === 0) {
        this.scheduleEnd();
      }
    } else if (this.story.currentChoices.length > 0) {
      const choices = this.buildChoices(this.story.currentChoices);
      this.eventBus.emit('dialogue:choices', choices);
    } else {
      this.endDialogue();
    }
  }

  async chooseOption(index: number): Promise<void> {
    if (!this.story || !this.active) return;
    const choiceText = this.story.currentChoices[index]?.text ?? '';
    this.advanceFromChoice = true;
    this.story.ChooseChoiceIndex(index);
    this.eventBus.emit('dialogue:choiceSelected:log', { index, text: choiceText });
    await this.advance();
  }

  /** 仅 glue 段等无可见台词、或需立即执行的标签使用。 */
  private async processActionTags(tags: string[]): Promise<void> {
    const defs = this.collectActionDefsFromTags(tags);
    for (const actionDef of defs) {
      await this.actionExecutor.executeForDialogue(actionDef);
    }
  }

  private collectActionDefsFromTags(tags: string[]): ActionDef[] {
    const out: ActionDef[] = [];
    for (const tag of tags) {
      if (!tag.startsWith('action:')) continue;
      const actionDef = this.parseActionTag(tag);
      if (actionDef) out.push(actionDef);
    }
    return out;
  }

  private queueDeferredActionTags(tags: string[]): void {
    this.deferredDialogueActions = this.collectActionDefsFromTags(tags);
  }

  private async flushDeferredDialogueActions(): Promise<void> {
    if (this.deferredDialogueActions.length === 0) return;
    const batch = this.deferredDialogueActions;
    this.deferredDialogueActions = [];
    for (const actionDef of batch) {
      await this.actionExecutor.executeForDialogue(actionDef);
    }
  }

  private parseActionTag(tag: string): ActionDef | null {
    const withoutPrefix = tag.substring('action:'.length);
    const colonIdx = withoutPrefix.indexOf(':');

    if (colonIdx === -1) {
      const t = withoutPrefix.trim();
      if (!this.actionExecutor.hasHandler(t)) {
        this.reportInkActionProblem(`未知对话 Action 类型「${t}」`);
        return null;
      }
      return { type: t, params: {} };
    }

    const actionType = withoutPrefix.substring(0, colonIdx);
    const paramStr = withoutPrefix.substring(colonIdx + 1);

    if (!this.actionExecutor.hasHandler(actionType)) {
      this.reportInkActionProblem(`未知对话 Action 类型「${actionType}」`);
      return null;
    }

    const paramNames = this.actionExecutor.getParamNames(actionType);
    if (!paramNames || paramNames.length === 0) {
      if (paramStr.trim().length > 0) {
        this.reportInkActionProblem(
          `Action「${actionType}」无参数 schema，标签参数已忽略：${paramStr.slice(0, 80)}`,
        );
      }
      return { type: actionType, params: {} };
    }

    const params: Record<string, unknown> = {};

    if (actionType === 'setFlag' && paramNames.length === 2) {
      const sf = parseSetFlagTagParam(paramStr);
      if (!sf) {
        this.reportInkActionProblem(`setFlag 标签参数无法解析：${paramStr.slice(0, 80)}`);
        return null;
      }
      params.key = sf.key;
      params.value = sf.value;
    } else if (actionType === 'appendFlag' && paramNames.length === 2) {
      const sf = parseSetFlagTagParam(paramStr);
      if (!sf) {
        this.reportInkActionProblem(`appendFlag 标签参数无法解析：${paramStr.slice(0, 80)}`);
        return null;
      }
      params.key = sf.key;
      params.text = typeof sf.value === 'string' ? sf.value : String(sf.value);
    } else if (paramNames.length === 1) {
      params[paramNames[0]] = parseTagValue(paramStr);
    } else {
      const rawParts = paramStr.split(':');
      for (let i = 0; i < paramNames.length; i++) {
        if (i < rawParts.length) {
          if (i === paramNames.length - 1 && rawParts.length > paramNames.length) {
            params[paramNames[i]] = parseTagValue(rawParts.slice(i).join(':'));
          } else {
            params[paramNames[i]] = parseTagValue(rawParts[i]);
          }
        }
      }
    }

    return { type: actionType, params };
  }

  /** `strings.get` 在缺 key 时会回传 key 本身，这里避免把文案键名显示在 UI 上 */
  private dialogueStr(key: string, whenMissing: string): string {
    const s = this.strings?.get('dialogue', key);
    return s && s !== key ? s : whenMissing;
  }

  /**
   * Ink 编译后 `\\n` 常变成句读后的孤立字母 `n`（反斜杠被吃掉），按常见中文起句模式还原为换行；
   *若仍带 `\\n` 字面量则转为真正换行。
   */
  private normalizeInkSourceNewlines(text: string): string {
    let t = text.replace(/\\n/g, '\n');
    t = t.replace(/([。！？…～])n([\u4e00-\u9fff「『【（])/g, '$1\n$2');
    return t;
  }

  /** Ink `getActorName`：`@` 主角，`#` 当前对话 NPC，否则为场景内 NPC id（未找到则回退为 id 原文）。 */
  private resolveActorNameForInk(rawId: string): string {
    const id = rawId.trim();
    if (id === '@') {
      const v = this.flagStore.get('player_display_name');
      if (typeof v === 'string' && v.trim()) return v.trim();
      return this.dialogueStr('defaultProtagonistName', '你');
    }
    if (id === '#') return this.currentNpcName;
    const npc = this.sceneManager.getNpcById(id);
    if (npc) return npc.def.name;
    return id;
  }

  private parseLine(
    text: string,
    rawTags: string[],
    filteredTags: string[],
  ): DialogueLine {
    const narrator = this.dialogueStr('narratorLabel', '旁白');
    let speaker = narrator;

    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 20) {
      const possibleSpeaker = text.substring(0, colonIdx).trim();
      if (!possibleSpeaker.includes(' ') || possibleSpeaker.length < 10) {
        if (possibleSpeaker === '@') {
          speaker = this.resolveActorNameForInk('@');
        } else if (possibleSpeaker === '%') {
          speaker = this.currentNpcName;
        } else {
          speaker = possibleSpeaker;
        }
        text = text.substring(colonIdx + 1).trim();
      }
    }

    for (const tag of rawTags) {
      if (tag.startsWith('speaker:')) {
        speaker = tag.substring('speaker:'.length).trim();
      }
    }

    return { speaker, text, tags: filteredTags };
  }

  private buildChoices(inkChoices: Choice[]): DialogueChoice[] {
    const peeked = this.peekChoiceContentTags(inkChoices.length);

    return inkChoices.map((choice, i) => {
      let ruleHintId: string | undefined;
      let requireKey: string | undefined;
      let costAmount: number | undefined;
      const tags = peeked[i];

      for (const tag of tags) {
        if (tag.startsWith('require:')) {
          requireKey = tag.substring('require:'.length).trim();
        }
        if (tag.startsWith('cost:')) {
          const n = parseInt(tag.substring('cost:'.length).trim(), 10);
          if (!Number.isNaN(n)) costAmount = n;
        }
        if (tag.startsWith('ruleHint:')) {
          ruleHintId = tag.substring('ruleHint:'.length).trim();
        }
      }

      const coins = (this.flagStore.get('coins') as number) ?? 0;
      const reqOk = requireKey === undefined || !!this.flagStore.get(requireKey);
      const costOk = costAmount === undefined || coins >= costAmount;
      const enabled = reqOk && costOk;
      const disableHint = enabled
        ? undefined
        : this.buildChoiceDisableHint({ requireKey, reqOk, costAmount, costOk, ruleHintId });

      return {
        index: i,
        text: choice.text,
        tags,
        enabled,
        ruleHintId,
        disableHint,
      };
    });
  }

  private buildChoiceDisableHint(args: {
    requireKey: string | undefined;
    reqOk: boolean;
    costAmount: number | undefined;
    costOk: boolean;
    ruleHintId: string | undefined;
  }): string | undefined {
    const s = this.strings;
    if (!s) return undefined;

    if (!args.reqOk && args.requireKey) {
      if (args.ruleHintId) {
        const def = this.rulesManager.getRuleDef(args.ruleHintId);
        const name = def?.name ?? args.ruleHintId;
        return s.get('dialogue', 'choiceNeedRule', { name });
      }
      return s.get('dialogue', 'choiceFlagLocked');
    }

    if (!args.costOk && args.costAmount !== undefined) {
      return s.get('dialogue', 'choiceNeedCoins', { amount: args.costAmount });
    }

    return undefined;
  }

  /**
   * inkjs JS compiler does not populate Choice.tags; tags written on
   * a choice line end up inside the choice content instead. Peek into
   * each branch via state save/restore to extract them before the
   * player actually picks an option.
   */
  private peekChoiceContentTags(count: number): string[][] {
    if (!this.story) return Array.from({ length: count }, () => []);

    const saved = this.story.state.toJson();
    const result: string[][] = [];

    for (let i = 0; i < count; i++) {
      this.story.state.LoadJson(saved);
      this.story.ChooseChoiceIndex(i);
      if (this.story.canContinue) {
        this.story.Continue();
        result.push([...(this.story.currentTags ?? [])]);
      } else {
        result.push([]);
      }
    }

    this.story.state.LoadJson(saved);
    return result;
  }

  private scheduleEnd(): void {
    this.eventBus.emit('dialogue:willEnd', {});
  }

  endDialogue(): void {
    if (!this.active) return;
    this.active = false;
    this.advanceFromChoice = false;
    this.story = null;
    this.scriptedRemaining = null;
    this.deferredDialogueActions = [];
    this.currentNpcName = '';
    this.currentInkPath = '';
    this.eventBus.emit('dialogue:end', {});
  }

  get isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    this.story = null;
    this.scriptedRemaining = null;
    this.active = false;
    this.advanceFromChoice = false;
    this.deferredDialogueActions = [];
    this.currentNpcName = '';
    this.currentInkPath = '';
  }
}
