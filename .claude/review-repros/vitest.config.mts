// 审查复现用例的独立 vitest 配置(主配置排除了 **/.claude/**,这些用例不进全量测试)。
// 用法(仓库根):npx vitest run --config .claude/review-repros/vitest.config.mts [路径过滤]
// 约定:复现用例「通过」= 偏差仍然存在;修复后应改写成 src/ 下断言 master / Pixi 行为的正式回归测试。
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(__dirname, '../..'),
  resolve: { alias: { '@': resolve(__dirname, '../../src') } },
  test: {
    globals: true,
    environment: 'node',
    include: ['.claude/review-repros/**/*.test.{ts,mts,mjs}'],
    exclude: ['**/node_modules/**'],
  },
});
