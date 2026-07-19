"""
Optimized Web Scraper for NRL Player Statistics.

This version reads player stats from the live match-centre q-data payload
instead of depending on rendered HTML table rows.
"""

from bs4 import BeautifulSoup
import csv
import json
import sys
import time

from utilities.set_up_driver import set_up_driver

sys.path.append("..")
import ENVIRONMENT_VARIABLES as EV


PLAYER_STAT_KEY_MAP = {
    "Mins Played": "minutesPlayed",
    "Points": "points",
    "Tries": "tries",
    "Conversions": "conversions",
    "Conversion Attempts": "conversionAttempts",
    "Penalty Goals": "penaltyGoals",
    "Goal Conversion Rate": "goalConversionRate",
    "1 Point Field Goals": "onePointFieldGoals",
    "2 Point Field Goals": "twoPointFieldGoals",
    "Total Points": "fantasyPointsTotal",
    "All Runs": "allRuns",
    "All Run Metres": "allRunMetres",
    "Kick Return Metres": "kickReturnMetres",
    "Post Contact Metres": "postContactMetres",
    "Line Breaks": "lineBreaks",
    "Line Break Assists": "lineBreakAssists",
    "Try Assists": "tryAssists",
    "Line Engaged Runs": "lineEngagedRuns",
    "Tackle Breaks": "tackleBreaks",
    "Hit Ups": "hitUps",
    "Play The Ball": "playTheBallTotal",
    "Average Play The Ball Speed": "playTheBallAverageSpeed",
    "Dummy Half Runs": "dummyHalfRuns",
    "Dummy Half Run Metres": "dummyHalfRunMetres",
    "One on One Steal": "oneOnOneSteal",
    "Offloads": "offloads",
    "Dummy Passes": "dummyPasses",
    "Passes": "passes",
    "Receipts": "receipts",
    "Passes To Run Ratio": "passesToRunRatio",
    "Tackle Efficiency": "tackleEfficiency",
    "Tackles Made": "tacklesMade",
    "Missed Tackles": "missedTackles",
    "Ineffective Tackles": "ineffectiveTackles",
    "Intercepts": "intercepts",
    "Kicks Defused": "kicksDefused",
    "Kicks": "kicks",
    "Kicking Metres": "kickMetres",
    "Forced Drop Outs": "forcedDropOutKicks",
    "Bomb Kicks": "bombKicks",
    "Grubbers": "grubberKicks",
    "40/20": "fortyTwentyKicks",
    "20/40": "twentyFortyKicks",
    "Cross Field Kicks": "crossFieldKicks",
    "Kicked Dead": "kicksDead",
    "Errors": "errors",
    "Handling Errors": "handlingErrors",
    "One on One Lost": "oneOnOneLost",
    "Penalties": "penalties",
    "Ruck Infringements": "ruckInfringements",
    "Inside 10 Metres": "offsideWithinTenMetres",
    "On Report": "onReport",
    "Sin Bins": "sinBins",
    "Send Offs": "sendOffs",
    "Stint One": "stintOne",
    "Stint Two": "stintTwo",
}


def format_player_stat_value(value):
    if value is None:
        return "na"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f"{value:.2f}".rstrip("0").rstrip(".")
    text = str(value).strip()
    return text or "na"


def extract_player_round_from_q_data(html_text):
    soup = BeautifulSoup(html_text, "html.parser")
    match_centre = soup.find("div", id="vue-match-centre")
    if not match_centre:
        return []

    raw_payload = match_centre.get("q-data")
    if not raw_payload:
        return []

    try:
        payload = json.loads(raw_payload.replace("&quot;", '"'))
    except json.JSONDecodeError:
        return []

    match_payload = payload.get("match") or {}
    stats_players = ((match_payload.get("stats") or {}).get("players") or {})
    players_info = []
    seen_players = set()

    for side_key, team_payload in (("homeTeam", match_payload.get("homeTeam") or {}), ("awayTeam", match_payload.get("awayTeam") or {})):
        roster = team_payload.get("players") or []
        stats_rows = stats_players.get(side_key) or []
        roster_by_id = {player.get("playerId"): player for player in roster if player.get("playerId") is not None}

        for stat_row in stats_rows:
            roster_row = roster_by_id.get(stat_row.get("playerId"), {})
            first_name = roster_row.get("firstName", "")
            last_name = roster_row.get("lastName", "")
            full_name = " ".join(part for part in [first_name, last_name] if part).strip()

            player_info = {
                "Name": full_name or "Unknown",
                "Number": format_player_stat_value(roster_row.get("number")),
                "Position": roster_row.get("position", "na") or "na",
            }

            for label in EV.PLAYER_LABELS:
                if label in ("Number", "Position"):
                    continue
                stat_key = PLAYER_STAT_KEY_MAP.get(label)
                player_info[label] = format_player_stat_value(stat_row.get(stat_key))

            key = (player_info.get("Name"), player_info.get("Number"))
            if key in seen_players:
                continue
            seen_players.add(key)
            players_info.append(player_info)

    return players_info


