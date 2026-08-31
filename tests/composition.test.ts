/** 组合测试：cordis.patch.yml 契约、apply 接线、prompt section、5256 零依赖扫描、client bundle 产物。 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { makeFakeHostCtx, makeWav } from './host-test-utils.ts'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('cordis.patch.yml 契约', () => {
  /** patch 文件是操作列表：[{insert:[...]}]。 */
  const parsed = parseYaml(readFileSync(join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')) as
    | Array<{ insert: Array<{ id: string; name: string; config?: Record<string, unknown> }> }>
    | { insert: Array<{ id: string; name: string; config?: Record<string, unknown> }> }
  const operations = Array.isArray(parsed) ? parsed : [parsed]
  const rows = operations.flatMap(operation => operation.insert ?? [])

  it('两行：host server 行 + client 根行', () => {
    expect(rows).toHaveLength(2)
    const [serverRow, uiRow] = rows
    expect(serverRow.id).toBe('voice-companion-server')
    expect(serverRow.name).toBe('@oldsan888/dsh-voice-companion/server')
    expect(uiRow.id).toBe('voice-companion-ui')
    expect(uiRow.name).toBe('@oldsan888/dsh-voice-companion')
    expect(uiRow.config).toBeUndefined()
  })

  it('config 为 v2.1 内置 Provider 形态（无 ttsUrl/无 5256）', () => {
    const config = (rows[0].config ?? {}) as Record<string, unknown>
    expect(config.provider).toBe('mimo')
    expect(config.model).toBe('mimo-v2.5-tts-voiceclone')
    expect(config.secretsFile).toBeUndefined()
    expect(config.promptEnabled).toBe(true)
    for (const key of ['maxLineChars', 'askMaxChars', 'queueLimit', 'requestTimeoutMs', 'maxAudioBytes', 'leaseTtlMs']) {
      expect(Number(config[key])).toBeGreaterThan(0)
    }
    expect(JSON.stringify(rows)).not.toContain('ttsUrl')
    expect(JSON.stringify(rows)).not.toContain('5256')
  })
})

describe('包清单契约', () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    name: string
    files?: string[]
    dsh: { bundle: { patch: string }, client: { platform: string, inject: string[] } }
    exports: Record<string, string>
  }

  it('bundle.patch 指向 cordis.patch.yml；client platform=web 且 inject 宿主模块', () => {
    expect(manifest.name).toBe('@oldsan888/dsh-voice-companion')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-runtime')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-slots')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(manifest.exports['./client']).toBe('./lib/client.js')
    expect(manifest.exports['./server']).toBe('./lib/server.js')
  })

  it('参考音频随 files 发布且存在', () => {
    const manifestFiles = manifest.files ?? []
    expect(manifestFiles.some(entry => entry.includes('assets/voice-reference.wav'))).toBe(true)
    expect(existsSync(join(PKG_ROOT, 'assets', 'voice-reference.wav'))).toBe(true)
  })

  it('公开包声明仓库、宿主 peers 与公开文档', () => {
    const publicManifest = manifest as typeof manifest & {
      private?: boolean
      repository?: { url?: string }
      peerDependencies?: Record<string, string>
    }
    expect(publicManifest.private).toBe(false)
    expect(publicManifest.repository?.url).toContain('oldsan888/dsh-voice-companion')
    expect(publicManifest.peerDependencies).toMatchObject({
      '@deepseek-ai/dsh-client-ui-slots': expect.any(String),
      '@deepseek-ai/dsh-host-webserver': expect.any(String),
      '@deepseek-ai/dsh-session': expect.any(String),
      '@deepseek-ai/dsh-system-prompt': expect.any(String),
      '@deepseek-ai/dsh-tools': expect.any(String),
    })
    expect(publicManifest.files).toContain('docs/*.md')
  })
})

