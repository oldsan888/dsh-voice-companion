/**
 * Host 配置校验（纯函数）：无效 provider/model、非正数、相互矛盾的上限、
 * 越出 dsh-home 的 secrets 路径都会产生明确 problem；
 * 问题使 TTS 进入 unconfigured/error 状态，但不让 DSH 无法启动。
 */
import { isInsideDshHome } from './secrets.ts'
import { CHAT_ID_PATTERN } from './lark.ts'

export const SUPPORTED_PROVIDERS = ['mimo'] as const
export const SUPPORTED_MODELS = ['mimo-v2.5-tts-voiceclone'] as const

/** cordis.patch.yml 中 voice-companion-server 行的 config 形状（全部可覆写）。 */
export interface VoicePluginConfig {
  provider: string
  secretsFile?: string
  model: string
  /** voicedesign 用模型（生成候选音色；与复刻用的 model 区分）。 */
  designModel: string
  /** 预置音色真流式模型（速度优先模式；voiceclone/voicedesign 非流式）。 */
  streamModel: string
  /** 速度优先模式使用的预置音色 id（显式指定，不硬编码 mimo_default）。 */
  presetVoiceId: string
  /** 真流式分片粒度（毫秒）：每段 WAV 的目标时长，默认 1000。 */
  streamChunkMs: number
  speed: number
  maxLineChars: number
  askMaxChars: number
  queueLimit: number
  requestTimeoutMs: number
  maxAudioBytes: number
  leaseTtlMs: number
  /** single 设计最多生成的候选数（1..maxDesignCandidates）。 */
  maxDesignCandidates: number
  /** 设计描述 prompt 的最大长度（Unicode code point）。 */
  maxDesignPromptChars: number
  promptEnabled: boolean
  /** 飞书投递（Phase 4，可选适配器）：false 时彻底禁用；默认 true（自动探测 lark-cli）。 */
  larkEnabled: boolean
  /** 飞书默认投递目标（chat_id/open_id）；空 = 工具必须显式传 chatId。 */
  larkDefaultChatId: string
  /** 飞书发送最大尝试次数（含首次；默认 3 → 失败重试 2 次）。 */
  larkMaxAttempts: number
  /** 飞书重试退避基数（毫秒）。 */
  larkRetryBaseMs: number
  /** 飞书发送命令超时（毫秒）。 */
  larkSendTimeoutMs: number
  /** ffmpeg 转码（含 ffprobe 时长读取）超时（毫秒）。 */
  larkTranscodeTimeoutMs: number
}

export interface ConfigProblem {
  field: string
  message: string
}

const DEFAULTS = {
  provider: 'mimo',
  model: 'mimo-v2.5-tts-voiceclone',
  designModel: 'mimo-v2.5-tts-voicedesign',
  streamModel: 'mimo-v2.5-tts',
  presetVoiceId: '冰糖',
  streamChunkMs: 1000,
  speed: 1,
  maxLineChars: 150,
  askMaxChars: 80,
  queueLimit: 8,
  requestTimeoutMs: 60000,
  maxAudioBytes: 8388608,
  leaseTtlMs: 6000,
  maxDesignCandidates: 3,
  maxDesignPromptChars: 300,
  promptEnabled: true,
  larkEnabled: true,
  larkDefaultChatId: '',
  larkMaxAttempts: 3,
  larkRetryBaseMs: 500,
  larkSendTimeoutMs: 30000,
  larkTranscodeTimeoutMs: 30000,
} as const

