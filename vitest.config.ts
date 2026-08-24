import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts?(x)'],
    environmentMatchGlobs: [
      ['tests/panel.test.tsx', 'jsdom'],
    ],
    // 真实时钟仅用于极短等待；核心时序全部用注入 clock。
  },
})
