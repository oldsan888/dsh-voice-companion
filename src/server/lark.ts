/**
 * 飞书语音投递适配器（Phase 4，可选）：把合成好的 WAV 转成飞书语音（opus），
 * 通过 `lark-cli im +messages-send --audio <相对路径>` 上传并发送到指定聊天，
 * 成功后立即删除临时文件（outbox 默认 discard）。
 *
 * 铁律（roadmap §7 / §10.3）：
 * - 未配置/不可用时适配器 available=false，核心网页 TTS 零依赖（隔离验证）；
 * - 临时文件只进 `<DSH_HOME>/voice-companion/tmp/outbox/`，文件名不含聊天内容；
 * - 有限重试 + 退避、转码超时、输入输出大小与路径边界；
 * - 审计只记脱敏元数据（时间/目标/状态/时长/字节/尝试次数），
 *   绝不写完整语音文本、飞书 Token 或凭据；
 * - 外发属于明显副作用：confirm 门禁在 index.ts 工具层强制。
 *
 * 依赖注入（runSpawn / clock / auditPath / outboxDir）供单测落地，不 spawn 真实进程。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { resolveProfilesRoot } from './profiles.ts'

/** 飞书 chat_id / open_id 白名单：字母数字与 `_`/`-`，杜绝 shell 拼接注入。 */
export const CHAT_ID_PATTERN = /^(oc_|ou_|om_|chat_)[A-Za-z0-9_-]{1,96}$/

/** 语音时长（秒）飞行边界：飞书语音消息要求约 1s~60s。 */
export const MIN_AUDIO_SECONDS = 1
export const MAX_AUDIO_SECONDS = 60
/** opus 输出大小上限（字节）：飞书语音约 20MB，留安全余量。 */
export const MAX_OPUS_BYTES = 10 * 1024 * 1024
/** 审计日志保留的最大行数（超限从头部截断）。 */
export const AUDIT_MAX_LINES = 500

export interface RunSpawnResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface LarkDeliveryOptions {
  /** outbox 根目录（默认 `<DSH_HOME>/voice-companion/tmp/outbox`）。 */
  outboxDir?: string
  /** 默认投递目标（chat_id/open_id，工具未显式传时使用）。 */
  defaultChatId?: string
  /** 发送尝试次数（含首次；默认 3 → 失败重试 2 次）。 */
  maxAttempts?: number
  /** 重试退避基数（毫秒；第 n 次重试 wait = base * 2^(n-1)）。 */
  retryBaseMs?: number
  /** 发送命令超时（毫秒，默认 30s）。 */
  sendTimeoutMs?: number
  /** ffmpeg 转码命令超时（毫秒，默认 30s）。 */
  transcodeTimeoutMs?: number
  /** 输入 WAV 大小上限（默认 8MB，与 config.maxAudioBytes 对齐）。 */
  maxWavBytes?: number
  /** 启动清理：outbox 中超过该年龄（毫秒）的残留会被删除（默认 1h）。 */
  staleMaxAgeMs?: number
  /** 探测 lark-cli 可用性的缓存 TTL（毫秒，默认 60s）。 */
  probeTtlMs?: number
  /** 测试注入：替代真实 spawn 的运行器（command/lark-cli、ffmpeg、ffprobe 全走这里）。 */
  runSpawn?: (command: string, args: string[], cwd: string, timeoutMs?: number) => Promise<RunSpawnResult>
  /** 测试注入：时钟。 */
  now?: () => number
  /** 测试注入：审计文件路径（默认 `<DSH_HOME>/voice-companion/delivery-audit.jsonl`）。 */
  auditPath?: string
  /** 是否打印诊断日志（默认 false；错误消息脱敏）。 */
  log?: (line: string) => void
}

export interface LarkProbeState {
  available: boolean
  reason?: 'cli-missing' | 'auth-not-ready' | 'probe-error'
  checkedAt?: number
}

export interface LarkDeliveryStatus {
  enabled: boolean
  available: boolean
  reason?: string
  defaultChatIdSet: boolean
  lastProbeAt?: number
  auditCount: number
}

