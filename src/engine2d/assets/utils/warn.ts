/**
 * 资源系统的告警(移植自 PixiJS v8.17(MIT):`utils/logging/warn`)。
 * 同 Pixi:最多打 500 条,第 500 条换成"告警太多、后面不再打"。
 */
let warnCount = 0;
const maxWarnings = 500;

export function warn(...args: unknown[]): void {
  if (warnCount === maxWarnings) return;
  warnCount++;
  if (warnCount === maxWarnings) {
    console.warn('[engine2d] Warning: too many warnings, no more warnings will be reported to the console by engine2d.');
  } else {
    console.warn('[engine2d] Warning: ', ...args);
  }
}
