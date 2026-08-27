/**
 * 内置 MiMo 云端 TTS Provider：随包参考音频 + 专用凭据 → 直连
 * `${apiBaseUrl}/chat/completions`，解析非流式 JSON 中的 Base64 音频，
 * 校验 RIFF/WAVE 后返回 Buffer。运行时不依赖任何本地 TTS 服务或端口。
 *
 * 约束：
 * - 合成并发数 1（内部串行队列），不并发压垮上游；
 * - AbortController 超时；下游断开/插件 dispose 时中止上游；
 * - 上游响应体、Base64、解码音频全部限长，不只信 Content-Length；
 * - Base64 只从允许的字段提取（无递归遍历）；
 * - 错误一律映射为稳定脱敏错误码 + 短消息，不落完整上游 body。
 */
import type { ErrorCode, TtsStatus } from '../shared/protocol.ts'
import type { SpeechDirection, SpeechEmotion, SpeechLoudness, SpeechSpeed } from '../shared/protocol.ts'
import type { SecretsResult } from './secrets.ts'

/** 参考音频资源（初始化时验证并缓存于 Host 内存）。 */
export interface ReferenceAudio {
  buffer: Buffer
  dataUrl: string
  bytes: number
}

/** WAV 结构校验结果。 */
export interface WavInspection {
  ok: boolean
  error?: string
}

/** 解析 RIFF/WAVE：要求 RIFF+WAVE 头、fmt 块（PCM16）、非空 data 块；采样率不限（24k/48k 均可）。 */
export function inspectWav(buffer: Buffer): WavInspection {
  if (buffer.length < 44) return { ok: false, error: 'WAV 文件太小' }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: '不是有效的 RIFF/WAVE 文件' }
  }
  let pos = 12
  let fmt = false
  let hasData = false
  while (pos + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', pos, pos + 4)
    const chunkSize = buffer.readUInt32LE(pos + 4)
    const start = pos + 8
    const end = start + chunkSize
    if (end > buffer.length) break
    if (chunkId === 'fmt ' && chunkSize >= 16) fmt = true
    if (chunkId === 'data' && chunkSize > 0) hasData = true
    pos = end + (chunkSize % 2)
  }
  if (!fmt) return { ok: false, error: 'WAV 缺少 fmt 块' }
  if (!hasData) return { ok: false, error: 'WAV 缺少 data 块' }
  return { ok: true }
}

/**
 * 参考音频专用校验：在 {@link inspectWav} 基础上要求 PCM16 编码的 fmt 块
 * （MiMo voiceclone 对参考音频的最低要求）。
 */
export function validateReferenceWav(buffer: Buffer): WavInspection {
  const base = inspectWav(buffer)
  if (!base.ok) return base
  let pos = 12
  while (pos + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', pos, pos + 4)
    const chunkSize = buffer.readUInt32LE(pos + 4)
    const start = pos + 8
    const end = start + chunkSize
    if (end > buffer.length) break
    if (chunkId === 'fmt ') {
      const audioFormat = buffer.readUInt16LE(start)
      const bitsPerSample = buffer.readUInt16LE(start + 14)
      if (audioFormat !== 1 || bitsPerSample !== 16) return { ok: false, error: '参考音频必须是 16-bit PCM WAV' }
    }
    pos = end + (chunkSize % 2)
  }
  return { ok: true }
}

/** TTS 合成失败（携带稳定错误码与脱敏短消息）。 */
export class TtsError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface MiMoTtsConfig {
  model: string
  /** voicedesign 用模型（生成候选音色；与复刻用的 model 区分）。 */
  designModel: string
  /** 预置音色真流式模型（速度优先模式）。 */
  streamModel: string
  /** 速度优先模式使用的预置音色 id（显式指定，不硬编码 mimo_default）。 */
  presetVoiceId: string
  /** 流式分片粒度（毫秒）：每段 WAV 的目标时长。 */
  streamChunkMs: number
  /** 语速指令档位（>0）；映射为自然语速描述写入 messages[0]。 */
  speed: number
  requestTimeoutMs: number
  maxAudioBytes: number
  /** 上游 JSON 响应体上限（字节）。 */
  maxResponseBytes?: number
}

