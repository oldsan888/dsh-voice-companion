/**
 * 语音身份 Profile 存储（Phase 1 基础）。
 *
 * 职责：在 `<DSH_HOME>/voice-companion/` 下长期保存 DSH 的声音身份，支持
 * 内置只读兜底、候选音色隔离、版本化（任何调整都生成新版本，禁止原地覆盖）、
 * 原子激活与回滚、SHA-256 指纹与严格的路径边界校验。
 *
 * 设计要点：
 * - 纯 Node fs 实现，不依赖 DSH 源码或 Cordis；root 由调用方显式注入
 *   （生产为 DSH_HOME/voice-companion，测试为临时目录），保持可测。
 * - 所有 id 必须匹配 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`；不含点号，从根上
 *   杜绝 `..` 与路径分隔符，任何拼接都先做包含性校验。
 * - 写入一律走 tmp + rename（原子），读失败返回 undefined 而非抛错。
 * - 参考音频复用 tts.ts 的 `validateReferenceWav`（16-bit PCM），防止把
 *   不可克隆的音频固化进身份。
 * - builtin（内置兜底）只读：不可删除、不可被激活写覆盖、不可原地改内容。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { validateReferenceWav } from './tts.ts'

/** 单个 Profile 参考音频上限（与 MiMo 限制一致）。 */
export const PROFILE_MAX_REFERENCE_BYTES = 10 * 1024 * 1024
/** 最多允许的 Profile 数（防止 id 空间无限增长）。 */
export const MAX_PROFILES = 64

/** 内置兜底 Profile 的固定 id。 */
export const BUILTIN_PROFILE_ID = 'builtin-adai-design-1'

export type VoiceProfileKind = 'builtin' | 'design' | 'clone'
export type VoiceProfileStatus = 'candidate' | 'active' | 'inactive' | 'deleted'

export interface ProfileOrigin {
  /** 原始用户自然语言需求，如"设计一个成熟一点的女声"。 */
  demand?: string
  /** DSH 整理后的 voice design prompt（喂给 voicedesign）。 */
  designPrompt?: string
}

export interface ProfileReference {
  fileName: string
  bytes: number
  sha256: string
}

export interface ProfileSource {
  model?: string
  speed?: number
  stylePrompt?: string
}

/** 持久化的语音身份（profile.json 形状）。 */
export interface VoiceProfile {
  id: string
  name: string
  kind: VoiceProfileKind
  /** true 表示内置兜底，只读。 */
  readOnly: boolean
  status: VoiceProfileStatus
  createdAt: number
  updatedAt: number
  activeAt?: number
  origin: ProfileOrigin
  previewText?: string
  reference: ProfileReference
  source: ProfileSource
  /** 用户是否已批准（候选→正式的关键开关）。 */
  approved: boolean
  note?: string
  /** 上一次被激活的 Profile（用于回滚）。 */
  prevId?: string
  /** 下一次被激活的 Profile（前向链，维护到下一层）。 */
  nextId?: string
}

/** 面板/列表用摘要（不携带内部 origin/source 细节）。 */
export interface ProfileSummary {
  id: string
  name: string
  kind: VoiceProfileKind
  readOnly: boolean
  status: VoiceProfileStatus
  createdAt: number
  updatedAt: number
  approved: boolean
  referenceBytes: number
  referenceSha256: string
  active: boolean
}

export interface ActiveProfileState {
  /** 当前激活的 Profile id；无则 null。 */
  activeId: string | null
  /** 立即前一个激活项（history 末位）；无则 null。 */
  previousId: string | null
  /** 激活历史（旧→新，不含 activeId 本身）；rollback 时 pop。 */
  history: string[]
  updatedAt: number
}

export type ProfileActionErrorCode = 'NOT_FOUND' | 'READ_ONLY' | 'DELETED' | 'ALREADY_ACTIVE' | 'EXISTS' | 'NO_PREVIOUS' | 'INVALID_ID' | 'ACTIVE' | 'INVALID_AUDIO' | 'TOO_LARGE' | 'TOO_MANY'

export type ProfileActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProfileActionErrorCode; message: string }

