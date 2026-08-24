/**
 * 语音插件 HTTP 协议类型：请求/响应/事件/错误。
 * Host 序列化与 Client 解析共同遵守；字段只增不删（协议版本内）。
 */
import type { VoiceKind } from './constants.ts'

/** 有限情绪词表（@voice 标签与 speechDirection 共用）。 */
export type SpeechEmotion = 'neutral' | 'happy' | 'calm' | 'serious' | 'excited' | 'tired' | 'helpless' | 'sad' | 'angry'

/** 有限语速档位（与语音身份无关的演绎维度）。 */
export type SpeechSpeed = 'slowest' | 'slow' | 'normal' | 'fast' | 'fastest'

/** 有限音量倾向。 */
export type SpeechLoudness = 'quiet' | 'normal' | 'loud'

/**
 * 结构化、有限长度的演绎指令（Phase 3）：由 Host 校验并转换成 MiMo
 * 自然语言导演指令，绝不把任意 JSON 直接拼进上游请求。
 * - 普通用户无需手写：通过 `@voice (开心,稍快) 文本` 这类受限标记表达；
 * - 模型工具（如 voice_prepare）可显式传递 emotion/speed 等有限字段；
 * - 每条播报独立携带，不改变音色身份 Profile。
 */
export interface SpeechDirection {
  emotion?: SpeechEmotion
  speed?: SpeechSpeed
  loudness?: SpeechLoudness
  /** 方言/角色化要求（如 "四川话"、"像深夜的搭档"）。有限长，Host 截断。 */
  role?: string
  /** MiMo 导演指令（自然语言）。有限长，Host 截断；未识别内容不拼入。 */
  director?: string
}

/** 一次待播报事件（drain 批次元素）。 */
export interface VoiceEventDto {
  id: string
  kind: VoiceKind
  text: string
  priority: number
  createdAt: number
  /** 试听指定 Profile 参考音频时携带；客户端播放该音色 WAV，忽略 text。 */
  previewProfileId?: string
  /** 本条播报的演绎指令（可选；聊天文本向后兼容扩展）。 */
  speechDirection?: SpeechDirection
}

/** TTS 健康状态：本地配置/资源完整且最近一次真实请求未失败 = ready。 */
export type TtsStatus = 'ready' | 'unconfigured' | 'error'

/** GET /api/dsh-voice/state 响应。 */
export interface StateResponse {
  protocolVersion: number
  tts: {
    status: TtsStatus
    /** 最近一次状态变更时间（Host 时钟）。 */
    checkedAt: number
    /** 尚未发起过真实合成时为 true（配置就绪但未经端到端验证）。 */
    notYetTested?: boolean
    /** 脱敏原因短语；绝不包含凭据、完整上游响应或本机路径。 */
    detail?: string
  }
  queue: { pending: number }
  lease: {
    /** 当前请求方（按 clientId）是否持有租约。 */
    ownedByThisClient: boolean
    /** 任一有效租约的到期时间；无租约为 0。 */
    expiresAt: number
    /** 是否存在其他标签页持有租约。 */
    ownedByOther: boolean
  }
  counts: { done: number; ask: number; fail: number; silent: number; dropped: number }
  /** 飞书投递（Phase 4，可选适配器）状态投影；未配置时为 disabled。 */
  lark: {
    enabled: boolean
    available: boolean
    /** 脱敏原因（cli-missing/auth-not-ready/probe-error）；可用时为 undefined。 */
    reason?: string
    lastProbeAt?: number
    defaultChatIdSet: boolean
    auditCount: number
  }
}

/** POST /api/dsh-voice/lease 请求体。 */
export interface LeaseRequest {
  action: 'acquire' | 'renew' | 'release' | 'takeover'
  clientId: string
}

/** 租约操作结果。 */
export interface LeaseResponse {
  protocolVersion: number
  lease: {
    held: boolean
    /** 当前持有者 clientId；无有效租约为 null。 */
    ownerClientId: string | null
    expiresAt: number
    /** 本次调用方是否因此成为持有者。 */
    youAreOwner: boolean
  }
}

/** GET /api/dsh-voice/drain 响应（leader-only）。 */
export interface DrainResponse {
  protocolVersion: number
  events: VoiceEventDto[]
}

/** POST /api/dsh-voice/tts 请求体。 */
export interface TtsRequest {
  text: string
  eventId?: string
  clientId: string
  /** 演绎指令（可选）；Host 校验有限字段并构造 MiMo 消息。 */
  speechDirection?: SpeechDirection
}

/** 音色身份摘要（面板列表项；与 server/profiles.ts 的 ProfileSummary 对齐）。 */
export interface VoiceProfileSummary {
  id: string
  name: string
  kind: 'builtin' | 'design' | 'clone'
  readOnly: boolean
  status: 'candidate' | 'active' | 'inactive' | 'deleted'
  createdAt: number
  updatedAt: number
  approved: boolean
  referenceBytes: number
  referenceSha256: string
  active: boolean
}

/** 激活状态（active-profile.json 的对外投影）。 */
export interface VoiceProfileActiveState {
  activeId: string | null
  previousId: string | null
  history: string[]
  updatedAt: number
}

/** GET /api/dsh-voice/profiles 响应：全部音色 + 激活状态。 */
export interface ProfilesResponse {
  protocolVersion: number
  profiles: VoiceProfileSummary[]
  active: VoiceProfileActiveState
}

/** POST /api/dsh-voice/profiles/activate 请求体。 */
export interface ProfileActivateRequest {
  clientId: string
  id: string
}

/** POST /api/dsh-voice/profiles/rollback 请求体。 */
export interface ProfileRollbackRequest {
  clientId: string
}

/** 激活/回滚/删除结果。 */
export interface ProfileMutationResponse {
  protocolVersion: number
  ok: boolean
  /** 操作失败时的稳定错误码（成功为 null）。 */
  errorCode?: string
  message?: string
  /** 当前激活项摘要。 */
  active: VoiceProfileSummary | null
}

/** 统一错误响应体。 */
export interface ErrorResponse {
  protocolVersion: number
  error: { code: ErrorCode; message: string }
}

/** 稳定错误码（客户端按码分支，不解析 message）。 */
export type ErrorCode =
  | 'BAD_METHOD'
  | 'BAD_CONTENT_TYPE'
  | 'BODY_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'NOT_LEADER'
  | 'TTS_UNAVAILABLE'
  | 'TTS_TIMEOUT'
  | 'TTS_REJECTED'
  | 'AUDIO_TOO_LARGE'
  | 'INVALID_AUDIO'

/** 错误码 → HTTP 状态码映射（http.ts 使用）。 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_METHOD: 405,
  BAD_CONTENT_TYPE: 415,
  BODY_TOO_LARGE: 413,
  INVALID_JSON: 400,
  INVALID_REQUEST: 400,
  NOT_LEADER: 409,
  TTS_UNAVAILABLE: 503,
  TTS_TIMEOUT: 504,
  TTS_REJECTED: 502,
  AUDIO_TOO_LARGE: 502,
  INVALID_AUDIO: 502,
}
