/** 内置 MiMo Provider 测试：WAV 校验、payload、Base64 提取、secrets 优先级、超时/失败/恢复、并发=1。 */
import { describe, expect, it } from 'vitest'
import { FakeClock, makeWav } from './host-test-utils.ts'
import {
  buildMimoPayload,
  buildPresetStreamPayload,
  buildSpeechDirectionInstruction,
  buildVoiceDesignPayload,
  createMiMoTts,
  extractBase64Audio,
  extractStreamAudio,
  inspectWav,
  speedInstruction,
  TtsError,
  validateReferenceWav,
  wrapPcm16Wav,
} from '../src/server/tts.ts'
import { isInsideDshHome, normalizeApiBaseUrl, parseSecretsFile, resolveSecrets } from '../src/server/secrets.ts'
import { loadReferenceAudio } from '../src/server/reference.ts'
import { validateVoiceConfig } from '../src/server/config.ts'

const OK_SECRETS = { ok: true as const, apiBaseUrl: 'https://api.example.com/v4', apiKey: 'k-test', origin: 'env' as const }
const OK_REFERENCE: import('../src/server/tts.ts').ReferenceAudio = {
  buffer: makeWav({}),
  bytes: 52,
  dataUrl: 'data:audio/wav;base64,UmVm',
}

function baseConfig() {
  return { model: 'mimo-v2.5-tts-voiceclone', designModel: 'mimo-v2.5-tts-voicedesign', streamModel: 'mimo-v2.5-tts', presetVoiceId: '冰糖', streamChunkMs: 1000, speed: 1, requestTimeoutMs: 200, maxAudioBytes: 1024 * 1024 }
}

function audioResponse(wav: Buffer): Response {
  const body = JSON.stringify({ choices: [{ message: { audio: { data: wav.toString('base64') } } }] })
  return new Response(body, { status: 200 })
}

/** 消费一个 async 迭代器并断言其以匹配错误终止（用于流式生成器）。 */
async function expectForAwaitRejects(gen: AsyncGenerator<unknown>, matcher: { code: string }): Promise<void> {
  const chunks: unknown[] = []
  let error: unknown = undefined
  try {
    for await (const chunk of gen) chunks.push(chunk)
  } catch (caught) {
    error = caught
  }
  expect(chunks).toHaveLength(0)
  expect(error).toMatchObject(matcher)
}

describe('inspectWav / validateReferenceWav', () => {
  it('24k 与 48k PCM16 均通过输出校验', () => {
    expect(inspectWav(makeWav({ sampleRate: 24000 })).ok).toBe(true)
    expect(inspectWav(makeWav({ sampleRate: 48000 })).ok).toBe(true)
  })

  it('非 RIFF / 缺 fmt / 空 data 拒绝', () => {
    expect(inspectWav(makeWav({ riff: 'JUNK' })).ok).toBe(false)
    expect(inspectWav(Buffer.alloc(10)).ok).toBe(false)
    const bad = makeWav({})
    bad.write('daTa', 36, 'ascii')
    bad.writeUInt32LE(0, 40)
    expect(inspectWav(bad).ok).toBe(false)
  })

  it('参考音频额外要求 PCM16；非 PCM 编码拒绝', () => {
    expect(validateReferenceWav(makeWav({})).ok).toBe(true)
    expect(validateReferenceWav(makeWav({ format: 3 })).error).toContain('16-bit PCM')
  })

  it('真实随包参考音频可加载并通过校验', () => {
    const result = loadReferenceAudio(import.meta.url)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.reference.bytes).toBe(606764)
      expect(result.reference.dataUrl.startsWith('data:audio/wav;base64,')).toBe(true)
      expect(result.reference.buffer.length).toBeGreaterThan(600_000)
    }
  })

  it('不存在的位置返回缺失', () => {
    const result = loadReferenceAudio('file:///E:/nonexistent-dir-a/b/c/module.js')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('缺失')
  })
})

