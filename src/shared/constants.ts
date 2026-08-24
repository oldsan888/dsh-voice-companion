/**
 * 语音插件共享常量：路由、优先级和协议版本。
 * Host 与 Client 共用；改动任何值都属于协议变更，必须同步两侧并升协议版本。
 */

/** 播报事件类别（三通道 + 手动）。 */
export type VoiceKind = 'ask' | 'done' | 'fail' | 'manual'

/** HTTP API 协议版本（JSON 响应统一携带）。 */
export const PROTOCOL_VERSION = 1

/** 插件专属 exact 路由前缀（避免笼统接管 /api）。 */
export const ROUTE_PREFIX = '/api/dsh-voice'

export const ROUTES = {
  state: `${ROUTE_PREFIX}/state`,
  lease: `${ROUTE_PREFIX}/lease`,
  drain: `${ROUTE_PREFIX}/drain`,
  tts: `${ROUTE_PREFIX}/tts`,
  /** 速度优先：预置音色真流式合成（SSE 增量 → NDJSON 逐段 WAV）。 */
  ttsStream: `${ROUTE_PREFIX}/tts/stream`,
  test: `${ROUTE_PREFIX}/test`,
  queueClear: `${ROUTE_PREFIX}/queue/clear`,
  profiles: `${ROUTE_PREFIX}/profiles`,
  profileReference: `${ROUTE_PREFIX}/profiles/reference`,
  profilesActivate: `${ROUTE_PREFIX}/profiles/activate`,
  profilesRollback: `${ROUTE_PREFIX}/profiles/rollback`,
} as const

/**
 * 播报事件类别与优先级（沿用旧动态语音实现已验证的次序）：
 * ask(3) > manual(2) = done(2) > fail(1)。
 */
export const VOICE_PRIORITY: Record<VoiceKind, number> = {
  ask: 3,
  manual: 2,
  done: 2,
  fail: 1,
}

/** sourceKey 记忆容量（有界 LRU），防止无限增长。 */
export const DEDUPE_LRU_LIMIT = 256

/** sourceKey 记忆 TTL（毫秒）：超过后同 key 可再次入队。 */
export const DEDUPE_TTL_MS = 10 * 60 * 1000

/** JSON 请求体上限（字节）。 */
export const BODY_LIMIT_BYTES = 16 * 1024

/** 试听固定文本。 */
export const TEST_TEXT = '你好老三，我是阿呆，语音试听成功，链路一切正常。'

/** localStorage 偏好键（带版本）。 */
export const PREFERENCES_KEY = 'dsh.voice-companion.preferences.v1'

/** 面板 Slot 注册 id（唯一，卸载时随 effect 消失）。 */
export const PANEL_SLOT_ID = 'voice-companion-panel'
