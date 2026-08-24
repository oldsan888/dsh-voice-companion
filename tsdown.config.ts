/**
 * dsh-voice-companion 构建：host node-ESM entry + client browser-CJS bundle。
 * client bundle 走 DSH 的 __ModuleLoader__ 协议：window.__ModuleLoader__.load({id, factory})，
 * externals 对齐宿主 shell 的平台模块表（web 侧冻结提供），其余依赖内联进包。
 */
import { defineConfig } from 'tsdown'

/** 宿主 shell 冻结的平台模块表（web 运行时提供，client bundle 对它们 external）。 */
const PLATFORM = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-layout',
] as const

export default defineConfig([
  // host（node ESM）：聚合根 apply + server 插件。
  // cordis 由宿主 DSH 提供 → external（绝不内联副本）。
  {
    name: '@oldsan888/dsh-voice-companion/host',
    entry: {
      index: 'src/index.ts',
      server: 'src/server/index.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'] },
  },
  // client（browser CJS，__ModuleLoader__ 工厂）
  {
    name: '@oldsan888/dsh-voice-companion/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...PLATFORM],
      alwaysBundle: (id: string) => !PLATFORM.includes(id as never),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: '@oldsan888/dsh-voice-companion', factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
