"""
Optimized Web Scraper for Finding NRL Team Statistics
"""

from bs4 import BeautifulSoup
from utilities.set_up_driver import set_up_driver
import html
import json
import sys

sys.path.append("..")
import ENVIRONMENT_VARIABLES as EV

# Default statistics with missing values set to -1
BARS_DATA = {
    'time_in_possession': -1, 'all_runs': -1, 'all_run_metres': -1, 'post_contact_metres': -1,
    'line_breaks': -1, 'tackle_breaks': -1, 'average_set_distance': -1, 'kick_return_metres': -1,
    'offloads': -1, 'receipts': -1, 'total_passes': -1, 'dummy_passes': -1, 'kicks': -1, 'kicking_metres': -1,
    'forced_drop_outs': -1, 'bombs': -1, 'grubbers': -1, 'tackles_made': -1, 'missed_tackles': -1,
    'intercepts': -1, 'ineffective_tackles': -1, 'errors': -1, 'penalties_conceded': -1, 'ruck_infringements': -1,
    'inside_10_metres': -1, 'interchanges_used': -1
}

DONUT_DATA = {
    'Completion Rate': -1, 'Average_Play_Ball_Speed': -1,
    'Kick_Defusal': -1, 'Effective_Tackle': -1
}

DONUT_DATA_2 = {
    'tries': -1, 'conversions': -1, 'penalty_goals': -1, 'sin_bins': -1,
    'send_offs': -1, '1_point_field_goals': -1, '2_point_field_goals': -1, 'half_time': -1
}

DONUT_DATA_2_WORDS = [
    'TRIES', 'CONVERSIONS', 'PENALTY GOALS', 'SIN BINS',
    '1 POINT FIELD GOALS', '2 POINT FIELD GOALS', 'HALF TIME'
]

TEAM_STATS_TITLE_MAP = {
    "Time In Possession": "time_in_possession",
    "Completion Rate": "Completion Rate",
    "All Runs": "all_runs",
    "All Run Metres": "all_run_metres",
    "Post Contact Metres": "post_contact_metres",
    "Line Breaks": "line_breaks",
    "Tackle Breaks": "tackle_breaks",
    "Average Set Distance": "average_set_distance",
    "Kick Return Metres": "kick_return_metres",
    "Average Play The Ball Speed": "Average_Play_Ball_Speed",
    "Offloads": "offloads",
    "Receipts": "receipts",
    "Total Passes": "total_passes",
    "Dummy Passes": "dummy_passes",
    "Kicks": "kicks",
    "Kicking Metres": "kicking_metres",
    "Forced Drop Outs": "forced_drop_outs",
    "Kick Defusal %": "Kick_Defusal",
    "Bombs": "bombs",
    "Grubbers": "grubbers",
    "Effective Tackle %": "Effective_Tackle",
    "Tackles Made": "tackles_made",
    "Missed Tackles": "missed_tackles",
    "Intercepts": "intercepts",
    "Ineffective Tackles": "ineffective_tackles",
    "Errors": "errors",
    "Penalties Conceded": "penalties_conceded",
    "Ruck Infringements": "ruck_infringements",
    "Inside 10 Metres": "inside_10_metres",
    "Sin Bins": "sin_bins",
    "Send Offs": "send_offs",
    "Used": "interchanges_used",
}

SCORING_KEY_MAP = {
    "tries": "tries",
    "conversions": "conversions",
    "penaltyGoals": "penalty_goals",
    "sinBins": "sin_bins",
    "onePointFieldGoals": "1_point_field_goals",
    "twoPointFieldGoals": "2_point_field_goals",
}


def format_percentage(value):
    if value is None:
        return -1
    numeric = float(value)
    if numeric.is_integer():
        return f"{int(numeric)}%"
    return f"{numeric:.2f}%"


def format_seconds_as_mmss(value):
    if value is None:
        return -1
    total_seconds = int(round(float(value)))
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return f"{minutes}:{seconds:02d}"


def format_numberish(value):
    if value is None:
        return -1
    numeric = float(value)
    if numeric.is_integer():
        return str(int(numeric))
    return f"{numeric:.2f}".rstrip("0").rstrip(".")


def extract_side_value(stat, side):
    side_key = "homeValue" if side == "home" else "awayValue"
    side_value = stat.get(side_key)
    if not side_value or side_value.get("value") is None:
        return -1

    value = side_value.get("value")
    stat_type = stat.get("type")
    units = stat.get("units")

    if stat.get("title") == "Completion Rate":
        numerator = side_value.get("numerator")
        denominator = side_value.get("denominator")
        if numerator is not None and denominator is not None:
          return f"{int(round(float(value)))}%"
        return format_percentage(value)

    if units == "Minutes" and stat.get("title") == "Time In Possession":
        return format_seconds_as_mmss(value)

    if units == "Seconds":
        return f"{float(value):.2f}s".rstrip("0").rstrip(".").replace(".s", "s")

    if stat_type in ("Percentage", "PercentageCombined", "PercentageAndFraction"):
        return format_percentage(value)

    return format_numberish(value)


