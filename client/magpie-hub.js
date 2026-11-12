window.__ModuleLoader__.load({
  id: "dsh-magpie-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin-src/client/index.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  callMagpieRpc: () => callMagpieRpc,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var React3 = __toESM(require("react"), 1);

// plugin-src/client/MagpiePage.jsx
var React = __toESM(require("react"), 1);
var { useCallback, useEffect, useMemo, useState, useRef } = React;
var TABS = [
  { id: "agents", zh: "Agent", en: "Agents" },
  { id: "quotas", zh: "额度", en: "Quotas" },
  { id: "usage", zh: "用量", en: "Usage" },
  { id: "routing", zh: "路由", en: "Routing" },
  { id: "store", zh: "商店", en: "Store" }
];
var PERIODS = [
  { id: "today", zh: "今天", en: "Today" },
  { id: "7d", zh: "7 天", en: "7 days" },
  { id: "30d", zh: "30 天", en: "30 days" },
  { id: "all", zh: "全部", en: "All" }
];
var PALETTE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)"];
function t(locale, zh, en) {
  return String(locale ?? "").toLowerCase().startsWith("en") ? en : zh;
}
function fmt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}
function fmtN(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return fmt(n);
}
function fmtShort(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function clock(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function resetsText(at, locale) {
  if (at === void 0 || at === null) return "";
  const when = typeof at === "number" ? at : new Date(at).getTime();
  if (!Number.isFinite(when)) return "";
  const left = when - Date.now();
  if (left <= 0) return t(locale, "已过期", "expired");
  const mins = Math.floor(left / 6e4);
  if (mins < 60) return t(locale, `${mins} 分钟后`, `in ${mins}m`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t(locale, `${hours} 小时后`, `in ${hours}h`);
  const days = Math.floor(hours / 24);
  return t(locale, `${days} 天后`, `in ${days}d`);
}
function Blk({ label, value, sub, tone, title }) {
  return React.createElement(
    "div",
    { className: "blk", title },
    React.createElement("span", { className: "k" }, label),
    React.createElement("span", { className: `v${tone === void 0 ? "" : ` ${tone}`}` }, value),
    sub === void 0 ? null : React.createElement("span", { className: "sub" }, sub)
  );
}
function Dial({ pct, label }) {
  const value = typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  const full = value !== null && value >= 100;
  return React.createElement(
    "div",
    { className: `pq-ring${full ? " full" : ""}` },
    React.createElement(
      "div",
      { className: "pq-dial", style: { "--p": value === null ? 0 : value } },
      React.createElement("b", null, value === null ? "—" : `${Math.round(value)}%`)
    ),
    label ? React.createElement("span", { className: "pq-rn", title: label }, label) : null
  );
}
function Chart({ series, height = 200, valueOf }) {
  const boxRef = useRef(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = boxRef.current;
    if (el === null) return void 0;
    const update = () => setWidth(Math.max(160, el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return void 0;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const points = Array.isArray(series) ? series : [];
  const values = points.map(valueOf);
  const max = Math.max(0, ...values);
  if (points.length === 0 || max <= 0) {
    return React.createElement(
      "div",
      { className: "led-chart" },
      React.createElement(
        "div",
        { className: "plot", ref: boxRef },
        React.createElement("div", { className: "none" }, t(void 0, "这段时间没有请求", "Nothing in this period"))
      )
    );
  }
  const padLeft = 46;
  const padRight = 8;
  const padTop = 8;
  const padBottom = 20;
  const plotW = Math.max(40, width - padLeft - padRight);
  const plotH = Math.max(40, height - padTop - padBottom);
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  let step = mag;
  for (const scale of [1, 2, 2.5, 5, 10]) {
    if (scale * mag >= rough) {
      step = scale * mag;
      break;
    }
  }
  const top = step * 4;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const barW = Math.max(1, Math.min(18, plotW / points.length * 0.66));
  const gap = plotW / Math.max(1, points.length);
  return React.createElement(
    "div",
    { className: "led-chart" },
    React.createElement(
      "div",
      { className: "plot", ref: boxRef, style: { height } },
      React.createElement(
        "svg",
        { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img" },
        // 网格 + 纵轴刻度
        ticks.map((v) => {
          const y = padTop + plotH - (top > 0 ? v / top * plotH : 0);
          return React.createElement(
            "g",
            { key: `t${v}` },
            React.createElement("line", { className: "grid", x1: padLeft, x2: width - padRight, y1: y, y2: y }),
            React.createElement("text", { className: "axis", x: padLeft - 7, y: y + 3.5, textAnchor: "end" }, fmtShort(v))
          );
        }),
        // 柱子
        points.map((p, i) => {
          const v = values[i];
          const h = top > 0 ? Math.max(1, v / top * plotH) : 1;
          return React.createElement("rect", {
            key: `b${i}`,
            className: "col",
            x: padLeft + gap * i + (gap - barW) / 2,
            y: padTop + plotH - h,
            width: barW,
            height: h,
            rx: 2,
            fill: "var(--c1)"
          }, React.createElement("title", null, `${p.label} · ${fmt(v)}`));
        }),
        // 横轴标签（最多 8 个，避免拥挤）
        points.map((p, i) => {
          const every = Math.ceil(points.length / 8);
          if (i % every !== 0) return null;
          return React.createElement("text", {
            key: `x${i}`,
            className: "axis",
            x: padLeft + gap * i + gap / 2,
            y: height - 6,
            textAnchor: "middle"
          }, p.label);
        })
      )
    )
  );
}
function Rank({ rows, valueOf, locale }) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (list.length === 0) return null;
  list.sort((a, b) => valueOf(b) - valueOf(a));
  return React.createElement(
    "div",
    { className: "led-rank" },
    list.slice(0, 7).map((r, i) => React.createElement(
      "div",
      { key: r.id ?? i, className: "rank-row" },
      React.createElement("i", { style: { background: PALETTE[i % PALETTE.length] } }),
      React.createElement("span", { className: "nm", title: r.name ?? r.id }, r.name ?? r.id),
      React.createElement("em", null, fmtShort(valueOf(r)))
    ))
  );
}
function AgentsTab({ snapshot, locale }) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  if (providers.length === 0) {
    return React.createElement(
      "div",
      { className: "none-box" },
      t(
        locale,
        "还没有安装 magpie 插件。把插件放进 magpie 的数据目录后重新扫描。",
        "No magpie plugins installed yet. Add plugins to the magpie data directory, then rescan."
      )
    );
  }
  return React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 12 } },
    providers.map((p) => React.createElement(
      "div",
      { key: p.id, className: "pq-group" },
      React.createElement(
        "div",
        { className: "pq-gh" },
        React.createElement("span", { className: "pq-gn" }, p.name || p.id),
        (p.accounts?.length ?? 0) > 1 ? React.createElement("span", { className: "pq-count", title: t(locale, `${p.accounts.length} 个账号`, `${p.accounts.length} accounts`) }, String(p.accounts.length)) : React.createElement("span", { className: "pq-gnote" }, `${p.models ?? 0} ${t(locale, "个模型", "models")}`),
        p.hasCheckin ? React.createElement("span", { className: "pq-gnote", style: { marginLeft: 0 } }, t(locale, "可签到", "check-in")) : null
      ),
      p.error ? React.createElement(
        "div",
        { className: "pq-card err" },
        React.createElement("div", { className: "pq-who" }, React.createElement("span", { className: "pq-user" }, p.name || p.id)),
        React.createElement("div", { className: "pq-sub err" }, p.error)
      ) : null,
      (p.accounts ?? []).map((a) => React.createElement(
        "div",
        { key: a.key, className: "pq-card" },
        React.createElement(
          "div",
          { className: "pq-who" },
          React.createElement("span", { className: "pq-user" }, a.accountId || a.key),
          a.signIn === "expired" ? React.createElement("span", { className: "pq-count", style: { background: "var(--red)", color: "#fff" } }, t(locale, "失效", "expired")) : null
        ),
        React.createElement(
          "div",
          { className: "pq-say" },
          [a.plan, a.until ? resetsText(a.until, locale) : ""].filter(Boolean).join(" · ") || a.key
        )
      ))
    ))
  );
}
function QuotasTab({ snapshot, locale }) {
  const usage = Array.isArray(snapshot?.usage) ? snapshot.usage : [];
  const [expanded, setExpanded] = useState({});
  if (usage.length === 0) {
    return React.createElement(
      "div",
      { className: "none-box" },
      t(
        locale,
        "没有额度信息（插件的 auth.usage 没回报，或还没登录）。",
        "No allowances reported (the plugin's auth.usage returned nothing, or nobody is signed in)."
      )
    );
  }
  const groups = [];
  const byName = /* @__PURE__ */ new Map();
  for (const u of usage) {
    const name2 = u.provider;
    if (!byName.has(name2)) {
      byName.set(name2, []);
      groups.push({ name: name2, rows: byName.get(name2) });
    }
    byName.get(name2).push(u);
  }
  return React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 14 } },
    groups.map((g) => {
      const open = expanded[g.name] === true;
      const shown = open ? g.rows : g.rows.slice(0, 1);
      const hidden = g.rows.length - shown.length;
      return React.createElement(
        "div",
        { key: g.name, className: "pq-group" },
        React.createElement(
          "div",
          { className: "pq-gh" },
          React.createElement("span", { className: "pq-gn" }, shown[0]?.label?.split(" · ")[0] ?? g.name),
          g.rows.length > 1 ? React.createElement("span", { className: "pq-count" }, String(g.rows.length)) : React.createElement("span", { className: "pq-gnote" }, shown[0]?.plan ?? "")
        ),
        shown.map((u, i) => React.createElement(
          "div",
          { key: `${u.accountKey}-${i}`, className: "pq-card" },
          React.createElement(
            "div",
            { className: "pq-who" },
            React.createElement("span", { className: "pq-user" }, u.label || u.provider)
          ),
          React.createElement(
            "div",
            { className: "pq-rings" + ((u.windows?.length ?? 0) > 3 ? " many" : "") },
            (u.windows ?? []).filter((w) => typeof w.used === "number").slice(0, 4).map((w, j) => React.createElement(Dial, { key: j, pct: w.used, label: w.name })),
            (u.windows ?? []).filter((w) => typeof w.used !== "number").slice(0, 2).map((w, j) => React.createElement(Dial, { key: `t${j}`, pct: null, label: w.name }))
          ),
          React.createElement(
            "div",
            { className: "pq-say" },
            [
              u.plan,
              u.balance ? t(locale, `余额 ${u.balance}`, `balance ${u.balance}`) : "",
              resetsText((u.windows ?? []).find((w) => w.resetsAt !== void 0)?.resetsAt, locale)
            ].filter(Boolean).join(" · ") || (u.error ?? "")
          ),
          u.error ? React.createElement("div", { className: "pq-sub err", style: { gridColumn: "1 / -1" } }, u.error) : null
        )),
        hidden > 0 ? React.createElement("button", {
          type: "button",
          className: "more",
          onClick: () => setExpanded({ ...expanded, [g.name]: true })
        }, t(locale, `展开其余 ${hidden} 个账号`, `Show ${hidden} more`)) : null,
        open && g.rows.length > 1 ? React.createElement("button", {
          type: "button",
          className: "more",
          onClick: () => setExpanded({ ...expanded, [g.name]: false })
        }, t(locale, "收起", "Collapse")) : null
      );
    })
  );
}
function UsageTab({ snapshot, locale, period, onPeriod }) {
  const stats = snapshot?.stats ?? {};
  const series = Array.isArray(stats.series) ? stats.series : [];
  const byProvider = Array.isArray(stats.byProvider) ? stats.byProvider : [];
  const [metric, setMetric] = useState("tokens");
  const valueOf = (p) => {
    if (metric === "cost") return typeof p.cost === "number" ? p.cost : 0;
    if (metric === "calls") return typeof p.calls === "number" ? p.calls : 0;
    return typeof p.tokens === "number" ? p.tokens : 0;
  };
  const rankValueOf = (r) => {
    if (metric === "calls") return typeof r.calls === "number" ? r.calls : 0;
    return typeof r.tokens === "number" ? r.tokens : 0;
  };
  const cached = (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
  const prompt = (stats.inputTokens ?? 0) + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
  const hitRate = prompt > 0 ? (stats.cacheReadTokens ?? 0) / prompt : null;
  return React.createElement(
    React.Fragment,
    null,
    // 工具条：时间段 + 刷新
    React.createElement(
      "div",
      { className: "pu-bar" },
      React.createElement(
        "div",
        { className: "segs" },
        PERIODS.map((p) => React.createElement("button", {
          key: p.id,
          type: "button",
          className: `opt${p.id === period ? " on" : ""}`,
          onClick: () => onPeriod(p.id)
        }, t(locale, p.zh, p.en)))
      )
    ),
    // 统计口径（magpie 原句）
    React.createElement(
      "p",
      { className: "usage-note" },
      t(
        locale,
        "统计网关调用与会话日志调用；本地拒绝的请求不计入汇总。",
        "Gateway and session-log calls; local rejections excluded from totals."
      )
    ),
    // 四张指标卡（magpie 的 .led-strip）
    React.createElement(
      "div",
      { className: "led-strip" },
      React.createElement(Blk, {
        label: "Tokens",
        value: fmtN(stats.tokens),
        sub: `${fmtN(stats.inputTokens)} in · ${fmtN(stats.outputTokens)} out${cached > 0 ? ` · ${fmtN(cached)} cached` : ""}`
      }),
      React.createElement(Blk, {
        label: t(locale, "请求", "Requests"),
        value: fmtN(stats.calls),
        sub: `${fmtN(stats.errors)} ${t(locale, "次失败", "failed")}`,
        tone: (stats.errors ?? 0) > 0 ? "bad" : void 0
      }),
      React.createElement(Blk, {
        label: t(locale, "输入", "Input"),
        value: fmtShort(stats.inputTokens),
        sub: t(locale, "未命中缓存", "uncached")
      }),
      React.createElement(Blk, {
        label: t(locale, "缓存命中率", "Cache hit rate"),
        value: hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`,
        sub: t(locale, "占提示词", "of the prompt")
      })
    ),
    // 图表 + 排行（magpie 的 .led-trend > .led-body）
    React.createElement(
      "div",
      { className: "led-trend" },
      React.createElement(
        "div",
        { className: "pu-bar" },
        React.createElement(
          "div",
          { className: "segs" },
          [["tokens", t(locale, "Token", "Tokens")], ["calls", t(locale, "请求", "Requests")]].map(([id, label]) => React.createElement("button", {
            key: id,
            type: "button",
            className: `opt${id === metric ? " on" : ""}`,
            onClick: () => setMetric(id)
          }, label))
        ),
        React.createElement("span", { className: "grow" })
      ),
      React.createElement(
        "div",
        { className: "led-body" },
        React.createElement(Chart, { series, valueOf }),
        React.createElement(Rank, { rows: byProvider, valueOf: rankValueOf, locale })
      )
    )
  );
}
function RoutingTab({ snapshot, locale }) {
  const routing = Array.isArray(snapshot?.routing) ? snapshot.routing : [];
  if (routing.length === 0) {
    return React.createElement(
      "div",
      { className: "none-box" },
      t(locale, "还没有请求经过这个宿主。", "No requests have gone through this host yet.")
    );
  }
  return React.createElement(
    "table",
    { className: "rows" },
    React.createElement("thead", null, React.createElement(
      "tr",
      null,
      React.createElement("th", null, t(locale, "时间", "Time")),
      React.createElement("th", null, t(locale, "平台", "Provider")),
      React.createElement("th", null, t(locale, "模型", "Model")),
      React.createElement("th", null, t(locale, "状态", "Status")),
      React.createElement("th", null, t(locale, "耗时", "Latency"))
    )),
    React.createElement("tbody", null, routing.map((r, i) => React.createElement(
      "tr",
      { key: `${r.at}-${i}` },
      React.createElement("td", null, clock(r.at)),
      React.createElement("td", null, r.provider),
      React.createElement("td", null, r.model),
      React.createElement(
        "td",
        { className: r.status === "error" ? "bad" : void 0 },
        r.status === "error" ? t(locale, "失败", "failed") : "OK"
      ),
      React.createElement("td", null, typeof r.ms === "number" ? `${r.ms} ms` : "—")
    )))
  );
}
function StoreTab({ rpcCall, locale, snapshot }) {
  const [listings, setListings] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const load = useCallback(async () => {
    setLoadError("");
    try {
      setListings(await rpcCall("market.list", { force: false }) ?? []);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [rpcCall]);
  useEffect(() => {
    void load();
  }, [load]);
  const install = useCallback(async (pkg) => {
    setWorking(pkg);
    setNotice("");
    try {
      await rpcCall("market.install", { package: pkg });
      setNotice(t(locale, `已安装 ${pkg}，正在重扫…`, `Installed ${pkg}, rescanning…`));
      await rpcCall("plugins.reload", {});
      setNotice(t(locale, `${pkg} 装好了，去 Agent 页登录。`, `${pkg} installed — sign in on the Agents tab.`));
    } catch (caught) {
      setNotice(t(locale, `安装失败：${caught instanceof Error ? caught.message : String(caught)}`, `Install failed: ${caught instanceof Error ? caught.message : String(caught)}`));
    } finally {
      setWorking("");
    }
  }, [rpcCall, locale]);
  const rows = useMemo(() => {
    const items = Array.isArray(listings) ? listings : [];
    const q = query.trim().toLowerCase();
    if (q === "") return items;
    return items.filter((x) => x.name?.toLowerCase().includes(q) || x.package?.toLowerCase().includes(q) || JSON.stringify(x.summary ?? {}).toLowerCase().includes(q));
  }, [listings, query]);
  if (loadError !== "") {
    return React.createElement(
      "div",
      { className: "none-box", style: { color: "var(--red)" } },
      t(locale, "市场清单拉不到：", "Could not fetch the market: ") + loadError
    );
  }
  if (listings === null) {
    return React.createElement("div", { className: "none-box" }, t(locale, "读取中…", "Loading…"));
  }
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "div",
      { className: "pu-bar" },
      React.createElement("input", {
        className: "mgh-search",
        type: "search",
        placeholder: t(locale, "搜索插件…", "Search plugins…"),
        value: query,
        onChange: (e) => setQuery(e.target.value)
      }),
      React.createElement("span", { className: "grow" }),
      React.createElement("button", {
        type: "button",
        className: "mini",
        disabled: working !== "",
        onClick: () => {
          void load();
        }
      }, t(locale, "刷新", "Refresh"))
    ),
    notice ? React.createElement("div", { className: "none-box", style: { padding: "8px 12px" } }, notice) : null,
    rows.length === 0 ? React.createElement("div", { className: "none-box" }, t(locale, "没有匹配的插件。", "No plugins match.")) : rows.map((x) => React.createElement(
      "div",
      { key: x.package, className: "pq-card" },
      React.createElement(
        "div",
        { className: "pq-who" },
        React.createElement("span", { className: "pq-user" }, x.name),
        x.kind ? React.createElement("span", { className: "pq-count" }, x.kind) : null,
        x.community ? React.createElement("span", { className: "pq-count" }, "community") : null
      ),
      React.createElement(
        "div",
        { className: "pq-say" },
        t(locale, x.summary?.zh ?? "", x.summary?.en ?? "") || x.package
      ),
      React.createElement(
        "div",
        { className: "pq-rings" },
        React.createElement("button", {
          type: "button",
          className: "mini",
          style: { border: "1px solid var(--line)", padding: "3px 10px" },
          disabled: working !== "",
          onClick: () => {
            void install(x.package);
          }
        }, working === x.package ? t(locale, "安装中…", "Installing…") : t(locale, "安装", "Install"))
      )
    ))
  );
}
function MagpiePage({ rpcCall, locale }) {
  const [tab, setTab] = useState("agents");
  const [snapshot, setSnapshot] = useState(null);
  const [period, setPeriod] = useState("today");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await rpcCall("panel.snapshot", {}) ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [rpcCall]);
  useEffect(() => {
    void load();
  }, [load]);
  const changePeriod = useCallback(async (next) => {
    setPeriod(next);
    setBusy(true);
    try {
      await rpcCall("stats.period", { period: next });
      setSnapshot(await rpcCall("panel.snapshot", {}) ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [rpcCall]);
  const body = useMemo(() => {
    if (snapshot === null) return null;
    if (tab === "agents") return React.createElement(AgentsTab, { snapshot, locale });
    if (tab === "quotas") return React.createElement(QuotasTab, { snapshot, locale });
    if (tab === "usage") return React.createElement(UsageTab, { snapshot, locale, period, onPeriod: changePeriod });
    if (tab === "store") return React.createElement(StoreTab, { rpcCall, locale, snapshot });
    return React.createElement(RoutingTab, { snapshot, locale });
  }, [snapshot, tab, locale, period, changePeriod, rpcCall]);
  return React.createElement(
    "div",
    { className: "mgh" },
    React.createElement(
      "div",
      { className: "ptabs", role: "tablist" },
      TABS.map((x) => React.createElement("button", {
        key: x.id,
        type: "button",
        role: "tab",
        "aria-selected": String(x.id === tab),
        className: x.id === tab ? "on" : void 0,
        onClick: () => setTab(x.id)
      }, t(locale, x.zh, x.en)))
    ),
    React.createElement(
      "div",
      { className: "view" },
      error ? React.createElement("div", { className: "none-box", style: { color: "var(--red)" } }, error) : null,
      busy && snapshot === null ? React.createElement("div", { className: "none-box" }, t(locale, "读取中…", "Loading…")) : body
    )
  );
}

// plugin-src/client/panel-entry.js
var React2 = __toESM(require("react"), 1);

// plugin-src/client/entry-store.js
var VALID_ENTRIES = ["sidebar", "settings"];
var FALLBACK_ENTRY = "sidebar";
var MAGPIE_PANEL_KEY = "magpie";
var MAGPIE_SIDEBAR_ORDER = 30;
var MAGPIE_SETTINGS_ORDER = 55;
var current = null;
var listeners = /* @__PURE__ */ new Set();
function normalize(value) {
  return VALID_ENTRIES.includes(value) ? value : FALLBACK_ENTRY;
}
function panelEntryShowsSidebar() {
  return current === null ? true : normalize(current) === "sidebar";
}
function panelEntryShowsSettings() {
  return current === null ? false : normalize(current) === "settings";
}
function subscribePanelEntry(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publishPanelEntry(value) {
  const next = normalize(value);
  if (current === next) return;
  current = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (caught) {
      console.warn("[magpie-hub] 面板入口订阅者出错", caught);
    }
  }
}
async function loadPanelEntry(rpcCall) {
  try {
    const value = await rpcCall();
    const entry = value !== null && typeof value === "object" ? value.entry : value;
    publishPanelEntry(typeof entry === "string" ? entry : FALLBACK_ENTRY);
  } catch {
  }
}

// plugin-src/client/panel-entry.js
var PANEL_LABEL = "Magpie";
function MagpieSidebarIcon({ size } = {}) {
  const px = typeof size === "number" && size > 0 ? size : 16;
  return React2.createElement(
    "svg",
    {
      width: px,
      height: px,
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": "true"
    },
    // 一只侧面的鸟形（magpie 的名字），笔画风格与其它导航图标一致
    React2.createElement("path", {
      d: "M2.6 9.2c0-2.9 2.3-5.2 5.2-5.2h2.3l1.9-1.6v2.1l1.4 1.1-1.4 1.1v.9c0 2.9-2.3 5.2-5.2 5.2H2.6z",
      stroke: "currentColor",
      strokeWidth: 1.25,
      strokeLinejoin: "round"
    }),
    React2.createElement("path", { d: "M6.2 10.6 4.9 13.2", stroke: "currentColor", strokeWidth: 1.25, strokeLinecap: "round" }),
    React2.createElement("circle", { cx: 9.9, cy: 6.6, r: 0.75, fill: "currentColor" })
  );
}
function registerMagpiePanelEntries(ctx, deps) {
  const { rpcCall, makeElement } = deps;
  const render = (props = {}) => makeElement({ rpcCall, ...props });
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: MAGPIE_PANEL_KEY,
    inject: () => ({ rpcCall })
  }, (props) => render(props)));
  let layout;
  ctx.inject(["layout"], (scoped) => {
    layout = scoped.layout;
    return () => {
      layout = void 0;
    };
  });
  const deselectIfActive = () => {
    try {
      if (layout?.panelInfo?.getSnapshot?.()?.activePanelId !== MAGPIE_PANEL_KEY) return;
      layout.selectPanel(null);
    } catch (caught) {
      console.warn("[magpie-hub] 撤销侧栏入口时取消选中失败", caught);
    }
  };
  ctx.slots.inject("sidebar.panellist", () => {
    let stopRow;
    const sync = (visible) => {
      if (visible && stopRow === void 0) {
        stopRow = ctx.slots.register({
          name: "sidebar.panellist",
          id: MAGPIE_PANEL_KEY,
          order: MAGPIE_SIDEBAR_ORDER,
          label: () => PANEL_LABEL
        }, MagpieSidebarIcon);
        return;
      }
      if (!visible && stopRow !== void 0) {
        const stop = stopRow;
        stopRow = void 0;
        stop();
        deselectIfActive();
      }
    };
    const unsubscribe = subscribePanelEntry(() => sync(panelEntryShowsSidebar()));
    sync(panelEntryShowsSidebar());
    let disposed = false;
    void loadPanelEntry(() => rpcCall("panel.entry", {})).then(() => {
      if (!disposed) sync(panelEntryShowsSidebar());
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (stopRow !== void 0) {
        const stop = stopRow;
        stopRow = void 0;
        stop();
      }
    };
  });
  ctx.slots.inject("settings.section", () => {
    let stopSection;
    const sync = (visible) => {
      if (visible && stopSection === void 0) {
        stopSection = ctx.slots.register({
          name: "settings.section",
          id: MAGPIE_PANEL_KEY,
          order: MAGPIE_SETTINGS_ORDER,
          label: () => PANEL_LABEL,
          inject: () => ({ rpcCall })
        }, (props) => render(props));
        return;
      }
      if (!visible && stopSection !== void 0) {
        const stop = stopSection;
        stopSection = void 0;
        stop();
      }
    };
    const unsubscribe = subscribePanelEntry(() => sync(panelEntryShowsSettings()));
    sync(panelEntryShowsSettings());
    let disposed = false;
    void loadPanelEntry(() => rpcCall("panel.entry", {})).then(() => {
      if (!disposed) sync(panelEntryShowsSettings());
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (stopSection !== void 0) {
        const stop = stopSection;
        stopSection = void 0;
        stop();
      }
    };
  });
}

// plugin-src/client/styles.js
var STYLE_ID = "dsh-magpie-hub-styles";
var CSS = `
.mgh {
  /* ---- 浅色令牌（照抄 app.css:2-46） ---- */  --bg: #f4f4f6;
  --card: #ffffff;
  --card-2: #f9f9fb;
  --pill: #f1f1f4;
  --pill-hover: #e9e9ee;
  --line: #e3e3e8;
  --line-2: #ececf0;
  --fg: #1c1c21;
  --fg-2: #4b4b53;
  --muted: #85858d;
  --faint: #b9b9c2;
  --accent: #4f46e5;
  --accent-soft: #eeedfd;
  --green: #189a58;
  --red: #d64545;
  --amber: #b45309;
  --card-edge: 0 0 0 .5px rgba(20, 22, 30, .08);
  --shadow: 0 16px 44px rgba(20, 22, 30, .16), 0 2px 8px rgba(20, 22, 30, .06), 0 0 0 .5px rgba(20, 22, 30, .1);
  --c1: #4f46e5; --c2: #0ea5e9; --c3: #10b981; --c4: #d97706; --c5: #db2777; --c6: #7c3aed; --c7: #64748b;
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  --code: ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace;

  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  /*
   * ⚠️ 布局要跟着**面板自己的宽度**收，不是窗口宽度：这个面板在桌面端既可能
   * 铺满中央主面板，也可能缩到侧栏旁边；在手机上是整屏。media 查询量的是视口，
   * 用一个 900px 宽的窗口装 390px 的面板时它不会收缩（4 列指标卡挤成一团）。
   * 容器查询量的是这里，两种情形都对。
   */
  container-type: inline-size;
  container-name: magh;
}

@media (prefers-color-scheme: dark) {
  .mgh {
    --bg: #1a1a1e;
    --card: #232327;
    --card-2: #1f1f23;
    --pill: #2d2d33;
    --pill-hover: #36363d;
    --line: #333339;
    --line-2: #2c2c32;
    --fg: #ededf1;
    --fg-2: #b9b9c1;
    --muted: #8b8b94;
    --faint: #56565f;
    --accent: #a5b4fc;
    --accent-soft: #2b2c47;
    --green: #6fd99b;
    --red: #f28b82;
    --amber: #f2b544;
    --card-edge: inset 0 .5px 0 rgba(255, 255, 255, .06), 0 1px 2px rgba(0, 0, 0, .3);
    --shadow: 0 16px 44px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .3), 0 0 0 .5px rgba(255, 255, 255, .1);
    --c1: #a5b4fc; --c2: #7dd3fc; --c3: #6ee7b7; --c4: #fcd34d; --c5: #f9a8d4; --c6: #c4b5fd; --c7: #94a3b8;
  }
}

.mgh * { box-sizing: border-box; }

/* ---- 页签条：照抄 .ptabs（app.css:1832-1842） ---- */
.mgh .ptabs {
  position: relative;
  display: flex;
  flex: none;
  gap: 2px;
  margin: 0 12px 8px;
  padding-top: 10px;
}
.mgh .ptabs button {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 26px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition: color .15s, background-color .15s;
}
.mgh .ptabs button:hover:not(.on) { color: var(--fg-2); }
.mgh .ptabs button.on {
  color: var(--fg);
  font-weight: 550;
  background: var(--card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .08), var(--card-edge);
}
.mgh .ptabs em {
  font-style: normal;
  font-weight: 400;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

/* ---- 视图滚动区 ---- */
.mgh .view {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ---- 说明行（.usage-note, app.css:1306） ---- */
.mgh .usage-note {
  margin: 0;
  padding: 2px 2px 0;
  font-size: 11px;
  color: var(--faint);
  user-select: text;
}

/* ---- 工具条（.pu-bar / .led-bar, app.css:1352） ---- */
.mgh .pu-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}
.mgh .pu-bar .grow { flex: 1; }

/* ---- 分段选择器：照抄 .segs / .opt（app.css:3348-3366） ---- */
.mgh .segs {
  position: relative;
  display: inline-flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--pill);
}
.mgh .segs .opt {
  position: relative;
  z-index: 1;
  white-space: nowrap;
  height: 22px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition: color .18s, transform .14s;
}
.mgh .segs .opt.on {
  color: var(--fg);
  background: var(--card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .08), var(--card-edge);
}
.mgh .segs .opt:hover:not(.on) { color: var(--fg-2); }

/* ---- 指标条：照抄 .led-strip / .blk / .k / .v / .sub（app.css:1323-1345） ---- */
.mgh .led-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
}
.mgh .led-strip .blk {
  min-width: 0;
  padding: 11px 15px 10px;
}
.mgh .led-strip .blk + .blk { border-left: 1px solid var(--line-2); }
.mgh .led-strip .k {
  display: block;
  font-size: 11px;
  color: var(--muted);
}
.mgh .led-strip .v {
  display: block;
  margin-top: 2px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.mgh .led-strip .v.cost { color: var(--green); }
.mgh .led-strip .v.bad { color: var(--red); }
.mgh .led-strip .sub {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mgh .led-strip .sub b { font-weight: 600; color: var(--fg-2); }

/* ---- 图表卡：照抄 .led-trend / .led-chart（app.css:1351, 1361-1372） ---- */
.mgh .led-trend {
  padding: 10px 14px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
}
.mgh .led-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 232px;
  gap: 18px;
}
@media (max-width: 720px) {
  .mgh .led-body { grid-template-columns: minmax(0, 1fr); }
  .mgh .led-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* 容器查询：面板比视口窄时（侧栏旁、手机上）按容器收 */
@container magh (max-width: 620px) {
  .mgh .led-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mgh .led-body { grid-template-columns: minmax(0, 1fr); }
  .mgh .led-chart .plot { height: 168px; }
  .mgh .pq-ring { gap: 2px; }
}
@container magh (max-width: 420px) {
  .mgh .led-strip { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .mgh .led-strip .blk { padding: 9px 11px 8px; }
  .mgh .led-strip .v { font-size: 19px; }
  .mgh .pq-rings { gap: 7px; }
}
.mgh .led-chart { min-width: 0; }
.mgh .led-chart .plot { position: relative; height: 200px; }
.mgh .led-chart svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
  font-family: var(--font);
  font-variant-numeric: tabular-nums;
}
.mgh .led-chart .grid { stroke: var(--line-2); stroke-width: 1; stroke-dasharray: 2 3; }
.mgh .led-chart .axis { fill: var(--muted); font-size: 10.5px; }
.mgh .led-chart rect.col { transition: opacity .12s; }
.mgh .led-chart .none {
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 12px;
  color: var(--muted);
}

/* ---- 排行（.led-rank） ---- */
.mgh .led-rank { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.mgh .led-rank .rank-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  min-width: 0;
}
.mgh .led-rank .rank-row i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex: none;
}
.mgh .led-rank .rank-row span.nm {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh .led-rank .rank-row em {
  margin-left: auto;
  padding-left: 10px;
  font-style: normal;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ---- 额度组头：照抄 .pq-gh（app.css:1958-1965） ---- */
.mgh .pq-group { display: flex; flex-direction: column; gap: 8px; }
.mgh .pq-gh {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
  color: var(--faint);
}
.mgh .pq-gn {
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mgh .pq-count {
  flex: none;
  min-width: 16px;
  height: 15px;
  padding: 0 5px;
  border-radius: 999px;
  display: inline-grid;
  place-items: center;
  background: color-mix(in srgb, var(--fg) 7%, transparent);
  color: var(--muted);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.mgh .pq-gnote {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  font-variant-numeric: tabular-nums;
}
.mgh .pq-gnote.ends { color: var(--amber); }

/* ---- 额度卡：照抄 .pq-card（app.css:1997-2008） ---- */
.mgh .pq-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  padding: 10px 12px;
  border-radius: 11px;
  background: var(--card);
  box-shadow: var(--card-edge);
  border: 1px solid var(--line-2);
}
.mgh .pq-card.err { opacity: .85; }
.mgh .pq-who { display: flex; align-items: center; gap: 2px; min-width: 0; }
.mgh .pq-user {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh .pq-sub {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.mgh .pq-sub.err { color: var(--red); white-space: normal; }
.mgh .pq-rings { grid-row: 1 / 3; grid-column: 2; display: flex; gap: 12px; }
.mgh .pq-rings.many { gap: 7px; }
.mgh .pq-ring {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  cursor: default;
}
/* 34px 环形：conic-gradient + 28px 内圈（app.css:2008-2013） */
.mgh .pq-dial {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: conic-gradient(var(--fg-2) calc(var(--p) * 1%), color-mix(in srgb, var(--fg) 9%, transparent) 0);
}
.mgh .pq-dial b {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--card);
  font-size: 9.5px;
  font-weight: 600;
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}
.mgh .pq-ring.full .pq-dial {
  background: conic-gradient(var(--amber) calc(var(--p) * 1%), color-mix(in srgb, var(--amber) 18%, transparent) 0);
}
.mgh .pq-ring.full b { color: var(--fg); }
.mgh .pq-rn {
  max-width: 44px;
  font-size: 9.5px;
  line-height: 1.2;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mgh .pq-say {
  grid-column: 1;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ---- 表格（路由页） ---- */
.mgh table.rows { width: 100%; border-collapse: collapse; font-size: 12px; }
.mgh table.rows th {
  text-align: left;
  padding: 6px 8px;
  font-weight: 500;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}
.mgh table.rows td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--line-2);
  font-variant-numeric: tabular-nums;
  color: var(--fg-2);
}
.mgh table.rows td.bad { color: var(--red); }

/* ---- 空状态 ---- */
.mgh .none-box {
  padding: 28px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
}

/* ---- 商店搜索框（照 .field 的克制风） ---- */
.mgh .mgh-search {
  flex: 0 1 240px;
  min-width: 120px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  outline: none;
}
.mgh .mgh-search:focus { border-color: var(--accent); }
.mgh .mgh-search::placeholder { color: var(--faint); }

/* ---- 小按钮（与 .text / .icon 同款克制） ---- */
.mgh .mini {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 11.5px;
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.mgh .mini:hover { background: var(--pill); color: var(--fg-2); }
.mgh .mini:disabled { opacity: .5; cursor: default; }

/* ---- 折叠（「展开其余 N 个账号」，照抄 usageMore 的语义） ---- */
.mgh .more {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 11.5px;
  padding: 3px 2px;
  cursor: pointer;
  text-align: start;
}
.mgh .more:hover { color: var(--fg-2); }
`;
function installMagpieStyles(doc = globalThis.document) {
  if (typeof doc === "undefined" || doc === null) return;
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

// plugin-src/client/index.js
var ENDPOINT = "magpie-hub";
var name = "magpie-hub-client";
var inject = ["slots", "connection"];
async function callMagpieRpc(connection, method, payload, signal) {
  const result = await connection.rpc.call("/api", ENDPOINT, { method, payload }, signal);
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || `magpie-hub ${method} 失败`);
    error.code = result.error?.code;
    throw error;
  }
  return result;
}
function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) => callMagpieRpc(ctx.connection, endpoint, payload, signal);
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      installMagpieStyles();
      return () => {
        const el = globalThis.document?.getElementById("dsh-magpie-hub-styles");
        el?.remove();
      };
    }, "magpie-hub: install styles");
  } else {
    installMagpieStyles();
  }
  registerMagpiePanelEntries(ctx, {
    rpcCall,
    Page: MagpiePage,
    makeElement: (props) => React3.createElement(MagpiePage, props)
  });
}

    return module.exports;
  }
});
