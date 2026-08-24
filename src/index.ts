/**
 * dsh-voice-companion 聚合包根 apply —— client 行的 node 半挂载点。
 * 本体（空）：host 能力在 @oldsan888/dsh-voice-companion/server；
 * client bundle 经 exports["./client"] 出货。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-voice-companion'

export function apply(_ctx: Context): void {
  // 根行仅作为 client entry 的挂载点（dsh.client 声明解析聚合包 manifest）。
}