def extract_q_data_payload(soup):
    node = soup.find("div", id="vue-match-centre")
    if not node:
        return None
    raw = node.get("q-data")
    if not raw:
        return None
    try:
        return json.loads(html.unescape(raw)).get("match")
    except Exception:
        return None


def build_team_stats_from_q_data(match_payload):
    home_bars, away_bars = BARS_DATA.copy(), BARS_DATA.copy()
    home_donut, away_donut = DONUT_DATA.copy(), DONUT_DATA.copy()
    home_game_stats, away_game_stats = DONUT_DATA_2.copy(), DONUT_DATA_2.copy()

    for group in match_payload.get("stats", {}).get("groups", []):
        for stat in group.get("stats", []):
            mapped_key = TEAM_STATS_TITLE_MAP.get(stat.get("title"))
            if not mapped_key:
                continue

            home_value = extract_side_value(stat, "home")
            away_value = extract_side_value(stat, "away")

            if mapped_key in BARS_DATA:
                home_bars[mapped_key] = home_value
                away_bars[mapped_key] = away_value
            elif mapped_key in DONUT_DATA:
                home_donut[mapped_key] = home_value
                away_donut[mapped_key] = away_value
            elif mapped_key in DONUT_DATA_2:
                home_game_stats[mapped_key] = home_value
                away_game_stats[mapped_key] = away_value

    for side_key, game_stats in (("homeTeam", home_game_stats), ("awayTeam", away_game_stats)):
        scoring = match_payload.get(side_key, {}).get("scoring", {})
        for scoring_key, output_key in SCORING_KEY_MAP.items():
            payload = scoring.get(scoring_key)
            if payload is None:
                continue
            if isinstance(payload, dict):
                made = payload.get("made")
                attempts = payload.get("attempts")
                if attempts is not None and attempts > 0:
                    if made is None:
                        game_stats[output_key] = -1
                    else:
                        game_stats[output_key] = f"{int(made)}/{int(attempts)}"
                elif made is not None:
                    game_stats[output_key] = str(int(made))
            elif isinstance(payload, (int, float)):
                game_stats[output_key] = str(int(payload))

        half_time_score = scoring.get("halfTimeScore")
        if half_time_score is not None:
            game_stats["half_time"] = str(int(half_time_score))

    return home_bars, away_bars, home_donut, away_donut, home_game_stats, away_game_stats