export type LarkSendStatus =
  | 'sent'
  | 'unavailable'
  | 'invalid-chat'
  | 'invalid-audio'
  | 'audio-too-short'
  | 'audio-too-long'
  | 'transcode-timeout'
  | 'send-failed'
  | 'internal-error'

export interface LarkSendResult {
  ok: boolean
  status: LarkSendStatus
  message: string
  chatId: string
  /** 发送成功后飞书返回的 message_id。 */
  messageId?: string
  /** 实际尝试次数。 */
  attempt?: number
  /** 语音时长（秒，转码后测得）。 */
  durationSec?: number
}

/** 生成不含聊天内容的临时文件名（`v-<ts36>-<rand>.ext`）。 */
export function makeSafeFileName(prefix: string, ext: 'wav' | 'opus', now = Date.now()): string {
  const rand = randomBytes(3).toString('hex')
  return `${prefix}-${now.toString(36)}-${rand}.${ext}`
}

/** 校验飞书接收人 id（chat_id/open_id）。 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId)
}

/** 解析 `lark-cli auth status` 的 JSON，判定 bot/默认身份是否就绪。 */
export function parseAuthStatus(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as {
      defaultAs?: string
      identity?: string
      identities?: { bot?: { status?: string }, user?: { status?: string } }
    }
    const identities = parsed.identities ?? {}
    const primary = parsed.identity ?? parsed.defaultAs ?? ''
    if (primary === 'bot') return identities.bot?.status === 'ready'
    if (primary === 'user') return identities.user?.status === 'ready'
    return identities.bot?.status === 'ready' || identities.user?.status === 'ready'
  } catch {
    return false
  }
}

/** 解析 `lark-cli im +messages-send` 输出的 message_id。 */
export function parseMessageId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { data?: { message_id?: string }, ok?: boolean }
    if (parsed.ok !== true) return undefined
    const id = parsed.data?.message_id
    return typeof id === 'string' && /^om_[A-Za-z0-9]+$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** 读取审计日志行数（不存在返回 0）。 */
export function countAuditLines(auditPath: string): number {
  if (!existsSync(auditPath)) return 0
  try {
    return readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean).length
  } catch {
    return 0
  }
}

/**
 * 创建飞书投递适配器。所有副作用（spawn / 文件写）都走可注入边界；
 * 探测结果缓存 TTL 内复用，不阻塞 apply 装配。
 */
