import React, { useState, useMemo, useEffect, useRef, useLayoutEffect } from "react";
import ReactDOM from "react-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell, ReferenceArea,
} from "recharts";

// ─── DATA SOURCE ──────────────────────────────────────────────────────────────
// Drop ohio_kalibri_consolidated.csv into your Replit /public folder.
// To update: just overwrite that file and refresh — no code changes needed.
const DATA_URL = "/ohio_kalibri_consolidated.csv";

// ─── LAST ACTUAL PERIOD ───────────────────────────────────────────────────────
// Set this to the last month of actual (non-forecast) data from Kalibri.
// Format: "YYYY-MM"  e.g. "2026-01" for January 2026.
// Update this whenever new actual data is loaded.
const LAST_ACTUAL_OVERRIDE = "2026-01";
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

  return { lookup, geoMeta, lastActual: LAST_ACTUAL_OVERRIDE || lastActual || "2026-01" };
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

// Aggregate metrics across multiple LOS tiers for a single period.
// LOS tiers are mutually exclusive revenue segments, so Occ and RevPAR are additive.
// ADR = RevPAR / Occ (exact identity holds). ALOS/BookingCost are occ-weighted.
function aggregateLOS(lookup, period, geoKey, revType, tier, losTiers) {
  if (losTiers.length === 1) return getMetrics(lookup, period, geoKey, revType, tier, losTiers[0]);
  const arr = losTiers.map(lt => getMetrics(lookup, period, geoKey, revType, tier, lt)).filter(Boolean);
  if (!arr.length) return null;
  let occ=0, revpar=0, bcNum=0, bcDen=0, alosNum=0, alosDen=0;
  for (const m of arr) {
    if (m.occ    != null) occ    += m.occ;
    if (m.revpar != null) revpar += m.revpar;
    if (m.booking_cost != null && m.occ > 0) { bcNum += m.booking_cost * m.occ; bcDen += m.occ; }
    if (m.alos         != null && m.occ > 0) { alosNum += m.alos * m.occ; alosDen += m.occ; }
  }
  return {
    occ:          occ    || null,
    adr:          occ > 0 ? revpar / occ : null,
    revpar:       revpar || null,
    booking_cost: bcDen   > 0 ? bcNum   / bcDen   : null,
    alos:         alosDen > 0 ? alosNum / alosDen : null,
  };
}

// Aggregate metrics across multiple hotel class tiers for a single period.
// Hotel class tiers are different hotel pools → supply-weighted (rooms as weights).
// RevPAR/Occ weighted by rooms, ADR = RevPAR/Occ (exact). ALOS/BookingCost occ×rooms-weighted.
function aggregateTiers(lookup, period, geoKey, revType, tiers, losTiers) {
  if (tiers.length === 1) return aggregateLOS(lookup, period, geoKey, revType, tiers[0], losTiers);
  const items = tiers.map(t => ({
    m:     aggregateLOS(lookup, period, geoKey, revType, t, losTiers),
    rooms: SUPPLY[geoKey]?.[t]?.rooms || 0,
  })).filter(({ m, rooms }) => m && rooms > 0);
  if (!items.length) return null;
  let occNum=0, revNum=0, bcNum=0, bcDen=0, alosNum=0, alosDen=0, totalRooms=0;
  for (const { m, rooms } of items) {
    if (m.occ    != null) { occNum += m.occ    * rooms; totalRooms += rooms; }
    if (m.revpar != null)   revNum += m.revpar * rooms;
    if (m.booking_cost != null && m.occ > 0) { bcNum   += m.booking_cost * m.occ * rooms; bcDen   += m.occ * rooms; }
    if (m.alos         != null && m.occ > 0) { alosNum += m.alos         * m.occ * rooms; alosDen += m.occ * rooms; }
  }
  const occ    = totalRooms > 0 ? occNum / totalRooms : null;
  const revpar = totalRooms > 0 ? revNum / totalRooms : null;
  return {
    occ,
    revpar,
    adr:          occ > 0 ? revpar / occ : null,
    booking_cost: bcDen   > 0 ? bcNum   / bcDen   : null,
    alos:         alosDen > 0 ? alosNum / alosDen : null,
  };
}

function computeTrailing(lookup, endPeriod, geoKey, revType, tiers, losTiers, tw, allPeriods) {
  const get = (p) => aggregateTiers(lookup, p, geoKey, revType, tiers, losTiers);
  const isMulti = tiers.length > 1 || losTiers.length > 1;

  const addYoY = (curr, prior) => {
    curr.occ_yoy          = curr.occ    != null && prior.occ    != null ? curr.occ - prior.occ : null;
    curr.adr_yoy          = curr.adr    != null && prior.adr    > 0     ? curr.adr / prior.adr - 1 : null;
    curr.revpar_yoy       = curr.revpar != null && prior.revpar > 0     ? curr.revpar / prior.revpar - 1 : null;
    curr.booking_cost_yoy = curr.booking_cost != null && prior.booking_cost > 0 ? curr.booking_cost / prior.booking_cost - 1 : null;
    curr.alos_yoy         = curr.alos   != null && prior.alos   > 0     ? curr.alos / prior.alos - 1 : null;
  };

  if (tw.id === "mo") {
    const curr = get(endPeriod);
    if (!curr || !isMulti) return curr; // single tier+LOS: raw yoy from CSV preserved
    const [y, mo] = endPeriod.split("-");
    const prior = get(`${parseInt(y)-1}-${mo}`);
    if (prior) addYoY(curr, prior);
    return curr;
  }

  const ps = getTrailingPeriods(allPeriods, endPeriod, tw);
  if (!ps.length) return null;
  const curr = weightedMetrics(ps.map(p => ({ period: p, m: get(p) })));
  if (curr.occ == null && curr.revpar == null) return null;

  const [y, mo] = endPeriod.split("-");
  const priorPs = getTrailingPeriods(allPeriods, `${parseInt(y)-1}-${mo}`, tw);
  if (priorPs.length) {
    const prior = weightedMetrics(priorPs.map(p => ({ period: p, m: get(p) })));
    addYoY(curr, prior);
  }
  return curr;
}
// ───────────────────────────────────────────────────────────────────────────

