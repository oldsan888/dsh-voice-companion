/** HTTP 路由测试：方法/状态/头/限长/错误码/租约门禁/二进制 WAV/disposer。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { invokeRoute, makeFakeHostCtx, makeWav } from './host-test-utils.ts'
import { apply } from '../src/server/index.ts'
import type { MiMoTts } from '../src/server/tts.ts'
import { ROUTES } from '../src/shared/constants.ts'
import { BUILTIN_PROFILE_ID, resolveProfilesRoot } from '../src/server/profiles.ts'

const SECRETS_FILE = join(process.env.DSH_HOME ?? 'E:\\test-dsh-home', 'secrets', 'dsh-voice-companion.env')

/**
 * 复位真实 DSH_HOME 语音身份到 http.test.ts 期望的干净基线
 * （active-profile.json activeId=null + 内置 status=inactive）：
 * `profiles/activate`（回退内置）测试会激活内置并留在磁盘，若不复位，
 * 同文件后续测试与下一次全量运行都会因读到脏状态而失败。
 */
function resetVoiceBaseline(): void {
  try {
    const root = resolveProfilesRoot()
    writeFileSync(join(root, 'active-profile.json'),
      JSON.stringify({ activeId: null, previousId: null, history: [], updatedAt: Date.now() }, null, 2), 'utf8')
    const profilePath = join(root, 'profiles', BUILTIN_PROFILE_ID, 'profile.json')
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>
    profile.status = 'inactive'
    writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')
  } catch {
    // 真实根不可用时保持原状（测试只做尽力复位）。
  }
}

function fakeTts(overrides?: Partial<MiMoTts>): MiMoTts {
  return {
    health: () => ({ status: 'ready', checkedAt: 1 }),
    configured: () => true,
    synthesize: async () => makeWav({ dataBytes: 32 }),
    synthesizeDesign: async () => makeWav({ dataBytes: 32 }),
    synthesizeStream: async function* () { return undefined as never },
    dispose: () => undefined,
    ...overrides,
  }
}

function setup(tts?: MiMoTts) {
  const host = makeFakeHostCtx()
  apply(host.ctx as never, {
    secretsFile: SECRETS_FILE,
    promptEnabled: false,
    // 单测不触发真实 lark-cli/ffmpeg 进程（隔离验证由 lark.test.ts 专项覆盖）。
    larkEnabled: false,
  }, tts === undefined ? {} : { tts })
  const routes = host.routes
  return { host, route: (path: string) => routes.get(path)! }
}

async function becomeLeader(routeGet: (path: string) => import('./host-test-utils.ts').FakeRoute, clientId: string) {
  await invokeRoute(routeGet(ROUTES.lease), { method: 'POST', body: { action: 'acquire', clientId } })
}

describe('state 路由', () => {
  it('GET 返回协议版本与 no-store；错误方法 405 带 Allow', async () => {
    const { route } = setup(fakeTts())
    const ok = await invokeRoute(route(ROUTES.state), { method: 'GET', url: `${ROUTES.state}?clientId=tab-a` })
    expect(ok.status).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(ok.json().protocolVersion).toBe(1)
    expect((ok.json() as { lease: { ownedByThisClient: boolean } }).lease.ownedByThisClient).toBe(false)

    const bad = await invokeRoute(route(ROUTES.state), { method: 'POST' })
    expect(bad.status).toBe(405)
    expect(bad.headers.allow).toBe('GET')
  })

  it('clientId 命中租约时 ownedByThisClient=true', async () => {
    const { route } = setup(fakeTts())
    await becomeLeader(route, 'tab-a')
    const state = await invokeRoute(route(ROUTES.state), { method: 'GET', url: `${ROUTES.state}?clientId=tab-a` })
    expect((state.json() as { lease: { ownedByThisClient: boolean; expiresAt: number } }).lease).toMatchObject({
      ownedByThisClient: true,
      ownedByOther: false,
    })
  })
})

