"""
Optimized Web Scraper for NRL Team Statistics
"""

import requests
from bs4 import BeautifulSoup
import sys

sys.path.append("..")
import ENVIRONMENT_VARIABLES as EV
import requests
import json
from bs4 import BeautifulSoup

def team_nickname(team, side, match_centre_url):
    nickname = team.get("nickName")
    if nickname:
        return nickname

    slug = str(match_centre_url or "").rstrip("/").split("/")[-1]
    divider = "-v-"
    if divider in slug:
        home_slug, away_slug = slug.split(divider, 1)
        selected_slug = home_slug if side == "home" else away_slug
        return selected_slug.replace("-", " ").title()

    return ""

def get_nrl_data(round=1, year=2024, competition = '111'):
    url = f"https://www.nrl.com/draw/?competition={competition}&round={round}&season={year}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
    
    response = requests.get(url, headers=headers)
    if response.status_code != 200:
        print("Failed to fetch data")
        return None

    soup = BeautifulSoup(response.text, "html.parser")
    
    # Find the JSON data within the HTML
    script_tag = soup.find("div", {"id": "vue-draw"})
    if not script_tag:
        print("Could not find fixture data")
        return None

    # Extract JSON from q-data attribute
    raw_json = script_tag["q-data"]
    raw_json = raw_json.replace("&quot;", '"')  # Fix encoding

    # Convert to Python dictionary
    data = json.loads(raw_json)

    fixtures = data.get("fixtures", [])
    
    matches_json = []
    for fixture in fixtures:
        if fixture["type"] == "Match":
            match_centre_url = fixture["matchCentreUrl"]
            match = {
                "Round": fixture["roundTitle"],
                "Home": team_nickname(fixture["homeTeam"], "home", match_centre_url),
                "Home_Score": fixture["homeTeam"].get("score", 0),
                "Away": team_nickname(fixture["awayTeam"], "away", match_centre_url),
                "Away_Score": fixture["awayTeam"].get("score", 0),
                "Venue": fixture["venue"],
                "Date": fixture["clock"]["kickOffTimeLong"],
                "Match_Centre_URL": f"https://www.nrl.com{match_centre_url}",
            }
            matches_json.append(match)

    round_data = {
        f"{round}": matches_json
    }
    return round_data
