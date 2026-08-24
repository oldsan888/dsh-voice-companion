/**
 * 多标签页唯一播放器租约（Host 权威，不押 localStorage 竞态）。
 * - 无租约或已过期：第一个 acquire 成为 leader；
 * - renew/release 仅当前持有者成功；takeover 原子替换租约；
 * - 过期惰性判定（now >= expiresAt 即失效），不依赖后台定时器；
 * - clock 注入：单测用假时钟推进时间。
 */

export type Clock = () => number

export interface PlayerLease {
  clientId: string
  expiresAt: number
}

export interface LeaseSnapshot {
  held: boolean
  ownerClientId: string | null
  expiresAt: number
  youAreOwner: boolean
}

export interface LeaseManagerOptions {
  ttlMs: number
  clock?: Clock
}

export class LeaseManager {
  private lease: PlayerLease | undefined

  constructor(private readonly options: LeaseManagerOptions) {}

  get clock(): Clock {
    return this.options.clock ?? Date.now
  }

  /** 当前有效租约（过期视为不存在）。 */
  current(): PlayerLease | undefined {
    const lease = this.lease
    if (lease === undefined) return undefined
    if (this.clock() >= lease.expiresAt) return undefined
    return lease
  }

  private snapshot(youAreOwner: boolean): LeaseSnapshot {
    const lease = this.current()
    return {
      held: lease !== undefined,
      ownerClientId: lease?.clientId ?? null,
      expiresAt: lease?.expiresAt ?? 0,
      youAreOwner,
    }
  }

  /** acquire：无租约/过期 → 授予；已是持有者 → 续期；他人持有 → 拒绝。 */
  acquire(clientId: string): { ok: true; snapshot: LeaseSnapshot } | { ok: false; snapshot: LeaseSnapshot } {
    const now = this.clock()
    const current = this.current()
    if (current === undefined) {
      this.lease = { clientId, expiresAt: now + this.options.ttlMs }
      return { ok: true, snapshot: this.snapshot(true) }
    }
    if (current.clientId === clientId) {
      this.lease = { clientId, expiresAt: now + this.options.ttlMs }
      return { ok: true, snapshot: this.snapshot(true) }
    }
    return { ok: false, snapshot: this.snapshot(false) }
  }

  /** renew：仅持有者成功；过期或他人持有失败。 */
  renew(clientId: string): { ok: boolean; snapshot: LeaseSnapshot } {
    const now = this.clock()
    const current = this.current()
    if (current === undefined || current.clientId !== clientId) {
      return { ok: false, snapshot: this.snapshot(false) }
    }
    this.lease = { clientId, expiresAt: now + this.options.ttlMs }
    return { ok: true, snapshot: this.snapshot(true) }
  }

  /** release：仅持有者可释放；无租约时幂等成功。 */
  release(clientId: string): LeaseSnapshot {
    const current = this.current()
    if (current !== undefined && current.clientId === clientId) this.lease = undefined
    return this.snapshot(false)
  }

  /** takeover：无条件原子替换租约给调用方。 */
  takeover(clientId: string): LeaseSnapshot {
    this.lease = { clientId, expiresAt: this.clock() + this.options.ttlMs }
    return this.snapshot(true)
  }

  /** 该 clientId 当前是否持有租约。 */
  heldBy(clientId: string | null | undefined): boolean {
    if (!clientId) return false
    const current = this.current()
    return current !== undefined && current.clientId === clientId
  }

  /** 插件卸载时清空租约（无论持有者与到期时间）。 */
  reset(): void {
    this.lease = undefined
  }
}