describe('lease 路由', () => {
  it('acquire 成功；他人 acquire → 409 NOT_LEADER；takeover 抢占成功', async () => {
    const { route } = setup(fakeTts())
    const first = await invokeRoute(route(ROUTES.lease), { method: 'POST', body: { action: 'acquire', clientId: 'a' } })
    expect(first.status).toBe(200)
    expect((first.json() as { lease: { youAreOwner: boolean } }).lease.youAreOwner).toBe(true)

    const second = await invokeRoute(route(ROUTES.lease), { method: 'POST', body: { action: 'acquire', clientId: 'b' } })
    expect(second.status).toBe(409)
    expect((second.json().error as { code: string })).toMatchObject({ code: 'NOT_LEADER' })

    const takeover = await invokeRoute(route(ROUTES.lease), { method: 'POST', body: { action: 'takeover', clientId: 'b' } })
    expect(takeover.status).toBe(200)
    expect((takeover.json() as { lease: { ownerClientId: string } }).lease.ownerClientId).toBe('b')
  })

  it('release 幂等；坏请求体 400；错误 content-type 415', async () => {
    const { route } = setup(fakeTts())
    const release = await invokeRoute(route(ROUTES.lease), { method: 'POST', body: { action: 'release', clientId: 'ghost' } })
    expect(release.status).toBe(200)

    const bad = await invokeRoute(route(ROUTES.lease), { method: 'POST', rawBody: Buffer.from('{nope') , headers: { 'content-type': 'application/json' } })
    expect(bad.status).toBe(400)
    expect((bad.json().error as { code: string }).code).toBe('INVALID_JSON')

    const wrongType = await invokeRoute(route(ROUTES.lease), { method: 'POST', rawBody: Buffer.from('x'), headers: { 'content-type': 'text/plain' } })
    expect(wrongType.status).toBe(415)
    expect((wrongType.json().error as { code: string }).code).toBe('BAD_CONTENT_TYPE')

    const missing = await invokeRoute(route(ROUTES.lease), { method: 'POST', body: { action: 'acquire' } })
    expect(missing.status).toBe(400)
  })
})

describe('drain 路由（leader-only）', () => {
  it('非 leader → 409；leader 收到按优先级排序的批次且事件被消费', async () => {
    const { host, route } = setup(fakeTts())
    // 直接向内部队列注入事件：经 session/event 监听器驱动。
    const sessionListener = host.listeners.find(item => item.name === 'session/event')!
    sessionListener.listener({ id: 's1' } as never, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '@voice 完成了' }] } } } as never)
    sessionListener.listener({ id: 's1' } as never, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as never)

    const denied = await invokeRoute(route(ROUTES.drain), { method: 'GET', url: `${ROUTES.drain}?clientId=stranger` })
    expect(denied.status).toBe(409)

    await becomeLeader(route, 'tab-a')
    const batch1 = await invokeRoute(route(ROUTES.drain), { method: 'GET', url: `${ROUTES.drain}?clientId=tab-a` })
    expect(batch1.status).toBe(200)
    const events = (batch1.json() as { events: Array<{ kind: string; text: string }> }).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'done', text: '完成了' })

    const batch2 = await invokeRoute(route(ROUTES.drain), { method: 'GET', url: `${ROUTES.drain}?clientId=tab-a` })
    expect((batch2.json() as { events: unknown[] }).events).toEqual([])
  })
})

describe('tts / test 路由', () => {
  it('返回 audio/wav 二进制（不 Base64 化）', async () => {
    const wav = makeWav({ dataBytes: 64 })
    const { route } = setup(fakeTts({ synthesize: async () => wav }))
    await becomeLeader(route, 'tab-a')
    const result = await invokeRoute(route(ROUTES.tts), { method: 'POST', body: { text: '你好', clientId: 'tab-a' } })
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('audio/wav')
    expect(result.body.equals(wav)).toBe(true)
    expect(result.text.startsWith('RIFF')).toBe(true)
  })

  it('非 leader 调用 /tts、/test、/queue/clear 均 409', async () => {
    const { route } = setup(fakeTts())
    for (const [path, body] of [
      [ROUTES.tts, { text: 'x', clientId: 'nope' }],
      [ROUTES.test, { clientId: 'nope' }],
      [ROUTES.queueClear, { clientId: 'nope' }],
    ] as const) {
      const result = await invokeRoute(route(path), { method: 'POST', body })
      expect(result.status).toBe(409)
      expect((result.json().error as { code: string }).code).toBe('NOT_LEADER')
    }
  })

  it('TTS 错误映射稳定错误码与脱敏消息', async () => {
    const failing = fakeTts({ synthesize: async () => { throw Object.assign(new Error('MiMo 请求失败（HTTP 429）'), { code: 'TTS_REJECTED' }) } })
    const { route } = setup(failing)
    await becomeLeader(route, 'tab-a')
    const result = await invokeRoute(route(ROUTES.tts), { method: 'POST', body: { text: 'x', clientId: 'tab-a' } })
    expect(result.status).toBe(502)
    expect(result.json().error).toMatchObject({ code: 'TTS_REJECTED', message: 'MiMo 请求失败（HTTP 429）' })
  })

  it('/test 使用固定文本并走同一合成链', async () => {
    let received = ''
    const { route } = setup(fakeTts({ synthesize: async (text) => { received = text; return makeWav({}) } }))
    await becomeLeader(route, 'tab-a')
    const result = await invokeRoute(route(ROUTES.test), { method: 'POST', body: { clientId: 'tab-a' } })
    expect(result.status).toBe(200)
    expect(received.length).toBeGreaterThan(0)
  })
})

