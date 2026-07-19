"""
Refresh the most recent completed rounds for an NRL dataset.

This script is designed for incremental weekly updates:
- it uses the latest completed detailed round in the year file as the baseline
- it re-scrapes the most recent completed rounds plus a small look-ahead
- it only writes rounds whose detailed and player pages look complete
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

from bs4 import BeautifulSoup

from match_data_select import match_data_select
from utilities.get_detailed_match_data import get_detailed_nrl_data
from utilities.get_nrl_data import get_nrl_data
from utilities.set_up_driver import set_up_driver

sys.path.append("..")
import ENVIRONMENT_VARIABLES as EV


ROOT = Path(__file__).resolve().parent
DATA_ROOT = (ROOT / ".." / "data").resolve()

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selection", default="NRL")
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--recent-round-count", type=int, default=2)
    parser.add_argument("--lookahead-rounds", type=int, default=2)
    parser.add_argument("--start-round", type=int, default=None)
    parser.add_argument("--end-round", type=int, default=None)
    return parser.parse_args()


def competition_id(selection_type: str) -> str:
    return EV.COMPETITION[selection_type]


def year_dir(selection_type: str, year: int) -> Path:
    path = DATA_ROOT / selection_type / str(year)
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=4)


def format_player_stat_value(value: Any) -> str:
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


def extract_player_round_from_q_data(html_text: str) -> List[Dict[str, Any]]:
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
    players_info: List[Dict[str, Any]] = []
    seen_players = set()

    for side_key, team_payload in (("homeTeam", match_payload.get("homeTeam") or {}), ("awayTeam", match_payload.get("awayTeam") or {})):
        roster = team_payload.get("players") or []
        stats_rows = stats_players.get(side_key) or []
        roster_by_id = {
            player.get("playerId"): player
            for player in roster
            if player.get("playerId") is not None
        }

        for stat_row in stats_rows:
            roster_row = roster_by_id.get(stat_row.get("playerId"), {})
            first_name = roster_row.get("firstName", "")
            last_name = roster_row.get("lastName", "")
            full_name = " ".join(part for part in [first_name, last_name] if part).strip()

            player_info: Dict[str, Any] = {
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


def latest_completed_round_from_detailed(path: Path) -> int:
    payload = load_json(path, {"NRL": []})
    rounds = payload.get("NRL", [])
    round_numbers = []
    for item in rounds:
        if not isinstance(item, dict) or not item:
            continue
        try:
            round_numbers.append(int(next(iter(item.keys()))))
        except Exception:
            continue
    return max(round_numbers, default=0)


def merge_round_list(existing: List[Dict[str, Any]], round_number: int, round_payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    merged = [item for item in existing if str(round_number) not in item]
    merged.append(round_payload)
    merged.sort(key=lambda item: int(next(iter(item.keys()))))
    return merged


def load_match_file(selection_type: str, year: int) -> Tuple[Path, Dict[str, Any]]:
    path = year_dir(selection_type, year) / f"{selection_type}_data_{year}.json"
    payload = load_json(path, {selection_type: [{str(year): []}]})
    if selection_type not in payload or not payload[selection_type]:
        payload = {selection_type: [{str(year): []}]}
    if str(year) not in payload[selection_type][0]:
        payload[selection_type][0][str(year)] = []
    return path, payload


def load_detailed_file(selection_type: str, year: int) -> Tuple[Path, Dict[str, Any]]:
    path = year_dir(selection_type, year) / f"{selection_type}_detailed_match_data_{year}.json"
    payload = load_json(path, {selection_type: []})
    if selection_type not in payload:
        payload = {selection_type: []}
    return path, payload


def load_player_file(selection_type: str, year: int) -> Tuple[Path, Dict[str, Any]]:
    path = year_dir(selection_type, year) / f"{selection_type}_player_statistics_{year}.json"
    payload = load_json(path, {"PlayerStats": [{str(year): []}]})
    if "PlayerStats" not in payload or not payload["PlayerStats"]:
        payload = {"PlayerStats": [{str(year): []}]}
    if str(year) not in payload["PlayerStats"][0]:
        payload["PlayerStats"][0][str(year)] = []
    return path, payload


def fetch_round_matches(round_number: int, year: int, selection_type: str) -> List[Dict[str, Any]]:
    round_json = get_nrl_data(round_number, year, competition_id(selection_type))
    if not round_json:
        return []
    return round_json.get(str(round_number), [])


def match_round_complete(matches: List[Dict[str, Any]]) -> bool:
    if not matches:
        return False
    complete_scores = 0
    for match in matches:
      home_score = match.get("Home_Score")
      away_score = match.get("Away_Score")
      if isinstance(home_score, int) and isinstance(away_score, int) and not (home_score == 0 and away_score == 0):
          complete_scores += 1
    return complete_scores >= max(1, len(matches) - 1)


def fetch_detailed_round(driver: Any, matches: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], bool]:
    round_payload: List[Dict[str, Any]] = []

    for game in matches:
        home_team = game["Home"]
        away_team = game["Away"]
        url = game.get("Match_Centre_URL")
        if not url:
            continue
        try:
            match_data = get_detailed_nrl_data(url=url, home_team=home_team, away_team=away_team, driver=driver)
            if match_data:
                round_payload.append({f"{home_team} v {away_team}": match_data})
        except Exception as exc:
            print(f"[detailed] failed for {home_team} v {away_team}: {exc}")

    is_complete = len(round_payload) == len(matches)
    return round_payload, is_complete


def fetch_player_round(driver: Any, matches: List[Dict[str, Any]], year: int, round_number: int) -> Tuple[List[Dict[str, Any]], bool, List[Dict[str, Any]]]:
    round_results: List[Dict[str, Any]] = []
    missing_matches: List[Dict[str, Any]] = []
    complete_matches = 0

    for game in matches:
        url = game["Match_Centre_URL"]
        home_team = game["Home"].replace(" ", "-")
        away_team = game["Away"].replace(" ", "-")
        match_key = f"{year}-{round_number}-{home_team}-v-{away_team}"
        reason = None

        try:
            driver.get(url)
            players_info = extract_player_round_from_q_data(driver.page_source)

            if len(players_info) < 10:
                reason = "no_qdata_players_initial"
                time.sleep(2)
                players_info = extract_player_round_from_q_data(driver.page_source)
                if len(players_info) < 10:
                    reason = "still_no_qdata_players"
                else:
                    reason = None

            if len(players_info) < 20:
                reason = reason or "too_few_players"
            else:
                reason = None
                complete_matches += 1

            if reason:
                missing_matches.append({
                    "match_key": match_key,
                    "year": year,
                    "round": round_number,
                    "reason": reason,
                    "players_found": len(players_info),
                })

            round_results.append({match_key: players_info})
        except Exception as exc:
            print(f"[player] failed for {match_key}: {exc}")
            missing_matches.append({
                "match_key": match_key,
                "year": year,
                "round": round_number,
                "reason": "exception",
                "players_found": 0,
            })
            round_results.append({match_key: []})

    is_complete = bool(matches) and complete_matches >= len(matches)
    return round_results, is_complete, missing_matches


def write_missing_log(selection_type: str, year: int, missing_matches: List[Dict[str, Any]]) -> None:
    filename = f"missing_player_matches_{year}.csv" if selection_type == "NRL" else f"missing_player_matches_{selection_type}_{year}.csv"
    path = ROOT / filename
    if not missing_matches:
        if path.exists():
            path.unlink()
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["match_key", "year", "round", "reason", "players_found"])
        writer.writeheader()
        writer.writerows(missing_matches)
    print(f"Missing player log saved to {path}")


def main() -> int:
    args = parse_args()
    selection_type = args.selection
    year = args.year

    detailed_path, detailed_payload = load_detailed_file(selection_type, year)
    latest_completed_round = latest_completed_round_from_detailed(detailed_path)

    if args.start_round is not None and args.end_round is not None:
        start_round = args.start_round
        end_round = args.end_round
    else:
        start_round = max(1, latest_completed_round - args.recent_round_count + 1)
        end_round = latest_completed_round + args.lookahead_rounds

    print(f"Refreshing {selection_type} {year} rounds {start_round} to {end_round} (latest completed in file: {latest_completed_round})")

    match_path, match_payload = load_match_file(selection_type, year)
    player_path, player_payload = load_player_file(selection_type, year)

    driver = set_up_driver()
    missing_matches: List[Dict[str, Any]] = []

    try:
        for round_number in range(start_round, end_round + 1):
            matches = fetch_round_matches(round_number, year, selection_type)
            if not matches:
                print(f"[skip] round {round_number}: no matches returned")
                continue

            detailed_round, detailed_complete = fetch_detailed_round(driver, matches)
            player_round, player_complete, player_missing = fetch_player_round(driver, matches, year, round_number)
            missing_matches.extend(player_missing)

            basic_complete = match_round_complete(matches)
            if not (basic_complete and detailed_complete and player_complete):
                print(
                    f"[skip] round {round_number}: "
                    f"basic_complete={basic_complete}, detailed_complete={detailed_complete}, player_complete={player_complete}"
                )
                continue

            print(f"[write] round {round_number}: complete data found, updating files")

            match_payload[selection_type][0][str(year)] = merge_round_list(
                match_payload[selection_type][0][str(year)],
                round_number,
                {str(round_number): matches},
            )
            detailed_payload[selection_type] = merge_round_list(
                detailed_payload[selection_type],
                round_number,
                {str(round_number): detailed_round},
            )
            player_payload["PlayerStats"][0][str(year)] = merge_round_list(
                player_payload["PlayerStats"][0][str(year)],
                round_number,
                {str(round_number): player_round},
            )

            # Persist each successful round immediately so long refresh runs can resume safely.
            save_json(match_path, match_payload)
            save_json(detailed_path, detailed_payload)
            save_json(player_path, player_payload)

        save_json(match_path, match_payload)
        save_json(detailed_path, detailed_payload)
        save_json(player_path, player_payload)
        write_missing_log(selection_type, year, missing_matches)
    finally:
        driver.quit()

    print("Recent round refresh complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