describe('buildMimoPayload', () => {
  it('字段与角色正确：model/audio.voice=dataURL/stream=false/messages[assistant]=text', () => {
    const payload = buildMimoPayload({
      model: 'mimo-v2.5-tts-voiceclone',
      speed: 1,
      text: '测试文本',
      referenceDataUrl: 'data:audio/wav;base64,UmVm',
    }) as Record<string, unknown>
    expect(payload.model).toBe('mimo-v2.5-tts-voiceclone')
    const audio = payload.audio as Record<string, unknown>
    expect(audio.format).toBe('wav')
    expect(audio.voice).toBe('data:audio/wav;base64,UmVm')
    expect(payload.stream).toBe(false)
    const messages = payload.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toBe('测试文本')
    expect(messages[0].content).toContain('语速')
  })

  it('speed 分档产生不同指令', () => {
    expect(speedInstruction(1)).not.toBe(speedInstruction(0.5))
    expect(speedInstruction(0)).toBe('')
  })
})

describe('speechDirection → MiMo 导演指令（Phase 3）', () => {
  it('buildMimoPayload 携带 direction：指令并入 messages[0] 且不改变文本/音色字段', () => {
    const payload = buildMimoPayload({
      model: 'mimo-v2.5-tts-voiceclone',
      speed: 1,
      text: '测试文本',
      referenceDataUrl: 'data:audio/wav;base64,UmVm',
      direction: { emotion: 'happy', loudness: 'quiet' },
    }) as Record<string, unknown>
    const audio = payload.audio as Record<string, unknown>
    expect(audio.voice).toBe('data:audio/wav;base64,UmVm')
    expect(payload.stream).toBe(false)
    const messages = payload.messages as Array<{ role: string; content: string }>
    expect(messages[1].content).toBe('测试文本')
    expect(messages[0].content).toContain('开心')
    expect(messages[0].content).toContain('耳语')
  })

  it('direction.speed 存在时覆盖基础语速档，避免相互矛盾', () => {
    const fast = buildMimoPayload({
      model: 'm', speed: 1.2, text: 't', referenceDataUrl: 'r',
      direction: { speed: 'slow' },
    }) as Record<string, unknown>
    const content = (fast.messages as Array<{ content: string }>)[0].content
    expect(content).toContain('慢')
    expect(content).not.toContain('明快')
  })

  it('buildSpeechDirectionInstruction 按字段映射并截断', () => {
    const instruction = buildSpeechDirectionInstruction(
      { emotion: 'angry', speed: 'fastest', role: '四川话', director: '节奏收紧' },
    )
    expect(instruction).toContain('不满')
    expect(instruction).toContain('很快')
    expect(instruction).toContain('四川话')
    expect(instruction).toContain('节奏收紧')
    expect(Array.from(instruction).length).toBeLessThanOrEqual(160)
  })

  it('undefined / 空 direction 返回空指令', () => {
    expect(buildSpeechDirectionInstruction(undefined)).toBe('')
  })
})

describe('extractBase64Audio', () => {
  it('允许字段命中：choices[0].message.audio.data', () => {
    const json = { choices: [{ message: { audio: { data: 'A'.repeat(100) } } }] }
    expect(extractBase64Audio(json)).toBe('A'.repeat(100))
  })

  it('允许字段命中：顶层 audio / output.audio.data / delta', () => {
    expect(extractBase64Audio({ audio: 'B'.repeat(80) })).toBe('B'.repeat(80))
    expect(extractBase64Audio({ output: { audio: { data: 'C'.repeat(90) } } })).toBe('C'.repeat(90))
    expect(extractBase64Audio({ choices: [{ delta: { audio: { data: 'D'.repeat(70) } } }] })).toBe('D'.repeat(70))
  })

  it('短字符串与未知深路径不提取（无递归）', () => {
    expect(extractBase64Audio({ random: { deep: { data: 'E'.repeat(999) } } })).toBeUndefined()
    expect(extractBase64Audio({ audio: 'short' })).toBeUndefined()
  })
})

