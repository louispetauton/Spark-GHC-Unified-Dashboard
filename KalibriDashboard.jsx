import { useState, useMemo, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell, ReferenceArea,
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

    const market    = row["Market"];
    const submarket = row["Submarket"];
    const revType   = row["Revenue Type"];
    const tier      = row["Tier"];
    const losTier   = row["LOS Tier"] || "";
    const periodRaw = row["Period"];

    if (!market || !revType || !tier || !periodRaw) continue;
    const period = normalizePeriod(periodRaw);
    if (!period) continue;

    const geoKey = submarket ? `${market}::${submarket}` : market;
    if (!geoMeta[geoKey]) {
      geoMeta[geoKey] = { market, submarket: submarket || null, isSubmarket: !!submarket };
    }

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
    `Failed to fetch data: ${res.status} ${res.statusText}\n\nMake sure ohio_kalibri_consolidated.csv is in the /public folder in Replit.`
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

function getDaysInMonth(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

// Proper hospitality-weighted aggregation:
//   Occ    = Σ(occ_i × days_i)    / Σ(days_i)          — days-weighted
//   ADR    = Σ(revpar_i × days_i) / Σ(occ_i × days_i)  — demand-weighted (exact)
//   RevPAR = Σ(revpar_i × days_i) / Σ(days_i)          — days-weighted
//   ADR × Occ = RevPAR holds exactly under this scheme.
function weightedMetrics(entries) {
  let occNum=0, occDen=0, adrNum=0, adrDen=0;
  let revNum=0, revDen=0, bcNum=0, bcDen=0, alosNum=0, alosDen=0;
  for (const {period, m} of entries) {
    if (!m) continue;
    const d = getDaysInMonth(period);
    if (m.occ    != null)                                    { occNum  += m.occ    * d; occDen  += d; }
    if (m.revpar != null)                                    { revNum  += m.revpar * d; revDen  += d; }
    if (m.revpar != null && m.occ != null && m.occ > 0)     { adrNum  += m.revpar * d; adrDen  += m.occ * d; }
    if (m.booking_cost != null && m.occ != null)             { bcNum   += m.booking_cost * m.occ * d; bcDen   += m.occ * d; }
    if (m.alos         != null && m.occ != null)             { alosNum += m.alos         * m.occ * d; alosDen += m.occ * d; }
  }
  return {
    occ:          occDen  > 0 ? occNum  / occDen  : null,
    adr:          adrDen  > 0 ? adrNum  / adrDen  : null,
    revpar:       revDen  > 0 ? revNum  / revDen  : null,
    booking_cost: bcDen   > 0 ? bcNum   / bcDen   : null,
    alos:         alosDen > 0 ? alosNum / alosDen : null,
  };
}

function computeTrailing(lookup, endPeriod, geoKey, revType, tier, losTier, tw, allPeriods) {
  if (tw.id === "mo") return getMetrics(lookup, endPeriod, geoKey, revType, tier, losTier);

  const ps = getTrailingPeriods(allPeriods, endPeriod, tw);
  if (!ps.length) return null;
  const entries = ps.map(p => ({ period: p, m: getMetrics(lookup, p, geoKey, revType, tier, losTier) }));
  const curr = weightedMetrics(entries);
  if (curr.occ == null && curr.revpar == null) return null;

  const [y, mo] = endPeriod.split("-");
  const priorEnd = `${parseInt(y) - 1}-${mo}`;
  const priorPs  = getTrailingPeriods(allPeriods, priorEnd, tw);
  if (priorPs.length) {
    const prior = weightedMetrics(priorPs.map(p => ({ period: p, m: getMetrics(lookup, p, geoKey, revType, tier, losTier) })));
    curr.occ_yoy          = curr.occ    != null && prior.occ    != null ? curr.occ - prior.occ : null;
    curr.adr_yoy          = curr.adr    != null && prior.adr    > 0     ? curr.adr / prior.adr - 1 : null;
    curr.revpar_yoy       = curr.revpar != null && prior.revpar > 0     ? curr.revpar / prior.revpar - 1 : null;
    curr.booking_cost_yoy = curr.booking_cost != null && prior.booking_cost > 0 ? curr.booking_cost / prior.booking_cost - 1 : null;
    curr.alos_yoy         = curr.alos   != null && prior.alos   > 0     ? curr.alos / prior.alos - 1 : null;
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
  const threshold = isOcc ? 0.005 : 0.05;
  if (v >  threshold) return "#4ade80";
  if (v >  0)         return "#86efac";
  if (v > -threshold) return "#fca5a5";
  return "#f87171";
}

const COLORS = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#06b6d4","#84cc16"];

// ── Supply data (from participation list) ─────────────────────────────────
const SUPPLY = {
  "Akron, OH":                                                   { rooms:9804,  props:110 },
  "Cincinnati, OH":                                              { rooms:32274, props:291 },
  "Cleveland, OH":                                               { rooms:21674, props:166 },
  "Columbus, OH":                                                { rooms:30974, props:262 },
  "Dayton, OH":                                                  { rooms:12367, props:137 },
  "Ohio State Area, OH":                                         { rooms:27249, props:412 },
  "Sandusky, OH":                                                { rooms:5116,  props:43  },
  "Toledo, OH":                                                  { rooms:7786,  props:78  },
  "Youngstown, OH":                                              { rooms:3279,  props:44  },
  "Akron, OH::Akron - Akron, OH":                                { rooms:2563,  props:29  },
  "Akron, OH::Akron West - Akron, OH":                           { rooms:2876,  props:33  },
  "Akron, OH::Canton - Akron, OH":                               { rooms:2602,  props:28  },
  "Akron, OH::Twinsburg/Streetsboro - Akron, OH":                { rooms:1763,  props:20  },
  "Cincinnati, OH::CVG Airport - Cincinnati, OH":                { rooms:5904,  props:54  },
  "Cincinnati, OH::Cincinnati East - Cincinnati, OH":            { rooms:2306,  props:23  },
  "Cincinnati, OH::Cincinnati North - Cincinnati, OH":           { rooms:12681, props:115 },
  "Cincinnati, OH::Cincinnati West - Cincinnati, OH":            { rooms:1561,  props:20  },
  "Cincinnati, OH::Downtown Cincinnati - Cincinnati, OH":        { rooms:8407,  props:57  },
  "Cincinnati, OH::Franklin - Cincinnati, OH":                   { rooms:1415,  props:22  },
  "Cleveland, OH::Avon/I90 West - Cleveland, OH":                { rooms:5483,  props:50  },
  "Cleveland, OH::Cleveland Heights - Cleveland, OH":            { rooms:1925,  props:20  },
  "Cleveland, OH::Cleveland Southeast - Cleveland, OH":          { rooms:3328,  props:29  },
  "Cleveland, OH::Downtown Cleveland - Cleveland, OH":           { rooms:6539,  props:32  },
  "Cleveland, OH::Strongsville/Medina - Cleveland, OH":          { rooms:4399,  props:35  },
  "Columbus, OH::CMH Airport - Columbus, OH":                    { rooms:4801,  props:39  },
  "Columbus, OH::Columbus South - Columbus, OH":                 { rooms:4192,  props:47  },
  "Columbus, OH::Columbus West - Columbus, OH":                  { rooms:5003,  props:48  },
  "Columbus, OH::Downtown Columbus - Columbus, OH":              { rooms:8261,  props:49  },
  "Columbus, OH::Newark - Columbus, OH":                         { rooms:1648,  props:20  },
  "Columbus, OH::Worthington/Westerville - Columbus, OH":        { rooms:7069,  props:59  },
  "Dayton, OH::Dayton Northeast/Fairborn - Dayton, OH":          { rooms:2691,  props:29  },
  "Dayton, OH::Dayton South/Miamisburg - Dayton, OH":            { rooms:2711,  props:27  },
  "Dayton, OH::Downtown/DAY Airport - Dayton, OH":               { rooms:4575,  props:50  },
  "Dayton, OH::Springfield - Dayton, OH":                        { rooms:1095,  props:16  },
  "Dayton, OH::Tipp City/Troy - Dayton, OH":                     { rooms:1295,  props:15  },
  "Ohio State Area, OH::Findlay - Ohio State Area, OH":          { rooms:1272,  props:15  },
  "Ohio State Area, OH::I70 Corridor - Ohio State Area, OH":     { rooms:2091,  props:24  },
  "Ohio State Area, OH::Lima - Ohio State Area, OH":             { rooms:1435,  props:16  },
  "Ohio State Area, OH::Mansfield/Ashland - Ohio State Area, OH":{ rooms:1902,  props:27  },
  "Ohio State Area, OH::Ohio North - Ohio State Area, OH":       { rooms:13992, props:231 },
  "Ohio State Area, OH::Ohio South - Ohio State Area, OH":       { rooms:6557,  props:99  },
  "Sandusky, OH::Sandusky, OH":                                  { rooms:5116,  props:43  },
  "Toledo, OH::Toledo East - Toledo, OH":                        { rooms:3333,  props:35  },
  "Toledo, OH::Toledo West - Toledo, OH":                        { rooms:4453,  props:43  },
  "Youngstown, OH::Youngstown, OH":                              { rooms:3279,  props:44  },
};

const METRICS = [
  { key:"occ",          label:"Occupancy",       yoyKey:"occ_yoy",          valFmt: fmt.occ,    yoyFmt: fmt.pp,  isOcc:true },
  { key:"adr",          label:"ADR",              yoyKey:"adr_yoy",          valFmt: fmt.dollar, yoyFmt: fmt.pct },
  { key:"revpar",       label:"RevPAR",           yoyKey:"revpar_yoy",       valFmt: fmt.dollar, yoyFmt: fmt.pct },
  { key:"booking_cost", label:"Booking Cost/RN",  yoyKey:"booking_cost_yoy", valFmt: fmt.dollar, yoyFmt: fmt.pct },
  { key:"alos",         label:"ALOS",             yoyKey:"alos_yoy",         valFmt: fmt.dec2,   yoyFmt: fmt.pct },
];

const TREND_METRICS = [
  { key:"revpar",           label:"RevPAR",              tickFmt: v => "$"+v.toFixed(0),              valFmt: v => "$"+v.toFixed(2) },
  { key:"revpar_yoy",       label:"RevPAR % Chg (YoY)",  tickFmt: v => (v*100).toFixed(1)+"%",        valFmt: v => (v>=0?"+":"")+(v*100).toFixed(1)+"%" },
  { key:"occ",              label:"Occupancy",           tickFmt: v => (v*100).toFixed(0)+"%",         valFmt: v => (v*100).toFixed(1)+"%" },
  { key:"occ_yoy",          label:"Occupancy Chg (YoY)", tickFmt: v => (v*100).toFixed(1)+"pp",        valFmt: v => (v>=0?"+":"")+(v*100).toFixed(1)+"pp" },
  { key:"adr",              label:"ADR",                 tickFmt: v => "$"+v.toFixed(0),              valFmt: v => "$"+v.toFixed(2) },
  { key:"adr_yoy",          label:"ADR % Chg (YoY)",     tickFmt: v => (v*100).toFixed(1)+"%",        valFmt: v => (v>=0?"+":"")+(v*100).toFixed(1)+"%" },
  { key:"booking_cost",     label:"Booking Cost/RN",     tickFmt: v => "$"+v.toFixed(2),              valFmt: v => "$"+v.toFixed(2) },
  { key:"booking_cost_yoy", label:"Booking Cost % Chg",  tickFmt: v => (v*100).toFixed(1)+"%",        valFmt: v => (v>=0?"+":"")+(v*100).toFixed(1)+"%" },
  { key:"alos",             label:"ALOS",                tickFmt: v => v.toFixed(1),                  valFmt: v => v.toFixed(2) },
  { key:"alos_yoy",         label:"ALOS % Chg (YoY)",    tickFmt: v => (v*100).toFixed(1)+"%",        valFmt: v => (v>=0?"+":"")+(v*100).toFixed(1)+"%" },
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
  { value:"",     label:"Overview"    },
  { value:"0-6",  label:"0–6 Nights"  },
  { value:"7-14", label:"7–14 Nights" },
  { value:"15-29",label:"15–29 Nights"},
  { value:"30+",  label:"30+ Nights"  },
];

function CustomTooltip({ active, payload, label, lastActual, metricKey }) {
  if (!active || !payload?.length) return null;
  const period = payload[0]?.payload?.periodRaw;
  const isForecast = period && period > lastActual;
  const metricDef = TREND_METRICS.find(m => m.key === metricKey);
  const formatVal = v => {
    if (v == null || typeof v !== "number") return "—";
    if (metricDef) return metricDef.valFmt(v);
    // fallback heuristic
    if (v > 1)                 return "$" + v.toFixed(2);
    if (v > 0 && v < 0.1)     return (v * 100).toFixed(1) + "%";
    return v.toFixed(2);
  };
  return (
    <div style={{ background:"#1e293b", border:`1px solid ${isForecast?"#f59e0b44":"#334155"}`, borderRadius:8, padding:"10px 14px", fontSize:11 }}>
      <div style={{ marginBottom:6, display:"flex", alignItems:"center", gap:6 }}>
        <span style={{ color:"#94a3b8", fontWeight:600 }}>{label}</span>
        {isForecast && <span style={{ background:"#f59e0b22", color:"#f59e0b", fontSize:9, padding:"1px 6px", borderRadius:3, fontWeight:700, letterSpacing:0.5 }}>FORECAST</span>}
      </div>
      {payload.map((p, i) => (
        <div key={i} style={{ display:"flex", justifyContent:"space-between", gap:16, color:p.color, marginBottom:2 }}>
          <span style={{ color:"#64748b" }}>{p.name}</span>
          <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontWeight:600 }}>{formatVal(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function KalibriDashboard() {
  const [db,          setDb]          = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [loadError,   setLoadError]   = useState(null);

  // filters
  const [revType,      setRevType]      = useState("Guest Paid");
  const [tier,         setTier]         = useState("All Tier");
  const [losTier,      setLosTier]      = useState("");
  const [geoLevel,     setGeoLevel]     = useState("market");
  const [mktFilter,    setMktFilter]    = useState("All");
  const [period1,      setPeriod1]      = useState("");
  const [showForecast, setShowForecast] = useState(false);
  const [timeWindow,   setTimeWindow]   = useState("mo");

  // tabs
  const [tab, setTab] = useState("overview");

  // overview
  const [sortKey, setSortKey] = useState("revpar_yoy");
  const [sortDir, setSortDir] = useState("desc");

  // trend
  const [trendMetric, setTrendMetric] = useState("revpar");
  const [yoyClip,     setYoyClip]     = useState(null); // null = no clip, else fraction e.g. 0.3

  // cagr
  const [cagrStart,      setCagrStart]      = useState("");
  const [cagrEnd,        setCagrEnd]        = useState("");
  const [cagrSortKey,    setCagrSortKey]    = useState("revpar_cagr");
  const [cagrSortDir,    setCagrSortDir]    = useState("desc");
  const [cagrChartMetric,setCagrChartMetric]= useState("revpar_cagr");

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
        setCagrEnd(latestActual);
        setCagrStart(allPeriods.includes(sixYrPrior) ? sixYrPrior : allPeriods[0]);
      })
      .catch(e => { setLoadError(e.message); setLoading(false); });
  }, []);

  const periods         = useMemo(() => db ? Object.keys(db.lookup).sort() : [], [db]);
  const lastActual      = useMemo(() => db?.lastActual || "2026-02", [db]);
  const geoMeta         = useMemo(() => db?.geoMeta || {}, [db]);
  const markets         = useMemo(() => [...new Set(Object.values(geoMeta).map(g => g.market).filter(Boolean))].sort(), [geoMeta]);
  const tw              = useMemo(() => TIME_WINDOWS.find(t => t.id === timeWindow) || TIME_WINDOWS[2], [timeWindow]);
  const filteredPeriods = useMemo(() =>
    showForecast ? periods : periods.filter(p => p <= lastActual),
    [periods, showForecast, lastActual]
  );
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

  const forecastStartLabel = useMemo(() => {
    const fp = filteredPeriods.filter((_, i) => i % 3 === 0 || i === filteredPeriods.length - 1).find(p => p > lastActual);
    return fp ? periodLabel(fp) : null;
  }, [filteredPeriods, lastActual]);

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

    const isYoY = trendMetric.endsWith("_yoy");
    const applyClip = v => (isYoY && yoyClip != null && v != null) ? Math.max(-yoyClip, Math.min(yoyClip, v)) : v;

    const chartData = filteredPeriods
      .filter((_, i) => i % 3 === 0 || i === filteredPeriods.length - 1)
      .map(p => {
        const row = { period: periodLabel(p), periodRaw: p };
        for (const geo of topGeos) {
          const m = computeTrailing(db.lookup, p, geo, revType, tier, losTier, tw, periods);
          const lbl = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
          const raw = m?.[trendMetric] != null ? parseFloat(m[trendMetric].toFixed(6)) : null;
          row[lbl] = applyClip(raw);
        }
        return row;
      });

    return { series: topGeos.map(g => geoMeta[g]?.submarket || geoMeta[g]?.market || g), chartData };
  }, [db, filteredGeos, period1, revType, tier, losTier, tw, periods, trendMetric, filteredPeriods, yoyClip]);

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
        adr_cagr:    calcCAGR(ms.adr,    me.adr,    years),
        occ_delta:   ms.occ != null && me.occ != null ? me.occ - ms.occ : null,
        ms_revpar: ms.revpar, me_revpar: me.revpar,
        ms_adr:    ms.adr,    me_adr:    me.adr,
        ms_occ:    ms.occ,    me_occ:    me.occ,
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
      background: active ? color     : "#1e293b",
      color:      active ? "#fff"    : "#64748b",
      border:     active ? "none"    : "1px solid #334155",
      ...style,
    }}>{children}</button>
  );
  const label9 = { fontSize:9, color:"#475569", textTransform:"uppercase", letterSpacing:1 };

  // ── Error / Loading ────────────────────────────────────────────────────────
  if (loadError) return (
    <div style={{ background:"#0f172a", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'IBM Plex Mono',monospace", padding:40 }}>
      <div style={{ maxWidth:560, textAlign:"center" }}>
        <div style={{ fontSize:28, marginBottom:12, color:"#ef4444" }}>⚠</div>
        <div style={{ color:"#f87171", fontWeight:700, fontSize:14, marginBottom:12 }}>Could not load data</div>
        <div style={{ color:"#475569", fontSize:11, lineHeight:1.7, marginBottom:20, textAlign:"left", background:"#1e293b", borderRadius:8, padding:"14px 18px", border:"1px solid #334155" }}>
          {loadError}
        </div>
        <div style={{ color:"#334155", fontSize:10, textAlign:"left" }}>
          <div style={{ color:"#64748b", marginBottom:6, fontWeight:600 }}>TO FIX:</div>
          <div>1. Open this file and find <span style={{ color:"#3b82f6" }}>DATA_URL</span> near the top</div>
          <div>2. Make sure <span style={{ color:"#3b82f6" }}>ohio_kalibri_consolidated.csv</span> is in your Replit /public folder</div>
          <div>3. Refresh the page</div>
        </div>
      </div>
    </div>
  );

  if (loading) return (
    <div style={{ background:"#0f172a", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"monospace" }}>
      <div style={{ textAlign:"center", color:"#475569" }}>
        <div style={{ fontSize:28, marginBottom:10, animation:"spin 1.5s linear infinite", display:"inline-block" }}>⟳</div>
        <div style={{ marginTop:8 }}>Loading Kalibri data…</div>
        <div style={{ fontSize:10, color:"#334155", marginTop:6 }}>{DATA_URL}</div>
      </div>
    </div>
  );

  const perfColSpan = METRICS.reduce((a, m) => a + (m.yoyKey ? 2 : 1), 0);
  const geoColSpan  = geoLevel === "submarket" ? 2 : 1;
  const getSupply   = geo => SUPPLY[geo] || null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ background:"#0f172a", minHeight:"100vh", fontFamily:"'DM Sans','Segoe UI',sans-serif", color:"#e2e8f0" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* ── Header ── */}
      <div style={{ background:"#0f172a", borderBottom:"1px solid #1e293b", padding:"14px 28px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <div style={{ marginBottom:4 }}>
            <img
              src="https://images.squarespace-cdn.com/content/v1/634ecc23e6a1eb0116ad3e64/b7f36457-07a7-4f6f-94fb-081608156032/SGHC+LogoDeck_MainWH.png"
              alt="Spark GHC"
              style={{ height:28, objectFit:"contain" }}
            />
          </div>
          <div style={{ fontSize:18, fontWeight:700, color:"#f8fafc", letterSpacing:-0.5 }}>Ohio Hospitality Analytics — Kalibri Labs</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, background:"#3b82f611", border:"1px solid #3b82f633", borderRadius:6, padding:"4px 10px" }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:"#3b82f6" }}/>
            <span style={{ fontSize:10, color:"#3b82f6", fontFamily:"'IBM Plex Mono',monospace" }}>Kalibri Labs · Guest Paid / Hotel Collected / COPE</span>
          </div>
          <div style={{ fontSize:10, color:"#334155", fontFamily:"'IBM Plex Mono',monospace" }}>Last Actual: <span style={{ color:"#94a3b8" }}>{periodLabel(lastActual)}</span></div>
        </div>
      </div>

      {/* ── Global Controls ── */}
      <div style={{ padding:"12px 28px", background:"#111827", borderBottom:"1px solid #1e293b", display:"flex", flexWrap:"wrap", gap:14, alignItems:"flex-end" }}>

        {/* Revenue Type */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Revenue Type</label>
          <div style={{ display:"flex", gap:2 }}>
            {REV_TYPES.map(rt => <Btn key={rt} active={revType===rt} onClick={() => setRevType(rt)} color="#3b82f6">{rt}</Btn>)}
          </div>
        </div>

        {/* Hotel Class */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Hotel Class</label>
          <div style={{ display:"flex", gap:2 }}>
            {TIERS.map(t => <Btn key={t} active={tier===t} onClick={() => setTier(t)} color="#10b981">{t.replace(" Tier","")}</Btn>)}
          </div>
        </div>

        {/* Length of Stay */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Length of Stay</label>
          <div style={{ display:"flex", gap:2 }}>
            {LOS_OPTIONS.map(l => <Btn key={l.value} active={losTier===l.value} onClick={() => setLosTier(l.value)} color="#8b5cf6">{l.label}</Btn>)}
          </div>
        </div>

        {/* Time Window */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Time Window</label>
          <div style={{ display:"flex", gap:2 }}>
            {TIME_WINDOWS.map(t => (
              <Btn key={t.id} active={timeWindow===t.id} onClick={() => setTimeWindow(t.id)} color="#3b82f6">{t.label}</Btn>
            ))}
          </div>
        </div>

        {/* Geography */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Geography</label>
          <div style={{ display:"flex", gap:2 }}>
            <Btn active={geoLevel==="market"}    onClick={() => { setGeoLevel("market"); setMktFilter("All"); }} color="#f97316">Markets</Btn>
            <Btn active={geoLevel==="submarket"} onClick={() => setGeoLevel("submarket")} color="#f97316">Submarkets</Btn>
          </div>
        </div>

        {/* Market filter */}
        {geoLevel === "submarket" && (
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            <label style={label9}>Market</label>
            <select value={mktFilter} onChange={e => setMktFilter(e.target.value)} style={{ ...sel, minWidth:150 }}>
              <option value="All">All Markets</option>
              {markets.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}

        {/* Period */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Period</label>
          <select value={period1} onChange={e => setPeriod1(e.target.value)} style={{ ...sel, minWidth:120, ...(isForecast(period1) ? { border:"1px solid #f59e0b55", color:"#fbbf24" } : {}) }}>
            {[...filteredPeriods].reverse().map(p => (
              <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ◆" : ""}</option>
            ))}
          </select>
        </div>

        {/* Include Forecast */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Forecast</label>
          <div style={{ display:"flex", gap:2 }}>
            <Btn active={showForecast}  onClick={() => setShowForecast(true)}  color="#f59e0b">Show</Btn>
            <Btn active={!showForecast} onClick={() => setShowForecast(false)}>Hide</Btn>
          </div>
        </div>

        {/* Sort By (overview) */}
        {tab === "overview" && (
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            <label style={label9}>Sort By</label>
            <div style={{ display:"flex", gap:4 }}>
              <select value={sortKey} onChange={e => setSortKey(e.target.value)} style={{ ...sel, minWidth:130 }}>
                {METRICS.map(m => (
                  <optgroup key={m.key} label={m.label}>
                    <option value={m.key}>{m.label}</option>
                    {m.yoyKey && <option value={m.yoyKey}>{m.label} YoY</option>}
                  </optgroup>
                ))}
              </select>
              <button onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
                style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155", padding:"6px 10px", fontSize:13, minWidth:34 }}>
                {sortDir === "desc" ? "↓" : "↑"}
              </button>
            </div>
          </div>
        )}

        {/* Sort By (cagr) */}
        {tab === "cagr" && (
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            <label style={label9}>Sort By</label>
            <div style={{ display:"flex", gap:4 }}>
              <select value={cagrSortKey} onChange={e => setCagrSortKey(e.target.value)} style={{ ...sel, minWidth:130 }}>
                {CAGR_SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <button onClick={() => setCagrSortDir(d => d === "desc" ? "asc" : "desc")}
                style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155", padding:"6px 10px", fontSize:13, minWidth:34 }}>
                {cagrSortDir === "desc" ? "↓" : "↑"}
              </button>
            </div>
          </div>
        )}

        <div style={{ flex:1 }}/>

        {/* Tabs */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Analysis</label>
          <div style={{ display:"flex", gap:2 }}>
            {[["overview","Overview"],["trend","Trend"],["cagr","CAGR Analysis"]].map(([id, lbl]) => (
              <Btn key={id} active={tab===id} onClick={() => setTab(id)} color="#6366f1">{lbl}</Btn>
            ))}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ padding:"20px 28px" }}>

        {/* ════ OVERVIEW ════ */}
        {tab === "overview" && (
          <div>
            {/* Status bar */}
            <div style={{ fontSize:10, color:"#334155", marginBottom:10, fontFamily:"'IBM Plex Mono',monospace", display:"flex", gap:6, alignItems:"center" }}>
              <span style={{ color:"#60a5fa", fontWeight:600 }}>{periodLabel(period1)}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span style={{ color:"#8b5cf6" }}>{tw.label}</span>
              {timeWindow !== "mo" && <span style={{ color:"#475569", fontSize:9 }}>(days-weighted)</span>}
              <span style={{ color:"#1a2540" }}>·</span>
              <span>{overviewRows.length} {geoLevel === "market" ? "markets" : "submarkets"}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span>{revType}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span>{tier.replace(" Tier","")}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span style={{ color:"#334155" }}>sorted by {METRICS.find(m => m.key===sortKey || m.yoyKey===sortKey)?.label}{sortKey.includes("_yoy") ? " YoY" : ""} {sortDir === "desc" ? "↓" : "↑"}</span>
              {isForecast(period1) && <span style={{ color:"#f59e0b", marginLeft:4, fontSize:10 }}>◆ FORECAST PERIOD</span>}
            </div>

            {/* Table */}
            <div style={{ overflowX:"auto" }}>
              <table style={{ borderCollapse:"collapse", width:"100%", fontSize:12, tableLayout:"auto" }}>
                <thead>
                  {/* Group banner row */}
                  <tr style={{ background:"#070f1e" }}>
                    <th colSpan={geoColSpan} style={{ background:"#070f1e", padding:"4px 0" }}/>
                    <th colSpan={1} style={{
                      background:"#0c1a2e", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#3b82f6",
                      textTransform:"uppercase", letterSpacing:1, textAlign:"center",
                      borderTop:"2px solid #3b82f655", borderLeft:"1px solid #0d1526",
                    }}>Supply</th>
                    <th colSpan={perfColSpan} style={{
                      background:"#042818", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#10b981",
                      textTransform:"uppercase", letterSpacing:1, textAlign:"center",
                      borderTop:"2px solid #10b98155", borderLeft:"1px solid #0d1526",
                    }}>
                      <div>Performance</div>
                      <div style={{ marginTop:2, fontWeight:400, fontSize:8, fontFamily:"'IBM Plex Mono',monospace", textTransform:"none", letterSpacing:0 }}>
                        <span style={{ color:"#3b82f6" }}>{periodLabel(period1)}</span>
                        <span style={{ color:"#334155", margin:"0 4px" }}>vs</span>
                        <span style={{ color:"#64748b" }}>prior year</span>
                      </div>
                    </th>
                  </tr>
                  {/* Column labels row */}
                  <tr style={{ background:"#0a1628", borderBottom:"2px solid #1e293b" }}>
                    <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", minWidth:150, position:"sticky", left:0, background:"#0a1628", zIndex:2 }}>
                      {geoLevel === "submarket" ? "Submarket" : "Market"}
                    </th>
                    {geoLevel === "submarket" && (
                      <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", minWidth:80 }}>Market</th>
                    )}
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#60a5fa", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:70 }}>Rooms</th>
                    {METRICS.map(m => m.yoyKey ? [
                      <th key={m.key+"v"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:70 }}>{m.label}</th>,
                      <th key={m.key+"c"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#64748b",  fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>YoY</th>,
                    ] : (
                      <th key={m.key} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:60 }}>{m.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {overviewRows.length === 0 && (
                    <tr><td colSpan={20} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>
                  )}
                  {overviewRows.map((row, i) => {
                    const bg = i % 2 === 0 ? "#111827" : "#0f172a";
                    return (
                      <tr key={row.geo}
                        style={{ borderBottom:"1px solid #0d1526", background:bg }}
                        onMouseEnter={e => e.currentTarget.style.background="#1e293b"}
                        onMouseLeave={e => e.currentTarget.style.background=bg}>
                        <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", position:"sticky", left:0, background:bg, zIndex:1 }}>
                          {row.label}
                        </td>
                        {geoLevel === "submarket" && (
                          <td style={{ padding:"6px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap" }}>{row.mkt}</td>
                        )}
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#60a5fa", borderLeft:"1px solid #0d1526", whiteSpace:"nowrap" }}>
                          {(() => { const s = getSupply(row.geo); return s ? s.rooms.toLocaleString() : "—"; })()}
                        </td>
                        {METRICS.map(m => m.yoyKey ? [
                          <td key={m.key+"v"} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#cbd5e1", borderLeft:"1px solid #0d1526", whiteSpace:"nowrap" }}>
                            {m.valFmt(row.m[m.key])}
                          </td>,
                          <td key={m.key+"c"} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:chgColor(row.m[m.yoyKey], m.isOcc), fontWeight:600, whiteSpace:"nowrap" }}>
                            {m.isOcc ? fmt.pp(row.m[m.yoyKey]) : fmt.pct(row.m[m.yoyKey])}
                          </td>,
                        ] : (
                          <td key={m.key} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#94a3b8", borderLeft:"1px solid #0d1526", whiteSpace:"nowrap" }}>
                            {m.valFmt(row.m[m.key])}
                          </td>
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
            <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Metric</label>
                <select value={trendMetric} onChange={e => setTrendMetric(e.target.value)} style={sel}>
                  {TREND_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </div>
              {trendMetric.endsWith("_yoy") && (
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Axis Cap</label>
                  <div style={{ display:"flex", gap:2 }}>
                    {[null, 0.20, 0.30, 0.50].map(v => (
                      <Btn key={String(v)} active={yoyClip===v} onClick={() => setYoyClip(v)} color="#8b5cf6">
                        {v == null ? "None" : `±${v*100|0}%`}
                      </Btn>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ fontSize:11, color:"#475569", alignSelf:"flex-end", paddingBottom:6 }}>
                Top 6 · <span style={{ color:"#94a3b8" }}>{revType}</span> · <span style={{ color:"#64748b" }}>{tw.label}</span>
              </div>
            </div>

            {/* Legend pills */}
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:4, alignItems:"center" }}>
              {trendData.series.map((s, i) => (
                <div key={s} style={{ display:"flex", alignItems:"center", gap:5, background:"#1e293b", borderRadius:4, padding:"3px 10px" }}>
                  <div style={{ width:8, height:8, borderRadius:2, background:COLORS[i % COLORS.length] }}/>
                  <span style={{ fontSize:10, color:"#cbd5e1" }}>{s}</span>
                </div>
              ))}
              {showForecast && (
                <div style={{ display:"flex", alignItems:"center", gap:5, background:"#f59e0b11", border:"1px solid #f59e0b33", borderRadius:4, padding:"3px 10px", marginLeft:8 }}>
                  <div style={{ width:8, height:8, borderRadius:2, background:"#f59e0b44", border:"1px dashed #f59e0b" }}/>
                  <span style={{ fontSize:10, color:"#f59e0b" }}>Forecast</span>
                </div>
              )}
            </div>

            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={trendData.chartData} margin={{ top:10, right:30, bottom:80, left:20 }}>
                {showForecast && forecastStartLabel && (
                  <ReferenceArea x1={forecastStartLabel} fill="#f59e0b" fillOpacity={0.04}/>
                )}
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                <XAxis dataKey="period" tick={{ fill:"#475569", fontSize:9 }} angle={-50} textAnchor="end" interval={3} height={70}/>
                <YAxis
                  tick={{ fill:"#475569", fontSize:10 }}
                  tickFormatter={TREND_METRICS.find(m => m.key === trendMetric)?.tickFmt}
                  domain={["auto","auto"]}
                  width={60}
                />
                <Tooltip content={<CustomTooltip lastActual={lastActual} metricKey={trendMetric}/>}/>
                {showForecast && forecastStartLabel && (
                  <ReferenceLine x={forecastStartLabel} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={1.5}
                    label={{ value:"Forecast →", fill:"#f59e0b", fontSize:9, position:"top" }}/>
                )}
                <ReferenceLine x="Jan - 2020" stroke="#ef444466" strokeDasharray="4 4"
                  label={{ value:"COVID", fill:"#ef4444", fontSize:9, position:"top" }}/>
                {trendData.series.map((s, i) => (
                  <Line key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]}
                    strokeWidth={2} dot={false} connectNulls activeDot={{ r:4 }}
                    isAnimationActive={false}/>
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ════ CAGR ════ */}
        {tab === "cagr" && (
          <div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Start Period</label>
                <select value={cagrStart} onChange={e => setCagrStart(e.target.value)} style={{ ...sel, minWidth:120 }}>
                  {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ◆" : ""}</option>)}
                </select>
              </div>
              <div style={{ alignSelf:"flex-end", paddingBottom:8, color:"#334155", fontSize:14 }}>→</div>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>End Period</label>
                <select value={cagrEnd} onChange={e => setCagrEnd(e.target.value)} style={{ ...sel, minWidth:120 }}>
                  {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ◆" : ""}</option>)}
                </select>
              </div>
              <div style={{ fontSize:11, color:"#64748b", alignSelf:"flex-end", paddingBottom:6 }}>
                {(() => {
                  const p1p = cagrStart.split("-"), p2p = cagrEnd.split("-");
                  const y = (parseInt(p2p[0]) - parseInt(p1p[0])) + (parseInt(p2p[1]) - parseInt(p1p[1])) / 12;
                  return y > 0 ? y.toFixed(1) + "-yr CAGR" : "Select valid range";
                })()}
                {" · "}<span style={{ color:"#94a3b8" }}>{revType}</span>
              </div>
              <div style={{ flex:1 }}/>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Chart Metric</label>
                <select value={cagrChartMetric} onChange={e => setCagrChartMetric(e.target.value)} style={{ ...sel, minWidth:140 }}>
                  {CAGR_SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </div>
            </div>

            {/* Bar chart */}
            {cagrRows.length > 0 && (
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:10, color:"#475569", marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>
                  {CAGR_SORT_OPTIONS.find(o => o.key === cagrChartMetric)?.label} · Top {Math.min(cagrRows.length, 20)} geographies · sorted by {CAGR_SORT_OPTIONS.find(o => o.key === cagrSortKey)?.label}
                </div>
                <ResponsiveContainer width="100%" height={380}>
                  <BarChart data={cagrRows.slice(0, 20)} margin={{ top:5, right:20, bottom:90, left:20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                    <XAxis dataKey="label" tick={{ fill:"#475569", fontSize:9 }} angle={-45} textAnchor="end" height={80} interval={0}/>
                    <YAxis
                      tickFormatter={v => cagrChartMetric === "occ_delta" ? (v*100).toFixed(1)+"pp" : (v*100).toFixed(1)+"%"}
                      tick={{ fill:"#475569", fontSize:10 }}
                    />
                    <Tooltip
                      contentStyle={{ background:"#1e293b", border:"1px solid #334155", borderRadius:6, fontSize:11 }}
                      formatter={(v, n) => [cagrChartMetric === "occ_delta" ? fmt.pp(v) : fmt.pct(v), n]}
                      labelStyle={{ color:"#94a3b8" }}
                    />
                    <ReferenceLine y={0} stroke="#334155"/>
                    <Bar dataKey={cagrChartMetric} name={CAGR_SORT_OPTIONS.find(o => o.key === cagrChartMetric)?.label} radius={[3,3,0,0]}>
                      {cagrRows.slice(0, 20).map((row, i) => (
                        <Cell key={i} fill={(row[cagrChartMetric] || 0) >= 0 ? "#3b82f6" : "#ef4444"}/>
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* CAGR table — grouped columns: Occupancy / ADR / RevPAR */}
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#070f1e" }}>
                    <th colSpan={geoColSpan} style={{ background:"#070f1e", padding:"4px 0" }}/>
                    {[["Occupancy",3],["ADR",3],["RevPAR",3]].map(([lbl, span]) => (
                      <th key={lbl} colSpan={span} style={{
                        background:"#042818", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#10b981",
                        textTransform:"uppercase", letterSpacing:1, textAlign:"center",
                        borderTop:"2px solid #10b98155", borderLeft:"1px solid #0d1526",
                      }}>{lbl}</th>
                    ))}
                  </tr>
                  <tr style={{ borderBottom:"1px solid #1e293b", background:"#0a1628" }}>
                    <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap" }}>Geography</th>
                    {geoLevel === "submarket" && (
                      <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap" }}>Market</th>
                    )}
                    {/* Occ sub-headers */}
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cagrStart)}</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cagrEnd)}</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:600, whiteSpace:"nowrap" }}>Δ (pp)</th>
                    {/* ADR sub-headers */}
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cagrStart)}</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cagrEnd)}</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:600, whiteSpace:"nowrap" }}>CAGR</th>
                    {/* RevPAR sub-headers */}
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cagrStart)}</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cagrEnd)}</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:600, whiteSpace:"nowrap" }}>CAGR</th>
                  </tr>
                </thead>
                <tbody>
                  {cagrRows.length === 0 && (
                    <tr><td colSpan={12} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>
                  )}
                  {cagrRows.map((row, i) => {
                    const bg = i % 2 === 0 ? "#111827" : "#0f172a";
                    return (
                      <tr key={row.geo}
                        style={{ borderBottom:"1px solid #0d1526", background:bg }}
                        onMouseEnter={e => e.currentTarget.style.background="#1e293b"}
                        onMouseLeave={e => e.currentTarget.style.background=bg}>
                        <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap" }}>{row.label}</td>
                        {geoLevel === "submarket" && (
                          <td style={{ padding:"6px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap" }}>{row.mkt}</td>
                        )}
                        {/* Occ */}
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.occ(row.ms_occ)}</td>
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#94a3b8" }}>{fmt.occ(row.me_occ)}</td>
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.occ_delta, true), fontWeight:600 }}>{fmt.pp(row.occ_delta)}</td>
                        {/* ADR */}
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.dollar(row.ms_adr)}</td>
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#94a3b8" }}>{fmt.dollar(row.me_adr)}</td>
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.adr_cagr), fontWeight:600 }}>{fmt.pct(row.adr_cagr)}</td>
                        {/* RevPAR */}
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.dollar(row.ms_revpar)}</td>
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#60a5fa" }}>{fmt.dollar(row.me_revpar)}</td>
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.revpar_cagr), fontWeight:700, fontSize:13 }}>{fmt.pct(row.revpar_cagr)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
