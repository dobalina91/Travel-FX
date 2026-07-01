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
  cardRates: {},
  created: new Date().toLocaleString(),
});

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

// ─── Live Rates ─────────────────────────────────────────────────────────────

async function fetchLiveRate(from, to) {
  const apis = [
    {
      name: "ExchangeRate-API",
      url: `https://open.er-api.com/v6/latest/${from}`,
      parse: (d) => d?.rates?.[to],
      getTime: (d) => d?.time_last_update_utc || null,
    },
    {
      name: "Frankfurter",
      url: `https://api.frankfurter.dev/v2/rates?base=${from}&quotes=${to}`,
      parse: (d) => d?.rates?.[to],
      getTime: (d) => d?.date || null,
    },
    {
      name: "Currency-API",
      url: `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from.toLowerCase()}.min.json`,
      parse: (d) => d?.[from.toLowerCase()]?.[to.toLowerCase()],
      getTime: (d) => d?.date || null,
    },
  ];
  // Fetch all in parallel, pick first valid result
  const results = await Promise.allSettled(
    apis.map(async (api) => {
      const res = await fetch(api.url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const rate = api.parse(data);
      if (!rate || isNaN(rate) || rate <= 0) throw new Error("No rate");
      return { rate, source: api.name, time: new Date().toLocaleString(), sourceTime: api.getTime(data) };
    })
  );
  for (const r of results) {
    if (r.status === "fulfilled") return r.value;
  }
  return null;
}

// ─── Export / Import ────────────────────────────────────────────────────────

function exportToJSON(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
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
        type="number" inputMode="decimal" step="any" value={value}
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

function CurrencySelect({ value, onChange, label, exclude }) {
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
  const [liveRates, setLiveRates] = useState({});
  const [rateLoading, setRateLoading] = useState(false);
  const fileInputRef = useRef(null);

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

  // Fetch live rates for all wallets
  const fetchAllRates = useCallback(async () => {
    if (!state) return;
    setRateLoading(true);
    const codes = Object.keys(state.wallets);
    const results = {};
    for (const code of codes) {
      const r = await fetchLiveRate(state.homeCurrency, code);
      if (r) results[code] = r;
    }
    setLiveRates(results);
    setRateLoading(false);
  }, [state?.homeCurrency, Object.keys(state?.wallets || {}).join(",")]);

  useEffect(() => {
    if (state && !loading && Object.keys(state.wallets).length > 0) fetchAllRates();
  }, [loading, Object.keys(state?.wallets || {}).join(",")]);

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await importFromJSON(file);
      const wCount = Object.keys(data.wallets || {}).length;
      if (confirm(`Import backup? This replaces all data (${wCount} wallet${wCount !== 1 ? "s" : ""}).`)) setState(data);
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

  const tabs = [
    { id: "wallet", label: "👛 Wallets" },
    { id: "exchange", label: "💱 Exchange" },
    { id: "spend", label: "💸 Spend" },
    { id: "data", label: "⚙️ Data" },
  ];

  return (
    <div style={{
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
            <select value={state.homeCurrency} onChange={(e) => update({ homeCurrency: e.target.value })}
              style={{ background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 8, color: T.text, padding: "6px 8px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: "pointer", appearance: "none" }}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
            </select>
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
            liveRates={liveRates} rateLoading={rateLoading} fetchAllRates={fetchAllRates} />
        )}
        {tab === "exchange" && (
          aw ? <ExchangeTab state={state} update={update} updateWallet={updateWallet} home={home} travel={travel} wallet={aw} walletCode={awCode} liveRates={liveRates} />
          : <NoWalletMsg onGo={() => setTab("wallet")} />
        )}
        {tab === "spend" && (
          aw ? <SpendTab state={state} update={update} updateWallet={updateWallet} home={home} travel={travel} wallet={aw} walletCode={awCode} />
          : <NoWalletMsg onGo={() => setTab("wallet")} />
        )}
        {tab === "data" && (
          <DataTab state={state} setState={setState} fileInputRef={fileInputRef} />
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

// ─── Wallets Tab ────────────────────────────────────────────────────────────

function WalletsTab({ state, update, updateWallet, home, liveRates, rateLoading, fetchAllRates }) {
  const [showNew, setShowNew] = useState(false);
  const [newCur, setNewCur] = useState("");
  const walletCodes = Object.keys(state.wallets);

  const existing = walletCodes.concat([state.homeCurrency]);

  const createWallet = () => {
    if (!newCur || state.wallets[newCur]) return;
    const w = newWallet(newCur);
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
        const blended = walletHome > 0 ? walletTravel / walletHome : 0;
        const lr = liveRates[code];
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

            {/* Live rate row */}
            {lr && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "6px 8px", background: T.accentLight, borderRadius: 8, fontSize: 11 }}>
                <span style={{ color: T.textSec }}>
                  Live: <strong style={{ fontFamily: "'DM Mono', monospace" }}>{fmt(lr.rate, 4)}</strong> via {lr.source}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    updateWallet(code, { marketRate: String(lr.rate), marketRateUpdated: new Date().toLocaleString(), marketRateSource: lr.source });
                  }}
                  style={{ background: T.accent, border: "none", borderRadius: 6, color: "#fff", padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  Use
                </button>
              </div>
            )}

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
        <button onClick={fetchAllRates} disabled={rateLoading}
          style={{ background: T.accentLight, border: "none", borderRadius: 10, color: T.accent, padding: "10px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          {rateLoading ? "Fetching rates..." : "↻ Refresh All Live Rates"}
        </button>
      )}

      {/* Create wallet */}
      {!showNew ? (
        <Btn onClick={() => setShowNew(true)} variant="primary">+ New Wallet</Btn>
      ) : (
        <Card title="Create New Wallet">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <CurrencySelect value={newCur} onChange={setNewCur} label="Currency" exclude={existing} />
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

function ExchangeTab({ state, update, updateWallet, home, travel, wallet, walletCode, liveRates }) {
  const [homeAmt, setHomeAmt] = useState("");
  const [travelAmt, setTravelAmt] = useState("");
  const [shop, setShop] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  // Rate comparison tool state
  const [shopRateInput, setShopRateInput] = useState("");
  const [rateFormat, setRateFormat] = useState("homePerTravel"); // how the shop quotes
  const [compareList, setCompareList] = useState([]);

  const marketRate = parseFloat(wallet.marketRate) || 0; // travel per home (e.g. 4.14 THB per HKD)
  // Mid-market expressed as home-per-travel (e.g. HKD per THB) for cost comparison
  const midHomePerTravel = marketRate > 0 ? 1 / marketRate : 0;

  const lr = liveRates[walletCode];

  // ── Rate comparison logic ──
  // Normalize any shop input to "home currency spent per 1 travel unit received"
  const rawShopRate = parseFloat(shopRateInput) || 0;
  const shopHomePerTravel = rawShopRate > 0
    ? (rateFormat === "homePerTravel" ? rawShopRate : 1 / rawShopRate)
    : 0;
  // vs mid-market: positive = you pay more than mid (worse)
  const compareDiffPct = midHomePerTravel > 0 && shopHomePerTravel > 0
    ? (shopHomePerTravel - midHomePerTravel) / midHomePerTravel
    : null;

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

  const addToCompare = () => {
    if (shopHomePerTravel <= 0) return;
    setCompareList([...compareList, {
      id: Date.now(),
      name: shop || `Shop ${compareList.length + 1}`,
      homePerTravel: shopHomePerTravel,
      raw: rawShopRate,
      format: rateFormat,
      diff: compareDiffPct,
    }]);
    setShopRateInput("");
    setShop("");
  };

  const removeFromCompare = (id) => setCompareList(compareList.filter((c) => c.id !== id));

  // Best shop = lowest homePerTravel
  const bestId = compareList.length > 0
    ? compareList.reduce((best, c) => (c.homePerTravel < best.homePerTravel ? c : best), compareList[0]).id
    : null;

  // ── Record exchange logic ──
  const shopRate = homeAmt && travelAmt ? parseFloat(travelAmt) / parseFloat(homeAmt) : 0;
  const diffPct = marketRate && shopRate ? (marketRate - shopRate) / marketRate : 0;
  const diffAmt = homeAmt && marketRate && shopRate ? parseFloat(homeAmt) * (marketRate - shopRate) / marketRate : 0;

  const addExchange = () => {
    if (!homeAmt || !travelAmt) return;
    const ex = {
      id: Date.now(), shop: shop || "Unknown", homeAmount: homeAmt, travelAmount: travelAmt,
      rate: shopRate, marketRateAtTime: marketRate || null, date: new Date().toLocaleString(),
    };
    updateWallet(walletCode, { exchanges: [...wallet.exchanges, ex] });
    setHomeAmt(""); setTravelAmt(""); setShop("");
  };

  const removeExchange = (id) => {
    updateWallet(walletCode, { exchanges: wallet.exchanges.filter((e) => e.id !== id) });
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
            onChange={(v) => updateWallet(walletCode, { marketRate: v, marketRateUpdated: new Date().toLocaleString(), marketRateSource: "Manual" })}
            placeholder="e.g. 4.1463" prefix={`1 ${home.code} =`} suffix={travel.code} />
          {marketRate > 0 && (
            <div style={{ fontSize: 12, color: T.textSec, background: T.input, padding: "6px 10px", borderRadius: 8 }}>
              = <strong style={{ fontFamily: "'DM Mono', monospace" }}>1 {travel.code} = {home.symbol}{fmt(midHomePerTravel, 4)}</strong> <span style={{ color: T.textTer }}>(what shops usually quote)</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: T.textTer }}>
              {wallet.marketRateUpdated ? `${wallet.marketRateSource || "Manual"} · ${wallet.marketRateUpdated}` : "Not set"}
            </span>
            <a href={`https://www.xe.com/currencyconverter/convert/?From=${home.code}&To=${travel.code}`}
              target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 11, color: T.accent, textDecoration: "none", fontWeight: 700 }}>Check on XE.com ↗</a>
          </div>
          {lr && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: T.input, borderRadius: 8 }}>
              <div>
                <div style={{ fontSize: 12, color: T.textSec }}>
                  Live: <strong style={{ fontFamily: "'DM Mono', monospace" }}>{fmt(lr.rate, 4)}</strong>
                  <span style={{ color: T.textTer }}> via {lr.source}</span>
                </div>
                {lr.sourceTime && <div style={{ fontSize: 10, color: T.textTer, marginTop: 1 }}>Data: {lr.sourceTime}</div>}
              </div>
              <button onClick={() => updateWallet(walletCode, { marketRate: String(lr.rate), marketRateUpdated: new Date().toLocaleString(), marketRateSource: lr.source })}
                style={{ background: T.accent, border: "none", borderRadius: 6, color: "#fff", padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                Use
              </button>
            </div>
          )}
          {!lr && (
            <div style={{ fontSize: 11, color: T.textTer, fontStyle: "italic" }}>
              Note: the in-app live rate comes from free rate APIs, not XE directly. XE adds its own spread, so numbers may differ slightly. Both are "mid-market" reference rates.
            </div>
          )}
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

          <input value={shop} onChange={(e) => setShop(e.target.value)} placeholder="Shop name (optional)"
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
        <Card title={`⚖️ Comparing ${compareList.length} Shop${compareList.length > 1 ? "s" : ""}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...compareList].sort((a, b) => a.homePerTravel - b.homePerTravel).map((c, i) => {
              const isBest = c.id === bestId;
              const cv = verdict(c.diff);
              return (
                <div key={c.id} style={{
                  background: isBest ? T.goodBg : T.input,
                  border: isBest ? `2px solid ${T.good}` : `1px solid ${T.divider}`,
                  borderRadius: 10, padding: "10px 12px",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
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
                    <span style={{ fontSize: 13, fontWeight: 800, color: cv?.color, fontFamily: "'DM Mono', monospace" }}>
                      {c.diff <= 0 ? "" : "+"}{fmt(c.diff * 100, 2)}%
                    </span>
                    <button onClick={() => removeFromCompare(c.id)} style={{ background: "none", border: "none", color: T.textTer, fontSize: 15, cursor: "pointer", padding: 2 }}>✕</button>
                  </div>
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
      <Card title={`✍️ Record an Exchange`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.textTer }}>
            Already changed money? Log the actual amounts here to track your wallet.
          </p>
          <input value={shop} onChange={(e) => setShop(e.target.value)} placeholder="Shop / location"
            style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <NumInput value={homeAmt} onChange={setHomeAmt} placeholder="You gave" suffix={home.code} />
            <NumInput value={travelAmt} onChange={setTravelAmt} placeholder="You got" suffix={travel.code} />
          </div>
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
          <Btn onClick={addExchange} disabled={!homeAmt || !travelAmt}>+ Add to Wallet</Btn>
        </div>
      </Card>

      {/* Exchange history */}
      {wallet.exchanges.length > 0 && (
        <Card title="Exchange History">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {wallet.exchanges.map((ex) => {
              const snap = ex.marketRateAtTime || null;
              const d = snap ? (snap - ex.rate) / snap : null;
              return (
                <div key={ex.id} style={{ background: T.input, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{home.symbol}{fmt(ex.homeAmount)} → {travel.symbol}{fmt(ex.travelAmount)}</div>
                      <div style={{ fontSize: 11, color: T.textTer, marginTop: 2 }}>{ex.shop} · {ex.date}</div>
                    </div>
                    <button onClick={() => removeExchange(ex.id)} style={{ background: "none", border: "none", color: T.textTer, fontSize: 16, cursor: "pointer", padding: 2 }}>✕</button>
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

// ─── Spend Tab ──────────────────────────────────────────────────────────────

function SpendTab({ state, update, updateWallet, home, travel, wallet, walletCode }) {
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [method, setMethod] = useState("cash");
  const [surcharge, setSurcharge] = useState("0");
  const [cardIdx, setCardIdx] = useState(0);

  const amt = parseFloat(amount) || 0;
  const sur = parseFloat(surcharge) || 0;
  const amtWithSurcharge = amt * (1 + sur / 100);
  const marketRate = parseFloat(wallet.marketRate) || 0;

  const walletHome = wallet.exchanges.reduce((s, e) => s + (parseFloat(e.homeAmount) || 0), 0);
  const walletTravel = wallet.exchanges.reduce((s, e) => s + (parseFloat(e.travelAmount) || 0), 0);
  const blendedRate = walletHome > 0 ? walletTravel / walletHome : 0;

  const cashCostHome = blendedRate > 0 ? amt / blendedRate : 0;
  const cashCostMarket = marketRate > 0 ? amt / marketRate : 0;

  const selectedCard = state.cards[cardIdx];
  const cardRateVal = selectedCard ? parseFloat(wallet.cardRates?.[selectedCard.id] || "") || 0 : 0;
  const cardCostHome = cardRateVal > 0 ? amtWithSurcharge / cardRateVal : 0;
  const cardCostMarket = marketRate > 0 ? amtWithSurcharge / marketRate : 0;

  const addPayment = () => {
    if (!amt) return;
    const p = {
      id: Date.now(), amount, description: desc || "Payment", method, surcharge: sur,
      costHome: method === "cash" ? cashCostHome : cardCostHome,
      date: new Date().toLocaleString(),
      cardName: method !== "cash" ? selectedCard?.name : null,
      cardRateAtTime: method !== "cash" ? cardRateVal : null,
      blendedRateAtTime: method === "cash" ? blendedRate : null,
      marketRateAtTime: marketRate || null,
    };
    updateWallet(walletCode, { payments: [...wallet.payments, p] });
    setAmount(""); setDesc(""); setSurcharge("0");
  };

  const removePayment = (id) => {
    updateWallet(walletCode, { payments: wallet.payments.filter((p) => p.id !== id) });
  };

  const updateCardRate = (cardId, rate) => {
    updateWallet(walletCode, { cardRates: { ...wallet.cardRates, [cardId]: rate } });
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
      <Card title={`Card Rates (${travel.code}/${home.code})`}
        action={<button onClick={addCard} style={{ background: T.accentLight, border: "none", borderRadius: 8, color: T.accent, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Card</button>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {state.cards.map((card, i) => (
            <div key={card.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, alignItems: "center" }}>
              <input value={card.name}
                onChange={(e) => {
                  const nc = [...state.cards]; nc[i] = { ...nc[i], name: e.target.value }; update({ cards: nc });
                }}
                style={{ background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 8, color: T.text, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", outline: "none" }} />
              <NumInput value={wallet.cardRates?.[card.id] || ""} onChange={(v) => updateCardRate(card.id, v)}
                placeholder="Rate" suffix={`/${home.code}`} />
              {state.cards.length > 1 && (
                <button onClick={() => removeCard(i)} style={{ background: "none", border: "none", color: T.textTer, cursor: "pointer", padding: 2, fontSize: 14 }}>✕</button>
              )}
            </div>
          ))}
          <p style={{ margin: 0, fontSize: 11, color: T.textTer }}>
            Rate per 1 {home.code} for this wallet. Updates here won't affect past transactions.
          </p>
        </div>
      </Card>

      {/* Record spend */}
      <Card title="Record a Spend">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What did you buy?"
            style={{ width: "100%", boxSizing: "border-box", background: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text, padding: "10px 14px", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
          <NumInput value={amount} onChange={setAmount} placeholder="0" suffix={travel.code} />

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

              {method === "cash" && blendedRate > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, color: T.textSec }}>Cash (blended rate)</span>
                    <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "'DM Mono', monospace" }}>{home.symbol}{fmt(cashCostHome)}</span>
                  </div>
                  {marketRate > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, color: T.textTer }}>vs. market rate</span>
                      <DiffBadge value={cashCostHome - cashCostMarket} sym={home.symbol} />
                    </div>
                  )}
                </div>
              )}
              {method === "cash" && blendedRate === 0 && (
                <p style={{ margin: 0, fontSize: 12, color: T.bad }}>Add exchanges first to calculate cash cost</p>
              )}

              {method === "card" && cardRateVal > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, color: T.textSec }}>{selectedCard.name}</span>
                    <span style={{ fontSize: 16, fontWeight: 800, fontFamily: "'DM Mono', monospace" }}>{home.symbol}{fmt(cardCostHome)}</span>
                  </div>
                  {sur > 0 && <div style={{ fontSize: 11, color: T.warn }}>Includes {sur}% surcharge ({travel.symbol}{fmt(amtWithSurcharge - amt)} extra)</div>}
                  {blendedRate > 0 && (
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
                <p style={{ margin: 0, fontSize: 12, color: T.bad }}>Set this card's rate for {travel.code} above first</p>
              )}

              {/* Recommendation */}
              {method === "card" && cardRateVal > 0 && blendedRate > 0 && (
                <div style={{ marginTop: 4, padding: "8px 10px", borderRadius: 8, background: cardCostHome < cashCostHome ? T.goodBg : T.warnBg, border: `1px solid ${cardCostHome < cashCostHome ? "rgba(22,163,89,0.15)" : "rgba(224,137,18,0.15)"}` }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: cardCostHome < cashCostHome ? T.good : T.warn }}>
                    💡 {cardCostHome < cashCostHome ? `Card saves ${home.symbol}${fmt(Math.abs(cashCostHome - cardCostHome))}` : `Cash saves ${home.symbol}${fmt(Math.abs(cardCostHome - cashCostHome))}`}
                  </span>
                </div>
              )}
            </div>
          )}
          <Btn onClick={addPayment} disabled={!amt}>+ Log Spend</Btn>
        </div>
      </Card>

      {/* Spend history */}
      {wallet.payments.length > 0 && (
        <Card title="Spend History">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...wallet.payments].reverse().map((p) => (
              <div key={p.id} style={{ background: T.input, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.description}</div>
                    <div style={{ fontSize: 12, color: T.textSec, marginTop: 2 }}>
                      {travel.symbol}{fmt(p.amount)} · {p.method === "cash" ? "💵 Cash" : `💳 ${p.cardName || "Card"}`}
                      {p.surcharge > 0 && ` +${p.surcharge}%`}
                    </div>
                  </div>
                  <button onClick={() => removePayment(p.id)} style={{ background: "none", border: "none", color: T.textTer, fontSize: 16, cursor: "pointer", padding: 2 }}>✕</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.divider}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: T.textTer }}>Cost</span>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>{home.symbol}{fmt(p.costHome)}</span>
                  </div>
                  {p.method === "cash" && p.blendedRateAtTime && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: T.textTer }}>Blended rate used</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: T.textSec }}>{fmt(p.blendedRateAtTime, 4)}</span>
                    </div>
                  )}
                  {p.method !== "cash" && p.cardRateAtTime && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: T.textTer }}>{p.cardName} rate used</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: T.textSec }}>{fmt(p.cardRateAtTime, 4)}</span>
                    </div>
                  )}
                  {p.marketRateAtTime && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: T.textTer }}>Market rate</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: T.textSec }}>{fmt(p.marketRateAtTime, 4)}</span>
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: T.textTer, marginTop: 2 }}>{p.date}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Data Tab ───────────────────────────────────────────────────────────────

function DataTab({ state, setState, fileInputRef }) {
  const walletCodes = Object.keys(state.wallets);
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
        Live rates by Frankfurter & ExchangeRate-API
      </p>
    </div>
  );
}