export interface MiMoTtsDeps {
  secrets: SecretsResult
  /** 静态参考音频；与 resolveReference 二选一（resolveReference 优先）。 */
  reference?: ReferenceAudio | undefined
  /** 动态解析当前参考音频（如切换到激活 Profile 的音色后调用）。 */
  resolveReference?: () => ReferenceAudio | undefined
  fetchImpl?: typeof fetch
  clock?: () => number
}

/** 语速 → 自然语速指令（沿用旧实现验证过的分档文案）。 */
export function speedInstruction(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) return ''
  if (speed <= 0.75) return '语速明显放慢，停顿自然，吐字清晰'
  if (speed <= 0.9) return '语速略慢，保持自然交流感'
  if (speed <= 1.1) return '使用自然、清晰的日常语速'
  if (speed <= 1.3) return '语速稍快，节奏明快但仍然清楚'
  return '语速较快，表达紧凑，避免含混'
}

/** 有限情绪词表 → 自然语言导演指令（Phase 3 语音表达层）。 */
const EMOTION_INSTRUCTIONS: Record<SpeechEmotion, string> = {
  neutral: '',
  happy: '语气开心、轻快，精神饱满',
  calm: '语气平静、从容，不紧不慢',
  serious: '语气严肃、认真，字正腔圆',
  excited: '语气兴奋、上扬，节奏明快',
  tired: '语气略显疲惫、慵懒',
  helpless: '语气无奈，带一点自嘲的轻叹',
  sad: '语气低落、伤感，放慢节奏',
  angry: '语气带着明显的不满，话要短促有力',
}

/** 有限语速档位 → 自然语言指令。 */
const SPEED_INSTRUCTIONS: Record<SpeechSpeed, string> = {
  slowest: '语速很慢，每句话之间都留白停顿',
  slow: '语速稍慢，保持自然交流感',
  normal: '使用自然、清晰的日常语速',
  fast: '语速稍快，节奏明快但仍然清楚',
  fastest: '语速很快，表达紧凑，避免含混',
}

/** 有限音量倾向 → 自然语言指令。 */
const LOUDNESS_INSTRUCTIONS: Record<SpeechLoudness, string> = {
  quiet: '音量放轻，像轻声耳语',
  normal: '',
  loud: '声音更响亮、更有力度',
}

/**
 * 把有限的 {@link SpeechDirection} 组装成 MiMo 自然语言导演指令。
 * Host 只允许经过词表/长度校验的字段进入此函数；返回内容按 code point
 * 截断到 maxDirectionChars，防止任意文本无限膨胀进上游请求。
 */
export function buildSpeechDirectionInstruction(direction: SpeechDirection | undefined, maxDirectionChars = 160): string {
  if (direction === undefined) return ''
  const parts: string[] = []
  if (direction.emotion !== undefined && direction.emotion !== 'neutral') parts.push(EMOTION_INSTRUCTIONS[direction.emotion])
  if (direction.speed !== undefined) parts.push(SPEED_INSTRUCTIONS[direction.speed])
  if (direction.loudness !== undefined && direction.loudness !== 'normal') parts.push(LOUDNESS_INSTRUCTIONS[direction.loudness])
  if (typeof direction.role === 'string' && direction.role.trim()) parts.push(`用${direction.role.trim()}的口吻演绎`)
  if (typeof direction.director === 'string' && direction.director.trim()) parts.push(direction.director.trim())
  const joined = parts.filter(Boolean).join('，')
  return Array.from(joined).slice(0, maxDirectionChars).join('')
}

