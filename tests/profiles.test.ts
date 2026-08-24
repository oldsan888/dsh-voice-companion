/**
 * Profile 存储单元测试：路径边界、内置只读兜底、候选固化、版本化激活/回滚、
 * 删除限制、SHA-256、WAV 校验、唯一性、文件布局与持久化。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from './host-test-utils.ts'
import {
  createProfilesStore,
  safeProfileId,
  profilesRootForDshHome,
  BUILTIN_PROFILE_ID,
  PROFILE_MAX_REFERENCE_BYTES,
  type VoiceProfile,
} from '../src/server/profiles.ts'
import { inspectWav } from '../src/server/tts.ts'

/** 构造一个合法 16-bit PCM / 24kHz / 单声道 WAV（totalBytes 为文件总长，含 44 字节头）。 */
function makeWav(totalBytes = 4096): Buffer {
  const sampleRate = 24000
  const channels = 1
  const bits = 16
  const dataBytes = Math.max(0, totalBytes - 44)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  const data = Buffer.alloc(dataBytes)
  data.fill(0x11)
  return Buffer.concat([header, data])
}

/** 构造一个编码非 PCM（如 aLaw=6）的 WAV，用于校验拒绝。 */
function makeNonPcmWav(): Buffer {
  const wav = makeWav(512)
  wav.writeUInt16LE(6, 20) // audioFormat=6 (aLaw)，非 PCM
  return wav
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
}

