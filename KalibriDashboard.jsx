import { useState, useMemo, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
} from "recharts";

// ─── DATA SOURCE ──────────────────────────────────────────────────────────────
// Drop ohio_kalibri_consolidated.csv into your Replit /public folder.
// To update: just overwrite that file and refresh — no code changes needed.
const DATA_URL = "/ohio_kalibri_consolidated.csv";
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
  Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12",
};

function normalizePeriod(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\w{3})\s*-\s*(\d{4})$/);
  if (m && MONTH_MAP[m[1]]) return `${m[2]}-${MONTH_MAP[m[1]]}`;
  return null;
}

function periodLabel(p) {
  if (!p) return "";
  const [y, mo] = p.split("-");
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[parseInt(mo) - 1]} - ${y}`;
}

function parseNum(v) {
  if (!v || v === "-" || String(v).trim() === "") return null;
  const s = String(v).replace(/[$+,]/g, "");
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return String(v).includes("%") ? n / 100 : n;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));

  // lookup[period][geoKey][revType][tier][losTier] = metrics object
  const lookup = {};
  const geoMeta = {};
  let lastActual = null;

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    const vals = [];
    let inQ = false, cur = "";
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { vals.push(cur); cur = ""; }
      else { cur += ch; }
    }
    vals.push(cur);

    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] ?? "").trim().replace(/^"|"$/g, ""); });

    const market   = row["Market"];
    const submarket = row["Submarket"];
    const revType  = row["Revenue Type"];
    const tier     = row["Tier"];
    const losTier  = row["LOS Tier"] || "";
    const periodRaw = row["Period"];

    if (!market || !revType || !tier || !periodRaw) continue;
    const period = normalizePeriod(periodRaw);
    if (!period) continue;

    const geoKey = submarket ? `${market}::${submarket}` : market;
    if (!geoMeta[geoKey]) {
      geoMeta[geoKey] = { market, submarket: submarket || null, isSubmarket: !!submarket };
    }

    // Detect last actual: ALOS present and not a dash means real data
    if (row["ALOS"] && row["ALOS"] !== "-" && row["ALOS"].trim() !== "") {
      if (!lastActual || period > lastActual) lastActual = period;
    }

    if (!lookup[period]) lookup[period] = {};
    if (!lookup[period][geoKey]) lookup[period][geoKey] = {};
    if (!lookup[period][geoKey][revType]) lookup[period][geoKey][revType] = {};
    if (!lookup[period][geoKey][revType][tier]) lookup[period][geoKey][revType][tier] = {};

    lookup[period][geoKey][revType][tier][losTier] = {
      occ:               parseNum(row["Occ"]),
      occ_yoy:           parseNum(row["Occ - YoY"]),
      adr:               parseNum(row["ADR"]),
      adr_yoy:           parseNum(row["ADR - YoY"]),
      revpar:            parseNum(row["RevPAR"]),
      revpar_yoy:        parseNum(row["RevPAR - YoY"]),
      booking_cost:      parseNum(row["Booking Costs per RN"]),
      booking_cost_yoy:  parseNum(row["Booking Costs per RN - YoY"]),
      alos:              parseNum(row["ALOS"]),
      alos_yoy:          parseNum(row["ALOS - YoY"]),
    };
  }

  return { lookup, geoMeta, lastActual: lastActual || "2026-02" };
}

async function loadData() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(
    `Failed to load: ${res.status} ${res.statusText}\n\nMake sure ohio_kalibri_consolidated.csv is in your Replit /public folder.`
  );
  return parseCSV(await res.text());
}

function getMetrics(lookup, period, geoKey, revType, tier, losTier) {
  return lookup[period]?.[geoKey]?.[revType]?.[tier]?.[losTier] ?? null;
}

// ── Trailing window helpers ─────────────────────────────────────────────────
function getTrailingPeriods(allPeriods, endPeriod, tw) {
  if (tw.id === "ytd") {
    const [y] = endPeriod.split("-");
    return allPeriods.filter(p => p >= `${y}-01` && p <= endPeriod);
  }
  if (tw.id === "mo") return allPeriods.includes(endPeriod) ? [endPeriod] : [];
  return allPeriods.filter(p => p <= endPeriod).slice(-tw.months);
}

function avgMetrics(mList) {
  const keys = ["occ","adr","revpar","booking_cost","alos"];
  const out = {};
  for (const k of keys) {
    const vals = mList.map(m => m?.[k]).filter(v => v != null);
    out[k] = vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : null;
  }
  return out;
}

// Returns aggregated metrics for a trailing window ending at endPeriod.
// For "Month" mode returns stored row (incl. stored YoY).
// For other modes, aggregates by arithmetic mean and recomputes YoY vs same
// window ending 12 months prior. (Proper Occ/ADR weighting requires room
// supply data — will be refined once supply counts are available.)
function computeTrailing(lookup, endPeriod, geoKey, revType, tier, losTier, tw, allPeriods) {
  if (tw.id === "mo") return getMetrics(lookup, endPeriod, geoKey, revType, tier, losTier);

  const ps = getTrailingPeriods(allPeriods, endPeriod, tw);
  if (!ps.length) return null;
  const curr = avgMetrics(ps.map(p => getMetrics(lookup, p, geoKey, revType, tier, losTier)));
  if (curr.occ == null && curr.revpar == null) return null;

  // YoY: same trailing window ending 12 months prior
  const [y, mo] = endPeriod.split("-");
  const priorEnd = `${parseInt(y) - 1}-${mo}`;
  const priorPs  = getTrailingPeriods(allPeriods, priorEnd, tw);
  if (priorPs.length) {
    const prior = avgMetrics(priorPs.map(p => getMetrics(lookup, p, geoKey, revType, tier, losTier)));
    curr.occ_yoy          = curr.occ != null && prior.occ != null ? curr.occ - prior.occ : null;
    curr.adr_yoy          = curr.adr && prior.adr > 0 ? curr.adr / prior.adr - 1 : null;
    curr.revpar_yoy       = curr.revpar && prior.revpar > 0 ? curr.revpar / prior.revpar - 1 : null;
    curr.booking_cost_yoy = curr.booking_cost && prior.booking_cost > 0 ? curr.booking_cost / prior.booking_cost - 1 : null;
    curr.alos_yoy         = curr.alos && prior.alos > 0 ? curr.alos / prior.alos - 1 : null;
  }
  return curr;
}
// ───────────────────────────────────────────────────────────────────────────

function calcCAGR(v1, v2, years) {
  if (!v1 || !v2 || years <= 0 || v1 <= 0) return null;
  return Math.pow(v2 / v1, 1 / years) - 1;
}

const fmt = {
  pct:    v => v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%",
  pp:     v => v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "pp",
  dollar: v => v == null ? "—" : "$" + v.toFixed(2),
  occ:    v => v == null ? "—" : (v * 100).toFixed(1) + "%",
  dec2:   v => v == null ? "—" : v.toFixed(2),
};

function chgColor(v, isOcc = false) {
  if (v == null) return "#475569";
  const threshold = isOcc ? 0.005 : 0.05; // 0.5pp for occ, 5% for rates
  if (v >  threshold) return "#4ade80";
  if (v >  0)         return "#86efac";
  if (v > -threshold) return "#fca5a5";
  return "#f87171";
}

const COLORS = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#06b6d4","#84cc16"];

const METRICS = [
  { key:"occ",          label:"Occupancy",       yoyKey:"occ_yoy",          valFmt: fmt.occ,    yoyFmt: fmt.pp,  isOcc:true },
  { key:"adr",          label:"ADR",              yoyKey:"adr_yoy",          valFmt: fmt.dollar, yoyFmt: fmt.pct },
  { key:"revpar",       label:"RevPAR",           yoyKey:"revpar_yoy",       valFmt: fmt.dollar, yoyFmt: fmt.pct },
  { key:"booking_cost", label:"Booking Cost/RN",  yoyKey:"booking_cost_yoy", valFmt: fmt.dollar, yoyFmt: fmt.pct },
  { key:"alos",         label:"ALOS",             yoyKey:"alos_yoy",         valFmt: fmt.dec2,   yoyFmt: fmt.pct },
];

const TREND_METRICS = [
  { key:"revpar",        label:"RevPAR",          tickFmt: v => "$" + v.toFixed(0) },
  { key:"occ",           label:"Occupancy",       tickFmt: v => (v * 100).toFixed(0) + "%" },
  { key:"adr",           label:"ADR",             tickFmt: v => "$" + v.toFixed(0) },
  { key:"booking_cost",  label:"Booking Cost/RN", tickFmt: v => "$" + v.toFixed(2) },
  { key:"alos",          label:"ALOS",            tickFmt: v => v.toFixed(1) },
];

const CAGR_SORT_OPTIONS = [
  { key:"revpar_cagr", label:"RevPAR CAGR" },
  { key:"adr_cagr",   label:"ADR CAGR"    },
  { key:"occ_delta",  label:"Occ Δ (pp)"  },
];

const TIME_WINDOWS = [
  { id:"12mo", label:"12 Mo", months:12   },
  { id:"3mo",  label:"3 Mo",  months:3    },
  { id:"mo",   label:"Month", months:1    },
  { id:"ytd",  label:"YTD",   months:null },
];

const REV_TYPES   = ["Guest Paid", "Hotel Collected", "COPE"];
const TIERS       = ["All Tier", "Lower Tier", "Mid Tier", "Upper Tier"];
const LOS_OPTIONS = [
  { value:"",     label:"Overview"   },
  { value:"0-6",  label:"0–6 Nights" },
  { value:"7-14", label:"7–14 Nights"},
  { value:"15-29",label:"15–29 Nights"},
  { value:"30+",  label:"30+ Nights" },
];

function CustomTooltip({ active, payload, label, lastActual }) {
  if (!active || !payload?.length) return null;
  const period = payload[0]?.payload?.periodRaw;
  const isForecast = period && period > lastActual;
  return (
    <div style={{ background:"#1e293b", border:`1px solid ${isForecast?"#f59e0b44":"#334155"}`, borderRadius:8, padding:"10px 14px", fontSize:11 }}>
      <div style={{ marginBottom:6, display:"flex", alignItems:"center", gap:6 }}>
        <span style={{ color:"#94a3b8", fontWeight:600 }}>{label}</span>
        {isForecast && <span style={{ background:"#f59e0b22", color:"#f59e0b", fontSize:9, padding:"1px 6px", borderRadius:3, fontWeight:700 }}>FORECAST</span>}
      </div>
      {payload.map((p, i) => (
        <div key={i} style={{ display:"flex", justifyContent:"space-between", gap:16, marginBottom:2 }}>
          <span style={{ color:"#64748b" }}>{p.name}</span>
          <span style={{ color:p.color, fontFamily:"'IBM Plex Mono',monospace", fontWeight:600 }}>
            {p.value != null ? p.value.toFixed(4) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function KalibriDashboard() {
  const [db,         setDb]         = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState(null);

  // filters
  const [revType,      setRevType]      = useState("Guest Paid");
  const [tier,         setTier]         = useState("All Tier");
  const [losTier,      setLosTier]      = useState("");
  const [geoLevel,     setGeoLevel]     = useState("market");
  const [mktFilter,    setMktFilter]    = useState("All");
  const [period1,      setPeriod1]      = useState("");
  const [period2,      setPeriod2]      = useState("");
  const [showForecast, setShowForecast] = useState(false);
  const [timeWindow, setTimeWindow]   = useState("mo");

  // tabs
  const [tab, setTab] = useState("overview");

  // overview
  const [sortKey, setSortKey] = useState("revpar_yoy");
  const [sortDir, setSortDir] = useState("desc");

  // trend
  const [trendMetric, setTrendMetric] = useState("revpar");

  // cagr
  const [cagrStart,    setCagrStart]    = useState("");
  const [cagrEnd,      setCagrEnd]      = useState("");
  const [cagrSortKey,  setCagrSortKey]  = useState("revpar_cagr");
  const [cagrSortDir,  setCagrSortDir]  = useState("desc");

  useEffect(() => {
    loadData()
      .then(d => {
        setDb(d);
        setLoading(false);
        const allPeriods = Object.keys(d.lookup).sort();
        const latestActual = allPeriods.filter(p => p <= d.lastActual).pop() || allPeriods[allPeriods.length - 1];
        const [y, mo] = latestActual.split("-");
        const priorYear  = `${parseInt(y) - 1}-${mo}`;
        const sixYrPrior = `${parseInt(y) - 6}-${mo}`;
        setPeriod1(latestActual);
        setPeriod2(allPeriods.includes(priorYear) ? priorYear : allPeriods[Math.max(0, allPeriods.indexOf(latestActual) - 12)]);
        setCagrEnd(latestActual);
        setCagrStart(allPeriods.includes(sixYrPrior) ? sixYrPrior : allPeriods[0]);
      })
      .catch(e => { setLoadError(e.message); setLoading(false); });
  }, []);

  const periods       = useMemo(() => db ? Object.keys(db.lookup).sort() : [], [db]);
  const lastActual    = useMemo(() => db?.lastActual || "2026-02", [db]);
  const geoMeta       = useMemo(() => db?.geoMeta || {}, [db]);
  const markets       = useMemo(() => [...new Set(Object.values(geoMeta).map(g => g.market).filter(Boolean))].sort(), [geoMeta]);
  const filteredPeriods = useMemo(() =>
    showForecast ? periods : periods.filter(p => p <= lastActual),
    [periods, showForecast, lastActual]
  );
  const tw = useMemo(() => TIME_WINDOWS.find(t => t.id === timeWindow) || TIME_WINDOWS[2], [timeWindow]);

  const filteredGeos = useMemo(() => {
    if (!db) return [];
    return Object.entries(geoMeta)
      .filter(([, v]) => {
        if (geoLevel === "market")    return !v.isSubmarket;
        if (geoLevel === "submarket") return v.isSubmarket && (mktFilter === "All" || v.market === mktFilter);
        return false;
      })
      .map(([k]) => k)
      .sort();
  }, [geoMeta, geoLevel, mktFilter, db]);

  const isForecast = p => p > lastActual;

  // ── Overview rows ──────────────────────────────────────────────────────────
  const overviewRows = useMemo(() => {
    if (!db || !period1) return [];
    const rows = filteredGeos.map(geo => {
      const m = computeTrailing(db.lookup, period1, geo, revType, tier, losTier, tw, periods);
      if (!m) return null;
      const label = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
      const mkt   = geoMeta[geo]?.market || "";
      return { geo, label, mkt, m };
    }).filter(Boolean);

    const dir = sortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a.m[sortKey] ?? null, bv = b.m[sortKey] ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (bv - av);
    });
    return rows;
  }, [db, filteredGeos, period1, revType, tier, losTier, tw, periods, sortKey, sortDir]);

  // ── Trend series ───────────────────────────────────────────────────────────
  const trendData = useMemo(() => {
    if (!db || !filteredGeos.length || !period1) return { series:[], chartData:[] };
    const topGeos = [...filteredGeos]
      .map(g => ({ geo:g, val: computeTrailing(db.lookup, period1, g, revType, tier, losTier, tw, periods)?.[trendMetric] || 0 }))
      .sort((a, b) => b.val - a.val)
      .slice(0, 6)
      .map(g => g.geo);

    const chartData = filteredPeriods
      .filter((_, i) => i % 3 === 0 || i === filteredPeriods.length - 1)
      .map(p => {
        const row = { period: periodLabel(p), periodRaw: p };
        for (const geo of topGeos) {
          const m = computeTrailing(db.lookup, p, geo, revType, tier, losTier, tw, periods);
          const lbl = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
          const val = m?.[trendMetric];
          row[lbl] = val != null ? parseFloat(val.toFixed(6)) : null;
        }
        return row;
      });

    return { series: topGeos.map(g => geoMeta[g]?.submarket || geoMeta[g]?.market || g), chartData };
  }, [db, filteredGeos, period1, revType, tier, losTier, tw, periods, trendMetric, filteredPeriods]);

  // ── CAGR rows ──────────────────────────────────────────────────────────────
  const cagrRows = useMemo(() => {
    if (!db || !cagrStart || !cagrEnd) return [];
    const [sy, sm] = cagrStart.split("-"), [ey, em] = cagrEnd.split("-");
    const years = (parseInt(ey) - parseInt(sy)) + (parseInt(em) - parseInt(sm)) / 12;
    const rows = filteredGeos.map(geo => {
      const ms = computeTrailing(db.lookup, cagrStart, geo, revType, tier, losTier, tw, periods);
      const me = computeTrailing(db.lookup, cagrEnd,   geo, revType, tier, losTier, tw, periods);
      if (!ms?.revpar || !me?.revpar) return null;
      const label = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
      const mkt   = geoMeta[geo]?.market || "";
      return {
        geo, label, mkt,
        revpar_cagr: calcCAGR(ms.revpar, me.revpar, years),
        adr_cagr:   calcCAGR(ms.adr,    me.adr,    years),
        occ_delta:  ms.occ != null && me.occ != null ? me.occ - ms.occ : null,
        ms_revpar:  ms.revpar,
        me_revpar:  me.revpar,
      };
    }).filter(Boolean);

    const dir = cagrSortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[cagrSortKey] ?? null, bv = b[cagrSortKey] ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (bv - av);
    });
    return rows;
  }, [db, filteredGeos, cagrStart, cagrEnd, revType, tier, losTier, tw, periods, cagrSortKey, cagrSortDir]);

  // ── Styles ─────────────────────────────────────────────────────────────────
  const sel = {
    background:"#1e293b", border:"1px solid #334155", color:"#f1f5f9",
    borderRadius:6, padding:"6px 10px", fontSize:12, outline:"none", cursor:"pointer",
  };
  const btnBase = { padding:"5px 13px", borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:600 };
  const Btn = ({ active, onClick, children, color="#3b82f6", style={} }) => (
    <button onClick={onClick} style={{
      ...btnBase,
      background: active ? color : "#1e293b",
      color:      active ? "#fff" : "#64748b",
      border:     active ? "none" : "1px solid #334155",
      ...style,
    }}>{children}</button>
  );
  const thStyle = (align="right") => ({
    textAlign: align, padding:"8px 10px", color:"#475569", fontWeight:600,
    borderBottom:"1px solid #1e293b", whiteSpace:"nowrap", fontSize:11,
  });
  const tdStyle = (align="right") => ({
    textAlign: align, padding:"7px 10px",
    borderBottom:"1px solid #0d1525",
    fontFamily:"'IBM Plex Mono',monospace", fontSize:11,
  });

  // ── Error / Loading states ─────────────────────────────────────────────────
  if (loadError) return (
    <div style={{ background:"#0f172a", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"monospace", padding:40 }}>
      <div style={{ maxWidth:560 }}>
        <div style={{ color:"#ef4444", fontWeight:700, fontSize:14, marginBottom:12 }}>⚠ Could not load data</div>
        <pre style={{ color:"#475569", fontSize:11, lineHeight:1.7, background:"#1e293b", borderRadius:8, padding:"14px 18px", border:"1px solid #334155", whiteSpace:"pre-wrap" }}>{loadError}</pre>
      </div>
    </div>
  );

  if (loading) return (
    <div style={{ background:"#0f172a", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"monospace" }}>
      <div style={{ textAlign:"center", color:"#475569" }}>
        <div style={{ fontSize:28, marginBottom:10 }}>⟳</div>
        <div>Loading Kalibri data…</div>
        <div style={{ fontSize:10, color:"#334155", marginTop:6 }}>{DATA_URL}</div>
      </div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ background:"#0f172a", minHeight:"100vh", fontFamily:"'DM Sans','Segoe UI',sans-serif", color:"#e2e8f0" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* ── Header ── */}
      <div style={{ background:"#0f172a", borderBottom:"1px solid #1e293b", padding:"14px 28px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:2 }}>
            <span style={{ fontSize:13, fontWeight:800, color:"#f8fafc", letterSpacing:-0.5, fontFamily:"'IBM Plex Mono',monospace" }}>spark</span>
            <span style={{ fontSize:11, fontWeight:700, color:"#3b82f6", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:1 }}>GHC</span>
            <span style={{ fontSize:9, color:"#334155", letterSpacing:2, textTransform:"uppercase", fontFamily:"'IBM Plex Mono',monospace" }}>· Asset Management</span>
          </div>
          <div style={{ fontSize:18, fontWeight:700, color:"#f8fafc", letterSpacing:-0.5 }}>Ohio Hospitality Analytics — Kalibri Labs</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ fontSize:10, color:"#475569", fontFamily:"'IBM Plex Mono',monospace" }}>
            Last actual: <span style={{ color:"#94a3b8" }}>{periodLabel(lastActual)}</span>
          </div>
          <Btn active={showForecast} onClick={() => setShowForecast(v => !v)} color="#f59e0b">
            {showForecast ? "Hide Forecast" : "Show Forecast"}
          </Btn>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div style={{ background:"#0b1120", borderBottom:"1px solid #1e293b", padding:"10px 28px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
        {/* Revenue Type */}
        <div style={{ display:"flex", gap:4 }}>
          {REV_TYPES.map(rt => <Btn key={rt} active={revType===rt} onClick={() => setRevType(rt)} color="#3b82f6">{rt}</Btn>)}
        </div>
        <div style={{ width:1, height:22, background:"#1e293b" }}/>

        {/* Tier */}
        <div style={{ display:"flex", gap:4 }}>
          {TIERS.map(t => <Btn key={t} active={tier===t} onClick={() => setTier(t)} color="#10b981">{t.replace(" Tier","")}</Btn>)}
        </div>
        <div style={{ width:1, height:22, background:"#1e293b" }}/>

        {/* LOS */}
        <div style={{ display:"flex", gap:4 }}>
          {LOS_OPTIONS.map(l => <Btn key={l.value} active={losTier===l.value} onClick={() => setLosTier(l.value)} color="#8b5cf6">{l.label}</Btn>)}
        </div>
        <div style={{ width:1, height:22, background:"#1e293b" }}/>

        {/* Time Window */}
        <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
          <span style={{ fontSize:9, color:"#475569", textTransform:"uppercase", letterSpacing:1, fontFamily:"'IBM Plex Mono',monospace" }}>Time Window</span>
          <div style={{ display:"flex", gap:2, background:"#0f172a", borderRadius:7, padding:2 }}>
            {TIME_WINDOWS.map(t => (
              <button key={t.id} onClick={() => setTimeWindow(t.id)} style={{
                padding:"4px 12px", borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:600,
                background: timeWindow === t.id ? "#3b82f6" : "transparent",
                color:      timeWindow === t.id ? "#fff"    : "#64748b",
              }}>{t.label}</button>
            ))}
          </div>
        </div>
        <div style={{ width:1, height:22, background:"#1e293b" }}/>

        {/* Geo Level */}
        <div style={{ display:"flex", gap:4 }}>
          <Btn active={geoLevel==="market"}    onClick={() => { setGeoLevel("market");    setMktFilter("All"); }} color="#f97316">Markets</Btn>
          <Btn active={geoLevel==="submarket"} onClick={() => setGeoLevel("submarket")} color="#f97316">Submarkets</Btn>
        </div>
        {geoLevel === "submarket" && (
          <select value={mktFilter} onChange={e => setMktFilter(e.target.value)} style={sel}>
            <option value="All">All Markets</option>
            {markets.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <div style={{ width:1, height:22, background:"#1e293b" }}/>

        {/* Period selectors */}
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:11, color:"#475569" }}>Period:</span>
          <select value={period1} onChange={e => setPeriod1(e.target.value)} style={sel}>
            {[...filteredPeriods].reverse().map(p => (
              <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ▲" : ""}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ borderBottom:"1px solid #1e293b", padding:"0 28px", display:"flex", gap:0 }}>
        {[["overview","Overview"],["trend","Trend"],["cagr","CAGR Analysis"]].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding:"10px 20px", border:"none", background:"none", cursor:"pointer",
            fontSize:12, fontWeight:600,
            color:       tab===id ? "#f1f5f9" : "#475569",
            borderBottom:tab===id ? "2px solid #3b82f6" : "2px solid transparent",
          }}>{label}</button>
        ))}
      </div>

      {/* ── Content ── */}
      <div style={{ padding:"20px 28px" }}>

        {/* ════ OVERVIEW ════ */}
        {tab === "overview" && (
          <div>
            {/* Sort controls */}
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
              <span style={{ fontSize:11, color:"#475569" }}>Sort by:</span>
              <select value={sortKey} onChange={e => setSortKey(e.target.value)} style={sel}>
                {METRICS.map(m => (
                  <React.Fragment key={m.key}>
                    <option value={m.key}>{m.label}</option>
                    {m.yoyKey && <option value={m.yoyKey}>{m.label} YoY</option>}
                  </React.Fragment>
                ))}
              </select>
              <Btn active={sortDir==="desc"} onClick={() => setSortDir("desc")}>↓ Desc</Btn>
              <Btn active={sortDir==="asc"}  onClick={() => setSortDir("asc")}>↑ Asc</Btn>
              <span style={{ fontSize:11, color:"#334155", marginLeft:4 }}>
                {overviewRows.length} {geoLevel === "market" ? "markets" : "submarkets"}
                {" · "}
                <span style={{ color:"#8b5cf6" }}>{tw.label}</span>
                {timeWindow !== "mo" && <span style={{ color:"#475569", fontSize:9, marginLeft:4 }}>(avg — supply weighting pending)</span>}
                {isForecast(period1) && <span style={{ color:"#f59e0b", marginLeft:6, fontSize:10 }}>▲ FORECAST PERIOD</span>}
              </span>
            </div>

            {/* Table */}
            <div style={{ overflowX:"auto" }}>
              <table style={{ borderCollapse:"collapse", width:"100%", fontSize:12 }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle("left"), position:"sticky", left:0, background:"#0f172a" }}>
                      {geoLevel === "submarket" ? "Submarket" : "Market"}
                    </th>
                    {geoLevel === "submarket" && <th style={thStyle("left")}>Market</th>}
                    {METRICS.map(m => (
                      <React.Fragment key={m.key}>
                        <th style={thStyle()}>{m.label}</th>
                        {m.yoyKey && <th style={thStyle()}>YoY</th>}
                      </React.Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {overviewRows.length === 0 && (
                    <tr>
                      <td colSpan={20} style={{ textAlign:"center", padding:48, color:"#334155" }}>
                        No data for selected filters
                      </td>
                    </tr>
                  )}
                  {overviewRows.map((row, i) => {
                    const bg = i % 2 === 0 ? "#0f172a" : "#0c1420";
                    return (
                      <tr key={row.geo}>
                        <td style={{ ...tdStyle("left"), fontWeight:600, color:"#f1f5f9", position:"sticky", left:0, background:bg, whiteSpace:"nowrap" }}>
                          {row.label}
                        </td>
                        {geoLevel === "submarket" && (
                          <td style={{ ...tdStyle("left"), color:"#64748b", fontSize:10, whiteSpace:"nowrap" }}>{row.mkt}</td>
                        )}
                        {METRICS.map(m => (
                          <React.Fragment key={m.key}>
                            <td style={{ ...tdStyle(), color:"#e2e8f0" }}>{m.valFmt(row.m[m.key])}</td>
                            {m.yoyKey && (
                              <td style={{ ...tdStyle(), color: chgColor(row.m[m.yoyKey], m.isOcc) }}>
                                {m.isOcc ? fmt.pp(row.m[m.yoyKey]) : fmt.pct(row.m[m.yoyKey])}
                              </td>
                            )}
                          </React.Fragment>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ════ TREND ════ */}
        {tab === "trend" && (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, flexWrap:"wrap" }}>
              <span style={{ fontSize:11, color:"#475569" }}>Metric:</span>
              <div style={{ display:"flex", gap:4 }}>
                {TREND_METRICS.map(m => (
                  <Btn key={m.key} active={trendMetric===m.key} onClick={() => setTrendMetric(m.key)}>{m.label}</Btn>
                ))}
              </div>
              <span style={{ fontSize:10, color:"#334155" }}>Top 6 by {periodLabel(period1)}</span>
            </div>

            {/* Legend */}
            <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:16 }}>
              {trendData.series.map((s, i) => (
                <div key={s} style={{ display:"flex", alignItems:"center", gap:5, fontSize:11, color:"#94a3b8" }}>
                  <div style={{ width:12, height:3, background:COLORS[i % COLORS.length], borderRadius:2 }}/>
                  {s}
                </div>
              ))}
            </div>

            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={trendData.chartData} margin={{ top:10, right:20, bottom:50, left:60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                <XAxis
                  dataKey="period"
                  tick={{ fill:"#475569", fontSize:10 }}
                  angle={-45}
                  textAnchor="end"
                  interval={3}
                />
                <YAxis
                  tick={{ fill:"#475569", fontSize:11 }}
                  tickFormatter={TREND_METRICS.find(m => m.key === trendMetric)?.tickFmt}
                  width={60}
                />
                <Tooltip content={<CustomTooltip lastActual={lastActual}/>}/>
                {!showForecast && (
                  <ReferenceLine
                    x={periodLabel(lastActual)}
                    stroke="#f59e0b55"
                    strokeDasharray="4 4"
                    label={{ value:"Actual →", fill:"#f59e0b88", fontSize:9, position:"insideTopRight" }}
                  />
                )}
                {trendData.series.map((s, i) => (
                  <Line key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]}
                    strokeWidth={2} dot={false} connectNulls activeDot={{ r:4 }}/>
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ════ CAGR ════ */}
        {tab === "cagr" && (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18, flexWrap:"wrap" }}>
              <span style={{ fontSize:11, color:"#475569" }}>From:</span>
              <select value={cagrStart} onChange={e => setCagrStart(e.target.value)} style={sel}>
                {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
              </select>
              <span style={{ fontSize:11, color:"#475569" }}>To:</span>
              <select value={cagrEnd} onChange={e => setCagrEnd(e.target.value)} style={sel}>
                {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
              </select>
              <div style={{ width:1, height:22, background:"#1e293b" }}/>
              <span style={{ fontSize:11, color:"#475569" }}>Sort:</span>
              <select value={cagrSortKey} onChange={e => setCagrSortKey(e.target.value)} style={sel}>
                {CAGR_SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <Btn active={cagrSortDir==="desc"} onClick={() => setCagrSortDir("desc")}>↓ Desc</Btn>
              <Btn active={cagrSortDir==="asc"}  onClick={() => setCagrSortDir("asc")}>↑ Asc</Btn>
            </div>

            {/* Bar chart of RevPAR CAGR */}
            {cagrRows.length > 0 && (
              <div style={{ marginBottom:28 }}>
                <div style={{ fontSize:11, color:"#475569", marginBottom:8 }}>RevPAR CAGR — {periodLabel(cagrStart)} → {periodLabel(cagrEnd)}</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={cagrRows} margin={{ top:0, right:20, bottom:60, left:20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                    <XAxis dataKey="label" tick={{ fill:"#475569", fontSize:9 }} angle={-40} textAnchor="end" interval={0}/>
                    <YAxis tick={{ fill:"#475569", fontSize:11 }} tickFormatter={v => (v*100).toFixed(1)+"%"} width={50}/>
                    <Tooltip
                      formatter={v => fmt.pct(v)}
                      contentStyle={{ background:"#1e293b", border:"1px solid #334155", borderRadius:8, fontSize:11 }}
                      labelStyle={{ color:"#94a3b8" }}
                    />
                    <Bar dataKey="revpar_cagr" name="RevPAR CAGR" radius={[3,3,0,0]}>
                      {cagrRows.map((row, i) => (
                        <Cell key={i} fill={row.revpar_cagr >= 0 ? "#10b981" : "#ef4444"}/>
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* CAGR table */}
            <table style={{ borderCollapse:"collapse", width:"100%", fontSize:12 }}>
              <thead>
                <tr>
                  <th style={thStyle("left")}>Geography</th>
                  {geoLevel === "submarket" && <th style={thStyle("left")}>Market</th>}
                  <th style={thStyle()}>RevPAR — Start</th>
                  <th style={thStyle()}>RevPAR — End</th>
                  <th style={thStyle()}>RevPAR CAGR</th>
                  <th style={thStyle()}>ADR CAGR</th>
                  <th style={thStyle()}>Occ Δ (pp)</th>
                </tr>
              </thead>
              <tbody>
                {cagrRows.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>
                )}
                {cagrRows.map((row, i) => {
                  const bg = i % 2 === 0 ? "#0f172a" : "#0c1420";
                  return (
                    <tr key={row.geo} style={{ background:bg }}>
                      <td style={{ ...tdStyle("left"), fontWeight:600, color:"#f1f5f9" }}>{row.label}</td>
                      {geoLevel === "submarket" && <td style={{ ...tdStyle("left"), color:"#64748b", fontSize:10 }}>{row.mkt}</td>}
                      <td style={{ ...tdStyle(), color:"#94a3b8" }}>{fmt.dollar(row.ms_revpar)}</td>
                      <td style={{ ...tdStyle(), color:"#94a3b8" }}>{fmt.dollar(row.me_revpar)}</td>
                      <td style={{ ...tdStyle(), color: chgColor(row.revpar_cagr) }}>{fmt.pct(row.revpar_cagr)}</td>
                      <td style={{ ...tdStyle(), color: chgColor(row.adr_cagr)   }}>{fmt.pct(row.adr_cagr)}</td>
                      <td style={{ ...tdStyle(), color: chgColor(row.occ_delta, true) }}>{fmt.pp(row.occ_delta)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      </div>
    </div>
  );
}