def player_data_select(SELECT_YEAR, SELECT_ROUND, SELECTION_TYPE):
    selection_mapping = {
        "NRLW": (EV.NRLW_TEAMS, EV.NRLW_WEBSITE),
        "KNOCKON": (EV.KNOCKON_TEAMS, EV.KNOCKON_WEBSITE),
        "HOSTPLUS": (EV.HOSTPLUS_TEAMS, EV.HOSTPLUS_WEBSITE),
    }

    website = EV.NRL_WEBSITE
    teams = EV.TEAMS
    teams, website = selection_mapping.get(SELECTION_TYPE, (teams, website))
    _ = (teams, website)  # Preserved for compatibility with the original shape.

    player_stats_file = f"../data/{SELECTION_TYPE}/{SELECT_YEAR}/{SELECTION_TYPE}_player_statistics_{SELECT_YEAR}.json"

    player_stats = {"PlayerStats": [{str(SELECT_YEAR): []}]}

    with open(f"../data/{SELECTION_TYPE}/{SELECT_YEAR}/{SELECTION_TYPE}_data_{SELECT_YEAR}.json", "r") as file:
        data = json.load(file)[SELECTION_TYPE]

    years_arr = {SELECT_YEAR: data[0][str(SELECT_YEAR)]}
    driver = set_up_driver()
    missing_matches = []

    print("TOTAL ROUND BLOCKS:", len(years_arr[SELECT_YEAR]))
    for i, round_block in enumerate(years_arr[SELECT_YEAR]):
        print(i, list(round_block.keys()))

    try:
        for round_index in range(SELECT_ROUND):
            round_data = years_arr[SELECT_YEAR][round_index][str(round_index + 1)]
            round_results = []

            for game in round_data:
                url = game["Match_Centre_URL"]
                home_team = game["Home"].replace(" ", "-")
                away_team = game["Away"].replace(" ", "-")
                match_key = f"{SELECT_YEAR}-{round_index + 1}-{home_team}-v-{away_team}"
                print(f"Fetching: {url}")

                try:
                    driver.get(url)
                    players_info = extract_player_round_from_q_data(driver.page_source)
                    reason = None

                    if len(players_info) < 10:
                        reason = "no_qdata_players_initial"
                        time.sleep(2)
                        players_info = extract_player_round_from_q_data(driver.page_source)
                        if len(players_info) >= 10:
                            reason = "loaded_after_wait"
                        else:
                            reason = "still_no_qdata_players"

                    if len(players_info) < 20 and reason is None:
                        reason = "too_few_players"

                    if reason:
                        print(f"[MISS] {match_key} -> {reason}")
                        missing_matches.append({
                            "match_key": match_key,
                            "year": SELECT_YEAR,
                            "round": round_index + 1,
                            "reason": reason,
                            "players_found": len(players_info),
                        })

                    round_results.append({match_key: players_info})
                    print(f"Processed match: {match_key}")
                except Exception as ex:
                    print(f"[ERROR] {match_key}: {ex}")
                    missing_matches.append({
                        "match_key": match_key,
                        "year": SELECT_YEAR,
                        "round": round_index + 1,
                        "reason": "exception",
                        "players_found": 0,
                    })
                    round_results.append({match_key: []})

            player_stats["PlayerStats"][0][str(SELECT_YEAR)].append({str(round_index + 1): round_results})

            with open(player_stats_file, "w") as file:
                json.dump(player_stats, file, indent=4)

            print(f"Round {round_index + 1} data saved.")
    finally:
        driver.quit()

    if missing_matches:
        csv_file = f"missing_player_matches_{SELECT_YEAR}.csv"
        with open(csv_file, "w", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=["match_key", "year", "round", "reason", "players_found"],
            )
            writer.writeheader()
            writer.writerows(missing_matches)

        print(f"\nMissing match log saved: {csv_file}")
        print(f"Total missing matches: {len(missing_matches)}")

    print(f"Final player statistics saved to {player_stats_file}")