describe('server apply 接线', () => {
  function setup(config: Record<string, unknown> = {}, overrides: unknown = {}) {
    const host = makeFakeHostCtx()
    // 动态 import 避免与 http.test.ts 的静态导入耦合。
    return import('../src/server/index.ts').then(serverModule => {
      serverModule.apply(host.ctx as never, { promptEnabled: true, larkEnabled: false, ...config }, overrides as never)
      return { host, serverModule }
    })
  }

  it('注册全局 session/event 与 tools/execute 监听器', async () => {
    const { host } = await setup({ promptEnabled: false })
    const names = host.listeners.map(item => item.name)
    expect(names).toContain('session/event')
    expect(names).toContain('tools/execute')
    expect(host.listeners.find(item => item.name === 'session/event')?.options?.global).toBe(true)
    expect(host.listeners.find(item => item.name === 'tools/execute')?.options?.global).toBe(true)
  })

  it('注册 voice_prepare，并在 completed 后复用预合成 WAV', async () => {
    const wav = Buffer.from('RIFF-prefetched-audio')
    let synthesizeCalls = 0
    const fakeTts = {
      health: () => ({ status: 'ready' as const, checkedAt: 1 }),
      configured: () => true,
      synthesize: async () => { synthesizeCalls++; return wav },
      dispose: () => undefined,
    }
    const { host } = await setup({ promptEnabled: true }, { tts: fakeTts })
    const tool = host.tools.find((candidate) => (candidate as { name?: string }).name === 'voice_prepare') as {
      execute: (args: { text: string }, exec: unknown) => Promise<{ accepted: boolean }>
    }
    expect(tool).toBeDefined()
    const listener = host.listeners.find(item => item.name === 'session/event')!
    const session = { id: 'session-prefetch' }
    listener.listener(session as never, { type: 'turn/start', data: { turn: 7 } } as never)
    await expect(tool.execute({ text: '长任务已经完成。' }, { agent: { session: { id: 'session-prefetch' } } }))
      .resolves.toMatchObject({ accepted: true })
    listener.listener(session as never, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } } as never)

    const { invokeRoute } = await import('./host-test-utils.ts')
    await invokeRoute(host.routes.get('/api/dsh-voice/lease')!, { method: 'POST', body: { action: 'acquire', clientId: 'tester' } })
    const batch = await invokeRoute(host.routes.get('/api/dsh-voice/drain')!, { method: 'GET', url: '/api/dsh-voice/drain?clientId=tester' })
    const [event] = (batch.json() as { events: Array<{ id: string, text: string }> }).events
    expect(event?.text).toBe('长任务已经完成。')
    const audio = await invokeRoute(host.routes.get('/api/dsh-voice/tts')!, {
      method: 'POST', body: { eventId: event?.id, text: event?.text, clientId: 'tester' },
    })
    expect(audio.body.equals(wav)).toBe(true)
    expect(synthesizeCalls).toBe(1)
  })

  it('tools/execute waterfall 必须委托 next() 并返回其结果', async () => {
    const { host } = await setup({ promptEnabled: false })
    const listener = host.listeners.find(item => item.name === 'tools/execute')!
    let nextCalled = false
    const result = await (listener.listener as (exec: unknown, next: () => Promise<string>) => Promise<string>)(
      { name: 'other_tool', callId: 'c1', arguments: {} },
      async () => { nextCalled = true; return 'tool-result' },
    )
    expect(nextCalled).toBe(true)
    expect(result).toBe('tool-result')
  })

  it('两个会话交错且同时完成时都保留自己的播报文本', async () => {
    const { host } = await setup({ promptEnabled: false })
    const listener = host.listeners.find(item => item.name === 'session/event')!
    const sessionA = { id: 'session-a' }
    const sessionB = { id: 'session-b' }
    listener.listener(sessionA as never, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '@voice A 完成' }] } } } as never)
    listener.listener(sessionB as never, { type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: '@voice B 完成' }] } } } as never)
    // 瞬时 request-error（会被 DSH 自动重试）绝不生成 fail。
    listener.listener(sessionA as never, { type: 'agent/request-error', data: { failure: { message: '瞬时网络抖动，会被自动重试' } } } as never)

    const { invokeRoute } = await import('./host-test-utils.ts')
    await invokeRoute(host.routes.get('/api/dsh-voice/lease')!, { method: 'POST', body: { action: 'acquire', clientId: 'tester' } })
    const drainRoute = host.routes.get('/api/dsh-voice/drain')!

    // B 先完成：拿到的是 B 自己的文本。
    listener.listener(sessionB as never, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } } as never)
    let batch = await invokeRoute(drainRoute, { method: 'GET', url: '/api/dsh-voice/drain?clientId=tester' })
    expect((batch.json() as { events: Array<{ kind: string, text: string }> }).events.map(event => `${event.kind}:${event.text}`))
      .toEqual(['done:B 完成'])

    // A 紧接着完成：不同 sourceKey 必须保留，不能被跨会话时间窗吞掉。
    listener.listener(sessionA as never, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } as never)
    batch = await invokeRoute(drainRoute, { method: 'GET', url: '/api/dsh-voice/drain?clientId=tester' })
    expect((batch.json() as { events: Array<{ kind: string, text: string }> }).events.map(event => `${event.kind}:${event.text}`))
      .toEqual(['done:A 完成'])
  })

  it('turn/end error 只入队一次 fail（重复事件由 sourceKey 去重拦截）', async () => {
    const { host } = await setup({ promptEnabled: false })
    const listener = host.listeners.find(item => item.name === 'session/event')!
    const sessionA = { id: 'session-a' }
    const payload = { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'API_KEY=secret C:\\private\\file', code: 'E_X' } } } } as never
    listener.listener(sessionA as never, payload)
    listener.listener(sessionA as never, payload)
    const { invokeRoute } = await import('./host-test-utils.ts')
    await invokeRoute(host.routes.get('/api/dsh-voice/lease')!, { method: 'POST', body: { action: 'acquire', clientId: 'tester' } })
    const batch = await invokeRoute(host.routes.get('/api/dsh-voice/drain')!, { method: 'GET', url: '/api/dsh-voice/drain?clientId=tester' })
    const events = (batch.json() as { events: Array<{ kind: string, text: string }> }).events
    expect(events.filter(event => event.kind === 'fail')).toHaveLength(1)
    expect(events[0]?.text).not.toContain('secret')
    expect(events[0]?.text).not.toContain('private')
  })

  it('promptEnabled 注册 @voice section；dispose 后移除', async () => {
    const { host } = await setup({})
    const section = host.sections.find(item => item.name === 'voice-companion:marker')
    expect(section).toBeDefined()
    expect(section!.text).toContain('@voice')
    expect(section!.order).toBe(130)
    const effect = host.effects.find(item => item.label === 'dsh-voice-companion: prompt section')!
    effect.dispose()
    expect(host.sections.find(item => item.name === 'voice-companion:marker')).toBeUndefined()
  })

  it('promptEnabled=false 不注册 prompt section', async () => {
    const { host } = await setup({ promptEnabled: false })
    expect(host.sections).toHaveLength(0)
  })
})