export function createLarkDelivery(options: LarkDeliveryOptions = {}): LarkDelivery {
  const outboxDir = options.outboxDir ?? join(resolveProfilesRoot(), 'tmp', 'outbox')
  const auditPath = options.auditPath ?? join(resolveProfilesRoot(), 'delivery-audit.jsonl')
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3))
  const retryBaseMs = options.retryBaseMs ?? 500
  const sendTimeoutMs = options.sendTimeoutMs ?? 30_000
  const transcodeTimeoutMs = options.transcodeTimeoutMs ?? 30_000
  const maxWavBytes = options.maxWavBytes ?? 8 * 1024 * 1024
  const staleMaxAgeMs = options.staleMaxAgeMs ?? 60 * 60 * 1000
  const probeTtlMs = options.probeTtlMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => undefined)

  const realRun = async (command: string, args: string[], cwd: string, timeoutMs = sendTimeoutMs): Promise<RunSpawnResult> => {
    return new Promise(resolve => {
      const child = spawn(command, args, { cwd, shell: process.platform === 'win32', windowsHide: true })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: error.message || stderr, timedOut })
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut })
      })
    })
  }
  const runSpawn = options.runSpawn ?? realRun

  // ---- 探测（懒加载 + TTL 缓存）----
  let probeState: LarkProbeState = { available: false }
  let probeCheckedAt = 0

  async function asyncProbe(): Promise<LarkProbeState> {
    const nowMs = now()
    if (nowMs - probeCheckedAt < probeTtlMs) return probeState
    probeCheckedAt = nowMs
    const result = await runSpawn('lark-cli', ['auth', 'status'], outboxDir, sendTimeoutMs)
    if (result.code !== 0 || result.timedOut) {
      probeState = result.code === null || result.timedOut
        ? { available: false, reason: 'probe-error', checkedAt: nowMs }
        : { available: false, reason: 'cli-missing', checkedAt: nowMs }
    } else if (!parseAuthStatus(result.stdout)) {
      probeState = { available: false, reason: 'auth-not-ready', checkedAt: nowMs }
    } else {
      probeState = { available: true, checkedAt: nowMs }
    }
    return probeState
  }

  // ---- 转码（WAV Buffer → outbox 内 opus 文件，带超时/大小/路径边界）----
  type TranscodeOutcome =
    | { ok: true; opusPath: string; wavPath: string; durationSec: number; opusBytes: number }
    | { ok: false; status: LarkSendStatus; message: string }

  async function transcode(wav: Buffer): Promise<TranscodeOutcome> {
    if (!Buffer.isBuffer(wav) || wav.length === 0) {
      return { ok: false, status: 'invalid-audio', message: '合成音频为空。' }
    }
    if (wav.length > maxWavBytes) {
      return { ok: false, status: 'invalid-audio', message: '合成音频超过大小上限。' }
    }
    try {
      mkdirSync(outboxDir, { recursive: true })
    } catch {
      return { ok: false, status: 'internal-error', message: 'outbox 目录不可写。' }
    }
    const wavName = makeSafeFileName('v', 'wav', now())
    const opusName = makeSafeFileName('v', 'opus', now())
    const wavPath = join(outboxDir, wavName)
    const opusPath = join(outboxDir, opusName)
    try {
      writeFileSync(wavPath, wav)
    } catch {
      return { ok: false, status: 'internal-error', message: '临时音频写入失败。' }
    }

    // 转码：ffmpeg 读临时 wav（安全相对名），输出 opus；带超时 kill。
    const transcodeResult = await runSpawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', wavName, '-ac', '1', '-ar', '24000', '-c:a', 'libopus', '-b:a', '24k', opusName],
      outboxDir,
      transcodeTimeoutMs,
    )
    if (transcodeResult.timedOut) {
      cleanupFiles([wavPath, opusPath])
      return { ok: false, status: 'transcode-timeout', message: '音频转码超时。' }
    }
    if (transcodeResult.code !== 0 || !existsSync(opusPath)) {
      cleanupFiles([wavPath, opusPath])
      return { ok: false, status: 'invalid-audio', message: '音频转码失败。' }
    }
    let opusBytes = 0
    try {
      opusBytes = statSync(opusPath).size
    } catch {
      cleanupFiles([wavPath, opusPath])
      return { ok: false, status: 'invalid-audio', message: '转码产物不可读。' }
    }
    if (opusBytes <= 0 || opusBytes > MAX_OPUS_BYTES) {
      cleanupFiles([wavPath, opusPath])
      return { ok: false, status: 'audio-too-long', message: '转码产物超过大小上限。' }
    }

    // 时长：ffprobe 读取（不依赖解析 stderr）。
    const duration = await probeDuration(opusName)
    if (duration === undefined) {
      cleanupFiles([wavPath, opusPath])
      return { ok: false, status: 'internal-error', message: '无法读取音频时长。' }
    }
    if (duration < MIN_AUDIO_SECONDS) {
      cleanupFiles([wavPath, opusPath])
      return { ok: false, status: 'audio-too-short', message: '语音时长不足 1 秒，飞书拒收。' }
    }
    if (duration > MAX_AUDIO_SECONDS) {
      cleanupFiles([wavPath, opusPath])
      return { ok: false, status: 'audio-too-long', message: '语音超过 60 秒上限。' }
    }
    return { ok: true, opusPath, wavPath, durationSec: duration, opusBytes }
  }

  async function probeDuration(opusName: string): Promise<number | undefined> {
    const result = await runSpawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', opusName],
      outboxDir,
      transcodeTimeoutMs,
    )
    if (result.code !== 0) return undefined
    try {
      const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } }
      const value = Number(parsed.format?.duration)
      return Number.isFinite(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 删除给定文件（缺失容忍）。 */
  function cleanupFiles(paths: string[]): void {
    for (const path of paths) {
      try {
        if (existsSync(path)) rmSync(path, { force: true })
      } catch {
        log(`cleanup failed: ${basename(path)}`)
      }
    }
  }

  // ---- 审计（脱敏 jsonl 追加，超限头部截断）----
  function audit(record: Record<string, string | number | boolean | null | undefined>): void {
    try {
      const line = `${JSON.stringify({ ts: now(), ...record })}\n`
      appendFileSync(auditPath, line, 'utf8')
      trimAuditFile()
    } catch {
      log('audit write failed')
    }
  }

  function trimAuditFile(): void {
    try {
      if (countAuditLines(auditPath) <= AUDIT_MAX_LINES) return
      const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
      if (lines.length <= AUDIT_MAX_LINES) return
      writeFileSync(auditPath, `${lines.slice(lines.length - AUDIT_MAX_LINES).join('\n')}\n`, 'utf8')
    } catch {
      // 审计截断失败不阻断投递。
    }
  }

  // ---- 发送（有限重试 + 退避；成功后删除临时文件）----
  async function sendWithRetry(opusName: string, chatId: string): Promise<{ ok: boolean; messageId?: string; attempt: number }> {
    let lastError = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await runSpawn(
        'lark-cli',
        ['im', '+messages-send', '--chat-id', chatId, '--audio', opusName],
        outboxDir,
        sendTimeoutMs,
      )
      if (!result.timedOut && result.code === 0) {
        const messageId = parseMessageId(result.stdout)
        if (messageId !== undefined) return { ok: true, messageId, attempt }
        lastError = 'lark-cli 未返回 message_id'
      } else if (result.timedOut) {
        lastError = '发送命令超时'
      } else {
        lastError = `lark-cli 退出码 ${result.code}`
      }
      log(`send attempt ${attempt}/${maxAttempts}: ${lastError}`)
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryBaseMs * 2 ** (attempt - 1)))
      }
    }
    return { ok: false, attempt: maxAttempts }
  }

  // ---- 对外面 ----
  /** 立即触发一次异步探测（apply 装配时 fire-and-forget；不阻塞）。 */
  function ensureProbed(): void {
    void asyncProbe()
  }

  async function status(): Promise<LarkDeliveryStatus> {
    const state = await asyncProbe()
    return {
      enabled: true,
      available: state.available,
      ...(state.reason !== undefined ? { reason: state.reason } : {}),
      ...(state.checkedAt !== undefined ? { lastProbeAt: state.checkedAt } : {}),
      defaultChatIdSet: Boolean(options.defaultChatId) && isValidChatId(options.defaultChatId ?? ''),
      auditCount: countAuditLines(auditPath),
    }
  }

  /** 同步返回最近一次探测缓存（不触发网络/进程），供 state 路由即时投影。 */
  function statusSync(): LarkDeliveryStatus {
    return {
      enabled: true,
      available: probeState.available,
      ...(probeState.reason !== undefined ? { reason: probeState.reason } : {}),
      ...(probeState.checkedAt !== undefined ? { lastProbeAt: probeState.checkedAt } : {}),
      defaultChatIdSet: Boolean(options.defaultChatId) && isValidChatId(options.defaultChatId ?? ''),
      auditCount: countAuditLines(auditPath),
    }
  }

  /**
   * 发送语音消息：转码 → 上传发送（有限重试）→ 成功即删；审计脱敏。
   * 调用方（工具层）负责 confirm 门禁与文本截断。
   */
  async function sendSpeech(input: { wav: Buffer; text: string; chatId: string }): Promise<LarkSendResult> {
    const { wav, text, chatId } = input
    void text // 工具已截断；适配器不落文本（仅本地存在内存，用于合成已发生）
    if (!isValidChatId(chatId)) {
      return { ok: false, status: 'invalid-chat', message: '接收人 id 不合法。', chatId }
    }
    const state = await asyncProbe()
    if (!state.available) {
      const reason = state.reason ?? 'unknown'
      return {
        ok: false,
        status: 'unavailable',
        message: `飞书投递未启用（${reason === 'cli-missing' ? '未找到 lark-cli' : reason === 'auth-not-ready' ? 'lark-cli 身份未就绪' : '飞书环境探测失败'}）。`,
        chatId,
      }
    }
    const startedAt = now()
    const transcodeOutcome = await transcode(wav)
    if (!transcodeOutcome.ok) {
      audit({ id: makeSafeFileName('audit', 'wav', now()).slice(0, 20), chat: chatId, kind: 'lark-audio', status: transcodeOutcome.status, ok: false })
      return { ...transcodeOutcome, chatId }
    }
    const sendOutcome = await sendWithRetry(basename(transcodeOutcome.opusPath), chatId)
    const elapsedMs = now() - startedAt
    if (sendOutcome.ok) {
      // 成功即删（discard 策略）。
      cleanupFiles([transcodeOutcome.wavPath, transcodeOutcome.opusPath])
      audit({
        id: String(now().toString(36)),
        chat: chatId,
        kind: 'lark-audio',
        status: 'sent',
        ok: true,
        attempt: sendOutcome.attempt,
        durationSec: Number(transcodeOutcome.durationSec.toFixed(1)),
        wavBytes: transcodeOutcome.opusBytes,
        sendMs: elapsedMs,
      })
      return {
        ok: true,
        status: 'sent',
        message: `语音已发送到飞书（时长 ${transcodeOutcome.durationSec.toFixed(1)}s）。`,
        chatId,
        messageId: sendOutcome.messageId,
        attempt: sendOutcome.attempt,
        durationSec: transcodeOutcome.durationSec,
      }
    }
    // 重试仍失败：保留 opus（temporary 策略：供诊断/手动重发），删 wav。
    cleanupFiles([transcodeOutcome.wavPath])
    audit({
      id: String(now().toString(36)),
      chat: chatId,
      kind: 'lark-audio',
      status: 'send-failed',
      ok: false,
      attempt: sendOutcome.attempt,
      durationSec: Number(transcodeOutcome.durationSec.toFixed(1)),
    })
    return {
      ok: false,
      status: 'send-failed',
      message: `发送失败（已尝试 ${sendOutcome.attempt} 次）。`,
      chatId,
      attempt: sendOutcome.attempt,
      durationSec: transcodeOutcome.durationSec,
    }
  }

  /** 启动/后台清理 outbox 中超过保留年龄的残留（.wav/.opus/.tmp）。 */
  function cleanupStale(): void {
    try {
      if (!existsSync(outboxDir)) return
      const nowMs = now()
      for (const name of readdirSync(outboxDir)) {
        if (!/\.(wav|opus|tmp)$/.test(name)) continue
        const full = join(outboxDir, name)
        try {
          if (nowMs - statSync(full).mtimeMs > staleMaxAgeMs) rmSync(full, { force: true })
        } catch {
          // 单文件清理失败不阻断其余。
        }
      }
    } catch {
      // outbox 不可读时静默（隔离要求）。
    }
  }

  return {
    probe: asyncProbe,
    ensureProbed,
    status,
    statusSync,
    sendSpeech,
    cleanupStale,
    auditCount: () => countAuditLines(auditPath),
    outboxDir,
    auditPath,
  }
}

export interface LarkDelivery {
  probe: () => Promise<LarkProbeState>
  ensureProbed: () => void
  status: () => Promise<LarkDeliveryStatus>
  statusSync: () => LarkDeliveryStatus
  sendSpeech: (input: { wav: Buffer; text: string; chatId: string }) => Promise<LarkSendResult>
  cleanupStale: () => void
  auditCount: () => number
  readonly outboxDir: string
  readonly auditPath: string
}