describe('tts/stream 真流式路由（Phase 3 §5.2）', () => {
  it('非 leader → 409；流式响应为 NDJSON，含 meta/audio/end 行', async () => {
    const chunkWav = makeWav({ dataBytes: 48 })
    const streamed: Buffer[] = []
    const { route } = setup(fakeTts({
      synthesizeStream: async function* () { streamed.push(chunkWav); yield { wav: chunkWav, sampleCount: 24 } },
    }))
    const anon = await invokeRoute(route(ROUTES.ttsStream), { method: 'POST', body: { text: 'x', clientId: 'nope' } })
    expect(anon.status).toBe(409)

    await becomeLeader(route, 'tab-a')
    const result = await invokeRoute(route(ROUTES.ttsStream), { method: 'POST', body: { text: '你好世界', clientId: 'tab-a' } })
    expect(result.status).toBe(200)
    expect(String(result.headers['content-type'])).toContain('application/x-ndjson')
    const lines = result.text.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toMatchObject({ t: 'meta', format: 'pcm16', sampleRate: 24000, channels: 1 })
    const audio = JSON.parse(lines[1]) as { t: string; s: number; wav: string }
    expect(audio.t).toBe('audio')
    expect(Buffer.from(audio.wav, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(JSON.parse(lines[2])).toMatchObject({ t: 'end', chunks: 1 })
    expect(streamed).toHaveLength(1)
  })

  it('流式合成失败时写 error 行并结束（不崩溃）', async () => {
    const { route } = setup(fakeTts({
      synthesizeStream: async function* () { throw Object.assign(new Error('MiMo 流式请求失败（HTTP 429）'), { code: 'TTS_REJECTED' }) },
    }))
    await becomeLeader(route, 'tab-a')
    const result = await invokeRoute(route(ROUTES.ttsStream), { method: 'POST', body: { text: 'x', clientId: 'tab-a' } })
    expect(result.status).toBe(200)
    const lines = result.text.trim().split('\n')
    const error = JSON.parse(lines[1]) as { t: string; code: string }
    expect(error.t).toBe('error')
    expect(error.code).toBe('TTS_REJECTED')
  })

  it('错误方法 405 / 缺 text 400', async () => {
    const { route } = setup(fakeTts())
    const bad = await invokeRoute(route(ROUTES.ttsStream), { method: 'GET' })
    expect(bad.status).toBe(405)
    await becomeLeader(route, 'tab-a')
    const empty = await invokeRoute(route(ROUTES.ttsStream), { method: 'POST', body: { clientId: 'tab-a' } })
    expect(empty.status).toBe(400)
  })
})

describe('queue/clear 路由', () => {
  it('leader 清空待播并返回数量（done + ask 两通道）', async () => {
    const { host, route } = setup(fakeTts())
    const sessionListener = host.listeners.find(item => item.name === 'session/event')!
    sessionListener.listener({ id: 's1' } as never, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '@voice 第1轮' }] } } } as never)
    sessionListener.listener({ id: 's1' } as never, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as never)
    const toolListener = host.listeners.find(item => item.name === 'tools/execute')!
    await (toolListener.listener as (exec: unknown, next: () => Promise<string>) => Promise<string>)(
      { name: 'ask_user_question', callId: 'call-9', arguments: { questions: [{ id: 'q', question: '继续吗？' }] } },
      async () => 'ok',
    )
    await becomeLeader(route, 'tab-a')
    const cleared = await invokeRoute(route(ROUTES.queueClear), { method: 'POST', body: { clientId: 'tab-a' } })
    expect(cleared.status).toBe(200)
    expect(cleared.json()).toMatchObject({ protocolVersion: 1, cleared: 2 })
  })

  it('相同 sourceKey 的重复完成事件被去重（不重复入队）', async () => {
    const { host, route } = setup(fakeTts())
    const listener = host.listeners.find(item => item.name === 'session/event')!
    for (let replay = 0; replay < 2; replay += 1) {
      listener.listener({ id: 's1' } as never, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '@voice 第1轮' }] } } } as never)
      listener.listener({ id: 's1' } as never, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as never)
    }
    await becomeLeader(route, 'tab-a')
    const batch = await invokeRoute(route(ROUTES.drain), { method: 'GET', url: `${ROUTES.drain}?clientId=tab-a` })
    const events = (batch.json() as { events: unknown[] }).events
    expect(events).toHaveLength(1)
  })
})

