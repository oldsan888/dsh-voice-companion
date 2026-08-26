/**
 * AudioContext 播放器：单例 AudioContext + GainNode 音量；
 * decodeAudioData 后播放；高优先级事件可打断当前 source。
 * 手势解锁由面板负责调用 unlock()（pointerdown/keydown 等监听）。
 */

export interface PlayerPlayOutcome {
  started: boolean
  reason?: 'interrupted' | 'skipped-low-priority' | 'no-context' | 'decode-failed'
}

export interface PlayerSequenceOptions {
  /** 外部中止信号：中止后停止排程与播放。 */
  signal?: AbortSignal
  /** 段间附加间隔（秒），默认 0（无缝衔接）。 */
  gapSec?: number
  /** 每段淡入时长（毫秒），默认 40。 */
  fadeMs?: number
}

export class VoicePlayer {
  private context: AudioContext | undefined
  private gain: GainNode | undefined
  private currentSource: AudioBufferSourceNode | undefined
  /**
   * 全部尚未结束的已排程 source（序列播放会同时排程多段未来播放的 source）。
   * stopCurrent 必须停掉整个集合——只停 currentSource 会留下"幽灵音频"：
   * 静音/清空后已排程的后续段仍会继续出声。
   */
  private readonly liveSources = new Set<AudioBufferSourceNode>()
  private currentResolve: ((outcome: PlayerPlayOutcome) => void) | undefined
  /** 当前正在播放的 priority；-1 = 空闲。 */
  private currentPriority = -1
  private volumeValue = 0.9
  /** 序列播放世代号：stopCurrent/新 playWav 会使旧世代失效。 */
  private epoch = 0

  get state(): AudioContextState | 'uninitialized' {
    return this.context?.state ?? 'uninitialized'
  }

  get playingPriority(): number {
    return this.currentSource !== undefined ? this.currentPriority : -1
  }

