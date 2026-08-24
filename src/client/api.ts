/**
 * 同源 HTTP Client：封装 /api/dsh-voice/* 六条路由。
 * 所有方法返回判别联合（ok / 带 code 的错误），绝不 throw；
 * 音频请求返回 ArrayBuffer（二进制 WAV，不是 Base64 JSON）。
 */
import { ROUTES } from '../shared/constants.ts'
import type { DrainResponse, ErrorCode, LeaseResponse, ProfilesResponse, ProfileMutationResponse, SpeechDirection, StateResponse } from '../shared/protocol.ts'

export type ApiResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode | 'NETWORK'; message: string }

async function parseJsonResponse<T>(response: Response): Promise<ApiResult<T>> {
  try {
    const body = await response.json() as Record<string, unknown>
    const error = body.error as { code?: unknown; message?: unknown } | undefined
    if (!response.ok && error && typeof error.code === 'string') {
      return { ok: false, code: error.code as ErrorCode, message: String(error.message ?? '') }
    }
    if (!response.ok) {
      return { ok: false, code: 'NETWORK', message: `HTTP ${response.status}` }
    }
    return { ok: true, value: body as T }
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message.slice(0, 120) : '响应解析失败' }
  }
}

async function postJson<T>(route: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message.slice(0, 120) : '网络错误' }
  }
  return parseJsonResponse<T>(response)
}

export async function getState(clientId?: string): Promise<ApiResult<StateResponse>> {
  const suffix = clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''
  let response: Response
  try {
    response = await fetch(`${ROUTES.state}${suffix}`)
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message.slice(0, 120) : '网络错误' }
  }
  return parseJsonResponse<StateResponse>(response)
}

export async function postLease(action: 'acquire' | 'renew' | 'release' | 'takeover', clientId: string): Promise<ApiResult<LeaseResponse>> {
  return postJson<LeaseResponse>(ROUTES.lease, { action, clientId })
}

export async function drain(clientId: string): Promise<ApiResult<DrainResponse>> {
  let response: Response
  try {
    response = await fetch(`${ROUTES.drain}?clientId=${encodeURIComponent(clientId)}`)
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message.slice(0, 120) : '网络错误' }
  }
  return parseJsonResponse<DrainResponse>(response)
}

/** 合成一段文本 → WAV 二进制。非 2xx 时解析统一错误体。 */
async function fetchAudio(route: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<ApiResult<ArrayBuffer>> {
  let response: Response
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, code: 'TTS_TIMEOUT', message: '合成已取消' }
    }
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message.slice(0, 120) : '网络错误' }
  }
  if (!response.ok) {
    try {
      const body = await response.json() as Record<string, unknown>
      const err = body.error as { code?: unknown; message?: unknown } | undefined
      if (err && typeof err.code === 'string') return { ok: false, code: err.code as ErrorCode, message: String(err.message ?? '') }
    } catch {
      // 错误体不是 JSON 时走通用消息。
    }
    return { ok: false, code: 'NETWORK', message: `HTTP ${response.status}` }
  }
  try {
    return { ok: true, value: await response.arrayBuffer() }
  } catch {
    return { ok: false, code: 'INVALID_AUDIO', message: '音频读取失败' }
  }
}

export function requestTts(
  text: string,
  eventId: string | undefined,
  clientId: string,
  signal?: AbortSignal,
  speechDirection?: SpeechDirection,
): Promise<ApiResult<ArrayBuffer>> {
  return fetchAudio(ROUTES.tts, {
    text,
    ...(eventId !== undefined ? { eventId } : {}),
    clientId,
    ...(speechDirection !== undefined ? { speechDirection } : {}),
  }, signal)
}

/** 流式合成失败（携带稳定错误码；供面板分支显示）。 */
export class VoiceStreamError extends Error {
  readonly code: ErrorCode | 'NETWORK'

  constructor(code: ErrorCode | 'NETWORK', message: string) {
    super(message)
    this.code = code
  }
}

/**
 * 真流式合成（速度优先模式）：POST /tts/stream → NDJSON 增量解析，
 * 逐段 yield 完整小 WAV（ArrayBuffer）。失败抛 {@link VoiceStreamError}；
 * 外部 abort 抛 DOMException AbortError（面板据此静默）。
 */
