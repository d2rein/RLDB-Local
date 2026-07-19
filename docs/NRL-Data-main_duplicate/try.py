import os
import json
from collections import defaultdict

BASE_DIR = r"C:\Users\d2rei\Downloads\NRL-Data-main\NRL-Data-main\data\NRL"
YEARS = range(1998, 2027)

def clean(val):
    if val in ["-", None]:
        return 0
    return int(val)

player_tries = defaultdict(int)

for year in YEARS:
    file = os.path.join(BASE_DIR, str(year), f"NRL_player_statistics_{year}.json")

    if not os.path.exists(file):
        continue

    data = json.load(open(file))["PlayerStats"][0][str(year)]

    for round_block in data:
        for _, matches in round_block.items():
            for match in matches:
                for _, players in match.items():

                    seen = set()  # prevent duplicate rows

                    for p in players:
                        name = p.get("Name")

                        key = (name, p.get("Number"), p.get("Position"))
                        if key in seen:
                            continue
                        seen.add(key)

                        tries = clean(p.get("Tries"))

                        player_tries[name] += tries

# sort results
top = sorted(player_tries.items(), key=lambda x: x[1], reverse=True)

# print top 20
for name, tries in top[:20]:
    print(f"{name}: {tries}")