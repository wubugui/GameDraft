/** 按类别自增的唯一 id(与 Pixi `uid(name)` 同用法) */
const counters: Record<string, number> = Object.create(null);

export function uid(name = 'default'): number {
  counters[name] = (counters[name] ?? -1) + 1;
  return counters[name];
}
