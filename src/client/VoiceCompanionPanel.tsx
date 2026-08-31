/**
 * 右下角全局语音控制面板（shell.overlay）。
 * 默认收起为胶囊；展开后提供解锁/静音/音量/试听/清空/接管与诊断。
 * 仅 leader 标签页执行 400ms drain；页面隐藏时释放租约并停止轮询。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PANEL_SLOT_ID } from '../shared/constants.ts'
import { splitSentences } from '../shared/split.ts'
import { activateProfile, clearQueue, drain, getProfileReference, getState, listProfiles, postLease, requestTestVoice, requestTts, requestTtsStream, rollbackProfile, VoiceStreamError } from './api.ts'
import type { VoiceEventDto, VoiceProfileActiveState, VoiceProfileSummary } from '../shared/protocol.ts'
import type { StateResponse } from '../shared/protocol.ts'
import { VoicePlayer } from './player.ts'
import type { PlayerPlayOutcome } from './player.ts'
import { loadPreferences, savePreferences } from './preferences.ts'
import type { VoicePreferences } from './preferences.ts'

/** 每标签页唯一 clientId（sessionStorage，随标签页生命周期）。 */
function ensureClientId(session: Storage): string {
  const key = 'dsh.voice-companion.clientId'
  let value = session.getItem(key)
  if (!value) {
    value = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    session.setItem(key, value)
  }
  return value
}

const KIND_LABEL: Record<string, string> = {
  ask: '提问',
  done: '完成',
  fail: '失败',
  manual: '手动',
}

const PROFILE_KIND_LABEL: Record<VoiceProfileSummary['kind'], string> = {
  builtin: '内置',
  design: '设计',
  clone: '复刻',
}

type AudioActivityPhase = 'synthesizing' | 'playing'

type PanelToggleAnchor = {
  horizontal: 'left' | 'right'
  vertical: 'top' | 'bottom'
  x: number
  y: number
}

export interface VoiceCompanionPanelProps {
  /** 测试注入点：覆盖网络 API（默认真实实现）。 */
  apiOverride?: Partial<typeof import('./api.ts')>
  /** 测试注入点：覆盖轮询间隔。 */
  intervals?: { drainMs?: number; renewMs?: number; stateMs?: number }
}

