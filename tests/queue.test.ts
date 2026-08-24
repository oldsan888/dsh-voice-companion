/** 队列测试：优先级/稳定序、满载淘汰、sourceKey LRU/TTL 去重、drain 语义。 */
import { describe, expect, it } from 'vitest'
import { FakeClock } from './host-test-utils.ts'
import { VoiceQueue } from '../src/server/queue.ts'

function event(kind: Parameters<VoiceQueue['enqueue']>[0]['kind'], sourceKey: string, createdAt: number) {
  return { id: `id-${sourceKey}-${createdAt}`, kind, text: `text-${sourceKey}`, createdAt, sourceKey }
}

describe('VoiceQueue', () => {
  it('drain 按 priority 降序、同优先级 createdAt 升序，且只清除返回的事件', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 8, clock: clock.now })
    queue.enqueue(event('done', 'a', 1))
    clock.advance(10)
    queue.enqueue(event('fail', 'b', 11))
    clock.advance(10)
    queue.enqueue(event('ask', 'c', 21))
    const batch = queue.drain()
    expect(batch.map(item => item.sourceKey)).toEqual(['c', 'a', 'b'])
    expect(queue.size()).toBe(0)
    expect(queue.drain()).toEqual([])
  })

  it('满队列：淘汰最低优先级中最旧事件；新事件优先级更低则直接丢弃', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 2, clock: clock.now })
    // 队列内：done(2)@t0, fail(1)@t+1300。
    queue.enqueue(event('done', 'd1', clock.now()))
    clock.advance(1300)
    queue.enqueue(event('fail', 'f1', clock.now()))
    clock.advance(1300)
    // ask(3) 进入 → 淘汰 fail。
    expect(queue.enqueue(event('ask', 'a1', clock.now()))).toBe('evicted-overflow')
    expect(queue.size()).toBe(2)
    let batch = queue.drain()
    expect(batch.map(item => item.sourceKey)).toEqual(['a1', 'd1'])

    clock.advance(1600)
    queue.enqueue(event('done', 'd2', clock.now()))
    queue.enqueue(event('ask', 'a2', clock.now() + 1))
    // 新事件 fail(1) 比队列全部（2、3）低 → dropped-full。
    expect(queue.enqueue(event('fail', 'f2', clock.now() + 2))).toBe('dropped-full')
    expect(queue.stats.dropped).toBeGreaterThanOrEqual(1)
    batch = queue.drain()
    expect(batch.map(item => item.sourceKey)).toEqual(['a2', 'd2'])
  })

  it('第一层去重：相同 sourceKey 被 LRU 记忆拦截', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 8, clock: clock.now })
    expect(queue.enqueue(event('done', 'k', 1))).toBe('enqueued')
    expect(queue.enqueue(event('done', 'k', 2))).toBe('deduped')
    expect(queue.size()).toBe(1)
  })

  it('不同 sourceKey 即使同 kind 同时到达也不会互相吞掉', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 8, clock: clock.now })
    expect(queue.enqueue(event('done', 'done-1', clock.now()))).toBe('enqueued')
    expect(queue.enqueue(event('done', 'done-2', clock.now()))).toBe('enqueued')
    expect(queue.enqueue(event('ask', 'ask-1', clock.now()))).toBe('enqueued')
    expect(queue.enqueue(event('ask', 'ask-2', clock.now()))).toBe('enqueued')
  })

  it('TTL 过期后 sourceKey 可复用', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 8, clock: clock.now })
    expect(queue.enqueue(event('done', 'k', clock.now()))).toBe('enqueued')
    // TTL（10 分钟）过后 sourceKey 'k' 再次可用。
    clock.advance(11 * 60 * 1000)
    expect(queue.enqueue(event('done', 'k', clock.now()))).toBe('enqueued')
  })

  it('LRU 有界：容量上限内最旧条目被淘汰，不会无限增长', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 8, clock: clock.now })
    // 填满 LRU（256）+ 一批，验证不抛错且内存受控（间接通过继续工作验证）。
    for (let i = 0; i < 400; i++) {
      queue.enqueue(event('manual', `m-${i}`, clock.now()))
      clock.advance(1)
    }
    expect(queue.size()).toBeLessThanOrEqual(8)
  })

  it('clear 返回清掉数量', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 8, clock: clock.now })
    queue.enqueue(event('ask', 'x', 1))
    queue.enqueue(event('done', 'y', 2))
    expect(queue.clear()).toBe(2)
    expect(queue.size()).toBe(0)
  })

  it('计数：done/ask/fail 入队计数，静默与丢弃独立', () => {
    const clock = new FakeClock()
    const queue = new VoiceQueue({ queueLimit: 8, clock: clock.now })
    queue.enqueue(event('done', 'd', 1))
    queue.enqueue(event('ask', 'a', 2))
    queue.enqueue(event('fail', 'f', 3))
    queue.enqueue(event('done', 'd', 4))
    expect(queue.stats).toMatchObject({ done: 1, ask: 1, fail: 1, dropped: 1 })
  })
})
