import { useState, useEffect, useCallback, useRef } from "react";

// ─── Constants ──────────────────────────────────────────────────────────────

const CURRENCIES = [
  { code: "HKD", symbol: "HK$", name: "Hong Kong Dollar", flag: "🇭🇰" },
  { code: "THB", symbol: "฿", name: "Thai Baht", flag: "🇹🇭" },
  { code: "USD", symbol: "$", name: "US Dollar", flag: "🇺🇸" },
  { code: "EUR", symbol: "€", name: "Euro", flag: "🇪🇺" },
  { code: "GBP", symbol: "£", name: "British Pound", flag: "🇬🇧" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen", flag: "🇯🇵" },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan", flag: "🇨🇳" },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar", flag: "🇸🇬" },
  { code: "KRW", symbol: "₩", name: "South Korean Won", flag: "🇰🇷" },
  { code: "TWD", symbol: "NT$", name: "Taiwan Dollar", flag: "🇹🇼" },
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit", flag: "🇲🇾" },
  { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah", flag: "🇮🇩" },
  { code: "VND", symbol: "₫", name: "Vietnamese Dong", flag: "🇻🇳" },
  { code: "PHP", symbol: "₱", name: "Philippine Peso", flag: "🇵🇭" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar", flag: "🇦🇺" },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc", flag: "🇨🇭" },
  { code: "NZD", symbol: "NZ$", name: "New Zealand Dollar", flag: "🇳🇿" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar", flag: "🇨🇦" },
  { code: "SEK", symbol: "kr", name: "Swedish Krona", flag: "🇸🇪" },
  { code: "DKK", symbol: "kr", name: "Danish Krone", flag: "🇩🇰" },
  { code: "NOK", symbol: "kr", name: "Norwegian Krone", flag: "🇳🇴" },
  { code: "CZK", symbol: "Kč", name: "Czech Koruna", flag: "🇨🇿" },
  { code: "PLN", symbol: "zł", name: "Polish Złoty", flag: "🇵🇱" },
  { code: "HUF", symbol: "Ft", name: "Hungarian Forint", flag: "🇭🇺" },
  { code: "TRY", symbol: "₺", name: "Turkish Lira", flag: "🇹🇷" },
  { code: "ZAR", symbol: "R", name: "South African Rand", flag: "🇿🇦" },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham", flag: "🇦🇪" },
  { code: "SAR", symbol: "﷼", name: "Saudi Riyal", flag: "🇸🇦" },
  { code: "INR", symbol: "₹", name: "Indian Rupee", flag: "🇮🇳" },
  { code: "BRL", symbol: "R$", name: "Brazilian Real", flag: "🇧🇷" },
  { code: "MXN", symbol: "$", name: "Mexican Peso", flag: "🇲🇽" },
];

const STORAGE_KEY = "travelcalc_v2";

const defaultState = () => ({
  homeCurrency: "HKD",
  wallets: {},
  activeWallet: null,
  rates: null,   // latest fetched market rates for the home currency (all travel currencies)
  oxrKey: "",    // optional Open Exchange Rates App ID for hourly rates (never exported)
  cards: [
    { id: "hsbc", name: "HSBC Credit", markup: "1.95" },
    { id: "citi", name: "Citi Debit", markup: "0" },
  ],
});

const newWallet = (travelCurrency) => ({
  travelCurrency,
  marketRate: "",
  marketRateUpdated: null,
  marketRateSource: null,
  exchanges: [],
  payments: [],
  manualBalance: "0",
  cardOverrides: {}, // { cardId: { rate, at } } — typed card rates; empty = automatic
  compareList: [],   // shops being compared (kept while you walk between shops)
  created: new Date().toLocaleString(),
});

// Currencies normally handled without decimals
const ZERO_DEC = ["JPY", "KRW", "VND", "IDR", "HUF"];
const roundAmt = (code, x) => {
  const d = ZERO_DEC.includes(code) ? 0 : 2;
  return Math.round(x * 10 ** d) / 10 ** d;
};
const fmtRate = (r) => (r > 0 ? String(Number(Number(r).toPrecision(6))) : "");

function fmtWhen(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${date}, ${time}`;
}

// Wallet fields for an automatically fetched market rate
const autoRatePatch = (q) => ({
  marketRate: String(q.rate), marketRateSource: q.source, marketRateFreq: q.freq,
  marketRateAt: q.dataTime, marketRateAuto: true, marketRateUpdated: new Date(q.dataTime).toLocaleString(),
});

// Card rate: your typed rate if any, otherwise market rate with the card's fee added
function cardRateInfo(wallet, card) {
  const typed = parseFloat(wallet.cardOverrides?.[card?.id]?.rate) || 0;
  const market = parseFloat(wallet.marketRate) || 0;
  const fee = parseFloat(card?.markup) || 0;
  const autoRate = market > 0 ? market / (1 + fee / 100) : 0;
  return typed > 0 ? { rate: typed, auto: false, autoRate, fee } : { rate: autoRate, auto: true, autoRate, fee };
}

// Blended rate of the exchanges recorded before a moment (ids are creation timestamps)
function blendBefore(exchanges, ts) {
  let h = 0, t = 0;
  for (const e of exchanges) if (e.id < ts) { h += parseFloat(e.homeAmount) || 0; t += parseFloat(e.travelAmount) || 0; }
  return h > 0 ? t / h : 0;
}

// After an exchange is edited/deleted: re-cost cash expenses that were costed from the old exchanges.
// Expenses costed any other way (edited by hand, market-rate fallback) are left alone.
function recostCash(payments, oldEx, newEx) {
  let count = 0;
  const updated = payments.map((p) => {
    if (p.method !== "cash") return p;
    const amt = parseFloat(p.amount) || 0;
    const used = p.blendedRateAtTime || (p.costHome > 0 ? amt / p.costHome : 0);
    const oldR = blendBefore(oldEx, p.id), newR = blendBefore(newEx, p.id);
    if (!amt || !used || !oldR || !newR) return p;
    if (Math.abs(used - oldR) / oldR > 1e-6) return p;
    if (Math.abs(newR - oldR) / oldR < 1e-12) return p;
    count++;
    return { ...p, blendedRateAtTime: newR, costHome: amt / newR };
  });
  return { updated, count };
}

function getCur(code) {
  return CURRENCIES.find((c) => c.code === code) || { code, symbol: code, name: code, flag: "💱" };
}

function fmt(num, dec = 2) {
  if (num === null || num === undefined || isNaN(num)) return "—";
  return Number(num).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// ─── Storage ────────────────────────────────────────────────────────────────
// Robust persistence: uses localStorage (works in real browsers / deployed PWA),
// falls back to window.storage (Claude artifact preview only). One file, both work.

async function loadState() {
  // 1. Try localStorage (browsers, deployed PWA)
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch (e) { /* localStorage unavailable, try fallback */ }
  // 2. Fall back to window.storage (artifact sandbox)
  try {
    if (typeof window !== "undefined" && window.storage) {
      const result = await window.storage.get(STORAGE_KEY);
      if (result && result.value) return JSON.parse(result.value);
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveState(state) {
  const json = JSON.stringify(state);
  // 1. Try localStorage first
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      localStorage.setItem(STORAGE_KEY, json);
      return;
    }
  } catch (e) { /* localStorage unavailable, try fallback */ }
  // 2. Fall back to window.storage
  try {
    if (typeof window !== "undefined" && window.storage) {
      window.storage.set(STORAGE_KEY, json);
    }
  } catch (e) { /* ignore */ }
}

// ─── Market Rates ───────────────────────────────────────────────────────────
// Free sources, no sign-up: they publish once a day. With an Open Exchange Rates
// App ID (free account) rates are hourly. For each currency the freshest data wins.

const RATE_CODES = CURRENCIES.map((c) => c.code);

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally { clearTimeout(timer); }
}

function pickCodes(base, getRate) {
  const out = {};
  for (const code of RATE_CODES) {
    if (code === base) continue;
    const r = Number(getRate(code));
    if (r > 0 && isFinite(r)) out[code] = r;
  }
  return out;
}

const RATE_SOURCES = [
  {
    name: "ExchangeRate-API",
    url: (b) => `https://open.er-api.com/v6/latest/${b}`,
    parse: (d, b) => (d?.result === "success" && d.rates
      ? { rates: pickCodes(b, (c) => d.rates[c]), dataTime: (d.time_last_update_unix || 0) * 1000 } : null),
  },
  {
    name: "ECB",
    url: (b) => `https://api.frankfurter.app/latest?from=${b}`,
    parse: (d, b) => (d?.rates
      ? { rates: pickCodes(b, (c) => d.rates[c]), dataTime: d.date ? Date.parse(d.date + "T14:00:00Z") : 0 } : null),
  },
  {
    name: "Currency-API",
    url: (b) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${b.toLowerCase()}.min.json`,
    parse: (d, b) => (d?.[b.toLowerCase()]
      ? { rates: pickCodes(b, (c) => d[b.toLowerCase()][c.toLowerCase()]), dataTime: d.date ? Date.parse(d.date + "T00:00:00Z") : 0 } : null),
  },
];

async function fetchOXR(key, base) {
  const { ok, status, data } = await getJSON(`https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(key)}`);
  if (!ok || !data?.rates) throw new Error(data?.description || data?.message || `HTTP ${status}`);
  const baseRate = Number(data.rates[base]);
  if (!(baseRate > 0)) throw new Error(`no ${base} rate`);
  return { rates: pickCodes(base, (c) => Number(data.rates[c]) / baseRate), dataTime: (data.timestamp || 0) * 1000 };
}

async function fetchRates(base, oxrKey) {
  let oxrError = null;
  const tasks = RATE_SOURCES.map(async (s) => {
    const { ok, data } = await getJSON(s.url(base));
    const parsed = ok ? s.parse(data, base) : null;
    if (!parsed || !Object.keys(parsed.rates).length) throw new Error(s.name + " failed");
    return { ...parsed, source: s.name, freq: "daily" };
  });
  if (oxrKey) {
    tasks.unshift(fetchOXR(oxrKey, base)
      .then((p) => ({ ...p, source: "Open Exchange Rates", freq: "hourly" }))
      .catch((e) => { oxrError = e.message || "failed"; throw e; }));
  }
  const results = (await Promise.allSettled(tasks)).filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!results.length) return { ok: false, oxrError };
  const byCode = {};
  // Freshest source first (stable sort keeps list order on ties)
  for (const res of [...results].sort((a, b) => (b.dataTime || 0) - (a.dataTime || 0))) {
    for (const [code, rate] of Object.entries(res.rates)) {
      if (!byCode[code]) byCode[code] = { rate, source: res.source, freq: res.freq, dataTime: res.dataTime || Date.now() };
    }
  }
  return { ok: true, oxrError, data: { base, fetchedAt: Date.now(), byCode } };
}

// Put fetched rates into wallets. A rate you typed stays until newer data is published.
function applyRates(state, fetched) {
  if (!fetched || fetched.base !== state.homeCurrency) return state;
  const wallets = { ...state.wallets };
  for (const [code, w] of Object.entries(wallets)) {
    const q = fetched.byCode[code];
    if (!q) continue;
    const current = parseFloat(w.marketRate) || 0;
    if (current > 0 && q.dataTime <= (w.marketRateAt || 0)) continue;
    wallets[code] = { ...w, ...autoRatePatch(q) };
  }
  return { ...state, wallets, rates: fetched };
}

// ─── Export / Import ────────────────────────────────────────────────────────

function exportToJSON(state) {
  const { oxrKey, ...backup } = state; // keep the API key out of backup files
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `travel-fx-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportToCSV(state) {
  const home = getCur(state.homeCurrency);
  const rows = [["Wallet", "Type", "Date", "Description", "Method", `Home Amount (${home.code})`, "Travel Amount", "Currency", "Rate", "Market Rate", `Cost (${home.code})`, "Surcharge %", "Card Rate Used", "Blended Rate Used"]];
  Object.values(state.wallets || {}).forEach((w) => {
    const tc = w.travelCurrency;
    (w.exchanges || []).forEach((ex) => {
      rows.push([tc, "Exchange", ex.date, ex.shop, "Cash", ex.homeAmount, ex.travelAmount, tc, ex.rate, ex.marketRateAtTime || "", "", "", "", ""]);
    });
    (w.payments || []).forEach((p) => {
      rows.push([tc, "Spend", p.date, p.description, p.method === "cash" ? "Cash" : (p.cardName || "Card"), "", p.amount, tc, "", p.marketRateAtTime || "", p.costHome, p.surcharge || 0, p.cardRateAtTime || "", p.blendedRateAtTime || ""]);
    });
  });
  const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `travel-fx-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function importFromJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || !data.homeCurrency) {
          reject(new Error("Invalid backup format"));
          return;
        }
        // Already v2 format
        if (data.wallets) {
          resolve(data);
          return;
        }
        // Migrate v1 (flat) → v2 (multi-wallet)
        if (data.travelCurrency && (Array.isArray(data.exchanges) || Array.isArray(data.payments))) {
          const tc = data.travelCurrency;
          const cardRates = {};
          (data.cards || []).forEach((c) => {
            if (c.rate) cardRates[c.id] = c.rate;
          });
          const migrated = {
            homeCurrency: data.homeCurrency,
            activeWallet: tc,
            cards: (data.cards || []).map((c) => ({ id: c.id, name: c.name, markup: c.markup || "0" })),
            wallets: {
              [tc]: {
                travelCurrency: tc,
                marketRate: data.marketRate || "",
                marketRateUpdated: data.marketRateUpdated || null,
                marketRateSource: data.marketRateSource || null,
                exchanges: data.exchanges || [],
                payments: data.payments || [],
                manualBalance: "0",
                cardRates,
                created: new Date().toLocaleString(),
              }
            }
          };
          resolve(migrated);
          return;
        }
        reject(new Error("Invalid backup format"));
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

// ─── Shared UI ──────────────────────────────────────────────────────────────

const T = {
  bg: "#f8f9fb",
  card: "#ffffff",
  cardBorder: "#e8ecf1",
  text: "#1a2332",
  textSec: "#5c6b7f",
  textTer: "#94a1b3",
  accent: "#3b6df0",
  accentLight: "rgba(59,109,240,0.08)",
  accentMed: "rgba(59,109,240,0.15)",
  input: "#f1f4f8",
  inputBorder: "#dde2ea",
  good: "#16a359",
  goodBg: "rgba(22,163,89,0.08)",
  warn: "#e08912",
  warnBg: "rgba(224,137,18,0.08)",
  bad: "#dc2626",
  badBg: "rgba(220,38,38,0.08)",
  divider: "#edf0f4",
};

function Card({ children, title, action, style: s }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.cardBorder}`, borderRadius: 14, padding: "16px 14px", ...s }}>
      {(title || action) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          {title && <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: T.text, letterSpacing: 0.2 }}>{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function NumInput({ value, onChange, placeholder, prefix, suffix, style: s, ...props }) {
  const prefixRef = useRef(null);
  const suffixRef = useRef(null);
  const [padL, setPadL] = useState(14);
  const [padR, setPadR] = useState(14);

  useEffect(() => {
    if (prefix && prefixRef.current) setPadL(prefixRef.current.offsetWidth + 20);
    else setPadL(14);
  }, [prefix]);

  useEffect(() => {
    if (suffix && suffixRef.current) setPadR(suffixRef.current.offsetWidth + 20);
    else setPadR(14);
  }, [suffix]);

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", ...s }}>
      {prefix && <span ref={prefixRef} style={{ position: "absolute", left: 12, color: T.textTer, fontSize: 13, fontWeight: 600, pointerEvents: "none", whiteSpace: "nowrap" }}>{prefix}</span>}
      <input
        type="number" inputMode="decimal" enterKeyHint="done" step="any" value={value}
        onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: "100%", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10,
          color: T.text, padding: `10px ${padR}px 10px ${padL}px`,
          fontSize: 15, fontFamily: "'DM Mono', monospace", outline: "none",
        }}
        {...props}
      />
      {suffix && <span ref={suffixRef} style={{ position: "absolute", right: 12, color: T.textTer, fontSize: 12, fontWeight: 600, pointerEvents: "none", whiteSpace: "nowrap" }}>{suffix}</span>}
    </div>
  );
}

