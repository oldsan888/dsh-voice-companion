/**
 * 有界优先级队列 + 稳定来源去重。
 *
 * - 队列上限 queueLimit；满队列时先淘汰最低优先级中最旧的事件；
 *   新事件若比队列全部事件优先级更低，直接丢弃（dropped 计数）。
 * - drain 返回按 priority 降序、同优先级 createdAt 升序的批次，
 *   并只从队列移除实际返回的事件。
 * - 去重只使用稳定 sourceKey 的有界 LRU/TTL 记忆；不同会话或轮次即使
 *   在极短时间内完成也不能互相吞掉。
 */
import { DEDUPE_LRU_LIMIT, DEDUPE_TTL_MS, VOICE_PRIORITY } from '../shared/constants.ts'
import type { VoiceKind } from '../shared/constants.ts'
import type { VoiceEvent } from './events.ts'

/** 时钟注入点：单测用假时钟，不在测试中真实 sleep。 */
export type Clock = () => number

export interface QueueStats {
  done: number
  ask: number
  fail: number
  silent: number
  dropped: number
}

export type EnqueueOutcome = 'enqueued' | 'deduped' | 'dropped-full' | 'evicted-overflow'

export interface VoiceQueueOptions {
  queueLimit: number
  clock?: Clock
}

/** sourceKey 记忆：Map 插入序即 LRU 序（get 后重插实现 touch）。 */
class SourceKeyMemory {
  private readonly entries = new Map<string, number>()

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly clock: Clock,
  ) {}

  /** 是否在 TTL 内见过该 key；见过则 touch 并返回 true。 */
  seen(key: string): boolean {
    const now = this.clock()
    const at = this.entries.get(key)
    if (at !== undefined) {
      if (now - at < this.ttlMs) {
        this.entries.delete(key)
        this.entries.set(key, now)
        return true
      }
      this.entries.delete(key)
    }
    this.remember(key, now)
    return false
  }

  private remember(key: string, now: number): void {
    this.entries.set(key, now)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

export class VoiceQueue {
  private readonly items: VoiceEvent[] = []
  private readonly memory: SourceKeyMemory
  readonly stats: QueueStats = { done: 0, ask: 0, fail: 0, silent: 0, dropped: 0 }

  constructor(private readonly options: VoiceQueueOptions) {
    this.memory = new SourceKeyMemory(DEDUPE_LRU_LIMIT, DEDUPE_TTL_MS, options.clock ?? Date.now)
  }

  get clock(): Clock {
    return this.options.clock ?? Date.now
  }

  get limit(): number {
    return this.options.queueLimit
  }

  size(): number {
    return this.items.length
  }

  /**
   * 入队一条事件。返回结果语义：
   * - enqueued / evicted-overflow：已进入队列；
   * - deduped / dropped-full：被丢弃（dropped 已计数）。
   */
  enqueue(event: Omit<VoiceEvent, 'priority'>): EnqueueOutcome {
    const now = this.clock()
    // 第一层：sourceKey LRU/TTL 去重。
    if (this.memory.seen(event.sourceKey)) {
      this.stats.dropped++
      return 'deduped'
    }
    const full: VoiceEvent = { ...event, priority: VOICE_PRIORITY[event.kind] }
    if (this.items.length >= this.limit) {
      // 淘汰最低优先级中最旧的；新事件优先级比全部更低则直接丢。
      let victimIndex = 0
      for (let i = 1; i < this.items.length; i++) {
        const victim = this.items[victimIndex]
        const candidate = this.items[i]
        if (candidate.priority < victim.priority
          || (candidate.priority === victim.priority && candidate.createdAt < victim.createdAt)) {
          victimIndex = i
        }
      }
      const victim = this.items[victimIndex]
      if (full.priority < victim.priority) {
        this.stats.dropped++
        return 'dropped-full'
      }
      this.items.splice(victimIndex, 1)
      this.items.push(full)
      this.countKind(event.kind)
      return 'evicted-overflow'
    }
    this.items.push(full)
    this.countKind(event.kind)
    return 'enqueued'
  }

  /** 取出批次：priority 降序、同优先级 createdAt 升序；只清除实际返回的事件。 */
  drain(): VoiceEvent[] {
    const batch = [...this.items].sort((a, b) =>
      b.priority - a.priority || a.createdAt - b.createdAt)
    this.items.length = 0
    return batch
  }

  /** 清空待播；返回清掉的数量（供 clear 路由回显）。 */
  clear(): number {
    const n = this.items.length
    this.items.length = 0
    return n
  }

  private countKind(kind: VoiceKind): void {
    if (kind === 'done') this.stats.done++
    else if (kind === 'ask') this.stats.ask++
    else if (kind === 'fail') this.stats.fail++
  }
}