function toPositiveInt(raw: unknown, fallback: number): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function toPositiveNumber(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function toBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * 校验并归一配置。返回 `ok` 时 config 全字段就绪；失败时 problems 非空，
 * partial 尽量携带可用的默认值（供路由仍可启动、面板显示错误）。
 */
export function validateVoiceConfig(raw: unknown, env: Record<string, string | undefined> = process.env):
  | { ok: true; config: VoicePluginConfig; warnings: ConfigProblem[] }
  | { ok: false; problems: ConfigProblem[]; partial: VoicePluginConfig } {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const warnings: ConfigProblem[] = []
  const problems: ConfigProblem[] = []

  const provider = typeof source.provider === 'string' && source.provider ? source.provider : DEFAULTS.provider
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    problems.push({ field: 'provider', message: `不支持的 provider：${provider}（仅支持 ${SUPPORTED_PROVIDERS.join('/')}）` })
  }
  const model = typeof source.model === 'string' && source.model ? source.model : DEFAULTS.model
  if (!(SUPPORTED_MODELS as readonly string[]).includes(model)) {
    problems.push({ field: 'model', message: `不支持的 model：${model}` })
  }

  const numericFields: Array<{ key: keyof VoicePluginConfig; label: string }> = [
    { key: 'speed', label: 'speed' },
    { key: 'maxLineChars', label: 'maxLineChars' },
    { key: 'askMaxChars', label: 'askMaxChars' },
    { key: 'queueLimit', label: 'queueLimit' },
    { key: 'requestTimeoutMs', label: 'requestTimeoutMs' },
    { key: 'maxAudioBytes', label: 'maxAudioBytes' },
    { key: 'leaseTtlMs', label: 'leaseTtlMs' },
    { key: 'maxDesignCandidates', label: 'maxDesignCandidates' },
    { key: 'maxDesignPromptChars', label: 'maxDesignPromptChars' },
    { key: 'streamChunkMs', label: 'streamChunkMs' },
  ]
  for (const field of numericFields) {
    if (source[field.key as string] === undefined) continue
    if (toPositiveInt(source[field.key as string], -1) === undefined) {
      problems.push({ field: field.label, message: `${field.label} 必须是正数` })
    }
  }

  const speed = toPositiveNumber(source.speed ?? DEFAULTS.speed) ?? DEFAULTS.speed
  const maxLineChars = toPositiveInt(source.maxLineChars, DEFAULTS.maxLineChars) ?? DEFAULTS.maxLineChars
  const askMaxChars = toPositiveInt(source.askMaxChars, DEFAULTS.askMaxChars) ?? DEFAULTS.askMaxChars
  const queueLimit = toPositiveInt(source.queueLimit, DEFAULTS.queueLimit) ?? DEFAULTS.queueLimit
  const requestTimeoutMs = toPositiveInt(source.requestTimeoutMs, DEFAULTS.requestTimeoutMs) ?? DEFAULTS.requestTimeoutMs
  const maxAudioBytes = toPositiveInt(source.maxAudioBytes, DEFAULTS.maxAudioBytes) ?? DEFAULTS.maxAudioBytes
  const leaseTtlMs = toPositiveInt(source.leaseTtlMs, DEFAULTS.leaseTtlMs) ?? DEFAULTS.leaseTtlMs
  const maxDesignCandidates = Math.min(3, toPositiveInt(source.maxDesignCandidates, DEFAULTS.maxDesignCandidates) ?? DEFAULTS.maxDesignCandidates)
  const maxDesignPromptChars = toPositiveInt(source.maxDesignPromptChars, DEFAULTS.maxDesignPromptChars) ?? DEFAULTS.maxDesignPromptChars
  const streamChunkMs = Math.max(200, Math.min(5000, toPositiveInt(source.streamChunkMs, DEFAULTS.streamChunkMs) ?? DEFAULTS.streamChunkMs))
  const promptEnabled = toBool(source.promptEnabled, DEFAULTS.promptEnabled)

  // voicedesign 模型：非空字符串；默认指向内置设计模型。
  let designModel = typeof source.designModel === 'string' && source.designModel.trim()
    ? source.designModel.trim()
    : DEFAULTS.designModel
  if (!designModel) designModel = DEFAULTS.designModel

  // 预置音色真流式模型 + 预置音色 id（显式指定，避免 mimo_default 的集群漂移）。
  let streamModel = typeof source.streamModel === 'string' && source.streamModel.trim()
    ? source.streamModel.trim()
    : DEFAULTS.streamModel
  if (!streamModel) streamModel = DEFAULTS.streamModel
  let presetVoiceId = typeof source.presetVoiceId === 'string' && source.presetVoiceId.trim()
    ? source.presetVoiceId.trim()
    : DEFAULTS.presetVoiceId
  if (!presetVoiceId) presetVoiceId = DEFAULTS.presetVoiceId
  if (presetVoiceId.toLowerCase() === 'mimo_default') {
    problems.push({ field: 'presetVoiceId', message: 'presetVoiceId 不能是 mimo_default（集群相关，不硬编码）' })
    presetVoiceId = DEFAULTS.presetVoiceId
  } else if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(presetVoiceId)) {
    problems.push({ field: 'presetVoiceId', message: 'presetVoiceId 格式不合法' })
    presetVoiceId = DEFAULTS.presetVoiceId
  }

  if (askMaxChars > maxLineChars) {
    problems.push({ field: 'askMaxChars', message: '相互矛盾的上限：askMaxChars 不得超过 maxLineChars' })
  }
  if (leaseTtlMs < 2000) {
    problems.push({ field: 'leaseTtlMs', message: 'leaseTtlMs 过小（<2000ms），租约无法稳定续期' })
  }

  // ---- 飞书投递（Phase 4，可选适配器）----
  // 飞书配置问题只进 warnings：核心网页 TTS 必须零依赖，绝不让飞书配置错误停用 TTS。
  const larkEnabled = toBool(source.larkEnabled, DEFAULTS.larkEnabled)
  let larkDefaultChatId = typeof source.larkDefaultChatId === 'string'
    ? source.larkDefaultChatId.trim()
    : String(DEFAULTS.larkDefaultChatId)
  if (larkDefaultChatId && !CHAT_ID_PATTERN.test(larkDefaultChatId)) {
    warnings.push({ field: 'larkDefaultChatId', message: 'larkDefaultChatId 不合法（应为 oc_/ou_ 开头的飞书 id），已忽略；投递需显式传 chatId' })
    larkDefaultChatId = ''
  }
  const larkNumeric: Array<{ key: 'larkMaxAttempts' | 'larkRetryBaseMs' | 'larkSendTimeoutMs' | 'larkTranscodeTimeoutMs'; label: string }> = [
    { key: 'larkMaxAttempts', label: 'larkMaxAttempts' },
    { key: 'larkRetryBaseMs', label: 'larkRetryBaseMs' },
    { key: 'larkSendTimeoutMs', label: 'larkSendTimeoutMs' },
    { key: 'larkTranscodeTimeoutMs', label: 'larkTranscodeTimeoutMs' },
  ]
  for (const field of larkNumeric) {
    if (source[field.key as string] === undefined) continue
    if (toPositiveInt(source[field.key as string], -1) === undefined) {
      warnings.push({ field: field.label, message: `${field.label} 必须是正数，已回退默认` })
    }
  }
  const larkMaxAttempts = Math.max(1, Math.min(5, toPositiveInt(source.larkMaxAttempts, DEFAULTS.larkMaxAttempts) ?? DEFAULTS.larkMaxAttempts))
  const larkRetryBaseMs = toPositiveInt(source.larkRetryBaseMs, DEFAULTS.larkRetryBaseMs) ?? DEFAULTS.larkRetryBaseMs
  const larkSendTimeoutMs = toPositiveInt(source.larkSendTimeoutMs, DEFAULTS.larkSendTimeoutMs) ?? DEFAULTS.larkSendTimeoutMs
  const larkTranscodeTimeoutMs = toPositiveInt(source.larkTranscodeTimeoutMs, DEFAULTS.larkTranscodeTimeoutMs) ?? DEFAULTS.larkTranscodeTimeoutMs

  let secretsFile: string | undefined
  if (source.secretsFile !== undefined) {
    if (typeof source.secretsFile !== 'string' || source.secretsFile.trim() === '') {
      problems.push({ field: 'secretsFile', message: 'secretsFile 必须是非空字符串路径' })
    } else if (!isInsideDshHome(source.secretsFile, env)) {
      problems.push({ field: 'secretsFile', message: 'secretsFile 必须位于 dsh-home 内' })
      secretsFile = undefined
    } else {
      secretsFile = source.secretsFile
    }
  }

  const config: VoicePluginConfig = {
    provider,
    ...(secretsFile !== undefined ? { secretsFile } : {}),
    model,
    designModel,
    streamModel,
    presetVoiceId,
    streamChunkMs,
    speed,
    maxLineChars,
    askMaxChars,
    queueLimit,
    requestTimeoutMs,
    maxAudioBytes,
    leaseTtlMs,
    maxDesignCandidates,
    maxDesignPromptChars,
    promptEnabled,
    larkEnabled,
    larkDefaultChatId,
    larkMaxAttempts,
    larkRetryBaseMs,
    larkSendTimeoutMs,
    larkTranscodeTimeoutMs,
  }

  if (problems.length > 0) return { ok: false, problems, partial: config }
  return { ok: true, config, warnings }
}