describe('配置问题与卸载', () => {
  it('无效配置：路由仍注册，/state 显示 TTS error 与原因；DSH 不崩', async () => {
    const host = makeFakeHostCtx()
    apply(host.ctx as never, {
      provider: 'unknown-provider',
      speed: -5,
      askMaxChars: 999,
      secretsFile: 'C:\\elsewhere\\secret.env',
      promptEnabled: false,
      larkEnabled: false,
    })
    const state = await invokeRoute(host.routes.get(ROUTES.state)!, { method: 'GET' })
    const payload = state.json() as { tts: { status: string; detail: string } }
    expect(payload.tts.status).toBe('error')
    expect(payload.tts.detail).toContain('provider')
    expect(payload.tts.detail).toContain('secretsFile')
    const lease = await invokeRoute(host.routes.get(ROUTES.lease)!, { method: 'POST', body: { action: 'acquire', clientId: 'tester' } })
    expect(lease.status).toBe(200)
    const test = await invokeRoute(host.routes.get(ROUTES.test)!, { method: 'POST', body: { clientId: 'tester' } })
    expect(test.status).toBe(503)
    expect((test.json() as { error: { code: string } }).error.code).toBe('TTS_UNAVAILABLE')
  })

  it('越出 dsh-home 的 secretsFile 被拒绝', () => {
    const host = makeFakeHostCtx()
    apply(host.ctx as never, {
      secretsFile: 'D:\\evil\\voice.env',
      promptEnabled: false,
      larkEnabled: false,
    })
    expect(host.routes.has(ROUTES.state)).toBe(true)
  })

  it('disposer 移除全部路由', async () => {
    const { host } = setup(fakeTts())
    // state/lease/drain/tts/ttsStream/test/queueClear + profiles/profileReference/profilesActivate/profilesRollback。
    expect(host.routes.size).toBe(11)
    const effect = host.effects.find(item => item.label === 'dsh-voice-companion: routes + provider cleanup')!
    effect.dispose()
    expect(effect.disposed).toBe(true)
    expect(host.routes.size).toBe(0)
  })
})

