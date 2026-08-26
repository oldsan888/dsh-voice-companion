/**
 * dsh-voice-companion host 插件装配：
 * - 订阅全局 session/event（完成/最终失败通道）与 tools/execute waterfall（提问通道）；
 * - 事件经稳定 sourceKey 去重进入有界优先级队列；
 * - 注册 /api/dsh-voice/* exact 路由（状态/租约/drain/TTS/试听/清空）；
 * - 内置 MiMo TTS Provider（随包参考音频 + dsh-home secrets → 云端直连）；
 * - promptEnabled 时注册 @voice 模型提示 section。
 *
 * 所有注册都有 disposer；监听器绝不 throw 进 DSH 主流程；
 * 配置/资源问题使 TTS 明确进入 unconfigured/error，但不阻断 DSH 启动。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROUTES, TEST_TEXT } from '../shared/constants.ts'
import type { VoiceKind } from '../shared/constants.ts'
import type { SpeechDirection } from '../shared/protocol.ts'
import { validateVoiceConfig } from './config.ts'
import { buildFailText, extractAsk, extractDoneSpoken, sanitizeSpeechDirection, truncateCodePoints } from './events.ts'
import type { AssistantMessageEvent } from './events.ts'
import { asRecord, clientIdFromUrl, isJsonContentType, readJsonBody, sendError, sendJson, sendWav } from './http.ts'
import { LeaseManager } from './lease.ts'
import { VOICE_PROMPT_ORDER, VOICE_PROMPT_SECTION_NAME, VOICE_PROMPT_TEXT } from './prompt.ts'
import { createVoicePrefetch } from './prefetch.ts'
import { loadReferenceAudio } from './reference.ts'
import { resolveSecrets } from './secrets.ts'
import { createMiMoTts } from './tts.ts'
import type { MiMoTts, ReferenceAudio, TtsError } from './tts.ts'
import { createProfilesStore, resolveProfilesRoot, BUILTIN_PROFILE_ID, safeProfileId } from './profiles.ts'
import type { ProfileActionResult, VoiceProfile } from './profiles.ts'
import { createLarkDelivery } from './lark.ts'
import type { LarkDelivery, LarkSendResult } from './lark.ts'
import { isValidChatId } from './lark.ts'
import { sanitizeForSpeech } from './sanitize.ts'
import { VoiceQueue } from './queue.ts'

export const name = 'dsh-voice-companion/server'

/** 依赖的宿主服务：HTTP 载体、系统提示词与模型工具注册表。 */
export const inject = ['webServer', 'systemPrompt', 'tools']

/** 测试注入点：替换内部构造的 TTS Provider（仅影响 /tts 与 /test）与 Profile 根目录。 */
export interface ApplyOverrides {
  tts?: Pick<MiMoTts, 'health' | 'configured' | 'synthesize' | 'dispose'>
  /** 测试注入：覆盖 Profile 根目录（默认 resolveProfilesRoot()）。 */
  profilesRoot?: string
  /** 测试注入：替换内部构造的飞书投递适配器（隔离验证用）。 */
  larkDelivery?: LarkDelivery | undefined
}

/** 会话轮次消息缓存上限（有界；正常每轮结束即清除）。 */
const TURN_KEY_LIMIT = 512

