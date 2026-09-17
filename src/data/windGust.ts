/** 一次有限阵风；毫秒时间轴同时驱动共享风场与指定环境音层。 */
export interface WindGustDef {
  speedMultiplier: number;
  durationMs: number;
  attackMs?: number;
  releaseMs?: number;
  /** 已播放的 ambient 层；不创建新环境音。volume 是峰值本处音量。 */
  id?: string;
  volume?: number;
  wait?: boolean;
}

export function windGustErrors(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const number = (key: string, min: number, max: number, required = false) => {
    const value = p[key];
    if (value === undefined && !required) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      errors.push(`${key} must be a finite number in [${min}, ${max}]`);
  };
  number('speedMultiplier', 1, 64, true);
  number('durationMs', 1, 60000, true);
  number('attackMs', 0, 60000);
  number('releaseMs', 0, 60000);
  number('volume', 0, 1);
  // 默认快速起风、缓慢收束；极短阵风按总时长的比例取值。
  if (typeof p.durationMs === 'number' && Number.isFinite(p.durationMs)) {
    const a = p.attackMs ?? Math.min(120, p.durationMs * 0.1);
    const r = p.releaseMs ?? Math.min(500, p.durationMs * 0.25);
    if (typeof a === 'number' && typeof r === 'number' && a + r > p.durationMs)
      errors.push('attackMs + releaseMs must not exceed durationMs');
  }
  if (p.id !== undefined && typeof p.id !== 'string') errors.push('id must be an ambient id');
  if (p.volume !== undefined && (typeof p.id !== 'string' || !p.id.trim())) errors.push('volume needs an ambient id');
  if (p.wait !== undefined && typeof p.wait !== 'boolean') errors.push('wait must be boolean');
  return errors;
}