function fakeFetchWith(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  const calls: Array<{ url: string; headers: Record<string, string>; signal: AbortSignal | null | undefined }> = []
  const fn = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      signal: init.signal,
    })
    return handler(String(url), init)
  }) as typeof fetch & { calls: typeof calls }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

function makeTts(overrides?: {
  fetchImpl?: typeof fetch
  secrets?: typeof OK_SECRETS | { ok: false; reason: string; detail: string }
  /** null 强制"参考音频无效"；未提供则用有效参考。 */
  reference?: typeof OK_REFERENCE | null
  config?: Partial<ReturnType<typeof baseConfig>>
}) {
  const clock = new FakeClock()
  const fetchImpl = overrides?.fetchImpl ?? fakeFetchWith(async () => audioResponse(makeWav({ dataBytes: 64 })))
  const hasReferenceOverride = overrides !== undefined && 'reference' in overrides
  const tts = createMiMoTts({ ...baseConfig(), ...overrides?.config }, {
    secrets: overrides?.secrets as never ?? OK_SECRETS,
    reference: hasReferenceOverride
      ? (overrides.reference === null ? undefined : overrides.reference!)
      : OK_REFERENCE,
    fetchImpl,
    clock: clock.now,
  })
  return { tts, fetchImpl, clock }
}

