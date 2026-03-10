import os
import csv
import openpyxl

ROOT   = os.path.dirname(os.path.abspath(__file__))
MKTDIR = os.path.join(ROOT, "Market")
OUTPUT = os.path.join(ROOT, "ohio_kalibri_consolidated.csv")

FIELDNAMES = [
    "Market", "Submarket", "Revenue Type", "Tier", "LOS Tier",
    "Period",
    "Occ", "Occ - YoY",
    "ADR", "ADR - YoY",
    "RevPAR", "RevPAR - YoY",
    "Booking Costs per RN", "Booking Costs per RN - YoY",
    "ALOS", "ALOS - YoY",
]

# Maps folder name → canonical submarket name used in the dashboard
SUBMARKET_NAME_MAP = {
    "AvonI90_West":             "Avon/I90 West",
    "Cleveland Heights":        "Cleveland Heights",
    "Cleveland Southeast":      "Cleveland Southeast",
    "Downtown_Cleveland":       "Downtown Cleveland",
    "Strongsville_Medina":      "Strongsville/Medina",
    "CMH Airport":              "CMH Airport",
    "CMH_Airport":              "CMH Airport",
    "Columbus South":           "Columbus South",
    "Columbus West":            "Columbus West",
    "Downtown Columbus":        "Downtown Columbus",
    "Newark":                   "Newark",
    "Worthington_Westerville":  "Worthington/Westerville",
    "Dayton_NortheastFairborn": "Dayton Northeast/Fairborn",
    "Dayton_SouthMiamisburg":   "Dayton South/Miamisburg",
    "Downtown_DAY Airport":     "Downtown/DAY Airport",
    "Springfield":              "Springfield",
    "Tipp City_Troy":           "Tipp City/Troy",
    "Findlay":                  "Findlay",
    "I70 Corridor":             "I70 Corridor",
    "Lima":                     "Lima",
    "Mansfield_Ashland":        "Mansfield/Ashland",
    "Ohio North":               "Ohio North",
    "Ohio South":               "Ohio South",
    # Akron submarkets (if/when downloaded)
    "Akron":                    "Akron",
    "Akron West":               "Akron West",
    "Canton":                   "Canton",
    "Twinsburg_Streetsboro":    "Twinsburg/Streetsboro",
    # Cincinnati submarkets
    "CVG Airport":              "CVG Airport",
    "Cincinnati East":          "Cincinnati East",
    "Cincinnati North":         "Cincinnati North",
    "Cincinnati West":          "Cincinnati West",
    "Downtown Cincinnati":      "Downtown Cincinnati",
    "Franklin":                 "Franklin",
    # Toledo submarkets
    "Toledo East":              "Toledo East",
    "Toledo West":              "Toledo West",
    # Youngstown
    "Youngstown":               "Youngstown",
}


def parse_los_tier(filename):
    """Extract LOS tier from filename (0-6, 7-14, 15-29, 30+) or empty string."""
    for tier in ["0-6", "7-14", "15-29", "30+"]:
        if tier in filename:
            return tier
    return ""


def read_xlsx(filepath):
    """Return list of dicts from the first sheet of an xlsx file."""
    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if len(rows) < 2:
        return []
    headers = [str(h) if h is not None else "" for h in rows[0]]
    result = []
    for row in rows[1:]:
        d = {}
        for h, v in zip(headers, row):
            d[h] = str(v) if v is not None else ""
        result.append(d)
    return result


def process_file(filepath, market, submarket, writer):
    los_tier = parse_los_tier(os.path.basename(filepath))

    try:
        rows = read_xlsx(filepath)
    except Exception as e:
        print(f"  SKIP (read error): {filepath} — {e}")
        return 0

    if not rows:
        return 0

    sample = rows[0]
    rev_type_col = next((k for k in sample if k.strip() == "Revenue Type"), None)
    tier_col     = next((k for k in sample if k.strip() in ("Tier Type", "Tier")), None)

    count = 0
    for row in rows:
        # First column (empty header) holds the period
        period_raw = row.get("") or ""
        if not period_raw.strip() or period_raw.strip() in ("None", "nan"):
            continue

        revenue_type = row.get(rev_type_col, "").strip() if rev_type_col else ""
        tier         = row.get(tier_col,     "").strip() if tier_col     else ""

        writer.writerow({
            "Market":                       market,
            "Submarket":                    submarket,
            "Revenue Type":                 revenue_type,
            "Tier":                         tier,
            "LOS Tier":                     los_tier,
            "Period":                       period_raw.strip(),
            "Occ":                          row.get("Occ",                          "").strip(),
            "Occ - YoY":                    row.get("Occ - YoY",                    "").strip(),
            "ADR":                          row.get("ADR",                          "").strip(),
            "ADR - YoY":                    row.get("ADR - YoY",                    "").strip(),
            "RevPAR":                       row.get("RevPAR",                       "").strip(),
            "RevPAR - YoY":                 row.get("RevPAR - YoY",                 "").strip(),
            "Booking Costs per RN":         row.get("Booking Costs per RN",         "").strip(),
            "Booking Costs per RN - YoY":   row.get("Booking Costs per RN - YoY",   "").strip(),
            "ALOS":                         row.get("ALOS",                         "").strip(),
            "ALOS - YoY":                   row.get("ALOS - YoY",                   "").strip(),
        })
        count += 1
    return count


def main():
    if not os.path.isdir(MKTDIR):
        print(f"ERROR: Market directory not found: {MKTDIR}")
        return

    total_files = total_rows = skipped = 0

    with open(OUTPUT, "w", newline="", encoding="utf-8") as out:
        writer = csv.DictWriter(out, fieldnames=FIELDNAMES)
        writer.writeheader()

        for market in sorted(os.listdir(MKTDIR)):
            market_path = os.path.join(MKTDIR, market)
            if not os.path.isdir(market_path) or market.startswith("."):
                continue

            # ── Walk files under this market ──────────────────────────────
            for dirpath, dirnames, filenames in os.walk(market_path):
                dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))

                for filename in sorted(filenames):
                    if not filename.endswith(".xlsx"):
                        continue

                    filepath = os.path.join(dirpath, filename)
                    rel      = os.path.relpath(filepath, market_path)
                    parts    = rel.split(os.sep)

                    # Determine if this is a submarket file
                    # Submarket path: Submarket/{folder}/Overview|Length of Stay/...
                    submarket = ""
                    if len(parts) >= 2 and parts[0] == "Submarket":
                        folder = parts[1]
                        if folder in SUBMARKET_NAME_MAP:
                            submarket = SUBMARKET_NAME_MAP[folder]
                        else:
                            # Fallback: replace _ with / for unknown folders
                            submarket = folder.replace("_", "/")
                            print(f"  WARN: unmapped submarket folder '{folder}' → '{submarket}'")

                    n = process_file(filepath, market, submarket, writer)
                    if n > 0:
                        total_files += 1
                        total_rows  += n
                    else:
                        skipped += 1

    print(f"\nDone.")
    print(f"  Files processed : {total_files}")
    print(f"  Files skipped   : {skipped}")
    print(f"  Rows written    : {total_rows:,}")
    print(f"  Output          : {OUTPUT}")


if __name__ == "__main__":
    main()