export function apply(ctx: Context, rawConfig: unknown = {}, overrides: ApplyOverrides = {}): void {
  const validated = validateVoiceConfig(rawConfig)
  const config = validated.ok ? validated.config : validated.partial
  const ttsDisabledReason = validated.ok ? undefined : validated.problems.map(p => `${p.field}: ${p.message}`).join('；')

  // ---- 随包参考音频 + 语音身份 Profile 储物柜（Phase 1）----
  const referenceResult = loadReferenceAudio(import.meta.url)
  // 储物柜失败仅告警，绝不让插件因 Profile 目录初始化失败而阻断 DSH 启动。
  const profilesStore = (() => {
    try {
      const store = createProfilesStore({ root: overrides.profilesRoot ?? resolveProfilesRoot() })
      if (referenceResult.ok) {
        store.registerBuiltin({
          name: '阿呆·设计音色-1',
          reference: { fileName: 'voice-reference.wav', buffer: referenceResult.reference.buffer },
        })
      }
      return store
    } catch (error) {
      ctx.logger.warn(`dsh-voice-companion 语音身份储物柜初始化失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  })()

  /**
   * 播报稿准备管线（Phase 3 §8.2）：净化（Markdown/URL/路径/哈希/凭据/符号）。
   * 净化后为空 → 返回 undefined（调用方据此静默）。
   * （发音词典已于 2026-08-23 按用户要求移除。）
   */
  const prepareSpoken = (raw: string): string | undefined => {
    const cleaned = sanitizeForSpeech(raw)
    if (!cleaned) return undefined
    return cleaned
  }

  /**
   * 解析当前合成应使用的参考音频：优先用当前激活 Profile 的参考（若激活项
   * 有合法的参考 WAV），否则回退到随包内置兜底。激活音色切换即时对 /tts 生效。
   */
  const currentReference = (): ReferenceAudio | undefined => {
    const active = profilesStore?.peekActive()
    if (active) {
      const buffer = profilesStore?.readReference(active.id)
      if (buffer) {
        return { buffer, bytes: buffer.length, dataUrl: `data:audio/wav;base64,${buffer.toString('base64')}` }
      }
    }
    return referenceResult.ok ? referenceResult.reference : undefined
  }

  const activeSummary = (): object | null => {
    return profilesStore ? profilesStore.list().find(p => p.active) ?? null : null
  }
  const profileMutationResponse = (outcome: ProfileActionResult<VoiceProfile | null>): object => {
    if (outcome.ok) return { protocolVersion: 1, ok: true, active: activeSummary() }
    return { protocolVersion: 1, ok: false, errorCode: outcome.code, message: outcome.message, active: activeSummary() }
  }

  // ---- 内置 TTS Provider：动态参考音频（激活 Profile 优先）+ dsh-home secrets ----
  const secrets = resolveSecrets(config.secretsFile !== undefined ? { secretsFile: config.secretsFile } : {})
  const ownTts = createMiMoTts({
    model: config.model,
    designModel: config.designModel,
    streamModel: config.streamModel,
    presetVoiceId: config.presetVoiceId,
    streamChunkMs: config.streamChunkMs,
    speed: config.speed,
    requestTimeoutMs: config.requestTimeoutMs,
    maxAudioBytes: config.maxAudioBytes,
  }, {
    secrets,
    resolveReference: currentReference,
  })
  // override.tts 只暴露 voiceclone 面；设计工具走同一对象，故向上抛为完整 MiMoTts。
  const tts = (overrides.tts ?? ownTts) as import('./tts.ts').MiMoTts
  let disposedOwnTts = false
  if (ttsDisabledReason !== undefined) ctx.logger.warn(`dsh-voice-companion 配置问题（TTS 停用）：${ttsDisabledReason}`)
  if (!referenceResult.ok) ctx.logger.warn(`dsh-voice-companion：${referenceResult.detail}`)

  // ---- 飞书投递（Phase 4，可选适配器）：larkEnabled=false 或测试显式禁用时彻底不装 ----
  // 未配置飞书时核心网页 TTS/音色设计/播放必须完全正常（隔离验证）。
  let delivery: LarkDelivery | undefined = undefined
  if (config.larkEnabled) {
    try {
      delivery = overrides.larkDelivery ?? createLarkDelivery({
        defaultChatId: config.larkDefaultChatId || undefined,
        maxAttempts: config.larkMaxAttempts,
        retryBaseMs: config.larkRetryBaseMs,
        sendTimeoutMs: config.larkSendTimeoutMs,
        transcodeTimeoutMs: config.larkTranscodeTimeoutMs,
      })
      delivery.cleanupStale()
      delivery.ensureProbed()
    } catch (error) {
      ctx.logger.warn(`dsh-voice-companion 飞书投递初始化失败（仅外发通道不可用）：${error instanceof Error ? error.message : String(error)}`)
      delivery = undefined
    }
  }

  // ---- 队列 / 租约 / 轮次消息缓存 ----
  const queue = new VoiceQueue({ queueLimit: config.queueLimit })
  const lease = new LeaseManager({ ttlMs: config.leaseTtlMs })
  const prefetch = createVoicePrefetch(tts)
  /** key: `${sessionId}#${turn}` → 该轮最后一条 assistant/message。 */
  const lastMessageByTurn = new Map<string, AssistantMessageEvent>()
  /** sessionId → 当前活动轮次；供 voice_prepare 工具绑定生命周期。 */
  const activeTurnBySession = new Map<string, number>()
  let eventCounter = 0
  const nextEventId = (): string => {
    eventCounter = (eventCounter + 1) % Number.MAX_SAFE_INTEGER
    return `v${Date.now().toString(36)}-${eventCounter.toString(36)}`
  }

  const enqueue = (kind: VoiceKind, text: string, sourceKey: string, previewProfileId?: string, speechDirection?: SpeechDirection): string | undefined => {
    try {
      // Phase 3 §8.2：净化 + 词典替换后才入队列；净化后为空则静默（不计入 stats）。
      const spoken = previewProfileId !== undefined ? text : (prepareSpoken(text) ?? '')
      if (!spoken && previewProfileId === undefined) return undefined
      const id = nextEventId()
      const outcome = queue.enqueue({
        id,
        kind,
        text: spoken,
        createdAt: Date.now(),
        sourceKey,
        ...(previewProfileId !== undefined ? { previewProfileId } : {}),
        ...(speechDirection !== undefined ? { speechDirection } : {}),
      })
      return outcome === 'enqueued' || outcome === 'evicted-overflow' ? id : undefined
    } catch {
      return undefined
    }
  }

  const sessionIdOf = (session: unknown): string => {
    return typeof session === 'object' && session !== null && 'id' in session
      ? String((session as { id: unknown }).id)
      : 'unknown'
  }
  const turnKey = (session: unknown, turn: number): string => `${sessionIdOf(session)}#${turn}`

  const rememberTurnKey = (key: string): void => {
    // 已存在的 key 是覆盖写，不增加容量，不应误逐出别的轮次缓存。
    if (lastMessageByTurn.has(key)) return
    if (lastMessageByTurn.size >= TURN_KEY_LIMIT) {
      const oldest = lastMessageByTurn.keys().next().value
      if (oldest !== undefined) lastMessageByTurn.delete(oldest)
    }
  }

  // ---- 完成通道 + 最终失败通道：全局 session/event ----
  ctx.on('session/event', (session: unknown, event: { type?: string; data?: Record<string, unknown> }) => {
    try {
      const data = event?.data
      if (data === undefined || typeof data !== 'object') return
      const type = event.type
      const turn = typeof data.turn === 'number' ? data.turn : undefined

      if (type === 'turn/start' && turn !== undefined) {
        activeTurnBySession.set(sessionIdOf(session), turn)
        return
      }

      if (type === 'assistant/message' && turn !== undefined) {
        const messageData = asRecord(data.message)
        const content = Array.isArray(messageData?.content) ? messageData?.content : []
        const stored: AssistantMessageEvent = {
          turn,
          message: { content: content as Array<{ type?: string; text?: string }> },
          ...(data.interrupted === true ? { interrupted: true as const } : {}),
        }
        rememberTurnKey(turnKey(session, turn))
        lastMessageByTurn.set(turnKey(session, turn), stored)
        return
      }

      if (type !== 'turn/end' || turn === undefined) return
      const reason = asRecord(data.reason)
      const kind = typeof reason?.kind === 'string' ? reason.kind : ''
      const key = turnKey(session, turn)

      if (kind === 'completed') {
        const prepared = prefetch.peek(key)
        if (prepared !== undefined) {
          const eventId = enqueue('done', prepared.text, `${key}|done`)
          if (eventId === undefined || !prefetch.authorize(key, eventId)) prefetch.discardTurn(key)
        } else {
          const stored = lastMessageByTurn.get(key)
          const result = stored === undefined
            ? ({ silent: true, reason: 'no-message' } as const)
            : extractDoneSpoken([stored], turn, config.maxLineChars)
          if (result.silent) queue.stats.silent++
          else enqueue('done', result.text, `${key}|done`, undefined, result.direction)
        }
      } else if (kind === 'error') {
        prefetch.discardTurn(key)
        enqueue('fail', buildFailText(), `${key}|fail`)
      } else if (kind === 'max-tokens') {
        prefetch.discardTurn(key)
        // 尚可继续的响应不播报；只记诊断计数。
        ctx.logger.debug?.('dsh-voice-companion: turn ended with max-tokens (silent)')
      } else {
        prefetch.discardTurn(key)
      }
      // aborted / blocked / interrupted / 其他终态：静默。
      lastMessageByTurn.delete(key)
      const sessionId = sessionIdOf(session)
      if (activeTurnBySession.get(sessionId) === turn) activeTurnBySession.delete(sessionId)
    } catch {
      // 播报事件绝不影响 DSH 主流程。
    }
  }, { global: true })

  // ---- 模型工具：最终文字生成前提前合成，成功 turn/end 才允许播放 ----
  ctx.tools.register(defineTool({
    name: 'voice_prepare',
    description: 'Prepare one short spoken completion in the background before writing the final answer. Use only after the claimed task outcome is verified, especially for long tasks or when the human explicitly requested speech. The audio is held in memory and is played only if the current turn completes successfully. Do not call this together with an @voice marker.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: `Natural spoken summary, non-empty and at most ${config.maxLineChars} Unicode characters. Never include secrets, paths, code, Markdown, or raw diagnostics.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const text = Array.from(args.text.trim()).slice(0, config.maxLineChars).join('')
      if (!text) return { accepted: false, message: 'Voice prefetch skipped: text is empty.' }
      if (ttsDisabledReason !== undefined || !tts.configured()) {
        return { accepted: false, message: 'Voice prefetch unavailable; continue with the final text answer.' }
      }
      const sessionId = exec.agent?.session?.id === undefined ? '' : String(exec.agent.session.id)
      const turn = activeTurnBySession.get(sessionId)
      if (!sessionId || turn === undefined) {
        return { accepted: false, message: 'Voice prefetch could not identify the active turn; continue with the final text answer.' }
      }
      prefetch.prepare(`${sessionId}#${turn}`, text)
      return { accepted: true, message: 'Voice is preparing in the background. Continue with the final text answer now.' }
    },
  }))

  // ==== Phase 2：自然语言音色设计闭环（模型可调用工具）====
  // 描述校验/长度统一 helper。
  const truncateCp = (s: string, n: number): string => truncateCodePoints(s, n)
  const DEFAULT_PREVIEW_TEXT = '你好，这是一段新的音色试听。你觉得这个声音怎么样？'

  /** 一次设计生成若干个候选并固化为 design Profile。 */
  async function generateDesignCandidates(input: {
    prompt: string
    previewText: string
    count: number
    demand?: string
    stylePrompt?: string
  }): Promise<
    | { ok: true; candidates: Array<{ id: string; name: string; kind: string; approved: boolean; previewText?: string }> }
    | { ok: false; message: string }
  > {
    const prompt = truncateCp(input.prompt, config.maxDesignPromptChars).trim()
    if (!prompt) return { ok: false, message: '设计描述为空。' }
    if (ttsDisabledReason !== undefined || !tts.configured()) {
      return { ok: false, message: '语音服务未配置，无法生成候选音色。' }
    }
    if (!profilesStore) return { ok: false, message: '语音身份储物柜未就绪。' }
    const previewText = truncateCp(input.previewText || DEFAULT_PREVIEW_TEXT, config.maxLineChars)
    const buffers: Buffer[] = []
    for (let i = 0; i < input.count; i++) {
      try {
        buffers.push(await tts.synthesizeDesign(prompt, previewText))
      } catch (error) {
        const detail = (error as { message?: string })?.message ?? '未知错误'
        if (buffers.length === 0) return { ok: false, message: `候选生成失败：${detail}` }
        ctx.logger.warn(`dsh-voice-companion: 候选生成失败（跳过该候选）：${detail}`)
      }
    }
    if (buffers.length === 0) return { ok: false, message: '候选生成失败。' }
    const out: Array<{ id: string; name: string; kind: string; approved: boolean; previewText?: string }> = []
    let candidateIndex = 1
    for (const buffer of buffers) {
      const imported = profilesStore.importReference({
        // 给候选名字加序号，避免同描述生成多个候选时在面板不可区分。
        name: `${truncateCp(prompt, 18)} #${candidateIndex}`,
        kind: 'design',
        buffer,
        fileName: 'design.wav',
        origin: {
          ...(input.demand !== undefined ? { demand: input.demand } : {}),
          designPrompt: prompt,
        },
        previewText,
        source: {
          model: config.designModel,
          ...(input.stylePrompt !== undefined ? { stylePrompt: input.stylePrompt } : {}),
        },
        approved: false,
      })
      if (!imported.ok) {
        ctx.logger.warn(`dsh-voice-companion: 候选固化失败：${imported.message}`)
        continue
      }
      const profile = imported.value
      out.push({ id: profile.id, name: profile.name, kind: profile.kind, approved: profile.approved, previewText: profile.previewText })
      candidateIndex++
    }
    if (out.length === 0) return { ok: false, message: '候选固化失败。' }
    return { ok: true, candidates: out }
  }

  /** 列表用的公开摘要（剔除内部 origin/source/note 等细节）。 */
  function profileListPublic(): Array<Record<string, string | number | boolean | null>> {
    if (!profilesStore) return []
    return profilesStore.list().map(profile => ({
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      status: profile.status,
      approved: profile.approved,
      readOnly: profile.readOnly,
      referenceBytes: profile.referenceBytes,
      referenceSha256: profile.referenceSha256,
      active: profile.active,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }))
  }

  ctx.tools.register(defineTool({
    name: 'voice_profile_list',
    description: 'List all voice profiles (designed candidates, clones and the builtin), the current active voice and its metadata. Read-only; no side effects. Use before activating/rolling back so the user can see what is available.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          profiles: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          activeId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() {
      if (!profilesStore) return { ok: false, message: '语音身份储物柜未就绪。', profiles: [] as Array<Record<string, string | number | boolean | null>> }
      const list = profileListPublic()
      const activeId = profilesStore.activeState().activeId
      const activeName = list.find(p => p.active)?.name ?? '未设置'
      return {
        ok: true,
        message: `共 ${list.length} 个音色；当前音色：${activeName}。详见 profiles 字段。`,
        profiles: list,
        ...(activeId !== null ? { activeId: String(activeId) } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_profile_design',
    description: 'Generate 1-3 new candidate voices from a natural-language description. Each candidate is stored as an unapproved design profile and returned. It does NOT change the current voice. Then let the user preview and choose; only voice_profile_activate (after explicit user confirmation) can make a candidate the active voice. For design, do NOT put the reference audio in audio.voice (handled by the host).',
    parameters: {
      demand: {
        type: 'string',
        required: true,
        description: `The user\'s natural-language desired voice, e.g. "一个成熟一点的女声，温柔但不要甜腻". Max ${config.maxDesignPromptChars} chars.`,
      },
      prompt: {
        type: 'string',
        description: 'Optional structured voice-design prompt. If omitted, demand is used directly.',
      },
      previewText: {
        type: 'string',
        description: 'Text the candidate should say (heard in preview). Defaults to a short greeting.',
      },
      count: {
        type: 'number',
        description: `How many candidates to generate (1-${config.maxDesignCandidates}). Default 2.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const demand = typeof args.demand === 'string' ? args.demand.trim() : ''
      const prompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : demand
      const previewText = typeof args.previewText === 'string' ? args.previewText : ''
      const rawCount = typeof args.count === 'number' ? Math.floor(args.count) : 2
      const count = Math.max(1, Math.min(config.maxDesignCandidates, rawCount))
      if (!demand) return { ok: false, message: '需要提供音色设计描述（demand）。', candidates: [] }
      const result = await generateDesignCandidates({ prompt, previewText, count, demand })
      if (!result.ok) return { ok: false, message: result.message, candidates: [] }
      const names = result.candidates.map(c => `${c.name} (${c.id})`).join('；')
      return {
        ok: true,
        message: `已生成 ${result.candidates.length} 个候选音色：${names}。已为你试听请先调用 voice_profile_preview 试听；批准后调用 voice_profile_activate 并确认才切换。`,
        candidates: result.candidates,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_profile_refine',
    description: 'Refine an existing voice by generating NEW candidate(s) from an updated description, without overwriting previous candidates. Takes the accumulated description (and any adjustment) and produces fresh candidates. Same preview/activate flow as voice_profile_design.',
    parameters: {
      demand: {
        type: 'string',
        required: true,
        description: 'Updated natural-language voice description (include the desired change).',
      },
      adjustment: {
        type: 'string',
        description: 'Optional short adjustment appended to demand, e.g. "稍微再成熟一点，语速慢一点".',
      },
      previewText: { type: 'string', description: 'Text the candidate should say in preview.' },
      count: { type: 'number', description: `Candidates to generate (1-${config.maxDesignCandidates}). Default 1.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const demand = typeof args.demand === 'string' ? args.demand.trim() : ''
      const adjustment = typeof args.adjustment === 'string' ? args.adjustment.trim() : ''
      const prompt = [demand, adjustment].filter(Boolean).join(' ')
      const previewText = typeof args.previewText === 'string' ? args.previewText : ''
      const rawCount = typeof args.count === 'number' ? Math.floor(args.count) : 1
      const count = Math.max(1, Math.min(config.maxDesignCandidates, rawCount))
      if (!prompt) return { ok: false, message: '需要提供调整后的音色描述（demand）。', candidates: [] }
      const result = await generateDesignCandidates({ prompt, previewText, count, demand: prompt })
      if (!result.ok) return { ok: false, message: result.message, candidates: [] }
      const names = result.candidates.map(c => `${c.name} (${c.id})`).join('；')
      return {
        ok: true,
        message: `已基于调整生成 ${result.candidates.length} 个新候选：${names}。请先试听后批准。`,
        candidates: result.candidates,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_profile_preview',
    description: 'Play (preview) a specific candidate or profile reference on the user\'s audio device. No persistent side effect. The audio is delivered to whichever browser tab holds the playback lease.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The profile id to preview (from voice_profile_list / voice_profile_design).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          enqueued: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const safe = safeProfileId(id)
      if (!profilesStore || !safe || !profilesStore.get(safe)) {
        return { ok: false, message: '指定音色不存在。', enqueued: false }
      }
      const eventId = enqueue('manual', '', `${safe}|preview|${nextEventId()}`, safe)
      if (eventId === undefined) {
        return { ok: false, message: '试听入队失败。', enqueued: false }
      }
      return { ok: true, message: '试听已下发到播放页。', enqueued: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_profile_activate',
    description: 'Promote a candidate to the approved voiceclone voice AND set it as the current voice. This is a side-effect with user-visible impact (future voice will change) — you MUST obtain explicit user confirmation and pass confirm:true.',
    parameters: {
      id: { type: 'string', required: true, description: 'Profile id to activate.' },
      confirm: { type: 'boolean', description: 'Must be true. Only pass true after the user explicitly confirmed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          activeId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (args.confirm !== true) {
        return { ok: false, message: '激活音色会改变之后的默认声音，需要用户明确确认后传 confirm: true。' }
      }
      if (!profilesStore) return { ok: false, message: '语音身份储物柜未就绪。' }
      if (!safeProfileId(id)) return { ok: false, message: '音色 id 不合法。' }
      // 批准候选（design → clone, approved）再激活。
      const approveOutcome = profilesStore.approve(id)
      if (!approveOutcome.ok) return { ok: false, message: approveOutcome.message }
      const activateOutcome = profilesStore.activate(id)
      if (!activateOutcome.ok) return { ok: false, message: activateOutcome.message }
      const active = profilesStore.activeState().activeId
      return {
        ok: true,
        message: `已启用音色：${activateOutcome.value.name}（已批准并设为当前音色）。`,
        ...(active !== null ? { activeId: String(active) } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_profile_rollback',
    description: 'Roll back to the previous voice used before the current one. Side effect — MUST pass confirm:true after explicit user confirmation.',
    parameters: {
      confirm: { type: 'boolean', description: 'Must be true after the user explicitly confirmed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      if (args.confirm !== true) {
        return { ok: false, message: '回滚会改变默认声音，需要用户明确确认后传 confirm: true。' }
      }
      if (!profilesStore) return { ok: false, message: '语音身份储物柜未就绪。' }
      const outcome = profilesStore.rollback()
      if (!outcome.ok) return { ok: false, message: outcome.message }
      return { ok: true, message: `已回滚到上一音色：${outcome.value?.name ?? '内置兜底'}。` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_profile_delete',
    description: 'Permanently delete a non-builtin, non-active voice profile. Irreversible — MUST pass confirm:true after explicit user confirmation.',
    parameters: {
      id: { type: 'string', required: true, description: 'Profile id to delete.' },
      confirm: { type: 'boolean', description: 'Must be true after the user explicitly confirmed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (args.confirm !== true) {
        return { ok: false, message: '永久删除音色不可逆，需要用户明确确认后传 confirm: true。' }
      }
      if (!profilesStore) return { ok: false, message: '语音身份储物柜未就绪。' }
      if (!safeProfileId(id)) return { ok: false, message: '音色 id 不合法。' }
      const outcome = profilesStore.delete(id)
      if (!outcome.ok) return { ok: false, message: outcome.message }
      return { ok: true, message: `已删除音色：${id}。` }
    },
  }))

  // ==== Phase 4：飞书语音投递（可选适配器；confirm 门禁 + 审计 + 隔离）====
  ctx.tools.register(defineTool({
    name: 'voice_send_to_lark',
    description: 'Send one synthesized voice message to a Feishu chat (delivered on phone and desktop). This is an external side effect — you MUST obtain explicit user confirmation and pass confirm:true. The message is spoken with the current voice identity. Ordinary web announcements never trigger Feishu delivery.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: `The exact spoken text to synthesize and send, non-empty and at most ${config.maxLineChars} Unicode characters.`,
      },
      chatId: {
        type: 'string',
        description: 'Target Feishu chat_id (oc_...) or user open_id (ou_...). Defaults to the configured delivery target when omitted.',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Only pass true after the user explicitly confirmed this external send.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          chatId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          messageId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      if (args.confirm !== true) {
        return { ok: false, message: '外发飞书语音属于明显副作用，需要用户明确确认后传 confirm: true。', chatId: '', status: 'unconfirmed' }
      }
      const text = typeof args.message === 'string' ? Array.from(args.message.trim()).slice(0, config.maxLineChars).join('') : ''
      if (!text) return { ok: false, message: '需要提供要发送的语音内容（message）。', chatId: '', status: 'invalid-message' }
      if (ttsDisabledReason !== undefined || !tts.configured()) {
        return { ok: false, message: '语音服务未配置，无法合成外发语音。', chatId: '', status: 'tts-unavailable' }
      }
      if (!delivery) {
        return { ok: false, message: '飞书投递未启用（未配置飞书适配器），外发不可用。', chatId: '', status: 'lark-disabled' }
      }
      const chatId = typeof args.chatId === 'string' && args.chatId.trim() ? args.chatId.trim() : config.larkDefaultChatId
      if (!chatId) return { ok: false, message: '未指定接收人，且未配置默认投递目标。', chatId: '', status: 'no-chat-id' }
      if (!isValidChatId(chatId)) return { ok: false, message: '接收人 id 不合法。', chatId, status: 'invalid-chat-id' }
      try {
        const wav = await tts.synthesize(text)
        const result: LarkSendResult = await delivery.sendSpeech({ wav, text, chatId })
        return {
          ok: result.ok,
          message: result.message,
          chatId,
          status: result.status,
          ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
        }
      } catch {
        // 错误详情不落日志/不返回（可能含敏感信息）；保持脱敏稳定反馈。
        return { ok: false, message: '语音发送失败，请稍后重试。', chatId, status: 'internal-error' }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_delivery_status',
    description: "Show the current Feishu voice delivery status: enabled/available, default target configured, recent audit count. Read-only; no side effects and no external send.",
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          available: { type: 'boolean', required: true },
          defaultChatIdSet: { type: 'boolean', required: true },
          auditCount: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() {
      if (!delivery) {
        return { ok: true, message: '飞书投递未启用。', enabled: false, available: false, defaultChatIdSet: false, auditCount: 0 }
      }
      const state = await delivery.status()
      const summary = state.available
        ? '飞书投递可用。'
        : `飞书投递不可用${state.reason === 'cli-missing' ? '（未找到 lark-cli）' : state.reason === 'auth-not-ready' ? '（lark-cli 身份未就绪）' : '（环境探测失败）'}。`
      return {
        ok: true,
        message: `${summary}${state.defaultChatIdSet ? '已配置默认投递目标。' : '未配置默认投递目标。'}审计记录 ${state.auditCount} 条。`,
        enabled: true,
        available: state.available,
        defaultChatIdSet: state.defaultChatIdSet,
        auditCount: state.auditCount,
      }
    },
  }))

  // ---- 提问通道：全局 tools/execute waterfall（必须在 next() 前入队，且必须委托 next()）----
  ctx.on('tools/execute', async (exec: { name: string; callId: string; arguments: unknown }, next: () => Promise<unknown>) => {
    try {
      const ask = extractAsk(exec, config.askMaxChars)
      if (ask !== undefined) enqueue('ask', ask.text, ask.sourceKey)
    } catch {
      // 提示音失败绝不影响工具执行。
    }
    return next()
  }, { global: true })

  // ---- @voice 模型提示 section ----
  if (config.promptEnabled) {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: VOICE_PROMPT_SECTION_NAME,
        order: VOICE_PROMPT_ORDER,
        text: VOICE_PROMPT_TEXT,
      }),
      'dsh-voice-companion: prompt section',
    )
  }

  // ---- HTTP 路由（exact，全部带 no-store 与协议版本）----
  ctx.inject(['webServer'], (httpCtx: Context) => {
    httpCtx.effect(() => {
      const disposers: Array<() => void> = []

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.state,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') {
            sendError(res, 'BAD_METHOD', 'state 只支持 GET', 'GET')
            return
          }
          const clientId = clientIdFromUrl(req, req.url ?? '/')
          const health = tts.health()
          if (ttsDisabledReason !== undefined) {
            health.status = 'error'
            health.detail = `配置无效：${ttsDisabledReason}`
            delete health.notYetTested
          } else if (!referenceResult.ok) {
            health.status = 'error'
            health.detail = referenceResult.detail
            delete health.notYetTested
          }
          const current = lease.current()
          const larkState = delivery?.statusSync()
          sendJson(res, 200, {
            protocolVersion: 1,
            tts: health,
            queue: { pending: queue.size() },
            lease: {
              ownedByThisClient: lease.heldBy(clientId),
              expiresAt: current?.expiresAt ?? 0,
              ownedByOther: current !== undefined && current.clientId !== clientId,
            },
            counts: { ...queue.stats },
            lark: larkState === undefined
              ? { enabled: false, available: false, defaultChatIdSet: false, auditCount: 0 }
              : larkState,
          })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.lease,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendError(res, 'BAD_METHOD', 'lease 只支持 POST', 'POST')
            return
          }
          if (!isJsonContentType(req)) {
            sendError(res, 'BAD_CONTENT_TYPE', '请求必须是 application/json')
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendError(res, body.code, body.message)
            return
          }
          const record = asRecord(body.value)
          const action = record?.action
          const clientId = typeof record?.clientId === 'string' ? record.clientId : ''
          if (typeof action !== 'string' || !clientId) {
            sendError(res, 'INVALID_REQUEST', '需要 action 与 clientId')
            return
          }
          try {
            if (action === 'acquire') {
              const outcome = lease.acquire(clientId)
              if (!outcome.ok) {
                sendError(res, 'NOT_LEADER', 'another browser tab owns voice playback')
                return
              }
              sendJson(res, 200, leaseResponse(outcome.snapshot))
              return
            }
            if (action === 'renew') {
              const outcome = lease.renew(clientId)
              if (!outcome.ok) {
                sendError(res, 'NOT_LEADER', 'lease expired or owned by another tab')
                return
              }
              sendJson(res, 200, leaseResponse(outcome.snapshot))
              return
            }
            if (action === 'release') {
              sendJson(res, 200, leaseResponse(lease.release(clientId)))
              return
            }
            if (action === 'takeover') {
              sendJson(res, 200, leaseResponse(lease.takeover(clientId)))
              return
            }
            sendError(res, 'INVALID_REQUEST', `未知 action：${action.slice(0, 24)}`)
          } catch {
            sendError(res, 'INVALID_REQUEST', '租约操作失败')
          }
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.drain,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') {
            sendError(res, 'BAD_METHOD', 'drain 只支持 GET', 'GET')
            return
          }
          const clientId = clientIdFromUrl(req, req.url ?? '/')
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          const events = queue.drain().map(event => ({
            id: event.id,
            kind: event.kind,
            text: event.text,
            priority: event.priority,
            createdAt: event.createdAt,
            ...(event.previewProfileId !== undefined ? { previewProfileId: event.previewProfileId } : {}),
            ...(event.speechDirection !== undefined ? { speechDirection: event.speechDirection } : {}),
          }))
          sendJson(res, 200, { protocolVersion: 1, events })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.tts,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendError(res, 'BAD_METHOD', 'tts 只支持 POST', 'POST')
            return
          }
          if (!isJsonContentType(req)) {
            sendError(res, 'BAD_CONTENT_TYPE', '请求必须是 application/json')
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendError(res, body.code, body.message)
            return
          }
          const record = asRecord(body.value)
          const clientId = typeof record?.clientId === 'string' ? record.clientId : ''
          const text = typeof record?.text === 'string' ? record.text : ''
          const eventId = typeof record?.eventId === 'string' ? record.eventId : undefined
          const speechDirection = sanitizeSpeechDirection(record?.speechDirection)
          if (!clientId || !text.trim()) {
            sendError(res, 'INVALID_REQUEST', '需要 clientId 与非空 text')
            return
          }
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          await synthesizeToClient(req, res, text.slice(0, config.maxLineChars), eventId, speechDirection)
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.ttsStream,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendError(res, 'BAD_METHOD', 'tts/stream 只支持 POST', 'POST')
            return
          }
          if (!isJsonContentType(req)) {
            sendError(res, 'BAD_CONTENT_TYPE', '请求必须是 application/json')
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendError(res, body.code, body.message)
            return
          }
          const record = asRecord(body.value)
          const clientId = typeof record?.clientId === 'string' ? record.clientId : ''
          const text = typeof record?.text === 'string' ? record.text : ''
          const eventId = typeof record?.eventId === 'string' ? record.eventId : undefined
          const speechDirection = sanitizeSpeechDirection(record?.speechDirection)
          if (!clientId || !text.trim()) {
            sendError(res, 'INVALID_REQUEST', '需要 clientId 与非空 text')
            return
          }
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          if (ttsDisabledReason !== undefined) {
            sendError(res, 'TTS_UNAVAILABLE', 'TTS 配置无效，请检查 Host 日志')
            return
          }
          // 真流式：NDJSON 逐段吐出完整小 WAV（pcm16/24k/单声道）。
          res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          const downstream = new AbortController()
          const onClose = (): void => { if (!res.writableEnded) downstream.abort(new Error('downstream')) }
          res.on('close', onClose)
          try {
            res.write('{\"t\":\"meta\",\"format\":\"pcm16\",\"sampleRate\":24000,\"channels\":1}\n')
            let seq = 0
            for await (const chunk of tts.synthesizeStream(text.slice(0, config.maxLineChars), downstream.signal, speechDirection)) {
              if (res.closed || res.destroyed) return
              res.write(`${JSON.stringify({ t: 'audio', s: seq++, wav: chunk.wav.toString('base64') })}\n`)
            }
            if (!(res.closed || res.destroyed)) {
              res.end(`${JSON.stringify({ t: 'end', chunks: seq })}\n`)
            }
          } catch (error) {
            if (res.closed || res.destroyed) return
            const ttsError = error as Partial<TtsError>
            if (typeof ttsError?.code === 'string' && ttsError.message) {
              res.write(`${JSON.stringify({ t: 'error', code: ttsError.code, message: ttsError.message })}\n`)
            } else {
              res.write(`${JSON.stringify({ t: 'error', code: 'TTS_UNAVAILABLE', message: '语音合成失败' })}\n`)
            }
            res.end()
          } finally {
            res.off('close', onClose)
          }
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.test,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendError(res, 'BAD_METHOD', 'test 只支持 POST', 'POST')
            return
          }
          if (!isJsonContentType(req)) {
            sendError(res, 'BAD_CONTENT_TYPE', '请求必须是 application/json')
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendError(res, body.code, body.message)
            return
          }
          const record = asRecord(body.value)
          const clientId = typeof record?.clientId === 'string' ? record.clientId : ''
          if (!clientId) {
            sendError(res, 'INVALID_REQUEST', '需要 clientId')
            return
          }
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          await synthesizeToClient(req, res, TEST_TEXT)
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.queueClear,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendError(res, 'BAD_METHOD', 'queue/clear 只支持 POST', 'POST')
            return
          }
          if (!isJsonContentType(req)) {
            sendError(res, 'BAD_CONTENT_TYPE', '请求必须是 application/json')
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendError(res, body.code, body.message)
            return
          }
          const record = asRecord(body.value) ?? {}
          const clientId = typeof record.clientId === 'string' ? record.clientId : ''
          if (!clientId) {
            sendError(res, 'INVALID_REQUEST', '需要 clientId')
            return
          }
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          const cleared = queue.clear()
          prefetch.clearAuthorized()
          sendJson(res, 200, { protocolVersion: 1, cleared })
        },
      }))

      // ---- 语音身份 Profile（Phase 1）：列表 / 参考音频 / 激活 / 回滚 ----
      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.profiles,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') {
            sendError(res, 'BAD_METHOD', 'profiles 只支持 GET', 'GET')
            return
          }
          if (!profilesStore) {
            sendError(res, 'TTS_UNAVAILABLE', '语音身份储物柜未就绪')
            return
          }
          sendJson(res, 200, { protocolVersion: 1, profiles: profilesStore.list(), active: profilesStore.activeState() })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.profileReference,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') {
            sendError(res, 'BAD_METHOD', 'profiles/reference 只支持 GET', 'GET')
            return
          }
          const clientId = clientIdFromUrl(req, req.url ?? '/')
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''
          const safe = safeProfileId(id)
          const reference = profilesStore && safe ? profilesStore.readReference(safe) : undefined
          if (!profilesStore || !safe || !reference) {
            sendError(res, 'INVALID_REQUEST', 'Profile 不存在或参考音频缺失')
            return
          }
          sendWav(res, reference)
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.profilesActivate,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendError(res, 'BAD_METHOD', 'profiles/activate 只支持 POST', 'POST')
            return
          }
          if (!isJsonContentType(req)) {
            sendError(res, 'BAD_CONTENT_TYPE', '请求必须是 application/json')
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendError(res, body.code, body.message)
            return
          }
          const record = asRecord(body.value) ?? {}
          const clientId = typeof record.clientId === 'string' ? record.clientId : ''
          const id = typeof record.id === 'string' ? record.id : ''
          if (!clientId || !id) {
            sendError(res, 'INVALID_REQUEST', '需要 clientId 与 id')
            return
          }
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          if (!profilesStore) {
            sendError(res, 'TTS_UNAVAILABLE', '语音身份储物柜未就绪')
            return
          }
          const outcome = profilesStore.activate(id)
          sendJson(res, outcome.ok ? 200 : 400, profileMutationResponse(outcome))
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.profilesRollback,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendError(res, 'BAD_METHOD', 'profiles/rollback 只支持 POST', 'POST')
            return
          }
          if (!isJsonContentType(req)) {
            sendError(res, 'BAD_CONTENT_TYPE', '请求必须是 application/json')
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendError(res, body.code, body.message)
            return
          }
          const record = asRecord(body.value) ?? {}
          const clientId = typeof record.clientId === 'string' ? record.clientId : ''
          if (!clientId) {
            sendError(res, 'INVALID_REQUEST', '需要 clientId')
            return
          }
          if (!lease.heldBy(clientId)) {
            notLeader(res)
            return
          }
          if (!profilesStore) {
            sendError(res, 'TTS_UNAVAILABLE', '语音身份储物柜未就绪')
            return
          }
          const outcome = profilesStore.rollback()
          sendJson(res, outcome.ok ? 200 : 400, profileMutationResponse(outcome))
        },
      }))

      return () => {
        for (const off of disposers) off()
        queue.clear()
        lease.reset()
        prefetch.dispose()
        if (!disposedOwnTts && tts === ownTts) {
          disposedOwnTts = true
          ownTts.dispose()
        }
      }
    }, 'dsh-voice-companion: routes + provider cleanup')
  })

  // ---- 内部助手 ----

  function notLeader(res: ServerResponse): void {
    sendError(res, 'NOT_LEADER', 'another browser tab owns voice playback')
  }

  function leaseResponse(snapshot: ReturnType<LeaseManager['takeover']>): object {
    return {
      protocolVersion: 1,
      lease: {
        held: snapshot.held,
        ownerClientId: snapshot.ownerClientId,
        expiresAt: snapshot.expiresAt,
        youAreOwner: snapshot.youAreOwner,
      },
    }
  }

  /** 合成并回写 WAV；TtsError 映射为稳定错误码响应。 */
  async function synthesizeToClient(req: IncomingMessage, res: ServerResponse, text: string, eventId?: string, speechDirection?: SpeechDirection): Promise<void> {
    if (ttsDisabledReason !== undefined) {
      sendError(res, 'TTS_UNAVAILABLE', 'TTS 配置无效，请检查 Host 日志')
      return
    }
    // 下游断开时中止上游请求。
    const downstream = new AbortController()
    const onClose = (): void => { if (!res.writableEnded) downstream.abort(new Error('downstream')) }
    res.on('close', onClose)
    try {
      const prepared = eventId === undefined ? undefined : await prefetch.consume(eventId, text)
      const audio = prepared ?? await tts.synthesize(text, downstream.signal, speechDirection)
      if (res.closed || res.destroyed) return
      sendWav(res, audio)
    } catch (error) {
      if (res.closed || res.destroyed) return
      const ttsError = error as Partial<TtsError>
      if (typeof ttsError?.code === 'string' && ttsError.message) {
        sendError(res, ttsError.code, ttsError.message)
        return
      }
      sendError(res, 'TTS_UNAVAILABLE', '语音合成失败')
    } finally {
      res.off('close', onClose)
    }
  }
}