describe('零依赖约束扫描', () => {
  function walkSources(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walkSources(full))
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('src 与 lib 不引用 localhost:5256 / Mimo-tts-web / /api/tts', () => {
    const sources = [...walkSources(join(PKG_ROOT, 'src')), ...(existsSync(join(PKG_ROOT, 'lib')) ? walkSources(join(PKG_ROOT, 'lib')) : [])]
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      const content = readFileSync(file, 'utf8')
      expect(content.includes(':5256')).toBe(false)
      expect(/mimo-tts-web/i.test(content)).toBe(false)
      expect(content.includes('/api/tts')).toBe(false)
    }
  })

  it('client bundle 存在且走 __ModuleLoader__ 协议（先 build 后 test）', () => {
    const bundlePath = join(PKG_ROOT, 'lib', 'client.js')
    expect(existsSync(bundlePath), 'lib/client.js 缺失——请先运行 pnpm run build').toBe(true)
    const bundle = readFileSync(bundlePath, 'utf8')
    expect(bundle).toMatch(/id:\s*['"]@oldsan888\/dsh-voice-companion['"]/)
    expect(bundle).toContain('__ModuleLoader__.load')
    expect(bundle).not.toContain(':5256')
  })

  it('client bundle 内联音色 Profile 路由与激活/回滚调用', () => {
    const bundlePath = join(PKG_ROOT, 'lib', 'client.js')
    const bundle = readFileSync(bundlePath, 'utf8')
    // 面板接入 Profile API 后，bundle 必须内联这些路由片与调用符号。
    // （路由是 `${ROUTE_PREFIX}/profiles` 模板拼接，因此按片段断言。）
    expect(bundle).toContain('/api/dsh-voice')
    expect(bundle).toContain('profiles/activate')
    expect(bundle).toContain('profiles/rollback')
    expect(bundle).toContain('profiles/reference')
    expect(bundle).toContain('listProfiles')
    expect(bundle).toContain('activateProfile')
    expect(bundle).toContain('rollbackProfile')
    expect(bundle).toContain('getProfileReference')
  })

  it('host bundle 导出 server 入口', () => {
    expect(existsSync(join(PKG_ROOT, 'lib', 'server.js'))).toBe(true)
    expect(existsSync(join(PKG_ROOT, 'lib', 'index.js'))).toBe(true)
  })
})

describe('Phase 2 音色设计工具', () => {
  function toolOf(host: ReturnType<typeof makeFakeHostCtx>, name: string): {
    name: string
    execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
  } {
    const tool = host.tools.find((candidate) => (candidate as { name?: string }).name === name) as {
      name: string
      execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
    }
    expect(tool, `tool ${name} 未注册`).toBeDefined()
    return tool
  }

  function setupPhase2(config: Record<string, unknown> = {}) {
    const host = makeFakeHostCtx()
    const root = mkdtempSync(join(tmpdir(), 'dsh-phase2-'))
    const fakeTts = {
      health: () => ({ status: 'ready' as const, checkedAt: 1 }),
      configured: () => true,
      synthesize: async (text: string) => makeWav({ dataBytes: 32 }),
      synthesizeDesign: async (prompt: string, text: string) => makeWav({ dataBytes: 64 }),
      dispose: () => undefined,
    }
    return import('../src/server/index.ts').then(serverModule => {
      serverModule.apply(host.ctx as never, { promptEnabled: false, larkEnabled: false, ...config }, {
        tts: fakeTts,
        profilesRoot: root,
      } as never)
      return { host, root }
    })
  }

  it('注册齐 Phase 2 的 7 个工具', async () => {
    const { host, root } = await setupPhase2()
    for (const name of ['voice_profile_list', 'voice_profile_design', 'voice_profile_refine', 'voice_profile_preview', 'voice_profile_activate', 'voice_profile_rollback', 'voice_profile_delete']) {
      expect(host.tools.some((candidate) => (candidate as { name?: string }).name === name)).toBe(true)
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('voice_profile_list：只读返回内置兜底与激活状态', async () => {
    const { host, root } = await setupPhase2()
    const result = await toolOf(host, 'voice_profile_list').execute({})
    expect(result.ok).toBe(true)
    expect(result.profiles).toHaveLength(1)
    const summary = (result.profiles as Array<Record<string, unknown>>)[0]
    expect(summary.kind).toBe('builtin')
    expect(summary.readOnly).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('voice_profile_design：按 count 生成候选并固化为 design Profile', async () => {
    const { host, root } = await setupPhase2()
    const result = await toolOf(host, 'voice_profile_design').execute({ demand: '成熟一点的女声', count: 2, previewText: '试听一下' })
    expect(result.ok).toBe(true)
    const candidates = result.candidates as Array<Record<string, unknown>>
    expect(candidates).toHaveLength(2)
    expect(candidates[0].kind).toBe('design')
    expect(candidates[0].approved).toBe(false)
    // 列表同时看到内置 + 两个候选。
    const listResult = await toolOf(host, 'voice_profile_list').execute({})
    expect((listResult.profiles as unknown[]).length).toBe(3)
    rmSync(root, { recursive: true, force: true })
  })

  it('voice_profile_activate：未确认 → 拒绝；confirm=true 才批准并激活', async () => {
    const { host, root } = await setupPhase2()
    const designResult = await toolOf(host, 'voice_profile_design').execute({ demand: '沉稳男声', count: 1 })
    const candId = (designResult.candidates as Array<{ id: string }>)[0].id

    const noConfirm = await toolOf(host, 'voice_profile_activate').execute({ id: candId })
    expect(noConfirm.ok).toBe(false)

    const ok = await toolOf(host, 'voice_profile_activate').execute({ id: candId, confirm: true })
    expect(ok.ok).toBe(true)
    const list = await toolOf(host, 'voice_profile_list').execute({})
    const active = (list.profiles as Array<{ active: boolean; kind: string; approved: boolean }>).find(p => p.active)
    expect(active?.active).toBe(true)
    expect(active?.kind).toBe('clone')
    expect(active?.approved).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('voice_profile_preview：入队带 previewProfileId 的试听事件', async () => {
    const { host, root } = await setupPhase2()
    const designResult = await toolOf(host, 'voice_profile_design').execute({ demand: '温柔女声', count: 1 })
    const candId = (designResult.candidates as Array<{ id: string }>)[0].id
    const previewResult = await toolOf(host, 'voice_profile_preview').execute({ id: candId })
    expect(previewResult.ok).toBe(true)
    expect(previewResult.enqueued).toBe(true)

    const { invokeRoute } = await import('./host-test-utils.ts')
    await invokeRoute(host.routes.get('/api/dsh-voice/lease')!, { method: 'POST', body: { action: 'acquire', clientId: 'tester' } })
    const batch = await invokeRoute(host.routes.get('/api/dsh-voice/drain')!, { method: 'GET', url: '/api/dsh-voice/drain?clientId=tester' })
    const events = (batch.json() as { events: Array<{ kind: string; previewProfileId?: string }> }).events
    expect(events.some(e => e.previewProfileId === candId)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('voice_profile_delete / rollback：未确认拒绝；confirm=true 生效', async () => {
    const { host, root } = await setupPhase2()
    const designResult = await toolOf(host, 'voice_profile_design').execute({ demand: '测试音色', count: 1 })
    const candId = (designResult.candidates as Array<{ id: string }>)[0].id

    expect((await toolOf(host, 'voice_profile_delete').execute({ id: candId })).ok).toBe(false)
    expect((await toolOf(host, 'voice_profile_rollback').execute({})).ok).toBe(false)

    const del = await toolOf(host, 'voice_profile_delete').execute({ id: candId, confirm: true })
    expect(del.ok).toBe(true)
    const listAfter = await toolOf(host, 'voice_profile_list').execute({})
    expect((listAfter.profiles as unknown[]).length).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it('对抗性：空 demand 拒绝、count 钳制到 maxDesignCandidates、不存在 id 拒绝、builtin 可回退激活、confirm 门禁', async () => {
    const { host, root } = await setupPhase2()

    // 空/空白的音色描述 → 拒绝，不生成候选。
    expect((await toolOf(host, 'voice_profile_design').execute({ demand: '   ' })).ok).toBe(false)

    // count=99 被钳制到 maxDesignCandidates（默认 3），不会生成 99 个。
    const big = await toolOf(host, 'voice_profile_design').execute({ demand: '沉稳女声', count: 99 })
    expect(big.ok).toBe(true)
    expect((big.candidates as unknown[]).length).toBe(3)

    // 试听不存在的音色 → ok:false。
    expect((await toolOf(host, 'voice_profile_preview').execute({ id: 'no-such-id' })).ok).toBe(false)

    // 回退内置：激活一个候选后，可再激活内置兜底作为默认。
    const firstId = (big.candidates as Array<{ id: string }>)[0].id
    expect((await toolOf(host, 'voice_profile_activate').execute({ id: firstId, confirm: true })).ok).toBe(true)
    const revert = await toolOf(host, 'voice_profile_activate').execute({ id: 'builtin-adai-design-1', confirm: true })
    expect(revert.ok).toBe(true)

    // 删除不存在的音色 → ok:false；缺 confirm → 拒绝。
    expect((await toolOf(host, 'voice_profile_delete').execute({ id: 'no-such-id', confirm: true })).ok).toBe(false)
    const preCreated = await toolOf(host, 'voice_profile_design').execute({ demand: '测试', count: 1 })
    const preId = (preCreated.candidates as Array<{ id: string }>)[0].id
    expect((await toolOf(host, 'voice_profile_delete').execute({ id: preId })).ok).toBe(false)

    rmSync(root, { recursive: true, force: true })
  })
})