function downloadCSV(filename, rows, columns) {
  const escape = v => (v == null ? "" : String(v).includes(",") || String(v).includes('"') ? `"${String(v).replace(/"/g,'""')}"` : String(v));
  const header = columns.map(c => c.label).join(",");
  const body   = rows.map(r => columns.map(c => escape(c.get(r))).join(",")).join("\n");
  const blob   = new Blob([header + "\n" + body], { type:"text/csv" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

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

// ── Extended stay brand list ───────────────────────────────────────────────
// ── Map coordinates for Ohio markets & submarkets ─────────────────────────
const GEO_COORDS = {
  // Markets
  "Akron, OH":             [41.0814, -81.5190],
  "Cincinnati, OH":        [39.1031, -84.5120],
  "Cleveland, OH":         [41.4993, -81.6944],
  "Columbus, OH":          [39.9612, -82.9988],
  "Dayton, OH":            [39.7589, -84.1916],
  "Ohio State Area, OH":   [40.4173, -82.9071],
  "Sandusky, OH":          [41.4489, -82.7079],
  "Toledo, OH":            [41.6639, -83.5552],
  "Youngstown, OH":        [41.0998, -80.6495],
  // Akron submarkets
  "Akron, OH::Akron":                    [41.0814, -81.5190],
  "Akron, OH::Akron West":               [41.1500, -81.6800],
  "Akron, OH::Canton":                   [40.7989, -81.3784],
  "Akron, OH::Twinsburg/Streetsboro":    [41.3123, -81.4401],
  // Cincinnati submarkets
  "Cincinnati, OH::CVG Airport":         [39.0489, -84.6678],
  "Cincinnati, OH::Cincinnati East":     [39.1200, -84.3200],
  "Cincinnati, OH::Cincinnati North":    [39.2700, -84.4500],
  "Cincinnati, OH::Cincinnati West":     [39.0900, -84.6500],
  "Cincinnati, OH::Downtown Cincinnati": [39.1031, -84.5120],
  "Cincinnati, OH::Franklin":            [39.5578, -84.3047],
  // Cleveland submarkets
  "Cleveland, OH::Avon/I90 West":        [41.4517, -82.0354],
  "Cleveland, OH::Cleveland Heights":    [41.5200, -81.5566],
  "Cleveland, OH::Cleveland Southeast":  [41.3500, -81.5000],
  "Cleveland, OH::Downtown Cleveland":   [41.4993, -81.6944],
  "Cleveland, OH::Strongsville/Medina":  [41.3145, -81.8357],
  // Columbus submarkets
  "Columbus, OH::CMH Airport":           [39.9980, -82.8919],
  "Columbus, OH::Columbus South":        [39.8200, -82.9988],
  "Columbus, OH::Columbus West":         [39.9612, -83.1500],
  "Columbus, OH::Downtown Columbus":     [39.9612, -82.9988],
  "Columbus, OH::Newark":                [40.0581, -82.4013],
  "Columbus, OH::Worthington/Westerville":[40.0931, -82.9557],
  // Dayton submarkets
  "Dayton, OH::Dayton Northeast/Fairborn":[39.8270, -84.0219],
  "Dayton, OH::Dayton South/Miamisburg": [39.6439, -84.2897],
  "Dayton, OH::Downtown/DAY Airport":    [39.9023, -84.2194],
  "Dayton, OH::Springfield":             [39.9242, -83.8088],
  "Dayton, OH::Tipp City/Troy":          [40.0614, -84.2016],
  // Ohio State Area submarkets
  "Ohio State Area, OH::Findlay":        [41.0442, -83.6499],
  "Ohio State Area, OH::I70 Corridor":   [39.9500, -82.0000],
  "Ohio State Area, OH::Lima":           [40.7423, -84.1052],
  "Ohio State Area, OH::Mansfield/Ashland":[40.7584, -82.5154],
  "Ohio State Area, OH::Ohio North":     [41.4000, -82.7000],
  "Ohio State Area, OH::Ohio South":     [39.3000, -82.5000],
  // Sandusky
  "Sandusky, OH::Sandusky":             [41.4489, -82.7079],
  // Toledo submarkets
  "Toledo, OH::Toledo East":             [41.6639, -83.3500],
  "Toledo, OH::Toledo West":             [41.6639, -83.7000],
  // Youngstown
  "Youngstown, OH::Youngstown":          [41.0998, -80.6495],
};

const EXTENDED_STAY_BRANDS = new Set([
  "Extended Stay America Suites", "Extended Stay America Premier Suites",
  "Extended Stay America Select Suites", "WoodSpring Suites",
  "Homewood Suites by Hilton", "Home2 Suites by Hilton", "TownePlace Suites",
  "Candlewood Suites", "Staybridge Suites", "Hawthorn Suites by Wyndham",
  "MainStay Suites", "Suburban Studios", "HomeTowne Studios by Red Roof",
  "InTown Suites", "Sonesta ES Suites", "Sonesta Simply Suites",
  "stayAPT Suites", "Hyatt House", "Residence Inn",
]);

const OUR_MARKETS = [
  "Akron, OH","Cincinnati, OH","Cleveland, OH","Columbus, OH",
  "Dayton, OH","Ohio State Area, OH","Sandusky, OH","Toledo, OH","Youngstown, OH",
];
const SUBMARKET_BY_MKT = {};
Object.keys(GEO_COORDS).filter(k => k.includes("::")).forEach(k => {
  const [mkt, sub] = k.split("::");
  if (!SUBMARKET_BY_MKT[mkt]) SUBMARKET_BY_MKT[mkt] = [];
  SUBMARKET_BY_MKT[mkt].push(sub);
});

// ── Supply data (from participation list) ─────────────────────────────────
const SUPPLY = {
  "Akron, OH": {
    "All Tier":   { rooms: 9804, props: 110 }, "Lower Tier": { rooms: 1891, props:  27 },
    "Mid Tier":   { rooms: 5008, props:  57 }, "Upper Tier": { rooms: 2905, props:  26 } },
  "Akron, OH::Akron": {
    "All Tier":   { rooms: 2563, props:  29 }, "Lower Tier": { rooms:  572, props:   7 },
    "Mid Tier":   { rooms: 1045, props:  14 }, "Upper Tier": { rooms:  946, props:   8 } },
  "Akron, OH::Akron West": {
    "All Tier":   { rooms: 2876, props:  33 }, "Lower Tier": { rooms:  594, props:  10 },
    "Mid Tier":   { rooms: 1661, props:  18 }, "Upper Tier": { rooms:  621, props:   5 } },
  "Akron, OH::Canton": {
    "All Tier":   { rooms: 2602, props:  28 }, "Lower Tier": { rooms:  436, props:   6 },
    "Mid Tier":   { rooms: 1213, props:  14 }, "Upper Tier": { rooms:  953, props:   8 } },
  "Akron, OH::Twinsburg/Streetsboro": {
    "All Tier":   { rooms: 1763, props:  20 }, "Lower Tier": { rooms:  289, props:   4 },
    "Mid Tier":   { rooms: 1089, props:  11 }, "Upper Tier": { rooms:  385, props:   5 } },
  "Cincinnati, OH": {
    "All Tier":   { rooms:32274, props: 291 }, "Lower Tier": { rooms: 5018, props:  59 },
    "Mid Tier":   { rooms:14211, props: 144 }, "Upper Tier": { rooms:13045, props:  88 } },
  "Cincinnati, OH::CVG Airport": {
    "All Tier":   { rooms: 5904, props:  54 }, "Lower Tier": { rooms: 1302, props:  15 },
    "Mid Tier":   { rooms: 2737, props:  27 }, "Upper Tier": { rooms: 1865, props:  12 } },
  "Cincinnati, OH::Cincinnati East": {
    "All Tier":   { rooms: 2306, props:  23 }, "Lower Tier": { rooms:  252, props:   3 },
    "Mid Tier":   { rooms: 1384, props:  14 }, "Upper Tier": { rooms:  670, props:   6 } },
  "Cincinnati, OH::Cincinnati North": {
    "All Tier":   { rooms:12681, props: 115 }, "Lower Tier": { rooms: 2303, props:  23 },
    "Mid Tier":   { rooms: 5695, props:  57 }, "Upper Tier": { rooms: 4683, props:  35 } },
  "Cincinnati, OH::Cincinnati West": {
    "All Tier":   { rooms: 1561, props:  20 }, "Lower Tier": { rooms:  285, props:   3 },
    "Mid Tier":   { rooms: 1009, props:  13 }, "Upper Tier": { rooms:  267, props:   4 } },
  "Cincinnati, OH::Downtown Cincinnati": {
    "All Tier":   { rooms: 8407, props:  57 }, "Lower Tier": { rooms:  337, props:   5 },
    "Mid Tier":   { rooms: 2631, props:  22 }, "Upper Tier": { rooms: 5439, props:  30 } },
  "Cincinnati, OH::Franklin": {
    "All Tier":   { rooms: 1415, props:  22 }, "Lower Tier": { rooms:  539, props:  10 },
    "Mid Tier":   { rooms:  755, props:  11 }, "Upper Tier": { rooms:  121, props:   1 } },
  "Cleveland, OH": {
    "All Tier":   { rooms:21674, props: 166 }, "Lower Tier": { rooms: 2548, props:  28 },
    "Mid Tier":   { rooms: 7891, props:  73 }, "Upper Tier": { rooms:11235, props:  65 } },
  "Cleveland, OH::Avon/I90 West": {
    "All Tier":   { rooms: 5483, props:  50 }, "Lower Tier": { rooms: 1104, props:  13 },
    "Mid Tier":   { rooms: 2600, props:  25 }, "Upper Tier": { rooms: 1779, props:  12 } },
  "Cleveland, OH::Cleveland Heights": {
    "All Tier":   { rooms: 1925, props:  20 }, "Lower Tier": { rooms:  711, props:   7 },
    "Mid Tier":   { rooms:  741, props:   8 }, "Upper Tier": { rooms:  473, props:   5 } },
  "Cleveland, OH::Cleveland Southeast": {
    "All Tier":   { rooms: 3328, props:  29 }, "Lower Tier": { rooms:  219, props:   2 },
    "Mid Tier":   { rooms: 1089, props:  11 }, "Upper Tier": { rooms: 2020, props:  16 } },
  "Cleveland, OH::Downtown Cleveland": {
    "All Tier":   { rooms: 6539, props:  32 }, "Lower Tier": { rooms:   50, props:   1 },
    "Mid Tier":   { rooms:  890, props:   7 }, "Upper Tier": { rooms: 5599, props:  24 } },
  "Cleveland, OH::Strongsville/Medina": {
    "All Tier":   { rooms: 4399, props:  35 }, "Lower Tier": { rooms:  464, props:   5 },
    "Mid Tier":   { rooms: 2571, props:  22 }, "Upper Tier": { rooms: 1364, props:   8 } },
  "Columbus, OH": {
    "All Tier":   { rooms:30974, props: 262 }, "Lower Tier": { rooms: 5610, props:  55 },
    "Mid Tier":   { rooms:10830, props: 119 }, "Upper Tier": { rooms:14534, props:  88 } },
  "Columbus, OH::CMH Airport": {
    "All Tier":   { rooms: 4801, props:  39 }, "Lower Tier": { rooms:  331, props:   2 },
    "Mid Tier":   { rooms: 2049, props:  21 }, "Upper Tier": { rooms: 2421, props:  16 } },
  "Columbus, OH::Columbus South": {
    "All Tier":   { rooms: 4192, props:  47 }, "Lower Tier": { rooms: 1422, props:  14 },
    "Mid Tier":   { rooms: 2342, props:  29 }, "Upper Tier": { rooms:  428, props:   4 } },
  "Columbus, OH::Columbus West": {
    "All Tier":   { rooms: 5003, props:  48 }, "Lower Tier": { rooms:  811, props:   9 },
    "Mid Tier":   { rooms: 2017, props:  24 }, "Upper Tier": { rooms: 2175, props:  15 } },
  "Columbus, OH::Downtown Columbus": {
    "All Tier":   { rooms: 8261, props:  49 }, "Lower Tier": { rooms:  635, props:   6 },
    "Mid Tier":   { rooms: 1553, props:  14 }, "Upper Tier": { rooms: 6073, props:  29 } },
  "Columbus, OH::Newark": {
    "All Tier":   { rooms: 1648, props:  20 }, "Lower Tier": { rooms:  439, props:   5 },
    "Mid Tier":   { rooms:  639, props:   8 }, "Upper Tier": { rooms:  570, props:   7 } },
  "Columbus, OH::Worthington/Westerville": {
    "All Tier":   { rooms: 7069, props:  59 }, "Lower Tier": { rooms: 1972, props:  19 },
    "Mid Tier":   { rooms: 2230, props:  23 }, "Upper Tier": { rooms: 2867, props:  17 } },
  "Dayton, OH": {
    "All Tier":   { rooms:12367, props: 137 }, "Lower Tier": { rooms: 2599, props:  32 },
    "Mid Tier":   { rooms: 6405, props:  76 }, "Upper Tier": { rooms: 3363, props:  29 } },
  "Dayton, OH::Dayton Northeast/Fairborn": {
    "All Tier":   { rooms: 2691, props:  29 }, "Lower Tier": { rooms:  433, props:   5 },
    "Mid Tier":   { rooms: 1598, props:  19 }, "Upper Tier": { rooms:  660, props:   5 } },
  "Dayton, OH::Dayton South/Miamisburg": {
    "All Tier":   { rooms: 2711, props:  27 }, "Lower Tier": { rooms:  710, props:   7 },
    "Mid Tier":   { rooms: 1082, props:  12 }, "Upper Tier": { rooms:  919, props:   8 } },
  "Dayton, OH::Downtown/DAY Airport": {
    "All Tier":   { rooms: 4575, props:  50 }, "Lower Tier": { rooms:  918, props:  11 },
    "Mid Tier":   { rooms: 2227, props:  28 }, "Upper Tier": { rooms: 1430, props:  11 } },
  "Dayton, OH::Springfield": {
    "All Tier":   { rooms: 1095, props:  16 }, "Lower Tier": { rooms:  348, props:   6 },
    "Mid Tier":   { rooms:  579, props:   7 }, "Upper Tier": { rooms:  168, props:   3 } },
  "Dayton, OH::Tipp City/Troy": {
    "All Tier":   { rooms: 1295, props:  15 }, "Lower Tier": { rooms:  190, props:   3 },
    "Mid Tier":   { rooms:  919, props:  10 }, "Upper Tier": { rooms:  186, props:   2 } },
  "Ohio State Area, OH": {
    "All Tier":   { rooms:27249, props: 412 }, "Lower Tier": { rooms: 6291, props: 100 },
    "Mid Tier":   { rooms:17506, props: 253 }, "Upper Tier": { rooms: 3452, props:  59 } },
  "Ohio State Area, OH::Findlay": {
    "All Tier":   { rooms: 1272, props:  15 }, "Lower Tier": { rooms:  255, props:   3 },
    "Mid Tier":   { rooms:  585, props:   8 }, "Upper Tier": { rooms:  432, props:   4 } },
  "Ohio State Area, OH::I70 Corridor": {
    "All Tier":   { rooms: 2091, props:  24 }, "Lower Tier": { rooms:  690, props:   9 },
    "Mid Tier":   { rooms:  997, props:  13 }, "Upper Tier": { rooms:  404, props:   2 } },
  "Ohio State Area, OH::Lima": {
    "All Tier":   { rooms: 1435, props:  16 }, "Lower Tier": { rooms:  477, props:   6 },
    "Mid Tier":   { rooms:  859, props:   9 }, "Upper Tier": { rooms:   99, props:   1 } },
  "Ohio State Area, OH::Mansfield/Ashland": {
    "All Tier":   { rooms: 1902, props:  27 }, "Lower Tier": { rooms:  567, props:   9 },
    "Mid Tier":   { rooms: 1209, props:  16 }, "Upper Tier": { rooms:  126, props:   2 } },
  "Ohio State Area, OH::Ohio North": {
    "All Tier":   { rooms:13992, props: 231 }, "Lower Tier": { rooms: 3060, props:  51 },
    "Mid Tier":   { rooms: 8984, props: 138 }, "Upper Tier": { rooms: 1948, props:  42 } },
  "Ohio State Area, OH::Ohio South": {
    "All Tier":   { rooms: 6557, props:  99 }, "Lower Tier": { rooms: 1242, props:  22 },
    "Mid Tier":   { rooms: 4872, props:  69 }, "Upper Tier": { rooms:  443, props:   8 } },
  "Sandusky, OH": {
    "All Tier":   { rooms: 5116, props:  43 }, "Lower Tier": { rooms:  846, props:  12 },
    "Mid Tier":   { rooms: 2503, props:  26 }, "Upper Tier": { rooms: 1767, props:   5 } },
  "Toledo, OH": {
    "All Tier":   { rooms: 7786, props:  78 }, "Lower Tier": { rooms: 1641, props:  19 },
    "Mid Tier":   { rooms: 3720, props:  41 }, "Upper Tier": { rooms: 2425, props:  18 } },
  "Toledo, OH::Toledo East": {
    "All Tier":   { rooms: 3333, props:  35 }, "Lower Tier": { rooms:  691, props:   9 },
    "Mid Tier":   { rooms: 1924, props:  20 }, "Upper Tier": { rooms:  718, props:   6 } },
  "Toledo, OH::Toledo West": {
    "All Tier":   { rooms: 4453, props:  43 }, "Lower Tier": { rooms:  950, props:  10 },
    "Mid Tier":   { rooms: 1796, props:  21 }, "Upper Tier": { rooms: 1707, props:  12 } },
  "Youngstown, OH": {
    "All Tier":   { rooms: 3279, props:  44 }, "Lower Tier": { rooms:  534, props:   9 },
    "Mid Tier":   { rooms: 2144, props:  29 }, "Upper Tier": { rooms:  601, props:   6 } },
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

// Portal-based popover — renders to document.body, immune to overflow clipping
function Popover({ anchorRef, open, children, minWidth = 200 }) {
  const [style, setStyle] = React.useState(null);
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) { setStyle(null); return; }
    const r = anchorRef.current.getBoundingClientRect();
    const viewH = window.innerHeight;
    const spaceBelow = viewH - r.bottom;
    const goUp = spaceBelow < 300 && r.top > spaceBelow;
    const w = Math.max(minWidth, r.width);
    const left = Math.min(r.left, window.innerWidth - w - 8);
    setStyle(goUp
      ? { position:"fixed", left:Math.max(8, left), bottom:viewH - r.top + 4, minWidth:w, zIndex:99999 }
      : { position:"fixed", left:Math.max(8, left), top:r.bottom + 4, minWidth:w, zIndex:99999 }
    );
  }, [open]);
  if (!open || !style) return null;
  return ReactDOM.createPortal(<div style={{ ...style, fontFamily:"'DM Sans','Segoe UI',sans-serif" }}>{children}</div>, document.body);
}

export default function KalibriDashboard() {
  const [db,          setDb]          = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [loadError,   setLoadError]   = useState(null);

  // filters
  const [revType,      setRevType]      = useState("Guest Paid");
  const [tiers,        setTiers]        = useState(["All Tier"]);
  const [losTiers,     setLosTiers]     = useState([""]);
  const [geoLevel,     setGeoLevel]     = useState("market");
  const [selectedGeos, setSelectedGeos] = useState([]);   // [] = all; market names or "Market::Sub" keys
  const [period1,      setPeriod1]      = useState("");
  const [showForecast, setShowForecast] = useState(false);
  const [showMarkers,  setShowMarkers]  = useState(true);
  const [timeWindow,   setTimeWindow]   = useState("mo");

  // tabs
  const [tab, setTab] = useState("overview");

  // overview
  const [sortKey,  setSortKey]  = useState("revpar_yoy");
  const [sortDir,  setSortDir]  = useState("desc");
  const [ovStart,  setOvStart]  = useState("");

  // trend
  const [trendMetric, setTrendMetric] = useState("revpar");
  const [yoyClip,     setYoyClip]     = useState(null);
  const [trendGeoSel,  setTrendGeoSel]  = useState(null);
  const [trendGeoOpen, setTrendGeoOpen] = useState(false);
  const [trendStart,   setTrendStart]   = useState("2023-01");
  const [trendEnd,     setTrendEnd]     = useState("2026-01");

  // cagr
  const [cagrStart,      setCagrStart]      = useState("2023-01");
  const [cagrEnd,        setCagrEnd]        = useState("2026-01");
  const [cagrSortKey,    setCagrSortKey]    = useState("revpar_cagr");
  const [cagrSortDir,    setCagrSortDir]    = useState("desc");
  const [cagrChartMetric,setCagrChartMetric]= useState("revpar_cagr");

  // score tab
  const [scoreRevType,    setScoreRevType]    = useState("Guest Paid");
  const [scoreLos,        setScoreLos]        = useState([""]); // array of selected LOS tier ids, default Overview
  const [scoreTier,       setScoreTier]       = useState(["Lower", "Mid", "Upper"]); // array of selected tier ids, default all
  const [scoreMetricW,    setScoreMetricW]    = useState({ revpar:1, revpar_cagr:1, occ:1, occ_cagr:1, adr:1, adr_cagr:1, alos:1 });
  const [scoreSupplyW,    setScoreSupplyW]    = useState(0); // -10 to +10
  const [scoreCagrStart,  setScoreCagrStart]  = useState("2023-01");
  const [scoreCagrEnd,    setScoreCagrEnd]    = useState("2026-01");

  // supply tab
  const [supplyData,          setSupplyData]          = useState([]);
  const [expandedGeo,         setExpandedGeo]         = useState(null);
  const [expandedTier,        setExpandedTier]        = useState("All Tier");
  const [extStayOnly,         setExtStayOnly]         = useState(false);
  const [supplyFilterCompany, setSupplyFilterCompany] = useState([]);
  const [supplyFilterBrand,   setSupplyFilterBrand]   = useState([]);
  const [supplyCompanyOpen,   setSupplyCompanyOpen]   = useState(false);
  const [supplyBrandOpen,     setSupplyBrandOpen]     = useState(false);
  const [supplySortKey,       setSupplySortKey]       = useState("rooms");
  const [supplySortDir,       setSupplySortDir]       = useState("desc");

  // overview two-panel
  const [hoveredRow, setHoveredRow] = useState(null);

  // map tab
  const [mapReady,      setMapReady]     = useState(false);
  const [mapMode,       setMapMode]      = useState("bubbles");   // "bubbles" | "pins"
  const [ccStatusOpen,  setCcStatusOpen] = useState(false);
  const [mapCompanies,  setMapCompanies] = useState([]);
  const [mapBrands,     setMapBrands]    = useState([]);
  const [mapExtStay,    setMapExtStay]   = useState(false);
  const [drillMkt,      setDrillMkt]     = useState(null);
  // Construct Connect layer
  const [ccData,        setCcData]       = useState([]);
  const [showCC,        setShowCC]       = useState(false);
  const [ccTypeFilter,  setCcTypeFilter] = useState("all"); // "all" | "hotel" | "elderly"
  const [ccStatuses,    setCcStatuses]   = useState([]);    // [] = all statuses
  const mapInstanceRef      = useRef(null);
  const trendGeoRef         = useRef(null);
  const supplyCompanyRef    = useRef(null);
  const supplyBrandRef      = useRef(null);
  const ccStatusRef         = useRef(null);

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
        const threeYrPrior = `${parseInt(y) - 3}-${mo}`;
        setCagrEnd(latestActual);
        setCagrStart(allPeriods.includes(threeYrPrior) ? threeYrPrior : allPeriods[0]);
        setScoreCagrEnd(latestActual);
        setScoreCagrStart(allPeriods.includes(threeYrPrior) ? threeYrPrior : allPeriods[0]);
      })
      .catch(e => { setLoadError(e.message); setLoading(false); });

    fetch("/kalibri_supply_detail.csv")
      .then(r => r.text())
      .then(text => {
        const lines = text.trim().split(/\r?\n/);
        const parseRow = line => {
          const vals = []; let inQ = false, cur = "";
          for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            if (ch === '"') { inQ = !inQ; }
            else if (ch === "," && !inQ) { vals.push(cur); cur = ""; }
            else { cur += ch; }
          }
          vals.push(cur);
          return vals;
        };
        const headers = parseRow(lines[0]).map(h => h.trim());
        const rows = lines.slice(1).map(line => {
          const vals = parseRow(line);
          const row = {};
          headers.forEach((h, i) => row[h] = (vals[i] || "").trim());
          row.Rooms = parseInt(row.Rooms) || 0;
          return row;
        });
        setSupplyData(rows);
      })
      .catch(() => {}); // non-fatal

    fetch("/construct_connect.csv")
      .then(r => r.text())
      .then(text => {
        const lines = text.trim().split(/\r?\n/);
        const headers = lines[0].split(",").map(h => h.trim());
        const rows = lines.slice(1).map(line => {
          const vals = []; let inQ = false, cur = "";
          for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            if (ch === '"') { inQ = !inQ; }
            else if (ch === "," && !inQ) { vals.push(cur); cur = ""; }
            else { cur += ch; }
          }
          vals.push(cur);
          const row = {};
          headers.forEach((h, i) => row[h] = (vals[i] || "").trim());
          row.Value = parseInt(row.Value) || 0;
          row.Lat   = parseFloat(row.Lat)  || null;
          row.Lng   = parseFloat(row.Lng)  || null;
          return row;
        }).filter(r => r.Lat && r.Lng);
        setCcData(rows);
      })
      .catch(() => {});
  }, []);

  // Load Leaflet from CDN
  useEffect(() => {
    if (window.L) { setMapReady(true); return; }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => setMapReady(true);
    document.head.appendChild(script);
  }, []);

  // Build / rebuild map
  useEffect(() => {
    if (tab !== "map" || !mapReady || !supplyData.length) return;
    let map = null;
    const timer = setTimeout(() => {
      const container = document.getElementById("kalibri-map");
      if (!container) return;
      const L = window.L;
      map = L.map(container, { zoomControl: true, scrollWheelZoom: true }).setView([40.4173, -82.9071], 7);
      mapInstanceRef.current = map;
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>',
        subdomains: "abcd", maxZoom: 19,
      }).addTo(map);

      // CSS
      const style = document.createElement("style");
      style.id = "kalibri-map-style";
      style.textContent = `.map-geo-label{background:transparent!important;border:none!important;box-shadow:none!important;font-size:10px!important;font-weight:700!important;color:#e2e8f0!important;text-shadow:0 1px 4px rgba(0,0,0,0.9)!important;white-space:nowrap!important}.map-geo-label::before{display:none!important}.leaflet-popup-content-wrapper{background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3)}.leaflet-popup-tip{background:#fff}`;
      if (!document.getElementById("kalibri-map-style")) document.head.appendChild(style);

      const TIER_PIN_COLOR = { "Lower Tier":"#ef4444", "Mid Tier":"#f59e0b", "Upper Tier":"#10b981" };

      if (mapMode === "pins") {
        // ── Property pins ───────────────────────────────────────────────
        let filtered = supplyData.filter(r => r.Lat && r.Lng);
        if (tiers[0] !== "All Tier") filtered = filtered.filter(r => tiers.includes(r.Tier));
        if (mapExtStay)               filtered = filtered.filter(r => EXTENDED_STAY_BRANDS.has(r.Brand));
        if (mapCompanies.length > 0)  filtered = filtered.filter(r => mapCompanies.includes(r.Company));
        if (mapBrands.length > 0)     filtered = filtered.filter(r => mapBrands.includes(r.Brand));
        if (selectedGeos.length > 0) {
          if (geoLevel === "market") {
            filtered = filtered.filter(r => selectedGeos.includes(r.Market));
          } else {
            filtered = filtered.filter(r => {
              const k = r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market;
              return selectedGeos.includes(k);
            });
          }
        }

        filtered.forEach(r => {
          const color = TIER_PIN_COLOR[r.Tier] || "#64748b";
          const marker = L.circleMarker([parseFloat(r.Lat), parseFloat(r.Lng)], {
            radius: 5, fillColor: color, color: "#000", weight: 0.5, opacity: 0.9, fillOpacity: 0.85,
          }).addTo(map);
          marker.bindPopup(`
            <div style="font-family:sans-serif;min-width:200px;padding:4px">
              <div style="font-size:13px;font-weight:700;margin-bottom:4px">${r.Property}</div>
              <div style="font-size:11px;color:#64748b;margin-bottom:6px">${r.Submarket || r.Market}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                <span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:${color}22;color:${color}">${r.Tier.replace(" Tier","")}</span>
                ${EXTENDED_STAY_BRANDS.has(r.Brand) ? '<span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:#8b5cf622;color:#8b5cf6">Extended Stay</span>' : ""}
              </div>
              <table style="font-size:11px;width:100%;border-collapse:collapse">
                <tr><td style="color:#64748b;padding:2px 8px 2px 0">Brand</td><td style="font-weight:500">${r.Brand}</td></tr>
                <tr><td style="color:#64748b;padding:2px 8px 2px 0">Company</td><td>${r.Company}</td></tr>
                <tr><td style="color:#64748b;padding:2px 8px 2px 0">Class</td><td>${r["Chain Class"] || "—"}</td></tr>
                <tr><td style="color:#64748b;padding:2px 8px 2px 0">Rooms</td><td><b>${r.Rooms}</b></td></tr>
              </table>
            </div>`);
        });

        // Pin legend
        const legend = L.control({ position: "bottomright" });
        legend.onAdd = () => {
          const div = L.DomUtil.create("div");
          const shown = mapBrands.length > 0 ? mapBrands.length + " brand(s)" : mapExtStay ? "Extended Stay" : "All brands";
          div.innerHTML = `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:11px;color:#94a3b8">
            <div style="font-weight:700;color:#e2e8f0;margin-bottom:8px;font-size:10px;text-transform:uppercase;letter-spacing:1px">${filtered.length} properties · ${shown}</div>
            ${Object.entries(TIER_PIN_COLOR).map(([t, c]) => `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="${c}" fill-opacity="0.85" stroke="#000" stroke-width="0.5"/></svg><span style="color:${c}">${t.replace(" Tier","")}</span></div>`).join("")}
          </div>`;
          return div;
        };
        legend.addTo(map);

      } else {
        // ── Bubble view ─────────────────────────────────────────────────
        const geoMap = {};
        for (const r of supplyData) {
          if (selectedGeos.length > 0) {
            if (geoLevel === "market" && !selectedGeos.includes(r.Market)) continue;
            if (geoLevel === "submarket") {
              const k = r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market;
              if (!selectedGeos.includes(k)) continue;
            }
          }
          const key = geoLevel === "market"
            ? r.Market
            : (r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market);
          if (!geoMap[key]) geoMap[key] = {
            name: geoLevel === "market" ? r.Market.replace(", OH","") : (r.Submarket || r.Market.replace(", OH","")),
            market: r.Market, totalRooms: 0, totalProps: 0, filteredRooms: 0, filteredProps: 0, tiers: {},
          };
          const tierMatch = tiers[0] === "All Tier" || tiers.includes(r.Tier);
          geoMap[key].totalRooms += r.Rooms;
          geoMap[key].totalProps += 1;
          if (!geoMap[key].tiers[r.Tier]) geoMap[key].tiers[r.Tier] = { rooms: 0, props: 0 };
          geoMap[key].tiers[r.Tier].rooms += r.Rooms;
          geoMap[key].tiers[r.Tier].props += 1;
          if (tierMatch) { geoMap[key].filteredRooms += r.Rooms; geoMap[key].filteredProps += 1; }
        }
        const geos = Object.entries(geoMap).filter(([k]) => GEO_COORDS[k] && geoMap[k].filteredRooms > 0);
        const maxRooms = Math.max(...geos.map(([, g]) => g.filteredRooms), 1);
        const tierColor = tiers[0] === "All Tier" ? "#3b82f6"
          : tiers.length === 1 && tiers[0] === "Lower Tier" ? "#ef4444"
          : tiers.length === 1 && tiers[0] === "Mid Tier"   ? "#f59e0b"
          : tiers.length === 1 && tiers[0] === "Upper Tier" ? "#10b981"
          : "#8b5cf6";

        for (const [key, geo] of geos) {
          const [lat, lng] = GEO_COORDS[key];
          const radius = Math.max(8, Math.sqrt(geo.filteredRooms / maxRooms) * 42);
          const lower  = geo.tiers["Lower Tier"] || { rooms:0, props:0 };
          const mid    = geo.tiers["Mid Tier"]   || { rooms:0, props:0 };
          const upper  = geo.tiers["Upper Tier"] || { rooms:0, props:0 };
          const circle = L.circleMarker([lat, lng], {
            radius, fillColor: tierColor, color: "#ffffff", weight: 1.5, opacity: 0.9, fillOpacity: 0.55,
          }).addTo(map);
          circle.bindPopup(`
            <div style="font-family:sans-serif;min-width:220px;padding:4px">
              <div style="font-size:14px;font-weight:700;margin-bottom:4px">${geo.name}</div>
              ${geoLevel === "submarket" ? `<div style="font-size:11px;color:#64748b;margin-bottom:6px">${geo.market}</div>` : ""}
              <div style="font-size:12px;margin-bottom:8px"><b>${geo.totalRooms.toLocaleString()}</b> total rooms · <b>${geo.totalProps}</b> properties</div>
              <table style="font-size:11px;border-collapse:collapse;width:100%">
                <tr style="color:#64748b;border-bottom:1px solid #e2e8f0"><th style="text-align:left;padding:3px 8px 3px 0">Tier</th><th style="text-align:right;padding:3px 4px">Rooms</th><th style="text-align:right;padding:3px 0 3px 8px">Props</th></tr>
                <tr><td style="padding:3px 8px 3px 0;color:#ef4444;font-weight:500">Lower</td><td style="text-align:right;padding:3px 4px">${lower.rooms.toLocaleString()}</td><td style="text-align:right;padding:3px 0 3px 8px">${lower.props}</td></tr>
                <tr><td style="padding:3px 8px 3px 0;color:#f59e0b;font-weight:500">Mid</td><td style="text-align:right;padding:3px 4px">${mid.rooms.toLocaleString()}</td><td style="text-align:right;padding:3px 0 3px 8px">${mid.props}</td></tr>
                <tr><td style="padding:3px 8px 3px 0;color:#10b981;font-weight:500">Upper</td><td style="text-align:right;padding:3px 4px">${upper.rooms.toLocaleString()}</td><td style="text-align:right;padding:3px 0 3px 8px">${upper.props}</td></tr>
              </table>
            </div>`);
          if (geoLevel === "market") {
            circle.bindTooltip(geo.name, { permanent: true, direction: "top", className: "map-geo-label", offset: [0, -(radius + 2)] });
          }
        }

        // Bubble legend
        const legend = L.control({ position: "bottomright" });
        legend.onAdd = () => {
          const div = L.DomUtil.create("div");
          const sizes = [[maxRooms, "Max"], [Math.round(maxRooms * 0.5), "50%"], [Math.round(maxRooms * 0.25), "25%"]];
          div.innerHTML = `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:11px;color:#94a3b8">
            <div style="font-weight:700;color:#e2e8f0;margin-bottom:2px;font-size:10px;text-transform:uppercase;letter-spacing:1px">Rooms</div>
            <div style="font-size:9px;color:#475569;margin-bottom:8px">bubble size = room count</div>
            ${sizes.map(([r, lbl]) => { const px = Math.max(8, Math.sqrt(r / maxRooms) * 42); return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><svg width="${px*2+2}" height="${px*2+2}" style="flex-shrink:0"><circle cx="${px+1}" cy="${px+1}" r="${px}" fill="${tierColor}" fill-opacity="0.55" stroke="#fff" stroke-width="1.5"/></svg><span>${r.toLocaleString()} <span style="color:#475569">${lbl}</span></span></div>`; }).join("")}
          </div>`;
          return div;
        };
        legend.addTo(map);
      }

      // ── Construct Connect layer ─────────────────────────────────────
      if (showCC && ccData.length) {
        const CC_STATUS_COLOR = {
          "Conceptual":                 "#64748b",
          "Design":                     "#3b82f6",
          "Final Planning":             "#8b5cf6",
          "GC Bidding":                 "#f59e0b",
          "Sub-Bidding":                "#f59e0b",
          "Pre-Construction/Negotiated":"#f97316",
          "Award":                      "#10b981",
          "Post-Bid":                   "#10b981",
          "Bid Results":                "#10b981",
          "Under Construction":         "#22c55e",
        };
        const fmtVal = v => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(0)}K` : v ? `$${v}` : "—";

        let ccFiltered = ccData;
        if (ccTypeFilter === "hotel")   ccFiltered = ccFiltered.filter(r => r.HasHotel   === "TRUE");
        if (ccTypeFilter === "elderly") ccFiltered = ccFiltered.filter(r => r.HasElderly === "TRUE");
        if (ccStatuses.length > 0)      ccFiltered = ccFiltered.filter(r => ccStatuses.includes(r.Status));

        ccFiltered.forEach(r => {
          const color = CC_STATUS_COLOR[r.Status] || "#64748b";
          const icon = L.divIcon({
            html: `<div style="width:9px;height:9px;background:${color};transform:rotate(45deg);border:1px solid rgba(0,0,0,0.5);border-radius:1px"></div>`,
            className: "", iconSize: [9, 9], iconAnchor: [5, 5],
          });
          const marker = L.marker([r.Lat, r.Lng], { icon }).addTo(map);
          marker.bindPopup(`
            <div style="font-family:sans-serif;min-width:220px;padding:4px">
              <div style="font-size:13px;font-weight:700;margin-bottom:4px">${r.Title}</div>
              <div style="font-size:11px;color:#64748b;margin-bottom:6px">${r.City}, ${r.State}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
                <span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:${color}22;color:${color}">${r.Status}</span>
                ${r.HasHotel === "TRUE" ? '<span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:#3b82f622;color:#3b82f6">Hotel</span>' : ""}
                ${r.HasElderly === "TRUE" ? '<span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:#8b5cf622;color:#8b5cf6">Elderly Care</span>' : ""}
              </div>
              <table style="font-size:11px;border-collapse:collapse;width:100%">
                <tr><td style="color:#64748b;padding:2px 8px 2px 0">Value</td><td style="font-weight:700;color:#10b981">${fmtVal(r.Value)}</td></tr>
                ${r.BidDate ? `<tr><td style="color:#64748b;padding:2px 8px 2px 0">Bid Date</td><td>${r.BidDate}</td></tr>` : ""}
                ${r.Uses ? `<tr><td style="color:#64748b;padding:2px 8px 2px 0">Uses</td><td style="color:#94a3b8">${r.Uses}</td></tr>` : ""}
              </table>
            </div>`);
        });

        // CC legend
        const ccLegend = L.control({ position: "bottomleft" });
        ccLegend.onAdd = () => {
          const div = L.DomUtil.create("div");
          const visibleStatuses = [...new Set(ccFiltered.map(r => r.Status))].sort();
          div.innerHTML = `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:11px;color:#94a3b8;max-width:200px">
            <div onclick="const b=this.nextElementSibling;const tog=this.querySelector('.cc-tog');if(b.style.display==='none'){b.style.display='flex';tog.textContent='▼';}else{b.style.display='none';tog.textContent='▶';}" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;margin-bottom:8px">
              <span style="font-weight:700;color:#e2e8f0;font-size:10px;text-transform:uppercase;letter-spacing:1px">CC Projects · ${ccFiltered.length}</span>
              <span class="cc-tog" style="color:#64748b;font-size:9px;margin-left:8px">▼</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:3px">
              ${visibleStatuses.map(s => { const c = CC_STATUS_COLOR[s]||"#64748b"; return `<div style="display:flex;align-items:center;gap:6px"><div style="width:8px;height:8px;background:${c};transform:rotate(45deg);flex-shrink:0;border-radius:1px"></div><span style="color:${c};font-size:10px">${s}</span></div>`; }).join("")}
            </div>
          </div>`;
          return div;
        };
        ccLegend.addTo(map);
      }

    }, 80);

    return () => {
      clearTimeout(timer);
      if (map) { map.remove(); map = null; }
      mapInstanceRef.current = null;
    };
  }, [tab, mapReady, supplyData, geoLevel, selectedGeos, tiers, mapMode, mapCompanies, mapBrands, mapExtStay, ccData, showCC, ccTypeFilter, ccStatuses]);

  const periods         = useMemo(() => db ? Object.keys(db.lookup).sort() : [], [db]);
  const lastActual      = useMemo(() => db?.lastActual || LAST_ACTUAL_OVERRIDE || "2026-01", [db]);
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
      .filter(([k, v]) => {
        if (geoLevel === "market")    return !v.isSubmarket && (selectedGeos.length === 0 || selectedGeos.includes(k));
        if (geoLevel === "submarket") return v.isSubmarket  && (selectedGeos.length === 0 || selectedGeos.includes(k));
        return false;
      })
      .map(([k]) => k)
      .sort();
  }, [geoMeta, geoLevel, selectedGeos, db]);

  const isForecast = p => p > lastActual;

  const forecastStartLabel = useMemo(() => {
    const fp = filteredPeriods.filter((_, i) => i % 3 === 0 || i === filteredPeriods.length - 1).find(p => p > lastActual);
    return fp ? periodLabel(fp) : null;
  }, [filteredPeriods, lastActual]);

  // ── Overview rows ──────────────────────────────────────────────────────────
  const overviewRows = useMemo(() => {
    if (!db || !period1) return [];
    const rows = filteredGeos.map(geo => {
      const m = computeTrailing(db.lookup, period1, geo, revType, tiers, losTiers, tw, periods);
      if (!m) return null;
      const label = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
      const mkt   = geoMeta[geo]?.market || "";

      // Always compute YoY from raw values so Prior Year and manual selection are consistent
      const [py, pmo] = period1.split("-");
      const compareDate = ovStart || `${parseInt(py)-1}-${pmo}`;
      const ms = computeTrailing(db.lookup, compareDate, geo, revType, tiers, losTiers, tw, periods);
      const chg = (v, b, isOcc) => v != null && b != null ? (isOcc ? v - b : (b > 0 ? v / b - 1 : null)) : null;
      let displayM = ms ? {
        ...m,
        occ_yoy:          chg(m.occ,          ms.occ,          true),
        adr_yoy:          chg(m.adr,          ms.adr,          false),
        revpar_yoy:       chg(m.revpar,       ms.revpar,       false),
        booking_cost_yoy: chg(m.booking_cost, ms.booking_cost, false),
        alos_yoy:         chg(m.alos,         ms.alos,         false),
      } : m;
      return { geo, label, mkt, m: displayM };
    }).filter(Boolean);

    const dir = sortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a.m[sortKey] ?? null, bv = b.m[sortKey] ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (bv - av);
    });
    return rows;
  }, [db, filteredGeos, period1, ovStart, revType, tiers, losTiers, tw, periods, sortKey, sortDir]);

  // ── Trend series ───────────────────────────────────────────────────────────
  const trendData = useMemo(() => {
    if (!db || !filteredGeos.length || !period1) return { series:[], chartData:[], top6:[] };

    // Filter periods by start/end range
    const trendPeriods = filteredPeriods.filter(p => {
      if (trendStart && p < trendStart) return false;
      if (trendEnd   && p > trendEnd)   return false;
      return true;
    });
    const rankPeriod = trendEnd || period1;

    const top6 = [...filteredGeos]
      .map(g => ({ geo:g, val: computeTrailing(db.lookup, rankPeriod, g, revType, tiers, losTiers, tw, periods)?.[trendMetric] || 0 }))
      .sort((a, b) => b.val - a.val)
      .slice(0, 6)
      .map(g => g.geo);
    const topGeos = trendGeoSel ? trendGeoSel.filter(g => filteredGeos.includes(g)) : top6;

    const isYoY = trendMetric.endsWith("_yoy");
    const applyClip = v => (isYoY && yoyClip != null && v != null) ? Math.max(-yoyClip, Math.min(yoyClip, v)) : v;

    const chartData = trendPeriods
      .map(p => {
        const row = { period: periodLabel(p), periodRaw: p };
        for (const geo of topGeos) {
          const m = computeTrailing(db.lookup, p, geo, revType, tiers, losTiers, tw, periods);
          const lbl = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
          const raw = m?.[trendMetric] != null ? parseFloat(m[trendMetric].toFixed(6)) : null;
          row[lbl] = applyClip(raw);
        }
        return row;
      });

    return { series: topGeos.map(g => geoMeta[g]?.submarket || geoMeta[g]?.market || g), chartData, top6 };
  }, [db, filteredGeos, period1, revType, tiers, losTiers, tw, periods, trendMetric, filteredPeriods, yoyClip, trendGeoSel, trendStart, trendEnd]);

  // ── CAGR rows ──────────────────────────────────────────────────────────────
  const cagrRows = useMemo(() => {
    if (!db || !cagrStart || !cagrEnd) return [];
    const [sy, sm] = cagrStart.split("-"), [ey, em] = cagrEnd.split("-");
    const years = (parseInt(ey) - parseInt(sy)) + (parseInt(em) - parseInt(sm)) / 12;
    const rows = filteredGeos.map(geo => {
      const ms = computeTrailing(db.lookup, cagrStart, geo, revType, tiers, losTiers, tw, periods);
      const me = computeTrailing(db.lookup, cagrEnd,   geo, revType, tiers, losTiers, tw, periods);
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
  }, [db, filteredGeos, cagrStart, cagrEnd, revType, tiers, losTiers, tw, periods, cagrSortKey, cagrSortDir]);

  // ── Supply rows ────────────────────────────────────────────────────────────
  const supplyRows = useMemo(() => {
    if (!supplyData.length) return [];

    let filtered = supplyData;
    if (selectedGeos.length > 0) {
      if (geoLevel === "market") {
        filtered = filtered.filter(r => selectedGeos.includes(r.Market));
      } else {
        filtered = filtered.filter(r => {
          const k = r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market;
          return selectedGeos.includes(k);
        });
      }
    }

    // Tier filter using existing tiers state
    const tierFilter = tiers.includes("All Tier") ? null : tiers.map(t => t.toLowerCase());
    if (tierFilter) {
      filtered = filtered.filter(r => tierFilter.some(t => r.Tier.toLowerCase().includes(t.replace(" tier",""))));
    }

    // Extended stay filter
    if (extStayOnly) {
      filtered = filtered.filter(r => EXTENDED_STAY_BRANDS.has(r.Brand));
    }

    // Group by geo
    const geoMap = {};
    for (const r of filtered) {
      const geo = geoLevel === "market" ? r.Market : (r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market);
      const label = geoLevel === "market" ? r.Market : (r.Submarket || r.Market);
      const mkt = r.Market;
      if (!geoMap[geo]) geoMap[geo] = { geo, label, mkt, rooms:0, props:0, tiers:{} };
      const entry = geoMap[geo];
      entry.rooms += r.Rooms;
      entry.props += 1;
      const t = r.Tier;
      if (!entry.tiers[t]) entry.tiers[t] = { rooms:0, props:0 };
      entry.tiers[t].rooms += r.Rooms;
      entry.tiers[t].props += 1;
    }

    const rows = Object.values(geoMap);
    const dir = supplySortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      if (supplySortKey === "lower") return dir * ((b.tiers["Lower Tier"]?.rooms||0) - (a.tiers["Lower Tier"]?.rooms||0));
      if (supplySortKey === "mid")   return dir * ((b.tiers["Mid Tier"]?.rooms||0)   - (a.tiers["Mid Tier"]?.rooms||0));
      if (supplySortKey === "upper") return dir * ((b.tiers["Upper Tier"]?.rooms||0) - (a.tiers["Upper Tier"]?.rooms||0));
      return dir * (b.rooms - a.rooms);
    });
    return rows;
  }, [supplyData, geoLevel, selectedGeos, tiers, extStayOnly, supplySortKey, supplySortDir]);

  const supplyBrands = useMemo(() => {
    if (!expandedGeo || !supplyData.length) return [];
    let filtered = supplyData.filter(r => {
      const geo = geoLevel === "market" ? r.Market : (r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market);
      return geo === expandedGeo;
    });
    if (expandedTier !== "All Tier") {
      filtered = filtered.filter(r => r.Tier === expandedTier);
    }
    // Group by Brand
    const brandMap = {};
    for (const r of filtered) {
      const key = r.Brand || "Independent";
      if (!brandMap[key]) brandMap[key] = { brand: key, company: r.Company, tier: r.Tier, chainClass: r["Chain Class"], rooms:0, props:0, properties:[] };
      brandMap[key].rooms += r.Rooms;
      brandMap[key].props += 1;
      brandMap[key].properties.push(r.Property);
    }
    let brands = Object.values(brandMap).sort((a, b) => b.rooms - a.rooms);
    if (extStayOnly)                       brands = brands.filter(b => EXTENDED_STAY_BRANDS.has(b.brand));
    if (supplyFilterCompany.length > 0)    brands = brands.filter(b => supplyFilterCompany.includes(b.company));
    if (supplyFilterBrand.length > 0)      brands = brands.filter(b => supplyFilterBrand.includes(b.brand));
    return brands;
  }, [expandedGeo, expandedTier, extStayOnly, supplyFilterCompany, supplyFilterBrand, supplyData, geoLevel]);

  const supplyCompanies = useMemo(() =>
    [...new Set(supplyData.map(r => r.Company))].filter(Boolean).sort()
  , [supplyData]);

  const supplyVisibleBrands = useMemo(() => {
    let rows = supplyData;
    if (extStayOnly)                    rows = rows.filter(r => EXTENDED_STAY_BRANDS.has(r.Brand));
    if (supplyFilterCompany.length > 0) rows = rows.filter(r => supplyFilterCompany.includes(r.Company));
    return [...new Set(rows.map(r => r.Brand))].filter(Boolean).sort();
  }, [supplyData, extStayOnly, supplyFilterCompany]);

  // ── Score rows ─────────────────────────────────────────────────────────────
  const scoreRows = useMemo(() => {
    if (!db || !filteredGeos.length) return [];

    const endPeriod = lastActual;

    // Map scoreTier short names to full tier keys used in data
    const TIER_MAP = { "Lower": "Lower Tier", "Mid": "Mid Tier", "Upper": "Upper Tier" };
    const activeTiers = scoreTier.map(t => TIER_MAP[t]).filter(Boolean);
    const activeLos   = scoreLos;

    // CAGR years
    let cagrYears = 0;
    if (scoreCagrStart && scoreCagrEnd && scoreCagrEnd > scoreCagrStart) {
      const [sy, sm] = scoreCagrStart.split("-");
      const [ey, em] = scoreCagrEnd.split("-");
      cagrYears = (parseInt(ey) - parseInt(sy)) + (parseInt(em) - parseInt(sm)) / 12;
    }

    const twMo = TIME_WINDOWS.find(t => t.id === "mo");

    const rawData = filteredGeos.map(geo => {
      // Single computeTrailing call with selected arrays — handles multi-LOS and multi-Tier aggregation
      const m = computeTrailing(db.lookup, endPeriod, geo, scoreRevType, activeTiers, activeLos, tw, periods);

      const revpar = m?.revpar ?? null;
      const occ    = m?.occ    ?? null;
      const adr    = m?.adr    ?? null;
      const alos   = m?.alos   ?? null;

      // CAGR
      let revpar_cagr = null, occ_cagr = null, adr_cagr = null;
      if (cagrYears > 0 && scoreCagrStart && scoreCagrEnd) {
        const ms = computeTrailing(db.lookup, scoreCagrStart, geo, scoreRevType, activeTiers, activeLos, twMo, periods);
        const me = computeTrailing(db.lookup, scoreCagrEnd,   geo, scoreRevType, activeTiers, activeLos, twMo, periods);
        revpar_cagr = calcCAGR(ms?.revpar, me?.revpar, cagrYears);
        occ_cagr    = ms?.occ != null && me?.occ != null && ms.occ > 0 ? Math.pow(me.occ / ms.occ, 1 / cagrYears) - 1 : null;
        adr_cagr    = calcCAGR(ms?.adr,    me?.adr,    cagrYears);
      }

      // Supply: sum rooms from SUPPLY for selected tiers only
      const tierKeys = scoreTier.map(t => TIER_MAP[t]).filter(Boolean);
      let rooms = null;
      if (tierKeys.length > 0) {
        const totalRooms = tierKeys.reduce((s, tk) => s + (SUPPLY[geo]?.[tk]?.rooms || 0), 0);
        rooms = totalRooms > 0 ? totalRooms : null;
      }
      if (rooms == null) rooms = SUPPLY[geo]?.["All Tier"]?.rooms || null;

      const label = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
      const mkt   = geoMeta[geo]?.market || "";
      return { geo, label, mkt, revpar, revpar_cagr, occ, occ_cagr, adr, adr_cagr, alos, rooms };
    });

    // Min-max normalization
    const minMax = (key) => {
      const vals = rawData.map(r => r[key]).filter(v => v != null && isFinite(v));
      if (!vals.length) return { min: 0, max: 1 };
      return { min: Math.min(...vals), max: Math.max(...vals) };
    };
    const normKeys = ["revpar", "revpar_cagr", "occ", "occ_cagr", "adr", "adr_cagr", "alos", "rooms"];
    const ranges = {};
    normKeys.forEach(k => { ranges[k] = minMax(k); });

    const normalize = (val, key) => {
      if (val == null || !isFinite(val)) return null;
      const { min, max } = ranges[key];
      if (max === min) return 50;
      return ((val - min) / (max - min)) * 100;
    };

    // Metric weight normalization
    const mwKeys = Object.keys(scoreMetricW);
    const mwSum = mwKeys.reduce((s, k) => s + (scoreMetricW[k] || 0), 0);
    const normMetricW = {};
    mwKeys.forEach(k => { normMetricW[k] = mwSum > 0 ? (scoreMetricW[k] || 0) / mwSum : 1 / mwKeys.length; });

    // Supply weight: direction baked into normalized score, weight = abs(scoreSupplyW)
    const supplyEffectiveW = Math.abs(scoreSupplyW);

    const scored = rawData.map(r => {
      const ns = {};
      normKeys.forEach(k => { ns[k] = normalize(r[k], k); });

      // Supply normalized score with direction baked in
      const supplyNorm = ns.rooms != null
        ? (scoreSupplyW >= 0 ? ns.rooms : 100 - ns.rooms)
        : null;

      // Composite score: 7 metric weights + optional supply weight
      let compNum = 0, compDen = 0;
      const addM = (normScore, wKey) => {
        if (normScore == null) return;
        const w = normMetricW[wKey] || 0;
        compNum += normScore * w;
        compDen += w;
      };
      addM(ns.revpar,      "revpar");
      addM(ns.revpar_cagr, "revpar_cagr");
      addM(ns.occ,         "occ");
      addM(ns.occ_cagr,    "occ_cagr");
      addM(ns.adr,         "adr");
      addM(ns.adr_cagr,    "adr_cagr");
      addM(ns.alos,        "alos");
      if (supplyEffectiveW > 0 && supplyNorm != null) {
        compNum += supplyNorm * supplyEffectiveW;
        compDen += supplyEffectiveW;
      }

      const composite = compDen > 0 ? compNum / compDen : null;

      return { ...r, ns, supplyNorm, composite };
    });

    scored.sort((a, b) => (b.composite ?? -Infinity) - (a.composite ?? -Infinity));
    return scored.map((r, i) => ({ ...r, rank: i + 1 }));
  }, [db, filteredGeos, periods, tw, lastActual, scoreRevType, scoreLos, scoreTier, scoreMetricW, scoreSupplyW, scoreCagrStart, scoreCagrEnd]);

  // ── Styles ─────────────────────────────────────────────────────────────────
  const PILL_ROW = { display:"flex", gap:3, flexWrap:"nowrap", overflowX:"auto", overflowY:"hidden", padding:"4px 6px", background:"#0a1628", border:"1px solid #1e293b", borderRadius:6, marginTop:3, height:28, alignItems:"center" };
  const sel = {
    background:"#1e293b", border:"1px solid #334155", color:"#f1f5f9",
    borderRadius:6, padding:"0 10px", height:28, fontSize:11, outline:"none", cursor:"pointer",
  };
  const btnBase = { padding:"0 12px", height:28, borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:600, display:"inline-flex", alignItems:"center", justifyContent:"center", whiteSpace:"nowrap" };
  const Btn = ({ active, onClick, children, color="#6366f1", style={} }) => (
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
  const MKT_W  = 160; // fixed width for sticky market/submarket column
  const SUB_W  = 100; // fixed width for market-label column in submarket view
  const ROOM_LEFT = geoLevel === "submarket" ? MKT_W + 2 + SUB_W + 2 : MKT_W + 2;
  const getSupply   = geo => {
    if (tiers.length === 1) return SUPPLY[geo]?.[tiers[0]] || null;
    const items = tiers.map(t => SUPPLY[geo]?.[t]).filter(Boolean);
    if (!items.length) return null;
    return { rooms: items.reduce((s, v) => s + v.rooms, 0), props: items.reduce((s, v) => s + v.props, 0) };
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ background:"#0f172a", height:"100vh", overflow:"hidden", display:"flex", flexDirection:"column", fontFamily:"'DM Sans','Segoe UI',sans-serif", color:"#e2e8f0" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* ── Header ── */}
      <div style={{ background:"#0f172a", borderBottom:"1px solid #1e293b", padding:"10px 28px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <img
            src="https://images.squarespace-cdn.com/content/v1/634ecc23e6a1eb0116ad3e64/b7f36457-07a7-4f6f-94fb-081608156032/SGHC+LogoDeck_MainWH.png"
            alt="Spark GHC"
            style={{ height:32, objectFit:"contain" }}
          />
          <div style={{ width:1, height:28, background:"#1e293b" }}/>
          <div style={{ fontSize:15, fontWeight:700, color:"#f8fafc", letterSpacing:-0.3, whiteSpace:"nowrap" }}>Ohio Hospitality Analytics — Kalibri Labs</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, background:"#3b82f611", border:"1px solid #3b82f633", borderRadius:6, padding:"4px 10px" }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:"#3b82f6" }}/>
            <span style={{ fontSize:10, color:"#3b82f6", fontFamily:"'IBM Plex Mono',monospace" }}>Kalibri Labs · Guest Paid / Hotel Collected / COPE</span>
          </div>
          <div style={{ fontSize:10, color:"#334155", fontFamily:"'IBM Plex Mono',monospace" }}>Last Actual: <span style={{ color:"#94a3b8" }}>{periodLabel(lastActual)}</span></div>
          <div style={{ width:1, height:28, background:"#1e293b" }}/>
          <div style={{ display:"flex", gap:2 }}>
            {[["overview","Overview"],["trend","Trend"],["cagr","CAGR Analysis"],["supply","Supply"],["map","Map"],["score","Score"]].map(([id, lbl]) => (
              <Btn key={id} active={tab===id} onClick={() => setTab(id)} color={id==="score"?"#10b981":"#6366f1"}>{lbl}</Btn>
            ))}
          </div>
        </div>
      </div>

      {/* ── Global Controls ── */}
      <div style={{ padding:"8px 28px", background:"#111827", borderBottom:"1px solid #1e293b", display:"flex", flexWrap:"wrap", gap:10, alignItems:"flex-end", flexShrink:0 }}>

        {/* Revenue Type */}
        {tab !== "supply" && tab !== "map" && tab !== "score" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Revenue Type</label>
          <div style={{ display:"flex", gap:2 }}>
            {REV_TYPES.map(rt => <Btn key={rt} active={revType===rt} onClick={() => setRevType(rt)} color="#6366f1">{rt}</Btn>)}
          </div>
        </div>
        )}

        {/* Hotel Class */}
        {tab !== "score" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Hotel Class</label>
          <div style={{ display:"flex", gap:2 }}>
            {TIERS.map(t => {
              const isAll = t === "All Tier";
              const active = isAll ? tiers[0] === "All Tier" : tiers.includes(t);
              const handleClick = () => {
                if (isAll) { setTiers(["All Tier"]); return; }
                setTiers(prev => {
                  const without = prev.filter(v => v !== "All Tier" && v !== t);
                  if (prev.includes(t)) return without.length ? without : ["All Tier"];
                  return [...prev.filter(v => v !== "All Tier"), t];
                });
              };
              return <Btn key={t} active={active} onClick={handleClick} color="#6366f1">{t.replace(" Tier","")}</Btn>;
            })}
          </div>
        </div>
        )}

        {/* Length of Stay */}
        {tab !== "supply" && tab !== "map" && tab !== "score" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Length of Stay</label>
          <div style={{ display:"flex", gap:2 }}>
            {LOS_OPTIONS.map(l => {
              const isOverview = l.value === "";
              const active = isOverview ? losTiers[0] === "" : losTiers.includes(l.value);
              const handleClick = () => {
                if (isOverview) { setLosTiers([""]); return; }
                setLosTiers(prev => {
                  const without = prev.filter(v => v !== "" && v !== l.value);
                  if (prev.includes(l.value)) return without.length ? without : [""];
                  return [...prev.filter(v => v !== ""), l.value];
                });
              };
              return <Btn key={l.value} active={active} onClick={handleClick} color="#6366f1">{l.label}</Btn>;
            })}
          </div>
        </div>
        )}

        {/* Aggregation disclaimer */}
        {tab !== "supply" && tab !== "map" && tab !== "score" && (tiers.length > 1 || losTiers.length > 1) && (
          <div style={{ display:"flex", alignItems:"flex-start", gap:6, background:"#1e293b", border:"1px solid #f59e0b55", borderRadius:6, padding:"6px 10px", maxWidth:420 }}>
            <span style={{ color:"#f59e0b", fontSize:13, lineHeight:1 }}>⚠</span>
            <span style={{ color:"#94a3b8", fontSize:11, lineHeight:1.4 }}>
              Multi-select aggregation is an approximation. Results use static room counts from the participation list as weights and will not exactly match <strong style={{ color:"#cbd5e1" }}>All Tier</strong> — Kalibri computes that as a single unified pool with dynamic monthly weights.
            </span>
          </div>
        )}

        {/* Time Window */}
        {tab !== "supply" && tab !== "map" && tab !== "score" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Time Window</label>
          <div style={{ display:"flex", gap:2 }}>
            {TIME_WINDOWS.map(t => (
              <Btn key={t.id} active={timeWindow===t.id} onClick={() => setTimeWindow(t.id)} color="#6366f1">{t.label}</Btn>
            ))}
          </div>
        </div>
        )}

        {/* Geography — unified across all tabs */}
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Geography</label>
          <div style={{ display:"flex", gap:2 }}>
            <Btn active={geoLevel==="market"}    onClick={() => { setGeoLevel("market"); setSelectedGeos([]); setDrillMkt(null); setExpandedGeo(null); }} color="#6366f1">Markets</Btn>
            <Btn active={geoLevel==="submarket"} onClick={() => { setGeoLevel("submarket"); setSelectedGeos([]); setDrillMkt(null); setExpandedGeo(null); }} color="#6366f1">Submarkets</Btn>
          </div>
        </div>

        {/* Period */}
        {tab === "overview" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Period</label>
          <select value={period1} onChange={e => setPeriod1(e.target.value)} style={{ ...sel, minWidth:120, ...(isForecast(period1) ? { border:"1px solid #f59e0b55", color:"#fbbf24" } : {}) }}>
            {[...filteredPeriods].reverse().map(p => (
              <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ◆" : ""}</option>
            ))}
          </select>
        </div>
        )}

        {/* Compare To (overview) */}
        {tab === "overview" && (
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            <label style={label9}>Compare To</label>
            <select value={ovStart} onChange={e => setOvStart(e.target.value)} style={{ ...sel, minWidth:130 }}>
              <option value="">Prior Year (YoY)</option>
              {[...filteredPeriods].reverse().map(p => (
                <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ◆" : ""}</option>
              ))}
            </select>
          </div>
        )}

        {/* Include Forecast (overview + cagr only; trend has its own inline toggle) */}
        {(tab === "overview" || tab === "cagr") && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <label style={label9}>Forecast</label>
          <div style={{ display:"flex", gap:2 }}>
            <Btn active={showForecast}  onClick={() => setShowForecast(true)}  color="#f59e0b">Show</Btn>
            <Btn active={!showForecast} onClick={() => setShowForecast(false)}>Hide</Btn>
          </div>
        </div>
        )}

        {/* Sort By (overview) */}
        {tab === "overview" && (
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            <label style={label9}>Sort By</label>
            <div style={{ display:"flex", gap:2 }}>
              <select value={sortKey} onChange={e => setSortKey(e.target.value)} style={{ ...sel, minWidth:130 }}>
                {METRICS.map(m => (
                  <optgroup key={m.key} label={m.label}>
                    <option value={m.key}>{m.label}</option>
                    {m.yoyKey && <option value={m.yoyKey}>{m.label} {ovStart ? "% Chg" : "YoY"}</option>}
                  </optgroup>
                ))}
              </select>
              <Btn active={true} onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")} color="#6366f1" style={{ minWidth:34 }}>
                {sortDir === "desc" ? "↓" : "↑"}
              </Btn>
            </div>
          </div>
        )}

        {/* Sort By (cagr) */}
        {tab === "cagr" && (
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            <label style={label9}>Sort By</label>
            <div style={{ display:"flex", gap:2 }}>
              <select value={cagrSortKey} onChange={e => setCagrSortKey(e.target.value)} style={{ ...sel, minWidth:130 }}>
                {CAGR_SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <Btn active={true} onClick={() => setCagrSortDir(d => d === "desc" ? "asc" : "desc")} color="#6366f1" style={{ minWidth:34 }}>
                {cagrSortDir === "desc" ? "↓" : "↑"}
              </Btn>
            </div>
          </div>
        )}

        <div style={{ flex:1 }}/>
      </div>

      {/* ── Content ── */}
      {tab !== "map" ? (
      <div style={{ padding:"16px 28px", flex:1, overflowY:"auto", minHeight:0 }}>

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
              <span style={{ color:"#10b981" }}>{tiers[0] === "All Tier" ? "All" : tiers.map(t => t.replace(" Tier","")).join(" + ")}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span style={{ color:"#8b5cf6" }}>{losTiers[0] === "" ? "All LOS" : losTiers.map(v => LOS_OPTIONS.find(l => l.value===v)?.label).join(" + ")}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span style={{ color:"#334155" }}>sorted by {METRICS.find(m => m.key===sortKey || m.yoyKey===sortKey)?.label}{sortKey.includes("_yoy") ? " YoY" : ""} {sortDir === "desc" ? "↓" : "↑"}</span>
              {isForecast(period1) && <span style={{ color:"#f59e0b", marginLeft:4, fontSize:10 }}>◆ FORECAST PERIOD</span>}
              <span style={{ flex:1 }}/>
              <button onClick={() => {
                const yoyLabel = ovStart ? `vs ${periodLabel(ovStart)}` : "YoY";
                const cols = [
                  ...(geoLevel === "submarket" ? [{ label:"Market", get: r => r.mkt }] : []),
                  { label: geoLevel === "submarket" ? "Submarket" : "Market", get: r => r.label },
                  { label:"Rooms",            get: r => getSupply(r.geo)?.rooms ?? "" },
                  { label:"Occ",              get: r => r.m.occ     != null ? (r.m.occ * 100).toFixed(1)+"%" : "" },
                  { label:`Occ ${yoyLabel}`,  get: r => r.m.occ_yoy != null ? (r.m.occ_yoy * 100).toFixed(1)+"pp" : "" },
                  { label:"ADR",              get: r => r.m.adr     != null ? r.m.adr.toFixed(2) : "" },
                  { label:`ADR ${yoyLabel}`,  get: r => r.m.adr_yoy != null ? (r.m.adr_yoy * 100).toFixed(1)+"%" : "" },
                  { label:"RevPAR",           get: r => r.m.revpar     != null ? r.m.revpar.toFixed(2) : "" },
                  { label:`RevPAR ${yoyLabel}`,get: r => r.m.revpar_yoy != null ? (r.m.revpar_yoy * 100).toFixed(1)+"%" : "" },
                  { label:"Booking Cost/RN",  get: r => r.m.booking_cost     != null ? r.m.booking_cost.toFixed(2) : "" },
                  { label:`Booking Cost ${yoyLabel}`, get: r => r.m.booking_cost_yoy != null ? (r.m.booking_cost_yoy * 100).toFixed(1)+"%" : "" },
                  { label:"ALOS",             get: r => r.m.alos     != null ? r.m.alos.toFixed(2) : "" },
                  { label:`ALOS ${yoyLabel}`, get: r => r.m.alos_yoy != null ? (r.m.alos_yoy * 100).toFixed(1)+"%" : "" },
                ];
                downloadCSV(`kalibri_overview_${period1}.csv`, overviewRows, cols);
              }} style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155" }}>↓ Export</button>
            </div>

            {/* Table — unified single table with sticky left columns */}
            <div style={{ overflowX:"auto" }}>
              <table style={{ borderCollapse:"separate", borderSpacing:0, fontSize:12, width:"100%" }}>
                <thead>
                  <tr style={{ background:"#070f1e" }}>
                    <th style={{ position:"sticky", left:0, zIndex:2, background:"#070f1e", padding:"3px 8px", width:MKT_W, minWidth:MKT_W }}/>
                    {geoLevel === "submarket" && (
                      <th style={{ position:"sticky", left:MKT_W+20, zIndex:2, background:"#070f1e", padding:"3px 8px", width:SUB_W, minWidth:SUB_W }}/>
                    )}
                    <th style={{ position:"sticky", left:geoLevel==="submarket" ? MKT_W+20+SUB_W+20 : MKT_W+20, zIndex:2, background:"#070f1e", padding:"3px 8px", width:90, minWidth:90 }}/>
                    <th colSpan={perfColSpan} style={{
                      background:"#042818", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#10b981",
                      textTransform:"uppercase", letterSpacing:1, textAlign:"center",
                      borderTop:"2px solid #10b98155", borderLeft:"1px solid #0d1526",
                    }}>
                      <div>PERFORMANCE</div>
                      <div style={{ marginTop:2, fontWeight:400, fontSize:8, fontFamily:"'IBM Plex Mono',monospace", textTransform:"none", letterSpacing:0 }}>
                        <span style={{ color:"#3b82f6" }}>{periodLabel(period1)}</span>
                        <span style={{ color:"#334155", margin:"0 4px" }}>vs</span>
                        <span style={{ color:"#64748b" }}>{ovStart ? periodLabel(ovStart) : "prior year"}</span>
                      </div>
                    </th>
                  </tr>
                  <tr style={{ background:"#0a1628", borderBottom:"2px solid #1e293b" }}>
                    <th style={{ position:"sticky", left:0, zIndex:2, background:"#0a1628", padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", width:MKT_W, minWidth:MKT_W }}>
                      {geoLevel === "submarket" ? "Submarket" : "Market"}
                    </th>
                    {geoLevel === "submarket" && (
                      <th style={{ position:"sticky", left:MKT_W+20, zIndex:2, background:"#0a1628", padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", width:SUB_W, minWidth:SUB_W }}>Market</th>
                    )}
                    <th style={{ position:"sticky", left:geoLevel==="submarket" ? MKT_W+20+SUB_W+20 : MKT_W+20, zIndex:2, background:"#0a1628", padding:"6px 8px", textAlign:"right", fontSize:9, color:"#60a5fa", fontWeight:600, whiteSpace:"nowrap", width:90, minWidth:90, borderLeft:"1px solid #1e293b" }}>Rooms</th>
                    {METRICS.map(m => m.yoyKey ? [
                      <th key={m.key+"v"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:90 }}>{m.label}</th>,
                      <th key={m.key+"c"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#64748b",  fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>{ovStart ? "% Chg" : "YoY"}</th>,
                    ] : (
                      <th key={m.key} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:60 }}>{m.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {overviewRows.length === 0 && (
                    <tr><td colSpan={(geoLevel==="submarket" ? 3 : 2) + perfColSpan} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>
                  )}
                  {overviewRows.map((row, i) => {
                    const bg = i % 2 === 0 ? "#111827" : "#0f172a";
                    const isHovered = hoveredRow === row.geo;
                    const rowBg = isHovered ? "#1e293b" : bg;
                    return (
                      <tr key={row.geo}
                        style={{ borderBottom:"1px solid #0d1526" }}
                        onMouseEnter={() => setHoveredRow(row.geo)}
                        onMouseLeave={() => setHoveredRow(null)}>
                        <td style={{ position:"sticky", left:0, zIndex:1, background:rowBg, padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap", width:MKT_W, minWidth:MKT_W, maxWidth:MKT_W, overflow:"hidden", textOverflow:"ellipsis" }}>
                          {row.label}
                        </td>
                        {geoLevel === "submarket" && (
                          <td style={{ position:"sticky", left:MKT_W+20, zIndex:1, background:rowBg, padding:"6px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap", width:SUB_W, minWidth:SUB_W, maxWidth:SUB_W, overflow:"hidden", textOverflow:"ellipsis" }}>{row.mkt}</td>
                        )}
                        <td style={{ position:"sticky", left:geoLevel==="submarket" ? MKT_W+20+SUB_W+20 : MKT_W+20, zIndex:1, background:rowBg, padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#60a5fa", whiteSpace:"nowrap", width:90, minWidth:90, borderLeft:"1px solid #1e293b" }}>
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
                      <Btn key={String(v)} active={yoyClip===v} onClick={() => setYoyClip(v)} color="#6366f1">
                        {v == null ? "None" : `±${v*100|0}%`}
                      </Btn>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Forecast</label>
                <div style={{ display:"flex", gap:2 }}>
                  <Btn active={showForecast}  onClick={() => setShowForecast(true)}  color="#f59e0b">Show</Btn>
                  <Btn active={!showForecast} onClick={() => setShowForecast(false)}>Hide</Btn>
                </div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Events</label>
                <div style={{ display:"flex", gap:2 }}>
                  <Btn active={showMarkers}  onClick={() => setShowMarkers(true)}  color="#818cf8">Show</Btn>
                  <Btn active={!showMarkers} onClick={() => setShowMarkers(false)}>Hide</Btn>
                </div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>From</label>
                <select value={trendStart} onChange={e => { setTrendStart(e.target.value); setTrendGeoSel(null); }} style={{ ...sel, minWidth:120 }}>
                  <option value="">All time</option>
                  {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ◆" : ""}</option>)}
                </select>
              </div>
              <div style={{ alignSelf:"flex-end", paddingBottom:8, color:"#334155", fontSize:14 }}>→</div>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>To</label>
                <select value={trendEnd} onChange={e => { setTrendEnd(e.target.value); setTrendGeoSel(null); }} style={{ ...sel, minWidth:120 }}>
                  <option value="">Latest</option>
                  {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{isForecast(p) ? " ◆" : ""}</option>)}
                </select>
              </div>
              <div style={{ fontSize:11, color:"#475569", alignSelf:"flex-end", paddingBottom:6 }}>
                <span style={{ color:"#94a3b8" }}>{revType}</span> · <span style={{ color:"#64748b" }}>{tw.label}</span>
              </div>
            </div>

            {/* Geo selector — compact popover */}
            <div style={{ display:"flex", gap:8, marginBottom:12, alignItems:"center" }}>
              <span style={label9}>{geoLevel === "submarket" ? "Submarkets" : "Markets"}</span>
              <div ref={trendGeoRef} style={{ position:"relative" }}>
                <button onClick={() => setTrendGeoOpen(v => !v)} style={{
                  ...btnBase, background:"#1e293b", border:"1px solid #334155", color:"#94a3b8", gap:6,
                }}>
                  {trendGeoSel ? `${trendGeoSel.length} selected` : `top 6 by ${periodLabel(trendEnd || period1) || "latest"}`}
                  {" "}<span style={{ fontSize:9 }}>{trendGeoOpen ? "▲" : "▼"}</span>
                </button>
                <Popover anchorRef={trendGeoRef} open={trendGeoOpen} minWidth={220}>
                  <div style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:8, padding:"8px 6px", minWidth:220, maxHeight:320, overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
                    {trendGeoSel && (
                      <span onClick={() => { setTrendGeoSel(null); }} style={{ color:"#3b82f6", cursor:"pointer", fontSize:10, padding:"0 4px 4px", borderBottom:"1px solid #1e293b", marginBottom:2 }}>reset to top 6</span>
                    )}
                    {filteredGeos.map((geo, i) => {
                      const lbl = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
                      const selected = trendGeoSel ? trendGeoSel.includes(geo) : trendData.top6?.includes(geo);
                      const colorIdx = (trendGeoSel ? trendGeoSel.indexOf(geo) : trendData.top6?.indexOf(geo));
                      const color = selected ? COLORS[(colorIdx >= 0 ? colorIdx : i) % COLORS.length] : "#475569";
                      return (
                        <div key={geo} onClick={() => {
                          const current = trendGeoSel || trendData.top6 || [];
                          setTrendGeoSel(current.includes(geo) ? current.filter(g => g !== geo) : [...current, geo]);
                        }} style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", padding:"4px 8px", borderRadius:4, background: selected ? "#1e293b" : "transparent" }}>
                          <div style={{ width:8, height:8, borderRadius:2, background: selected ? color : "#1e293b", flexShrink:0 }}/>
                          <span style={{ fontSize:11, color: selected ? "#cbd5e1" : "#475569", flex:1 }}>{lbl}</span>
                          {selected && <span style={{ color, fontSize:10 }}>✓</span>}
                        </div>
                      );
                    })}
                  </div>
                </Popover>
              </div>
              {/* active geo color swatches */}
              {(trendGeoSel || trendData.top6)?.slice(0, 6).map((geo, i) => {
                const lbl = geoMeta[geo]?.submarket || geoMeta[geo]?.market || geo;
                return (
                  <div key={geo} style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <div style={{ width:8, height:8, borderRadius:2, background:COLORS[i % COLORS.length], flexShrink:0 }}/>
                    <span style={{ fontSize:10, color:"#94a3b8" }}>{lbl}</span>
                  </div>
                );
              })}
              {showForecast && (
                <div style={{ display:"flex", alignItems:"center", gap:5, background:"#f59e0b11", border:"1px solid #f59e0b33", borderRadius:4, padding:"3px 10px", marginLeft:4 }}>
                  <div style={{ width:8, height:8, borderRadius:2, background:"#f59e0b44", border:"1px dashed #f59e0b" }}/>
                  <span style={{ fontSize:10, color:"#f59e0b" }}>Forecast</span>
                </div>
              )}
            </div>

            <ResponsiveContainer width="100%" height={600}>
              <LineChart data={trendData.chartData} margin={{ top:30, right:30, bottom:80, left:20 }}>
                {showForecast && forecastStartLabel && (
                  <ReferenceArea x1={forecastStartLabel} fill="#f59e0b" fillOpacity={0.04}/>
                )}
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                <XAxis dataKey="period" tick={{ fill:"#94a3b8", fontSize:10 }} angle={-45} textAnchor="end" height={70} interval={Math.max(0, Math.floor(trendData.chartData?.length / 20) - 1)}/>
                <YAxis
                  tick={{ fill:"#94a3b8", fontSize:10 }}
                  tickFormatter={TREND_METRICS.find(m => m.key === trendMetric)?.tickFmt}
                  domain={["auto","auto"]}
                  width={60}
                />
                <Tooltip content={<CustomTooltip lastActual={lastActual} metricKey={trendMetric}/>}/>
                {showForecast && forecastStartLabel && (
                  <ReferenceLine x={forecastStartLabel} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={1.5}
                    label={{ value:"Forecast →", fill:"#f59e0b", fontSize:9, position:"top" }}/>
                )}
                {showMarkers && [
                  { x:"Mar - 2020", label:"COVID-19",           color:"#ef4444" },
                  { x:"Jun - 2021", label:"Hotels Reopen",      color:"#22c55e" },
                  { x:"Mar - 2022", label:"Fed Rate Hikes",     color:"#f59e0b" },
                  { x:"Jul - 2022", label:"Revenge Travel Peak",color:"#a78bfa" },
                  { x:"Jan - 2023", label:"Record ADR",         color:"#38bdf8" },
                ].map(ev => (
                  <ReferenceLine key={ev.x} x={ev.x} stroke={ev.color+"99"} strokeDasharray="4 4" strokeWidth={1.5}
                    label={{ value:ev.label, fill:ev.color, fontSize:9, position:"insideTopRight" }}/>
                ))}
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
              <div style={{ fontSize:11, color:"#475569", alignSelf:"flex-end", paddingBottom:6 }}>
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
              <div style={{ display:"flex", flexDirection:"column", gap:3, justifyContent:"flex-end" }}>
                <button onClick={() => {
                  const cols = [
                    ...(geoLevel === "submarket" ? [{ label:"Market", get: r => r.mkt }] : []),
                    { label: geoLevel === "submarket" ? "Submarket" : "Market", get: r => r.label },
                    { label:`Occ (${periodLabel(cagrStart)})`,    get: r => r.ms_occ    != null ? (r.ms_occ * 100).toFixed(1)+"%" : "" },
                    { label:`Occ (${periodLabel(cagrEnd)})`,      get: r => r.me_occ    != null ? (r.me_occ * 100).toFixed(1)+"%" : "" },
                    { label:"Occ Delta (pp)",                     get: r => r.occ_delta != null ? (r.occ_delta * 100).toFixed(1) : "" },
                    { label:`ADR (${periodLabel(cagrStart)})`,    get: r => r.ms_adr    != null ? r.ms_adr.toFixed(2) : "" },
                    { label:`ADR (${periodLabel(cagrEnd)})`,      get: r => r.me_adr    != null ? r.me_adr.toFixed(2) : "" },
                    { label:"ADR CAGR",                           get: r => r.adr_cagr  != null ? (r.adr_cagr * 100).toFixed(2)+"%" : "" },
                    { label:`RevPAR (${periodLabel(cagrStart)})`, get: r => r.ms_revpar != null ? r.ms_revpar.toFixed(2) : "" },
                    { label:`RevPAR (${periodLabel(cagrEnd)})`,   get: r => r.me_revpar != null ? r.me_revpar.toFixed(2) : "" },
                    { label:"RevPAR CAGR",                        get: r => r.revpar_cagr != null ? (r.revpar_cagr * 100).toFixed(2)+"%" : "" },
                  ];
                  downloadCSV(`kalibri_cagr_${cagrStart}_to_${cagrEnd}.csv`, cagrRows, cols);
                }} style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155" }}>↓ Export</button>
              </div>
            </div>

            {/* Bar chart */}
            {cagrRows.length > 0 && (
              <div style={{ marginBottom:2 }}>
                <div style={{ fontSize:10, color:"#475569", marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>
                  {CAGR_SORT_OPTIONS.find(o => o.key === cagrChartMetric)?.label} · Top {Math.min(cagrRows.length, 20)} geographies · sorted by {CAGR_SORT_OPTIONS.find(o => o.key === cagrSortKey)?.label}
                </div>
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={cagrRows.slice(0, 20)} margin={{ top:10, right:30, bottom:60, left:20 }}>
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
              <table style={{ width:"100%", borderCollapse:"separate", borderSpacing:0, fontSize:12 }}>
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
                    <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap" }}>{geoLevel === "submarket" ? "Submarket" : "Market"}</th>
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
                        <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.revpar_cagr), fontWeight:600 }}>{fmt.pct(row.revpar_cagr)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ════ SUPPLY ════ */}
        {tab === "supply" && (
          <div>
            {/* Supply tab controls */}
            <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:14, alignItems:"flex-end" }}>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Filter</label>
                <Btn active={extStayOnly} onClick={() => { setExtStayOnly(v => !v); setSupplyFilterBrand([]); }} color="#8b5cf6">Extended Stay</Btn>
              </div>
              {/* Parent Company dropdown */}
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Parent Company {supplyFilterCompany.length > 0 && <span style={{ color:"#475569" }}>· {supplyFilterCompany.length}</span>}{supplyFilterCompany.length > 0 && <span onClick={() => { setSupplyFilterCompany([]); setSupplyFilterBrand([]); }} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}</label>
                <div ref={supplyCompanyRef} style={{ position:"relative" }}>
                  <Btn active={supplyFilterCompany.length > 0 || supplyCompanyOpen} onClick={() => setSupplyCompanyOpen(v => !v)} color="#f97316" style={{ display:"flex", alignItems:"center", gap:4 }}>
                    {supplyFilterCompany.length > 0 ? `${supplyFilterCompany.length} selected` : "All"} <span style={{ fontSize:9 }}>{supplyCompanyOpen ? "▲" : "▼"}</span>
                  </Btn>
                  <Popover anchorRef={supplyCompanyRef} open={supplyCompanyOpen} minWidth={220}>
                    <div style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:8, padding:"8px 6px", minWidth:220, maxHeight:300, overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
                      {supplyFilterCompany.length > 0 && <span onClick={() => { setSupplyFilterCompany([]); setSupplyFilterBrand([]); }} style={{ color:"#3b82f6", cursor:"pointer", fontSize:10, padding:"0 4px 4px", borderBottom:"1px solid #1e293b", marginBottom:2 }}>clear all</span>}
                      {supplyCompanies.map(c => (
                        <div key={c} onClick={() => { setSupplyFilterCompany(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]); setSupplyFilterBrand([]); }}
                          style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", padding:"4px 8px", borderRadius:4, background: supplyFilterCompany.includes(c) ? "#f9731622" : "transparent" }}>
                          <div style={{ width:8, height:8, borderRadius:"50%", background: supplyFilterCompany.includes(c) ? "#f97316" : "#334155", flexShrink:0 }}/>
                          <span style={{ fontSize:11, color: supplyFilterCompany.includes(c) ? "#fed7aa" : "#94a3b8", flex:1 }}>{c}</span>
                          {supplyFilterCompany.includes(c) && <span style={{ color:"#f97316", fontSize:10 }}>✓</span>}
                        </div>
                      ))}
                    </div>
                  </Popover>
                </div>
              </div>

              {/* Brand dropdown */}
              {(supplyFilterCompany.length > 0 || extStayOnly) && supplyVisibleBrands.length > 0 && (
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Brand {supplyFilterBrand.length > 0 && <span style={{ color:"#475569" }}>· {supplyFilterBrand.length}</span>}{supplyFilterBrand.length > 0 && <span onClick={() => setSupplyFilterBrand([])} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}</label>
                  <div ref={supplyBrandRef} style={{ position:"relative" }}>
                    <Btn active={supplyFilterBrand.length > 0 || supplyBrandOpen} onClick={() => setSupplyBrandOpen(v => !v)} color="#6366f1" style={{ display:"flex", alignItems:"center", gap:4 }}>
                      {supplyFilterBrand.length > 0 ? `${supplyFilterBrand.length} selected` : `all ${supplyVisibleBrands.length}`} <span style={{ fontSize:9 }}>{supplyBrandOpen ? "▲" : "▼"}</span>
                    </Btn>
                    <Popover anchorRef={supplyBrandRef} open={supplyBrandOpen} minWidth={200}>
                      <div style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:8, padding:"8px 6px", minWidth:200, maxHeight:300, overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
                        {supplyFilterBrand.length > 0 && <span onClick={() => setSupplyFilterBrand([])} style={{ color:"#3b82f6", cursor:"pointer", fontSize:10, padding:"0 4px 4px", borderBottom:"1px solid #1e293b", marginBottom:2 }}>clear all</span>}
                        {supplyVisibleBrands.map(b => (
                          <div key={b} onClick={() => setSupplyFilterBrand(prev => prev.includes(b) ? prev.filter(x => x !== b) : [...prev, b])}
                            style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", padding:"4px 8px", borderRadius:4, background: supplyFilterBrand.includes(b) ? "#6366f122" : "transparent" }}>
                            <div style={{ width:8, height:8, borderRadius:"50%", background: supplyFilterBrand.includes(b) ? "#6366f1" : "#334155", flexShrink:0 }}/>
                            <span style={{ fontSize:11, color: supplyFilterBrand.includes(b) ? "#c7d2fe" : "#94a3b8", flex:1 }}>{b}</span>
                            {supplyFilterBrand.includes(b) && <span style={{ color:"#6366f1", fontSize:10 }}>✓</span>}
                          </div>
                        ))}
                      </div>
                    </Popover>
                  </div>
                </div>
              )}
            </div>
            <div style={{ fontSize:10, color:"#334155", marginBottom:10, fontFamily:"'IBM Plex Mono',monospace", display:"flex", gap:6, alignItems:"center" }}>
              <span style={{ color:"#60a5fa", fontWeight:600 }}>{supplyRows.length} {geoLevel === "market" ? "markets" : "submarkets"}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span style={{ color:"#10b981" }}>{tiers[0] === "All Tier" ? "All Classes" : tiers.map(t => t.replace(" Tier","")).join(" + ")}</span>
              <span style={{ color:"#1a2540" }}>·</span>
              <span style={{ color:"#475569" }}>Click a row to drill into brands</span>
            </div>

            <div style={{ overflowX:"auto" }}>
              <table style={{ borderCollapse:"separate", borderSpacing:0, width:"100%", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#070f1e" }}>
                    <th colSpan={geoLevel === "submarket" ? 2 : 1} style={{ background:"#070f1e", padding:"4px 0" }}/>
                    <th colSpan={4} style={{ background:"#0c1a2e", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#3b82f6", textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:"2px solid #3b82f655", borderLeft:"1px solid #0d1526" }}>
                      Supply — Active Properties
                    </th>
                  </tr>
                  {(() => {
                    const SortTh = ({ sk, color, children, style={} }) => {
                      const active = supplySortKey === sk;
                      return (
                        <th onClick={() => { if (active) setSupplySortDir(d => d === "desc" ? "asc" : "desc"); else { setSupplySortKey(sk); setSupplySortDir("desc"); } }}
                          style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color: active ? color : "#475569", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:100, cursor:"pointer", userSelect:"none", ...style }}>
                          {children} {active ? (supplySortDir === "desc" ? "↓" : "↑") : ""}
                        </th>
                      );
                    };
                    return (
                      <tr style={{ background:"#0a1628", borderBottom:"2px solid #1e293b" }}>
                        <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:160 }}>
                          {geoLevel === "submarket" ? "Submarket" : "Market"}
                        </th>
                        {geoLevel === "submarket" && (
                          <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:100 }}>Market</th>
                        )}
                        <SortTh sk="rooms" color="#60a5fa" style={{ minWidth:90 }}>Total Rooms (Props)</SortTh>
                        <SortTh sk="lower" color="#f87171">Lower Tier</SortTh>
                        <SortTh sk="mid"   color="#fbbf24">Mid Tier</SortTh>
                        <SortTh sk="upper" color="#34d399">Upper Tier</SortTh>
                      </tr>
                    );
                  })()}
                </thead>
                <tbody>
                  {supplyRows.map((row, i) => {
                    const bg = i % 2 === 0 ? "#111827" : "#0f172a";
                    const isExp = expandedGeo === row.geo;
                    const lower = row.tiers["Lower Tier"] || { rooms:0, props:0 };
                    const mid   = row.tiers["Mid Tier"]   || { rooms:0, props:0 };
                    const upper = row.tiers["Upper Tier"] || { rooms:0, props:0 };
                    return (
                      <React.Fragment key={row.geo}>
                        <tr
                          style={{ borderBottom:"1px solid #0d1526", background: isExp ? "#1e3a5f" : bg, cursor:"pointer" }}
                          onClick={() => { setExpandedGeo(isExp ? null : row.geo); setExpandedTier("All Tier"); }}
                          onMouseEnter={e => { if (!isExp) e.currentTarget.style.background="#1e293b"; }}
                          onMouseLeave={e => { if (!isExp) e.currentTarget.style.background=bg; }}>
                          <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap" }}>
                            <span style={{ marginRight:6, color: isExp ? "#f59e0b" : "#475569", fontSize:10 }}>{isExp ? "▼" : "▶"}</span>
                            {row.label}
                          </td>
                          {geoLevel === "submarket" && (
                            <td style={{ padding:"6px 10px", color:"#475569", fontSize:10 }}>{row.mkt}</td>
                          )}
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#60a5fa", fontWeight:600, borderLeft:"1px solid #0d1526" }}>
                            {row.rooms.toLocaleString()} <span style={{ color:"#334155", fontSize:9 }}>/ {row.props} props</span>
                          </td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#f87171", borderLeft:"1px solid #0d1526" }}>
                            {lower.rooms > 0 ? <>{lower.rooms.toLocaleString()} <span style={{ color:"#334155", fontSize:9 }}>/ {lower.props}</span></> : "—"}
                          </td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#fbbf24", borderLeft:"1px solid #0d1526" }}>
                            {mid.rooms > 0 ? <>{mid.rooms.toLocaleString()} <span style={{ color:"#334155", fontSize:9 }}>/ {mid.props}</span></> : "—"}
                          </td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#34d399", borderLeft:"1px solid #0d1526" }}>
                            {upper.rooms > 0 ? <>{upper.rooms.toLocaleString()} <span style={{ color:"#334155", fontSize:9 }}>/ {upper.props}</span></> : "—"}
                          </td>
                        </tr>
                        {isExp && (
                          <tr key={row.geo+"_exp"}>
                            <td colSpan={geoLevel === "submarket" ? 6 : 5} style={{ padding:0, background:"#0a1628", borderBottom:"2px solid #334155" }}>
                              <div style={{ padding:"12px 20px" }}>
                                <div style={{ marginBottom:10, fontSize:10, color:"#475569" }}>
                                  {supplyBrands.length} brands · {supplyBrands.reduce((s,b)=>s+b.rooms,0).toLocaleString()} rooms
                                </div>
                                <table style={{ borderCollapse:"separate", borderSpacing:0, width:"100%", fontSize:11 }}>
                                  <thead>
                                    <tr style={{ background:"#070f1e" }}>
                                      <th style={{ padding:"5px 8px", textAlign:"left", fontSize:9, color:"#3b82f6", fontWeight:600, minWidth:160 }}>Brand</th>
                                      <th style={{ padding:"5px 8px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:140 }}>Parent Company</th>
                                      <th style={{ padding:"5px 8px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:90 }}>Class</th>
                                      <th style={{ padding:"5px 8px", textAlign:"right", fontSize:9, color:"#60a5fa", fontWeight:600, minWidth:70 }}>Rooms</th>
                                      <th style={{ padding:"5px 8px", textAlign:"right", fontSize:9, color:"#475569", fontWeight:600, minWidth:70 }}>Properties</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {supplyBrands.map((b, j) => (
                                      <tr key={b.brand+j} style={{ background: j%2===0 ? "#0f172a" : "#111827" }}>
                                        <td style={{ padding:"5px 8px", color:"#f1f5f9", fontWeight:500 }}>{b.brand}</td>
                                        <td style={{ padding:"5px 8px", color:"#64748b", fontSize:10 }}>{b.company}</td>
                                        <td style={{ padding:"5px 8px" }}>
                                          <span style={{ fontSize:9, padding:"1px 6px", borderRadius:3, fontWeight:600,
                                            background: b.tier==="Upper Tier"?"#34d39922":b.tier==="Mid Tier"?"#fbbf2422":"#f8717122",
                                            color:      b.tier==="Upper Tier"?"#34d399"  :b.tier==="Mid Tier"?"#fbbf24"  :"#f87171"
                                          }}>{b.tier.replace(" Tier","")}</span>
                                        </td>
                                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#60a5fa" }}>{b.rooms.toLocaleString()}</td>
                                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#94a3b8" }}>{b.props}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ════ SCORE ════ */}
        {tab === "score" && (
          <div>
            {/* Score controls */}
            <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
              {/* Revenue Type */}
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Revenue Type</label>
                <div style={{ display:"flex", gap:2 }}>
                  {REV_TYPES.map(rt => <Btn key={rt} active={scoreRevType===rt} onClick={() => setScoreRevType(rt)} color="#10b981">{rt}</Btn>)}
                </div>
              </div>
              {/* CAGR Period */}
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>CAGR From</label>
                <select value={scoreCagrStart} onChange={e => setScoreCagrStart(e.target.value)} style={{ ...sel, minWidth:120 }}>
                  {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                </select>
              </div>
              <div style={{ alignSelf:"flex-end", paddingBottom:8, color:"#334155", fontSize:14 }}>→</div>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>CAGR To</label>
                <select value={scoreCagrEnd} onChange={e => setScoreCagrEnd(e.target.value)} style={{ ...sel, minWidth:120 }}>
                  {[...filteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                </select>
              </div>
              {scoreCagrStart && scoreCagrEnd && scoreCagrEnd > scoreCagrStart && (
                <div style={{ fontSize:11, color:"#475569", alignSelf:"flex-end", paddingBottom:6 }}>
                  {(() => {
                    const [sy, sm] = scoreCagrStart.split("-"), [ey, em] = scoreCagrEnd.split("-");
                    const y = (parseInt(ey) - parseInt(sy)) + (parseInt(em) - parseInt(sm)) / 12;
                    return y.toFixed(1) + "-yr CAGR window";
                  })()}
                </div>
              )}
            </div>

            {/* Slider Groups */}
            {(() => {
              const SliderGroup = ({ title, items, onReset, children }) => (
                <div style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:8, padding:"10px 14px", marginBottom:10 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                    <span style={{ fontSize:10, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", letterSpacing:1 }}>{title}</span>
                    <button onClick={onReset} style={{ ...btnBase, height:22, padding:"0 8px", fontSize:9, background:"#0f172a", color:"#475569", border:"1px solid #334155" }}>Reset equal</button>
                  </div>
                  <div style={{ display:"flex", gap:12, flexWrap:"nowrap", overflowX:"auto" }}>
                    {children}
                  </div>
                </div>
              );
              const Slider = ({ label, value, min, max, step, onChange, isCenter }) => (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", minWidth:90, maxWidth:110 }}>
                  <span style={{ fontSize:10, color:"#94a3b8", marginBottom:4, textAlign:"center", lineHeight:1.2, whiteSpace:"nowrap" }}>{label}</span>
                  {isCenter && (
                    <div style={{ width:"100%", position:"relative", height:4, marginBottom:2 }}>
                      <div style={{ position:"absolute", left:"50%", transform:"translateX(-50%)", width:1, height:8, background:"#475569", top:-2 }}/>
                    </div>
                  )}
                  <input type="range" min={min} max={max} step={step} value={value}
                    onChange={e => onChange(parseFloat(e.target.value))}
                    style={{ width:"100%", accentColor:"#10b981", cursor:"pointer" }}
                  />
                  <span style={{ fontSize:10, color:"#10b981", marginTop:2, fontFamily:"'IBM Plex Mono',monospace", fontWeight:600 }}>
                    {isCenter ? (value > 0 ? "+" + value : value) : value.toFixed(1)}
                  </span>
                </div>
              );

              return (
                <div>
                  {/* Length of Stay filter toggles */}
                  <div style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:8, padding:"10px 14px", marginBottom:10 }}>
                    <span style={{ fontSize:10, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:8 }}>Length of Stay</span>
                    <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                      {LOS_OPTIONS.map(l => {
                        const isOverview = l.value === "";
                        const active = isOverview ? scoreLos[0] === "" : scoreLos.includes(l.value);
                        const handleClick = () => {
                          if (isOverview) { setScoreLos([""]); return; }
                          setScoreLos(prev => {
                            const without = prev.filter(v => v !== "" && v !== l.value);
                            if (prev.includes(l.value)) return without.length ? without : [""];
                            return [...prev.filter(v => v !== ""), l.value];
                          });
                        };
                        return <Btn key={l.value} active={active} onClick={handleClick} color="#10b981">{l.label}</Btn>;
                      })}
                    </div>
                  </div>

                  {/* Hotel Class filter toggles */}
                  <div style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:8, padding:"10px 14px", marginBottom:10 }}>
                    <span style={{ fontSize:10, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:8 }}>Hotel Class</span>
                    <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                      {[["Lower","Lower Tier"],["Mid","Mid Tier"],["Upper","Upper Tier"]].map(([id, lbl]) => {
                        const active = scoreTier.includes(id);
                        const handleClick = () => {
                          setScoreTier(prev => {
                            if (prev.includes(id)) {
                              const without = prev.filter(v => v !== id);
                              return without.length ? without : [id]; // prevent empty
                            }
                            return [...prev, id];
                          });
                        };
                        return <Btn key={id} active={active} onClick={handleClick} color="#10b981">{lbl}</Btn>;
                      })}
                    </div>
                  </div>

                  {/* Metric Weights */}
                  <SliderGroup title="Metric Weights" onReset={() => setScoreMetricW({ revpar:1,revpar_cagr:1,occ:1,occ_cagr:1,adr:1,adr_cagr:1,alos:1 })}>
                    {[["revpar","RevPAR Level"],["revpar_cagr","RevPAR CAGR"],["occ","Occ Level"],["occ_cagr","Occ CAGR"],["adr","ADR Level"],["adr_cagr","ADR CAGR"],["alos","ALOS"]].map(([k, lbl]) => (
                      <Slider key={k} label={lbl} value={scoreMetricW[k] ?? 1} min={0} max={10} step={0.1}
                        onChange={v => setScoreMetricW(prev => ({ ...prev, [k]: v }))} />
                    ))}
                  </SliderGroup>

                  {/* Supply */}
                  <SliderGroup title="Supply" onReset={() => setScoreSupplyW(0)}>
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", minWidth:260, maxWidth:320 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", width:"100%", marginBottom:2 }}>
                        <span style={{ fontSize:9, color:"#64748b" }}>Favor Low Supply<br/><span style={{ fontSize:8, color:"#475569" }}>(development opportunity)</span></span>
                        <span style={{ fontSize:9, color:"#64748b", textAlign:"right" }}>Favor High Supply<br/><span style={{ fontSize:8, color:"#475569" }}>(proven market)</span></span>
                      </div>
                      <div style={{ width:"100%", position:"relative" }}>
                        <div style={{ position:"absolute", left:"50%", transform:"translateX(-50%)", width:1, height:"100%", background:"#334155", top:0, pointerEvents:"none" }}/>
                        <input type="range" min={-10} max={10} step={0.5} value={scoreSupplyW}
                          onChange={e => setScoreSupplyW(parseFloat(e.target.value))}
                          style={{ width:"100%", accentColor:"#10b981", cursor:"pointer" }}
                        />
                      </div>
                      <span style={{ fontSize:10, color:"#10b981", fontFamily:"'IBM Plex Mono',monospace", fontWeight:600, marginTop:2 }}>
                        Supply Weight: {scoreSupplyW > 0 ? "+" + scoreSupplyW : scoreSupplyW === 0 ? "0 (neutral)" : scoreSupplyW}
                      </span>
                    </div>
                  </SliderGroup>
                </div>
              );
            })()}

            {/* Bar chart */}
            {scoreRows.length > 0 && (
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:10, color:"#475569", marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>
                  Composite Score · {scoreRows.length} {geoLevel === "market" ? "markets" : "submarkets"} · {scoreRevType}
                </div>
                <ResponsiveContainer width="100%" height={Math.min(500, scoreRows.length * 16 + 40)}>
                  <BarChart data={scoreRows} layout="vertical" margin={{ top:4, right:60, bottom:4, left:220 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false}/>
                    <XAxis type="number" domain={[0, 100]} tick={{ fill:"#475569", fontSize:9 }} tickFormatter={v => v.toFixed(0)}/>
                    <YAxis type="category" dataKey="label" tick={{ fill:"#94a3b8", fontSize:10 }} width={215}/>
                    <Tooltip
                      contentStyle={{ background:"#1e293b", border:"1px solid #334155", borderRadius:6, fontSize:11 }}
                      formatter={(v) => [v != null ? v.toFixed(1) : "—", "Score"]}
                      labelStyle={{ color:"#94a3b8" }}
                    />
                    <Bar dataKey="composite" radius={[0,3,3,0]} barSize={8}>
                      {scoreRows.map((row, i) => (
                        <Cell key={i} fill={i < 5 ? "#10b981" : "#3b82f6"}/>
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Score table */}
            <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:6 }}>
              <button onClick={() => {
                const headers = ["Rank", geoLevel==="submarket"?"Submarket":"Market", ...(geoLevel==="submarket"?["Market"]:[]), "RevPAR","RevPAR CAGR","Occ","Occ CAGR","ADR","ADR CAGR","ALOS","Rooms","Score"];
                const rows = scoreRows.map(r => [r.rank, r.label, ...(geoLevel==="submarket"?[geoMeta[r.geo]?.market||""]:[]), r.revpar?.toFixed(2)??"", r.revpar_cagr!=null?(r.revpar_cagr*100).toFixed(1)+"%":"", r.occ!=null?(r.occ*100).toFixed(1)+"%":"", r.occ_cagr!=null?(r.occ_cagr*100).toFixed(1)+"%":"", r.adr?.toFixed(2)??"", r.adr_cagr!=null?(r.adr_cagr*100).toFixed(1)+"%":"", r.alos?.toFixed(2)??"", r.rooms??"", r.composite?.toFixed(1)??""]);
                const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
                const a = document.createElement("a"); a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv); a.download = "score_ranking.csv"; a.click();
              }} style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155" }}>↓ Export CSV</button>
            </div>
            <div style={{ overflowX:"auto" }}>
              <table style={{ borderCollapse:"separate", borderSpacing:0, fontSize:11, width:"100%" }}>
                <thead>
                  <tr style={{ background:"#070f1e" }}>
                    <th colSpan={geoLevel === "submarket" ? 3 : 2} style={{ background:"#070f1e", padding:"4px 0" }}/>
                    <th colSpan={8} style={{ background:"#042818", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#10b981", textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:"2px solid #10b98155", borderLeft:"1px solid #0d1526" }}>
                      Blended Metrics
                    </th>
                    <th colSpan={8} style={{ background:"#0c1a2e", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#3b82f6", textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:"2px solid #3b82f655", borderLeft:"1px solid #0d1526" }}>
                      Normalized Scores (0–100)
                    </th>
                  </tr>
                  <tr style={{ background:"#0a1628", borderBottom:"2px solid #1e293b" }}>
                    <th style={{ padding:"6px 8px", textAlign:"center", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", minWidth:36 }}>#</th>
                    <th style={{ padding:"6px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", minWidth:140 }}>{geoLevel === "submarket" ? "Submarket" : "Market"}</th>
                    {geoLevel === "submarket" && <th style={{ padding:"6px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", minWidth:100 }}>Market</th>}
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:75 }}>RevPAR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", minWidth:75 }}>RevPAR CAGR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>Occ</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", minWidth:70 }}>Occ CAGR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>ADR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", minWidth:70 }}>ADR CAGR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", minWidth:50 }}>ALOS</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#60a5fa", fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>Rooms</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:50 }}>RevPAR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>Rev CAGR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", minWidth:40 }}>Occ</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", minWidth:55 }}>Occ CAGR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", minWidth:40 }}>ADR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", minWidth:55 }}>ADR CAGR</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", minWidth:40 }}>ALOS</th>
                    <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:700, whiteSpace:"nowrap", borderLeft:"2px solid #10b98155", minWidth:80 }}>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {scoreRows.length === 0 && (
                    <tr><td colSpan={21} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>
                  )}
                  {scoreRows.map((row, i) => {
                    const isTop5 = i < 5;
                    const bg = isTop5 ? (i % 2 === 0 ? "#052e16" : "#073820") : (i % 2 === 0 ? "#111827" : "#0f172a");
                    const ns = row.ns || {};
                    const scoreVal = row.composite;
                    const scoreBarW = scoreVal != null ? Math.max(0, Math.min(100, scoreVal)) : 0;
                    const scoreColor = isTop5 ? "#10b981" : "#3b82f6";
                    const fmtNorm = v => v != null ? v.toFixed(1) : "—";
                    return (
                      <tr key={row.geo} style={{ borderBottom:"1px solid #0d1526", background:bg }}
                        onMouseEnter={e => e.currentTarget.style.background = isTop5 ? "#0a4a24" : "#1e293b"}
                        onMouseLeave={e => e.currentTarget.style.background = bg}>
                        <td style={{ padding:"5px 8px", textAlign:"center", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color: isTop5 ? "#10b981" : "#475569", fontWeight: isTop5 ? 700 : 400 }}>
                          {row.rank}
                        </td>
                        <td style={{ padding:"5px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis" }}>
                          {row.label}
                        </td>
                        {geoLevel === "submarket" && (
                          <td style={{ padding:"5px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap" }}>{row.mkt}</td>
                        )}
                        {/* Blended metrics */}
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#cbd5e1", borderLeft:"1px solid #0d1526" }}>{row.revpar != null ? "$"+row.revpar.toFixed(2) : "—"}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color: row.revpar_cagr != null ? (row.revpar_cagr >= 0 ? "#4ade80" : "#f87171") : "#475569" }}>{row.revpar_cagr != null ? (row.revpar_cagr >= 0 ? "+" : "") + (row.revpar_cagr * 100).toFixed(1) + "%" : "—"}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#cbd5e1" }}>{row.occ != null ? (row.occ * 100).toFixed(1)+"%" : "—"}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color: row.occ_cagr != null ? (row.occ_cagr >= 0 ? "#4ade80" : "#f87171") : "#475569" }}>{row.occ_cagr != null ? (row.occ_cagr >= 0 ? "+" : "") + (row.occ_cagr * 100).toFixed(1) + "%" : "—"}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#cbd5e1" }}>{row.adr != null ? "$"+row.adr.toFixed(2) : "—"}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color: row.adr_cagr != null ? (row.adr_cagr >= 0 ? "#4ade80" : "#f87171") : "#475569" }}>{row.adr_cagr != null ? (row.adr_cagr >= 0 ? "+" : "") + (row.adr_cagr * 100).toFixed(1) + "%" : "—"}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#94a3b8" }}>{row.alos != null ? row.alos.toFixed(2) : "—"}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#60a5fa" }}>{row.rooms != null ? Math.round(row.rooms).toLocaleString() : "—"}</td>
                        {/* Normalized scores */}
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmtNorm(ns.revpar)}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#64748b" }}>{fmtNorm(ns.revpar_cagr)}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#64748b" }}>{fmtNorm(ns.occ)}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#64748b" }}>{fmtNorm(ns.occ_cagr)}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#64748b" }}>{fmtNorm(ns.adr)}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#64748b" }}>{fmtNorm(ns.adr_cagr)}</td>
                        <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#64748b" }}>{fmtNorm(ns.alos)}</td>
                        {/* Composite score */}
                        <td style={{ padding:"5px 8px", borderLeft:`2px solid ${scoreColor}55`, minWidth:80 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                            <div style={{ flex:1, height:10, background:"#1e293b", borderRadius:3, overflow:"hidden", minWidth:40 }}>
                              <div style={{ height:"100%", width: scoreBarW + "%", background: scoreColor, borderRadius:3, transition:"width 0.2s" }}/>
                            </div>
                            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, fontWeight:700, color: scoreColor, minWidth:32, textAlign:"right" }}>
                              {scoreVal != null ? scoreVal.toFixed(1) : "—"}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
      ) : (() => {
        // ════ MAP ════
        const companies = [...new Set(supplyData.map(r => r.Company))].filter(Boolean).sort();
        const brandsForCompany = supplyData
          .filter(r => (mapCompanies.length === 0 || mapCompanies.includes(r.Company)) && (!mapExtStay || EXTENDED_STAY_BRANDS.has(r.Brand)))
          .reduce((s, r) => { s.add(r.Brand); return s; }, new Set());
        const visibleBrands = [...brandsForCompany].sort();
        const toggleGeo = key => setSelectedGeos(prev => prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]);
        const CC_STATUSES_ALL = ["Conceptual","Design","Final Planning","GC Bidding","Sub-Bidding","Pre-Construction/Negotiated","Award","Post-Bid","Bid Results","Under Construction"];
        const CC_STATUS_COLOR = { "Conceptual":"#64748b","Design":"#3b82f6","Final Planning":"#8b5cf6","GC Bidding":"#f59e0b","Sub-Bidding":"#f59e0b","Pre-Construction/Negotiated":"#f97316","Award":"#10b981","Post-Bid":"#10b981","Bid Results":"#10b981","Under Construction":"#22c55e" };
        return (
          <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0 }}>
            {/* ── Filter panel: scrollable left + fixed CC right ── */}
            <div style={{ display:"flex", alignItems:"flex-start", borderBottom:"1px solid #1e293b", flexShrink:0 }}>
            {/* Scrollable section */}
            <div style={{ display:"flex", gap:10, padding:"6px 16px", alignItems:"flex-start", overflowX:"auto", flexWrap:"nowrap", flex:1, minWidth:0 }}>

              {/* Supply disclaimer */}
              <div style={{ display:"flex", flexDirection:"column", justifyContent:"center", flexShrink:0 }}>
                <span style={{ fontSize:10, color:"#64748b", fontStyle:"italic" }}>Supply pins limited to Kalibri participation list</span>
              </div>

              {/* View + Ext Stay */}
              <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0 }}>
                <label style={label9}>View</label>
                <div style={{ display:"flex", gap:2 }}>
                  <Btn active={mapMode==="bubbles"} onClick={() => setMapMode("bubbles")} color="#6366f1">Bubbles</Btn>
                  <Btn active={mapMode==="pins"}    onClick={() => setMapMode("pins")} color="#6366f1">Pins</Btn>
                  {mapMode === "pins" && <Btn active={mapExtStay} onClick={() => { setMapExtStay(v => !v); setMapBrands([]); }} color="#8b5cf6">Ext. Stay</Btn>}
                </div>
              </div>

              {/* Market / Submarket pills — two-step drill-down */}
              <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0, minWidth:260, maxWidth:420, borderLeft:"1px solid #1e293b", paddingLeft:10 }}>
                {geoLevel === "market" ? (
                  <>
                    <label style={label9}>
                      Market
                      {" "}<span style={{ color:"#475569" }}>· {selectedGeos.length > 0 ? `${selectedGeos.length} selected` : "all"}</span>
                      {selectedGeos.length > 0 && <span onClick={() => setSelectedGeos([])} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}
                    </label>
                    <div style={PILL_ROW}>
                      {OUR_MARKETS.map(m => (
                        <Btn key={m} active={selectedGeos.includes(m)} onClick={() => toggleGeo(m)}
                          color="#f97316" style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0 }}>
                          {m.replace(", OH","")}
                        </Btn>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    {/* Step 1 — pick a market */}
                    <label style={label9}>
                      Market
                      {selectedGeos.length > 0 && <span style={{ color:"#475569" }}> · {selectedGeos.length} submarket{selectedGeos.length > 1 ? "s" : ""} selected</span>}
                      {selectedGeos.length > 0 && <span onClick={() => { setSelectedGeos([]); }} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}
                    </label>
                    <div style={PILL_ROW}>
                      {OUR_MARKETS.map(m => {
                        const hasSel = selectedGeos.some(g => g.startsWith(m + "::"));
                        return (
                          <Btn key={m}
                            active={drillMkt === m}
                            onClick={() => setDrillMkt(drillMkt === m ? null : m)}
                            color="#f97316"
                            style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0, outline: hasSel ? "1px solid #f97316" : "none" }}>
                            {m.replace(", OH","")}
                          </Btn>
                        );
                      })}
                    </div>
                    {/* Step 2 — pick submarkets within focused market */}
                    {drillMkt && (
                      <div style={{ borderLeft:"2px solid #f9741640", paddingLeft:8, marginTop:4 }}>
                        <label style={{ ...label9, marginTop:2 }}>
                          {drillMkt.replace(", OH","")} Submarkets
                          {selectedGeos.filter(g => g.startsWith(drillMkt + "::")).length > 0 && (
                            <span style={{ color:"#475569" }}> · {selectedGeos.filter(g => g.startsWith(drillMkt + "::")).length} selected</span>
                          )}
                        </label>
                        <div style={PILL_ROW}>
                          {(SUBMARKET_BY_MKT[drillMkt] || []).map(sub => {
                            const gkey = `${drillMkt}::${sub}`;
                            return (
                              <Btn key={gkey} active={selectedGeos.includes(gkey)} onClick={() => toggleGeo(gkey)}
                                color="#fb923c" style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0 }}>
                                {sub}
                              </Btn>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Company pills (pins mode only) */}
              {mapMode === "pins" && (
                <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0, width:280 }}>
                  <label style={label9}>
                    Parent Company
                    {" "}<span style={{ color:"#475569" }}>· {mapCompanies.length > 0 ? `${mapCompanies.length} selected` : "all"}</span>
                    {mapCompanies.length > 0 && <span onClick={() => { setMapCompanies([]); setMapBrands([]); }} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}
                  </label>
                  <div style={PILL_ROW}>
                    {companies.map(c => (
                      <Btn key={c} active={mapCompanies.includes(c)}
                        onClick={() => { setMapCompanies(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]); setMapBrands([]); }}
                        color="#f97316" style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0 }}>{c}</Btn>
                    ))}
                  </div>
                </div>
              )}

              {/* Brand pills */}
              {mapMode === "pins" && (mapCompanies.length > 0 || mapExtStay) && (
                <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0, width:280 }}>
                  <label style={label9}>
                    Brand
                    {" "}<span style={{ color:"#475569" }}>· {mapBrands.length > 0 ? `${mapBrands.length} selected` : `all ${visibleBrands.length}`}</span>
                    {mapBrands.length > 0 && <span onClick={() => setMapBrands([])} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}
                  </label>
                  <div style={PILL_ROW}>
                    {visibleBrands.map(b => (
                      <Btn key={b} active={mapBrands.includes(b)}
                        onClick={() => setMapBrands(prev => prev.includes(b) ? prev.filter(x => x !== b) : [...prev, b])}
                        color="#6366f1" style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0 }}>{b}</Btn>
                    ))}
                  </div>
                </div>
              )}

              {!mapReady && <span style={{ color:"#f59e0b", fontSize:11, alignSelf:"center", flexShrink:0 }}>Loading map…</span>}
            </div>{/* end scrollable section */}

            {/* Construct Connect — fixed right, outside overflow container so dropdown escapes */}
            <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0, borderLeft:"1px solid #1e293b", padding:"6px 16px", position:"relative", zIndex:200 }}>
              <label style={label9}>Construct Connect {ccData.length > 0 && <span style={{ color:"#475569" }}>· {ccData.length.toLocaleString()} projects</span>}</label>
              <div style={{ display:"flex", gap:2, flexWrap:"nowrap", alignItems:"center" }}>
                <Btn active={showCC} onClick={() => { setShowCC(v => !v); setCcStatusOpen(false); }} color="#06b6d4">{showCC ? "Hide" : "Show"} Layer</Btn>
                {showCC && <>
                  <span style={{ width:1, background:"#334155", alignSelf:"stretch", margin:"0 6px" }} />
                  <Btn active={ccTypeFilter==="all"}     onClick={() => setCcTypeFilter("all")}     color="#06b6d4">All</Btn>
                  <Btn active={ccTypeFilter==="hotel"}   onClick={() => setCcTypeFilter("hotel")}   color="#3b82f6">Hotel</Btn>
                  <Btn active={ccTypeFilter==="elderly"} onClick={() => setCcTypeFilter("elderly")} color="#8b5cf6">Elderly</Btn>
                  <span style={{ width:1, background:"#334155", alignSelf:"stretch", margin:"0 6px" }} />
                  <div ref={ccStatusRef} style={{ position:"relative" }}>
                    <Btn active={ccStatuses.length > 0 || ccStatusOpen} onClick={() => setCcStatusOpen(v => !v)} color="#6366f1" style={{ display:"flex", alignItems:"center", gap:4 }}>
                      Status{ccStatuses.length > 0 ? ` (${ccStatuses.length})` : ""} <span style={{ fontSize:9 }}>{ccStatusOpen ? "▲" : "▼"}</span>
                    </Btn>
                    <Popover anchorRef={ccStatusRef} open={ccStatusOpen} minWidth={220}>
                      <div style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:8, padding:"8px 6px", minWidth:220, display:"flex", flexDirection:"column", gap:2 }}>
                        {ccStatuses.length > 0 && (
                          <span onClick={() => setCcStatuses([])} style={{ color:"#3b82f6", cursor:"pointer", fontSize:10, padding:"0 4px 4px", borderBottom:"1px solid #1e293b", marginBottom:2 }}>clear all</span>
                        )}
                        {CC_STATUSES_ALL.map(s => (
                          <div key={s} onClick={() => setCcStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                            style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", padding:"4px 8px", borderRadius:4, background: ccStatuses.includes(s) ? CC_STATUS_COLOR[s]+"22" : "transparent" }}>
                            <div style={{ width:8, height:8, background:CC_STATUS_COLOR[s], borderRadius:1, transform:"rotate(45deg)", flexShrink:0 }} />
                            <span style={{ fontSize:11, color: ccStatuses.includes(s) ? CC_STATUS_COLOR[s] : "#94a3b8", flex:1 }}>{s}</span>
                            {ccStatuses.includes(s) && <span style={{ color:CC_STATUS_COLOR[s], fontSize:10 }}>✓</span>}
                          </div>
                        ))}
                      </div>
                    </Popover>
                  </div>
                </>}
              </div>
            </div>
            </div>{/* end filter bar wrapper */}

            {/* Map fills remaining height */}
            <div id="kalibri-map" style={{ flex:1, minHeight:0, background:"#0a1628" }} />
          </div>
        );
      })()}
    </div>
  );
}