export function VoiceCompanionPanel({ apiOverride, intervals }: VoiceCompanionPanelProps = {}): React.ReactElement {
  const api = useMemo(() => ({ ...realApi(), ...apiOverride }), [apiOverride])
  const drainMs = intervals?.drainMs ?? 400
  const renewMs = intervals?.renewMs ?? 2000
  const stateMs = intervals?.stateMs ?? 3000

  const [prefs, setPrefs] = useState<VoicePreferences>(() => loadPreferences())
  const [audioReady, setAudioReady] = useState(false)
  const [serverState, setServerState] = useState<StateResponse | undefined>(undefined)
  const [isLeader, setIsLeader] = useState(false)
  const [lastError, setLastError] = useState<string | undefined>(undefined)
  const [playingKind, setPlayingKind] = useState<string | undefined>(undefined)
  const [activityPhase, setActivityPhase] = useState<AudioActivityPhase | undefined>(undefined)
  const [mutedDropped, setMutedDropped] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  // 展开状态持久化：collapsed 偏好曾是死字段（只写不读），现在接线。
  const [expanded, setExpanded] = useState(() => !loadPreferences().collapsed)
  /** 拖动进行中（超过阈值后为 true；用于光标样式与禁用过渡）。 */
  const [dragging, setDragging] = useState(false)

  // ---- 音色 Profile（Phase 1）----
  const [profiles, setProfiles] = useState<VoiceProfileSummary[]>([])
  const [activeState, setActiveState] = useState<VoiceProfileActiveState | undefined>(undefined)
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [profilesError, setProfilesError] = useState<string | undefined>(undefined)
  /** 正在执行的音色变更（id 或 'rollback'）；非 undefined 时禁用全部音色操作，防并发。 */
  const [profileBusy, setProfileBusy] = useState<string | undefined>(undefined)
  /** 正在试听/加载参考音频的 Profile id。 */
  const [previewId, setPreviewId] = useState<string | undefined>(undefined)
  /** 待确认的激活目标。 */
  const [confirmActivate, setConfirmActivate] = useState<VoiceProfileSummary | undefined>(undefined)
  /** 是否正在确认回滚。 */
  const [confirmRollback, setConfirmRollback] = useState(false)

  const clientId = useMemo(() => ensureClientId(window.sessionStorage), [])
  const playerRef = useRef<VoicePlayer | undefined>(undefined)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
    lastPos?: { x: number; y: number }
  } | undefined>(undefined)
  /** 拖动结束后抑制紧随其后的 click（避免拖完误展开面板）。 */
  const suppressClickRef = useRef(false)
  /** 尺寸切换时保持离视口最近的边角不动，避免右/下侧胶囊展开后跳位。 */
  const toggleAnchorRef = useRef<PanelToggleAnchor | undefined>(undefined)
  /** 未拖动展开面板时，收起后精确恢复展开前的胶囊位置。 */
  const collapsedPosRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const pendingCollapsedRestoreRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const leaderRef = useRef(false)
  const pumpingRef = useRef(false)
  const audioAbortRef = useRef<AbortController | undefined>(undefined)
  const pendingEventsRef = useRef<VoiceEventDto[]>([])
  const playbackRunningRef = useRef(false)
  const currentPriorityRef = useRef(-1)

  const updatePrefs = useCallback((patch: Partial<VoicePreferences>): void => {
    setPrefs(previous => {
      const next = { ...previous, ...patch }
      savePreferences(next)
      return next
    })
  }, [])

  // ---- 播放器生命周期 ----
  useEffect(() => {
    const player = new VoicePlayer()
    player.setVolume(loadPreferences().volume)
    playerRef.current = player
    return () => {
      pendingEventsRef.current = []
      audioAbortRef.current?.abort()
      playerRef.current = undefined
      void player.dispose()
    }
  }, [])

  const unlockAudio = useCallback(async (): Promise<void> => {
    const player = playerRef.current
    if (player === undefined) return
    try {
      const state = await player.unlock()
      setAudioReady(state === 'running')
    } catch (error) {
      setLastError(error instanceof Error ? `音频解锁失败：${error.message}` : '音频解锁失败')
    }
  }, [])

  // 全局手势解锁（幂等 resume；不自动播放任何声音）。
  useEffect(() => {
    const handler = (): void => {
      if (playerRef.current === undefined) return
      void unlockAudio()
    }
    window.addEventListener('pointerdown', handler)
    window.addEventListener('mousedown', handler)
    window.addEventListener('keydown', handler)
    window.addEventListener('touchstart', handler)
    return () => {
      window.removeEventListener('pointerdown', handler)
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('keydown', handler)
      window.removeEventListener('touchstart', handler)
    }
  }, [unlockAudio])

  // ---- 租约：可见时持有，隐藏时释放 ----
  useEffect(() => {
    let cancelled = false
    const acquire = async (): Promise<void> => {
      const outcome = await api.postLease('acquire', clientId)
      if (cancelled) return
      if (outcome.ok) {
        setIsLeader(outcome.value.lease.youAreOwner)
        leaderRef.current = outcome.value.lease.youAreOwner
      }
    }
    const release = async (): Promise<void> => {
      await api.postLease('release', clientId)
      setIsLeader(false)
      leaderRef.current = false
    }
    const onVisibility = (): void => {
      if (document.hidden) void release()
      else void acquire()
    }
    const onBeforeUnload = (): void => {
      // 尽力而为；正确性不依赖该事件（租约会过期）。
      void navigator.sendBeacon?.(
        '/api/dsh-voice/lease',
        new Blob([JSON.stringify({ action: 'release', clientId })], { type: 'application/json' }),
      )
    }
    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onBeforeUnload)
      void api.postLease('release', clientId)
      leaderRef.current = false
    }
  }, [api, clientId])

  const takeover = useCallback(async (): Promise<void> => {
    const outcome = await api.postLease('takeover', clientId)
    if (outcome.ok) {
      setIsLeader(outcome.value.lease.youAreOwner)
      leaderRef.current = outcome.value.lease.youAreOwner
    }
  }, [api, clientId])

  // ---- 本地播放调度：同优先级顺序播放，高优先级原子打断当前合成/播放 ----
  /** 可被 AbortSignal 打断的等待（句间停顿用；返回 false 表示被打断）。 */
  const waitAbortable = useCallback((ms: number, signal: AbortSignal): Promise<boolean> => {
    return new Promise(resolve => {
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve(false)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }, [])

  /** 句间停顿（voiceclone 句子级流水；Phase 3 §5.3）。 */
  const SENTENCE_GAP_MS = 240

  /**
   * voiceclone 句子级流水（Phase 3 §5.3）：第一句合成后立播，播放当前句时
   * 并行合成下一句；句间停顿（可中断）；后续句失败不重播已播句、跳过剩余；
   * 高优先级抢占/静音/清空通过 abort 让整个流水立即停止。
   */
  const runSentencePipeline = useCallback(async (
    event: VoiceEventDto,
    sentences: string[],
    controller: AbortController,
  ): Promise<void> => {
    const player = playerRef.current
    if (player === undefined) return
    setActivityPhase('synthesizing')
    let pending = await api.requestTts(sentences[0], event.id, clientId, controller.signal, event.speechDirection)
    if (!pending.ok) {
      if (!controller.signal.aborted) setLastError(`合成失败[${pending.code}]：${pending.message}`)
      return
    }
    for (let idx = 1; idx < sentences.length; idx++) {
      // 合成下一句（并行）与播放当前句同时进行。
      const nextPromise = api.requestTts(sentences[idx], event.id, clientId, controller.signal, event.speechDirection)
      setActivityPhase('playing')
      const played = await player.playWav(pending.value, event.priority)
      if (controller.signal.aborted) return
      if (!played.started && played.reason !== 'decode-failed') return // 被更高优先级抢占/跳过
      const resumed = await waitAbortable(SENTENCE_GAP_MS, controller.signal)
      if (!resumed || controller.signal.aborted) return
      setActivityPhase('synthesizing')
      const next = await nextPromise
      if (!next.ok) {
        // 后续句失败：不重播已播句，跳过剩余并提示。
        if (!controller.signal.aborted) setLastError(`后续句子合成失败[${next.code}]，已跳过`)
        return
      }
      pending = next
    }
    setActivityPhase('playing')
    const last = await player.playWav(pending.value, event.priority)
    if (!last.started && last.reason === 'decode-failed') setLastError('音频解码失败')
  }, [api, clientId, waitAbortable])

  /** 播放单条事件：试听 / 速度优先（真流式）/ 身份优先（单句或句子级流水）。 */
  const playEvent = useCallback(async (event: VoiceEventDto): Promise<void> => {
    const player = playerRef.current
    if (player === undefined) return
    currentPriorityRef.current = event.priority
    setPlayingKind(event.kind)
    const controller = new AbortController()
    audioAbortRef.current = controller
    try {
      if (event.previewProfileId !== undefined) {
        // 音色试听：不走模式，固定最高优先级播放参考音频。
        setActivityPhase('synthesizing')
        const outcome = await api.getProfileReference(event.previewProfileId, clientId, controller.signal)
        if (!outcome.ok) {
          if (!controller.signal.aborted) setLastError(`试听失败[${outcome.code}]：${outcome.message}`)
          return
        }
        setActivityPhase('playing')
        const played = await player.playWav(outcome.value, 9)
        if (!played.started && played.reason === 'decode-failed') setLastError('试听音频解码失败')
        return
      }
      if (prefsRef.current.mode === 'speed') {
        // 速度优先：预置音色真流式（SSE 增量 → 逐段无缝播放）。
        setActivityPhase('synthesizing')
        let played: PlayerPlayOutcome
        try {
          const segments = api.requestTtsStream(event.text, clientId, controller.signal, event.speechDirection)
          setActivityPhase('playing')
          played = await player.playWavSequence(segments, event.priority, { signal: controller.signal, fadeMs: 40 })
        } catch (error) {
          if (!controller.signal.aborted) {
            const code = error instanceof VoiceStreamError ? error.code : 'TTS_UNAVAILABLE'
            setLastError(`流式合成失败[${code}]`)
          }
          return
        }
        if (!played.started && played.reason === 'decode-failed') setLastError('流式音频解码失败')
        return
      }
      // 身份优先：voiceclone 非流式；多句走分句流水。
      const sentences = splitSentences(event.text)
      if (sentences.length <= 1) {
        setActivityPhase('synthesizing')
        const outcome = await api.requestTts(event.text, event.id, clientId, controller.signal, event.speechDirection)
        if (!outcome.ok) {
          if (!controller.signal.aborted) setLastError(`合成失败[${outcome.code}]：${outcome.message}`)
          return
        }
        setActivityPhase('playing')
        const played = await player.playWav(outcome.value, event.priority)
        if (!played.started && played.reason === 'decode-failed') setLastError('音频解码失败')
        return
      }
      await runSentencePipeline(event, sentences, controller)
    } finally {
      if (audioAbortRef.current === controller) {
        audioAbortRef.current = undefined
        currentPriorityRef.current = -1
        setPlayingKind(undefined)
        setActivityPhase(undefined)
      }
    }
  }, [api, clientId, runSentencePipeline])

  const runPlayback = useCallback(async (): Promise<void> => {
    if (playbackRunningRef.current) return
    playbackRunningRef.current = true
    try {
      for (;;) {
        const event = pendingEventsRef.current.shift()
        if (event === undefined) break
        if (prefsRef.current.muted) {
          setMutedDropped(count => count + 1)
          continue
        }
        if (playerRef.current === undefined) break
        await playEvent(event)
      }
    } finally {
      playbackRunningRef.current = false
    }
  }, [playEvent])

  const enqueueForPlayback = useCallback((events: VoiceEventDto[]): void => {
    if (events.length === 0) return
    pendingEventsRef.current.push(...events)
    pendingEventsRef.current.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
    const nextPriority = pendingEventsRef.current[0]?.priority ?? -1
    if (currentPriorityRef.current >= 0 && nextPriority > currentPriorityRef.current) {
      audioAbortRef.current?.abort()
      playerRef.current?.stopCurrent()
    }
    void runPlayback()
  }, [runPlayback])

  // ---- leader 轮询：drain（400ms）/ renew（2s）；状态查询独立 ----
  useEffect(() => {
    let disposed = false
    const pump = async (): Promise<void> => {
      if (disposed || pumpingRef.current || document.hidden || !leaderRef.current) return
      pumpingRef.current = true
      try {
        const outcome = await api.drain(clientId)
        if (disposed) return
        if (!outcome.ok) {
          if (outcome.code === 'NOT_LEADER') {
            leaderRef.current = false
            setIsLeader(false)
          } else {
            setLastError(`拉取失败[${outcome.code}]：${outcome.message}`)
          }
          return
        }
        if (!disposed) enqueueForPlayback(outcome.value.events)
      } catch {
        // 网络抖动留给下一轮。
      } finally {
        pumpingRef.current = false
      }
    }
    const renew = async (): Promise<void> => {
      if (disposed || document.hidden) return
      if (!leaderRef.current) {
        // leader 标签页可能已崩溃/关闭而没来得及 release：
        // 可见的非 leader 页周期性重试 acquire，租约到期后自动接回播放权，
        // 不再依赖用户手动切换标签页可见性或点击"接管"。
        const outcome = await api.postLease('acquire', clientId)
        if (!disposed && outcome.ok && outcome.value.lease.youAreOwner) {
          leaderRef.current = true
          setIsLeader(true)
        }
        return
      }
      const outcome = await api.postLease('renew', clientId)
      if (disposed) return
      if (!outcome.ok || !outcome.value.lease.youAreOwner) {
        leaderRef.current = false
        setIsLeader(false)
      }
    }
    const refreshState = async (): Promise<void> => {
      if (disposed || document.hidden) return
      const outcome = await api.getState(clientId)
      if (!disposed && outcome.ok) setServerState(outcome.value)
    }
    const drainTimer = window.setInterval(() => void pump(), drainMs)
    const renewTimer = window.setInterval(() => void renew(), renewMs)
    const stateTimer = window.setInterval(() => void refreshState(), stateMs)
    void refreshState()
    return () => {
      disposed = true
      window.clearInterval(drainTimer)
      window.clearInterval(renewTimer)
      window.clearInterval(stateTimer)
    }
  }, [api, clientId, drainMs, renewMs, stateMs, enqueueForPlayback])

  // ---- 操作 ----
  const toggleMute = useCallback((): void => {
    const nextMuted = !prefs.muted
    updatePrefs({ muted: nextMuted })
    if (nextMuted) {
      const dropped = pendingEventsRef.current.length
      pendingEventsRef.current = []
      if (dropped > 0) setMutedDropped(count => count + dropped)
      playerRef.current?.stopCurrent()
      audioAbortRef.current?.abort()
      currentPriorityRef.current = -1
      setPlayingKind(undefined)
      setActivityPhase(undefined)
    }
  }, [prefs.muted, updatePrefs])

  const changeVolume = useCallback((value: number): void => {
    updatePrefs({ volume: value })
    playerRef.current?.setVolume(value)
  }, [updatePrefs])

  const testVoice = useCallback(async (): Promise<void> => {
    const player = playerRef.current
    if (player === undefined) return
    setLastError(undefined)
    await unlockAudio()
    const controller = new AbortController()
    // 显式试听接管本地播放器；清掉已从 Host 领取但尚未播放的旧事件，
    // 避免队列协程在试听结束前后并发恢复。
    pendingEventsRef.current = []
    audioAbortRef.current?.abort()
    player.stopCurrent()
    audioAbortRef.current = controller
    currentPriorityRef.current = 9
    setPlayingKind('manual')
    try {
      setActivityPhase('synthesizing')
      const outcome = await api.requestTestVoice(clientId, controller.signal)
      if (!outcome.ok) {
        // 被音色参考试听或其它高优先级操作抢占属于正常取消，不向用户报错。
        if (!controller.signal.aborted) setLastError(`试听失败[${outcome.code}]：${outcome.message}`)
        return
      }
      // 试听优先级最高：不受队列影响，但尊重音量。
      setActivityPhase('playing')
      const played = await player.playWav(outcome.value, 9)
      if (!played.started && played.reason === 'decode-failed') setLastError('试听音频解码失败')
    } finally {
      if (audioAbortRef.current === controller) {
        audioAbortRef.current = undefined
        currentPriorityRef.current = -1
        setPlayingKind(undefined)
        setActivityPhase(undefined)
      }
    }
  }, [api, clientId, unlockAudio])

  const clearPending = useCallback(async (): Promise<void> => {
    const outcome = await api.clearQueue(clientId)
    if (!outcome.ok) setLastError(`清空失败[${outcome.code}]：${outcome.message}`)
    pendingEventsRef.current = []
    audioAbortRef.current?.abort()
    playerRef.current?.stopCurrent()
    currentPriorityRef.current = -1
    setPlayingKind(undefined)
    setActivityPhase(undefined)
  }, [api, clientId])

  // ---- 音色 Profile 操作（Phase 1）----
  const fetchProfiles = useCallback(async (): Promise<void> => {
    setProfilesLoading(true)
    setProfilesError(undefined)
    const outcome = await api.listProfiles()
    if (outcome.ok) {
      setProfiles(outcome.value.profiles)
      setActiveState(outcome.value.active)
    } else {
      setProfilesError(`[${outcome.code}] ${outcome.message}`)
    }
    setProfilesLoading(false)
  }, [api])

  /** 试听某个音色的参考音频（leader-only GET）。无持久副作用，无需确认。 */
  const previewProfile = useCallback(async (id: string): Promise<void> => {
    const player = playerRef.current
    if (player === undefined || !isLeader) return
    setLastError(undefined)
    await unlockAudio()
    const controller = new AbortController()
    // 与显式试听一致：接管播放器并清掉尚未播放的旧事件，避免队列协程并发恢复。
    pendingEventsRef.current = []
    audioAbortRef.current?.abort()
    player.stopCurrent()
    audioAbortRef.current = controller
    currentPriorityRef.current = 9
    setPreviewId(id)
    setPlayingKind('manual')
    try {
      setActivityPhase('synthesizing')
      const outcome = await api.getProfileReference(id, clientId, controller.signal)
      if (!outcome.ok) {
        if (!controller.signal.aborted) setLastError(`试听失败[${outcome.code}]：${outcome.message}`)
        return
      }
      setActivityPhase('playing')
      const played = await player.playWav(outcome.value, 9)
      if (!played.started && played.reason === 'decode-failed') setLastError('音色试听音频解码失败')
    } finally {
      setPreviewId(undefined)
      if (audioAbortRef.current === controller) {
        audioAbortRef.current = undefined
        currentPriorityRef.current = -1
        setPlayingKind(undefined)
        setActivityPhase(undefined)
      }
    }
  }, [api, clientId, isLeader, unlockAudio])

  /** 点击启用：先弹确认，再执行激活。 */
  const requestActivate = useCallback((profile: VoiceProfileSummary): void => {
    // readOnly 只表示音色内容不可修改/删除；内置音色仍必须能被重新选为默认。
    if (!isLeader || profileBusy !== undefined) return
    setConfirmActivate(profile)
  }, [isLeader, profileBusy])

  const doActivate = useCallback(async (): Promise<void> => {
    const target = confirmActivate
    if (target === undefined) return
    setConfirmActivate(undefined)
    setProfileBusy(target.id)
    const outcome = await api.activateProfile(target.id, clientId)
    if (outcome.ok) {
      setLastError(undefined)
    } else {
      setLastError(`启用失败[${outcome.code}]：${outcome.message}`)
    }
    await fetchProfiles()
    setProfileBusy(undefined)
  }, [api, confirmActivate, clientId, fetchProfiles])

  const cancelActivate = useCallback((): void => {
    setConfirmActivate(undefined)
  }, [])

  const requestRollback = useCallback((): void => {
    if (!isLeader || profileBusy !== undefined) return
    setConfirmRollback(true)
  }, [isLeader, profileBusy])

  const doRollback = useCallback(async (): Promise<void> => {
    setConfirmRollback(false)
    setProfileBusy('rollback')
    const outcome = await api.rollbackProfile(clientId)
    if (outcome.ok) {
      setLastError(undefined)
    } else {
      setLastError(`回滚失败[${outcome.code}]：${outcome.message}`)
    }
    await fetchProfiles()
    setProfileBusy(undefined)
  }, [api, clientId, fetchProfiles])

  const cancelRollback = useCallback((): void => {
    setConfirmRollback(false)
  }, [])

  // 面板展开时拉取一次音色列表；仅 leader 才能执行有副作用的操作。
  useEffect(() => {
    if (!expanded) return
    void fetchProfiles()
  }, [expanded, fetchProfiles])

  const captureToggleAnchor = useCallback((): void => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const horizontal = rect.left + rect.width / 2 <= window.innerWidth / 2 ? 'left' : 'right'
    const vertical = rect.top + rect.height / 2 <= window.innerHeight / 2 ? 'top' : 'bottom'
    toggleAnchorRef.current = {
      horizontal,
      vertical,
      x: horizontal === 'left' ? rect.left : rect.right,
      y: vertical === 'top' ? rect.top : rect.bottom,
    }
  }, [])

  const expandPanel = useCallback((): void => {
    const pos = prefsRef.current.panelPos
    collapsedPosRef.current = pos === undefined ? undefined : { ...pos }
    if (pos !== undefined) captureToggleAnchor()
    setExpanded(true)
    updatePrefs({ onboardingSeen: true, collapsed: false })
  }, [captureToggleAnchor, updatePrefs])

  const collapsePanel = useCallback((): void => {
    const restore = collapsedPosRef.current
    collapsedPosRef.current = undefined
    if (restore !== undefined) pendingCollapsedRestoreRef.current = restore
    else if (prefsRef.current.panelPos !== undefined) captureToggleAnchor()
    setExpanded(false)
    updatePrefs({ onboardingSeen: true, collapsed: true })
  }, [captureToggleAnchor, updatePrefs])

  // ---- 自由拖动（胶囊整体可拖；面板以头部为把手）----
  /** 把候选位置钳制在视口内（8px 边距；面板/胶囊尺寸实时测量）。 */
  const clampPos = useCallback((x: number, y: number): { x: number; y: number } => {
    const margin = 8
    const element = rootRef.current
    const width = element?.offsetWidth || 120
    const height = element?.offsetHeight || 44
    const maxX = Math.max(margin, window.innerWidth - width - margin)
    const maxY = Math.max(margin, window.innerHeight - height - margin)
    return {
      x: Math.round(Math.min(Math.max(x, margin), maxX)),
      y: Math.round(Math.min(Math.max(y, margin), maxY)),
    }
  }, [])

  const onDragPointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // 把手内的交互元素（如面板收起按钮）不触发拖动。
    if ((event.target as HTMLElement).closest('[data-vcp-nodrag]') !== null) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const onDragPointerMove = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (drag === undefined || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    if (!drag.moved) {
      // 4px 阈值区分点击与拖动。
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      drag.moved = true
      // 用户主动移动展开面板后，新位置应成为事实，不再恢复到展开前的胶囊位置。
      if (expanded) collapsedPosRef.current = undefined
      setDragging(true)
    }
    const next = clampPos(drag.originX + dx, drag.originY + dy)
    drag.lastPos = next
    // 拖动过程只更新内存状态；localStorage 在 pointerup 时写一次。
    setPrefs(previous => ({ ...previous, panelPos: next }))
  }, [clampPos, expanded])

  const onDragPointerEnd = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (drag === undefined || event.pointerId !== drag.pointerId) return
    dragRef.current = undefined
    setDragging(false)
    if (drag.moved) {
      suppressClickRef.current = true
      if (drag.lastPos !== undefined) updatePrefs({ panelPos: drag.lastPos })
    }
  }, [updatePrefs])

  // 视口尺寸变化时把已固定的位置重新钳回可见区域。
  useEffect(() => {
    const onResize = (): void => {
      const pos = prefsRef.current.panelPos
      if (pos === undefined) return
      const next = clampPos(pos.x, pos.y)
      if (next.x !== pos.x || next.y !== pos.y) updatePrefs({ panelPos: next })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampPos, updatePrefs])

  // 展开/收起后尺寸变化：保持最近边角；未拖动时收起精确回到原胶囊位置。
  useLayoutEffect(() => {
    const element = rootRef.current
    const restore = pendingCollapsedRestoreRef.current
    pendingCollapsedRestoreRef.current = undefined
    const anchor = toggleAnchorRef.current
    toggleAnchorRef.current = undefined
    const pos = prefsRef.current.panelPos
    if (pos === undefined || element === null) return
    const candidate = restore ?? (anchor === undefined
      ? pos
      : {
          x: anchor.horizontal === 'right' ? anchor.x - element.offsetWidth : anchor.x,
          y: anchor.vertical === 'bottom' ? anchor.y - element.offsetHeight : anchor.y,
        })
    const next = clampPos(candidate.x, candidate.y)
    if (next.x !== pos.x || next.y !== pos.y) updatePrefs({ panelPos: next })
  }, [expanded, clampPos, updatePrefs])

  // ---- 派生显示 ----
  const ttsStatus = serverState?.tts.status
  const pillText = prefs.muted
    ? '已静音'
    : activityPhase === 'synthesizing'
      ? '合成中'
      : activityPhase === 'playing'
        ? '播放中'
        : !audioReady
          ? '点击启用'
          : ttsStatus === 'ready'
            ? '空闲中'
            : ttsStatus === 'unconfigured'
              ? 'TTS 未配置'
              : 'TTS 离线'
  // 静音/未解锁不该显示绿色"正常"圆点：静音与待启用用中性灰。
  const pillDotClass = prefs.muted || !audioReady
    ? 'vcp-dot idle'
    : ttsStatus === 'ready' ? 'vcp-dot' : 'vcp-dot warn'

  const counts = serverState?.counts
  const pending = serverState?.queue.pending ?? 0
  const ttsLabel = ttsStatus === 'ready'
    ? 'TTS 服务就绪'
    : ttsStatus === 'unconfigured'
      ? 'TTS 尚未配置'
      : ttsStatus === 'error'
        ? 'TTS 服务异常'
        : '正在检查 TTS'
  const ttsNote = playingKind !== undefined && activityPhase === 'synthesizing'
    ? `正在合成：${KIND_LABEL[playingKind] ?? playingKind}`
    : playingKind !== undefined && activityPhase === 'playing'
      ? `正在播：${KIND_LABEL[playingKind] ?? playingKind}`
      : prefs.muted
        ? '当前已静音'
        : '随时可以播报'

  // ---- 音色派生显示 ----
  const activeProfile = profiles.find(p => p.active)
  const fallbackBuiltin = profiles.find(p => p.kind === 'builtin' && !p.active)
  const currentVoiceName = activeProfile?.name ?? fallbackBuiltin?.name ?? '未设置'
  const canRollback = Boolean(activeState?.previousId)
  const anyProfileBusy = profileBusy !== undefined || previewId !== undefined
  const profilesDisabled = !isLeader || anyProfileBusy
  const rootClass = [
    'vcp-root',
    dragging ? 'dragging' : '',
    prefs.muted ? 'is-muted' : '',
    activityPhase === 'synthesizing' ? 'is-synthesizing' : '',
    activityPhase === 'playing' ? 'is-playing' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={rootClass}
      ref={rootRef}
      style={prefs.panelPos !== undefined
        ? { left: prefs.panelPos.x, top: prefs.panelPos.y, right: 'auto', bottom: 'auto' }
        : undefined}
    >
      {!prefs.onboardingSeen && (
        <div className='vcp-onboarding' data-testid='voice-onboarding'>
          <strong>打开声音</strong>
          <p>任务完成、提问和异常会用语音提醒。</p>
          <button
            type='button' className='vcp-btn primary' data-testid='voice-onboarding-enable'
            onClick={() => { void unlockAudio(); updatePrefs({ onboardingSeen: true }) }}
          >
            启用声音
          </button>
        </div>
      )}
      {expanded ? (
        <div className='vcp-panel' data-testid='voice-panel'>
          <div
            className='vcp-head'
            onPointerDown={onDragPointerDown}
            onPointerMove={onDragPointerMove}
            onPointerUp={onDragPointerEnd}
            onPointerCancel={onDragPointerEnd}
            title='按住拖动面板'
          >
            <span className='vcp-brandmark' aria-hidden='true'>
              <i className='vcp-voice-core' />
              <i className='vcp-voice-wave inner' />
              <i className='vcp-voice-wave outer' />
            </span>
            <div className='vcp-heading'>
              <div className='vcp-title'>语音</div>
              <div className='vcp-subtitle'>
                <span className='vcp-leader'>
                  <span className={isLeader ? 'vcp-dot' : 'vcp-dot idle'} />
                  {isLeader ? '本页播放' : '另一个标签页播放'}
                </span>
              </div>
            </div>
            <button type='button' className='vcp-icon-btn' data-vcp-nodrag onClick={collapsePanel} title='收起' aria-label='收起面板'>
              <span aria-hidden='true'>×</span><span className='vcp-sr-only'>收起</span>
            </button>
          </div>
          <div className='vcp-body'>
            {!audioReady && (
              <button type='button' className='vcp-btn primary' onClick={() => void unlockAudio()}>启用浏览器声音</button>
            )}
            <div className='vcp-service'>
              <div className='vcp-service-main'>
                <span className={pillDotClass} />
                <div>
                  <div className='vcp-service-title'>{ttsLabel}</div>
                  <div className='vcp-service-note'>{ttsNote}</div>
                </div>
              </div>
              <div className='vcp-queue'><strong>{pending}</strong>待播</div>
            </div>
            <div className='vcp-profiles' data-testid='voice-profiles'>
              <div className='vcp-profiles-head'>
                <span>音色</span>
                <strong data-testid='voice-current-voice' title={currentVoiceName}>{currentVoiceName}</strong>
              </div>
              {profilesLoading && (
                <div className='vcp-profiles-note' data-testid='voice-profiles-loading'>正在加载音色…</div>
              )}
              {!profilesLoading && profilesError !== undefined && (
                <div className='vcp-profiles-error' data-testid='voice-profiles-error'>
                  <span>{profilesError}</span>
                  <button type='button' className='vcp-btn' data-testid='voice-profiles-retry' onClick={() => void fetchProfiles()}>重试</button>
                </div>
              )}
              {!profilesLoading && profilesError === undefined && profiles.length === 0 && (
                <div className='vcp-profiles-note' data-testid='voice-profiles-empty'>暂无音色，使用默认内置音色。</div>
              )}
              {!profilesLoading && profilesError === undefined && profiles.length > 0 && (
                <ul className='vcp-profiles-list'>
                  {profiles.map(profile => {
                    const isActive = profile.active
                    const isBusy = profileBusy === profile.id
                    const isPreviewing = previewId === profile.id
                    const enableDisabled = profile.active || profilesDisabled || isBusy
                    const previewDisabled = profilesDisabled || isBusy
                    const isBuiltin = profile.kind === 'builtin'
                    const enableLabel = profile.active
                      ? '当前'
                      : isBusy
                        ? '处理中'
                        : isBuiltin
                          ? '回退默认'
                          : '启用'
                    return (
                      <li
                        key={profile.id}
                        className={`vcp-profile-row${isActive ? ' active' : ''}`}
                        data-testid={`voice-profile-row-${profile.id}`}
                      >
                        <div className='vcp-profile-main'>
                          <span className='vcp-profile-name'>{profile.name}</span>
                          <span className='vcp-profile-badges'>
                            <span className='vcp-profile-kind'>{PROFILE_KIND_LABEL[profile.kind]}</span>
                            {isActive && <span className='vcp-profile-activebadge' data-testid={`voice-profile-active-${profile.id}`}>当前</span>}
                          </span>
                        </div>
                        <div className='vcp-profile-actions'>
                          <button
                            type='button' className='vcp-btn' data-testid={`voice-profile-preview-${profile.id}`}
                            disabled={previewDisabled}
                            title='试听该音色'
                            onClick={() => void previewProfile(profile.id)}
                          >
                            {isPreviewing ? '试听中' : '试听'}
                          </button>
                          <button
                            type='button' className='vcp-btn primary' data-testid={`voice-profile-enable-${profile.id}`}
                            disabled={enableDisabled}
                            title={profile.active ? '已是当前音色' : isBuiltin ? '回到内置默认音色' : '启用该音色'}
                            onClick={() => requestActivate(profile)}
                          >
                            {enableLabel}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {!profilesLoading && profilesError === undefined && profiles.length > 0 && (
                <div className='vcp-profiles-foot'>
                  <button
                    type='button' className='vcp-btn' data-testid='voice-profile-rollback'
                    disabled={!canRollback || profilesDisabled}
                    title={canRollback ? '回滚到上一启用音色' : '没有可回滚的版本'}
                    onClick={requestRollback}
                  >
                    {profileBusy === 'rollback' ? '回滚中' : '回滚'}
                  </button>
                  <span className='vcp-profiles-hint'>{isLeader ? '本页为播放方，可更改音色' : '另一个标签页播放中，仅可查看'}</span>
                </div>
              )}
            </div>
            {(confirmActivate !== undefined || confirmRollback) && (
              <div className='vcp-confirm' data-testid='voice-profile-confirm'>
                {confirmActivate !== undefined ? (
                  <>
                    <span>把当前音色切换为「{confirmActivate.name}」？后续播报将使用该音色。</span>
                    <div className='vcp-confirm-actions'>
                      <button type='button' className='vcp-btn primary' data-testid='voice-profile-activate-confirm' onClick={() => void doActivate()}>确认启用</button>
                      <button type='button' className='vcp-btn' data-testid='voice-profile-activate-cancel' onClick={cancelActivate}>取消</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span>回滚到上一个启用的音色？</span>
                    <div className='vcp-confirm-actions'>
                      <button type='button' className='vcp-btn primary' data-testid='voice-profile-rollback-confirm' onClick={() => void doRollback()}>确认回滚</button>
                      <button type='button' className='vcp-btn' data-testid='voice-profile-rollback-cancel' onClick={cancelRollback}>取消</button>
                    </div>
                  </>
                )}
              </div>
            )}
            <div className='vcp-control-label'>
              <span>播放模式</span><strong data-testid='voice-mode-label'>{prefs.mode === 'speed' ? '速度优先 · 预置音色' : '身份优先 · 专属音色'}</strong>
            </div>
            <div className='vcp-mode'>
              <button
                type='button' className='vcp-btn' data-testid='voice-mode-toggle'
                onClick={() => {
                  updatePrefs({ mode: prefs.mode === 'speed' ? 'identity' : 'speed' })
                  // 切换模式即停止当前合成/播放；剩余队列稍后按新模式重放。
                  audioAbortRef.current?.abort()
                  playerRef.current?.stopCurrent()
                }}
                title={prefs.mode === 'speed' ? '切回专属音色（voiceclone 非流式）' : '改用预置音色真流式（声音非专属）'}
              >
                {prefs.mode === 'speed' ? '切回专属音色' : '速度优先（预置）'}
              </button>
              <span className='vcp-profiles-hint'>
                {prefs.mode === 'speed' ? '真流式 · 低延迟 · 非专属音色' : 'voiceclone · 专属音色 · 分句流水'}
              </span>
            </div>
            <div className='vcp-control-label'>
              <span>播放音量</span><strong>{Math.round(prefs.volume * 100)}%</strong>
            </div>
            <div className='vcp-volume'>
              <button type='button' className='vcp-btn' data-testid='voice-mute' onClick={toggleMute}>
                {prefs.muted ? '取消静音' : '静音'}
              </button>
              <input
                type='range' min={0} max={1} step={0.05} className='vcp-slider'
                value={prefs.volume} aria-label='音量'
                onChange={event => changeVolume(Number(event.target.value))}
              />
            </div>
            <div className='vcp-actions'>
              <button type='button' className='vcp-btn primary' data-testid='voice-test' disabled={!isLeader} onClick={() => void testVoice()}>
                播放试听
              </button>
              <button
                type='button' className='vcp-btn danger' data-testid='voice-clear'
                disabled={!isLeader} onClick={() => void clearPending()}
              >
                清空待播{pending > 0 ? ` (${pending})` : ''}
              </button>
              {!isLeader && (
                <button type='button' className='vcp-btn primary wide' data-testid='voice-takeover' onClick={() => void takeover()}>
                  在此页面接管
                </button>
              )}
            </div>
            {playingKind !== undefined && activityPhase !== undefined && (
              <div className='vcp-now-playing'>
                {activityPhase === 'synthesizing' ? '正在合成' : '正在播'}：{KIND_LABEL[playingKind] ?? playingKind}
              </div>
            )}
            {mutedDropped > 0 && <div className='vcp-service-note'>静音丢弃 {mutedDropped}</div>}
            {serverState?.tts.detail !== undefined && (
              <div className='vcp-error'>{serverState.tts.detail}</div>
            )}
            {lastError !== undefined && <div className='vcp-error'>{lastError}</div>}
            <details
              className='vcp-details' data-testid='voice-diagnostics'
              open={showDetails} onToggle={event => setShowDetails((event.target as HTMLDetailsElement).open)}
            >
              <summary>运行详情</summary>
              <div>
                三通道计数 —— 完成 {counts?.done ?? 0} · 提问 {counts?.ask ?? 0} · 失败 {counts?.fail ?? 0} · 静默 {counts?.silent ?? 0} · 丢弃 {counts?.dropped ?? 0}
                <br />
                租约：{isLeader ? '本页持有' : serverState?.lease.ownedByOther ? '其他标签页持有' : '空闲'} · clientId {clientId.slice(0, 8)}
              </div>
            </details>
          </div>
        </div>
      ) : (
        <button
          type='button' className='vcp-pill' data-testid='voice-pill' id={PANEL_SLOT_ID}
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerEnd}
          onPointerCancel={onDragPointerEnd}
          onClick={() => {
            // 拖动结束后的合成 click 不展开面板。
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            expandPanel()
          }}
          title='语音插件（可拖动）'
        >
          <span className='vcp-brandmark' aria-hidden='true'>
            <i className='vcp-voice-core' />
            <i className='vcp-voice-wave inner' />
            <i className='vcp-voice-wave outer' />
          </span>
          <span className='vcp-pill-label' data-testid='voice-pill-label'>{pillText}</span>
          <span className={pillDotClass} />
          {!isLeader && audioReady && <span className='vcp-sr-only'>另一个标签页播放中</span>}
        </button>
      )}
    </div>
  )
}

/** 真实 API 引用（测试可用 apiOverride 替换）。 */
function realApi() {
  return {
    postLease,
    drain,
    getState,
    requestTts,
    requestTtsStream,
    requestTestVoice,
    clearQueue,
    listProfiles,
    getProfileReference,
    activateProfile,
    rollbackProfile,
  }
}
