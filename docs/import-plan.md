# Import Plan

## Source Files

1. Reconciled match backbone
- `master_matches_reconciled.csv`

2. Detailed match team stats
- `NRL_detailed_match_data_*.json`

3. Match-level player stats
- `NRL_player_statistics_*.json`

4. Legacy scorer rows
- `player_stats.csv`

## Import Sequence

1. Load competitions
2. Load teams and aliases
3. Load venues
4. Load reconciled matches
5. Load match source provenance rows
6. Build initial player universe from AFLTables scoring data
7. Import legacy scoring rows
8. Import modern player stats rows with alias matching
9. Import modern detailed match team stats
10. Write unresolved names and collisions to `import_issues`

## Matching Rules

### Match matching

Use the reconciled CSV as the canonical match backbone.

### Team matching

Use canonical team names from the reconciled export and preserve source aliases separately.

### Player matching

Primary approach:
- first exact alias match on source + season window
- then exact alias match ignoring season window
- otherwise create/open `import_issues`

## Streak Support

Streak queries depend on:

- stable canonical `match_id`
- sortable `season`, `round_index`, `match_date_utc`
- derived result fields
- finals flag
- player/team participation tables

We should generate derived views or query-side window-function SQL later, but the base schema supports it from day one.
