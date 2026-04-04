import { Story } from 'inkjs';
import type { Choice } from 'inkjs/engine/Choice';
import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { ActionDef, IGameSystem, GameContext, DialogueLine, DialogueChoice } from '../data/types';

function parseTagValue(s: string): string | number | boolean {
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  if (!isNaN(n) && s.trim() !== '') return n;
  return s;
}

export class DialogueManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private assetManager: AssetManager;
  private story: Story | null = null;
  private active: boolean = false;
  private currentNpcName: string = '';
  private currentInkPath: string = '';

  constructor(
    eventBus: EventBus,
    flagStore: FlagStore,
    actionExecutor: ActionExecutor,
    assetManager: AssetManager,
  ) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
    this.assetManager = assetManager;
  }

  init(_ctx: GameContext): void {}
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
    this.story = null;
    this.currentNpcName = '';
    this.currentInkPath = '';
  }

  async startDialogue(inkPath: string, npcName: string, knotName?: string): Promise<void> {
    const jsonPath = inkPath.replace(/\.ink$/, '.ink.json');
    const jsonStr = await this.assetManager.loadText(jsonPath);

    this.story = new Story(jsonStr);
    this.bindGetFlag();

    this.currentInkPath = inkPath;
    this.currentNpcName = npcName;
    this.active = true;

    if (knotName) {
      this.story.ChoosePathString(knotName);
    }

    this.eventBus.emit('dialogue:start', { npcName });
    this.advance();
  }

  private bindGetFlag(): void {
    if (!this.story) return;
    this.story.BindExternalFunction('getFlag', (key: string) => {
      const val = this.flagStore.get(key);
      if (typeof val === 'boolean') return val ? 1 : 0;
      return val ?? 0;
    }, true);
  }

  advance(): void {
    if (!this.story || !this.active) return;

    if (this.story.canContinue) {
      const rawText = this.story.Continue() ?? '';
      const tags = this.story.currentTags ?? [];

      this.processActionTags(tags);

      const text = rawText.trim();

      if (!text) {
        this.advance();
        return;
      }

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

  chooseOption(index: number): void {
    if (!this.story || !this.active) return;
    const choiceText = this.story.currentChoices[index]?.text ?? '';
    this.story.ChooseChoiceIndex(index);
    this.eventBus.emit('dialogue:choiceSelected:log', { index, text: choiceText });
    this.advance();
  }

  private processActionTags(tags: string[]): void {
    for (const tag of tags) {
      if (!tag.startsWith('action:')) continue;

      const actionDef = this.parseActionTag(tag);
      if (actionDef) {
        this.actionExecutor.execute(actionDef);
      }
    }
  }

  private parseActionTag(tag: string): ActionDef | null {
    const withoutPrefix = tag.substring('action:'.length);
    const colonIdx = withoutPrefix.indexOf(':');

    if (colonIdx === -1) {
      return { type: withoutPrefix, params: {} };
    }

    const actionType = withoutPrefix.substring(0, colonIdx);
    const paramStr = withoutPrefix.substring(colonIdx + 1);
    const paramNames = this.actionExecutor.getParamNames(actionType);

    if (!paramNames) {
      console.warn(`DialogueManager: unknown action tag type "${actionType}"`);
      return null;
    }

    const params: Record<string, unknown> = {};

    if (paramNames.length === 1) {
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

  private parseLine(
    text: string,
    rawTags: string[],
    filteredTags: string[],
  ): DialogueLine {
    let speaker = this.currentNpcName;

    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 20) {
      const possibleSpeaker = text.substring(0, colonIdx).trim();
      if (!possibleSpeaker.includes(' ') || possibleSpeaker.length < 10) {
        speaker = possibleSpeaker;
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
    return inkChoices.map((choice, i) => {
      let enabled = true;
      let ruleHintId: string | undefined;
      const tags = choice.tags ?? [];

      for (const tag of tags) {
        if (tag.startsWith('require:')) {
          const flagKey = tag.substring('require:'.length).trim();
          enabled = !!this.flagStore.get(flagKey);
        }
        if (tag.startsWith('cost:')) {
          const amount = parseInt(tag.substring('cost:'.length).trim(), 10);
          const coins = (this.flagStore.get('coins') as number) ?? 0;
          enabled = coins >= amount;
        }
        if (tag.startsWith('ruleHint:')) {
          ruleHintId = tag.substring('ruleHint:'.length).trim();
        }
      }

      return {
        index: i,
        text: choice.text,
        tags,
        enabled,
        ruleHintId,
      };
    });
  }

  private scheduleEnd(): void {
    this.eventBus.emit('dialogue:willEnd', {});
  }

  endDialogue(): void {
    if (!this.active) return;
    this.active = false;
    this.story = null;
    this.currentNpcName = '';
    this.eventBus.emit('dialogue:end', {});
  }

  get isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    this.story = null;
    this.active = false;
    this.currentNpcName = '';
  }
}
