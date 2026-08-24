/** Phase 4 飞书投递：适配器单测（纯函数 + 注入 runSpawn 的端到端）与 index 工具集成。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLarkDelivery,
  makeSafeFileName,
  isValidChatId,
  parseAuthStatus,
  parseMessageId,
  countAuditLines,
  AUDIT_MAX_LINES,
  MAX_OPUS_BYTES,
} from '../src/server/lark.ts'
import type { LarkDelivery, RunSpawnResult } from '../src/server/lark.ts'
import { apply } from '../src/server/index.ts'
import { makeFakeHostCtx, invokeRoute } from './host-test-utils.ts'
import { ROUTES } from '../src/shared/constants.ts'
import { makeWav } from './host-test-utils.ts'

const tmpDirs: string[] = []
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lark-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

/** 手动造一个 WAV（makeWav 已存在但这里直接用，避免重复 import 名冲突）。 */
function wavBuffer(bytes = 128): Buffer {
  return makeWav({ dataBytes: bytes })
}

describe('纯函数', () => {
  it('makeSafeFileName：不含用户内容，格式 v-<ts36>-<rand>.ext，两次不同', () => {
    const a = makeSafeFileName('v', 'opus', 1_700_000_000_000)
    const b = makeSafeFileName('v', 'opus', 1_700_000_000_000)
    expect(a).toMatch(/^v-[a-z0-9]+-[0-9a-f]{6}\.opus$/)
    expect(b).toMatch(/^v-[a-z0-9]+-[0-9a-f]{6}\.opus$/)
    expect(a).not.toBe(b)
    // 不许出现可能的聊天内容：文件名只有前缀+时间戳+随机。
    expect(a).not.toContain('/')
    expect(a).not.toContain('..')
  })

  it('isValidChatId：合法前缀通过，注入形态拒绝', () => {
    expect(isValidChatId('oc_test_group_0001')).toBe(true)
    expect(isValidChatId('ou_c949e2ffd5baf6bd94dd665d20cb2586')).toBe(true)
    expect(isValidChatId('om_testmessage0001')).toBe(true)
    expect(isValidChatId('')).toBe(false)
    expect(isValidChatId('oc_abc def')).toBe(false)
    expect(isValidChatId('oc_abc;rm -rf')).toBe(false)
    expect(isValidChatId('oc_ab"cd')).toBe(false)
    expect(isValidChatId('oc_x"&echo pwned"')).toBe(false)
    expect(isValidChatId(`oc_x' || echo`)).toBe(false)
    expect(isValidChatId('x'.repeat(200))).toBe(false)
  })

  it('parseAuthStatus：bot 就绪判定', () => {
    expect(parseAuthStatus(JSON.stringify({ identity: 'bot', identities: { bot: { status: 'ready' } } }))).toBe(true)
    expect(parseAuthStatus(JSON.stringify({ identity: 'bot', identities: { bot: { status: 'missing' } } }))).toBe(false)
    expect(parseAuthStatus(JSON.stringify({ identity: 'user', identities: { user: { status: 'ready' } } }))).toBe(true)
    // 无 identity 字段时回退任意就绪身份。
    expect(parseAuthStatus(JSON.stringify({ identities: { bot: { status: 'ready' } } }))).toBe(true)
    expect(parseAuthStatus('not-json')).toBe(false)
    expect(parseAuthStatus('{}')).toBe(false)
  })

  it('parseMessageId：只认 ok:true 且 message_id 格式合法', () => {
    expect(parseMessageId(JSON.stringify({ ok: true, data: { message_id: 'om_testmessage0001' } }))).toBe('om_testmessage0001')
    expect(parseMessageId(JSON.stringify({ ok: false }))).toBeUndefined()
    expect(parseMessageId(JSON.stringify({ data: { message_id: 'om_x1' } }))).toBeUndefined() // 缺 ok
    expect(parseMessageId(JSON.stringify({ ok: true, data: {} }))).toBeUndefined()
    expect(parseMessageId('xxx')).toBeUndefined()
  })

  it('countAuditLines：不存在为 0，存在按行计数', () => {
    const dir = makeTmpDir()
    expect(countAuditLines(join(dir, 'no.jsonl'))).toBe(0)
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, '{"ts":1}\n{"ts":2}\n', 'utf8')
    expect(countAuditLines(path)).toBe(2)
  })
})

