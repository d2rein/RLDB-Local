import os
import json
import csv
from collections import defaultdict

TARGET = "Alex Johnston"

AFL_FILE = r"C:\Users\d2rei\Downloads\NRL-Data-main\afltables\player_stats.csv"
NRL_DIR = r"C:\Users\d2rei\Downloads\NRL-Data-main\NRL-Data-main\data\NRL"


def clean(val):
    if val in ["-", None, ""]:
        return 0
    return int(val)


# =========================
# AFL LIST
# =========================
afl_list = []

with open(AFL_FILE, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)

    for r in reader:
        if r["player"] != TARGET:
            continue

        tries = clean(r["tries"])
        if tries == 0:
            continue

        afl_list.append({
            "year": int(r["year"]),
            "round": r["round"],
            "home": r["home"],
            "away": r["away"],
            "tries": tries
        })


# =========================
# NRL LIST (USE WORKING LOGIC)
# =========================
nrl_list = []

for year in range(1998, 2027):
    file = os.path.join(NRL_DIR, str(year), f"NRL_player_statistics_{year}.json")

    if not os.path.exists(file):
        continue

    data = json.load(open(file))["PlayerStats"][0][str(year)]

    for round_block in data:
        for round_name, matches in round_block.items():
            for match in matches:
                for match_key, players in match.items():

                    # Extract metadata from key (this worked before)
                    parts = match_key.split("-")
                    year = parts[0]
                    round_part = parts[1]
                    home = parts[2]
                    away = parts[4]

                    for p in players:
                        if p.get("Name") != TARGET:
                            continue

                        tries = clean(p.get("Tries"))
                        if tries == 0:
                            continue

                        nrl_list.append({
                            "year": int(year),
                            "round": round_part,
                            "home": home,
                            "away": away,
                            "tries": tries
                        })


# =========================
# SORT (chronological approx)
# =========================
afl_list = sorted(afl_list, key=lambda x: (x["year"], x["round"]))
nrl_list = sorted(nrl_list, key=lambda x: (x["year"], x["round"]))


# =========================
# OUTPUT SEPARATE CSVs
# =========================
with open("aj_afl.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(["year", "round", "home", "away", "tries"])

    for m in afl_list:
        writer.writerow([m["year"], m["round"], m["home"], m["away"], m["tries"]])


with open("aj_nrl.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(["year", "round", "home", "away", "tries"])

    for m in nrl_list:
        writer.writerow([m["year"], m["round"], m["home"], m["away"], m["tries"]])


print("✅ Done: aj_afl.csv and aj_nrl.csv")