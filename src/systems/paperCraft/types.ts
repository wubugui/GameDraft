import type { ActionDef } from '../../data/types';

export interface PaperCraftIndexEntry {
  id: string;
  label: string;
  file: string;
}

export interface PaperCraftPartDef {
  id: string;
  label: string;
  image?: string;
  score?: number;
  tags?: string[];
}

export interface PaperCraftSlotDef {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  accepts: string[];
  optional?: boolean;
}

export interface PaperCraftPaperOption {
  id: string;
  label: string;
  tint: string;
  score?: number;
  tags?: string[];
}

export interface PaperCraftFinishOption {
  id: string;
  label: string;
  score?: number;
  tags?: string[];
}

export interface PaperCraftOrderDef {
  id: string;
  title: string;
  description?: string;
  targetHint?: string;
  correctPaper?: string;
  finishQuestion?: string;
  parts: PaperCraftPartDef[];
  slots: PaperCraftSlotDef[];
  paperOptions?: PaperCraftPaperOption[];
  finishOptions?: PaperCraftFinishOption[];
  successScore?: number;
  warnScore?: number;
  onSuccessActions?: ActionDef[];
  onWarnActions?: ActionDef[];
  onBadActions?: ActionDef[];
}

export interface PaperCraftInstance {
  id: string;
  label: string;
  backgroundImage?: string;
  orders: PaperCraftOrderDef[];
}

export interface PaperCraftPlacedPart {
  slotId: string;
  partId: string;
  partLabel: string;
}

export interface PaperCraftResult {
  instanceId: string;
  instanceLabel: string;
  orderId: string;
  orderTitle: string;
  score: number;
  level: 'success' | 'warn' | 'bad';
  paperId: string;
  finishId: string;
  tags: string[];
  placed: PaperCraftPlacedPart[];
}