// ---- 适配器（注入 runSpawn，无真实进程）----
interface SpawnCall { command: string; args: string[]; cwd: string }

function makeHarness(overrides?: {
  authResult?: RunSpawnResult
  ffmpegResult?: RunSpawnResult
  ffprobeResult?: RunSpawnResult
  sendResult?: RunSpawnResult | Array<RunSpawnResult>
  deliveryOptions?: Parameters<typeof createLarkDelivery>[0]
}) {
  const dir = makeTmpDir()
  const auditPath = join(dir, 'audit.jsonl')
  const calls: SpawnCall[] = []
  const authResult = overrides?.authResult ?? { code: 0, stdout: JSON.stringify({ identity: 'bot', identities: { bot: { status: 'ready' } } }), stderr: '', timedOut: false }
  const ffmpegResult = overrides?.ffmpegResult ?? { code: 0, stdout: '', stderr: '', timedOut: false }
  const ffprobeResult = overrides?.ffprobeResult ?? { code: 0, stdout: JSON.stringify({ format: { duration: '2.3' } }), stderr: '', timedOut: false }
  let sendQueue: Array<RunSpawnResult>
  if (Array.isArray(overrides?.sendResult)) sendQueue = [...overrides.sendResult]
  else sendQueue = [overrides?.sendResult ?? { code: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_test123' } }), stderr: '', timedOut: false }]
  const runSpawn = async (command: string, args: string[], cwd: string): Promise<RunSpawnResult> => {
    calls.push({ command, args, cwd })
    if (command === 'ffmpeg') {
      // 模拟成功转码：在 outbox 里生成 opus 产物（最后一个参数是输出名）。
      const opusName = args[args.length - 1]
      writeFileSync(join(cwd, opusName), 'OPUS-DATA')
      return ffmpegResult
    }
    if (command === 'ffprobe') return ffprobeResult
    if (command === 'lark-cli' && args[0] === 'auth') return authResult
    if (command === 'lark-cli' && args[0] === 'im') return sendQueue.shift() ?? { code: 1, stdout: '', stderr: 'no more send results', timedOut: false }
    return { code: 1, stdout: '', stderr: `unexpected command ${command}`, timedOut: false }
  }
  const delivery = createLarkDelivery({
    outboxDir: dir,
    auditPath,
    runSpawn,
    retryBaseMs: 2,
    maxAttempts: 3,
    ...overrides?.deliveryOptions,
  })
  return { delivery, dir, auditPath, calls }
}

describe('createLarkDelivery 端到端（注入 runSpawn）', () => {
  it('成功：probe ready → 转码 → 时长校验 → 发送 → 成功即删 + 脱敏审计', async () => {
    const { delivery, dir, auditPath, calls } = makeHarness()
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: '你好老三，语音外发测试', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('sent')
    expect(result.messageId).toBe('om_test123')
    expect(result.durationSec).toBeCloseTo(2.3, 1)
    // 发送参数：cwd 是 outbox、audio 是相对文件名（无路径穿越）。
    const sendCall = calls.find(c => c.command === 'lark-cli' && c.args[0] === 'im')!
    expect(sendCall.cwd).toBe(dir)
    const audioArg = sendCall.args[sendCall.args.indexOf('--audio') + 1]
    expect(audioArg).toMatch(/^v-[a-z0-9]+-[0-9a-f]{6}\.opus$/)
    expect(audioArg).not.toContain('/')
    expect(audioArg).not.toContain('\\')
    // 成功即删：outbox 无残留。
    expect(readdirSync(dir).filter(name => /\.(wav|opus)$/.test(name))).toHaveLength(0)
    // 审计：1 行、含 chat/status/ok、绝不含文本与 token。
    const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]) as Record<string, unknown>
    expect(record.status).toBe('sent')
    expect(record.ok).toBe(true)
    expect(record.chat).toBe('oc_test_group_0001')
    expect(JSON.stringify(record)).not.toContain('你好老三')
    expect(JSON.stringify(record)).not.toContain('token')
    expect(JSON.stringify(record)).not.toContain('Dk-')
  })

  it('chatId 不合法：直接拒绝，不 spawn 任何进程', async () => {
    const { delivery, calls } = makeHarness()
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_abc;rm -rf /' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('invalid-chat')
    expect(calls).toHaveLength(0)
  })

  it('探测不可用（cli-missing）：unavailable，不做转码/发送', async () => {
    const { delivery, calls } = makeHarness({ authResult: { code: 1, stdout: '', stderr: 'not found', timedOut: false } })
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('unavailable')
    expect(calls.filter(c => c.command === 'ffmpeg')).toHaveLength(0)
  })

  it('音频过短（<1s）：audio-too-short，临时文件清理', async () => {
    const { delivery, dir } = makeHarness({ ffprobeResult: { code: 0, stdout: JSON.stringify({ format: { duration: '0.4' } }), stderr: '', timedOut: false } })
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('audio-too-short')
    expect(readdirSync(dir).filter(name => /\.(wav|opus)$/.test(name))).toHaveLength(0)
  })

  it('音频过长（>60s）：audio-too-long，临时文件清理', async () => {
    const { delivery, dir } = makeHarness({ ffprobeResult: { code: 0, stdout: JSON.stringify({ format: { duration: '61.0' } }), stderr: '', timedOut: false } })
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('audio-too-long')
    expect(readdirSync(dir).filter(name => /\.(wav|opus)$/.test(name))).toHaveLength(0)
  })

  it('转码超时：transcode-timeout，临时文件清理', async () => {
    const { delivery, dir } = makeHarness({ ffmpegResult: { code: null, stdout: '', stderr: 'timeout', timedOut: true } })
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('transcode-timeout')
    expect(readdirSync(dir).filter(name => /\.(wav|opus)$/.test(name))).toHaveLength(0)
  })

  it('发送重试：第一次失败第二次成功 → attempt=2 且成功即删', async () => {
    const fail = { code: 1, stdout: '', stderr: 'bot not in chat', timedOut: false }
    const ok = { code: 0, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_retry' } }), stderr: '', timedOut: false }
    const { delivery, dir, auditPath } = makeHarness({ sendResult: [fail, ok] })
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(true)
    expect(result.attempt).toBe(2)
    expect(result.messageId).toBe('om_retry')
    expect(readdirSync(dir).filter(name => /\.(wav|opus)$/.test(name))).toHaveLength(0)
    const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ status: 'sent', attempt: 2 })
  })

  it('发送全部失败：send-failed，attempt=3；wav 删除、opus 保留（temporary 策略）', async () => {
    const fail = { code: 1, stdout: '', stderr: 'denied', timedOut: false }
    const { delivery, dir, auditPath } = makeHarness({ sendResult: [fail, fail, fail] })
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('send-failed')
    expect(result.attempt).toBe(3)
    const files = readdirSync(dir)
    expect(files.filter(name => name.endsWith('.wav'))).toHaveLength(0)
    expect(files.filter(name => name.endsWith('.opus'))).toHaveLength(1) // 供诊断/手动重发
    const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ status: 'send-failed', ok: false, attempt: 3 })
  })

  it('WAV 超限：invalid-audio，拒绝转码', async () => {
    const { delivery, calls } = makeHarness()
    const big = Buffer.alloc(8 * 1024 * 1024 + 1)
    big.fill(0)
    const result = await delivery.sendSpeech({ wav: big, text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('invalid-audio')
    expect(calls.filter(c => c.command === 'ffmpeg')).toHaveLength(0)
  })

  it('startup cleanupStale：删除超龄残留、保留新文件', async () => {
    const { delivery, dir } = makeHarness()
    const oldOpus = join(dir, 'v-old.opus')
    const newOpus = join(dir, 'v-new.opus')
    writeFileSync(oldOpus, 'x')
    writeFileSync(newOpus, 'y')
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(oldOpus, past, past)
    delivery.cleanupStale()
    expect(existsSync(oldOpus)).toBe(false)
    expect(existsSync(newOpus)).toBe(true)
  })

  it('status：probe 后 available=true、defaultChatIdSet 准确', async () => {
    const { delivery } = makeHarness({ deliveryOptions: { defaultChatId: 'oc_test_group_0001' } })
    const state = await delivery.status()
    expect(state.enabled).toBe(true)
    expect(state.available).toBe(true)
    expect(state.defaultChatIdSet).toBe(true)
  })

  it('审计截断：超过 AUDIT_MAX_LINES 时保留尾部并写入新记录', async () => {
    const { delivery, auditPath } = makeHarness()
    const many = Array.from({ length: 510 }, (_, i) => `{"i":${i}}`).join('\n')
    writeFileSync(auditPath, `${many}\n`, 'utf8')
    const result = await delivery.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(true)
    const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(AUDIT_MAX_LINES + 1)
    expect(JSON.parse(lines[lines.length - 1] as string)).toMatchObject({ status: 'sent' })
  })

  it('opus 产物超过 MAX_OPUS_BYTES：转码后拒绝并清理', async () => {
    const dir = makeTmpDir()
    const bigOpus = Buffer.alloc(MAX_OPUS_BYTES + 1).fill(0)
    const runSpawn = async (command: string, args: string[], cwd: string): Promise<RunSpawnResult> => {
      if (command === 'ffmpeg') {
        const opusName = args[args.length - 1]
        writeFileSync(join(cwd, opusName), bigOpus)
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      }
      if (command === 'ffprobe') return { code: 0, stdout: JSON.stringify({ format: { duration: '2.0' } }), stderr: '', timedOut: false }
      if (command === 'lark-cli' && args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ identity: 'bot', identities: { bot: { status: 'ready' } } }), stderr: '', timedOut: false }
      return { code: 1, stdout: '', stderr: 'x', timedOut: false }
    }
    const custom = createLarkDelivery({ outboxDir: dir, auditPath: join(dir, 'a.jsonl'), runSpawn, retryBaseMs: 2, maxWavBytes: MAX_OPUS_BYTES * 2 })
    const result = await custom.sendSpeech({ wav: wavBuffer(), text: 'x', chatId: 'oc_test_group_0001' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('audio-too-long')
    expect(readdirSync(dir).filter(name => /\.(wav|opus)$/.test(name))).toHaveLength(0)
  })
})

