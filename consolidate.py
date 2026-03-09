import os
import csv

ROOT = os.path.dirname(os.path.abspath(__file__))
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

def parse_market_submarket(filepath):
    """Infer Market and Submarket from folder structure."""
    rel = os.path.relpath(filepath, ROOT)
    parts = rel.split(os.sep)
    # parts[0] = market folder (e.g. "Akron, OH")
    # parts[1] = "Overview" or "Length of Stay"
    # parts[2] = "Guest Paid" or "Hotel Collected"
    # --- OR for submarkets ---
    # parts[0] = market, parts[1] = "Submarket", parts[2] = submarket name
    # parts[3] = "Overview"/"Length of Stay", parts[4] = revenue type

    market = parts[0]
    if len(parts) >= 2 and parts[1] == "Submarket":
        submarket = parts[2].replace("_", "/")
    else:
        submarket = None  # market-level file

    return market, submarket

def parse_los_tier(filename):
    """Extract LOS tier from filename (0-6, 7-14, 15-29, 30+) or None for Overview."""
    for tier in ["0-6", "7-14", "15-29", "30+"]:
        if tier in filename:
            return tier
    return None

def read_csv_rows(filepath):
    with open(filepath, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return list(reader)

def process_file(filepath, writer, seen_count):
    market, submarket = parse_market_submarket(filepath)
    los_tier = parse_los_tier(os.path.basename(filepath))
    
    try:
        rows = read_csv_rows(filepath)
    except Exception as e:
        print(f"  SKIP (read error): {filepath} — {e}")
        return 0

    if not rows:
        return 0

    # Detect column names (handle the trailing-space variant)
    sample = rows[0]
    rev_type_col = next((k for k in sample if k.strip() == "Revenue Type"), None)
    tier_col = next((k for k in sample if k.strip() in ("Tier Type", "Tier")), None)

    count = 0
    for row in rows:
        period_raw = row.get("") or row.get(next(iter(row), ""))
        if not period_raw or not period_raw.strip():
            continue

        revenue_type = row.get(rev_type_col, "").strip() if rev_type_col else ""
        tier = row.get(tier_col, "").strip() if tier_col else ""

        writer.writerow({
            "Market": market,
            "Submarket": submarket or "",
            "Revenue Type": revenue_type,
            "Tier": tier,
            "LOS Tier": los_tier or "",
            "Period": period_raw.strip(),
            "Occ": row.get("Occ", "").strip(),
            "Occ - YoY": row.get("Occ - YoY", "").strip(),
            "ADR": row.get("ADR", "").strip(),
            "ADR - YoY": row.get("ADR - YoY", "").strip(),
            "RevPAR": row.get("RevPAR", "").strip(),
            "RevPAR - YoY": row.get("RevPAR - YoY", "").strip(),
            "Booking Costs per RN": row.get("Booking Costs per RN", "").strip(),
            "Booking Costs per RN - YoY": row.get("Booking Costs per RN - YoY", "").strip(),
            "ALOS": row.get("ALOS", "").strip(),
            "ALOS - YoY": row.get("ALOS - YoY", "").strip(),
        })
        count += 1
    return count

def main():
    total_files = 0
    total_rows = 0
    skipped = 0

    with open(OUTPUT, "w", newline="", encoding="utf-8") as out:
        writer = csv.DictWriter(out, fieldnames=FIELDNAMES)
        writer.writeheader()

        for dirpath, dirnames, filenames in os.walk(ROOT):
            # Skip the script itself and output file
            for filename in sorted(filenames):
                if not filename.endswith(".csv"):
                    continue
                if filename == "ohio_kalibri_consolidated.csv":
                    continue
                filepath = os.path.join(dirpath, filename)
                rows_written = process_file(filepath, writer, total_rows)
                if rows_written > 0:
                    total_files += 1
                    total_rows += rows_written
                else:
                    skipped += 1

    print(f"\nDone.")
    print(f"  Files processed : {total_files}")
    print(f"  Files skipped   : {skipped}")
    print(f"  Rows written    : {total_rows:,}")
    print(f"  Output          : {OUTPUT}")

if __name__ == "__main__":
    main()
