/**
 * 面板样式（随 client bundle 内联注入一次）。
 * 深浅主题用 CSS 变量 + prefers-color-scheme；右下角固定，不遮挡输入区。
 */
export const PANEL_CSS = `
.vcp-root {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  --vcp-accent: #6d5dfc;
  --vcp-accent-strong: #5947ef;
  --vcp-accent-soft: rgba(109, 93, 252, .1);
  --vcp-bg: rgba(255, 255, 255, .96);
  --vcp-surface: #f7f7fa;
  --vcp-surface-hover: #f0eff7;
  --vcp-border: rgba(30, 32, 42, .09);
  --vcp-divider: rgba(30, 32, 42, .07);
  --vcp-text: #20212a;
  --vcp-muted: #767887;
  --vcp-shadow: 0 18px 48px rgba(20, 22, 32, .16), 0 3px 12px rgba(20, 22, 32, .08);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 12px;
  color: var(--vcp-text);
  line-height: 1.4;
}
@media (max-width: 640px) {
  .vcp-root { right: 10px; bottom: 10px; }
}

.vcp-pill {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 120px;
  height: 44px;
  padding: 0 15px 0 9px;
  border-radius: 15px;
  border: 1px solid var(--vcp-border);
  background: var(--vcp-bg);
  backdrop-filter: blur(20px) saturate(1.15);
  -webkit-backdrop-filter: blur(20px) saturate(1.15);
  box-shadow: var(--vcp-shadow);
  color: var(--vcp-text);
  cursor: pointer;
  user-select: none;
  touch-action: none;
  white-space: nowrap;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
}
.vcp-pill:hover {
  transform: translateY(-2px);
  border-color: rgba(109, 93, 252, .22);
  box-shadow: 0 22px 52px rgba(20, 22, 32, .19), 0 4px 14px rgba(20, 22, 32, .09);
}
.vcp-root.dragging .vcp-pill {
  cursor: grabbing;
  transform: none;
  transition: none;
}
.vcp-pill-label { font-weight: 600; letter-spacing: .01em; }
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
  width: 336px;
  max-width: calc(100vw - 32px);
  border-radius: 20px;
  border: 1px solid var(--vcp-border);
  background: var(--vcp-bg);
  backdrop-filter: blur(24px) saturate(1.12);
  -webkit-backdrop-filter: blur(24px) saturate(1.12);
  box-shadow: var(--vcp-shadow);
  overflow: hidden;
  animation: vcp-enter .18s ease-out;
}
@keyframes vcp-enter {
  from { opacity: 0; transform: translateY(8px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.vcp-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 15px 15px 13px;
  border-bottom: 1px solid var(--vcp-divider);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.vcp-root.dragging .vcp-head { cursor: grabbing; }
.vcp-brandmark {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 11px;
  color: #fff;
  background: linear-gradient(145deg, #7868ff, #5745e8);
  box-shadow: 0 7px 18px rgba(92, 72, 235, .25);
}
.vcp-brandmark i {
  display: block;
  width: 2px;
  border-radius: 2px;
  background: currentColor;
}
.vcp-brandmark i:nth-child(1), .vcp-brandmark i:nth-child(5) { height: 7px; opacity: .72; }
.vcp-brandmark i:nth-child(2), .vcp-brandmark i:nth-child(4) { height: 13px; opacity: .88; }
.vcp-brandmark i:nth-child(3) { height: 18px; }
.vcp-heading { min-width: 0; flex: 1; }
.vcp-title { font-weight: 700; font-size: 14px; letter-spacing: -.01em; }
.vcp-subtitle { margin-top: 1px; color: var(--vcp-muted); font-size: 11px; }
.vcp-leader {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--vcp-muted);
  font-size: 10px;
  white-space: nowrap;
}
.vcp-icon-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--vcp-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background .16s ease, color .16s ease;
}
.vcp-icon-btn:hover { background: var(--vcp-surface); color: var(--vcp-text); }
.vcp-body {
  padding: 13px 15px 14px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.vcp-service {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 11px;
  border: 1px solid var(--vcp-border);
  border-radius: 12px;
  background: var(--vcp-surface);
}
.vcp-service-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vcp-service-title { font-weight: 600; font-size: 12px; }
.vcp-service-note { color: var(--vcp-muted); font-size: 10px; margin-top: 1px; }
.vcp-queue {
  min-width: 42px;
  padding-left: 10px;
  border-left: 1px solid var(--vcp-divider);
  color: var(--vcp-muted);
  text-align: right;
  white-space: nowrap;
}
.vcp-queue strong { display: block; color: var(--vcp-text); font-size: 13px; line-height: 1.1; }
.vcp-control-label { display: flex; justify-content: space-between; color: var(--vcp-muted); font-size: 11px; }
.vcp-control-label strong { color: var(--vcp-text); font-weight: 600; }
.vcp-volume {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 10px;
}
.vcp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.vcp-actions .wide { grid-column: 1 / -1; }
.vcp-btn {
  min-height: 34px;
  border: 1px solid var(--vcp-border);
  background: var(--vcp-surface);
  color: var(--vcp-text);
  border-radius: 10px;
  padding: 7px 11px;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: transform .14s ease, background .14s ease, border-color .14s ease, box-shadow .14s ease;
}
.vcp-btn:hover:not([disabled]) { background: var(--vcp-surface-hover); border-color: rgba(109, 93, 252, .18); }
.vcp-btn:active:not([disabled]) { transform: scale(.98); }
.vcp-btn[disabled] { opacity: .42; cursor: default; }
.vcp-btn.primary {
  border-color: transparent;
  color: #fff;
  background: linear-gradient(135deg, var(--vcp-accent), var(--vcp-accent-strong));
  box-shadow: 0 6px 15px rgba(93, 73, 235, .2);
}
.vcp-btn.primary:hover:not([disabled]) { background: linear-gradient(135deg, #7869ff, #5b49ef); border-color: transparent; }
.vcp-btn.danger:hover:not([disabled]) { color: #d84657; border-color: rgba(216, 70, 87, .2); background: rgba(216, 70, 87, .06); }
.vcp-btn:focus-visible,
.vcp-pill:focus-visible,
.vcp-icon-btn:focus-visible,
.vcp-slider:focus-visible {
  outline: 2px solid var(--vcp-accent);
  outline-offset: 2px;
}
.vcp-slider {
  width: 100%;
  height: 4px;
  accent-color: var(--vcp-accent);
  cursor: pointer;
}
.vcp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: #2fcf9f;
  box-shadow: 0 0 0 3px rgba(47, 207, 159, .12);
}
.vcp-dot.err { background: #ea6070; box-shadow: 0 0 0 3px rgba(234, 96, 112, .12); }
.vcp-dot.warn { background: #e8ad35; box-shadow: 0 0 0 3px rgba(232, 173, 53, .13); }
.vcp-dot.idle { background: #9aa0ae; box-shadow: 0 0 0 3px rgba(154, 160, 174, .14); }
.vcp-now-playing {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: 10px;
  color: var(--vcp-accent-strong);
  background: var(--vcp-accent-soft);
  font-size: 11px;
}
.vcp-now-playing::before { content: '●'; font-size: 7px; animation: vcp-pulse 1.1s ease-in-out infinite; }
@keyframes vcp-pulse { 50% { opacity: .35; } }
.vcp-error {
  color: #c64051;
  word-break: break-word;
  background: rgba(216, 70, 87, .07);
  border: 1px solid rgba(216, 70, 87, .12);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 11px;
}
.vcp-details {
  margin: 0 -15px -14px;
  border-top: 1px solid var(--vcp-divider);
  color: var(--vcp-muted);
  font-size: 10.5px;
  line-height: 1.6;
}
.vcp-details summary {
  padding: 10px 15px;
  cursor: pointer;
  outline: none;
  list-style: none;
  font-size: 11px;
  font-weight: 500;
}
.vcp-details summary::-webkit-details-marker { display: none; }
.vcp-details summary::after { content: '＋'; float: right; color: var(--vcp-muted); }
.vcp-details[open] summary::after { content: '−'; }
.vcp-details > div { padding: 0 15px 12px; }
.vcp-onboarding {
  /* 锚定在胶囊正上方，跟随拖动后的位置，不再固定死在右下角。 */
  position: absolute;
  right: 0;
  bottom: calc(100% + 12px);
  width: 280px;
  max-width: calc(100vw - 32px);
  border-radius: 16px;
  border: 1px solid var(--vcp-border);
  background: var(--vcp-bg);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--vcp-shadow);
  padding: 14px;
  color: var(--vcp-text);
  font-size: 12px;
  line-height: 1.55;
}
.vcp-onboarding strong { display: block; margin-bottom: 3px; font-size: 13px; }
.vcp-onboarding p { margin: 0; color: var(--vcp-muted); }
.vcp-onboarding .vcp-btn { width: 100%; margin-top: 11px; }

/* ---- 音色 Profile（Phase 1）---- */
.vcp-profiles {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid var(--vcp-border);
  border-radius: 12px;
  background: var(--vcp-surface);
}
.vcp-profiles-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--vcp-muted);
  font-size: 11px;
}
.vcp-profiles-head strong {
  display: block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vcp-text);
  font-weight: 600;
}
.vcp-profiles-note { color: var(--vcp-muted); font-size: 11px; padding: 3px 2px; }
.vcp-profiles-error {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  color: #c64051; font-size: 11px; word-break: break-word;
  background: rgba(216, 70, 87, .07);
  border: 1px solid rgba(216, 70, 87, .12);
  border-radius: 10px; padding: 7px 9px;
}
.vcp-profiles-error .vcp-btn { min-height: 26px; padding: 4px 9px; }
.vcp-profiles-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.vcp-profile-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 8px; border-radius: 10px;
  border: 1px solid var(--vcp-divider); background: var(--vcp-bg);
}
.vcp-profile-row.active { border-color: rgba(109, 93, 252, .22); background: var(--vcp-accent-soft); }
.vcp-profile-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.vcp-profile-name { font-weight: 600; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vcp-profile-badges { display: flex; align-items: center; gap: 5px; }
.vcp-profile-kind {
  padding: 0 6px; border-radius: 6px; font-size: 9px; line-height: 16px;
  color: var(--vcp-muted); background: var(--vcp-surface-hover);
}
.vcp-profile-activebadge {
  padding: 0 6px; border-radius: 6px; font-size: 9px; line-height: 16px;
  color: #fff; background: linear-gradient(135deg, var(--vcp-accent), var(--vcp-accent-strong));
}
.vcp-profile-actions { display: flex; align-items: center; gap: 5px; flex: none; }
.vcp-profile-actions .vcp-btn { min-height: 27px; padding: 4px 8px; font-size: 11px; }
.vcp-profiles-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.vcp-profiles-foot .vcp-btn { min-height: 27px; padding: 4px 9px; font-size: 11px; }
.vcp-profiles-hint { color: var(--vcp-muted); font-size: 9.5px; padding-right: 2px; }
.vcp-confirm {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 11px; border-radius: 12px;
  border: 1px solid rgba(109, 93, 252, .22); background: var(--vcp-accent-soft);
  font-size: 11px;
}
.vcp-confirm-actions { display: flex; gap: 8px; }
.vcp-confirm-actions .vcp-btn { flex: 1; min-height: 30px; }

.dark .vcp-root,
[data-theme='dark'] .vcp-root {
  --vcp-bg: rgba(27, 28, 35, .96);
  --vcp-surface: #23242c;
  --vcp-surface-hover: #2a2b35;
  --vcp-border: rgba(255, 255, 255, .09);
  --vcp-divider: rgba(255, 255, 255, .07);
  --vcp-text: #f1f1f5;
  --vcp-muted: #9b9daa;
  --vcp-shadow: 0 20px 54px rgba(0, 0, 0, .42), 0 3px 12px rgba(0, 0, 0, .28);
}
@media (prefers-color-scheme: dark) {
  .vcp-root {
    --vcp-bg: rgba(27, 28, 35, .96);
    --vcp-surface: #23242c;
    --vcp-surface-hover: #2a2b35;
    --vcp-border: rgba(255, 255, 255, .09);
    --vcp-divider: rgba(255, 255, 255, .07);
    --vcp-text: #f1f1f5;
    --vcp-muted: #9b9daa;
    --vcp-shadow: 0 20px 54px rgba(0, 0, 0, .42), 0 3px 12px rgba(0, 0, 0, .28);
  }
}

/* 应用显式选择浅色主题时覆盖 OS 深色偏好（避免"应用浅色、面板深色"的错位）。 */
.light .vcp-root,
[data-theme='light'] .vcp-root {
  --vcp-bg: rgba(255, 255, 255, .96);
  --vcp-surface: #f7f7fa;
  --vcp-surface-hover: #f0eff7;
  --vcp-border: rgba(30, 32, 42, .09);
  --vcp-divider: rgba(30, 32, 42, .07);
  --vcp-text: #20212a;
  --vcp-muted: #767887;
  --vcp-shadow: 0 18px 48px rgba(20, 22, 32, .16), 0 3px 12px rgba(20, 22, 32, .08);
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