describe('profiles store', () => {
  it('safeProfileId 拒绝越界/危险 id', () => {
    expect(safeProfileId('profile-20260822-001')).toBe('profile-20260822-001')
    expect(safeProfileId('..')).toBeNull()
    expect(safeProfileId('a/b')).toBeNull()
    expect(safeProfileId('a\\b')).toBeNull()
    expect(safeProfileId('')).toBeNull()
    expect(safeProfileId('a b')).toBeNull()
    expect(safeProfileId('a.b')).toBeNull()
    expect(safeProfileId('a..b')).toBeNull()
    expect(safeProfileId(undefined)).toBeNull()
  })

  it('root 路径规范化：profilesRootForDshHome 拼接正确', () => {
    const root = profilesRootForDshHome('E:\\test-dsh-home')
    expect(root.endsWith('voice-companion')).toBe(true)
    expect(root.includes('E:/')).toBe(true) // 反斜杠已归一为正斜杠
  })

  it('registerBuiltin：幂等、产生只读兜底、落盘且不可删除', () => {
    const root = tempRoot()
    const store = createProfilesStore({ root })
    const ref = makeWav(2048)

    const once = store.registerBuiltin({ name: '阿呆·设计音色-1', reference: { fileName: 'voice-reference.wav', buffer: ref } })
    expect(once.ok).toBe(true)
    const builtin = (once as { ok: true; value: VoiceProfile }).value
    expect(builtin.id).toBe(BUILTIN_PROFILE_ID)
    expect(builtin.readOnly).toBe(true)
    expect(builtin.kind).toBe('builtin')
    expect(builtin.reference.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(builtin.reference.bytes).toBe(2048)

    // 幂等：重复注册返回同一实例，不覆盖
    const twice = store.registerBuiltin({ name: 'other', reference: { fileName: 'x.wav', buffer: makeWav(512) } })
    expect(twice.ok).toBe(true)
    expect((twice as { ok: true; value: VoiceProfile }).value.id).toBe(BUILTIN_PROFILE_ID)

    // 只读兜底不可删除；但可作为默认音色被重新激活（回退内置）。
    expect(store.delete(BUILTIN_PROFILE_ID).ok).toBe(false)
    const reactivate = store.activate(BUILTIN_PROFILE_ID)
    expect(reactivate.ok).toBe(true)
    expect((reactivate as { ok: true; value: VoiceProfile }).value.status).toBe('active')

    // 落盘：profiles/<id>/profile.json + reference.wav
    const dir = join(root, 'profiles', BUILTIN_PROFILE_ID)
    expect(existsSync(join(dir, 'profile.json'))).toBe(true)
    expect(existsSync(join(dir, 'reference.wav'))).toBe(true)
    expect(readFileSync(join(dir, 'reference.wav')).length).toBe(2048)

    rmSync(root, { recursive: true, force: true })
  })

  it('importReference：固化为候选、SHA-256、持久化参考音频', () => {
    const root = tempRoot()
    const store = createProfilesStore({ root })
    const result = store.importReference({
      name: '设计女声',
      kind: 'design',
      id: 'design-voice-001',
      buffer: makeWav(3072),
      fileName: 'design.wav',
      origin: { demand: '设计一个成熟一点的女声', designPrompt: 'young female, warm' },
      source: { model: 'mimo-v2.5-tts-voicedesign', speed: 1.1 },
      approved: false,
    })
    expect(result.ok).toBe(true)
    const profile = (result as { ok: true; value: VoiceProfile }).value
    expect(profile.id).toBe('design-voice-001')
    expect(profile.status).toBe('candidate')
    expect(profile.approved).toBe(false)
    expect(profile.readOnly).toBe(false)
    expect(profile.reference.bytes).toBe(3072)
    expect(profile.reference.fileName).toBe('design.wav')
    const persisted = readFileSync(join(root, 'profiles', 'design-voice-001', 'reference.wav'))
    expect(inspectWav(persisted).ok).toBe(true)

    // 同 id 再次固化 → EXISTS
    expect(store.importReference({ name: 'x', kind: 'clone', id: 'design-voice-001', buffer: makeWav(100), fileName: 'x.wav' })).toMatchObject({ ok: false, code: 'EXISTS' })

    // list 含该候选，且非激活
    const list = store.list()
    expect(list.some(p => p.id === 'design-voice-001' && !p.active)).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  it('激活/回滚：记录上一版本并原子落盘 active-profile.json', () => {
    const root = tempRoot()
    const clock = new FakeClock()
    const store = createProfilesStore({ root, now: clock.now })

    store.importReference({ id: 'v1', name: 'v1', kind: 'design', buffer: makeWav(512), fileName: 'v1.wav' })
    clock.advance(1000)
    store.importReference({ id: 'v2', name: 'v2', kind: 'design', buffer: makeWav(512), fileName: 'v2.wav' })

    // 激活 v1
    const a1 = store.activate('v1')
    expect(a1.ok).toBe(true)
    expect(store.peekActive()?.id).toBe('v1')
    expect(store.activeState()).toMatchObject({ activeId: 'v1', previousId: null })

    // 激活 v2 → previousId 变 v1
    const a2 = store.activate('v2')
    expect(a2.ok).toBe(true)
    expect(store.peekActive()?.id).toBe('v2')
    expect(store.activeState()).toMatchObject({ activeId: 'v2', previousId: 'v1' })
    // 旧激活项降级为 inactive
    expect(store.get('v1')?.status).toBe('inactive')

    // 重复激活同项 → ALREADY_ACTIVE
    expect(store.activate('v2')).toMatchObject({ ok: false, code: 'ALREADY_ACTIVE' })

    // 回滚 → 回到 v1
    const roll = store.rollback()
    expect(roll.ok).toBe(true)
    expect(store.peekActive()?.id).toBe('v1')

    // 再回滚（v1 无上一版本）→ NO_PREVIOUS
    expect(store.rollback()).toMatchObject({ ok: false, code: 'NO_PREVIOUS' })

    rmSync(root, { recursive: true, force: true })
  })

  it('回退内置：激活过自定义音色后，可重新激活内置兜底作为默认', () => {
    const root = tempRoot()
    const clock = new FakeClock()
    const store = createProfilesStore({ root, now: clock.now })
    store.registerBuiltin({ name: '内置', reference: { fileName: 'b.wav', buffer: makeWav(512) } })
    store.importReference({ id: 'c1', name: '自定义', kind: 'design', buffer: makeWav(512), fileName: 'c1.wav' })

    store.activate('c1')
    expect(store.peekActive()?.id).toBe('c1')

    // 回退到内置默认（内置只读不变，但可作为默认音色被选回）
    const back = store.activate(BUILTIN_PROFILE_ID)
    expect(back.ok).toBe(true)
    expect(store.peekActive()?.id).toBe(BUILTIN_PROFILE_ID)
    expect(store.activeState()).toMatchObject({ activeId: BUILTIN_PROFILE_ID, previousId: 'c1' })

    rmSync(root, { recursive: true, force: true })
  })

  it('激活不存在/已删除 → 错误码', () => {
    const root = tempRoot()
    const store = createProfilesStore({ root })
    store.importReference({ id: 'gone', name: 'gone', kind: 'design', buffer: makeWav(64), fileName: 'g.wav' })
    store.delete('gone')

    expect(store.activate('nope')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    // delete() 是硬删除（移除目录），之后激活同 id 走 NOT_FOUND。
    expect(store.activate('gone')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(store.activate('bad/id')).toMatchObject({ ok: false, code: 'INVALID_ID' })

    rmSync(root, { recursive: true, force: true })
  })

  it('删除限制：内置/激活不可删，普通可删', () => {
    const root = tempRoot()
    const store = createProfilesStore({ root })
    store.registerBuiltin({ name: 'builtin', reference: { fileName: 'b.wav', buffer: makeWav(256) } })
    store.importReference({ id: 'active1', name: 'a', kind: 'design', buffer: makeWav(256), fileName: 'a.wav' })
    store.importReference({ id: 'idle', name: 'i', kind: 'clone', buffer: makeWav(256), fileName: 'i.wav' })
    store.activate('active1')

    expect(store.delete(BUILTIN_PROFILE_ID)).toMatchObject({ ok: false, code: 'READ_ONLY' })
    expect(store.delete('active1')).toMatchObject({ ok: false, code: 'ACTIVE' })
    expect(store.delete('idle').ok).toBe(true)
    expect(store.get('idle')).toBeUndefined()

    rmSync(root, { recursive: true, force: true })
  })

  it('音频校验：非 PCM / 空 / 过大 → 拒绝', () => {
    const root = tempRoot()
    const store = createProfilesStore({ root })

    expect(store.importReference({ name: 'x', kind: 'design', buffer: makeNonPcmWav(), fileName: 'x.wav' })).toMatchObject({ ok: false, code: 'INVALID_AUDIO' })
    expect(store.importReference({ name: 'x', kind: 'design', buffer: Buffer.alloc(0), fileName: 'x.wav' })).toMatchObject({ ok: false, code: 'INVALID_AUDIO' })
    expect(store.importReference({ name: 'x', kind: 'design', buffer: Buffer.alloc(PROFILE_MAX_REFERENCE_BYTES + 1), fileName: 'x.wav' })).toMatchObject({ ok: false, code: 'TOO_LARGE' })

    rmSync(root, { recursive: true, force: true })
  })

  it('没有默认激活项；list 空 store 为空数组', () => {
    const root = tempRoot()
    const store = createProfilesStore({ root })
    expect(store.peekActive()).toBeUndefined()
    expect(store.activeState()).toEqual({ activeId: null, previousId: null, history: [], updatedAt: 0 })
    expect(store.list()).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('approve：design 候选 → approved clone；幂等；内置返回原实例；不存在 → NOT_FOUND', () => {
    const root = tempRoot()
    const store = createProfilesStore({ root })
    store.importReference({ id: 'cand', name: 'cand', kind: 'design', buffer: makeWav(512), fileName: 'c.wav', approved: false })

    const a = store.approve('cand')
    expect(a.ok).toBe(true)
    const profile = (a as { ok: true; value: VoiceProfile }).value
    expect(profile.approved).toBe(true)
    expect(profile.kind).toBe('clone')
    expect(profile.status).toBe('inactive')

    // 幂等：再次 approve 返回同一 approved clone，不覆盖。
    const again = store.approve('cand')
    expect(again.ok).toBe(true)
    expect((again as { ok: true; value: VoiceProfile }).value.kind).toBe('clone')
    expect((again as { ok: true; value: VoiceProfile }).value.id).toBe('cand')

    // 内置兜底天然 approved，直接返回原实例。
    store.registerBuiltin({ name: 'builtin', reference: { fileName: 'b.wav', buffer: makeWav(256) } })
    const builtin = store.approve(BUILTIN_PROFILE_ID)
    expect(builtin.ok).toBe(true)
    expect((builtin as { ok: true; value: VoiceProfile }).value.readOnly).toBe(true)

    // 不存在 / 非法 id。
    expect(store.approve('nope')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(store.approve('bad/id')).toMatchObject({ ok: false, code: 'INVALID_ID' })

    rmSync(root, { recursive: true, force: true })
  })

  it('自动 id 唯一：同时间戳多次导入不冲突', () => {
    const root = tempRoot()
    const clock = new FakeClock()
    const store = createProfilesStore({ root, now: clock.now })
    for (let i = 0; i < 3; i++) {
      const result = store.importReference({ name: `v${i}`, kind: 'design', buffer: makeWav(64), fileName: 'd.wav' })
      expect(result.ok).toBe(true)
    }
    const ids = store.list().map(p => p.id)
    expect(new Set(ids).size).toBe(3)
    rmSync(root, { recursive: true, force: true })
  })
})
