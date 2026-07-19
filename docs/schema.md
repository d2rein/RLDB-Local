# Schema Plan

## competitions

- `competition_id` INTEGER PRIMARY KEY
- `code` TEXT UNIQUE NOT NULL
- `name` TEXT NOT NULL

Examples:
- `NRL`
- `NRLW`

## teams

- `team_id` INTEGER PRIMARY KEY
- `competition_id` INTEGER NOT NULL
- `canonical_name` TEXT NOT NULL
- `short_name` TEXT
- `first_season` INTEGER
- `last_season` INTEGER
- `is_active` INTEGER NOT NULL DEFAULT 1

## team_aliases

- `team_alias_id` INTEGER PRIMARY KEY
- `team_id` INTEGER NOT NULL
- `source` TEXT NOT NULL
- `source_name` TEXT NOT NULL
- `first_season` INTEGER
- `last_season` INTEGER

## venues

- `venue_id` INTEGER PRIMARY KEY
- `canonical_name` TEXT NOT NULL
- `afltables_name` TEXT
- `nrl_name` TEXT
- `city` TEXT
- `country` TEXT

## players

- `player_id` INTEGER PRIMARY KEY
- `display_name` TEXT NOT NULL
- `sort_name` TEXT
- `first_season` INTEGER
- `last_season` INTEGER
- `afltables_player_url` TEXT
- `is_unresolved` INTEGER NOT NULL DEFAULT 0

## player_aliases

- `player_alias_id` INTEGER PRIMARY KEY
- `player_id` INTEGER NOT NULL
- `source` TEXT NOT NULL
- `source_name` TEXT NOT NULL
- `first_season` INTEGER
- `last_season` INTEGER
- `confidence` REAL

## matches

- `match_id` INTEGER PRIMARY KEY
- `competition_id` INTEGER NOT NULL
- `season` INTEGER NOT NULL
- `round_label` TEXT NOT NULL
- `round_index` INTEGER NOT NULL
- `match_date_utc` TEXT
- `match_date_local_text` TEXT
- `is_finals` INTEGER NOT NULL
- `home_team_id` INTEGER NOT NULL
- `away_team_id` INTEGER NOT NULL
- `home_score` INTEGER
- `away_score` INTEGER
- `winner_team_id` INTEGER
- `margin` INTEGER
- `venue_id` INTEGER
- `notes` TEXT

## match_sources

- `match_source_id` INTEGER PRIMARY KEY
- `match_id` INTEGER NOT NULL
- `source` TEXT NOT NULL
- `source_match_key` TEXT
- `source_round_label` TEXT
- `source_round_index` INTEGER
- `source_date` TEXT
- `source_home_team` TEXT
- `source_away_team` TEXT
- `source_home_score` TEXT
- `source_away_score` TEXT
- `source_venue` TEXT
- `source_url` TEXT

## match_team_stats

- `match_team_stat_id` INTEGER PRIMARY KEY
- `match_id` INTEGER NOT NULL
- `team_id` INTEGER NOT NULL
- `is_home` INTEGER NOT NULL
- `stat_key` TEXT NOT NULL
- `stat_value_text` TEXT
- `stat_value_num` REAL

This EAV-style table gives flexibility for the NRL detailed-match JSON without constant schema churn.

## match_player_stats

- `match_player_stat_id` INTEGER PRIMARY KEY
- `match_id` INTEGER NOT NULL
- `team_id` INTEGER NOT NULL
- `player_id` INTEGER
- `player_name_raw` TEXT NOT NULL
- `jumper_number` INTEGER
- `position_label` TEXT
- `stat_key` TEXT NOT NULL
- `stat_value_text` TEXT
- `stat_value_num` REAL

## legacy_player_scoring

- `legacy_player_scoring_id` INTEGER PRIMARY KEY
- `match_id` INTEGER
- `season` INTEGER NOT NULL
- `player_id` INTEGER
- `player_name_raw` TEXT NOT NULL
- `team_id` INTEGER
- `tries` INTEGER NOT NULL DEFAULT 0
- `goals` INTEGER NOT NULL DEFAULT 0
- `fg1` INTEGER NOT NULL DEFAULT 0
- `fg2` INTEGER NOT NULL DEFAULT 0
- `points` INTEGER NOT NULL

## player_team_spells

- `player_team_spell_id` INTEGER PRIMARY KEY
- `player_id` INTEGER NOT NULL
- `team_id` INTEGER NOT NULL
- `first_match_id` INTEGER
- `last_match_id` INTEGER
- `first_season` INTEGER
- `last_season` INTEGER

## import_issues

- `import_issue_id` INTEGER PRIMARY KEY
- `entity_type` TEXT NOT NULL
- `source` TEXT NOT NULL
- `source_key` TEXT
- `season` INTEGER
- `issue_type` TEXT NOT NULL
- `details_json` TEXT
- `status` TEXT NOT NULL DEFAULT 'open'

## Important Indexes

- `matches(competition_id, season, round_index, match_date_utc)`
- `matches(home_team_id, season, match_date_utc)`
- `matches(away_team_id, season, match_date_utc)`
- `matches(is_finals, season, match_date_utc)`
- `match_team_stats(match_id, team_id, stat_key)`
- `match_team_stats(stat_key, stat_value_num)`
- `match_player_stats(match_id, player_id, stat_key)`
- `match_player_stats(player_id, stat_key, stat_value_num)`
- `legacy_player_scoring(player_id, season)`
- `player_aliases(source, source_name)`
- `team_aliases(source, source_name)`
