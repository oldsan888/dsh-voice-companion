/**
 * 三通道事件提取纯函数：turn/end 完成与失败提取、ask_user_question 提取、
 * Unicode code point 安全截断、@voice 演绎标签解析。全部输入输出为普通数据，
 * 可独立单测；不持有状态、不做 IO、不接触宿主类型。
 */
import { VOICE_PRIORITY } from '../shared/constants.ts'
import type { VoiceKind } from '../shared/constants.ts'
import type { SpeechDirection, SpeechEmotion, SpeechLoudness, SpeechSpeed } from '../shared/protocol.ts'

/** 一条待播报事件（宿主侧完整形态）。 */
export interface VoiceEvent {
  id: string
  kind: VoiceKind
  text: string
  priority: number
  createdAt: number
  sourceKey: string
  /** 试听一个指定 Profile 的参考音频（客户端播放该音色的 WAV，忽略 text）。 */
  previewProfileId?: string
  /** 本条播报的演绎指令。 */
  speechDirection?: SpeechDirection
}

/** 与宿主 assistant/message 对齐的最小投影。 */
export interface AssistantMessageEvent {
  turn: number
  message: { content?: Array<{ type?: string; text?: string }> }
  interrupted?: true
}

/** 与宿主 turn/end 对齐的最小投影。 */
export interface TurnEndEvent {
  turn: number
  reason: {
    kind: string
    reason?: { kind?: string }
    error?: { message?: unknown; code?: unknown; status?: unknown }
  }
}

/** 按 Unicode code point 截断；emoji/代理对不会被切成半个字符。 */
export function truncateCodePoints(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** 拼接一条 assistant 消息中的全部 text block。 */
export function concatTextBlocks(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += `${block.text}\n`
  }
  return text
}

/** 情绪标签词表（有限；未收录的标签静默丢弃，不拼进播报稿）。 */
const EMOTION_TOKENS: Record<string, SpeechEmotion> = {
  '开心': 'happy', '高兴': 'happy', '欢快': 'happy', '愉快': 'happy', '轻松': 'happy',
  '兴奋': 'excited', '激动': 'excited', '热情': 'excited', '精神': 'excited',
  '平静': 'calm', '从容': 'calm', '冷静': 'calm', '稳重': 'calm',
  '严肃': 'serious', '认真': 'serious', '正经': 'serious',
  '疲惫': 'tired', '累了': 'tired', '慵懒': 'tired', '犯困': 'tired',
  '无奈': 'helpless', '委屈': 'helpless', '叹气': 'helpless',
  '难过': 'sad', '伤心': 'sad', '低落': 'sad', '失落': 'sad',
  '生气': 'angry', '不满': 'angry', '愤怒': 'angry',
}

/** 语速标签词表（有限）。 */
const SPEED_TOKENS: Record<string, SpeechSpeed> = {
  '很慢': 'slowest', '特别慢': 'slowest', '慢': 'slow', '稍慢': 'slow', '慢点': 'slow',
  '正常': 'normal', '适中': 'normal', '普通': 'normal',
  '快': 'fast', '稍快': 'fast', '快点': 'fast', '飞快': 'fastest', '很快': 'fastest', '加速': 'fastest',
}

/** 音量倾向标签词表（有限）。 */
const LOUDNESS_TOKENS: Record<string, SpeechLoudness> = {
  '轻声': 'quiet', '耳语': 'quiet', '小声': 'quiet', '轻轻': 'quiet',
  '大声': 'loud', '响亮': 'loud', '有力': 'loud', '洪亮': 'loud',
}

/**
 * 把 `@voice (标签)` 括号里的受限标签解析成语义方向字段。标签用
 * 逗号/顿号/分号/空白分隔；每个 token 按最长匹配查表（如 "很快" 优先于
 * "快"）。未识别的 token 静默丢弃——绝不把任意文本拼进上游请求。
 */
export function parseDirectionTags(tag: string): SpeechDirection {
  const direction: SpeechDirection = {}
  const tokens = tag.split(/[,，、;；\s]+/).map(t => t.trim()).filter(Boolean)
  const seen = new Set<string>()
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    // 最长优先：先尝试完整 token，再按长度递减的子串匹配（如 "语速很快"）。
    const emotionHit = matchLongest(token, EMOTION_TOKENS)
    if (emotionHit !== undefined) { direction.emotion = emotionHit; continue }
    const speedHit = matchLongest(token, SPEED_TOKENS)
    if (speedHit !== undefined) { direction.speed = speedHit; continue }
    const loudnessHit = matchLongest(token, LOUDNESS_TOKENS)
    if (loudnessHit !== undefined) { direction.loudness = loudnessHit; continue }
    // 未识别标签：静默丢弃。
  }
  return direction
}

function matchLongest<T extends string>(token: string, table: Record<string, T>): T | undefined {
  // 最长子串匹配：按表项长度降序，token 任意位置出现即命中（"语速很快"→"很快"→fastest）。
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (token.includes(key)) return table[key]
  }
  return undefined
}

const EMOTION_VALUES: readonly SpeechEmotion[] = ['neutral', 'happy', 'calm', 'serious', 'excited', 'tired', 'helpless', 'sad', 'angry']
const SPEED_VALUES: readonly SpeechSpeed[] = ['slowest', 'slow', 'normal', 'fast', 'fastest']
const LOUDNESS_VALUES: readonly SpeechLoudness[] = ['quiet', 'normal', 'loud']