function CurrencySelect({ value, onChange, label, exclude, placeholder }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && <label style={{ fontSize: 11, color: T.textTer, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</label>}
      <select
        value={value} onChange={(e) => onChange(e.target.value)}
        style={{
          background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10,
          color: T.text, padding: "10px 32px 10px 14px", fontSize: 14, fontFamily: "inherit",
          cursor: "pointer", appearance: "none",
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235c6b7f' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center",
        }}
      >
        {placeholder && <option value="" disabled>{placeholder}</option>}
        {CURRENCIES.filter((c) => !exclude || !exclude.includes(c.code)).map((c) => (
          <option key={c.code} value={c.code}>{c.flag} {c.code} — {c.name}</option>
        ))}
      </select>
    </div>
  );
}

function RateBadge({ diffPct }) {
  if (diffPct === null || diffPct === undefined || isNaN(diffPct)) return null;
  const abs = Math.abs(diffPct * 100);
  const [color, bg, label] = abs < 0.5 ? [T.good, T.goodBg, "Great"] : abs < 1.5 ? [T.warn, T.warnBg, "OK"] : [T.bad, T.badBg, "Poor"];
  return <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: bg, color }}>{label} ({abs.toFixed(2)}%)</span>;
}

function DiffBadge({ value, sym }) {
  if (value === null || value === undefined || isNaN(value)) return null;
  const isGood = value <= 0;
  return (
    <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: isGood ? T.goodBg : T.badBg, color: isGood ? T.good : T.bad }}>
      {isGood ? "▼" : "▲"} {sym}{fmt(Math.abs(value))}
    </span>
  );
}

function Btn({ onClick, children, disabled, variant = "primary", style: s }) {
  const variants = {
    primary: { bg: T.accent, color: "#fff" },
    secondary: { bg: T.input, color: T.text },
    danger: { bg: T.badBg, color: T.bad },
    success: { bg: T.goodBg, color: T.good },
  };
  const v = variants[variant];
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        width: "100%", padding: "12px", borderRadius: 12, border: "none",
        background: disabled ? T.input : v.bg, color: disabled ? T.textTer : v.color,
        fontSize: 14, fontWeight: 700, cursor: disabled ? "default" : "pointer", fontFamily: "inherit", ...s,
      }}>
      {children}
    </button>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────

