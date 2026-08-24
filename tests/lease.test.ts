/** 租约测试：acquire/renew/release/expiry/takeover；注入 clock，无真实 sleep。 */
import { describe, expect, it } from 'vitest'
import { FakeClock } from './host-test-utils.ts'
import { LeaseManager } from '../src/server/lease.ts'

function manager(ttlMs = 6000) {
  const clock = new FakeClock()
  return { lease: new LeaseManager({ ttlMs, clock: clock.now }), clock }
}

describe('LeaseManager', () => {
  it('无租约时第一个 acquire 成为 leader', () => {
    const { lease } = manager()
    const outcome = lease.acquire('tab-a')
    expect(outcome.ok).toBe(true)
    expect(outcome.snapshot.youAreOwner).toBe(true)
  })

  it('有效租约被他人 acquire 拒绝；过期后可重新获得', () => {
    const { lease, clock } = manager(6000)
    expect(lease.acquire('a').ok).toBe(true)
    expect(lease.acquire('b').ok).toBe(false)
    clock.advance(6001)
    expect(lease.acquire('b').ok).toBe(true)
  })

  it('renew 仅持有者成功并顺延到期时间', () => {
    const { lease, clock } = manager(6000)
    lease.acquire('a')
    clock.advance(2000)
    const renewed = lease.renew('a')
    expect(renewed.ok).toBe(true)
    expect(renewed.snapshot.expiresAt).toBe(clock.now() + 6000)
    clock.advance(1000)
    expect(lease.renew('b').ok).toBe(false)
  })

  it('release 仅持有者生效；无租约时幂等', () => {
    const { lease } = manager()
    lease.acquire('a')
    lease.release('b')
    expect(lease.heldBy('a')).toBe(true)
    lease.release('a')
    expect(lease.current()).toBeUndefined()
    expect(() => lease.release('nobody')).not.toThrow()
  })

  it('takeover 原子替换；旧 owner renew 失败', () => {
    const { lease, clock } = manager()
    lease.acquire('old')
    clock.advance(1000)
    const snapshot = lease.takeover('new-owner')
    expect(snapshot.youAreOwner).toBe(true)
    expect(snapshot.ownerClientId).toBe('new-owner')
    expect(lease.renew('old').ok).toBe(false)
    expect(lease.heldBy('old')).toBe(false)
  })

  it('过期惰性判定：current() 过期即视为不存在', () => {
    const { lease, clock } = manager()
    lease.acquire('a')
    clock.advance(5999)
    expect(lease.current()).toBeDefined()
    clock.advance(2)
    expect(lease.current()).toBeUndefined()
  })
})
