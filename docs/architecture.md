# Architecture

## Product Shape

The application is a public Statsguru-style rugby league query tool with dense, filter-heavy UI and shareable query results.

## Platform

- Cloudflare Pages for the frontend shell
- Cloudflare Workers for API/query execution
- Cloudflare D1 for relational storage

## Core Design Principles

- Do not mutate source data files
- Preserve source-level provenance in imported records
- Prefer reconciled match identity from the local master export
- Prefer NRL.com orientation and values when source rows disagree
- Support NRLW later by treating competition as a first-class dimension
- Design schema to support both leaderboard and streak queries

## Data Layers

1. Canonical dimensions
- competitions
- teams
- venues
- players
- player_aliases

2. Match backbone
- matches
- match_sources

3. Team and player stat facts
- match_team_stats
- match_player_stats

4. Legacy scorer support
- legacy_player_scoring

5. Query acceleration / audit
- import_issues
- optional derived summary tables later

## Query Modes

- Team stats
- Player stats
- Team streaks
- Player streaks

## Initial Query Targets

- Leading try scorers all time
- Most consecutive team wins/losses
- Greatest winning margins
- Most consecutive wins to start a season
- Most games played by a player
- Most tries in a season
- Most points scored all time / season / club
- Single-season modern player stat leaderboards

## Player Identity Strategy

Player identity is not fully clean across sources, so the schema must support:

- internal `player_id`
- multiple aliases per player
- source-specific external references
- unresolved import issues for manual review

The AFLTables scorer universe is the starting point for the master player list, but not the only source of truth.