export default function TravelFX() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("wallet");
  const [rateStatus, setRateStatus] = useState({ loading: false, error: false, oxrError: null });
  const fileInputRef = useRef(null);
  const stateRef = useRef(null);
  stateRef.current = state;
  const prevKeyRef = useRef(null);

  useEffect(() => {
    (async () => {
      const loaded = await loadState();
      setState(loaded || defaultState());
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (state && !loading) saveState(state);
  }, [state, loading]);

  const update = useCallback((patch) => setState((p) => ({ ...p, ...patch })), []);

  const updateWallet = useCallback((code, patch) => {
    setState((prev) => ({
      ...prev,
      wallets: { ...prev.wallets, [code]: { ...prev.wallets[code], ...patch } },
    }));
  }, []);

  // Market rates refresh by themselves: on opening, and on returning to the app.
  // At most every 15 min (60 min with an hourly key, to stay within its free quota) unless forced.
  const refreshRates = useCallback(async (force = false) => {
    const s = stateRef.current;
    if (!s) return;
    const last = s.rates?.base === s.homeCurrency ? s.rates.fetchedAt || 0 : 0;
    const minGap = (s.oxrKey ? 60 : 15) * 60 * 1000;
    if (!force && Date.now() - last < minGap) return;
    setRateStatus((r) => ({ ...r, loading: true }));
    const res = await fetchRates(s.homeCurrency, s.oxrKey);
    if (res.ok) setState((cur) => (cur.homeCurrency === res.data.base ? applyRates(cur, res.data) : cur));
    setRateStatus({ loading: false, error: !res.ok, oxrError: res.oxrError });
  }, []);

  useEffect(() => {
    if (loading || !state) return;
    const keyChanged = prevKeyRef.current !== null && prevKeyRef.current !== state.oxrKey;
    prevKeyRef.current = state.oxrKey;
    refreshRates(keyChanged);
  }, [loading, state?.homeCurrency, state?.oxrKey, refreshRates]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refreshRates(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshRates]);

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await importFromJSON(file);
      const wCount = Object.keys(data.wallets || {}).length;
      if (confirm(`Import backup? This replaces all data (${wCount} wallet${wCount !== 1 ? "s" : ""}).`)) {
        setState({ ...data, oxrKey: stateRef.current?.oxrKey || "" }); // keep this phone's API key
      }
    } catch (err) { alert("Import failed: " + err.message); }
    e.target.value = "";
  };

  if (loading || !state) return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: T.bg, color: T.textSec }}>Loading...</div>
  );

  const home = getCur(state.homeCurrency);
  const walletCodes = Object.keys(state.wallets);
  const aw = state.activeWallet && state.wallets[state.activeWallet] ? state.wallets[state.activeWallet] : null;
  const awCode = state.activeWallet;
  const travel = aw ? getCur(aw.travelCurrency) : null;
  const homeLocked = Object.values(state.wallets).some((w) => (w.exchanges?.length || 0) + (w.payments?.length || 0) > 0);

  const tabs = [
    { id: "wallet", label: "👛 Wallets" },
    { id: "exchange", label: "💱 Exchange" },
    { id: "spend", label: "💸 Spend" },
    { id: "data", label: "⚙️ Data" },
  ];

  return (
    <div
      onKeyDown={(e) => {
        // Enter / Done on the phone keyboard closes the keyboard in every field
        if ((e.key === "Enter" || e.keyCode === 13) && e.target.tagName === "INPUT" && e.target.type !== "file") {
          e.preventDefault();
          e.target.blur();
        }
      }}
      style={{
      minHeight: "100vh", background: T.bg, color: T.text,
      fontFamily: "'DM Sans', 'Nunito', -apple-system, sans-serif",
      maxWidth: 480, margin: "0 auto", paddingBottom: 20,
    }}>
      {/* Header */}
      <div style={{ background: "#fff", padding: "18px 16px 14px", borderBottom: `1px solid ${T.cardBorder}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 24 }}>✈️</span>
            <div>
              <h1 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: T.text, letterSpacing: -0.5 }}>Travel FX</h1>
              <p style={{ margin: 0, fontSize: 11, color: T.textTer }}>Multi-wallet currency tracker</p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 13, color: T.textSec, fontWeight: 600 }}>Home:</span>
            {homeLocked ? (
              <button
                onClick={() => alert(`Home currency is locked to ${home.code} because you have transactions recorded in ${home.code}. Changing it would relabel all past amounts.\n\nTo switch: export a backup, then Reset in the Data tab.`)}
                style={{ background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 8, color: T.text, padding: "6px 8px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: "pointer" }}>
                {home.flag} {home.code} 🔒
              </button>
            ) : (
              <select value={state.homeCurrency} onChange={(e) => update({ homeCurrency: e.target.value })}
                style={{ background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 8, color: T.text, padding: "6px 8px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: "pointer", appearance: "none" }}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", background: "#fff", borderBottom: `1px solid ${T.cardBorder}`, position: "sticky", top: 0, zIndex: 10 }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: "11px 0", fontSize: 12, fontWeight: 700, fontFamily: "inherit",
              border: "none", borderBottom: tab === t.id ? `2px solid ${T.accent}` : "2px solid transparent",
              background: "transparent", color: tab === t.id ? T.text : T.textTer, cursor: "pointer",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: "12px" }}>
        {tab === "wallet" && (
          <WalletsTab state={state} update={update} updateWallet={updateWallet} home={home}
            rateStatus={rateStatus} refreshRates={refreshRates} />
        )}
        {tab === "exchange" && (
          aw ? <ExchangeTab state={state} update={update} updateWallet={updateWallet} home={home} travel={travel} wallet={aw} walletCode={awCode} rateStatus={rateStatus} refreshRates={refreshRates} />
          : <NoWalletMsg onGo={() => setTab("wallet")} />
        )}
        {tab === "spend" && (
          aw ? <SpendTab state={state} update={update} updateWallet={updateWallet} home={home} travel={travel} wallet={aw} walletCode={awCode} />
          : <NoWalletMsg onGo={() => setTab("wallet")} />
        )}
        {tab === "data" && (
          <DataTab state={state} setState={setState} update={update} fileInputRef={fileInputRef} rateStatus={rateStatus} />
        )}
      </div>

      <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} style={{ display: "none" }} />
    </div>
  );
}

function NoWalletMsg({ onGo }) {
  return (
    <Card style={{ textAlign: "center", padding: 32 }}>
      <p style={{ fontSize: 28, margin: "0 0 8px" }}>👛</p>
      <p style={{ fontSize: 14, color: T.textSec, margin: "0 0 14px" }}>Select or create a wallet first</p>
      <Btn onClick={onGo}>Go to Wallets</Btn>
    </Card>
  );
}

function RateAsOf({ wallet }) {
  const m = parseFloat(wallet.marketRate) || 0;
  let text;
  if (!m) text = "No market rate yet";
  else if (wallet.marketRateAuto) text = `Auto · ${wallet.marketRateFreq === "hourly" ? "hourly" : "daily"} rate (${wallet.marketRateSource}) · as of ${fmtWhen(wallet.marketRateAt)}`;
  else if (wallet.marketRateAt) text = `Typed by you · ${fmtWhen(wallet.marketRateAt)}`;
  else text = `${wallet.marketRateSource || "Manual"} · ${wallet.marketRateUpdated || ""}`;
  return <span style={{ fontSize: 11, color: T.textTer }}>{text}</span>;
}

function RefreshStatus({ rateStatus, state }) {
  if (rateStatus.loading) return <span style={{ fontSize: 11, color: T.textTer }}>Updating rates…</span>;
  if (rateStatus.error) return <span style={{ fontSize: 11, color: T.warn }}>Couldn't update (offline?). Using saved rates.</span>;
  if (state.rates?.fetchedAt) return <span style={{ fontSize: 11, color: T.textTer }}>Checked for new rates {fmtWhen(state.rates.fetchedAt)}</span>;
  return null;
}

// ─── Wallets Tab ────────────────────────────────────────────────────────────

function WalletsTab({ state, update, updateWallet, home, rateStatus, refreshRates }) {
  const [showNew, setShowNew] = useState(false);
  const [newCur, setNewCur] = useState("");
  const walletCodes = Object.keys(state.wallets);

  const existing = walletCodes.concat([state.homeCurrency]);

  const createWallet = () => {
    if (!newCur || state.wallets[newCur]) return;
    let w = newWallet(newCur);
    const q = state.rates?.base === state.homeCurrency ? state.rates.byCode?.[newCur] : null;
    if (q) w = { ...w, ...autoRatePatch(q) }; // start with today's market rate
    update({ wallets: { ...state.wallets, [newCur]: w }, activeWallet: newCur });
    setShowNew(false);
    setNewCur("");
  };

  const deleteWallet = (code) => {
    if (!confirm(`Delete ${code} wallet and all its transactions?`)) return;
    const { [code]: _, ...rest } = state.wallets;
    update({ wallets: rest, activeWallet: state.activeWallet === code ? Object.keys(rest)[0] || null : state.activeWallet });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Wallet list */}
      {walletCodes.map((code) => {
        const w = state.wallets[code];
        const cur = getCur(code);
        const isActive = state.activeWallet === code;
        const walletHome = w.exchanges.reduce((s, e) => s + (parseFloat(e.homeAmount) || 0), 0);
        const walletTravel = w.exchanges.reduce((s, e) => s + (parseFloat(e.travelAmount) || 0), 0);
        const manual = parseFloat(w.manualBalance) || 0;
        const totalTravel = walletTravel + manual;
        const cashSpent = w.payments.filter((p) => p.method === "cash").reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        const remaining = totalTravel - cashSpent;
        const cardSpent = w.payments.filter((p) => p.method !== "cash").reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        const spentHome = w.payments.reduce((s, p) => s + (parseFloat(p.costHome) || 0), 0);
        const blended = walletHome > 0 ? walletTravel / walletHome : 0;
        const marketRate = parseFloat(w.marketRate) || 0;

        return (
          <div key={code}
            onClick={() => update({ activeWallet: code })}
            style={{
              background: T.card,
              border: isActive ? `2px solid ${T.accent}` : `1px solid ${T.cardBorder}`,
              borderRadius: 14, padding: "14px", cursor: "pointer",
              transition: "border-color 0.15s",
            }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 28 }}>{cur.flag}</span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{cur.code} Wallet</div>
                  <div style={{ fontSize: 12, color: T.textTer }}>{cur.name}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: T.accent, background: T.accentLight, padding: "2px 8px", borderRadius: 20 }}>Active</span>}
                <button onClick={(e) => { e.stopPropagation(); deleteWallet(code); }}
                  style={{ background: "none", border: "none", color: T.textTer, fontSize: 16, cursor: "pointer", padding: 2 }}>✕</button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: T.textTer, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Remaining</div>
                <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: remaining >= 0 ? T.text : T.bad }}>
                  {cur.symbol}{fmt(remaining)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textTer, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Changed</div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: T.textSec }}>
                  {home.symbol}{fmt(walletHome)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textTer, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Rate</div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: T.textSec }}>
                  {marketRate > 0 ? fmt(marketRate, 4) : "—"}
                </div>
              </div>
            </div>

            {/* Spent totals: cash vs card */}
            {w.payments.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, fontSize: 11, color: T.textSec, flexWrap: "wrap", gap: 4 }}>
                <span>Spent: 💵 {cur.symbol}{fmt(cashSpent)} · 💳 {cur.symbol}{fmt(cardSpent)}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700, color: T.text }}>≈ {home.symbol}{fmt(spentHome)}</span>
              </div>
            )}

            {/* Market rate source and date */}
            <div style={{ marginTop: 6 }}><RateAsOf wallet={w} /></div>

            {/* Manual balance editor */}
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}
              onClick={(e) => e.stopPropagation()}>
              <span style={{ fontSize: 11, color: T.textTer, fontWeight: 600, whiteSpace: "nowrap" }}>Existing cash:</span>
              <NumInput
                value={w.manualBalance}
                onChange={(v) => updateWallet(code, { manualBalance: v })}
                placeholder="0"
                suffix={cur.code}
                style={{ flex: 1 }}
              />
            </div>
          </div>
        );
      })}

      {/* Refresh rates */}
      {walletCodes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <button onClick={() => refreshRates(true)} disabled={rateStatus.loading}
            style={{ width: "100%", background: T.accentLight, border: "none", borderRadius: 10, color: T.accent, padding: "10px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {rateStatus.loading ? "Updating rates…" : "↻ Refresh market rates"}
          </button>
          <RefreshStatus rateStatus={rateStatus} state={state} />
        </div>
      )}

      {/* Create wallet */}
      {!showNew ? (
        <Btn onClick={() => setShowNew(true)} variant="primary">+ New Wallet</Btn>
      ) : (
        <Card title="Create New Wallet">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <CurrencySelect value={newCur} onChange={setNewCur} label="Currency" exclude={existing} placeholder="Choose a currency…" />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={createWallet} disabled={!newCur} style={{ flex: 1 }}>Create</Btn>
              <Btn onClick={() => { setShowNew(false); setNewCur(""); }} variant="secondary" style={{ flex: 1 }}>Cancel</Btn>
            </div>
          </div>
        </Card>
      )}

      {walletCodes.length === 0 && (
        <div style={{ textAlign: "center", padding: 24, color: T.textTer }}>
          <p style={{ fontSize: 32, margin: "0 0 8px" }}>🌍</p>
          <p style={{ fontSize: 14, margin: 0 }}>Create a wallet for each travel currency</p>
        </div>
      )}
    </div>
  );
}

// ─── Exchange Tab ───────────────────────────────────────────────────────────

function ExchangeTab({ state, update, updateWallet, home, travel, wallet, walletCode, rateStatus, refreshRates }) {
  const [homeAmt, setHomeAmt] = useState("");
  const [travelAmt, setTravelAmt] = useState("");
  const [shop, setShop] = useState("");          // Record an Exchange: shop name
  const [checkShop, setCheckShop] = useState(""); // Rate checker: shop name
  const [showGuide, setShowGuide] = useState(false);
  const [lockRate, setLockRate] = useState(0);    // board rate from "Change here" (travel per home)
  const [autoField, setAutoField] = useState(null); // which amount was filled in for you
  const [editingExId, setEditingExId] = useState(null);
  const recordRef = useRef(null);

  // Rate comparison tool state
  const [shopRateInput, setShopRateInput] = useState("");
  const [rateFormat, setRateFormat] = useState("homePerTravel"); // how the shop quotes
  const compareList = wallet.compareList || [];

  const marketRate = parseFloat(wallet.marketRate) || 0; // travel per home (e.g. 4.14 THB per HKD)
  // Mid-market expressed as home-per-travel (e.g. HKD per THB) for cost comparison
  const midHomePerTravel = marketRate > 0 ? 1 / marketRate : 0;
  const autoQuote = state.rates?.base === state.homeCurrency ? state.rates.byCode?.[walletCode] : null;

  // ── Rate comparison logic ──
  // Normalize any shop input to "home currency spent per 1 travel unit received"
  const rawShopRate = parseFloat(shopRateInput) || 0;
  const shopHomePerTravel = rawShopRate > 0
    ? (rateFormat === "homePerTravel" ? rawShopRate : 1 / rawShopRate)
    : 0;
  // vs mid-market: positive = you pay more than mid (worse)
  const diffVsMid = (hpt) => (midHomePerTravel > 0 && hpt > 0 ? (hpt - midHomePerTravel) / midHomePerTravel : null);
  const compareDiffPct = diffVsMid(shopHomePerTravel);

  const verdict = (diff) => {
    if (diff === null) return null;
    const abs = Math.abs(diff * 100);
    if (diff <= 0) return { color: T.good, bg: T.goodBg, label: "Excellent — better than mid-market!", icon: "🤑" };
    if (abs < 1) return { color: T.good, bg: T.goodBg, label: "Great rate", icon: "✅" };
    if (abs < 2.5) return { color: T.warn, bg: T.warnBg, label: "OK rate", icon: "😐" };
    if (abs < 5) return { color: T.bad, bg: T.badBg, label: "Poor — keep looking", icon: "⚠️" };
    return { color: T.bad, bg: T.badBg, label: "Bad — avoid this shop", icon: "🛑" };
  };
  const v = verdict(compareDiffPct);

  // The comparison is saved in the wallet, so it survives switching apps while you walk between shops
  const addToCompare = () => {
    if (shopHomePerTravel <= 0) return;
    updateWallet(walletCode, { compareList: [...compareList, {
      id: Date.now(),
      name: checkShop.trim() || `Shop ${compareList.length + 1}`,
      homePerTravel: shopHomePerTravel,
      raw: rawShopRate,
      format: rateFormat,
    }] });
    setShopRateInput("");
    setCheckShop("");
  };

  const removeFromCompare = (id) => updateWallet(walletCode, { compareList: compareList.filter((c) => c.id !== id) });
  const clearCompare = () => { if (confirm("Clear the shop comparison?")) updateWallet(walletCode, { compareList: [] }); };

  // Best shop = lowest homePerTravel
  const bestId = compareList.length > 0
    ? compareList.reduce((best, c) => (c.homePerTravel < best.homePerTravel ? c : best), compareList[0]).id
    : null;

  // "Change here": fill the exchange form with that shop and its board rate
  const changeHere = (c) => {
    setShop(c.name);
    setLockRate(1 / c.homePerTravel);
    setHomeAmt(""); setTravelAmt(""); setAutoField(null);
    setTimeout(() => recordRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 50);
  };

  // With a board rate set, typing one amount fills in the other.
  // Anything you typed yourself is never overwritten.
  const onHomeChange = (val) => {
    setHomeAmt(val);
    if (lockRate > 0 && (autoField === "travel" || travelAmt === "")) {
      const h = parseFloat(val);
      setTravelAmt(h > 0 ? String(roundAmt(travel.code, h * lockRate)) : "");
      setAutoField(h > 0 ? "travel" : null);
    } else if (autoField === "home") setAutoField(null);
  };
  const onTravelChange = (val) => {
    setTravelAmt(val);
    if (lockRate > 0 && (autoField === "home" || homeAmt === "")) {
      const t = parseFloat(val);
      setHomeAmt(t > 0 ? String(roundAmt(home.code, t / lockRate)) : "");
      setAutoField(t > 0 ? "home" : null);
    } else if (autoField === "travel") setAutoField(null);
  };
  const clearLock = () => { setLockRate(0); setAutoField(null); };

  // ── Record exchange logic ──
  const shopRate = homeAmt && travelAmt ? parseFloat(travelAmt) / parseFloat(homeAmt) : 0;
  const diffPct = marketRate && shopRate ? (marketRate - shopRate) / marketRate : 0;
  const diffAmt = homeAmt && marketRate && shopRate ? parseFloat(homeAmt) * (marketRate - shopRate) / marketRate : 0;

  const addExchange = () => {
    if (!(parseFloat(homeAmt) > 0) || !(parseFloat(travelAmt) > 0)) return;
    const ex = {
      id: Date.now(), shop: shop.trim() || "Unknown", homeAmount: homeAmt, travelAmount: travelAmt,
      rate: shopRate, marketRateAtTime: marketRate || null, date: new Date().toLocaleString(),
    };
    updateWallet(walletCode, { exchanges: [...wallet.exchanges, ex] });
    setHomeAmt(""); setTravelAmt(""); setShop(""); clearLock();
  };

  // Changing or deleting an exchange changes your cash rate: offer to update the cash expenses that used it
  const commitExchanges = (newEx, question) => {
    const { updated, count } = recostCash(wallet.payments, wallet.exchanges, newEx);
    const patch = { exchanges: newEx };
    if (count > 0 && confirm(question(count))) patch.payments = updated;
    updateWallet(walletCode, patch);
  };
  const plural = (n) => `${n} cash expense${n > 1 ? "s" : ""}`;

  const saveExchange = (updatedEx) => {
    commitExchanges(wallet.exchanges.map((e) => (e.id === updatedEx.id ? updatedEx : e)),
      (n) => `This changes your cash rate. Also update the cost of ${plural(n)} logged with the old rate?`);
    setEditingExId(null);
  };

  const removeExchange = (id) => {
    if (!confirm("Delete this exchange?")) return;
    commitExchanges(wallet.exchanges.filter((e) => e.id !== id),
      (n) => `This changes your cash rate. Also update the cost of ${plural(n)} logged with the old rate?`);
    if (editingExId === id) setEditingExId(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Wallet indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: T.accentLight, borderRadius: 10 }}>
        <span style={{ fontSize: 18 }}>{travel.flag}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.accent }}>{travel.code} Wallet</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: T.textSec }}>
          Buying {travel.code} with {home.code}
        </span>
      </div>

      {/* Market rate */}
      <Card title="Mid-Market Rate (the 'real' rate)">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <NumInput value={wallet.marketRate}
            onChange={(v) => updateWallet(walletCode, { marketRate: v, marketRateAt: Date.now(), marketRateSource: "Manual", marketRateAuto: false, marketRateUpdated: new Date().toLocaleString() })}
            placeholder="e.g. 4.1463" prefix={`1 ${home.code} =`} suffix={travel.code} />
          {marketRate > 0 && (
            <div style={{ fontSize: 12, color: T.textSec, background: T.input, padding: "6px 10px", borderRadius: 8 }}>
              = <strong style={{ fontFamily: "'DM Mono', monospace" }}>1 {travel.code} = {home.symbol}{fmt(midHomePerTravel, 4)}</strong> <span style={{ color: T.textTer }}>(what shops usually quote)</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <RateAsOf wallet={wallet} />
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {!wallet.marketRateAuto && autoQuote && (
                <button onClick={() => updateWallet(walletCode, autoRatePatch(autoQuote))}
                  style={{ background: T.accent, border: "none", borderRadius: 6, color: "#fff", padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  Use auto
                </button>
              )}
              <button onClick={() => refreshRates(true)} disabled={rateStatus.loading} aria-label="Refresh market rate"
                style={{ background: T.input, border: "none", borderRadius: 6, color: T.textSec, padding: "4px 8px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                ↻
              </button>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <RefreshStatus rateStatus={rateStatus} state={state} />
            <a href={`https://www.xe.com/currencyconverter/convert/?From=${home.code}&To=${travel.code}`}
              target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 11, color: T.accent, textDecoration: "none", fontWeight: 700, whiteSpace: "nowrap" }}>Check on XE.com ↗</a>
          </div>
          <div style={{ fontSize: 11, color: T.textTer }}>
            Updates by itself. Free rates are published once a day{state.oxrKey ? " (hourly with your key)" : ""}. For the exact rate right now, check XE and type it in: it stays until newer rates come out.
          </div>
        </div>
      </Card>

      {/* ═══ RATE CHECKER (before changing money) ═══ */}
      <Card title="🔍 Check a Shop's Rate">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.textSec }}>
            Standing at a money changer? Punch in the number on their board and see instantly if it's good — no need to change any money first.
          </p>

          {marketRate === 0 && (
            <div style={{ padding: "8px 10px", background: T.warnBg, borderRadius: 8, fontSize: 12, color: T.warn }}>
              ⚠️ Set the mid-market rate above first, so we can compare.
            </div>
          )}

          <input value={checkShop} onChange={(e) => setCheckShop(e.target.value)} enterKeyHint="done" placeholder="Shop name (optional)"
            style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "inherit", outline: "none" }} />

          {/* Format toggle */}
          <div>
            <label style={{ fontSize: 11, color: T.textTer, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>The board shows the rate as:</label>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button onClick={() => setRateFormat("homePerTravel")}
                style={{ flex: 1, padding: "10px 8px", borderRadius: 10, border: rateFormat === "homePerTravel" ? `2px solid ${T.accent}` : `1px solid ${T.inputBorder}`, background: rateFormat === "homePerTravel" ? T.accentLight : T.card, color: rateFormat === "homePerTravel" ? T.accent : T.textSec, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.3 }}>
                {home.symbol} per 1 {travel.code}
                <div style={{ fontSize: 10, fontWeight: 500, marginTop: 2, opacity: 0.8 }}>
                  {midHomePerTravel > 0 ? `e.g. ${home.symbol}${fmt(midHomePerTravel, midHomePerTravel < 1 ? 4 : 2)}` : `e.g. ${home.symbol}0.05`}
                </div>
              </button>
              <button onClick={() => setRateFormat("travelPerHome")}
                style={{ flex: 1, padding: "10px 8px", borderRadius: 10, border: rateFormat === "travelPerHome" ? `2px solid ${T.accent}` : `1px solid ${T.inputBorder}`, background: rateFormat === "travelPerHome" ? T.accentLight : T.card, color: rateFormat === "travelPerHome" ? T.accent : T.textSec, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.3 }}>
                {travel.code} per 1 {home.code}
                <div style={{ fontSize: 10, fontWeight: 500, marginTop: 2, opacity: 0.8 }}>
                  {marketRate > 0 ? `e.g. ${fmt(marketRate, marketRate < 1 ? 4 : 2)}` : `e.g. 20.68`}
                </div>
              </button>
            </div>
          </div>

          <NumInput value={shopRateInput} onChange={setShopRateInput} placeholder="Type the board number"
            prefix={rateFormat === "homePerTravel" ? home.symbol : travel.symbol} />

          {/* Verdict */}
          {v && shopHomePerTravel > 0 && (
            <div style={{ padding: "12px 14px", borderRadius: 12, background: v.bg, border: `1px solid ${v.color}22` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 22 }}>{v.icon}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: v.color }}>{v.label}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.textSec }}>
                <span>You'd pay per 1 {travel.code}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>{home.symbol}{fmt(shopHomePerTravel, 4)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.textSec }}>
                <span>Mid-market is</span>
                <span style={{ fontFamily: "'DM Mono', monospace" }}>{home.symbol}{fmt(midHomePerTravel, 4)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 4, paddingTop: 4, borderTop: `1px solid ${v.color}22` }}>
                <span style={{ fontWeight: 700, color: v.color }}>Difference</span>
                <span style={{ fontWeight: 800, color: v.color, fontFamily: "'DM Mono', monospace" }}>
                  {compareDiffPct <= 0 ? "" : "+"}{fmt(compareDiffPct * 100, 2)}%
                </span>
              </div>
              <div style={{ fontSize: 11, color: T.textSec, marginTop: 6 }}>
                On a {home.symbol}5,000 change, that's about {home.symbol}{fmt(Math.abs(5000 * compareDiffPct))} {compareDiffPct <= 0 ? "saved" : "lost"} vs mid-market.
              </div>
            </div>
          )}

          <Btn onClick={addToCompare} disabled={shopHomePerTravel <= 0} variant="secondary">
            + Add to comparison
          </Btn>
        </div>
      </Card>

      {/* Comparison list */}
      {compareList.length > 0 && (
        <Card title={`⚖️ Comparing ${compareList.length} Shop${compareList.length > 1 ? "s" : ""}`}
          action={<button onClick={clearCompare} style={{ background: "none", border: "none", color: T.textTer, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Clear</button>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...compareList].sort((a, b) => a.homePerTravel - b.homePerTravel).map((c) => {
              const isBest = c.id === bestId;
              const diff = diffVsMid(c.homePerTravel);
              const cv = verdict(diff);
              return (
                <div key={c.id} style={{
                  background: isBest ? T.goodBg : T.input,
                  border: isBest ? `2px solid ${T.good}` : `1px solid ${T.divider}`,
                  borderRadius: 10, padding: "10px 12px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isBest && <span style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: T.good, padding: "1px 6px", borderRadius: 20 }}>BEST</span>}
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</span>
                      </div>
                      <div style={{ fontSize: 11, color: T.textTer, marginTop: 2 }}>
                        Board: {c.format === "homePerTravel" ? home.symbol : travel.symbol}{fmt(c.raw, 4)} → {home.symbol}{fmt(c.homePerTravel, 4)}/{travel.code}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {diff !== null && (
                        <span style={{ fontSize: 13, fontWeight: 800, color: cv?.color, fontFamily: "'DM Mono', monospace" }}>
                          {diff <= 0 ? "" : "+"}{fmt(diff * 100, 2)}%
                        </span>
                      )}
                      <button onClick={() => removeFromCompare(c.id)} style={{ background: "none", border: "none", color: T.textTer, fontSize: 15, cursor: "pointer", padding: 2 }}>✕</button>
                    </div>
                  </div>
                  <button onClick={() => changeHere(c)}
                    style={{ marginTop: 8, width: "100%", background: isBest ? T.good : T.card, border: isBest ? "none" : `1px solid ${T.inputBorder}`, borderRadius: 8, color: isBest ? "#fff" : T.textSec, padding: "7px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    💱 Change here
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Beginner guide */}
      <Card>
        <button onClick={() => setShowGuide(!showGuide)}
          style={{ width: "100%", background: "none", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>📖 First time? How to read exchange boards</span>
          <span style={{ fontSize: 14, color: T.textTer }}>{showGuide ? "▲" : "▼"}</span>
        </button>
        {showGuide && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: T.textSec, lineHeight: 1.5 }}>
            <div style={{ padding: "10px 12px", background: T.accentLight, borderRadius: 8 }}>
              <strong style={{ color: T.accent }}>You are BUYING {travel.code} with your {home.code}.</strong> The shop is selling you foreign currency. Answers below match the format toggle you picked above (<strong>{rateFormat === "homePerTravel" ? `${home.symbol} per 1 ${travel.code}` : `${travel.code} per 1 ${home.code}`}</strong>).
            </div>

            {/* Q1: Buy vs Sell — does NOT depend on format */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ color: T.text }}>Buy or Sell column?</strong>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#fff", background: T.accent, padding: "2px 10px", borderRadius: 20, whiteSpace: "nowrap" }}>SELL</span>
              </div>
              <p style={{ margin: "4px 0 0" }}>
                Boards show two columns ("WE BUY" / "WE SELL") from the <em>shop's</em> point of view. The shop is <em>selling</em> you {travel.code}, so read the <strong>SELL</strong> column (sometimes "We Sell" or "Ask").
              </p>
            </div>

            {/* Q2: Highest or lowest — FLIPS with format */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ color: T.text }}>Highest or lowest number?</strong>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#fff", background: T.good, padding: "2px 10px", borderRadius: 20, whiteSpace: "nowrap" }}>
                  {rateFormat === "homePerTravel" ? "LOWEST" : "HIGHEST"}
                </span>
              </div>
              <p style={{ margin: "4px 0 0" }}>
                {rateFormat === "homePerTravel" ? (
                  <>With the <strong>{home.symbol} per 1 {travel.code}</strong> format (like {home.symbol}{midHomePerTravel > 0 ? fmt(midHomePerTravel, midHomePerTravel < 1 ? 4 : 2) : "0.05"}), you want the <strong>lowest</strong> number — you're paying fewer {home.code} for each {travel.code}.</>
                ) : (
                  <>With the <strong>{travel.code} per 1 {home.code}</strong> format (like {marketRate > 0 ? fmt(marketRate, marketRate < 1 ? 4 : 2) : "20.68"}), you want the <strong>highest</strong> number — you're getting more {travel.code} for each {home.code}.</>
                )}
              </p>
            </div>

            {/* Q3: tricks */}
            <div>
              <strong style={{ color: T.text }}>Watch for tricks</strong>
              <p style={{ margin: "4px 0 0" }}>
                "No commission" shops often bake a worse rate into the board. A big bright number on the street sign might be the <em>{rateFormat === "homePerTravel" ? "buy" : "buy"}</em> rate, not yours. Always confirm the SELL rate and ask exactly how much {travel.code} you'll receive before handing over cash.
              </p>
            </div>

            {/* Q4: benchmarks */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ color: T.text }}>What's a good rate?</strong>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#fff", background: T.good, padding: "2px 10px", borderRadius: 20, whiteSpace: "nowrap" }}>WITHIN 1%</span>
              </div>
              <p style={{ margin: "4px 0 0" }}>
                Within ~1% of mid-market is great. 1–2.5% is normal. Over 5% away, walk to the next shop — on a busy exchange street there's always a better one nearby.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* Record exchange */}
      <div ref={recordRef} style={{ scrollMarginTop: 56 }}>
      <Card title={`✍️ Record an Exchange`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {lockRate > 0 ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 10px", background: T.goodBg, borderRadius: 8 }}>
              <span style={{ fontSize: 12, color: T.good, fontWeight: 700 }}>
                Changing at {shop || "this shop"}: 1 {home.code} = {fmt(lockRate, 4)} {travel.code}
              </span>
              <button onClick={clearLock} aria-label="Stop using board rate" style={{ background: "none", border: "none", color: T.good, fontSize: 15, cursor: "pointer", padding: 2 }}>✕</button>
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: T.textTer }}>
              Already changed money? Log the actual amounts here to track your wallet.
            </p>
          )}
          <input value={shop} onChange={(e) => setShop(e.target.value)} enterKeyHint="done" placeholder="Shop / location"
            style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <NumInput value={homeAmt} onChange={onHomeChange} placeholder="You gave" suffix={home.code} />
            <NumInput value={travelAmt} onChange={onTravelChange} placeholder="You got" suffix={travel.code} />
          </div>
          {lockRate > 0 && autoField && (
            <div style={{ fontSize: 11, color: T.textTer, marginTop: -4 }}>
              {autoField === "travel" ? `"You got" is calculated at the board rate.` : `"You gave" is calculated at the board rate.`} Change it if the counter gives a different amount.
            </div>
          )}
          {shopRate > 0 && (
            <div style={{ background: T.input, borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: T.textSec }}>Effective rate</span>
                <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'DM Mono', monospace" }}>1 {home.code} = {fmt(shopRate, 4)}</span>
              </div>
              {marketRate > 0 && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: T.textTer }}>vs. market</span>
                    <RateBadge diffPct={diffPct} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: T.textTer }}>Difference</span>
                    <DiffBadge value={diffAmt} sym={home.symbol} />
                  </div>
                </>
              )}
            </div>
          )}
          <Btn onClick={addExchange} disabled={!(parseFloat(homeAmt) > 0) || !(parseFloat(travelAmt) > 0)}>+ Add to Wallet</Btn>
        </div>
      </Card>
      </div>

      {/* Exchange history */}
      {wallet.exchanges.length > 0 && (
        <Card title="Exchange History">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {wallet.exchanges.map((ex) => {
              if (editingExId === ex.id) {
                return <ExchangeEditor key={ex.id} ex={ex} home={home} travel={travel}
                  onSave={saveExchange} onCancel={() => setEditingExId(null)} />;
              }
              const snap = ex.marketRateAtTime || null;
              const d = snap ? (snap - ex.rate) / snap : null;
              return (
                <div key={ex.id} style={{ background: T.input, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{home.symbol}{fmt(ex.homeAmount)} → {travel.symbol}{fmt(ex.travelAmount)}</div>
                      <div style={{ fontSize: 11, color: T.textTer, marginTop: 2 }}>{ex.shop} · {ex.date}{ex.editedAt ? " · edited" : ""}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button onClick={() => setEditingExId(ex.id)}
                        style={{ background: T.accentLight, border: "none", borderRadius: 6, color: T.accent, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "5px 12px", fontFamily: "inherit" }}>Edit</button>
                      <button onClick={() => removeExchange(ex.id)} style={{ background: "none", border: "none", color: T.textTer, fontSize: 16, cursor: "pointer", padding: "2px 4px" }}>✕</button>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.divider}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: T.textTer }}>Shop rate</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>{fmt(ex.rate, 4)}</span>
                    </div>
                    {snap && (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                          <span style={{ color: T.textTer }}>Market at time</span>
                          <span style={{ fontFamily: "'DM Mono', monospace", color: T.textSec }}>{fmt(snap, 4)}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                          <span style={{ color: T.textTer }}>Difference</span>
                          <RateBadge diffPct={d} />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Exchange Editor (inline in Exchange History) ───────────────────────────

function ExchangeEditor({ ex, home, travel, onSave, onCancel }) {
  const [shop, setShop] = useState(ex.shop || "");
  const [homeAmt, setHomeAmt] = useState(String(ex.homeAmount ?? ""));
  const [travelAmt, setTravelAmt] = useState(String(ex.travelAmount ?? ""));
  const [mkt, setMkt] = useState(ex.marketRateAtTime ? fmtRate(ex.marketRateAtTime) : "");
  const h = parseFloat(homeAmt) || 0, t = parseFloat(travelAmt) || 0, m = parseFloat(mkt) || 0;
  const rate = h > 0 && t > 0 ? t / h : 0;
  const canSave = rate > 0;

  const save = () => {
    if (!canSave) return;
    onSave({ ...ex, shop: shop.trim() || "Unknown", homeAmount: String(h), travelAmount: String(t), rate,
      marketRateAtTime: m > 0 ? m : null, editedAt: new Date().toLocaleString() });
  };

  return (
    <div style={{ background: T.card, border: `2px solid ${T.accent}`, borderRadius: 10, padding: "12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: T.accent }}>✏️ Edit exchange</div>
      <input value={shop} onChange={(e) => setShop(e.target.value)} enterKeyHint="done" placeholder="Shop / location"
        style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <NumInput value={homeAmt} onChange={setHomeAmt} placeholder="You gave" suffix={home.code} />
        <NumInput value={travelAmt} onChange={setTravelAmt} placeholder="You got" suffix={travel.code} />
      </div>
      <div>
        <label style={{ fontSize: 11, color: T.textTer, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Market rate at the time (optional)</label>
        <NumInput value={mkt} onChange={setMkt} placeholder="Market rate" prefix={`1 ${home.code} =`} suffix={travel.code} style={{ marginTop: 4 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "8px 10px", background: T.input, borderRadius: 8 }}>
        <span style={{ color: T.textSec }}>Rate <span style={{ color: T.textTer, fontSize: 11 }}>(was {fmt(ex.rate, 4)})</span></span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 800 }}>{rate > 0 ? fmt(rate, 4) : "—"}</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={save} disabled={!canSave} style={{ flex: 1 }}>Save</Btn>
        <Btn onClick={onCancel} variant="secondary" style={{ flex: 1 }}>Cancel</Btn>
      </div>
    </div>
  );
}

// ─── Spend Tab ──────────────────────────────────────────────────────────────

function SpendTab({ state, update, updateWallet, home, travel, wallet, walletCode }) {
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [method, setMethod] = useState("cash");
  const [surcharge, setSurcharge] = useState("0");
  const [cardIdx, setCardIdx] = useState(0);
  const [editingId, setEditingId] = useState(null);

  const amt = parseFloat(amount) || 0;
  const sur = parseFloat(surcharge) || 0;
  const amtWithSurcharge = amt * (1 + sur / 100);
  const marketRate = parseFloat(wallet.marketRate) || 0;

  const walletHome = wallet.exchanges.reduce((s, e) => s + (parseFloat(e.homeAmount) || 0), 0);
  const walletTravel = wallet.exchanges.reduce((s, e) => s + (parseFloat(e.travelAmount) || 0), 0);
  const blendedRate = walletHome > 0 ? walletTravel / walletHome : 0;

  // Cash valued at your exchange rate; if this wallet has no exchanges (only existing cash), use the market rate
  const cashRate = blendedRate > 0 ? blendedRate : marketRate;
  const cashCostHome = cashRate > 0 ? amt / cashRate : 0;
  const cashCostMarket = marketRate > 0 ? amt / marketRate : 0;

  const selectedCard = state.cards[cardIdx];
  const cardInfo = selectedCard ? cardRateInfo(wallet, selectedCard) : { rate: 0, auto: true };
  const cardRateVal = cardInfo.rate;
  const cardCostHome = cardRateVal > 0 ? amtWithSurcharge / cardRateVal : 0;
  const cardCostMarket = marketRate > 0 ? amtWithSurcharge / marketRate : 0;

  const currentCost = method === "cash" ? cashCostHome : cardCostHome;

  const addPayment = () => {
    if (!amt || currentCost <= 0) return;
    const p = {
      id: Date.now(), amount, description: desc || "Payment", method,
      surcharge: method === "cash" ? 0 : sur,
      costHome: currentCost,
      date: new Date().toLocaleString(),
      cardId: method !== "cash" ? selectedCard?.id : null,
      cardName: method !== "cash" ? selectedCard?.name : null,
      cardRateAtTime: method !== "cash" ? cardRateVal : null,
      cardRateAuto: method !== "cash" ? cardInfo.auto : null,
      blendedRateAtTime: method === "cash" ? cashRate : null,
      marketRateAtTime: marketRate || null,
    };
    updateWallet(walletCode, { payments: [...wallet.payments, p] });
    setAmount(""); setDesc(""); setSurcharge("0");
  };

  const removePayment = (id) => {
    if (!confirm("Delete this expense?")) return;
    updateWallet(walletCode, { payments: wallet.payments.filter((p) => p.id !== id) });
    if (editingId === id) setEditingId(null);
  };

  const savePayment = (updated) => {
    updateWallet(walletCode, { payments: wallet.payments.map((p) => (p.id === updated.id ? updated : p)) });
    setEditingId(null);
  };

  // Typed card rate for this wallet; clearing it goes back to automatic
  const setCardOverride = (cardId, rate) => {
    const ov = { ...(wallet.cardOverrides || {}) };
    if (rate === "" || rate == null) delete ov[cardId];
    else ov[cardId] = { rate, at: Date.now() };
    updateWallet(walletCode, { cardOverrides: ov });
  };
  const updateCard = (i, patch) => {
    const nc = [...state.cards]; nc[i] = { ...nc[i], ...patch }; update({ cards: nc });
  };

  const addCard = () => {
    update({ cards: [...state.cards, { id: String(Date.now()), name: "New Card", markup: "0" }] });
  };

  const removeCard = (idx) => {
    update({ cards: state.cards.filter((_, i) => i !== idx) });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Wallet indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: T.accentLight, borderRadius: 10 }}>
        <span style={{ fontSize: 18 }}>{travel.flag}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.accent }}>{travel.code} Wallet</span>
      </div>

      {/* Card rates for this wallet */}
      <Card title={`Cards (${travel.code} per 1 ${home.code})`}
        action={<button onClick={addCard} style={{ background: T.accentLight, border: "none", borderRadius: 8, color: T.accent, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Card</button>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {state.cards.map((card, i) => {
            const info = cardRateInfo(wallet, card);
            const typed = wallet.cardOverrides?.[card.id];
            return (
              <div key={card.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 118px auto", gap: 6, alignItems: "center" }}>
                  <input value={card.name} enterKeyHint="done" onChange={(e) => updateCard(i, { name: e.target.value })}
                    style={{ minWidth: 0, background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 8, color: T.text, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", outline: "none" }} />
                  <NumInput value={card.markup ?? ""} onChange={(v) => updateCard(i, { markup: v })} placeholder="0" suffix="% fee" />
                  {state.cards.length > 1 ? (
                    <button onClick={() => { if (confirm(`Remove ${card.name}?`)) removeCard(i); }} style={{ background: "none", border: "none", color: T.textTer, cursor: "pointer", padding: 2, fontSize: 14 }}>✕</button>
                  ) : <span />}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, alignItems: "center" }}>
                  <NumInput value={typed?.rate || ""} onChange={(v) => setCardOverride(card.id, v)}
                    placeholder={info.autoRate > 0 ? `${fmtRate(info.autoRate)} (auto)` : "Rate"} prefix="Rate" />
                  {typed?.rate ? (
                    <button onClick={() => setCardOverride(card.id, "")}
                      style={{ background: T.accentLight, border: "none", borderRadius: 6, color: T.accent, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>↺ Auto</button>
                  ) : (
                    <span style={{ fontSize: 10, fontWeight: 800, color: T.good, background: T.goodBg, padding: "3px 8px", borderRadius: 20 }}>AUTO</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: T.textTer }}>
                  {typed?.rate ? `Your rate, typed ${fmtWhen(typed.at)}` : info.autoRate > 0 ? `Market rate + ${info.fee}% fee` : "Needs the market rate (Exchange tab)"}
                </div>
              </div>
            );
          })}
          <p style={{ margin: 0, fontSize: 11, color: T.textTer }}>
            Rates are calculated from the market rate and each card's fee. To use your bank's exact rate, type it in. Changes never affect past expenses.
          </p>
        </div>
      </Card>

      {/* Record spend */}
      <Card title="Record a Spend">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} enterKeyHint="done" placeholder="What did you buy?"
            style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
          <NumInput value={amount} onChange={setAmount} placeholder="Amount" suffix={travel.code} />

          {/* Method */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => setMethod("cash")}
              style={{ flex: "1 1 auto", padding: "10px", borderRadius: 10, border: method === "cash" ? `2px solid ${T.accent}` : `1px solid ${T.inputBorder}`, background: method === "cash" ? T.accentLight : T.card, color: method === "cash" ? T.accent : T.textSec, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              💵 Cash
            </button>
            {state.cards.map((card, i) => (
              <button key={card.id} onClick={() => { setMethod("card"); setCardIdx(i); }}
                style={{ flex: "1 1 auto", padding: "10px", borderRadius: 10, border: method === "card" && cardIdx === i ? `2px solid ${T.accent}` : `1px solid ${T.inputBorder}`, background: method === "card" && cardIdx === i ? T.accentLight : T.card, color: method === "card" && cardIdx === i ? T.accent : T.textSec, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                💳 {card.name}
              </button>
            ))}
          </div>

          {method === "card" && (
            <NumInput value={surcharge} onChange={setSurcharge} placeholder="0" prefix="Surcharge" suffix="%" />
          )}

          {/* Cost preview */}
          {amt > 0 && (
            <div style={{ background: T.input, borderRadius: 10, padding: "12px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, color: T.textSec, fontWeight: 700 }}>Real cost to you:</div>

              {method === "cash" && cashRate > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, color: T.textSec }}>Cash ({blendedRate > 0 ? "your exchange rate" : "market rate"})</span>
                    <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "'DM Mono', monospace" }}>{home.symbol}{fmt(cashCostHome)}</span>
                  </div>
                  {marketRate > 0 && blendedRate > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, color: T.textTer }}>vs. market rate</span>
                      <DiffBadge value={cashCostHome - cashCostMarket} sym={home.symbol} />
                    </div>
                  )}
                </div>
              )}
              {method === "cash" && cashRate === 0 && (
                <p style={{ margin: 0, fontSize: 12, color: T.bad }}>Set the market rate (Exchange tab) or add an exchange first</p>
              )}

              {method === "card" && cardRateVal > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, color: T.textSec }}>{selectedCard.name}{cardInfo.auto ? " (auto rate)" : ""}</span>
                    <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "'DM Mono', monospace" }}>{home.symbol}{fmt(cardCostHome)}</span>
                  </div>
                  {sur > 0 && <div style={{ fontSize: 11, color: T.warn }}>Includes {sur}% surcharge ({travel.symbol}{fmt(amtWithSurcharge - amt)} extra)</div>}
                  {cashRate > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, color: T.textTer }}>vs. cash</span>
                      <DiffBadge value={cardCostHome - cashCostHome} sym={home.symbol} />
                    </div>
                  )}
                  {marketRate > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, color: T.textTer }}>vs. market</span>
                      <DiffBadge value={cardCostHome - cardCostMarket} sym={home.symbol} />
                    </div>
                  )}
                </div>
              )}
              {method === "card" && cardRateVal === 0 && (
                <p style={{ margin: 0, fontSize: 12, color: T.bad }}>Set the market rate (Exchange tab) or type this card's rate above</p>
              )}

              {/* Recommendation */}
              {method === "card" && cardRateVal > 0 && cashRate > 0 && (
                <div style={{ marginTop: 4, padding: "8px 10px", borderRadius: 8, background: cardCostHome < cashCostHome ? T.goodBg : T.warnBg, border: `1px solid ${cardCostHome < cashCostHome ? "rgba(22,163,89,0.15)" : "rgba(224,137,18,0.15)"}` }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: cardCostHome < cashCostHome ? T.good : T.warn }}>
                    💡 {cardCostHome < cashCostHome ? `Card saves ${home.symbol}${fmt(Math.abs(cashCostHome - cardCostHome))}` : `Cash saves ${home.symbol}${fmt(Math.abs(cardCostHome - cashCostHome))}`}
                  </span>
                </div>
              )}
            </div>
          )}
          <Btn onClick={addPayment} disabled={!amt || currentCost <= 0}>+ Log Spend</Btn>
        </div>
      </Card>

      {/* Spend history */}
      {wallet.payments.length > 0 && (
        <Card title="Spend History">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...wallet.payments].reverse().map((p) => editingId === p.id ? (
              <PaymentEditor key={p.id} p={p} state={state} wallet={wallet} home={home} travel={travel}
                cashRate={cashRate} onSave={savePayment} onCancel={() => setEditingId(null)} />
            ) : (
              <div key={p.id} style={{ background: T.input, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.description}</div>
                    <div style={{ fontSize: 12, color: T.textSec, marginTop: 2 }}>
                      {travel.symbol}{fmt(p.amount)} · {p.method === "cash" ? "💵 Cash" : `💳 ${p.cardName || "Card"}`}
                      {p.surcharge > 0 && ` +${p.surcharge}%`}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button onClick={() => setEditingId(p.id)}
                      style={{ background: T.accentLight, border: "none", borderRadius: 6, color: T.accent, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "5px 12px", fontFamily: "inherit" }}>Edit</button>
                    <button onClick={() => removePayment(p.id)} style={{ background: "none", border: "none", color: T.textTer, fontSize: 16, cursor: "pointer", padding: "2px 4px" }}>✕</button>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.divider}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: T.textTer }}>Cost</span>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>{home.symbol}{fmt(p.costHome)}</span>
                  </div>
                  {p.method === "cash" && p.blendedRateAtTime && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: T.textTer }}>Cash rate used</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: T.textSec }}>{fmt(p.blendedRateAtTime, 4)}</span>
                    </div>
                  )}
                  {p.method !== "cash" && p.cardRateAtTime && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: T.textTer }}>{p.cardName} rate used{p.cardRateAuto ? " (auto)" : ""}</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: T.textSec }}>{fmt(p.cardRateAtTime, 4)}</span>
                    </div>
                  )}
                  {p.marketRateAtTime && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: T.textTer }}>Market rate</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: T.textSec }}>{fmt(p.marketRateAtTime, 4)}</span>
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: T.textTer, marginTop: 2 }}>{p.date}{p.editedAt ? " · edited" : ""}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Payment Editor (inline in Spend History) ───────────────────────────────

