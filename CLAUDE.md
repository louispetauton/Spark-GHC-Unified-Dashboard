# Spark-GHC-Kalibri-Dashboard

Ohio hospitality analytics dashboard built in React, sourcing data from Kalibri Labs and ConstructConnect. Deployed on Replit, connected to GitHub repo `louispetauton/Spark-GHC-Kalibri-Dashboard`.

---

## Tech Stack

- **React 19** + **Recharts 3** — single-file UI (`KalibriDashboard.jsx`)
- **Vite 6** — dev/build server (`vite.config.js`)
- **No backend** — all data is static CSV files fetched at runtime from `/public/`
- Font: **DM Sans** (Google Fonts, loaded in `index.html`)

---

## Project Structure

```
KalibriDashboard.jsx        ← entire app (~2200 lines, single component file)
src/main.jsx                ← React entry point, mounts <KalibriDashboard />
public/
  ohio_kalibri_consolidated.csv   ← Kalibri performance time-series (main data)
  kalibri_supply_summary.csv      ← Kalibri supply/rooms by geo+tier
  kalibri_supply_detail.csv       ← Kalibri property-level supply list
  construct_connect.csv           ← ConstructConnect pipeline projects
ohio_kalibri_consolidated.csv     ← working copy (must also copy to /public)
Ohio_Hotels_Combined_Costar.csv   ← CoStar property inventory (1,465 hotels)
Costar Export Raw Data (2026.03.02).xlsm  ← CoStar monthly time-series (56k rows)
consolidate.py              ← consolidates Kalibri .xlsx exports into ohio_kalibri_consolidated.csv
build_supply_data.py        ← builds kalibri_supply_summary/detail CSVs
build_cc_data.py            ← builds construct_connect.csv from raw CC export
vite.config.js
package.json
CLAUDE.md
```

---

## Data Sources

### 1. Kalibri Labs — Performance Time-Series
**File:** `public/ohio_kalibri_consolidated.csv`
**How it's built:** Run `consolidate.py` against the raw `.xlsx` exports from Kalibri (stored in `/Users/louispetauton/Desktop/OHIO KALIBRI MARKETS/`). Copy output to `public/`.
**Key columns:** Market, Submarket, Revenue Type, Tier, LOS Tier, Period (e.g. `Jan - 2025`), Occ, Occ - YoY, ADR, ADR - YoY, RevPAR, RevPAR - YoY, Booking Costs per RN, ALOS
**Parsed by:** `parseCSV()` in KalibriDashboard.jsx — converts periods to `YYYY-MM`, parses numbers, strips `%`/`$`/`,`.

**Metrics aggregation logic:**
- Multi-period (trailing): days-weighted Occ/RevPAR; demand-weighted ADR (`RevPAR/Occ`)
- Multi-LOS-tier: additive (tiers are mutually exclusive segments)
- Multi-hotel-tier: rooms-weighted (different supply pools)
- YoY deltas recomputed from aggregated periods (not from raw YoY columns when trailing/multi-filter active)

### 2. Kalibri Labs — Supply
**Files:** `public/kalibri_supply_summary.csv`, `public/kalibri_supply_detail.csv`
Built by `build_supply_data.py`. Powers the **Supply** tab and map marker sizing.
`SUPPLY` constant (inline JS object in KalibriDashboard.jsx) holds rooms by `geoKey → tier`.

### 3. ConstructConnect — Pipeline Projects
**File:** `public/construct_connect.csv`
Built by `build_cc_data.py` from raw CC export. Powers hotel pipeline pins on the **Map** tab.
Key fields: lat/lng, project name, status (Permit, Under Construction, Planning, etc.), rooms, type.

### 4. CoStar — Property Inventory (not yet integrated)
**File:** `Ohio_Hotels_Combined_Costar.csv` — 1,465 Ohio hotel properties
Columns: Rooms, Brand, Extended Stay, Parent Company, Property Name, Market Name, Submarket Name, Hotel Class, Scale, Operation Type, Constr Status, Operational Status, Year Built, Year Renovated, address, lat/lng

### 5. CoStar — Monthly Performance (not yet integrated)
**File:** `Costar Export Raw Data (2026.03.02).xlsm` — 56,113 rows
Columns: Period, Slice (hotel class), Geography Name, Market, Submarket, Geography Type, ADR, Occupancy, RevPAR, Supply, Demand, Revenue (with YoY and 12Mo/3Mo/YTD variants)

