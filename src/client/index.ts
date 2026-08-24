/**
 * client bundle 入口：向 shell.overlay 注册唯一面板 entry。
 * 依赖宿主冻结提供的 slots 服务；注册走 ctx.slots.inject（effect 包装，
 * 插件卸载/HMR 时自动移除）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_SLOT_ID } from '../shared/constants.ts'
import { VoiceCompanionPanel } from './VoiceCompanionPanel.tsx'
import { injectPanelStyles } from './styles.ts'

/** Required services: the slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: register the voice panel into the frame-wide overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // 样式随 effect 卸载（HMR/插件移除时一并清理）。
  ctx.effect(() => injectPanelStyles(), 'dsh-voice-companion: panel styles')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: PANEL_SLOT_ID,
    order: 40,
    label: 'voice-companion',
  }, VoiceCompanionPanel))
}
