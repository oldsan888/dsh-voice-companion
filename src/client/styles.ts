/**
 * 面板样式（随 client bundle 内联注入一次）。
 * 颜色/字体尽量跟 DSH 宿主 token，深浅主题随 body[data-ds-dark-theme] 走；
 * 唯一强调色留给均衡器：空闲是墨色，说话时才亮成 DeepSeek 蓝。
 */
export const PANEL_CSS = `
.vcp-root {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  --vcp-ink: var(--dsw-alias-label-primary, #0f1115);
  --vcp-mute: var(--dsw-alias-label-secondary, #61666b);
  --vcp-faint: var(--dsw-alias-label-tertiary, #81858c);
  --vcp-paper: var(--dsw-alias-bg-layer-2, #ffffff);
  --vcp-wash: var(--dsw-alias-bg-module-platform, #f5f6f7);
  --vcp-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .06));
  --vcp-line: var(--dsw-alias-border-l2, rgba(0, 0, 0, .10));
  --vcp-hair: var(--dsw-alias-border-l1, rgba(0, 0, 0, .04));
  --vcp-accent: var(--dsw-static-deepseek-500, #4176e6);
  --vcp-accent-soft: color-mix(in srgb, var(--vcp-accent) 12%, transparent);
  --vcp-live: var(--dsw-static-green-500, #22c55e);
  --vcp-warn: var(--dsw-static-amber-500, #f59e0b);
  --vcp-danger: var(--dsw-static-red-500, #ef4444);
  --vcp-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(15, 17, 21, .08), 0 2px 6px rgba(15, 17, 21, .04));
  --vcp-radius: 12px;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  font-size: 12px;
  color: var(--vcp-ink);
  line-height: 1.45;
}
@media (max-width: 640px) {
  .vcp-root { right: 10px; bottom: 10px; }
}

.vcp-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 36px;
  padding: 0 12px 0 6px;
  border-radius: 999px;
  border: 1px solid var(--vcp-line);
  background: var(--vcp-paper);
  box-shadow: var(--vcp-shadow);
  color: var(--vcp-ink);
  cursor: pointer;
  user-select: none;
  touch-action: none;
  white-space: nowrap;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
}
.vcp-pill:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--vcp-ink) 22%, transparent);
}
.vcp-root.dragging .vcp-pill {
  cursor: grabbing;
  transform: none;
  transition: none;
}
.vcp-pill-label {
  font-weight: 500;
  letter-spacing: .01em;
  font-size: 12px;
}
.vcp-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.vcp-panel {
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: min(calc(100dvh - 24px), 720px);
  display: flex;
  flex-direction: column;
  border-radius: var(--vcp-radius);
  border: 1px solid var(--vcp-line);
  background: var(--vcp-paper);
  box-shadow: var(--vcp-shadow);
  overflow: hidden;
  animation: vcp-enter .16s ease-out;
}
@media (max-width: 640px) {
  .vcp-panel { width: calc(100vw - 20px); max-width: none; }
}
@keyframes vcp-enter {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.vcp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 10px 12px 12px;
  border-bottom: 1px solid var(--vcp-hair);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.vcp-root.dragging .vcp-head { cursor: grabbing; }

.vcp-brandmark {
  position: relative;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  color: var(--vcp-ink);
  background: var(--vcp-wash);
  overflow: hidden;
}
.vcp-brandmark i {
  position: absolute;
  display: block;
  box-sizing: border-box;
}
.vcp-voice-core {
  width: 4px;
  height: 10px;
  border-radius: 999px;
  background: currentColor;
}
.vcp-voice-wave {
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-bottom-color: transparent;
  border-radius: 50%;
}
.vcp-voice-wave.inner { width: 12px; height: 18px; opacity: .66; }
.vcp-voice-wave.outer { width: 20px; height: 24px; opacity: .28; }
.vcp-root.is-synthesizing .vcp-brandmark,
.vcp-root.is-playing .vcp-brandmark {
  color: var(--vcp-accent);
  background: var(--vcp-accent-soft);
}
.vcp-root.is-synthesizing .vcp-brandmark {
  animation: vcp-synth 1.1s ease-in-out infinite;
}
.vcp-root.is-playing .vcp-voice-core {
  animation: vcp-core .72s ease-in-out infinite;
}
.vcp-root.is-playing .vcp-voice-wave.inner { animation: vcp-wave .9s ease-out infinite; }
.vcp-root.is-playing .vcp-voice-wave.outer { animation: vcp-wave .9s .16s ease-out infinite; }
.vcp-root.is-muted .vcp-brandmark { color: var(--vcp-faint); }
.vcp-root.is-muted .vcp-brandmark::after {
  content: '';
  position: absolute;
  width: 18px;
  height: 1.5px;
  border-radius: 999px;
  background: currentColor;
  transform: rotate(-45deg);
  box-shadow: 0 0 0 1.5px var(--vcp-wash);
}
@keyframes vcp-synth {
  0%, 100% { opacity: .58; transform: scale(.94); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes vcp-core {
  0%, 100% { transform: scaleY(.65); }
  50% { transform: scaleY(1.18); }
}
@keyframes vcp-wave {
  0% { opacity: .18; transform: scale(.78); }
  55% { opacity: .78; }
  100% { opacity: .12; transform: scale(1.08); }
}
@media (prefers-reduced-motion: reduce) {
  .vcp-root.is-synthesizing .vcp-brandmark,
  .vcp-root.is-playing .vcp-brandmark i { animation: none; }
  .vcp-panel { animation: none; }
}

.vcp-heading { min-width: 0; flex: 1; }
.vcp-title { font-weight: 600; font-size: 13px; letter-spacing: -.01em; }
.vcp-subtitle {
  margin-top: 2px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--vcp-mute);
  font-size: 11px;
}
.vcp-leader {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--vcp-mute);
  font-size: 11px;
  white-space: nowrap;
}
.vcp-icon-btn {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--vcp-mute);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.vcp-icon-btn:hover { background: var(--vcp-hover); color: var(--vcp-ink); }
.vcp-body {
  padding: 14px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  min-height: 0;
}
.vcp-service {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--vcp-hair);
}
.vcp-service-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vcp-service-title { font-weight: 600; font-size: 12px; }
.vcp-service-note { color: var(--vcp-mute); font-size: 11px; margin-top: 1px; }
.vcp-queue {
  min-width: 36px;
  color: var(--vcp-mute);
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.vcp-queue strong {
  display: block;
  color: var(--vcp-ink);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -.02em;
}
.vcp-control-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  color: var(--vcp-faint);
  font-size: 11px;
}
.vcp-control-label strong {
  color: var(--vcp-ink);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.vcp-volume {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 10px;
}
.vcp-mode {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.vcp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.vcp-actions .wide { grid-column: 1 / -1; }
.vcp-btn {
  min-height: 32px;
  border: 1px solid var(--vcp-line);
  background: transparent;
  color: var(--vcp-ink);
  border-radius: 8px;
  padding: 6px 10px;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background .14s ease, border-color .14s ease, color .14s ease;
}
.vcp-btn:hover:not([disabled]) { background: var(--vcp-hover); }
.vcp-btn:active:not([disabled]) { background: var(--vcp-wash); }
.vcp-btn[disabled] { opacity: .38; cursor: default; }
.vcp-btn.primary {
  border-color: transparent;
  color: var(--vcp-paper);
  background: var(--vcp-ink);
}
.vcp-btn.primary:hover:not([disabled]) {
  background: color-mix(in srgb, var(--vcp-ink) 86%, white);
  border-color: transparent;
}
.vcp-btn.danger:hover:not([disabled]) {
  color: var(--vcp-danger);
  border-color: color-mix(in srgb, var(--vcp-danger) 28%, transparent);
  background: color-mix(in srgb, var(--vcp-danger) 6%, transparent);
}
.vcp-btn:focus-visible,
.vcp-pill:focus-visible,
.vcp-icon-btn:focus-visible,
.vcp-slider:focus-visible,
.vcp-details summary:focus-visible {
  outline: 2px solid var(--vcp-accent);
  outline-offset: 2px;
}
.vcp-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 20px;
  border-radius: 99px;
  background: linear-gradient(var(--vcp-line), var(--vcp-line)) center / 100% 3px no-repeat;
  cursor: pointer;
}
.vcp-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--vcp-ink);
  border: 2px solid var(--vcp-paper);
  box-shadow: 0 0 0 1px var(--vcp-line);
}
.vcp-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--vcp-ink);
  border: 2px solid var(--vcp-paper);
  box-shadow: 0 0 0 1px var(--vcp-line);
}
.vcp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--vcp-live);
}
.vcp-dot.err { background: var(--vcp-danger); }
.vcp-dot.warn { background: var(--vcp-warn); }
.vcp-dot.idle { background: var(--vcp-faint); }
.vcp-now-playing {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--vcp-accent);
  font-size: 11px;
}
.vcp-now-playing::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: vcp-pulse 1.1s ease-in-out infinite;
}
@keyframes vcp-pulse { 50% { opacity: .28; } }
.vcp-error {
  color: var(--vcp-danger);
  word-break: break-word;
  background: color-mix(in srgb, var(--vcp-danger) 7%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 11px;
}
.vcp-details {
  margin: 0 -12px -12px;
  border-top: 1px solid var(--vcp-hair);
  color: var(--vcp-mute);
  font-size: 11px;
  line-height: 1.6;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
}
.vcp-details summary {
  padding: 10px 12px;
  cursor: pointer;
  list-style: none;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  color: var(--vcp-faint);
}
.vcp-details summary::-webkit-details-marker { display: none; }
.vcp-details summary::after { content: ''; float: right; width: 0; height: 0; margin-top: 5px; border: 4px solid transparent; border-top-color: currentColor; }
.vcp-details[open] summary::after { margin-top: 1px; border-top-color: transparent; border-bottom-color: currentColor; }
.vcp-details > div { padding: 0 12px 12px; }
.vcp-onboarding {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  width: 248px;
  max-width: calc(100vw - 32px);
  border-radius: 10px;
  border: 1px solid var(--vcp-line);
  background: var(--vcp-paper);
  box-shadow: var(--vcp-shadow);
  padding: 12px;
  color: var(--vcp-ink);
  font-size: 12px;
  line-height: 1.5;
}
.vcp-onboarding::after {
  content: '';
  position: absolute;
  right: 22px;
  bottom: -5px;
  width: 8px;
  height: 8px;
  background: var(--vcp-paper);
  border-right: 1px solid var(--vcp-line);
  border-bottom: 1px solid var(--vcp-line);
  transform: rotate(45deg);
}
.vcp-onboarding strong { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 600; }
.vcp-onboarding p { margin: 0; color: var(--vcp-mute); }
.vcp-onboarding .vcp-btn { width: 100%; margin-top: 10px; }

.vcp-profiles {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vcp-profiles-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--vcp-faint);
  font-size: 11px;
}
.vcp-profiles-head strong {
  display: block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vcp-ink);
  font-weight: 500;
}
.vcp-profiles-note { color: var(--vcp-mute); font-size: 11px; padding: 2px 0; }
.vcp-profiles-error {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  color: var(--vcp-danger); font-size: 11px; word-break: break-word;
  background: color-mix(in srgb, var(--vcp-danger) 7%, transparent);
  border-radius: 8px; padding: 7px 9px;
}
.vcp-profiles-error .vcp-btn { min-height: 26px; padding: 4px 9px; }
.vcp-profiles-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.vcp-profile-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 8px; border-radius: 8px;
  background: var(--vcp-wash);
}
.vcp-profile-row.active { box-shadow: inset 2px 0 0 var(--vcp-accent); }
.vcp-profile-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.vcp-profile-name { font-weight: 500; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vcp-profile-badges { display: flex; align-items: center; gap: 5px; }
.vcp-profile-kind {
  padding: 0 5px; border-radius: 4px; font-size: 10px; line-height: 16px;
  color: var(--vcp-mute); background: var(--vcp-paper);
}
.vcp-profile-activebadge {
  padding: 0 5px; border-radius: 4px; font-size: 10px; line-height: 16px;
  color: var(--vcp-paper); background: var(--vcp-ink);
}
.vcp-profile-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.vcp-profile-actions .vcp-btn { min-height: 30px; padding: 4px 8px; font-size: 11px; }
.vcp-profiles-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.vcp-profiles-foot .vcp-btn { min-height: 30px; padding: 4px 8px; font-size: 11px; }
.vcp-profiles-hint { color: var(--vcp-faint); font-size: 10px; padding-right: 2px; }
.vcp-confirm {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px;
  border-radius: 8px;
  background: var(--vcp-wash);
  font-size: 11px;
}
.vcp-confirm-actions { display: flex; gap: 8px; }
.vcp-confirm-actions .vcp-btn { flex: 1; min-height: 30px; }

@media (pointer: coarse) {
  .vcp-pill { height: 44px; }
  .vcp-icon-btn { width: 44px; height: 44px; }
  .vcp-btn,
  .vcp-profile-actions .vcp-btn,
  .vcp-profiles-foot .vcp-btn,
  .vcp-confirm-actions .vcp-btn { min-height: 44px; }
  .vcp-slider { height: 44px; }
  .vcp-slider::-webkit-slider-thumb { width: 20px; height: 20px; }
  .vcp-slider::-moz-range-thumb { width: 20px; height: 20px; }
  .vcp-details summary { min-height: 44px; display: flow-root; }
}
`

/** 把样式注入 <head>（幂等）；返回清理函数。 */
export function injectPanelStyles(documentRef: Document = document): () => void {
  const existing = documentRef.getElementById('dsh-voice-companion-styles')
  if (existing !== null) return () => undefined
  const style = documentRef.createElement('style')
  style.id = 'dsh-voice-companion-styles'
  style.textContent = PANEL_CSS
  documentRef.head.appendChild(style)
  return () => {
    style.remove()
  }
}
