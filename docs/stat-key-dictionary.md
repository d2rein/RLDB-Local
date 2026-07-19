# Flattened Stat Key Notes

## Team-level detailed match stats

The NRL detailed-match JSON is flattened into:

- `match_label`
- `side` (`home`, `away`, or `match`)
- `stat_key_raw`
- `stat_key`
- `stat_value_text`
- `stat_value_num`

Examples:

- `All Run Metres` -> `all_run_metres`
- `Average_Play_Ball_Speed` -> `average_play_ball_speed`
- `Completion Rate` -> `completion_rate`
- `overall_first_try_scorer` -> `overall_first_try_scorer`

## Player-level stats

The NRL player-stat JSON is flattened into:

- `season`
- `round_label`
- `source_match_key`
- `player_name`
- `jumper_number`
- `position_label`
- `stat_key_raw`
- `stat_key`
- `stat_value_text`
- `stat_value_num`

Examples:

- `All Run Metres` -> `all_run_metres`
- `Try Assists` -> `try_assists`
- `Mins Played` -> `mins_played`
- `Tackle Efficiency` -> `tackle_efficiency`
- `1 Point Field Goals` -> `1_point_field_goals`

## Important import note

The raw source label is always preserved alongside the normalized key so we can re-map or promote fields later without losing provenance.