/** 目录布局常量。 */
const PROFILES_DIR = 'profiles'
const CANDIDATES_DIR = 'candidates'
const TMP_DIR = 'tmp'
const ACTIVE_FILE = 'active-profile.json'
const PROFILE_JSON = 'profile.json'
const REFERENCE_WAV = 'reference.wav'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface ProfilesStore {
  /** 所有 Profile 摘要，按 createdAt 降序；不抛错。 */
  list(): ProfileSummary[]
  /** 读取单个 Profile；不存在/损坏返回 undefined。 */
  get(id: string): VoiceProfile | undefined
  /** 读取指定 Profile 的参考音频 Buffer；不存在/损坏返回 undefined。 */
  readReference(id: string): Buffer | undefined
  /** 当前激活的 Profile；无则 undefined。 */
  peekActive(): VoiceProfile | undefined
  activeState(): ActiveProfileState
  /** 注册（或幂等重建）内置只读兜底。 */
  registerBuiltin(input: { name: string; reference: { fileName: string; buffer: Buffer } }): ProfileActionResult<VoiceProfile>
  /** 将候选/参考音频固化为新 Profile（"设计→固化"入口）。 */
  importReference(input: {
    name: string
    kind: VoiceProfileKind
    buffer: Buffer
    fileName: string
    origin?: ProfileOrigin
    previewText?: string
    source?: ProfileSource
    approved?: boolean
    note?: string
    id?: string
  }): ProfileActionResult<VoiceProfile>
  /**
   * 批准一个候选：把 design 候选提升为已批准的 voiceclone Profile
   * （kind='clone'、approved=true、status='inactive'）。幂等：已批准且
   * 已是 clone 直接返回。内置兜底天然 approved，返回原实例。
   */
  approve(id: string): ProfileActionResult<VoiceProfile>
  /** 激活指定 Profile；记录上一激活项供回滚。 */
  activate(id: string): ProfileActionResult<VoiceProfile>
  /** 回滚到上一激活项；无上一项则失败。 */
  rollback(): ProfileActionResult<VoiceProfile | null>
  /** 删除指定非内置、非激活 Profile。 */
  delete(id: string): ProfileActionResult<{ deletedId: string }>
}

/** 自动生成有序 id（时间戳 + 自增序号），如 profile-20260822-001。 */
function timestampedId(clock: () => number, used: Set<string>): string {
  const date = new Date(clock()).toISOString().slice(0, 10).replaceAll('-', '')
  let n = 1
  let id = `profile-${date}-${String(n).padStart(3, '0')}`
  while (used.has(id)) {
    n += 1
    id = `profile-${date}-${String(n).padStart(3, '0')}`
  }
  return id
}

/** 校验并归一 id；不合法返回 null。 */
export function safeProfileId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!ID_PATTERN.test(trimmed)) return null
  return trimmed
}

/** 规范化绝对路径并统一为 POSIX 分隔形式。 */
function normalizePath(p: string): string {
  return resolve(p).replaceAll('\\', '/').replace(/\/+$/, '')
}

/** 把 parts 拼到 root 下，并强制仍在 root 内部；越界返回 null。 */
function safeJoin(root: string, ...parts: string[]): string | null {
  const joined = normalizePath(join(root, ...parts))
  const rootN = normalizePath(root)
  if (joined !== rootN && !joined.startsWith(`${rootN}/`)) return null
  return joined
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 原子写 JSON（tmp + rename）。 */
function writeJsonAtomically(file: string, value: unknown): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${Math.random().toString(36).slice(2)}`)
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(tmp, { force: true })
    throw new Error('atomic write failed')
  }
}

/** 原子写二进制（tmp + rename）。 */
function writeBufferAtomically(file: string, buffer: Buffer): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${Math.random().toString(36).slice(2)}`)
  writeFileSync(tmp, buffer)
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(tmp, { force: true })
    throw new Error('atomic write failed')
  }
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function assertPath(p: string | null, label: string): string {
  if (!p) throw new Error(`invalid profiles root: ${label}`)
  return p
}