export async function* requestTtsStream(
  text: string,
  clientId: string,
  signal?: AbortSignal,
  speechDirection?: SpeechDirection,
): AsyncGenerator<ArrayBuffer> {
  let response: Response
  try {
    response = await fetch(ROUTES.ttsStream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        clientId,
        ...(speechDirection !== undefined ? { speechDirection } : {}),
      }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const message = error instanceof Error ? error.message.slice(0, 120) : '网络错误'
    throw new VoiceStreamError('NETWORK', message)
  }
  if (!response.ok) {
    try {
      const body = await response.json() as Record<string, unknown>
      const err = body.error as { code?: unknown; message?: unknown } | undefined
      if (err && typeof err.code === 'string') throw new VoiceStreamError(err.code as ErrorCode, String(err.message ?? ''))
    } catch (error) {
      if (error instanceof VoiceStreamError) throw error
      // 错误体不是 JSON 时走通用消息。
    }
    throw new VoiceStreamError('NETWORK', `HTTP ${response.status}`)
  }
  const body = response.body
  if (!body) throw new VoiceStreamError('NETWORK', '流式响应无 body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let json: Record<string, unknown>
        try {
          json = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const type = json.t
        if (type === 'audio') {
          const wav = typeof json.wav === 'string' ? json.wav : ''
          if (wav) {
            const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0))
            yield bytes.buffer as ArrayBuffer
          }
        } else if (type === 'error') {
          throw new VoiceStreamError(String(json.code ?? 'TTS_UNAVAILABLE') as ErrorCode, String(json.message ?? '流式合成失败'))
        } else if (type === 'end') {
          return
        }
      }
    }
  }
}

export function requestTestVoice(clientId: string, signal?: AbortSignal): Promise<ApiResult<ArrayBuffer>> {
  return fetchAudio(ROUTES.test, { clientId }, signal)
}

export async function clearQueue(clientId: string): Promise<ApiResult<{ cleared: number }>> {
  return postJson<{ cleared: number }>(ROUTES.queueClear, { clientId })
}

/** 拉取全部语音身份（只读）。 */
export async function listProfiles(): Promise<ApiResult<ProfilesResponse>> {
  let response: Response
  try {
    response = await fetch(ROUTES.profiles, { cache: 'no-store' })
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message.slice(0, 120) : '网络错误' }
  }
  return parseJsonResponse<ProfilesResponse>(response)
}

/** 拉取某个 Profile 的参考音频 WAV（leader-only，GET）。 */
async function fetchAudioGet(url: string, signal?: AbortSignal): Promise<ApiResult<ArrayBuffer>> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, code: 'TTS_TIMEOUT', message: '读取已取消' }
    }
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message.slice(0, 120) : '网络错误' }
  }
  if (!response.ok) {
    try {
      const body = await response.json() as Record<string, unknown>
      const err = body.error as { code?: unknown; message?: unknown } | undefined
      if (err && typeof err.code === 'string') return { ok: false, code: err.code as ErrorCode, message: String(err.message ?? '') }
    } catch {
      // 非 JSON 错误体。
    }
    return { ok: false, code: 'NETWORK', message: `HTTP ${response.status}` }
  }
  try {
    return { ok: true, value: await response.arrayBuffer() }
  } catch {
    return { ok: false, code: 'INVALID_AUDIO', message: '音频读取失败' }
  }
}

export function getProfileReference(id: string, clientId: string, signal?: AbortSignal): Promise<ApiResult<ArrayBuffer>> {
  return fetchAudioGet(`${ROUTES.profileReference}?id=${encodeURIComponent(id)}&clientId=${encodeURIComponent(clientId)}`, signal)
}

/** 激活指定音色（leader-only）。 */
export function activateProfile(id: string, clientId: string): Promise<ApiResult<ProfileMutationResponse>> {
  return postJson<ProfileMutationResponse>(ROUTES.profilesActivate, { id, clientId })
}

/** 回滚到上一音色（leader-only）。 */
export function rollbackProfile(clientId: string): Promise<ApiResult<ProfileMutationResponse>> {
  return postJson<ProfileMutationResponse>(ROUTES.profilesRollback, { clientId })
}