function PaymentEditor({ p, state, wallet, home, travel, cashRate, onSave, onCancel }) {
  const roundRate = (r) => (r > 0 ? String(Number(Number(r).toPrecision(8))) : "");
  const origAmt = parseFloat(p.amount) || 0;
  const origSur = p.method === "cash" ? 0 : parseFloat(p.surcharge) || 0;
  // Rate originally used: the saved snapshot, or implied from the saved cost for older entries
  const impliedRate = p.costHome > 0 ? (origAmt * (1 + origSur / 100)) / p.costHome : 0;
  const origRate = (p.method === "cash" ? p.blendedRateAtTime : p.cardRateAtTime) || impliedRate;

  const initialKey = (() => {
    if (p.method === "cash") return "cash";
    const byId = p.cardId && state.cards.find((c) => c.id === p.cardId);
    if (byId) return byId.id;
    const byName = state.cards.find((c) => c.name === p.cardName);
    return byName ? byName.id : "__orig__"; // card since renamed/deleted: keep it as an option
  })();

  const [desc, setDesc] = useState(p.description || "");
  const [amount, setAmount] = useState(String(p.amount ?? ""));
  const [key, setKey] = useState(initialKey);
  const [surcharge, setSurcharge] = useState(String(origSur));
  const [rate, setRate] = useState(roundRate(origRate));
  const [rateAuto, setRateAuto] = useState(p.method === "cash" ? null : p.cardRateAuto ?? null);

  const options = [
    { key: "cash", label: "💵 Cash" },
    ...state.cards.map((c) => ({ key: c.id, label: `💳 ${c.name}` })),
    ...(initialKey === "__orig__" ? [{ key: "__orig__", label: `💳 ${p.cardName || "Card"}` }] : []),
  ];

  // Switching method loads the matching rate; switching back restores the original one
  const pickMethod = (k) => {
    setKey(k);
    if (k === initialKey) { setRate(roundRate(origRate)); setRateAuto(p.method === "cash" ? null : p.cardRateAuto ?? null); }
    else if (k === "cash") { setRate(roundRate(cashRate)); setRateAuto(null); }
    else {
      const info = cardRateInfo(wallet, state.cards.find((c) => c.id === k));
      setRate(roundRate(info.rate)); setRateAuto(info.auto);
    }
  };

  const isCash = key === "cash";
  const a = parseFloat(amount) || 0;
  const r = parseFloat(rate) || 0;
  const s = isCash ? 0 : parseFloat(surcharge) || 0;
  const cost = r > 0 ? (a * (1 + s / 100)) / r : 0;
  const canSave = a > 0 && r > 0;

  const save = () => {
    if (!canSave) return;
    const card = !isCash && key !== "__orig__" ? state.cards.find((c) => c.id === key) : null;
    onSave({
      ...p,
      description: desc.trim() || "Payment",
      amount: String(a),
      method: isCash ? "cash" : "card",
      surcharge: s,
      costHome: cost,
      cardId: isCash ? null : card ? card.id : p.cardId || null,
      cardName: isCash ? null : card ? card.name : p.cardName,
      cardRateAtTime: isCash ? null : r,
      cardRateAuto: isCash ? null : rateAuto,
      blendedRateAtTime: isCash ? r : null,
      editedAt: new Date().toLocaleString(),
    });
  };

  return (
    <div style={{ background: T.card, border: `2px solid ${T.accent}`, borderRadius: 10, padding: "12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: T.accent }}>✏️ Edit expense</div>
      <input value={desc} onChange={(e) => setDesc(e.target.value)} enterKeyHint="done" placeholder="What did you buy?"
        style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
      <NumInput value={amount} onChange={setAmount} placeholder="0" suffix={travel.code} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {options.map((o) => (
          <button key={o.key} onClick={() => pickMethod(o.key)}
            style={{ flex: "1 1 auto", padding: "8px", borderRadius: 10, border: key === o.key ? `2px solid ${T.accent}` : `1px solid ${T.inputBorder}`, background: key === o.key ? T.accentLight : T.card, color: key === o.key ? T.accent : T.textSec, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {o.label}
          </button>
        ))}
      </div>
      {!isCash && <NumInput value={surcharge} onChange={setSurcharge} placeholder="0" prefix="Surcharge" suffix="%" />}
      <div>
        <label style={{ fontSize: 11, color: T.textTer, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Rate used</label>
        <NumInput value={rate} onChange={(v) => { setRate(v); setRateAuto(false); }} placeholder="Rate" prefix={`1 ${home.code} =`} suffix={travel.code} style={{ marginTop: 4 }} />
        <div style={{ fontSize: 11, color: T.textTer, marginTop: 4 }}>Kept from when you logged it. Change it only if it was wrong.</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "8px 10px", background: T.input, borderRadius: 8 }}>
        <span style={{ color: T.textSec }}>Cost <span style={{ color: T.textTer, fontSize: 11 }}>(was {home.symbol}{fmt(p.costHome)})</span></span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 800 }}>{cost > 0 ? `${home.symbol}${fmt(cost)}` : "—"}</span>
      </div>
      {r === 0 && <p style={{ margin: 0, fontSize: 11, color: T.bad }}>Enter the rate to calculate the cost</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={save} disabled={!canSave} style={{ flex: 1 }}>Save</Btn>
        <Btn onClick={onCancel} variant="secondary" style={{ flex: 1 }}>Cancel</Btn>
      </div>
    </div>
  );
}

// ─── Data Tab ───────────────────────────────────────────────────────────────

function DataTab({ state, setState, update, fileInputRef, rateStatus }) {
  const [keyDraft, setKeyDraft] = useState(state.oxrKey || "");
  const walletCodes = Object.keys(state.wallets);
  const hourlyActive = state.oxrKey && !rateStatus.oxrError &&
    Object.values(state.rates?.byCode || {}).some((q) => q.freq === "hourly");
  const totalExch = walletCodes.reduce((s, c) => s + (state.wallets[c].exchanges?.length || 0), 0);
  const totalPay = walletCodes.reduce((s, c) => s + (state.wallets[c].payments?.length || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card title="Summary">
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {[
            ["Wallets", walletCodes.length],
            ["Currencies", walletCodes.join(", ") || "None"],
            ["Total exchanges", totalExch],
            ["Total payments", totalPay],
            ["Cards configured", state.cards?.length || 0],
          ].map(([label, val]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: T.textSec }}>{label}</span>
              <span style={{ color: T.text, fontWeight: 600 }}>{val}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Market Rates">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.textSec }}>
            Rates update by themselves from free sources that publish once a day.
          </p>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Optional: hourly rates</div>
          <p style={{ margin: 0, fontSize: 12, color: T.textTer }}>
            Create a free account at{" "}
            <a href="https://openexchangerates.org/signup/free" target="_blank" rel="noopener noreferrer" style={{ color: T.accent, fontWeight: 700 }}>openexchangerates.org</a>,
            copy your App ID and paste it below. It stays on this phone and isn't included in backups.
          </p>
          <input value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} enterKeyHint="done"
            placeholder="App ID" autoComplete="off" autoCapitalize="off" spellCheck={false}
            style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "'DM Mono', monospace", outline: "none" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={() => update({ oxrKey: keyDraft.trim() })} disabled={keyDraft.trim() === (state.oxrKey || "")} style={{ flex: 1 }}>Save</Btn>
            {state.oxrKey && (
              <Btn onClick={() => { setKeyDraft(""); update({ oxrKey: "" }); }} variant="secondary" style={{ flex: 1 }}>Remove</Btn>
            )}
          </div>
          {state.oxrKey && (
            <div style={{ fontSize: 12, fontWeight: 700, color: rateStatus.oxrError ? T.bad : hourlyActive ? T.good : T.textTer }}>
              {rateStatus.oxrError ? `App ID not working (${rateStatus.oxrError}). Using daily rates.`
                : hourlyActive ? "✓ Hourly rates active" : rateStatus.loading ? "Checking…" : "Saved. Checks on the next update."}
            </div>
          )}
        </div>
      </Card>

      <Card title="Export">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.textTer }}>JSON backup can be re-imported. CSV is for viewing in Excel / Google Sheets.</p>
          <Btn onClick={() => exportToJSON(state)}>📦 Export JSON Backup</Btn>
          <Btn onClick={() => exportToCSV(state)} variant="success">📊 Export to CSV</Btn>
        </div>
      </Card>

      <Card title="Import">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.textTer }}>Restore from a JSON backup. Replaces all current data.</p>
          <Btn onClick={() => fileInputRef.current?.click()} variant="secondary">📂 Import JSON Backup</Btn>
        </div>
      </Card>

      <Card title="Danger Zone" style={{ borderColor: "rgba(220,38,38,0.2)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.textTer }}>Permanently delete everything. Export a backup first.</p>
          <Btn onClick={() => {
            if (confirm("Reset ALL data? This cannot be undone.")) setState(defaultState());
          }} variant="danger">🗑️ Reset All Data</Btn>
        </div>
      </Card>

      <p style={{ textAlign: "center", fontSize: 10, color: T.textTer, padding: "8px 0" }}>
        Market rates: ExchangeRate-API, European Central Bank (via Frankfurter), Currency-API{state.oxrKey ? ", Open Exchange Rates" : ""}
      </p>
    </div>
  );
}