// ---- index 集成（模型工具 + state 路由 + 隔离）----
function fakeDelivery(overrides?: Partial<LarkDelivery>): LarkDelivery {
  const base: LarkDelivery = {
    probe: async () => ({ available: true, checkedAt: 1 }),
    ensureProbed: () => undefined,
    status: async () => ({ enabled: true, available: true, defaultChatIdSet: true, auditCount: 0, lastProbeAt: 1 }),
    statusSync: () => ({ enabled: true, available: true, defaultChatIdSet: true, auditCount: 0, lastProbeAt: 1 }),
    sendSpeech: async () => ({ ok: true, status: 'sent', message: '语音已发送到飞书。', chatId: 'oc_test' }),
    cleanupStale: () => undefined,
    auditCount: () => 0,
    outboxDir: 'outbox',
    auditPath: 'audit',
  }
  return { ...base, ...overrides }
}

function fakeTts(overrides?: Record<string, unknown>) {
  return {
    health: () => ({ status: 'ready' as const, checkedAt: 1 }),
    configured: () => true,
    synthesize: async () => wavBuffer(64),
    synthesizeDesign: async () => wavBuffer(64),
    synthesizeStream: async function* () { return undefined as never },
    dispose: () => undefined,
    ...overrides,
  }
}

function setupIndex(opts: { larkEnabled?: boolean; delivery?: LarkDelivery | null; config?: Record<string, unknown> } = {}) {
  const host = makeFakeHostCtx()
  const applyConfig = {
    promptEnabled: false,
    larkEnabled: opts.larkEnabled ?? true,
    larkDefaultChatId: 'oc_test_group_0001',
    ...opts.config,
  }
  // 默认注入 fake 适配器：单测绝不触发真实 lark-cli/ffmpeg 进程或真实外发。
  const overrides: { tts: ReturnType<typeof fakeTts>; larkDelivery?: LarkDelivery } = { tts: fakeTts() }
  if (opts.larkEnabled !== false && opts.delivery !== null) {
    overrides.larkDelivery = opts.delivery ?? fakeDelivery()
  }
  apply(host.ctx as never, applyConfig, overrides as never)
  const toolOf = (name: string) => host.tools.find((candidate) => (candidate as { name?: string }).name === name) as {
    execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
  }
  return { host, toolOf }
}