def get_detailed_nrl_data(url, home_team, away_team, driver=None):
    print(f"Fetching data: {url}")

    # Webscrape the NRL website
    if driver is None:
        driver = set_up_driver()  # Only create a new driver if one isn't provided
    
    driver.get(url)
    soup = BeautifulSoup(driver.page_source, "html.parser")

    match_payload = extract_q_data_payload(soup)
    if match_payload:
        home_bars, away_bars, home_donut, away_donut, home_game_stats, away_game_stats = build_team_stats_from_q_data(match_payload)

        def extract_try_summaries(team_key):
            tries = match_payload.get(team_key, {}).get("scoring", {}).get("tries", {}).get("summaries", [])
            return tries if isinstance(tries, list) else []

        home_try_summaries = extract_try_summaries("homeTeam")
        away_try_summaries = extract_try_summaries("awayTeam")

        def summary_minute(text):
            if not text or "'" not in text:
                return None
            try:
                return int(str(text).rsplit(" ", 1)[-1].replace("'", ""))
            except Exception:
                return None

        def determine_first_scorer_from_summaries():
            home_first = home_try_summaries[0] if home_try_summaries else None
            away_first = away_try_summaries[0] if away_try_summaries else None
            if not home_first and not away_first:
                return None, None, None
            if home_first and not away_first:
                parts = str(home_first).rsplit(" ", 1)
                return parts[0], parts[1], home_team
            if away_first and not home_first:
                parts = str(away_first).rsplit(" ", 1)
                return parts[0], parts[1], away_team

            home_min = summary_minute(home_first)
            away_min = summary_minute(away_first)
            if away_min is None or (home_min is not None and home_min <= away_min):
                parts = str(home_first).rsplit(" ", 1)
                return parts[0], parts[1], home_team
            parts = str(away_first).rsplit(" ", 1)
            return parts[0], parts[1], away_team

        overall_first_try_scorer, overall_first_try_minute, overall_first_scorer_team = determine_first_scorer_from_summaries()

        officials = match_payload.get("officials", []) or []
        ref_names = []
        ref_positions = []
        for official in officials:
            first_name = official.get("firstName", "").strip()
            last_name = official.get("lastName", "").strip()
            full_name = " ".join(part for part in [first_name, last_name] if part)
            if full_name:
                ref_names.append(full_name)
                ref_positions.append(official.get("position"))
        main_ref_name = ref_names[0] if ref_names else None

        match_data = {
            'overall_first_try_scorer': overall_first_try_scorer,
            'overall_first_try_minute': overall_first_try_minute,
            'overall_first_try_round': overall_first_scorer_team,
            'ref_names': ref_names,
            'ref_positions': ref_positions,
            'main_ref': main_ref_name,
            'ground_condition': match_payload.get('groundConditions'),
            'weather_condition': match_payload.get('weather')
        }

        return {'match': match_data, 'home': {**home_bars, **home_donut, **home_game_stats}, 'away': {**away_bars, **away_donut, **away_game_stats}}

    # Fallback legacy DOM parsing if q-data is unavailable
    home_bars, away_bars = BARS_DATA.copy(), BARS_DATA.copy()
    home_donut, away_donut = DONUT_DATA.copy(), DONUT_DATA.copy()
    home_game_stats, away_game_stats = DONUT_DATA_2.copy(), DONUT_DATA_2.copy()

    def extract_bars(stat_list, bars_dict):
        for item, bar_name in zip(stat_list, bars_dict.keys()):
            bars_dict[bar_name] = item.get_text(strip=True)

    try:
        extract_bars(soup.find_all('dd', class_="stats-bar-chart__label--home"), home_bars)
        extract_bars(soup.find_all('dd', class_="stats-bar-chart__label--away"), away_bars)
    except Exception:
        print("Error: Issue extracting bar statistics.")

    try:
        elements = soup.find_all("p", class_="donut-chart-stat__value")
        numbers = [el.get_text(strip=True) for el in elements]
        home_donut.update(dict(zip(home_donut.keys(), numbers[::2])))
        away_donut.update(dict(zip(away_donut.keys(), numbers[1::2])))
    except Exception:
        print("Error: Issue extracting donut statistics.")

    def extract_try_scorers(team_class):
        try:
            tries = soup.find("ul", class_=team_class).find_all("li")
            names, times = zip(*[(t.get_text(strip=True).rsplit(" ", 1)) for t in tries])
            return list(names), list(times)
        except (AttributeError, ValueError):
            return [], []

    home_try_names, home_try_minutes = extract_try_scorers("match-centre-summary-group__list--home")
    away_try_names, away_try_minutes = extract_try_scorers("match-centre-summary-group__list--away")

    def determine_first_scorer():
        if not home_try_minutes and not away_try_minutes:
            return None, None, None
        elif not away_try_minutes or (home_try_minutes and home_try_minutes[0] < away_try_minutes[0]):
            return home_try_names[0], home_try_minutes[0], home_team
        else:
            return away_try_names[0], away_try_minutes[0], away_team

    overall_first_try_scorer, overall_first_try_minute, overall_first_scorer_team = determine_first_scorer()

    try:
        stats = [el.span.get_text(strip=True) for el in soup.find_all("span", class_="match-centre-summary-group__value")]
        home_game_stats.update(dict(zip(home_game_stats.keys(), stats[::2])))
        away_game_stats.update(dict(zip(away_game_stats.keys(), stats[1::2])))
    except Exception:
        print("Error: Issue extracting match summary statistics.")

    try:
        refs = soup.find_all("a", class_="card-team-mate")
        ref_names = [r.find("h3", class_="card-team-mate__name").get_text(strip=True) for r in refs]
        ref_positions = [r.find("p", class_="card-team-mate__position").get_text(strip=True) for r in refs]
        main_ref_name = ref_names[0] if ref_names else None
    except Exception:
        ref_names, ref_positions, main_ref_name = [], [], None
        print("Error: Issue extracting referee data.")

    ground_condition, weather_condition = None, None
    try:
        conditions = {p.get_text(strip=True).split(":")[0].strip(): p.span.get_text(strip=True) for p in soup.find_all("p", class_="match-weather__text")}
        ground_condition = conditions.get("Ground Conditions", None)
        weather_condition = conditions.get("Weather", None)
    except Exception:
        print("Error: Issue extracting weather/ground conditions.")

    match_data = {
        'overall_first_try_scorer': overall_first_try_scorer,
        'overall_first_try_minute': overall_first_try_minute,
        'overall_first_try_round': overall_first_scorer_team,
        'ref_names': ref_names, 'ref_positions': ref_positions, 'main_ref': main_ref_name,
        'ground_condition': ground_condition, 'weather_condition': weather_condition
    }

    return {'match': match_data, 'home': {**home_bars, **home_donut, **home_game_stats}, 'away': {**away_bars, **away_donut, **away_game_stats}}