/** 构造直连请求 payload（纯函数，单测覆盖字段与角色）。 */
export function buildMimoPayload(input: {
  model: string
  speed: number
  text: string
  referenceDataUrl: string
  /** Phase 3：本条播报的演绎指令；direction.speed 存在时覆盖基础语速档。 */
  direction?: SpeechDirection
}): Record<string, unknown> {
  const baseSpeed = input.direction?.speed !== undefined ? '' : speedInstruction(input.speed)
  const style = [baseSpeed, buildSpeechDirectionInstruction(input.direction)].filter(Boolean).join('，')
  return {
    model: input.model,
    audio: {
      format: 'wav',
      voice: input.referenceDataUrl,
    },
    stream: false,
    messages: [
      { role: 'user', content: style },
      { role: 'assistant', content: input.text },
    ],
  }
}

/**
 * voicedesign 专用 payload：**必须不带 `audio.voice`**（MiMo 对 voicedesign 的
 * 硬约束，见 docs/mimo-tts-verification.md §6），把 voice design prompt 放
 * messages[0]，把候选音频要朗读的文本放 messages[1]。
 */
export function buildVoiceDesignPayload(input: {
  model: string
  prompt: string
  text: string
}): Record<string, unknown> {
  return {
    model: input.model,
    audio: { format: 'wav' },
    stream: false,
    messages: [
      { role: 'user', content: input.prompt },
      { role: 'assistant', content: input.text },
    ],
  }
}

/**
 * 预置音色真流式 payload（Phase 3 §5.2/§5.1）：`mimo-v2.5-tts` + `pcm16`
 * + `stream=true`。`audio.voice` 为预置音色 id（非参考音频）；messages[0]
 * 放风格指令（含可选演绎 direction，direction.speed 覆盖基础语速档）。
 */
export function buildPresetStreamPayload(input: {
  model: string
  voiceId: string
  speed: number
  text: string
  direction?: SpeechDirection
}): Record<string, unknown> {
  const baseSpeed = input.direction?.speed !== undefined ? '' : speedInstruction(input.speed)
  const style = [baseSpeed, buildSpeechDirectionInstruction(input.direction)].filter(Boolean).join('，')
  return {
    model: input.model,
    audio: {
      format: 'pcm16',
      voice: input.voiceId,
    },
    stream: true,
    messages: [
      { role: 'user', content: style },
      { role: 'assistant', content: input.text },
    ],
  }
}

/**
 * 从流式 SSE 单条 data: JSON 中提取增量音频 Base64（PCM16LE）。
 * 候选路径（固定，无递归）：choices[0].delta.audio.data /
 * choices[0].message.audio.data / output.audio.data / 顶层 audio/data。
 */
export function extractStreamAudio(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const root = json as Record<string, unknown>
  const choices = Array.isArray(root.choices) ? root.choices : []
  const first = typeof choices[0] === 'object' && choices[0] !== null ? choices[0] as Record<string, unknown> : undefined
  const message = first && typeof first.message === 'object' && first.message !== null ? first.message as Record<string, unknown> : undefined
  const delta = first && typeof first.delta === 'object' && first.delta !== null ? first.delta as Record<string, unknown> : undefined
  const candidates: unknown[] = [
    delta && typeof delta.audio === 'object' && delta.audio !== null
      ? (delta.audio as Record<string, unknown>).data : undefined,
    message && typeof message.audio === 'object' && message.audio !== null
      ? (message.audio as Record<string, unknown>).data : undefined,
    root.output instanceof Object ? (root.output as Record<string, unknown>).audio instanceof Object
      ? ((root.output as Record<string, unknown>).audio as Record<string, unknown>).data : undefined : undefined,
    root.audio,
    root.data,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 32) return candidate
  }
  return undefined
}

/** 一段流式小 WAV（PCM16/24k/单声道，自带 RIFF 头），供客户端逐段播放。 */
export interface StreamChunk {
  wav: Buffer
  /** 原始采样数（16-bit 单声道：字节数 / 2）。 */
  sampleCount: number
}

/** 把一段 PCM16LE 单声道数据包装成完整 WAV（24kHz）。 */
export function wrapPcm16Wav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 从允许的响应字段中提取 Base64 音频字符串（固定候选路径，无递归）。
 * 候选：choices[0].message.audio.data、choices[0].delta.audio.data、
 * choices[0].message.content.audio.data、output.audio.data、顶层 data/audio。
 */