  /** 创建/恢复 AudioContext（必须在用户手势内首次调用）。 */
  async unlock(): Promise<AudioContextState> {
    if (this.context === undefined) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctor === undefined) throw new Error('浏览器不支持 Web Audio')
      this.context = new Ctor()
      this.gain = this.context.createGain()
      this.gain.gain.value = this.volumeValue
      this.gain.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
    return this.context.state
  }

  setVolume(value: number): void {
    const clamped = Math.min(1, Math.max(0, value))
    this.volumeValue = clamped
    if (this.gain !== undefined) this.gain.gain.value = clamped
  }

  /**
   * 播放一段 WAV。打断规则：新 priority 严格高于当前 → 停止当前并播放；
   * 相同或更低 → 跳过（同优先级不打断、按队列顺序播）。
   */
  async playWav(data: ArrayBuffer, priority: number): Promise<PlayerPlayOutcome> {
    if (this.context === undefined || this.gain === undefined) {
      return { started: false, reason: 'no-context' }
    }
    if (this.currentSource !== undefined && priority <= this.currentPriority) {
      return { started: false, reason: 'skipped-low-priority' }
    }
    this.stopCurrent()
    let buffer: AudioBuffer
    try {
      buffer = await this.context.decodeAudioData(data)
    } catch {
      return { started: false, reason: 'decode-failed' }
    }
    if (this.context === undefined || this.gain === undefined) {
      return { started: false, reason: 'no-context' }
    }
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    return new Promise(resolve => {
      this.currentResolve = resolve
      source.onended = () => {
        this.liveSources.delete(source)
        if (this.currentSource !== source) return
        this.currentSource = undefined
        this.currentPriority = -1
        this.currentResolve = undefined
        resolve({ started: true })
      }
      this.currentSource = source
      this.liveSources.add(source)
      this.currentPriority = priority
      source.start()
    })
  }

  /** 停止全部已排程播放（静音/清空/卸载/抢占时）。 */
  stopCurrent(): void {
    this.epoch++
    for (const source of this.liveSources) {
      try {
        source.onended = null
        source.stop()
      } catch {
        // 已停止的 source 再 stop 会 throw，忽略。
      }
    }
    this.liveSources.clear()
    this.currentSource = undefined
    this.currentPriority = -1
    const resolve = this.currentResolve
    this.currentResolve = undefined
    resolve?.({ started: true, reason: 'interrupted' })
  }

  /**
   * 流式/分句序列播放（Phase 3 §5.2/§5.3）：按到达顺序 decode 并排程播放，
   * 无缝续接（可配段间间隔与每段淡入）。高优先级 playWav/stopCurrent 会使
   * 本序列作废（返回 interrupted）；外部 signal 中止同理。音量一致：所有段
   * 走同一主 GainNode。
   */
  async playWavSequence(
    segments: AsyncIterable<ArrayBuffer>,
    priority: number,
    options: PlayerSequenceOptions = {},
  ): Promise<PlayerPlayOutcome> {
    const ctx = this.context
    const mainGain = this.gain
    if (ctx === undefined || mainGain === undefined) return { started: false, reason: 'no-context' }
    if (this.currentSource !== undefined && priority <= this.currentPriority) {
      return { started: false, reason: 'skipped-low-priority' }
    }
    this.stopCurrent()
    const { signal, gapSec = 0, fadeMs = 40 } = options
    const epoch = this.epoch
    let nextStart = Math.max(ctx.currentTime + 0.04, 0)
    let startedAny = false
    let streamEnded = false
    let resolve: ((outcome: PlayerPlayOutcome) => void) | undefined
    const outcome = new Promise<PlayerPlayOutcome>(done => { resolve = done })

    const finish = (result: PlayerPlayOutcome): void => {
      if (this.currentResolve === interruptedResolve) this.currentResolve = undefined
      const r = resolve
      resolve = undefined
      r?.(result)
    }
    /**
     * 注册到 currentResolve：stopCurrent（静音/清空/抢占/卸载）会调用它。
     * 否则当全部段已排程完（循环退出）后再被 stopCurrent 打断时，
     * 已排程 source 的 onended 已被置空，本 Promise 将永远悬挂，
     * 播放循环随之死锁（后续事件永不再播）。
     */
    const interruptedResolve = (): void => finish({ started: startedAny, reason: 'interrupted' })
    this.currentResolve = interruptedResolve

    const abortIfNeeded = (): boolean => {
      if (signal?.aborted || this.epoch !== epoch) {
        finish({ started: startedAny, reason: 'interrupted' })
        return true
      }
      return false
    }

    for await (const data of segments) {
      if (abortIfNeeded()) break
      let buffer: AudioBuffer
      try {
        buffer = await ctx.decodeAudioData(data)
      } catch {
        continue // 跳过坏段（不中断整段播报）
      }
      if (abortIfNeeded()) break
      const source = ctx.createBufferSource()
      source.buffer = buffer
      let output: AudioNode = mainGain
      if (fadeMs > 0 && typeof mainGain.context !== 'undefined') {
        try {
          const segmentGain = ctx.createGain() as AudioNode & { gain: AudioParam }
          if (typeof segmentGain.gain.setValueAtTime === 'function') {
            segmentGain.gain.setValueAtTime(0.0001, nextStart)
            segmentGain.gain.exponentialRampToValueAtTime(1, Math.max(nextStart + fadeMs / 1000, nextStart + 0.005))
          }
          segmentGain.connect(mainGain)
          output = segmentGain
        } catch {
          output = mainGain
        }
      }
      source.connect(output)
      source.onended = () => {
        this.liveSources.delete(source)
        if (this.epoch !== epoch) return
        if (this.currentSource === source) {
          this.currentSource = undefined
          this.currentPriority = -1
        }
        // 全部段排程完毕且没有仍在播/待播的 source 才算播放完成，
        // 避免前段结束时后段还在播就提前 resolve。
        if (streamEnded && this.liveSources.size === 0) {
          finish({ started: true })
        }
      }
      this.currentSource = source
      this.liveSources.add(source)
      this.currentPriority = priority
      if (!startedAny) startedAny = true
      source.start(nextStart)
      nextStart += buffer.duration + gapSec
    }
    streamEnded = true
    if (!startedAny) {
      finish({ started: false, reason: 'decode-failed' })
    } else if (this.epoch !== epoch || (signal?.aborted ?? false)) {
      finish({ started: true, reason: 'interrupted' })
    } else if (this.liveSources.size === 0) {
      // 极短音频可能在循环结束前就全部 onended：此处兜底避免悬挂。
      finish({ started: true })
    }
    return outcome
  }

  /** 卸载：停止播放并关闭 AudioContext。 */
  async dispose(): Promise<void> {
    this.stopCurrent()
    const context = this.context
    this.context = undefined
    this.gain = undefined
    if (context !== undefined && context.state !== 'closed') {
      try {
        await context.close()
      } catch {
        // 关闭竞态可忽略。
      }
    }
  }
}
