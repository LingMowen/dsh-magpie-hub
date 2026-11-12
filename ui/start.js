// ⚠ 本插件裁掉了 Agents 等页面，`load()` 可能在到达 `loadProviders()` 之前中断
// （碰到被删页面的 DOM），于是供应商页永远停在骨架屏。这段自愈**放在最前面**，
// 因为 `magpie.start()` 本身也可能抛错——放末尾就永远不会执行。
(function healProviders() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    // 真实 48 插件时首屏很慢：给到 60 次 × 700ms ≈ 42 秒
    if (tries > 60) { clearInterval(timer); return; }
    let needData = true;
    let needView = true;
    try {
      needData = providers === null;
      const v = document.querySelector("#view-providers");
      needView = !v || getComputedStyle(v).display === "none";
    } catch {
      needData = true; needView = true; // 还没准备好，下一轮再试
    }
    // 两件都办完就收工
    if (!needData && !needView) { clearInterval(timer); return; }
    // ⚠ 只在**视图没切出来**时才 show：每次都调会把页面反复重绘，
    // 表现成「一直在闪/一直骨架」（真实规模下尤其明显）。
    if (needView) {
      try {
        const r = show("providers");
        if (r && r.catch) r.catch(() => {});
      } catch { /* 还没准备好 */ }
    }
    // 同理，只在**没数据**时才拉
    if (needData) {
      try {
        const p = (typeof loadProvidersNow === "function") ? loadProvidersNow() : loadProviders();
        if (p && p.catch) p.catch(() => {});
      } catch { /* 还没准备好 */ }
    }
  }, 700);
})();

// The window's start, loaded last: app.js, the plugins' pages and the
// scripts after app.js are all there, so the first page shown has its
// code (the Usage page's is a plugin's, run after app.js).
// the plugins' pages wired up (kernel.js), before the first is shown
magpie.start();
navHides(); // the pages built-in plugins switched off have, from boot.js
// The window opens on the page the reader last left, as a Mac app comes back
// as it was (molvqingtai, lc on Discord): a page asked for (?view=, a link
// from the tray or a reload) first, then the one kept; a page gateway mode
// leaves out, or one there is no longer, gives way to the first page.
// the pages the window can open on besides the first (Agents)
const OPEN_VIEWS = ["providers", "plugins", "settings", ...magpie.pages()];
function keptView() {
  const asked = params.get("view");
  if (asked === "agents" || OPEN_VIEWS.includes(asked)) return asked;
  let v = "";
  try { v = localStorage.getItem("magpie.lastView") || ""; } catch { /* none kept */ }
  return OPEN_VIEWS.includes(v) ? v : ""; // one gateway mode leaves out, show() makes Providers
}
const firstView = mode === "window" ? keptView() : "";
// from the tray panel's More in Plugins (q): Discover, once show() picked the tab (#3579)
if (OPEN_VIEWS.includes(firstView)) show(firstView).then(() => view === "plugins" && params.has("q") && window.pluginQuery?.(params.get("q")));
else if (mode === "window" && !gatewayMode && !sideNav()) slide($("#nav"), "nav");
// in gateway mode the first page is Providers, Agents' tab gone
if (gatewayMode) setGatewayMode(true);
load();
