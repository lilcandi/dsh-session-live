/**
 * 样式。类名统一 `dsl-` 前缀，避免与其它插件或宿主样式撞名。
 *
 * 两套色系刻意分开，不要合并：
 *
 * 1. 悬停面板（`.dsl-panel` 子树）渲染在**宿主的悬停卡片**里。该卡片由宿主自己
 *    硬编码为深色底 + 浅色字，**完全不跟随主题**：
 *      .hoverTitle  { color:#fff }
 *      .hoverTime   { color:#cfd3d6 }
 *      .hoverStatus { color:#adb2b8 }
 *    （见 dsh-client-ui-workspace/lib/client.js 的 Rows.module CSS）
 *    所以这里也钉死同一套浅色。若改用 --dsw-alias-label-* 主题变量，浅色主题下会
 *    解析成 bluish-700 深灰，落在深色卡片上就是「深底深字」，肉眼不可读。
 *
 * 2. 设置页（`.dsl-settings` 子树）渲染在常规设置面板里，**跟随主题**，
 *    继续用宿主 alias 变量。
 *
 * 语义色用 --dsw-static-*-400 亮色档：static 色板定义在 body 上、不随主题翻转，
 * 正好适配恒定深色的卡片底。
 */
export const CSS_TEXT = `
/* ============ 悬停面板：恒定深色卡片，钉死浅色 ============ */
.dsl-panel {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 1px 0 3px;
  font-size: 12px;
  line-height: 1.4;
  color: #cfd3d6;
}
.dsl-panel.dsl-dense { gap: 2px; font-size: 11px; line-height: 1.3; }
.dsl-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.dsl-row-live { color: #fff; }
.dsl-row-bad { color: var(--dsw-static-red-400, #ff8a80); }
.dsl-row-warn { color: var(--dsw-static-amber-400, #f7ad31); }
.dsl-row-dim { color: #adb2b8; }
.dsl-glyph {
  flex: 0 0 auto;
  width: 12px;
  text-align: center;
  opacity: .8;
  font-variant-numeric: tabular-nums;
}
.dsl-glyph-live { opacity: 1; color: var(--dsw-static-deepseek-400, #7aaaff); animation: dsl-pulse 1.4s ease-in-out infinite; }
.dsl-glyph-bad { opacity: 1; color: var(--dsw-static-red-400, #ff8a80); }
.dsl-glyph-warn { opacity: 1; color: var(--dsw-static-amber-400, #f7ad31); }
@keyframes dsl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .38; } }
@media (prefers-reduced-motion: reduce) { .dsl-glyph-live { animation: none; } }
.dsl-name {
  flex: 0 0 auto;
  font-weight: 500;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsl-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .9;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.dsl-time {
  flex: 0 0 auto;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  opacity: .85;
}
.dsl-label {
  flex: 0 0 auto;
  opacity: .72;
  font-size: .92em;
}
.dsl-recent-track { display: inline-flex; gap: 3px; align-items: center; min-width: 0; overflow: hidden; }
.dsl-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  font-size: 10px;
  background: rgba(255,255,255,.1);
  color: inherit;
}
.dsl-dot-bad { color: var(--dsw-static-red-400, #ff8a80); }
.dsl-preview { display: flex; flex-direction: column; gap: 2px; }
.dsl-preview-row { align-items: center; }
.dsl-preview-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .9;
}
.dsl-notices { display: flex; flex-direction: column; gap: 2px; }

/* ---- 最近图片缩略图 ----
   刻意做小：悬停卡片本身很窄，缩略图只负责「认得出是哪张」，
   点开才是看原图的地方。 */
.dsl-thumb-row { display: flex; margin: 0; }
.dsl-thumb {
  display: block;
  max-width: 58%;
  max-height: 54px;
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,.16);
  object-fit: cover;
  background: rgba(255,255,255,.06);
  cursor: zoom-in;
}
.dsl-panel.dsl-dense .dsl-thumb { max-height: 40px; border-radius: 4px; }

/* ---- 原图放大遮罩 ----
   这张遮罩挂在 body 上（不在 React 树里），所以它是全站元素：用宿主主题变量
   才能同时适配明暗两套主题。注意不能照抄上面悬停面板的钉死色——那里钉死是因为
   宿主悬停卡片自己硬编码深色，而遮罩底下是整页。 */
.dsl-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1300; /* 高于宿主全部客户端浮层（实测宿主最高 1250） */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--dsw-alias-bg-mask-drop, rgba(0,0,0,.62));
  backdrop-filter: blur(10px);
  animation: .16s ease-out dsl-fade-in;
  cursor: zoom-out;
}
.dsl-lightbox-box { display: flex; align-items: center; justify-content: center; }
.dsl-lightbox-img {
  display: block;
  max-width: 92vw;
  max-height: 86vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 12px 48px rgba(0,0,0,.5);
  cursor: default;
}
.dsl-lightbox-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #cfd3d6); }
@keyframes dsl-fade-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dsl-lightbox { animation: none; } }

/* ---- 用量行（轮数 · token · 模型，三项合并成一行）---- */
.dsl-usage .dsl-name {
  font-family: inherit;
  font-weight: 500;
  color: #fff;
  max-width: 100%;
  font-variant-numeric: tabular-nums;
}

/* ============ 设置页：常规面板，跟随主题 ============ */
.dsl-settings { display: flex; flex-direction: column; gap: 14px; padding: 2px 0 8px; }
.dsl-settings-head { display: flex; flex-direction: column; gap: 4px; }
.dsl-settings-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dsl-settings-sub { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #81858c); }
.dsl-settings-body { display: flex; flex-direction: column; gap: 2px; }
.dsl-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.14));
  cursor: pointer;
}
.dsl-setting-row:last-child { border-bottom: none; }
.dsl-setting-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsl-setting-label { font-size: 13px; color: var(--dsw-alias-label-primary, #1f2329); }
.dsl-setting-help { font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #81858c); }
.dsl-setting-control { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.dsl-switch { width: 15px; height: 15px; accent-color: var(--dsw-alias-state-business-primary, #4d6bfe); cursor: pointer; }
.dsl-range { width: 110px; accent-color: var(--dsw-alias-state-business-primary, #4d6bfe); cursor: pointer; }
.dsl-range-value { min-width: 18px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; }
.dsl-settings-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 4px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #a2a6ad);
}
.dsl-btn {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.28));
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 12px;
  cursor: pointer;
}
.dsl-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.dsl-btn:disabled { opacity: .5; cursor: default; }
.dsl-settings-status { color: var(--dsw-alias-state-business-primary, #4d6bfe); }
`;