export function extractBase64Audio(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const root = json as Record<string, unknown>
  const choices = Array.isArray(root.choices) ? root.choices : []
  const first = typeof choices[0] === 'object' && choices[0] !== null ? choices[0] as Record<string, unknown> : undefined
  const message = first && typeof first.message === 'object' && first.message !== null ? first.message as Record<string, unknown> : undefined
  const delta = first && typeof first.delta === 'object' && first.delta !== null ? first.delta as Record<string, unknown> : undefined
  const candidates: unknown[] = [
    message && typeof message.audio === 'object' && message.audio !== null
      ? (message.audio as Record<string, unknown>).data : undefined,
    delta && typeof delta.audio === 'object' && delta.audio !== null
      ? (delta.audio as Record<string, unknown>).data : undefined,
    message && typeof message.content === 'object' && message.content !== null
      ? (message.content as Record<string, unknown>).audio instanceof Object
        ? ((message.content as Record<string, unknown>).audio as Record<string, unknown>).data
        : undefined : undefined,
    root.output instanceof Object ? (root.output as Record<string, unknown>).audio instanceof Object
      ? ((root.output as Record<string, unknown>).audio as Record<string, unknown>).data : undefined : undefined,
    root.data,
    root.audio,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 64) return candidate
  }
  return undefined
}

interface HealthState {
  status: TtsStatus
  checkedAt: number
  notYetTested: boolean
  detail?: string
}

export interface MiMoTts {
  /** 当前健康状态（脱敏；绝不包含凭据/Base URL/路径）。 */
  health(): { status: TtsStatus; checkedAt: number; notYetTested?: boolean; detail?: string }
  /** 是否具备可合成条件（凭据+参考音频+配置有效）。 */
  configured(): boolean
  /**
   * 合成一段文本 → WAV Buffer。串行执行；外部 signal 触发时中止上游。
   * direction 为可选的本条播报演绎指令（Phase 3）。
   * 失败抛 TtsError（code ∈ TTS_* / AUDIO_* / INVALID_AUDIO）。
   */
  synthesize(text: string, signal?: AbortSignal, direction?: SpeechDirection): Promise<Buffer>
  /**
   * voicedesign：根据设计描述生成一个候选音色 → WAV Buffer（无需参考音频，
   * 但仍需凭据）。与 synthesize 共享串行链（并发数 1）。
   */
  synthesizeDesign(prompt: string, text: string, signal?: AbortSignal): Promise<Buffer>
  /**
   * 预置音色真流式合成（Phase 3 §5.2）：mimo-v2.5-tts + pcm16（24k/单声道）
   * 增量解析 SSE，逐段吐出完整小 WAV（StreamChunk）。与 synthesize 共享
   * 串行门（并发数 1；流式持锁直到流结束/中止）。失败抛 TtsError。
   */
  synthesizeStream(text: string, signal?: AbortSignal, direction?: SpeechDirection): AsyncGenerator<StreamChunk>
  /** dispose：中止正在执行及排队中的上游请求。 */
  dispose(): void
}

/** 串行门：同时只允许一个上游操作（并发数=1）；流式可持锁到流结束。 */
class SerialGate {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => task())
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** 排队占用一个槽位；返回的 release 在槽位获得后调用即可继续后续操作。 */
  hold(): { release: () => void } {
    let release!: () => void
    const slot = new Promise<void>(resolve => { release = resolve })
    this.tail = this.tail.then(() => slot)
    return { release: () => release() }
  }
}