describe('index 工具：voice_send_to_lark', () => {
  it('未 confirm → 拒绝，且不合成', async () => {
    let synthesized = false
    const host = makeFakeHostCtx()
    apply(host.ctx as never, { promptEnabled: false, larkEnabled: true, larkDefaultChatId: 'oc_test_group_0001' }, {
      tts: { ...fakeTts(), synthesize: async () => { synthesized = true; return wavBuffer() } } as never,
      larkDelivery: fakeDelivery(),
    })
    const tool = host.tools.find((candidate) => (candidate as { name?: string }).name === 'voice_send_to_lark') as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    const result = await tool.execute({ message: '你好' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('unconfirmed')
    expect(synthesized).toBe(false)
  })

  it('confirm:true + 可用适配器 → 合成并发送成功', async () => {
    let synthesizedText = ''
    const sent: Array<{ chatId: string; text: string }> = []
    const delivery = fakeDelivery({
      sendSpeech: async input => { sent.push({ chatId: input.chatId, text: input.text }); return { ok: true, status: 'sent', message: '已发送', chatId: input.chatId, messageId: 'om_abc' } },
    })
    const host = makeFakeHostCtx()
    apply(host.ctx as never, { promptEnabled: false, larkEnabled: true, larkDefaultChatId: 'oc_test_group_0001' }, {
      tts: { ...fakeTts(), synthesize: async (text: string) => { synthesizedText = text; return wavBuffer() } } as never,
      larkDelivery: delivery,
    })
    const tool = host.tools.find((candidate) => (candidate as { name?: string }).name === 'voice_send_to_lark') as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    const result = await tool.execute({ message: '你好老三', confirm: true })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('sent')
    expect(synthesizedText).toBe('你好老三')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.chatId).toBe('oc_test_group_0001')
  })

  it('confirm:true 但 lark 未启用 → lark-disabled，不合成', async () => {
    let synthesized = false
    const host = makeFakeHostCtx()
    apply(host.ctx as never, { promptEnabled: false, larkEnabled: false, larkDefaultChatId: '' }, {
      tts: { ...fakeTts(), synthesize: async () => { synthesized = true; return wavBuffer() } } as never,
    })
    const tool = host.tools.find((candidate) => (candidate as { name?: string }).name === 'voice_send_to_lark') as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    const result = await tool.execute({ message: '你好', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('lark-disabled')
    expect(synthesized).toBe(false)
  })

  it('confirm:true、无默认目标且未显式传 chatId → no-chat-id', async () => {
    const { toolOf } = setupIndex({ larkEnabled: true, config: { larkDefaultChatId: '' } })
    const result = await toolOf('voice_send_to_lark').execute({ message: '你好', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('no-chat-id')
  })

  it('显式 chatId 覆盖默认目标；非法 chatId → invalid-chat-id', async () => {
    const { toolOf } = setupIndex()
    const bad = await toolOf('voice_send_to_lark').execute({ message: 'hi', confirm: true, chatId: 'oc_x; rm -rf' })
    expect(bad.ok).toBe(false)
    expect(bad.status).toBe('invalid-chat-id')
    const good = await toolOf('voice_send_to_lark').execute({ message: 'hi', confirm: true, chatId: 'ou_c949e2ffd5baf6bd94dd665d20cb2586' })
    expect(good.ok).toBe(true)
  })

  it('sendSpeech 失败透传（send-failed）', async () => {
    const delivery = fakeDelivery({
      sendSpeech: async () => ({ ok: false, status: 'send-failed', message: '发送失败（已尝试 3 次）。', chatId: 'oc_x' }),
    })
    const host = makeFakeHostCtx()
    apply(host.ctx as never, { promptEnabled: false, larkEnabled: true, larkDefaultChatId: 'oc_test_group_0001' }, {
      tts: fakeTts() as never,
      larkDelivery: delivery,
    })
    const tool = host.tools.find((candidate) => (candidate as { name?: string }).name === 'voice_send_to_lark') as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    const result = await tool.execute({ message: 'hi', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('send-failed')
  })
})

describe('index 工具：voice_delivery_status', () => {
  it('未启用 → enabled:false 只读响应', async () => {
    const { toolOf } = setupIndex({ larkEnabled: false })
    const result = await toolOf('voice_delivery_status').execute({})
    expect(result.ok).toBe(true)
    expect(result.enabled).toBe(false)
    expect(result.available).toBe(false)
    expect(result.auditCount).toBe(0)
  })

  it('已启用 → 状态透传（可用）', async () => {
    const { toolOf } = setupIndex()
    const result = await toolOf('voice_delivery_status').execute({})
    expect(result.ok).toBe(true)
    expect(result.enabled).toBe(true)
    expect(result.available).toBe(true)
  })
})

describe('隔离验证：未配置飞书时核心功能完全正常', () => {
  it('larkEnabled:false 时 state.lark=disabled，且 /tts、/profiles、/state 正常', async () => {
    const host = makeFakeHostCtx()
    apply(host.ctx as never, { promptEnabled: false, larkEnabled: false }, { tts: fakeTts() as never })
    const route = (path: string) => host.routes.get(path)!

    const state = await invokeRoute(route(ROUTES.state), { method: 'GET', url: `${ROUTES.state}?clientId=x` })
    expect(state.status).toBe(200)
    expect((state.json() as { lark: { enabled: boolean; available: boolean } }).lark).toMatchObject({ enabled: false, available: false })
    expect((state.json() as { tts: { status: string } }).tts.status).toBe('ready')

    const profiles = await invokeRoute(route(ROUTES.profiles), { method: 'GET' })
    expect(profiles.status).toBe(200)

    await invokeRoute(route(ROUTES.lease), { method: 'POST', body: { action: 'takeover', clientId: 'x' } })
    const tts = await invokeRoute(route(ROUTES.tts), { method: 'POST', body: { clientId: 'x', text: '隔离验证' } })
    expect(tts.status).toBe(200)
    expect(tts.body.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('larkEnabled:true + 适配器可用时 state.lark 透传 available', async () => {
    const host = makeFakeHostCtx()
    apply(host.ctx as never, { promptEnabled: false, larkEnabled: true, larkDefaultChatId: 'oc_test_group_0001' }, {
      tts: fakeTts() as never,
      larkDelivery: fakeDelivery(),
    })
    const state = await invokeRoute(host.routes.get(ROUTES.state)!, { method: 'GET', url: `${ROUTES.state}?clientId=x` })
    const lark = (state.json() as { lark: { enabled: boolean; available: boolean; defaultChatIdSet: boolean } }).lark
    expect(lark).toMatchObject({ enabled: true, available: true, defaultChatIdSet: true })
  })
})