/**
 * 校验并归一来自 HTTP 请求体 / 事件的 speechDirection（有限字段白名单）。
 * 字段类型不符、枚举不符、超长（role≤40 / director≤80 code point）一律丢弃；
 * 空对象返回 undefined。返回对象只含经校验的字段——绝不把任意内容透传上游。
 */
export function sanitizeSpeechDirection(raw: unknown): SpeechDirection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const src = raw as Record<string, unknown>
  const out: SpeechDirection = {}
  if (typeof src.emotion === 'string' && (EMOTION_VALUES as readonly string[]).includes(src.emotion)) {
    out.emotion = src.emotion as SpeechEmotion
  }
  if (typeof src.speed === 'string' && (SPEED_VALUES as readonly string[]).includes(src.speed)) {
    out.speed = src.speed as SpeechSpeed
  }
  if (typeof src.loudness === 'string' && (LOUDNESS_VALUES as readonly string[]).includes(src.loudness)) {
    out.loudness = src.loudness as SpeechLoudness
  }
  if (typeof src.role === 'string') {
    const role = Array.from(src.role.trim()).slice(0, 40).join('')
    if (role) out.role = role
  }
  if (typeof src.director === 'string') {
    const director = Array.from(src.director.trim()).slice(0, 80).join('')
    if (director) out.director = director
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 从一段回复文本中找行首 `@voice` 标记行并取标记后的播报词。
 * 规则：trim 后必须以字面量 `@voice` 开头（正文提及不触发）；
 * 紧随其后可有一个 `(标签)`（逗号/顿号分隔的情绪/语速/音量标签，
 * 解析为 {@link SpeechDirection}；未识别标签被丢弃）；标签后可跟冒号；
 * 空内容返回 `{ found: true, text: '' }`。向后兼容：不带标签的旧写法等价。
 */
export function findVoiceMarker(text: string): { found: boolean; spoken: string; direction?: SpeechDirection } {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!/^@voice(?=$|\s|[:：(（])/.test(line)) continue
    let rest = line.slice('@voice'.length).trim()
    let direction: SpeechDirection | undefined = undefined
    // 允许紧跟一个中文/英文括号标签（逗号/顿号/分号分隔多个），随后取剩余文本。
    const tagMatch = rest.match(/^[（(]([^（）()]*)[)）]/)
    if (tagMatch !== null) {
      const parsed = parseDirectionTags(tagMatch[1])
      if (Object.keys(parsed).length > 0) direction = parsed
      rest = rest.slice(tagMatch[0].length).trim()
    }
    rest = rest.replace(/^[:：]/, '').trim()
    return { found: true, spoken: rest, ...(direction !== undefined ? { direction } : {}) }
  }
  return { found: false, spoken: '' }
}

/**
 * 完成通道：从同一 turn 的 assistant/message 中倒序查找最后一条完整、
 * 未中断的消息，提取行首 @voice 播报词并截断到 maxLineChars。
 * 找不到消息 / 消息被中断 → 静默；marker 空内容 → 静默。
 * 播报词可携带已解析的 {@link SpeechDirection}。
 */
export function extractDoneSpoken(
  messages: AssistantMessageEvent[],
  turn: number,
  maxLineChars: number,
): { silent: false; text: string; direction?: SpeechDirection } | { silent: true; reason: 'no-message' | 'interrupted' | 'empty-marker' | 'no-marker' } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const event = messages[i]
    if (event.turn !== turn) continue
    if (event.interrupted === true) return { silent: true, reason: 'interrupted' }
    const text = findVoiceMarker(concatTextBlocks(event.message?.content))
    if (!text.found) return { silent: true, reason: 'no-marker' }
    if (text.spoken.length === 0) return { silent: true, reason: 'empty-marker' }
    return {
      silent: false,
      text: truncateCodePoints(text.spoken, maxLineChars),
      ...(text.direction !== undefined ? { direction: text.direction } : {}),
    }
  }
  return { silent: true, reason: 'no-message' }
}

/**
 * 失败通道：从 turn/end error reason 中提取用户安全的短错误信息，
 * 组装固定失败话术。只保留 message/code/status 的短摘要，
 * 绝不携带堆栈、路径或上游原文。
 */
export function buildFailText(): string {
  return '似乎出了点状况，请查看错误详情。'
}

/**
 * 提问通道：识别 ask_user_question 调用并取第一个 question。
 * 返回 undefined 表示不是提问调用。
 */
export function extractAsk(exec: { name: string; callId: string; arguments: unknown }, askMaxChars: number):
  | { sourceKey: string; text: string }
  | undefined {
  if (exec.name !== 'ask_user_question') return undefined
  const args = exec.arguments as { questions?: Array<{ question?: unknown }> } | null | undefined
  const first = Array.isArray(args?.questions) ? args.questions[0] : undefined
  const question = typeof first?.question === 'string' ? first.question.trim() : ''
  if (!question) return undefined
  return {
    sourceKey: `${exec.callId}|ask`,
    text: truncateCodePoints(question, askMaxChars),
  }
}

/** 构造一条入队事件（id 由调用方注入生成器）。 */
export function makeVoiceEvent(input: {
  id: string
  kind: VoiceKind
  text: string
  createdAt: number
  sourceKey: string
  previewProfileId?: string
  speechDirection?: SpeechDirection
}): VoiceEvent {
  return {
    id: input.id,
    kind: input.kind,
    text: input.text,
    priority: VOICE_PRIORITY[input.kind],
    createdAt: input.createdAt,
    sourceKey: input.sourceKey,
    ...(input.previewProfileId !== undefined ? { previewProfileId: input.previewProfileId } : {}),
    ...(input.speechDirection !== undefined ? { speechDirection: input.speechDirection } : {}),
  }
}
