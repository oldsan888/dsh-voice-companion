/**
 * 浏览器本地偏好（localStorage，带版本键）。
 * 只保存 muted / volume / collapsed / onboardingSeen / mode / panelPos；
 * 坏数据回退默认值，绝不持久化队列、错误全文、clientId 或音频。
 */
import { PREFERENCES_KEY } from '../shared/constants.ts'

/** 播放模式：identity=身份优先（voiceclone 专属音色，非流式）；speed=速度优先（预置音色真流式）。 */
export type VoicePlaybackMode = 'identity' | 'speed'

/** 面板拖动后的固定位置（视口 left/top，px）；未拖动时缺省（默认右下角）。 */
export interface VoicePanelPosition {
  x: number
  y: number
}

export interface VoicePreferences {
  muted: boolean
  /** 0–1。 */
  volume: number
  collapsed: boolean
  onboardingSeen: boolean
  /** 播放模式（Phase 3 §5.2）；默认身份优先，绝不后台静默切换。 */
  mode: VoicePlaybackMode
  /** 拖动后的面板位置；undefined = 默认右下角。 */
  panelPos?: VoicePanelPosition
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

/** 解析持久化的面板位置；非法数据回退 undefined（默认右下角）。 */
function parsePanelPos(value: unknown): VoicePanelPosition | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const x = typeof record.x === 'number' ? record.x : NaN
  const y = typeof record.y === 'number' ? record.y : NaN
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x: Math.round(x), y: Math.round(y) }
}

/** 读取偏好；缺失/坏数据逐字段回退默认值。 */
export function loadPreferences(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): VoicePreferences {
  if (!storage) return { ...DEFAULT_PREFERENCES }
  try {
    const raw = storage.getItem(PREFERENCES_KEY)
    if (!raw) return { ...DEFAULT_PREFERENCES }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const panelPos = parsePanelPos(parsed.panelPos)
    return {
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_PREFERENCES.muted,
      volume: clampVolume(parsed.volume),
      collapsed: typeof parsed.collapsed === 'boolean' ? parsed.collapsed : DEFAULT_PREFERENCES.collapsed,
      onboardingSeen: typeof parsed.onboardingSeen === 'boolean' ? parsed.onboardingSeen : DEFAULT_PREFERENCES.onboardingSeen,
      mode: parsed.mode === 'speed' ? 'speed' : 'identity',
      ...(panelPos !== undefined ? { panelPos } : {}),
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

/** 保存偏好；存储不可用时静默失败（功能不受影响）。 */
export function savePreferences(preferences: VoicePreferences, storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  if (!storage) return
  try {
    const panelPos = parsePanelPos(preferences.panelPos)
    storage.setItem(PREFERENCES_KEY, JSON.stringify({
      muted: preferences.muted,
      volume: clampVolume(preferences.volume),
      collapsed: preferences.collapsed,
      onboardingSeen: preferences.onboardingSeen,
      mode: preferences.mode === 'speed' ? 'speed' : 'identity',
      ...(panelPos !== undefined ? { panelPos } : {}),
    }))
  } catch {
    // 隐私模式/配额满：偏好不持久化但不影响播放。
  }
}