describe('createMiMoTts', () => {
  it('成功合成：请求直连云端端点，返回 WAV Buffer，状态 ready', async () => {
    const wav = makeWav({ dataBytes: 128 })
    const { tts, fetchImpl } = makeTts({ fetchImpl: fakeFetchWith(async () => audioResponse(wav)) })
    const audio = await tts.synthesize('你好')
    expect(audio.equals(wav)).toBe(true)
    const call = (fetchImpl as typeof fetch & { calls: Array<{ url: string; headers: Record<string, string> }> }).calls[0]
    expect(call.url).toBe('https://api.example.com/v4/chat/completions')
    expect(call.headers['api-key']).toBe('k-test')
    expect(call.headers['content-type']).toBe('application/json')
    expect(tts.health().status).toBe('ready')
    expect(tts.health().notYetTested).toBeUndefined()
  })

  it('初始 ready 且未实测时 notYetTested=true', () => {
    const { tts } = makeTts()
    expect(tts.health()).toMatchObject({ status: 'ready', notYetTested: true })
  })

  it('非 2xx → TTS_REJECTED 脱敏错误；上游 body 不进入 message', async () => {
    const { tts } = makeTts({
      fetchImpl: fakeFetchWith(async () => new Response(JSON.stringify({ error: 'SECRET-DETAIL' }), { status: 503 })),
    })
    await expect(tts.synthesize('x')).rejects.toMatchObject({ code: 'TTS_REJECTED' })
    try {
      await tts.synthesize('x')
    } catch (error) {
      expect((error as TtsError).message).not.toContain('SECRET-DETAIL')
      expect((error as TtsError).message).toContain('HTTP 503')
    }
    expect(tts.health().status).toBe('error')
  })

  it('网络异常 → TTS_UNAVAILABLE', async () => {
    const { tts } = makeTts({ fetchImpl: fakeFetchWith(async () => { throw new Error('ECONNREFUSED x') }) })
    await expect(tts.synthesize('x')).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE' })
  })

  it('超时 → TTS_TIMEOUT 并 abort 上游', async () => {
    let abortedSeen = false
    const { tts } = makeTts({
      config: { requestTimeoutMs: 30 },
      fetchImpl: fakeFetchWith((_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          abortedSeen = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      })),
    })
    await expect(tts.synthesize('x')).rejects.toMatchObject({ code: 'TTS_TIMEOUT' })
    expect(abortedSeen).toBe(true)
  })

  it('下游中止 → 不再返回音频（TTS_UNAVAILABLE）', async () => {
    const { tts } = makeTts()
    const controller = new AbortController()
    controller.abort(new Error('downstream'))
    await expect(tts.synthesize('x', controller.signal)).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE' })
  })

  it('请求进行中被下游中止：fetch 抛出 reason 也不污染 TTS 健康状态', async () => {
    let notifyStarted!: () => void
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const { tts } = makeTts({
      fetchImpl: fakeFetchWith((_url, init) => new Promise<Response>((_resolve, reject) => {
        notifyStarted()
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })),
    })
    const controller = new AbortController()
    const pending = tts.synthesize('x', controller.signal)
    await started
    controller.abort(new Error('downstream'))
    await expect(pending).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE', message: '请求已中止' })
    expect(tts.health().status).toBe('ready')
    expect(tts.health().detail).toBeUndefined()
  })

  it('超限音频 → AUDIO_TOO_LARGE；非 WAV → INVALID_AUDIO', async () => {
    const big = makeTts({
      config: { maxAudioBytes: 100 },
      fetchImpl: fakeFetchWith(async () => audioResponse(makeWav({ dataBytes: 512 }))),
    })
    await expect(big.tts.synthesize('x')).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' })
    expect(big.tts.health().status).toBe('error')

    const junk = makeTts({
      // 足够长（Base64 > 64 字符）但不是 WAV。
      fetchImpl: fakeFetchWith(async () => audioResponse(Buffer.from('J'.repeat(200)))),
    })
    await expect(junk.tts.synthesize('x')).rejects.toMatchObject({ code: 'INVALID_AUDIO' })
    expect(junk.tts.health().status).toBe('error')
  })

  it('响应体超限 → AUDIO_TOO_LARGE（不只信 Content-Length）', async () => {
    const hugeJson = JSON.stringify({ choices: [{ message: { audio: { data: 'Z'.repeat(300) } } }] })
    const ttsStrict = createMiMoTts({ ...baseConfig(), maxAudioBytes: 1024 * 1024, maxResponseBytes: 100 }, {
      secrets: OK_SECRETS,
      reference: OK_REFERENCE,
      fetchImpl: fakeFetchWith(async () => new Response(hugeJson, { status: 200 })),
    })
    await expect(ttsStrict.synthesize('x')).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' })
  })

  it('失败后重试成功恢复 ready', async () => {
    let fail = true
    const { tts } = makeTts({
      fetchImpl: fakeFetchWith(async () => {
        if (fail) return new Response('{}', { status: 500 })
        return audioResponse(makeWav({}))
      }),
    })
    await expect(tts.synthesize('x')).rejects.toBeTruthy()
    expect(tts.health().status).toBe('error')
    fail = false
    await tts.synthesize('y')
    expect(tts.health().status).toBe('ready')
  })

  it('并发数 1：两个合成串行执行', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { tts } = makeTts({
      fetchImpl: fakeFetchWith(async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 10))
        inFlight--
        return audioResponse(makeWav({}))
      }),
    })
    await Promise.all([tts.synthesize('a'), tts.synthesize('b')])
    expect(maxInFlight).toBe(1)
  })

  it('dispose 中止正在执行的上游请求', async () => {
    let aborted = false
    const { tts } = makeTts({
      fetchImpl: fakeFetchWith((_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      })),
    })
    const pending = tts.synthesize('x')
    await new Promise(resolve => setTimeout(resolve, 0))
    tts.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE' })
    expect(aborted).toBe(true)
  })

  it('凭据缺失 → unconfigured；参考音频无效 → error', async () => {
    const missing = makeTts({ secrets: { ok: false, reason: 'missing-keys', detail: '缺' } })
    expect(missing.tts.configured()).toBe(false)
    expect(missing.tts.health()).toMatchObject({ status: 'unconfigured' })
    await expect(missing.tts.synthesize('x')).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE' })

    const badRef = makeTts({ reference: null })
    expect(badRef.tts.health()).toMatchObject({ status: 'error' })
  })
})

