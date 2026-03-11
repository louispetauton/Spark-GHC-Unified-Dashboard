"""
Extracts Ohio property data from kalibri_participation_list.xlsx
and outputs kalibri_supply_detail.csv for the Supply tab.
"""
import os, csv, re, openpyxl

ROOT   = os.path.dirname(os.path.abspath(__file__))
INPUT  = os.path.join(ROOT, "kalibri_participation_list.xlsx")
OUTPUT = os.path.join(ROOT, "kalibri_supply_detail.csv")

OUR_MARKETS = {
    "Akron, OH", "Cincinnati, OH", "Cleveland, OH", "Columbus, OH",
    "Dayton, OH", "Ohio State Area, OH", "Sandusky, OH", "Toledo, OH",
    "Youngstown, OH",
}

TIER_MAP = {
    "Economy":       "Lower Tier",
    "Midscale":      "Mid Tier",
    "Upper Midscale":"Mid Tier",
    "Upscale":       "Upper Tier",
    "Upper Upscale": "Upper Tier",
    "Luxury":        "Upper Tier",
}

def short_submarket(raw, market):
    """Strip ' - Market' suffix to match consolidated CSV format."""
    if not raw:
        return ""
    suffix = f" - {market}"
    if raw.endswith(suffix):
        return raw[:-len(suffix)]
    # Also handle cases where submarket == market (single-submarket markets)
    if raw == market:
        return ""
    return raw

def main():
    wb = openpyxl.load_workbook(INPUT, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    headers = rows[0]
    # Column indices
    col = {h: i for i, h in enumerate(headers)}

    out_rows = []
    skipped = 0

    for r in rows[1:]:
        market   = r[col["KL Market"]]
        status   = r[col["Property Status"]]
        if market not in OUR_MARKETS:
            continue
        if status != "Active / Open":
            skipped += 1
            continue

        submarket_raw = r[col["KL Submarket"]] or ""
        submarket     = short_submarket(submarket_raw, market)

        chain_class  = r[col["Chain Class"]]   or ""
        chain_scale  = r[col["Chain Scale"]]   or ""
        brand        = r[col["Brand Name"]]    or "Independent"
        company      = r[col["Company Name"]]  or "Independent"
        prop_name    = r[col["Property Name"]] or ""
        rooms        = r[col["Property Size"]] or 0
        try:
            rooms = int(rooms)
        except (ValueError, TypeError):
            rooms = 0

        tier = TIER_MAP.get(chain_class, "Lower Tier")  # Independent defaults to Lower

        out_rows.append({
            "Market":      market,
            "Submarket":   submarket,
            "Tier":        tier,
            "Chain Class": chain_class,
            "Chain Scale": chain_scale,
            "Brand":       brand,
            "Company":     company,
            "Property":    prop_name,
            "Rooms":       rooms,
        })

    fieldnames = ["Market","Submarket","Tier","Chain Class","Chain Scale","Brand","Company","Property","Rooms"]
    with open(OUTPUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"Done. {len(out_rows):,} active Ohio properties written → {OUTPUT}")
    print(f"Skipped (inactive): {skipped:,}")

if __name__ == "__main__":
    main()
