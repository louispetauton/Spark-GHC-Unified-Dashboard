"""
Extracts Construct Connect project data and outputs construct_connect.csv
for the Map layer. Only keeps projects with valid coordinates.
"""
import os, csv

ROOT   = os.path.dirname(os.path.abspath(__file__))
INPUT  = os.path.join(ROOT, "Construct_Connect_Filtered_Search_02.25.2026_WITH_COORDS_FLAGS.csv")
OUTPUT = os.path.join(ROOT, "public", "construct_connect.csv")

KEEP = [
    "Project Title", "City", "State", "Project Value",
    "Project Status", "Bid Date", "Building Uses",
    "Has Hotel", "Has Elderly Care", "Latitude", "Longitude",
]

def main():
    os.makedirs(os.path.join(ROOT, "public"), exist_ok=True)
    with open(INPUT, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = [row for row in reader if row.get("Latitude") and row.get("Longitude")]

    out_rows = []
    for row in rows:
        try:
            lat = float(row["Latitude"])
            lng = float(row["Longitude"])
        except (ValueError, TypeError):
            continue
        val = row.get("Project Value", "").strip()
        try:
            val = int(val)
        except (ValueError, TypeError):
            val = 0
        out_rows.append({
            "Title":       row["Project Title"].strip(),
            "City":        row["City"].strip(),
            "State":       row["State"].strip(),
            "Value":       val,
            "Status":      row["Project Status"].strip(),
            "BidDate":     row["Bid Date"].strip(),
            "Uses":        row["Building Uses"].strip(),
            "HasHotel":    row["Has Hotel"].strip(),
            "HasElderly":  row["Has Elderly Care"].strip(),
            "Lat":         lat,
            "Lng":         lng,
        })

    fieldnames = ["Title","City","State","Value","Status","BidDate","Uses","HasHotel","HasElderly","Lat","Lng"]
    with open(OUTPUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"Done. {len(out_rows):,} projects written → {OUTPUT}")

if __name__ == "__main__":
    main()
