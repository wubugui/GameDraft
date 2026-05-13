/**
 * 世界滤镜管线：管理施加于 worldContainer 的 shader 滤镜栈
 * 架构可扩展，后续可串联：氛围滤镜、深度效果、Bloom 等
 */
import type { Container, Filter } from 'pixi.js';

export class WorldFilterPipeline {
  private target: Container;
  private filters: Filter[] = [];

  constructor(target: Container) {
    this.target = target;
  }

  /**
   * 设置滤镜栈（替换现有）
   * 传入空数组则清除所有滤镜
   */
  setFilters(filters: Filter[]): void {
    this.filters = filters;
    this.target.filters = filters.length > 0 ? filters : null;
  }

  /**
   * 追加滤镜到栈尾
   */
  pushFilter(filter: Filter): void {
    this.filters = [...this.filters, filter];
    this.target.filters = this.filters;
  }

  /**
   * 移除栈尾滤镜
   */
  popFilter(): Filter | undefined {
    const removed = this.filters.pop();
    this.target.filters = this.filters.length > 0 ? this.filters : null;
    return removed;
  }

  /**
   * 清除所有滤镜
   */
  clear(): void {
    this.filters = [];
    this.target.filters = null;
  }

  /**
   * 获取当前滤镜栈（只读）
   */
  getFilters(): readonly Filter[] {
    return this.filters;
  }

  /**
   * 是否启用了滤镜
   */
  get hasFilters(): boolean {
    return this.filters.length > 0;
  }
}