---

## Dashboard Tabs

### Overview
Snapshot table: all selected geographies × one period (or trailing window). Sticky left columns (Market/Submarket + Rooms). Color-coded YoY deltas.

### Trend
Line chart of a single selected geography over time. Height 600px. X-axis shows quarterly ticks (Jan/Apr/Jul/Oct). Shaded region separates actual vs. forecast data. `LAST_ACTUAL_OVERRIDE` constant controls the cutoff.

### CAGR
Table showing compound annual growth rates across geographies. Column header says "Market" or "Submarket" depending on `geoLevel`. Grouped columns: Occupancy / ADR / RevPAR. Recharts bar charts above table.

### Supply
Property-level table of Kalibri supply data. Filterable by Company and Brand (portaled dropdowns). Expandable rows by geo. Extended-stay-only toggle.

### Map
Leaflet map of Ohio. Markers sized by rooms count. Layers: Kalibri supply (company/brand/ext-stay filters), ConstructConnect pipeline (CC Status filter). Popup tooltips on hover.

---

## Key UI Patterns

### Portaled Dropdowns (all 4 dropdown menus)
Dropdowns use `ReactDOM.createPortal` to render into `document.body` at `position:fixed`, bypassing `overflow:auto` clipping. Implemented via `Popover` component near top of KalibriDashboard.jsx. Uses `useLayoutEffect` + `getBoundingClientRect()` for synchronous positioning. Right-edge clamped: `left = Math.min(r.left, window.innerWidth - w - 8)`.
**Important:** portaled content renders outside the root `<div>` that sets DM Sans font — `fontFamily` must be set explicitly on the Popover wrapper.

### Sticky Table Columns (Overview + CAGR)
Uses `borderCollapse:"separate", borderSpacing:0` (required — `"collapse"` breaks sticky). Columns have explicit `left` pixel offsets:
- Col 1 (Market): `left:0`, width 160px → next col starts at 180 (160 + 2×10 padding)
- Col 2 (Submarket, when visible): `left:180`, width 100px → next at 300
- Rooms column: `left:180` (market mode) or `left:300` (submarket mode)
Sticky headers: `zIndex:2`, sticky body cells: `zIndex:1`. Background color must be set explicitly on sticky cells.

### Geo Key Format
Geography is identified by `geoKey`:
- Market: `"Columbus, OH"`
- Submarket: `"Columbus, OH::Downtown Columbus"`

---

## Updating Data

To load a new Kalibri data export:
1. Run `consolidate.py` in `/Users/louispetauton/Desktop/OHIO KALIBRI MARKETS/`
2. Copy the output `ohio_kalibri_consolidated.csv` to this project's `public/` folder
3. Update `LAST_ACTUAL_OVERRIDE` in KalibriDashboard.jsx (line ~17) to the last actual data month (format: `"YYYY-MM"`)
4. Commit and push — Replit will pick up the new file on next `git reset --hard`

---

## Deployment

### Replit
Repo `louispetauton/Spark-GHC-Kalibri-Dashboard` is connected to Replit. Replit maps port 5173 → external :80.

**Pulling updates on Replit** (Replit always modifies `.replit` locally, so standard pull fails):
```bash
git fetch origin && git reset --hard origin/main && pkill -f vite; npm run dev
```

If orphaned processes occupy ports:
```bash
fuser -k 5000/tcp 5001/tcp 5002/tcp 5173/tcp && npm run dev
```

### Dev Server
```bash
npm run dev
```
Runs on `http://localhost:5173`. Replit infrastructure permanently occupies ports 3000 and 3001 — Vite must use 5173.

---

## Common Gotchas

- **Port conflicts on Replit**: Replit holds 3000 and 3001. Always use 5173.
- **`.replit` file**: Always modified by Replit locally. Never commit Replit's version; `git reset --hard` restores the correct one.
- **CoStar files are not yet in `/public/`** — they're local only and not yet wired into the dashboard.
- **SUPPLY constant**: Rooms data for tier-weighting is an inline JS object in KalibriDashboard.jsx (around line 370), not loaded from CSV at runtime.
- **Forecast shading**: Controlled by `LAST_ACTUAL_OVERRIDE` constant. Must be updated manually when new data arrives.