describe('voicedesign payload 与 synthesis', () => {
  it('buildVoiceDesignPayload：不带 audio.voice；messages[0]=prompt, messages[1]=text, stream=false', () => {
    const payload = buildVoiceDesignPayload({
      model: 'mimo-v2.5-tts-voicedesign',
      prompt: '成熟一点的女声，温柔但不甜腻',
      text: '试听文本',
    }) as Record<string, unknown>
    expect(payload.model).toBe('mimo-v2.5-tts-voicedesign')
    const audio = payload.audio as Record<string, unknown>
    expect(audio.format).toBe('wav')
    expect('voice' in audio).toBe(false)
    expect(payload.stream).toBe(false)
    const messages = payload.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toBe('成熟一点的女声，温柔但不甜腻')
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toBe('试听文本')
  })

  it('synthesizeDesign：无需参考音频，按设计模型构造请求体并返回 WAV', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = fakeFetchWith(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return audioResponse(makeWav({ dataBytes: 64 }))
    })
    const tts = createMiMoTts(baseConfig(), { secrets: OK_SECRETS, fetchImpl })
    const audio = await tts.synthesizeDesign('温柔女声', '你好呀')
    expect(audio.length).toBeGreaterThan(0)
    expect(bodies[0].model).toBe('mimo-v2.5-tts-voicedesign')
    const audioField = bodies[0].audio as Record<string, unknown>
    expect('voice' in audioField).toBe(false)
    expect((bodies[0].messages as Array<{ role: string; content: string }>)[0].content).toBe('温柔女声')
    expect(tts.health().status).toBe('ready')
  })

  it('synthesizeDesign 凭据缺失 → TTS_UNAVAILABLE', async () => {
    const tts = createMiMoTts(baseConfig(), {
      secrets: { ok: false as const, reason: 'missing-keys', detail: '缺' },
      reference: OK_REFERENCE,
      fetchImpl: fakeFetchWith(async () => audioResponse(makeWav({}))),
    })
    await expect(tts.synthesizeDesign('x', 'y')).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE' })
  })

  it('synthesizeDesign 与 synthesize 共用串行链（并发数 1）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchImpl = fakeFetchWith(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight--
      return audioResponse(makeWav({}))
    })
    const tts = createMiMoTts(baseConfig(), { secrets: OK_SECRETS, reference: OK_REFERENCE, fetchImpl })
    await Promise.all([tts.synthesize('a'), tts.synthesizeDesign('b', 'c')])
    expect(maxInFlight).toBe(1)
  })
})

describe('Host 配置', () => {
  it('保留小数 speed，不截断为零或整数', () => {
    const result = validateVoiceConfig({ speed: 0.75 }, { DSH_HOME: 'E:\\dsh-home' })
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.speed).toBe(0.75)
  })

  it('profile 只覆写 secretsFile 时，飞书投递仍默认关闭', () => {
    const result = validateVoiceConfig({ secretsFile: 'E:\\dsh-home\\secrets\\voice.env' }, { DSH_HOME: 'E:\\dsh-home' })
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.larkEnabled).toBe(false)
  })
})