describe('profiles 路由', () => {
  it('GET /profiles 返回协议版本、内置只读兜底与激活状态', async () => {
    const { route } = setup(fakeTts())
    const ok = await invokeRoute(route(ROUTES.profiles), { method: 'GET' })
    expect(ok.status).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    const body = ok.json() as {
      protocolVersion: number
      profiles: Array<{ id: string; readOnly: boolean; active: boolean }>
      active: { activeId: string | null }
    }
    expect(body.protocolVersion).toBe(1)
    const builtin = body.profiles.find(p => p.id === BUILTIN_PROFILE_ID)
    expect(builtin).toBeDefined()
    expect(builtin!.readOnly).toBe(true)
    expect(builtin!.active).toBe(false)
    expect(body.active.activeId).toBeNull()

    const bad = await invokeRoute(route(ROUTES.profiles), { method: 'POST' })
    expect(bad.status).toBe(405)
    expect(bad.headers.allow).toBe('GET')
  })

  it('profiles/activate 需要租约；非 leader → 409', async () => {
    const { route } = setup(fakeTts())
    const anon = await invokeRoute(route(ROUTES.profilesActivate), { method: 'POST', body: { clientId: 'tab-a', id: BUILTIN_PROFILE_ID } })
    expect(anon.status).toBe(409)

    await becomeLeader(route, 'tab-a')
    // 内置兜底可作为默认音色被选回（回退内置）→ 200。
    const res = await invokeRoute(route(ROUTES.profilesActivate), { method: 'POST', body: { clientId: 'tab-a', id: BUILTIN_PROFILE_ID } })
    expect(res.status).toBe(200)
    // 复位干净基线（activeId=null + 内置 inactive），避免污染后续测试与下次运行。
    resetVoiceBaseline()
  })

  it('profiles/activate：越界 id → 400 INVALID_ID（路径穿越被安全ProfileId拦截）', async () => {
    const { route } = setup(fakeTts())
    await becomeLeader(route, 'tab-a')
    // 含分隔符/点号/空串的非法 id：空串命中 INVALID_REQUEST，其余命中 INVALID_ID。
    for (const badId of ['../evil', 'a/b', 'a\\b', '..', 'a.b']) {
      const res = await invokeRoute(route(ROUTES.profilesActivate), { method: 'POST', body: { clientId: 'tab-a', id: badId } })
      expect(res.status).toBe(400)
      expect((res.json() as { errorCode: string }).errorCode).toBe('INVALID_ID')
    }
    const empty = await invokeRoute(route(ROUTES.profilesActivate), { method: 'POST', body: { clientId: 'tab-a', id: '' } })
    expect(empty.status).toBe(400)
    expect((empty.json().error as { code: string }).code).toBe('INVALID_REQUEST')
  })

  it('profiles/activate：不存在的合法 id → 400 NOT_FOUND；缺 id/clientId → 400 INVALID_REQUEST', async () => {
    const { route } = setup(fakeTts())
    await becomeLeader(route, 'tab-a')
    const notFound = await invokeRoute(route(ROUTES.profilesActivate), { method: 'POST', body: { clientId: 'tab-a', id: 'nope-profile' } })
    expect(notFound.status).toBe(400)
    expect((notFound.json() as { errorCode: string }).errorCode).toBe('NOT_FOUND')

    const missing = await invokeRoute(route(ROUTES.profilesActivate), { method: 'POST', body: { clientId: 'tab-a' } })
    expect(missing.status).toBe(400)
    expect((missing.json().error as { code: string }).code).toBe('INVALID_REQUEST')
  })

  it('profiles/reference：需要租约；带租约返回内置参考音频 WAV；非法 id → 400', async () => {
    const { route } = setup(fakeTts())
    const anon = await invokeRoute(route(ROUTES.profileReference), { method: 'GET', url: `${ROUTES.profileReference}?id=${BUILTIN_PROFILE_ID}&clientId=tab-a` })
    expect(anon.status).toBe(409)
    expect((anon.json().error as { code: string }).code).toBe('NOT_LEADER')

    await becomeLeader(route, 'tab-a')
    const wav = await invokeRoute(route(ROUTES.profileReference), { method: 'GET', url: `${ROUTES.profileReference}?id=${BUILTIN_PROFILE_ID}&clientId=tab-a` })
    expect(wav.status).toBe(200)
    expect(wav.headers['content-type']).toBe('audio/wav')
    expect(wav.body.subarray(0, 4).toString('ascii')).toBe('RIFF')

    for (const badId of ['../evil', 'a/b', '..', '']) {
      const res = await invokeRoute(route(ROUTES.profileReference), { method: 'GET', url: `${ROUTES.profileReference}?id=${encodeURIComponent(badId)}&clientId=tab-a` })
      expect(res.status).toBe(400)
    }

    // 错误方法 → 405
    const badMethod = await invokeRoute(route(ROUTES.profileReference), { method: 'POST' })
    expect(badMethod.status).toBe(405)
  })

  it('profiles/rollback：非 leader → 409；leader 无上一版本 → 400 NO_PREVIOUS', async () => {
    const { route } = setup(fakeTts())
    const anon = await invokeRoute(route(ROUTES.profilesRollback), { method: 'POST', body: { clientId: 'tab-a' } })
    expect(anon.status).toBe(409)

    await becomeLeader(route, 'tab-a')
    const noPrev = await invokeRoute(route(ROUTES.profilesRollback), { method: 'POST', body: { clientId: 'tab-a' } })
    expect(noPrev.status).toBe(400)
    expect((noPrev.json() as { errorCode: string }).errorCode).toBe('NO_PREVIOUS')

    const badMethod = await invokeRoute(route(ROUTES.profilesRollback), { method: 'GET' })
    expect(badMethod.status).toBe(405)
  })

  it('profiles/rollback：坏 JSON 请求体 → 400 INVALID_JSON', async () => {
    const { route } = setup(fakeTts())
    await becomeLeader(route, 'tab-a')
    const res = await invokeRoute(route(ROUTES.profilesRollback), { method: 'POST', rawBody: Buffer.from('{nope'), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
    expect((res.json().error as { code: string }).code).toBe('INVALID_JSON')
  })
})

describe('净化应用于入队播报稿（Phase 3 §8.2）', () => {
  it('URL / 凭据被清除后才入队（正文与播报稿分离）', async () => {
    const { host, route } = setup(fakeTts())
    const sessionListener = host.listeners.find(item => item.name === 'session/event')!
    sessionListener.listener({ id: 's1' } as never, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '@voice 看 https://example.com 和 sk-abc123def456 就懂了' }] } },
    } as never)
    sessionListener.listener({ id: 's1' } as never, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as never)
    await becomeLeader(route, 'tab-a')
    const batch = await invokeRoute(route(ROUTES.drain), { method: 'GET', url: `${ROUTES.drain}?clientId=tab-a` })
    const events = (batch.json() as { events: Array<{ text: string }> }).events
    expect(events).toHaveLength(1)
    expect(events[0].text).toBe('看 和 就懂了')
  })
})
