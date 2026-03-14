import React, { useState, useMemo, useEffect, useRef, useLayoutEffect } from "react";
import ReactDOM from "react-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell, ReferenceArea,
} from "recharts";

const KALIBRI_URL = "/ohio_kalibri_consolidated.csv";
const COSTAR_URL  = "/ohio_costar.csv";
const LAST_ACTUAL_OVERRIDE = "2026-01";

const MONTH_MAP = {
  Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
  Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12",
};

function normalizePeriodK(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\w{3})\s*-\s*(\d{4})$/);
  if (m && MONTH_MAP[m[1]]) return `${m[2]}-${MONTH_MAP[m[1]]}`;
  return null;
}

function normalizePeriodC(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 7);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${String(mdy[1]).padStart(2,"0")}`;
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
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

function parseKalibriCSV(text) {
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
    const market = row["Market"], submarket = row["Submarket"];
    const revType = row["Revenue Type"], tier = row["Tier"], losTier = row["LOS Tier"] || "";
    const periodRaw = row["Period"];
    if (!market || !revType || !tier || !periodRaw) continue;
    const period = normalizePeriodK(periodRaw);
    if (!period) continue;
    const geoKey = submarket ? `${market}::${submarket}` : market;
    if (!geoMeta[geoKey]) geoMeta[geoKey] = { market, submarket: submarket || null, isSubmarket: !!submarket };
    if (row["ALOS"] && row["ALOS"] !== "-" && row["ALOS"].trim() !== "") {
      if (!lastActual || period > lastActual) lastActual = period;
    }
    if (!lookup[period]) lookup[period] = {};
    if (!lookup[period][geoKey]) lookup[period][geoKey] = {};
    if (!lookup[period][geoKey][revType]) lookup[period][geoKey][revType] = {};
    if (!lookup[period][geoKey][revType][tier]) lookup[period][geoKey][revType][tier] = {};
    lookup[period][geoKey][revType][tier][losTier] = {
      occ: parseNum(row["Occ"]), occ_yoy: parseNum(row["Occ - YoY"]),
      adr: parseNum(row["ADR"]), adr_yoy: parseNum(row["ADR - YoY"]),
      revpar: parseNum(row["RevPAR"]), revpar_yoy: parseNum(row["RevPAR - YoY"]),
      booking_cost: parseNum(row["Booking Costs per RN"]),
      booking_cost_yoy: parseNum(row["Booking Costs per RN - YoY"]),
      alos: parseNum(row["ALOS"]), alos_yoy: parseNum(row["ALOS - YoY"]),
    };
  }
  return { lookup, geoMeta, lastActual: LAST_ACTUAL_OVERRIDE || lastActual || "2026-01" };
}

async function loadKalibriData() {
  const res = await fetch(KALIBRI_URL);
  if (!res.ok) throw new Error(`Failed to fetch Kalibri data: ${res.status} ${res.statusText}\n\nMake sure ohio_kalibri_consolidated.csv is in the /public folder.`);
  return parseKalibriCSV(await res.text());
}

const C_NUMERIC_COLS = new Set([
  "Inventory Rooms","Existing Buildings","Avg Rooms Per Building",
  "12 Mo Delivered Rooms","12 Mo Inventory Growth","12 Mo Opened Rooms","12 Mo Opened Buildings",
  "Under Construction Rooms","Under Construction Buildings",
  "12 Mo Occupancy","12 Mo Occupancy Chg","12 Mo ADR","12 Mo ADR Chg",
  "12 Mo RevPAR","12 Mo RevPAR Chg","12 Mo Supply","12 Mo Demand","12 Mo Revenue",
  "12 Mo Sales Volume","12 Mo Transactions",
  "3 Mo Occupancy","3 Mo Occupancy Chg","3 Mo ADR","3 Mo ADR Chg",
  "3 Mo RevPAR","3 Mo RevPAR Chg","3 Mo Supply","3 Mo Demand","3 Mo Revenue",
  "Occupancy","Occupancy Chg (YOY)","ADR","ADR Chg (YOY)",
  "RevPAR","RevPAR Chg (YOY)","Supply","Supply Chg (YOY)","Demand","Demand Chg (YOY)",
  "Revenue","Revenue Chg (YOY)",
  "YTD Occupancy","YTD Occupancy Chg","YTD ADR","YTD ADR Chg",
  "YTD RevPAR","YTD RevPAR Chg","YTD Supply","YTD Demand","YTD Revenue",
  "Market Sale Price/Room","Market Cap Rate","Asset Value",
]);

function parseCoStarCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const lookup = {};
  const geo_meta = {};
  let last_actual = "2020-01";
  let lastProcessed = null;
  for (let i = 1; i <= Math.min(5, lines.length - 1); i++) {
    const vals = lines[i].split(",");
    const lpIdx = headers.indexOf("Last Processed Month");
    if (lpIdx >= 0 && vals[lpIdx]) {
      lastProcessed = normalizePeriodC(vals[lpIdx].trim());
      if (lastProcessed) break;
    }
  }
  if (lastProcessed) last_actual = lastProcessed;
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
    headers.forEach((h, idx) => {
      const v = (vals[idx] ?? "").trim().replace(/^"|"$/g, "");
      row[h] = C_NUMERIC_COLS.has(h) ? (v === "" || v === "-" ? null : parseFloat(v)) : v;
    });
    const period = normalizePeriodC(row["Period"]);
    const geoName = row["Geography Name"];
    const slice = row["Slice"];
    const geoType = row["Geography Type"];
    const market = row["Market"];
    const submarket = row["Submarket"] || null;
    if (!period || !geoName || !slice) continue;
    if (!geo_meta[geoName]) {
      geo_meta[geoName] = { geo_type: geoType, market, submarket: submarket || (geoType === "Market" ? null : geoName) };
    }
    if (!lookup[period]) lookup[period] = {};
    if (!lookup[period][geoName]) lookup[period][geoName] = {};
    lookup[period][geoName][slice] = row;
  }
  return { lookup, geo_meta, last_actual };
}

async function loadCoStarData() {
  const res = await fetch(COSTAR_URL);
  if (!res.ok) throw new Error(`Failed to fetch CoStar data: ${res.status} ${res.statusText}\n\nMake sure ohio_costar.csv is in the /public folder.`);
  return parseCoStarCSV(await res.text());
}

function getMetricsK(lookup, period, geoKey, revType, tier, losTier) {
  return lookup[period]?.[geoKey]?.[revType]?.[tier]?.[losTier] ?? null;
}

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

function weightedMetrics(entries) {
  let occNum=0,occDen=0,adrNum=0,adrDen=0,revNum=0,revDen=0,bcNum=0,bcDen=0,alosNum=0,alosDen=0;
  for (const {period, m} of entries) {
    if (!m) continue;
    const d = getDaysInMonth(period);
    if (m.occ    != null)                                { occNum  += m.occ    * d; occDen  += d; }
    if (m.revpar != null)                                { revNum  += m.revpar * d; revDen  += d; }
    if (m.revpar != null && m.occ != null && m.occ > 0) { adrNum  += m.revpar * d; adrDen  += m.occ * d; }
    if (m.booking_cost != null && m.occ != null)        { bcNum   += m.booking_cost * m.occ * d; bcDen   += m.occ * d; }
    if (m.alos         != null && m.occ != null)        { alosNum += m.alos * m.occ * d; alosDen += m.occ * d; }
  }
  return {
    occ:          occDen  > 0 ? occNum  / occDen  : null,
    adr:          adrDen  > 0 ? adrNum  / adrDen  : null,
    revpar:       revDen  > 0 ? revNum  / revDen  : null,
    booking_cost: bcDen   > 0 ? bcNum   / bcDen   : null,
    alos:         alosDen > 0 ? alosNum / alosDen : null,
  };
}

function aggregateLOS(lookup, period, geoKey, revType, tier, losTiers) {
  if (losTiers.length === 1) return getMetricsK(lookup, period, geoKey, revType, tier, losTiers[0]);
  const arr = losTiers.map(lt => getMetricsK(lookup, period, geoKey, revType, tier, lt)).filter(Boolean);
  if (!arr.length) return null;
  let occ=0,revpar=0,bcNum=0,bcDen=0,alosNum=0,alosDen=0;
  for (const m of arr) {
    if (m.occ    != null) occ    += m.occ;
    if (m.revpar != null) revpar += m.revpar;
    if (m.booking_cost != null && m.occ > 0) { bcNum += m.booking_cost * m.occ; bcDen += m.occ; }
    if (m.alos         != null && m.occ > 0) { alosNum += m.alos * m.occ; alosDen += m.occ; }
  }
  return {
    occ: occ || null, adr: occ > 0 ? revpar / occ : null, revpar: revpar || null,
    booking_cost: bcDen > 0 ? bcNum / bcDen : null, alos: alosDen > 0 ? alosNum / alosDen : null,
  };
}

function aggregateTiers(kLookup, period, geoKey, revType, tiers, losTiers) {
  if (tiers.length === 1) return aggregateLOS(kLookup, period, geoKey, revType, tiers[0], losTiers);
  const items = tiers.map(t => ({
    m:     aggregateLOS(kLookup, period, geoKey, revType, t, losTiers),
    rooms: SUPPLY[geoKey]?.[t]?.rooms || 0,
  })).filter(({ m, rooms }) => m && rooms > 0);
  if (!items.length) return null;
  let occNum=0,revNum=0,bcNum=0,bcDen=0,alosNum=0,alosDen=0,totalRooms=0;
  for (const { m, rooms } of items) {
    if (m.occ    != null) { occNum += m.occ    * rooms; totalRooms += rooms; }
    if (m.revpar != null)   revNum += m.revpar * rooms;
    if (m.booking_cost != null && m.occ > 0) { bcNum   += m.booking_cost * m.occ * rooms; bcDen   += m.occ * rooms; }
    if (m.alos         != null && m.occ > 0) { alosNum += m.alos         * m.occ * rooms; alosDen += m.occ * rooms; }
  }
  const occ    = totalRooms > 0 ? occNum / totalRooms : null;
  const revpar = totalRooms > 0 ? revNum / totalRooms : null;
  return {
    occ, revpar, adr: occ > 0 ? revpar / occ : null,
    booking_cost: bcDen > 0 ? bcNum / bcDen : null, alos: alosDen > 0 ? alosNum / alosDen : null,
  };
}

function computeTrailing(kLookup, endPeriod, geoKey, revType, tiers, losTiers, tw, allPeriods) {
  const get = (p) => aggregateTiers(kLookup, p, geoKey, revType, tiers, losTiers);
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
    if (!curr || !isMulti) return curr;
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

const C_CUSTOM_COMBOS = {
  "Economy + Midscale": ["Economy","Midscale"],
  "Midscale + Upper Midscale": ["Midscale","Upper Midscale"],
  "Upper Midscale + Upscale": ["Upper Midscale","Upscale"],
  "Upscale + Upper Upscale": ["Upscale","Upper Upscale"],
  "Upper Upscale + Luxury": ["Upper Upscale","Luxury"],
  "Eco + Mid + UpMid (Select Service)": ["Economy","Midscale","Upper Midscale"],
  "Upscale + UpUpscale + Luxury (Full Service)": ["Upscale","Upper Upscale","Luxury"],
};

function getMetricsC(lookup, period, geoName, sliceKey, tw) {
  const pd = lookup[period]?.[geoName];
  if (!pd) return null;
  const custom = C_CUSTOM_COMBOS[sliceKey];
  const extract = (m) => m ? {
    revpar:m[tw.revpar], revpar_chg:m[tw.revpar_chg], adr:m[tw.adr], adr_chg:m[tw.adr_chg],
    occ:m[tw.occ], occ_chg:m[tw.occ_chg], supply:m[tw.supply], demand:m[tw.demand], revenue:m[tw.revenue],
    inv_rooms:m["Inventory Rooms"], exist_bldgs:m["Existing Buildings"], avg_rooms_per_bldg:m["Avg Rooms Per Building"],
    del_rooms:m["12 Mo Delivered Rooms"], inv_growth:m["12 Mo Inventory Growth"],
    opened_rooms:m["12 Mo Opened Rooms"], opened_bldgs:m["12 Mo Opened Buildings"],
    uc_rooms:m["Under Construction Rooms"], uc_bldgs:m["Under Construction Buildings"],
    sale_price_room:m["Market Sale Price/Room"], sales_vol:m["12 Mo Sales Volume"], cap_rate:m["Market Cap Rate"],
  } : null;
  if (!custom) return extract(pd[sliceKey]);
  let totRev=0,totSup=0,totDem=0,totInv=0,totBldgs=0,totUcR=0,totUcB=0,totDelR=0,totOpenR=0,totOpenB=0,totSalesVol=0;
  let capSum=0,capW=0,saleSum=0,saleW=0,valid=0;
  for (const s of custom) {
    const m=pd[s]; if(!m||m[tw.supply]==null) continue;
    totRev+=m[tw.revenue]||0; totSup+=m[tw.supply]||0; totDem+=m[tw.demand]||0;
    totInv+=m["Inventory Rooms"]||0; totBldgs+=m["Existing Buildings"]||0;
    totUcR+=m["Under Construction Rooms"]||0; totUcB+=m["Under Construction Buildings"]||0;
    totDelR+=m["12 Mo Delivered Rooms"]||0; totOpenR+=m["12 Mo Opened Rooms"]||0;
    totOpenB+=m["12 Mo Opened Buildings"]||0; totSalesVol+=m["12 Mo Sales Volume"]||0;
    const wt=m["Inventory Rooms"]||1;
    if(m["Market Cap Rate"]!=null){capSum+=m["Market Cap Rate"]*wt;capW+=wt;}
    if(m["Market Sale Price/Room"]!=null){saleSum+=m["Market Sale Price/Room"]*wt;saleW+=wt;}
    valid++;
  }
  if(!valid) return null;
  return {
    revpar:totSup>0?totRev/totSup:null, revpar_chg:null, adr:totDem>0?totRev/totDem:null, adr_chg:null,
    occ:totSup>0?totDem/totSup:null, occ_chg:null, supply:totSup, demand:totDem, revenue:totRev,
    inv_rooms:totInv, exist_bldgs:totBldgs, avg_rooms_per_bldg:totBldgs>0?totInv/totBldgs:null,
    del_rooms:totDelR||null, inv_growth:totInv>0?totDelR/totInv:null,
    opened_rooms:totOpenR||null, opened_bldgs:totOpenB||null, uc_rooms:totUcR||null, uc_bldgs:totUcB||null,
    sale_price_room:saleW>0?saleSum/saleW:null, sales_vol:totSalesVol||null, cap_rate:capW>0?capSum/capW:null,
  };
}

function calcCAGR(v1, v2, years) {
  if (!v1 || !v2 || years <= 0 || v1 <= 0) return null;
  return Math.pow(v2 / v1, 1 / years) - 1;
}

function downloadCSV(filename, rows, columns) {
  const escape = v => (v == null ? "" : String(v).includes(",") || String(v).includes('"') ? `"${String(v).replace(/"/g,'""')}"` : String(v));
  const header = columns.map(c => c.label).join(",");
  const body   = rows.map(r => columns.map(c => escape(c.get(r))).join(",")).join("\n");
  const blob   = new Blob([header + "\n" + body], { type:"text/csv" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const fmt = {
  pct:       v => v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%",
  pp:        v => v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "pp",
  dollar:    v => v == null ? "—" : "$" + v.toFixed(2),
  dollarK:   v => v == null ? "—" : "$" + (v / 1000).toFixed(0) + "K",
  dollarM:   v => v == null ? "—" : "$" + (v / 1e6).toFixed(1) + "M",
  int:       v => v == null ? "—" : Math.round(v).toLocaleString(),
  occ:       v => v == null ? "—" : (v * 100).toFixed(1) + "%",
  capRate:   v => v == null ? "—" : (v * 100).toFixed(2) + "%",
  invGrowth: v => v == null ? "—" : (v * 100).toFixed(2) + "%",
  dec1:      v => v == null ? "—" : v.toFixed(1),
  dec2:      v => v == null ? "—" : v.toFixed(2),
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

const GEO_COORDS = {
  "Akron, OH":           [41.0814,-81.5190], "Cincinnati, OH":  [39.1031,-84.5120],
  "Cleveland, OH":       [41.4993,-81.6944], "Columbus, OH":    [39.9612,-82.9988],
  "Dayton, OH":          [39.7589,-84.1916], "Ohio State Area, OH":[40.4173,-82.9071],
  "Sandusky, OH":        [41.4489,-82.7079], "Toledo, OH":      [41.6639,-83.5552],
  "Youngstown, OH":      [41.0998,-80.6495],
  "Akron, OH::Akron":                    [41.0814,-81.5190],
  "Akron, OH::Akron West":               [41.1500,-81.6800],
  "Akron, OH::Canton":                   [40.7989,-81.3784],
  "Akron, OH::Twinsburg/Streetsboro":    [41.3123,-81.4401],
  "Cincinnati, OH::CVG Airport":         [39.0489,-84.6678],
  "Cincinnati, OH::Cincinnati East":     [39.1200,-84.3200],
  "Cincinnati, OH::Cincinnati North":    [39.2700,-84.4500],
  "Cincinnati, OH::Cincinnati West":     [39.0900,-84.6500],
  "Cincinnati, OH::Downtown Cincinnati": [39.1031,-84.5120],
  "Cincinnati, OH::Franklin":            [39.5578,-84.3047],
  "Cleveland, OH::Avon/I90 West":        [41.4517,-82.0354],
  "Cleveland, OH::Cleveland Heights":    [41.5200,-81.5566],
  "Cleveland, OH::Cleveland Southeast":  [41.3500,-81.5000],
  "Cleveland, OH::Downtown Cleveland":   [41.4993,-81.6944],
  "Cleveland, OH::Strongsville/Medina":  [41.3145,-81.8357],
  "Columbus, OH::CMH Airport":           [39.9980,-82.8919],
  "Columbus, OH::Columbus South":        [39.8200,-82.9988],
  "Columbus, OH::Columbus West":         [39.9612,-83.1500],
  "Columbus, OH::Downtown Columbus":     [39.9612,-82.9988],
  "Columbus, OH::Newark":                [40.0581,-82.4013],
  "Columbus, OH::Worthington/Westerville":[40.0931,-82.9557],
  "Dayton, OH::Dayton Northeast/Fairborn":[39.8270,-84.0219],
  "Dayton, OH::Dayton South/Miamisburg": [39.6439,-84.2897],
  "Dayton, OH::Downtown/DAY Airport":    [39.9023,-84.2194],
  "Dayton, OH::Springfield":             [39.9242,-83.8088],
  "Dayton, OH::Tipp City/Troy":          [40.0614,-84.2016],
  "Ohio State Area, OH::Findlay":        [41.0442,-83.6499],
  "Ohio State Area, OH::I70 Corridor":   [39.9500,-82.0000],
  "Ohio State Area, OH::Lima":           [40.7423,-84.1052],
  "Ohio State Area, OH::Mansfield/Ashland":[40.7584,-82.5154],
  "Ohio State Area, OH::Ohio North":     [41.4000,-82.7000],
  "Ohio State Area, OH::Ohio South":     [39.3000,-82.5000],
  "Sandusky, OH::Sandusky":             [41.4489,-82.7079],
  "Toledo, OH::Toledo East":             [41.6639,-83.3500],
  "Toledo, OH::Toledo West":             [41.6639,-83.7000],
  "Youngstown, OH::Youngstown":          [41.0998,-80.6495],
};

const EXTENDED_STAY_BRANDS = new Set([
  "Extended Stay America Suites","Extended Stay America Premier Suites",
  "Extended Stay America Select Suites","WoodSpring Suites",
  "Homewood Suites by Hilton","Home2 Suites by Hilton","TownePlace Suites",
  "Candlewood Suites","Staybridge Suites","Hawthorn Suites by Wyndham",
  "MainStay Suites","Suburban Studios","HomeTowne Studios by Red Roof",
  "InTown Suites","Sonesta ES Suites","Sonesta Simply Suites",
  "stayAPT Suites","Hyatt House","Residence Inn",
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

const SUPPLY = {
  "Akron, OH": { "All Tier":{rooms:9804,props:110},"Lower Tier":{rooms:1891,props:27},"Mid Tier":{rooms:5008,props:57},"Upper Tier":{rooms:2905,props:26} },
  "Akron, OH::Akron": { "All Tier":{rooms:2563,props:29},"Lower Tier":{rooms:572,props:7},"Mid Tier":{rooms:1045,props:14},"Upper Tier":{rooms:946,props:8} },
  "Akron, OH::Akron West": { "All Tier":{rooms:2876,props:33},"Lower Tier":{rooms:594,props:10},"Mid Tier":{rooms:1661,props:18},"Upper Tier":{rooms:621,props:5} },
  "Akron, OH::Canton": { "All Tier":{rooms:2602,props:28},"Lower Tier":{rooms:436,props:6},"Mid Tier":{rooms:1213,props:14},"Upper Tier":{rooms:953,props:8} },
  "Akron, OH::Twinsburg/Streetsboro": { "All Tier":{rooms:1763,props:20},"Lower Tier":{rooms:289,props:4},"Mid Tier":{rooms:1089,props:11},"Upper Tier":{rooms:385,props:5} },
  "Cincinnati, OH": { "All Tier":{rooms:32274,props:291},"Lower Tier":{rooms:5018,props:59},"Mid Tier":{rooms:14211,props:144},"Upper Tier":{rooms:13045,props:88} },
  "Cincinnati, OH::CVG Airport": { "All Tier":{rooms:5904,props:54},"Lower Tier":{rooms:1302,props:15},"Mid Tier":{rooms:2737,props:27},"Upper Tier":{rooms:1865,props:12} },
  "Cincinnati, OH::Cincinnati East": { "All Tier":{rooms:2306,props:23},"Lower Tier":{rooms:252,props:3},"Mid Tier":{rooms:1384,props:14},"Upper Tier":{rooms:670,props:6} },
  "Cincinnati, OH::Cincinnati North": { "All Tier":{rooms:12681,props:115},"Lower Tier":{rooms:2303,props:23},"Mid Tier":{rooms:5695,props:57},"Upper Tier":{rooms:4683,props:35} },
  "Cincinnati, OH::Cincinnati West": { "All Tier":{rooms:1561,props:20},"Lower Tier":{rooms:285,props:3},"Mid Tier":{rooms:1009,props:13},"Upper Tier":{rooms:267,props:4} },
  "Cincinnati, OH::Downtown Cincinnati": { "All Tier":{rooms:8407,props:57},"Lower Tier":{rooms:337,props:5},"Mid Tier":{rooms:2631,props:22},"Upper Tier":{rooms:5439,props:30} },
  "Cincinnati, OH::Franklin": { "All Tier":{rooms:1415,props:22},"Lower Tier":{rooms:539,props:10},"Mid Tier":{rooms:755,props:11},"Upper Tier":{rooms:121,props:1} },
  "Cleveland, OH": { "All Tier":{rooms:21674,props:166},"Lower Tier":{rooms:2548,props:28},"Mid Tier":{rooms:7891,props:73},"Upper Tier":{rooms:11235,props:65} },
  "Cleveland, OH::Avon/I90 West": { "All Tier":{rooms:5483,props:50},"Lower Tier":{rooms:1104,props:13},"Mid Tier":{rooms:2600,props:25},"Upper Tier":{rooms:1779,props:12} },
  "Cleveland, OH::Cleveland Heights": { "All Tier":{rooms:1925,props:20},"Lower Tier":{rooms:711,props:7},"Mid Tier":{rooms:741,props:8},"Upper Tier":{rooms:473,props:5} },
  "Cleveland, OH::Cleveland Southeast": { "All Tier":{rooms:3328,props:29},"Lower Tier":{rooms:219,props:2},"Mid Tier":{rooms:1089,props:11},"Upper Tier":{rooms:2020,props:16} },
  "Cleveland, OH::Downtown Cleveland": { "All Tier":{rooms:6539,props:32},"Lower Tier":{rooms:50,props:1},"Mid Tier":{rooms:890,props:7},"Upper Tier":{rooms:5599,props:24} },
  "Cleveland, OH::Strongsville/Medina": { "All Tier":{rooms:4399,props:35},"Lower Tier":{rooms:464,props:5},"Mid Tier":{rooms:2571,props:22},"Upper Tier":{rooms:1364,props:8} },
  "Columbus, OH": { "All Tier":{rooms:30974,props:262},"Lower Tier":{rooms:5610,props:55},"Mid Tier":{rooms:10830,props:119},"Upper Tier":{rooms:14534,props:88} },
  "Columbus, OH::CMH Airport": { "All Tier":{rooms:4801,props:39},"Lower Tier":{rooms:331,props:2},"Mid Tier":{rooms:2049,props:21},"Upper Tier":{rooms:2421,props:16} },
  "Columbus, OH::Columbus South": { "All Tier":{rooms:4192,props:47},"Lower Tier":{rooms:1422,props:14},"Mid Tier":{rooms:2342,props:29},"Upper Tier":{rooms:428,props:4} },
  "Columbus, OH::Columbus West": { "All Tier":{rooms:5003,props:48},"Lower Tier":{rooms:811,props:9},"Mid Tier":{rooms:2017,props:24},"Upper Tier":{rooms:2175,props:15} },
  "Columbus, OH::Downtown Columbus": { "All Tier":{rooms:8261,props:49},"Lower Tier":{rooms:635,props:6},"Mid Tier":{rooms:1553,props:14},"Upper Tier":{rooms:6073,props:29} },
  "Columbus, OH::Newark": { "All Tier":{rooms:1648,props:20},"Lower Tier":{rooms:439,props:5},"Mid Tier":{rooms:639,props:8},"Upper Tier":{rooms:570,props:7} },
  "Columbus, OH::Worthington/Westerville": { "All Tier":{rooms:7069,props:59},"Lower Tier":{rooms:1972,props:19},"Mid Tier":{rooms:2230,props:23},"Upper Tier":{rooms:2867,props:17} },
  "Dayton, OH": { "All Tier":{rooms:12367,props:137},"Lower Tier":{rooms:2599,props:32},"Mid Tier":{rooms:6405,props:76},"Upper Tier":{rooms:3363,props:29} },
  "Dayton, OH::Dayton Northeast/Fairborn": { "All Tier":{rooms:2691,props:29},"Lower Tier":{rooms:433,props:5},"Mid Tier":{rooms:1598,props:19},"Upper Tier":{rooms:660,props:5} },
  "Dayton, OH::Dayton South/Miamisburg": { "All Tier":{rooms:2711,props:27},"Lower Tier":{rooms:710,props:7},"Mid Tier":{rooms:1082,props:12},"Upper Tier":{rooms:919,props:8} },
  "Dayton, OH::Downtown/DAY Airport": { "All Tier":{rooms:4575,props:50},"Lower Tier":{rooms:918,props:11},"Mid Tier":{rooms:2227,props:28},"Upper Tier":{rooms:1430,props:11} },
  "Dayton, OH::Springfield": { "All Tier":{rooms:1095,props:16},"Lower Tier":{rooms:348,props:6},"Mid Tier":{rooms:579,props:7},"Upper Tier":{rooms:168,props:3} },
  "Dayton, OH::Tipp City/Troy": { "All Tier":{rooms:1295,props:15},"Lower Tier":{rooms:190,props:3},"Mid Tier":{rooms:919,props:10},"Upper Tier":{rooms:186,props:2} },
  "Ohio State Area, OH": { "All Tier":{rooms:27249,props:412},"Lower Tier":{rooms:6291,props:100},"Mid Tier":{rooms:17506,props:253},"Upper Tier":{rooms:3452,props:59} },
  "Ohio State Area, OH::Findlay": { "All Tier":{rooms:1272,props:15},"Lower Tier":{rooms:255,props:3},"Mid Tier":{rooms:585,props:8},"Upper Tier":{rooms:432,props:4} },
  "Ohio State Area, OH::I70 Corridor": { "All Tier":{rooms:2091,props:24},"Lower Tier":{rooms:690,props:9},"Mid Tier":{rooms:997,props:13},"Upper Tier":{rooms:404,props:2} },
  "Ohio State Area, OH::Lima": { "All Tier":{rooms:1435,props:16},"Lower Tier":{rooms:477,props:6},"Mid Tier":{rooms:859,props:9},"Upper Tier":{rooms:99,props:1} },
  "Ohio State Area, OH::Mansfield/Ashland": { "All Tier":{rooms:1902,props:27},"Lower Tier":{rooms:567,props:9},"Mid Tier":{rooms:1209,props:16},"Upper Tier":{rooms:126,props:2} },
  "Ohio State Area, OH::Ohio North": { "All Tier":{rooms:13992,props:231},"Lower Tier":{rooms:3060,props:51},"Mid Tier":{rooms:8984,props:138},"Upper Tier":{rooms:1948,props:42} },
  "Ohio State Area, OH::Ohio South": { "All Tier":{rooms:6557,props:99},"Lower Tier":{rooms:1242,props:22},"Mid Tier":{rooms:4872,props:69},"Upper Tier":{rooms:443,props:8} },
  "Sandusky, OH": { "All Tier":{rooms:5116,props:43},"Lower Tier":{rooms:846,props:12},"Mid Tier":{rooms:2503,props:26},"Upper Tier":{rooms:1767,props:5} },
  "Toledo, OH": { "All Tier":{rooms:7786,props:78},"Lower Tier":{rooms:1641,props:19},"Mid Tier":{rooms:3720,props:41},"Upper Tier":{rooms:2425,props:18} },
  "Toledo, OH::Toledo East": { "All Tier":{rooms:3333,props:35},"Lower Tier":{rooms:691,props:9},"Mid Tier":{rooms:1924,props:20},"Upper Tier":{rooms:718,props:6} },
  "Toledo, OH::Toledo West": { "All Tier":{rooms:4453,props:43},"Lower Tier":{rooms:950,props:10},"Mid Tier":{rooms:1796,props:21},"Upper Tier":{rooms:1707,props:12} },
  "Youngstown, OH": { "All Tier":{rooms:3279,props:44},"Lower Tier":{rooms:534,props:9},"Mid Tier":{rooms:2144,props:29},"Upper Tier":{rooms:601,props:6} },
};

// ─── KALIBRI CONSTANTS ────────────────────────────────────────────────────────
const K_METRICS = [
  { key:"occ",          label:"Occupancy",      yoyKey:"occ_yoy",          valFmt:fmt.occ,    yoyFmt:fmt.pp,  isOcc:true },
  { key:"adr",          label:"ADR",             yoyKey:"adr_yoy",          valFmt:fmt.dollar, yoyFmt:fmt.pct },
  { key:"revpar",       label:"RevPAR",          yoyKey:"revpar_yoy",       valFmt:fmt.dollar, yoyFmt:fmt.pct },
  { key:"booking_cost", label:"Booking Cost/RN", yoyKey:"booking_cost_yoy", valFmt:fmt.dollar, yoyFmt:fmt.pct },
  { key:"alos",         label:"ALOS",            yoyKey:"alos_yoy",         valFmt:fmt.dec2,   yoyFmt:fmt.pct },
];

const K_TREND_METRICS = [
  { key:"revpar",           label:"RevPAR",              tickFmt:v=>"$"+v.toFixed(0),              valFmt:v=>"$"+v.toFixed(2) },
  { key:"revpar_yoy",       label:"RevPAR % Chg (YoY)",  tickFmt:v=>(v*100).toFixed(1)+"%",        valFmt:v=>(v>=0?"+":"")+(v*100).toFixed(1)+"%" },
  { key:"occ",              label:"Occupancy",           tickFmt:v=>(v*100).toFixed(0)+"%",         valFmt:v=>(v*100).toFixed(1)+"%" },
  { key:"occ_yoy",          label:"Occupancy Chg (YoY)", tickFmt:v=>(v*100).toFixed(1)+"pp",        valFmt:v=>(v>=0?"+":"")+(v*100).toFixed(1)+"pp" },
  { key:"adr",              label:"ADR",                 tickFmt:v=>"$"+v.toFixed(0),              valFmt:v=>"$"+v.toFixed(2) },
  { key:"adr_yoy",          label:"ADR % Chg (YoY)",     tickFmt:v=>(v*100).toFixed(1)+"%",        valFmt:v=>(v>=0?"+":"")+(v*100).toFixed(1)+"%" },
  { key:"booking_cost",     label:"Booking Cost/RN",     tickFmt:v=>"$"+v.toFixed(2),              valFmt:v=>"$"+v.toFixed(2) },
  { key:"booking_cost_yoy", label:"Booking Cost % Chg",  tickFmt:v=>(v*100).toFixed(1)+"%",        valFmt:v=>(v>=0?"+":"")+(v*100).toFixed(1)+"%" },
  { key:"alos",             label:"ALOS",                tickFmt:v=>v.toFixed(1),                  valFmt:v=>v.toFixed(2) },
  { key:"alos_yoy",         label:"ALOS % Chg (YoY)",    tickFmt:v=>(v*100).toFixed(1)+"%",        valFmt:v=>(v>=0?"+":"")+(v*100).toFixed(1)+"%" },
];

const K_CAGR_SORT = [
  { key:"revpar_cagr", label:"RevPAR CAGR" },
  { key:"adr_cagr",   label:"ADR CAGR"    },
  { key:"occ_delta",  label:"Occ Δ (pp)"  },
];

const K_TIME_WINDOWS = [
  { id:"12mo", label:"12 Mo", months:12   },
  { id:"3mo",  label:"3 Mo",  months:3    },
  { id:"mo",   label:"Month", months:1    },
  { id:"ytd",  label:"YTD",   months:null },
];

const K_REV_TYPES   = ["Guest Paid","Hotel Collected","COPE"];
const K_TIERS       = ["All Tier","Lower Tier","Mid Tier","Upper Tier"];
const K_LOS_OPTIONS = [
  { value:"",     label:"Overview"    },
  { value:"0-6",  label:"0–6 Nights"  },
  { value:"7-14", label:"7–14 Nights" },
  { value:"15-29",label:"15–29 Nights"},
  { value:"30+",  label:"30+ Nights"  },
];

// ─── COSTAR CONSTANTS ─────────────────────────────────────────────────────────
const C_TIME_WINDOWS = [
  { id:"12mo",label:"12 Mo", revpar:"12 Mo RevPAR",revpar_chg:"12 Mo RevPAR Chg",adr:"12 Mo ADR",adr_chg:"12 Mo ADR Chg",occ:"12 Mo Occupancy",occ_chg:"12 Mo Occupancy Chg",supply:"12 Mo Supply",demand:"12 Mo Demand",revenue:"12 Mo Revenue" },
  { id:"3mo", label:"3 Mo",  revpar:"3 Mo RevPAR", revpar_chg:"3 Mo RevPAR Chg", adr:"3 Mo ADR", adr_chg:"3 Mo ADR Chg", occ:"3 Mo Occupancy", occ_chg:"3 Mo Occupancy Chg", supply:"3 Mo Supply", demand:"3 Mo Demand", revenue:"3 Mo Revenue"  },
  { id:"mo",  label:"Month", revpar:"RevPAR",       revpar_chg:"RevPAR Chg (YOY)",adr:"ADR",      adr_chg:"ADR Chg (YOY)",occ:"Occupancy",       occ_chg:"Occupancy Chg (YOY)",supply:"Supply",       demand:"Demand",       revenue:"Revenue"        },
  { id:"ytd", label:"YTD",   revpar:"YTD RevPAR",  revpar_chg:"YTD RevPAR Chg",  adr:"YTD ADR",  adr_chg:"YTD ADR Chg",  occ:"YTD Occupancy",  occ_chg:"YTD Occupancy Chg",  supply:"YTD Supply",  demand:"YTD Demand",  revenue:"YTD Revenue"   },
];

const C_NATIVE_SLICES = ["All","Economy","Midscale","Upper Midscale","Upscale","Upper Upscale","Luxury","Midscale & Economy","Upscale & Upper Midscale","Luxury & Upper Upscale"];

const C_SUPPLY_COLS = [
  {key:"inv_rooms",          label:"Inv Rooms",    fmt:v=>fmt.int(v)},
  {key:"exist_bldgs",        label:"Bldgs",        fmt:v=>fmt.int(v)},
  {key:"avg_rooms_per_bldg", label:"Avg Rms/Bldg", fmt:v=>fmt.dec1(v)},
  {key:"del_rooms",          label:"Del Rooms",    fmt:v=>fmt.int(v)},
  {key:"inv_growth",         label:"Inv Growth",   fmt:v=>fmt.invGrowth(v), isChg:true},
  {key:"opened_rooms",       label:"Opened Rms",   fmt:v=>fmt.int(v)},
  {key:"opened_bldgs",       label:"Opened Bldgs", fmt:v=>fmt.int(v)},
  {key:"uc_rooms",           label:"UC Rooms",     fmt:v=>fmt.int(v)},
  {key:"uc_bldgs",           label:"UC Bldgs",     fmt:v=>fmt.int(v)},
];
const C_PERF_COLS = [
  {key:"occ",    label:"Occupancy",fmt:v=>fmt.occ(v),   chgKey:"occ_chg",   chgFmt:v=>fmt.pp(v),  isOcc:true},
  {key:"adr",    label:"ADR",      fmt:v=>fmt.dollar(v),chgKey:"adr_chg",   chgFmt:v=>fmt.pct(v)},
  {key:"revpar", label:"RevPAR",   fmt:v=>fmt.dollar(v),chgKey:"revpar_chg",chgFmt:v=>fmt.pct(v)},
];
const C_CAP_COLS = [
  {key:"sale_price_room",label:"Sale $/Room",fmt:v=>fmt.dollarK(v)},
  {key:"sales_vol",      label:"Sales Vol",  fmt:v=>fmt.dollarM(v)},
  {key:"cap_rate",       label:"Cap Rate",   fmt:v=>fmt.capRate(v)},
];
const C_COL_GROUPS = {
  supply:{label:"Supply & Pipeline",color:"#1d4ed8",accent:"#3b82f6",cols:C_SUPPLY_COLS},
  perf:  {label:"Performance",      color:"#065f46",accent:"#10b981",cols:C_PERF_COLS},
  cap:   {label:"Capital Markets",  color:"#7c2d12",accent:"#f97316",cols:C_CAP_COLS},
};
const C_SORT_OPTIONS = [
  {value:"revpar",label:"RevPAR"},{value:"occ",label:"Occupancy"},{value:"adr",label:"ADR"},
  {value:"revpar_chg",label:"RevPAR Δ"},{value:"occ_chg",label:"Occ Δ"},{value:"adr_chg",label:"ADR Δ"},
  {value:"inv_rooms",label:"Inv Rooms"},{value:"uc_rooms",label:"UC Rooms"},
  {value:"inv_growth",label:"Inv Growth"},{value:"cap_rate",label:"Cap Rate"},
  {value:"sale_price_room",label:"Sale $/Room"},{value:"sales_vol",label:"Sales Vol"},
];
const C_CAGR_SORT = [
  {value:"revpar_cagr",label:"RevPAR CAGR"},{value:"adr_cagr",label:"ADR CAGR"},
  {value:"occ_delta",label:"Occ Δ"},{value:"supply_cagr",label:"Supply CAGR"},
  {value:"demand_cagr",label:"Demand CAGR"},
];
const C_CAGR_CHART = [
  {value:"revpar_cagr", label:"RevPAR CAGR",  fmtFn:v=>fmt.pct(v)},
  {value:"adr_cagr",   label:"ADR CAGR",      fmtFn:v=>fmt.pct(v)},
  {value:"occ_delta",  label:"Occ Δ (pp)",    fmtFn:v=>fmt.pp(v)},
  {value:"supply_cagr",label:"Supply CAGR",   fmtFn:v=>fmt.pct(v)},
  {value:"demand_cagr",label:"Demand CAGR",   fmtFn:v=>fmt.pct(v)},
];
const C_TREND_METRICS = [
  {key:"revpar",         label:"RevPAR",          tick:v=>"$"+v.toFixed(0)},
  {key:"occ",            label:"Occupancy",        tick:v=>(v*100).toFixed(0)+"%"},
  {key:"adr",            label:"ADR",              tick:v=>"$"+v.toFixed(0)},
  {key:"inv_rooms",      label:"Inventory Rooms",  tick:v=>v.toLocaleString()},
  {key:"uc_rooms",       label:"UC Rooms",         tick:v=>v.toLocaleString()},
  {key:"cap_rate",       label:"Cap Rate",         tick:v=>(v*100).toFixed(2)+"%"},
  {key:"sale_price_room",label:"Sale $/Room",      tick:v=>"$"+(v/1000).toFixed(0)+"K"},
];

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label, lastActual, metricKey }) {
  if (!active || !payload?.length) return null;
  const period = payload[0]?.payload?.periodRaw;
  const isForecast = period && period > lastActual;
  const kMetric = K_TREND_METRICS.find(m => m.key === metricKey);
  const formatVal = v => {
    if (v == null || typeof v !== "number") return "—";
    if (kMetric) return kMetric.valFmt(v);
    if (v > 1) return "$" + v.toFixed(2);
    if (v > 0 && v < 0.1) return (v * 100).toFixed(1) + "%";
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
      ? { position:"fixed", left:Math.max(8,left), bottom:viewH - r.top + 4, minWidth:w, zIndex:99999 }
      : { position:"fixed", left:Math.max(8,left), top:r.bottom + 4, minWidth:w, zIndex:99999 }
    );
  }, [open]);
  if (!open || !style) return null;
  return ReactDOM.createPortal(
    <div style={{ ...style, fontFamily:"'DM Sans','Segoe UI',sans-serif" }}>{children}</div>,
    document.body
  );
}

function costarGeoToKey(geoName, geoType, market) {
  const clean = geoName.replace(/ - OH USA$/, "").replace(/ USA$/, "").replace(/ - OH$/, "").trim();
  if (geoType === "Market") {
    const key = `${clean}, OH`;
    if (GEO_COORDS[key]) return key;
    for (const k of Object.keys(GEO_COORDS)) {
      if (!k.includes("::") && k.replace(", OH","").toLowerCase() === clean.toLowerCase()) return k;
    }
  }
  if (geoType === "Submarket" && market) {
    const mktClean = market.replace(/ - OH USA$/, "").replace(/ USA$/, "").replace(/ - OH$/, "").trim();
    const key = `${mktClean}, OH::${clean}`;
    if (GEO_COORDS[key]) return key;
    for (const k of Object.keys(GEO_COORDS)) {
      if (k.includes("::")) {
        const [, sub] = k.split("::");
        if (sub.toLowerCase() === clean.toLowerCase()) return k;
      }
    }
  }
  return null;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function UnifiedDashboard() {
  // ── Source toggle ──
  const [dataSource, setDataSource] = useState("kalibri"); // "kalibri" | "costar"

  // ── Kalibri data ──
  const [kDb,        setKDb]        = useState(null);
  const [kLoading,   setKLoading]   = useState(true);
  const [kLoadError, setKLoadError] = useState(null);

  // ── CoStar data ──
  const [cDb,        setCDb]        = useState(null);
  const [cLoading,   setCLoading]   = useState(true);
  const [cLoadError, setCLoadError] = useState(null);

  // ── Shared state ──
  const [tab,         setTab]         = useState("overview");
  const [geoLevel,    setGeoLevel]    = useState("market");
  const [showForecast,setShowForecast]= useState(false);

  // ── Kalibri filters ──
  const [revType,    setRevType]    = useState("Guest Paid");
  const [tiers,      setTiers]      = useState(["All Tier"]);
  const [losTiers,   setLosTiers]   = useState([""]);
  const [kTimeWindow,setKTimeWindow]= useState("mo");
  const [selectedGeos,setSelectedGeos]= useState([]);
  const [kPeriod1,   setKPeriod1]   = useState("");
  const [kOvStart,   setKOvStart]   = useState("");
  const [kSortKey,   setKSortKey]   = useState("revpar_yoy");
  const [kSortDir,   setKSortDir]   = useState("desc");

  // ── Kalibri trend ──
  const [kTrendMetric, setKTrendMetric] = useState("revpar");
  const [yoyClip,      setYoyClip]      = useState(null);
  const [trendGeoSel,  setTrendGeoSel]  = useState(null);
  const [trendGeoOpen, setTrendGeoOpen] = useState(false);
  const [trendStart,   setTrendStart]   = useState("");
  const [trendEnd,     setTrendEnd]     = useState("");

  // ── Kalibri CAGR ──
  const [kCagrStart,       setKCagrStart]       = useState("");
  const [kCagrEnd,         setKCagrEnd]         = useState("");
  const [kCagrSortKey,     setKCagrSortKey]     = useState("revpar_cagr");
  const [kCagrSortDir,     setKCagrSortDir]     = useState("desc");
  const [kCagrChartMetric, setKCagrChartMetric] = useState("revpar_cagr");

  // ── Kalibri Score ──
  const [scoreRevType,   setScoreRevType]   = useState("Guest Paid");
  const [scoreLos,       setScoreLos]       = useState([""]);
  const [scoreTier,      setScoreTier]      = useState(["Lower", "Mid", "Upper"]);
  const [scoreMetricW,   setScoreMetricW]   = useState({ revpar:1, revpar_cagr:1, occ:1, occ_cagr:1, adr:1, adr_cagr:1, alos:1 });
  const [scoreSupplyW,   setScoreSupplyW]   = useState(0);
  const [scoreCagrStart, setScoreCagrStart] = useState("");
  const [scoreCagrEnd,   setScoreCagrEnd]   = useState("");

  // ── Kalibri supply ──
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
  const [hoveredRow,          setHoveredRow]          = useState(null);

  // ── CoStar properties ──
  const [costarProps, setCostarProps] = useState([]);

  // ── Map ──
  const [mapReady,    setMapReady]    = useState(false);
  const [mapMode,     setMapMode]     = useState("bubbles");
  const [mapCompanies,setMapCompanies]= useState([]);
  const [mapBrands,   setMapBrands]   = useState([]);
  const [mapExtStay,  setMapExtStay]  = useState(false);
  const [drillMkt,    setDrillMkt]    = useState(null);
  const [ccData,      setCcData]      = useState([]);
  const [showCC,      setShowCC]      = useState(false);
  const [ccTypeFilter,setCcTypeFilter]= useState("all");
  const [ccStatuses,  setCcStatuses]  = useState([]);
  const [ccStatusOpen,setCcStatusOpen]= useState(false);

  // ── CoStar supply expanded row ──
  const [costarSupplyExpanded, setCostarSupplyExpanded] = useState(null);

  // ── CoStar supply period selectors ──
  const [supplyPeriod1, setSupplyPeriod1] = useState("");
  const [supplyPeriod2, setSupplyPeriod2] = useState("");

  // ── CoStar filters ──
  const [slice,       setSlice]       = useState("All");
  const [cMktFilter,  setCMktFilter]  = useState("All");
  const [cTimeWindow, setCTimeWindow] = useState("12mo");
  const [cPeriod1,    setCPeriod1]    = useState("");
  const [cPeriod2,    setCPeriod2]    = useState("");
  const [visGroups,   setVisGroups]   = useState({supply:true,perf:true,cap:true});
  const [cSortCol,    setCSortCol]    = useState("revpar_chg");
  const [cSortDir,    setCSortDir]    = useState("desc");

  // ── CoStar CAGR ──
  const [cCagrStart,       setCCagrStart]       = useState("");
  const [cCagrEnd,         setCCagrEnd]         = useState("");
  const [cCagrSortCol,     setCCagrSortCol]     = useState("revpar_cagr");
  const [cCagrSortDir,     setCCagrSortDir]     = useState("desc");
  const [cCagrChartMetric, setCCagrChartMetric] = useState("revpar_cagr");

  // ── CoStar trend ──
  const [cTrendMetric, setCTrendMetric] = useState("revpar");

  // ── Refs ──
  const mapInstanceRef   = useRef(null);
  const trendGeoRef      = useRef(null);
  const supplyCompanyRef = useRef(null);
  const supplyBrandRef   = useRef(null);
  const ccStatusRef      = useRef(null);

  // ── Load both data sources at mount ──
  useEffect(() => {
    loadKalibriData()
      .then(d => {
        setKDb(d);
        setKLoading(false);
        const allP = Object.keys(d.lookup).sort();
        const latest = allP.filter(p => p <= d.lastActual).pop() || allP[allP.length - 1];
        const [y, mo] = latest.split("-");
        setKPeriod1(latest);
        setKCagrEnd(latest);
        setKCagrStart(allP.includes(`${parseInt(y)-6}-${mo}`) ? `${parseInt(y)-6}-${mo}` : allP[0]);
        const threeYrPrior = `${parseInt(y)-3}-${mo}`;
        setScoreCagrEnd(latest);
        setScoreCagrStart(allP.includes(threeYrPrior) ? threeYrPrior : allP[0]);
      })
      .catch(e => { setKLoadError(e.message); setKLoading(false); });

    loadCoStarData()
      .then(d => {
        setCDb(d);
        setCLoading(false);
        const allP = Object.keys(d.lookup).sort();
        const latest = allP.filter(p => p <= d.last_actual).pop() || allP[allP.length - 1];
        const [y, mo] = latest.split("-");
        const priorYear = `${parseInt(y)-1}-${mo}`;
        setCPeriod1(latest);
        setCPeriod2(allP.includes(priorYear) ? priorYear : allP[Math.max(0, allP.indexOf(latest)-12)]);
        setSupplyPeriod1(latest);
        const oneYrPrior = `${parseInt(y)-1}-${mo}`;
        setSupplyPeriod2(allP.includes(oneYrPrior) ? oneYrPrior : allP[Math.max(0, allP.indexOf(latest)-12)]);
        const fiveYearPrior = `${parseInt(y)-6}-${mo}`;
        setCCagrEnd(latest);
        setCCagrStart(allP.includes(fiveYearPrior) ? fiveYearPrior : allP[0]);
      })
      .catch(e => { setCLoadError(e.message); setCLoading(false); });

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
          vals.push(cur); return vals;
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
      .catch(() => {});

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

    fetch("/costar_properties.csv")
      .then(r => r.text())
      .then(text => {
        const lines = text.trim().split(/\r?\n/);
        const parseRow = line => { const vals = []; let inQ = false, cur = ""; for (let c = 0; c < line.length; c++) { const ch = line[c]; if (ch === '"') { inQ = !inQ; } else if (ch === "," && !inQ) { vals.push(cur); cur = ""; } else { cur += ch; } } vals.push(cur); return vals; };
        const headers = parseRow(lines[0]).map(h => h.trim());
        const rows = lines.slice(1).map(line => {
          const vals = parseRow(line);
          const row = {};
          headers.forEach((h, i) => row[h] = (vals[i] || "").trim());
          row.Rooms = parseInt(row.Rooms) || 0;
          row.Lat   = parseFloat(row.Lat)  || null;
          row.Lng   = parseFloat(row.Long) || null;
          row.isExtStay = row["Extended Stay"] === "Extended Stay";
          row.parentCompany = row["Parent Company"] || "";
          row.marketName = row["Market Name"] || "";
          row.submarket  = row["Submarket Name"] || "";
          row.hotelClass = row["Hotel Class"] || "";
          return row;
        }).filter(r => r.Lat && r.Lng);
        setCostarProps(rows);
      })
      .catch(() => {});
  }, []);

  // ── Load Leaflet ──
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

  // ── Build / rebuild map ──
  useEffect(() => {
    if (tab !== "map" || !mapReady) return;
    if (dataSource === "kalibri" && !supplyData.length && !costarProps.length) return;
    if (dataSource === "costar"  && !cDb) return;

    let map = null;
    const timer = setTimeout(() => {
      const container = document.getElementById("unified-map");
      if (!container) return;
      const L = window.L;
      map = L.map(container, { zoomControl:true, scrollWheelZoom:true }).setView([40.4173,-82.9071], 7);
      mapInstanceRef.current = map;
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution:'&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>',
        subdomains:"abcd", maxZoom:19,
      }).addTo(map);

      const styleEl = document.createElement("style");
      styleEl.id = "unified-map-style";
      styleEl.textContent = `.map-geo-label{background:transparent!important;border:none!important;box-shadow:none!important;font-size:10px!important;font-weight:700!important;color:#e2e8f0!important;text-shadow:0 1px 4px rgba(0,0,0,0.9)!important;white-space:nowrap!important}.map-geo-label::before{display:none!important}.leaflet-popup-content-wrapper{background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3)}.leaflet-popup-tip{background:#fff}`;
      if (!document.getElementById("unified-map-style")) document.head.appendChild(styleEl);

      const CC_STATUS_COLOR = {
        "Conceptual":"#64748b","Design":"#3b82f6","Final Planning":"#8b5cf6",
        "GC Bidding":"#f59e0b","Sub-Bidding":"#f59e0b","Pre-Construction/Negotiated":"#f97316",
        "Award":"#10b981","Post-Bid":"#10b981","Bid Results":"#10b981","Under Construction":"#22c55e",
      };

      if (dataSource === "kalibri") {
        const TIER_PIN_COLOR = { "Lower Tier":"#ef4444","Mid Tier":"#f59e0b","Upper Tier":"#10b981" };

        if (mapMode === "pins") {
          const CLASS_COLOR = {
            "Economy":"#ef4444","Midscale":"#f97316","Upper Midscale":"#f59e0b",
            "Upscale":"#3b82f6","Upper Upscale":"#8b5cf6","Luxury":"#f0abfc","Independent":"#64748b"
          };
          let filtered = costarProps.filter(r => r.Lat && r.Lng);
          // Geo filter
          if (selectedGeos.length > 0) {
            if (geoLevel === "market") {
              filtered = filtered.filter(r => selectedGeos.some(g => r.marketName.includes(g.replace(", OH","")) || g.includes(r.marketName)));
            } else {
              filtered = filtered.filter(r => selectedGeos.some(g => {
                const [mkt] = g.split("::");
                return r.marketName.includes(mkt.replace(", OH","")) || mkt.includes(r.marketName);
              }));
            }
          }
          if (mapExtStay)              filtered = filtered.filter(r => r.isExtStay);
          if (mapCompanies.length > 0) filtered = filtered.filter(r => mapCompanies.includes(r.parentCompany));
          if (mapBrands.length > 0)    filtered = filtered.filter(r => mapBrands.includes(r.Brand));
          filtered.forEach(r => {
            const color = CLASS_COLOR[r.hotelClass] || "#64748b";
            const marker = L.circleMarker([r.Lat, r.Lng], {
              radius:5, fillColor:color, color:"#000", weight:0.5, opacity:0.9, fillOpacity:0.85,
            }).addTo(map);
            marker.bindPopup(`<div style="font-family:sans-serif;min-width:200px;padding:4px">
      <div style="font-size:13px;font-weight:700;margin-bottom:4px">${r["Property Name"]}</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:6px">${r.submarket||r.marketName}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:${color}22;color:${color}">${r.hotelClass}</span>
        ${r.isExtStay?'<span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:#8b5cf622;color:#8b5cf6">Extended Stay</span>':""}
      </div>
      <table style="font-size:11px;width:100%;border-collapse:collapse">
        <tr><td style="color:#64748b;padding:2px 8px 2px 0">Brand</td><td style="font-weight:500">${r.Brand||"Independent"}</td></tr>
        <tr><td style="color:#64748b;padding:2px 8px 2px 0">Parent Company</td><td>${r.parentCompany||"—"}</td></tr>
        <tr><td style="color:#64748b;padding:2px 8px 2px 0">Rooms</td><td><b>${r.Rooms}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 8px 2px 0">Operation</td><td>${r["Operation Type"]||"—"}</td></tr>
      </table></div>`);
          });
          const legend = L.control({ position:"bottomright" });
          legend.onAdd = () => {
            const div = L.DomUtil.create("div");
            const shown = mapBrands.length > 0 ? mapBrands.length + " brand(s)" : mapExtStay ? "Extended Stay" : "All brands";
            div.innerHTML = `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:11px;color:#94a3b8">
      <div style="font-weight:700;color:#e2e8f0;margin-bottom:8px;font-size:10px;text-transform:uppercase;letter-spacing:1px">${filtered.length} properties · ${shown}</div>
      ${Object.entries(CLASS_COLOR).map(([cl,c])=>`<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="${c}" fill-opacity="0.85" stroke="#000" stroke-width="0.5"/></svg><span style="color:${c}">${cl}</span></div>`).join("")}
    </div>`;
            return div;
          };
          legend.addTo(map);
        } else {
          // Kalibri bubbles
          const geoMap = {};
          for (const r of supplyData) {
            if (selectedGeos.length > 0) {
              if (geoLevel === "market" && !selectedGeos.includes(r.Market)) continue;
              if (geoLevel === "submarket") {
                const k = r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market;
                if (!selectedGeos.includes(k)) continue;
              }
            }
            const key = geoLevel === "market" ? r.Market : (r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market);
            if (!geoMap[key]) geoMap[key] = {
              name: geoLevel === "market" ? r.Market.replace(", OH","") : (r.Submarket || r.Market.replace(", OH","")),
              market:r.Market, totalRooms:0, totalProps:0, filteredRooms:0, filteredProps:0, tiers:{},
            };
            const tierMatch = tiers[0] === "All Tier" || tiers.includes(r.Tier);
            geoMap[key].totalRooms += r.Rooms; geoMap[key].totalProps += 1;
            if (!geoMap[key].tiers[r.Tier]) geoMap[key].tiers[r.Tier] = { rooms:0, props:0 };
            geoMap[key].tiers[r.Tier].rooms += r.Rooms; geoMap[key].tiers[r.Tier].props += 1;
            if (tierMatch) { geoMap[key].filteredRooms += r.Rooms; geoMap[key].filteredProps += 1; }
          }
          const geos = Object.entries(geoMap).filter(([k]) => GEO_COORDS[k] && geoMap[k].filteredRooms > 0);
          const maxRooms = Math.max(...geos.map(([,g]) => g.filteredRooms), 1);
          const tierColor = tiers[0]==="All Tier"?"#3b82f6":tiers.length===1&&tiers[0]==="Lower Tier"?"#ef4444":tiers.length===1&&tiers[0]==="Mid Tier"?"#f59e0b":tiers.length===1&&tiers[0]==="Upper Tier"?"#10b981":"#8b5cf6";
          for (const [key, geo] of geos) {
            const [lat, lng] = GEO_COORDS[key];
            const radius = Math.max(8, Math.sqrt(geo.filteredRooms / maxRooms) * 42);
            const lower  = geo.tiers["Lower Tier"] || { rooms:0, props:0 };
            const mid    = geo.tiers["Mid Tier"]   || { rooms:0, props:0 };
            const upper  = geo.tiers["Upper Tier"] || { rooms:0, props:0 };
            const circle = L.circleMarker([lat, lng], {
              radius, fillColor:tierColor, color:"#ffffff", weight:1.5, opacity:0.9, fillOpacity:0.55,
            }).addTo(map);
            circle.bindPopup(`<div style="font-family:sans-serif;min-width:220px;padding:4px">
              <div style="font-size:14px;font-weight:700;margin-bottom:4px">${geo.name}</div>
              ${geoLevel==="submarket"?`<div style="font-size:11px;color:#64748b;margin-bottom:6px">${geo.market}</div>`:""}
              <div style="font-size:12px;margin-bottom:8px"><b>${geo.totalRooms.toLocaleString()}</b> total rooms · <b>${geo.totalProps}</b> properties</div>
              <table style="font-size:11px;border-collapse:collapse;width:100%">
                <tr style="color:#64748b;border-bottom:1px solid #e2e8f0"><th style="text-align:left;padding:3px 8px 3px 0">Tier</th><th style="text-align:right;padding:3px 4px">Rooms</th><th style="text-align:right;padding:3px 0 3px 8px">Props</th></tr>
                <tr><td style="padding:3px 8px 3px 0;color:#ef4444;font-weight:500">Lower</td><td style="text-align:right;padding:3px 4px">${lower.rooms.toLocaleString()}</td><td style="text-align:right;padding:3px 0 3px 8px">${lower.props}</td></tr>
                <tr><td style="padding:3px 8px 3px 0;color:#f59e0b;font-weight:500">Mid</td><td style="text-align:right;padding:3px 4px">${mid.rooms.toLocaleString()}</td><td style="text-align:right;padding:3px 0 3px 8px">${mid.props}</td></tr>
                <tr><td style="padding:3px 8px 3px 0;color:#10b981;font-weight:500">Upper</td><td style="text-align:right;padding:3px 4px">${upper.rooms.toLocaleString()}</td><td style="text-align:right;padding:3px 0 3px 8px">${upper.props}</td></tr>
              </table></div>`);
            if (geoLevel === "market") {
              circle.bindTooltip(geo.name, { permanent:true, direction:"top", className:"map-geo-label", offset:[0,-(radius+2)] });
            }
          }
          const legend = L.control({ position:"bottomright" });
          legend.onAdd = () => {
            const div = L.DomUtil.create("div");
            const sizes = [[maxRooms,"Max"],[Math.round(maxRooms*0.5),"50%"],[Math.round(maxRooms*0.25),"25%"]];
            div.innerHTML = `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:11px;color:#94a3b8">
              <div style="font-weight:700;color:#e2e8f0;margin-bottom:2px;font-size:10px;text-transform:uppercase;letter-spacing:1px">Rooms</div>
              <div style="font-size:9px;color:#475569;margin-bottom:8px">bubble size = room count</div>
              ${sizes.map(([r,lbl])=>{ const px=Math.max(8,Math.sqrt(r/maxRooms)*42); return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><svg width="${px*2+2}" height="${px*2+2}" style="flex-shrink:0"><circle cx="${px+1}" cy="${px+1}" r="${px}" fill="${tierColor}" fill-opacity="0.55" stroke="#fff" stroke-width="1.5"/></svg><span>${r.toLocaleString()} <span style="color:#475569">${lbl}</span></span></div>`; }).join("")}
            </div>`;
            return div;
          };
          legend.addTo(map);
        }
      } else {
        // ── CoStar bubbles ──
        const cTw = C_TIME_WINDOWS.find(t => t.id === cTimeWindow) || C_TIME_WINDOWS[0];
        const csLevel = geoLevel === "market" ? "Market" : "Submarket";
        const geoEntries = cDb ? Object.entries(cDb.geo_meta).filter(([,v]) => v.geo_type === csLevel) : [];
        const roomsByGeo = {};
        for (const [geoName, meta] of geoEntries) {
          const m = getMetricsC(cDb.lookup, cPeriod1, geoName, slice, cTw);
          if (!m?.inv_rooms) continue;
          const geoKey = costarGeoToKey(geoName, meta.geo_type, meta.market);
          if (!geoKey || !GEO_COORDS[geoKey]) continue;
          roomsByGeo[geoKey] = { geoKey, geoName, inv_rooms: m.inv_rooms, meta };
        }
        const geos = Object.values(roomsByGeo);
        const maxRooms = Math.max(...geos.map(g => g.inv_rooms), 1);
        for (const g of geos) {
          const [lat, lng] = GEO_COORDS[g.geoKey];
          const radius = Math.max(8, Math.sqrt(g.inv_rooms / maxRooms) * 42);
          const displayName = g.geoKey.includes("::") ? g.geoKey.split("::")[1] : g.geoKey.replace(", OH","");
          const circle = L.circleMarker([lat, lng], {
            radius, fillColor:"#f59e0b", color:"#ffffff", weight:1.5, opacity:0.9, fillOpacity:0.55,
          }).addTo(map);
          circle.bindPopup(`<div style="font-family:sans-serif;min-width:200px;padding:4px">
            <div style="font-size:14px;font-weight:700;margin-bottom:4px">${displayName}</div>
            <div style="font-size:12px;color:#475569;margin-bottom:6px">${g.geoName}</div>
            <div style="font-size:12px"><b>${g.inv_rooms.toLocaleString()}</b> inventory rooms</div>
          </div>`);
          if (geoLevel === "market") {
            circle.bindTooltip(displayName, { permanent:true, direction:"top", className:"map-geo-label", offset:[0,-(radius+2)] });
          }
        }
        const legend = L.control({ position:"bottomright" });
        legend.onAdd = () => {
          const div = L.DomUtil.create("div");
          const sizes = [[maxRooms,"Max"],[Math.round(maxRooms*0.5),"50%"],[Math.round(maxRooms*0.25),"25%"]];
          div.innerHTML = `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:11px;color:#94a3b8">
            <div style="font-weight:700;color:#e2e8f0;margin-bottom:2px;font-size:10px;text-transform:uppercase;letter-spacing:1px">CoStar Inv Rooms</div>
            <div style="font-size:9px;color:#475569;margin-bottom:8px">bubble size = inventory rooms · ${periodLabel(cPeriod1)}</div>
            ${sizes.map(([r,lbl])=>{ const px=Math.max(8,Math.sqrt(r/maxRooms)*42); return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><svg width="${px*2+2}" height="${px*2+2}" style="flex-shrink:0"><circle cx="${px+1}" cy="${px+1}" r="${px}" fill="#f59e0b" fill-opacity="0.55" stroke="#fff" stroke-width="1.5"/></svg><span>${r.toLocaleString()} <span style="color:#475569">${lbl}</span></span></div>`; }).join("")}
          </div>`;
          return div;
        };
        legend.addTo(map);
      }

      // ── CC layer (both sources) ──
      if (showCC && ccData.length) {
        const fmtVal = v => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(0)}K` : v ? `$${v}` : "—";
        let ccFiltered = ccData;
        if (ccTypeFilter === "hotel")   ccFiltered = ccFiltered.filter(r => r.HasHotel   === "TRUE");
        if (ccTypeFilter === "elderly") ccFiltered = ccFiltered.filter(r => r.HasElderly === "TRUE");
        if (ccStatuses.length > 0)      ccFiltered = ccFiltered.filter(r => ccStatuses.includes(r.Status));
        ccFiltered.forEach(r => {
          const color = CC_STATUS_COLOR[r.Status] || "#64748b";
          const icon = L.divIcon({
            html:`<div style="width:9px;height:9px;background:${color};transform:rotate(45deg);border:1px solid rgba(0,0,0,0.5);border-radius:1px"></div>`,
            className:"", iconSize:[9,9], iconAnchor:[5,5],
          });
          const marker = L.marker([r.Lat, r.Lng], { icon }).addTo(map);
          marker.bindPopup(`<div style="font-family:sans-serif;min-width:220px;padding:4px">
            <div style="font-size:13px;font-weight:700;margin-bottom:4px">${r.Title}</div>
            <div style="font-size:11px;color:#64748b;margin-bottom:6px">${r.City}, ${r.State}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
              <span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:${color}22;color:${color}">${r.Status}</span>
              ${r.HasHotel==="TRUE"?'<span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:#3b82f622;color:#3b82f6">Hotel</span>':""}
              ${r.HasElderly==="TRUE"?'<span style="font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600;background:#8b5cf622;color:#8b5cf6">Elderly Care</span>':""}
            </div>
            <table style="font-size:11px;border-collapse:collapse;width:100%">
              <tr><td style="color:#64748b;padding:2px 8px 2px 0">Value</td><td style="font-weight:700;color:#10b981">${fmtVal(r.Value)}</td></tr>
              ${r.BidDate?`<tr><td style="color:#64748b;padding:2px 8px 2px 0">Bid Date</td><td>${r.BidDate}</td></tr>`:""}
            </table></div>`);
        });
        const ccLegend = L.control({ position:"bottomleft" });
        ccLegend.onAdd = () => {
          const div = L.DomUtil.create("div");
          const visibleStatuses = [...new Set(ccFiltered.map(r => r.Status))].sort();
          div.innerHTML = `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:sans-serif;font-size:11px;color:#94a3b8;max-width:200px">
            <div style="font-weight:700;color:#e2e8f0;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">CC Projects · ${ccFiltered.length}</div>
            <div style="display:flex;flex-direction:column;gap:3px">
              ${visibleStatuses.map(s=>{ const c=CC_STATUS_COLOR[s]||"#64748b"; return `<div style="display:flex;align-items:center;gap:6px"><div style="width:8px;height:8px;background:${c};transform:rotate(45deg);flex-shrink:0;border-radius:1px"></div><span style="color:${c};font-size:10px">${s}</span></div>`; }).join("")}
            </div></div>`;
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
  }, [tab, mapReady, supplyData, costarProps, cDb, dataSource, geoLevel, selectedGeos, tiers, mapMode,
      mapCompanies, mapBrands, mapExtStay, ccData, showCC, ccTypeFilter, ccStatuses,
      cPeriod1, slice, cTimeWindow]);

  // ── Kalibri computed values ──
  const kPeriods         = useMemo(() => kDb ? Object.keys(kDb.lookup).sort() : [], [kDb]);
  const kLastActual      = useMemo(() => kDb?.lastActual || LAST_ACTUAL_OVERRIDE || "2026-01", [kDb]);
  const kGeoMeta         = useMemo(() => kDb?.geoMeta || {}, [kDb]);
  const kTw              = useMemo(() => K_TIME_WINDOWS.find(t => t.id === kTimeWindow) || K_TIME_WINDOWS[2], [kTimeWindow]);
  const kFilteredPeriods = useMemo(() =>
    showForecast ? kPeriods : kPeriods.filter(p => p <= kLastActual),
    [kPeriods, showForecast, kLastActual]
  );
  const kFilteredGeos = useMemo(() => {
    if (!kDb) return [];
    return Object.entries(kGeoMeta)
      .filter(([k, v]) => {
        if (geoLevel === "market")    return !v.isSubmarket && (selectedGeos.length === 0 || selectedGeos.includes(k));
        if (geoLevel === "submarket") return v.isSubmarket  && (selectedGeos.length === 0 || selectedGeos.includes(k));
        return false;
      })
      .map(([k]) => k).sort();
  }, [kGeoMeta, geoLevel, selectedGeos, kDb]);

  const kIsForecast = p => p > kLastActual;

  const kForecastStartLabel = useMemo(() => {
    const fp = kFilteredPeriods.filter((_,i) => i%3===0 || i===kFilteredPeriods.length-1).find(p => p > kLastActual);
    return fp ? periodLabel(fp) : null;
  }, [kFilteredPeriods, kLastActual]);

  const kOverviewRows = useMemo(() => {
    if (!kDb || !kPeriod1) return [];
    const rows = kFilteredGeos.map(geo => {
      const m = computeTrailing(kDb.lookup, kPeriod1, geo, revType, tiers, losTiers, kTw, kPeriods);
      if (!m) return null;
      const label = kGeoMeta[geo]?.submarket || kGeoMeta[geo]?.market || geo;
      const mkt   = kGeoMeta[geo]?.market || "";
      const [py, pmo] = kPeriod1.split("-");
      const compareDate = kOvStart || `${parseInt(py)-1}-${pmo}`;
      const ms = computeTrailing(kDb.lookup, compareDate, geo, revType, tiers, losTiers, kTw, kPeriods);
      const chg = (v, b, isOcc) => v != null && b != null ? (isOcc ? v - b : (b > 0 ? v / b - 1 : null)) : null;
      const displayM = ms ? {
        ...m,
        occ_yoy:          chg(m.occ,          ms.occ,          true),
        adr_yoy:          chg(m.adr,          ms.adr,          false),
        revpar_yoy:       chg(m.revpar,       ms.revpar,       false),
        booking_cost_yoy: chg(m.booking_cost, ms.booking_cost, false),
        alos_yoy:         chg(m.alos,         ms.alos,         false),
      } : m;
      return { geo, label, mkt, m: displayM };
    }).filter(Boolean);
    const dir = kSortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a.m[kSortKey] ?? null, bv = b.m[kSortKey] ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (bv - av);
    });
    return rows;
  }, [kDb, kFilteredGeos, kPeriod1, kOvStart, revType, tiers, losTiers, kTw, kPeriods, kSortKey, kSortDir]);

  const kTrendData = useMemo(() => {
    if (!kDb || !kFilteredGeos.length || !kPeriod1) return { series:[], chartData:[], top6:[] };
    const trendPeriods = kFilteredPeriods.filter(p => {
      if (trendStart && p < trendStart) return false;
      if (trendEnd   && p > trendEnd)   return false;
      return true;
    });
    const rankPeriod = trendEnd || kPeriod1;
    const top6 = [...kFilteredGeos]
      .map(g => ({ geo:g, val: computeTrailing(kDb.lookup, rankPeriod, g, revType, tiers, losTiers, kTw, kPeriods)?.[kTrendMetric] || 0 }))
      .sort((a, b) => b.val - a.val).slice(0, 6).map(g => g.geo);
    const topGeos = trendGeoSel ? trendGeoSel.filter(g => kFilteredGeos.includes(g)) : top6;
    const isYoY = kTrendMetric.endsWith("_yoy");
    const applyClip = v => (isYoY && yoyClip != null && v != null) ? Math.max(-yoyClip, Math.min(yoyClip, v)) : v;
    const chartData = trendPeriods
      .filter((_,i) => i%3===0 || i===trendPeriods.length-1)
      .map(p => {
        const row = { period: periodLabel(p), periodRaw: p };
        for (const geo of topGeos) {
          const m = computeTrailing(kDb.lookup, p, geo, revType, tiers, losTiers, kTw, kPeriods);
          const lbl = kGeoMeta[geo]?.submarket || kGeoMeta[geo]?.market || geo;
          const raw = m?.[kTrendMetric] != null ? parseFloat(m[kTrendMetric].toFixed(6)) : null;
          row[lbl] = applyClip(raw);
        }
        return row;
      });
    return { series: topGeos.map(g => kGeoMeta[g]?.submarket || kGeoMeta[g]?.market || g), chartData, top6 };
  }, [kDb, kFilteredGeos, kPeriod1, revType, tiers, losTiers, kTw, kPeriods, kTrendMetric, kFilteredPeriods, yoyClip, trendGeoSel, trendStart, trendEnd]);

  const kCagrRows = useMemo(() => {
    if (!kDb || !kCagrStart || !kCagrEnd) return [];
    const [sy, sm] = kCagrStart.split("-"), [ey, em] = kCagrEnd.split("-");
    const years = (parseInt(ey) - parseInt(sy)) + (parseInt(em) - parseInt(sm)) / 12;
    const rows = kFilteredGeos.map(geo => {
      const ms = computeTrailing(kDb.lookup, kCagrStart, geo, revType, tiers, losTiers, kTw, kPeriods);
      const me = computeTrailing(kDb.lookup, kCagrEnd,   geo, revType, tiers, losTiers, kTw, kPeriods);
      if (!ms?.revpar || !me?.revpar) return null;
      const label = kGeoMeta[geo]?.submarket || kGeoMeta[geo]?.market || geo;
      const mkt   = kGeoMeta[geo]?.market || "";
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
    const dir = kCagrSortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[kCagrSortKey] ?? null, bv = b[kCagrSortKey] ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (bv - av);
    });
    return rows;
  }, [kDb, kFilteredGeos, kCagrStart, kCagrEnd, revType, tiers, losTiers, kTw, kPeriods, kCagrSortKey, kCagrSortDir]);

  const kSupplyRows = useMemo(() => {
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
    const tierFilter = tiers.includes("All Tier") ? null : tiers.map(t => t.toLowerCase());
    if (tierFilter) {
      filtered = filtered.filter(r => tierFilter.some(t => r.Tier.toLowerCase().includes(t.replace(" tier",""))));
    }
    if (extStayOnly) filtered = filtered.filter(r => EXTENDED_STAY_BRANDS.has(r.Brand));
    const geoMap = {};
    for (const r of filtered) {
      const geo   = geoLevel === "market" ? r.Market : (r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market);
      const label = geoLevel === "market" ? r.Market : (r.Submarket || r.Market);
      if (!geoMap[geo]) geoMap[geo] = { geo, label, mkt:r.Market, rooms:0, props:0, tiers:{} };
      geoMap[geo].rooms += r.Rooms; geoMap[geo].props += 1;
      const t = r.Tier;
      if (!geoMap[geo].tiers[t]) geoMap[geo].tiers[t] = { rooms:0, props:0 };
      geoMap[geo].tiers[t].rooms += r.Rooms; geoMap[geo].tiers[t].props += 1;
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

  const kSupplyBrands = useMemo(() => {
    if (!expandedGeo || !supplyData.length) return [];
    let filtered = supplyData.filter(r => {
      const geo = geoLevel === "market" ? r.Market : (r.Submarket ? `${r.Market}::${r.Submarket}` : r.Market);
      return geo === expandedGeo;
    });
    if (expandedTier !== "All Tier") filtered = filtered.filter(r => r.Tier === expandedTier);
    const brandMap = {};
    for (const r of filtered) {
      const key = r.Brand || "Independent";
      if (!brandMap[key]) brandMap[key] = { brand:key, company:r.Company, tier:r.Tier, chainClass:r["Chain Class"], rooms:0, props:0, properties:[] };
      brandMap[key].rooms += r.Rooms; brandMap[key].props += 1;
      brandMap[key].properties.push(r.Property);
    }
    let brands = Object.values(brandMap).sort((a, b) => b.rooms - a.rooms);
    if (extStayOnly)                    brands = brands.filter(b => EXTENDED_STAY_BRANDS.has(b.brand));
    if (supplyFilterCompany.length > 0) brands = brands.filter(b => supplyFilterCompany.includes(b.company));
    if (supplyFilterBrand.length > 0)   brands = brands.filter(b => supplyFilterBrand.includes(b.brand));
    return brands;
  }, [expandedGeo, expandedTier, extStayOnly, supplyFilterCompany, supplyFilterBrand, supplyData, geoLevel]);

  const kSupplyCompanies = useMemo(() =>
    [...new Set(supplyData.map(r => r.Company))].filter(Boolean).sort()
  , [supplyData]);

  const kSupplyVisibleBrands = useMemo(() => {
    let rows = supplyData;
    if (extStayOnly)                    rows = rows.filter(r => EXTENDED_STAY_BRANDS.has(r.Brand));
    if (supplyFilterCompany.length > 0) rows = rows.filter(r => supplyFilterCompany.includes(r.Company));
    return [...new Set(rows.map(r => r.Brand))].filter(Boolean).sort();
  }, [supplyData, extStayOnly, supplyFilterCompany]);

  // ── Kalibri Score rows ──
  const kScoreRows = useMemo(() => {
    if (!kDb || !kFilteredGeos.length) return [];
    const endPeriod = kLastActual;
    const TIER_MAP = { "Lower": "Lower Tier", "Mid": "Mid Tier", "Upper": "Upper Tier" };
    const activeTiers = scoreTier.map(t => TIER_MAP[t]).filter(Boolean);
    const activeLos   = scoreLos;
    let cagrYears = 0;
    if (scoreCagrStart && scoreCagrEnd && scoreCagrEnd > scoreCagrStart) {
      const [sy, sm] = scoreCagrStart.split("-");
      const [ey, em] = scoreCagrEnd.split("-");
      cagrYears = (parseInt(ey) - parseInt(sy)) + (parseInt(em) - parseInt(sm)) / 12;
    }
    const twMo = K_TIME_WINDOWS.find(t => t.id === "mo");
    const rawData = kFilteredGeos.map(geo => {
      const m = computeTrailing(kDb.lookup, endPeriod, geo, scoreRevType, activeTiers, activeLos, kTw, kPeriods);
      const revpar = m?.revpar ?? null;
      const occ    = m?.occ    ?? null;
      const adr    = m?.adr    ?? null;
      const alos   = m?.alos   ?? null;
      let revpar_cagr = null, occ_cagr = null, adr_cagr = null;
      if (cagrYears > 0 && scoreCagrStart && scoreCagrEnd) {
        const ms = computeTrailing(kDb.lookup, scoreCagrStart, geo, scoreRevType, activeTiers, activeLos, twMo, kPeriods);
        const me = computeTrailing(kDb.lookup, scoreCagrEnd,   geo, scoreRevType, activeTiers, activeLos, twMo, kPeriods);
        revpar_cagr = calcCAGR(ms?.revpar, me?.revpar, cagrYears);
        occ_cagr    = ms?.occ != null && me?.occ != null && ms.occ > 0 ? Math.pow(me.occ / ms.occ, 1 / cagrYears) - 1 : null;
        adr_cagr    = calcCAGR(ms?.adr,    me?.adr,    cagrYears);
      }
      const tierKeys = scoreTier.map(t => TIER_MAP[t]).filter(Boolean);
      let rooms = null;
      if (tierKeys.length > 0) {
        const totalRooms = tierKeys.reduce((s, tk) => s + (SUPPLY[geo]?.[tk]?.rooms || 0), 0);
        rooms = totalRooms > 0 ? totalRooms : null;
      }
      if (rooms == null) rooms = SUPPLY[geo]?.["All Tier"]?.rooms || null;
      const label = kGeoMeta[geo]?.submarket || kGeoMeta[geo]?.market || geo;
      const mkt   = kGeoMeta[geo]?.market || "";
      return { geo, label, mkt, revpar, revpar_cagr, occ, occ_cagr, adr, adr_cagr, alos, rooms };
    });
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
    const mwKeys = Object.keys(scoreMetricW);
    const mwSum = mwKeys.reduce((s, k) => s + (scoreMetricW[k] || 0), 0);
    const normMetricW = {};
    mwKeys.forEach(k => { normMetricW[k] = mwSum > 0 ? (scoreMetricW[k] || 0) / mwSum : 1 / mwKeys.length; });
    const supplyEffectiveW = Math.abs(scoreSupplyW);
    const scored = rawData.map(r => {
      const ns = {};
      normKeys.forEach(k => { ns[k] = normalize(r[k], k); });
      const supplyNorm = ns.rooms != null
        ? (scoreSupplyW >= 0 ? ns.rooms : 100 - ns.rooms)
        : null;
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
  }, [kDb, kFilteredGeos, kPeriods, kTw, kLastActual, scoreRevType, scoreLos, scoreTier, scoreMetricW, scoreSupplyW, scoreCagrStart, scoreCagrEnd]);

  // ── CoStar computed values ──
  const cPeriods         = useMemo(() => cDb ? Object.keys(cDb.lookup).sort() : [], [cDb]);
  const cLastActual      = useMemo(() => cDb?.last_actual || "2026-01", [cDb]);
  const cGeoMeta         = useMemo(() => cDb?.geo_meta || {}, [cDb]);
  const cTw              = useMemo(() => C_TIME_WINDOWS.find(t => t.id === cTimeWindow) || C_TIME_WINDOWS[0], [cTimeWindow]);
  const cFilteredPeriods = useMemo(() =>
    showForecast ? cPeriods : cPeriods.filter(p => p <= cLastActual),
    [cPeriods, showForecast, cLastActual]
  );
  const cMarkets = useMemo(() =>
    [...new Set(Object.values(cGeoMeta).map(g => g.market).filter(Boolean))].sort()
  , [cGeoMeta]);
  const cFilteredGeos = useMemo(() => {
    if (!cDb) return [];
    const csLevel = geoLevel === "market" ? "Market" : "Submarket";
    return Object.entries(cGeoMeta)
      .filter(([,v]) => v.geo_type === csLevel && (cMktFilter === "All" || v.market === cMktFilter))
      .map(([k]) => k).sort();
  }, [cGeoMeta, geoLevel, cMktFilter, cDb]);

  const cIsForecast = p => p > cLastActual;
  const cForecastStartLabel = useMemo(() => {
    const fp = cFilteredPeriods.filter((_,i) => i%3===0 || i===cFilteredPeriods.length-1).find(p => p > cLastActual);
    return fp ? periodLabel(fp) : null;
  }, [cFilteredPeriods, cLastActual]);

  const cVisibleCols = useMemo(() =>
    Object.entries(C_COL_GROUPS).filter(([g]) => visGroups[g]).flatMap(([,{cols}]) => cols)
  , [visGroups]);

  const cVisGroupSpans = useMemo(() =>
    Object.entries(C_COL_GROUPS).filter(([g]) => visGroups[g]).map(([g,{label,color,accent,cols}]) => ({
      g, label, color, accent,
      span: cols.reduce((a,c) => a + (c.chgKey ? 2 : 1), 0)
    }))
  , [visGroups]);

  const cCompTable = useMemo(() => {
    if (!cDb) return [];
    const rows = cFilteredGeos.map(geo => {
      const m1 = getMetricsC(cDb.lookup, cPeriod1, geo, slice, cTw);
      const m2 = getMetricsC(cDb.lookup, cPeriod2, geo, slice, cTw);
      const subName = cGeoMeta[geo]?.submarket || cGeoMeta[geo]?.market || geo;
      const mkt = (cGeoMeta[geo]?.market || "").replace(" - OH USA","").replace(" USA","");
      const occ_chg    = (m1?.occ!=null && m2?.occ!=null)             ? m1.occ - m2.occ           : (m1?.occ_chg    ?? null);
      const adr_chg    = (m1?.adr!=null && m2?.adr!=null && m2.adr>0) ? m1.adr / m2.adr - 1       : (m1?.adr_chg    ?? null);
      const revpar_chg = (m1?.revpar!=null && m2?.revpar!=null && m2.revpar>0) ? m1.revpar/m2.revpar-1 : (m1?.revpar_chg ?? null);
      const m1e = m1 ? { ...m1, occ_chg, adr_chg, revpar_chg } : null;
      return { geo, subName, mkt, m1:m1e, m2 };
    }).filter(r => r.m1 != null);
    const dir = cSortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a.m1?.[cSortCol] ?? null, bv = b.m1?.[cSortCol] ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (bv - av);
    });
    return rows;
  }, [cDb, cFilteredGeos, cPeriod1, cPeriod2, slice, cTw, cSortCol, cSortDir]);

  const cCagrTable = useMemo(() => {
    if (!cDb) return [];
    const p1p = cCagrStart.split("-"), p2p = cCagrEnd.split("-");
    const years = (parseInt(p2p[0]) - parseInt(p1p[0])) + (parseInt(p2p[1]) - parseInt(p1p[1])) / 12;
    const rows = cFilteredGeos.map(geo => {
      const ms = getMetricsC(cDb.lookup, cCagrStart, geo, slice, cTw);
      const me = getMetricsC(cDb.lookup, cCagrEnd,   geo, slice, cTw);
      const subName = cGeoMeta[geo]?.submarket || cGeoMeta[geo]?.market || geo;
      const mkt = (cGeoMeta[geo]?.market || "").replace(" - OH USA","").replace(" USA","");
      return {
        geo, subName, mkt, ms, me, years,
        revpar_cagr:  calcCAGR(ms?.revpar,  me?.revpar,  years),
        adr_cagr:     calcCAGR(ms?.adr,     me?.adr,     years),
        occ_delta:    ms?.occ!=null && me?.occ!=null ? me.occ - ms.occ : null,
        supply_cagr:  calcCAGR(ms?.supply,  me?.supply,  years),
        demand_cagr:  calcCAGR(ms?.demand,  me?.demand,  years),
      };
    }).filter(r => r.ms?.revpar != null && r.me?.revpar != null);
    const dir = cCagrSortDir === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[cCagrSortCol] ?? null, bv = b[cCagrSortCol] ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (bv - av);
    });
    return rows;
  }, [cDb, cFilteredGeos, cCagrStart, cCagrEnd, slice, cTw, cCagrSortCol, cCagrSortDir]);

  const cTrendData = useMemo(() => {
    if (!cDb || !cFilteredGeos.length) return { series:[], chartData:[] };
    const topGeos = [...cFilteredGeos]
      .map(g => ({ geo:g, val: getMetricsC(cDb.lookup, cPeriod1, g, slice, cTw)?.[cTrendMetric] || 0 }))
      .sort((a, b) => b.val - a.val).slice(0, 6).map(g => g.geo);
    const chartData = cFilteredPeriods.filter((_,i) => i%3===0 || i===cFilteredPeriods.length-1).map(p => {
      const row = { period: periodLabel(p), periodRaw: p };
      for (const geo of topGeos) {
        const m = getMetricsC(cDb.lookup, p, geo, slice, cTw);
        const lbl = cGeoMeta[geo]?.submarket || cGeoMeta[geo]?.market || geo;
        const val = m?.[cTrendMetric];
        row[lbl] = val != null ? parseFloat(parseFloat(val).toFixed(4)) : null;
      }
      return row;
    });
    return { series: topGeos.map(g => cGeoMeta[g]?.submarket || cGeoMeta[g]?.market || g), chartData };
  }, [cDb, cFilteredGeos, cPeriod1, slice, cTw, cFilteredPeriods, cTrendMetric]);

  // ── Style helpers ──
  const PILL_ROW = { display:"flex", gap:3, flexWrap:"nowrap", overflowX:"auto", overflowY:"hidden", padding:"4px 6px", background:"#0a1628", border:"1px solid #1e293b", borderRadius:6, marginTop:3, height:28, alignItems:"center" };
  const sel = { background:"#1e293b", border:"1px solid #334155", color:"#f1f5f9", borderRadius:6, padding:"0 10px", height:28, fontSize:11, outline:"none", cursor:"pointer" };
  const btnBase = { padding:"0 12px", height:28, borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:600, display:"inline-flex", alignItems:"center", justifyContent:"center", whiteSpace:"nowrap" };
  const Btn = ({ active, onClick, children, color="#6366f1", style={} }) => (
    <button onClick={onClick} style={{ ...btnBase, background:active?color:"#1e293b", color:active?"#fff":"#64748b", border:active?"none":"1px solid #334155", ...style }}>{children}</button>
  );
  const label9 = { fontSize:9, color:"#475569", textTransform:"uppercase", letterSpacing:1 };

  const kGetSupply = geo => {
    if (tiers.length === 1) return SUPPLY[geo]?.[tiers[0]] || null;
    const items = tiers.map(t => SUPPLY[geo]?.[t]).filter(Boolean);
    if (!items.length) return null;
    return { rooms: items.reduce((s,v) => s + v.rooms, 0), props: items.reduce((s,v) => s + v.props, 0) };
  };

  const kPerfColSpan = K_METRICS.reduce((a, m) => a + (m.yoyKey ? 2 : 1), 0);
  const MKT_W  = 160, SUB_W = 100;

  // ── Loading / error ──
  const isLoading = kLoading || cLoading;
  const loadError = kLoadError || cLoadError;

  if (loadError) return (
    <div style={{ background:"#0f172a", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'IBM Plex Mono',monospace", padding:40 }}>
      <div style={{ maxWidth:560, textAlign:"center" }}>
        <div style={{ fontSize:28, marginBottom:12, color:"#ef4444" }}>⚠</div>
        <div style={{ color:"#f87171", fontWeight:700, fontSize:14, marginBottom:12 }}>Could not load data</div>
        <div style={{ color:"#475569", fontSize:11, lineHeight:1.7, marginBottom:20, textAlign:"left", background:"#1e293b", borderRadius:8, padding:"14px 18px", border:"1px solid #334155" }}>{loadError}</div>
        {kLoadError && <div style={{ color:"#64748b", fontSize:10, marginBottom:4 }}>Kalibri: ohio_kalibri_consolidated.csv in /public</div>}
        {cLoadError && <div style={{ color:"#64748b", fontSize:10 }}>CoStar: ohio_costar.csv in /public</div>}
      </div>
    </div>
  );

  if (isLoading) return (
    <div style={{ background:"#0f172a", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"monospace" }}>
      <div style={{ textAlign:"center", color:"#475569" }}>
        <div style={{ fontSize:28, marginBottom:10, animation:"spin 1.5s linear infinite", display:"inline-block" }}>⟳</div>
        <div style={{ marginTop:8 }}>Loading data…</div>
        <div style={{ fontSize:10, color:"#334155", marginTop:6 }}>
          {kLoading && <div>Kalibri: {KALIBRI_URL}</div>}
          {cLoading && <div>CoStar: {COSTAR_URL}</div>}
        </div>
      </div>
    </div>
  );

  // ── Render ──
  return (
    <div style={{ background:"#0f172a", height:"100vh", overflow:"hidden", display:"flex", flexDirection:"column", fontFamily:"'DM Sans','Segoe UI',sans-serif", color:"#e2e8f0" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* ── Header ── */}
      <div style={{ background:"#0f172a", borderBottom:"1px solid #1e293b", padding:"10px 28px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <img src="https://images.squarespace-cdn.com/content/v1/634ecc23e6a1eb0116ad3e64/b7f36457-07a7-4f6f-94fb-081608156032/SGHC+LogoDeck_MainWH.png" alt="Spark GHC" style={{ height:32, objectFit:"contain" }}/>
          <div style={{ width:1, height:28, background:"#1e293b" }}/>
          <div style={{ fontSize:15, fontWeight:700, color:"#f8fafc", letterSpacing:-0.3, whiteSpace:"nowrap" }}>Ohio Hospitality Analytics</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          {/* Source toggle */}
          <div style={{ display:"flex", background:"#1e293b", borderRadius:7, padding:2, border:"1px solid #334155" }}>
            <button onClick={() => setDataSource("kalibri")}
              style={{ ...btnBase, padding:"0 14px", borderRadius:5, background:dataSource==="kalibri"?"#6366f1":"transparent", color:dataSource==="kalibri"?"#fff":"#64748b", border:"none" }}>
              Kalibri Labs
            </button>
            <button onClick={() => setDataSource("costar")}
              style={{ ...btnBase, padding:"0 14px", borderRadius:5, background:dataSource==="costar"?"#f59e0b":"transparent", color:dataSource==="costar"?"#fff":"#64748b", border:"none" }}>
              CoStar
            </button>
          </div>
          {/* Source badge */}
          {dataSource === "kalibri" ? (
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"#3b82f611", border:"1px solid #3b82f633", borderRadius:6, padding:"4px 10px" }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"#3b82f6" }}/>
              <span style={{ fontSize:10, color:"#3b82f6", fontFamily:"'IBM Plex Mono',monospace" }}>Kalibri Labs · Guest Paid / Hotel Collected / COPE</span>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"#f59e0b11", border:"1px solid #f59e0b33", borderRadius:6, padding:"4px 10px" }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"#f59e0b" }}/>
              <span style={{ fontSize:10, color:"#f59e0b", fontFamily:"'IBM Plex Mono',monospace" }}>CoStar Base Case Forecast → Mar 2031</span>
            </div>
          )}
          <div style={{ fontSize:10, color:"#334155", fontFamily:"'IBM Plex Mono',monospace" }}>
            Last Actual: <span style={{ color:"#94a3b8" }}>{periodLabel(dataSource==="kalibri" ? kLastActual : cLastActual)}</span>
          </div>
          <div style={{ width:1, height:28, background:"#1e293b" }}/>
          <div style={{ display:"flex", gap:2 }}>
            {[["overview","Overview"],["trend","Trend"],["cagr","CAGR"],["supply","Supply"],["map","Map"],
              ...(dataSource === "kalibri" ? [["score","Score"]] : [])
            ].map(([id,lbl]) => (
              <Btn key={id} active={tab===id} onClick={() => setTab(id)} color={id==="score"?"#10b981":"#6366f1"}>{lbl}</Btn>
            ))}
          </div>
        </div>
      </div>

      {/* ── Controls Bar ── */}
      <div style={{ padding:"8px 28px", background:"#111827", borderBottom:"1px solid #1e293b", display:"flex", flexWrap:"wrap", gap:10, alignItems:"flex-end", flexShrink:0 }}>
        {dataSource === "kalibri" ? (
          <>
            {tab !== "supply" && tab !== "map" && tab !== "score" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Revenue Type</label>
                <div style={{ display:"flex", gap:2 }}>
                  {K_REV_TYPES.map(rt => <Btn key={rt} active={revType===rt} onClick={() => setRevType(rt)} color="#6366f1">{rt}</Btn>)}
                </div>
              </div>
            )}
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              <label style={label9}>Hotel Class</label>
              <div style={{ display:"flex", gap:2 }}>
                {K_TIERS.map(t => {
                  const isAll = t === "All Tier";
                  const active = isAll ? tiers[0] === "All Tier" : tiers.includes(t);
                  return (
                    <Btn key={t} active={active} onClick={() => {
                      if (isAll) { setTiers(["All Tier"]); return; }
                      setTiers(prev => {
                        const without = prev.filter(v => v !== "All Tier" && v !== t);
                        if (prev.includes(t)) return without.length ? without : ["All Tier"];
                        return [...prev.filter(v => v !== "All Tier"), t];
                      });
                    }} color="#6366f1">{t.replace(" Tier","")}</Btn>
                  );
                })}
              </div>
            </div>
            {tab !== "supply" && tab !== "map" && tab !== "score" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Length of Stay</label>
                <div style={{ display:"flex", gap:2 }}>
                  {K_LOS_OPTIONS.map(l => {
                    const isOv = l.value === "";
                    const active = isOv ? losTiers[0] === "" : losTiers.includes(l.value);
                    return (
                      <Btn key={l.value} active={active} onClick={() => {
                        if (isOv) { setLosTiers([""]); return; }
                        setLosTiers(prev => {
                          const without = prev.filter(v => v !== "" && v !== l.value);
                          if (prev.includes(l.value)) return without.length ? without : [""];
                          return [...prev.filter(v => v !== ""), l.value];
                        });
                      }} color="#6366f1">{l.label}</Btn>
                    );
                  })}
                </div>
              </div>
            )}
            {tab !== "supply" && tab !== "map" && tab !== "score" && (tiers.length > 1 || losTiers.length > 1) && (
              <div style={{ display:"flex", alignItems:"flex-start", gap:6, background:"#1e293b", border:"1px solid #f59e0b55", borderRadius:6, padding:"6px 10px", maxWidth:400 }}>
                <span style={{ color:"#f59e0b", fontSize:13, lineHeight:1 }}>⚠</span>
                <span style={{ color:"#94a3b8", fontSize:11, lineHeight:1.4 }}>Multi-select aggregation uses static room counts as weights. Results may not exactly match <strong style={{ color:"#cbd5e1" }}>All Tier</strong>.</span>
              </div>
            )}
            {tab !== "supply" && tab !== "map" && tab !== "score" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Time Window</label>
                <div style={{ display:"flex", gap:2 }}>
                  {K_TIME_WINDOWS.map(t => <Btn key={t.id} active={kTimeWindow===t.id} onClick={() => setKTimeWindow(t.id)} color="#6366f1">{t.label}</Btn>)}
                </div>
              </div>
            )}
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              <label style={label9}>Geography</label>
              <div style={{ display:"flex", gap:2 }}>
                <Btn active={geoLevel==="market"}    onClick={() => { setGeoLevel("market"); setSelectedGeos([]); setDrillMkt(null); setExpandedGeo(null); }} color="#6366f1">Markets</Btn>
                <Btn active={geoLevel==="submarket"} onClick={() => { setGeoLevel("submarket"); setSelectedGeos([]); setDrillMkt(null); setExpandedGeo(null); }} color="#6366f1">Submarkets</Btn>
              </div>
            </div>
            {tab === "overview" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Period</label>
                <select value={kPeriod1} onChange={e => setKPeriod1(e.target.value)} style={{ ...sel, minWidth:120, ...(kIsForecast(kPeriod1)?{border:"1px solid #f59e0b55",color:"#fbbf24"}:{}) }}>
                  {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{kIsForecast(p)?" ◆":""}</option>)}
                </select>
              </div>
            )}
            {tab === "overview" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Compare To</label>
                <select value={kOvStart} onChange={e => setKOvStart(e.target.value)} style={{ ...sel, minWidth:130 }}>
                  <option value="">Prior Year (YoY)</option>
                  {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{kIsForecast(p)?" ◆":""}</option>)}
                </select>
              </div>
            )}
            {(tab === "overview" || tab === "cagr") && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Forecast</label>
                <div style={{ display:"flex", gap:2 }}>
                  <Btn active={showForecast}  onClick={() => setShowForecast(true)}  color="#f59e0b">Show</Btn>
                  <Btn active={!showForecast} onClick={() => setShowForecast(false)}>Hide</Btn>
                </div>
              </div>
            )}
            {tab === "overview" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Sort By</label>
                <div style={{ display:"flex", gap:2 }}>
                  <select value={kSortKey} onChange={e => setKSortKey(e.target.value)} style={{ ...sel, minWidth:130 }}>
                    {K_METRICS.map(m => (
                      <optgroup key={m.key} label={m.label}>
                        <option value={m.key}>{m.label}</option>
                        {m.yoyKey && <option value={m.yoyKey}>{m.label} {kOvStart?"% Chg":"YoY"}</option>}
                      </optgroup>
                    ))}
                  </select>
                  <Btn active={true} onClick={() => setKSortDir(d => d==="desc"?"asc":"desc")} color="#6366f1" style={{ minWidth:34 }}>
                    {kSortDir==="desc"?"↓":"↑"}
                  </Btn>
                </div>
              </div>
            )}
            {tab === "cagr" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Sort By</label>
                <div style={{ display:"flex", gap:2 }}>
                  <select value={kCagrSortKey} onChange={e => setKCagrSortKey(e.target.value)} style={{ ...sel, minWidth:130 }}>
                    {K_CAGR_SORT.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                  <Btn active={true} onClick={() => setKCagrSortDir(d => d==="desc"?"asc":"desc")} color="#6366f1" style={{ minWidth:34 }}>
                    {kCagrSortDir==="desc"?"↓":"↑"}
                  </Btn>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              <label style={label9}>Hotel Class / Slice</label>
              <select value={slice} onChange={e => setSlice(e.target.value)} style={{ ...sel, minWidth:220 }}>
                <optgroup label="─ Native Slices ─">{C_NATIVE_SLICES.map(s => <option key={s} value={s}>{s}</option>)}</optgroup>
                <optgroup label="─ Custom Aggregations ─">{Object.keys(C_CUSTOM_COMBOS).map(s => <option key={s} value={s}>{s}</option>)}</optgroup>
              </select>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              <label style={label9}>Time Window</label>
              <div style={{ display:"flex", gap:2, background:"#0f172a", borderRadius:7, padding:2 }}>
                {C_TIME_WINDOWS.map(t => (
                  <button key={t.id} onClick={() => setCTimeWindow(t.id)} style={{ ...btnBase, padding:"0 12px", background:cTimeWindow===t.id?"#f59e0b":"transparent", color:cTimeWindow===t.id?"#fff":"#64748b", border:"none" }}>{t.label}</button>
                ))}
              </div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              <label style={label9}>Geography</label>
              <div style={{ display:"flex", gap:2 }}>
                <Btn active={geoLevel==="market"}    onClick={() => setGeoLevel("market")}    color="#f59e0b">Market</Btn>
                <Btn active={geoLevel==="submarket"} onClick={() => setGeoLevel("submarket")} color="#f59e0b">Submarket</Btn>
              </div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              <label style={label9}>Market</label>
              <select value={cMktFilter} onChange={e => setCMktFilter(e.target.value)} style={{ ...sel, minWidth:150 }}>
                <option value="All">All Markets</option>
                {cMarkets.map(m => <option key={m} value={m}>{m.replace(" - OH USA","").replace(" USA","")}</option>)}
              </select>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              <label style={label9}>Include Forecast</label>
              <div style={{ display:"flex", gap:2 }}>
                <Btn active={showForecast}  onClick={() => setShowForecast(true)}  color="#f59e0b">Show</Btn>
                <Btn active={!showForecast} onClick={() => setShowForecast(false)}>Hide</Btn>
              </div>
            </div>
            {tab === "overview" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Sort By</label>
                <div style={{ display:"flex", gap:4 }}>
                  <select value={cSortCol} onChange={e => setCSortCol(e.target.value)} style={{ ...sel, minWidth:130 }}>
                    {C_SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <button onClick={() => setCSortDir(d => d==="desc"?"asc":"desc")} style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155", minWidth:34 }}>
                    {cSortDir==="desc"?"↓":"↑"}
                  </button>
                </div>
              </div>
            )}
            {tab === "cagr" && (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={label9}>Sort By</label>
                <div style={{ display:"flex", gap:4 }}>
                  <select value={cCagrSortCol} onChange={e => setCCagrSortCol(e.target.value)} style={{ ...sel, minWidth:130 }}>
                    {C_CAGR_SORT.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <button onClick={() => setCCagrSortDir(d => d==="desc"?"asc":"desc")} style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155", minWidth:34 }}>
                    {cCagrSortDir==="desc"?"↓":"↑"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        <div style={{ flex:1 }}/>
      </div>

      {/* ── Content area ── */}
      {tab !== "map" ? (
        <div style={{ padding:"16px 28px", flex:1, overflowY:"auto", minHeight:0 }}>

          {/* ════════════════════════════════ OVERVIEW ════════════════════════════════ */}
          {tab === "overview" && dataSource === "kalibri" && (
            <div>
              <div style={{ fontSize:10, color:"#334155", marginBottom:10, fontFamily:"'IBM Plex Mono',monospace", display:"flex", gap:6, alignItems:"center" }}>
                <span style={{ color:"#60a5fa", fontWeight:600 }}>{periodLabel(kPeriod1)}</span>
                <span style={{ color:"#1a2540" }}>·</span>
                <span style={{ color:"#8b5cf6" }}>{kTw.label}</span>
                {kTimeWindow !== "mo" && <span style={{ color:"#475569", fontSize:9 }}>(days-weighted)</span>}
                <span style={{ color:"#1a2540" }}>·</span>
                <span>{kOverviewRows.length} {geoLevel==="market"?"markets":"submarkets"}</span>
                <span style={{ color:"#1a2540" }}>·</span>
                <span>{revType}</span>
                <span style={{ color:"#1a2540" }}>·</span>
                <span style={{ color:"#10b981" }}>{tiers[0]==="All Tier"?"All":tiers.map(t=>t.replace(" Tier","")).join(" + ")}</span>
                <span style={{ color:"#1a2540" }}>·</span>
                <span style={{ color:"#8b5cf6" }}>{losTiers[0]===""?"All LOS":losTiers.map(v=>K_LOS_OPTIONS.find(l=>l.value===v)?.label).join(" + ")}</span>
                {kIsForecast(kPeriod1) && <span style={{ color:"#f59e0b", marginLeft:4, fontSize:10 }}>◆ FORECAST PERIOD</span>}
                <span style={{ flex:1 }}/>
                <button onClick={() => {
                  const yoyLabel = kOvStart ? `vs ${periodLabel(kOvStart)}` : "YoY";
                  const cols = [
                    ...(geoLevel==="submarket"?[{ label:"Market", get:r=>r.mkt }]:[]),
                    { label:geoLevel==="submarket"?"Submarket":"Market", get:r=>r.label },
                    { label:"Rooms", get:r=>kGetSupply(r.geo)?.rooms??"" },
                    { label:"Occ",   get:r=>r.m.occ!=null?(r.m.occ*100).toFixed(1)+"%":"" },
                    { label:`Occ ${yoyLabel}`,get:r=>r.m.occ_yoy!=null?(r.m.occ_yoy*100).toFixed(1)+"pp":"" },
                    { label:"ADR",   get:r=>r.m.adr!=null?r.m.adr.toFixed(2):"" },
                    { label:`ADR ${yoyLabel}`,get:r=>r.m.adr_yoy!=null?(r.m.adr_yoy*100).toFixed(1)+"%":"" },
                    { label:"RevPAR",get:r=>r.m.revpar!=null?r.m.revpar.toFixed(2):"" },
                    { label:`RevPAR ${yoyLabel}`,get:r=>r.m.revpar_yoy!=null?(r.m.revpar_yoy*100).toFixed(1)+"%":"" },
                  ];
                  downloadCSV(`kalibri_overview_${kPeriod1}.csv`, kOverviewRows, cols);
                }} style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155" }}>↓ Export</button>
              </div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ borderCollapse:"separate", borderSpacing:0, fontSize:12, width:"100%" }}>
                  <thead>
                    <tr style={{ background:"#070f1e" }}>
                      <th style={{ position:"sticky", left:0, zIndex:2, background:"#070f1e", padding:"3px 8px", width:MKT_W, minWidth:MKT_W }}/>
                      {geoLevel==="submarket" && <th style={{ position:"sticky", left:MKT_W+20, zIndex:2, background:"#070f1e", padding:"3px 8px", width:SUB_W, minWidth:SUB_W }}/>}
                      <th style={{ position:"sticky", left:geoLevel==="submarket"?MKT_W+20+SUB_W+20:MKT_W+20, zIndex:2, background:"#070f1e", padding:"3px 8px", width:90, minWidth:90 }}/>
                      <th colSpan={kPerfColSpan} style={{ background:"#042818", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#10b981", textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:"2px solid #10b98155", borderLeft:"1px solid #0d1526" }}>
                        <div>PERFORMANCE</div>
                        <div style={{ marginTop:2, fontWeight:400, fontSize:8, fontFamily:"'IBM Plex Mono',monospace", textTransform:"none", letterSpacing:0 }}>
                          <span style={{ color:"#3b82f6" }}>{periodLabel(kPeriod1)}</span>
                          <span style={{ color:"#334155", margin:"0 4px" }}>vs</span>
                          <span style={{ color:"#64748b" }}>{kOvStart ? periodLabel(kOvStart) : "prior year"}</span>
                        </div>
                      </th>
                    </tr>
                    <tr style={{ background:"#0a1628", borderBottom:"2px solid #1e293b" }}>
                      <th style={{ position:"sticky", left:0, zIndex:2, background:"#0a1628", padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", width:MKT_W, minWidth:MKT_W }}>
                        {geoLevel==="submarket"?"Submarket":"Market"}
                      </th>
                      {geoLevel==="submarket" && <th style={{ position:"sticky", left:MKT_W+20, zIndex:2, background:"#0a1628", padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", width:SUB_W, minWidth:SUB_W }}>Market</th>}
                      <th style={{ position:"sticky", left:geoLevel==="submarket"?MKT_W+20+SUB_W+20:MKT_W+20, zIndex:2, background:"#0a1628", padding:"6px 8px", textAlign:"right", fontSize:9, color:"#60a5fa", fontWeight:600, whiteSpace:"nowrap", width:90, minWidth:90, borderLeft:"1px solid #1e293b" }}>Rooms</th>
                      {K_METRICS.map(m => m.yoyKey ? [
                        <th key={m.key+"v"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:90 }}>{m.label}</th>,
                        <th key={m.key+"c"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#64748b", fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>{kOvStart?"% Chg":"YoY"}</th>,
                      ] : <th key={m.key} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:60 }}>{m.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {kOverviewRows.length === 0 && <tr><td colSpan={(geoLevel==="submarket"?3:2)+kPerfColSpan} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>}
                    {kOverviewRows.map((row, i) => {
                      const bg = i%2===0?"#111827":"#0f172a";
                      const rowBg = hoveredRow===row.geo?"#1e293b":bg;
                      return (
                        <tr key={row.geo} style={{ borderBottom:"1px solid #0d1526" }}
                          onMouseEnter={() => setHoveredRow(row.geo)} onMouseLeave={() => setHoveredRow(null)}>
                          <td style={{ position:"sticky", left:0, zIndex:1, background:rowBg, padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap", width:MKT_W, minWidth:MKT_W, maxWidth:MKT_W, overflow:"hidden", textOverflow:"ellipsis" }}>{row.label}</td>
                          {geoLevel==="submarket" && <td style={{ position:"sticky", left:MKT_W+20, zIndex:1, background:rowBg, padding:"6px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap", width:SUB_W, minWidth:SUB_W, maxWidth:SUB_W, overflow:"hidden", textOverflow:"ellipsis" }}>{row.mkt}</td>}
                          <td style={{ position:"sticky", left:geoLevel==="submarket"?MKT_W+20+SUB_W+20:MKT_W+20, zIndex:1, background:rowBg, padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#60a5fa", whiteSpace:"nowrap", width:90, minWidth:90, borderLeft:"1px solid #1e293b" }}>
                            {(() => { const s = kGetSupply(row.geo); return s ? s.rooms.toLocaleString() : "—"; })()}
                          </td>
                          {K_METRICS.map(m => m.yoyKey ? [
                            <td key={m.key+"v"} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#cbd5e1", borderLeft:"1px solid #0d1526", whiteSpace:"nowrap" }}>{m.valFmt(row.m[m.key])}</td>,
                            <td key={m.key+"c"} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:chgColor(row.m[m.yoyKey], m.isOcc), fontWeight:600, whiteSpace:"nowrap" }}>
                              {m.isOcc ? fmt.pp(row.m[m.yoyKey]) : fmt.pct(row.m[m.yoyKey])}
                            </td>,
                          ] : <td key={m.key} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#94a3b8", borderLeft:"1px solid #0d1526", whiteSpace:"nowrap" }}>{m.valFmt(row.m[m.key])}</td>)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "overview" && dataSource === "costar" && (
            <div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:12, marginBottom:14, alignItems:"center", background:"#111827", borderRadius:8, padding:"10px 14px", border:"1px solid #1e293b" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                  <label style={{ fontSize:8, color:"#3b82f6", textTransform:"uppercase", letterSpacing:1, fontFamily:"'IBM Plex Mono',monospace" }}>P1</label>
                  <div style={{ position:"relative" }}>
                    <select value={cPeriod1} onChange={e => setCPeriod1(e.target.value)} style={{ ...sel, border:"1px solid #3b82f6", minWidth:110, fontWeight:600, color:"#93c5fd" }}>
                      {[...cFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{cIsForecast(p)?" ◆":""}</option>)}
                    </select>
                    {cIsForecast(cPeriod1) && <span style={{ position:"absolute", right:6, top:"50%", transform:"translateY(-50%)", fontSize:7, color:"#f59e0b", fontWeight:700, pointerEvents:"none" }}>FCST</span>}
                  </div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1, paddingTop:14 }}>
                  <span style={{ fontSize:9, color:"#334155", fontWeight:600, letterSpacing:1 }}>VS</span>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                  <label style={{ fontSize:8, color:"#475569", textTransform:"uppercase", letterSpacing:1, fontFamily:"'IBM Plex Mono',monospace" }}>P2</label>
                  <div style={{ position:"relative" }}>
                    <select value={cPeriod2} onChange={e => setCPeriod2(e.target.value)} style={{ ...sel, minWidth:110 }}>
                      {[...cFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{cIsForecast(p)?" ◆":""}</option>)}
                    </select>
                    {cIsForecast(cPeriod2) && <span style={{ position:"absolute", right:6, top:"50%", transform:"translateY(-50%)", fontSize:7, color:"#f59e0b", fontWeight:700, pointerEvents:"none" }}>FCST</span>}
                  </div>
                </div>
                <div style={{ width:1, height:32, background:"#1e293b", margin:"0 4px" }}/>
                <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                  <label style={{ fontSize:8, color:"#475569", textTransform:"uppercase", letterSpacing:1, fontFamily:"'IBM Plex Mono',monospace" }}>Columns</label>
                  <div style={{ display:"flex", gap:4 }}>
                    {Object.entries(C_COL_GROUPS).map(([g,{label,color,accent}]) => (
                      <button key={g} onClick={() => setVisGroups(prev => ({ ...prev, [g]:!prev[g] }))}
                        style={{ ...btnBase, fontSize:10, background:visGroups[g]?color:"#0f172a", color:visGroups[g]?"#fff":"#475569", border:`1px solid ${visGroups[g]?accent:"#334155"}` }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {(cIsForecast(cPeriod1)||cIsForecast(cPeriod2)) && (
                <div style={{ background:"#f59e0b11", border:"1px solid #f59e0b33", borderRadius:6, padding:"6px 14px", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ color:"#f59e0b", fontSize:13 }}>◆</span>
                  <span style={{ fontSize:11, color:"#d97706" }}>
                    {cIsForecast(cPeriod1)&&cIsForecast(cPeriod2)?"Both periods are CoStar forecasts.":cIsForecast(cPeriod1)?"P1 is a CoStar forecast.":"P2 is a CoStar forecast."}
                    {" "}Base Case scenario.
                  </span>
                </div>
              )}
              <div style={{ fontSize:10, color:"#334155", marginBottom:10, fontFamily:"'IBM Plex Mono',monospace", display:"flex", gap:6, alignItems:"center" }}>
                <span style={{ color:"#60a5fa", fontWeight:600 }}>{periodLabel(cPeriod1)}</span>
                <span style={{ color:"#1e293b" }}>vs</span>
                <span style={{ color:"#475569" }}>{periodLabel(cPeriod2)}</span>
                <span style={{ color:"#1a2540", margin:"0 2px" }}>·</span>
                <span>{cTw.label}</span>
                <span style={{ color:"#1a2540", margin:"0 2px" }}>·</span>
                <span>{cCompTable.length} geographies</span>
                <span style={{ color:"#1a2540", margin:"0 2px" }}>·</span>
                <span>{slice}</span>
              </div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12, tableLayout:"auto" }}>
                  <thead>
                    <tr style={{ background:"#070f1e" }}>
                      <th colSpan={2} style={{ background:"#070f1e", padding:"4px 0" }}/>
                      {cVisGroupSpans.map(({g,label,color,accent,span}) => (
                        <th key={g} colSpan={span} style={{ background:color+"33", padding:"3px 8px", fontSize:9, fontWeight:700, color:accent, textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:`2px solid ${accent}55`, borderLeft:"1px solid #0d1526" }}>
                          <div>{label}</div>
                          <div style={{ marginTop:2, fontWeight:400, fontSize:8, fontFamily:"'IBM Plex Mono',monospace", textTransform:"none", letterSpacing:0 }}>
                            {g==="perf"?(
                              <span><span style={{ color:"#3b82f6" }}>{periodLabel(cPeriod1)}</span><span style={{ color:"#334155", margin:"0 4px" }}>vs</span><span style={{ color:"#64748b" }}>{periodLabel(cPeriod2)}</span></span>
                            ):(
                              <span style={{ color:"#3b82f6" }}>{periodLabel(cPeriod1)}</span>
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                    <tr style={{ background:"#0a1628", borderBottom:"2px solid #1e293b" }}>
                      <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", minWidth:150, position:"sticky", left:0, background:"#0a1628", zIndex:2 }}>
                        {geoLevel==="submarket"?"Submarket":"Geography"}
                      </th>
                      <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap", minWidth:80 }}>Market</th>
                      {cVisibleCols.map(col => col.chgKey ? [
                        <th key={col.key+"v"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:70 }}>{col.label}</th>,
                        <th key={col.key+"c"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#64748b", fontWeight:600, whiteSpace:"nowrap", minWidth:60 }}>Δ</th>,
                      ] : <th key={col.key} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", minWidth:60 }}>{col.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {cCompTable.map((row, i) => {
                      const bg = i%2===0?"#111827":"#0f172a";
                      return (
                        <tr key={row.geo} style={{ borderBottom:"1px solid #0d1526", background:bg }}
                          onMouseEnter={e => e.currentTarget.style.background="#1e293b"}
                          onMouseLeave={e => e.currentTarget.style.background=bg}>
                          <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap", maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", position:"sticky", left:0, background:bg, zIndex:1 }}>{row.subName}</td>
                          <td style={{ padding:"6px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap" }}>{row.mkt}</td>
                          {cVisibleCols.map(col => {
                            const v = row.m1?.[col.key];
                            const chg = col.chgKey ? row.m1?.[col.chgKey] : null;
                            return col.chgKey ? [
                              <td key={col.key+"v"} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#cbd5e1", borderLeft:"1px solid #0d1526", whiteSpace:"nowrap" }}>{col.fmt(v)}</td>,
                              <td key={col.key+"c"} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:chgColor(chg, col.isOcc), fontWeight:600, whiteSpace:"nowrap" }}>
                                {chg==null?"—":col.isOcc?fmt.pp(chg):fmt.pct(chg)}
                              </td>,
                            ] : <td key={col.key} style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:col.isChg?chgColor(v):"#94a3b8", borderLeft:"1px solid #0d1526", whiteSpace:"nowrap" }}>{col.fmt(v)}</td>;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ════ TREND ════ */}
          {tab === "trend" && dataSource === "kalibri" && (
            <div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Metric</label>
                  <select value={kTrendMetric} onChange={e => setKTrendMetric(e.target.value)} style={sel}>
                    {K_TREND_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </div>
                {kTrendMetric.endsWith("_yoy") && (
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
                    <Btn active={showForecast} onClick={() => setShowForecast(true)} color="#f59e0b">Show</Btn>
                    <Btn active={!showForecast} onClick={() => setShowForecast(false)}>Hide</Btn>
                  </div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>From</label>
                  <select value={trendStart} onChange={e => { setTrendStart(e.target.value); setTrendGeoSel(null); }} style={{ ...sel, minWidth:120 }}>
                    <option value="">All time</option>
                    {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{kIsForecast(p) ? " ◆" : ""}</option>)}
                  </select>
                </div>
                <div style={{ alignSelf:"flex-end", paddingBottom:8, color:"#334155", fontSize:14 }}>→</div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>To</label>
                  <select value={trendEnd} onChange={e => { setTrendEnd(e.target.value); setTrendGeoSel(null); }} style={{ ...sel, minWidth:120 }}>
                    <option value="">Latest</option>
                    {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{kIsForecast(p) ? " ◆" : ""}</option>)}
                  </select>
                </div>
                <div style={{ fontSize:11, color:"#475569", alignSelf:"flex-end", paddingBottom:6 }}>
                  <span style={{ color:"#94a3b8" }}>{revType}</span> · <span style={{ color:"#64748b" }}>{kTw.label}</span>
                </div>
              </div>

              {/* Geo selector */}
              <div style={{ display:"flex", gap:8, marginBottom:12, alignItems:"center" }}>
                <span style={label9}>{geoLevel === "submarket" ? "Submarkets" : "Markets"}</span>
                <div ref={trendGeoRef} style={{ position:"relative" }}>
                  <button onClick={() => setTrendGeoOpen(v => !v)} style={{ ...btnBase, background:"#1e293b", border:"1px solid #334155", color:"#94a3b8", gap:6 }}>
                    {trendGeoSel ? `${trendGeoSel.length} selected` : `top 6 by ${periodLabel(trendEnd || kPeriod1) || "latest"}`}
                    {" "}<span style={{ fontSize:9 }}>{trendGeoOpen ? "▲" : "▼"}</span>
                  </button>
                  <Popover anchorRef={trendGeoRef} open={trendGeoOpen} minWidth={220}>
                    <div style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:8, padding:"8px 6px", minWidth:220, maxHeight:320, overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
                      {trendGeoSel && (
                        <span onClick={() => setTrendGeoSel(null)} style={{ color:"#3b82f6", cursor:"pointer", fontSize:10, padding:"0 4px 4px", borderBottom:"1px solid #1e293b", marginBottom:2 }}>reset to top 6</span>
                      )}
                      {kFilteredGeos.map((geo, i) => {
                        const lbl = kGeoMeta[geo]?.submarket || kGeoMeta[geo]?.market || geo;
                        const selected = trendGeoSel ? trendGeoSel.includes(geo) : kTrendData.top6?.includes(geo);
                        const colorIdx = trendGeoSel ? trendGeoSel.indexOf(geo) : kTrendData.top6?.indexOf(geo);
                        const color = selected ? COLORS[(colorIdx >= 0 ? colorIdx : i) % COLORS.length] : "#475569";
                        return (
                          <div key={geo} onClick={() => {
                            const current = trendGeoSel || kTrendData.top6 || [];
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
                {(trendGeoSel || kTrendData.top6)?.slice(0, 6).map((geo, i) => {
                  const lbl = kGeoMeta[geo]?.submarket || kGeoMeta[geo]?.market || geo;
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
                <LineChart data={kTrendData.chartData} margin={{ top:10, right:30, bottom:60, left:20 }}>
                  {showForecast && kForecastStartLabel && (
                    <ReferenceArea x1={kForecastStartLabel} fill="#f59e0b" fillOpacity={0.04}/>
                  )}
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                  <XAxis dataKey="period" tick={{ fill:"#475569", fontSize:9 }} angle={-45} textAnchor="end" height={55}
                    ticks={kTrendData.chartData?.filter(d => [1,4,7,10].includes(parseInt(d.period.split("-")[1]))).map(d => d.period)}/>
                  <YAxis tick={{ fill:"#475569", fontSize:10 }}
                    tickFormatter={K_TREND_METRICS.find(m => m.key === kTrendMetric)?.tickFmt}
                    domain={yoyClip ? [v => Math.max(-yoyClip, v), v => Math.min(yoyClip, v)] : ["auto","auto"]}
                    width={60}/>
                  <Tooltip content={<CustomTooltip lastActual={kLastActual} metricKey={kTrendMetric}/>}/>
                  {showForecast && kForecastStartLabel && (
                    <ReferenceLine x={kForecastStartLabel} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={1.5}
                      label={{ value:"Forecast →", fill:"#f59e0b", fontSize:9, position:"top" }}/>
                  )}
                  <ReferenceLine x="Jan - 2020" stroke="#ef444466" strokeDasharray="4 4"
                    label={{ value:"COVID", fill:"#ef4444", fontSize:9, position:"top" }}/>
                  {kTrendData.series.map((s, i) => (
                    <Line key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2} dot={false} connectNulls activeDot={{ r:4 }} isAnimationActive={false}/>
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {tab === "trend" && dataSource === "costar" && (
            <div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Metric</label>
                  <select value={cTrendMetric} onChange={e => setCTrendMetric(e.target.value)} style={sel}>
                    {C_TREND_METRICS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Rank By Period</label>
                  <select value={cPeriod1} onChange={e => setCPeriod1(e.target.value)} style={sel}>
                    {[...cFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{cIsForecast(p) ? " ◆" : ""}</option>)}
                  </select>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Forecast</label>
                  <div style={{ display:"flex", gap:2 }}>
                    <Btn active={showForecast} onClick={() => setShowForecast(true)} color="#f59e0b">Show</Btn>
                    <Btn active={!showForecast} onClick={() => setShowForecast(false)}>Hide</Btn>
                  </div>
                </div>
                <div style={{ fontSize:11, color:"#475569", alignSelf:"flex-end", paddingBottom:6 }}>
                  Top 6 · <span style={{ color:"#94a3b8" }}>{slice}</span> · <span style={{ color:"#64748b" }}>{cTw.label}</span>
                </div>
              </div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:4, alignItems:"center" }}>
                {cTrendData.series.map((s, i) => (
                  <div key={s} style={{ display:"flex", alignItems:"center", gap:5, background:"#1e293b", borderRadius:4, padding:"3px 10px" }}>
                    <div style={{ width:8, height:8, borderRadius:2, background:COLORS[i%COLORS.length] }}/>
                    <span style={{ fontSize:10, color:"#cbd5e1" }}>{s}</span>
                  </div>
                ))}
                {showForecast && <div style={{ display:"flex", alignItems:"center", gap:5, background:"#f59e0b11", border:"1px solid #f59e0b33", borderRadius:4, padding:"3px 10px", marginLeft:8 }}>
                  <div style={{ width:8, height:8, borderRadius:2, background:"#f59e0b44", border:"1px dashed #f59e0b" }}/>
                  <span style={{ fontSize:10, color:"#f59e0b" }}>Forecast (Base Case)</span>
                </div>}
              </div>
              <ResponsiveContainer width="100%" height={420}>
                <LineChart data={cTrendData.chartData} margin={{ top:10, right:30, bottom:80, left:20 }}>
                  {showForecast && cForecastStartLabel && (
                    <ReferenceArea x1={cForecastStartLabel} fill="#f59e0b" fillOpacity={0.04}/>
                  )}
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                  <XAxis dataKey="period" tick={{ fill:"#475569", fontSize:9 }} angle={-50} textAnchor="end" interval={3} height={70}/>
                  <YAxis tick={{ fill:"#475569", fontSize:10 }}
                    tickFormatter={C_TREND_METRICS.find(t => t.key === cTrendMetric)?.tick || (v => v)}
                    domain={["auto","auto"]} width={60}/>
                  <Tooltip content={<CustomTooltip lastActual={cLastActual}/>}/>
                  {showForecast && cForecastStartLabel && (
                    <ReferenceLine x={cForecastStartLabel} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={1.5}
                      label={{ value:"Forecast →", fill:"#f59e0b", fontSize:9, position:"top" }}/>
                  )}
                  <ReferenceLine x="Jan - 2020" stroke="#ef444466" strokeDasharray="4 4"
                    label={{ value:"COVID", fill:"#ef4444", fontSize:9, position:"top" }}/>
                  {cTrendData.series.map((s, i) => (
                    <Line key={s} type="monotone" dataKey={s} stroke={COLORS[i%COLORS.length]} strokeWidth={2} dot={false} connectNulls/>
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ════ CAGR ════ */}
          {tab === "cagr" && dataSource === "kalibri" && (
            <div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Start Period</label>
                  <select value={kCagrStart} onChange={e => setKCagrStart(e.target.value)} style={{ ...sel, minWidth:120 }}>
                    {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{kIsForecast(p) ? " ◆" : ""}</option>)}
                  </select>
                </div>
                <div style={{ alignSelf:"flex-end", paddingBottom:8, color:"#334155", fontSize:14 }}>→</div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>End Period</label>
                  <select value={kCagrEnd} onChange={e => setKCagrEnd(e.target.value)} style={{ ...sel, minWidth:120 }}>
                    {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{kIsForecast(p) ? " ◆" : ""}</option>)}
                  </select>
                </div>
                <div style={{ fontSize:11, color:"#475569", alignSelf:"flex-end", paddingBottom:6 }}>
                  {(() => { const p1p = kCagrStart.split("-"), p2p = kCagrEnd.split("-"); const y = (parseInt(p2p[0]) - parseInt(p1p[0])) + (parseInt(p2p[1]) - parseInt(p1p[1])) / 12; return y > 0 ? y.toFixed(1) + "-yr CAGR" : "Select valid range"; })()}
                  {" · "}<span style={{ color:"#94a3b8" }}>{revType}</span>
                </div>
                <div style={{ flex:1 }}/>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Chart Metric</label>
                  <select value={kCagrChartMetric} onChange={e => setKCagrChartMetric(e.target.value)} style={{ ...sel, minWidth:140 }}>
                    {K_CAGR_SORT.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:3, justifyContent:"flex-end" }}>
                  <button onClick={() => {
                    const cols = [
                      ...(geoLevel === "submarket" ? [{ label:"Market", get: r => r.mkt }] : []),
                      { label: geoLevel === "submarket" ? "Submarket" : "Market", get: r => r.label },
                      { label:`Occ (${periodLabel(kCagrStart)})`, get: r => r.ms_occ != null ? (r.ms_occ*100).toFixed(1)+"%" : "" },
                      { label:`Occ (${periodLabel(kCagrEnd)})`,   get: r => r.me_occ != null ? (r.me_occ*100).toFixed(1)+"%" : "" },
                      { label:"Occ Delta (pp)",                   get: r => r.occ_delta != null ? (r.occ_delta*100).toFixed(1) : "" },
                      { label:`ADR (${periodLabel(kCagrStart)})`, get: r => r.ms_adr != null ? r.ms_adr.toFixed(2) : "" },
                      { label:`ADR (${periodLabel(kCagrEnd)})`,   get: r => r.me_adr != null ? r.me_adr.toFixed(2) : "" },
                      { label:"ADR CAGR",                         get: r => r.adr_cagr != null ? (r.adr_cagr*100).toFixed(2)+"%" : "" },
                      { label:`RevPAR (${periodLabel(kCagrStart)})`, get: r => r.ms_revpar != null ? r.ms_revpar.toFixed(2) : "" },
                      { label:`RevPAR (${periodLabel(kCagrEnd)})`,   get: r => r.me_revpar != null ? r.me_revpar.toFixed(2) : "" },
                      { label:"RevPAR CAGR",                         get: r => r.revpar_cagr != null ? (r.revpar_cagr*100).toFixed(2)+"%" : "" },
                    ];
                    downloadCSV(`kalibri_cagr_${kCagrStart}_to_${kCagrEnd}.csv`, kCagrRows, cols);
                  }} style={{ ...btnBase, background:"#1e293b", color:"#94a3b8", border:"1px solid #334155" }}>↓ Export</button>
                </div>
              </div>

              {kCagrRows.length > 0 && (
                <div style={{ marginBottom:2 }}>
                  <div style={{ fontSize:10, color:"#475569", marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>
                    {K_CAGR_SORT.find(o => o.key === kCagrChartMetric)?.label} · Top {Math.min(kCagrRows.length, 20)} geographies · sorted by {K_CAGR_SORT.find(o => o.key === kCagrSortKey)?.label}
                  </div>
                  <ResponsiveContainer width="100%" height={360}>
                    <BarChart data={kCagrRows.slice(0, 20)} margin={{ top:10, right:30, bottom:60, left:20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                      <XAxis dataKey="label" tick={{ fill:"#475569", fontSize:9 }} angle={-45} textAnchor="end" height={80} interval={0}/>
                      <YAxis tickFormatter={v => kCagrChartMetric === "occ_delta" ? (v*100).toFixed(1)+"pp" : (v*100).toFixed(1)+"%"} tick={{ fill:"#475569", fontSize:10 }}/>
                      <Tooltip contentStyle={{ background:"#1e293b", border:"1px solid #334155", borderRadius:6, fontSize:11 }}
                        formatter={(v, n) => [kCagrChartMetric === "occ_delta" ? fmt.pp(v) : fmt.pct(v), n]} labelStyle={{ color:"#94a3b8" }}/>
                      <ReferenceLine y={0} stroke="#334155"/>
                      <Bar dataKey={kCagrChartMetric} name={K_CAGR_SORT.find(o => o.key === kCagrChartMetric)?.label} radius={[3,3,0,0]}>
                        {kCagrRows.slice(0, 20).map((row, i) => (
                          <Cell key={i} fill={(row[kCagrChartMetric] || 0) >= 0 ? "#3b82f6" : "#ef4444"}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"separate", borderSpacing:0, fontSize:12 }}>
                  <thead>
                    <tr style={{ background:"#070f1e" }}>
                      <th colSpan={geoLevel === "submarket" ? 2 : 1} style={{ background:"#070f1e", padding:"4px 0" }}/>
                      {[["Occupancy",3],["ADR",3],["RevPAR",3]].map(([lbl, span]) => (
                        <th key={lbl} colSpan={span} style={{ background:"#042818", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#10b981", textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:"2px solid #10b98155", borderLeft:"1px solid #0d1526" }}>{lbl}</th>
                      ))}
                    </tr>
                    <tr style={{ borderBottom:"1px solid #1e293b", background:"#0a1628" }}>
                      <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap" }}>{geoLevel === "submarket" ? "Submarket" : "Market"}</th>
                      {geoLevel === "submarket" && <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, whiteSpace:"nowrap" }}>Market</th>}
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(kCagrStart)}</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(kCagrEnd)}</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:600, whiteSpace:"nowrap" }}>Δ (pp)</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(kCagrStart)}</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(kCagrEnd)}</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:600, whiteSpace:"nowrap" }}>CAGR</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(kCagrStart)}</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(kCagrEnd)}</th>
                      <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:600, whiteSpace:"nowrap" }}>CAGR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kCagrRows.length === 0 && (
                      <tr><td colSpan={12} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>
                    )}
                    {kCagrRows.map((row, i) => {
                      const bg = i % 2 === 0 ? "#111827" : "#0f172a";
                      return (
                        <tr key={row.geo} style={{ borderBottom:"1px solid #0d1526", background:bg }}
                          onMouseEnter={e => e.currentTarget.style.background="#1e293b"}
                          onMouseLeave={e => e.currentTarget.style.background=bg}>
                          <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap" }}>{row.label}</td>
                          {geoLevel === "submarket" && <td style={{ padding:"6px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap" }}>{row.mkt}</td>}
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.occ(row.ms_occ)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#94a3b8" }}>{fmt.occ(row.me_occ)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.occ_delta, true), fontWeight:600 }}>{fmt.pp(row.occ_delta)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.dollar(row.ms_adr)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#94a3b8" }}>{fmt.dollar(row.me_adr)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.adr_cagr), fontWeight:600 }}>{fmt.pct(row.adr_cagr)}</td>
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

          {tab === "cagr" && dataSource === "costar" && (
            <div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Start Period</label>
                  <div style={{ position:"relative" }}>
                    <select value={cCagrStart} onChange={e => setCCagrStart(e.target.value)} style={{ ...sel, minWidth:120 }}>
                      {[...cFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{cIsForecast(p) ? " ◆" : ""}</option>)}
                    </select>
                    {cIsForecast(cCagrStart) && <span style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", fontSize:7, color:"#f59e0b", fontWeight:700, pointerEvents:"none" }}>FCST</span>}
                  </div>
                </div>
                <div style={{ alignSelf:"flex-end", paddingBottom:8, color:"#334155", fontSize:14 }}>→</div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>End Period</label>
                  <div style={{ position:"relative" }}>
                    <select value={cCagrEnd} onChange={e => setCCagrEnd(e.target.value)} style={{ ...sel, minWidth:120 }}>
                      {[...cFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}{cIsForecast(p) ? " ◆" : ""}</option>)}
                    </select>
                    {cIsForecast(cCagrEnd) && <span style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", fontSize:7, color:"#f59e0b", fontWeight:700, pointerEvents:"none" }}>FCST</span>}
                  </div>
                </div>
                <div style={{ fontSize:11, color:"#64748b", alignSelf:"flex-end", paddingBottom:6 }}>
                  {(() => { const p1p = cCagrStart.split("-"), p2p = cCagrEnd.split("-"); const y = (parseInt(p2p[0]) - parseInt(p1p[0])) + (parseInt(p2p[1]) - parseInt(p1p[1])) / 12; return y > 0 ? y.toFixed(1) + "-yr CAGR" : "Select valid range"; })()}
                  {" · "}<span style={{ color:"#94a3b8" }}>{slice}</span>{" · "}<span style={{ color:"#64748b" }}>{cTw.label}</span>
                </div>
                <div style={{ flex:1 }}/>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Chart Metric</label>
                  <select value={cCagrChartMetric} onChange={e => setCCagrChartMetric(e.target.value)} style={{ ...sel, minWidth:140 }}>
                    {C_CAGR_CHART.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>

              {(cIsForecast(cCagrEnd) || cIsForecast(cCagrStart)) && (
                <div style={{ background:"#f59e0b11", border:"1px solid #f59e0b33", borderRadius:6, padding:"6px 14px", marginBottom:12, fontSize:11, color:"#d97706" }}>
                  ◆ {cIsForecast(cCagrEnd) && cIsForecast(cCagrStart) ? "Both periods are" : "One period is"} a CoStar Base Case forecast. CAGR figures reflect projected performance.
                </div>
              )}

              {cCagrTable.length > 0 && (
                <div style={{ marginBottom:20 }}>
                  <div style={{ fontSize:10, color:"#475569", marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>
                    {C_CAGR_CHART.find(o => o.value === cCagrChartMetric)?.label} · Top {Math.min(cCagrTable.length, 20)} geographies · sorted by {C_SORT_OPTIONS.find(o => o.value === cCagrSortCol)?.label}
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={cCagrTable.slice(0, 20)} margin={{ top:5, right:20, bottom:90, left:20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/>
                      <XAxis dataKey="subName" tick={{ fill:"#475569", fontSize:9 }} angle={-45} textAnchor="end" height={80} interval={0}/>
                      <YAxis tickFormatter={v => cCagrChartMetric === "occ_delta" ? (v*100).toFixed(1)+"pp" : (v*100).toFixed(1)+"%"} tick={{ fill:"#475569", fontSize:10 }}/>
                      <Tooltip contentStyle={{ background:"#1e293b", border:"1px solid #334155", borderRadius:6, fontSize:11 }}
                        formatter={(v, n) => [C_CAGR_CHART.find(o => o.value === cCagrChartMetric)?.fmtFn ? C_CAGR_CHART.find(o => o.value === cCagrChartMetric).fmtFn(v) : fmt.pct(v), n]}/>
                      <ReferenceLine y={0} stroke="#334155"/>
                      <Bar dataKey={cCagrChartMetric} name={C_CAGR_CHART.find(o => o.value === cCagrChartMetric)?.label} radius={[3,3,0,0]}>
                        {cCagrTable.slice(0, 20).map((row, i) => <Cell key={i} fill={(row[cCagrChartMetric]||0) >= 0 ? "#3b82f6" : "#ef4444"}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead>
                    <tr style={{ background:"#070f1e" }}>
                      <th colSpan={2} style={{ background:"#070f1e", padding:"4px 0" }}/>
                      {[["Occupancy",3,"#10b981","#042818","#10b98155"],["ADR",3,"#10b981","#042818","#10b98155"],["RevPAR",3,"#10b981","#042818","#10b98155"],["Supply",3,"#3b82f6","#0d2040","#3b82f655"],["Demand",3,"#3b82f6","#0d2040","#3b82f655"]].map(([lbl,span,col,bg,border]) => (
                        <th key={lbl} colSpan={span} style={{ background:bg, padding:"4px 0", fontSize:9, fontWeight:700, color:col, textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:`2px solid ${border}`, borderLeft:"1px solid #0d1526" }}>{lbl}</th>
                      ))}
                    </tr>
                    <tr style={{ borderBottom:"1px solid #1e293b", background:"#0a1628" }}>
                      {["Submarket","Market"].map(h => <th key={h} style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", textTransform:"uppercase", letterSpacing:0.5, fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>)}
                      {["Occ","ADR","RevPAR","Supply","Demand"].map(g => [
                        <th key={g+"s"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#3b82f6", fontWeight:600, whiteSpace:"nowrap", borderLeft:"1px solid #1a2540", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cCagrStart)}</th>,
                        <th key={g+"e"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, whiteSpace:"nowrap", fontFamily:"'IBM Plex Mono',monospace" }}>{periodLabel(cCagrEnd)}</th>,
                        <th key={g+"c"} style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color: g==="Occ"?"#10b981":"#10b981", fontWeight:600, whiteSpace:"nowrap" }}>{g==="Occ"?"Δ (pp)":"CAGR"}</th>,
                      ])}
                    </tr>
                  </thead>
                  <tbody>
                    {cCagrTable.map((row, i) => {
                      const bg = i % 2 === 0 ? "#111827" : "#0f172a";
                      const fe = cIsForecast(cCagrEnd);
                      return (
                        <tr key={row.geo} style={{ borderBottom:"1px solid #0d1526", background:bg }}
                          onMouseEnter={e => e.currentTarget.style.background="#1e293b"}
                          onMouseLeave={e => e.currentTarget.style.background=bg}>
                          <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap" }}>{row.subName}</td>
                          <td style={{ padding:"6px 10px", color:"#475569", fontSize:10, whiteSpace:"nowrap" }}>{row.mkt}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.occ(row.ms?.occ)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:fe?"#fbbf24":"#94a3b8" }}>{fmt.occ(row.me?.occ)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.occ_delta, true), fontWeight:600 }}>{fmt.pp(row.occ_delta)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.dollar(row.ms?.adr)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:fe?"#fbbf24":"#94a3b8" }}>{fmt.dollar(row.me?.adr)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.adr_cagr), fontWeight:600 }}>{fmt.pct(row.adr_cagr)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.dollar(row.ms?.revpar)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:fe?"#fbbf24":"#60a5fa" }}>{fmt.dollar(row.me?.revpar)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.revpar_cagr), fontWeight:700, fontSize:13 }}>{fmt.pct(row.revpar_cagr)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.int(row.ms?.supply)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:fe?"#fbbf24":"#94a3b8" }}>{fmt.int(row.me?.supply)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.supply_cagr) }}>{fmt.pct(row.supply_cagr)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#64748b", borderLeft:"1px solid #0d1526" }}>{fmt.int(row.ms?.demand)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:fe?"#fbbf24":"#94a3b8" }}>{fmt.int(row.me?.demand)}</td>
                          <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:chgColor(row.demand_cagr) }}>{fmt.pct(row.demand_cagr)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ════ SUPPLY ════ */}
          {tab === "supply" && dataSource === "kalibri" && (
            <div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:14, alignItems:"flex-end" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Filter</label>
                  <Btn active={extStayOnly} onClick={() => { setExtStayOnly(v => !v); setSupplyFilterBrand([]); }} color="#8b5cf6">Extended Stay</Btn>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Parent Company {supplyFilterCompany.length > 0 && <span style={{ color:"#475569" }}>· {supplyFilterCompany.length}</span>}{supplyFilterCompany.length > 0 && <span onClick={() => { setSupplyFilterCompany([]); setSupplyFilterBrand([]); }} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}</label>
                  <div ref={supplyCompanyRef} style={{ position:"relative" }}>
                    <Btn active={supplyFilterCompany.length > 0 || supplyCompanyOpen} onClick={() => setSupplyCompanyOpen(v => !v)} color="#f97316" style={{ display:"flex", alignItems:"center", gap:4 }}>
                      {supplyFilterCompany.length > 0 ? `${supplyFilterCompany.length} selected` : "All"} <span style={{ fontSize:9 }}>{supplyCompanyOpen ? "▲" : "▼"}</span>
                    </Btn>
                    <Popover anchorRef={supplyCompanyRef} open={supplyCompanyOpen} minWidth={220}>
                      <div style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:8, padding:"8px 6px", minWidth:220, maxHeight:300, overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
                        {supplyFilterCompany.length > 0 && <span onClick={() => { setSupplyFilterCompany([]); setSupplyFilterBrand([]); }} style={{ color:"#3b82f6", cursor:"pointer", fontSize:10, padding:"0 4px 4px", borderBottom:"1px solid #1e293b", marginBottom:2 }}>clear all</span>}
                        {kSupplyCompanies.map(c => (
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
                {(supplyFilterCompany.length > 0 || extStayOnly) && kSupplyVisibleBrands.length > 0 && (
                  <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                    <label style={label9}>Brand {supplyFilterBrand.length > 0 && <span style={{ color:"#475569" }}>· {supplyFilterBrand.length}</span>}{supplyFilterBrand.length > 0 && <span onClick={() => setSupplyFilterBrand([])} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}</label>
                    <div ref={supplyBrandRef} style={{ position:"relative" }}>
                      <Btn active={supplyFilterBrand.length > 0 || supplyBrandOpen} onClick={() => setSupplyBrandOpen(v => !v)} color="#6366f1" style={{ display:"flex", alignItems:"center", gap:4 }}>
                        {supplyFilterBrand.length > 0 ? `${supplyFilterBrand.length} selected` : `all ${kSupplyVisibleBrands.length}`} <span style={{ fontSize:9 }}>{supplyBrandOpen ? "▲" : "▼"}</span>
                      </Btn>
                      <Popover anchorRef={supplyBrandRef} open={supplyBrandOpen} minWidth={200}>
                        <div style={{ background:"#0f172a", border:"1px solid #334155", borderRadius:8, padding:"8px 6px", minWidth:200, maxHeight:300, overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
                          {supplyFilterBrand.length > 0 && <span onClick={() => setSupplyFilterBrand([])} style={{ color:"#3b82f6", cursor:"pointer", fontSize:10, padding:"0 4px 4px", borderBottom:"1px solid #1e293b", marginBottom:2 }}>clear all</span>}
                          {kSupplyVisibleBrands.map(b => (
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
                <span style={{ color:"#60a5fa", fontWeight:600 }}>{kSupplyRows.length} {geoLevel === "market" ? "markets" : "submarkets"}</span>
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
                      <th colSpan={4} style={{ background:"#0c1a2e", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#3b82f6", textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:"2px solid #3b82f655", borderLeft:"1px solid #0d1526" }}>Supply — Active Properties</th>
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
                          <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:160 }}>{geoLevel === "submarket" ? "Submarket" : "Market"}</th>
                          {geoLevel === "submarket" && <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:100 }}>Market</th>}
                          <SortTh sk="rooms" color="#60a5fa" style={{ minWidth:90 }}>Total Rooms (Props)</SortTh>
                          <SortTh sk="lower" color="#f87171">Lower Tier</SortTh>
                          <SortTh sk="mid"   color="#fbbf24">Mid Tier</SortTh>
                          <SortTh sk="upper" color="#34d399">Upper Tier</SortTh>
                        </tr>
                      );
                    })()}
                  </thead>
                  <tbody>
                    {kSupplyRows.map((row, i) => {
                      const bg = i % 2 === 0 ? "#111827" : "#0f172a";
                      const isExp = expandedGeo === row.geo;
                      const lower = row.tiers["Lower Tier"] || { rooms:0, props:0 };
                      const mid   = row.tiers["Mid Tier"]   || { rooms:0, props:0 };
                      const upper = row.tiers["Upper Tier"] || { rooms:0, props:0 };
                      return (
                        <React.Fragment key={row.geo}>
                          <tr style={{ borderBottom:"1px solid #0d1526", background: isExp ? "#1e3a5f" : bg, cursor:"pointer" }}
                            onClick={() => { setExpandedGeo(isExp ? null : row.geo); setExpandedTier("All Tier"); }}
                            onMouseEnter={e => { if (!isExp) e.currentTarget.style.background="#1e293b"; }}
                            onMouseLeave={e => { if (!isExp) e.currentTarget.style.background=bg; }}>
                            <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap" }}>
                              <span style={{ marginRight:6, color: isExp ? "#f59e0b" : "#475569", fontSize:10 }}>{isExp ? "▼" : "▶"}</span>
                              {row.label}
                            </td>
                            {geoLevel === "submarket" && <td style={{ padding:"6px 10px", color:"#475569", fontSize:10 }}>{row.mkt}</td>}
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
                                    {kSupplyBrands.length} brands · {kSupplyBrands.reduce((s,b)=>s+b.rooms,0).toLocaleString()} rooms
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
                                      {kSupplyBrands.map((b, j) => (
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

          {tab === "supply" && dataSource === "costar" && cDb && (
            <div>
              {/* Date selectors */}
              <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:14, alignItems:"flex-end" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Period 1</label>
                  <select value={supplyPeriod1} onChange={e => setSupplyPeriod1(e.target.value)} style={{ ...sel, minWidth:130 }}>
                    {Object.keys(cDb.lookup).sort().reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                  </select>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>vs. Period 2</label>
                  <select value={supplyPeriod2} onChange={e => setSupplyPeriod2(e.target.value)} style={{ ...sel, minWidth:130 }}>
                    <option value="">— none —</option>
                    {Object.keys(cDb.lookup).sort().reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                  </select>
                </div>
              </div>
              {/* Supply + Demand table */}
              {(() => {
                const cTw = C_TIME_WINDOWS.find(t => t.id === cTimeWindow) || C_TIME_WINDOWS[0];
                const csLevel = geoLevel === "market" ? "Market" : "Submarket";
                const geoEntries = Object.entries(cDb.geo_meta).filter(([,v]) => v.geo_type === csLevel);
                const pFmt = v => v != null ? Math.round(v).toLocaleString() : "—";
                const pctFmt = v => v != null ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%` : "—";
                const pctColor = v => v == null ? "#475569" : v > 0 ? "#10b981" : v < 0 ? "#ef4444" : "#94a3b8";
                const rows = geoEntries.map(([geoName, meta]) => {
                  const m1 = getMetricsC(cDb.lookup, supplyPeriod1, geoName, slice, cTw);
                  const m2 = supplyPeriod2 ? getMetricsC(cDb.lookup, supplyPeriod2, geoName, slice, cTw) : null;
                  if (!m1?.inv_rooms) return null;
                  const supplyChg = m2?.inv_rooms ? (m1.inv_rooms - m2.inv_rooms) / m2.inv_rooms : null;
                  const demandChg = m2?.demand && m1?.demand ? (m1.demand - m2.demand) / m2.demand : null;
                  const displayName = geoName.replace(", OH USA","").replace(", OH","");
                  return { geoName, displayName, market: meta.market, inv_rooms: m1.inv_rooms, demand: m1.demand, occ: m1.occ, supplyChg, demandChg, inv_rooms2: m2?.inv_rooms, demand2: m2?.demand };
                }).filter(Boolean).sort((a, b) => (b.inv_rooms||0) - (a.inv_rooms||0));
                return (
                  <div style={{ overflowX:"auto" }}>
                    <div style={{ fontSize:10, color:"#334155", marginBottom:10, fontFamily:"'IBM Plex Mono',monospace", display:"flex", gap:6, alignItems:"center" }}>
                      <span style={{ color:"#60a5fa", fontWeight:600 }}>{rows.length} {geoLevel === "market" ? "markets" : "submarkets"}</span>
                      <span style={{ color:"#1a2540" }}>·</span>
                      <span style={{ color:"#f59e0b" }}>{periodLabel(supplyPeriod1)}</span>
                      {supplyPeriod2 && <><span style={{ color:"#1a2540" }}>vs.</span><span style={{ color:"#94a3b8" }}>{periodLabel(supplyPeriod2)}</span></>}
                    </div>
                    <table style={{ borderCollapse:"separate", borderSpacing:0, width:"100%", fontSize:12 }}>
                      <thead>
                        <tr style={{ background:"#070f1e" }}>
                          <th colSpan={geoLevel === "submarket" ? 2 : 1} style={{ background:"#070f1e", padding:"4px 0" }}/>
                          <th colSpan={supplyPeriod2 ? 4 : 2} style={{ background:"#0c1a2e", padding:"3px 8px", fontSize:9, fontWeight:700, color:"#f59e0b", textTransform:"uppercase", letterSpacing:1, textAlign:"center", borderTop:"2px solid #f59e0b55", borderLeft:"1px solid #0d1526" }}>Supply · Demand</th>
                        </tr>
                        <tr style={{ background:"#0a1628", borderBottom:"2px solid #1e293b" }}>
                          <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:160 }}>{geoLevel === "submarket" ? "Submarket" : "Market"}</th>
                          {geoLevel === "submarket" && <th style={{ padding:"7px 10px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:100 }}>Market</th>}
                          <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#f59e0b", fontWeight:600, borderLeft:"1px solid #1a2540", minWidth:100 }}>Inventory Rooms</th>
                          <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#10b981", fontWeight:600, borderLeft:"1px solid #1a2540", minWidth:100 }}>Demand (RN Sold)</th>
                          {supplyPeriod2 && <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, borderLeft:"1px solid #1a2540", minWidth:80 }}>Supply Δ</th>}
                          {supplyPeriod2 && <th style={{ padding:"6px 8px", textAlign:"right", fontSize:9, color:"#94a3b8", fontWeight:600, borderLeft:"1px solid #1a2540", minWidth:80 }}>Demand Δ</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, i) => (
                          <React.Fragment key={row.geoName}>
                            <tr
                              onClick={() => setCostarSupplyExpanded(costarSupplyExpanded === row.geoName ? null : row.geoName)}
                              style={{ cursor:"pointer", borderBottom:"1px solid #0d1526", background: i%2===0?"#111827":"#0f172a" }}>
                              <td style={{ padding:"6px 10px", color:"#f1f5f9", fontWeight:500, whiteSpace:"nowrap" }}>{row.displayName}</td>
                              {geoLevel === "submarket" && <td style={{ padding:"6px 10px", color:"#475569", fontSize:10 }}>{row.market?.replace(", OH USA","")}</td>}
                              <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#f59e0b", fontWeight:600, borderLeft:"1px solid #0d1526" }}>{pFmt(row.inv_rooms)}</td>
                              <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#10b981", borderLeft:"1px solid #0d1526" }}>{pFmt(row.demand)}</td>
                              {supplyPeriod2 && <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:pctColor(row.supplyChg), borderLeft:"1px solid #0d1526" }}>{pctFmt(row.supplyChg)}</td>}
                              {supplyPeriod2 && <td style={{ padding:"6px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:pctColor(row.demandChg), borderLeft:"1px solid #0d1526" }}>{pctFmt(row.demandChg)}</td>}
                            </tr>
                            {costarSupplyExpanded === row.geoName && (() => {
                              const props = costarProps.filter(r => {
                                const rMkt = r.marketName.replace(", OH USA","").replace(", OH","");
                                return rMkt === row.displayName || r.marketName === row.geoName;
                              });
                              const brandMap = {};
                              for (const r of props) {
                                const key = r.Brand || "Independent";
                                if (!brandMap[key]) brandMap[key] = { brand:key, parent:r.parentCompany, hotelClass:r.hotelClass, rooms:0, props:0 };
                                brandMap[key].rooms += r.Rooms; brandMap[key].props += 1;
                              }
                              const brands = Object.values(brandMap).sort((a,b) => b.rooms - a.rooms);
                              return (
                                <tr key={row.geoName+"_exp"}>
                                  <td colSpan={geoLevel === "submarket" ? (supplyPeriod2 ? 6 : 4) : (supplyPeriod2 ? 5 : 3)} style={{ padding:0, background:"#0a1628", borderBottom:"2px solid #334155" }}>
                                    <div style={{ padding:"12px 20px" }}>
                                      <div style={{ marginBottom:10, fontSize:10, color:"#475569" }}>{brands.length} brands · {brands.reduce((s,b)=>s+b.rooms,0).toLocaleString()} rooms (CoStar property data)</div>
                                      <table style={{ borderCollapse:"separate", borderSpacing:0, width:"100%", fontSize:11 }}>
                                        <thead>
                                          <tr style={{ background:"#070f1e" }}>
                                            <th style={{ padding:"5px 8px", textAlign:"left", fontSize:9, color:"#f59e0b", fontWeight:600, minWidth:160 }}>Brand</th>
                                            <th style={{ padding:"5px 8px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:140 }}>Parent Company</th>
                                            <th style={{ padding:"5px 8px", textAlign:"left", fontSize:9, color:"#475569", fontWeight:600, minWidth:110 }}>Hotel Class</th>
                                            <th style={{ padding:"5px 8px", textAlign:"right", fontSize:9, color:"#60a5fa", fontWeight:600, minWidth:70 }}>Rooms</th>
                                            <th style={{ padding:"5px 8px", textAlign:"right", fontSize:9, color:"#475569", fontWeight:600, minWidth:70 }}>Properties</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {brands.map((b, j) => (
                                            <tr key={b.brand+j} style={{ background: j%2===0?"#0f172a":"#111827" }}>
                                              <td style={{ padding:"5px 8px", color:"#f1f5f9", fontWeight:500 }}>{b.brand}</td>
                                              <td style={{ padding:"5px 8px", color:"#64748b", fontSize:10 }}>{b.parent||"—"}</td>
                                              <td style={{ padding:"5px 8px", fontSize:10, color:"#94a3b8" }}>{b.hotelClass||"—"}</td>
                                              <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#60a5fa" }}>{b.rooms.toLocaleString()}</td>
                                              <td style={{ padding:"5px 8px", textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", color:"#94a3b8" }}>{b.props}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })()}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          )}
          {tab === "supply" && dataSource === "costar" && !cDb && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:320, gap:12 }}>
              <div style={{ fontSize:16, color:"#64748b", fontWeight:600 }}>Loading CoStar data…</div>
            </div>
          )}

          {/* ════ SCORE (Kalibri only) ════ */}
          {tab === "score" && dataSource === "kalibri" && (
            <div>
              {/* Score controls */}
              <div style={{ display:"flex", flexWrap:"wrap", gap:14, marginBottom:16, alignItems:"flex-end" }}>
                {/* Revenue Type */}
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>Revenue Type</label>
                  <div style={{ display:"flex", gap:2 }}>
                    {K_REV_TYPES.map(rt => <Btn key={rt} active={scoreRevType===rt} onClick={() => setScoreRevType(rt)} color="#10b981">{rt}</Btn>)}
                  </div>
                </div>
                {/* CAGR Period */}
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>CAGR From</label>
                  <select value={scoreCagrStart} onChange={e => setScoreCagrStart(e.target.value)} style={{ ...sel, minWidth:120 }}>
                    {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                  </select>
                </div>
                <div style={{ alignSelf:"flex-end", paddingBottom:8, color:"#334155", fontSize:14 }}>→</div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <label style={label9}>CAGR To</label>
                  <select value={scoreCagrEnd} onChange={e => setScoreCagrEnd(e.target.value)} style={{ ...sel, minWidth:120 }}>
                    {[...kFilteredPeriods].reverse().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
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
                const SliderGroup = ({ title, onReset, children }) => (
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
                        {K_LOS_OPTIONS.map(l => {
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
                                return without.length ? without : [id];
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
              {kScoreRows.length > 0 && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:10, color:"#475569", marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>
                    Composite Score · {kScoreRows.length} {geoLevel === "market" ? "markets" : "submarkets"} · {scoreRevType}
                  </div>
                  <ResponsiveContainer width="100%" height={Math.min(500, kScoreRows.length * 16 + 40)}>
                    <BarChart data={kScoreRows} layout="vertical" margin={{ top:4, right:60, bottom:4, left:220 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false}/>
                      <XAxis type="number" domain={[0, 100]} tick={{ fill:"#475569", fontSize:9 }} tickFormatter={v => v.toFixed(0)}/>
                      <YAxis type="category" dataKey="label" tick={{ fill:"#94a3b8", fontSize:10 }} width={215}/>
                      <Tooltip
                        contentStyle={{ background:"#1e293b", border:"1px solid #334155", borderRadius:6, fontSize:11 }}
                        formatter={(v) => [v != null ? v.toFixed(1) : "—", "Score"]}
                        labelStyle={{ color:"#94a3b8" }}
                      />
                      <Bar dataKey="composite" radius={[0,3,3,0]} barSize={8}>
                        {kScoreRows.map((row, i) => (
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
                  const rows = kScoreRows.map(r => [r.rank, r.label, ...(geoLevel==="submarket"?[kGeoMeta[r.geo]?.market||""]:[]), r.revpar?.toFixed(2)??"", r.revpar_cagr!=null?(r.revpar_cagr*100).toFixed(1)+"%":"", r.occ!=null?(r.occ*100).toFixed(1)+"%":"", r.occ_cagr!=null?(r.occ_cagr*100).toFixed(1)+"%":"", r.adr?.toFixed(2)??"", r.adr_cagr!=null?(r.adr_cagr*100).toFixed(1)+"%":"", r.alos?.toFixed(2)??"", r.rooms??"", r.composite?.toFixed(1)??""]);
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
                    {kScoreRows.length === 0 && (
                      <tr><td colSpan={21} style={{ textAlign:"center", padding:48, color:"#334155" }}>No data for selected filters</td></tr>
                    )}
                    {kScoreRows.map((row, i) => {
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
          const pinSource = mapMode === "pins" ? costarProps : supplyData;
          const pinCompanyKey = mapMode === "pins" ? "parentCompany" : "Company";
          const pinExtStayFn  = mapMode === "pins" ? (r => r.isExtStay) : (r => EXTENDED_STAY_BRANDS.has(r.Brand));
          const mapCompanyList = [...new Set(pinSource.map(r => r[pinCompanyKey]))].filter(Boolean).sort();
          const brandsForMapCompany = pinSource
            .filter(r => (mapCompanies.length === 0 || mapCompanies.includes(r[pinCompanyKey])) && (!mapExtStay || pinExtStayFn(r)))
            .reduce((s, r) => { s.add(r.Brand); return s; }, new Set());
          const mapVisibleBrands = [...brandsForMapCompany].sort();
          const toggleGeo = key => setSelectedGeos(prev => prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]);
          const CC_STATUSES_ALL = ["Conceptual","Design","Final Planning","GC Bidding","Sub-Bidding","Pre-Construction/Negotiated","Award","Post-Bid","Bid Results","Under Construction"];
          const CC_STATUS_COLOR = { "Conceptual":"#64748b","Design":"#3b82f6","Final Planning":"#8b5cf6","GC Bidding":"#f59e0b","Sub-Bidding":"#f59e0b","Pre-Construction/Negotiated":"#f97316","Award":"#10b981","Post-Bid":"#10b981","Bid Results":"#10b981","Under Construction":"#22c55e" };
          return (
            <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0 }}>
              {/* Filter panel */}
              <div style={{ display:"flex", alignItems:"flex-start", borderBottom:"1px solid #1e293b", flexShrink:0 }}>
                <div style={{ display:"flex", gap:10, padding:"6px 16px", alignItems:"flex-start", overflowX:"auto", flexWrap:"nowrap", flex:1, minWidth:0 }}>

                  {/* View + Ext Stay (Kalibri pins mode only) */}
                  <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0 }}>
                    <label style={label9}>View</label>
                    <div style={{ display:"flex", gap:2 }}>
                      <Btn active={mapMode==="bubbles"} onClick={() => setMapMode("bubbles")} color="#6366f1">Bubbles</Btn>
                      <Btn active={mapMode==="pins"} onClick={() => setMapMode("pins")} color="#6366f1">Pins</Btn>
                      {mapMode === "pins" && <Btn active={mapExtStay} onClick={() => { setMapExtStay(v => !v); setMapBrands([]); }} color="#8b5cf6">Ext. Stay</Btn>}
                    </div>
                  </div>

                  {/* Market / Submarket drill-down pills */}
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
                        <label style={label9}>
                          Market
                          {selectedGeos.length > 0 && <span style={{ color:"#475569" }}> · {selectedGeos.length} submarket{selectedGeos.length > 1 ? "s" : ""} selected</span>}
                          {selectedGeos.length > 0 && <span onClick={() => setSelectedGeos([])} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}
                        </label>
                        <div style={PILL_ROW}>
                          {OUR_MARKETS.map(m => {
                            const hasSel = selectedGeos.some(g => g.startsWith(m + "::"));
                            return (
                              <Btn key={m} active={drillMkt === m} onClick={() => setDrillMkt(drillMkt === m ? null : m)}
                                color="#f97316" style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0, outline: hasSel ? "1px solid #f97316" : "none" }}>
                                {m.replace(", OH","")}
                              </Btn>
                            );
                          })}
                        </div>
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

                  {/* Company pills (pins mode) */}
                  {mapMode === "pins" && (
                    <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0, width:280 }}>
                      <label style={label9}>
                        Parent Company
                        {" "}<span style={{ color:"#475569" }}>· {mapCompanies.length > 0 ? `${mapCompanies.length} selected` : "all"}</span>
                        {mapCompanies.length > 0 && <span onClick={() => { setMapCompanies([]); setMapBrands([]); }} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}
                      </label>
                      <div style={PILL_ROW}>
                        {mapCompanyList.map(c => (
                          <Btn key={c} active={mapCompanies.includes(c)}
                            onClick={() => { setMapCompanies(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]); setMapBrands([]); }}
                            color="#f97316" style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0 }}>{c}</Btn>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Brand pills (pins mode) */}
                  {mapMode === "pins" && (mapCompanies.length > 0 || mapExtStay) && (
                    <div style={{ display:"flex", flexDirection:"column", gap:3, flexShrink:0, width:280 }}>
                      <label style={label9}>
                        Brand
                        {" "}<span style={{ color:"#475569" }}>· {mapBrands.length > 0 ? `${mapBrands.length} selected` : `all ${mapVisibleBrands.length}`}</span>
                        {mapBrands.length > 0 && <span onClick={() => setMapBrands([])} style={{ color:"#3b82f6", cursor:"pointer", marginLeft:4 }}>clear</span>}
                      </label>
                      <div style={PILL_ROW}>
                        {mapVisibleBrands.map(b => (
                          <Btn key={b} active={mapBrands.includes(b)}
                            onClick={() => setMapBrands(prev => prev.includes(b) ? prev.filter(x => x !== b) : [...prev, b])}
                            color="#6366f1" style={{ fontSize:10, padding:"0 7px", height:22, flexShrink:0 }}>{b}</Btn>
                        ))}
                      </div>
                    </div>
                  )}

                  {!mapReady && <span style={{ color:"#f59e0b", fontSize:11, alignSelf:"center", flexShrink:0 }}>Loading map…</span>}
                </div>

                {/* Construct Connect — fixed right panel */}
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
              </div>

              {/* Map div — fills remaining height */}
              <div id="unified-map" style={{ flex:1, minHeight:0, background:"#0a1628" }} />
            </div>
          );
        })()}
    </div>
  );
}