export function createMiMoTts(config: MiMoTtsConfig, deps: MiMoTtsDeps): MiMoTts {
  const doFetch = deps.fetchImpl ?? fetch
  const maxResponseBytes = config.maxResponseBytes ?? Math.max(4 * 1024 * 1024, Math.ceil(config.maxAudioBytes * 4 / 3) + 1024 * 1024)
  const healthState: HealthState = {
    status: 'unconfigured',
    checkedAt: deps.clock?.() ?? Date.now(),
    notYetTested: true,
  }

  if (!deps.secrets.ok) {
    healthState.status = 'unconfigured'
    healthState.detail = deps.secrets.detail
  } else if (deps.reference === undefined) {
    // 动态参考音频（resolveReference）优先：若它当前能解析出参考，视为就绪；
    // 否则按"静态参考缺失"处理，避免干净启动时误报 error。
    const resolvable = deps.resolveReference ? deps.resolveReference() !== undefined : false
    if (!resolvable) {
      healthState.status = 'error'
      healthState.detail = '参考音频未通过验证'
    } else {
      healthState.status = 'ready'
      healthState.detail = undefined
    }
  } else {
    healthState.status = 'ready'
    healthState.detail = undefined
  }

  // 并发数 1 的串行门（普通合成 + 流式合成共享；流式持锁到流结束/中止）。
  const gate = new SerialGate()
  const heldSlots = new Set<{ release: () => void }>()
  let disposed = false
  const activeControllers = new Set<AbortController>()

  function note(status: TtsStatus, detail?: string): void {
    healthState.status = status
    healthState.checkedAt = Date.now()
    healthState.notYetTested = false
    healthState.detail = detail
  }

  async function readBounded(response: Response): Promise<string> {
    const body = response.body
    if (!body) return ''
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxResponseBytes) {
          try { await reader.cancel() } catch { /* 上游已断开时可忽略 */ }
          throw new TtsError('AUDIO_TOO_LARGE', `上游响应超过 ${maxResponseBytes} 字节上限`)
        }
        chunks.push(value)
      }
    }
    const parts: Uint8Array[] = chunks
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    return new TextDecoder().decode(merged)
  }

  async function synthesizeOnce(text: string, external: AbortSignal | undefined, direction: SpeechDirection | undefined): Promise<Buffer> {
    if (disposed) throw new TtsError('TTS_UNAVAILABLE', '插件正在卸载')
    if (external?.aborted) throw new TtsError('TTS_UNAVAILABLE', '请求已中止')
    const reference = deps.resolveReference ? deps.resolveReference() : deps.reference
    if (reference === undefined) {
      throw new TtsError('TTS_UNAVAILABLE', healthState.detail ?? 'TTS 未配置')
    }
    return requestAudio(buildMimoPayload({
      model: config.model,
      speed: config.speed,
      text,
      referenceDataUrl: reference.dataUrl,
      ...(direction !== undefined ? { direction } : {}),
    }), external)
  }

  /** voicedesign：无参考音频，同样串行；只需凭据。 */
  async function synthesizeDesignOnce(prompt: string, text: string, external: AbortSignal | undefined): Promise<Buffer> {
    return requestAudio(buildVoiceDesignPayload({ model: config.designModel, prompt, text }), external)
  }

  /**
   * 预置音色真流式：SSE 增量解析，每收到足够的 PCM16 采样就包装成小 WAV 吐出。
   * 上游响应体全程限长；读完即断/中止即停；不读到底才返回。
   */
  async function* streamOnce(text: string, external: AbortSignal | undefined, direction: SpeechDirection | undefined): AsyncGenerator<StreamChunk> {
    if (disposed) throw new TtsError('TTS_UNAVAILABLE', '插件正在卸载')
    if (external?.aborted) throw new TtsError('TTS_UNAVAILABLE', '请求已中止')
    if (!deps.secrets.ok) {
      throw new TtsError('TTS_UNAVAILABLE', healthState.detail ?? 'TTS 未配置')
    }
    // 24kHz * 16bit 单声道 = 48000 字节/秒。
    const chunkBytes = Math.max(1, Math.floor(config.streamChunkMs * 48000 / 1000))
    const controller = new AbortController()
    activeControllers.add(controller)
    const timer = setTimeout(() => controller.abort(new Error('timeout')), config.requestTimeoutMs)
    const onExternalAbort = () => controller.abort(new Error('downstream'))
    external?.addEventListener('abort', onExternalAbort, { once: true })
    try {
      const endpoint = `${deps.secrets.apiBaseUrl}/chat/completions`
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': deps.secrets.apiKey,
        },
        body: JSON.stringify(buildPresetStreamPayload({
          model: config.streamModel,
          voiceId: config.presetVoiceId,
          speed: config.speed,
          text,
          ...(direction !== undefined ? { direction } : {}),
        })),
        signal: controller.signal,
      })
      if (!response.ok) {
        await readBounded(response).catch(() => '')
        throw new TtsError('TTS_REJECTED', `MiMo 流式请求失败（HTTP ${response.status}）`)
      }
      const body = response.body
      if (!body) throw new TtsError('TTS_REJECTED', 'MiMo 流式响应无 body')
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let pcm = Buffer.alloc(0)
      let totalBytes = 0
      let sawAudio = false
      let finished = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.byteLength
          if (totalBytes > maxResponseBytes) {
            try { await reader.cancel() } catch { /* 上游断开可忽略 */ }
            throw new TtsError('AUDIO_TOO_LARGE', `流式响应超过 ${maxResponseBytes} 字节上限`)
          }
          buf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') { finished = true; break }
            if (!data) continue
            let json: unknown
            try { json = JSON.parse(data) } catch { continue }
            const base64 = extractStreamAudio(json)
            if (base64 === undefined) continue
            sawAudio = true
            const samples = Buffer.from(base64, 'base64')
            pcm = Buffer.concat([pcm, samples])
            if (pcm.length >= chunkBytes) {
              yield { wav: wrapPcm16Wav(pcm), sampleCount: pcm.length / 2 }
              pcm = Buffer.alloc(0)
            }
          }
          // 单行（不含 \n）无限膨胀防护：文本缓冲超限即中止上游。
          if (buf.length > maxResponseBytes) {
            try { await reader.cancel() } catch { /* 上游断开可忽略 */ }
            throw new TtsError('AUDIO_TOO_LARGE', `流式响应超过 ${maxResponseBytes} 字节上限`)
          }
          if (finished) break
        }
      }
      // 尾部不足一小段的残余：也要播放，避免吞尾音/断句。
      if (pcm.length > 0) {
        yield { wav: wrapPcm16Wav(pcm), sampleCount: pcm.length / 2 }
        pcm = Buffer.alloc(0)
      }
      if (!sawAudio) throw new TtsError('TTS_REJECTED', 'MiMo 流式响应中没有音频数据')
      note('ready')
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      const reason = (controller.signal.reason as Error | undefined)?.message
      if (aborted && reason === 'timeout') {
        const timeout = new TtsError('TTS_TIMEOUT', `MiMo 流式请求超时（${config.requestTimeoutMs}ms）`)
        note('error', timeout.message)
        throw timeout
      }
      // 下游主动断开/客户端抢占不是 MiMo 故障，不污染健康状态。
      if (aborted) throw new TtsError('TTS_UNAVAILABLE', '请求已中止')
      if (error instanceof TtsError) {
        note('error', error.message)
        throw error
      }
      const message = error instanceof Error ? `${error.name}: ${error.message.slice(0, 80)}` : '网络错误'
      const unavailable = new TtsError('TTS_UNAVAILABLE', `无法连接 MiMo API（${message}）`)
      note('error', unavailable.message)
      throw unavailable
    } finally {
      clearTimeout(timer)
      activeControllers.delete(controller)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** 通用请求：构造/发起到 /chat/completions，解析、限长、校验并回写健康状态。 */
  async function requestAudio(payload: Record<string, unknown>, external: AbortSignal | undefined): Promise<Buffer> {
    if (disposed) throw new TtsError('TTS_UNAVAILABLE', '插件正在卸载')
    if (external?.aborted) throw new TtsError('TTS_UNAVAILABLE', '请求已中止')
    if (!deps.secrets.ok) {
      throw new TtsError('TTS_UNAVAILABLE', healthState.detail ?? 'TTS 未配置')
    }
    const controller = new AbortController()
    activeControllers.add(controller)
    const timer = setTimeout(() => controller.abort(new Error('timeout')), config.requestTimeoutMs)
    const onExternalAbort = () => controller.abort(new Error('downstream'))
    external?.addEventListener('abort', onExternalAbort, { once: true })
    try {
      const endpoint = `${deps.secrets.apiBaseUrl}/chat/completions`
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': deps.secrets.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        // 只保留 HTTP 状态码；上游 body 不进入错误信息或日志。
        await readBounded(response).catch(() => '')
        throw new TtsError('TTS_REJECTED', `MiMo 请求失败（HTTP ${response.status}）`)
      }
      const raw = await readBounded(response)
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        throw new TtsError('TTS_REJECTED', 'MiMo 返回了无法解析的响应')
      }
      const base64 = extractBase64Audio(json)
      if (base64 === undefined) throw new TtsError('TTS_REJECTED', 'MiMo 响应中没有音频数据')
      const audio = Buffer.from(base64, 'base64')
      if (audio.length === 0) throw new TtsError('INVALID_AUDIO', '解码后音频为空')
      if (audio.length > config.maxAudioBytes) {
        throw new TtsError('AUDIO_TOO_LARGE', `音频超过 ${config.maxAudioBytes} 字节上限`)
      }
      const inspection = inspectWav(audio)
      if (!inspection.ok) throw new TtsError('INVALID_AUDIO', inspection.error ?? 'WAV 校验失败')
      note('ready')
      return audio
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      const reason = (controller.signal.reason as Error | undefined)?.message
      if (aborted && reason === 'timeout') {
        const timeout = new TtsError('TTS_TIMEOUT', `MiMo 请求超时（${config.requestTimeoutMs}ms）`)
        note('error', timeout.message)
        throw timeout
      }
      // fetch 可能直接抛出 AbortSignal.reason（Error: downstream），不能当成网络故障。
      if (aborted) throw new TtsError('TTS_UNAVAILABLE', '请求已中止')
      if (error instanceof TtsError) {
        note('error', error.message)
        throw error
      }
      const message = error instanceof Error ? `${error.name}: ${error.message.slice(0, 80)}` : '网络错误'
      const unavailable = new TtsError('TTS_UNAVAILABLE', `无法连接 MiMo API（${message}）`)
      note('error', unavailable.message)
      throw unavailable
    } finally {
      clearTimeout(timer)
      activeControllers.delete(controller)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  return {
    health() {
      const out: { status: TtsStatus; checkedAt: number; notYetTested?: boolean; detail?: string } = {
        status: healthState.status,
        checkedAt: healthState.checkedAt,
      }
      if (healthState.notYetTested && healthState.status === 'ready') out.notYetTested = true
      if (healthState.detail !== undefined && healthState.status !== 'ready') out.detail = healthState.detail
      return out
    },
    configured() {
      return deps.secrets.ok && (deps.resolveReference ? deps.resolveReference() !== undefined : deps.reference !== undefined)
    },
    synthesize(text: string, signal?: AbortSignal, direction?: SpeechDirection): Promise<Buffer> {
      return gate.run(() => synthesizeOnce(text, signal, direction))
    },
    synthesizeDesign(prompt: string, text: string, signal?: AbortSignal): Promise<Buffer> {
      return gate.run(() => synthesizeDesignOnce(prompt, text, signal))
    },
    synthesizeStream(text: string, signal?: AbortSignal, direction?: SpeechDirection): AsyncGenerator<StreamChunk> {
      const slot = gate.hold()
      heldSlots.add(slot)
      const gen = (async function* () {
        try {
          yield* streamOnce(text, signal, direction)
        } finally {
          heldSlots.delete(slot)
          slot.release()
        }
      })()
      return gen
    },
    dispose() {
      disposed = true
      for (const controller of activeControllers) controller.abort(new Error('dispose'))
      activeControllers.clear()
      // 释放仍在排队的流式槽位，避免后续操作被永久阻塞。
      for (const slot of heldSlots) slot.release()
      heldSlots.clear()
    },
  }
}
