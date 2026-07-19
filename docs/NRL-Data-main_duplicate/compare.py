import os
import json
import csv
from collections import defaultdict

# -------- PATHS --------
AFL_FILE = r"C:\Users\d2rei\Downloads\NRL-Data-main\afltables\matches.csv"
NRL_DIR = r"C:\Users\d2rei\Downloads\NRL-Data-main\NRL-Data-main\data\NRL"

# -------- AFLTABLES --------
afl_counts = defaultdict(set)

with open(AFL_FILE, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)

    for row in reader:
        year = int(row["year"])
        if year < 1998:
            continue

        key = (row["round"], row["home"], row["away"])
        afl_counts[year].add(key)

# -------- NRL JSON --------
nrl_counts = defaultdict(set)

for year in range(1998, 2027):
    file = os.path.join(NRL_DIR, str(year), f"NRL_data_{year}.json")

    if not os.path.exists(file):
        continue

    data = json.load(open(file))["NRL"][0][str(year)]

    for r_index, round_block in enumerate(data):
        round_num = r_index + 1

        matches = round_block.get(str(round_num), [])

        for game in matches:
            key = (f"Round {round_num}", game["Home"], game["Away"])
            nrl_counts[year].add(key)

# -------- COMPARE --------
print("\nYEAR | AFLTables | NRL | DIFF")
print("--------------------------------")

for year in range(1998, 2027):
    afl = len(afl_counts[year])
    nrl = len(nrl_counts[year])

    diff = afl - nrl

    flag = ""
    if diff != 0:
        flag = " <-- MISMATCH"

    print(f"{year}: {afl:3} vs {nrl:3}  diff={diff}{flag}")