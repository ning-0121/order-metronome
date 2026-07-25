import { defineConfig } from 'vitest/config';

// 单元测试(2026-07-24 · 根因6):给高危纯逻辑补自动化回归。
// 与现有 `npm run check`(node:assert 脚本)并存;vitest 跑 *.test.ts。
export default defineConfig({
  resolve: {
    alias: { '@': import.meta.dirname },   // 对齐 tsconfig paths "@/*": ["./*"]
  },
  test: {
    include: ['tests/**/*.test.ts'],   // 仅本目录的 vitest 用例;lib/**/__tests__ 是 node:test,另经 npm run test:ai-runtime 跑
    environment: 'node',
    passWithNoTests: false,
  },
});
