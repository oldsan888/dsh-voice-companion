/**
 * 轮次级语音预合成：工具调用时开始合成，成功 turn/end 后绑定到队列事件，
 * 浏览器请求该事件时消费内存 WAV。失败、中断、替换和卸载都会清理。
 */

export interface PrefetchSynthesizer {
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>
}

interface PendingPrefetch {
  readonly turnKey: string
  readonly text: string
  readonly controller: AbortController
  readonly result: Promise<Buffer | undefined>
  expiry: ReturnType<typeof setTimeout>
}

export interface VoicePrefetch {
  /** 开始或替换某轮的预合成；后台失败被收敛为缓存未命中。 */
  prepare(turnKey: string, text: string): void
  /** 是否存在该轮的有效预合成意图。 */
  peek(turnKey: string): { text: string } | undefined
  /** 成功终态把轮次预合成绑定到实际队列事件。 */
  authorize(turnKey: string, eventId: string): boolean
  /** 非成功终态或显式取消时丢弃该轮。 */
  discardTurn(turnKey: string): void
  /** 浏览器按事件消费；文本不一致时安全未命中。每个事件最多消费一次。 */
  consume(eventId: string, text: string): Promise<Buffer | undefined>
  /** 清空已放行但尚未消费的事件（例如用户清空待播）。 */
  clearAuthorized(): void
  /** 卸载时取消并清空全部内存状态。 */
  dispose(): void
}

/** 创建有界的轮次级预合成缓存。 */
export function createVoicePrefetch(
  tts: PrefetchSynthesizer,
  maxEntries = 32,
  turnTtlMs = 120_000,
  eventTtlMs = 30_000,
): VoicePrefetch {
  const byTurn = new Map<string, PendingPrefetch>()
  const byEvent = new Map<string, PendingPrefetch>()
  let disposed = false

  const cancel = (entry: PendingPrefetch): void => {
    if (!entry.controller.signal.aborted) entry.controller.abort(new Error('prefetch-discarded'))
  }

  const removeEntry = (entry: PendingPrefetch): void => {
    clearTimeout(entry.expiry)
    if (byTurn.get(entry.turnKey) === entry) byTurn.delete(entry.turnKey)
    for (const [eventId, candidate] of byEvent) {
      if (candidate === entry) byEvent.delete(eventId)
    }
  }

  const evictOldest = (): void => {
    const oldestTurn = byTurn.values().next().value as PendingPrefetch | undefined
    const oldestEvent = byEvent.values().next().value as PendingPrefetch | undefined
    const oldest = oldestTurn ?? oldestEvent
    if (oldest === undefined) return
    removeEntry(oldest)
    cancel(oldest)
  }

  const expireAfter = (entry: PendingPrefetch, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      removeEntry(entry)
      cancel(entry)
    }, delayMs)
    timer.unref?.()
    return timer
  }

  return {
    prepare(turnKey, text) {
      if (disposed) return
      const prior = byTurn.get(turnKey)
      if (prior !== undefined) {
        byTurn.delete(turnKey)
        cancel(prior)
      }
      while (byTurn.size + byEvent.size >= maxEntries) evictOldest()
      const controller = new AbortController()
      const entry = {} as PendingPrefetch
      Object.assign(entry, {
        turnKey,
        text,
        controller,
        result: tts.synthesize(text, controller.signal).catch(() => undefined),
        expiry: undefined,
      })
      entry.expiry = expireAfter(entry, turnTtlMs)
      byTurn.set(turnKey, entry)
    },
    peek(turnKey) {
      const entry = byTurn.get(turnKey)
      return entry === undefined ? undefined : { text: entry.text }
    },
    authorize(turnKey, eventId) {
      const entry = byTurn.get(turnKey)
      if (entry === undefined) return false
      byTurn.delete(turnKey)
      clearTimeout(entry.expiry)
      byEvent.set(eventId, entry)
      entry.expiry = expireAfter(entry, eventTtlMs)
      return true
    },
    discardTurn(turnKey) {
      const entry = byTurn.get(turnKey)
      if (entry === undefined) return
      byTurn.delete(turnKey)
      cancel(entry)
    },
    async consume(eventId, text) {
      const entry = byEvent.get(eventId)
      if (entry === undefined) return undefined
      byEvent.delete(eventId)
      clearTimeout(entry.expiry)
      if (entry.text !== text) {
        cancel(entry)
        return undefined
      }
      return entry.result
    },
    clearAuthorized() {
      const entries = new Set(byEvent.values())
      byEvent.clear()
      for (const entry of entries) {
        clearTimeout(entry.expiry)
        cancel(entry)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      const entries = new Set([...byTurn.values(), ...byEvent.values()])
      byTurn.clear()
      byEvent.clear()
      for (const entry of entries) cancel(entry)
    },
  }
}