export function createProfilesStore(input: { root: string; now?: () => number }): ProfilesStore {
  const root = normalizePath(input.root)
  const now = input.now ?? (() => Date.now())
  const profilesDir = assertPath(safeJoin(root, PROFILES_DIR), 'profiles')
  const candidatesDir = assertPath(safeJoin(root, CANDIDATES_DIR), 'candidates')
  const tmpDir = assertPath(safeJoin(root, TMP_DIR), 'tmp')
  const activeFile = assertPath(safeJoin(root, ACTIVE_FILE), 'active-profile.json')

  mkdirSync(profilesDir, { recursive: true })
  mkdirSync(candidatesDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })

  /** 已存在的 id 集合（用于唯一性与自动编号）。 */
  function usedIds(): Set<string> {
    const ids = new Set<string>()
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name)
    }
    return ids
  }

  /** 加载单个 Profile（含边界校验）。 */
  function parseProfile(id: string): VoiceProfile | undefined {
    const dir = safeJoin(profilesDir, id)
    if (!dir) return undefined
    return readJson<VoiceProfile>(safeJoin(dir, PROFILE_JSON) ?? '')
  }

  /** 读取参考音频 Buffer；不存在/损坏返回 undefined。 */
  function readReference(id: string): Buffer | undefined {
    const dir = safeJoin(profilesDir, id)
    if (!dir) return undefined
    const file = safeJoin(dir, REFERENCE_WAV)
    if (!file || !existsSync(file)) return undefined
    try {
      return readFileSync(file)
    } catch {
      return undefined
    }
  }

  /** 写出 profile.json 与 reference.wav（原子）。 */
  function persistProfile(profile: VoiceProfile, referenceBuffer?: Buffer): void {
    const dir = safeJoin(profilesDir, profile.id)
    if (!dir) throw new Error('unsafe profile id')
    mkdirSync(dir, { recursive: true })
    writeJsonAtomically(safeJoin(dir, PROFILE_JSON)!, profile)
    if (referenceBuffer) {
      writeBufferAtomically(safeJoin(dir, REFERENCE_WAV)!, referenceBuffer)
    }
  }

  /** 汇总单个 Profile 为摘要，并携带是否激活。 */
  function summarize(profile: VoiceProfile, activeId: string | null): ProfileSummary {
    return {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      readOnly: profile.readOnly,
      status: profile.status,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      approved: profile.approved,
      referenceBytes: profile.reference.bytes,
      referenceSha256: profile.reference.sha256,
      active: profile.id === activeId,
    }
  }

  function activeState(): ActiveProfileState {
    const raw = readJson<Partial<ActiveProfileState>>(activeFile ?? '')
    const activeId = typeof raw?.activeId === 'string' ? raw.activeId : null
    // 兼容旧版本遗留的脏历史：被删除/非法的 Profile 不再构成可回滚目标。
    const history = Array.isArray(raw?.history)
      ? raw.history.filter((x): x is string => typeof x === 'string' && safeProfileId(x) !== undefined && parseProfile(x) !== undefined)
      : []
    // 手动切回较早音色后，历史中可能残留当前 activeId；尾项回滚到自身没有意义。
    while (history.length > 0 && history[history.length - 1] === activeId) history.pop()
    return {
      activeId,
      previousId: history.length > 0 ? history[history.length - 1] : null,
      history,
      updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : 0,
    }
  }

  /** 刷新 active-profile.json（原子）。 */
  function writeActive(state: ActiveProfileState): void {
    writeJsonAtomically(activeFile!, state)
  }

  /** 更新 profile.json 的 status/updatedAt 等，并落地。 */
  function updateProfile(profile: VoiceProfile): void {
    persistProfile(profile)
  }

  /**
   * 应用一次激活：把 targetId 设为当前激活，把 state.history 先前记录的任何
   * 旧激活项降级为 inactive，并持久化 active-profile.json。
   */
  function applyActivation(targetId: string, newHistory: string[]): ProfileActionResult<VoiceProfile> {
    const profile = parseProfile(targetId)
    if (!profile) return { ok: false, code: 'NOT_FOUND', message: `Profile 不存在：${targetId}` }
    // 内置兜底只读（不可删除/覆盖内容），但允许作为默认音色被重新选为当前——
    // 这样用户激活自定义音色后可"回退到内置默认"。其它 readOnly（当前只有内置）仍拒绝。
    if (profile.readOnly && profile.id !== BUILTIN_PROFILE_ID) {
      return { ok: false, code: 'READ_ONLY', message: '内置兜底不可被激活覆盖' }
    }
    const state = activeState()
    if (state.activeId === targetId) {
      return { ok: false, code: 'ALREADY_ACTIVE', message: '该 Profile 已是当前音色' }
    }

    const ts = now()
    // 旧激活项降级为 inactive。
    if (state.activeId) {
      const previous = parseProfile(state.activeId)
      if (previous && previous.id !== targetId) {
        updateProfile({ ...previous, status: 'inactive', updatedAt: ts, nextId: targetId })
      }
    }

    const activated: VoiceProfile = {
      ...profile,
      status: 'active',
      activeAt: ts,
      updatedAt: ts,
      prevId: state.activeId && state.activeId !== targetId ? state.activeId : undefined,
    }
    updateProfile(activated)
    writeActive({ activeId: targetId, previousId: newHistory.length > 0 ? newHistory[newHistory.length - 1] : null, history: newHistory, updatedAt: ts })
    return { ok: true, value: activated }
  }

  return {
    list() {
      const activeId = activeState().activeId
      const out: ProfileSummary[] = []
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const profile = parseProfile(entry.name)
        if (profile) out.push(summarize(profile, activeId))
      }
      out.sort((a, b) => b.createdAt - a.createdAt)
      return out
    },

    get(id) {
      const safe = safeProfileId(id)
      if (!safe) return undefined
      return parseProfile(safe)
    },

    readReference(id) {
      const safe = safeProfileId(id)
      if (!safe) return undefined
      return readReference(safe)
    },

    peekActive() {
      const state = activeState()
      return state.activeId ? parseProfile(state.activeId) : undefined
    },

    activeState,

    registerBuiltin(input) {
      // 内置只读兜底：若已存在，幂等返回现有实例，绝不覆盖用户数据。
      const existing = parseProfile(BUILTIN_PROFILE_ID)
      if (existing) return { ok: true, value: existing }

      const buffer = input.reference.buffer
      if (buffer.length === 0) return { ok: false, code: 'INVALID_AUDIO', message: '内置参考音频为空' }
      if (buffer.length > PROFILE_MAX_REFERENCE_BYTES) {
        return { ok: false, code: 'TOO_LARGE', message: '内置参考音频超过 10MiB 上限' }
      }
      const inspection = validateReferenceWav(buffer)
      if (!inspection.ok) return { ok: false, code: 'INVALID_AUDIO', message: inspection.error ?? '内置参考音频不是有效 WAV' }

      const profile: VoiceProfile = {
        id: BUILTIN_PROFILE_ID,
        name: input.name,
        kind: 'builtin',
        readOnly: true,
        status: 'inactive',
        createdAt: now(),
        updatedAt: now(),
        origin: {},
        reference: {
          fileName: input.reference.fileName,
          bytes: buffer.length,
          sha256: sha256(buffer),
        },
        source: {},
        approved: true,
      }
      persistProfile(profile, buffer)
      return { ok: true, value: profile }
    },

    importReference(input) {
      const buffer = input.buffer
      if (buffer.length === 0) return { ok: false, code: 'INVALID_AUDIO', message: '参考音频为空' }
      if (buffer.length > PROFILE_MAX_REFERENCE_BYTES) {
        return { ok: false, code: 'TOO_LARGE', message: '参考音频超过 10MiB 上限' }
      }
      const inspection = validateReferenceWav(buffer)
      if (!inspection.ok) return { ok: false, code: 'INVALID_AUDIO', message: inspection.error ?? '参考音频不是有效 WAV' }

      // id：允许调用方给合法 id，否则自动生成；任何情况下不覆盖已存在的 Profile。
      const used = usedIds()
      const proposed = input.id === undefined ? undefined : safeProfileId(input.id)
      const id = proposed ?? timestampedId(now, used)
      // id 可能由自动生成，也可能由调用方给出；必须唯一。
      const finalId = safeProfileId(id)
      if (!finalId) return { ok: false, code: 'INVALID_ID', message: 'Profile id 不合法' }
      if (used.has(finalId)) return { ok: false, code: 'EXISTS', message: `Profile 已存在：${finalId}` }
      if (used.size >= MAX_PROFILES) return { ok: false, code: 'TOO_MANY', message: `Profile 数量已达上限 ${MAX_PROFILES}` }

      const ts = now()
      const profile: VoiceProfile = {
        id: finalId,
        name: input.name,
        kind: input.kind,
        readOnly: false,
        status: 'candidate',
        createdAt: ts,
        updatedAt: ts,
        origin: input.origin ?? {},
        ...(input.previewText !== undefined ? { previewText: input.previewText } : {}),
        reference: {
          fileName: input.fileName,
          bytes: buffer.length,
          sha256: sha256(buffer),
        },
        source: input.source ?? {},
        approved: input.approved ?? false,
        ...(input.note !== undefined ? { note: input.note } : {}),
      }
      persistProfile(profile, buffer)
      return { ok: true, value: profile }
    },

    activate(id) {
      const safe = safeProfileId(id)
      if (!safe) return { ok: false, code: 'INVALID_ID', message: 'Profile id 不合法' }
      const profile = parseProfile(safe)
      if (!profile) return { ok: false, code: 'NOT_FOUND', message: `Profile 不存在：${safe}` }

      const state = activeState()
      if (state.activeId === safe) {
        return { ok: false, code: 'ALREADY_ACTIVE', message: '该 Profile 已是当前音色' }
      }
      // 正常激活：把当前激活项压入 history。
      const newHistory = state.activeId ? [...state.history, state.activeId] : [...state.history]
      return applyActivation(safe, newHistory)
    },

    approve(id) {
      const safe = safeProfileId(id)
      if (!safe) return { ok: false, code: 'INVALID_ID', message: 'Profile id 不合法' }
      const profile = parseProfile(safe)
      if (!profile) return { ok: false, code: 'NOT_FOUND', message: `Profile 不存在：${safe}` }
      // 内置兜底天然已批准，无需变更。
      if (profile.readOnly) return { ok: true, value: profile }
      // 幂等：已是批准的 clone。
      if (profile.approved && profile.kind === 'clone') return { ok: true, value: profile }
      const ts = now()
      const approved: VoiceProfile = {
        ...profile,
        approved: true,
        kind: 'clone',
        status: 'inactive',
        updatedAt: ts,
      }
      updateProfile(approved)
      return { ok: true, value: approved }
    },

    rollback() {
      const state = activeState()
      if (state.history.length === 0) return { ok: false, code: 'NO_PREVIOUS', message: '没有可回滚的上一版本' }
      // 单调撤销：pop 出上一项，history 少一个，不再回 toggle。
      const target = state.history[state.history.length - 1]
      const newHistory = state.history.slice(0, -1)
      return applyActivation(target, newHistory)
    },

    delete(id) {
      const safe = safeProfileId(id)
      if (!safe) return { ok: false, code: 'INVALID_ID', message: 'Profile id 不合法' }
      const profile = parseProfile(safe)
      if (!profile) return { ok: false, code: 'NOT_FOUND', message: `Profile 不存在：${safe}` }
      if (profile.readOnly) return { ok: false, code: 'READ_ONLY', message: '内置兜底不可删除' }
      const state = activeState()
      if (state.activeId === safe) return { ok: false, code: 'ACTIVE', message: '不能删除当前激活的音色' }
      const dir = safeJoin(profilesDir, safe)
      if (dir) rmSync(dir, { recursive: true, force: true })
      // 删除也必须同步清理回滚链；并去掉清理后落在尾部的当前音色。
      const history = state.history.filter(id => id !== safe)
      while (history.length > 0 && history[history.length - 1] === state.activeId) history.pop()
      writeActive({
        activeId: state.activeId,
        previousId: history.length > 0 ? history[history.length - 1] : null,
        history,
        updatedAt: now(),
      })
      return { ok: true, value: { deletedId: safe } }
    },
  }
}

/** 留给调用方构造 DSH_HOME/voice-companion 根目录（本模块不猜测路径）。 */
export function profilesRootForDshHome(dshHome: string): string {
  return normalizePath(join(dshHome, 'voice-companion'))
}

/** 解析 DSH_HOME（显式 > DSH_HOME > ~/.dsh，与 secrets.ts 一致），返回 voice-companion 根目录。 */
export function resolveProfilesRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.DSH_HOME?.trim()
  const home = configured ? expandTilde(configured) : join(homedir(), '.dsh')
  return profilesRootForDshHome(home)
}

function expandTilde(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, homedir())
}