describe('secrets 解析', () => {
  it('.env 形态解析：注释/export 前缀/引号/无关键忽略', () => {
    const parsed = parseSecretsFile([
      '# comment',
      'export DSH_VOICE_MIMO_API_BASE_URL="https://x.example/v4"',
      "DSH_VOICE_MIMO_API_KEY='abc'",
      'OTHER_KEY=ignored',
      'broken line',
    ].join('\n'))
    expect(parsed.DSH_VOICE_MIMO_API_BASE_URL).toBe('https://x.example/v4')
    expect(parsed.DSH_VOICE_MIMO_API_KEY).toBe('abc')
    expect(Object.keys(parsed)).toHaveLength(2)
  })

  it('环境变量优先于文件', () => {
    const result = resolveSecrets({
      env: { DSH_VOICE_MIMO_API_BASE_URL: 'https://env.example', DSH_VOICE_MIMO_API_KEY: 'envkey' },
      fileContent: 'DSH_VOICE_MIMO_API_BASE_URL=https://file.example\nDSH_VOICE_MIMO_API_KEY=filekey',
    })
    expect(result.ok && result.origin).toBe('env')
    expect(result.ok && result.apiBaseUrl).toBe('https://env.example')
  })

  it('文件补环境变量缺口 → mixed', () => {
    const result = resolveSecrets({
      env: { DSH_VOICE_MIMO_API_KEY: 'envkey' },
      fileContent: 'DSH_VOICE_MIMO_API_BASE_URL=https://file.example',
    })
    expect(result.ok && result.origin).toBe('mixed')
    expect(result.ok && result.apiBaseUrl).toBe('https://file.example')
  })

  it('两处都缺 → missing-keys（脱敏）', () => {
    const result = resolveSecrets({ env: {}, fileContent: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing-keys')
  })

  it('坏协议 Base URL 拒绝；query 拒绝；归一去尾斜杠', () => {
    expect(normalizeApiBaseUrl('ftp://x').ok).toBe(false)
    expect(normalizeApiBaseUrl('https://x/y?z=1').ok).toBe(false)
    const ok = normalizeApiBaseUrl('https://x.example/v4/')
    expect(ok.ok && ok.url).toBe('https://x.example/v4')
    expect(resolveSecrets({ env: { DSH_VOICE_MIMO_API_BASE_URL: 'notaurl', DSH_VOICE_MIMO_API_KEY: 'k' } }).ok).toBe(false)
  })

  it('secretsFile 必须位于 dsh-home 内', () => {
    const env = { DSH_HOME: 'E:\\home\\dsh-home' }
    expect(isInsideDshHome('E:\\home\\dsh-home\\secrets\\a.env', env)).toBe(true)
    expect(isInsideDshHome('E:\\other\\a.env', env)).toBe(false)
    expect(isInsideDshHome('E:\\home\\dsh-home-evil\\a.env', env)).toBe(false)
  })
})

describe('createMiMoTts 动态参考音频', () => {
  it('synthesize 在调用时用 resolveReference() 返回的参考；切换即时生效', async () => {
    const refA: import('../src/server/tts.ts').ReferenceAudio = { buffer: makeWav({}), bytes: 100, dataUrl: 'data:audio/wav;base64,QUFB' }
    const refB: import('../src/server/tts.ts').ReferenceAudio = { buffer: makeWav({}), bytes: 200, dataUrl: 'data:audio/wav;base64,QkJC' }
    let current = refA
    const voices: string[] = []
    const fetchImpl = fakeFetchWith(async (url, init) => {
      voices.push(JSON.parse(String(init.body)).audio.voice)
      return audioResponse(makeWav({ dataBytes: 64 }))
    })
    const tts = createMiMoTts(baseConfig(), { secrets: OK_SECRETS, resolveReference: () => current, fetchImpl })

    expect(tts.configured()).toBe(true)
    await tts.synthesize('第一句')
    expect(voices[0]).toBe('data:audio/wav;base64,QUFB')

    current = refB // 模拟切换到另一 Profile 音色
    await tts.synthesize('第二句')
    expect(voices[1]).toBe('data:audio/wav;base64,QkJC')
    expect(tts.health().status).toBe('ready')
  })

  it('resolveReference 返回 undefined 视为未配置；configured()=false', () => {
    const tts = createMiMoTts(baseConfig(), {
      secrets: OK_SECRETS,
      resolveReference: () => undefined,
      fetchImpl: fakeFetchWith(async () => audioResponse(makeWav({}))),
    })
    expect(tts.configured()).toBe(false)
  })

  it('初始健康：仅 resolveReference 且当前能解析出参考 → ready（不误报 error）', () => {
    const tts = createMiMoTts(baseConfig(), {
      secrets: OK_SECRETS,
      resolveReference: () => OK_REFERENCE,
      fetchImpl: fakeFetchWith(async () => audioResponse(makeWav({}))),
    })
    expect(tts.health()).toMatchObject({ status: 'ready' })
    expect(tts.configured()).toBe(true)
  })

  it('初始健康：resolveReference 返回 undefined → error（参考音频未通过验证）', () => {
    const tts = createMiMoTts(baseConfig(), {
      secrets: OK_SECRETS,
      resolveReference: () => undefined,
      fetchImpl: fakeFetchWith(async () => audioResponse(makeWav({}))),
    })
    expect(tts.health()).toMatchObject({ status: 'error', detail: '参考音频未通过验证' })
    expect(tts.configured()).toBe(false)
  })
})

describe('预置音色真流式（Phase 3 §5.2）', () => {
  it('buildPresetStreamPayload：pcm16 + stream=true + voice=预置 id；不含参考音频', () => {
    const payload = buildPresetStreamPayload({
      model: 'mimo-v2.5-tts',
      voiceId: '冰糖',
      speed: 1,
      text: '你好',
    }) as Record<string, unknown>
    expect(payload.model).toBe('mimo-v2.5-tts')
    expect(payload.stream).toBe(true)
    const audio = payload.audio as Record<string, unknown>
    expect(audio.format).toBe('pcm16')
    expect(audio.voice).toBe('冰糖')
    const messages = payload.messages as Array<{ role: string; content: string }>
    expect(messages[1].content).toBe('你好')
  })

  it('buildPresetStreamPayload：direction 合并进风格指令且 speed 覆盖基础档', () => {
    const payload = buildPresetStreamPayload({
      model: 'm', voiceId: '苏打', speed: 1.3, text: 't',
      direction: { emotion: 'excited', speed: 'slow' },
    }) as Record<string, unknown>
    const content = (payload.messages as Array<{ content: string }>)[0].content
    expect(content).toContain('兴奋')
    expect(content).toContain('稍慢')
    // 基础 1.3 档的"语速稍快，节奏明快但仍然清楚"被 direction.speed 覆盖，不应出现。
    expect(content).not.toContain('语速稍快，节奏明快但仍然清楚')
  })

  it('extractStreamAudio：delta / message / 顶层 audio 候选', () => {
    expect(extractStreamAudio({ choices: [{ delta: { audio: { data: 'A'.repeat(40) } } }] })).toBe('A'.repeat(40))
    expect(extractStreamAudio({ choices: [{ message: { audio: { data: 'B'.repeat(40) } } }] })).toBe('B'.repeat(40))
    expect(extractStreamAudio({ audio: 'C'.repeat(40) })).toBe('C'.repeat(40))
    expect(extractStreamAudio({ choices: [{ delta: { content: 'text' } }] })).toBeUndefined()
    expect(extractStreamAudio({})).toBeUndefined()
  })

  it('wrapPcm16Wav：合法 RIFF / PCM16 / 24k / 单声道 / data 长度正确', () => {
    const pcm = Buffer.alloc(4800, 1)
    const wav = wrapPcm16Wav(pcm)
    expect(wav.length).toBe(44 + 4800)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(4800)
    expect(inspectWav(wav).ok).toBe(true)
  })

  it('synthesizeStream：SSE 增量累积 → 满段吐出，不足段累积到下一 delta', async () => {
    // 每段 100ms → 4800 字节采样满段。3600 + 2400 = 6000 → 正好一段（6000）且无尾。
    const pcmA = Buffer.alloc(3600, 7)
    const pcmB = Buffer.alloc(2400, 9)
    const sseLines = [
      'data: {"choices":[{"delta":{"audio":{"data":"' + pcmA.toString('base64') + '"}}}]}\n',
      'data: {"choices":[{"delta":{"audio":{"data":"' + pcmB.toString('base64') + '"}}}]}\n',
      'data: [DONE]\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of sseLines) controller.enqueue(new TextEncoder().encode(line))
        controller.close()
      },
    })
    const tts = createMiMoTts({ ...baseConfig(), streamChunkMs: 100 }, {
      secrets: OK_SECRETS,
      reference: OK_REFERENCE,
      fetchImpl: async () => new Response(stream, { status: 200 }),
    })
    const chunks: Array<{ wav: Buffer; sampleCount: number }> = []
    for await (const chunk of tts.synthesizeStream('你好世界')) {
      chunks.push({ wav: chunk.wav, sampleCount: chunk.sampleCount })
    }
    expect(chunks).toHaveLength(1)
    expect(chunks[0].wav.length).toBe(44 + 6000)
    expect(chunks[0].sampleCount).toBe(3000)
    expect(tts.health().status).toBe('ready')
  })

  it('synthesizeStream：不足一小段的数据在流末作为尾部段吐出（不吞尾音）', async () => {
    const pcm = Buffer.alloc(3000, 5)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"audio":{"data":"${pcm.toString('base64')}"}}}]}\n`))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'))
        controller.close()
      },
    })
    const tts = createMiMoTts({ ...baseConfig(), streamChunkMs: 100 }, {
      secrets: OK_SECRETS,
      reference: OK_REFERENCE,
      fetchImpl: async () => new Response(stream, { status: 200 }),
    })
    const wavs: Buffer[] = []
    for await (const chunk of tts.synthesizeStream('短句')) wavs.push(chunk.wav)
    expect(wavs).toHaveLength(1)
    expect(wavs[0].length).toBe(44 + 3000)
  })

  it('synthesizeStream：无音频数据 → TTS_REJECTED；预中止 → TTS_UNAVAILABLE', async () => {
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'))
        controller.close()
      },
    })
    const tts = createMiMoTts(baseConfig(), {
      secrets: OK_SECRETS,
      reference: OK_REFERENCE,
      fetchImpl: async () => new Response(emptyStream, { status: 200 }),
    })
    await expectForAwaitRejects(tts.synthesizeStream('x'), { code: 'TTS_REJECTED' })

    const ttsAbort = createMiMoTts(baseConfig(), {
      secrets: OK_SECRETS,
      reference: OK_REFERENCE,
      fetchImpl: async () => new Response(emptyStream, { status: 200 }),
    })
    const controller = new AbortController()
    controller.abort()
    await expectForAwaitRejects(ttsAbort.synthesizeStream('x', controller.signal), { code: 'TTS_UNAVAILABLE' })
  })

  it('synthesizeStream 与非流式共享串行门（流式持锁期间 synthesize 不发上游）', async () => {
    const pcm = Buffer.alloc(3000, 1)
    const sseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"audio":{"data":"${pcm.toString('base64')}"}}}]}\n`))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'))
        controller.close()
      },
    })
    let fetchCount = 0
    const tts = createMiMoTts(baseConfig(), {
      secrets: OK_SECRETS,
      reference: OK_REFERENCE,
      fetchImpl: async () => {
        fetchCount++
        return new Response(sseStream, { status: 200 })
      },
    })
    const streamGen = tts.synthesizeStream('流式')
    const first = await streamGen.next()
    expect(first.done).toBe(false)
    const syncPromise = tts.synthesize('同步').catch(() => undefined as never)
    // 流式持锁：非流式合成排队，不应已发起上游。
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetchCount).toBe(1)
    await streamGen.return(undefined as never)
    await syncPromise
    expect(fetchCount).toBe(2)
  })
})

describe('speechDirection → MiMo 导演指令（完整性）', () => {
  it('undefined / 空 direction 返回空指令', () => {
    expect(buildSpeechDirectionInstruction(undefined)).toBe('')
  })
})
