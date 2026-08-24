/**
 * 浏览器本地偏好（localStorage，带版本键）。
 * 只保存 muted / volume / collapsed / onboardingSeen / mode；
 * 坏数据回退默认值，绝不持久化队列、错误全文、clientId 或音频。
 */
import { PREFERENCES_KEY } from '../shared/constants.ts'

/** 播放模式：identity=身份优先（voiceclone 专属音色，非流式）；speed=速度优先（预置音色真流式）。 */
export type VoicePlaybackMode = 'identity' | 'speed'

export interface VoicePreferences {
  muted: boolean
  /** 0–1。 */
  volume: number
  collapsed: boolean
  onboardingSeen: boolean
  /** 播放模式（Phase 3 §5.2）；默认身份优先，绝不后台静默切换。 */
  mode: VoicePlaybackMode
}

export const DEFAULT_PREFERENCES: Readonly<VoicePreferences> = {
  muted: false,
  volume: 0.9,
  collapsed: true,
  onboardingSeen: false,
  mode: 'identity',
}

function clampVolume(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return DEFAULT_PREFERENCES.volume
  return Math.min(1, Math.max(0, num))
}

/** 读取偏好；缺失/坏数据逐字段回退默认值。 */
export function loadPreferences(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): VoicePreferences {
  if (!storage) return { ...DEFAULT_PREFERENCES }
  try {
    const raw = storage.getItem(PREFERENCES_KEY)
    if (!raw) return { ...DEFAULT_PREFERENCES }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_PREFERENCES.muted,
      volume: clampVolume(parsed.volume),
      collapsed: typeof parsed.collapsed === 'boolean' ? parsed.collapsed : DEFAULT_PREFERENCES.collapsed,
      onboardingSeen: typeof parsed.onboardingSeen === 'boolean' ? parsed.onboardingSeen : DEFAULT_PREFERENCES.onboardingSeen,
      mode: parsed.mode === 'speed' ? 'speed' : 'identity',
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

/** 保存偏好；存储不可用时静默失败（功能不受影响）。 */
export function savePreferences(preferences: VoicePreferences, storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  if (!storage) return
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify({
      muted: preferences.muted,
      volume: clampVolume(preferences.volume),
      collapsed: preferences.collapsed,
      onboardingSeen: preferences.onboardingSeen,
      mode: preferences.mode === 'speed' ? 'speed' : 'identity',
    }))
  } catch {
    // 隐私模式/配额满：偏好不持久化但不影响播放。
  }
}
