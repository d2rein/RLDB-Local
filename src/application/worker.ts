import { STAT_DEFINITIONS, STAT_GROUPS } from "./config/stat-definitions.mjs";
import {
  handleWithQueryTelemetry,
  type QueryTelemetryEnv,
} from "./query-telemetry";

type Env = QueryTelemetryEnv & {
  DB?: D1Database;
  REMOTE_QUERY_ORIGIN?: string;
  REMOTE_QUERY_TOKEN?: string;
  LOCAL_API_TOKEN?: string;
  STATS_SITE_PASSWORD_HASH?: string;
  STATS_SITE_SESSION_SECRET?: string;
};

type QueryRow = Record<string, unknown>;
type QueryCondition = {
  statKey: string;
  operator: string;
  value: string;
  joiner: string;
};
type QueryFilters = {
  competition: string;
  team: string;
  opponent: string;
  venue: string;
  referee: string;
  position: string;
  player: string;
  playerType: string;
  matchPlayer: string;
  debut: string;
  groundCondition: string;
  weatherCondition: string;
  homeAway: string;
  result: string;
  scoreHalf: string;
  excludeSparseHistoricalStreaks: boolean;
  excludeZeroMinuteStreakGames: boolean;
  roundFrom: number | null;
  roundTo: number | null;
  includeRegular: boolean;
  includeFinals: boolean;
  includeGrandFinal: boolean;
  conditions: QueryCondition[];
};

type AppBootstrap = {
  app: {
    name: string;
    version: string;
    status: string;
    dataFreshness: Array<{
      competition: string;
      season: number | null;
      roundLabel: string | null;
      roundIndex: number | null;
      matchDateUtc: string | null;
    }>;
  };
  filterOptions: {
    competitions: string[];
    teams: string[];
    players: string[];
    venues: string[];
    referees: string[];
    positions: string[];
    groundConditions: string[];
    weatherConditions: string[];
  };
  statGroups: Array<{
    code: string;
    label: string;
    sortOrder: number;
  }>;
  statDefinitions: Array<{
    scope: string;
    statKey: string;
    displayName: string;
    groupCode: string;
    missingValueStrategy?: string;
    firstConsistentSeason: number | null;
    supportsTotals: boolean;
    supportsAverages: boolean;
    supportsStreaks: boolean;
    isDerived: boolean;
    availabilityNotes: string;
  }>;
  starterQueries: Array<{
    id: string;
    label: string;
    mode: "team" | "player";
    metric: string;
    statKey: string;
    competition: string;
    format?: string;
  }>;
};

const APP_NAME = "Rugby League Stats Database";
const GRAND_FINAL_LABEL = "Grand Final";
const POSITION_OPTIONS = [
  "Any",
  "Fullback",
  "Wing",
  "Centre",
  "Five-Eighth",
  "Halfback",
  "Prop",
  "Hooker",
  "Second Row",
  "Lock",
  "Interchange",
];
const GROUND_CONDITION_OPTIONS = ["Any", "Dry", "Damp", "Soft", "Heavy", "Wet"];
const WEATHER_CONDITION_OPTIONS = ["Any", "Fine", "Cloudy", "Rain", "Showers", "Windy", "Storm"];
const HALF_TEAM_STATS = [
  "points_for_first_half",
  "points_against_first_half",
  "margin_first_half",
  "points_for_second_half",
  "points_against_second_half",
  "margin_second_half",
];
const MAIN_DROPDOWN_HIDDEN_STATS = new Set([
  "games_included",
  "half_time",
  "penalty_goals",
  "conversions",
  "conversions_with_attempts",
  "conversion_attempts",
  "goal_conversion_rate",
  "fantasy_points",
]);
const API_DEFAULT_LIMIT = 200;
const API_MAX_LIMIT = 500000;
const API_MAX_CONDITIONS = 12;
const API_MAX_QUERYSTRING_LENGTH = 4000;
const API_MAX_EXPORT_ROWS = 500000;
const DB_HEALTHCHECK_TIMEOUT_MS = 0;
const BOOTSTRAP_CACHE_TTL_MS = 5 * 60 * 1000;
const PLAYER_OPTIONS_CACHE_TTL_MS = 60 * 60 * 1000;
const SITE_AUTH_COOKIE_NAME = "rldb_site_session";
const SITE_AUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SITE_AUTH_LOCKOUT_THRESHOLD = 3;
const SITE_AUTH_LOCKOUT_DURATION_MS = 60 * 60 * 1000;
const SITE_AUTH_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const MIN_SEASON = 1908;
const MAX_SEASON = 2026;
const VALID_SCOPES = new Set(["player", "team"]);
const VALID_MODES = new Set(["totals", "averages", "streaks"]);
const VALID_FORMATS = new Set(["overall", "season", "match", "ground", "opposition", "club"]);
const VALID_EXPORT_DATASETS = new Set(["matches", "team_match_summary", "player_match_summary"]);
const PLAYER_PROFILE_TABLE_STAT_KEYS = [
  "tries",
  "field_goals_1pt",
  "field_goals_2pt",
  "goals",
  "points",
  "all_runs",
  "all_run_metres",
  "post_contact_metres",
  "try_assists",
  "line_breaks",
  "line_break_assists",
  "line_engaged_runs",
  "hit_ups",
  "dummy_half_runs",
  "dummy_half_run_metres",
  "tackle_breaks",
  "offloads",
  "tackles_made",
  "missed_tackles",
  "ineffective_tackles",
  "errors",
  "handling_errors",
  "penalties",
  "kicking_metres",
  "kicks",
  "bomb_kicks",
  "grubbers",
  "kicked_dead",
  "cross_field_kicks",
  "40_20",
  "20_40",
  "dummy_passes",
  "passes",
  "play_the_ball",
  "receipts",
  "one_on_one_steal",
  "one_on_one_lost",
  "kicks_defused",
  "sin_bins",
  "send_offs",
  "on_report",
  "minutes_played",
];
const PLAYER_PROFILE_RANK_STAT_KEYS = [
  "tries",
  "goals",
  "field_goals_1pt",
  "points",
  "all_run_metres",
  "try_assists",
  "line_breaks",
  "tackle_breaks",
  "offloads",
  "tackles_made",
  "errors",
  "kicking_metres",
];
const STAT_DEFINITION_BY_KEY = new Map(
  STAT_DEFINITIONS.map((definition) => [`${definition.scope}:${definition.statKey}`, definition])
);
const STAT_GROUP_LABEL_BY_CODE = new Map(STAT_GROUPS.map((group) => [group.code, group.label]));
const PROXY_ELIGIBLE_PATHS = new Set([
  "/api/health",
  "/api/meta/bootstrap",
  "/api/meta/players",
  "/api/meta/regression-suite",
  "/api/player-profile",
  "/api/player-rank-cards",
  "/api/match-detail",
  "/api/season-index",
  "/api/export",
  "/api/query",
  "/api/query/full",
]);
let bootstrapResponseCache: { value: AppBootstrap; cachedAtMs: number } | null = null;
let playerOptionsCache: { values: string[]; cachedAtMs: number } | null = null;
const siteAuthAttemptCache = new Map<string, {
  failureCount: number;
  firstFailureMs: number;
  lockedUntilMs: number | null;
  updatedAtMs: number;
}>();
type SiteAuthAuditOutcome = "login_success" | "login_failure" | "login_lockout";
type SiteAuthAuditEventPayload = {
  outcome: SiteAuthAuditOutcome;
  clientIp: string;
  userAgent: string;
  country: string;
  host: string;
  nextPath: string;
  detail: string;
};
type SiteAuthPresencePayload = {
  sessionKey: string;
  clientIp: string;
  userAgent: string;
  country: string;
  host: string;
  path: string;
};

const SITE_AUTH_AUDIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS site_auth_audit_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  outcome TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  country TEXT NOT NULL,
  host TEXT NOT NULL,
  next_path TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;
const SITE_AUTH_PRESENCE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS site_auth_presence (
  session_key TEXT PRIMARY KEY,
  first_seen_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client_ip TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  country TEXT NOT NULL,
  host TEXT NOT NULL,
  last_path TEXT NOT NULL
);
`;
function isUiHiddenStat(statKey: string): boolean {
  return MAIN_DROPDOWN_HIDDEN_STATS.has(statKey);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isSitePasswordProtectionEnabled(env: Env): boolean {
  return Boolean(env.STATS_SITE_PASSWORD_HASH && env.STATS_SITE_SESSION_SECRET);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function isForwardedHttpsRequest(request: Request): boolean {
  if ((request.headers.get("x-forwarded-proto") ?? "").toLowerCase() === "https") return true;
  const cfVisitor = request.headers.get("cf-visitor");
  if (!cfVisitor) return false;
  try {
    return String(JSON.parse(cfVisitor)?.scheme ?? "").toLowerCase() === "https";
  } catch {
    return false;
  }
}

function isProxyEligibleRequestPath(pathname: string): boolean {
  return PROXY_ELIGIBLE_PATHS.has(pathname);
}

function shouldRequireBackendToken(url: URL, env: Env): boolean {
  if (!env.LOCAL_API_TOKEN) return false;
  return !isLoopbackHostname(url.hostname);
}

function isAuthorizedBackendRequest(request: Request, env: Env): boolean {
  if (!env.LOCAL_API_TOKEN) return true;
  return (request.headers.get("x-rldb-token") ?? "") === env.LOCAL_API_TOKEN;
}

async function proxyToRemoteBackend(request: Request, url: URL, env: Env): Promise<Response | null> {
  const remoteOrigin = trimTrailingSlash(String(env.REMOTE_QUERY_ORIGIN ?? "").trim());
  if (!remoteOrigin || !isProxyEligibleRequestPath(url.pathname)) return null;

  const targetUrl = new URL(`${remoteOrigin}${url.pathname}${url.search}`);
  const headers = new Headers(request.headers);
  headers.set("x-rldb-proxied-by", "cloudflare-public-site");
  if (env.REMOTE_QUERY_TOKEN) {
    headers.set("x-rldb-token", env.REMOTE_QUERY_TOKEN);
  }

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

function parseCookies(request: Request): Map<string, string> {
  const headerValue = request.headers.get("cookie") ?? "";
  const cookies = new Map<string, string>();
  for (const fragment of headerValue.split(";")) {
    const trimmed = fragment.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies.set(key, value);
  }
  return cookies;
}

function normalizeNextPath(rawValue: string | null | undefined): string {
  if (!rawValue) return "/";
  if (!rawValue.startsWith("/")) return "/";
  if (rawValue.startsWith("//")) return "/";
  return rawValue;
}

function getClientIp(request: Request): string {
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp.trim();
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || "unknown";
  return "unknown";
}

function trimAuditField(value: string, maxLength = 255): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength);
}

function xorEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(digest);
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(signature);
}

async function buildSiteSessionCookieValue(env: Env, expiresAtSeconds: number): Promise<string> {
  const signature = await hmacSha256Hex(
    String(env.STATS_SITE_SESSION_SECRET ?? ""),
    `exp:${expiresAtSeconds}:pwd:${String(env.STATS_SITE_PASSWORD_HASH ?? "")}`
  );
  return `${expiresAtSeconds}.${signature}`;
}

async function hasValidSiteSession(request: Request, env: Env): Promise<boolean> {
  if (!isSitePasswordProtectionEnabled(env)) return true;
  const cookieValue = parseCookies(request).get(SITE_AUTH_COOKIE_NAME);
  if (!cookieValue) return false;
  const [expiresAtRaw, signature] = cookieValue.split(".", 2);
  const expiresAtSeconds = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtSeconds) || !signature) return false;
  if (Date.now() >= expiresAtSeconds * 1000) return false;
  const expectedSignature = await hmacSha256Hex(
    String(env.STATS_SITE_SESSION_SECRET ?? ""),
    `exp:${expiresAtSeconds}:pwd:${String(env.STATS_SITE_PASSWORD_HASH ?? "")}`
  );
  return xorEqual(signature, expectedSignature);
}

function buildSiteSessionCookieHeader(value: string): string {
  return `${SITE_AUTH_COOKIE_NAME}=${value}; Path=/; Max-Age=${SITE_AUTH_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function buildClearSiteSessionCookieHeader(): string {
  return `${SITE_AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location: string, headers?: HeadersInit): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      ...(headers ?? {}),
    },
  });
}

type SiteAuthLockoutState = {
  active: boolean;
  failureCount: number;
  remainingAttempts: number;
  lockedUntilMs: number | null;
};

function pruneSiteAuthAttemptCache(nowMs = Date.now()): void {
  for (const [key, value] of siteAuthAttemptCache.entries()) {
    const expiredLockout = value.lockedUntilMs !== null && value.lockedUntilMs <= nowMs;
    const staleFailures = nowMs - value.firstFailureMs > SITE_AUTH_FAILURE_WINDOW_MS;
    if (expiredLockout || staleFailures) {
      siteAuthAttemptCache.delete(key);
    }
  }
}

async function buildSiteAuthSubjectKey(request: Request, env: Env): Promise<string> {
  return hmacSha256Hex(String(env.STATS_SITE_SESSION_SECRET ?? "fallback"), `ip:${getClientIp(request)}`);
}

async function getSiteAuthLockoutState(_db: D1Database | undefined, request: Request, env: Env): Promise<SiteAuthLockoutState> {
  if (!isSitePasswordProtectionEnabled(env)) {
    return {
      active: false,
      failureCount: 0,
      remainingAttempts: SITE_AUTH_LOCKOUT_THRESHOLD,
      lockedUntilMs: null,
    };
  }

  pruneSiteAuthAttemptCache();
  const subjectKey = await buildSiteAuthSubjectKey(request, env);
  const row = siteAuthAttemptCache.get(subjectKey);
  if (!row) {
    return {
      active: false,
      failureCount: 0,
      remainingAttempts: SITE_AUTH_LOCKOUT_THRESHOLD,
      lockedUntilMs: null,
    };
  }

  const nowMs = Date.now();
  if (row.lockedUntilMs !== null && row.lockedUntilMs > nowMs) {
    return {
      active: true,
      failureCount: row.failureCount,
      remainingAttempts: 0,
      lockedUntilMs: row.lockedUntilMs,
    };
  }

  if (nowMs - row.firstFailureMs > SITE_AUTH_FAILURE_WINDOW_MS) {
    siteAuthAttemptCache.delete(subjectKey);
    return {
      active: false,
      failureCount: 0,
      remainingAttempts: SITE_AUTH_LOCKOUT_THRESHOLD,
      lockedUntilMs: null,
    };
  }

  return {
    active: false,
    failureCount: row.failureCount,
    remainingAttempts: Math.max(0, SITE_AUTH_LOCKOUT_THRESHOLD - row.failureCount),
    lockedUntilMs: null,
  };
}

async function clearSiteAuthAttempts(_db: D1Database | undefined, request: Request, env: Env): Promise<void> {
  if (!isSitePasswordProtectionEnabled(env)) return;
  const subjectKey = await buildSiteAuthSubjectKey(request, env);
  siteAuthAttemptCache.delete(subjectKey);
}

async function recordFailedSiteAuthAttempt(_db: D1Database | undefined, request: Request, env: Env): Promise<SiteAuthLockoutState> {
  const fallback = {
    active: false,
    failureCount: 1,
    remainingAttempts: Math.max(0, SITE_AUTH_LOCKOUT_THRESHOLD - 1),
    lockedUntilMs: null,
  };
  if (!isSitePasswordProtectionEnabled(env)) return fallback;

  pruneSiteAuthAttemptCache();
  const subjectKey = await buildSiteAuthSubjectKey(request, env);
  const currentState = await getSiteAuthLockoutState(undefined, request, env);
  const nowMs = Date.now();
  const nextFailureCount = currentState.failureCount + 1;
  const lockedUntilMs = nextFailureCount >= SITE_AUTH_LOCKOUT_THRESHOLD
    ? nowMs + SITE_AUTH_LOCKOUT_DURATION_MS
    : null;

  siteAuthAttemptCache.set(subjectKey, {
    failureCount: nextFailureCount,
    firstFailureMs: nowMs,
    lockedUntilMs,
    updatedAtMs: nowMs,
  });

  return {
    active: Boolean(lockedUntilMs),
    failureCount: nextFailureCount,
    remainingAttempts: lockedUntilMs ? 0 : Math.max(0, SITE_AUTH_LOCKOUT_THRESHOLD - nextFailureCount),
    lockedUntilMs,
  };
}

async function ensureSiteAuthAuditTable(db: D1Database): Promise<void> {
  const statements = SITE_AUTH_AUDIT_TABLE_SQL
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

async function ensureSiteAuthPresenceTable(db: D1Database): Promise<void> {
  const statements = SITE_AUTH_PRESENCE_TABLE_SQL
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

async function insertSiteAuthAuditEvent(db: D1Database, payload: SiteAuthAuditEventPayload): Promise<void> {
  await ensureSiteAuthAuditTable(db);
  await db
    .prepare(`
      INSERT INTO site_auth_audit_events (
        outcome,
        client_ip,
        user_agent,
        country,
        host,
        next_path,
        detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      payload.outcome,
      trimAuditField(payload.clientIp, 64) || "unknown",
      trimAuditField(payload.userAgent, 512),
      trimAuditField(payload.country, 32),
      trimAuditField(payload.host, 255),
      trimAuditField(payload.nextPath, 512),
      trimAuditField(payload.detail, 512)
    )
    .run();
}

async function readSiteAuthAuditEvents(db: D1Database, limit = 50, failuresOnly = false): Promise<Record<string, unknown>[]> {
  await ensureSiteAuthAuditTable(db);
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const statement = failuresOnly
    ? db.prepare(`
        SELECT
          event_id,
          recorded_at_utc,
          outcome,
          client_ip,
          user_agent,
          country,
          host,
          next_path,
          detail
        FROM site_auth_audit_events
        WHERE outcome <> 'login_success'
        ORDER BY event_id DESC
        LIMIT ?
      `)
    : db.prepare(`
        SELECT
          event_id,
          recorded_at_utc,
          outcome,
          client_ip,
          user_agent,
          country,
          host,
          next_path,
          detail
        FROM site_auth_audit_events
        ORDER BY event_id DESC
        LIMIT ?
      `);
  const result = await statement.bind(safeLimit).all<Record<string, unknown>>();
  return Array.isArray(result.results) ? result.results : [];
}

async function upsertSiteAuthPresence(db: D1Database, payload: SiteAuthPresencePayload): Promise<void> {
  await ensureSiteAuthPresenceTable(db);
  await db.prepare(`
    INSERT INTO site_auth_presence (
      session_key,
      client_ip,
      user_agent,
      country,
      host,
      last_path
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      last_seen_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      client_ip = excluded.client_ip,
      user_agent = excluded.user_agent,
      country = excluded.country,
      host = excluded.host,
      last_path = excluded.last_path
  `)
    .bind(
      trimAuditField(payload.sessionKey, 128),
      trimAuditField(payload.clientIp, 64) || "unknown",
      trimAuditField(payload.userAgent, 512),
      trimAuditField(payload.country, 32),
      trimAuditField(payload.host, 255),
      trimAuditField(payload.path, 512)
    )
    .run();
}

async function readActiveSiteAuthPresence(
  db: D1Database,
  limit = 50,
  activeWithinMinutes = 30
): Promise<Record<string, unknown>[]> {
  await ensureSiteAuthPresenceTable(db);
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const safeMinutes = Math.min(1440, Math.max(1, Math.trunc(activeWithinMinutes)));
  const result = await db.prepare(`
    SELECT
      session_key,
      first_seen_utc,
      last_seen_utc,
      client_ip,
      user_agent,
      country,
      host,
      last_path
    FROM site_auth_presence
    WHERE datetime(last_seen_utc) >= datetime('now', '-' || ? || ' minutes')
    ORDER BY datetime(last_seen_utc) DESC
    LIMIT ?
  `).bind(String(safeMinutes), safeLimit).all<Record<string, unknown>>();
  return Array.isArray(result.results) ? result.results : [];
}

async function sendSiteAuthAuditEvent(env: Env, payload: SiteAuthAuditEventPayload): Promise<void> {
  try {
    if (env.DB) {
      await insertSiteAuthAuditEvent(env.DB, payload);
      return;
    }

    const remoteOrigin = trimTrailingSlash(String(env.REMOTE_QUERY_ORIGIN ?? "").trim());
    if (!remoteOrigin) return;

    const headers = new Headers({
      "content-type": "application/json",
      "x-rldb-proxied-by": "cloudflare-public-site",
    });
    if (env.REMOTE_QUERY_TOKEN) {
      headers.set("x-rldb-token", env.REMOTE_QUERY_TOKEN);
    }

    await fetch(`${remoteOrigin}/api/internal/site-auth-events`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("Failed to record site auth audit event", error);
  }
}

async function buildSiteAuthPresencePayload(request: Request, env: Env): Promise<SiteAuthPresencePayload | null> {
  if (!isSitePasswordProtectionEnabled(env)) return null;
  const cookieValue = parseCookies(request).get(SITE_AUTH_COOKIE_NAME);
  if (!cookieValue) return null;
  const sessionKey = await hmacSha256Hex(String(env.STATS_SITE_SESSION_SECRET ?? "fallback"), `site-session:${cookieValue}`);
  const url = new URL(request.url);
  return {
    sessionKey,
    clientIp: getClientIp(request),
    userAgent: request.headers.get("user-agent") ?? "",
    country: request.headers.get("cf-ipcountry") ?? "",
    host: url.host,
    path: `${url.pathname}${url.search}`,
  };
}

async function sendSiteAuthPresenceEvent(env: Env, payload: SiteAuthPresencePayload): Promise<void> {
  try {
    if (env.DB) {
      await upsertSiteAuthPresence(env.DB, payload);
      return;
    }

    const remoteOrigin = trimTrailingSlash(String(env.REMOTE_QUERY_ORIGIN ?? "").trim());
    if (!remoteOrigin) return;

    const headers = new Headers({
      "content-type": "application/json",
      "x-rldb-proxied-by": "cloudflare-public-site",
    });
    if (env.REMOTE_QUERY_TOKEN) {
      headers.set("x-rldb-token", env.REMOTE_QUERY_TOKEN);
    }

    await fetch(`${remoteOrigin}/api/internal/site-auth-presence`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("Failed to record site auth presence event", error);
  }
}

function isApiLikeRequest(url: URL): boolean {
  return url.pathname.startsWith("/api/") || /^\/match\/\d+$/.test(url.pathname);
}

function buildSiteAuthAuditPayload(
  request: Request,
  outcome: SiteAuthAuditOutcome,
  nextPath: string,
  detail: string
): SiteAuthAuditEventPayload {
  const url = new URL(request.url);
  return {
    outcome,
    clientIp: getClientIp(request),
    userAgent: request.headers.get("user-agent") ?? "",
    country: request.headers.get("cf-ipcountry") ?? "",
    host: url.host,
    nextPath,
    detail,
  };
}

function buildSitePasswordGatePage(nextPath: string, errorMessage = "", lockedUntilMs: number | null = null): string {
  const lockedMessage = lockedUntilMs
    ? `Too many failed attempts. Try again after ${new Date(lockedUntilMs).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })}.`
    : "";
  const notice = errorMessage || lockedMessage || "Enter the shared site password to use the database.";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${APP_NAME} Login</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #11161f;
        --panel: #182131;
        --panel-border: #2e3d5b;
        --accent: #b9d57e;
        --text: #f4f7fb;
        --muted: #a9b4c9;
        --danger: #ffb4ab;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(185, 213, 126, 0.15), transparent 38%),
          linear-gradient(180deg, #0b1017 0%, var(--bg) 100%);
        font-family: "Segoe UI", system-ui, sans-serif;
        color: var(--text);
        padding: 24px;
      }
      .panel {
        width: min(420px, 100%);
        background: rgba(24, 33, 49, 0.94);
        border: 1px solid var(--panel-border);
        border-radius: 18px;
        padding: 28px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 1.8rem;
      }
      p {
        margin: 0 0 16px;
        color: var(--muted);
        line-height: 1.5;
      }
      .notice {
        color: ${lockedUntilMs ? "var(--danger)" : "var(--accent)"};
        margin-bottom: 18px;
      }
      label {
        display: block;
        font-size: 0.95rem;
        margin-bottom: 8px;
      }
      input[type="password"] {
        width: 100%;
        padding: 12px 14px;
        border-radius: 10px;
        border: 1px solid #415273;
        background: #0f1724;
        color: var(--text);
        margin-bottom: 16px;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 10px;
        padding: 12px 14px;
        background: var(--accent);
        color: #122014;
        font-weight: 700;
        cursor: pointer;
      }
      .meta {
        margin-top: 14px;
        font-size: 0.85rem;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>${APP_NAME}</h1>
      <p>Private access is enabled for this site.</p>
      <p class="notice">${escapeHtml(notice)}</p>
      <form method="post" action="/auth/login">
        <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
        <label for="site-password">Shared password</label>
        <input id="site-password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Enter Site</button>
      </form>
      <div class="meta">Three failed attempts will lock this IP address for one hour.</div>
    </main>
  </body>
</html>`;
}

async function handleUnauthenticatedSiteRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const nextPath = normalizeNextPath(`${url.pathname}${url.search}`);
  const lockoutState = await getSiteAuthLockoutState(env.DB, request, env);
  if (isApiLikeRequest(url)) {
    return json(
      {
        ok: false,
        error: lockoutState.active
          ? "Too many failed login attempts. Try again later."
          : "Authentication required.",
      },
      { status: lockoutState.active ? 429 : 401, headers: { "cache-control": "no-store" } }
    );
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(
      {
        ok: false,
        error: "Authentication required.",
      },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }

  return html(
    buildSitePasswordGatePage(nextPath, "", lockoutState.active ? lockoutState.lockedUntilMs : null),
    lockoutState.active ? 429 : 401
  );
}

async function handleSiteLogin(request: Request, env: Env): Promise<Response> {
  let password = "";
  let nextPath = "/";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await request.text();
    const params = new URLSearchParams(body);
    password = String(params.get("password") ?? "");
    nextPath = normalizeNextPath(String(params.get("next") ?? "/"));
  } else {
    const formData = await request.formData();
    password = String(formData.get("password") ?? "");
    nextPath = normalizeNextPath(String(formData.get("next") ?? "/"));
  }
  const lockoutState = await getSiteAuthLockoutState(env.DB, request, env);

  if (lockoutState.active) {
    await sendSiteAuthAuditEvent(
      env,
      buildSiteAuthAuditPayload(
        request,
        "login_lockout",
        nextPath,
        "Attempt blocked because this IP is currently locked out."
      )
    );
    return html(buildSitePasswordGatePage(nextPath, "", lockoutState.lockedUntilMs), 429);
  }

  const submittedHash = await sha256Hex(password);
  if (!xorEqual(submittedHash, String(env.STATS_SITE_PASSWORD_HASH ?? ""))) {
    const updatedState = await recordFailedSiteAuthAttempt(env.DB, request, env);
    await sendSiteAuthAuditEvent(
      env,
      buildSiteAuthAuditPayload(
        request,
        updatedState.active ? "login_lockout" : "login_failure",
        nextPath,
        updatedState.active
          ? "Incorrect password triggered the one-hour IP lockout."
          : `Incorrect password. ${updatedState.remainingAttempts} attempt(s) remaining before lockout.`
      )
    );
    const errorMessage = updatedState.active
      ? ""
      : `Incorrect password. ${updatedState.remainingAttempts} attempt${updatedState.remainingAttempts === 1 ? "" : "s"} remaining before a one-hour lockout.`;
    return html(buildSitePasswordGatePage(nextPath, errorMessage, updatedState.lockedUntilMs), updatedState.active ? 429 : 401);
  }

  await clearSiteAuthAttempts(env.DB, request, env);
  await sendSiteAuthAuditEvent(
    env,
    buildSiteAuthAuditPayload(request, "login_success", nextPath, "Password accepted and site session issued.")
  );
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + SITE_AUTH_SESSION_TTL_SECONDS;
  const cookieValue = await buildSiteSessionCookieValue(env, expiresAtSeconds);
  return redirect(nextPath, {
    "set-cookie": buildSiteSessionCookieHeader(cookieValue),
    "clear-site-data": "\"cache\"",
  });
}

const DERIVED_STAT_RECIPES: Record<string, Record<string, {
  components: string[];
  compute: (values: Record<string, number>) => number | null;
}>> = {
  player: {
    points: {
      components: ["tries", "goals", "field_goals_1pt", "field_goals_2pt"],
      compute: (values) =>
        (values.tries * 4) + (values.goals * 2) + values.field_goals_1pt + (values.field_goals_2pt * 2),
    },
    goal_conversion_rate: {
      components: ["conversions_with_attempts", "conversion_attempts"],
      compute: (values) => values.conversion_attempts > 0 ? (values.conversions_with_attempts * 100) / values.conversion_attempts : null,
    },
    average_play_the_ball_speed: {
      components: ["play_the_ball_total_seconds", "play_the_ball"],
      compute: (values) => values.play_the_ball > 0 ? values.play_the_ball_total_seconds / values.play_the_ball : null,
    },
    passes_to_run_ratio: {
      components: ["passes", "all_runs"],
      compute: (values) => values.all_runs > 0 ? values.passes / values.all_runs : null,
    },
    tackle_efficiency: {
      components: ["tackles_made", "tackle_attempts"],
      compute: (values) => values.tackle_attempts > 0 ? (values.tackles_made * 100) / values.tackle_attempts : null,
    },
  },
  team: {
    kick_defusal: {
      components: ["kick_defusal_weighted_numerator", "opposition_kicks"],
      compute: (values) => values.opposition_kicks > 0 ? values.kick_defusal_weighted_numerator / values.opposition_kicks : null,
    },
    average_play_the_ball_speed: {
      components: ["average_play_the_ball_speed_weighted_numerator", "opposition_tackles_made"],
      compute: (values) => values.opposition_tackles_made > 0 ? values.average_play_the_ball_speed_weighted_numerator / values.opposition_tackles_made : null,
    },
    average_set_distance: {
      components: ["all_run_metres", "sets"],
      compute: (values) => values.sets > 0 ? values.all_run_metres / values.sets : null,
    },
    completion_rate: {
      components: ["completed_sets", "sets"],
      compute: (values) => values.sets > 0 ? (values.completed_sets * 100) / values.sets : null,
    },
    effective_tackle: {
      components: ["tackles_made", "tackle_attempts"],
      compute: (values) => values.tackle_attempts > 0 ? (values.tackles_made * 100) / values.tackle_attempts : null,
    },
    goal_conversion_rate: {
      components: ["conversions_with_attempts", "conversion_attempts"],
      compute: (values) => values.conversion_attempts > 0 ? (values.conversions_with_attempts * 100) / values.conversion_attempts : null,
    },
  },
};
const PLAYER_ZERO_IF_MISSING = new Set(
  STAT_DEFINITIONS.filter((stat) => stat.scope === "player" && stat.missingValueStrategy === "zero_if_missing")
    .map((stat) => stat.statKey)
);

const TEAM_ZERO_IF_MISSING = new Set(
  STAT_DEFINITIONS.filter((stat) => stat.scope === "team" && stat.missingValueStrategy === "zero_if_missing")
    .map((stat) => stat.statKey)
);

const STARTER_QUERIES: AppBootstrap["starterQueries"] = [
  {
    id: "player-all-time-tries",
    label: "Leading try scorers",
    mode: "player",
    metric: "totals",
    statKey: "tries",
    competition: "NRL",
    format: "overall",
  },
  {
    id: "player-all-time-games",
    label: "Most games played",
    mode: "player",
    metric: "totals",
    statKey: "games_played",
    competition: "NRL",
    format: "overall",
  },
  {
    id: "player-season-run-metres",
    label: "Most run metres in a season",
    mode: "player",
    metric: "totals",
    statKey: "all_run_metres",
    competition: "NRL",
    format: "season",
  },
  {
    id: "team-consecutive-wins",
    label: "Most consecutive wins",
    mode: "team",
    metric: "streaks",
    statKey: "wins",
    competition: "NRL",
    format: "match",
  },
  {
    id: "team-winning-margin",
    label: "Greatest winning margins",
    mode: "team",
    metric: "totals",
    statKey: "margin",
    competition: "NRL",
    format: "match",
  },
];

const REGRESSION_SNAPSHOT_TAG = "Rd 7 2026";
const REGRESSION_BASE_PARAMS: Record<string, string> = {
  competition: "NRL",
  seasonFrom: "1908",
  seasonTo: "2026",
  excludeSparseHistoricalStreaks: "0",
  includeRegular: "1",
  includeFinals: "1",
  includeGrandFinal: "1",
};

const REGRESSION_EXCLUDED_CASE_IDS = new Set<string>([
  "user-tries-where-tries-eq-0-leaderboard",
  "user-tries-tries-eq-0-and-minutes-gt-0-leaderboard",
  "user-tries-where-tries-eq-0-full",
  "user-games-played-where-tries-eq-0-full",
  "user-tries-tries-eq-0-and-minutes-gt-0-full",
  "wiki-style-most-points",
  "wiki-style-most-games",
  "wiki-style-highest-team-margin",
  "wiki-style-most-goals",
  "wiki-style-most-conversions",
  "wiki-style-most-penalty-goals",
  "wiki-style-most-drop-goals",
  "wiki-style-most-team-wins",
]);

const ALL_TIME_TEAM_LADDER_TARGET: Array<{
  team: string;
  played: number;
  wins: number;
  losses: number;
  draws: number;
}> = [
  { team: "Melbourne Storm", played: 743, wins: 494, losses: 243, draws: 6 },
  { team: "Brisbane Broncos", played: 961, wins: 569, losses: 378, draws: 14 },
  { team: "St. George Dragons", played: 1545, wins: 910, losses: 579, draws: 56 },
  { team: "Manly Warringah Sea Eagles", played: 1763, wins: 993, losses: 732, draws: 38 },
  { team: "Glebe", played: 297, wins: 163, losses: 128, draws: 6 },
  { team: "Sydney Roosters", played: 2387, wins: 1278, losses: 1040, draws: 69 },
  { team: "South Sydney Rabbitohs", played: 2311, wins: 1199, losses: 1066, draws: 46 },
  { team: "Canberra Raiders", played: 1100, wins: 569, losses: 521, draws: 10 },
  { team: "Balmain Tigers", played: 1705, wins: 871, losses: 766, draws: 68 },
  { team: "Canterbury-Bankstown Bulldogs", played: 1995, wins: 1005, losses: 937, draws: 53 },
  { team: "Cronulla-Sutherland Sharks", played: 1430, wins: 707, losses: 699, draws: 24 },
  { team: "St. George Illawarra Dragons", played: 680, wins: 322, losses: 352, draws: 6 },
  { team: "Penrith Panthers", played: 1420, wins: 667, losses: 723, draws: 30 },
  { team: "Newcastle Knights", played: 931, wins: 431, losses: 482, draws: 18 },
  { team: "Parramatta Eels", played: 1815, wins: 838, losses: 937, draws: 40 },
  { team: "New Zealand Warriors", played: 762, wins: 346, losses: 407, draws: 9 },
  { team: "Newcastle", played: 20, wins: 9, losses: 11, draws: 0 },
  { team: "Newtown Jets", played: 1305, wins: 583, losses: 663, draws: 59 },
  { team: "Dolphins", played: 78, wins: 34, losses: 44, draws: 0 },
  { team: "Western Suburbs Magpies", played: 1691, wins: 734, losses: 908, draws: 49 },
  { team: "North Queensland Cowboys", played: 771, wins: 333, losses: 431, draws: 7 },
  { team: "North Sydney Bears", played: 1665, wins: 678, losses: 916, draws: 71 },
  { team: "Wests Tigers", played: 639, wins: 257, losses: 379, draws: 3 },
  { team: "Northern Eagles", played: 76, wins: 30, losses: 45, draws: 1 },
  { team: "Perth Reds", played: 61, wins: 24, losses: 36, draws: 1 },
  { team: "Hunter Mariners", played: 18, wins: 7, losses: 11, draws: 0 },
  { team: "Illawarra Steelers", played: 396, wins: 153, losses: 230, draws: 13 },
  { team: "Gold Coast Titans", played: 465, wins: 177, losses: 287, draws: 1 },
  { team: "Adelaide Rams", played: 42, wins: 13, losses: 28, draws: 1 },
  { team: "Gold Coast Chargers", played: 246, wins: 53, losses: 184, draws: 9 },
  { team: "South Queensland Crushers", played: 65, wins: 13, losses: 51, draws: 1 },
  { team: "University", played: 242, wins: 47, losses: 190, draws: 5 },
  { team: "Annandale", played: 153, wins: 25, losses: 122, draws: 6 },
  { team: "Cumberland", played: 8, wins: 1, losses: 7, draws: 0 },
];

const WIKIPEDIA_TOP_FIVE_LOSS_STREAK_TARGET: Array<{ team: string; streak: number }> = [
  { team: "University", streak: 42 },
  { team: "Eastern Suburbs", streak: 25 },
  { team: "South Sydney", streak: 22 },
  { team: "Western Suburbs Magpies", streak: 22 },
  { team: "Newtown", streak: 20 },
];

const WIKIPEDIA_TOP_FIVE_WIN_STREAK_TARGET: Array<{ team: string; streak: number }> = [
  { team: "Eastern Suburbs", streak: 19 },
  { team: "Melbourne Storm", streak: 19 },
  { team: "Bulldogs", streak: 17 },
  { team: "Penrith Panthers", streak: 17 },
  { team: "South Sydney", streak: 16 },
];

type RegressionOutputTargetRow = { entity: string; value: number };

const REGRESSION_OUTPUT_TARGETS: Record<string, RegressionOutputTargetRow[]> = {
  "user-games-played-where-tries-eq-0-leaderboard": [{ entity: "Thomas Mikaele", value: 108 }],
  "starter-leading-try-scorers": [{ entity: "Alex Johnston", value: 217 }],
  "starter-most-games-played": [{ entity: "Cameron Smith", value: 430 }],
  "starter-most-consecutive-wins": [
    { entity: "Sydney Roosters", value: 19 },
    { entity: "Melbourne Storm", value: 19 },
    { entity: "Canterbury-Bankstown Bulldogs", value: 17 },
    { entity: "Penrith Panthers", value: 17 },
    { entity: "South Sydney Rabbitohs", value: 16 },
  ],
  "wiki-style-team-loss-streak-top5": WIKIPEDIA_TOP_FIVE_LOSS_STREAK_TARGET.map((row) => ({ entity: row.team, value: row.streak })),
  "wiki-style-team-win-streak-top5": [
    { entity: "Sydney Roosters", value: 19 },
    { entity: "Melbourne Storm", value: 19 },
    { entity: "Canterbury-Bankstown Bulldogs", value: 17 },
    { entity: "Penrith Panthers", value: 17 },
    { entity: "South Sydney Rabbitohs", value: 16 },
  ],
  "wiki-style-winning-margin-top5-overall": [
    { entity: "St George Dragons", value: 85 },
    { entity: "Sydney Roosters", value: 80 },
    { entity: "North Queensland Cowboys", value: 74 },
    { entity: "Parramatta Eels", value: 70 },
    { entity: "Canberra Raiders", value: 68 },
  ],
  "wiki-style-winning-margin-top5-gf": [
    { entity: "Manly Warringah Sea Eagles", value: 40 },
    { entity: "Sydney Roosters", value: 38 },
    { entity: "North Sydney", value: 32 },
    { entity: "Balmain", value: 29 },
    { entity: "South Sydney Rabbitohs", value: 28 },
  ],
  "wiki-style-total-points-overall": [
    { entity: "*", value: 102 },
    { entity: "*", value: 102 },
    { entity: "*", value: 97 },
    { entity: "*", value: 97 },
    { entity: "*", value: 96 },
    { entity: "*", value: 96 },
    { entity: "*", value: 94 },
    { entity: "*", value: 94 },
    { entity: "*", value: 94 },
    { entity: "*", value: 94 },
  ],
  "wiki-style-total-points-gf": [
    { entity: "*", value: 56 },
    { entity: "*", value: 56 },
    { entity: "*", value: 54 },
    { entity: "*", value: 54 },
    { entity: "*", value: 50 },
    { entity: "*", value: 50 },
    { entity: "*", value: 50 },
    { entity: "*", value: 50 },
    { entity: "*", value: 48 },
    { entity: "*", value: 48 },
  ],
  "wiki-style-points-for-overall": [
    { entity: "St George Dragons", value: 91 },
    { entity: "Sydney Roosters", value: 87 },
    { entity: "Parramatta Eels", value: 74 },
    { entity: "Canberra Raiders", value: 74 },
    { entity: "North Queensland Cowboys", value: 74 },
  ],
  "wiki-style-points-for-gf": [
    { entity: "South Sydney Rabbitohs", value: 42 },
    { entity: "Manly Warringah Sea Eagles", value: 40 },
    { entity: "Sydney Roosters", value: 38 },
    { entity: "Brisbane Broncos", value: 38 },
    { entity: "Canberra Raiders", value: 36 },
  ],
  "wiki-style-highest-losing-score-overall": [
    { entity: "Parramatta Eels", value: 40 },
    { entity: "Canterbury-Bankstown Bulldogs", value: 36 },
    { entity: "Wests Tigers", value: 36 },
    { entity: "Gold Coast Titans", value: 36 },
    { entity: "Melbourne Storm", value: 36 },
  ],
  "wiki-style-highest-losing-score-gf": [
    { entity: "Parramatta Eels", value: 24 },
    { entity: "Brisbane Broncos", value: 24 },
    { entity: "Melbourne Storm", value: 22 },
    { entity: "Penrith Panthers", value: 20 },
    { entity: "St. George Illawarra Dragons", value: 18 },
  ],
  "wiki-style-highest-drawn-score": [
    { entity: "*", value: 34 },
    { entity: "*", value: 34 },
    { entity: "*", value: 34 },
    { entity: "*", value: 34 },
    { entity: "*", value: 34 },
    { entity: "*", value: 34 },
    { entity: "*", value: 32 },
    { entity: "*", value: 32 },
    { entity: "*", value: 32 },
    { entity: "*", value: 32 },
  ],
  "wiki-style-player-most-games-top10": [
    { entity: "Cameron Smith", value: 430 },
    { entity: "Cooper Cronk", value: 372 },
    { entity: "Ben Hunt", value: 360 },
    { entity: "Daly Cherry-Evans", value: 358 },
    { entity: "Darren Lockyer", value: 355 },
    { entity: "Terry Lamb", value: 350 },
    { entity: "Steve Menzies", value: 349 },
    { entity: "Paul Gallen", value: 348 },
    { entity: "Corey Parker", value: 347 },
    { entity: "Benji Marshall", value: 346 },
  ],
  "wiki-style-player-most-games-by-club": [
    { entity: "Darren Lockyer", value: 355 },
    { entity: "Josh Papalii", value: 334 },
    { entity: "Hazem El Masri", value: 317 },
    { entity: "Paul Gallen", value: 348 },
    { entity: "Jamayne Isaako", value: 78 },
    { entity: "Mark Minichiello", value: 173 },
    { entity: "Daly Cherry-Evans", value: 352 },
    { entity: "Cameron Smith", value: 430 },
    { entity: "Danny Buderus", value: 257 },
    { entity: "Simon Mannering", value: 301 },
    { entity: "Johnathan Thurston", value: 294 },
    { entity: "Nathan Hindmarsh", value: 330 },
    { entity: "Isaah Yeo", value: 273 },
    { entity: "John Sutton", value: 336 },
    { entity: "Ben Hornby", value: 273 },
    { entity: "Jared Waerea-Hargreaves", value: 310 },
    { entity: "Robbie Farah", value: 277 },
  ],
  "wiki-style-player-most-tries-top10": [
    { entity: "Alex Johnston", value: 217 },
    { entity: "Ken Irvine", value: 212 },
    { entity: "Billy Slater", value: 190 },
    { entity: "Daniel Tupou", value: 187 },
    { entity: "Steve Menzies", value: 180 },
    { entity: "Brett Morris", value: 176 },
    { entity: "Andrew Ettingshausen", value: 166 },
    { entity: "Terry Lamb", value: 164 },
    { entity: "Brett Stewart", value: 163 },
    { entity: "Josh Addo-Carr", value: 163 },
  ],
  "wiki-style-player-most-tries-by-club": [
    { entity: "Steve Renouf", value: 142 },
    { entity: "Jarrod Croker", value: 136 },
    { entity: "Hazem El Masri", value: 159 },
    { entity: "Andrew Ettingshausen", value: 166 },
    { entity: "Hamiso Tabuai-Fidow", value: 58 },
    { entity: "Anthony Don", value: 85 },
    { entity: "Brett Stewart", value: 163 },
    { entity: "Billy Slater", value: 190 },
    { entity: "Akuila Uate", value: 110 },
    { entity: "Manu Vatuvei", value: 152 },
    { entity: "Kyle Feldt", value: 151 },
    { entity: "Luke Burt", value: 124 },
    { entity: "Rhys Wesser", value: 113 },
    { entity: "Alex Johnston", value: 217 },
    { entity: "Matt Cooper", value: 124 },
    { entity: "Daniel Tupou", value: 187 },
    { entity: "David Nofoaluma", value: 100 },
  ],
  "wiki-style-player-tries-season-top5": [
    { entity: "Dave Brown", value: 38 },
    { entity: "Ray Preston", value: 34 },
    { entity: "Alex Johnston", value: 30 },
    { entity: "Alex Johnston", value: 30 },
    { entity: "Les Brennan", value: 29 },
  ],
  "wiki-style-player-tries-game-record": [{ entity: "Frank Burge", value: 8 }],
  "wiki-style-player-points-top10": [
    { entity: "Cameron Smith", value: 2786 },
    { entity: "Adam Reynolds", value: 2557 },
    { entity: "Hazem El Masri", value: 2418 },
    { entity: "Jarrod Croker", value: 2374 },
    { entity: "Johnathan Thurston", value: 2222 },
    { entity: "Andrew Johns", value: 2176 },
    { entity: "Jason Taylor", value: 2107 },
    { entity: "Daryl Halligan", value: 2034 },
    { entity: "Mick Cronin", value: 1971 },
    { entity: "Graham Eadie", value: 1917 },
  ],
  "wiki-style-player-points-by-club": [
    { entity: "Corey Parker", value: 1328 },
    { entity: "Jarrod Croker", value: 2374 },
    { entity: "Hazem El Masri", value: 2418 },
    { entity: "Steve Rogers", value: 1255 },
    { entity: "Jamayne Isaako", value: 795 },
    { entity: "Scott Prince", value: 719 },
    { entity: "Graham Eadie", value: 1917 },
    { entity: "Cameron Smith", value: 2786 },
    { entity: "Andrew Johns", value: 2176 },
    { entity: "Shaun Johnson", value: 1476 },
    { entity: "Johnathan Thurston", value: 2182 },
    { entity: "Mick Cronin", value: 1971 },
    { entity: "Nathan Cleary", value: 1802 },
    { entity: "Adam Reynolds", value: 1896 },
    { entity: "Jamie Soward", value: 977 },
    { entity: "Craig Fitzgibbon", value: 1469 },
    { entity: "Benji Marshall", value: 1181 },
  ],
  "wiki-style-player-points-season-record": [
    { entity: "Hazem El Masri", value: 342 },
    { entity: "Reuben Garrick", value: 334 },
    { entity: "Brett Hodgson", value: 308 },
    { entity: "Hazem El Masri", value: 296 },
    { entity: "Jarrod Croker", value: 296 },
  ],
  "wiki-style-player-points-game-record": [
    { entity: "Dave Brown", value: 45 },
    { entity: "Dave Brown", value: 38 },
    { entity: "Mal Meninga", value: 38 },
    { entity: "Les Griffin", value: 36 },
    { entity: "Jack Lindwall", value: 36 },
  ],
  "wiki-style-player-goals-most": [
    { entity: "Cameron Smith", value: 1295 },
    { entity: "Adam Reynolds", value: 1153 },
    { entity: "Jason Taylor", value: 942 },
    { entity: "Johnathan Thurston", value: 923 },
    { entity: "Andrew Johns", value: 917 },
    { entity: "Jarrod Croker", value: 915 },
    { entity: "Hazem El Masri", value: 891 },
    { entity: "Mick Cronin", value: 865 },
    { entity: "Daryl Halligan", value: 855 },
    { entity: "Graham Eadie", value: 847 },
  ],
  "wiki-style-player-100-tries-500-goals": [
    { entity: "Ryan Girdler", value: 624 },
    { entity: "Hazem El Masri", value: 891 },
    { entity: "Luke Burt", value: 646 },
    { entity: "Jamie Lyon", value: 533 },
    { entity: "Jarrod Croker", value: 915 },
  ],
  "wiki-style-player-longest-no-try-streak": [{ entity: "Alex Twal", value: 115 }],
};

function withRegressionBaseline(params: Record<string, string>): Record<string, string> {
  return {
    ...REGRESSION_BASE_PARAMS,
    ...params,
  };
}

const REGRESSION_QUERY_SUITE: Array<{
  id: string;
  label: string;
  category: "user_reported" | "starter" | "wikipedia_style";
  endpoint: "leaderboard" | "full";
  params: Record<string, string>;
  expected: {
    minRows?: number;
    topEntityField?: "player" | "team" | "winner";
    topEntityEquals?: string;
    topValueField?: string;
    topValueEquals?: number;
  };
  checks?: Array<{
    label: string;
    params?: Record<string, string>;
    entityField?: "player" | "team" | "winner";
    valueField?: string;
    expectedEntity?: string;
    expectedValue?: number;
  }>;
  tableTarget?: Array<{
    team: string;
    played: number;
    wins: number;
    losses: number;
    draws: number;
  }>;
  rankTarget?: Array<{
    team: string;
    streak: number;
  }>;
  outputTarget?: RegressionOutputTargetRow[];
  snapshotTag: string;
}> = [
  {
    id: "user-tries-where-tries-eq-0-leaderboard",
    label: "Tries where tries = 0 (leaderboard)",
    category: "user_reported",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "overall",
      conditions: JSON.stringify([{ statKey: "tries", operator: "eq", value: "0", joiner: "AND" }]),
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Adam Christensen",
      topValueField: "stat_total",
      topValueEquals: 0,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "user-games-played-where-tries-eq-0-leaderboard",
    label: "Games played where tries = 0 (leaderboard)",
    category: "user_reported",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "games_played",
      mode: "totals",
      format: "overall",
      conditions: JSON.stringify([{ statKey: "tries", operator: "eq", value: "0", joiner: "AND" }]),
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Thomas Mikaele",
      topValueField: "stat_total",
      topValueEquals: 108,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "user-tries-tries-eq-0-and-minutes-gt-0-leaderboard",
    label: "Tries where tries = 0 AND minutes_played > 0 (leaderboard)",
    category: "user_reported",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "overall",
      conditions: JSON.stringify([
        { statKey: "tries", operator: "eq", value: "0", joiner: "AND" },
        { statKey: "minutes_played", operator: "gt", value: "0", joiner: "AND" },
      ]),
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Adam Christensen",
      topValueField: "stat_total",
      topValueEquals: 0,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "user-tries-where-tries-eq-0-full",
    label: "Tries where tries = 0 (full results)",
    category: "user_reported",
    endpoint: "full",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "overall",
      conditions: JSON.stringify([{ statKey: "tries", operator: "eq", value: "0", joiner: "AND" }]),
      page: "1",
      pageSize: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Adam Christensen",
      topValueField: "stat_total",
      topValueEquals: 0,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "user-games-played-where-tries-eq-0-full",
    label: "Games played where tries = 0 (full results)",
    category: "user_reported",
    endpoint: "full",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "games_played",
      mode: "totals",
      format: "overall",
      conditions: JSON.stringify([{ statKey: "tries", operator: "eq", value: "0", joiner: "AND" }]),
      page: "1",
      pageSize: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Thomas Mikaele",
      topValueField: "stat_total",
      topValueEquals: 108,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "user-tries-tries-eq-0-and-minutes-gt-0-full",
    label: "Tries where tries = 0 AND minutes_played > 0 (full results)",
    category: "user_reported",
    endpoint: "full",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "overall",
      conditions: JSON.stringify([
        { statKey: "tries", operator: "eq", value: "0", joiner: "AND" },
        { statKey: "minutes_played", operator: "gt", value: "0", joiner: "AND" },
      ]),
      page: "1",
      pageSize: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Adam Christensen",
      topValueField: "stat_total",
      topValueEquals: 0,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "starter-leading-try-scorers",
    label: "Leading try scorers",
    category: "starter",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Alex Johnston",
      topValueField: "stat_total",
      topValueEquals: 217,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "starter-most-games-played",
    label: "Most games played",
    category: "starter",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "games_played",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Cameron Smith",
      topValueField: "stat_total",
      topValueEquals: 430,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "starter-most-consecutive-wins",
    label: "Most consecutive wins",
    category: "starter",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "wins",
      mode: "streaks",
      format: "match",
      excludeSparseHistoricalStreaks: "0",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "streak",
      topValueEquals: 19,
    },
    rankTarget: WIKIPEDIA_TOP_FIVE_WIN_STREAK_TARGET,
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-most-points",
    label: "Most points scored (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "points",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Nathan Cleary",
      topValueField: "stat_total",
      topValueEquals: 72,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-most-games",
    label: "Most appearances (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "games_played",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "AJ Brimson",
      topValueField: "stat_total",
      topValueEquals: 6,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-highest-team-margin",
    label: "Greatest winning margins (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "margin",
      mode: "totals",
      format: "match",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "winner",
      topEntityEquals: "Melbourne Storm",
      topValueField: "margin",
      topValueEquals: 48,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-most-goals",
    label: "Most goals kicked (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "goals",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "AJ Brimson",
      topValueField: "stat_total",
      topValueEquals: 0,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-most-conversions",
    label: "Most conversions kicked (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "conversions",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Nathan Cleary",
      topValueField: "stat_total",
      topValueEquals: 28,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-most-penalty-goals",
    label: "Most penalty goals kicked (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "penalty_goals",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Tanah Boyd",
      topValueField: "stat_total",
      topValueEquals: 6,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-most-drop-goals",
    label: "Most field goals (1pt) kicked (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "field_goals_1pt",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Ethan Sanders",
      topValueField: "stat_total",
      topValueEquals: 1,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-most-team-wins",
    label: "Most team wins (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "wins",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 1,
      topEntityField: "team",
      topEntityEquals: "Penrith Panthers",
      topValueField: "stat_total",
      topValueEquals: 5,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-team-games-played-all-time",
    label: "All-time team played/wins/losses/draws",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "games",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "400",
    }),
    expected: {
      minRows: 34,
    },
    tableTarget: ALL_TIME_TEAM_LADDER_TARGET,
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-team-loss-streak-top5",
    label: "Top 5 consecutive losses (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "losses",
      mode: "streaks",
      format: "match",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "streak",
      topValueEquals: 42,
    },
    rankTarget: WIKIPEDIA_TOP_FIVE_LOSS_STREAK_TARGET,
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-team-win-streak-top5",
    label: "Top 5 consecutive wins (Wikipedia-style)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "wins",
      mode: "streaks",
      format: "match",
      excludeSparseHistoricalStreaks: "0",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "streak",
      topValueEquals: 19,
    },
    rankTarget: WIKIPEDIA_TOP_FIVE_WIN_STREAK_TARGET,
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-winning-margin-top5-overall",
    label: "Top 5 winning margins overall",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "margin",
      mode: "totals",
      format: "match",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "margin",
      topValueEquals: 85,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-winning-margin-top5-gf",
    label: "Top 5 winning margins grand final",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "margin",
      mode: "totals",
      format: "match",
      includeRegular: "0",
      includeFinals: "0",
      includeGrandFinal: "1",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "margin",
      topValueEquals: 40,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-total-points-overall",
    label: "Top 5 total points in match overall",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "total_points",
      mode: "totals",
      format: "match",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 102,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-total-points-gf",
    label: "Top 5 total points in grand final",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "total_points",
      mode: "totals",
      format: "match",
      includeRegular: "0",
      includeFinals: "0",
      includeGrandFinal: "1",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 56,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-points-for-overall",
    label: "Top 5 points for in match overall",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "points_for",
      mode: "totals",
      format: "match",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "stat_total",
      topValueEquals: 91,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-points-for-gf",
    label: "Top 5 points for in grand final",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "points_for",
      mode: "totals",
      format: "match",
      includeRegular: "0",
      includeFinals: "0",
      includeGrandFinal: "1",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "stat_total",
      topValueEquals: 42,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-highest-losing-score-overall",
    label: "Top 5 highest losing scores overall",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "points_for",
      mode: "totals",
      format: "match",
      result: "loss",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "stat_total",
      topValueEquals: 40,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-highest-losing-score-gf",
    label: "Top 5 highest losing scores in grand finals",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "points_for",
      mode: "totals",
      format: "match",
      result: "loss",
      includeRegular: "0",
      includeFinals: "0",
      includeGrandFinal: "1",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "stat_total",
      topValueEquals: 24,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-highest-drawn-score",
    label: "Top drawn scores (34-34 check)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "team",
      statKey: "points_for",
      mode: "totals",
      format: "match",
      result: "tie",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 34,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-most-games-top10",
    label: "Top 10 player games played (Smith 430)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "games_played",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 430,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-most-games-by-club",
    label: "Most games at each club",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "games_played",
      mode: "totals",
      format: "club",
      singleEntityResults: "1",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 16,
      topValueField: "stat_total",
      topValueEquals: 430,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-most-tries-top10",
    label: "Top 10 player tries (Johnston 217)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 217,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-most-tries-by-club",
    label: "Most tries at each club",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "club",
      singleEntityResults: "1",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 16,
      topValueField: "stat_total",
      topValueEquals: 217,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-tries-season-top5",
    label: "Top 5 tries in a season (Brown 38)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "season",
      conditions: "[]",
      limit: "5",
    }),
    expected: {
      minRows: 5,
      topValueField: "stat_total",
      topValueEquals: 38,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-tries-game-record",
    label: "Most tries in a game (Burge 8)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "totals",
      format: "match",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 8,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-points-top10",
    label: "Top 10 player points (Smith 2786)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "points",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 2786,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-points-by-club",
    label: "Most points at each club",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "points",
      mode: "totals",
      format: "club",
      singleEntityResults: "1",
      conditions: "[]",
      limit: "200",
    }),
    expected: {
      minRows: 16,
      topValueField: "stat_total",
      topValueEquals: 2786,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-points-season-record",
    label: "Most points in a season (342)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "points",
      mode: "totals",
      format: "season",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 342,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-points-game-record",
    label: "Most points in a game (45)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "points",
      mode: "totals",
      format: "match",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 45,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-goals-most",
    label: "Most goals (Smith 1295)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "goals",
      mode: "totals",
      format: "overall",
      conditions: "[]",
      limit: "10",
    }),
    expected: {
      minRows: 10,
      topValueField: "stat_total",
      topValueEquals: 1295,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-100-tries-500-goals",
    label: "Players with >100 tries and >500 goals",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "goals",
      mode: "totals",
      format: "overall",
      conditions: JSON.stringify([
        { statKey: "tries", operator: "gt", value: "100", joiner: "AND" },
        { statKey: "goals", operator: "gt", value: "500", joiner: "AND" },
      ]),
      limit: "20",
    }),
    expected: {
      minRows: 5,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
  {
    id: "wiki-style-player-longest-no-try-streak",
    label: "Longest streak without a try (Twal approx 115)",
    category: "wikipedia_style",
    endpoint: "leaderboard",
    params: withRegressionBaseline({
      scope: "player",
      statKey: "tries",
      mode: "streaks",
      format: "match",
      conditions: JSON.stringify([{ statKey: "tries", operator: "eq", value: "0", joiner: "AND" }]),
      limit: "10",
    }),
    expected: {
      minRows: 1,
      topEntityField: "player",
      topEntityEquals: "Alex Twal",
      topValueField: "streak",
      topValueEquals: 115,
    },
    snapshotTag: REGRESSION_SNAPSHOT_TAG,
  },
];

function buildBootstrap(): AppBootstrap {
  const statsWithIncluded = [
    {
      scope: "player",
      statKey: "games_included",
      displayName: "Games Included",
      groupCode: "availability",
      firstConsistentSeason: null,
      supportsTotals: true,
      supportsAverages: false,
      supportsStreaks: false,
      isDerived: true,
      availabilityNotes: "Derived helper for qualifying filters.",
    },
    {
      scope: "team",
      statKey: "games_included",
      displayName: "Games Included",
      groupCode: "availability",
      firstConsistentSeason: null,
      supportsTotals: true,
      supportsAverages: false,
      supportsStreaks: false,
      isDerived: true,
      availabilityNotes: "Derived helper for qualifying filters.",
    },
    {
      scope: "team",
      statKey: "points_for_first_half",
      displayName: "Points For - 1st Half",
      groupCode: "results",
      firstConsistentSeason: 1998,
      supportsTotals: true,
      supportsAverages: true,
      supportsStreaks: true,
      isDerived: true,
      availabilityNotes: "Derived from stored half-time scores.",
    },
    {
      scope: "team",
      statKey: "points_against_first_half",
      displayName: "Points Against - 1st Half",
      groupCode: "results",
      firstConsistentSeason: 1998,
      supportsTotals: true,
      supportsAverages: true,
      supportsStreaks: true,
      isDerived: true,
      availabilityNotes: "Derived from stored opponent half-time scores.",
    },
    {
      scope: "team",
      statKey: "margin_first_half",
      displayName: "Margin - 1st Half",
      groupCode: "results",
      firstConsistentSeason: 1998,
      supportsTotals: true,
      supportsAverages: true,
      supportsStreaks: true,
      isDerived: true,
      availabilityNotes: "Derived from stored half-time scores.",
    },
    {
      scope: "team",
      statKey: "points_for_second_half",
      displayName: "Points For - 2nd Half",
      groupCode: "results",
      firstConsistentSeason: 1998,
      supportsTotals: true,
      supportsAverages: true,
      supportsStreaks: true,
      isDerived: true,
      availabilityNotes: "Derived from full-time less half-time scores.",
    },
    {
      scope: "team",
      statKey: "points_against_second_half",
      displayName: "Points Against - 2nd Half",
      groupCode: "results",
      firstConsistentSeason: 1998,
      supportsTotals: true,
      supportsAverages: true,
      supportsStreaks: true,
      isDerived: true,
      availabilityNotes: "Derived from full-time less opponent half-time scores.",
    },
    {
      scope: "team",
      statKey: "margin_second_half",
      displayName: "Margin - 2nd Half",
      groupCode: "results",
      firstConsistentSeason: 1998,
      supportsTotals: true,
      supportsAverages: true,
      supportsStreaks: true,
      isDerived: true,
      availabilityNotes: "Derived from full-time less half-time scores.",
    },
    ...STAT_DEFINITIONS,
  ];
  return {
    app: {
      name: APP_NAME,
      version: "0.2.0",
      status: "scaffolded",
      dataFreshness: [],
    },
    filterOptions: {
      competitions: ["Any", "NRL", "SOO", "NRL_PLUS_SOO", "NRLW", "WSOO", "NRLW_PLUS_WSOO"],
      teams: ["Any"],
      players: ["Any"],
      venues: ["Any"],
      referees: ["Any"],
      positions: POSITION_OPTIONS,
      groundConditions: GROUND_CONDITION_OPTIONS,
      weatherConditions: WEATHER_CONDITION_OPTIONS,
    },
    statGroups: STAT_GROUPS.map((group) => ({
      code: group.code,
      label: group.label,
      sortOrder: group.sortOrder,
    })),
    statDefinitions: statsWithIncluded.map((stat) => ({
      scope: stat.scope,
      statKey: stat.statKey,
      displayName: stat.displayName,
      groupCode: stat.groupCode,
      missingValueStrategy: stat.missingValueStrategy,
      firstConsistentSeason: stat.firstConsistentSeason,
      supportsTotals: stat.supportsTotals,
      supportsAverages: stat.supportsAverages,
      supportsStreaks: stat.supportsStreaks,
      isDerived: stat.isDerived,
      availabilityNotes: stat.availabilityNotes,
    })),
    starterQueries: STARTER_QUERIES,
  };
}

function cloneBootstrap(bootstrap: AppBootstrap): AppBootstrap {
  return JSON.parse(JSON.stringify(bootstrap)) as AppBootstrap;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function csvResponse(filename: string, columns: string[], rows: QueryRow[], cacheControl: string): Response {
  const csv = [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n");

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": cacheControl,
    },
  });
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeLimit(value: number): number {
  return clampNumber(value, 1, API_MAX_LIMIT, API_DEFAULT_LIMIT);
}

function normalizeSeason(value: number, fallback: number): number {
  return clampNumber(value, MIN_SEASON, MAX_SEASON, fallback);
}

function normalizeOptionalBound(value: string | null, fallback: number | null): number | null {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRoundBounds(
  roundFrom: number | null,
  roundTo: number | null
): { roundFrom: number | null; roundTo: number | null } {
  const normalizedFrom = roundFrom !== null && roundFrom <= 1 ? null : roundFrom;
  const normalizedTo = roundTo !== null && roundTo >= 33 ? null : roundTo;
  if (normalizedFrom !== null && normalizedTo !== null && normalizedFrom > normalizedTo) {
    return { roundFrom: normalizedFrom, roundTo: null };
  }
  return {
    roundFrom: normalizedFrom,
    roundTo: normalizedTo,
  };
}

function normalizeConditions(raw: unknown): QueryCondition[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .slice(0, API_MAX_CONDITIONS)
    .map((condition) => {
      const candidate = condition as Partial<QueryCondition>;
      return {
        statKey: String(candidate.statKey ?? ""),
        operator: String(candidate.operator ?? ""),
        value: String(candidate.value ?? ""),
        joiner: candidate.joiner === "OR" || candidate.joiner === "AND NOT" ? candidate.joiner : "AND",
      };
    })
    .filter((condition) => condition.statKey && condition.operator && condition.value !== "");
}

function normalizeCompetition(value: string | null): string {
  return value && value !== "" ? value : "Any";
}

async function getDatabaseStatus(
  env: Env,
  timeoutMs = DB_HEALTHCHECK_TIMEOUT_MS
): Promise<{ configured: boolean; reachable: boolean; error?: string }> {
  if (!env.DB) {
    return { configured: false, reachable: false, error: "D1 binding not configured." };
  }

  try {
    const healthCheck = env.DB.prepare("SELECT 1 AS ok").first();
    if (timeoutMs > 0) {
      await Promise.race([
        healthCheck,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`D1 health check timed out after ${timeoutMs}ms.`)), timeoutMs);
        }),
      ]);
    } else {
      await healthCheck;
    }
    return { configured: true, reachable: true };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getTableCount(db: D1Database, tableName: string): Promise<number | null> {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first<{ count: number }>();
    return row?.count ?? 0;
  } catch {
    return null;
  }
}

async function getBootstrapFromDatabase(db: D1Database): Promise<AppBootstrap | null> {
  const statsAvailable = await getTableCount(db, "stat_definitions");
  if (statsAvailable === null) {
    return null;
  }

  const statGroupsPromise = db
    .prepare("SELECT code, label, sort_order AS sortOrder FROM stat_groups ORDER BY sort_order, label")
    .all<{ code: string; label: string; sortOrder: number }>();
  const teamRowsPromise = db
    .prepare("SELECT canonical_name AS name FROM teams ORDER BY canonical_name")
    .all<{ name: string }>();
  const venueRowsPromise = db
    .prepare("SELECT canonical_name AS name FROM venues ORDER BY canonical_name")
    .all<{ name: string }>();
  const refereeRowsPromise = db
    .prepare("SELECT DISTINCT stat_value_text AS name FROM team_match_stat_values WHERE stat_key = 'referee' AND stat_value_text IS NOT NULL AND stat_value_text <> '' ORDER BY stat_value_text")
    .all<{ name: string }>();
  const groundRowsPromise = db
    .prepare("SELECT DISTINCT stat_value_text AS name FROM team_match_stat_values WHERE stat_key = 'ground_condition' AND stat_value_text IS NOT NULL AND stat_value_text <> '' ORDER BY stat_value_text")
    .all<{ name: string }>();
  const weatherRowsPromise = db
    .prepare("SELECT DISTINCT stat_value_text AS name FROM team_match_stat_values WHERE stat_key = 'weather_condition' AND stat_value_text IS NOT NULL AND stat_value_text <> '' ORDER BY stat_value_text")
    .all<{ name: string }>();
  const fallbackBootstrap = buildBootstrap();
  const freshnessRowsPromise = db.prepare(`
    WITH latest AS (
      SELECT
        c.name AS competition_name,
        m.season,
        m.round_label AS roundLabel,
        m.round_index AS roundIndex,
        m.match_date_utc AS matchDateUtc,
        ROW_NUMBER() OVER (
          PARTITION BY c.name
          ORDER BY m.season DESC, m.round_index DESC, COALESCE(m.match_date_utc, '') DESC, m.match_id DESC
        ) AS row_num
      FROM matches m
      JOIN competitions c ON c.competition_id = m.competition_id
      WHERE ${completedMatchPredicate("m")}
    )
    SELECT competition_name, season, roundLabel, roundIndex, matchDateUtc
    FROM latest
    WHERE row_num = 1
    ORDER BY competition_name
  `).all<{ competition_name: string; season: number | null; roundLabel: string | null; roundIndex: number | null; matchDateUtc: string | null }>();

  const [
    statGroups,
    teamRows,
    venueRows,
    refereeRows,
    groundRows,
    weatherRows,
    freshnessRows,
  ] = await Promise.all([
    statGroupsPromise,
    teamRowsPromise,
    venueRowsPromise,
    refereeRowsPromise,
    groundRowsPromise,
    weatherRowsPromise,
    freshnessRowsPromise,
  ]);

  const dataFreshness = (freshnessRows.results ?? []).map((row) => ({
    competition:
      row.competition_name === "National Rugby League"
        ? "NRL"
        : row.competition_name === "State of Origin"
          ? "SOO"
        : row.competition_name === "National Rugby League Women"
          ? "NRLW"
          : row.competition_name === "Women's State of Origin"
            ? "WSOO"
          : row.competition_name,
    season: row.season ?? null,
    roundLabel: row.roundLabel ?? null,
    roundIndex: row.roundIndex ?? null,
    matchDateUtc: row.matchDateUtc ?? null,
  }));

  return {
    app: {
      name: APP_NAME,
      version: "0.2.0",
      status: "seeded-local-db",
      dataFreshness,
    },
    filterOptions: {
      competitions: ["Any", "NRL", "SOO", "NRL_PLUS_SOO", "NRLW", "WSOO", "NRLW_PLUS_WSOO"],
      teams: ["Any", ...(teamRows.results ?? []).map((row) => row.name)],
      players: playerOptionsCache?.values?.length ? playerOptionsCache.values : ["Any"],
      venues: ["Any", ...(venueRows.results ?? []).map((row) => row.name)],
      referees: ["Any", ...(refereeRows.results ?? []).map((row) => row.name)],
      positions: POSITION_OPTIONS,
      groundConditions: ["Any", ...(groundRows.results ?? []).map((row) => row.name)],
      weatherConditions: ["Any", ...(weatherRows.results ?? []).map((row) => row.name)],
    },
    statGroups: statGroups.results ?? [],
    statDefinitions: fallbackBootstrap.statDefinitions,
    starterQueries: STARTER_QUERIES,
  };
}

async function getPlayerOptionsFromDatabase(db: D1Database): Promise<string[]> {
  const nowMs = Date.now();
  if (playerOptionsCache && nowMs - playerOptionsCache.cachedAtMs < PLAYER_OPTIONS_CACHE_TTL_MS) {
    return playerOptionsCache.values;
  }

  const playerRows = await db
    .prepare("SELECT display_name AS name FROM players WHERE display_name IS NOT NULL AND display_name <> '' ORDER BY display_name")
    .all<{ name: string }>();
  const values = ["Any", ...(playerRows.results ?? []).map((row) => row.name)];
  playerOptionsCache = { values, cachedAtMs: nowMs };
  return values;
}

function statJsonPath(statKey: string): string {
  return `$."${String(statKey).replace(/"/g, '\\"')}"`;
}

function playerStatNumericExpr(summaryAlias: string, statKeySql: string): string {
  return `(SELECT psv.stat_value_num
    FROM player_match_stat_values psv
    WHERE psv.player_match_summary_id = ${summaryAlias}.player_match_summary_id
      AND psv.stat_key = ${statKeySql}
    LIMIT 1)`;
}

function playerStatTextExpr(summaryAlias: string, statKeySql: string): string {
  return `(SELECT psv.stat_value_text
    FROM player_match_stat_values psv
    WHERE psv.player_match_summary_id = ${summaryAlias}.player_match_summary_id
      AND psv.stat_key = ${statKeySql}
    LIMIT 1)`;
}

function playerStatPresentExpr(summaryAlias: string, statKeySql: string): string {
  return `EXISTS(
    SELECT 1
    FROM player_match_stat_values psv
    WHERE psv.player_match_summary_id = ${summaryAlias}.player_match_summary_id
      AND psv.stat_key = ${statKeySql}
  )`;
}

function teamStatNumericExpr(summaryAlias: string, statKeySql: string): string {
  return `(SELECT tsv.stat_value_num
    FROM team_match_stat_values tsv
    WHERE tsv.team_match_summary_id = ${summaryAlias}.team_match_summary_id
      AND tsv.stat_key = ${statKeySql}
    LIMIT 1)`;
}

function teamStatTextExpr(summaryAlias: string, statKeySql: string): string {
  return `(SELECT tsv.stat_value_text
    FROM team_match_stat_values tsv
    WHERE tsv.team_match_summary_id = ${summaryAlias}.team_match_summary_id
      AND tsv.stat_key = ${statKeySql}
    LIMIT 1)`;
}

function teamStatPresentExpr(summaryAlias: string, statKeySql: string): string {
  return `EXISTS(
    SELECT 1
    FROM team_match_stat_values tsv
    WHERE tsv.team_match_summary_id = ${summaryAlias}.team_match_summary_id
      AND tsv.stat_key = ${statKeySql}
  )`;
}

function getStatDefinition(scope: string, statKey: string) {
  return STAT_DEFINITION_BY_KEY.get(`${scope}:${statKey}`) ?? null;
}

function getDerivedRecipe(scope: string, statKey: string) {
  return DERIVED_STAT_RECIPES[scope]?.[statKey] ?? null;
}

function computeDerivedStat(scope: string, statKey: string, values: Record<string, number>): number | null {
  const recipe = getDerivedRecipe(scope, statKey);
  return recipe ? recipe.compute(values) : null;
}

function streakRows(
  rows: Array<{ entity: string; season: number; round_index: number | null; match_date_utc: string | null; stat_value: number | null; group_label?: string | null }>,
  entityLabel: "player" | "team",
  limit: number,
  allowMultiple = false,
  groupLabelName: string | null = null,
  partitionByGroup = false
): QueryRow[] {
  const summaries = new Map<string, {
    entity: string;
    groupLabel: string | null;
    streak: number;
    current: number;
    start: number | null;
    startRound: number | null;
    end: number | null;
    endRound: number | null;
    bestStart: number | null;
    bestStartRound: number | null;
    bestEnd: number | null;
    bestEndRound: number | null;
  }>();
  const segments: Array<{
    entity: string;
    groupLabel: string | null;
    streak: number;
    bestStart: number | null;
    bestStartRound: number | null;
    bestEnd: number | null;
    bestEndRound: number | null;
  }> = [];

  const pushSegment = (entry: {
    entity: string;
    groupLabel: string | null;
    current: number;
    start: number | null;
    startRound: number | null;
    end: number | null;
    endRound: number | null;
  }) => {
    if (entry.current <= 0) return;
    segments.push({
      entity: entry.entity,
      groupLabel: entry.groupLabel,
      streak: entry.current,
      bestStart: entry.start,
      bestStartRound: entry.startRound,
      bestEnd: entry.end,
      bestEndRound: entry.endRound,
    });
  };

  for (const row of rows) {
    const key = partitionByGroup ? `${row.entity}||${row.group_label ?? ""}` : row.entity;
    const entry = summaries.get(key) ?? {
      entity: row.entity,
      groupLabel: row.group_label ?? null,
      streak: 0,
      current: 0,
      start: null,
      startRound: null,
      end: null,
      endRound: null,
      bestStart: null,
      bestStartRound: null,
      bestEnd: null,
      bestEndRound: null,
    };

    if (Number(row.stat_value ?? 0) > 0) {
      entry.current += 1;
      if (entry.current === 1) {
        entry.start = row.season;
        entry.startRound = row.round_index;
      }
      entry.end = row.season;
      entry.endRound = row.round_index;
      if (entry.current > entry.streak) {
        entry.streak = entry.current;
        entry.bestStart = entry.start;
        entry.bestStartRound = entry.startRound;
        entry.bestEnd = entry.end;
        entry.bestEndRound = entry.endRound;
      }
    } else {
      if (allowMultiple) {
        pushSegment(entry);
      }
      entry.current = 0;
      entry.start = null;
      entry.startRound = null;
      entry.end = null;
      entry.endRound = null;
    }

    summaries.set(key, entry);
  }

  if (allowMultiple) {
    for (const entry of summaries.values()) {
      pushSegment(entry);
    }
  }

  const source = allowMultiple
    ? segments
    : [...summaries.values()]
        .filter((entry) => entry.streak > 0)
        .map((entry) => ({
          entity: entry.entity,
          groupLabel: entry.groupLabel,
          streak: entry.streak,
          bestStart: entry.bestStart,
          bestStartRound: entry.bestStartRound,
          bestEnd: entry.bestEnd,
          bestEndRound: entry.bestEndRound,
        }));

  return source
    .sort((a, b) => b.streak - a.streak || a.entity.localeCompare(b.entity))
    .slice(0, limit)
    .map((entry) => {
      const row: QueryRow = {
        [entityLabel]: entry.entity,
        streak: entry.streak,
        first_game:
          entry.bestStart === null
            ? null
            : entry.bestStartRound === null
              ? `Season ${entry.bestStart}`
              : `Season ${entry.bestStart} Rd ${entry.bestStartRound}`,
        last_game:
          entry.bestEnd === null
            ? null
            : entry.bestEndRound === null
              ? `Season ${entry.bestEnd}`
              : `Season ${entry.bestEnd} Rd ${entry.bestEndRound}`,
      };
      if (groupLabelName) {
        row[groupLabelName] = entry.groupLabel;
      }
      return row;
    });
}

function buildNumericConditionExpression(
  jsonColumnExpr: string,
  conditions: QueryCondition[]
): { sql: string; binds: unknown[] } | null {
  const activeConditions = conditions.filter(
    (condition) =>
      condition.statKey &&
      condition.statKey !== "games_included" &&
      condition.operator &&
      condition.value !== ""
  );
  if (activeConditions.length === 0) {
    return null;
  }

  const operatorSql: Record<string, string> = {
    gt: ">",
    gte: ">=",
    eq: "=",
    lt: "<",
    lte: "<=",
    neq: "!=",
  };

  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const [index, condition] of activeConditions.entries()) {
    const comparator = operatorSql[condition.operator];
    if (!comparator) continue;
    const expr = `COALESCE(CAST(json_extract(${jsonColumnExpr}, ?) AS REAL), 0) ${comparator} CAST(? AS REAL)`;
    binds.push(statJsonPath(condition.statKey), condition.value);
    if (index === 0) {
      parts.push(expr);
    } else if (condition.joiner === "OR") {
      parts.push(`OR ${expr}`);
    } else if (condition.joiner === "AND NOT") {
      parts.push(`AND NOT (${expr})`);
    } else {
      parts.push(`AND ${expr}`);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return { sql: `(${parts.join(" ")})`, binds };
}

function normalizeScoreHalf(value: string | null | undefined): "all" | "first" | "second" {
  return value === "first" || value === "second" ? value : "all";
}

function teamHalfTimeExpr(alias: string): string {
  return teamStatNumericExpr(alias, "'half_time'");
}

function teamStoredNumericStatExpr(alias: string, statKey: string): string {
  return teamStatNumericExpr(alias, quotedSqlString(statKey));
}

function teamScoreStatExpression(
  statKey: string,
  scoreHalf: string,
  teamAlias = "s",
  opponentAlias = "os",
  scoreColumns: { team: string; opponent: string } = { team: "team_score", opponent: "opponent_score" }
): string | null {
  const normalizedHalf = normalizeScoreHalf(scoreHalf);
  const teamHalfExpr = teamHalfTimeExpr(teamAlias);
  const opponentHalfExpr = teamHalfTimeExpr(opponentAlias);
  const teamScoreExpr = `${teamAlias}.${scoreColumns.team}`;
  const opponentScoreExpr = `${teamAlias}.${scoreColumns.opponent}`;

  if (statKey === "points_for_first_half") {
    return teamStoredNumericStatExpr(teamAlias, "points_for_first_half");
  }
  if (statKey === "points_against_first_half") {
    return teamStoredNumericStatExpr(teamAlias, "points_against_first_half");
  }
  if (statKey === "margin_first_half") {
    return teamStoredNumericStatExpr(teamAlias, "margin_first_half");
  }
  if (statKey === "points_for_second_half") {
    return teamStoredNumericStatExpr(teamAlias, "points_for_second_half");
  }
  if (statKey === "points_against_second_half") {
    return teamStoredNumericStatExpr(teamAlias, "points_against_second_half");
  }
  if (statKey === "margin_second_half") {
    return teamStoredNumericStatExpr(teamAlias, "margin_second_half");
  }

  if (statKey === "wins") {
    return `CASE WHEN ${teamScoreExpr} > ${opponentScoreExpr} THEN 1 ELSE 0 END`;
  }
  if (statKey === "losses") {
    return `CASE WHEN ${teamScoreExpr} < ${opponentScoreExpr} THEN 1 ELSE 0 END`;
  }
  if (statKey === "draws") {
    return `CASE WHEN ${teamScoreExpr} = ${opponentScoreExpr} THEN 1 ELSE 0 END`;
  }
  if (normalizedHalf === "all") {
    if (statKey === "points_for") return teamScoreExpr;
    if (statKey === "points_against") return opponentScoreExpr;
    if (statKey === "total_points") return `(${teamScoreExpr} + ${opponentScoreExpr})`;
    if (statKey === "margin") return `(${teamScoreExpr} - ${opponentScoreExpr})`;
  }
  if (normalizedHalf === "first") {
    if (statKey === "points_for" || statKey === "points_for_first_half") {
      return teamStoredNumericStatExpr(teamAlias, "points_for_first_half");
    }
    if (statKey === "points_against" || statKey === "points_against_first_half") {
      return teamStoredNumericStatExpr(teamAlias, "points_against_first_half");
    }
    if (statKey === "total_points") {
      return `(${teamStoredNumericStatExpr(teamAlias, "points_for_first_half")} + ${teamStoredNumericStatExpr(teamAlias, "points_against_first_half")})`;
    }
    if (statKey === "margin" || statKey === "margin_first_half") {
      return teamStoredNumericStatExpr(teamAlias, "margin_first_half");
    }
  }
  if (normalizedHalf === "second") {
    if (statKey === "points_for" || statKey === "points_for_second_half") {
      return teamStoredNumericStatExpr(teamAlias, "points_for_second_half");
    }
    if (statKey === "points_against" || statKey === "points_against_second_half") {
      return teamStoredNumericStatExpr(teamAlias, "points_against_second_half");
    }
    if (statKey === "total_points") {
      return `(${teamStoredNumericStatExpr(teamAlias, "points_for_second_half")} + ${teamStoredNumericStatExpr(teamAlias, "points_against_second_half")})`;
    }
    if (statKey === "margin" || statKey === "margin_second_half") {
      return teamStoredNumericStatExpr(teamAlias, "margin_second_half");
    }
  }
  return null;
}

function buildTeamConditionExpression(
  conditions: QueryCondition[],
  scoreHalf: string,
  teamAlias = "s",
  opponentAlias = "os",
  scoreColumns: { team: string; opponent: string } = { team: "team_score", opponent: "opponent_score" }
): { sql: string; binds: unknown[] } | null {
  const activeConditions = conditions.filter(
    (condition) => condition.statKey && condition.operator && condition.value !== ""
  );
  if (activeConditions.length === 0) {
    return null;
  }

  const operatorSql: Record<string, string> = {
    gt: ">",
    gte: ">=",
    eq: "=",
    lt: "<",
    lte: "<=",
    neq: "!=",
  };

  const parts: string[] = [];
  const binds: unknown[] = [];

  for (const [index, condition] of activeConditions.entries()) {
    const comparator = operatorSql[condition.operator];
    if (!comparator) continue;

    let expr: string | null = null;
    if (condition.statKey === "games_included" || condition.statKey === "games") {
      expr = "1";
    } else {
      const scoreExpr = teamScoreStatExpression(condition.statKey, scoreHalf, teamAlias, opponentAlias, scoreColumns);
      if (scoreExpr) {
        expr = scoreExpr;
      } else {
        expr = `COALESCE(${teamStatNumericExpr(teamAlias, "?")}, 0)`;
        binds.push(condition.statKey);
      }
    }

    const clause = condition.statKey.startsWith("points_") || condition.statKey.startsWith("margin_")
      ? `(${expr}) IS NOT NULL AND (${expr}) ${comparator} CAST(? AS REAL)`
      : `${expr} ${comparator} CAST(? AS REAL)`;
    binds.push(condition.value);

    if (index === 0) {
      parts.push(clause);
    } else if (condition.joiner === "OR") {
      parts.push(`OR ${clause}`);
    } else if (condition.joiner === "AND NOT") {
      parts.push(`AND NOT (${clause})`);
    } else {
      parts.push(`AND ${clause}`);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return { sql: `(${parts.join(" ")})`, binds };
}

function normalizeCompetitionCode(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "Any") return "Any";
  const lower = trimmed.toLowerCase();
  if (lower === "nrl" || lower === "national rugby league") return "NRL";
  if (lower === "soo" || lower === "state of origin" || lower === "ampol state of origin") return "SOO";
  if (lower === "nrl_plus_soo" || lower === "nrl+soo") return "NRL_PLUS_SOO";
  if (lower === "nrlw" || lower === "national rugby league women") return "NRLW";
  if (lower === "wsoo" || lower === "women's state of origin" || lower === "womens state of origin") return "WSOO";
  if (lower === "nrlw_plus_wsoo" || lower === "nrlw+wsoo") return "NRLW_PLUS_WSOO";
  return trimmed;
}

function competitionNamesForSelection(value: string): string[] | null {
  const normalized = normalizeCompetitionCode(value);
  if (normalized === "Any") return null;
  if (normalized === "NRL") return ["National Rugby League"];
  if (normalized === "SOO") return ["State of Origin"];
  if (normalized === "NRL_PLUS_SOO") return ["National Rugby League", "State of Origin"];
  if (normalized === "NRLW") return ["National Rugby League Women"];
  if (normalized === "WSOO") return ["Women's State of Origin"];
  if (normalized === "NRLW_PLUS_WSOO") return ["National Rugby League Women", "Women's State of Origin"];
  return [normalized];
}

function aggregateSourcesForCompetition(value: string): Array<"nrl" | "soo" | "nrlw" | "wsoo"> | null {
  const normalized = normalizeCompetitionCode(value);
  if (normalized === "NRL") return ["nrl"];
  if (normalized === "SOO") return ["soo"];
  if (normalized === "NRL_PLUS_SOO") return ["nrl", "soo"];
  if (normalized === "NRLW") return ["nrlw"];
  if (normalized === "WSOO") return ["wsoo"];
  if (normalized === "NRLW_PLUS_WSOO") return ["nrlw", "wsoo"];
  return null;
}

function competitionFamilyCode(value: string | null | undefined): "NRL" | "NRLW" {
  const normalized = normalizeCompetitionCode(value);
  if (["NRLW", "WSOO", "NRLW_PLUS_WSOO"].includes(normalized)) return "NRLW";
  return "NRL";
}

function competitionFilterSql(columnSql: string, value: string): { sql: string; binds: string[] } {
  const names = competitionNamesForSelection(value);
  if (!names || names.length === 0) return { sql: "", binds: [] };
  if (names.length === 1) return { sql: `${columnSql} = ?`, binds: names };
  return { sql: `${columnSql} IN (${names.map(() => "?").join(", ")})`, binds: names };
}

function normalizeAnyStyleValue(value: string | null | undefined): string {
  const lower = String(value ?? "").trim().toLowerCase();
  if (!lower || lower === "all" || lower === "either") return "any";
  return lower;
}

function normalizePlayerType(value: string | null | undefined): string {
  const normalized = normalizeAnyStyleValue(value);
  return ["any", "forwards", "backs"].includes(normalized) ? normalized : "any";
}

function canUsePlayerAggregateFastPath(filters: QueryFilters, mode: string, format: string): boolean {
  if (!["totals", "averages"].includes(mode)) return false;
  if (!["overall", "season"].includes(format)) return false;
  if (filters.conditions.length) return false;
  if (filters.team !== "Any") return false;
  if (filters.opponent !== "Any") return false;
  if (filters.venue !== "Any") return false;
  if (filters.referee !== "Any") return false;
  if (filters.position !== "Any") return false;
  if (filters.playerType !== "any") return false;
  if (filters.matchPlayer !== "Any") return false;
  if (filters.debut !== "any") return false;
  if (filters.groundCondition !== "Any") return false;
  if (filters.weatherCondition !== "Any") return false;
  if (filters.homeAway !== "any") return false;
  if (filters.result !== "any") return false;
  if (filters.roundFrom !== null || filters.roundTo !== null) return false;
  return filters.includeRegular && filters.includeFinals && filters.includeGrandFinal;
}

async function runPlayerAggregateFastPath(
  db: D1Database,
  statKey: string,
  limit: number,
  mode: string,
  format: string,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters
): Promise<{
  ok: boolean;
  summary: string;
  columns: string[];
  rows: QueryRow[];
} | null> {
  if (statKey === "games_played") return null;
  const sources = aggregateSourcesForCompetition(filters.competition);
  if (!sources || !canUsePlayerAggregateFastPath(filters, mode, format)) return null;

  const aggregateSeasonFrom = seasonFrom;
  const aggregateSeasonTo = seasonTo;
  if (aggregateSeasonFrom > aggregateSeasonTo) return null;

  const playerFilterSql = filters.player !== "Any" ? " AND player_name = ?" : "";
  const playerFilterBinds = filters.player !== "Any" ? [filters.player] : [];
  const groupSelect = format === "season" ? "player_name, season" : "player_name";
  const groupBy = format === "season" ? "player_name, season" : "player_name";
  const orderBy = format === "season"
    ? "stat_total DESC, included_games DESC, player ASC, season ASC"
    : "stat_total DESC, included_games DESC, player ASC";
  const statExpr = mode === "averages"
    ? "ROUND(1.0 * SUM(total_value) / NULLIF(SUM(recorded_games), 0), 3)"
    : "ROUND(SUM(total_value), 3)";
  const parts: string[] = [];
  const binds: unknown[] = [];

  parts.push(`
    SELECT
      COALESCE(p.display_name, a.player_name_raw) AS player_name,
      a.season,
      SUM(a.total_value) AS total_value,
      SUM(a.recorded_games) AS recorded_games,
      SUM(a.total_games) AS total_games,
      MIN(COALESCE(a.first_season, a.season)) AS first_season,
      MAX(COALESCE(a.last_season, a.season)) AS last_season
    FROM player_stat_aggregates a
    LEFT JOIN players p ON p.player_id = a.player_id
    WHERE a.source IN (${sources.map(() => "?").join(", ")})
      AND a.scope = 'season'
      AND a.stat_key = ?
      AND a.season BETWEEN ? AND ?
    GROUP BY COALESCE(p.display_name, a.player_name_raw), a.season
  `);
  binds.push(...sources, statKey, aggregateSeasonFrom, aggregateSeasonTo);

  const sql = `
    WITH source AS (
      ${parts.join("\n      UNION ALL\n")}
    ),
    filtered AS (
      SELECT *
      FROM source
      WHERE total_value IS NOT NULL
      ${playerFilterSql}
    )
    SELECT
      ${groupSelect.replace("player_name", "player_name AS player")},
      MIN(first_season) AS first_season,
      MAX(last_season) AS last_season,
      SUM(total_games) AS games,
      SUM(recorded_games) AS included_games,
      ${statExpr} AS stat_total
    FROM filtered
    GROUP BY ${groupBy}
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  const result = await db.prepare(sql).bind(...binds, ...playerFilterBinds, limit).all<QueryRow>();
  const grouping = groupingColumns("player", format);
  const selectedDefinition = getStatDefinition("player", statKey);
  const rows = (result.results ?? []).map((row) => {
    const hydrated: QueryRow = { ...row };
    if (!selectedDefinition?.isDerived) {
      hydrated.games_played = row.games;
      hydrated[statKey] = row.stat_total;
    }
    return hydrated;
  });
  return {
    ok: true,
    summary: `Top ${limit} players by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}. Used precomputed season aggregates.`,
    columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
    rows,
  };
}

async function runPlayerConditionalAggregateFastPath(
  db: D1Database,
  statKey: string,
  limit: number,
  mode: string,
  format: string,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters
): Promise<{
  ok: boolean;
  summary: string;
  columns: string[];
  rows: QueryRow[];
} | null> {
  if (filters.conditions.length === 0) return null;
  if (!canUsePlayerAggregateFastPath({ ...filters, conditions: [] }, mode, format)) return null;
  if (statKey === "games_played" && filters.conditions.some((condition) => condition.statKey === "minutes_played")) {
    return null;
  }

  const sources = aggregateSourcesForCompetition(filters.competition);
  if (!sources) return null;

  const requestedStatKeys = new Set<string>();
  const addStatKey = (candidate: string): void => {
    if (!candidate || candidate === "games" || candidate === "games_included" || candidate === "games_played") return;
    const recipe = getDerivedRecipe("player", candidate);
    if (recipe) {
      for (const component of recipe.components) addStatKey(component);
      return;
    }
    requestedStatKeys.add(candidate);
  };
  addStatKey(statKey);
  for (const condition of filters.conditions) addStatKey(condition.statKey);

  // Tries is present for every imported player-season and provides the game-count anchor
  // when the selected statistic is games played.
  requestedStatKeys.add("tries");
  const rawStatKeys = [...requestedStatKeys];
  const playerFilterSql = filters.player !== "Any"
    ? " AND COALESCE(p.display_name, a.player_name_raw) = ?"
    : "";
  const playerFilterBinds = filters.player !== "Any" ? [filters.player] : [];
  const sql = `
    SELECT
      COALESCE(p.display_name, a.player_name_raw) AS player,
      a.source,
      a.season,
      a.stat_key,
      SUM(a.total_value) AS total_value,
      SUM(a.recorded_games) AS recorded_games,
      MAX(a.total_games) AS total_games,
      MIN(COALESCE(a.first_season, a.season)) AS first_season,
      MAX(COALESCE(a.last_season, a.season)) AS last_season
    FROM player_stat_aggregates a
    LEFT JOIN players p ON p.player_id = a.player_id
    WHERE a.source IN (${sources.map(() => "?").join(", ")})
      AND a.scope = 'season'
      AND a.season BETWEEN ? AND ?
      AND a.stat_key IN (${rawStatKeys.map(() => "?").join(", ")})
      ${playerFilterSql}
    GROUP BY COALESCE(p.display_name, a.player_name_raw), a.source, a.season, a.stat_key
  `;
  const result = await db.prepare(sql).bind(
    ...sources,
    seasonFrom,
    seasonTo,
    ...rawStatKeys,
    ...playerFilterBinds,
  ).all<QueryRow>();

  type AggregateAccumulator = {
    player: string;
    season: number;
    firstSeason: number;
    lastSeason: number;
    games: number;
    totals: Record<string, number>;
    recorded: Record<string, number>;
  };
  const sourceSeasons = new Map<string, AggregateAccumulator>();
  for (const row of result.results ?? []) {
    const player = String(row.player ?? "");
    const source = String(row.source ?? "");
    const season = Number(row.season ?? 0);
    const key = `${player}\u0000${source}\u0000${season}`;
    const accumulator = sourceSeasons.get(key) ?? {
      player,
      season,
      firstSeason: Number(row.first_season ?? season),
      lastSeason: Number(row.last_season ?? season),
      games: 0,
      totals: {},
      recorded: {},
    };
    const rawStatKey = String(row.stat_key ?? "");
    accumulator.games = Math.max(accumulator.games, Number(row.total_games ?? 0));
    accumulator.firstSeason = Math.min(accumulator.firstSeason, Number(row.first_season ?? season));
    accumulator.lastSeason = Math.max(accumulator.lastSeason, Number(row.last_season ?? season));
    accumulator.totals[rawStatKey] = Number(row.total_value ?? 0);
    accumulator.recorded[rawStatKey] = Number(row.recorded_games ?? 0);
    sourceSeasons.set(key, accumulator);
  }

  const grouped = new Map<string, AggregateAccumulator>();
  for (const sourceSeason of sourceSeasons.values()) {
    const key = format === "season" ? `${sourceSeason.player}\u0000${sourceSeason.season}` : sourceSeason.player;
    const accumulator = grouped.get(key) ?? {
      player: sourceSeason.player,
      season: sourceSeason.season,
      firstSeason: sourceSeason.firstSeason,
      lastSeason: sourceSeason.lastSeason,
      games: 0,
      totals: {},
      recorded: {},
    };
    accumulator.games += sourceSeason.games;
    accumulator.firstSeason = Math.min(accumulator.firstSeason, sourceSeason.firstSeason);
    accumulator.lastSeason = Math.max(accumulator.lastSeason, sourceSeason.lastSeason);
    for (const rawStatKey of rawStatKeys) {
      accumulator.totals[rawStatKey] = Number(accumulator.totals[rawStatKey] ?? 0)
        + Number(sourceSeason.totals[rawStatKey] ?? 0);
      accumulator.recorded[rawStatKey] = Number(accumulator.recorded[rawStatKey] ?? 0)
        + Number(sourceSeason.recorded[rawStatKey] ?? 0);
    }
    grouped.set(key, accumulator);
  }

  const requestedOutputKeys = new Set([statKey, ...filters.conditions.map((condition) => condition.statKey)]);
  const rows = [...grouped.values()].map((accumulator): QueryRow => {
    const row: QueryRow = {
      player: accumulator.player,
      ...(format === "season" ? { season: accumulator.season } : {}),
      first_season: accumulator.firstSeason,
      last_season: accumulator.lastSeason,
      games: accumulator.games,
      ...(statKey === "games_played" ? {} : { games_played: accumulator.games }),
    };
    for (const rawStatKey of rawStatKeys) {
      row[rawStatKey] = mode === "averages"
        ? Math.round((accumulator.totals[rawStatKey] / Math.max(accumulator.recorded[rawStatKey], 1)) * 1000) / 1000
        : Math.round(accumulator.totals[rawStatKey] * 1000) / 1000;
    }
    for (const outputStatKey of requestedOutputKeys) {
      const recipe = getDerivedRecipe("player", outputStatKey);
      if (!recipe) continue;
      const values = Object.fromEntries(recipe.components.map((component) => [component, Number(row[component] ?? 0)]));
      row[outputStatKey] = recipe.compute(values);
    }
    row.stat_total = statKey === "games_played" ? accumulator.games : Number(row[statKey] ?? 0);
    row.included_games = statKey === "games_played"
      ? accumulator.games
      : Number(accumulator.recorded[statKey] ?? accumulator.games);
    return row;
  });

  const filteredRows = applyAggregateConditions(rows, filters.conditions, statKey).sort((left, right) =>
    Number(right.stat_total ?? 0) - Number(left.stat_total ?? 0)
    || Number(right.included_games ?? 0) - Number(left.included_games ?? 0)
    || String(left.player ?? "").localeCompare(String(right.player ?? ""))
    || Number(left.season ?? 0) - Number(right.season ?? 0)
  );
  const grouping = groupingColumns("player", format);
  return {
    ok: true,
    summary: `Top ${limit} players by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}. Used precomputed season aggregates with aggregate conditions.`,
    columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
    rows: filteredRows.slice(0, limit),
  };
}

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quotedSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runFullResultsPlayerAggregateFastPath(
  db: D1Database,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters,
  statDefinitions: AppBootstrap["statDefinitions"],
  mode: "totals" | "averages" | "streaks",
  format: string,
  selectedStatKey: string,
  pageSize?: number,
  offset?: number,
  sortColumn?: string,
  sortDirection?: "asc" | "desc"
): Promise<{ ok: true; summary: string; rows: QueryRow[]; totalRows?: number } | null> {
  const sources = aggregateSourcesForCompetition(filters.competition);
  if (!sources || mode === "streaks") return null;
  if (!canUsePlayerAggregateFastPath({ ...filters, conditions: [] }, mode, format)) return null;

  const aggregateSeasonFrom = seasonFrom;
  const aggregateSeasonTo = seasonTo;
  if (aggregateSeasonFrom > aggregateSeasonTo) return null;

  const statKeys = new Set<string>();
  for (const definition of statDefinitions) {
    statKeys.add(definition.statKey);
    const recipe = getDerivedRecipe("player", definition.statKey);
    if (recipe) {
      for (const component of recipe.components) statKeys.add(component);
    }
  }
  statKeys.add(selectedStatKey);
  const aggregateStatKeys = [...statKeys].filter((statKey) => statKey !== "games_played");
  const modernStatKeys = aggregateStatKeys;

  const parts: string[] = [];
  const binds: unknown[] = [];
  if (modernStatKeys.length) {
    parts.push(`
      SELECT
        COALESCE(p.display_name, a.player_name_raw) AS player_name,
        a.season,
        a.stat_key,
        SUM(a.total_value) AS total_value,
        SUM(a.recorded_games) AS recorded_games,
        MAX(a.total_games) AS total_games,
        MIN(COALESCE(a.first_season, a.season)) AS first_season,
        MAX(COALESCE(a.last_season, a.season)) AS last_season
      FROM player_stat_aggregates a
      LEFT JOIN players p ON p.player_id = a.player_id
      WHERE a.source IN (${sources.map(() => "?").join(", ")})
        AND a.scope = 'season'
        AND a.season BETWEEN ? AND ?
        AND a.stat_key IN (${modernStatKeys.map(quotedSqlString).join(", ")})
      GROUP BY COALESCE(p.display_name, a.player_name_raw), a.season, a.stat_key
    `);
    binds.push(...sources, aggregateSeasonFrom, aggregateSeasonTo);
  }

  if (!parts.length) return null;

  const groupSelect = format === "season" ? "player_name AS player, season" : "player_name AS player";
  const groupBy = format === "season" ? "player_name, season" : "player_name";
  const playerFilterSql = filters.player !== "Any" ? " AND player_name = ?" : "";
  const playerFilterBinds = filters.player !== "Any" ? [filters.player] : [];
  const statColumnExprs = aggregateStatKeys.map((statKey) => {
    const alias = quotedIdentifier(statKey);
    const statKeySql = quotedSqlString(statKey);
    if (mode === "averages") {
      return `ROUND(
        1.0 * SUM(CASE WHEN stat_key = ${statKeySql} THEN total_value ELSE 0 END)
        / NULLIF(SUM(CASE WHEN stat_key = ${statKeySql} THEN recorded_games ELSE 0 END), 0),
        3
      ) AS ${alias}`;
    }
    return `ROUND(SUM(CASE WHEN stat_key = ${statKeySql} THEN total_value ELSE 0 END), 3) AS ${alias}`;
  });
  const selectedStatKeySql = quotedSqlString(selectedStatKey);
  const selectedStatTotalExpr = mode === "averages"
    ? `ROUND(
        1.0 * SUM(CASE WHEN stat_key = ${selectedStatKeySql} THEN total_value ELSE 0 END)
        / NULLIF(SUM(CASE WHEN stat_key = ${selectedStatKeySql} THEN recorded_games ELSE 0 END), 0),
        3
      )`
    : `ROUND(SUM(CASE WHEN stat_key = ${selectedStatKeySql} THEN total_value ELSE 0 END), 3)`;

  const aggregateSql = `
    WITH source AS (
      ${parts.join("\n      UNION ALL\n")}
    ),
    filtered AS (
      SELECT *
      FROM source
      WHERE total_value IS NOT NULL
      ${playerFilterSql}
    )
    SELECT
      ${groupSelect},
      ${selectedStatTotalExpr} AS stat_total,
      SUM(CASE WHEN stat_key = ${selectedStatKeySql} THEN total_games ELSE 0 END) AS games,
      SUM(CASE WHEN stat_key = ${selectedStatKeySql} THEN recorded_games ELSE 0 END) AS included_games,
      MIN(first_season) AS first_season,
      MAX(last_season) AS last_season,
      ${statColumnExprs.join(",\n      ")}
    FROM filtered
    GROUP BY ${groupBy}
  `;
  const canPageInSql = filters.conditions.length === 0 && pageSize !== undefined && offset !== undefined;
  const safeSortColumn = sortColumn && [
    ...(format === "season" ? ["season"] : []),
    "player",
    "stat_total",
    "games",
    "included_games",
    "first_season",
    "last_season",
    ...aggregateStatKeys,
  ].includes(sortColumn) ? sortColumn : "stat_total";
  const safeSortDirection = sortDirection === "asc" ? "ASC" : "DESC";
  const sql = canPageInSql
    ? `
      WITH aggregated AS (
        ${aggregateSql}
      )
      SELECT *
      FROM aggregated
      ORDER BY ${quotedIdentifier(safeSortColumn)} ${safeSortDirection}, player ASC
      LIMIT ? OFFSET ?
    `
    : aggregateSql;
  const countSql = canPageInSql
    ? `
      WITH aggregated AS (
        ${aggregateSql}
      )
      SELECT COUNT(*) AS count
      FROM aggregated
    `
    : null;

  const result = await db.prepare(sql).bind(
    ...binds,
    ...playerFilterBinds,
    ...(canPageInSql ? [pageSize, offset] : []),
  ).all<QueryRow>();
  const countResult = countSql
    ? await db.prepare(countSql).bind(
        ...binds,
        ...playerFilterBinds,
      ).first<{ count: number }>()
    : null;

  const rows = (result.results ?? []).map((row) => {
    const hydrated: QueryRow = { ...row };
    hydrated.games_played = hydrated.games;
    for (const definition of statDefinitions) {
      const recipe = getDerivedRecipe("player", definition.statKey);
      if (!recipe) continue;
      const values = Object.fromEntries(
        recipe.components.map((component) => [component, Number(hydrated[component] ?? 0)])
      );
      hydrated[definition.statKey] = recipe.compute(values);
    }
    if (selectedStatKey === "games_played") {
      hydrated.stat_total = hydrated.games;
      hydrated.included_games = hydrated.games;
    } else {
      hydrated.stat_total = hydrated[selectedStatKey] ?? hydrated.stat_total ?? null;
    }
    return hydrated;
  }).filter((row) => fullResultsMatchesConditions(row, filters.conditions, selectedStatKey, filters.scoreHalf));

  return {
    ok: true,
    summary: `Loaded ${rows.length} player ${format} aggregate rows for full-results from precomputed season aggregates.`,
    rows,
    totalRows: countResult ? Number(countResult.count ?? rows.length) : undefined,
  };
}

function canUsePlayerMatchAggregatePagedPath(
  filters: QueryFilters,
  mode: "totals" | "averages" | "streaks",
  format: string,
  statDefinitions: AppBootstrap["statDefinitions"],
  selectedStatKey: string,
  sortColumn: string,
  allowConditionBypass = false
): boolean {
  if (!["totals", "averages"].includes(mode)) return false;
  if (!["overall", "season", "club", "ground", "opposition", "match"].includes(format)) return false;
  if (!allowConditionBypass && filters.conditions.length > 0) return false;
  const selectedDefinition = statDefinitions.find((definition) => definition.statKey === selectedStatKey);
  if (selectedDefinition?.isDerived && selectedStatKey !== "games_played") return false;
  const sortDefinition = statDefinitions.find((definition) => definition.statKey === sortColumn);
  if (sortDefinition?.isDerived && sortColumn !== "games_played") return false;
  return true;
}

function canUseTeamMatchAggregatePagedPath(
  filters: QueryFilters,
  mode: "totals" | "averages" | "streaks",
  format: string,
  statDefinitions: AppBootstrap["statDefinitions"],
  selectedStatKey: string,
  sortColumn: string,
  allowConditionBypass = false
): boolean {
  if (!["totals", "averages"].includes(mode)) return false;
  if (!["overall", "season", "ground", "opposition", "match"].includes(format)) return false;
  if (!allowConditionBypass && filters.conditions.length > 0) return false;
  const sqlDerivedTeamStats = new Set([
    "games",
    "wins",
    "losses",
    "draws",
    "points_for",
    "points_against",
    "total_points",
    "margin",
    "points_for_first_half",
    "points_against_first_half",
    "margin_first_half",
    "points_for_second_half",
    "points_against_second_half",
    "margin_second_half",
  ]);
  const selectedDefinition = statDefinitions.find((definition) => definition.statKey === selectedStatKey);
  if (selectedDefinition?.isDerived && !sqlDerivedTeamStats.has(selectedStatKey)) return false;
  const sortDefinition = statDefinitions.find((definition) => definition.statKey === sortColumn);
  if (sortDefinition?.isDerived && !sqlDerivedTeamStats.has(sortColumn)) return false;
  return true;
}

async function runFullResultsTeamMatchAggregatePagedPath(
  db: D1Database,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters,
  statDefinitions: AppBootstrap["statDefinitions"],
  mode: "totals" | "averages" | "streaks",
  format: string,
  selectedStatKey: string,
  pageSize: number,
  offset: number,
  sortColumn: string,
  sortDirection: "asc" | "desc",
  allowConditionBypass = false,
): Promise<{ ok: true; summary: string; rows: QueryRow[]; totalRows: number } | null> {
  if (!canUseTeamMatchAggregatePagedPath(filters, mode, format, statDefinitions, selectedStatKey, sortColumn, allowConditionBypass)) {
    return null;
  }

  const scoreDerivedStatKeys = new Set([
    "wins",
    "losses",
    "draws",
    "points_for",
    "points_against",
    "total_points",
    "margin",
    "points_for_first_half",
    "points_against_first_half",
    "margin_first_half",
    "points_for_second_half",
    "points_against_second_half",
    "margin_second_half",
  ]);
  if (
    format === "match" &&
    scoreDerivedStatKeys.has(selectedStatKey) &&
    filters.referee === "Any" &&
    filters.groundCondition === "Any" &&
    filters.weatherCondition === "Any" &&
    filters.matchPlayer === "Any"
  ) {
    const matchClauses: string[] = [];
    const matchBinds: unknown[] = [seasonFrom, seasonTo];
    if (filters.competition !== "Any") {
      const competitionFilter = competitionFilterSql("src.competition_name", filters.competition);
      if (competitionFilter.sql) {
        matchClauses.push(competitionFilter.sql);
        matchBinds.push(...competitionFilter.binds);
      }
    }
    if (filters.team !== "Any") {
      matchClauses.push("src.team = ?");
      matchBinds.push(filters.team);
    }
    if (filters.opponent !== "Any") {
      matchClauses.push("src.opposition = ?");
      matchBinds.push(filters.opponent);
    }
    if (filters.venue !== "Any") {
      matchClauses.push("src.ground = ?");
      matchBinds.push(filters.venue);
    }
    if (filters.homeAway === "home") {
      matchClauses.push("src.is_home = 1");
    } else if (filters.homeAway === "away") {
      matchClauses.push("src.is_home = 0");
    }
    if (filters.result === "win") {
      matchClauses.push("src.points_for > src.points_against");
    } else if (filters.result === "loss") {
      matchClauses.push("src.points_for < src.points_against");
    } else if (filters.result === "tie") {
      matchClauses.push("src.points_for = src.points_against");
    }
    if (filters.roundFrom !== null) {
      matchClauses.push("src.round_index >= ?");
      matchBinds.push(filters.roundFrom);
    }
    if (filters.roundTo !== null) {
      matchClauses.push("src.round_index <= ?");
      matchBinds.push(filters.roundTo);
    }
    const seasonTypeExpr = buildSeasonTypeExpression("src", filters);
    if (seasonTypeExpr) {
      matchClauses.push(seasonTypeExpr);
    }
    const conditionExpr = buildTeamConditionExpression(
      filters.conditions,
      filters.scoreHalf,
      "src",
      "src",
      { team: "points_for", opponent: "points_against" }
    );
    if (conditionExpr) {
      matchClauses.push(conditionExpr.sql);
      matchBinds.push(...conditionExpr.binds);
    }

    const safeSortColumn = [
      "team",
      "season",
      "round",
      "opposition",
      "ground",
      "match_reference",
      "match_sort_key",
      "match_id",
      "games",
      "included_games",
      "wins",
      "losses",
      "draws",
      "points_for",
      "points_against",
      "total_points",
      "margin",
      "stat_total",
    ].includes(sortColumn) ? sortColumn : "stat_total";
    const safeSortDirection = sortDirection === "asc" ? "ASC" : "DESC";
    const selectedScoreColumn = (() => {
      const scoreHalf = normalizeScoreHalf(filters.scoreHalf);
      if (selectedStatKey === "points_for") {
        return scoreHalf === "first"
          ? "points_for_first_half"
          : scoreHalf === "second"
            ? "points_for_second_half"
            : "points_for";
      }
      if (selectedStatKey === "points_against") {
        return scoreHalf === "first"
          ? "points_against_first_half"
          : scoreHalf === "second"
            ? "points_against_second_half"
            : "points_against";
      }
      if (selectedStatKey === "total_points") {
        return scoreHalf === "first"
          ? "total_points_first_half"
          : scoreHalf === "second"
            ? "total_points_second_half"
            : "total_points";
      }
      if (selectedStatKey === "margin") {
        return scoreHalf === "first"
          ? "margin_first_half"
          : scoreHalf === "second"
            ? "margin_second_half"
            : "margin";
      }
      return selectedStatKey;
    })();
    const statTotalExpr = mode === "averages"
      ? `1.0 * src.${quotedIdentifier(selectedScoreColumn)}`
      : `src.${quotedIdentifier(selectedScoreColumn)}`;
    const sourceSql = `
      SELECT
        t.canonical_name AS team,
        c.name AS competition_name,
        s.season,
        s.match_id,
        s.round_index,
        m.round_label AS round_label,
        m.round_label AS round,
        m.is_finals,
        COALESCE(ot.canonical_name, 'Unknown') AS opposition,
        COALESCE(v.canonical_name, 'Unknown') AS ground,
        COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
        ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
        s.is_home,
        1 AS games,
        1 AS included_games,
        CASE WHEN s.team_score > s.opponent_score THEN 1 ELSE 0 END AS wins,
        CASE WHEN s.team_score < s.opponent_score THEN 1 ELSE 0 END AS losses,
        CASE WHEN s.team_score = s.opponent_score THEN 1 ELSE 0 END AS draws,
        s.team_score AS points_for,
        s.opponent_score AS points_against,
        (s.team_score + s.opponent_score) AS total_points,
        (s.team_score - s.opponent_score) AS margin,
        ${teamStoredNumericStatExpr("s", "points_for_first_half")} AS points_for_first_half,
        ${teamStoredNumericStatExpr("s", "points_against_first_half")} AS points_against_first_half,
        (${teamStoredNumericStatExpr("s", "points_for_first_half")} + ${teamStoredNumericStatExpr("s", "points_against_first_half")}) AS total_points_first_half,
        ${teamStoredNumericStatExpr("s", "margin_first_half")} AS margin_first_half,
        ${teamStoredNumericStatExpr("s", "points_for_second_half")} AS points_for_second_half,
        ${teamStoredNumericStatExpr("s", "points_against_second_half")} AS points_against_second_half,
        (${teamStoredNumericStatExpr("s", "points_for_second_half")} + ${teamStoredNumericStatExpr("s", "points_against_second_half")}) AS total_points_second_half,
        ${teamStoredNumericStatExpr("s", "margin_second_half")} AS margin_second_half
      FROM team_match_summary s
      JOIN matches m ON m.match_id = s.match_id
      JOIN teams t ON t.team_id = s.team_id
      LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
      JOIN competitions c ON c.competition_id = m.competition_id
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      WHERE ${completedMatchPredicate("m")}
    `;
    const sql = `
      WITH source AS (
        ${sourceSql}
      ),
      filtered AS (
        SELECT
          src.*,
          ${statTotalExpr} AS stat_total
        FROM source src
        WHERE src.season BETWEEN ? AND ?
        ${matchClauses.length ? ` AND ${matchClauses.join(" AND ")}` : ""}
      )
      SELECT *
      FROM filtered
      ORDER BY ${quotedIdentifier(safeSortColumn)} ${safeSortDirection}, team ASC
      LIMIT ? OFFSET ?
    `;
    const countSql = `
      WITH source AS (
        ${sourceSql}
      ),
      filtered AS (
        SELECT 1
        FROM source src
        WHERE src.season BETWEEN ? AND ?
        ${matchClauses.length ? ` AND ${matchClauses.join(" AND ")}` : ""}
      )
      SELECT COUNT(*) AS count
      FROM filtered
    `;
    const rowsResult = await db.prepare(sql).bind(...matchBinds, pageSize, offset).all<QueryRow>();
    const countResult = await db.prepare(countSql).bind(...matchBinds).first<{ count: number }>();
    return {
      ok: true,
      summary: `Loaded ${(rowsResult.results ?? []).length} team match rows for full-results using direct match scoring history.`,
      rows: rowsResult.results ?? [],
      totalRows: Number(countResult?.count ?? 0),
    };
  }

  const teamFilters = buildTeamFilters({ ...filters, conditions: [] });
  const grouping = groupingColumns("team", format);
  const groupSelect = grouping.select.map((selectExpr) => {
    if (selectExpr === "team_name AS team") return "team AS team";
    if (selectExpr === "season") return "season";
    if (selectExpr === "venue_name AS ground") return "ground AS ground";
    if (selectExpr === "opposition_name AS opposition") return "opposition AS opposition";
    return selectExpr.replaceAll("team_name", "team").replaceAll("venue_name", "ground").replaceAll("opposition_name", "opposition");
  }).join(", ");
  const groupBy = grouping.groupBy.map((groupByExpr) =>
    groupByExpr.replaceAll("team_name", "team").replaceAll("venue_name", "ground").replaceAll("opposition_name", "opposition")
  ).join(", ");
  const groupingColumnsList = grouping.columns;
  const rawStatKeys = [...new Set(statDefinitions
    .filter((definition) => !definition.isDerived && definition.statKey !== "games")
    .map((definition) => definition.statKey))];
  const selectedScoreExpr = selectedStatKey === "games"
    ? null
    : teamScoreStatExpression(selectedStatKey, filters.scoreHalf, "s", "os");
  if (!rawStatKeys.length && selectedStatKey !== "games" && !selectedScoreExpr) return null;
  if (
    selectedStatKey !== "games" &&
    !rawStatKeys.includes(selectedStatKey) &&
    !selectedScoreExpr
  ) return null;

  const definitionByStatKey = new Map(statDefinitions.map((definition) => [definition.statKey, definition]));
  const getTeamStatDefinition = (statKey: string) =>
    definitionByStatKey.get(statKey) ?? getStatDefinition("team", statKey);
  const missingStrategyForStat = (statKey: string) =>
    getTeamStatDefinition(statKey)?.missingValueStrategy ?? (TEAM_ZERO_IF_MISSING.has(statKey) ? "zero_if_missing" : "exclude");
  const firstConsistentSeasonForStat = (statKey: string) =>
    Number(getTeamStatDefinition(statKey)?.firstConsistentSeason ?? 0);
  const statValueSelects: string[] = [];
  const statIncludedSelects: string[] = [];
  const statAggregateSelects: string[] = [];
  const statValueAliases = new Map<string, string>();
  const statIncludedAliases = new Map<string, string>();
  const statValueBinds: unknown[] = [];
  const statIncludedBinds: unknown[] = [];

  for (const statKey of rawStatKeys) {
    const valueAlias = quotedIdentifier(`v_${statKey}`);
    const includedAlias = quotedIdentifier(`i_${statKey}`);
    statValueAliases.set(statKey, valueAlias);
    statIncludedAliases.set(statKey, includedAlias);
    const scoreExpr = teamScoreStatExpression(statKey, filters.scoreHalf, "s", "os");

    if (scoreExpr) {
      statValueSelects.push(`${scoreExpr} AS ${valueAlias}`);
    } else {
    statValueSelects.push(`COALESCE(${teamStatNumericExpr("s", "?")}, 0) AS ${valueAlias}`);
    statValueBinds.push(statKey);
    }

    if (scoreExpr) {
      statIncludedSelects.push(
        normalizeScoreHalf(filters.scoreHalf) === "all"
          ? `1 AS ${includedAlias}`
          : `CASE WHEN (${scoreExpr}) IS NOT NULL THEN 1 ELSE 0 END AS ${includedAlias}`
      );
    } else if (missingStrategyForStat(statKey) === "zero_if_missing") {
      statIncludedSelects.push(`1 AS ${includedAlias}`);
    } else {
      statIncludedSelects.push(
        `CASE WHEN s.season >= ${firstConsistentSeasonForStat(statKey)} THEN 1 WHEN ${teamStatPresentExpr("s", "?")} THEN 1 ELSE 0 END AS ${includedAlias}`
      );
      statIncludedBinds.push(statKey);
    }

    const statAlias = quotedIdentifier(statKey);
    statAggregateSelects.push(
      mode === "averages"
        ? `ROUND(1.0 * SUM(${valueAlias}) / NULLIF(SUM(${includedAlias}), 0), 3) AS ${statAlias}`
        : `ROUND(SUM(${valueAlias}), 3) AS ${statAlias}`
    );
  }

  const selectedValueAlias = selectedStatKey === "games"
    ? null
    : (statValueAliases.get(selectedStatKey) ?? quotedIdentifier(`v_${selectedStatKey}`));
  const selectedIncludedAlias = selectedStatKey === "games"
    ? null
    : (statIncludedAliases.get(selectedStatKey) ?? quotedIdentifier(`i_${selectedStatKey}`));
  if (selectedStatKey !== "games" && !statValueAliases.has(selectedStatKey)) {
    if (selectedScoreExpr) {
      statValueSelects.push(`${selectedScoreExpr} AS ${selectedValueAlias}`);
    } else {
      statValueSelects.push(`COALESCE(${teamStatNumericExpr("s", "?")}, 0) AS ${selectedValueAlias}`);
      statValueBinds.push(selectedStatKey);
    }
  }
  if (selectedStatKey !== "games" && !statIncludedAliases.has(selectedStatKey)) {
    if (selectedScoreExpr) {
      statIncludedSelects.push(
        normalizeScoreHalf(filters.scoreHalf) === "all"
          ? `1 AS ${selectedIncludedAlias}`
          : `CASE WHEN (${selectedScoreExpr}) IS NOT NULL THEN 1 ELSE 0 END AS ${selectedIncludedAlias}`
      );
    } else if (missingStrategyForStat(selectedStatKey) === "zero_if_missing") {
      statIncludedSelects.push(`1 AS ${selectedIncludedAlias}`);
    } else {
      statIncludedSelects.push(
        `CASE WHEN s.season >= ${firstConsistentSeasonForStat(selectedStatKey)} THEN 1 WHEN ${teamStatPresentExpr("s", "?")} THEN 1 ELSE 0 END AS ${selectedIncludedAlias}`
      );
      statIncludedBinds.push(selectedStatKey);
    }
  }

  const selectedStatTotalExpr = selectedStatKey === "games"
    ? (mode === "averages" ? "1.0" : "COUNT(*)")
    : (mode === "averages"
        ? `ROUND(1.0 * SUM(${selectedValueAlias}) / NULLIF(SUM(${selectedIncludedAlias}), 0), 3)`
        : `ROUND(SUM(${selectedValueAlias}), 3)`);
  const selectedIncludedGamesExpr = selectedStatKey === "games"
    ? "COUNT(*)"
    : `SUM(${selectedIncludedAlias})`;
  const bindValues: unknown[] = [
    ...statValueBinds,
    ...statIncludedBinds,
    seasonFrom,
    seasonTo,
    ...teamFilters.binds,
  ];

  const aggregateSql = `
    WITH base AS (
      SELECT
        t.canonical_name AS team,
        s.season,
        s.match_id,
        m.round_label,
        COALESCE(v.canonical_name, 'Unknown') AS ground,
        COALESCE(ot.canonical_name, 'Unknown') AS opposition,
        COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
        ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key${[...statValueSelects, ...statIncludedSelects].length ? `,\n        ${[...statValueSelects, ...statIncludedSelects].join(",\n        ")}` : ""}
      FROM team_match_summary s
      JOIN teams t ON t.team_id = s.team_id
      JOIN matches m ON m.match_id = s.match_id
      JOIN competitions c ON c.competition_id = m.competition_id
      LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      LEFT JOIN team_match_summary os ON os.match_id = s.match_id AND os.team_id = s.opponent_team_id
      WHERE s.season BETWEEN ? AND ?
      ${teamFilters.sql}
    ),
    aggregated AS (
      SELECT
        ${groupSelect},
        ${selectedStatTotalExpr} AS stat_total,
        COUNT(*) AS games,
        ${selectedIncludedGamesExpr} AS included_games,
        MIN(season) AS first_season,
        MAX(season) AS last_season${statAggregateSelects.length ? `,\n        ${statAggregateSelects.join(",\n        ")}` : ""}
      FROM base
      GROUP BY ${groupBy}
    )
  `;

  const safeSortColumn = sortColumn && [
    ...groupingColumnsList,
    ...(sortColumn === "games" ? ["games"] : []),
    "stat_total",
    "games",
    "included_games",
    "first_season",
    "last_season",
    ...rawStatKeys,
  ].includes(sortColumn) ? sortColumn : "stat_total";
  const safeSortDirection = sortDirection === "asc" ? "ASC" : "DESC";
  const sql = `
    ${aggregateSql}
    SELECT *
    FROM aggregated
    ORDER BY ${quotedIdentifier(safeSortColumn)} ${safeSortDirection}, team ASC
    LIMIT ? OFFSET ?
  `;
  const countSql = `
    ${aggregateSql}
    SELECT COUNT(*) AS count
    FROM aggregated
  `;

  const rowsResult = await db.prepare(sql).bind(...bindValues, pageSize, offset).all<QueryRow>();
  const countResult = await db.prepare(countSql).bind(...bindValues).first<{ count: number }>();
  const rows = (rowsResult.results ?? []).map((row) => {
    const hydrated: QueryRow = { ...row };
    for (const definition of statDefinitions) {
      const recipe = getDerivedRecipe("team", definition.statKey);
      if (!recipe) continue;
      const values = Object.fromEntries(
        recipe.components.map((component) => [component, Number(hydrated[component] ?? 0)])
      );
      hydrated[definition.statKey] = recipe.compute(values);
    }
    if (scoreDerivedStatKeys.has(selectedStatKey)) {
      hydrated.stat_total = hydrated[selectedStatKey] ?? hydrated.stat_total ?? null;
    }
    return hydrated;
  });

  return {
    ok: true,
    summary: `Loaded ${rows.length} team ${format} aggregate rows for full-results from match summaries with SQL paging.`,
    rows,
    totalRows: Number(countResult?.count ?? 0),
  };
}

async function runFullResultsPlayerMatchAggregatePagedPath(
  db: D1Database,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters,
  statDefinitions: AppBootstrap["statDefinitions"],
  mode: "totals" | "averages" | "streaks",
  format: string,
  selectedStatKey: string,
  pageSize: number,
  offset: number,
  sortColumn: string,
  sortDirection: "asc" | "desc",
  allowConditionBypass = false,
  topRowPerGroup = false,
): Promise<{ ok: true; summary: string; rows: QueryRow[]; totalRows: number } | null> {
  if (!canUsePlayerMatchAggregatePagedPath(filters, mode, format, statDefinitions, selectedStatKey, sortColumn, allowConditionBypass)) {
    return null;
  }

  const playerFilters = buildPlayerFilters({ ...filters, conditions: [] });
  const groupSelect = format === "season"
    ? "player, season"
    : format === "club"
      ? "player, club_name AS club"
      : format === "ground"
        ? "player, venue_name AS ground"
        : format === "opposition"
          ? "player, opposition_name AS opposition"
          : format === "match"
            ? "player, season, round_label AS round, opposition_name AS opposition, venue_name AS ground, match_reference, match_sort_key, match_id"
            : "player";
  const groupBy = format === "season"
    ? "player, season"
    : format === "club"
      ? "player, club_name"
      : format === "ground"
        ? "player, venue_name"
        : format === "opposition"
          ? "player, opposition_name"
          : format === "match"
            ? "player, match_id, season, round_label, opposition_name, venue_name, match_reference, match_sort_key"
            : "player";
  const groupingColumnsList = format === "season"
    ? ["player", "season"]
    : format === "club"
      ? ["player", "club"]
      : format === "ground"
        ? ["player", "ground"]
        : format === "opposition"
          ? ["player", "opposition"]
          : format === "match"
            ? ["player", "season", "round", "opposition", "ground", "match_reference", "match_sort_key", "match_id"]
            : ["player"];
  const rawStatKeys = [...new Set(statDefinitions
    .filter((definition) => !definition.isDerived && definition.statKey !== "games_played")
    .map((definition) => definition.statKey))];
  if (!rawStatKeys.length && selectedStatKey !== "games_played") return null;
  if (selectedStatKey !== "games_played" && !rawStatKeys.includes(selectedStatKey)) return null;

  const definitionByStatKey = new Map(statDefinitions.map((definition) => [definition.statKey, definition]));
  const getPlayerStatDefinition = (statKey: string) =>
    definitionByStatKey.get(statKey) ?? getStatDefinition("player", statKey);
  const missingStrategyForStat = (statKey: string) =>
    getPlayerStatDefinition(statKey)?.missingValueStrategy ?? (PLAYER_ZERO_IF_MISSING.has(statKey) ? "zero_if_missing" : "exclude");
  const firstConsistentSeasonForStat = (statKey: string) =>
    Number(getPlayerStatDefinition(statKey)?.firstConsistentSeason ?? 0);

  const statValueSelects: string[] = [];
  const statIncludedSelects: string[] = [];
  const statAggregateSelects: string[] = [];
  const statValueAliases = new Map<string, string>();
  const statIncludedAliases = new Map<string, string>();

  rawStatKeys.forEach((statKey) => {
    const valueAlias = quotedIdentifier(`v_${statKey}`);
    const includedAlias = quotedIdentifier(`i_${statKey}`);
    const jsonPath = quotedSqlString(statJsonPath(statKey));
    const jsonValue = `json_extract(s.stats_json, ${jsonPath})`;
    statValueAliases.set(statKey, valueAlias);
    statIncludedAliases.set(statKey, includedAlias);

    statValueSelects.push(`COALESCE(CAST(${jsonValue} AS REAL), 0) AS ${valueAlias}`);

    if (missingStrategyForStat(statKey) === "zero_if_missing") {
      statIncludedSelects.push(`1 AS ${includedAlias}`);
    } else {
      statIncludedSelects.push(
        `CASE WHEN s.season >= ${firstConsistentSeasonForStat(statKey)} THEN 1 WHEN json_type(s.stats_json, ${jsonPath}) IS NOT NULL THEN 1 ELSE 0 END AS ${includedAlias}`
      );
    }

    const statAlias = quotedIdentifier(statKey);
    statAggregateSelects.push(
      mode === "averages"
        ? `ROUND(1.0 * SUM(${valueAlias}) / NULLIF(SUM(${includedAlias}), 0), 3) AS ${statAlias}`
        : `ROUND(SUM(${valueAlias}), 3) AS ${statAlias}`
    );
  });

  const selectedValueAlias = selectedStatKey === "games_played"
    ? null
    : (statValueAliases.get(selectedStatKey) ?? quotedIdentifier(`v_${selectedStatKey}`));
  const selectedIncludedAlias = selectedStatKey === "games_played"
    ? null
    : (statIncludedAliases.get(selectedStatKey) ?? quotedIdentifier(`i_${selectedStatKey}`));

  const selectedStatTotalExpr = selectedStatKey === "games_played"
    ? (mode === "averages" ? "1.0" : "COUNT(*)")
    : (mode === "averages"
        ? `ROUND(1.0 * SUM(${selectedValueAlias}) / NULLIF(SUM(${selectedIncludedAlias}), 0), 3)`
        : `ROUND(SUM(${selectedValueAlias}), 3)`);
  const selectedIncludedGamesExpr = selectedStatKey === "games_played"
    ? "COUNT(*)"
    : `SUM(${selectedIncludedAlias})`;
  const bindValues: unknown[] = [
    seasonFrom,
    seasonTo,
    ...playerFilters.binds,
  ];

  const baseSql = `
    WITH base AS (
      SELECT
        COALESCE(p.display_name, s.player_name_raw) AS player,
        tt.canonical_name AS club_name,
        s.season,
        s.match_id,
        m.round_label,
        COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
        COALESCE(v.canonical_name, 'Unknown') AS venue_name,
        COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
        ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key${[...statValueSelects, ...statIncludedSelects].length ? `,\n        ${[...statValueSelects, ...statIncludedSelects].join(",\n        ")}` : ""}
      FROM player_match_summary s
      LEFT JOIN players p ON p.player_id = s.player_id
      JOIN matches m ON m.match_id = s.match_id
      JOIN competitions c ON c.competition_id = m.competition_id
      JOIN teams tt ON tt.team_id = s.team_id
      LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      WHERE s.season BETWEEN ? AND ?
      ${playerFilters.sql}
    )
  `;

  if (format === "match") {
    const selectedDirectValueExpr = selectedStatKey === "games_played" ? "1" : selectedValueAlias;
    const selectedDirectIncludedExpr = selectedStatKey === "games_played" ? "1" : selectedIncludedAlias;
    const directStatSelects = rawStatKeys.map((rawStatKey) =>
      `${statValueAliases.get(rawStatKey)} AS ${quotedIdentifier(rawStatKey)}`
    );
    const safeDirectSortColumn = safePlayerMatchSortColumn(
      sortColumn,
      groupingColumnsList,
      rawStatKeys
    );
    const safeSortDirection = sortDirection === "asc" ? "ASC" : "DESC";
    const sql = `
      ${baseSql}
      SELECT
        player,
        season,
        round_label AS round,
        opposition_name AS opposition,
        venue_name AS ground,
        match_reference,
        match_sort_key,
        match_id,
        ${selectedDirectValueExpr} AS stat_total,
        1 AS games,
        ${selectedDirectIncludedExpr} AS included_games,
        season AS first_season,
        season AS last_season,
        COUNT(*) OVER() AS "__total_rows"${directStatSelects.length ? `,
        ${directStatSelects.join(",\n        ")}` : ""}
      FROM base
      ORDER BY ${quotedIdentifier(safeDirectSortColumn)} ${safeSortDirection}, player ASC
      LIMIT ? OFFSET ?
    `;
    const rowsResult = await db.prepare(sql).bind(...bindValues, pageSize, offset).all<QueryRow>();
    const rawRows = rowsResult.results ?? [];
    const totalRows = Number(rawRows[0]?.__total_rows ?? 0);
    const rows = rawRows.map((row) => {
      const { __total_rows, ...publicRow } = row;
      return {
        ...publicRow,
        games_played: publicRow.games,
      };
    });
    return {
      ok: true,
      summary: `Loaded ${rows.length} player match rows directly from canonical match summaries with SQL paging.`,
      rows,
      totalRows,
    };
  }

  const aggregateSql = `
    ${baseSql},
    aggregated AS (
      SELECT
        ${groupSelect},
        ${selectedStatTotalExpr} AS stat_total,
        COUNT(*) AS games,
        ${selectedIncludedGamesExpr} AS included_games,
        MIN(season) AS first_season,
        MAX(season) AS last_season${statAggregateSelects.length ? `,\n        ${statAggregateSelects.join(",\n        ")}` : ""}
      FROM base
      GROUP BY ${groupBy}
    )
  `;

  const safeSortColumn = sortColumn && [
    ...groupingColumnsList,
    ...(sortColumn === "games_played" ? ["games_played"] : []),
    "stat_total",
    "games",
    "included_games",
    "first_season",
    "last_season",
    ...rawStatKeys,
  ].includes(sortColumn) ? sortColumn : "stat_total";
  const safeSortDirection = sortDirection === "asc" ? "ASC" : "DESC";
  const groupPartitionColumns = groupingColumnsList.slice(1);
  const useGroupedRanking = topRowPerGroup && groupPartitionColumns.length > 0;
  const rankedSql = useGroupedRanking
    ? `,
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY ${groupPartitionColumns.map(quotedIdentifier).join(", ")}
          ORDER BY stat_total DESC, included_games DESC, player ASC
        ) AS "__group_rank"
      FROM aggregated
    )`
    : "";
  const sql = `
    ${aggregateSql}${rankedSql}
    SELECT *, COUNT(*) OVER() AS "__total_rows"
    FROM ${useGroupedRanking ? "ranked" : "aggregated"}
    ${useGroupedRanking ? 'WHERE "__group_rank" = 1' : ""}
    ORDER BY ${quotedIdentifier(safeSortColumn === "games_played" ? "games" : safeSortColumn)} ${safeSortDirection}, player ASC
    LIMIT ? OFFSET ?
  `;
  const rowsResult = await db.prepare(sql).bind(...bindValues, pageSize, offset).all<QueryRow>();
  const rawRows = rowsResult.results ?? [];
  const totalRows = Number(rawRows[0]?.__total_rows ?? 0);
  const rows = rawRows.map((row) => {
    const { __total_rows, __group_rank, ...publicRow } = row;
    const hydrated: QueryRow = { ...publicRow, games_played: publicRow.games };
    for (const definition of statDefinitions) {
      if (definition.statKey === "games_played") {
        hydrated.games_played = hydrated.games ?? 0;
        continue;
      }
      const recipe = getDerivedRecipe("player", definition.statKey);
      if (!recipe) continue;
      const values = Object.fromEntries(
        recipe.components.map((component) => [component, Number(hydrated[component] ?? 0)])
      );
      hydrated[definition.statKey] = recipe.compute(values);
    }
    return hydrated;
  });

  return {
    ok: true,
    summary: `Loaded ${rows.length} player ${format} aggregate rows for full-results from match summaries with SQL paging.`,
    rows,
    totalRows,
  };
}

function safePlayerMatchSortColumn(
  sortColumn: string,
  groupingColumns: string[],
  rawStatKeys: string[]
): string {
  const normalized = sortColumn === "games_played" ? "games" : sortColumn;
  return [
    ...groupingColumns,
    "match_id",
    "stat_total",
    "games",
    "included_games",
    "first_season",
    "last_season",
    ...rawStatKeys,
  ].includes(normalized) ? normalized : "stat_total";
}

function canUseTeamJsonAggregateFastPath(filters: QueryFilters, mode: string, format: string, statKey: string): boolean {
  if (!["totals", "averages"].includes(mode)) return false;
  if (!["overall", "season"].includes(format)) return false;
  if (getDerivedRecipe("team", statKey)) return false;
  if (["wins", "losses", "draws", "points_for", "points_against", "total_points", "margin"].includes(statKey)) return false;
  if (filters.conditions.length) return false;
  if (filters.team !== "Any") return false;
  if (filters.opponent !== "Any") return false;
  if (filters.venue !== "Any") return false;
  if (filters.referee !== "Any") return false;
  if (filters.matchPlayer !== "Any") return false;
  if (filters.groundCondition !== "Any") return false;
  if (filters.weatherCondition !== "Any") return false;
  if (filters.homeAway !== "any") return false;
  if (filters.result !== "any") return false;
  if (filters.roundFrom !== null || filters.roundTo !== null) return false;
  if (normalizeScoreHalf(filters.scoreHalf) !== "all") return false;
  return filters.includeRegular && filters.includeFinals && filters.includeGrandFinal;
}

async function runTeamJsonAggregateFastPath(
  db: D1Database,
  statKey: string,
  limit: number,
  mode: string,
  format: string,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters
): Promise<{
  ok: boolean;
  summary: string;
  columns: string[];
  rows: QueryRow[];
} | null> {
  if (!canUseTeamJsonAggregateFastPath(filters, mode, format, statKey)) return null;
  const grouping = groupingColumns("team", format);
  const groupSelect = format === "season" ? "t.canonical_name AS team, s.season" : "t.canonical_name AS team";
  const groupBy = format === "season" ? "t.canonical_name, s.season" : "t.canonical_name";
  const competitionFilter = competitionFilterSql("c.name", filters.competition);
  const competitionSql = competitionFilter.sql ? `AND ${competitionFilter.sql}` : "";
  const includedFlag = TEAM_ZERO_IF_MISSING.has(statKey)
    ? "1"
    : `CASE WHEN s.season >= COALESCE(sd.first_consistent_season, 0) THEN 1 WHEN ${teamStatPresentExpr("s", "?")} THEN 1 ELSE 0 END`;
  const statExpr = mode === "averages"
    ? "ROUND(SUM(stat_value) / NULLIF(SUM(included_flag), 0), 3)"
    : "ROUND(SUM(stat_value), 3)";
  const sql = `
    WITH base AS (
      SELECT
        ${groupSelect},
        s.season AS source_season,
        COALESCE(${teamStatNumericExpr("s", "?")}, 0) AS stat_value,
        ${includedFlag} AS included_flag
      FROM team_match_summary s
      JOIN teams t ON t.team_id = s.team_id
      JOIN matches m ON m.match_id = s.match_id
      JOIN competitions c ON c.competition_id = m.competition_id
      LEFT JOIN stat_definitions sd ON sd.scope = 'team' AND sd.stat_key = ?
      WHERE s.season BETWEEN ? AND ?
        AND ${completedMatchPredicate("m")}
        ${competitionSql}
    )
    SELECT
      ${format === "season" ? "team, season" : "team"},
      MIN(source_season) AS first_season,
      MAX(source_season) AS last_season,
      COUNT(*) AS games,
      SUM(included_flag) AS included_games,
      ${statExpr} AS stat_total
    FROM base
    GROUP BY ${groupBy.replaceAll("t.canonical_name", "team").replaceAll("s.season", "season")}
    ORDER BY stat_total DESC, team ASC
    LIMIT ?
  `;
  const binds = TEAM_ZERO_IF_MISSING.has(statKey)
    ? [statKey, statKey, seasonFrom, seasonTo]
    : [statKey, statKey, statKey, seasonFrom, seasonTo];
  binds.push(...competitionFilter.binds);
  binds.push(limit);
  const result = await db.prepare(sql).bind(...binds).all<QueryRow>();
  return {
    ok: true,
    summary: `Top ${limit} teams by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}. Used simplified team aggregate path.`,
    columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
    rows: result.results ?? [],
  };
}

async function runTeamSeasonAggregateStreakPath(
  db: D1Database,
  statKey: string,
  limit: number,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters,
  allowMultipleStreaks: boolean,
): Promise<{ ok: boolean; summary: string; columns: string[]; rows: QueryRow[] } | null> {
  if (!canUseTeamSeasonAggregatePath(filters, "season")) return null;
  const sources = aggregateSourcesForCompetition(filters.competition);
  if (!sources) return null;
  const phases = selectedSeasonPhases(filters);
  if (!phases.length) return null;

  const conditionStatKeys = uniqueConditionStatKeys(filters.conditions, statKey);
  const requestedMetricKeys = new Set<string>([statKey, ...conditionStatKeys]);
  const storedMetricKeys = new Set<string>();
  const sourceSqlList = sources.map(quotedSqlString).join(", ");
  const phaseSqlList = phases.map(quotedSqlString).join(", ");

  for (const key of requestedMetricKeys) {
    if (["games", "games_played", "games_included"].includes(key)) continue;
    const recipe = getDerivedRecipe("team", key);
    if (recipe) {
      for (const component of recipe.components) storedMetricKeys.add(component);
    } else {
      for (const storageKey of teamSeasonAggregateStorageKeys(key, filters.scoreHalf)) {
        storedMetricKeys.add(storageKey);
      }
    }
  }

  const teamFilterSql = filters.team !== "Any" ? " AND t.canonical_name = ?" : "";
  const teamFilterBinds = filters.team !== "Any" ? [filters.team] : [];
  const seasonPoolSql = `
    SELECT
      t.canonical_name AS team,
      tsa.season,
      SUM(tsa.total_value) AS games
    FROM team_season_aggregates tsa
    JOIN teams t ON t.team_id = tsa.team_id
    WHERE tsa.source IN (${sourceSqlList})
      AND tsa.season_phase IN (${phaseSqlList})
      AND tsa.season BETWEEN ? AND ?
      AND tsa.stat_key = 'games'
      ${teamFilterSql}
    GROUP BY t.canonical_name, tsa.season
    ORDER BY t.canonical_name, tsa.season
  `;

  const seasonPoolResult = await db.prepare(seasonPoolSql).bind(
    seasonFrom,
    seasonTo,
    ...teamFilterBinds
  ).all<{ team: string; season: number; games: number }>();

  const seasonRows = new Map<string, QueryRow>();
  for (const row of seasonPoolResult.results ?? []) {
    seasonRows.set(`${row.team}|${row.season}`, {
      team: row.team,
      season: row.season,
      games: Number(row.games ?? 0),
      included_games: Number(row.games ?? 0),
      stat_total: Number(row.games ?? 0),
    });
  }

  if (storedMetricKeys.size > 0) {
    const metricKeySqlList = [...storedMetricKeys].map(quotedSqlString).join(", ");
    const metricRowsSql = `
      SELECT
        t.canonical_name AS team,
        tsa.season,
        tsa.stat_key,
        SUM(tsa.total_value) AS total_value,
        SUM(tsa.recorded_games) AS recorded_games
      FROM team_season_aggregates tsa
      JOIN teams t ON t.team_id = tsa.team_id
      WHERE tsa.source IN (${sourceSqlList})
        AND tsa.season_phase IN (${phaseSqlList})
        AND tsa.season BETWEEN ? AND ?
        AND tsa.stat_key IN (${metricKeySqlList})
        ${teamFilterSql}
      GROUP BY t.canonical_name, tsa.season, tsa.stat_key
      ORDER BY t.canonical_name, tsa.season, tsa.stat_key
    `;
    const metricRowsResult = await db.prepare(metricRowsSql).bind(
      seasonFrom,
      seasonTo,
      ...teamFilterBinds
    ).all<{ team: string; season: number; stat_key: string; total_value: number; recorded_games: number }>();

    for (const row of metricRowsResult.results ?? []) {
      const target = seasonRows.get(`${row.team}|${row.season}`);
      if (!target) continue;
      target[row.stat_key] = Number(row.total_value ?? 0);
      target[`__recorded_${row.stat_key}`] = Number(row.recorded_games ?? 0);
    }
  }

  for (const row of seasonRows.values()) {
    for (const metricKey of requestedMetricKeys) {
      if (["games", "games_played", "games_included"].includes(metricKey)) continue;
      const recipe = getDerivedRecipe("team", metricKey);
      if (recipe) {
        const values = Object.fromEntries(
          recipe.components.map((component) => [component, Number(row[component] ?? 0)])
        );
        row[metricKey] = recipe.compute(values);
        continue;
      }

      const storageKeys = teamSeasonAggregateStorageKeys(metricKey, filters.scoreHalf);
      if (storageKeys.length === 1) {
        row[metricKey] = Number(row[storageKeys[0]] ?? 0);
      } else {
        row[metricKey] = storageKeys.reduce((sum, storageKey) => sum + Number(row[storageKey] ?? 0), 0);
      }
    }

    row.stat_total =
      statKey === "games" || statKey === "games_played"
        ? Number(row.games ?? 0)
        : Number(row[statKey] ?? 0);
    row.included_games =
      statKey === "games" || statKey === "games_played"
        ? Number(row.games ?? 0)
        : Number(row[`__recorded_${statKey}`] ?? row.games ?? 0);
  }

  const streakInput = [...seasonRows.values()].map((row) => ({
    entity: String(row.team ?? ""),
    season: Number(row.season ?? 0),
    round_index: null,
    match_date_utc: null,
    stat_value: filters.conditions.length
      ? (matchesAggregateConditions(row, filters.conditions, statKey, filters.scoreHalf) ? 1 : 0)
      : Number(row.stat_total ?? 0),
    group_label: null,
  }));

  const rows = streakRows(streakInput, "team", limit, allowMultipleStreaks, null, false);
  return {
    ok: true,
    summary: `Top ${limit} team streaks for seasons with ${describeStreakThreshold(statKey, filters.conditions)} from ${seasonFrom} to ${seasonTo}. Used persisted team season aggregates.`,
    columns: ["team", "streak", "first_game", "last_game"],
    rows,
  };
}

function queryFormat(mode: string, format: string, streakGrouping: string): string {
  return mode === "streaks" ? streakGrouping : format;
}

function buildSeasonTypeExpression(alias: string, filters: QueryFilters): string {
  const parts: string[] = [];

  if (filters.includeRegular) {
    parts.push(`${alias}.is_finals = 0`);
  }
  if (filters.includeFinals) {
    parts.push(`(${alias}.is_finals = 1 AND ${alias}.round_label <> '${GRAND_FINAL_LABEL}')`);
  }
  if (filters.includeGrandFinal) {
    parts.push(`(${alias}.is_finals = 1 AND ${alias}.round_label = '${GRAND_FINAL_LABEL}')`);
  }

  if (parts.length === 0) {
    return "0 = 1";
  }
  if (parts.length === 3) {
    return "";
  }

  return `(${parts.join(" OR ")})`;
}

function selectedSeasonPhases(filters: QueryFilters): string[] {
  const phases: string[] = [];
  if (filters.includeRegular) phases.push("regular");
  if (filters.includeFinals) phases.push("finals");
  if (filters.includeGrandFinal) phases.push("grand_final");
  return phases;
}

function teamSeasonAggregateStorageKeys(statKey: string, scoreHalf: string): string[] {
  const normalizedHalf = normalizeScoreHalf(scoreHalf);
  if (normalizedHalf === "first") {
    if (statKey === "points_for") return ["points_for_first_half"];
    if (statKey === "points_against") return ["points_against_first_half"];
    if (statKey === "margin") return ["margin_first_half"];
    if (statKey === "total_points") return ["points_for_first_half", "points_against_first_half"];
  }
  if (normalizedHalf === "second") {
    if (statKey === "points_for") return ["points_for_second_half"];
    if (statKey === "points_against") return ["points_against_second_half"];
    if (statKey === "margin") return ["margin_second_half"];
    if (statKey === "total_points") return ["points_for_second_half", "points_against_second_half"];
  }
  return [statKey];
}

function canUseTeamSeasonAggregatePath(filters: QueryFilters, format: string): boolean {
  if (format !== "season") return false;
  if (filters.opponent !== "Any") return false;
  if (filters.venue !== "Any") return false;
  if (filters.referee !== "Any") return false;
  if (filters.matchPlayer !== "Any") return false;
  if (filters.groundCondition !== "Any") return false;
  if (filters.weatherCondition !== "Any") return false;
  if (filters.homeAway !== "any") return false;
  if (filters.result !== "any") return false;
  if (filters.roundFrom !== null || filters.roundTo !== null) return false;
  return true;
}

function describeStreakThreshold(statKey: string, conditions: QueryCondition[]): string {
  if (!conditions.length) {
    return `${statKey.replace(/_/g, " ")} > 0`;
  }
  return `${statKey.replace(/_/g, " ")} matching the selected conditions`;
}

function matchSortKeySql(utcExpr: string, localTextExpr: string): string {
  return `CASE
    WHEN ${utcExpr} IS NOT NULL AND ${utcExpr} LIKE '____-__-__T%' THEN substr(${utcExpr}, 1, 10)
    WHEN ${utcExpr} IS NOT NULL AND length(${utcExpr}) >= 15 THEN
      substr(${utcExpr}, 12, 4) || '-' ||
      CASE substr(${utcExpr}, 8, 3)
        WHEN 'Jan' THEN '01'
        WHEN 'Feb' THEN '02'
        WHEN 'Mar' THEN '03'
        WHEN 'Apr' THEN '04'
        WHEN 'May' THEN '05'
        WHEN 'Jun' THEN '06'
        WHEN 'Jul' THEN '07'
        WHEN 'Aug' THEN '08'
        WHEN 'Sep' THEN '09'
        WHEN 'Oct' THEN '10'
        WHEN 'Nov' THEN '11'
        WHEN 'Dec' THEN '12'
        ELSE '00'
      END || '-' || substr(${utcExpr}, 5, 2)
    WHEN ${localTextExpr} IS NOT NULL AND length(${localTextExpr}) >= 15 THEN
      substr(${localTextExpr}, 12, 4) || '-' ||
      CASE substr(${localTextExpr}, 8, 3)
        WHEN 'Jan' THEN '01'
        WHEN 'Feb' THEN '02'
        WHEN 'Mar' THEN '03'
        WHEN 'Apr' THEN '04'
        WHEN 'May' THEN '05'
        WHEN 'Jun' THEN '06'
        WHEN 'Jul' THEN '07'
        WHEN 'Aug' THEN '08'
        WHEN 'Sep' THEN '09'
        WHEN 'Oct' THEN '10'
        WHEN 'Nov' THEN '11'
        WHEN 'Dec' THEN '12'
        ELSE '00'
      END || '-' || substr(${localTextExpr}, 5, 2)
    ELSE NULL
  END`;
}

function completedMatchDateSql(matchAlias = "m"): string {
  return matchSortKeySql(`${matchAlias}.match_date_utc`, `${matchAlias}.match_date_local_text`);
}

function completedMatchPredicate(matchAlias = "m"): string {
  const completedDateExpr = completedMatchDateSql(matchAlias);
  return `${matchAlias}.home_score IS NOT NULL AND ${matchAlias}.away_score IS NOT NULL AND NOT (${matchAlias}.home_score = 0 AND ${matchAlias}.away_score = 0 AND ${completedDateExpr} IS NOT NULL AND ${completedDateExpr} >= date('now'))`;
}

function uniqueConditionStatKeys(conditions: QueryCondition[], selectedStatKey: string): string[] {
  const keys = new Set<string>();
  for (const condition of conditions) {
    if (!condition.statKey || condition.statKey === "games_included" || condition.statKey === selectedStatKey) continue;
    keys.add(condition.statKey);
  }
  return [...keys];
}

function buildPlayerConditionAggregateColumns(
  conditionStatKeys: string[],
  mode: string
): { baseSelect: string[]; outerSelect: string[]; binds: unknown[]; baseBindCount: number } {
  const baseSelect: string[] = [];
  const outerSelect: string[] = [];
  const binds: unknown[] = [];
  let baseBindCount = 0;

  conditionStatKeys.forEach((statKey, index) => {
    const valueAlias = `condition_value_${index}`;
    const includedAlias = `condition_included_${index}`;
    const includedExpr = PLAYER_ZERO_IF_MISSING.has(statKey)
      ? "1"
      : `CASE WHEN ${playerStatPresentExpr("s", "?")} THEN 1 ELSE 0 END`;

    baseSelect.push(`COALESCE(${playerStatNumericExpr("s", "?")}, 0) AS ${valueAlias}`);
    baseSelect.push(`${includedExpr} AS ${includedAlias}`);
    binds.push(statKey);
    baseBindCount += 1;
    if (!PLAYER_ZERO_IF_MISSING.has(statKey)) {
      binds.push(statKey);
      baseBindCount += 1;
    }

    outerSelect.push(`ROUND(
          CASE
            WHEN ? = 'averages' THEN 1.0 * SUM(${valueAlias}) / NULLIF(SUM(${includedAlias}), 0)
            ELSE SUM(${valueAlias})
          END,
          3
        ) AS "${statKey}"`);
    binds.push(mode);
  });

  return { baseSelect, outerSelect, binds, baseBindCount };
}

function buildTeamConditionAggregateColumns(
  conditionStatKeys: string[],
  mode: string,
  scoreHalf: string
): { baseSelect: string[]; outerSelect: string[]; binds: unknown[]; baseBindCount: number } {
  const baseSelect: string[] = [];
  const outerSelect: string[] = [];
  const binds: unknown[] = [];
  let baseBindCount = 0;

  conditionStatKeys.forEach((statKey, index) => {
    const valueAlias = `condition_value_${index}`;
    const includedAlias = `condition_included_${index}`;
    const scoreExpr = teamScoreStatExpression(statKey, scoreHalf, "s", "os");
    const includedExpr = scoreExpr
      ? (normalizeScoreHalf(scoreHalf) === "all"
          ? "1"
          : `CASE WHEN (${scoreExpr}) IS NOT NULL THEN 1 ELSE 0 END`)
      : TEAM_ZERO_IF_MISSING.has(statKey)
        ? "1"
        : `CASE WHEN ${teamStatPresentExpr("s", "?")} THEN 1 ELSE 0 END`;

    if (scoreExpr) {
      baseSelect.push(`${scoreExpr} AS ${valueAlias}`);
    } else {
      baseSelect.push(`COALESCE(${teamStatNumericExpr("s", "?")}, 0) AS ${valueAlias}`);
      binds.push(statKey);
      baseBindCount += 1;
    }
    baseSelect.push(`${includedExpr} AS ${includedAlias}`);
    if (!scoreExpr && !TEAM_ZERO_IF_MISSING.has(statKey)) {
      binds.push(statKey);
      baseBindCount += 1;
    }

    outerSelect.push(`ROUND(
          CASE
            WHEN ? = 'averages' THEN 1.0 * SUM(${valueAlias}) / NULLIF(SUM(${includedAlias}), 0)
            ELSE SUM(${valueAlias})
          END,
          3
        ) AS "${statKey}"`);
    binds.push(mode);
  });

  return { baseSelect, outerSelect, binds, baseBindCount };
}

function buildTeamSeasonMetricColumns(
  statKeys: string[],
  scoreHalf: string
): { select: string[]; binds: unknown[]; metrics: Array<{ statKey: string; valueAlias: string; includedAlias: string }> } {
  const select: string[] = [];
  const binds: unknown[] = [];
  const metrics: Array<{ statKey: string; valueAlias: string; includedAlias: string }> = [];
  const scoreDerivedStatKeys = new Set(["wins", "losses", "draws", "points_for", "points_against", "total_points", "margin"]);

  statKeys.forEach((statKey, index) => {
    const valueAlias = `metric_value_${index}`;
    const includedAlias = `metric_included_${index}`;
    let valueExpr = "0";
    let includedExpr = "1";

    if (statKey === "games" || statKey === "games_included") {
      valueExpr = "1";
      includedExpr = "1";
    } else if (scoreDerivedStatKeys.has(statKey)) {
      const scoreExpr = teamScoreStatExpression(statKey, scoreHalf, "s", "os") ?? "0";
      valueExpr = scoreExpr;
      includedExpr = normalizeScoreHalf(scoreHalf) === "all"
        ? "1"
        : `CASE WHEN (${scoreExpr}) IS NOT NULL THEN 1 ELSE 0 END`;
    } else if (TEAM_ZERO_IF_MISSING.has(statKey)) {
      valueExpr = `COALESCE(${teamStatNumericExpr("s", "?")}, 0)`;
      includedExpr = "1";
      binds.push(statKey);
    } else {
      valueExpr = `COALESCE(${teamStatNumericExpr("s", "?")}, 0)`;
      includedExpr = `CASE WHEN ${teamStatPresentExpr("s", "?")} THEN 1 ELSE 0 END`;
      binds.push(statKey, statKey);
    }

    select.push(`${valueExpr} AS ${valueAlias}`);
    select.push(`${includedExpr} AS ${includedAlias}`);
    metrics.push({ statKey, valueAlias, includedAlias });
  });

  return { select, binds, metrics };
}

function groupingColumns(scope: "player" | "team", format: string): {
  select: string[];
  groupBy: string[];
  columns: string[];
  label: string;
  groupLabelSelect?: string;
  groupLabelName?: string;
} {
  const entityColumn = scope === "player" ? "player_name" : "team_name";
  const entityLabel = scope === "player" ? "player" : "team";

  if (format === "season") {
    return {
      select: [`${entityColumn} AS ${entityLabel}`, "season"],
      groupBy: [entityColumn, "season"],
      columns: [entityLabel, "season"],
      label: "season",
      groupLabelSelect: "CAST(season AS TEXT) AS group_label",
      groupLabelName: "season",
    };
  }
  if (format === "ground") {
    return {
      select: [`${entityColumn} AS ${entityLabel}`, "venue_name AS ground"],
      groupBy: [entityColumn, "venue_name"],
      columns: [entityLabel, "ground"],
      label: "ground",
      groupLabelSelect: "venue_name AS group_label",
      groupLabelName: "ground",
    };
  }
  if (scope === "player" && format === "club") {
    return {
      select: [`${entityColumn} AS ${entityLabel}`, "club_name AS club"],
      groupBy: [entityColumn, "club_name"],
      columns: [entityLabel, "club"],
      label: "club",
      groupLabelSelect: "club_name AS group_label",
      groupLabelName: "club",
    };
  }
  if (format === "opposition") {
    return {
      select: [`${entityColumn} AS ${entityLabel}`, "opposition_name AS opposition"],
      groupBy: [entityColumn, "opposition_name"],
      columns: [entityLabel, "opposition"],
      label: "opposition",
      groupLabelSelect: "opposition_name AS group_label",
      groupLabelName: "opposition",
    };
  }
  if (format === "match") {
    return {
      select: [
        `${entityColumn} AS ${entityLabel}`,
        "match_id",
        "season",
        "round_label AS round",
        "opposition_name AS opposition",
        "venue_name AS ground",
        "match_reference",
        "match_sort_key",
      ],
      groupBy: [entityColumn, "match_id", "season", "round_label", "opposition_name", "venue_name", "match_reference", "match_sort_key"],
      columns: [entityLabel, "season", "round", "opposition", "ground", "match_reference", "match_sort_key"],
      label: "match",
    };
  }

  return {
    select: [`${entityColumn} AS ${entityLabel}`],
    groupBy: [entityColumn],
    columns: [entityLabel],
    label: "overall",
  };
}

function groupedSourceValue(row: QueryRow, column: string): unknown {
  if (column === "player" || column === "team") return row.entity;
  if (column === "club") return row.club_name;
  if (column === "ground") return row.venue_name;
  if (column === "opposition") return row.opposition_name;
  if (column === "round") return row.round_label;
  return row[column];
}

function applyAggregateConditions(rows: QueryRow[], conditions: QueryCondition[], selectedStatKey: string): QueryRow[] {
  const activeConditions = conditions.filter((condition) => condition.statKey && condition.operator && condition.value !== "");
  if (activeConditions.length === 0) {
    return rows;
  }

  return rows.filter((row) => {
    return matchesAggregateConditions(row, activeConditions, selectedStatKey);
  });
}

function compareCondition(left: number, operator: string, right: number): boolean {
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "eq") return left === right;
  if (operator === "lt") return left < right;
  if (operator === "lte") return left <= right;
  if (operator === "neq") return left !== right;
  return true;
}

function reduceToTopClubRows(rows: QueryRow[], entityKey: "player" | "team"): QueryRow[] {
  const bestByClub = new Map<string, QueryRow>();

  for (const row of rows) {
    const club = String(row.club ?? "");
    if (!club) continue;
    const current = bestByClub.get(club);
    if (!current) {
      bestByClub.set(club, row);
      continue;
    }

    const rowStat = Number(row.stat_total ?? Number.NEGATIVE_INFINITY);
    const currentStat = Number(current.stat_total ?? Number.NEGATIVE_INFINITY);
    const rowIncluded = Number(row.included_games ?? 0);
    const currentIncluded = Number(current.included_games ?? 0);
    const rowEntity = String(row[entityKey] ?? "");
    const currentEntity = String(current[entityKey] ?? "");

    if (
      rowStat > currentStat ||
      (rowStat === currentStat && rowIncluded > currentIncluded) ||
      (rowStat === currentStat && rowIncluded === currentIncluded && rowEntity.localeCompare(currentEntity) < 0)
    ) {
      bestByClub.set(club, row);
    }
  }

  return [...bestByClub.values()].sort(
    (left, right) =>
      Number(right.stat_total ?? 0) - Number(left.stat_total ?? 0) ||
      Number(right.included_games ?? 0) - Number(left.included_games ?? 0) ||
      String(left.club ?? "").localeCompare(String(right.club ?? "")) ||
      String(left[entityKey] ?? "").localeCompare(String(right[entityKey] ?? ""))
  );
}

function selectedStreakStatKeys(selectedStatKey: string, scoreHalf = "all"): Set<string> {
  const keys = new Set<string>([selectedStatKey]);
  const normalizedHalf = normalizeScoreHalf(scoreHalf);

  if (normalizedHalf === "first") {
    if (selectedStatKey === "points_for") keys.add("points_for_first_half");
    if (selectedStatKey === "points_against") keys.add("points_against_first_half");
    if (selectedStatKey === "margin") keys.add("margin_first_half");
  } else if (normalizedHalf === "second") {
    if (selectedStatKey === "points_for") keys.add("points_for_second_half");
    if (selectedStatKey === "points_against") keys.add("points_against_second_half");
    if (selectedStatKey === "margin") keys.add("margin_second_half");
  }

  return keys;
}

function matchesAggregateConditions(row: QueryRow, conditions: QueryCondition[], selectedStatKey: string, scoreHalf = "all"): boolean {
  const eligibleStatKeys = selectedStreakStatKeys(selectedStatKey, scoreHalf);
  let result: boolean | null = null;
  for (const condition of conditions) {
    const targetValue =
      condition.statKey === "games_included"
        ? Number(row.included_games ?? 0)
        : condition.statKey === "games_played" || condition.statKey === "games"
          ? Number(row.games ?? 0)
        : eligibleStatKeys.has(condition.statKey)
          ? Number(row.stat_total ?? 0)
          : row[condition.statKey] !== undefined
            ? Number(row[condition.statKey] ?? 0)
            : null;
    if (targetValue === null || Number.isNaN(targetValue)) continue;
    const comparison = compareCondition(targetValue, condition.operator, Number(condition.value));
    if (result === null) {
      result = comparison;
    } else if (condition.joiner === "OR") {
      result = result || comparison;
    } else if (condition.joiner === "AND NOT") {
      result = result && !comparison;
    } else {
      result = result && comparison;
    }
  }
  return result ?? true;
}

function buildStreakHitConditionSql(
  conditions: QueryCondition[],
  selectedStatKey: string,
  scoreHalf = "all",
  statAlias = "stat_total",
  includedGamesAlias = "included_games"
): { sql: string; binds: unknown[] } | null {
  const activeConditions = conditions.filter((condition) => condition.statKey && condition.operator && condition.value !== "");
  const eligibleStatKeys = selectedStreakStatKeys(selectedStatKey, scoreHalf);
  const parts: string[] = [];
  const binds: unknown[] = [];

  for (let index = 0; index < activeConditions.length; index += 1) {
    const condition = activeConditions[index];
    const targetExpr =
      condition.statKey === "games_included"
        ? includedGamesAlias
        : eligibleStatKeys.has(condition.statKey)
          ? statAlias
          : null;
    if (!targetExpr) continue;

    const operator =
      condition.operator === "gt" ? ">" :
      condition.operator === "gte" ? ">=" :
      condition.operator === "eq" ? "=" :
      condition.operator === "lt" ? "<" :
      condition.operator === "lte" ? "<=" :
      condition.operator === "neq" ? "<>" :
      null;
    if (!operator) continue;

    const clause = `${targetExpr} ${operator} ?`;
    if (parts.length === 0) {
      parts.push(clause);
    } else if (condition.joiner === "OR") {
      parts.push(`OR ${clause}`);
    } else if (condition.joiner === "AND NOT") {
      parts.push(`AND NOT (${clause})`);
    } else {
      parts.push(`AND ${clause}`);
    }
    binds.push(Number(condition.value));
  }

  if (!parts.length) {
    return null;
  }

  return {
    sql: parts.join(" "),
    binds,
  };
}

function buildPlayerFilters(filters: QueryFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  clauses.push(completedMatchPredicate("m"));

  if (filters.competition !== "Any") {
    const competitionFilter = competitionFilterSql("c.name", filters.competition);
    if (competitionFilter.sql) {
      clauses.push(competitionFilter.sql);
      binds.push(...competitionFilter.binds);
    }
  }
  if (filters.team !== "Any") {
    clauses.push("tt.canonical_name = ?");
    binds.push(filters.team);
  }
  if (filters.player !== "Any") {
    clauses.push("COALESCE(p.display_name, s.player_name_raw) = ?");
    binds.push(filters.player);
  }
  if (filters.opponent !== "Any") {
    clauses.push("ot.canonical_name = ?");
    binds.push(filters.opponent);
  }
  if (filters.venue !== "Any") {
    clauses.push("v.canonical_name = ?");
    binds.push(filters.venue);
  }
  if (filters.referee !== "Any") {
    clauses.push(`COALESCE(${playerStatTextExpr("s", "'referee'")}, 'Unknown') = ?`);
    binds.push(filters.referee);
  }
  if (filters.groundCondition !== "Any") {
    clauses.push(`COALESCE(${playerStatTextExpr("s", "'ground_condition'")}, 'Unknown') = ?`);
    binds.push(filters.groundCondition);
  }
  if (filters.weatherCondition !== "Any") {
    clauses.push(`COALESCE(${playerStatTextExpr("s", "'weather_condition'")}, 'Unknown') = ?`);
    binds.push(filters.weatherCondition);
  }
  if (filters.position !== "Any") {
    clauses.push("s.position_label = ?");
    binds.push(filters.position);
  }
  if (filters.matchPlayer && filters.matchPlayer !== "Any") {
    clauses.push(`EXISTS (
      SELECT 1
      FROM player_match_summary mp
      LEFT JOIN players pp ON pp.player_id = mp.player_id
      WHERE mp.match_id = s.match_id
        AND COALESCE(pp.display_name, mp.player_name_raw) = ?
    )`);
    binds.push(filters.matchPlayer);
  }
  if (filters.debut && filters.debut !== "any") {
    clauses.push("s.season >= 1998");
    if (filters.debut === "career_debut") {
      clauses.push(`s.match_id = CAST(${playerStatNumericExpr("s", "'career_first_match_id'")} AS INTEGER)`);
    } else if (filters.debut === "last_career_match") {
      clauses.push(`s.match_id = CAST(${playerStatNumericExpr("s", "'career_last_match_id'")} AS INTEGER)`);
    } else if (filters.debut === "team_debut") {
      clauses.push(`s.match_id = CAST(${playerStatNumericExpr("s", "'team_first_match_id'")} AS INTEGER)`);
    } else if (filters.debut === "last_team_match") {
      clauses.push(`s.match_id = CAST(${playerStatNumericExpr("s", "'team_last_match_id'")} AS INTEGER)`);
    }
  }
  if (filters.playerType === "forwards") {
    clauses.push("s.position_label IN ('Prop', 'Hooker', 'Second Row', 'Lock', 'Interchange')");
  } else if (filters.playerType === "backs") {
    clauses.push("s.position_label IN ('Fullback', 'Wing', 'Centre', 'Five-Eighth', 'Halfback')");
  }
  if (filters.homeAway === "home") {
    clauses.push("s.is_home = 1");
  } else if (filters.homeAway === "away") {
    clauses.push("s.is_home = 0");
  }
  if (filters.result === "win") {
    clauses.push("((s.team_id = m.home_team_id AND m.home_score > m.away_score) OR (s.team_id = m.away_team_id AND m.away_score > m.home_score))");
  } else if (filters.result === "loss") {
    clauses.push("((s.team_id = m.home_team_id AND m.home_score < m.away_score) OR (s.team_id = m.away_team_id AND m.away_score < m.home_score))");
  } else if (filters.result === "tie") {
    clauses.push("m.home_score = m.away_score");
  }
  if (filters.roundFrom !== null) {
    clauses.push("s.round_index >= ?");
    binds.push(filters.roundFrom);
  }
  if (filters.roundTo !== null) {
    clauses.push("s.round_index <= ?");
    binds.push(filters.roundTo);
  }
  const seasonTypeExpr = buildSeasonTypeExpression("m", filters);
  if (seasonTypeExpr) {
    clauses.push(seasonTypeExpr);
  }

  return {
    sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
    binds,
  };
}

function buildPlayerRowConditionExpression(
  conditions: QueryCondition[],
  tableAlias = "s"
): { sql: string; binds: unknown[] } | null {
  const active = conditions.filter((condition) => condition.statKey && condition.operator && condition.value !== "");
  if (!active.length) return null;

  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const condition of active) {
    const operator =
      condition.operator === "gt" ? ">" :
      condition.operator === "gte" ? ">=" :
      condition.operator === "eq" ? "=" :
      condition.operator === "lt" ? "<" :
      condition.operator === "lte" ? "<=" :
      condition.operator === "neq" ? "<>" :
      null;
    if (!operator) continue;

    const statKey = condition.statKey;
    let targetExpr: string;
    if (statKey === "games" || statKey === "games_played" || statKey === "games_included") {
      targetExpr = "1";
    } else {
      targetExpr = `COALESCE(${playerStatNumericExpr(tableAlias, "?")}, 0)`;
      binds.push(statKey);
    }

    const clause = `${targetExpr} ${operator} ?`;
    binds.push(Number(condition.value));
    if (!parts.length) {
      parts.push(clause);
    } else if (condition.joiner === "OR") {
      parts.push(`OR ${clause}`);
    } else if (condition.joiner === "AND NOT") {
      parts.push(`AND NOT (${clause})`);
    } else {
      parts.push(`AND ${clause}`);
    }
  }

  if (!parts.length) return null;
  return { sql: parts.join(" "), binds };
}

function buildTeamFilters(filters: QueryFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  clauses.push(completedMatchPredicate("m"));

  if (filters.competition !== "Any") {
    const competitionFilter = competitionFilterSql("c.name", filters.competition);
    if (competitionFilter.sql) {
      clauses.push(competitionFilter.sql);
      binds.push(...competitionFilter.binds);
    }
  }
  if (filters.team !== "Any") {
    clauses.push("t.canonical_name = ?");
    binds.push(filters.team);
  }
  if (filters.opponent !== "Any") {
    clauses.push("ot.canonical_name = ?");
    binds.push(filters.opponent);
  }
  if (filters.venue !== "Any") {
    clauses.push("v.canonical_name = ?");
    binds.push(filters.venue);
  }
  if (filters.referee !== "Any") {
    clauses.push(`COALESCE(${teamStatTextExpr("s", "'referee'")}, 'Unknown') = ?`);
    binds.push(filters.referee);
  }
  if (filters.groundCondition !== "Any") {
    clauses.push(`COALESCE(${teamStatTextExpr("s", "'ground_condition'")}, 'Unknown') = ?`);
    binds.push(filters.groundCondition);
  }
  if (filters.weatherCondition !== "Any") {
    clauses.push(`COALESCE(${teamStatTextExpr("s", "'weather_condition'")}, 'Unknown') = ?`);
    binds.push(filters.weatherCondition);
  }
  if (filters.matchPlayer && filters.matchPlayer !== "Any") {
    clauses.push(`EXISTS (
      SELECT 1
      FROM player_match_summary mp
      LEFT JOIN players pp ON pp.player_id = mp.player_id
      WHERE mp.match_id = s.match_id
        AND COALESCE(pp.display_name, mp.player_name_raw) = ?
    )`);
    binds.push(filters.matchPlayer);
  }
  if (filters.homeAway === "home") {
    clauses.push("s.is_home = 1");
  } else if (filters.homeAway === "away") {
    clauses.push("s.is_home = 0");
  }
  if (filters.result === "win") {
    clauses.push("s.result_code = 'W'");
  } else if (filters.result === "loss") {
    clauses.push("s.result_code = 'L'");
  } else if (filters.result === "tie") {
    clauses.push("s.result_code = 'T'");
  }
  if (filters.roundFrom !== null) {
    clauses.push("s.round_index >= ?");
    binds.push(filters.roundFrom);
  }
  if (filters.roundTo !== null) {
    clauses.push("s.round_index <= ?");
    binds.push(filters.roundTo);
  }
  const seasonTypeExpr = buildSeasonTypeExpression("m", filters);
  if (seasonTypeExpr) {
    clauses.push(seasonTypeExpr);
  }

  return {
    sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
    binds,
  };
}

function buildTeamSeasonPresenceFilters(filters: QueryFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  clauses.push(completedMatchPredicate("m"));

  if (filters.competition !== "Any") {
    const competitionFilter = competitionFilterSql("c.name", filters.competition);
    if (competitionFilter.sql) {
      clauses.push(competitionFilter.sql);
      binds.push(...competitionFilter.binds);
    }
  }
  if (filters.team !== "Any") {
    clauses.push("t.canonical_name = ?");
    binds.push(filters.team);
  }

  return {
    sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
    binds,
  };
}

async function runDerivedAggregateQuery(
  db: D1Database,
  scope: "player" | "team",
  statKey: string,
  limit: number,
  mode: string,
  format: string,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters
): Promise<{ ok: boolean; summary: string; columns: string[]; rows: QueryRow[] }> {
  const recipe = getDerivedRecipe(scope, statKey);
  const definition = getStatDefinition(scope, statKey);
  if (!recipe || !definition) {
    return { ok: false, summary: "", columns: [], rows: [] };
  }

  const grouping = groupingColumns(scope, format);
  const filterBundle = scope === "player" ? buildPlayerFilters(filters) : buildTeamFilters(filters);
  const entitySelect = scope === "player"
    ? "COALESCE(p.display_name, s.player_name_raw) AS entity"
    : "t.canonical_name AS entity";
  const componentSelect = recipe.components
    .map((component) => scope === "player"
      ? `COALESCE(${playerStatNumericExpr("s", "?")}, 0) AS comp_${component}`
      : `COALESCE(${teamStatNumericExpr("s", "?")}, 0) AS comp_${component}`)
    .join(",\n          ");
  const sql = `
    SELECT
      ${entitySelect},
      s.season,
      s.match_id,
      m.round_label,
      ${scope === "player" ? "tt.canonical_name AS club_name," : ""}
      COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
      COALESCE(v.canonical_name, 'Unknown') AS venue_name,
      COALESCE(m.match_date_local_text, s.match_date_utc, m.match_date_utc) AS match_reference,
      ${matchSortKeySql("COALESCE(s.match_date_utc, m.match_date_utc)", "m.match_date_local_text")} AS match_sort_key,
      ${componentSelect}
    FROM ${scope === "player" ? "player_match_summary" : "team_match_summary"} s
    ${scope === "player" ? "LEFT JOIN players p ON p.player_id = s.player_id" : "JOIN teams t ON t.team_id = s.team_id"}
    JOIN matches m ON m.match_id = s.match_id
    JOIN competitions c ON c.competition_id = m.competition_id
    ${scope === "player" ? "JOIN teams tt ON tt.team_id = s.team_id" : ""}
    LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
    LEFT JOIN venues v ON v.venue_id = m.venue_id
    ${scope === "team" ? "LEFT JOIN team_match_summary os ON os.match_id = s.match_id AND os.team_id = s.opponent_team_id" : ""}
    WHERE s.season BETWEEN ? AND ?
    ${filterBundle.sql}
  `;

  const binds: unknown[] = [
    ...recipe.components.map((component) => component),
    seasonFrom,
    seasonTo,
    ...filterBundle.binds,
  ];

  const result = await db.prepare(sql).bind(...binds).all<QueryRow>();
  const grouped = new Map<string, QueryRow & { __components: Record<string, number> }>();

  for (const row of result.results ?? []) {
    const groupParts = grouping.columns.map((column) => String(groupedSourceValue(row, column) ?? ""));
    const key = groupParts.join("|");
    const rowComponents = Object.fromEntries(
      recipe.components.map((component) => [component, Number(row[`comp_${component}`] ?? 0)])
    );
    const rowIncluded = computeDerivedStat(scope, statKey, rowComponents) !== null ? 1 : 0;
    const existing = grouped.get(key) ?? {
      [scope === "player" ? "player" : "team"]: row.entity,
      season: row.season,
      round: row.round_label,
      opposition: row.opposition_name,
      ground: row.venue_name,
      match_reference: row.match_reference,
      match_sort_key: row.match_sort_key,
      first_season: row.season,
      last_season: row.season,
      games: 0,
      included_games: 0,
      __components: Object.fromEntries(recipe.components.map((component) => [component, 0])),
    };

    for (const column of grouping.columns) {
      if (column === "player" || column === "team") continue;
      existing[column] = groupedSourceValue(row, column);
    }
    existing.first_season = Math.min(Number(existing.first_season ?? row.season), Number(row.season ?? 0));
    existing.last_season = Math.max(Number(existing.last_season ?? row.season), Number(row.season ?? 0));
    existing.games = Number(existing.games ?? 0) + 1;
    existing.included_games = Number(existing.included_games ?? 0) + rowIncluded;
    for (const component of recipe.components) {
      existing.__components[component] += rowComponents[component];
    }
    grouped.set(key, existing);
  }

  const rows = [...grouped.values()].map((row) => {
    const statTotal = computeDerivedStat(scope, statKey, row.__components);
    const output: QueryRow = {};
    for (const column of grouping.columns) {
      output[column] = row[column];
    }
    output.stat_total = statTotal === null ? null : Number(statTotal.toFixed(3));
    output.games = row.games;
    output.included_games = row.included_games;
    output.first_season = row.first_season;
    output.last_season = row.last_season;
    return output;
  });

  const filtered = applyAggregateConditions(rows, filters.conditions, statKey)
    .filter((row) => row.stat_total !== null)
    .sort((left, right) => Number(right.stat_total ?? 0) - Number(left.stat_total ?? 0) || Number(right.included_games ?? 0) - Number(left.included_games ?? 0));
  const finalRows = format === "club" && scope === "player"
    ? reduceToTopClubRows(filtered, "player")
    : filtered;

  return {
    ok: true,
    summary: `Top ${limit} ${scope === "player" ? "players" : "teams"} by ${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}. Weighted derived stat.`,
    columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
    rows: finalRows.slice(0, limit),
  };
}

async function runExportCountQuery(
  db: D1Database,
  dataset: string,
  seasonFrom: number,
  seasonTo: number,
  competition: string
): Promise<number> {
  const binds: unknown[] = [seasonFrom, seasonTo];
  const competitionFilter = competitionFilterSql("c.name", competition);
  const competitionClause = competitionFilter.sql ? `AND ${competitionFilter.sql}` : "";
  binds.push(...competitionFilter.binds);

  const sql = dataset === "matches"
    ? `
      SELECT COUNT(*) AS count
      FROM matches m
      JOIN competitions c ON c.competition_id = m.competition_id
      WHERE m.season BETWEEN ? AND ?
      ${competitionClause}
    `
    : dataset === "team_match_summary"
      ? `
        SELECT COUNT(*) AS count
        FROM team_match_summary s
        JOIN matches m ON m.match_id = s.match_id
        JOIN competitions c ON c.competition_id = m.competition_id
        WHERE s.season BETWEEN ? AND ?
        ${competitionClause}
      `
      : `
        SELECT COUNT(*) AS count
        FROM player_match_summary s
        JOIN matches m ON m.match_id = s.match_id
        JOIN competitions c ON c.competition_id = m.competition_id
        WHERE s.season BETWEEN ? AND ?
        ${competitionClause}
      `;

  const result = await db.prepare(sql).bind(...binds).first<{ count: number }>();
  return Number(result?.count ?? 0);
}

async function runExportQuery(
  db: D1Database,
  dataset: string,
  seasonFrom: number,
  seasonTo: number,
  competition: string
): Promise<{ columns: string[]; rows: QueryRow[]; filename: string }> {
  const binds: unknown[] = [seasonFrom, seasonTo];
  const competitionFilter = competitionFilterSql("c.name", competition);
  const competitionClause = competitionFilter.sql ? `AND ${competitionFilter.sql}` : "";
  binds.push(...competitionFilter.binds);

  if (dataset === "matches") {
    const columns = [
      "match_id",
      "competition",
      "season",
      "round",
      "round_index",
      "match_date_utc",
      "match_date_local_text",
      "is_finals",
      "home_team",
      "away_team",
      "home_score",
      "away_score",
      "winner_team",
      "margin",
      "venue",
    ];
    const sql = `
      SELECT
        m.match_id,
        c.name AS competition,
        m.season,
        m.round_label AS round,
        m.round_index,
        m.match_date_utc,
        m.match_date_local_text,
        m.is_finals,
        th.canonical_name AS home_team,
        ta.canonical_name AS away_team,
        m.home_score,
        m.away_score,
        tw.canonical_name AS winner_team,
        m.margin,
        COALESCE(v.canonical_name, 'Unknown') AS venue
      FROM matches m
      JOIN competitions c ON c.competition_id = m.competition_id
      JOIN teams th ON th.team_id = m.home_team_id
      JOIN teams ta ON ta.team_id = m.away_team_id
      LEFT JOIN teams tw ON tw.team_id = m.winner_team_id
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      WHERE m.season BETWEEN ? AND ?
      ${competitionClause}
      ORDER BY m.season, m.round_index, COALESCE(m.match_date_utc, m.match_date_local_text), m.match_id
    `;
    const result = await db.prepare(sql).bind(...binds).all<QueryRow>();
    return {
      columns,
      rows: result.results ?? [],
      filename: `rugby-league-matches-${seasonFrom}-${seasonTo}.csv`,
    };
  }

  if (dataset === "team_match_summary") {
    const columns = [
      "team_match_summary_id",
      "match_id",
      "competition",
      "season",
      "round",
      "round_index",
      "match_reference",
      "team",
      "opposition",
      "venue",
      "is_home",
      "is_finals",
      "team_score",
      "opponent_score",
      "result_code",
      "stats_json",
    ];
    const sql = `
      SELECT
        s.team_match_summary_id,
        s.match_id,
        c.name AS competition,
        s.season,
        m.round_label AS round,
        s.round_index,
        COALESCE(m.match_date_local_text, s.match_date_utc, m.match_date_utc) AS match_reference,
        t.canonical_name AS team,
        COALESCE(ot.canonical_name, 'Unknown') AS opposition,
        COALESCE(v.canonical_name, 'Unknown') AS venue,
        s.is_home,
        s.is_finals,
        s.team_score,
        s.opponent_score,
        s.result_code,
        s.stats_json
      FROM team_match_summary s
      JOIN matches m ON m.match_id = s.match_id
      JOIN competitions c ON c.competition_id = m.competition_id
      JOIN teams t ON t.team_id = s.team_id
      LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      WHERE s.season BETWEEN ? AND ?
      ${competitionClause}
      ORDER BY s.season, s.round_index, COALESCE(s.match_date_utc, m.match_date_utc, m.match_date_local_text), s.match_id, s.is_home DESC
    `;
    const result = await db.prepare(sql).bind(...binds).all<QueryRow>();
    return {
      columns,
      rows: result.results ?? [],
      filename: `rugby-league-team-match-summary-${seasonFrom}-${seasonTo}.csv`,
    };
  }

  const columns = [
    "player_match_summary_id",
    "match_id",
    "competition",
    "season",
    "round",
    "round_index",
    "match_reference",
    "player_id",
    "player",
    "team",
    "opposition",
    "venue",
    "is_home",
    "is_finals",
    "jumper_number",
    "position_label",
    "stats_json",
  ];
  const sql = `
    SELECT
      s.player_match_summary_id,
      s.match_id,
      c.name AS competition,
      s.season,
      m.round_label AS round,
      s.round_index,
      COALESCE(m.match_date_local_text, s.match_date_utc, m.match_date_utc) AS match_reference,
      s.player_id,
      COALESCE(p.display_name, s.player_name_raw) AS player,
      tt.canonical_name AS team,
      COALESCE(ot.canonical_name, 'Unknown') AS opposition,
      COALESCE(v.canonical_name, 'Unknown') AS venue,
      s.is_home,
      s.is_finals,
      s.jumper_number,
      s.position_label,
      s.stats_json
    FROM player_match_summary s
    JOIN matches m ON m.match_id = s.match_id
    JOIN competitions c ON c.competition_id = m.competition_id
    LEFT JOIN players p ON p.player_id = s.player_id
    JOIN teams tt ON tt.team_id = s.team_id
    LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
    LEFT JOIN venues v ON v.venue_id = m.venue_id
    WHERE s.season BETWEEN ? AND ?
    ${competitionClause}
    ORDER BY s.season, s.round_index, COALESCE(s.match_date_utc, m.match_date_utc, m.match_date_local_text), player, s.match_id
  `;
  const result = await db.prepare(sql).bind(...binds).all<QueryRow>();
  return {
    columns,
    rows: result.results ?? [],
    filename: `rugby-league-player-match-summary-${seasonFrom}-${seasonTo}.csv`,
  };
}

async function runLeaderboardQuery(
  db: D1Database,
  scope: string,
  statKey: string,
  limit: number,
  mode: string,
  format: string,
  allowMultipleStreaks: boolean,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters,
  singleEntityResults = true,
): Promise<{
  ok: boolean;
  summary: string;
  columns: string[];
  rows: QueryRow[];
  error?: string;
}> {
  if (scope === "player" && mode === "streaks") {
    const conditionStatKeys = uniqueConditionStatKeys(filters.conditions, statKey);
    const playerFilters = buildPlayerFilters({ ...filters, conditions: [] });
    const grouping = groupingColumns("player", format);
    const historicalStreakClause =
      format !== "season" && filters.excludeSparseHistoricalStreaks ? " AND s.season >= 1998" : "";
    const playerStreakGroupExpr =
      format === "ground"
        ? "COALESCE(v.canonical_name, 'Unknown') AS group_label"
        : format === "opposition"
          ? "COALESCE(ot.canonical_name, 'Unknown') AS group_label"
          : "NULL AS group_label";
    const seasonConditionBaseSelects: string[] = [];
    const seasonConditionOuterSelects: string[] = [];
    const seasonConditionBinds: unknown[] = [];
    const matchConditionSelects: string[] = [];
    const matchConditionBinds: unknown[] = [];
    conditionStatKeys.forEach((conditionStatKey, index) => {
      const baseAlias = quotedIdentifier(`condition_value_${index}`);
      seasonConditionBaseSelects.push(`COALESCE(${playerStatNumericExpr("s", "?")}, 0) AS ${baseAlias}`);
      seasonConditionOuterSelects.push(`ROUND(SUM(${baseAlias}), 3) AS ${quotedIdentifier(conditionStatKey)}`);
      seasonConditionBinds.push(conditionStatKey);
      matchConditionSelects.push(`COALESCE(${playerStatNumericExpr("s", "?")}, 0) AS ${quotedIdentifier(conditionStatKey)}`);
      matchConditionBinds.push(conditionStatKey);
    });
    const minutesRawAlias = quotedIdentifier("minutes_played_raw_source");
    const minutesPresentAlias = quotedIdentifier("minutes_played_present_source");
    const seasonMinuteBaseSelects = [
      `${playerStatNumericExpr("s", "'minutes_played'")} AS ${minutesRawAlias}`,
      `CASE WHEN ${playerStatPresentExpr("s", "'minutes_played'")} THEN 1 ELSE 0 END AS ${minutesPresentAlias}`,
    ];
    const seasonMinuteOuterSelects = [
      `ROUND(SUM(COALESCE(${minutesRawAlias}, 0)), 3) AS "minutes_played_raw"`,
      `SUM(${minutesPresentAlias}) AS "minutes_played_present"`,
    ];
    const seasonMinuteBinds: unknown[] = [];
    const matchMinuteSelects = [
      `${playerStatNumericExpr("s", "'minutes_played'")} AS "minutes_played_raw"`,
      `CASE WHEN ${playerStatPresentExpr("s", "'minutes_played'")} THEN 1 ELSE 0 END AS "minutes_played_present"`,
    ];
    const matchMinuteBinds: unknown[] = [];
    const sql = format === "season" ? `
      WITH base AS (
        SELECT
          COALESCE(p.display_name, s.player_name_raw) AS entity,
          s.season,
          s.round_index,
          s.match_date_utc,
          COALESCE(${playerStatNumericExpr("s", "?")}, 0) AS stat_total,
          1 AS included_games${seasonConditionBaseSelects.length || seasonMinuteBaseSelects.length ? `,\n          ${[...seasonConditionBaseSelects, ...seasonMinuteBaseSelects].join(",\n          ")}` : ""}
        FROM player_match_summary s
        LEFT JOIN players p ON p.player_id = s.player_id
        JOIN matches m ON m.match_id = s.match_id
        JOIN competitions c ON c.competition_id = m.competition_id
        JOIN teams tt ON tt.team_id = s.team_id
        LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
        LEFT JOIN venues v ON v.venue_id = m.venue_id
        WHERE s.season BETWEEN ? AND ?
        ${playerFilters.sql}
        ${historicalStreakClause}
      )
      SELECT
        entity,
        season,
        NULL AS round_index,
        MAX(match_date_utc) AS match_date_utc,
        NULL AS group_label,
        SUM(stat_total) AS stat_total,
        SUM(included_games) AS included_games${seasonConditionOuterSelects.length || seasonMinuteOuterSelects.length ? `,\n        ${[...seasonConditionOuterSelects, ...seasonMinuteOuterSelects].join(",\n        ")}` : ""}
      FROM base
      GROUP BY entity, season
      ORDER BY entity, season
    ` : `
      SELECT
        COALESCE(p.display_name, s.player_name_raw) AS entity,
        s.season,
        s.round_index,
        s.match_date_utc,
        COALESCE(v.canonical_name, 'Unknown') AS venue_name,
        COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
        m.round_label,
        COALESCE(m.match_date_local_text, s.match_date_utc, m.match_date_utc) AS match_reference,
        ${matchSortKeySql("COALESCE(s.match_date_utc, m.match_date_utc)", "m.match_date_local_text")} AS match_sort_key,
        ${playerStreakGroupExpr},
        COALESCE(${playerStatNumericExpr("s", "?")}, 0) AS stat_total,
        1 AS included_games${matchConditionSelects.length || matchMinuteSelects.length ? `,\n        ${[...matchConditionSelects, ...matchMinuteSelects].join(",\n        ")}` : ""}
      FROM player_match_summary s
      LEFT JOIN players p ON p.player_id = s.player_id
      JOIN matches m ON m.match_id = s.match_id
      JOIN competitions c ON c.competition_id = m.competition_id
      JOIN teams tt ON tt.team_id = s.team_id
      LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      WHERE s.season BETWEEN ? AND ?
      ${playerFilters.sql}
      ${historicalStreakClause}
      ORDER BY COALESCE(p.display_name, s.player_name_raw), s.season, match_sort_key, s.match_id
    `;

    const streakBinds = format === "season"
      ? [statKey, ...seasonConditionBinds, ...seasonMinuteBinds, seasonFrom, seasonTo, ...playerFilters.binds]
      : [statKey, ...matchConditionBinds, ...matchMinuteBinds, seasonFrom, seasonTo, ...playerFilters.binds];
    const result = await db.prepare(sql).bind(...streakBinds).all<{
      entity: string;
      season: number;
      round_index: number | null;
      match_date_utc: string | null;
      group_label: string | null;
      stat_total: number | null;
      included_games: number | null;
      minutes_played_raw?: number | null;
      minutes_played_present?: number | null;
      [key: string]: unknown;
    }>();

    const streakInput = (result.results ?? [])
      .filter((row) => {
        if (!filters.excludeZeroMinuteStreakGames) return true;
        const minuteDataPresent = Number(row.minutes_played_present ?? 0);
        if (!Number.isFinite(minuteDataPresent) || minuteDataPresent <= 0) return true;
        return Number(row.minutes_played_raw ?? 0) !== 0;
      })
      .map((row) => {
        const probe: QueryRow = {
          stat_total: row.stat_total,
          included_games: row.included_games,
          games: row.included_games ?? 1,
        };
        for (const conditionStatKey of conditionStatKeys) {
          probe[conditionStatKey] = row[conditionStatKey];
        }
        if (row.minutes_played_raw !== undefined) {
          probe.minutes_played = row.minutes_played_raw;
        }
        return {
          entity: row.entity,
          season: row.season,
          round_index: row.round_index,
          match_date_utc: row.match_date_utc,
          stat_value: filters.conditions.length
            ? (matchesAggregateConditions(probe, filters.conditions, statKey) ? 1 : 0)
            : Number(row.stat_total ?? 0),
          group_label: row.group_label ?? null,
        };
      });

    const rows = streakRows(
      streakInput,
      "player",
      limit,
      allowMultipleStreaks,
      ["ground", "opposition"].includes(format) ? grouping.groupLabelName ?? null : null,
      ["ground", "opposition"].includes(format)
    );
    const minuteSkipSuffix = filters.excludeZeroMinuteStreakGames
      ? "; 0-minute player rows skipped when minutes data exists"
      : "";
    return {
      ok: true,
      summary: `Top ${limit} player streaks for games in a row with ${describeStreakThreshold(statKey, filters.conditions)} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}${format !== "season" && filters.excludeSparseHistoricalStreaks ? "; pre-1998 sparse match streaks excluded" : ""}${minuteSkipSuffix}.`,
      columns: ["player", ...(["ground", "opposition"].includes(format) && grouping.groupLabelName ? [grouping.groupLabelName] : []), "streak", "first_game", "last_game"],
      rows,
    };
  }

  if (scope === "player") {
    const conditionalAggregateFastPath = mode !== "streaks"
      ? await runPlayerConditionalAggregateFastPath(
          db,
          statKey,
          limit,
          mode,
          format,
          seasonFrom,
          seasonTo,
          filters,
        )
      : null;
    if (conditionalAggregateFastPath) {
      return conditionalAggregateFastPath;
    }

    if (mode === "totals" && statKey === "games_played" && filters.conditions.length > 0) {
      const grouping = groupingColumns("player", format);
      const playerFilters = buildPlayerFilters({ ...filters, conditions: [] });
      const minuteScopedConditions = filters.conditions.filter((condition) => condition.statKey === "minutes_played");
      const aggregateConditions = filters.conditions.filter((condition) => condition.statKey !== "minutes_played");
      const conditionStatKeys = uniqueConditionStatKeys(aggregateConditions, statKey);
      const conditionColumns = buildPlayerConditionAggregateColumns(conditionStatKeys, "totals");
      const rowCondition = buildPlayerRowConditionExpression(minuteScopedConditions, "s");
      const includedExpr = rowCondition ? `CASE WHEN (${rowCondition.sql}) THEN 1 ELSE 0 END` : "1";
      const preFilterLimit = Math.min(50000, Math.max(limit * 50, 5000));
      const sql = `
        WITH base AS (
          SELECT
            COALESCE(p.display_name, s.player_name_raw) AS player_name,
            tt.canonical_name AS club_name,
            s.season,
            s.match_id,
            m.round_label,
            COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
            COALESCE(v.canonical_name, 'Unknown') AS venue_name,
            COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
            ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
            ${includedExpr} AS included_flag${conditionColumns.baseSelect.length ? `,\n            ${conditionColumns.baseSelect.join(",\n            ")}` : ""}
          FROM player_match_summary s
          LEFT JOIN players p ON p.player_id = s.player_id
          JOIN matches m ON m.match_id = s.match_id
          JOIN competitions c ON c.competition_id = m.competition_id
          LEFT JOIN teams tt ON tt.team_id = s.team_id
          LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
          LEFT JOIN venues v ON v.venue_id = m.venue_id
          WHERE s.season BETWEEN ? AND ?
          ${playerFilters.sql}
        )
        SELECT
          ${grouping.select.join(", ")},
          MIN(season) AS first_season,
          MAX(season) AS last_season,
          COUNT(*) AS games,
          SUM(included_flag) AS included_games,
          ROUND(SUM(included_flag), 3) AS stat_total${conditionColumns.outerSelect.length ? `,\n          ${conditionColumns.outerSelect.join(",\n          ")}` : ""}
        FROM base
        GROUP BY ${grouping.groupBy.join(", ")}
        ORDER BY stat_total DESC, games DESC, ${grouping.columns[0]} ASC
        LIMIT ?
      `;
      const binds: unknown[] = [
        ...(rowCondition?.binds ?? []),
        ...conditionColumns.binds.slice(0, conditionColumns.baseBindCount),
        seasonFrom,
        seasonTo,
        ...playerFilters.binds,
        ...conditionColumns.binds.slice(conditionColumns.baseBindCount),
        preFilterLimit,
      ];
      const result = await db.prepare(sql).bind(...binds).all<QueryRow>();
      const filteredRows = aggregateConditions.length
        ? applyAggregateConditions(result.results ?? [], aggregateConditions, statKey)
        : (result.results ?? []);
      return {
        ok: true,
        summary: `Top ${limit} players by games played from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}. Fast SQL path with minutes-based game inclusion.`,
        columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
        rows: filteredRows.slice(0, limit),
      };
    }

    const aggregateFastPath = await runPlayerAggregateFastPath(
      db,
      statKey,
      limit,
      mode,
      format,
      seasonFrom,
      seasonTo,
      filters
    );
    if (aggregateFastPath) {
      return aggregateFastPath;
    }

    const unifiedPlayerAggregatePayload = mode !== "streaks"
      ? await (() => {
          const allDefinitions = buildBootstrap().statDefinitions
            .filter((definition) => definition.scope === "player")
            .filter((definition) => definition.statKey !== "games_included")
            .filter((definition) => supportsFullResultsMode(definition, mode as "totals" | "averages"));
          const neededStatKeys = new Set<string>([statKey, ...uniqueConditionStatKeys(filters.conditions, statKey)]);
          const definitionsForQuery = allDefinitions.filter((definition) =>
            neededStatKeys.has(definition.statKey) || definition.statKey === "games_played"
          );
          const unifiedLimit = filters.conditions.length
            ? Math.min(50000, Math.max(limit * 50, 5000))
            : limit;
          return runFullResultsPlayerMatchAggregatePagedPath(
            db,
            seasonFrom,
            seasonTo,
            filters,
            definitionsForQuery,
            mode as "totals" | "averages",
            format,
            statKey,
            unifiedLimit,
            0,
            "stat_total",
            "desc",
            true,
            singleEntityResults && filters.conditions.length === 0 && format !== "overall"
          );
        })()
      : null;
    if (unifiedPlayerAggregatePayload) {
      const grouping = groupingColumns("player", format);
      let rows = filters.conditions.length
        ? applyAggregateConditions(unifiedPlayerAggregatePayload.rows, filters.conditions, statKey)
        : unifiedPlayerAggregatePayload.rows;
      if (format === "club") {
        rows = reduceToTopClubRows(rows, "player");
      }
      return {
        ok: true,
        summary: `Top ${limit} players by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}. Unified SQL-paged aggregate path.`,
        columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
        rows: rows.slice(0, limit),
      };
    }
    if (getDerivedRecipe("player", statKey)) {
      return runDerivedAggregateQuery(db, "player", statKey, limit, mode, format, seasonFrom, seasonTo, filters);
    }
    const playerGamesPlayedStat = statKey === "games_played";
    const playerFilters = buildPlayerFilters(filters);
    const grouping = groupingColumns("player", format);
    const conditionStatKeys = uniqueConditionStatKeys(filters.conditions, statKey);
    const conditionColumns = buildPlayerConditionAggregateColumns(conditionStatKeys, mode);
    const includedFlag = playerGamesPlayedStat
      ? "1"
      : PLAYER_ZERO_IF_MISSING.has(statKey)
      ? "1"
      : `CASE WHEN s.season >= COALESCE(sd.first_consistent_season, 0) THEN 1 WHEN ${playerStatPresentExpr("s", "?")} THEN 1 ELSE 0 END`;
    const statValueExpr = playerGamesPlayedStat
      ? "1"
      : `COALESCE(${playerStatNumericExpr("s", "?")}, 0)`;
    const statExpr = mode === "averages"
      ? "ROUND(SUM(stat_value) / NULLIF(SUM(included_flag), 0), 3)"
      : "ROUND(SUM(stat_value), 3)";
    const preFilterLimit = filters.conditions.length
      ? Math.min(50000, Math.max(limit * 50, 5000))
      : limit;
    const sql = `
      WITH base AS (
        SELECT
          COALESCE(p.display_name, s.player_name_raw) AS player_name,
          tt.canonical_name AS club_name,
          s.season,
          s.match_id,
          m.round_label,
          COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
          COALESCE(v.canonical_name, 'Unknown') AS venue_name,
          COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
          ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
          ${statValueExpr} AS stat_value,
          ${includedFlag} AS included_flag${conditionColumns.baseSelect.length ? `,\n          ${conditionColumns.baseSelect.join(",\n          ")}` : ""}
        FROM player_match_summary s
        LEFT JOIN players p ON p.player_id = s.player_id
        JOIN matches m ON m.match_id = s.match_id
        JOIN competitions c ON c.competition_id = m.competition_id
        LEFT JOIN teams tt ON tt.team_id = s.team_id
        LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
        LEFT JOIN venues v ON v.venue_id = m.venue_id
        LEFT JOIN stat_definitions sd ON sd.scope = 'player' AND sd.stat_key = ?
        WHERE s.season BETWEEN ? AND ?
        ${playerFilters.sql}
      )
      SELECT
        ${grouping.select.join(", ")},
        MIN(season) AS first_season,
        MAX(season) AS last_season,
        COUNT(*) AS games,
        SUM(included_flag) AS included_games,
        ${statExpr} AS stat_total${conditionColumns.outerSelect.length ? `,\n        ${conditionColumns.outerSelect.join(",\n        ")}` : ""}
      FROM base
      GROUP BY ${grouping.groupBy.join(", ")}
      ORDER BY stat_total DESC, included_games DESC, ${grouping.columns[0]} ASC
      LIMIT ?
    `;
    const bindValues = playerGamesPlayedStat
      ? [...conditionColumns.binds.slice(0, conditionColumns.baseBindCount), statKey, seasonFrom, seasonTo, ...playerFilters.binds, ...conditionColumns.binds.slice(conditionColumns.baseBindCount), preFilterLimit]
      : PLAYER_ZERO_IF_MISSING.has(statKey)
      ? [statKey, ...conditionColumns.binds.slice(0, conditionColumns.baseBindCount), statKey, seasonFrom, seasonTo, ...playerFilters.binds, ...conditionColumns.binds.slice(conditionColumns.baseBindCount), preFilterLimit]
      : [statKey, statKey, ...conditionColumns.binds.slice(0, conditionColumns.baseBindCount), statKey, seasonFrom, seasonTo, ...playerFilters.binds, ...conditionColumns.binds.slice(conditionColumns.baseBindCount), preFilterLimit];

    const result = await db.prepare(sql).bind(...bindValues).all<QueryRow>();
    let rows = applyAggregateConditions(result.results ?? [], filters.conditions, statKey);
    if (format === "club") {
      rows = reduceToTopClubRows(rows, "player");
    }
    return {
      ok: true,
      summary: `Top ${limit} players by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}. Included games now respect each stat's first consistent season.`,
      columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
      rows: rows.slice(0, limit),
    };
  }

  if (
    scope === "team"
    && ["wins", "losses", "draws", "points_for", "points_against", "total_points", "margin"].includes(statKey)
    && mode === "streaks"
    && normalizeScoreHalf(filters.scoreHalf) === "all"
  ) {
    const grouping = groupingColumns("team", format);
    const isResultStat = ["wins", "losses", "draws"].includes(statKey);
    const target = statKey === "wins" ? "win" : statKey === "losses" ? "loss" : statKey === "draws" ? "tie" : null;
    const statValueExpr = statKey === "wins"
      ? "CASE WHEN result = 'win' THEN 1 ELSE 0 END"
      : statKey === "losses"
        ? "CASE WHEN result = 'loss' THEN 1 ELSE 0 END"
        : statKey === "draws"
          ? "CASE WHEN result = 'tie' THEN 1 ELSE 0 END"
          : statKey === "points_for"
            ? "team_score"
            : statKey === "points_against"
              ? "opponent_score"
              : statKey === "total_points"
                ? "(team_score + opponent_score)"
                : "(team_score - opponent_score)";
    const clauses: string[] = [];
    const binds: unknown[] = [seasonFrom, seasonTo, seasonFrom, seasonTo];
    if (filters.competition !== "Any") {
      const competitionFilter = competitionFilterSql("c.name", filters.competition);
      if (competitionFilter.sql) {
        clauses.push(competitionFilter.sql);
        binds.push(...competitionFilter.binds);
      }
    }
    if (filters.team !== "Any") {
      clauses.push("t.canonical_name = ?");
      binds.push(filters.team);
    }
    if (filters.opponent !== "Any") {
      clauses.push("ot.canonical_name = ?");
      binds.push(filters.opponent);
    }
    if (filters.venue !== "Any") {
      clauses.push("v.canonical_name = ?");
      binds.push(filters.venue);
    }
    if (filters.matchPlayer && filters.matchPlayer !== "Any") {
      clauses.push(`EXISTS (
        SELECT 1
        FROM player_match_summary mp
        LEFT JOIN players pp ON pp.player_id = mp.player_id
        WHERE mp.match_id = tg.match_id
          AND COALESCE(pp.display_name, mp.player_name_raw) = ?
      )`);
      binds.push(filters.matchPlayer);
    }
    if (filters.homeAway === "home") {
      clauses.push("tg.is_home = 1");
    } else if (filters.homeAway === "away") {
      clauses.push("tg.is_home = 0");
    }
    if (filters.roundFrom !== null) {
      clauses.push("tg.round_index >= ?");
      binds.push(filters.roundFrom);
    }
    if (filters.roundTo !== null) {
      clauses.push("tg.round_index <= ?");
      binds.push(filters.roundTo);
    }
    const seasonTypeExpr = buildSeasonTypeExpression("tg", filters);
    if (seasonTypeExpr) {
      clauses.push(seasonTypeExpr);
    }
    if (format !== "season" && filters.excludeSparseHistoricalStreaks) {
      clauses.push("tg.season >= 1998");
    }

    const sql = `
      WITH team_games AS (
        SELECT
          m.match_id,
          m.season,
          m.round_index,
          m.round_label,
          m.match_date_utc,
          ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
          m.competition_id,
          m.venue_id,
          m.is_finals,
          m.home_team_id AS team_id,
          m.away_team_id AS opponent_team_id,
          1 AS is_home,
          home_score AS team_score,
          away_score AS opponent_score
        FROM matches m
        WHERE m.season BETWEEN ? AND ?
          AND ${completedMatchPredicate("m")}
        UNION ALL
        SELECT
          m.match_id,
          m.season,
          m.round_index,
          m.round_label,
          m.match_date_utc,
          ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
          m.competition_id,
          m.venue_id,
          m.is_finals,
          m.away_team_id AS team_id,
          m.home_team_id AS opponent_team_id,
          0 AS is_home,
          away_score AS team_score,
          home_score AS opponent_score
        FROM matches m
        WHERE m.season BETWEEN ? AND ?
          AND ${completedMatchPredicate("m")}
      )
      , base AS (
      SELECT
        t.canonical_name AS team,
        tg.match_id,
        tg.season,
        tg.round_index,
        tg.match_date_utc,
        tg.match_sort_key,
        COALESCE(v.canonical_name, 'Unknown') AS venue_name,
        COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
        tg.team_score,
        tg.opponent_score,
        CASE
          WHEN tg.team_score > tg.opponent_score THEN 'win'
          WHEN tg.team_score < tg.opponent_score THEN 'loss'
          ELSE 'tie'
        END AS result
      FROM team_games tg
      JOIN teams t ON t.team_id = tg.team_id
      LEFT JOIN teams ot ON ot.team_id = tg.opponent_team_id
      JOIN competitions c ON c.competition_id = tg.competition_id
      LEFT JOIN venues v ON v.venue_id = tg.venue_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      )
      SELECT
        team,
        season,
        ${format === "season" ? "NULL" : "round_index"} AS round_index,
        MAX(match_date_utc) AS match_date_utc,
        MIN(match_sort_key) AS match_sort_key,
        MIN(match_id) AS match_id,
        ${format === "ground" ? "venue_name" : format === "opposition" ? "opposition_name" : "NULL"} AS group_label,
        ${format === "season"
          ? `SUM(${statValueExpr})`
          : `MAX(${statValueExpr})`} AS stat_total,
        ${format === "season"
          ? `CASE WHEN SUM(${statValueExpr}) > 0 THEN 'hit' ELSE 'miss' END`
          : "result"} AS result
      FROM base
      GROUP BY team, ${format === "season" ? "season" : "season, round_index, match_date_utc, match_sort_key"}, ${format === "ground" ? "venue_name" : format === "opposition" ? "opposition_name" : "NULL"}
      ORDER BY team, season, match_sort_key, match_id
    `;

    const result = await db.prepare(sql).bind(...binds).all<{
      team: string;
      season: number;
      round_index: number;
      match_date_utc: string | null;
      venue_name: string;
      opposition_name: string;
      group_label: string | null;
      stat_total: number | null;
      result: string;
    }>();
    const streakInput = (result.results ?? []).map((row) => ({
      entity: row.team,
      season: row.season,
      round_index: row.round_index,
      match_date_utc: row.match_date_utc,
      stat_value:
        filters.conditions.length
          ? (matchesAggregateConditions(
              {
                stat_total: Number(row.stat_total ?? 0),
                included_games: 1,
              },
              filters.conditions,
              statKey
            ) ? 1 : 0)
          : (isResultStat
              ? (row.result === (format === "season" ? "hit" : target) ? 1 : 0)
              : (Number(row.stat_total ?? 0) > 0 ? 1 : 0)),
      group_label: row.group_label ?? null,
    }));
    const rows = streakRows(
      streakInput,
      "team",
      limit,
      allowMultipleStreaks,
      ["ground", "opposition"].includes(format) ? grouping.groupLabelName ?? null : null,
      ["ground", "opposition"].includes(format)
    );

    return {
      ok: true,
      summary: `Top ${limit} team ${statKey} streaks from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}${format !== "season" && filters.excludeSparseHistoricalStreaks ? "; pre-1998 sparse match streaks excluded" : ""}.`,
      columns: ["team", ...(["ground", "opposition"].includes(format) && grouping.groupLabelName ? [grouping.groupLabelName] : []), "streak", "first_game", "last_game"],
      rows,
    };
  }

  if (scope === "team" && mode === "streaks") {
    if (format === "season") {
      const aggregateStreakPath = await runTeamSeasonAggregateStreakPath(
        db,
        statKey,
        limit,
        seasonFrom,
        seasonTo,
        filters,
        allowMultipleStreaks,
      );
      if (aggregateStreakPath) {
        return aggregateStreakPath;
      }
    }

    const scoreDerivedStat = ["wins", "losses", "draws", "points_for", "points_against", "total_points", "margin"].includes(statKey);
    const storedTeamStat = !scoreDerivedStat && statKey !== "games";
    const grouping = groupingColumns("team", format);
    const historicalStreakClause =
      format !== "season" && filters.excludeSparseHistoricalStreaks ? " AND s.season >= 1998" : "";
    const statValueExpr = scoreDerivedStat
      ? teamScoreStatExpression(statKey, filters.scoreHalf, "s") ?? "0"
      : (storedTeamStat ? `COALESCE(${teamStatNumericExpr("s", "?")}, 0)` : "1");
    const teamFilters = buildTeamFilters({ ...filters, conditions: [] });
    const effectiveStreakConditions = filters.conditions.length
      ? filters.conditions
      : [{ statKey, operator: "gt", value: "0", joiner: "AND" }];
    const streakHitExpr = buildTeamConditionExpression(effectiveStreakConditions, filters.scoreHalf, "s", "os");

    const sql = `
      WITH base AS (
        SELECT
          t.canonical_name AS entity,
          s.season,
          s.round_index,
          s.match_date_utc,
          ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
          ${format === "ground"
            ? "COALESCE(v.canonical_name, 'Unknown')"
            : format === "opposition"
              ? "COALESCE(ot.canonical_name, 'Unknown')"
              : "NULL"} AS group_label,
          ${statValueExpr} AS stat_total,
          CASE WHEN ${streakHitExpr?.sql ?? "stat_total > 0"} THEN 1 ELSE 0 END AS hit_value,
          1 AS included_games
        FROM team_match_summary s
        JOIN teams t ON t.team_id = s.team_id
        JOIN matches m ON m.match_id = s.match_id
        JOIN competitions c ON c.competition_id = m.competition_id
        LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
        LEFT JOIN venues v ON v.venue_id = m.venue_id
        LEFT JOIN team_match_summary os ON os.match_id = s.match_id AND os.team_id = s.opponent_team_id
        WHERE s.season BETWEEN ? AND ?
        ${teamFilters.sql}
        ${historicalStreakClause}
      )
      SELECT
        entity,
        season,
        round_index,
        match_date_utc,
        match_sort_key,
        group_label,
        stat_total,
        hit_value,
        included_games
      FROM base
      ORDER BY entity, season, match_sort_key, round_index
    `;

    const bindValues = format === "season"
      ? (scoreDerivedStat
          ? [seasonFrom, seasonTo, ...teamFilters.binds]
          : (storedTeamStat ? [statKey, seasonFrom, seasonTo, ...teamFilters.binds] : [seasonFrom, seasonTo, ...teamFilters.binds]))
      : (scoreDerivedStat
          ? [...(streakHitExpr?.binds ?? []), seasonFrom, seasonTo, ...teamFilters.binds]
          : (storedTeamStat
              ? [statKey, ...(streakHitExpr?.binds ?? []), seasonFrom, seasonTo, ...teamFilters.binds]
              : [...(streakHitExpr?.binds ?? []), seasonFrom, seasonTo, ...teamFilters.binds]));
    const result = await db.prepare(sql).bind(...bindValues).all<{
      entity: string;
      season: number;
      round_index: number | null;
      match_date_utc: string | null;
      group_label: string | null;
      stat_total: number | null;
      hit_value: number | null;
      included_games: number | null;
    }>();

    const streakInput = (result.results ?? []).map((row) => ({
      entity: row.entity,
      season: row.season,
      round_index: row.round_index,
      match_date_utc: row.match_date_utc,
      stat_value: format !== "season"
        ? Number(row.hit_value ?? 0)
        : filters.conditions.length
        ? (matchesAggregateConditions({ stat_total: row.stat_total, included_games: row.included_games }, filters.conditions, statKey, filters.scoreHalf) ? 1 : 0)
        : Number(row.stat_total ?? 0),
      group_label: row.group_label ?? null,
    }));

    const rows = streakRows(
      streakInput,
      "team",
      limit,
      allowMultipleStreaks,
      ["ground", "opposition"].includes(format) ? grouping.groupLabelName ?? null : null,
      ["ground", "opposition"].includes(format)
    );
    return {
      ok: true,
      summary: `Top ${limit} team streaks for games in a row with ${describeStreakThreshold(statKey, filters.conditions)} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}${format !== "season" && filters.excludeSparseHistoricalStreaks ? "; pre-1998 sparse match streaks excluded" : ""}.`,
      columns: ["team", ...(["ground", "opposition"].includes(format) && grouping.groupLabelName ? [grouping.groupLabelName] : []), "streak", "first_game", "last_game"],
      rows,
    };
  }

  if (scope === "team" && statKey === "margin" && normalizeScoreHalf(filters.scoreHalf) === "all") {
    const seasonTypeExpr = buildSeasonTypeExpression("m", filters);
    const competitionFilter = competitionFilterSql("c.name", filters.competition);
    const sql = `
      SELECT
        m.season,
        m.round_label AS round,
        th.canonical_name AS winner,
        ta.canonical_name AS loser,
        m.margin,
        m.match_date_utc AS match_date
      FROM matches m
      JOIN competitions c ON c.competition_id = m.competition_id
      JOIN teams th ON th.team_id = m.winner_team_id
      JOIN teams ta ON (
        (ta.team_id = m.home_team_id AND m.winner_team_id = m.away_team_id) OR
        (ta.team_id = m.away_team_id AND m.winner_team_id = m.home_team_id)
      )
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      WHERE m.winner_team_id IS NOT NULL
        AND m.season BETWEEN ? AND ?
        ${competitionFilter.sql ? `AND ${competitionFilter.sql}` : ""}
        ${filters.team !== "Any" ? "AND th.canonical_name = ?" : ""}
        ${filters.opponent !== "Any" ? "AND ta.canonical_name = ?" : ""}
        ${filters.venue !== "Any" ? "AND v.canonical_name = ?" : ""}
        ${filters.matchPlayer !== "Any" ? `AND EXISTS (
          SELECT 1
          FROM player_match_summary mp
          LEFT JOIN players pp ON pp.player_id = mp.player_id
          WHERE mp.match_id = m.match_id
            AND COALESCE(pp.display_name, mp.player_name_raw) = ?
        )` : ""}
        ${filters.roundFrom !== null ? "AND m.round_index >= ?" : ""}
        ${filters.roundTo !== null ? "AND m.round_index <= ?" : ""}
        ${seasonTypeExpr ? `AND ${seasonTypeExpr}` : ""}
      ORDER BY m.margin DESC, m.season DESC
      LIMIT ?
    `;

    const bindValues: unknown[] = [seasonFrom, seasonTo];
    bindValues.push(...competitionFilter.binds);
    if (filters.team !== "Any") bindValues.push(filters.team);
    if (filters.opponent !== "Any") bindValues.push(filters.opponent);
    if (filters.venue !== "Any") bindValues.push(filters.venue);
    if (filters.matchPlayer !== "Any") bindValues.push(filters.matchPlayer);
    if (filters.roundFrom !== null) bindValues.push(filters.roundFrom);
    if (filters.roundTo !== null) bindValues.push(filters.roundTo);
    bindValues.push(limit);
    const result = await db.prepare(sql).bind(...bindValues).all<QueryRow>();
    return {
      ok: true,
      summary: `Top ${limit} winning margins from ${seasonFrom} to ${seasonTo}.`,
      columns: ["season", "round", "winner", "loser", "margin", "match_date"],
      rows: (result.results ?? []).map((row) => ({ ...row, stat_total: row.margin })),
    };
  }

  if (scope === "team" && ["games", "wins", "losses", "draws", "points_for", "points_against", "total_points", "margin"].includes(statKey)) {
    const grouping = groupingColumns("team", format);
    const clauses: string[] = [];
    const bindValues: unknown[] = [seasonFrom, seasonTo];
    const seasonTypeExpr = buildSeasonTypeExpression("m", filters);
    const scoreHalf = normalizeScoreHalf(filters.scoreHalf);
    const groupedScoreStatKeys = new Set([
      "games",
      "games_included",
      "wins",
      "losses",
      "draws",
      "points_for",
      "points_against",
      "total_points",
      "margin",
    ]);
    const postAggregateConditions = format === "match"
      ? []
      : filters.conditions.filter((condition) => groupedScoreStatKeys.has(condition.statKey));
    const rowConditions = filters.conditions.filter((condition) => !postAggregateConditions.includes(condition));
    const useMatchHistoryQuery =
      scoreHalf === "all" &&
      filters.referee === "Any" &&
      filters.groundCondition === "Any" &&
      filters.weatherCondition === "Any";

    if (useMatchHistoryQuery) {
      const useLeanMatchHistoryQuery = filters.matchPlayer === "Any";
      if (filters.competition !== "Any") {
        const competitionFilter = competitionFilterSql("src.competition_name", filters.competition);
        if (competitionFilter.sql) {
          clauses.push(competitionFilter.sql);
          bindValues.push(...competitionFilter.binds);
        }
      }
      if (filters.team !== "Any") {
        clauses.push("src.team_name = ?");
        bindValues.push(filters.team);
      }
      if (filters.opponent !== "Any") {
        clauses.push("src.opposition_name = ?");
        bindValues.push(filters.opponent);
      }
      if (filters.venue !== "Any") {
        clauses.push("src.venue_name = ?");
        bindValues.push(filters.venue);
      }
      if (filters.referee !== "Any") {
        clauses.push("src.referee_name = ?");
        bindValues.push(filters.referee);
      }
      if (filters.groundCondition !== "Any") {
        clauses.push("src.ground_condition_name = ?");
        bindValues.push(filters.groundCondition);
      }
      if (filters.weatherCondition !== "Any") {
        clauses.push("src.weather_condition_name = ?");
        bindValues.push(filters.weatherCondition);
      }
      if (filters.matchPlayer !== "Any") {
        clauses.push(`EXISTS (
          SELECT 1
          FROM player_match_summary mp
          LEFT JOIN players pp ON pp.player_id = mp.player_id
          WHERE mp.match_id = src.match_id
            AND COALESCE(pp.display_name, mp.player_name_raw) = ?
        )`);
        bindValues.push(filters.matchPlayer);
      }
      if (filters.homeAway === "home") {
        clauses.push("src.is_home = 1");
      } else if (filters.homeAway === "away") {
        clauses.push("src.is_home = 0");
      }
      if (filters.result === "win") {
        clauses.push("src.team_score > src.opponent_score");
      } else if (filters.result === "loss") {
        clauses.push("src.team_score < src.opponent_score");
      } else if (filters.result === "tie") {
        clauses.push("src.team_score = src.opponent_score");
      }
      if (filters.roundFrom !== null) {
        clauses.push("src.round_index >= ?");
        bindValues.push(filters.roundFrom);
      }
      if (filters.roundTo !== null) {
        clauses.push("src.round_index <= ?");
        bindValues.push(filters.roundTo);
      }
      if (seasonTypeExpr) {
        clauses.push(buildSeasonTypeExpression("src", filters));
      }
      const conditionExpr = buildTeamConditionExpression(rowConditions, scoreHalf, "src", "src");
      if (conditionExpr) {
        clauses.push(conditionExpr.sql);
        bindValues.push(...conditionExpr.binds);
      }

      const sourceSql = useLeanMatchHistoryQuery
        ? `
          SELECT
            ht.canonical_name AS team_name,
            m.season,
            m.match_id,
            m.round_index,
            m.round_label,
            m.is_finals,
            c.name AS competition_name,
            COALESCE(at.canonical_name, 'Unknown') AS opposition_name,
            COALESCE(v.canonical_name, 'Unknown') AS venue_name,
            COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
            ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
            'Unknown' AS referee_name,
            'Unknown' AS ground_condition_name,
            'Unknown' AS weather_condition_name,
            1 AS is_home,
            m.home_score AS team_score,
            m.away_score AS opponent_score,
            NULL AS team_match_summary_id,
            1 AS included_games,
            CASE WHEN m.home_score > m.away_score THEN 1 ELSE 0 END AS win_value,
            CASE WHEN m.home_score < m.away_score THEN 1 ELSE 0 END AS loss_value,
            CASE WHEN m.home_score = m.away_score THEN 1 ELSE 0 END AS draw_value,
            m.home_score AS points_for_value,
            m.away_score AS points_against_value,
            (m.home_score - m.away_score) AS margin_value,
            NULL AS stats_json
          FROM matches m
          JOIN teams ht ON ht.team_id = m.home_team_id
          JOIN teams at ON at.team_id = m.away_team_id
          JOIN competitions c ON c.competition_id = m.competition_id
          LEFT JOIN venues v ON v.venue_id = m.venue_id
          WHERE ${completedMatchPredicate("m")}
          UNION ALL
          SELECT
            at.canonical_name AS team_name,
            m.season,
            m.match_id,
            m.round_index,
            m.round_label,
            m.is_finals,
            c.name AS competition_name,
            COALESCE(ht.canonical_name, 'Unknown') AS opposition_name,
            COALESCE(v.canonical_name, 'Unknown') AS venue_name,
            COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
            ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
            'Unknown' AS referee_name,
            'Unknown' AS ground_condition_name,
            'Unknown' AS weather_condition_name,
            0 AS is_home,
            m.away_score AS team_score,
            m.home_score AS opponent_score,
            NULL AS team_match_summary_id,
            1 AS included_games,
            CASE WHEN m.away_score > m.home_score THEN 1 ELSE 0 END AS win_value,
            CASE WHEN m.away_score < m.home_score THEN 1 ELSE 0 END AS loss_value,
            CASE WHEN m.away_score = m.home_score THEN 1 ELSE 0 END AS draw_value,
            m.away_score AS points_for_value,
            m.home_score AS points_against_value,
            (m.away_score - m.home_score) AS margin_value,
            NULL AS stats_json
          FROM matches m
          JOIN teams ht ON ht.team_id = m.home_team_id
          JOIN teams at ON at.team_id = m.away_team_id
          JOIN competitions c ON c.competition_id = m.competition_id
          LEFT JOIN venues v ON v.venue_id = m.venue_id
          WHERE ${completedMatchPredicate("m")}
        `
        : `
          SELECT
            ht.canonical_name AS team_name,
            m.season,
            m.match_id,
            m.round_index,
            m.round_label,
            m.is_finals,
            c.name AS competition_name,
            COALESCE(at.canonical_name, 'Unknown') AS opposition_name,
            COALESCE(v.canonical_name, 'Unknown') AS venue_name,
            COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
            ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
            COALESCE(hs_ref.stat_value_text, 'Unknown') AS referee_name,
            COALESCE(hs_ground.stat_value_text, 'Unknown') AS ground_condition_name,
            COALESCE(hs_weather.stat_value_text, 'Unknown') AS weather_condition_name,
            1 AS is_home,
            m.home_score AS team_score,
            m.away_score AS opponent_score,
            hs.team_match_summary_id AS team_match_summary_id,
            1 AS included_games,
            CASE WHEN m.home_score > m.away_score THEN 1 ELSE 0 END AS win_value,
            CASE WHEN m.home_score < m.away_score THEN 1 ELSE 0 END AS loss_value,
            CASE WHEN m.home_score = m.away_score THEN 1 ELSE 0 END AS draw_value,
            m.home_score AS points_for_value,
            m.away_score AS points_against_value,
            (m.home_score - m.away_score) AS margin_value,
            NULL AS stats_json
          FROM matches m
          JOIN teams ht ON ht.team_id = m.home_team_id
          JOIN teams at ON at.team_id = m.away_team_id
          JOIN competitions c ON c.competition_id = m.competition_id
          LEFT JOIN venues v ON v.venue_id = m.venue_id
          LEFT JOIN team_match_summary hs ON hs.match_id = m.match_id AND hs.team_id = m.home_team_id
          LEFT JOIN team_match_stat_values hs_ref ON hs_ref.team_match_summary_id = hs.team_match_summary_id AND hs_ref.stat_key = 'referee'
          LEFT JOIN team_match_stat_values hs_ground ON hs_ground.team_match_summary_id = hs.team_match_summary_id AND hs_ground.stat_key = 'ground_condition'
          LEFT JOIN team_match_stat_values hs_weather ON hs_weather.team_match_summary_id = hs.team_match_summary_id AND hs_weather.stat_key = 'weather_condition'
          WHERE ${completedMatchPredicate("m")}
          UNION ALL
          SELECT
            at.canonical_name AS team_name,
            m.season,
            m.match_id,
            m.round_index,
            m.round_label,
            m.is_finals,
            c.name AS competition_name,
            COALESCE(ht.canonical_name, 'Unknown') AS opposition_name,
            COALESCE(v.canonical_name, 'Unknown') AS venue_name,
            COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
            ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
            COALESCE(asu_ref.stat_value_text, 'Unknown') AS referee_name,
            COALESCE(asu_ground.stat_value_text, 'Unknown') AS ground_condition_name,
            COALESCE(asu_weather.stat_value_text, 'Unknown') AS weather_condition_name,
            0 AS is_home,
            m.away_score AS team_score,
            m.home_score AS opponent_score,
            asu.team_match_summary_id AS team_match_summary_id,
            1 AS included_games,
            CASE WHEN m.away_score > m.home_score THEN 1 ELSE 0 END AS win_value,
            CASE WHEN m.away_score < m.home_score THEN 1 ELSE 0 END AS loss_value,
            CASE WHEN m.away_score = m.home_score THEN 1 ELSE 0 END AS draw_value,
            m.away_score AS points_for_value,
            m.home_score AS points_against_value,
            (m.away_score - m.home_score) AS margin_value,
            NULL AS stats_json
          FROM matches m
          JOIN teams ht ON ht.team_id = m.home_team_id
          JOIN teams at ON at.team_id = m.away_team_id
          JOIN competitions c ON c.competition_id = m.competition_id
          LEFT JOIN venues v ON v.venue_id = m.venue_id
          LEFT JOIN team_match_summary asu ON asu.match_id = m.match_id AND asu.team_id = m.away_team_id
          LEFT JOIN team_match_stat_values asu_ref ON asu_ref.team_match_summary_id = asu.team_match_summary_id AND asu_ref.stat_key = 'referee'
          LEFT JOIN team_match_stat_values asu_ground ON asu_ground.team_match_summary_id = asu.team_match_summary_id AND asu_ground.stat_key = 'ground_condition'
          LEFT JOIN team_match_stat_values asu_weather ON asu_weather.team_match_summary_id = asu.team_match_summary_id AND asu_weather.stat_key = 'weather_condition'
          WHERE ${completedMatchPredicate("m")}
        `;

      const sql = `
        WITH source AS (
          ${sourceSql}
        ),
        base AS (
          SELECT *
          FROM source src
          WHERE src.season BETWEEN ? AND ?
          AND NOT (
            src.team_score = 0
            AND src.opponent_score = 0
            AND src.match_sort_key IS NOT NULL
            AND src.match_sort_key >= date('now')
          )
          ${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
        )
        SELECT
          ${grouping.select.join(", ")},
          COUNT(*) AS games,
          SUM(included_games) AS included_games,
          SUM(win_value) AS wins,
          SUM(loss_value) AS losses,
          SUM(draw_value) AS draws,
          SUM(points_for_value) AS points_for,
          SUM(points_against_value) AS points_against,
          SUM(margin_value) AS margin,
          ROUND(
            CASE
              WHEN ? = 'averages' THEN
                CASE
                  WHEN ? = 'games' THEN 1.0
                  WHEN ? = 'wins' THEN 1.0 * SUM(win_value) / NULLIF(COUNT(*), 0)
                  WHEN ? = 'losses' THEN 1.0 * SUM(loss_value) / NULLIF(COUNT(*), 0)
                  WHEN ? = 'draws' THEN 1.0 * SUM(draw_value) / NULLIF(COUNT(*), 0)
                  WHEN ? = 'points_for' THEN 1.0 * SUM(points_for_value) / NULLIF(SUM(included_games), 0)
                  WHEN ? = 'points_against' THEN 1.0 * SUM(points_against_value) / NULLIF(SUM(included_games), 0)
                  WHEN ? = 'total_points' THEN 1.0 * (SUM(points_for_value) + SUM(points_against_value)) / NULLIF(SUM(included_games), 0)
                  ELSE 1.0 * SUM(margin_value) / NULLIF(SUM(included_games), 0)
                END
              ELSE
                CASE
                  WHEN ? = 'games' THEN COUNT(*)
                  WHEN ? = 'wins' THEN SUM(win_value)
                  WHEN ? = 'losses' THEN SUM(loss_value)
                  WHEN ? = 'draws' THEN SUM(draw_value)
                  WHEN ? = 'points_for' THEN SUM(points_for_value)
                  WHEN ? = 'points_against' THEN SUM(points_against_value)
                  WHEN ? = 'total_points' THEN SUM(points_for_value) + SUM(points_against_value)
                  ELSE SUM(margin_value)
                END
            END,
            3
          ) AS stat_total
        FROM base
        GROUP BY ${grouping.groupBy.join(", ")}
        ORDER BY stat_total DESC, ${grouping.columns[0]} ASC
        ${postAggregateConditions.length ? "" : "LIMIT ?"}
      `;
      bindValues.push(mode, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey);
      if (!postAggregateConditions.length) bindValues.push(limit);
      const result = await db.prepare(sql).bind(...bindValues).all<QueryRow>();
      const rows = applyAggregateConditions(result.results ?? [], postAggregateConditions, statKey);
      return {
        ok: true,
        summary: `Top ${limit} teams by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}.`,
        columns: [...grouping.columns, "stat_total", "games", "included_games", "wins", "losses", "draws", "points_for", "points_against", "margin"],
        rows: rows.slice(0, limit),
      };
    }

    if (filters.competition !== "Any") {
      const competitionFilter = competitionFilterSql("c.name", filters.competition);
      if (competitionFilter.sql) {
        clauses.push(competitionFilter.sql);
        bindValues.push(...competitionFilter.binds);
      }
    }
    if (filters.team !== "Any") {
      clauses.push("t.canonical_name = ?");
      bindValues.push(filters.team);
    }
    if (filters.opponent !== "Any") {
      clauses.push("ot.canonical_name = ?");
      bindValues.push(filters.opponent);
    }
    if (filters.venue !== "Any") {
      clauses.push("v.canonical_name = ?");
      bindValues.push(filters.venue);
    }
    if (filters.referee !== "Any") {
      clauses.push(`COALESCE(${teamStatTextExpr("s", "'referee'")}, 'Unknown') = ?`);
      bindValues.push(filters.referee);
    }
    if (filters.groundCondition !== "Any") {
      clauses.push(`COALESCE(${teamStatTextExpr("s", "'ground_condition'")}, 'Unknown') = ?`);
      bindValues.push(filters.groundCondition);
    }
    if (filters.weatherCondition !== "Any") {
      clauses.push(`COALESCE(${teamStatTextExpr("s", "'weather_condition'")}, 'Unknown') = ?`);
      bindValues.push(filters.weatherCondition);
    }
    if (filters.matchPlayer !== "Any") {
      clauses.push(`EXISTS (
        SELECT 1
        FROM player_match_summary mp
        LEFT JOIN players pp ON pp.player_id = mp.player_id
        WHERE mp.match_id = s.match_id
          AND COALESCE(pp.display_name, mp.player_name_raw) = ?
      )`);
      bindValues.push(filters.matchPlayer);
    }
    if (filters.homeAway === "home") {
      clauses.push("s.is_home = 1");
    } else if (filters.homeAway === "away") {
      clauses.push("s.is_home = 0");
    }
    clauses.push(completedMatchPredicate("m"));
    if (filters.result === "win") {
      clauses.push("s.team_score > s.opponent_score");
    } else if (filters.result === "loss") {
      clauses.push("s.team_score < s.opponent_score");
    } else if (filters.result === "tie") {
      clauses.push("s.team_score = s.opponent_score");
    }
    if (filters.roundFrom !== null) {
      clauses.push("s.round_index >= ?");
      bindValues.push(filters.roundFrom);
    }
    if (filters.roundTo !== null) {
      clauses.push("s.round_index <= ?");
      bindValues.push(filters.roundTo);
    }
    if (seasonTypeExpr) {
      clauses.push(seasonTypeExpr);
    }
    const conditionExpr = buildTeamConditionExpression(rowConditions, scoreHalf, "s", "os");
    if (conditionExpr) {
      clauses.push(conditionExpr.sql);
      bindValues.push(...conditionExpr.binds);
    }

    const pointsForExpr = teamScoreStatExpression("points_for", scoreHalf, "s", "os") ?? "s.team_score";
    const pointsAgainstExpr = teamScoreStatExpression("points_against", scoreHalf, "s", "os") ?? "s.opponent_score";
    const totalPointsExpr = teamScoreStatExpression("total_points", scoreHalf, "s", "os") ?? "(s.team_score + s.opponent_score)";
    const marginExpr = teamScoreStatExpression("margin", scoreHalf, "s", "os") ?? "(s.team_score - s.opponent_score)";
    const includedExpr = scoreHalf === "all"
      ? "1"
      : `CASE WHEN ${teamScoreStatExpression("margin", scoreHalf, "s", "os")} IS NOT NULL THEN 1 ELSE 0 END`;

    const sql = `
      WITH base AS (
        SELECT
          t.canonical_name AS team_name,
          s.season,
          s.match_id,
          m.round_label,
          COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
          COALESCE(v.canonical_name, 'Unknown') AS venue_name,
          COALESCE(m.match_date_local_text, s.match_date_utc, m.match_date_utc) AS match_reference,
          ${matchSortKeySql("COALESCE(s.match_date_utc, m.match_date_utc)", "m.match_date_local_text")} AS match_sort_key,
          ${includedExpr} AS included_games,
          CASE WHEN s.team_score > s.opponent_score THEN 1 ELSE 0 END AS win_value,
          CASE WHEN s.team_score < s.opponent_score THEN 1 ELSE 0 END AS loss_value,
          CASE WHEN s.team_score = s.opponent_score THEN 1 ELSE 0 END AS draw_value,
          ${pointsForExpr} AS points_for_value,
          ${pointsAgainstExpr} AS points_against_value,
          ${totalPointsExpr} AS total_points_value,
          ${marginExpr} AS margin_value
        FROM team_match_summary s
        JOIN matches m ON m.match_id = s.match_id
        JOIN teams t ON t.team_id = s.team_id
        LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
        JOIN competitions c ON c.competition_id = m.competition_id
        LEFT JOIN venues v ON v.venue_id = m.venue_id
        WHERE s.season BETWEEN ? AND ?
        ${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
      )
      SELECT
        ${grouping.select.join(", ")},
        COUNT(*) AS games,
        SUM(included_games) AS included_games,
        SUM(win_value) AS wins,
        SUM(loss_value) AS losses,
        SUM(draw_value) AS draws,
        SUM(points_for_value) AS points_for,
        SUM(points_against_value) AS points_against,
        SUM(margin_value) AS margin,
        ROUND(
          CASE
            WHEN ? = 'averages' THEN
              CASE
                WHEN ? = 'games' THEN 1.0
                WHEN ? = 'wins' THEN 1.0 * SUM(win_value) / NULLIF(COUNT(*), 0)
                WHEN ? = 'losses' THEN 1.0 * SUM(loss_value) / NULLIF(COUNT(*), 0)
                WHEN ? = 'draws' THEN 1.0 * SUM(draw_value) / NULLIF(COUNT(*), 0)
                WHEN ? = 'points_for' THEN 1.0 * SUM(points_for_value) / NULLIF(SUM(included_games), 0)
                WHEN ? = 'points_against' THEN 1.0 * SUM(points_against_value) / NULLIF(SUM(included_games), 0)
                WHEN ? = 'total_points' THEN 1.0 * SUM(total_points_value) / NULLIF(SUM(included_games), 0)
                ELSE 1.0 * SUM(margin_value) / NULLIF(SUM(included_games), 0)
              END
            ELSE
              CASE
                WHEN ? = 'games' THEN COUNT(*)
                WHEN ? = 'wins' THEN SUM(win_value)
                WHEN ? = 'losses' THEN SUM(loss_value)
                WHEN ? = 'draws' THEN SUM(draw_value)
                WHEN ? = 'points_for' THEN SUM(points_for_value)
                WHEN ? = 'points_against' THEN SUM(points_against_value)
                WHEN ? = 'total_points' THEN SUM(total_points_value)
                ELSE SUM(margin_value)
              END
          END,
          3
        ) AS stat_total
      FROM base
      GROUP BY ${grouping.groupBy.join(", ")}
      ORDER BY stat_total DESC, ${grouping.columns[0]} ASC
      ${postAggregateConditions.length ? "" : "LIMIT ?"}
    `;
    bindValues.push(mode, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey, statKey);
    if (!postAggregateConditions.length) bindValues.push(limit);
    const result = await db.prepare(sql).bind(...bindValues).all<QueryRow>();
    const rows = applyAggregateConditions(result.results ?? [], postAggregateConditions, statKey);
    return {
      ok: true,
      summary: `Top ${limit} teams by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}${scoreHalf !== "all" && ["points_for", "points_against", "total_points", "margin"].includes(statKey) ? ` using ${scoreHalf}-half scoring` : ""}.`,
      columns: [...grouping.columns, "stat_total", "games", "included_games", "wins", "losses", "draws", "points_for", "points_against", "margin"],
      rows: rows.slice(0, limit),
    };
  }

  if (scope === "team") {
    const teamFastPath = await runTeamJsonAggregateFastPath(db, statKey, limit, mode, format, seasonFrom, seasonTo, filters);
    if (teamFastPath) {
      return teamFastPath;
    }
    if (getDerivedRecipe("team", statKey)) {
      return runDerivedAggregateQuery(db, "team", statKey, limit, mode, format, seasonFrom, seasonTo, filters);
    }
    const teamFilters = buildTeamFilters(filters);
    const grouping = groupingColumns("team", format);
    const conditionStatKeys = uniqueConditionStatKeys(filters.conditions, statKey);
    const conditionColumns = buildTeamConditionAggregateColumns(conditionStatKeys, mode, filters.scoreHalf);
    const scoreDerivedStat = ["wins", "losses", "draws", "points_for", "points_against", "total_points", "margin"].includes(statKey);
    const includedFlag = scoreDerivedStat
      ? (normalizeScoreHalf(filters.scoreHalf) === "all"
          ? "1"
          : `CASE WHEN ${teamScoreStatExpression(statKey, filters.scoreHalf, "s", "os")} IS NOT NULL THEN 1 ELSE 0 END`)
      : TEAM_ZERO_IF_MISSING.has(statKey)
      ? "1"
      : `CASE WHEN s.season >= COALESCE(sd.first_consistent_season, 0) THEN 1 WHEN ${teamStatPresentExpr("s", "?")} THEN 1 ELSE 0 END`;
    const statValueExpr = scoreDerivedStat
      ? teamScoreStatExpression(statKey, filters.scoreHalf, "s", "os") ?? "0"
      : `COALESCE(${teamStatNumericExpr("s", "?")}, 0)`;
    const statExpr = mode === "averages"
      ? "ROUND(SUM(stat_value) / NULLIF(SUM(included_flag), 0), 3)"
      : "ROUND(SUM(stat_value), 3)";
    const sql = `
      WITH base AS (
        SELECT
          t.canonical_name AS team_name,
          s.season,
          s.match_id,
          m.round_label,
          COALESCE(ot.canonical_name, 'Unknown') AS opposition_name,
          COALESCE(v.canonical_name, 'Unknown') AS venue_name,
          COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
          ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
          ${statValueExpr} AS stat_value,
          ${includedFlag} AS included_flag${conditionColumns.baseSelect.length ? `,\n          ${conditionColumns.baseSelect.join(",\n          ")}` : ""}
        FROM team_match_summary s
        JOIN teams t ON t.team_id = s.team_id
        JOIN matches m ON m.match_id = s.match_id
        JOIN competitions c ON c.competition_id = m.competition_id
        LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
        LEFT JOIN venues v ON v.venue_id = m.venue_id
        LEFT JOIN team_match_summary os ON os.match_id = s.match_id AND os.team_id = s.opponent_team_id
        LEFT JOIN stat_definitions sd ON sd.scope = 'team' AND sd.stat_key = ?
        WHERE s.season BETWEEN ? AND ?
        ${teamFilters.sql}
      )
      SELECT
        ${grouping.select.join(", ")},
        MIN(season) AS first_season,
        MAX(season) AS last_season,
        COUNT(*) AS games,
        SUM(included_flag) AS included_games,
        ${statExpr} AS stat_total${conditionColumns.outerSelect.length ? `,\n        ${conditionColumns.outerSelect.join(",\n        ")}` : ""}
      FROM base
      GROUP BY ${grouping.groupBy.join(", ")}
      ORDER BY stat_total DESC, included_games DESC, team ASC
      LIMIT ?
    `;

    const bindValues = scoreDerivedStat
      ? [...conditionColumns.binds.slice(0, conditionColumns.baseBindCount), statKey, seasonFrom, seasonTo, ...teamFilters.binds, ...conditionColumns.binds.slice(conditionColumns.baseBindCount), limit]
      : TEAM_ZERO_IF_MISSING.has(statKey)
      ? [statKey, ...conditionColumns.binds.slice(0, conditionColumns.baseBindCount), statKey, seasonFrom, seasonTo, ...teamFilters.binds, ...conditionColumns.binds.slice(conditionColumns.baseBindCount), limit]
      : [statKey, statKey, ...conditionColumns.binds.slice(0, conditionColumns.baseBindCount), statKey, seasonFrom, seasonTo, ...teamFilters.binds, ...conditionColumns.binds.slice(conditionColumns.baseBindCount), limit];

    const result = await db.prepare(sql).bind(...bindValues).all<QueryRow>();
    const rows = applyAggregateConditions(result.results ?? [], filters.conditions, statKey);
    return {
      ok: true,
      summary: `Top ${limit} teams by ${mode === "averages" ? "average " : ""}${statKey.replace(/_/g, " ")} from ${seasonFrom} to ${seasonTo}${grouping.label !== "overall" ? ` by ${grouping.label}` : ""}.`,
      columns: [...grouping.columns, "stat_total", "games", "included_games", "first_season", "last_season"],
      rows: rows.slice(0, limit),
    };
  }

  return {
    ok: false,
    summary: "",
    columns: [],
    rows: [],
    error: `Query for scope='${scope}' stat='${statKey}' is not wired yet.`,
  };
}

async function runFullResultsRawQuery(
  db: D1Database,
  scope: string,
  seasonFrom: number,
  seasonTo: number,
  filters: QueryFilters
): Promise<{ ok: boolean; summary: string; rows: QueryRow[]; error?: string }> {
  if (scope === "player") {
    const playerFilters = buildPlayerFilters({ ...filters, conditions: [] });
    const sql = `
      SELECT
        COALESCE(p.display_name, s.player_name_raw) AS player,
        tt.canonical_name AS club,
        s.season,
        s.match_id,
        s.round_index,
        m.round_label AS round,
        COALESCE(ot.canonical_name, 'Unknown') AS opposition,
        COALESCE(v.canonical_name, 'Unknown') AS ground,
        COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
        ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
        s.stats_json
      FROM player_match_summary s
      LEFT JOIN players p ON p.player_id = s.player_id
      JOIN matches m ON m.match_id = s.match_id
      JOIN competitions c ON c.competition_id = m.competition_id
      JOIN teams tt ON tt.team_id = s.team_id
      LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
      LEFT JOIN venues v ON v.venue_id = m.venue_id
      WHERE s.season BETWEEN ? AND ?
      ${playerFilters.sql}
      ORDER BY player, s.season, s.round_index, match_sort_key
    `;
    const result = await db.prepare(sql).bind(seasonFrom, seasonTo, ...playerFilters.binds).all<QueryRow>();
    return {
      ok: true,
      summary: `Loaded ${(result.results ?? []).length} player match rows for full-results aggregation.`,
      rows: result.results ?? [],
    };
  }

  if (scope === "team") {
    const clauses: string[] = [];
    const binds: unknown[] = [];

    if (filters.competition !== "Any") {
      const competitionFilter = competitionFilterSql("src.competition", filters.competition);
      if (competitionFilter.sql) {
        clauses.push(competitionFilter.sql);
        binds.push(...competitionFilter.binds);
      }
    }
    if (filters.team !== "Any") {
      clauses.push("src.team = ?");
      binds.push(filters.team);
    }
    if (filters.opponent !== "Any") {
      clauses.push("src.opposition = ?");
      binds.push(filters.opponent);
    }
    if (filters.venue !== "Any") {
      clauses.push("src.ground = ?");
      binds.push(filters.venue);
    }
    if (filters.referee !== "Any") {
      clauses.push(`COALESCE(${teamStatTextExpr("src", "'referee'")}, 'Unknown') = ?`);
      binds.push(filters.referee);
    }
    if (filters.groundCondition !== "Any") {
      clauses.push(`COALESCE(${teamStatTextExpr("src", "'ground_condition'")}, 'Unknown') = ?`);
      binds.push(filters.groundCondition);
    }
    if (filters.weatherCondition !== "Any") {
      clauses.push(`COALESCE(${teamStatTextExpr("src", "'weather_condition'")}, 'Unknown') = ?`);
      binds.push(filters.weatherCondition);
    }
    if (filters.matchPlayer && filters.matchPlayer !== "Any") {
      clauses.push(`EXISTS (
        SELECT 1
        FROM player_match_summary mp
        LEFT JOIN players pp ON pp.player_id = mp.player_id
        WHERE mp.match_id = src.match_id
          AND COALESCE(pp.display_name, mp.player_name_raw) = ?
      )`);
      binds.push(filters.matchPlayer);
    }
    if (filters.homeAway === "home") {
      clauses.push("src.is_home = 1");
    } else if (filters.homeAway === "away") {
      clauses.push("src.is_home = 0");
    }
    if (filters.result === "win") {
      clauses.push("src.result_code = 'W'");
    } else if (filters.result === "loss") {
      clauses.push("src.result_code = 'L'");
    } else if (filters.result === "tie") {
      clauses.push("src.result_code = 'T'");
    }
    if (filters.roundFrom !== null) {
      clauses.push("src.round_index >= ?");
      binds.push(filters.roundFrom);
    }
    if (filters.roundTo !== null) {
      clauses.push("src.round_index <= ?");
      binds.push(filters.roundTo);
    }
    const seasonTypeExpr = buildSeasonTypeExpression("src", filters);
    if (seasonTypeExpr) {
      clauses.push(seasonTypeExpr);
    }

    const sql = `
      WITH source AS (
        SELECT
          ht.canonical_name AS team,
          c.name AS competition,
          m.season,
          m.match_id,
          m.round_index,
          m.round_label AS round_label,
          m.round_label AS round,
          m.is_finals,
          COALESCE(at.canonical_name, 'Unknown') AS opposition,
          COALESCE(v.canonical_name, 'Unknown') AS ground,
          COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
          ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
          1 AS is_home,
          m.home_score AS team_score,
          m.away_score AS opponent_score,
          CASE
            WHEN m.home_score > m.away_score THEN 'W'
            WHEN m.home_score < m.away_score THEN 'L'
            ELSE 'T'
          END AS result_code,
          hs.team_match_summary_id AS team_match_summary_id,
          hs.stats_json AS stats_json,
          asu.stats_json AS opponent_stats_json
        FROM matches m
        JOIN competitions c ON c.competition_id = m.competition_id
        JOIN teams ht ON ht.team_id = m.home_team_id
        JOIN teams at ON at.team_id = m.away_team_id
        LEFT JOIN venues v ON v.venue_id = m.venue_id
        LEFT JOIN team_match_summary hs ON hs.match_id = m.match_id AND hs.team_id = m.home_team_id
        LEFT JOIN team_match_summary asu ON asu.match_id = m.match_id AND asu.team_id = m.away_team_id
        WHERE m.season BETWEEN ? AND ?
          AND ${completedMatchPredicate("m")}

        UNION ALL

        SELECT
          at.canonical_name AS team,
          c.name AS competition,
          m.season,
          m.match_id,
          m.round_index,
          m.round_label AS round_label,
          m.round_label AS round,
          m.is_finals,
          COALESCE(ht.canonical_name, 'Unknown') AS opposition,
          COALESCE(v.canonical_name, 'Unknown') AS ground,
          COALESCE(m.match_date_local_text, m.match_date_utc) AS match_reference,
          ${matchSortKeySql("m.match_date_utc", "m.match_date_local_text")} AS match_sort_key,
          0 AS is_home,
          m.away_score AS team_score,
          m.home_score AS opponent_score,
          CASE
            WHEN m.away_score > m.home_score THEN 'W'
            WHEN m.away_score < m.home_score THEN 'L'
            ELSE 'T'
          END AS result_code,
          asu.team_match_summary_id AS team_match_summary_id,
          asu.stats_json AS stats_json,
          hs.stats_json AS opponent_stats_json
        FROM matches m
        JOIN competitions c ON c.competition_id = m.competition_id
        JOIN teams ht ON ht.team_id = m.home_team_id
        JOIN teams at ON at.team_id = m.away_team_id
        LEFT JOIN venues v ON v.venue_id = m.venue_id
        LEFT JOIN team_match_summary hs ON hs.match_id = m.match_id AND hs.team_id = m.home_team_id
        LEFT JOIN team_match_summary asu ON asu.match_id = m.match_id AND asu.team_id = m.away_team_id
        WHERE m.season BETWEEN ? AND ?
          AND ${completedMatchPredicate("m")}
      )
      SELECT *
      FROM source src
      ${clauses.length ? `WHERE ${clauses.join("\n        AND ")}` : ""}
      ORDER BY team, season, round_index, match_sort_key
    `;
    const result = await db.prepare(sql).bind(
      seasonFrom,
      seasonTo,
      seasonFrom,
      seasonTo,
      ...binds
    ).all<QueryRow>();
    return {
      ok: true,
      summary: `Loaded ${(result.results ?? []).length} team match rows for full-results aggregation.`,
      rows: result.results ?? [],
    };
  }

  return {
    ok: false,
    summary: "",
    rows: [],
    error: `Unsupported full-results scope '${scope}'.`,
  };
}

const FULL_RESULTS_SCORE_DERIVED_TEAM_STATS = new Set([
  "games",
  "wins",
  "losses",
  "draws",
  "points_for",
  "points_against",
  "total_points",
  "margin",
  "points_for_first_half",
  "points_against_first_half",
  "margin_first_half",
  "points_for_second_half",
  "points_against_second_half",
  "margin_second_half",
]);

type FullResultsAggregationParams = {
  scope: "player" | "team";
  format: string;
  mode: string;
  selectedStatKey: string;
  scoreHalf: string;
  conditions: QueryCondition[];
};

function fullResultsToNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === -1) return null;
  const numeric = Number(String(value).replace("%", ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function fullResultsGroupKey(scope: "player" | "team", format: string, row: QueryRow): string {
  if (format === "season") return [row[scope], row.season].join("||");
  if (format === "ground") return [row[scope], row.ground].join("||");
  if (format === "opposition") return [row[scope], row.opposition].join("||");
  if (scope === "player" && format === "club") return [row.player, row.club].join("||");
  if (format === "match") return [row[scope], row.match_id].join("||");
  return String(row[scope] ?? "");
}

function fullResultsCreateBaseRow(scope: "player" | "team", format: string, row: QueryRow): QueryRow {
  const base: QueryRow = {};
  if (scope === "player") base.player = row.player;
  if (scope === "team") base.team = row.team;
  if (format === "season") base.season = row.season;
  if (format === "ground") base.ground = row.ground;
  if (format === "opposition") base.opposition = row.opposition;
  if (scope === "player" && format === "club") base.club = row.club;
  if (format === "match") {
    base.season = row.season;
    base.round = row.round;
    base.opposition = row.opposition;
    base.ground = row.ground;
    if (scope === "player") base.club = row.club;
    base.match_reference = row.match_reference;
    base.match_id = row.match_id;
  }
  return base;
}

function fullResultsConditionPasses(left: number, operator: string, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "eq") return left === right;
  if (operator === "lt") return left < right;
  if (operator === "lte") return left <= right;
  if (operator === "neq") return left !== right;
  return true;
}

function fullResultsMatchesConditions(
  row: QueryRow,
  conditions: QueryCondition[],
  selectedStatKey: string,
  scoreHalf = "all",
): boolean {
  return matchesAggregateConditions(row, conditions, selectedStatKey, scoreHalf);
}

function fullResultsComputeTeamScoreStat(statKey: string, row: QueryRow, scoreHalf: string): number | null {
  const stats = (row.stats_json as QueryRow) || {};
  const opponentStats = (row.opponent_stats_json as QueryRow) || {};
  if (statKey === "games") return 1;
  if (statKey === "wins") return row.team_score > row.opponent_score ? 1 : 0;
  if (statKey === "losses") return row.team_score < row.opponent_score ? 1 : 0;
  if (statKey === "draws") return row.team_score === row.opponent_score ? 1 : 0;
  if (statKey === "points_for_first_half") return fullResultsToNumber(stats.points_for_first_half);
  if (statKey === "points_against_first_half") return fullResultsToNumber(stats.points_against_first_half);
  if (statKey === "margin_first_half") return fullResultsToNumber(stats.margin_first_half);
  if (statKey === "points_for_second_half") return fullResultsToNumber(stats.points_for_second_half);
  if (statKey === "points_against_second_half") return fullResultsToNumber(stats.points_against_second_half);
  if (statKey === "margin_second_half") return fullResultsToNumber(stats.margin_second_half);
  if (scoreHalf === "first") {
    if (statKey === "points_for" || statKey === "points_for_first_half") return fullResultsToNumber(stats.points_for_first_half);
    if (statKey === "points_against" || statKey === "points_against_first_half") return fullResultsToNumber(stats.points_against_first_half);
    if (statKey === "margin" || statKey === "margin_first_half") return fullResultsToNumber(stats.margin_first_half);
    if (statKey === "total_points") {
      const pf = fullResultsToNumber(stats.points_for_first_half);
      const pa = fullResultsToNumber(stats.points_against_first_half);
      return pf !== null && pa !== null ? pf + pa : null;
    }
  }
  if (scoreHalf === "second") {
    if (statKey === "points_for" || statKey === "points_for_second_half") return fullResultsToNumber(stats.points_for_second_half);
    if (statKey === "points_against" || statKey === "points_against_second_half") return fullResultsToNumber(stats.points_against_second_half);
    if (statKey === "margin" || statKey === "margin_second_half") return fullResultsToNumber(stats.margin_second_half);
    if (statKey === "total_points") {
      const pf = fullResultsToNumber(stats.points_for_second_half);
      const pa = fullResultsToNumber(stats.points_against_second_half);
      return pf !== null && pa !== null ? pf + pa : null;
    }
  }
  if (statKey === "points_for") return Number(row.team_score ?? 0);
  if (statKey === "points_against") return Number(row.opponent_score ?? 0);
  if (statKey === "total_points") return Number(row.team_score ?? 0) + Number(row.opponent_score ?? 0);
  if (statKey === "margin") return Number(row.team_score ?? 0) - Number(row.opponent_score ?? 0);
  if (statKey === "kick_defusal_weighted_numerator") return fullResultsToNumber(stats.kick_defusal_weighted_numerator);
  if (statKey === "opposition_kicks") return fullResultsToNumber(opponentStats.kicks);
  if (statKey === "average_play_the_ball_speed_weighted_numerator") return fullResultsToNumber(stats.average_play_the_ball_speed_weighted_numerator);
  if (statKey === "opposition_tackles_made") return fullResultsToNumber(opponentStats.tackles_made);
  return null;
}

function fullResultsGetStatValue(scope: "player" | "team", statKey: string, row: QueryRow, scoreHalf: string): number | null {
  const stats = (row.stats_json as QueryRow) || {};
  if (scope === "team" && FULL_RESULTS_SCORE_DERIVED_TEAM_STATS.has(statKey)) {
    return fullResultsComputeTeamScoreStat(statKey, row, scoreHalf);
  }
  if (scope === "player" && statKey === "games_played") return 1;
  if (scope === "player" && statKey === "points") {
    return (fullResultsToNumber(stats.tries) ?? 0) * 4
      + (fullResultsToNumber(stats.conversions) ?? 0) * 2
      + (fullResultsToNumber(stats.penalty_goals) ?? 0) * 2
      + (fullResultsToNumber(stats.field_goals_1pt) ?? 0)
      + (fullResultsToNumber(stats.field_goals_2pt) ?? 0) * 2;
  }
  return fullResultsToNumber(stats[statKey]);
}

function fullResultsIncludedForStat(
  definition: AppBootstrap["statDefinitions"][number],
  row: QueryRow,
  value: number | null,
  scope: "player" | "team",
  scoreHalf: string
): number {
  const halfSpecificTeamStats = new Set([
    "points_for_first_half",
    "points_against_first_half",
    "margin_first_half",
    "points_for_second_half",
    "points_against_second_half",
    "margin_second_half",
  ]);
  if (scope === "team" && FULL_RESULTS_SCORE_DERIVED_TEAM_STATS.has(definition.statKey)) {
    if (halfSpecificTeamStats.has(definition.statKey)) {
      if (value !== null) return 1;
      return Number(row.season ?? 0) >= Number(definition.firstConsistentSeason ?? 0) ? 1 : 0;
    }
    return scoreHalf === "all" ? 1 : (value === null ? 0 : 1);
  }
  if (definition.missingValueStrategy === "zero_if_missing") return 1;
  if (value !== null) return 1;
  return Number(row.season ?? 0) >= Number(definition.firstConsistentSeason ?? 0) ? 1 : 0;
}

function fullResultsHydrateRows(rawRows: QueryRow[]): QueryRow[] {
  return rawRows.map((row) => ({
    ...row,
    stats_json: typeof row.stats_json === "string" ? JSON.parse(row.stats_json || "{}") : (row.stats_json || {}),
    opponent_stats_json: row.opponent_stats_json
      ? (typeof row.opponent_stats_json === "string" ? JSON.parse(row.opponent_stats_json || "{}") : row.opponent_stats_json)
      : null,
  }));
}

function fullResultsSanitizeRow(row: QueryRow): QueryRow {
  const { __totals, __included, stats_json, opponent_stats_json, ...rest } = row;
  return rest;
}

function aggregateFullResultsRows(
  rawRows: QueryRow[],
  statDefinitions: AppBootstrap["statDefinitions"],
  options: FullResultsAggregationParams
): QueryRow[] {
  const { scope, format, mode, selectedStatKey, scoreHalf, conditions } = options;
  const recipes = DERIVED_STAT_RECIPES[scope] || {};
  const hydratedRows = fullResultsHydrateRows(rawRows);

  if (mode === "streaks") {
    const groups = new Map<string, QueryRow[]>();
    for (const row of hydratedRows) {
      const entity = scope === "player" ? row.player : row.team;
      const partition = format === "ground" ? row.ground : format === "opposition" ? row.opposition : "";
      const key = entity + "||" + partition;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(row);
    }

    const segments: QueryRow[][] = [];
    for (const rows of groups.values()) {
      rows.sort((a, b) => String(a.match_sort_key ?? "").localeCompare(String(b.match_sort_key ?? "")));
      let current: QueryRow[] = [];
      const flush = () => {
        if (!current.length) return;
        segments.push(current);
        current = [];
      };
      for (const row of rows) {
        const probe: QueryRow = { stat_total: fullResultsGetStatValue(scope, selectedStatKey, row, scoreHalf), included_games: 1 };
        for (const definition of statDefinitions) {
          probe[definition.statKey] = fullResultsGetStatValue(scope, definition.statKey, row, scoreHalf);
        }
        const hit = conditions.length
          ? fullResultsMatchesConditions(probe, conditions, selectedStatKey, scoreHalf)
          : Number(probe.stat_total ?? 0) > 0;
        if (hit) current.push(row);
        else flush();
      }
      flush();
    }

    return segments
      .map((segment) => {
        const first = segment[0];
        const last = segment[segment.length - 1];
        const bucket: QueryRow = {
          ...fullResultsCreateBaseRow(scope, format, first),
          streak: segment.length,
          games: segment.length,
          included_games: segment.length,
          first_game: `Season ${first.season} Rd ${first.round_index}`,
          last_game: `Season ${last.season} Rd ${last.round_index}`,
          __totals: {},
        };
        if (scope === "player") bucket.player = first.player;
        if (scope === "team") bucket.team = first.team;
        if (format === "ground") bucket.ground = first.ground;
        if (format === "opposition") bucket.opposition = first.opposition;

        for (const row of segment) {
          for (const definition of statDefinitions) {
            const value = fullResultsGetStatValue(scope, definition.statKey, row, scoreHalf);
            (bucket.__totals as QueryRow)[definition.statKey] = (((bucket.__totals as QueryRow)[definition.statKey] as number) || 0) + (value ?? 0);
          }
        }

        for (const definition of statDefinitions) {
          if (recipes[definition.statKey]) {
            const values = Object.fromEntries(
              recipes[definition.statKey].components.map((component) => [component, Number((bucket.__totals as QueryRow)[component] ?? 0)])
            );
            bucket[definition.statKey] = recipes[definition.statKey].compute(values);
          } else if (definition.isDerived && (definition.statKey === "games" || definition.statKey === "games_played")) {
            bucket[definition.statKey] = bucket.games;
          } else {
            bucket[definition.statKey] = (bucket.__totals as QueryRow)[definition.statKey] ?? null;
          }
        }

        bucket.stat_total = bucket[selectedStatKey] ?? null;
        if (scope === "team") {
          bucket.wins = (bucket.__totals as QueryRow).wins ?? 0;
          bucket.losses = (bucket.__totals as QueryRow).losses ?? 0;
          bucket.draws = (bucket.__totals as QueryRow).draws ?? 0;
          bucket.points_for = (bucket.__totals as QueryRow).points_for ?? 0;
          bucket.points_against = (bucket.__totals as QueryRow).points_against ?? 0;
          bucket.margin = (bucket.__totals as QueryRow).margin ?? 0;
        }
        return fullResultsSanitizeRow(bucket);
      })
      .sort((a, b) => Number(b.streak ?? 0) - Number(a.streak ?? 0));
  }

  const buckets = new Map<string, QueryRow>();
  for (const row of hydratedRows) {
    const key = fullResultsGroupKey(scope, format, row);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        ...fullResultsCreateBaseRow(scope, format, row),
        games: 0,
        included_games: 0,
        __totals: {},
        __included: {},
      };
      buckets.set(key, bucket);
    }
    bucket.games = Number(bucket.games ?? 0) + 1;
    for (const definition of statDefinitions) {
      const value = fullResultsGetStatValue(scope, definition.statKey, row, scoreHalf);
      const included = fullResultsIncludedForStat(definition, row, value, scope, scoreHalf);
      (bucket.__totals as QueryRow)[definition.statKey] = (((bucket.__totals as QueryRow)[definition.statKey] as number) || 0) + (value ?? 0);
      (bucket.__included as QueryRow)[definition.statKey] = (((bucket.__included as QueryRow)[definition.statKey] as number) || 0) + included;
    }
  }

  return [...buckets.values()]
    .map((bucket) => {
      for (const definition of statDefinitions) {
        if (recipes[definition.statKey]) {
          const values = Object.fromEntries(
            recipes[definition.statKey].components.map((component) => [component, Number((bucket.__totals as QueryRow)[component] ?? 0)])
          );
          bucket[definition.statKey] = recipes[definition.statKey].compute(values);
          continue;
        }
        if (definition.isDerived && (definition.statKey === "games" || definition.statKey === "games_played")) {
          bucket[definition.statKey] = bucket.games;
          continue;
        }
        const total = Number((bucket.__totals as QueryRow)[definition.statKey] ?? 0);
        const included = Number((bucket.__included as QueryRow)[definition.statKey] ?? 0);
        bucket[definition.statKey] = mode === "averages"
          ? (included > 0 ? Number((total / included).toFixed(3)) : null)
          : Number(total.toFixed(3));
      }
      bucket.stat_total = bucket[selectedStatKey] ?? null;
      bucket.included_games = (bucket.__included as QueryRow)[selectedStatKey] || bucket.games;
      if (scope === "team") {
        bucket.wins = (bucket.__totals as QueryRow).wins ?? 0;
        bucket.losses = (bucket.__totals as QueryRow).losses ?? 0;
        bucket.draws = (bucket.__totals as QueryRow).draws ?? 0;
        bucket.points_for = (bucket.__totals as QueryRow).points_for ?? 0;
        bucket.points_against = (bucket.__totals as QueryRow).points_against ?? 0;
        bucket.margin = (bucket.__totals as QueryRow).margin ?? 0;
      }
      return fullResultsSanitizeRow(bucket);
    })
    .filter((bucket) => fullResultsMatchesConditions(bucket, conditions, selectedStatKey, scoreHalf));
}

function fullResultsBaseColumns(scope: "player" | "team", format: string, mode: string): string[] {
  const columns = scope === "player"
    ? ["player", "stat_total", "games", "included_games"]
    : ["team", "stat_total", "games", "included_games", "wins", "losses", "draws", "points_for", "points_against", "margin"];
  if (format === "season") columns.splice(1, 0, "season");
  if (format === "club" && scope === "player") columns.splice(1, 0, "club");
  if (format === "ground") columns.splice(1, 0, "ground");
  if (format === "opposition") columns.splice(1, 0, "opposition");
  if (format === "match") {
    columns.splice(1, 0, "season", "round", "opposition", "ground", ...(scope === "player" ? ["club"] : []), "match_reference");
  }
  if (mode === "streaks") {
    columns.splice(1, 0, "streak", "first_game", "last_game");
  }
  return columns;
}

function trimRowsToColumns(rows: QueryRow[], columns: string[]): QueryRow[] {
  return rows.map((row) => {
    const trimmed: QueryRow = {};
    for (const column of columns) {
      trimmed[column] = row[column] ?? null;
    }
    return trimmed;
  });
}

function statKeysNeededForFullResults(
  definitions: AppBootstrap["statDefinitions"],
  columns: string[],
  selectedStatKey: string,
  sortColumn: string | null,
  conditions: QueryCondition[],
): Set<string> {
  const availableStatKeys = new Set(definitions.map((definition) => definition.statKey));
  const needed = new Set<string>();
  const addStat = (statKey: string | null | undefined) => {
    if (!statKey || !availableStatKeys.has(statKey)) return;
    needed.add(statKey);
    const recipe = getDerivedRecipe("player", statKey) || getDerivedRecipe("team", statKey);
    if (recipe) {
      for (const component of recipe.components) {
        if (availableStatKeys.has(component)) needed.add(component);
      }
    }
  };

  for (const column of columns) addStat(column);
  addStat(selectedStatKey);
  addStat(sortColumn);
  for (const condition of conditions) addStat(condition.statKey);
  return needed;
}

function fullResultsCompareValues(a: unknown, b: unknown): number {
  const aNum = Number(a);
  const bNum = Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function fullResultsEntityGroupKey(row: QueryRow, scope: "player" | "team", format: string): string | null {
  if (format === "overall") return null;
  if (format === "season") return `season:${String(row.season ?? "")}`;
  if (format === "club" && scope === "player") return `club:${String(row.club ?? "")}`;
  if (format === "ground") return `ground:${String(row.ground ?? "")}`;
  if (format === "opposition") return `opposition:${String(row.opposition ?? "")}`;
  if (format === "match") {
    if (row.match_id !== undefined && row.match_id !== null) return `match:${String(row.match_id)}`;
    return `match:${String(row.season ?? "")}|${String(row.round ?? "")}|${String(row.match_reference ?? "")}|${String(row.ground ?? "")}|${String(row.opposition ?? "")}`;
  }
  return null;
}

function collapseToSingleResultPerEntity(
  rows: QueryRow[],
  scope: "player" | "team",
  format: string,
  sortColumn: string,
  sortDirection: "asc" | "desc"
): QueryRow[] {
  if (!rows.length || format === "overall") return rows;
  const sorted = rows.slice().sort((left, right) => {
    const result = fullResultsCompareValues(left[sortColumn], right[sortColumn]);
    return sortDirection === "asc" ? result : -result;
  });
  const seen = new Set<string>();
  const collapsed: QueryRow[] = [];
  for (const row of sorted) {
    const key = fullResultsEntityGroupKey(row, scope, format);
    if (!key) {
      collapsed.push(row);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(row);
  }
  return collapsed;
}

function supportsFullResultsMode(
  definition: AppBootstrap["statDefinitions"][number],
  mode: "totals" | "averages" | "streaks"
): boolean {
  if (mode === "averages") return definition.supportsAverages;
  if (mode === "streaks") return definition.supportsStreaks;
  if (definition.supportsTotals) return true;
  return [
    "margin",
    "total_points",
    "points_for_first_half",
    "points_against_first_half",
    "margin_first_half",
    "points_for_second_half",
    "points_against_second_half",
    "margin_second_half",
  ].includes(definition.statKey);
}

function renderFullResultsPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - Full Stats</title>
    <style>
      :root {
        --bg: #f7f4ea;
        --panel: #fffdf6;
        --grid: #d7d1be;
        --text: #1f1c16;
        --muted: #5d5445;
        --accent: #2f5b84;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; color: var(--text); background: var(--bg); }
      .page { width: min(98vw, 2400px); max-width: 2400px; margin: 0 auto; padding: 12px; }
      .panel { background: var(--panel); border: 1px solid var(--grid); padding: 10px 12px; margin-bottom: 10px; overflow: hidden; }
      .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .title { margin: 0; font-size: 22px; }
      .hint, .filters-copy { color: var(--muted); font-size: 12px; line-height: 1.45; }
      .filters-copy strong { color: var(--text); }
      .group-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin-top: 10px; }
      details { border: 1px solid var(--grid); background: #fcfaf2; padding: 6px 8px; }
      summary { cursor: pointer; font-weight: 700; font-size: 12px; }
      .group-columns { margin-top: 6px; color: var(--muted); font-size: 12px; }
      #table-wrap { width: 100%; max-width: 100%; overflow: auto; }
      table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid var(--grid); padding: 5px 6px; text-align: left; vertical-align: top; }
      th { background: #efe8d7; cursor: pointer; white-space: nowrap; position: sticky; top: 0; z-index: 1; }
      td { color: var(--text); white-space: nowrap; }
      th.active-sort::after { margin-left: 4px; font-size: 11px; }
      th.sort-asc::after { content: "▲"; }
      th.sort-desc::after { content: "▼"; }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      button { border: 1px solid var(--grid); background: #f1ebdc; padding: 6px 9px; font-size: 12px; cursor: pointer; }
      .loading { color: var(--muted); font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="panel">
        <div class="toolbar">
          <button type="button" id="back-button">Back to Stat Builder</button>
          <h1 class="title">Full Stats</h1>
          <a href="/auth/logout" style="margin-left:auto;">Log Out</a>
        </div>
        <p class="hint" id="summary-copy">Preparing full results...</p>
        <div class="filters-copy" id="filters-copy"></div>
      </section>

      <section class="panel">
        <div class="toolbar">
          <strong>Column Groups</strong>
          <span class="hint">Open a group to add those stats to the table. Base columns stay visible.</span>
        </div>
        <div id="group-grid" class="group-grid"></div>
      </section>

      <section class="panel">
        <div class="toolbar">
          <strong id="row-count">0 rows</strong>
          <span class="hint">All columns remain sortable.</span>
          <button type="button" id="page-prev">Prev</button>
          <span class="hint" id="page-label">Page 1 of 1</span>
          <button type="button" id="page-next">Next</button>
        </div>
        <div id="table-scrollbar" style="overflow-x:auto;overflow-y:hidden;"><div id="table-scrollbar-inner" style="height:1px;"></div></div>
        <div id="table-wrap" class="loading">Loading full results...</div>
      </section>
    </div>

    <script>
      const scoreDerivedTeamStats = new Set(["games", "wins", "losses", "draws", "points_for", "points_against", "total_points", "margin", "points_for_first_half", "points_against_first_half", "margin_first_half", "points_for_second_half", "points_against_second_half", "margin_second_half"]);
      const derivedRecipes = {
        player: {
          goal_conversion_rate: {
            components: ["conversions_with_attempts", "conversion_attempts"],
            compute: (values) => values.conversion_attempts > 0 ? (values.conversions_with_attempts * 100) / values.conversion_attempts : null,
          },
          average_play_the_ball_speed: {
            components: ["play_the_ball_total_seconds", "play_the_ball"],
            compute: (values) => values.play_the_ball > 0 ? values.play_the_ball_total_seconds / values.play_the_ball : null,
          },
          passes_to_run_ratio: {
            components: ["passes", "all_runs"],
            compute: (values) => values.all_runs > 0 ? values.passes / values.all_runs : null,
          },
          tackle_efficiency: {
            components: ["tackles_made", "tackle_attempts"],
            compute: (values) => values.tackle_attempts > 0 ? (values.tackles_made * 100) / values.tackle_attempts : null,
          },
        },
        team: {
          kick_defusal: {
            components: ["kick_defusal_weighted_numerator", "opposition_kicks"],
            compute: (values) => values.opposition_kicks > 0 ? values.kick_defusal_weighted_numerator / values.opposition_kicks : null,
          },
          average_play_the_ball_speed: {
            components: ["average_play_the_ball_speed_weighted_numerator", "opposition_tackles_made"],
            compute: (values) => values.opposition_tackles_made > 0 ? values.average_play_the_ball_speed_weighted_numerator / values.opposition_tackles_made : null,
          },
          average_set_distance: {
            components: ["all_run_metres", "sets"],
            compute: (values) => values.sets > 0 ? values.all_run_metres / values.sets : null,
          },
          completion_rate: {
            components: ["completed_sets", "sets"],
            compute: (values) => values.sets > 0 ? (values.completed_sets * 100) / values.sets : null,
          },
          effective_tackle: {
            components: ["tackles_made", "tackle_attempts"],
            compute: (values) => values.tackle_attempts > 0 ? (values.tackles_made * 100) / values.tackle_attempts : null,
          },
          goal_conversion_rate: {
            components: ["conversions_with_attempts", "conversion_attempts"],
            compute: (values) => values.conversion_attempts > 0 ? (values.conversions_with_attempts * 100) / values.conversion_attempts : null,
          },
        },
      };

      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.search);
      const summaryCopy = document.getElementById("summary-copy");
      const filtersCopy = document.getElementById("filters-copy");
      const groupGrid = document.getElementById("group-grid");
      const tableScrollbar = document.getElementById("table-scrollbar");
      const tableScrollbarInner = document.getElementById("table-scrollbar-inner");
      const tableWrap = document.getElementById("table-wrap");
      const rowCount = document.getElementById("row-count");
      const pagePrev = document.getElementById("page-prev");
      const pageNext = document.getElementById("page-next");
      const pageLabel = document.getElementById("page-label");
      const backButton = document.getElementById("back-button");
      const baseColumnsByScope = {
        player: ["player", "stat_total", "games", "included_games"],
        team: ["team", "stat_total", "games", "included_games", "wins", "losses", "draws", "points_for", "points_against", "margin"],
      };

      let bootstrapCache = null;
      let fullRows = [];
      let visibleColumns = [];
      let availableColumns = [];
      let sortColumn = null;
      let sortDirection = "desc";
      let currentPage = 1;
      let totalPages = 1;
      let totalRows = 0;
      let activeLoadController = null;
      let activeLoadRunId = 0;
      let initController = null;
      let isPageActive = true;

      backButton.addEventListener("click", () => {
        window.location.assign("/app-fixed");
      });
      pagePrev.addEventListener("click", () => {
        if (currentPage > 1) loadResults(currentPage - 1).catch((error) => {
          if (error instanceof Error && error.name === "AbortError") return;
          summaryCopy.textContent = error instanceof Error ? error.message : String(error);
        });
      });
      pageNext.addEventListener("click", () => {
        if (currentPage < totalPages) loadResults(currentPage + 1).catch((error) => {
          if (error instanceof Error && error.name === "AbortError") return;
          summaryCopy.textContent = error instanceof Error ? error.message : String(error);
        });
      });
      window.addEventListener("pagehide", () => {
        isPageActive = false;
        if (activeLoadController) activeLoadController.abort();
        if (initController) initController.abort();
      });
      window.addEventListener("beforeunload", () => {
        isPageActive = false;
        if (activeLoadController) activeLoadController.abort();
        if (initController) initController.abort();
      });

      function toNumber(value) {
        if (value === null || value === undefined || value === "" || value === -1) return null;
        const numeric = Number(String(value).replace("%", ""));
        return Number.isFinite(numeric) ? numeric : null;
      }

      function compareValues(a, b) {
        const aNum = Number(a);
        const bNum = Number(b);
        if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
          return aNum - bNum;
        }
        return String(a ?? "").localeCompare(String(b ?? ""));
      }

      function setLoadingState(message) {
        summaryCopy.textContent = message;
        tableWrap.classList.add("loading");
        tableWrap.setAttribute("aria-busy", "true");
        pagePrev.disabled = true;
        pageNext.disabled = true;
        backButton.disabled = true;
      }

      function clearLoadingState() {
        tableWrap.classList.remove("loading");
        tableWrap.removeAttribute("aria-busy");
        backButton.disabled = false;
        pagePrev.disabled = currentPage <= 1;
        pageNext.disabled = currentPage >= totalPages;
      }

      function columnLabel(column) {
        const labels = {
          player: "Player",
          team: "Team",
          club: "Club",
          season: "Season",
          round: "Round",
          opposition: "Opposition",
          ground: "Ground",
          match_reference: "Match",
          games: "Games",
          included_games: "Included Games",
          stat_total: "Selected Stat",
          first_game: "First Game",
          last_game: "Last Game",
          streak: "Streak",
        };
        const definition = (bootstrapCache?.statDefinitions || []).find((item) => item.statKey === column);
        return definition?.displayName || labels[column] || column.replace(/_/g, " ");
      }

      function supportsFullResultsClient(definition, mode) {
        if (mode === "averages") return definition.supportsAverages;
        if (mode === "streaks") return definition.supportsStreaks;
        if (definition.supportsTotals) return true;
        return [
          "margin",
          "total_points",
          "points_for_first_half",
          "points_against_first_half",
          "margin_first_half",
          "points_for_second_half",
          "points_against_second_half",
          "margin_second_half",
        ].includes(definition.statKey);
      }

      function syncScrollbars() {
        const table = tableWrap.querySelector("table");
        const width = table ? table.scrollWidth : tableWrap.scrollWidth;
        tableScrollbarInner.style.width = width + "px";
        tableScrollbar.style.display = width > tableWrap.clientWidth ? "block" : "none";
      }

      tableScrollbar.addEventListener("scroll", () => {
        tableWrap.scrollLeft = tableScrollbar.scrollLeft;
      });
      tableWrap.addEventListener("scroll", () => {
        tableScrollbar.scrollLeft = tableWrap.scrollLeft;
      });

      function summariseFilters() {
        const entries = [];
        for (const [key, value] of params.entries()) {
          if (!value || value === "Any" || value === "any" || value === "[]" || key === "limit") continue;
          entries.push("<strong>" + key + ":</strong> " + value);
        }
        filtersCopy.innerHTML = entries.join(" | ");
      }

      function groupKey(scope, format, row) {
        if (format === "season") return [row[scope], row.season].join("||");
        if (format === "ground") return [row[scope], row.ground].join("||");
        if (format === "opposition") return [row[scope], row.opposition].join("||");
        if (scope === "player" && format === "club") return [row.player, row.club].join("||");
        if (format === "match") return [row[scope], row.match_id].join("||");
        return String(row[scope] ?? "");
      }

      function createBaseRow(scope, format, row) {
        const base = {};
        if (scope === "player") base.player = row.player;
        if (scope === "team") base.team = row.team;
        if (format === "season") base.season = row.season;
        if (format === "ground") base.ground = row.ground;
        if (format === "opposition") base.opposition = row.opposition;
        if (scope === "player" && format === "club") base.club = row.club;
        if (format === "match") {
          base.season = row.season;
          base.round = row.round;
          base.opposition = row.opposition;
          base.ground = row.ground;
          if (scope === "player") base.club = row.club;
          base.match_reference = row.match_reference;
          base.match_id = row.match_id;
        }
        return base;
      }

      function baseColumnsForCurrentView(scope, format, mode) {
        const columns = baseColumnsByScope[scope].slice();
        if (format === "season") columns.splice(1, 0, "season");
        if (format === "club" && scope === "player") columns.splice(1, 0, "club");
        if (format === "ground") columns.splice(1, 0, "ground");
        if (format === "opposition") columns.splice(1, 0, "opposition");
        if (format === "match") {
          columns.splice(1, 0, "season", "round", "opposition", "ground", ...(scope === "player" ? ["club"] : []), "match_reference");
        }
        if (mode === "streaks") {
          columns.splice(1, 0, "streak", "first_game", "last_game");
        }
        return columns;
      }

      function conditionPasses(left, operator, right) {
        if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
        if (operator === "gt") return left > right;
        if (operator === "gte") return left >= right;
        if (operator === "eq") return left === right;
        if (operator === "lt") return left < right;
        if (operator === "lte") return left <= right;
        if (operator === "neq") return left !== right;
        return true;
      }

      function matchesConditions(row, conditions, selectedStatKey) {
        let result = null;
        for (const condition of conditions) {
          const left =
            condition.statKey === "games_included"
              ? Number(row.included_games ?? 0)
              : (condition.statKey === "games_played" || condition.statKey === "games")
                ? Number(row.games ?? 0)
              : Number(row[condition.statKey] ?? (condition.statKey === selectedStatKey ? row.stat_total : NaN));
          const passed = conditionPasses(left, condition.operator, Number(condition.value));
          if (result === null) {
            result = passed;
          } else if (condition.joiner === "OR") {
            result = result || passed;
          } else if (condition.joiner === "AND NOT") {
            result = result && !passed;
          } else {
            result = result && passed;
          }
        }
        return result ?? true;
      }

      function computeTeamScoreStat(statKey, row, scoreHalf) {
        const stats = row.stats_json || {};
        const opponentStats = row.opponent_stats_json || {};
        if (statKey === "games") return 1;
        if (statKey === "wins") return row.team_score > row.opponent_score ? 1 : 0;
        if (statKey === "losses") return row.team_score < row.opponent_score ? 1 : 0;
        if (statKey === "draws") return row.team_score === row.opponent_score ? 1 : 0;
        if (scoreHalf === "first") {
          if (statKey === "points_for" || statKey === "points_for_first_half") return toNumber(stats.points_for_first_half);
          if (statKey === "points_against" || statKey === "points_against_first_half") return toNumber(stats.points_against_first_half);
          if (statKey === "margin" || statKey === "margin_first_half") return toNumber(stats.margin_first_half);
          if (statKey === "total_points") {
            const pf = toNumber(stats.points_for_first_half);
            const pa = toNumber(stats.points_against_first_half);
            return pf !== null && pa !== null ? pf + pa : null;
          }
        }
        if (scoreHalf === "second") {
          if (statKey === "points_for" || statKey === "points_for_second_half") return toNumber(stats.points_for_second_half);
          if (statKey === "points_against" || statKey === "points_against_second_half") return toNumber(stats.points_against_second_half);
          if (statKey === "margin" || statKey === "margin_second_half") return toNumber(stats.margin_second_half);
          if (statKey === "total_points") {
            const pf = toNumber(stats.points_for_second_half);
            const pa = toNumber(stats.points_against_second_half);
            return pf !== null && pa !== null ? pf + pa : null;
          }
        }
        if (statKey === "points_for") return Number(row.team_score ?? 0);
        if (statKey === "points_against") return Number(row.opponent_score ?? 0);
        if (statKey === "total_points") return Number(row.team_score ?? 0) + Number(row.opponent_score ?? 0);
        if (statKey === "margin") return Number(row.team_score ?? 0) - Number(row.opponent_score ?? 0);
        if (statKey === "kick_defusal_weighted_numerator") return toNumber(stats.kick_defusal_weighted_numerator);
        if (statKey === "opposition_kicks") return toNumber(opponentStats.kicks);
        if (statKey === "average_play_the_ball_speed_weighted_numerator") return toNumber(stats.average_play_the_ball_speed_weighted_numerator);
        if (statKey === "opposition_tackles_made") return toNumber(opponentStats.tackles_made);
        return null;
      }

      function getStatValue(scope, statKey, row, scoreHalf) {
        const stats = row.stats_json || {};
        if (scope === "team" && scoreDerivedTeamStats.has(statKey)) {
          return computeTeamScoreStat(statKey, row, scoreHalf);
        }
        if (scope === "player" && statKey === "games_played") return 1;
        if (scope === "player" && statKey === "points") {
          return (toNumber(stats.tries) ?? 0) * 4
            + (toNumber(stats.conversions) ?? 0) * 2
            + (toNumber(stats.penalty_goals) ?? 0) * 2
            + (toNumber(stats.field_goals_1pt) ?? 0)
            + (toNumber(stats.field_goals_2pt) ?? 0) * 2;
        }
        return toNumber(stats[statKey]);
      }

      function includedForStat(definition, row, value, scope, scoreHalf) {
        if (scope === "team" && scoreDerivedTeamStats.has(definition.statKey)) {
          return scoreHalf === "all" ? 1 : (value === null ? 0 : 1);
        }
        if (definition.missingValueStrategy === "zero_if_missing") return 1;
        if (value !== null) return 1;
        return Number(row.season ?? 0) >= Number(definition.firstConsistentSeason ?? 0) ? 1 : 0;
      }

      function hydrateRawRows(rawRows) {
        return rawRows.map((row) => ({
          ...row,
          stats_json: typeof row.stats_json === "string" ? JSON.parse(row.stats_json || "{}") : (row.stats_json || {}),
          opponent_stats_json: row.opponent_stats_json
            ? (typeof row.opponent_stats_json === "string" ? JSON.parse(row.opponent_stats_json || "{}") : row.opponent_stats_json)
            : null,
        }));
      }

      function aggregateRegularRows(rawRows, statDefinitions) {
        const scope = params.get("scope") || "player";
        const format = params.get("format") || "overall";
        const mode = params.get("mode") || "totals";
        const scoreHalf = params.get("scoreHalf") || "all";
        const selectedStatKey = params.get("statKey") || "tries";
        const conditions = JSON.parse(params.get("conditions") || "[]");
        const buckets = new Map();
        const recipes = derivedRecipes[scope] || {};

        for (const row of rawRows) {
          const key = groupKey(scope, format, row);
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              ...createBaseRow(scope, format, row),
              games: 0,
              included_games: 0,
              __totals: {},
              __included: {},
            };
            buckets.set(key, bucket);
          }
          bucket.games += 1;
          for (const definition of statDefinitions) {
            const value = getStatValue(scope, definition.statKey, row, scoreHalf);
            const included = includedForStat(definition, row, value, scope, scoreHalf);
            bucket.__totals[definition.statKey] = (bucket.__totals[definition.statKey] || 0) + (value ?? 0);
            bucket.__included[definition.statKey] = (bucket.__included[definition.statKey] || 0) + included;
          }
        }

        const rows = [...buckets.values()].map((bucket) => {
          for (const definition of statDefinitions) {
            if (recipes[definition.statKey]) {
              const values = {};
              for (const component of recipes[definition.statKey].components) {
                values[component] = bucket.__totals[component] || 0;
              }
              bucket[definition.statKey] = recipes[definition.statKey].compute(values);
              continue;
            }
            if (definition.isDerived && (definition.statKey === "games" || definition.statKey === "games_played")) {
              bucket[definition.statKey] = bucket.games;
              continue;
            }
            const total = bucket.__totals[definition.statKey] || 0;
            const included = bucket.__included[definition.statKey] || 0;
            bucket[definition.statKey] = mode === "averages"
              ? (included > 0 ? Number((total / included).toFixed(3)) : null)
              : Number(total.toFixed(3));
          }
          bucket.stat_total = bucket[selectedStatKey] ?? null;
          bucket.included_games = bucket.__included[selectedStatKey] || bucket.games;
          if (scope === "team") {
            bucket.wins = bucket.__totals.wins ?? 0;
            bucket.losses = bucket.__totals.losses ?? 0;
            bucket.draws = bucket.__totals.draws ?? 0;
            bucket.points_for = bucket.__totals.points_for ?? 0;
            bucket.points_against = bucket.__totals.points_against ?? 0;
            bucket.margin = bucket.__totals.margin ?? 0;
          }
          return bucket;
        }).filter((bucket) => matchesConditions(bucket, conditions, selectedStatKey));

        return rows;
      }

      function aggregateStreakRows(rawRows, statDefinitions) {
        const scope = params.get("scope") || "player";
        const format = params.get("format") || "overall";
        const scoreHalf = params.get("scoreHalf") || "all";
        const selectedStatKey = params.get("statKey") || "tries";
        const conditions = JSON.parse(params.get("conditions") || "[]");
        const recipes = derivedRecipes[scope] || {};
        const groups = new Map();

        for (const row of rawRows) {
          const entity = scope === "player" ? row.player : row.team;
          const partition = format === "ground" ? row.ground : format === "opposition" ? row.opposition : "";
          const key = entity + "||" + partition;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(row);
        }

        const segments = [];
        for (const rows of groups.values()) {
          rows.sort((a, b) => String(a.match_sort_key ?? "").localeCompare(String(b.match_sort_key ?? "")));
          let current = [];
          const flush = () => {
            if (!current.length) return;
            segments.push(current);
            current = [];
          };
          for (const row of rows) {
            const probe = { stat_total: getStatValue(scope, selectedStatKey, row, scoreHalf), included_games: 1 };
            for (const definition of statDefinitions) {
              probe[definition.statKey] = getStatValue(scope, definition.statKey, row, scoreHalf);
            }
            const hit = conditions.length ? matchesConditions(probe, conditions, selectedStatKey) : Number(probe.stat_total ?? 0) > 0;
            if (hit) current.push(row); else flush();
          }
          flush();
        }

        return segments.map((segment) => {
          const first = segment[0];
          const last = segment[segment.length - 1];
          const bucket = {
            ...createBaseRow(scope, format, first),
            streak: segment.length,
            games: segment.length,
            included_games: segment.length,
            first_game: "Season " + first.season + " Rd " + first.round_index,
            last_game: "Season " + last.season + " Rd " + last.round_index,
            __totals: {},
          };
          if (scope === "player") bucket.player = first.player;
          if (scope === "team") bucket.team = first.team;
          if (format === "ground") bucket.ground = first.ground;
          if (format === "opposition") bucket.opposition = first.opposition;

          for (const row of segment) {
            for (const definition of statDefinitions) {
              const value = getStatValue(scope, definition.statKey, row, scoreHalf);
              bucket.__totals[definition.statKey] = (bucket.__totals[definition.statKey] || 0) + (value ?? 0);
            }
          }

          for (const definition of statDefinitions) {
            if (recipes[definition.statKey]) {
              const values = {};
              for (const component of recipes[definition.statKey].components) {
                values[component] = bucket.__totals[component] || 0;
              }
              bucket[definition.statKey] = recipes[definition.statKey].compute(values);
            } else if (definition.isDerived && (definition.statKey === "games" || definition.statKey === "games_played")) {
              bucket[definition.statKey] = bucket.games;
            } else {
              bucket[definition.statKey] = bucket.__totals[definition.statKey] ?? null;
            }
          }

          bucket.stat_total = bucket[selectedStatKey] ?? null;
          if (scope === "team") {
            bucket.wins = bucket.__totals.wins ?? 0;
            bucket.losses = bucket.__totals.losses ?? 0;
            bucket.draws = bucket.__totals.draws ?? 0;
            bucket.points_for = bucket.__totals.points_for ?? 0;
            bucket.points_against = bucket.__totals.points_against ?? 0;
            bucket.margin = bucket.__totals.margin ?? 0;
          }
          return bucket;
        }).sort((a, b) => Number(b.streak ?? 0) - Number(a.streak ?? 0));
      }

      function renderGroupControls(statDefinitions) {
        const grouped = new Map();
        for (const definition of statDefinitions) {
          const label = definition.groupLabel || definition.groupCode;
          if (!grouped.has(definition.groupCode)) grouped.set(definition.groupCode, { label, items: [] });
          grouped.get(definition.groupCode).items.push(definition);
        }
        groupGrid.innerHTML = [...grouped.entries()].map(([groupCode, value]) => {
          const open = true;
          return '<details data-group="' + groupCode + '"' + (open ? " open" : "") + '><summary>' + value.label + '</summary><div class="group-columns">' + value.items.map((item) => item.displayName).join(", ") + '</div></details>';
        }).join("");
        groupGrid.querySelectorAll("details").forEach((detail) => detail.addEventListener("toggle", () => loadResults(1)));
      }

      function buildDetailUrl(overrides) {
        const next = new URLSearchParams(params.toString());
        Object.entries(overrides).forEach(([key, value]) => next.set(key, value));
        return "/full-results?" + next.toString();
      }

      function buildRoundAnchor(roundLabel) {
        const normalized = String(roundLabel || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        return "round-" + (normalized || "unknown");
      }

      function buildSeasonIndexHref(season, roundLabel) {
        const next = new URLSearchParams();
        next.set("competition", params.get("competition") || "NRL");
        next.set("season", String(season || ""));
        return "/season?" + next.toString() + (roundLabel ? ("#" + buildRoundAnchor(roundLabel)) : "");
      }

      function renderTable() {
        if (!fullRows.length) {
          rowCount.textContent = "0 rows";
          pageLabel.textContent = "Page 1 of 1";
          tableWrap.textContent = "No rows found for this search.";
          return;
        }
        const scope = params.get("scope") || "player";
        const mode = params.get("mode") || "totals";
        const openGroups = new Set([...groupGrid.querySelectorAll("details[open]")].map((detail) => detail.dataset.group));
        const groupedColumns = (bootstrapCache.statDefinitions || [])
          .filter((definition) => definition.scope === scope && openGroups.has(definition.groupCode))
          .filter((definition) => !availableColumns.length || availableColumns.includes(definition.statKey))
          .map((definition) => definition.statKey);
        const format = params.get("format") || "overall";
        const baseColumns = baseColumnsForCurrentView(scope, format, mode)
          .filter((column) => !availableColumns.length || availableColumns.includes(column));
        visibleColumns = [...new Set([...baseColumns, ...groupedColumns])].filter((column) => column !== "match_id" && column !== "match_sort_key");
        rowCount.textContent = totalRows + " rows";
        pageLabel.textContent = "Page " + currentPage + " of " + totalPages;
        pagePrev.disabled = currentPage <= 1;
        pageNext.disabled = currentPage >= totalPages;
        tableWrap.innerHTML =
          "<table><thead><tr>" +
          visibleColumns.map((column) => '<th data-column="' + column + '" class="' + (sortColumn === column ? 'active-sort sort-' + sortDirection : "") + '">' + columnLabel(column) + "</th>").join("") +
          "</tr></thead><tbody>" +
          fullRows.map((row) => "<tr>" + visibleColumns.map((column) => {
            let value = row[column];
            if (column === "player" && value) {
              value =
                '<a href="/player/' +
                encodeURIComponent(String(row.player)) +
                '?competition=' +
                encodeURIComponent(competitionSelect.value || "NRL") +
                '">' +
                value +
                "</a>";
            } else if (column === "season" && row.season && !row.__summary) {
              value = '<a href="' + buildSeasonIndexHref(row.season, format === "match" ? row.round : "") + '">' + String(row.season) + "</a>";
            } else if (column === "round" && row.round && row.season) {
              value = '<a href="' + buildSeasonIndexHref(row.season, row.round) + '">' + String(row.round) + "</a>";
            } else if (column === "team" && value) {
              value = '<a href="' + buildDetailUrl({ scope: "team", team: String(row.team), mode: "totals", format: "overall" }) + '">' + value + "</a>";
            } else if (column === "match_reference" && row.match_id) {
              value = '<a href="/match/' + row.match_id + '">' + (value || "Match") + "</a>";
            }
            return "<td>" + (value ?? "") + "</td>";
          }).join("") + "</tr>").join("") +
          "</tbody></table>";

        tableWrap.querySelectorAll("th[data-column]").forEach((header) => {
          header.addEventListener("click", () => {
            const column = header.dataset.column;
            const columnLabelText = columnLabel(column);
            if (sortColumn === column) {
              sortDirection = sortDirection === "asc" ? "desc" : "asc";
            } else {
              sortColumn = column;
              sortDirection = "desc";
            }
            loadResults(1, "Sorting by " + columnLabelText + "...");
          });
        });
        syncScrollbars();
      }

      function selectedColumnsForRequest() {
        const scope = params.get("scope") || "player";
        const mode = params.get("mode") || "totals";
        const format = params.get("format") || "overall";
        const selectedStatKey = params.get("statKey") || (scope === "team" ? "wins" : "tries");
        const openGroups = new Set([...groupGrid.querySelectorAll("details[open]")].map((detail) => detail.dataset.group));
        const groupedColumns = (bootstrapCache.statDefinitions || [])
          .filter((definition) => definition.scope === scope && openGroups.has(definition.groupCode))
          .map((definition) => definition.statKey);
        const baseColumns = baseColumnsForCurrentView(scope, format, mode);
        return [...new Set([...baseColumns, selectedStatKey, sortColumn, ...groupedColumns])]
          .filter((column) => column && column !== "match_id" && column !== "match_sort_key");
      }

      async function loadResults(nextPage, loadingMessage) {
        const runId = ++activeLoadRunId;
        if (activeLoadController) activeLoadController.abort();
        const controller = new AbortController();
        activeLoadController = controller;
        if (nextPage) params.set("page", String(nextPage));
        if (!params.get("pageSize")) params.set("pageSize", "200");
        if (sortColumn) params.set("sortColumn", sortColumn);
        if (sortDirection) params.set("sortDirection", sortDirection);
        params.set("columns", selectedColumnsForRequest().join(","));
        const scope = params.get("scope") || "player";
        const format = params.get("format") || "overall";
        const mode = params.get("mode") || "totals";
        setLoadingState(loadingMessage || ("Loading " + scope + " " + format + " " + mode + " results..."));
        try {
          const rawResponse = await fetch("/api/query/full?" + params.toString(), {
            cache: "no-store",
            headers: { "cache-control": "no-cache" },
            signal: controller.signal,
          });
          const rawText = await rawResponse.text();
          let rawPayload;
          try {
            rawPayload = JSON.parse(rawText);
          } catch {
            throw new Error(rawText || ("Unable to load full results (status " + rawResponse.status + ")."));
          }
          if (runId !== activeLoadRunId || !isPageActive) return;
          if (!rawPayload.ok) {
            throw new Error(rawPayload.error || "Unable to load full results.");
          }
          fullRows = rawPayload.rows || [];
          availableColumns = rawPayload.allColumns || rawPayload.columns || [];
          totalRows = Number(rawPayload.totalRows || 0);
          currentPage = Number(rawPayload.page || 1);
          totalPages = Number(rawPayload.totalPages || 1);
          sortColumn = rawPayload.sortColumn || sortColumn;
          sortDirection = rawPayload.sortDirection || sortDirection;
          summaryCopy.textContent = rawPayload.summary || "Full results ready.";
          renderTable();
        } catch (error) {
          if (runId !== activeLoadRunId || !isPageActive) return;
          if (error instanceof Error && error.name === "AbortError") return;
          throw error;
        } finally {
          if (runId === activeLoadRunId) {
            activeLoadController = null;
            clearLoadingState();
          }
        }
      }

      async function init() {
        initController = new AbortController();
        const bootstrapResponse = await fetch("/api/meta/bootstrap", {
          cache: "no-store",
          headers: { "cache-control": "no-cache" },
          signal: initController.signal,
        });
        bootstrapCache = await bootstrapResponse.json();
        const statDefinitions = (bootstrapCache.statDefinitions || []).map((definition) => ({
          ...definition,
          groupLabel: definition.groupCode,
        }));
        const groupLabelMap = Object.fromEntries((bootstrapCache.statGroups || []).map((group) => [group.code, group.label]));
        for (const definition of statDefinitions) {
          definition.groupLabel = groupLabelMap[definition.groupCode] || definition.groupCode;
        }
        bootstrapCache.statDefinitions = statDefinitions.filter((definition) => {
          const mode = params.get("mode") || "totals";
          if (definition.scope !== (params.get("scope") || "player")) return false;
          if (["games_included", "half_time", "penalty_goals", "conversions", "conversions_with_attempts", "conversion_attempts", "goal_conversion_rate", "fantasy_points"].includes(definition.statKey)) return false;
          return supportsFullResultsClient(definition, mode);
        });

        summariseFilters();
        renderGroupControls(bootstrapCache.statDefinitions);
        await loadResults(Number(params.get("page") || "1"), "Preparing full results...");
      }

      init().catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        summaryCopy.textContent = error instanceof Error ? error.message : String(error);
        tableWrap.textContent = "Unable to load full results.";
        clearLoadingState();
      });
    </script>
  </body>
</html>`;
}

function renderRegressionPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - Regression Suite</title>
    <style>
      body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; background: #f5f1e8; color: #1f1c16; }
      .page { max-width: 1200px; margin: 0 auto; padding: 16px; }
      .panel { background: #fffdf6; border: 1px solid #d7d1be; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
      .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid #d7d1be; background: #efe8d7; }
      .pill.user_reported { background: #dceee0; border-color: #8cb89a; }
      .pill.starter { background: #e1ebf9; border-color: #90add8; }
      .pill.wikipedia_style { background: #f1e4f9; border-color: #b99cd4; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #d7d1be; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #efe8d7; }
      button { border: 1px solid #b8b09a; background: #f7f2e4; color: #1f1c16; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
      button:hover { background: #ece2cc; }
      a { color: #2f5b84; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .ok { color: #1b6b3a; font-weight: 600; }
      .fail { color: #8a1f1f; font-weight: 600; }
      .pending { color: #6d6659; }
      .mono { font-family: Consolas, "Courier New", monospace; font-size: 12px; }
      .cmp-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .cmp-table th, .cmp-table td { border: 1px solid #d7d1be; padding: 3px 4px; text-align: left; }
      .cmp-table th { background: #f4eedf; }
      .cmp-table tr.mismatch td { background: #fbe5e5; }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="panel">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h1 style="margin:0 0 6px;">Regression Query Suite</h1>
            <p style="margin:0;">Runs representative leaderboard/full queries exactly as the query builder sends them.</p>
          </div>
          <div class="row">
            <button type="button" id="run-all">Run All</button>
            <a href="/app-fixed">Open Query Builder</a>
          </div>
        </div>
        <p id="suite-meta" class="mono" style="margin:8px 0 0;">Loading suite...</p>
      </section>

      <section class="panel">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Case</th>
              <th>Category</th>
              <th>Status</th>
              <th>Rows</th>
              <th>Duration</th>
              <th>Links</th>
              <th>Target Values</th>
              <th>Query Output</th>
            </tr>
          </thead>
          <tbody id="suite-body"></tbody>
        </table>
      </section>
    </div>

    <script>
      const body = document.getElementById("suite-body");
      const suiteMeta = document.getElementById("suite-meta");
      const runAllButton = document.getElementById("run-all");
      let suite = [];

      async function fetchJsonWithTimeout(url, timeoutMs = 45000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, { cache: "no-store", signal: controller.signal });
          const text = await response.text();
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            throw new Error(text || ("Request failed with status " + response.status));
          }
          return { response, payload };
        } finally {
          clearTimeout(timer);
        }
      }

      function toParams(caseItem) {
        const params = new URLSearchParams(caseItem.params || {});
        if (!params.has("limit")) params.set("limit", "200");
        if (!params.has("page")) params.set("page", "1");
        if (!params.has("pageSize")) params.set("pageSize", "200");
        if (!params.has("conditions")) params.set("conditions", "[]");
        return params;
      }

      function apiUrl(caseItem) {
        const params = toParams(caseItem);
        return (caseItem.endpoint === "full" ? "/api/query/full?" : "/api/query?") + params.toString();
      }

      function builderUrl(caseItem) {
        const params = toParams(caseItem);
        params.set("autorun", "1");
        if (caseItem.endpoint === "full") {
          params.set("mode", params.get("mode") || "totals");
        }
        return "/app-fixed?" + params.toString();
      }

      function fullResultsUrl(caseItem) {
        const params = toParams(caseItem);
        return "/full-results?" + params.toString();
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function valueDisplay(value) {
        if (value === null || value === undefined || value === "") return "-";
        if (typeof value === "number" && !Number.isFinite(value)) return "-";
        return String(value);
      }

      function buildKeyValueTable(rows, mismatches = new Set()) {
        const bodyRows = rows.map((row, index) => {
          const mismatch = mismatches.has(index) ? " class='mismatch'" : "";
          return "<tr" + mismatch + ">"
            + "<td>" + escapeHtml(valueDisplay(row.label)) + "</td>"
            + "<td>" + escapeHtml(valueDisplay(row.entity)) + "</td>"
            + "<td>" + escapeHtml(valueDisplay(row.value)) + "</td>"
            + "</tr>";
        }).join("");
        return "<table class='cmp-table'><thead><tr><th>Check</th><th>Entity</th><th>Value</th></tr></thead><tbody>" + bodyRows + "</tbody></table>";
      }

      function pickOutputEntity(row) {
        if (!row || typeof row !== "object") return "-";
        return row.player ?? row.team ?? row.winner ?? row.name ?? row.opponent ?? "-";
      }

      function pickOutputValue(row) {
        if (!row || typeof row !== "object") return "-";
        const keys = ["stat_total", "streak", "margin", "points", "points_for", "goals", "tries", "included_games"];
        for (const key of keys) {
          if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
        }
        return "-";
      }

      function buildQueryOutputPreviewTable(payload, limit = 10) {
        const rows = Array.isArray(payload?.rows) ? payload.rows.slice(0, limit) : [];
        if (rows.length === 0) return "-";
        const bodyRows = rows.map((row, index) => {
          const rank = index + 1;
          return "<tr>"
            + "<td>" + rank + "</td>"
            + "<td>" + escapeHtml(valueDisplay(pickOutputEntity(row))) + "</td>"
            + "<td>" + escapeHtml(valueDisplay(pickOutputValue(row))) + "</td>"
            + "</tr>";
        }).join("");
        return "<table class='cmp-table'><thead><tr><th>Rank</th><th>Entity</th><th>Value</th></tr></thead><tbody>" + bodyRows + "</tbody></table>";
      }

      function buildSimpleExpectedRows(caseItem) {
        if (Array.isArray(caseItem.outputTarget) && caseItem.outputTarget.length > 0) {
          return caseItem.outputTarget.map((row, index) => ({
            label: "#" + (index + 1),
            entity: row.entity,
            value: row.value,
          }));
        }
        const expected = caseItem.expected || {};
        const rows = [];
        if (Number.isFinite(expected.minRows)) {
          rows.push({ label: "rows >= ", entity: "-", value: Number(expected.minRows) });
        }
        if (expected.topEntityField && typeof expected.topEntityEquals === "string") {
          rows.push({ label: "top " + expected.topEntityField, entity: expected.topEntityEquals, value: "-" });
        }
        if (expected.topValueField && Number.isFinite(expected.topValueEquals)) {
          rows.push({ label: expected.topValueField, entity: "-", value: Number(expected.topValueEquals) });
        }
        return rows;
      }

      function buildSimpleActualRows(caseItem, payload, rowsCount) {
        const expected = caseItem.expected || {};
        const rows = [];
        if (Number.isFinite(expected.minRows)) {
          rows.push({ label: "rows", entity: "-", value: Number(rowsCount) });
        }
        if (expected.topEntityField && typeof expected.topEntityEquals === "string") {
          rows.push({ label: "top " + expected.topEntityField, entity: firstRowValue(payload, expected.topEntityField), value: "-" });
        }
        if (expected.topValueField && Number.isFinite(expected.topValueEquals)) {
          rows.push({ label: expected.topValueField, entity: "-", value: firstRowValue(payload, expected.topValueField) });
        }
        return rows;
      }

      function rowHtml(caseItem, index) {
        const expectedRows = buildSimpleExpectedRows(caseItem);
        return \`
          <tr data-case-id="\${caseItem.id}">
            <td>\${index + 1}</td>
            <td><strong>\${caseItem.label}</strong><div class="mono">\${caseItem.id}</div></td>
            <td><span class="pill \${caseItem.category}">\${caseItem.category.replace("_", " ")}</span></td>
            <td class="status pending">pending</td>
            <td class="rows">-</td>
            <td class="duration">-</td>
            <td>
              <a href="\${apiUrl(caseItem)}" target="_blank" rel="noopener noreferrer">API</a>
              <span> | </span>
              <a href="\${builderUrl(caseItem)}" target="_blank" rel="noopener noreferrer">Builder</a>
              <span> | </span>
              <a href="\${fullResultsUrl(caseItem)}" target="_blank" rel="noopener noreferrer">Full</a>
            </td>
            <td class="expected mono">\${expectedRows.length ? buildKeyValueTable(expectedRows) : "-"}</td>
            <td class="message mono">-</td>
          </tr>
        \`;
      }

      function setRowResult(caseItem, status, rowCount, durationMs, message, expectedOverride) {
        const row = body.querySelector('tr[data-case-id="' + caseItem.id + '"]');
        if (!row) return;
        const statusCell = row.querySelector(".status");
        const rowsCell = row.querySelector(".rows");
        const durationCell = row.querySelector(".duration");
        const expectedCell = row.querySelector(".expected");
        const messageCell = row.querySelector(".message");
        statusCell.textContent = status;
        statusCell.className = "status " + (status === "ok" ? "ok" : status === "fail" ? "fail" : "pending");
        rowsCell.textContent = Number.isFinite(rowCount) ? String(rowCount) : "-";
        durationCell.textContent = Number.isFinite(durationMs) ? durationMs + "ms" : "-";
        if (typeof expectedOverride === "string") {
          expectedCell.innerHTML = expectedOverride;
        }
        if (typeof message === "string" && message.trim().startsWith("<")) {
          messageCell.innerHTML = message;
        } else {
          messageCell.textContent = message || "-";
        }
      }

      function firstRowValue(payload, field) {
        if (!payload) return undefined;
        if (Array.isArray(payload.rows) && payload.rows.length > 0) return payload.rows[0]?.[field];
        return undefined;
      }

      function checkExpected(caseItem, payload, rows) {
        const expected = caseItem.expected || {};
        if (Number.isFinite(expected.minRows) && rows < expected.minRows) {
          return { ok: false, message: "Expected at least " + expected.minRows + " rows, got " + rows };
        }
        if (expected.topEntityField && typeof expected.topEntityEquals === "string") {
          const actualEntity = firstRowValue(payload, expected.topEntityField);
          if (String(actualEntity || "") !== expected.topEntityEquals) {
            return { ok: false, message: "Expected top " + expected.topEntityField + " = " + expected.topEntityEquals + ", got " + String(actualEntity || "") };
          }
        }
        if (expected.topValueField && Number.isFinite(expected.topValueEquals)) {
          const actualValue = Number(firstRowValue(payload, expected.topValueField) || 0);
          if (actualValue !== Number(expected.topValueEquals)) {
            return { ok: false, message: "Expected " + expected.topValueField + " = " + expected.topValueEquals + ", got " + actualValue };
          }
        }
        return { ok: true, message: "validated" };
      }

      function mergedParams(baseParams, overrides) {
        const params = new URLSearchParams(baseParams.toString());
        Object.entries(overrides || {}).forEach(([key, value]) => params.set(key, String(value)));
        return params;
      }

      function normalizeTeamName(value) {
        const aliases = {
          "eastern suburbs": "sydney roosters",
          "eastern suburbs roosters": "sydney roosters",
          "sydney roosters": "sydney roosters",
          "bulldogs": "canterbury bankstown bulldogs",
          "canterbury bulldogs": "canterbury bankstown bulldogs",
          "canterbury-bankstown bulldogs": "canterbury bankstown bulldogs",
          "south sydney": "south sydney rabbitohs",
          "st george": "st george dragons",
          "st george dragons": "st george dragons",
          "st george illawarra": "st george illawarra dragons",
          "st george illawarra dragons": "st george illawarra dragons",
          "manly warringah": "manly warringah sea eagles",
          "manly sea eagles": "manly warringah sea eagles",
          "newtown": "newtown jets",
          "north sydney": "north sydney bears",
          "canberra raider": "canberra raiders",
          "wests": "wests tigers",
        };
        const raw = String(value || "").toLowerCase();
        const normalized = raw
          .replace(/st\./g, "st")
          .replace(/&/g, " and ")
          .replace(/[^a-z0-9 ]+/g, " ")
          .replace(/\\s+/g, " ")
          .trim();
        return aliases[normalized] || normalized;
      }

      function normalizeEntityName(value) {
        return normalizeTeamName(value)
          .replace(/\\bvs\\.?\\b/g, "vs")
          .replace(/\\s+/g, " ")
          .trim();
      }

      function buildTeamLadderTable(rows, mismatches) {
        const bodyRows = rows.map((row, index) => {
          const mismatch = mismatches.has(index) ? " class='mismatch'" : "";
          return "<tr" + mismatch + ">"
            + "<td>" + row.team + "</td>"
            + "<td>" + row.played + "</td>"
            + "<td>" + row.wins + "</td>"
            + "<td>" + row.losses + "</td>"
            + "<td>" + row.draws + "</td>"
            + "</tr>";
        }).join("");
        return "<table class='cmp-table'><thead><tr><th>Team</th><th>Pld</th><th>W</th><th>L</th><th>D</th></tr></thead><tbody>" + bodyRows + "</tbody></table>";
      }

      function buildRankTargetTable(rows, mismatches) {
        const bodyRows = rows.map((row, index) => {
          const mismatch = mismatches.has(index) ? " class='mismatch'" : "";
          const rank = index + 1;
          return "<tr" + mismatch + ">"
            + "<td>" + rank + "</td>"
            + "<td>" + (row.team || "-") + "</td>"
            + "<td>" + (Number.isFinite(Number(row.streak)) ? Number(row.streak) : "-") + "</td>"
            + "</tr>";
        }).join("");
        return "<table class='cmp-table'><thead><tr><th>Rank</th><th>Team</th><th>Streak</th></tr></thead><tbody>" + bodyRows + "</tbody></table>";
      }

      async function runTeamLadderCase(caseItem, started) {
        const targetRows = Array.isArray(caseItem.tableTarget) ? caseItem.tableTarget : [];
        if (!targetRows.length) return false;
        const metrics = [
          { key: "played", statKey: "games" },
          { key: "wins", statKey: "wins" },
          { key: "losses", statKey: "losses" },
          { key: "draws", statKey: "draws" },
        ];
        const actualByTeam = new Map();
        for (const metric of metrics) {
          const params = mergedParams(toParams(caseItem), { statKey: metric.statKey, limit: "500" });
          const response = await fetch((caseItem.endpoint === "full" ? "/api/query/full?" : "/api/query?") + params.toString(), { cache: "no-store" });
          const payload = await response.json();
          if (!response.ok || !payload?.ok) {
            const ended = performance.now();
            setRowResult(caseItem, "fail", NaN, Math.round(ended - started), payload?.error || "Request failed");
            return true;
          }
          const rows = Array.isArray(payload.rows) ? payload.rows : [];
          rows.forEach((row) => {
            const team = String(row.team ?? "");
            const norm = normalizeTeamName(team);
            if (!actualByTeam.has(norm)) actualByTeam.set(norm, { team, played: null, wins: null, losses: null, draws: null });
            actualByTeam.get(norm)[metric.key] = Number(row.stat_total ?? 0);
          });
        }

        const outputRows = [];
        const mismatchIndexes = new Set();
        targetRows.forEach((target, index) => {
          const actual = actualByTeam.get(normalizeTeamName(target.team)) || { team: "-", played: "-", wins: "-", losses: "-", draws: "-" };
          const row = {
            team: String(actual.team || target.team),
            played: actual.played ?? "-",
            wins: actual.wins ?? "-",
            losses: actual.losses ?? "-",
            draws: actual.draws ?? "-",
          };
          outputRows.push(row);
          if (
            Number(row.played) !== Number(target.played) ||
            Number(row.wins) !== Number(target.wins) ||
            Number(row.losses) !== Number(target.losses) ||
            Number(row.draws) !== Number(target.draws)
          ) {
            mismatchIndexes.add(index);
          }
        });

        const expectedTableHtml = buildTeamLadderTable(targetRows, new Set());
        const actualTableHtml = buildTeamLadderTable(outputRows, mismatchIndexes);
        const ended = performance.now();
        setRowResult(
          caseItem,
          mismatchIndexes.size === 0 ? "ok" : "fail",
          outputRows.length,
          Math.round(ended - started),
          actualTableHtml,
          expectedTableHtml
        );
        return true;
      }

      async function runRankTargetCase(caseItem, started) {
        const targetRows = Array.isArray(caseItem.rankTarget) ? caseItem.rankTarget : [];
        if (targetRows.length === 0) return false;
        const { response, payload } = await fetchJsonWithTimeout(apiUrl(caseItem), 30000);
        const ended = performance.now();
        if (!response.ok || !payload?.ok) {
          setRowResult(caseItem, "fail", NaN, Math.round(ended - started), payload?.error || "Request failed");
          return true;
        }

        const sourceRows = Array.isArray(payload.rows) ? payload.rows : [];
        const outputRows = targetRows.map((_, index) => {
          const actual = sourceRows[index] || {};
          return {
            team: String(actual.team ?? "-"),
            streak: Number(actual.streak ?? NaN),
          };
        });

        const mismatchIndexes = new Set();
        targetRows.forEach((target, index) => {
          const actual = outputRows[index];
          if (
            !actual
            || normalizeEntityName(actual.team) !== normalizeEntityName(target.team)
            || Number(actual.streak) !== Number(target.streak)
          ) {
            mismatchIndexes.add(index);
          }
        });

        const expectedTableHtml = buildRankTargetTable(targetRows, new Set());
        const actualTableHtml = buildRankTargetTable(outputRows, mismatchIndexes);
        setRowResult(
          caseItem,
          mismatchIndexes.size === 0 ? "ok" : "fail",
          sourceRows.length,
          Math.round(ended - started),
          actualTableHtml,
          expectedTableHtml
        );
        return true;
      }

      async function runOutputTargetCase(caseItem, started) {
        const targetRows = Array.isArray(caseItem.outputTarget) ? caseItem.outputTarget : [];
        if (targetRows.length === 0) return false;
        const { response, payload } = await fetchJsonWithTimeout(apiUrl(caseItem), 30000);
        const ended = performance.now();
        if (!response.ok || !payload?.ok) {
          setRowResult(caseItem, "fail", NaN, Math.round(ended - started), payload?.error || "Request failed");
          return true;
        }

        const sourceRows = Array.isArray(payload.rows) ? payload.rows : [];
        const outputPreview = buildQueryOutputPreviewTable(payload, Math.max(10, targetRows.length));
        const actualWindow = sourceRows.slice(0, Math.max(targetRows.length + 20, targetRows.length * 3));

        const normalizedActual = actualWindow.map((row) => ({
          entity: normalizeEntityName(pickOutputEntity(row)),
          value: Number(pickOutputValue(row)),
          used: false,
        }));
        const mismatchIndexes = new Set();
        targetRows.forEach((row, index) => {
          const targetValue = Number(row.value);
          const targetEntity = String(row.entity ?? "").trim();
          const wildcardEntity = targetEntity === "*" || targetEntity === "-";
          const matchIndex = normalizedActual.findIndex((actual) =>
            !actual.used
            && actual.value === targetValue
            && (wildcardEntity || actual.entity === normalizeEntityName(targetEntity))
          );
          if (matchIndex >= 0) {
            normalizedActual[matchIndex].used = true;
          } else {
            mismatchIndexes.add(index);
          }
        });

        setRowResult(
          caseItem,
          mismatchIndexes.size === 0 ? "ok" : "fail",
          sourceRows.length,
          Math.round(ended - started),
          outputPreview,
          buildKeyValueTable(
            targetRows.map((row, index) => ({ label: "#" + (index + 1), entity: row.entity, value: row.value })),
            mismatchIndexes
          )
        );
        return true;
      }

      async function runMultiCheckCase(caseItem, started) {
        if (!Array.isArray(caseItem.checks) || caseItem.checks.length === 0) return false;
        const expectedRows = [];
        const actualRows = [];
        const mismatchIndexes = new Set();
        let rowsTotal = 0;
        let failed = false;
        let checkIndex = 0;
        for (const check of caseItem.checks) {
          const params = mergedParams(toParams(caseItem), check.params || {});
          const endpoint = (caseItem.endpoint === "full" ? "/api/query/full?" : "/api/query?") + params.toString();
          const response = await fetch(endpoint, { cache: "no-store" });
          const payload = await response.json();
          const expectedEntity = check.expectedEntity || "-";
          const expectedValue = Number.isFinite(Number(check.expectedValue)) ? Number(check.expectedValue) : "-";
          expectedRows.push({ label: check.label, entity: expectedEntity, value: expectedValue });
          if (!response.ok || !payload?.ok) {
            failed = true;
            mismatchIndexes.add(checkIndex);
            actualRows.push({ label: check.label, entity: "error", value: payload?.error || "Request failed" });
            checkIndex += 1;
            continue;
          }
          const rows = Array.isArray(payload.rows) ? payload.rows.length : Number(payload.totalRows ?? 0);
          rowsTotal += rows;
          const top = Array.isArray(payload.rows) && payload.rows.length ? payload.rows[0] : null;
          const entityField = check.entityField || "team";
          const valueField = check.valueField || "stat_total";
          const numericExpected = Number.isFinite(Number(check.expectedValue)) ? Number(check.expectedValue) : null;
          const actualEntity = String(top?.[entityField] ?? "-");
          const actualValue = Number(top?.[valueField] ?? NaN);
          const entityOk = !check.expectedEntity || normalizeEntityName(actualEntity) === normalizeEntityName(check.expectedEntity);
          const valueOk = numericExpected === null || actualValue === numericExpected;
          const mismatch = !(entityOk && valueOk);
          if (mismatch) failed = true;
          if (mismatch) mismatchIndexes.add(checkIndex);
          actualRows.push({ label: check.label, entity: actualEntity, value: Number.isFinite(actualValue) ? actualValue : "-" });
          checkIndex += 1;
        }
        const ended = performance.now();
        setRowResult(
          caseItem,
          failed ? "fail" : "ok",
          rowsTotal,
          Math.round(ended - started),
          buildKeyValueTable(actualRows, mismatchIndexes),
          buildKeyValueTable(expectedRows, new Set())
        );
        return true;
      }

      async function runCase(caseItem) {
        const started = performance.now();
        try {
          const handledTeamLadder = await runTeamLadderCase(caseItem, started);
          if (handledTeamLadder) return;
          const handledRankTarget = await runRankTargetCase(caseItem, started);
          if (handledRankTarget) return;
          const handledOutputTarget = await runOutputTargetCase(caseItem, started);
          if (handledOutputTarget) return;
          const handled = await runMultiCheckCase(caseItem, started);
          if (handled) return;
          const { response, payload } = await fetchJsonWithTimeout(apiUrl(caseItem), 30000);
          const ended = performance.now();
          if (!response.ok || !payload?.ok) {
            setRowResult(caseItem, "fail", NaN, Math.round(ended - started), payload?.error || "Request failed");
            return;
          }
          const rows = Array.isArray(payload.rows) ? payload.rows.length : Number(payload.totalRows ?? 0);
          const validation = checkExpected(caseItem, payload, rows);
          const expectedRows = buildSimpleExpectedRows(caseItem);
          const actualRows = buildSimpleActualRows(caseItem, payload, rows);
          const mismatchIndexes = new Set();
          for (let index = 0; index < Math.max(expectedRows.length, actualRows.length); index += 1) {
            const expectedRow = expectedRows[index];
            const actualRow = actualRows[index];
            if (!expectedRow || !actualRow) {
              mismatchIndexes.add(index);
              continue;
            }
            const expectedEntity = String(valueDisplay(expectedRow.entity));
            const actualEntity = String(valueDisplay(actualRow.entity));
            const expectedValue = Number(expectedRow.value);
            const actualValue = Number(actualRow.value);
            const entityMismatch = expectedEntity !== "-" && expectedEntity !== actualEntity;
            const valueMismatch = Number.isFinite(expectedValue) ? Number(actualValue) !== expectedValue : false;
            if (entityMismatch || valueMismatch) mismatchIndexes.add(index);
          }
          setRowResult(
            caseItem,
            validation.ok ? "ok" : "fail",
            rows,
            Math.round(ended - started),
            buildQueryOutputPreviewTable(payload, 10),
            expectedRows.length ? buildKeyValueTable(expectedRows, new Set()) : undefined
          );
        } catch (error) {
          const ended = performance.now();
          setRowResult(caseItem, "fail", NaN, Math.round(ended - started), error instanceof Error ? error.message : String(error));
        }
      }

      async function runAllCases() {
        runAllButton.disabled = true;
        for (const caseItem of suite) {
          setRowResult(caseItem, "pending", NaN, NaN, "running...");
        }
        for (const caseItem of suite) {
          await runCase(caseItem);
        }
        runAllButton.disabled = false;
      }

      async function init() {
        const { response, payload } = await fetchJsonWithTimeout("/api/meta/regression-suite", 12000);
        if (!response.ok || !payload?.ok || !Array.isArray(payload.cases)) {
          throw new Error(payload?.error || "Unable to load regression suite.");
        }
        suite = payload.cases;
        const snapshot = suite[0]?.snapshotTag || payload.snapshotTag || "unstamped";
        suiteMeta.textContent = "Loaded " + suite.length + " cases. Snapshot: " + snapshot + ". Generated at " + (payload.generatedAtUtc || "unknown") + ".";
        body.innerHTML = suite.map((caseItem, index) => rowHtml(caseItem, index)).join("");
        runAllButton.addEventListener("click", () => {
          runAllCases().catch((error) => {
            suiteMeta.textContent = "Run failed: " + (error instanceof Error ? error.message : String(error));
          });
        });
      }

      init().catch((error) => {
        suiteMeta.textContent = error instanceof Error ? error.message : String(error);
      });
    </script>
  </body>
</html>`;
}

async function loadMatchPageData(db: D1Database, matchId: number): Promise<{
  match: QueryRow | null;
  teamRows: QueryRow[];
  playerRows: QueryRow[];
}> {
  const matchResult = await db.prepare(`
    SELECT
      m.match_id,
      c.name AS competition,
      CASE
        WHEN c.name = 'State of Origin' THEN 'SOO'
        WHEN c.name = 'Women''s State of Origin' THEN 'WSOO'
        WHEN c.name = 'National Rugby League Women' THEN 'NRLW'
        ELSE 'NRL'
      END AS competition_code,
      m.season,
      m.round_label,
      COALESCE(m.match_date_local_text, hs.match_date_utc, m.match_date_utc, printf('%d %s', m.season, m.round_label)) AS match_reference,
      COALESCE(v.canonical_name, 'Unknown') AS ground,
      COALESCE(hs_ref.stat_value_text, 'Unknown') AS referee_name,
      COALESCE(hs_ground.stat_value_text, 'Unknown') AS ground_condition_name,
      COALESCE(hs_weather.stat_value_text, 'Unknown') AS weather_condition_name,
      COALESCE(hs_crowd.stat_value_text, '') AS crowd,
      ht.canonical_name AS home_team,
      at.canonical_name AS away_team,
      m.home_score,
      m.away_score
    FROM matches m
    JOIN competitions c ON c.competition_id = m.competition_id
    JOIN teams ht ON ht.team_id = m.home_team_id
    JOIN teams at ON at.team_id = m.away_team_id
    LEFT JOIN venues v ON v.venue_id = m.venue_id
    LEFT JOIN team_match_summary hs ON hs.match_id = m.match_id AND hs.team_id = m.home_team_id
    LEFT JOIN team_match_stat_values hs_ref ON hs_ref.team_match_summary_id = hs.team_match_summary_id AND hs_ref.stat_key = 'referee'
    LEFT JOIN team_match_stat_values hs_ground ON hs_ground.team_match_summary_id = hs.team_match_summary_id AND hs_ground.stat_key = 'ground_condition'
    LEFT JOIN team_match_stat_values hs_weather ON hs_weather.team_match_summary_id = hs.team_match_summary_id AND hs_weather.stat_key = 'weather_condition'
    LEFT JOIN team_match_stat_values hs_crowd ON hs_crowd.team_match_summary_id = hs.team_match_summary_id AND hs_crowd.stat_key = 'crowd'
    WHERE m.match_id = ?
  `).bind(matchId).first<QueryRow>();

  const teamResult = await db.prepare(`
    SELECT
      t.canonical_name AS team,
      t.team_id,
      s.is_home,
      s.team_score,
      s.opponent_score,
      s.stats_json
    FROM team_match_summary s
    JOIN teams t ON t.team_id = s.team_id
    WHERE s.match_id = ?
    ORDER BY s.is_home DESC, t.canonical_name
  `).bind(matchId).all<QueryRow>();

  const playerResult = await db.prepare(`
    SELECT
      s.match_id,
      s.team_id,
      tt.canonical_name AS team,
      tms.is_home,
      COALESCE(p.display_name, s.player_name_raw) AS player,
      s.position_label,
      s.jumper_number,
      s.stats_json
    FROM player_match_summary s
    LEFT JOIN players p ON p.player_id = s.player_id
    JOIN teams tt ON tt.team_id = s.team_id
    LEFT JOIN team_match_summary tms ON tms.match_id = s.match_id AND tms.team_id = s.team_id
    WHERE s.match_id = ?
    ORDER BY tms.is_home DESC, s.team_id, s.jumper_number ASC, COALESCE(p.display_name, s.player_name_raw) ASC
  `).bind(matchId).all<QueryRow>();

  return {
    match: matchResult ?? null,
    teamRows: teamResult.results ?? [],
    playerRows: playerResult.results ?? [],
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildFaviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#f6efe0"/>
  <rect x="6" y="6" width="52" height="52" rx="12" fill="#224e78"/>
  <ellipse cx="32" cy="32" rx="18" ry="24" fill="#d3a24a" transform="rotate(-18 32 32)"/>
  <ellipse cx="32" cy="32" rx="12" ry="17" fill="#f4d59a" transform="rotate(-18 32 32)"/>
  <path d="M32 17v30M24 22l16 20M40 22L24 42" stroke="#224e78" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}

function buildPlayerProfileUrl(playerName: string): string {
  return `/player/${encodeURIComponent(playerName)}`;
}

function buildSeasonIndexHref(competition: string, season: number | string, roundLabel?: string | null): string {
  const params = new URLSearchParams();
  params.set("competition", normalizeCompetitionCode(String(competition ?? "")));
  params.set("season", String(season ?? ""));
  const roundAnchor = roundLabel ? `#${buildRoundAnchor(roundLabel)}` : "";
  return `/season?${params.toString()}${roundAnchor}`;
}

function buildRoundAnchor(roundLabel: string): string {
  const normalized = String(roundLabel ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `round-${normalized || "unknown"}`;
}

function safeJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

async function loadSeasonIndexData(
  db: D1Database,
  competition: string,
  season: number
): Promise<{
  competition: string;
  season: number;
  seasons: number[];
  rows: QueryRow[];
} | null> {
  const normalizedCompetition = normalizeCompetitionCode(competition);
  const competitionFilter = competitionFilterSql("c.name", normalizedCompetition);
  const binds: unknown[] = [season];
  binds.push(...competitionFilter.binds);

  const rowsResult = await db.prepare(`
    SELECT
      m.match_id,
      c.name AS competition,
      m.season,
      m.round_label,
      m.round_index,
      COALESCE(m.match_date_local_text, hs.match_date_utc, m.match_date_utc, printf('%d %s', m.season, m.round_label)) AS match_reference,
      ht.canonical_name AS home_team,
      at.canonical_name AS away_team,
      m.home_score,
      m.away_score,
      COALESCE(v.canonical_name, 'Unknown') AS ground,
      COALESCE(hs_ref.stat_value_text, 'Unknown') AS referee_name,
      COALESCE(hs_weather.stat_value_text, 'Unknown') AS weather_condition_name,
      COALESCE(hs_ground.stat_value_text, 'Unknown') AS ground_condition_name,
      COALESCE(hs_crowd.stat_value_text, '') AS crowd
    FROM matches m
    JOIN competitions c ON c.competition_id = m.competition_id
    JOIN teams ht ON ht.team_id = m.home_team_id
    JOIN teams at ON at.team_id = m.away_team_id
    LEFT JOIN venues v ON v.venue_id = m.venue_id
    LEFT JOIN team_match_summary hs ON hs.match_id = m.match_id AND hs.team_id = m.home_team_id
    LEFT JOIN team_match_stat_values hs_ref ON hs_ref.team_match_summary_id = hs.team_match_summary_id AND hs_ref.stat_key = 'referee'
    LEFT JOIN team_match_stat_values hs_weather ON hs_weather.team_match_summary_id = hs.team_match_summary_id AND hs_weather.stat_key = 'weather_condition'
    LEFT JOIN team_match_stat_values hs_ground ON hs_ground.team_match_summary_id = hs.team_match_summary_id AND hs_ground.stat_key = 'ground_condition'
    LEFT JOIN team_match_stat_values hs_crowd ON hs_crowd.team_match_summary_id = hs.team_match_summary_id AND hs_crowd.stat_key = 'crowd'
    WHERE m.season = ?
      ${competitionFilter.sql ? `AND ${competitionFilter.sql}` : ""}
    ORDER BY m.round_index ASC, COALESCE(m.match_date_utc, m.match_date_local_text) ASC, m.match_id ASC
  `).bind(...binds).all<QueryRow>();

  const seasonsResult = await db.prepare(`
    SELECT DISTINCT m.season
    FROM matches m
    JOIN competitions c ON c.competition_id = m.competition_id
    WHERE 1 = 1
      ${competitionFilter.sql ? `AND ${competitionFilter.sql}` : ""}
    ORDER BY m.season DESC
  `).bind(...competitionFilter.binds).all<{ season: number }>();

  const rows = rowsResult.results ?? [];
  const seasons = (seasonsResult.results ?? []).map((row) => Number(row.season)).filter((value) => Number.isFinite(value));
  if (!rows.length && !seasons.length) return null;

  return {
    competition: normalizedCompetition,
    season,
    seasons,
    rows,
  };
}

async function loadPlayerPageData(db: D1Database, playerName: string, competition: string): Promise<{
  playerName: string;
  competition: string;
  playerOptions: string[];
  matchRows: QueryRow[];
} | null> {
  const normalizedCompetition = normalizeCompetitionCode(competition);
  const competitionFilter = competitionFilterSql("c.name", normalizedCompetition);
  const playerMeta = await db.prepare(`
    SELECT player_id, display_name
    FROM players
    WHERE display_name = ?
    LIMIT 1
  `).bind(playerName).first<{ player_id: number; display_name: string }>();

  const playerQuery = `
    SELECT
      COALESCE(p.display_name, s.player_name_raw) AS player,
      c.name AS competition,
      s.match_id,
      s.season,
      s.round_index,
      m.round_label,
      COALESCE(m.match_date_local_text, s.match_date_utc, m.match_date_utc, printf('%d %s', s.season, m.round_label)) AS match_reference,
      ${matchSortKeySql("COALESCE(s.match_date_utc, m.match_date_utc)", "m.match_date_local_text")} AS match_sort_key,
      tt.canonical_name AS team,
      COALESCE(ot.canonical_name, 'Unknown') AS opposition,
      COALESCE(v.canonical_name, 'Unknown') AS ground,
      s.position_label,
      s.jumper_number,
      s.stats_json,
      tms.team_score,
      tms.opponent_score,
      CASE
        WHEN tms.team_score > tms.opponent_score THEN 'W'
        WHEN tms.team_score < tms.opponent_score THEN 'L'
        ELSE 'D'
      END AS result_code
    FROM player_match_summary s
    LEFT JOIN players p ON p.player_id = s.player_id
    JOIN matches m ON m.match_id = s.match_id
    JOIN competitions c ON c.competition_id = m.competition_id
    JOIN teams tt ON tt.team_id = s.team_id
    LEFT JOIN teams ot ON ot.team_id = s.opponent_team_id
    LEFT JOIN venues v ON v.venue_id = m.venue_id
    LEFT JOIN team_match_summary tms ON tms.match_id = s.match_id AND tms.team_id = s.team_id
    WHERE %FILTER%
      ${competitionFilter.sql ? `AND ${competitionFilter.sql}` : ""}
    ORDER BY s.season DESC, match_sort_key DESC, s.match_id DESC, s.jumper_number ASC
  `;

  const playerRows = playerMeta
    ? await db.prepare(playerQuery.replace("%FILTER%", "s.player_id = ?")).bind(playerMeta.player_id, ...competitionFilter.binds).all<QueryRow>()
    : await db.prepare(playerQuery.replace("%FILTER%", "s.player_name_raw = ?")).bind(playerName, ...competitionFilter.binds).all<QueryRow>();

  const matchRows = playerRows.results ?? [];
  if (!matchRows.length) return null;

  const playerOptions = await getPlayerOptionsFromDatabase(db);

  return {
    playerName,
    competition: normalizedCompetition,
    playerOptions,
    matchRows,
  };
}

async function loadPlayerRankingCards(db: D1Database, playerName: string, competition: string): Promise<Array<{ statKey: string; label: string; rank: number; total: number }>> {
  const rankStatList = PLAYER_PROFILE_RANK_STAT_KEYS.map(quotedSqlString).join(", ");
  const sourceCodes = aggregateSourcesForCompetition(competition) ?? ["nrl"];
  const sourcePlaceholders = sourceCodes.map(() => "?").join(", ");
  const playerMeta = await db.prepare(`
    SELECT player_id
    FROM players
    WHERE display_name = ?
    LIMIT 1
  `).bind(playerName).first<{ player_id: number }>();

  const totalsQuery = `
    SELECT
      a.stat_key,
      ROUND(SUM(a.total_value), 3) AS total_value
    FROM player_stat_aggregates a
    LEFT JOIN players p ON p.player_id = a.player_id
    WHERE a.scope = 'season'
      AND a.source IN (${sourcePlaceholders})
      AND a.stat_key IN (${rankStatList})
      AND %FILTER%
    GROUP BY a.stat_key
    HAVING SUM(a.total_value) > 0
  `;
  const playerTotals = playerMeta
    ? await db.prepare(totalsQuery.replace("%FILTER%", "a.player_id = ?")).bind(...sourceCodes, playerMeta.player_id).all<{ stat_key: string; total_value: number }>()
    : await db.prepare(totalsQuery.replace("%FILTER%", "a.player_name_raw = ?")).bind(...sourceCodes, playerName).all<{ stat_key: string; total_value: number }>();

  const rankResults = await Promise.all((playerTotals.results ?? []).map(async (row) => {
    const rankRow = await db.prepare(`
      WITH career_totals AS (
        SELECT
          COALESCE(p.display_name, a.player_name_raw) AS player_name,
          ROUND(SUM(a.total_value), 3) AS total_value
        FROM player_stat_aggregates a
        LEFT JOIN players p ON p.player_id = a.player_id
        WHERE a.scope = 'season'
          AND a.source IN (${sourcePlaceholders})
          AND a.stat_key = ?
        GROUP BY COALESCE(p.display_name, a.player_name_raw)
        HAVING SUM(a.total_value) > 0
      )
      SELECT 1 + COUNT(*) AS stat_rank
      FROM career_totals
      WHERE total_value > ?
    `).bind(...sourceCodes, row.stat_key, row.total_value).first<{ stat_rank: number }>();
    return {
      stat_key: row.stat_key,
      total_value: Number(row.total_value),
      stat_rank: Number(rankRow?.stat_rank ?? 0),
    };
  }));

  const statDefinitionByKey = new Map(
    STAT_DEFINITIONS
      .filter((definition) => definition.scope === "player")
      .map((definition) => [definition.statKey, definition.displayName])
  );
  return rankResults
    .map((row) => ({
      statKey: row.stat_key,
      label: statDefinitionByKey.get(row.stat_key) ?? row.stat_key.replace(/_/g, " "),
      rank: Number(row.stat_rank),
      total: Number(row.total_value),
    }))
    .filter((row) => Number.isFinite(row.rank) && row.rank > 0)
    .sort((left, right) => left.rank - right.rank || right.total - left.total || left.label.localeCompare(right.label))
    .slice(0, 3);
}

function renderPlayerPage(payload: {
  playerName: string;
  playerOptions: string[];
  matchRows: QueryRow[];
  rankingCards: Array<{ statKey: string; label: string; rank: number; total: number }>;
} | null): string {
  if (!payload) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${APP_NAME} - Player Not Found</title></head><body><h1>Player Not Found</h1></body></html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - ${escapeHtml(payload.playerName)}</title>
    <style>
      :root{
        --bg:#ece7d9; --panel:#f8f3e7; --panel-2:#fbf8f0; --line:#cdbf9e; --line-2:#b39f77;
        --text:#1f1d19; --muted:#6e6552; --green:#1e5631; --blue:#274d78; --gold:#b48a3a;
        --shadow:0 8px 24px rgba(65,49,22,.08); --radius:14px;
      }
      *{box-sizing:border-box}
      body{
        margin:0; color:var(--text); font-family:Arial, Helvetica, sans-serif;
        background:
          linear-gradient(rgba(255,255,255,.14), rgba(255,255,255,.14)),
          repeating-linear-gradient(0deg, rgba(84,74,44,.03) 0 1px, transparent 1px 34px),
          repeating-linear-gradient(90deg, rgba(84,74,44,.03) 0 1px, transparent 1px 34px),
          var(--bg);
      }
      a{color:#0048c9; text-decoration:underline; text-underline-offset:2px}
      .shell{max-width:1600px; margin:0 auto; padding:16px}
      .masthead,.card,.sidebar{background:rgba(248,243,231,.94); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow)}
      .masthead{padding:18px 20px; margin-bottom:14px}
      .brand h1{margin:0 0 4px; font-size:2rem}
      .brand p{margin:0; color:var(--muted)}
      .topbar{display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-top:14px}
      .ghost-btn,.seg-btn,.page-btn{appearance:none; border:1px solid var(--line-2); background:linear-gradient(180deg,#faf5ea,#efe6d4); color:var(--text); cursor:pointer; border-radius:10px; padding:10px 14px; font-weight:700; font-size:.94rem}
      .ghost-btn.primary{background:linear-gradient(180deg,#315f8d,#274d78); color:#fff; border-color:#274d78; text-decoration:none; display:inline-flex; align-items:center}
      .layout{display:grid; grid-template-columns:320px minmax(0,1fr); gap:14px; align-items:start}
      .sidebar{padding:14px; position:sticky; top:12px}
      .content-stack{display:grid; gap:14px; min-width:0}
      .card{overflow:hidden}
      .hero{padding:18px; position:relative}
      .hero::after{content:""; position:absolute; right:-40px; bottom:-40px; width:180px; height:180px; background:radial-gradient(circle, rgba(30,86,49,.1), transparent 70%)}
      .eyebrow{display:inline-flex; align-items:center; gap:8px; font-size:.8rem; text-transform:uppercase; letter-spacing:.11em; color:var(--muted); font-weight:700; margin-bottom:10px}
      .eyebrow::before{content:""; width:26px; height:2px; background:var(--gold)}
      .hero-grid{display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:start}
      .hero-title{margin:0; font-size:2rem; line-height:1.08}
      .hero-sub{margin:8px 0 0; color:var(--muted); font-size:1rem}
      .filters{display:grid; gap:14px}
      .filter-group{border-top:1px solid var(--line); padding-top:14px}
      .filter-group:first-child{border-top:0; padding-top:0}
      .label{display:block; font-size:.82rem; color:var(--muted); font-weight:700; text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px}
      select{width:100%; border:1px solid var(--line-2); background:#fbf8f0; border-radius:10px; padding:10px 12px; color:var(--text); font:inherit}
      .segmented{display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:4px; background:#efe8d8; border:1px solid var(--line-2); border-radius:12px}
      .seg-btn.active{background:var(--green); color:#fff; border-color:var(--green)}
      .summary-grid{display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; padding:14px}
      .metric{background:linear-gradient(180deg,#fcf8ef,#f2eadc); border:1px solid var(--line); border-radius:12px; padding:12px}
      .metric-label{display:block; color:var(--muted); font-size:.76rem; text-transform:uppercase; letter-spacing:.08em; font-weight:700; margin-bottom:7px}
      .metric-value{font-size:1.35rem; font-weight:800; line-height:1.05}
      .metric.rank-card{padding:0; overflow:hidden; background:#f7c300}
      .metric.rank-card a{display:flex; flex-direction:column; justify-content:space-between; min-height:116px; width:100%; padding:12px 14px; text-decoration:none; color:#000}
      .metric.rank-card .metric-label,.metric.rank-card .metric-value{color:#000}
      .section-head{display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; padding:14px 16px 0}
      .section-head h3{margin:0; font-size:1.14rem}
      .pagination{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
      .table-meta{font-size:.88rem; color:var(--muted)}
      .table-shell{padding:12px 14px 16px; min-width:0}
      .table-wrap{overflow:auto; border:1px solid var(--line); border-radius:12px; background:#fbf8f0}
      table{width:100%; border-collapse:separate; border-spacing:0; min-width:840px}
      thead th{position:sticky; top:0; z-index:1; background:#e7dcc5; color:#2b2418; font-size:.83rem; text-transform:uppercase; letter-spacing:.04em; text-align:left; border-bottom:1px solid var(--line-2); border-right:1px solid var(--line); padding:10px; white-space:nowrap}
      tbody td{border-bottom:1px solid #ddd0b2; border-right:1px solid #e3d7bc; padding:9px 10px; white-space:nowrap; font-size:.92rem}
      tbody tr:nth-child(odd){background:#fbf7ee} tbody tr:nth-child(even){background:#f5eedf} tbody tr:hover{background:#ecf2e8}
      tbody tr.summary-row{background:#dde8dd !important; font-weight:800}
      th.sortable{cursor:pointer; user-select:none} th.sortable::after{content:" ↕"; color:#6c6049; font-weight:400} th.sortable.asc::after{content:" ↑"} th.sortable.desc::after{content:" ↓"}
      .muted{color:var(--muted)}
      @media (max-width:1200px){.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media (max-width:940px){.layout{grid-template-columns:1fr} .sidebar{position:relative; top:0} .hero-grid{grid-template-columns:1fr}}
      @media (max-width:720px){.shell{padding:10px} .brand h1{font-size:1.55rem} .hero-title{font-size:1.55rem} .summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="masthead">
        <div class="brand">
          <h1>${APP_NAME}</h1>
          <p>Player profile in the house style with real match and aggregate data.</p>
        </div>
        <div class="topbar">
          <div class="muted">Clicking a player opens their profile. Clicking a match opens match detail.</div>
          <a class="ghost-btn" href="/app-fixed">← Back to Search</a>
        </div>
      </header>

      <main class="layout">
        <aside class="sidebar">
          <div class="filters">
            <div class="filter-group">
              <span class="label">Selected player</span>
              <select id="playerSelect"></select>
            </div>
            <div class="filter-group">
              <span class="label">View</span>
              <div class="segmented" id="viewToggle">
                <button class="seg-btn" data-view="seasons">Seasons</button>
                <button class="seg-btn" data-view="matches">Matches</button>
                <button class="seg-btn" data-view="team">Team</button>
                <button class="seg-btn" data-view="position">Position</button>
              </div>
            </div>
            <div class="filter-group">
              <span class="label">Mode</span>
              <div class="segmented" id="modeToggle">
                <button class="seg-btn" data-mode="totals">Totals</button>
                <button class="seg-btn" data-mode="averages">Averages</button>
              </div>
            </div>
          </div>
        </aside>

        <div class="content-stack">
          <section class="card hero">
            <div class="eyebrow">Player profile</div>
            <div class="hero-grid">
              <div>
                <h2 class="hero-title" id="playerTitle"></h2>
                <p class="hero-sub" id="playerSubtitle"></p>
              </div>
              <div><a class="ghost-btn primary" id="builderLink" href="#">Run Query</a></div>
            </div>
          </section>

          <section class="card">
            <div class="summary-grid" id="playerSummaryGrid"></div>
          </section>

          <section class="card">
            <div class="section-head">
              <div><h3 id="playerTableTitle"></h3></div>
              <div class="pagination">
                <button class="page-btn" id="playerPrev">Prev</button>
                <span class="table-meta" id="playerPageMeta"></span>
                <button class="page-btn" id="playerNext">Next</button>
              </div>
            </div>
            <div class="table-shell">
              <div class="table-wrap"><table id="playerTable"><thead></thead><tbody></tbody></table></div>
            </div>
          </section>
        </div>
      </main>
    </div>

    <script id="player-page-data" type="application/json">${safeJsonScript(payload)}</script>
    <script>
      const payload = JSON.parse(document.getElementById("player-page-data").textContent);
      const statLabels = {
        season: "Season",
        team: "Team",
        position: "Position",
        games: "Games",
        tries: "Tries",
        goals: "Goals",
        field_goals_1pt: "1FG",
        points: "Points",
        all_run_metres: "Run Metres",
        try_assists: "Try Assists",
        line_breaks: "Line Breaks",
        tackles_made: "Tackles",
        errors: "Errors",
        kicking_metres: "Kicking Metres",
        minutes_played: "Minutes",
        round: "Round",
        opposition: "Opponent",
        ground: "Venue",
        match_reference: "Match",
        result: "Result",
      };
      const tableStatKeys = ${safeJsonScript(PLAYER_PROFILE_TABLE_STAT_KEYS)};
      const viewColumns = {
        seasons: ["season", "team", "position", "games", ...tableStatKeys],
        matches: ["season", "round", "team", "opposition", "ground", "match_reference", "result", "position", ...tableStatKeys],
        team: ["team", "position", "games", ...tableStatKeys],
        position: ["position", "games", ...tableStatKeys],
      };
      const state = {
        view: new URLSearchParams(window.location.search).get("view") || "seasons",
        mode: new URLSearchParams(window.location.search).get("mode") || "totals",
        page: Math.max(1, Number(new URLSearchParams(window.location.search).get("page") || "1")),
        sort: new URLSearchParams(window.location.search).get("sort") || "",
        direction: new URLSearchParams(window.location.search).get("direction") || "",
      };
      const pageSize = 12;
      const playerName = payload.playerName;
      const playerSelect = document.getElementById("playerSelect");
      const playerTitle = document.getElementById("playerTitle");
      const playerSubtitle = document.getElementById("playerSubtitle");
      const builderLink = document.getElementById("builderLink");
      const summaryGrid = document.getElementById("playerSummaryGrid");
      const playerTable = document.getElementById("playerTable");
      const playerTableTitle = document.getElementById("playerTableTitle");
      const playerPageMeta = document.getElementById("playerPageMeta");
      const playerPrev = document.getElementById("playerPrev");
      const playerNext = document.getElementById("playerNext");

      function toNumber(value) {
        if (value === null || value === undefined || value === "") return 0;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
      }

      function formatNumber(value, decimals = 0) {
        if (value === null || value === undefined || value === "") return "";
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return String(value);
        return numeric.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      }

      function parseStats(row) {
        return typeof row.stats_json === "string" ? JSON.parse(row.stats_json || "{}") : (row.stats_json || {});
      }

      function matchStatValue(row, statKey) {
        const stats = parseStats(row);
        if (statKey === "games") return 1;
        if (statKey === "field_goals_1pt") return toNumber(stats.field_goals_1pt);
        if (statKey === "points") {
          return (toNumber(stats.tries) * 4)
            + (toNumber(stats.goals) * 2)
            + (toNumber(stats.field_goals_1pt))
            + (toNumber(stats.field_goals_2pt) * 2);
        }
        return toNumber(stats[statKey]);
      }

      function buildMatchRows() {
        return payload.matchRows.map((row) => {
          const stats = parseStats(row);
          const resultText = row.result_code === "W"
            ? "W " + row.team_score + "–" + row.opponent_score
            : row.result_code === "L"
              ? "L " + row.team_score + "–" + row.opponent_score
              : "D " + row.team_score + "–" + row.opponent_score;
          const out = {
            season: row.season,
            round: row.round_label,
            team: row.team,
            opposition: row.opposition,
            ground: row.ground,
            position: row.position_label || "Unknown",
            match_reference: row.match_reference,
            match_sort_key: row.match_sort_key,
            match_id: row.match_id,
            result: resultText,
            games: 1,
          };
          for (const statKey of tableStatKeys) {
            out[statKey] = matchStatValue(row, statKey);
          }
          return out;
        });
      }

      function aggregateRows(view, mode) {
        const matchRows = buildMatchRows();
        if (view === "matches") {
          const summary = createSummaryRow(matchRows, mode);
          return [summary, ...matchRows];
        }

        const groups = new Map();
        for (const row of matchRows) {
          const key = view === "seasons"
            ? String(row.season)
            : view === "team"
              ? String(row.team)
              : String(row.position);
          if (!groups.has(key)) {
            groups.set(key, {
              season: view === "seasons" ? row.season : "",
              team: view === "team" ? row.team : (view === "seasons" ? row.team : ""),
              position: view === "position" ? row.position : (view === "seasons" ? row.position : ""),
              games: 0,
            });
            for (const statKey of tableStatKeys) {
              groups.get(key)[statKey] = 0;
            }
          }
          const bucket = groups.get(key);
          bucket.games += 1;
          if (view === "seasons") {
            bucket.team = bucket.team || row.team;
            bucket.position = bucket.position || row.position;
          } else if (view === "team") {
            if (!bucket.position || bucket.position === "Mixed") bucket.position = row.position;
            else if (bucket.position !== row.position) bucket.position = "Mixed";
          }
          for (const statKey of tableStatKeys) {
            bucket[statKey] += toNumber(row[statKey]);
          }
        }
        const rows = [...groups.values()].map((row) => {
          const out = { ...row };
          if (mode === "averages") {
            for (const statKey of tableStatKeys) {
              out[statKey] = row.games > 0 ? Number((toNumber(row[statKey]) / row.games).toFixed(3)) : 0;
            }
          }
          return out;
        });
        const summary = createSummaryRow(matchRows, mode);
        return [summary, ...rows];
      }

      function createSummaryRow(matchRows, mode) {
        const summary = {
          season: "Career",
          team: summarisePrimary(matchRows.map((row) => row.team)),
          position: summarisePrimary(matchRows.map((row) => row.position)),
          games: matchRows.length,
        };
        for (const statKey of tableStatKeys) {
          const total = matchRows.reduce((sum, row) => sum + toNumber(row[statKey]), 0);
          summary[statKey] = mode === "averages" && matchRows.length > 0
            ? Number((total / matchRows.length).toFixed(3))
            : total;
        }
        summary.__summary = true;
        return summary;
      }

      function summarisePrimary(values) {
        const counts = new Map();
        for (const value of values) {
          const text = String(value || "Unknown");
          counts.set(text, (counts.get(text) || 0) + 1);
        }
        const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        if (!ordered.length) return "Unknown";
        return ordered.length === 1 ? ordered[0][0] : ordered.slice(0, 2).map((entry) => entry[0]).join(" / ");
      }

      function compareValues(a, b, column) {
        if (column === "match_reference") {
          return String(a.match_sort_key || "").localeCompare(String(b.match_sort_key || ""));
        }
        const left = a[column];
        const right = b[column];
        const leftNum = Number(left);
        const rightNum = Number(right);
        if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return leftNum - rightNum;
        return String(left || "").localeCompare(String(right || ""));
      }

      function sortRows(rows) {
        const summary = rows[0];
        const dataRows = rows.slice(1);
        const defaultSort = state.view === "matches"
          ? { column: "match_reference", direction: "desc" }
          : state.view === "seasons"
            ? { column: "season", direction: "desc" }
            : { column: "games", direction: "desc" };
        const sortColumn = state.sort || defaultSort.column;
        const direction = state.direction || defaultSort.direction;
        dataRows.sort((left, right) => {
          const result = compareValues(left, right, sortColumn);
          return direction === "asc" ? result : -result;
        });
        return [summary, ...dataRows];
      }

      function updateUrl() {
        const next = new URL(window.location.href);
        next.searchParams.set("view", state.view);
        next.searchParams.set("mode", state.mode);
        next.searchParams.set("page", String(state.page));
        if (state.sort) next.searchParams.set("sort", state.sort); else next.searchParams.delete("sort");
        if (state.direction) next.searchParams.set("direction", state.direction); else next.searchParams.delete("direction");
        history.replaceState(null, "", next.toString());
      }

      function renderSummaryCards(rows) {
        const summary = rows[0];
        const metricLabel = state.mode === "averages" ? "Avg points" : "Points";
        const gamesLabel = state.mode === "averages" ? "Matches" : "Matches";
        const cards = [
          '<div class="metric"><span class="metric-label">' + gamesLabel + '</span><div class="metric-value">' + formatNumber(summary.games) + '</div></div>',
          '<div class="metric"><span class="metric-label">' + metricLabel + '</span><div class="metric-value">' + formatNumber(summary.points, state.mode === "averages" ? 3 : 0) + '</div></div>',
          ...payload.rankingCards.map((card) =>
            '<div class="metric rank-card"><a href="/app-fixed?scope=player&player=' + encodeURIComponent(playerName) + '&mode=totals&format=overall&statKey=' + encodeURIComponent(card.statKey) + '"><span class="metric-label">' + card.label + '</span><div class="metric-value">' + card.rank + 'th</div></a></div>'
          ),
        ];
        summaryGrid.innerHTML = cards.join("");
      }

      function renderTable(rows) {
        const columns = viewColumns[state.view];
        const sortColumn = state.sort || (state.view === "matches" ? "match_reference" : state.view === "seasons" ? "season" : "games");
        const sortDirection = state.direction || "desc";
        const totalDataRows = Math.max(0, rows.length - 1);
        const totalPages = Math.max(1, Math.ceil(totalDataRows / pageSize));
        if (state.page > totalPages) state.page = totalPages;
        const summaryRow = rows[0];
        const dataRows = rows.slice(1);
        const pagedRows = dataRows.slice((state.page - 1) * pageSize, state.page * pageSize);
        const visibleRows = [summaryRow, ...pagedRows];

        playerTable.querySelector("thead").innerHTML = "<tr>" + columns.map((column) => {
          const klass = ["sortable"];
          if (sortColumn === column) klass.push(sortDirection === "asc" ? "asc" : "desc");
          return '<th class="' + klass.join(" ") + '" data-column="' + column + '">' + (statLabels[column] || column) + "</th>";
        }).join("") + "</tr>";

        playerTable.querySelector("tbody").innerHTML = visibleRows.map((row) => {
          const rowClass = row.__summary ? ' class="summary-row"' : "";
          return "<tr" + rowClass + ">" + columns.map((column) => {
            let value = row[column];
            if (column === "team" && row.match_id) {
              value = '<a href="/app-fixed?scope=player&player=' + encodeURIComponent(playerName) + '&team=' + encodeURIComponent(String(row.team)) + '&mode=totals&format=overall&statKey=tries">' + value + '</a>';
            } else if (column === "match_reference" && row.match_id) {
              value = '<a href="/match/' + row.match_id + '">' + value + '</a>';
            } else if (typeof value === "number") {
              value = formatNumber(value, state.mode === "averages" && column !== "games" ? 3 : 0);
            }
            return "<td>" + (value ?? "") + "</td>";
          }).join("") + "</tr>";
        }).join("");

        playerTable.querySelectorAll("th[data-column]").forEach((header) => {
          header.addEventListener("click", () => {
            const column = header.dataset.column;
            if (state.sort === column) state.direction = state.direction === "asc" ? "desc" : "asc";
            else {
              state.sort = column;
              state.direction = column === "season" ? "desc" : "desc";
            }
            state.page = 1;
            render();
          });
        });

        playerTableTitle.textContent = playerName;
        playerPageMeta.textContent = "Page " + state.page + " of " + totalPages + " • " + totalDataRows + " rows";
        playerPrev.disabled = state.page <= 1;
        playerNext.disabled = state.page >= totalPages;
      }

      function renderHeader(rows) {
        const summary = rows[0];
        playerTitle.textContent = playerName;
        playerSubtitle.textContent = summary.team + " • " + summary.position + " • " + Math.min(...payload.matchRows.map((row) => Number(row.season || 0))) + "–" + Math.max(...payload.matchRows.map((row) => Number(row.season || 0)));
        builderLink.href = "/app-fixed?scope=player&player=" + encodeURIComponent(playerName) + "&mode=totals&format=overall&statKey=tries";
      }

      function render() {
        const rows = sortRows(aggregateRows(state.view, state.mode));
        renderHeader(rows);
        renderSummaryCards(rows);
        renderTable(rows);
        document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
        document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
        updateUrl();
      }

      playerSelect.innerHTML = payload.playerOptions.filter((name) => name && name !== "Any").map((name) => '<option value="' + name.replace(/"/g, "&quot;") + '"' + (name === playerName ? " selected" : "") + ">" + name + "</option>").join("");
      playerSelect.addEventListener("change", () => {
        const next = new URL(window.location.origin + "/player/" + encodeURIComponent(playerSelect.value));
        next.searchParams.set("view", state.view);
        next.searchParams.set("mode", state.mode);
        window.location.assign(next.toString());
      });
      document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
        state.view = button.dataset.view;
        state.page = 1;
        state.sort = "";
        state.direction = "";
        render();
      }));
      document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
        state.mode = button.dataset.mode;
        state.page = 1;
        render();
      }));
      playerPrev.addEventListener("click", () => {
        if (state.page > 1) {
          state.page -= 1;
          render();
        }
      });
      playerNext.addEventListener("click", () => {
        state.page += 1;
        render();
      });
      render();
    </script>
  </body>
</html>`;
}

function renderMatchPage(match: QueryRow | null, teamRows: QueryRow[]): string {
  if (!match) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${APP_NAME} - Match Not Found</title></head><body><h1>Match Not Found</h1></body></html>`;
  }

  const statKeys = ["tries", "goals", "penalty_goals", "field_goals_1pt", "field_goals_2pt", "all_run_metres", "all_runs", "line_breaks", "tackle_breaks", "offloads", "tackles_made", "missed_tackles", "errors", "kicks", "kicking_metres"];
  const rows = teamRows.map((row) => {
    const stats = typeof row.stats_json === "string" ? JSON.parse(String(row.stats_json || "{}")) : (row.stats_json || {});
    return { ...row, stats };
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - Match ${escapeHtml(match.match_id)}</title>
    <style>
      body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; background: #f7f4ea; color: #1f1c16; }
      .page { max-width: 1000px; margin: 0 auto; padding: 16px; }
      .panel { background: #fffdf6; border: 1px solid #d7d1be; padding: 12px; margin-bottom: 12px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #d7d1be; padding: 6px; text-align: left; }
      th { background: #efe8d7; }
      a { color: #2f5b84; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="panel">
        <p><a href="javascript:history.back()">Back</a></p>
        <h1 style="margin:0 0 6px;">${escapeHtml(match.home_team)} ${escapeHtml(match.home_score)} - ${escapeHtml(match.away_score)} ${escapeHtml(match.away_team)}</h1>
        <p style="margin:0;color:#6f6758;">${escapeHtml(match.competition)} | ${escapeHtml(match.season)} | ${escapeHtml(match.round_label)} | ${escapeHtml(match.match_reference)} | ${escapeHtml(match.ground)}</p>
      </section>
      <section class="panel">
        <table>
          <thead>
            <tr>
              <th>Stat</th>
              ${rows.map((row) => `<th>${escapeHtml(row.team)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Score</td>
              ${rows.map((row) => `<td>${escapeHtml(row.team_score)}</td>`).join("")}
            </tr>
            ${statKeys.map((key) => `<tr><td>${escapeHtml(key)}</td>${rows.map((row) => `<td>${escapeHtml((row as { stats: Record<string, unknown> }).stats[key] ?? "")}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </section>
    </div>
  </body>
</html>`;
}

function renderPlayerPageShell(playerName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - ${escapeHtml(playerName)}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root{--bg:#ece7d9;--panel:#f8f3e7;--line:#cdbf9e;--line-2:#b39f77;--text:#1f1d19;--muted:#6e6552;--green:#1e5631;--blue:#274d78;--gold:#b48a3a;--shadow:0 8px 24px rgba(65,49,22,.08)}
      *{box-sizing:border-box} body{margin:0;color:var(--text);font-family:Arial,Helvetica,sans-serif;background:linear-gradient(rgba(255,255,255,.14),rgba(255,255,255,.14)),repeating-linear-gradient(0deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),repeating-linear-gradient(90deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),var(--bg)}
      a{color:#0048c9;text-decoration:underline;text-underline-offset:2px}
      .shell{max-width:1600px;margin:0 auto;padding:16px}.masthead,.card,.sidebar{background:rgba(248,243,231,.94);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)} .masthead{padding:18px 20px;margin-bottom:14px}
      .brand h1{margin:0 0 4px;font-size:2rem}.brand p{margin:0;color:var(--muted)} .topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
      .ghost-btn,.seg-btn,.page-btn{appearance:none;border:1px solid var(--line-2);background:linear-gradient(180deg,#faf5ea,#efe6d4);color:var(--text);cursor:pointer;border-radius:10px;padding:10px 14px;font-weight:700;font-size:.94rem}
      .ghost-btn.primary{background:linear-gradient(180deg,#315f8d,#274d78);color:#fff;border-color:#274d78;text-decoration:none;display:inline-flex;align-items:center}
      .layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:14px;align-items:start}.sidebar{padding:14px;position:sticky;top:12px}.content-stack{display:grid;gap:14px;min-width:0}.card{overflow:hidden}
      .hero{padding:18px;position:relative}.hero::after{content:"";position:absolute;right:-40px;bottom:-40px;width:180px;height:180px;background:radial-gradient(circle, rgba(30,86,49,.1), transparent 70%)}
      .eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:.8rem;text-transform:uppercase;letter-spacing:.11em;color:var(--muted);font-weight:700;margin-bottom:10px}.eyebrow::before{content:"";width:26px;height:2px;background:var(--gold)}
      .hero-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:start}.hero-title{margin:0;font-size:2rem;line-height:1.08}.hero-sub{margin:8px 0 0;color:var(--muted);font-size:1rem}
      .filters{display:grid;gap:14px}.filter-group{border-top:1px solid var(--line);padding-top:14px}.filter-group:first-child{border-top:0;padding-top:0}.label{display:block;font-size:.82rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
      select{width:100%;border:1px solid var(--line-2);background:#fbf8f0;border-radius:10px;padding:10px 12px;color:var(--text);font:inherit}.segmented{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px;background:#efe8d8;border:1px solid var(--line-2);border-radius:12px}.seg-btn.active{background:var(--green);color:#fff;border-color:var(--green)}
      .summary-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;padding:14px}.metric{background:linear-gradient(180deg,#fcf8ef,#f2eadc);border:1px solid var(--line);border-radius:12px;padding:12px}.metric-label{display:block;color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:7px}.metric-value{font-size:1.35rem;font-weight:800;line-height:1.05}
      .metric.rank-card{padding:0;overflow:hidden;background:#f7c300}.metric.rank-card a,.metric.rank-card .rank-shell{display:flex;flex-direction:column;justify-content:space-between;min-height:116px;width:100%;padding:12px 14px;text-decoration:none;color:#000}.metric.rank-card .metric-label,.metric.rank-card .metric-value{color:#000}
      .section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:14px 16px 0}.section-head h3{margin:0;font-size:1.14rem}.pagination{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.table-meta{font-size:.88rem;color:var(--muted)}
      .table-shell{padding:12px 14px 16px;min-width:0}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fbf8f0} table{width:100%;border-collapse:separate;border-spacing:0;min-width:840px}
      thead th{position:sticky;top:0;z-index:1;background:#e7dcc5;color:#2b2418;font-size:.83rem;text-transform:uppercase;letter-spacing:.04em;text-align:left;border-bottom:1px solid var(--line-2);border-right:1px solid var(--line);padding:10px;white-space:nowrap}
      tbody td{border-bottom:1px solid #ddd0b2;border-right:1px solid #e3d7bc;padding:9px 10px;white-space:nowrap;font-size:.92rem} tbody tr:nth-child(odd){background:#fbf7ee} tbody tr:nth-child(even){background:#f5eedf} tbody tr:hover{background:#ecf2e8} tbody tr.summary-row{background:#dde8dd !important;font-weight:800}
      th.sortable{cursor:pointer;user-select:none} th.sortable::after{content:" ↕";color:#6c6049;font-weight:400} th.sortable.asc::after{content:" ↑"} th.sortable.desc::after{content:" ↓"}
      .loading,.error{padding:16px;color:var(--muted)} .error{color:#8f4d1c} .hidden{display:none}
      @media (max-width:1200px){.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}} @media (max-width:940px){.layout{grid-template-columns:1fr}.sidebar{position:relative;top:0}.hero-grid{grid-template-columns:1fr}} @media (max-width:720px){.shell{padding:10px}.brand h1{font-size:1.55rem}.hero-title{font-size:1.55rem}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="masthead">
        <div class="brand"><h1>${APP_NAME}</h1><p>Player profile in the house style with live local data.</p></div>
        <div class="topbar"><div class="muted">This page loads safely and will show an error instead of hanging the whole site if the backend is unavailable.</div><a class="ghost-btn" href="/app-fixed">← Back to Search</a></div>
      </header>
      <main class="layout">
        <aside class="sidebar">
          <div class="filters">
            <div class="filter-group"><span class="label">Selected player</span><select id="playerSelect"><option>${escapeHtml(playerName)}</option></select></div>
            <div class="filter-group"><span class="label">View</span><div class="segmented" id="viewToggle"><button class="seg-btn" data-view="seasons">Seasons</button><button class="seg-btn" data-view="matches">Matches</button><button class="seg-btn" data-view="team">Team</button><button class="seg-btn" data-view="position">Position</button></div></div>
            <div class="filter-group"><span class="label">Mode</span><div class="segmented" id="modeToggle"><button class="seg-btn" data-mode="totals">Totals</button><button class="seg-btn" data-mode="averages">Averages</button></div></div>
          </div>
        </aside>
        <div class="content-stack">
          <section class="card hero"><div class="eyebrow">Player profile</div><div class="hero-grid"><div><h2 class="hero-title" id="playerTitle">${escapeHtml(playerName)}</h2><p class="hero-sub" id="playerSubtitle">Loading player profile…</p></div><div><a class="ghost-btn primary" id="builderLink" href="/app-fixed">Run Query</a></div></div></section>
          <section class="card"><div class="summary-grid" id="playerSummaryGrid"><div class="metric"><span class="metric-label">Loading</span><div class="metric-value">…</div></div></div></section>
          <section class="card">
            <div class="section-head"><div><h3 id="playerTableTitle">${escapeHtml(playerName)}</h3></div><div class="pagination"><button class="page-btn" id="playerPrev">Prev</button><span class="table-meta" id="playerPageMeta">Loading…</span><button class="page-btn" id="playerNext">Next</button></div></div>
            <div class="table-shell">
              <div id="playerError" class="error hidden"></div>
              <div class="table-wrap" id="playerTableWrap"><table id="playerTable"><thead></thead><tbody></tbody></table></div>
            </div>
          </section>
        </div>
      </main>
    </div>
    <script>
      const playerName = decodeURIComponent(${JSON.stringify(encodeURIComponent(playerName))});
      const playerSelect = document.getElementById("playerSelect");
      const playerTitle = document.getElementById("playerTitle");
      const playerSubtitle = document.getElementById("playerSubtitle");
      const builderLink = document.getElementById("builderLink");
      const summaryGrid = document.getElementById("playerSummaryGrid");
      const playerTable = document.getElementById("playerTable");
      const playerTableTitle = document.getElementById("playerTableTitle");
      const playerPageMeta = document.getElementById("playerPageMeta");
      const playerPrev = document.getElementById("playerPrev");
      const playerNext = document.getElementById("playerNext");
      const playerError = document.getElementById("playerError");
      const playerTableWrap = document.getElementById("playerTableWrap");
      const pageSize = 12;
      const tableStatKeys = ["tries","goals","field_goals_1pt","points","all_run_metres","try_assists","line_breaks","tackles_made","errors"];
      const statLabels = { season:"Season", team:"Team", position:"Position", games:"Games", tries:"Tries", goals:"Goals", field_goals_1pt:"1FG", points:"Points", all_run_metres:"Run Metres", try_assists:"Try Assists", line_breaks:"Line Breaks", tackles_made:"Tackles Made", errors:"Errors", match_reference:"Match", opposition:"Opposition", ground:"Ground", result:"Result" };
      const viewColumns = { seasons:["season","team","position","games",...tableStatKeys], matches:["match_reference","team","opposition","ground","position","result",...tableStatKeys], team:["team","position","games",...tableStatKeys], position:["position","games",...tableStatKeys] };
      const state = { view:new URLSearchParams(window.location.search).get("view")||"seasons", mode:new URLSearchParams(window.location.search).get("mode")||"totals", page:Math.max(1, Number(new URLSearchParams(window.location.search).get("page")||"1")), sort:new URLSearchParams(window.location.search).get("sort")||"", direction:new URLSearchParams(window.location.search).get("direction")||"" };
      let payload = null;
      let rankingCards = [];
      function toNumber(value){ if(value===null||value===undefined||value==="") return 0; const numeric=Number(value); return Number.isFinite(numeric)?numeric:0; }
      function formatNumber(value, decimals=0){ if(value===null||value===undefined||value==="") return ""; const numeric=Number(value); if(!Number.isFinite(numeric)) return String(value); return numeric.toLocaleString(undefined,{minimumFractionDigits:decimals, maximumFractionDigits:decimals});}
      function parseStats(row){ return typeof row.stats_json==="string" ? JSON.parse(row.stats_json||"{}") : (row.stats_json||{}); }
      function matchStatValue(row, statKey){ const stats=parseStats(row); if(statKey==="games") return 1; if(statKey==="points"){ return (toNumber(stats.tries)*4)+(toNumber(stats.goals)*2)+toNumber(stats.field_goals_1pt)+(toNumber(stats.field_goals_2pt)*2);} return toNumber(stats[statKey]); }
      function buildMatchRows(){ return payload.matchRows.map((row)=>{ const resultText = row.result_code==="W" ? "W " + row.team_score + "–" + row.opponent_score : row.result_code==="L" ? "L " + row.team_score + "–" + row.opponent_score : "D " + row.team_score + "–" + row.opponent_score; const out={ season:row.season, round:row.round_label, team:row.team, opposition:row.opposition, ground:row.ground, position:row.position_label||"Unknown", match_reference:row.match_reference, match_sort_key:row.match_sort_key, match_id:row.match_id, result:resultText, games:1 }; for(const statKey of tableStatKeys){ out[statKey]=matchStatValue(row, statKey); } return out; });}
      function summarisePrimary(values){ const counts=new Map(); for(const value of values){ const text=String(value||"Unknown"); counts.set(text,(counts.get(text)||0)+1);} const ordered=[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])); if(!ordered.length) return "Unknown"; return ordered.length===1 ? ordered[0][0] : ordered.slice(0,2).map((entry)=>entry[0]).join(" / "); }
      function createSummaryRow(matchRows, mode){ const summary={ season:"Career", team:summarisePrimary(matchRows.map((row)=>row.team)), position:summarisePrimary(matchRows.map((row)=>row.position)), games:matchRows.length, __summary:true }; for(const statKey of tableStatKeys){ const total=matchRows.reduce((sum,row)=>sum+toNumber(row[statKey]),0); summary[statKey]=mode==="averages"&&matchRows.length>0 ? Number((total/matchRows.length).toFixed(3)) : total; } return summary; }
      function aggregateRows(view, mode){ const matchRows=buildMatchRows(); if(view==="matches"){ return [createSummaryRow(matchRows, mode), ...matchRows]; } const groups=new Map(); for(const row of matchRows){ const key=view==="seasons"?String(row.season):view==="team"?String(row.team):String(row.position); if(!groups.has(key)){ const seed={ season:view==="seasons"?row.season:"", team:view==="team"?row.team:(view==="seasons"?row.team:""), position:view==="position"?row.position:(view==="seasons"?row.position:""), games:0 }; for(const statKey of tableStatKeys){ seed[statKey]=0; } groups.set(key, seed); } const bucket=groups.get(key); bucket.games+=1; if(view==="seasons"){ bucket.team = bucket.team || row.team; bucket.position = bucket.position || row.position; } else if(view==="team"){ if(!bucket.position || bucket.position==="Mixed") bucket.position=row.position; else if(bucket.position!==row.position) bucket.position="Mixed"; } for(const statKey of tableStatKeys){ bucket[statKey]+=toNumber(row[statKey]); } } const rows=[...groups.values()].map((row)=>{ const out={...row}; if(mode==="averages"){ for(const statKey of tableStatKeys){ out[statKey]=row.games>0 ? Number((toNumber(row[statKey])/row.games).toFixed(3)) : 0; } } return out; }); return [createSummaryRow(matchRows, mode), ...rows]; }
      function compareValues(a,b,column){ if(column==="match_reference"){ return String(a.match_sort_key||"").localeCompare(String(b.match_sort_key||"")); } const left=a[column]; const right=b[column]; const leftNum=Number(left); const rightNum=Number(right); if(Number.isFinite(leftNum)&&Number.isFinite(rightNum)) return leftNum-rightNum; return String(left||"").localeCompare(String(right||"")); }
      function sortRows(rows){ const summary=rows[0]; const dataRows=rows.slice(1); const defaultSort=state.view==="matches"?{column:"match_reference",direction:"desc"}:state.view==="seasons"?{column:"season",direction:"desc"}:{column:"games",direction:"desc"}; const sortColumn=state.sort||defaultSort.column; const direction=state.direction||defaultSort.direction; dataRows.sort((left,right)=>{ const result=compareValues(left,right,sortColumn); return direction==="asc"?result:-result; }); return [summary, ...dataRows]; }
      function updateUrl(){ const next=new URL(window.location.href); next.searchParams.set("view", state.view); next.searchParams.set("mode", state.mode); next.searchParams.set("page", String(state.page)); if(state.sort) next.searchParams.set("sort", state.sort); else next.searchParams.delete("sort"); if(state.direction) next.searchParams.set("direction", state.direction); else next.searchParams.delete("direction"); history.replaceState(null, "", next.toString()); }
      function renderSummaryCards(rows){ const summary=rows[0]; const cards=['<div class="metric"><span class="metric-label">Matches</span><div class="metric-value">'+formatNumber(summary.games)+'</div></div>','<div class="metric"><span class="metric-label">'+(state.mode==="averages"?"Avg points":"Points")+'</span><div class="metric-value">'+formatNumber(summary.points, state.mode==="averages"?3:0)+'</div></div>']; if(rankingCards.length){ cards.push(...rankingCards.map((card)=>'<div class="metric rank-card"><a href="/app-fixed?scope=player&player='+encodeURIComponent(playerName)+'&mode=totals&format=overall&statKey='+encodeURIComponent(card.statKey)+'"><span class="metric-label">'+card.label+'</span><div class="metric-value">'+card.rank+'th</div></a></div>')); } else { cards.push('<div class="metric rank-card"><div class="rank-shell"><span class="metric-label">Rankings</span><div class="metric-value">Unavailable</div></div></div>'); } summaryGrid.innerHTML=cards.join(""); }
      function renderTable(rows){ const columns=viewColumns[state.view]; const sortColumn=state.sort||(state.view==="matches"?"match_reference":state.view==="seasons"?"season":"games"); const sortDirection=state.direction||"desc"; const totalDataRows=Math.max(0, rows.length-1); const totalPages=Math.max(1, Math.ceil(totalDataRows/pageSize)); if(state.page>totalPages) state.page=totalPages; const summaryRow=rows[0]; const dataRows=rows.slice(1); const pagedRows=dataRows.slice((state.page-1)*pageSize, state.page*pageSize); const visibleRows=[summaryRow, ...pagedRows];
        playerTable.querySelector("thead").innerHTML="<tr>"+columns.map((column)=>{ const klass=["sortable"]; if(sortColumn===column) klass.push(sortDirection==="asc"?"asc":"desc"); return '<th class="'+klass.join(" ")+'" data-column="'+column+'">'+(statLabels[column]||column)+"</th>"; }).join("")+"</tr>";
        playerTable.querySelector("tbody").innerHTML=visibleRows.map((row)=>{ const rowClass=row.__summary?' class="summary-row"':""; return "<tr"+rowClass+">"+columns.map((column)=>{ let value=row[column]; if(column==="team" && row.match_id){ value='<a href="/app-fixed?scope=player&player='+encodeURIComponent(playerName)+'&team='+encodeURIComponent(String(row.team))+'&mode=totals&format=overall&statKey=tries">'+value+'</a>'; } else if(column==="match_reference" && row.match_id){ value='<a href="/match/'+row.match_id+'">'+value+'</a>'; } else if(typeof value==="number"){ value=formatNumber(value, state.mode==="averages"&&column!=="games"?3:0); } return "<td>"+(value??"")+"</td>"; }).join("")+"</tr>"; }).join("");
        playerTable.querySelectorAll("th[data-column]").forEach((header)=>{ header.addEventListener("click", ()=>{ const column=header.dataset.column; if(state.sort===column) state.direction=state.direction==="asc"?"desc":"asc"; else { state.sort=column; state.direction="desc"; } state.page=1; render(); }); });
        playerTableTitle.textContent=playerName; playerPageMeta.textContent="Page "+state.page+" of "+totalPages+" • "+totalDataRows+" rows"; playerPrev.disabled=state.page<=1; playerNext.disabled=state.page>=totalPages; }
      function renderHeader(rows){ const summary=rows[0]; const seasons=payload.matchRows.map((row)=>Number(row.season||0)).filter((value)=>Number.isFinite(value)&&value>0); const seasonFrom=Math.min(...seasons); const seasonTo=Math.max(...seasons); playerTitle.textContent=playerName; playerSubtitle.textContent=summary.team+" • "+summary.position+" • "+seasonFrom+"–"+seasonTo; builderLink.href="/app-fixed?scope=player&player="+encodeURIComponent(playerName)+"&mode=totals&format=overall&statKey=tries"; }
      function render(){ const rows=sortRows(aggregateRows(state.view, state.mode)); renderHeader(rows); renderSummaryCards(rows); renderTable(rows); document.querySelectorAll("[data-view]").forEach((button)=>button.classList.toggle("active", button.dataset.view===state.view)); document.querySelectorAll("[data-mode]").forEach((button)=>button.classList.toggle("active", button.dataset.mode===state.mode)); updateUrl(); }
      async function fetchJson(url, timeoutMs){ const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(), timeoutMs); try { const response=await fetch(url, {cache:"no-store", signal:controller.signal}); const payload=await response.json(); if(!response.ok||!payload?.ok) throw new Error(payload?.error||("Request failed with status "+response.status)); return payload; } finally { clearTimeout(timer); } }
      async function init(){ try { payload = await fetchJson("/api/player-profile?player="+encodeURIComponent(playerName), 12000); playerSelect.innerHTML=payload.playerOptions.filter((name)=>name&&name!=="Any").map((name)=>'<option value="'+String(name).replace(/"/g,"&quot;")+'"'+(name===playerName?" selected":"")+">"+name+"</option>").join(""); playerSelect.addEventListener("change", ()=>{ const next=new URL(window.location.origin+"/player/"+encodeURIComponent(playerSelect.value)); next.searchParams.set("view", state.view); next.searchParams.set("mode", state.mode); window.location.assign(next.toString()); }); document.querySelectorAll("[data-view]").forEach((button)=>button.addEventListener("click", ()=>{ state.view=button.dataset.view; state.page=1; state.sort=""; state.direction=""; render(); })); document.querySelectorAll("[data-mode]").forEach((button)=>button.addEventListener("click", ()=>{ state.mode=button.dataset.mode; state.page=1; render(); })); playerPrev.addEventListener("click", ()=>{ if(state.page>1){ state.page-=1; render(); }}); playerNext.addEventListener("click", ()=>{ state.page+=1; render(); }); render();
      } catch (error) { playerSubtitle.textContent="Unable to load player profile."; playerError.textContent=error instanceof Error?error.message:String(error); playerError.classList.remove("hidden"); playerTableWrap.classList.add("hidden"); summaryGrid.innerHTML='<div class="metric"><span class="metric-label">Status</span><div class="metric-value">Unavailable</div></div>'; playerPageMeta.textContent="Load failed"; } }
      init();
    </script>
  </body>
</html>`;
}

function renderPlayerPageShellV2(playerName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - ${escapeHtml(playerName)}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root{--bg:#ece7d9;--panel:#f8f3e7;--line:#cdbf9e;--line-2:#b39f77;--text:#1f1d19;--muted:#6e6552;--green:#1e5631;--gold:#b48a3a;--shadow:0 8px 24px rgba(65,49,22,.08)}
      *{box-sizing:border-box} body{margin:0;color:var(--text);font-family:Arial,Helvetica,sans-serif;background:linear-gradient(rgba(255,255,255,.14),rgba(255,255,255,.14)),repeating-linear-gradient(0deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),repeating-linear-gradient(90deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),var(--bg)}
      a{color:#0048c9;text-decoration:underline;text-underline-offset:2px}
      .shell{max-width:1600px;margin:0 auto;padding:16px}.masthead,.card,.sidebar{background:rgba(248,243,231,.94);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)} .masthead{padding:18px 20px;margin-bottom:14px}
      .brand h1{margin:0 0 4px;font-size:2rem}.brand p{margin:0;color:var(--muted)}.topbar{display:flex;justify-content:flex-end;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
      .ghost-btn,.seg-btn,.include-btn{appearance:none;border:1px solid var(--line-2);background:linear-gradient(180deg,#faf5ea,#efe6d4);color:var(--text);cursor:pointer;border-radius:10px;padding:10px 14px;font-weight:700;font-size:.94rem}
      .layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:14px;align-items:start}.sidebar{padding:14px;position:sticky;top:12px}.content-stack{display:grid;gap:14px;min-width:0}.card{overflow:hidden}
      .hero{padding:18px;position:relative}.hero::after{content:"";position:absolute;right:-40px;bottom:-40px;width:180px;height:180px;background:radial-gradient(circle, rgba(30,86,49,.1), transparent 70%)}
      .eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:.8rem;text-transform:uppercase;letter-spacing:.11em;color:var(--muted);font-weight:700;margin-bottom:10px}.eyebrow::before{content:"";width:26px;height:2px;background:var(--gold)}
      .hero-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}.hero-title{margin:0;font-size:2rem;line-height:1.08}.hero-sub{margin:8px 0 0;color:var(--muted);font-size:1rem}
      .filters{display:grid;gap:14px}.filter-group{border-top:1px solid var(--line);padding-top:14px}.filter-group:first-child{border-top:0;padding-top:0}.label{display:block;font-size:.82rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
      .search-inline{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
      .search-inline input{width:100%;border:1px solid var(--line-2);background:#fbf8f0;border-radius:10px;padding:10px 12px;color:var(--text);font:inherit}
      .search-inline button{appearance:none;border:1px solid #274d78;background:linear-gradient(180deg,#315f8d,#274d78);color:#fff;cursor:pointer;border-radius:10px;padding:10px 14px;font-weight:700;font-size:.94rem}
      .segmented,.include-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px;background:#efe8d8;border:1px solid var(--line-2);border-radius:12px}.seg-btn.active,.include-btn.active{background:var(--green);color:#fff;border-color:var(--green)}
      .summary-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;padding:14px}.metric{background:linear-gradient(180deg,#fcf8ef,#f2eadc);border:1px solid var(--line);border-radius:12px;padding:12px}.metric-label{display:block;color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:7px}.metric-value{font-size:1.35rem;font-weight:800;line-height:1.05}
      .metric.rank-card{padding:0;overflow:hidden;background:#f7c300}.metric.rank-card a,.metric.rank-card .rank-shell{display:flex;flex-direction:column;justify-content:space-between;min-height:116px;width:100%;padding:12px 14px;text-decoration:none;color:#000}.metric.rank-card .metric-label,.metric.rank-card .metric-value{color:#000}
      .section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:14px 16px 0}.section-head h3{margin:0;font-size:1.14rem}.table-meta{font-size:.88rem;color:var(--muted)}
      .table-shell{padding:12px 14px 16px;min-width:0}.table-scrollbar{overflow-x:auto;overflow-y:hidden;height:18px;border:1px solid var(--line);border-bottom:0;border-radius:12px 12px 0 0;background:#f1eadc}.table-scrollbar-inner{height:1px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:0 0 12px 12px;background:#fbf8f0} table{width:100%;border-collapse:separate;border-spacing:0;min-width:840px}
      thead th{position:sticky;top:0;z-index:1;background:#e7dcc5;color:#2b2418;font-size:.83rem;text-transform:uppercase;letter-spacing:.04em;text-align:left;border-bottom:1px solid var(--line-2);border-right:1px solid var(--line);padding:10px;white-space:nowrap}
      tbody td{border-bottom:1px solid #ddd0b2;border-right:1px solid #e3d7bc;padding:9px 10px;white-space:nowrap;font-size:.92rem} tbody tr:nth-child(odd){background:#fbf7ee} tbody tr:nth-child(even){background:#f5eedf} tbody tr:hover{background:#ecf2e8} tbody tr.summary-row{background:#dde8dd !important;font-weight:800}
      th.sortable{cursor:pointer;user-select:none} th.sortable::after{content:" ↕";color:#6c6049;font-weight:400} th.sortable.asc::after{content:" ↑"} th.sortable.desc::after{content:" ↓"}
      .loading,.error{padding:16px;color:var(--muted)} .error{color:#8f4d1c} .hidden{display:none}
      @media (max-width:1200px){.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}} @media (max-width:940px){.layout{grid-template-columns:1fr}.sidebar{position:relative;top:0}} @media (max-width:720px){.shell{padding:10px}.brand h1{font-size:1.55rem}.hero-title{font-size:1.55rem}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.search-inline{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="masthead">
        <div class="brand"><h1>${APP_NAME}</h1><p id="playerFreshness">Loading data freshness...</p></div>
        <div class="topbar"><a class="ghost-btn" href="/app-fixed">← Back to Search</a></div>
      </header>
      <main class="layout">
        <aside class="sidebar">
          <div class="filters">
            <div class="filter-group">
              <span class="label">Selected player</span>
              <div class="search-inline">
                <input id="playerSearch" list="playerOptions" value="${escapeHtml(playerName)}" />
                <button type="button" id="playerGo">Go</button>
              </div>
              <datalist id="playerOptions"></datalist>
            </div>
            <div class="filter-group"><span class="label">Include</span><div class="include-grid"><button class="include-btn" type="button" data-include="NRL">NRL</button><button class="include-btn" type="button" data-include="SOO">SOO</button></div></div>
            <div class="filter-group"><span class="label">View</span><div class="segmented" id="viewToggle"><button class="seg-btn" data-view="seasons">Seasons</button><button class="seg-btn" data-view="matches">Matches</button><button class="seg-btn" data-view="team">Team</button><button class="seg-btn" data-view="position">Position</button></div></div>
            <div class="filter-group"><span class="label">Mode</span><div class="segmented" id="modeToggle"><button class="seg-btn" data-mode="totals">Totals</button><button class="seg-btn" data-mode="averages">Averages</button></div></div>
          </div>
        </aside>
        <div class="content-stack">
          <section class="card hero"><div class="eyebrow">Player profile</div><div class="hero-grid"><div><h2 class="hero-title" id="playerTitle">${escapeHtml(playerName)}</h2><p class="hero-sub" id="playerSubtitle">Loading player profile...</p></div></div></section>
          <section class="card"><div class="summary-grid" id="playerSummaryGrid"><div class="metric"><span class="metric-label">Loading</span><div class="metric-value">...</div></div></div></section>
          <section class="card">
            <div class="section-head"><div><h3 id="playerTableTitle">${escapeHtml(playerName)}</h3></div><div class="table-meta" id="playerPageMeta">Loading...</div></div>
            <div class="table-shell">
              <div id="playerError" class="error hidden"></div>
              <div class="table-scrollbar" id="playerTableScrollbar"><div class="table-scrollbar-inner" id="playerTableScrollbarInner"></div></div>
              <div class="table-wrap" id="playerTableWrap"><table id="playerTable"><thead></thead><tbody></tbody></table></div>
            </div>
          </section>
        </div>
      </main>
    </div>
    <script>
      const playerName = decodeURIComponent(${JSON.stringify(encodeURIComponent(playerName))});
      const playerSearch = document.getElementById("playerSearch");
      const playerOptions = document.getElementById("playerOptions");
      const playerGo = document.getElementById("playerGo");
      const playerTitle = document.getElementById("playerTitle");
      const playerSubtitle = document.getElementById("playerSubtitle");
      const playerFreshness = document.getElementById("playerFreshness");
      const summaryGrid = document.getElementById("playerSummaryGrid");
      const playerTable = document.getElementById("playerTable");
      const playerTableTitle = document.getElementById("playerTableTitle");
      const playerPageMeta = document.getElementById("playerPageMeta");
      const playerError = document.getElementById("playerError");
      const playerTableWrap = document.getElementById("playerTableWrap");
      const playerTableScrollbar = document.getElementById("playerTableScrollbar");
      const playerTableScrollbarInner = document.getElementById("playerTableScrollbarInner");
      const tableStatKeys = ${safeJsonScript(PLAYER_PROFILE_TABLE_STAT_KEYS)};
      const statLabels = { season:"Season", round:"Round", team:"Team", position:"Position", games:"Games", tries:"Tries", goals:"Goals", field_goals_1pt:"1FG", field_goals_2pt:"2FG", points:"Points", all_runs:"All Runs", all_run_metres:"Run Metres", post_contact_metres:"Post Contact Metres", try_assists:"Try Assists", line_breaks:"Line Breaks", line_break_assists:"Line Break Assists", line_engaged_runs:"Line Engaged Runs", hit_ups:"Hit Ups", dummy_half_runs:"Dummy Half Runs", dummy_half_run_metres:"Dummy Half Run Metres", tackle_breaks:"Tackle Breaks", offloads:"Offloads", tackles_made:"Tackles Made", missed_tackles:"Missed Tackles", ineffective_tackles:"Ineffective Tackles", errors:"Errors", handling_errors:"Handling Errors", penalties:"Penalties", kicking_metres:"Kicking Metres", kicks:"Kicks", bomb_kicks:"Bomb Kicks", grubbers:"Grubbers", kicked_dead:"Kicked Dead", cross_field_kicks:"Cross Field Kicks", "40_20":"40/20", "20_40":"20/40", dummy_passes:"Dummy Passes", passes:"Passes", play_the_ball:"Play The Ball", receipts:"Receipts", one_on_one_steal:"One on One Steal", one_on_one_lost:"One on One Lost", kicks_defused:"Kicks Defused", sin_bins:"Sin Bins", send_offs:"Send Offs", on_report:"On Report", minutes_played:"Minutes Played", match_reference:"Match", opposition:"Opposition", ground:"Ground", result:"Result" };
      const viewColumns = { seasons:["season","team","position","games",...tableStatKeys], matches:["season","round","team","opposition","ground","match_reference","result","position",...tableStatKeys], team:["team","position","games",...tableStatKeys], position:["position","games",...tableStatKeys] };
      const state = { view:new URLSearchParams(window.location.search).get("view")||"seasons", mode:new URLSearchParams(window.location.search).get("mode")||"totals", sort:new URLSearchParams(window.location.search).get("sort")||"", direction:new URLSearchParams(window.location.search).get("direction")||"", competition:new URLSearchParams(window.location.search).get("competition")||"NRL" };
      let payload = null;
      let rankingCards = [];
      function buildRoundAnchor(roundLabel){ const normalized=String(roundLabel||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); return "round-"+(normalized||"unknown"); }
      function buildSeasonHref(season, roundLabel){ const params = new URLSearchParams(); params.set("competition", state.competition); params.set("season", String(season)); return "/season?" + params.toString() + (roundLabel ? "#" + buildRoundAnchor(roundLabel) : ""); }
      function toNumber(value){ if(value===null||value===undefined||value==="") return 0; const numeric=Number(value); return Number.isFinite(numeric)?numeric:0; }
      function formatNumber(value, decimals=0){ if(value===null||value===undefined||value==="") return ""; const numeric=Number(value); if(!Number.isFinite(numeric)) return String(value); return numeric.toLocaleString(undefined,{minimumFractionDigits:decimals, maximumFractionDigits:decimals});}
      function parseStats(row){ return typeof row.stats_json==="string" ? JSON.parse(row.stats_json||"{}") : (row.stats_json||{}); }
      function matchStatValue(row, statKey){ const stats=parseStats(row); if(statKey==="games") return 1; if(statKey==="points"){ return (toNumber(stats.tries)*4)+(toNumber(stats.goals)*2)+toNumber(stats.field_goals_1pt)+(toNumber(stats.field_goals_2pt)*2);} return toNumber(stats[statKey]); }
      function includesPrimary(){ return state.competition === "NRL" || state.competition === "NRL_PLUS_SOO"; }
      function includesRep(){ return state.competition === "SOO" || state.competition === "NRL_PLUS_SOO"; }
      function syncIncludeButtons(){ document.querySelectorAll("[data-include]").forEach((button)=>{ const code=button.dataset.include; button.classList.toggle("active", code==="NRL" ? includesPrimary() : includesRep()); }); }
      function setCompetitionFromInclude(code){ const nextPrimary = code === "NRL" ? !includesPrimary() : includesPrimary(); const nextRep = code === "SOO" ? !includesRep() : includesRep(); if(!nextPrimary && !nextRep){ state.competition = code; } else if(nextPrimary && nextRep){ state.competition = "NRL_PLUS_SOO"; } else if(nextRep){ state.competition = "SOO"; } else { state.competition = "NRL"; } }
      function buildMatchRows(){ return payload.matchRows.map((row)=>{ const resultText = row.result_code==="W" ? "W " + row.team_score + "–" + row.opponent_score : row.result_code==="L" ? "L " + row.team_score + "–" + row.opponent_score : "D " + row.team_score + "–" + row.opponent_score; const out={ season:row.season, round:row.round_label, team:row.team, opposition:row.opposition, ground:row.ground, position:row.position_label||"Unknown", match_reference:row.match_reference, match_sort_key:row.match_sort_key, match_id:row.match_id, result:resultText, games:1 }; for(const statKey of tableStatKeys){ out[statKey]=matchStatValue(row, statKey); } return out; });}
      function summarisePrimary(values){ const counts=new Map(); for(const value of values){ const text=String(value||"Unknown"); counts.set(text,(counts.get(text)||0)+1);} const ordered=[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])); if(!ordered.length) return "Unknown"; return ordered.length===1 ? ordered[0][0] : ordered.slice(0,2).map((entry)=>entry[0]).join(" / "); }
      function createSummaryRow(matchRows, mode){ const summary={ season:"Career", team:summarisePrimary(matchRows.map((row)=>row.team)), position:summarisePrimary(matchRows.map((row)=>row.position)), games:matchRows.length, __summary:true }; for(const statKey of tableStatKeys){ const total=matchRows.reduce((sum,row)=>sum+toNumber(row[statKey]),0); summary[statKey]=mode==="averages"&&matchRows.length>0 ? Number((total/matchRows.length).toFixed(3)) : total; } return summary; }
      function aggregateRows(view, mode){ const matchRows=buildMatchRows(); if(view==="matches"){ return [createSummaryRow(matchRows, mode), ...matchRows]; } const groups=new Map(); for(const row of matchRows){ const key=view==="seasons"?String(row.season):view==="team"?String(row.team):String(row.position); if(!groups.has(key)){ const seed={ season:view==="seasons"?row.season:"", team:view==="team"?row.team:(view==="seasons"?row.team:""), position:view==="position"?row.position:(view==="seasons"?row.position:""), games:0 }; for(const statKey of tableStatKeys){ seed[statKey]=0; } groups.set(key, seed); } const bucket=groups.get(key); bucket.games+=1; if(view==="seasons"){ bucket.team = bucket.team || row.team; bucket.position = bucket.position || row.position; } else if(view==="team"){ if(!bucket.position || bucket.position==="Mixed") bucket.position=row.position; else if(bucket.position!==row.position) bucket.position="Mixed"; } for(const statKey of tableStatKeys){ bucket[statKey]+=toNumber(row[statKey]); } } const rows=[...groups.values()].map((row)=>{ const out={...row}; if(mode==="averages"){ for(const statKey of tableStatKeys){ out[statKey]=row.games>0 ? Number((toNumber(row[statKey])/row.games).toFixed(3)) : 0; } } return out; }); return [createSummaryRow(matchRows, mode), ...rows]; }
      function compareValues(a,b,column){ if(column==="match_reference"){ return String(a.match_sort_key||"").localeCompare(String(b.match_sort_key||"")); } const left=a[column]; const right=b[column]; const leftNum=Number(left); const rightNum=Number(right); if(Number.isFinite(leftNum)&&Number.isFinite(rightNum)) return leftNum-rightNum; return String(left||"").localeCompare(String(right||"")); }
      function sortRows(rows){ const summary=rows[0]; const dataRows=rows.slice(1); const defaultSort=state.view==="matches"?{column:"match_reference",direction:"desc"}:state.view==="seasons"?{column:"season",direction:"desc"}:{column:"games",direction:"desc"}; const sortColumn=state.sort||defaultSort.column; const direction=state.direction||defaultSort.direction; dataRows.sort((left,right)=>{ const result=compareValues(left,right,sortColumn); return direction==="asc"?result:-result; }); return [summary, ...dataRows]; }
      function updateUrl(){ const next=new URL(window.location.href); next.searchParams.set("view", state.view); next.searchParams.set("mode", state.mode); next.searchParams.set("competition", state.competition); if(state.sort) next.searchParams.set("sort", state.sort); else next.searchParams.delete("sort"); if(state.direction) next.searchParams.set("direction", state.direction); else next.searchParams.delete("direction"); next.searchParams.delete("page"); history.replaceState(null, "", next.toString()); }
      function ordinalSuffix(value){ const number=Number(value); const abs=Math.abs(number); const mod100=abs%100; if(mod100>=11&&mod100<=13) return String(number)+"th"; switch(abs%10){ case 1: return String(number)+"st"; case 2: return String(number)+"nd"; case 3: return String(number)+"rd"; default: return String(number)+"th"; } }
      function renderSummaryCards(rows){ const summary=rows[0]; const cards=['<div class="metric"><span class="metric-label">Matches</span><div class="metric-value">'+formatNumber(summary.games)+'</div></div>','<div class="metric"><span class="metric-label">'+(state.mode==="averages"?"Avg points":"Points")+'</span><div class="metric-value">'+formatNumber(summary.points, state.mode==="averages"?3:0)+'</div></div>']; if(rankingCards.length){ cards.push(...rankingCards.map((card)=>'<div class="metric rank-card"><a href="/app-fixed?scope=player&player='+encodeURIComponent(playerName)+'&mode=totals&format=overall&competition='+encodeURIComponent(state.competition)+'&statKey='+encodeURIComponent(card.statKey)+'"><span class="metric-label">'+card.label+'</span><div class="metric-value">'+ordinalSuffix(card.rank)+'</div></a></div>')); } else { cards.push('<div class="metric rank-card"><div class="rank-shell"><span class="metric-label">Rankings</span><div class="metric-value">Unavailable</div></div></div>'); } summaryGrid.innerHTML=cards.join(""); }
      function syncPlayerScrollbar(){ const table=playerTableWrap.querySelector("table"); const width=table ? table.scrollWidth : playerTableWrap.scrollWidth; playerTableScrollbarInner.style.width=width+"px"; playerTableScrollbar.style.display=width > playerTableWrap.clientWidth ? "block" : "none"; }
      function renderTable(rows){ const columns=viewColumns[state.view]; const sortColumn=state.sort||(state.view==="matches"?"match_reference":state.view==="seasons"?"season":"games"); const sortDirection=state.direction||"desc"; const totalDataRows=Math.max(0, rows.length-1); const visibleRows=rows.slice();
        playerTable.querySelector("thead").innerHTML="<tr>"+columns.map((column)=>{ const klass=["sortable"]; if(sortColumn===column) klass.push(sortDirection==="asc"?"asc":"desc"); return '<th class="'+klass.join(" ")+'" data-column="'+column+'">'+(statLabels[column]||column)+"</th>"; }).join("")+"</tr>";
        playerTable.querySelector("tbody").innerHTML=visibleRows.map((row)=>{ const rowClass=row.__summary?' class="summary-row"':""; return "<tr"+rowClass+">"+columns.map((column)=>{ let value=row[column]; if(column==="season" && row.season && !row.__summary){ value='<a href="'+buildSeasonHref(row.season, state.view==="matches" ? row.round : "")+'">'+String(row.season)+'</a>'; } else if(column==="round" && row.round && row.season && !row.__summary){ value='<a href="'+buildSeasonHref(row.season, row.round)+'">'+String(row.round)+'</a>'; } else if(column==="team" && row.match_id){ value='<a href="/app-fixed?scope=player&player='+encodeURIComponent(playerName)+'&team='+encodeURIComponent(String(row.team))+'&mode=totals&format=overall&competition='+encodeURIComponent(state.competition)+'&statKey=tries">'+value+'</a>'; } else if(column==="match_reference" && row.match_id){ value='<a href="/match/'+row.match_id+'">'+(value||"Match")+'</a>'; } else if(typeof value==="number"){ value=column==="season"?String(value):formatNumber(value, state.mode==="averages"&&column!=="games"?3:0); } return "<td>"+(value??"")+"</td>"; }).join("")+"</tr>"; }).join("");
        playerTable.querySelectorAll("th[data-column]").forEach((header)=>{ header.addEventListener("click", ()=>{ const column=header.dataset.column; if(state.sort===column) state.direction=state.direction==="asc"?"desc":"asc"; else { state.sort=column; state.direction="desc"; } render(); }); });
        playerTableTitle.textContent=playerName; playerPageMeta.textContent=totalDataRows+" rows"; syncPlayerScrollbar(); }
      function renderHeader(rows){ const summary=rows[0]; const seasons=payload.matchRows.map((row)=>Number(row.season||0)).filter((value)=>Number.isFinite(value)&&value>0); const seasonFrom=Math.min(...seasons); const seasonTo=Math.max(...seasons); playerTitle.textContent=playerName; playerSubtitle.textContent=summary.team+" • "+summary.position+" • "+seasonFrom+"–"+seasonTo; }
      function render(){ const rows=sortRows(aggregateRows(state.view, state.mode)); renderHeader(rows); renderSummaryCards(rows); renderTable(rows); document.querySelectorAll("[data-view]").forEach((button)=>button.classList.toggle("active", button.dataset.view===state.view)); document.querySelectorAll("[data-mode]").forEach((button)=>button.classList.toggle("active", button.dataset.mode===state.mode)); syncIncludeButtons(); updateUrl(); }
      async function fetchJson(url, timeoutMs){ const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(), timeoutMs); try { const response=await fetch(url, {cache:"no-store", signal:controller.signal}); const payload=await response.json(); if(!response.ok||!payload?.ok) throw new Error(payload?.error||("Request failed with status "+response.status)); return payload; } finally { clearTimeout(timer); } }
      async function loadFreshness(){ try { const bootstrap=await fetchJson("/api/meta/bootstrap", 12000); const freshness=bootstrap?.app?.dataFreshness||[]; const codes=state.competition==="NRL_PLUS_SOO" ? ["NRL","SOO"] : [state.competition]; const text=codes.map((code)=>{ const active=freshness.find((item)=>item.competition===code); return active&&active.roundLabel&&active.season ? code+" data currently through "+active.roundLabel+", "+active.season+"." : null; }).filter(Boolean).join(" "); playerFreshness.textContent=text||"Latest imported round not available yet."; } catch (_error) { playerFreshness.textContent="Latest imported round not available yet."; } }
      function navigateToPlayer(){ const nextName=String(playerSearch.value||"").trim(); if(!nextName) return; const next=new URL(window.location.origin+"/player/"+encodeURIComponent(nextName)); next.searchParams.set("view", state.view); next.searchParams.set("mode", state.mode); next.searchParams.set("competition", state.competition); window.location.assign(next.toString()); }
      playerTableScrollbar.addEventListener("scroll", ()=>{ playerTableWrap.scrollLeft = playerTableScrollbar.scrollLeft; });
      playerTableWrap.addEventListener("scroll", ()=>{ playerTableScrollbar.scrollLeft = playerTableWrap.scrollLeft; });
      async function init(){ try { await loadFreshness(); payload = await fetchJson("/api/player-profile?player="+encodeURIComponent(playerName)+"&competition="+encodeURIComponent(state.competition), 12000); rankingCards = (await fetchJson("/api/player-rank-cards?player="+encodeURIComponent(playerName)+"&competition="+encodeURIComponent(state.competition), 12000)).cards || []; playerOptions.innerHTML=payload.playerOptions.filter((name)=>name&&name!=="Any").map((name)=>'<option value="'+String(name).replace(/"/g,"&quot;")+'"></option>').join(""); playerSearch.value=playerName; playerGo.addEventListener("click", navigateToPlayer); playerSearch.addEventListener("keydown", (event)=>{ if(event.key==="Enter"){ event.preventDefault(); navigateToPlayer(); }}); document.querySelectorAll("[data-view]").forEach((button)=>button.addEventListener("click", ()=>{ state.view=button.dataset.view; state.sort=""; state.direction=""; render(); })); document.querySelectorAll("[data-mode]").forEach((button)=>button.addEventListener("click", ()=>{ state.mode=button.dataset.mode; render(); })); document.querySelectorAll("[data-include]").forEach((button)=>button.addEventListener("click", async ()=>{ setCompetitionFromInclude(button.dataset.include); state.sort=""; state.direction=""; await loadFreshness(); payload = await fetchJson("/api/player-profile?player="+encodeURIComponent(playerName)+"&competition="+encodeURIComponent(state.competition), 12000); rankingCards = (await fetchJson("/api/player-rank-cards?player="+encodeURIComponent(playerName)+"&competition="+encodeURIComponent(state.competition), 12000)).cards || []; render(); })); render();
      } catch (error) { playerSubtitle.textContent="Unable to load player profile."; playerError.textContent=error instanceof Error?error.message:String(error); playerError.classList.remove("hidden"); playerTableWrap.classList.add("hidden"); summaryGrid.innerHTML='<div class="metric"><span class="metric-label">Status</span><div class="metric-value">Unavailable</div></div>'; playerPageMeta.textContent="Load failed"; }
      }
      init();
    </script>
  </body>
</html>`;
}

function renderMatchPageShell(matchId: number): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - Match ${matchId}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root{--bg:#ece7d9;--panel:#f8f3e7;--line:#cdbf9e;--line-2:#b39f77;--text:#1f1d19;--muted:#6e6552;--green:#1e5631;--blue:#274d78;--shadow:0 8px 24px rgba(65,49,22,.08)}
      *{box-sizing:border-box} body{margin:0;color:var(--text);font-family:Arial,Helvetica,sans-serif;background:linear-gradient(rgba(255,255,255,.14),rgba(255,255,255,.14)),repeating-linear-gradient(0deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),repeating-linear-gradient(90deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),var(--bg)}
      a{color:#0048c9;text-decoration:underline;text-underline-offset:2px}
      .shell{max-width:1500px;margin:0 auto;padding:16px}.masthead,.card,.sidebar{background:rgba(248,243,231,.94);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)} .masthead{padding:18px 20px;margin-bottom:14px}
      .brand h1{margin:0 0 4px;font-size:2rem}.brand p{margin:0;color:var(--muted)} .topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
      .ghost-btn{appearance:none;border:1px solid var(--line-2);background:linear-gradient(180deg,#faf5ea,#efe6d4);color:var(--text);cursor:pointer;border-radius:10px;padding:10px 14px;font-weight:700;font-size:.94rem;text-decoration:none;display:inline-flex;align-items:center}
      .layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:14px;align-items:start}.sidebar{padding:14px;position:sticky;top:12px}.content-stack{display:grid;gap:14px;min-width:0}.card{overflow:hidden}
      .hero{padding:18px}.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:.8rem;text-transform:uppercase;letter-spacing:.11em;color:var(--muted);font-weight:700;margin-bottom:10px}.eyebrow::before{content:"";width:26px;height:2px;background:#b48a3a}
      .hero-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:start}.hero-title{margin:0;font-size:2rem;line-height:1.08}.hero-sub{margin:8px 0 0;color:var(--muted);font-size:1rem}
      .pill-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.pill{border:1px solid var(--line-2);border-radius:999px;padding:8px 12px;background:#fbf8f0;font-size:.9rem}
      .loading,.error{padding:16px;color:var(--muted)} .error{color:#8f4d1c}.team-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px}.team-card{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#fbf8f0}
      .team-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;color:#fff;font-weight:800}.team-head.home{background:#1e5631}.team-head.away{background:#274d78}.score-badge{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:34px;border-radius:999px;background:rgba(255,255,255,.18);font-size:1.1rem}
      .filter-group{display:grid;gap:8px}.label{display:block;font-size:.82rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em}.field{width:100%;border:1px solid var(--line-2);background:#fbf8f0;border-radius:10px;padding:10px 12px;color:var(--text);font:inherit}
      .section-head{padding:14px 16px 0}.section-head h3{margin:0;font-size:1.12rem}.table-shell{padding:12px 14px 16px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fbf8f0}
      table{width:100%;border-collapse:separate;border-spacing:0;min-width:760px;font-size:12px} th,td{border-right:1px solid #d7d1be;border-bottom:1px solid #d7d1be;padding:7px 8px;text-align:left;white-space:nowrap} th{background:#efe8d7;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
      @media (max-width:940px){.layout{grid-template-columns:1fr}.sidebar{position:relative;top:0}.hero-grid{grid-template-columns:1fr}.team-grid{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="masthead"><div class="brand"><h1>${APP_NAME}</h1><p id="matchFreshness">Loading data freshness...</p></div><div class="topbar"><a class="ghost-btn" href="/app-fixed">← Back to Search</a></div></header>
      <main class="layout">
        <aside class="sidebar"><div class="filter-group"><span class="label">Selected Match</span><select id="matchSeasonSelect" class="field"><option>Loading...</option></select><select id="matchRoundSelect" class="field"><option>Loading...</option></select><select id="matchSelect" class="field"><option>Loading...</option></select></div></aside>
        <div class="content-stack">
          <section class="card hero"><div class="eyebrow">Match detail</div><div class="hero-grid"><div><h2 class="hero-title" id="matchTitle">Loading match…</h2><p class="hero-sub" id="matchSubtitle"></p></div><div><a class="ghost-btn" id="matchBuilderLink" href="/app-fixed">Open full stats</a></div></div><div class="pill-row" id="matchPills"></div></section>
          <section class="card"><div class="section-head"><h3>Team Lists</h3></div><div id="matchError" class="error" style="display:none"></div><div class="team-grid" id="teamGrid"></div></section>
          <section class="card"><div class="section-head"><h3>Team Match Stats</h3></div><div class="table-shell"><div class="table-wrap" id="teamStatsWrap"><div class="loading">Loading team stats...</div></div></div></section>
          <section class="card"><div class="section-head"><h3>Full Player Stats</h3></div><div class="table-shell"><div class="table-wrap" id="playerStatsWrap"><div class="loading">Loading player stats...</div></div></div></section>
        </div>
      </main>
    </div>
    <script>
      const matchId = ${matchId};
      const matchFreshness = document.getElementById("matchFreshness");
      const matchSeasonSelect = document.getElementById("matchSeasonSelect");
      const matchRoundSelect = document.getElementById("matchRoundSelect");
      const matchSelect = document.getElementById("matchSelect");
      function toNumber(value){ const numeric=Number(value); return Number.isFinite(numeric)?numeric:0; }
      function parseStats(row){ return typeof row.stats_json==="string" ? JSON.parse(row.stats_json||"{}") : (row.stats_json||{}); }
      function pointsFromStats(stats){ return (toNumber(stats.tries)*4)+(toNumber(stats.goals)*2)+toNumber(stats.field_goals_1pt)+(toNumber(stats.field_goals_2pt)*2); }
      async function fetchJson(url, timeoutMs){ const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(), timeoutMs); try { const response=await fetch(url,{cache:"no-store",signal:controller.signal}); const payload=await response.json(); if(!response.ok||!payload?.ok) throw new Error(payload?.error||("Request failed with status "+response.status)); return payload; } finally { clearTimeout(timer); } }
      function renderTeamTable(team, rows, tone, competitionCode){ return '<div class="team-card"><div class="team-head '+tone+'"><span>'+team.team+'</span><span class="score-badge">'+team.team_score+'</span></div><table><thead><tr><th>#</th><th>Player</th><th>Tries</th><th>Goals</th><th>FG</th><th>Pts</th></tr></thead><tbody>'+rows.map((row)=>{ const stats=parseStats(row); const player=row.player?'<a href="/player/'+encodeURIComponent(String(row.player))+'?competition='+encodeURIComponent(competitionCode)+'">'+row.player+'</a>':'Unknown'; return '<tr><td>'+String(row.jumper_number??'')+'</td><td>'+player+'</td><td>'+toNumber(stats.tries)+'</td><td>'+toNumber(stats.goals)+'</td><td>'+(toNumber(stats.field_goals_1pt)+toNumber(stats.field_goals_2pt))+'</td><td>'+pointsFromStats(stats)+'</td></tr>'; }).join("")+'</tbody></table></div>'; }
      function renderTeamStats(teamRows){ const keys=["tries","goals","field_goals_1pt","field_goals_2pt","40_20","20_40","points","all_runs","all_run_metres","post_contact_metres","line_breaks","line_break_assists","try_assists","line_engaged_runs","hit_ups","dummy_half_runs","dummy_half_run_metres","tackle_breaks","offloads","receipts","passes","dummy_passes","play_the_ball","tackles_made","missed_tackles","ineffective_tackles","errors","handling_errors","penalties","ruck_infringements","inside_10_metres","kicks","kicking_metres","bomb_kicks","grubbers","kicked_dead","forced_drop_outs","kicks_defused","one_on_one_steal","one_on_one_lost","interchanges_used","sin_bins","send_offs","on_report","minutes_played"]; const labels={tries:"Tries",goals:"Goals",field_goals_1pt:"1FG",field_goals_2pt:"2FG","40_20":"40/20","20_40":"20/40",points:"Points",all_runs:"All Runs",all_run_metres:"Run Metres",post_contact_metres:"Post Contact Metres",line_breaks:"Line Breaks",line_break_assists:"Line Break Assists",try_assists:"Try Assists",line_engaged_runs:"Line Engaged Runs",hit_ups:"Hit Ups",dummy_half_runs:"Dummy Half Runs",dummy_half_run_metres:"Dummy Half Run Metres",tackle_breaks:"Tackle Breaks",offloads:"Offloads",receipts:"Receipts",passes:"Passes",dummy_passes:"Dummy Passes",play_the_ball:"Play The Ball",tackles_made:"Tackles Made",missed_tackles:"Missed Tackles",ineffective_tackles:"Ineffective Tackles",errors:"Errors",handling_errors:"Handling Errors",penalties:"Penalties Conceded",ruck_infringements:"Ruck Infringements",inside_10_metres:"Inside 10 Metres",kicks:"Kicks",kicking_metres:"Kicking Metres",bomb_kicks:"Bomb Kicks",grubbers:"Grubbers",kicked_dead:"Kicked Dead",forced_drop_outs:"Forced Drop Outs",kicks_defused:"Kicks Defused",one_on_one_steal:"One on One Steal",one_on_one_lost:"One on One Lost",interchanges_used:"Interchanges Used",sin_bins:"Sin Bins",send_offs:"Send Offs",on_report:"On Report",minutes_played:"Minutes"}; const home=teamRows.find((row)=>Number(row.is_home)===1) || teamRows[0]; const away=teamRows.find((row)=>Number(row.is_home)!==1) || teamRows[1] || null; if(!home||!away){ return '<div class="loading">Team stats unavailable.</div>'; } const homeStats=parseStats(home); const awayStats=parseStats(away); return '<table><thead><tr><th>Stat</th><th>'+home.team+'</th><th>'+away.team+'</th></tr></thead><tbody>'+keys.map((key)=>{ const homeValue=key==="points"?pointsFromStats(homeStats):toNumber(homeStats[key]); const awayValue=key==="points"?pointsFromStats(awayStats):toNumber(awayStats[key]); return (homeValue||awayValue) ? '<tr><td>'+labels[key]+'</td><td>'+homeValue+'</td><td>'+awayValue+'</td></tr>' : ''; }).join("")+'</tbody></table>'; }
      function renderPlayerStatsTable(teamName, rows, competitionCode){ const columns=[["jumper_number","#"],["player","Player"],["position_label","Pos"],["tries","Tries"],["goals","Goals"],["field_goals_1pt","1FG"],["field_goals_2pt","2FG"],["40_20","40/20"],["20_40","20/40"],["points","Points"],["all_runs","Runs"],["all_run_metres","Run Metres"],["post_contact_metres","PCM"],["line_breaks","LB"],["line_break_assists","LBA"],["try_assists","TA"],["line_engaged_runs","LER"],["hit_ups","Hit Ups"],["dummy_half_runs","DH Runs"],["dummy_half_run_metres","DH Metres"],["tackle_breaks","TB"],["offloads","Offloads"],["receipts","Receipts"],["passes","Passes"],["dummy_passes","Dummy Passes"],["play_the_ball","PTB"],["tackles_made","Tackles"],["missed_tackles","Missed"],["ineffective_tackles","Ineffective"],["errors","Errors"],["handling_errors","Handling"],["penalties","Pens"],["kicks","Kicks"],["kicking_metres","Kick Metres"],["bomb_kicks","Bombs"],["grubbers","Grubbers"],["kicked_dead","Kicked Dead"],["kicks_defused","Defused"],["one_on_one_steal","1v1 Steal"],["one_on_one_lost","1v1 Lost"],["sin_bins","Sin Bins"],["send_offs","Send Offs"],["on_report","On Report"],["minutes_played","Minutes"]]; return '<div style="margin-bottom:16px"><div style="font-weight:800;margin:0 0 8px">'+teamName+'</div><table><thead><tr>'+columns.map((column)=>'<th>'+column[1]+'</th>').join('')+'</tr></thead><tbody>'+rows.map((row)=>{ const stats=parseStats(row); return '<tr>'+columns.map((column)=>{ const key=column[0]; let value=''; if(key==='player'){ value=row.player?'<a href="/player/'+encodeURIComponent(String(row.player))+'?competition='+encodeURIComponent(competitionCode)+'">'+row.player+'</a>':'Unknown'; } else if(key==='points'){ value=String(pointsFromStats(stats)); } else if(key==='jumper_number'||key==='position_label'){ value=String(row[key] ?? ''); } else { value=String(toNumber(stats[key])); } return '<td>'+value+'</td>'; }).join('')+'</tr>'; }).join('')+'</tbody></table></div>'; }
      function renderPlayerStats(playerRows, competitionCode){ const teamIds=[...new Set(playerRows.map((row)=>row.team_id))]; return teamIds.map((teamId)=>{ const rows=playerRows.filter((row)=>row.team_id===teamId); const teamName=rows[0]?.team || 'Team'; return renderPlayerStatsTable(teamName, rows, competitionCode); }).join(''); }
      async function loadFreshness(competitionCode){ try { const bootstrap=await fetchJson('/api/meta/bootstrap', 12000); const active=(bootstrap?.app?.dataFreshness||[]).find((item)=>item.competition===competitionCode); matchFreshness.textContent=active&&active.roundLabel&&active.season ? competitionCode+' data currently through '+active.roundLabel+', '+active.season+'.' : 'Latest imported round not available yet.'; } catch (_error) { matchFreshness.textContent='Latest imported round not available yet.'; } }
      function renderSeasonNavigator(match, seasonPayload){ const rows=seasonPayload.rows||[]; const rounds=[...new Set(rows.map((row)=>String(row.round_label||'Unknown')))]; const selectedRound=String(match.round_label||rounds[0]||'Unknown'); const filteredRows=rows.filter((row)=>String(row.round_label||'Unknown')===selectedRound); matchSeasonSelect.innerHTML=(seasonPayload.seasons||[]).map((value)=>'<option value="'+value+'"'+(String(value)===String(match.season)?' selected':'')+'>'+value+'</option>').join(''); matchRoundSelect.innerHTML=rounds.map((round)=>'<option value="'+round+'"'+(round===selectedRound?' selected':'')+'>'+round+'</option>').join(''); matchSelect.innerHTML=filteredRows.map((row)=>{ const label=(row.home_team||'Home')+' '+String(row.home_score ?? '')+'-'+String(row.away_score ?? '')+' '+(row.away_team||'Away'); return '<option value="'+row.match_id+'"'+(Number(row.match_id)===Number(match.match_id)?' selected':'')+'>'+label+'</option>'; }).join(''); matchSeasonSelect.onchange=()=>{ const next=new URL(window.location.origin+'/season'); next.searchParams.set('competition', match.competition_code); next.searchParams.set('season', matchSeasonSelect.value); window.location.assign(next.toString()); }; matchRoundSelect.onchange=()=>{ const chosenRound=matchRoundSelect.value; const nextRows=rows.filter((row)=>String(row.round_label||'Unknown')===chosenRound); matchSelect.innerHTML=nextRows.map((row)=>{ const label=(row.home_team||'Home')+' '+String(row.home_score ?? '')+'-'+String(row.away_score ?? '')+' '+(row.away_team||'Away'); return '<option value="'+row.match_id+'"'+(Number(row.match_id)===Number(match.match_id)?' selected':'')+'>'+label+'</option>'; }).join(''); }; matchSelect.onchange=()=>{ if(matchSelect.value){ window.location.assign('/match/'+encodeURIComponent(matchSelect.value)); } }; }
      async function init(){ const title=document.getElementById("matchTitle"); const subtitle=document.getElementById("matchSubtitle"); const pills=document.getElementById("matchPills"); const grid=document.getElementById("teamGrid"); const error=document.getElementById("matchError"); const builder=document.getElementById("matchBuilderLink"); const teamStatsWrap=document.getElementById("teamStatsWrap"); const playerStatsWrap=document.getElementById("playerStatsWrap"); try { const payload=await fetchJson('/api/match-detail?matchId='+matchId, 12000); const match=payload.match; const competitionCode=match.competition_code || 'NRL'; await loadFreshness(competitionCode); const teamRows=payload.teamRows||[]; const playerRows=payload.playerRows||[]; title.textContent=match.home_team+' '+match.home_score+'-'+match.away_score+' '+match.away_team; subtitle.textContent=match.competition+' • '+match.season+' '+match.round_label+' • '+(match.match_reference||'Match reference unavailable'); builder.href='/app-fixed?scope=team&format=match&mode=totals&competition='+encodeURIComponent(competitionCode)+'&matchId='+matchId+'&statKey=points_for'; pills.innerHTML=['Venue: '+(match.ground||'Unknown'),'Referee: '+(match.referee_name||'Unknown'),'Crowd: '+(match.crowd||'Unknown'),'Weather: '+(match.weather_condition_name||'Unknown'),'Ground: '+(match.ground_condition_name||'Unknown')].map((text)=>'<span class="pill">'+text+'</span>').join(""); const homeTeam=teamRows.find((row)=>Number(row.is_home)===1) || teamRows[0]; const awayTeam=teamRows.find((row)=>Number(row.is_home)!==1) || teamRows[1] || null; const homePlayers=playerRows.filter((row)=>row.team_id===homeTeam.team_id); const awayPlayers=awayTeam ? playerRows.filter((row)=>row.team_id===awayTeam.team_id) : []; grid.innerHTML=renderTeamTable(homeTeam, homePlayers, 'home', competitionCode) + (awayTeam ? renderTeamTable(awayTeam, awayPlayers, 'away', competitionCode) : ''); teamStatsWrap.innerHTML=renderTeamStats(teamRows); playerStatsWrap.innerHTML=renderPlayerStats(playerRows, competitionCode); try { const seasonPayload=await fetchJson('/api/season-index?competition='+encodeURIComponent(competitionCode)+'&season='+encodeURIComponent(match.season), 12000); renderSeasonNavigator(match, seasonPayload); } catch (_seasonError) { matchSeasonSelect.innerHTML='<option>'+match.season+'</option>'; matchRoundSelect.innerHTML='<option>'+match.round_label+'</option>'; matchSelect.innerHTML='<option>'+(match.match_reference||'Current match')+'</option>'; } } catch (err) { title.textContent='Unable to load match detail'; subtitle.textContent=''; error.style.display='block'; error.textContent=err instanceof Error ? err.message : String(err); } }
      init();
    </script>
  </body>
</html>`;
}

function renderSeasonPageShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} - Season Index</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root{--bg:#ece7d9;--panel:#f8f3e7;--line:#cdbf9e;--line-2:#b39f77;--text:#1f1d19;--muted:#6e6552;--shadow:0 8px 24px rgba(65,49,22,.08)}
      *{box-sizing:border-box} body{margin:0;color:var(--text);font-family:Arial,Helvetica,sans-serif;background:linear-gradient(rgba(255,255,255,.14),rgba(255,255,255,.14)),repeating-linear-gradient(0deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),repeating-linear-gradient(90deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),var(--bg)}
      a{color:#0048c9;text-decoration:underline;text-underline-offset:2px}
      .shell{max-width:1500px;margin:0 auto;padding:16px}.masthead,.card,.sidebar{background:rgba(248,243,231,.94);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)} .masthead{padding:18px 20px;margin-bottom:14px}
      .topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
      .ghost-btn{appearance:none;border:1px solid var(--line-2);background:linear-gradient(180deg,#faf5ea,#efe6d4);color:var(--text);cursor:pointer;border-radius:10px;padding:10px 14px;font-weight:700;font-size:.94rem;text-decoration:none;display:inline-flex;align-items:center}
      .layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:14px;align-items:start}.sidebar{padding:14px;position:sticky;top:12px}.content-stack{display:grid;gap:14px;min-width:0}.card{overflow:hidden}
      .filter-group{display:grid;gap:8px}.label{display:block;font-size:.82rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em}
      select{width:100%;border:1px solid var(--line-2);background:#fbf8f0;border-radius:10px;padding:10px 12px;color:var(--text);font:inherit}
      .round-links{display:grid;gap:6px}.round-links a{font-size:.92rem}
      .card-head{padding:16px 18px 0}.card-body{padding:14px 18px 18px}.muted{color:var(--muted)}
      table{width:100%;border-collapse:separate;border-spacing:0;min-width:920px} thead th{position:sticky;top:0;z-index:1;background:#e7dcc5;color:#2b2418;font-size:.83rem;text-transform:uppercase;letter-spacing:.04em;text-align:left;border-bottom:1px solid var(--line-2);border-right:1px solid var(--line);padding:10px;white-space:nowrap}
      tbody td{border-bottom:1px solid #ddd0b2;border-right:1px solid #e3d7bc;padding:9px 10px;white-space:nowrap;font-size:.92rem} tbody tr.match-row:nth-child(odd){background:#fbf7ee} tbody tr.match-row:nth-child(even){background:#f5eedf}
      .round-divider td{background:#dde8dd;font-weight:800;color:#24311d}
      .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fbf8f0}
      .round-section{scroll-margin-top:16px}.round-title{margin:0 0 10px;font-size:1.05rem}
      @media (max-width:940px){.layout{grid-template-columns:1fr}.sidebar{position:relative;top:0}}
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="masthead">
        <div class="topbar">
          <div>
            <h1 style="margin:0 0 4px;">${APP_NAME}</h1>
            <div class="muted" id="seasonSubtitle">Loading season index...</div>
          </div>
          <a class="ghost-btn" href="/app-fixed">← Back to Search</a>
        </div>
      </header>
      <main class="layout">
        <aside class="sidebar">
          <div class="filter-group">
            <span class="label">Season</span>
            <select id="seasonSelect"></select>
          </div>
          <div class="filter-group" style="margin-top:16px;">
            <span class="label">Rounds</span>
            <div class="round-links" id="roundLinks"></div>
          </div>
        </aside>
        <div class="content-stack">
          <section class="card">
            <div class="card-head">
              <h2 style="margin:0;" id="seasonTitle">Loading season...</h2>
            </div>
            <div class="card-body" id="seasonContent"><div class="muted">Loading...</div></div>
          </section>
        </div>
      </main>
    </div>
    <script>
      const params = new URLSearchParams(window.location.search);
      const season = params.get("season") || "2026";
      const competition = params.get("competition") || "NRL";
      const seasonTitle = document.getElementById("seasonTitle");
      const seasonSubtitle = document.getElementById("seasonSubtitle");
      const seasonSelect = document.getElementById("seasonSelect");
      const roundLinks = document.getElementById("roundLinks");
      const seasonContent = document.getElementById("seasonContent");
      function buildRoundAnchor(roundLabel){ const normalized=String(roundLabel||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); return "round-"+(normalized||"unknown"); }
      function seasonHref(nextSeason){ const next = new URL(window.location.href); next.searchParams.set("competition", competition); next.searchParams.set("season", String(nextSeason)); next.hash = ""; return next.toString(); }
      async function fetchJson(url){ const response = await fetch(url, { cache:"no-store" }); const payload = await response.json(); if(!response.ok || !payload?.ok) throw new Error(payload?.error || ("Request failed with status " + response.status)); return payload; }
      function renderRows(payload){
        seasonTitle.textContent = payload.competition + " " + payload.season;
        seasonSubtitle.textContent = payload.rows.length + " matches";
        seasonSelect.innerHTML = payload.seasons.map((value)=>'<option value="'+value+'"'+(String(value)===String(payload.season)?' selected':'')+'>'+value+'</option>').join("");
        seasonSelect.addEventListener("change", ()=>window.location.assign(seasonHref(seasonSelect.value)));
        const grouped = new Map();
        for(const row of payload.rows){ if(!grouped.has(row.round_label)) grouped.set(row.round_label, []); grouped.get(row.round_label).push(row); }
        roundLinks.innerHTML = [...grouped.keys()].map((round)=>'<a href="#'+buildRoundAnchor(round)+'">'+round+'</a>').join("");
        seasonContent.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Home</th><th>Away</th><th>Ground</th><th>Match</th><th>Home Score</th><th>Away Score</th><th>Referee</th><th>Crowd</th><th>Weather</th><th>Ground Condition</th></tr></thead><tbody>' + [...grouped.entries()].map(([round, rows]) => '<tr class="round-divider round-section" id="'+buildRoundAnchor(round)+'"><td colspan="10">'+round+'</td></tr>' + rows.map((row)=>'<tr class="match-row"><td>'+row.home_team+'</td><td>'+row.away_team+'</td><td>'+row.ground+'</td><td><a href="/match/'+row.match_id+'">'+(row.match_reference || "Match")+'</a></td><td>'+String(row.home_score ?? "")+'</td><td>'+String(row.away_score ?? "")+'</td><td>'+String(row.referee_name ?? "")+'</td><td>'+String(row.crowd ?? "")+'</td><td>'+String(row.weather_condition_name ?? "")+'</td><td>'+String(row.ground_condition_name ?? "")+'</td></tr>').join("")).join("") + '</tbody></table></div>';
      }
      fetchJson("/api/season-index?competition=" + encodeURIComponent(competition) + "&season=" + encodeURIComponent(season))
        .then(renderRows)
        .catch((error)=>{ seasonTitle.textContent = "Unable to load season"; seasonSubtitle.textContent = ""; seasonContent.innerHTML = '<div class="muted">'+String(error.message || error)+'</div>'; });
    </script>
  </body>
</html>`;
}

function renderAppShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root {
        --bg: #f7f4ea;
        --panel: #fffdf6;
        --grid: #d7d1be;
        --text: #1f1c16;
        --muted: #6f6758;
        --accent: #2f5b84;
        --accent-soft: #e3eef8;
        --warn: #8f4d1c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, sans-serif;
        color: var(--text);
        background:
          linear-gradient(0deg, rgba(0,0,0,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0,0,0,0.03) 1px, transparent 1px),
          var(--bg);
        background-size: 28px 28px, 28px 28px, auto;
      }
      .page {
        max-width: 1600px;
        margin: 0 auto;
        padding: 10px 12px 24px;
      }
      .topbar {
        display: flex;
        gap: 10px;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 10px;
      }
      .topbar-main {
        flex: 1;
      }
      .topbar-actions {
        display: flex;
        align-items: center;
      }
      .link-button {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--grid);
        background: #f1ebdc;
        color: var(--text);
        padding: 6px 10px;
        font-size: 12px;
        text-decoration: none;
        cursor: pointer;
      }
      .link-button:hover {
        background: #ece2cc;
      }
      .starter-panel-mobile {
        display: none;
        margin-bottom: 10px;
      }
      .starter-panel-desktop {
        display: block;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--grid);
        padding: 8px 10px;
      }
      .title {
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.02em;
        margin: 0 0 2px;
      }
      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
      }
      .data-freshness {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }
      .status-card {
        border: 1px solid var(--grid);
        padding: 6px 8px;
        min-height: 58px;
      }
      .status-card .label {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
      }
      .status-card .value {
        margin-top: 4px;
        font-size: 18px;
        font-weight: 700;
      }
      .layout {
        display: grid;
        grid-template-columns: 420px 1fr;
        gap: 10px;
      }
      .tabs {
        display: grid;
        gap: 8px;
        margin-bottom: 10px;
      }
      .tab-row {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
        align-items: center;
      }
      .tab {
        border: 1px solid var(--grid);
        background: #f2edde;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
        min-width: 82px;
        text-align: center;
      }
      .tab-row .primary {
        margin-left: auto;
      }
      .tab.active {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--accent);
        font-weight: 700;
      }
      .subsection {
        border-top: 1px solid var(--grid);
        margin-top: 10px;
        padding-top: 8px;
      }
      .subsection.hidden {
        display: none;
      }
      .subsection-title {
        font-weight: 700;
        font-size: 12px;
        margin: 0 0 8px;
        color: var(--muted);
        text-transform: uppercase;
      }
      .section-title {
        font-weight: 700;
        font-size: 13px;
        border-bottom: 1px solid var(--grid);
        padding-bottom: 4px;
        margin: 0 0 8px;
      }
      .filters {
        display: grid;
        gap: 6px;
      }
      .row {
        display: grid;
        grid-template-columns: 110px 1fr;
        gap: 8px;
        align-items: center;
        min-height: 28px;
      }
      .row.entity-row {
        align-items: start;
      }
      .row label {
        font-size: 12px;
      }
      .row.unavailable {
        opacity: 0.45;
      }
      .row input, .row select {
        width: 100%;
        border: 1px solid var(--grid);
        background: white;
        padding: 4px 6px;
        font-size: 12px;
      }
      .inline-options {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
        font-size: 12px;
      }
      .inline-options label,
      .column-controls label,
      .pager label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .row.entity-row .inline-options label {
        white-space: normal;
        line-height: 1.25;
      }
      .mini-range {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-wrap: nowrap;
      }
      .mini-range input,
      .mini-range select {
        width: 90px;
      }
      .action-row {
        display: flex;
        gap: 6px;
        margin-top: 10px;
      }
      button {
        border: 1px solid var(--grid);
        background: #f1ebdc;
        padding: 6px 9px;
        font-size: 12px;
        cursor: pointer;
      }
      button.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .results {
        display: grid;
        gap: 10px;
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }
      .toolbar .hint {
        color: var(--muted);
        font-size: 12px;
      }
      .export-note {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 12px;
      }
      .export-link {
        display: inline-flex;
        align-items: center;
        font-size: 12px;
        color: var(--accent);
        text-decoration: none;
      }
      .export-link:hover {
        text-decoration: underline;
      }
      .starter-list {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
      }
      .starter-hint {
        color: var(--muted);
        font-size: 11px;
      }
      .starter-item {
        border: 1px solid var(--grid);
        padding: 4px 7px;
        font-size: 11px;
        background: #fcfaf2;
        white-space: nowrap;
        line-height: 1.2;
      }
      .starter-item strong {
        font-weight: 600;
      }
      .condition-grid {
        display: grid;
        gap: 6px;
      }
      .condition-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 82px 96px 92px 32px;
        gap: 6px;
      }
      .condition-grid select.operator {
        width: 82px;
      }
      .condition-grid .remove-condition {
        padding: 4px 0;
        min-width: 32px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        border: 1px solid var(--grid);
        padding: 5px 6px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #efe8d7;
      }
      .note {
        color: var(--warn);
        font-size: 12px;
      }
      .loading-toast {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 9999;
        background: rgba(31, 28, 22, 0.92);
        color: white;
        padding: 10px 14px;
        border-radius: 6px;
        font-size: 12px;
        box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        display: none;
      }
      .loading-toast.visible {
        display: block;
      }
      .muted-option {
        opacity: 0.45;
      }
      code.inline {
        background: #efe8d7;
        padding: 1px 4px;
      }
      details.panel-summary > summary {
        cursor: pointer;
        list-style: none;
        font-weight: 700;
        font-size: 13px;
      }
      details.panel-summary > summary::-webkit-details-marker {
        display: none;
      }
      .results-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin: 8px 0;
        font-size: 12px;
      }
      .column-controls {
        display: none;
      }
      .pager {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 12px;
      }
      .results-panel,
      .results,
      .panel,
      details.panel-summary {
        align-self: start;
      }
      .results {
        align-content: start;
        grid-auto-rows: min-content;
      }
      th.sortable {
        cursor: pointer;
      }
      th.sortable.active-sort::after {
        margin-left: 4px;
        font-size: 11px;
      }
      th.sortable.active-sort.sort-asc::after {
        content: "▲";
      }
      th.sortable.active-sort.sort-desc::after {
        content: "▼";
      }
      @media (max-width: 1100px) {
        .layout {
          grid-template-columns: 1fr;
        }
        .topbar {
          flex-direction: column;
          align-items: stretch;
        }
        .topbar-actions {
          justify-content: flex-end;
        }
        .starter-panel-mobile {
          display: block;
        }
        .starter-panel-desktop {
          display: none;
        }
        .tab-row .primary {
          margin-left: 0;
        }
        .row {
          grid-template-columns: 92px minmax(0, 1fr);
        }
        .tab-row {
          gap: 6px;
        }
      }
    </style>
  </head>
  <body>
    <div class="loading-toast" id="loading-toast">Running query...</div>
    <div class="page">
      <div class="topbar">
        <section class="panel topbar-main">
          <h1 class="title">${APP_NAME}</h1>
          <p class="data-freshness" id="data-freshness-note">Data freshness will appear here after bootstrap.</p>
        </section>
        <div class="topbar-actions">
          <a class="link-button" href="/regression">Validation Queries</a>
          <a class="link-button" href="/auth/logout">Log Out</a>
        </div>
      </div>

      <section class="panel starter-panel-mobile">
        <div class="toolbar">
          <h2 class="section-title" style="margin:0;border:0;padding:0;">Starter Queries</h2>
          <div class="starter-hint">Click a starter button to preload a useful query.</div>
        </div>
        <div class="starter-list starter-list-target"></div>
      </section>

      <div class="layout">
        <section class="panel">
          <div class="tabs">
            <div class="tab-row">
              <button class="tab" type="button" data-scope="team">TEAM</button>
              <button class="tab active" type="button" data-scope="player">PLAYER</button>
              <button class="primary" type="button" id="run-query">Run Query</button>
              <button type="button" id="reset-query">Reset</button>
            </div>
            <div class="tab-row">
              <button class="tab active" type="button" data-mode="stats">STATS</button>
              <button class="tab" type="button" data-mode="streaks">STREAKS</button>
            </div>
            <div class="tab-row">
              <button class="tab active" type="button" data-competition="NRL">NRL</button>
              <button class="tab" type="button" data-competition="NRLW">NRLW</button>
            </div>
            <div class="tab-row">
              <button class="tab active" type="button" data-competition-selection="primary">NRL</button>
              <button class="tab" type="button" data-competition-selection="rep">SOO</button>
              <button class="tab" type="button" data-competition-selection="combined">NRL + SOO</button>
            </div>
          </div>

          <h2 class="section-title">Query Builder</h2>
          <select id="scope" style="display:none;">
            <option value="player" selected>Player</option>
            <option value="team">Team</option>
          </select>
          <select id="competition" style="display:none;">
            <option value="NRL" selected>NRL</option>
            <option value="SOO">SOO</option>
            <option value="NRL_PLUS_SOO">NRL + SOO</option>
            <option value="NRLW">NRLW</option>
            <option value="WSOO">WSOO</option>
            <option value="NRLW_PLUS_WSOO">NRLW + WSOO</option>
          </select>
          <div class="filters">
            <div class="row">
              <label for="stat">Stat</label>
              <select id="stat"></select>
            </div>
            <div class="row">
              <label for="team">Team</label>
              <select id="team"></select>
            </div>
            <div class="row">
              <label for="opponent">Opponent</label>
              <select id="opponent"></select>
            </div>
            <div class="row">
              <label for="venue">Venue</label>
              <select id="venue"></select>
            </div>
            <div class="row">
              <label for="referee">Referee</label>
              <select id="referee"></select>
            </div>
            <div class="row">
              <label for="season-from">Seasons</label>
              <div class="mini-range">
                <input id="season-from" value="1908" />
                <span>to</span>
                <input id="season-to" value="2026" />
              </div>
            </div>
            <div class="row">
              <label>Home/Away</label>
              <div class="inline-options">
                <label><input type="radio" name="home-away" value="any" checked /> any</label>
                <label><input type="radio" name="home-away" value="home" /> home</label>
                <label><input type="radio" name="home-away" value="away" /> away</label>
                <label class="muted-option"><input type="radio" name="home-away" value="neutral" disabled /> neutral</label>
              </div>
            </div>
            <div class="row">
              <label>Result</label>
              <div class="inline-options">
                <label><input type="radio" name="result-filter" value="any" checked /> any</label>
                <label><input type="radio" name="result-filter" value="win" /> win</label>
                <label><input type="radio" name="result-filter" value="loss" /> loss</label>
                <label><input type="radio" name="result-filter" value="tie" /> draw</label>
              </div>
            </div>
            <div class="row">
              <label>Score Half</label>
              <div class="inline-options" id="score-half-options">
                <label><input type="radio" name="score-half" value="all" checked /> full game</label>
                <label><input type="radio" name="score-half" value="first" /> 1st half</label>
                <label><input type="radio" name="score-half" value="second" /> 2nd half</label>
              </div>
            </div>
            <div class="row">
              <label for="round-from">Round</label>
              <div class="mini-range">
                <input id="round-from" value="1" />
                <span>to</span>
                <input id="round-to" value="33" />
              </div>
            </div>
            <div class="row">
              <label>Season Type</label>
              <div class="inline-options">
                <label><input type="checkbox" id="include-regular" checked /> regular season</label>
                <label><input type="checkbox" id="include-finals" checked /> finals</label>
                <label><input type="checkbox" id="include-grand-final" checked /> grand final</label>
              </div>
            </div>
            <div class="row" style="display:none;">
              <label>Include</label>
              <div class="inline-options">
                <label><input type="checkbox" id="include-primary-competition" checked /> <span id="include-primary-competition-label">NRL</span></label>
                <label><input type="checkbox" id="include-rep-competition" /> <span id="include-rep-competition-label">SOO</span></label>
              </div>
            </div>
            <div class="row">
              <label>Position</label>
              <select id="position"></select>
            </div>
            <div class="row">
              <label>Player Type</label>
              <div class="inline-options">
                <label><input type="radio" name="position-pool" value="any" checked /> any</label>
                <label><input type="radio" name="position-pool" value="forwards" /> forwards</label>
                <label><input type="radio" name="position-pool" value="backs" /> backs</label>
              </div>
            </div>
            <div class="row unavailable">
              <label>Day/Night</label>
              <div class="inline-options">
                <label><input type="radio" name="day-night" value="any" checked disabled /> any</label>
                <label><input type="radio" name="day-night" value="day" disabled /> day</label>
                <label><input type="radio" name="day-night" value="night" disabled /> night</label>
              </div>
            </div>
            <div class="row unavailable">
              <label for="ground-condition">Ground</label>
              <select id="ground-condition"></select>
            </div>
            <div class="row unavailable">
              <label for="weather-condition">Weather</label>
              <select id="weather-condition"></select>
            </div>
            <div class="row">
              <label>View Format</label>
              <div class="inline-options">
                <label><input type="radio" name="view-format" value="overall" checked /> overall</label>
                <label><input type="radio" name="view-format" value="season" /> season</label>
                <label><input type="radio" name="view-format" value="match" /> match</label>
                <label id="club-format-label"><input type="radio" name="view-format" value="club" /> club</label>
                <label><input type="radio" name="view-format" value="ground" /> ground</label>
                <label><input type="radio" name="view-format" value="opposition" /> opposition</label>
              </div>
            </div>
            <div class="row">
              <label>Metric</label>
              <div class="inline-options">
                <label><input type="radio" name="metric-mode" value="totals" checked /> totals</label>
                <label id="averages-label"><input type="radio" name="metric-mode" value="averages" /> averages</label>
              </div>
            </div>
            <div class="row">
              <label>Output</label>
              <div class="inline-options">
                <label><input type="checkbox" checked /> games</label>
                <label><input type="checkbox" checked /> included</label>
                <label><input type="checkbox" checked /> references</label>
              </div>
            </div>
          </div>

          <div id="stats-only-section" class="subsection">
            <h3 class="subsection-title">Stats Pages Only</h3>
            <div class="filters">
              <div class="row">
                <label for="player-search">Player</label>
                <input id="player-search" list="player-options" placeholder="[ return only this player's stats ]" />
              </div>
              <div class="row">
                <label for="match-player">Match involving player</label>
                <input id="match-player" list="player-options" placeholder="[ enter a player's name ]" />
                <datalist id="player-options"></datalist>
              </div>
              <div class="row unavailable">
                <label for="match-captain">Match involving captain</label>
                <input id="match-captain" placeholder="[ enter a player's name ]" disabled />
              </div>
              <div class="row">
                <label for="points-for-from">Points For</label>
                <div class="inline-options">
                  <input id="points-for-from" value="0" style="width:90px" />
                  <span>to</span>
                  <input id="points-for-to" value="98" style="width:90px" />
                </div>
              </div>
              <div class="row">
                <label for="points-against-from">Points Against</label>
                <div class="inline-options">
                  <input id="points-against-from" value="0" style="width:90px" />
                  <span>to</span>
                  <input id="points-against-to" value="98" style="width:90px" />
                </div>
              </div>
              <div class="row entity-row">
                <label>Entity Rows</label>
                <div class="inline-options">
                  <label><input type="checkbox" id="single-entity-results" checked /> one row per season, club, ground, opposition, or match</label>
                </div>
              </div>
            </div>
          </div>

          <div id="player-only-section" class="subsection">
            <h3 class="subsection-title">Add To Player Search Only</h3>
            <div class="filters">
              <div class="row unavailable">
                <label>Captaincy</label>
                <div class="inline-options">
                  <label><input type="radio" name="captaincy" value="either" checked disabled /> either</label>
                  <label><input type="radio" name="captaincy" value="as_captain" disabled /> as captain</label>
                  <label><input type="radio" name="captaincy" value="not_captain" disabled /> not captain</label>
                </div>
              </div>
              <div class="row unavailable">
                <label for="age-from">Age at start</label>
                <div class="inline-options">
                  <input id="age-from" value="14" style="width:90px" disabled />
                  <span>to</span>
                  <input id="age-to" value="52" style="width:90px" disabled />
                </div>
              </div>
              <div class="row">
                <label>Debut</label>
                <div class="inline-options">
                  <label><input type="radio" name="debut" value="any" checked /> any</label>
                  <label><input type="radio" name="debut" value="career_debut" /> career debut</label>
                  <label><input type="radio" name="debut" value="last_career_match" /> last career match</label>
                  <label><input type="radio" name="debut" value="team_debut" /> team debut</label>
                  <label><input type="radio" name="debut" value="last_team_match" /> last team match</label>
                </div>
              </div>
            </div>
          </div>

          <div id="streak-only-section" class="subsection hidden">
            <h3 class="subsection-title">Streak Pages Only</h3>
            <div class="filters">
              <div class="row">
                <label>Results</label>
                <div class="inline-options">
                  <label><input type="checkbox" id="multi-streaks" /> include multiple streaks per entity</label>
                </div>
              </div>
              <div class="row">
                <label>History Filter</label>
                <div class="inline-options">
                  <label><input type="checkbox" id="exclude-sparse-streaks" checked /> exclude pre-1998 sparse match streaks</label>
                </div>
              </div>
              <div class="row">
                <label>Player Minutes</label>
                <div class="inline-options">
                  <label><input type="checkbox" id="exclude-zero-minute-streak-games" checked /> skip 0-minute player rows in streaks (when minutes data exists)</label>
                </div>
              </div>
            </div>
          </div>

          <div class="subsection">
            <h3 class="subsection-title">Condition Builder</h3>
            <div class="condition-grid" id="condition-grid">
            </div>
            <div class="action-row">
              <button type="button" id="add-condition">Add condition</button>
            </div>
          </div>
        </section>

        <section class="results">
          <section class="panel starter-panel-desktop">
            <div class="toolbar">
              <h2 class="section-title" style="margin:0;border:0;padding:0;">Starter Queries</h2>
              <div class="starter-hint">Click a starter button to preload a useful query.</div>
            </div>
            <div class="starter-list starter-list-target"></div>
          </section>

          <section class="panel" id="results-panel">
            <div class="toolbar">
              <h2 class="section-title" style="margin:0;border:0;padding:0;">Live Results</h2>
              <div class="hint" id="result-hint">Run a query to fetch leaderboard results.</div>
            </div>
            <div class="results-controls">
              <button type="button" id="full-results-button">See Full Stats</button>
              <div class="pager">
                <button type="button" id="page-prev">Prev</button>
                <span id="page-label">Page 1</span>
                <button type="button" id="page-next">Next</button>
                <label>Rows per page
                  <select id="page-size">
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="200" selected>200</option>
                    <option value="500">500</option>
                    <option value="1000">1000</option>
                  </select>
                </label>
              </div>
              <div id="result-count" class="hint">0 rows</div>
            </div>
            <div class="column-controls" id="column-controls"></div>
            <table>
              <thead id="results-head"></thead>
              <tbody id="results-body"></tbody>
            </table>
          </section>

          <details class="panel panel-summary">
            <summary>Stat Availability</summary>
            <div style="margin-top:8px;">
              <table>
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Stat</th>
                    <th>Group</th>
                    <th>First Consistent Season</th>
                    <th>Modes</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody id="stat-table"></tbody>
              </table>
            </div>
          </details>

          <details class="panel panel-summary">
            <summary>Data Export</summary>
            <div style="margin-top:8px;">
              <div class="filters">
                <div class="row">
                  <label for="export-dataset">Dataset</label>
                  <select id="export-dataset">
                    <option value="matches">Matches</option>
                    <option value="team_match_summary">Team Match Summary</option>
                    <option value="player_match_summary">Player Match Summary</option>
                  </select>
                </div>
                <div class="row">
                  <label for="export-season-from">Seasons</label>
                  <div class="mini-range">
                    <input id="export-season-from" value="1998" />
                    <span>to</span>
                    <input id="export-season-to" value="2026" />
                  </div>
                </div>
              </div>
              <div class="action-row">
                <button type="button" id="download-export">Download CSV</button>
                <a id="export-link" class="export-link" href="#" target="_blank" rel="noopener noreferrer">Open export URL</a>
              </div>
              <p class="export-note">Uses the current competition tab. Exports include friendly names plus <code>stats_json</code> where that carries the detailed stat payload.</p>
            </div>
          </details>

          <details class="panel panel-summary">
            <summary>Current Build Status</summary>
            <div style="margin-top:8px;">
              <p class="note">Current live support now includes legacy all-time scoring, modern player stat summaries, team result queries, and generic match-level stat totals, averages, and basic streaks.</p>
              <p class="subtitle">Public-facing note: NRL and NRLW data are presented for research and historical analysis; source names, logos, and likenesses remain the property of their respective owners.</p>
            </div>
          </details>
        </section>
      </div>
    </div>

    <script>
      const scopeSelect = document.getElementById("scope");
      const competitionSelect = document.getElementById("competition");
      const statSelect = document.getElementById("stat");
      const seasonFromInput = document.getElementById("season-from");
      const seasonToInput = document.getElementById("season-to");
      const teamSelect = document.getElementById("team");
      const opponentSelect = document.getElementById("opponent");
      const venueSelect = document.getElementById("venue");
      const refereeSelect = document.getElementById("referee");
      const playerOptions = document.getElementById("player-options");
      const positionSelect = document.getElementById("position");
      const groundConditionSelect = document.getElementById("ground-condition");
      const weatherConditionSelect = document.getElementById("weather-condition");
      const includeRegularCheckbox = document.getElementById("include-regular");
      const includeFinalsCheckbox = document.getElementById("include-finals");
      const includeGrandFinalCheckbox = document.getElementById("include-grand-final");
      const includePrimaryCompetitionCheckbox = document.getElementById("include-primary-competition");
      const includeRepCompetitionCheckbox = document.getElementById("include-rep-competition");
      const includePrimaryCompetitionLabel = document.getElementById("include-primary-competition-label");
      const includeRepCompetitionLabel = document.getElementById("include-rep-competition-label");
      const competitionSelectionButtons = Array.from(document.querySelectorAll(".tab[data-competition-selection]"));
      const excludeZeroMinuteStreakGamesCheckbox = document.getElementById("exclude-zero-minute-streak-games");
      const singleEntityResultsCheckbox = document.getElementById("single-entity-results");
      const pageSizeSelect = document.getElementById("page-size");
      const conditionGrid = document.getElementById("condition-grid");
      const columnControls = document.getElementById("column-controls");
        const fullResultsButton = document.getElementById("full-results-button");
      const resultCount = document.getElementById("result-count");
      const pageLabel = document.getElementById("page-label");
      const loadingToast = document.getElementById("loading-toast");
      const runQueryButton = document.getElementById("run-query");
      const dataFreshnessNote = document.getElementById("data-freshness-note");
      const exportDatasetSelect = document.getElementById("export-dataset");
      const exportSeasonFromInput = document.getElementById("export-season-from");
      const exportSeasonToInput = document.getElementById("export-season-to");
      const exportLink = document.getElementById("export-link");
      const statsOnlySection = document.getElementById("stats-only-section");
      const playerOnlySection = document.getElementById("player-only-section");
      const streakOnlySection = document.getElementById("streak-only-section");
      const scoreHalfOptions = document.getElementById("score-half-options");
      let pageSize = 200;
      let bootstrapCache = null;
      let starterQueriesCache = [];
      let currentRows = [];
      let currentColumns = [];
      let visibleColumns = [];
      let currentPage = 1;
      let totalRows = 0;
      let totalPages = 1;
      let serverPaging = false;
      let sortColumn = null;
      let sortDirection = "desc";
      let lastQueryShape = null;
      let bootstrapSlowNoticeTimer = null;
      let activeQueryController = null;
      let activeQueryRunId = 0;
      const backendWarmupStartedAt = Date.now();
      const backendWarmupPromise = fetch("/api/health?ts=" + backendWarmupStartedAt, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
        keepalive: true,
      })
        .then((response) => (response.ok ? response.json().catch(() => null) : null))
        .catch(() => null);

      window.addEventListener("pageshow", (event) => {
        if (event.persisted) {
          window.location.reload();
        }
      });

      function currentMode() {
        const streakTab = document.querySelector('.tab[data-mode="streaks"]');
        if (streakTab?.classList.contains("active")) {
          return "streaks";
        }
        return document.querySelector('input[name="metric-mode"]:checked')?.value || "totals";
      }

      function currentFormat() {
        return document.querySelector('input[name="view-format"]:checked')?.value || "overall";
      }

      function setHidden(element, hidden) {
        element.classList.toggle("hidden", hidden);
      }

      function competitionFamily(value) {
        return ["NRLW", "WSOO", "NRLW_PLUS_WSOO"].includes(value) ? "NRLW" : "NRL";
      }

      function competitionToggleConfig(value) {
        return competitionFamily(value) === "NRLW"
          ? { family: "NRLW", primaryCode: "NRLW", repCode: "WSOO", primaryLabel: "NRLW", repLabel: "WSOO" }
          : { family: "NRL", primaryCode: "NRL", repCode: "SOO", primaryLabel: "NRL", repLabel: "SOO" };
      }

      function selectionIncludesPrimaryCompetition(value) {
        return ["NRL", "NRLW", "NRL_PLUS_SOO", "NRLW_PLUS_WSOO"].includes(value);
      }

      function selectionIncludesRepCompetition(value) {
        return ["SOO", "WSOO", "NRL_PLUS_SOO", "NRLW_PLUS_WSOO"].includes(value);
      }

      function deriveCompetitionSelection(family, includePrimary, includeRep) {
        if (family === "NRLW") {
          if (includePrimary && includeRep) return "NRLW_PLUS_WSOO";
          if (includeRep) return "WSOO";
          return "NRLW";
        }
        if (includePrimary && includeRep) return "NRL_PLUS_SOO";
        if (includeRep) return "SOO";
        return "NRL";
      }

      function syncCompetitionControlsFromSelection() {
        const value = competitionSelect.value || "NRL";
        const config = competitionToggleConfig(value);
        if (includePrimaryCompetitionLabel) includePrimaryCompetitionLabel.textContent = config.primaryLabel;
        if (includeRepCompetitionLabel) includeRepCompetitionLabel.textContent = config.repLabel;
        if (includePrimaryCompetitionCheckbox) includePrimaryCompetitionCheckbox.checked = selectionIncludesPrimaryCompetition(value);
        if (includeRepCompetitionCheckbox) includeRepCompetitionCheckbox.checked = selectionIncludesRepCompetition(value);
        document.querySelectorAll('.tab[data-competition]').forEach((tab) => {
          tab.classList.toggle("active", tab.dataset.competition === config.family);
        });
        competitionSelectionButtons.forEach((button) => {
          const selection = button.dataset.competitionSelection;
          if (selection === "primary") {
            button.textContent = config.primaryLabel;
            button.classList.toggle("active", value === (config.family === "NRLW" ? "NRLW" : "NRL"));
            return;
          }
          if (selection === "rep") {
            button.textContent = config.repLabel;
            button.classList.toggle("active", value === (config.family === "NRLW" ? "WSOO" : "SOO"));
            return;
          }
          button.textContent = config.family === "NRLW" ? "NRLW + WSOO" : "NRL + SOO";
          button.classList.toggle("active", value === (config.family === "NRLW" ? "NRLW_PLUS_WSOO" : "NRL_PLUS_SOO"));
        });
      }

      function updateCompetitionSelectionFromToggles(preferred = "primary") {
        const family = competitionFamily(competitionSelect.value || "NRL");
        let includePrimary = !!includePrimaryCompetitionCheckbox?.checked;
        let includeRep = !!includeRepCompetitionCheckbox?.checked;
        if (!includePrimary && !includeRep) {
          if (preferred === "rep") {
            includePrimary = true;
            if (includePrimaryCompetitionCheckbox) includePrimaryCompetitionCheckbox.checked = true;
          } else {
            includeRep = true;
            if (includeRepCompetitionCheckbox) includeRepCompetitionCheckbox.checked = true;
          }
        }
        competitionSelect.value = deriveCompetitionSelection(family, includePrimary, includeRep);
        syncCompetitionControlsFromSelection();
        syncExportLink();
        syncDataFreshness();
      }

      function populateSelect(select, values, selectedValue = "Any") {
        const safeValues = values.length ? values : ["Any"];
        select.innerHTML = safeValues
          .map((value) => '<option value="' + value + '"' + (value === selectedValue ? " selected" : "") + '>' + value + '</option>')
          .join("");
      }

      function populatePlayerOptions(values) {
        playerOptions.innerHTML = (values || [])
          .filter((value) => value && value !== "Any")
          .map((value) => '<option value="' + value + '"></option>')
          .join("");
      }

      function supportsMode(stat, mode) {
        if (!stat) return false;
        const scoreDerivedTeamStats = new Set(["games", "wins", "losses", "draws", "points_for", "points_against", "total_points", "margin"]);
        if (mode === "streaks") {
          if (stat.scope === "team" && scoreDerivedTeamStats.has(stat.statKey)) return true;
          return !!stat.supportsStreaks;
        }
        if (mode === "averages") {
          if (stat.scope === "team" && ["games", "wins", "losses", "draws"].includes(stat.statKey)) return true;
          if (stat.scope === "player" && stat.statKey === "games_played") return true;
          return !!stat.supportsAverages;
        }
        if (stat.scope === "team" && scoreDerivedTeamStats.has(stat.statKey)) return true;
        return !!stat.supportsTotals;
      }

      function scoreHalfSupportsCurrentStat(scope, statKey) {
        if (scope !== "team") return false;
        return [
          "points_for",
          "points_against",
          "total_points",
          "margin",
          "points_for_first_half",
          "points_against_first_half",
          "margin_first_half",
          "points_for_second_half",
          "points_against_second_half",
          "margin_second_half",
        ].includes(statKey);
      }

      function syncScoreHalfControls(scope, statKey) {
        const supported = scoreHalfSupportsCurrentStat(scope, statKey);
        const labels = scoreHalfOptions?.querySelectorAll("label") ?? [];
        const inputs = scoreHalfOptions?.querySelectorAll('input[name="score-half"]') ?? [];
        inputs.forEach((input) => {
          const keepEnabled = input.value === "all" || supported;
          input.disabled = !keepEnabled;
          if (!keepEnabled && input.checked) {
            const fallback = scoreHalfOptions?.querySelector('input[name="score-half"][value="all"]');
            if (fallback) fallback.checked = true;
          }
        });
        labels.forEach((label) => {
          const input = label.querySelector('input[name="score-half"]');
          const keepEnabled = input?.value === "all" || supported;
          label.classList.toggle("muted-option", !keepEnabled);
        });
      }

      function activeStatsForScope(statDefinitions, scope) {
        return statDefinitions
          .filter((stat) => stat.scope === scope && !["games_included", "half_time", "penalty_goals", "conversions", "conversions_with_attempts", "conversion_attempts", "goal_conversion_rate", "fantasy_points"].includes(stat.statKey))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
      }

      function syncModeSections() {
        const mode = currentMode();
        const scope = scopeSelect.value;
        if (bootstrapCache?.statDefinitions) {
          fillScopeOptions(bootstrapCache.statDefinitions);
        }
        setHidden(statsOnlySection, mode !== "totals" && mode !== "averages");
        setHidden(streakOnlySection, mode !== "streaks");
        setHidden(playerOnlySection, scope !== "player");
        const overallInput = document.querySelector('input[name="view-format"][value="overall"]');
        const clubInput = document.querySelector('input[name="view-format"][value="club"]');
        const clubLabel = document.getElementById("club-format-label");
        const averagesInput = document.querySelector('input[name="metric-mode"][value="averages"]');
        const averagesLabel = document.getElementById("averages-label");
        const clubAllowed = scope === "player" && mode !== "streaks";
        if (mode === "streaks") {
          if (overallInput) {
            overallInput.disabled = true;
            overallInput.parentElement?.classList.add("muted-option");
            if (overallInput.checked) {
              const fallback = document.querySelector('input[name="view-format"][value="match"]');
              if (fallback) fallback.checked = true;
            }
          }
          if (averagesInput) {
            averagesInput.disabled = true;
            averagesLabel?.classList.add("muted-option");
            const totalsInput = document.querySelector('input[name="metric-mode"][value="totals"]');
            if (averagesInput.checked && totalsInput) totalsInput.checked = true;
          }
        } else {
          if (overallInput) {
            overallInput.disabled = false;
            overallInput.parentElement?.classList.remove("muted-option");
          }
          if (averagesInput) {
            averagesInput.disabled = false;
            averagesLabel?.classList.remove("muted-option");
          }
        }
        if (clubInput) {
          clubInput.disabled = !clubAllowed;
          clubLabel?.classList.toggle("muted-option", !clubAllowed);
          if (clubInput.checked && !clubAllowed) {
            const fallback = document.querySelector('input[name="view-format"][value="overall"]');
            if (fallback) fallback.checked = true;
          }
        }
        syncScoreHalfControls(scope, statSelect.value);
      }

      function fillScopeOptions(statDefinitions) {
        const scope = scopeSelect.value;
        const mode = currentMode();
        const previous = statSelect.value;
        const stats = activeStatsForScope(statDefinitions, scope);

        statSelect.innerHTML = stats
          .map((stat) => {
            const enabled = supportsMode(stat, mode);
            const suffix = enabled ? "" : mode === "streaks" ? " (streaks unavailable)" : mode === "averages" ? " (averages unavailable)" : " (totals unavailable)";
            return \`<option value="\${stat.statKey}"\${enabled ? "" : " disabled"}>\${stat.displayName}\${suffix}</option>\`;
          })
          .join("");

        const stillValid = [...statSelect.options].find((option) => option.value === previous && !option.disabled);
        if (stillValid) {
          statSelect.value = previous;
        } else {
          const firstEnabled = [...statSelect.options].find((option) => !option.disabled);
          statSelect.value = firstEnabled?.value || "";
        }
        syncScoreHalfControls(scope, statSelect.value);
      }

      function buildConditionRow(joiner = "AND", seed = null) {
        const mode = currentMode();
        const stats = activeStatsForScope((bootstrapCache?.statDefinitions ?? []), scopeSelect.value)
          .slice()
          .sort((a, b) => {
            if (a.statKey === "games_included") return -1;
            if (b.statKey === "games_included") return 1;
            return a.displayName.localeCompare(b.displayName);
          });
        const seenLabels = new Set();
        const statOptions = stats
          .filter((stat) => {
            const label = stat.displayName.toLowerCase();
            if (seenLabels.has(label)) return false;
            seenLabels.add(label);
            return true;
          })
          .map((stat) => {
            const enabled = supportsMode(stat, mode);
            const suffix = enabled ? "" : mode === "streaks" ? " (streaks unavailable)" : mode === "averages" ? " (averages unavailable)" : " (totals unavailable)";
            const selected = seed?.statKey === stat.statKey ? " selected" : "";
            return '<option value="' + stat.statKey + '"' + (enabled ? "" : " disabled") + selected + '>' + stat.displayName + suffix + '</option>';
          })
          .join("");

        return \`
          <div class="condition-row">
            <select class="condition-stat"><option value="">Stat</option>\${statOptions}</select>
            <select class="operator">
              <option value="gt"\${seed?.operator === "gt" ? " selected" : ""}>&gt;</option>
              <option value="gte"\${seed?.operator === "gte" ? " selected" : ""}>&gt;=</option>
              <option value="eq"\${seed?.operator === "eq" ? " selected" : ""}>=</option>
              <option value="lt"\${seed?.operator === "lt" ? " selected" : ""}>&lt;</option>
              <option value="lte"\${seed?.operator === "lte" ? " selected" : ""}>&lt;=</option>
              <option value="neq"\${seed?.operator === "neq" ? " selected" : ""}>!=</option>
            </select>
            <input class="condition-value" placeholder="value" value="\${seed?.value ?? ""}" />
            <select class="condition-joiner">
              <option value="AND"\${joiner === "AND" ? " selected" : ""}>AND</option>
              <option value="OR"\${joiner === "OR" ? " selected" : ""}>OR</option>
              <option value="AND NOT"\${joiner === "AND NOT" ? " selected" : ""}>AND NOT</option>
            </select>
            <button type="button" class="remove-condition" title="Remove">x</button>
          </div>
        \`;
      }

      function setConditionRows(conditions) {
        const safeConditions = Array.isArray(conditions) ? conditions : [];
        if (!safeConditions.length) {
          conditionGrid.innerHTML = buildConditionRow();
          wireConditionButtons();
          return;
        }
        conditionGrid.innerHTML = safeConditions
          .map((condition, index) => buildConditionRow(index === 0 ? "AND" : (condition.joiner || "AND"), condition))
          .join("");
        wireConditionButtons();
      }

      function buildExportUrl() {
        const params = new URLSearchParams({
          dataset: exportDatasetSelect.value || "matches",
          format: "csv",
          competition: competitionSelect.value || "NRL",
          seasonFrom: exportSeasonFromInput.value || "1998",
          seasonTo: exportSeasonToInput.value || "2026",
        });
        return "/api/export?" + params.toString();
      }

      function syncExportLink() {
        exportLink.href = buildExportUrl();
      }

      function syncDataFreshness() {
        const freshness = bootstrapCache?.app?.dataFreshness || [];
        const activeCompetition = competitionSelect.value || "NRL";
        const competitionCodes = activeCompetition === "NRL_PLUS_SOO"
          ? ["NRL", "SOO"]
          : activeCompetition === "NRLW_PLUS_WSOO"
            ? ["NRLW", "WSOO"]
            : [activeCompetition];
        const summaries = competitionCodes
          .map((code) => {
            const active = freshness.find((item) => item.competition === code);
            if (!active || !active.roundLabel || !active.season) return null;
            return code + " data currently through " + active.roundLabel + ", " + active.season + ".";
          })
          .filter(Boolean);
        if (summaries.length === 0) {
          dataFreshnessNote.textContent = "Latest imported round not available yet.";
          return;
        }
        dataFreshnessNote.textContent = summaries.join(" ");
      }

      function wireConditionButtons() {
        conditionGrid.querySelectorAll(".remove-condition").forEach((button) => {
          button.addEventListener("click", () => {
            const rows = conditionGrid.querySelectorAll(".condition-row");
            if (rows.length <= 1) {
              const stat = button.closest(".condition-row")?.querySelector(".condition-stat");
              const operator = button.closest(".condition-row")?.querySelector(".operator");
              const value = button.closest(".condition-row")?.querySelector(".condition-value");
              const joiner = button.closest(".condition-row")?.querySelector(".condition-joiner");
              if (stat) stat.value = "";
              if (operator) operator.value = "gt";
              if (value) value.value = "";
              if (joiner) joiner.value = "AND";
              return;
            }
            button.closest(".condition-row")?.remove();
          });
        });
      }

      function checkedValue(name, fallback = "any") {
        return document.querySelector('input[name="' + name + '"]:checked')?.value || fallback;
      }

      function setCheckedValue(name, value) {
        const target = document.querySelector('input[name="' + name + '"][value="' + value + '"]')
          || document.querySelector('input[name="' + name + '"]');
        if (target) target.checked = true;
      }

      function invalidateColumnProjectionState() {
        visibleColumns = [];
        currentColumns = [];
        lastQueryShape = null;
      }

      function resetForm() {
        invalidateColumnProjectionState();
        scopeSelect.value = "player";
        competitionSelect.value = "NRL";
        document.querySelectorAll('.tab[data-scope]').forEach((tab) => tab.classList.toggle("active", tab.dataset.scope === "player"));
        document.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === "stats"));
        syncCompetitionControlsFromSelection();
        setCheckedValue("metric-mode", "totals");
        setCheckedValue("home-away", "any");
        setCheckedValue("result-filter", "any");
        setCheckedValue("score-half", "all");
        setCheckedValue("position-pool", "any");
        setCheckedValue("debut", "any");
        setCheckedValue("view-format", "overall");
        seasonFromInput.value = "1908";
        seasonToInput.value = "2026";
        document.getElementById("round-from").value = "1";
        document.getElementById("round-to").value = "33";
        includeRegularCheckbox.checked = true;
        includeFinalsCheckbox.checked = true;
        includeGrandFinalCheckbox.checked = true;
        fillScopeOptions(bootstrapCache?.statDefinitions || []);
        statSelect.value = [...statSelect.options].find((option) => !option.disabled)?.value || "";
        teamSelect.value = "Any";
        opponentSelect.value = "Any";
        venueSelect.value = "Any";
        refereeSelect.value = "Any";
        positionSelect.value = "Any";
        groundConditionSelect.value = "Any";
        weatherConditionSelect.value = "Any";
        document.getElementById("match-player").value = "";
        document.getElementById("player-search").value = "";
        document.getElementById("points-for-from").value = "0";
        document.getElementById("points-for-to").value = "98";
        document.getElementById("points-against-from").value = "0";
        document.getElementById("points-against-to").value = "98";
        document.getElementById("multi-streaks").checked = false;
        document.getElementById("exclude-sparse-streaks").checked = true;
        if (excludeZeroMinuteStreakGamesCheckbox) excludeZeroMinuteStreakGamesCheckbox.checked = true;
        if (singleEntityResultsCheckbox) singleEntityResultsCheckbox.checked = false;
        exportDatasetSelect.value = "matches";
        exportSeasonFromInput.value = "1998";
        exportSeasonToInput.value = "2026";
        setConditionRows([]);
        syncModeSections();
        syncExportLink();
        syncDataFreshness();
      }

      function collectConditions() {
        return [...conditionGrid.querySelectorAll(".condition-row")]
          .map((row) => ({
            statKey: row.querySelector(".condition-stat")?.value || "",
            operator: row.querySelector(".operator")?.value || "",
            value: row.querySelector(".condition-value")?.value?.trim?.() || "",
            joiner: row.querySelector(".condition-joiner")?.value || "AND",
          }))
          .filter((condition) => condition.statKey && condition.value !== "");
      }

      async function applyQueryFromUrlIfPresent() {
        const urlParams = new URLSearchParams(window.location.search);
        if (!urlParams.size) return;
        const knownKeys = [
          "scope", "competition", "statKey", "mode", "seasonFrom", "seasonTo",
          "team", "opponent", "venue", "referee", "position", "player", "playerType",
          "matchPlayer", "debut", "groundCondition", "weatherCondition", "homeAway", "result",
          "scoreHalf", "format", "allowMultipleStreaks", "excludeSparseHistoricalStreaks",
          "excludeZeroMinuteStreakGames", "singleEntityResults", "roundFrom", "roundTo", "includeRegular",
          "includeFinals", "includeGrandFinal", "conditions", "autorun",
        ];
        if (!knownKeys.some((key) => urlParams.has(key))) return;

        const scope = urlParams.get("scope");
        if (scope === "player" || scope === "team") {
          scopeSelect.value = scope;
          document.querySelectorAll('.tab[data-scope]').forEach((tab) => tab.classList.remove("active"));
          document.querySelector('.tab[data-scope="' + scope + '"]')?.classList.add("active");
        }

        const competition = urlParams.get("competition");
        if (competition) {
          competitionSelect.value = competition;
          syncCompetitionControlsFromSelection();
        }

        const mode = urlParams.get("mode");
        if (mode === "streaks") {
          document.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.classList.remove("active"));
          document.querySelector('.tab[data-mode="streaks"]')?.classList.add("active");
        } else if (mode === "totals" || mode === "averages") {
          document.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.classList.remove("active"));
          document.querySelector('.tab[data-mode="stats"]')?.classList.add("active");
          setCheckedValue("metric-mode", mode);
        }

        fillScopeOptions(bootstrapCache.statDefinitions);
        syncModeSections();

        const statKey = urlParams.get("statKey");
        if (statKey) {
          const validStat = [...statSelect.options].find((option) => option.value === statKey && !option.disabled);
          if (validStat) statSelect.value = statKey;
        }

        if (urlParams.has("seasonFrom")) seasonFromInput.value = urlParams.get("seasonFrom") || seasonFromInput.value;
        if (urlParams.has("seasonTo")) seasonToInput.value = urlParams.get("seasonTo") || seasonToInput.value;
        if (urlParams.has("team")) teamSelect.value = urlParams.get("team") || "Any";
        if (urlParams.has("opponent")) opponentSelect.value = urlParams.get("opponent") || "Any";
        if (urlParams.has("venue")) venueSelect.value = urlParams.get("venue") || "Any";
        if (urlParams.has("referee")) refereeSelect.value = urlParams.get("referee") || "Any";
        if (urlParams.has("position")) positionSelect.value = urlParams.get("position") || "Any";
        if (urlParams.has("groundCondition")) groundConditionSelect.value = urlParams.get("groundCondition") || "Any";
        if (urlParams.has("weatherCondition")) weatherConditionSelect.value = urlParams.get("weatherCondition") || "Any";
        if (urlParams.has("player")) document.getElementById("player-search").value = urlParams.get("player") || "";
        if (urlParams.has("matchPlayer")) document.getElementById("match-player").value = urlParams.get("matchPlayer") || "";
        if (urlParams.has("roundFrom")) document.getElementById("round-from").value = urlParams.get("roundFrom") || "";
        if (urlParams.has("roundTo")) document.getElementById("round-to").value = urlParams.get("roundTo") || "";

        setCheckedValue("home-away", urlParams.get("homeAway") || "any");
        setCheckedValue("result-filter", urlParams.get("result") || "any");
        setCheckedValue("score-half", urlParams.get("scoreHalf") || "all");
        setCheckedValue("position-pool", urlParams.get("playerType") || "any");
        setCheckedValue("debut", urlParams.get("debut") || "any");
        setCheckedValue("view-format", urlParams.get("format") || "overall");

        includeRegularCheckbox.checked = urlParams.get("includeRegular") !== "0";
        includeFinalsCheckbox.checked = urlParams.get("includeFinals") !== "0";
        includeGrandFinalCheckbox.checked = urlParams.get("includeGrandFinal") !== "0";
        document.getElementById("multi-streaks").checked = urlParams.get("allowMultipleStreaks") === "1";
        document.getElementById("exclude-sparse-streaks").checked = urlParams.get("excludeSparseHistoricalStreaks") !== "0";
        if (excludeZeroMinuteStreakGamesCheckbox) {
          excludeZeroMinuteStreakGamesCheckbox.checked = urlParams.get("excludeZeroMinuteStreakGames") !== "0";
        }
        if (singleEntityResultsCheckbox) {
          singleEntityResultsCheckbox.checked = urlParams.get("singleEntityResults") !== "0";
        }

        let parsedConditions = [];
        if (urlParams.has("conditions")) {
          try {
            const raw = JSON.parse(urlParams.get("conditions") || "[]");
            if (Array.isArray(raw)) parsedConditions = raw;
          } catch {
            parsedConditions = [];
          }
        }
        setConditionRows(parsedConditions);
        syncModeSections();

        if (urlParams.get("autorun") === "1") {
          await runQuery();
        }
      }

      function renderStarterQueries(starterQueries) {
        starterQueriesCache = starterQueries.slice();
        const markup = starterQueries
          .map((query, index) => \`
            <button type="button" class="starter-item" data-starter-index="\${index}"><strong>\${query.label}</strong></button>
          \`)
          .join("");
        document.querySelectorAll(".starter-list-target").forEach((container) => {
          container.innerHTML = markup;
        });

        document.querySelectorAll(".starter-item[data-starter-index]").forEach((item) => {
          item.addEventListener("click", () => {
            const query = starterQueriesCache[Number(item.dataset.starterIndex)];
            if (!query) return;
            resetForm();
            scopeSelect.value = query.mode === "team" ? "team" : "player";
            document.querySelectorAll('.tab[data-scope]').forEach((tab) => tab.classList.remove("active"));
            document.querySelector('.tab[data-scope="' + scopeSelect.value + '"]')?.classList.add("active");
            competitionSelect.value = query.competition || "NRL";
            syncCompetitionControlsFromSelection();
            fillScopeOptions(bootstrapCache.statDefinitions);
            const preferredStat = [...statSelect.options].find((option) => option.value === query.statKey && !option.disabled)?.value;
            statSelect.value = preferredStat || [...statSelect.options].find((option) => !option.disabled)?.value || "";
            if (query.metric === "streaks") {
              document.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.classList.remove("active"));
              document.querySelector('.tab[data-mode="streaks"]')?.classList.add("active");
            } else {
              document.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.classList.remove("active"));
              document.querySelector('.tab[data-mode="stats"]')?.classList.add("active");
              const metricInput = document.querySelector('input[name="metric-mode"][value="' + query.metric + '"]') || document.querySelector('input[name="metric-mode"][value="totals"]');
              if (metricInput) metricInput.checked = true;
            }
            if (query.format) {
              setCheckedValue("view-format", query.format);
            }
            if (query.statKey === "tries" || query.statKey === "points") {
              seasonFromInput.value = "1908";
            }
            syncModeSections();
            runQuery();
          });
        });
      }

      function renderStats(statDefinitions, statGroups) {
        const groupMap = Object.fromEntries(statGroups.map((group) => [group.code, group.label]));
        document.getElementById("stat-table").innerHTML = statDefinitions
          .filter((stat) => !["games_included", "half_time", "penalty_goals", "conversions", "conversions_with_attempts", "conversion_attempts", "goal_conversion_rate", "fantasy_points"].includes(stat.statKey))
          .slice()
          .sort((a, b) => {
            if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
            return a.displayName.localeCompare(b.displayName);
          })
          .map((stat) => {
            const modes = [
              stat.supportsTotals ? "totals" : null,
              stat.supportsAverages ? "averages" : null,
              stat.supportsStreaks ? "streaks" : null,
            ].filter(Boolean).join(", ");

            return \`
              <tr>
                <td>\${stat.scope}</td>
                <td>\${stat.displayName}</td>
                <td>\${groupMap[stat.groupCode] ?? stat.groupCode}</td>
                <td>\${stat.firstConsistentSeason ?? "-"}</td>
                <td>\${modes || "-"}</td>
                <td>\${stat.availabilityNotes}</td>
              </tr>
            \`;
          })
          .join("");
      }

      function compareValues(a, b) {
        const aNum = Number(a);
        const bNum = Number(b);
        if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
          return aNum - bNum;
        }
        return String(a ?? "").localeCompare(String(b ?? ""));
      }

      function renderColumnControls() {
        if (!columnControls) return;
        if (currentColumns.length === 0) {
          columnControls.innerHTML = "";
          return;
        }

        columnControls.innerHTML = currentColumns
          .map((column) => \`<label><input type="checkbox" data-column="\${column}" \${visibleColumns.includes(column) ? "checked" : ""} /> \${column}</label>\`)
          .join("");

        columnControls.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
          checkbox.addEventListener("change", () => {
            visibleColumns = [...columnControls.querySelectorAll("input:checked")].map((item) => item.dataset.column);
            renderTable();
          });
        });
      }

      function buildQueryParams() {
        return new URLSearchParams({
          scope: scopeSelect.value,
          competition: competitionSelect.value || "NRL",
          statKey: statSelect.value,
          mode: currentMode(),
          seasonFrom: seasonFromInput.value || "1908",
          seasonTo: seasonToInput.value || "2026",
          team: teamSelect.value || "Any",
          opponent: opponentSelect.value || "Any",
          venue: venueSelect.value || "Any",
          referee: refereeSelect.value || "Any",
          position: positionSelect.value || "Any",
          player: document.getElementById("player-search").value || "Any",
          playerType: checkedValue("position-pool"),
          matchPlayer: document.getElementById("match-player").value || "Any",
          debut: checkedValue("debut"),
          groundCondition: groundConditionSelect.value || "Any",
          weatherCondition: weatherConditionSelect.value || "Any",
          homeAway: checkedValue("home-away"),
          result: checkedValue("result-filter"),
          scoreHalf: checkedValue("score-half", "all"),
          format: currentFormat(),
          allowMultipleStreaks: document.getElementById("multi-streaks").checked ? "1" : "0",
          excludeSparseHistoricalStreaks: document.getElementById("exclude-sparse-streaks").checked ? "1" : "0",
          excludeZeroMinuteStreakGames: excludeZeroMinuteStreakGamesCheckbox?.checked ? "1" : "0",
          singleEntityResults: singleEntityResultsCheckbox?.checked ? "1" : "0",
          roundFrom: document.getElementById("round-from").value || "",
          roundTo: document.getElementById("round-to").value || "",
          includeRegular: includeRegularCheckbox.checked ? "1" : "0",
          includeFinals: includeFinalsCheckbox.checked ? "1" : "0",
          includeGrandFinal: includeGrandFinalCheckbox.checked ? "1" : "0",
          conditions: JSON.stringify(collectConditions()),
          limit: String(pageSizeSelect.value || "200"),
        });
      }

      function buildDetailHref(overrides) {
        const params = buildQueryParams();
        Object.entries(overrides).forEach(([key, value]) => params.set(key, value));
        return "/full-results?" + params.toString();
      }

      function buildRoundAnchor(roundLabel) {
        const normalized = String(roundLabel || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        return "round-" + (normalized || "unknown");
      }

      function buildSeasonIndexHref(season, roundLabel) {
        const params = new URLSearchParams();
        params.set("competition", competitionSelect.value || "NRL");
        params.set("season", String(season || ""));
        return "/season?" + params.toString() + (roundLabel ? ("#" + buildRoundAnchor(roundLabel)) : "");
      }

      function compactFullResultsParams() {
        const defaults = {
          scope: "player",
          competition: "NRL",
          mode: "totals",
          seasonFrom: "1908",
          seasonTo: "2026",
          team: "Any",
          opponent: "Any",
          venue: "Any",
          referee: "Any",
          position: "Any",
          player: "Any",
          playerType: "any",
          matchPlayer: "Any",
          debut: "any",
          groundCondition: "Any",
          weatherCondition: "Any",
          homeAway: "any",
          result: "any",
          scoreHalf: "all",
          format: "overall",
          allowMultipleStreaks: "0",
          excludeSparseHistoricalStreaks: "1",
          excludeZeroMinuteStreakGames: "1",
          singleEntityResults: "1",
          roundFrom: "",
          roundTo: "",
          includeRegular: "1",
          includeFinals: "1",
          includeGrandFinal: "1",
          conditions: "[]",
          limit: String(pageSizeSelect.value || "200"),
        };
        const params = buildQueryParams();
        const compact = new URLSearchParams();
        params.forEach((value, key) => {
          if (key === "limit") return;
          if (defaults[key] !== undefined && String(defaults[key]) === String(value)) return;
          compact.set(key, value);
        });
        for (const key of ["scope", "competition", "statKey", "mode", "seasonFrom", "seasonTo", "format"]) {
          if (params.has(key)) compact.set(key, params.get(key));
        }
        compact.set("page", "1");
        compact.set("pageSize", String(pageSizeSelect.value || "200"));
        return compact;
      }

      function renderTable() {
        const head = document.getElementById("results-head");
        const body = document.getElementById("results-body");
        const columns = visibleColumns.length > 0 ? visibleColumns : currentColumns;
        const pageRows = currentRows.slice();
        const effectiveTotalRows = serverPaging ? totalRows : pageRows.length;
        const effectiveTotalPages = serverPaging ? totalPages : Math.max(1, Math.ceil(effectiveTotalRows / pageSize));

        pageLabel.textContent = \`Page \${currentPage} of \${effectiveTotalPages}\`;
        resultCount.textContent = \`\${effectiveTotalRows} rows\`;
        head.innerHTML =
          '<tr><th>#</th>' +
          columns
            .map((column) => {
              const active = sortColumn === column ? ' active-sort sort-' + sortDirection : '';
              return '<th class="sortable' + active + '" data-column="' + column + '">' + column + '</th>';
            })
            .join('') +
          '</tr>';
        body.innerHTML = pageRows
          .map((row, index) => '<tr><td>' + (((currentPage - 1) * pageSize) + index + 1) + '</td>' + columns.map((column) => {
            let value = row[column] ?? '';
            if (column === "player" && value) {
              value =
                '<a href="/player/' +
                encodeURIComponent(String(row.player)) +
                '?competition=' +
                encodeURIComponent(competitionSelect.value || "NRL") +
                '">' +
                value +
                '</a>';
            } else if (column === "season" && row.season) {
              value = '<a href="' + buildSeasonIndexHref(row.season, columns.includes("round") ? row.round : "") + '">' + String(row.season) + '</a>';
            } else if (column === "round" && row.round && row.season) {
              value = '<a href="' + buildSeasonIndexHref(row.season, row.round) + '">' + String(row.round) + '</a>';
            } else if (column === "team" && value) {
              value = '<a href="' + buildDetailHref({ scope: "team", team: String(row.team), mode: "totals", format: "overall" }) + '">' + value + '</a>';
            } else if (column === "match_reference" && row.match_id) {
              value = '<a href="/match/' + row.match_id + '">' + (value || "Match") + '</a>';
            }
            return '<td>' + value + '</td>';
          }).join('') + '</tr>')
          .join('');

        head.querySelectorAll("th.sortable").forEach((cell) => {
          cell.addEventListener("click", () => {
            const column = cell.dataset.column;
            if (sortColumn === column) {
              sortDirection = sortDirection === "asc" ? "desc" : "asc";
            } else {
              sortColumn = column;
              sortDirection = "desc";
            }
            currentPage = 1;
            runQuery(false);
          });
        });
      }

      function renderResults(payload) {
        const hint = document.getElementById("result-hint");

        if (!payload.ok) {
          currentRows = [];
          currentColumns = [];
          visibleColumns = [];
          currentPage = 1;
          totalRows = 0;
          totalPages = 1;
          serverPaging = false;
          document.getElementById("results-head").innerHTML = "";
          document.getElementById("results-body").innerHTML = '<tr><td>' + payload.error + '</td></tr>';
          hint.textContent = payload.error;
          renderColumnControls();
          resultCount.textContent = "0 rows";
          pageLabel.textContent = "Page 1";
          return;
        }

        hint.textContent = payload.summary;
        currentColumns = payload.columns || [];
        currentRows = payload.rows || [];
        totalRows = Number(payload.totalRows ?? currentRows.length);
        totalPages = Number(payload.totalPages ?? Math.max(1, Math.ceil(totalRows / pageSize)));
        currentPage = Number(payload.page ?? currentPage ?? 1);
        serverPaging = Number.isFinite(Number(payload.totalRows));
        if (!visibleColumns.length) {
          visibleColumns = currentColumns.slice();
        } else {
          visibleColumns = visibleColumns.filter((column) => currentColumns.includes(column));
          if (!visibleColumns.length) visibleColumns = currentColumns.slice();
        }
        if (currentColumns.includes("streak")) {
          sortColumn = "streak";
        } else if (currentColumns.includes("stat_total")) {
          sortColumn = "stat_total";
        } else if (currentColumns.includes("margin")) {
          sortColumn = "margin";
        } else {
          sortColumn = currentColumns[1] ?? currentColumns[0] ?? null;
        }
        if (typeof payload.sortColumn === "string" && payload.sortColumn) {
          sortColumn = payload.sortColumn;
        }
        if (payload.sortDirection === "asc" || payload.sortDirection === "desc") {
          sortDirection = payload.sortDirection;
        } else {
          sortDirection = "desc";
        }
        renderColumnControls();
        renderTable();
      }

      function queryShapeFromParams(params) {
        return [
          params.get("scope") || "",
          params.get("mode") || "",
          params.get("format") || "",
          params.get("statKey") || "",
        ].join("|");
      }

      async function runQuery(resetPage = true) {
        const runId = ++activeQueryRunId;
        if (activeQueryController) {
          activeQueryController.abort();
        }
        const controller = new AbortController();
        activeQueryController = controller;
        loadingToast.classList.add("visible");
        if (runQueryButton) runQueryButton.disabled = true;
        if (resetPage) currentPage = 1;
        const params = buildQueryParams();
        const nextQueryShape = queryShapeFromParams(params);
        const queryShapeChanged = nextQueryShape !== lastQueryShape;
        if (queryShapeChanged) {
          visibleColumns = [];
          sortColumn = null;
          sortDirection = "desc";
        }
        params.set("page", String(currentPage));
        params.set("pageSize", String(pageSize));
        if (sortColumn) params.set("sortColumn", sortColumn);
        if (sortDirection) params.set("sortDirection", sortDirection);
        if (!queryShapeChanged) {
          const requestedColumns = (visibleColumns.length > 0 ? visibleColumns : currentColumns).filter(Boolean);
          if (requestedColumns.length > 0) params.set("columns", requestedColumns.join(","));
        }
        try {
          const response = await fetch('/api/query/full?' + params.toString(), {
            cache: "no-store",
            signal: controller.signal,
          });
          const text = await response.text();
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            throw new Error(text || ('Query failed with status ' + response.status));
          }
          if (runId !== activeQueryRunId) return;
          if (payload?.ok) {
            lastQueryShape = nextQueryShape;
          }
          renderResults(payload);
        } catch (error) {
          if (runId !== activeQueryRunId) return;
          if (error instanceof Error && error.name === "AbortError") return;
          renderResults({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            columns: [],
            rows: [],
          });
        } finally {
          if (runId === activeQueryRunId) {
            activeQueryController = null;
            loadingToast.classList.remove("visible");
            if (runQueryButton) runQueryButton.disabled = false;
          }
        }
      }

      async function fetchBootstrapWithRetry(maxAttempts = 4) {
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 12000);
            const bootstrapResponse = await fetch("/api/meta/bootstrap?ts=" + Date.now() + "-" + attempt, {
              cache: "no-store",
              headers: { "cache-control": "no-cache" },
              signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!bootstrapResponse.ok) {
              throw new Error("Bootstrap request failed with status " + bootstrapResponse.status);
            }
            return await bootstrapResponse.json();
          } catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(1200, attempt * 350)));
            }
          }
        }
        if (lastError instanceof Error) throw lastError;
        throw new Error(String(lastError ?? "Unknown bootstrap fetch error"));
      }

      async function fetchPlayerOptionsWithRetry(maxAttempts = 3) {
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const response = await fetch("/api/meta/players?ts=" + Date.now() + "-" + attempt, {
              cache: "no-store",
              headers: { "cache-control": "no-cache" },
              signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) {
              throw new Error("Player options request failed with status " + response.status);
            }
            const payload = await response.json();
            if (!payload?.ok || !Array.isArray(payload.players)) {
              throw new Error(payload?.error || "Invalid player options payload.");
            }
            return payload.players;
          } catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(1200, attempt * 350)));
            }
          }
        }
        if (lastError instanceof Error) throw lastError;
        throw new Error(String(lastError ?? "Unknown player options fetch error"));
      }

      async function waitForBackendWarmup(maxWaitMs = 1500) {
        await Promise.race([
          backendWarmupPromise,
          new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
        ]);
      }

      async function bootstrap() {
        dataFreshnessNote.textContent = "Waking backend and loading filters...";
        await waitForBackendWarmup();
        dataFreshnessNote.textContent = "Loading data freshness and filters...";
        bootstrapSlowNoticeTimer = setTimeout(() => {
          dataFreshnessNote.textContent = "Still loading bootstrap data (cold start can take up to a minute)...";
          document.querySelectorAll(".starter-list-target").forEach((container) => {
            if (!container.dataset.bootstrapLoadingShown) {
              container.dataset.bootstrapLoadingShown = "1";
              container.innerHTML = '<div class="starter-item">Loading starter queries and filter options...</div>';
            }
          });
        }, 1200);

        const bootstrap = await fetchBootstrapWithRetry();
        bootstrapCache = bootstrap;

        populateSelect(teamSelect, bootstrap.filterOptions.teams, "Any");
        populateSelect(opponentSelect, bootstrap.filterOptions.teams, "Any");
        populateSelect(venueSelect, bootstrap.filterOptions.venues, "Any");
        populateSelect(refereeSelect, bootstrap.filterOptions.referees, "Any");
        populatePlayerOptions(bootstrap.filterOptions.players || []);
        populateSelect(positionSelect, bootstrap.filterOptions.positions, "Any");
        populateSelect(groundConditionSelect, bootstrap.filterOptions.groundConditions, "Any");
        populateSelect(weatherConditionSelect, bootstrap.filterOptions.weatherConditions, "Any");
        fillScopeOptions(bootstrap.statDefinitions);
        renderStarterQueries(bootstrap.starterQueries);
        renderStats(bootstrap.statDefinitions, bootstrap.statGroups);
        setConditionRows([]);
        renderResults({ ok: true, summary: "Seeded local D1 is ready. Try a supported query such as player tries or team wins.", columns: [], rows: [] });
        syncModeSections();
        syncCompetitionControlsFromSelection();
        syncExportLink();
        syncDataFreshness();
        fetchPlayerOptionsWithRetry()
          .then((players) => {
            if (Array.isArray(players) && players.length > 0) {
              populatePlayerOptions(players);
            }
          })
          .catch(() => {
            // Keep whatever bootstrap supplied if the async player list call fails.
          });

        scopeSelect.addEventListener("change", () => {
          invalidateColumnProjectionState();
          fillScopeOptions(bootstrap.statDefinitions);
          setConditionRows([]);
          syncModeSections();
        });
        statSelect.addEventListener("change", () => {
          invalidateColumnProjectionState();
          syncModeSections();
        });
        document.querySelectorAll(".tab[data-scope]").forEach((button) => {
          button.addEventListener("click", () => {
            invalidateColumnProjectionState();
            document.querySelectorAll(".tab[data-scope]").forEach((tab) => tab.classList.remove("active"));
            button.classList.add("active");
            scopeSelect.value = button.dataset.scope;
            fillScopeOptions(bootstrap.statDefinitions);
            setConditionRows([]);
            syncModeSections();
          });
        });
        document.querySelectorAll(".tab[data-mode]").forEach((button) => {
          button.addEventListener("click", () => {
            invalidateColumnProjectionState();
            document.querySelectorAll(".tab[data-mode]").forEach((tab) => tab.classList.remove("active"));
            button.classList.add("active");
            syncModeSections();
          });
        });
        document.querySelectorAll(".tab[data-competition]").forEach((button) => {
          button.addEventListener("click", () => {
            competitionSelect.value = button.dataset.competition === "NRLW" ? "NRLW" : "NRL";
            syncCompetitionControlsFromSelection();
            syncExportLink();
            syncDataFreshness();
          });
        });
        competitionSelectionButtons.forEach((button) => {
          button.addEventListener("click", () => {
            const family = competitionFamily(competitionSelect.value || "NRL");
            if (button.dataset.competitionSelection === "rep") {
              competitionSelect.value = family === "NRLW" ? "WSOO" : "SOO";
            } else if (button.dataset.competitionSelection === "combined") {
              competitionSelect.value = family === "NRLW" ? "NRLW_PLUS_WSOO" : "NRL_PLUS_SOO";
            } else {
              competitionSelect.value = family === "NRLW" ? "NRLW" : "NRL";
            }
            syncCompetitionControlsFromSelection();
            syncExportLink();
            syncDataFreshness();
          });
        });
        includePrimaryCompetitionCheckbox?.addEventListener("change", () => {
          updateCompetitionSelectionFromToggles("primary");
        });
        includeRepCompetitionCheckbox?.addEventListener("change", () => {
          updateCompetitionSelectionFromToggles("rep");
        });
        document.querySelectorAll('input[name="metric-mode"]').forEach((input) => {
          input.addEventListener("change", () => {
            invalidateColumnProjectionState();
            syncModeSections();
          });
        });
        document.querySelectorAll('input[name="view-format"]').forEach((input) => {
          input.addEventListener("change", () => {
            invalidateColumnProjectionState();
            syncModeSections();
          });
        });
        document.getElementById("run-query").addEventListener("click", runQuery);
        document.getElementById("reset-query").addEventListener("click", resetForm);
        document.getElementById("download-export").addEventListener("click", () => {
          syncExportLink();
          window.open(exportLink.href, "_blank");
        });
        document.getElementById("add-condition").addEventListener("click", () => {
          conditionGrid.insertAdjacentHTML("beforeend", buildConditionRow("AND"));
          wireConditionButtons();
        });
        const openFullResults = () => {
          window.location.href = "/full-results?" + compactFullResultsParams().toString();
        };
        fullResultsButton?.addEventListener("click", openFullResults);
        exportDatasetSelect.addEventListener("change", syncExportLink);
        exportSeasonFromInput.addEventListener("change", syncExportLink);
        exportSeasonToInput.addEventListener("change", syncExportLink);
        pageSizeSelect.addEventListener("change", () => {
          pageSize = Number(pageSizeSelect.value) || 200;
          currentPage = 1;
          runQuery(false);
        });
        document.getElementById("page-prev").addEventListener("click", () => {
          if (currentPage > 1) {
            currentPage -= 1;
            runQuery(false);
          }
        });
        document.getElementById("page-next").addEventListener("click", () => {
          const pages = serverPaging ? totalPages : Math.max(1, Math.ceil(currentRows.length / pageSize));
          if (currentPage < pages) {
            currentPage += 1;
            runQuery(false);
          }
        });
        await applyQueryFromUrlIfPresent();

        if (bootstrapSlowNoticeTimer) {
          clearTimeout(bootstrapSlowNoticeTimer);
          bootstrapSlowNoticeTimer = null;
        }
      }

      bootstrap().catch((error) => {
        if (bootstrapSlowNoticeTimer) {
          clearTimeout(bootstrapSlowNoticeTimer);
          bootstrapSlowNoticeTimer = null;
        }
        dataFreshnessNote.textContent = "Bootstrap failed: " + (error instanceof Error ? error.message : String(error));
        document.querySelectorAll(".starter-list-target").forEach((container) => {
          container.innerHTML = '<div class="starter-item">Bootstrap failed: ' + error.message + '</div>';
        });
      });
    </script>
  </body>
</html>`;
}

const applicationWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isProxiedPublicBackendRequest = request.headers.get("x-rldb-proxied-by") === "cloudflare-public-site";

    if (
      url.protocol === "http:"
      && !isLoopbackHostname(url.hostname)
      && !isProxiedPublicBackendRequest
      && !isForwardedHttpsRequest(request)
    ) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/api/internal/site-auth-events" && request.method === "POST") {
      if (!env.DB) {
        return json({ ok: false, error: "D1 binding not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      if (!isAuthorizedBackendRequest(request, env) && !isLoopbackHostname(url.hostname)) {
        return json({ ok: false, error: "Unauthorized backend request." }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      const payload = await request.json<Partial<SiteAuthAuditEventPayload>>();
      if (!payload || typeof payload.outcome !== "string" || typeof payload.clientIp !== "string") {
        return json({ ok: false, error: "Invalid auth audit payload." }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      await insertSiteAuthAuditEvent(env.DB, {
        outcome: payload.outcome as SiteAuthAuditOutcome,
        clientIp: String(payload.clientIp ?? "unknown"),
        userAgent: String(payload.userAgent ?? ""),
        country: String(payload.country ?? ""),
        host: String(payload.host ?? ""),
        nextPath: String(payload.nextPath ?? "/"),
        detail: String(payload.detail ?? ""),
      });
      return json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/internal/site-auth-presence" && request.method === "POST") {
      if (!env.DB) {
        return json({ ok: false, error: "D1 binding not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      if (!isAuthorizedBackendRequest(request, env) && !isLoopbackHostname(url.hostname)) {
        return json({ ok: false, error: "Unauthorized backend request." }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      const payload = await request.json<Partial<SiteAuthPresencePayload>>();
      if (!payload || typeof payload.sessionKey !== "string") {
        return json({ ok: false, error: "Invalid auth presence payload." }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      await upsertSiteAuthPresence(env.DB, {
        sessionKey: String(payload.sessionKey ?? ""),
        clientIp: String(payload.clientIp ?? "unknown"),
        userAgent: String(payload.userAgent ?? ""),
        country: String(payload.country ?? ""),
        host: String(payload.host ?? ""),
        path: String(payload.path ?? "/"),
      });
      return json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/admin/auth-attempts" && request.method === "GET") {
      if (!env.DB) {
        return json({ ok: false, error: "D1 binding not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      if (!isAuthorizedBackendRequest(request, env) && !isLoopbackHostname(url.hostname)) {
        return json({ ok: false, error: "Unauthorized backend request." }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const failuresOnly = url.searchParams.get("failuresOnly") !== "0";
      const events = await readSiteAuthAuditEvents(env.DB, limit, failuresOnly);
      return json(
        {
          ok: true,
          failuresOnly,
          count: events.length,
          events,
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    if (url.pathname === "/api/admin/active-users" && request.method === "GET") {
      if (!env.DB) {
        return json({ ok: false, error: "D1 binding not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      if (!isAuthorizedBackendRequest(request, env) && !isLoopbackHostname(url.hostname)) {
        return json({ ok: false, error: "Unauthorized backend request." }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const activeWithinMinutes = Number(url.searchParams.get("activeWithinMinutes") ?? "30");
      const users = await readActiveSiteAuthPresence(env.DB, limit, activeWithinMinutes);
      return json(
        {
          ok: true,
          count: users.length,
          activeWithinMinutes,
          users,
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    if (isSitePasswordProtectionEnabled(env)) {
      if (url.pathname === "/auth/logout") {
        return redirect("/auth/login", { "set-cookie": buildClearSiteSessionCookieHeader() });
      }

      if (url.pathname === "/auth/login" && request.method === "POST") {
        return handleSiteLogin(request, env);
      }

      const hasSession = await hasValidSiteSession(request, env);
      if (!hasSession) {
        return handleUnauthenticatedSiteRequest(request, url, env);
      }

      const presencePayload = await buildSiteAuthPresencePayload(request, env);
      if (presencePayload) {
        await sendSiteAuthPresenceEvent(env, presencePayload);
      }

      if (url.pathname === "/auth/login") {
        return redirect("/");
      }
    }

    const proxiedResponse = await proxyToRemoteBackend(request, url, env);
    if (proxiedResponse) {
      return proxiedResponse;
    }

    if (shouldRequireBackendToken(url, env) && isProxyEligibleRequestPath(url.pathname) && !isAuthorizedBackendRequest(request, env)) {
      return json(
        {
          ok: false,
          error: "Unauthorized backend request.",
        },
        { status: 401, headers: { "cache-control": "no-store" } }
      );
    }

    const maxQueryStringLength = url.pathname === "/full-results" || url.pathname === "/api/query/full"
      ? 16000
      : API_MAX_QUERYSTRING_LENGTH;
    if (url.search.length > maxQueryStringLength) {
      return json(
        {
          ok: false,
          error: `Query string is too large (${url.search.length} characters). The full-results page now uses compact links, so refresh the app and try the button again.`,
        },
        { status: 414, headers: { "cache-control": "no-store" } }
      );
    }
    let databaseStatusPromise: Promise<{ configured: boolean; reachable: boolean; error?: string }> | null = null;
    const getDatabase = () => {
      if (!databaseStatusPromise) {
        databaseStatusPromise = getDatabaseStatus(env);
      }
      return databaseStatusPromise;
    };

    if (url.pathname === "/api/health") {
      const database = await getDatabase();
      return json({
        ok: true,
        service: "rugby-league-stats-database",
        database: {
          configured: database.configured,
          reachable: database.reachable,
        },
        checked_at_utc: new Date().toISOString(),
      }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/meta/bootstrap") {
      const nowMs = Date.now();
      if (bootstrapResponseCache && nowMs - bootstrapResponseCache.cachedAtMs < BOOTSTRAP_CACHE_TTL_MS) {
        const cached = cloneBootstrap(bootstrapResponseCache.value);
        cached.app.status = "seeded-local-db-cached";
        return json(cached, { headers: { "cache-control": "no-store" } });
      }

      const database = await getDatabase();
      let bootstrap = buildBootstrap();
      if (env.DB && database.reachable) {
        try {
          const databaseBootstrap = await getBootstrapFromDatabase(env.DB);
          if (databaseBootstrap) {
            bootstrap = databaseBootstrap;
          }
          bootstrap.app.status = "seeded-local-db";
          bootstrapResponseCache = {
            value: cloneBootstrap(bootstrap),
            cachedAtMs: nowMs,
          };
        } catch {
          if (bootstrapResponseCache) {
            const stale = cloneBootstrap(bootstrapResponseCache.value);
            stale.app.status = "seeded-local-db-stale-cache";
            return json(stale, { headers: { "cache-control": "no-store" } });
          }
          bootstrap.app.status = "bootstrap-fallback";
        }
      } else if (bootstrapResponseCache) {
        const stale = cloneBootstrap(bootstrapResponseCache.value);
        stale.app.status = "seeded-local-db-stale-cache";
        return json(stale, { headers: { "cache-control": "no-store" } });
      } else {
        bootstrap.app.status = "scaffolded";
      }
      return json(bootstrap, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/meta/players") {
      const database = await getDatabase();
      if (!env.DB || !database.reachable) {
        const reason = database.error ? ` (${database.error})` : "";
        return json(
          {
            ok: false,
            error: `D1 database is not reachable${reason}.`,
          },
          { status: 503, headers: { "cache-control": "no-store" } }
        );
      }

      try {
        const players = await getPlayerOptionsFromDatabase(env.DB);
        return json(
          {
            ok: true,
            players,
          },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500, headers: { "cache-control": "no-store" } }
        );
      }
    }

    if (url.pathname === "/api/meta/regression-suite") {
      const visibleCases = REGRESSION_QUERY_SUITE
        .filter((caseItem) => !REGRESSION_EXCLUDED_CASE_IDS.has(caseItem.id))
        .map((caseItem) => ({
          ...caseItem,
          outputTarget: REGRESSION_OUTPUT_TARGETS[caseItem.id] ?? caseItem.outputTarget,
        }));
      const teamPlayedIndex = visibleCases.findIndex((caseItem) => caseItem.id === "wiki-style-team-games-played-all-time");
      if (teamPlayedIndex >= 0 && visibleCases.length >= 18) {
        const [teamPlayedCase] = visibleCases.splice(teamPlayedIndex, 1);
        visibleCases.splice(17, 0, teamPlayedCase);
      }
      return json(
        {
          ok: true,
          generatedAtUtc: new Date().toISOString(),
          snapshotTag: REGRESSION_SNAPSHOT_TAG,
          cases: visibleCases,
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    if (url.pathname === "/api/export") {
      try {
        const database = await getDatabase();
        if (!env.DB || !database.reachable) {
          const reason = database.error ? ` (${database.error})` : "";
          return json(
            {
              ok: false,
              error: `D1 database is not reachable${reason}.`,
            },
            { status: 503, headers: { "cache-control": "no-store" } }
          );
        }

        const format = url.searchParams.get("format") ?? "csv";
        const dataset = url.searchParams.get("dataset") ?? "matches";
        const competition = normalizeCompetition(url.searchParams.get("competition"));
        const seasonFrom = normalizeSeason(Number(url.searchParams.get("seasonFrom") ?? String(MIN_SEASON)), MIN_SEASON);
        const seasonTo = normalizeSeason(Number(url.searchParams.get("seasonTo") ?? String(MAX_SEASON)), MAX_SEASON);

        if (format !== "csv") {
          return json({ ok: false, error: `Unsupported export format '${format}'.` }, { status: 400, headers: { "cache-control": "no-store" } });
        }
        if (!VALID_EXPORT_DATASETS.has(dataset)) {
          return json({ ok: false, error: `Unsupported export dataset '${dataset}'.` }, { status: 400, headers: { "cache-control": "no-store" } });
        }
        if (seasonFrom > seasonTo) {
          return json({ ok: false, error: "seasonFrom cannot be greater than seasonTo." }, { status: 400, headers: { "cache-control": "no-store" } });
        }

        const estimatedRows = await runExportCountQuery(env.DB, dataset, seasonFrom, seasonTo, competition);
        if (estimatedRows > API_MAX_EXPORT_ROWS) {
          return json(
            {
              ok: false,
              error: `Export too large (${estimatedRows} rows). Narrow the season range and try again.`,
            },
            { status: 413, headers: { "cache-control": "no-store" } }
          );
        }

        const exportPayload = await runExportQuery(env.DB, dataset, seasonFrom, seasonTo, competition);
        return csvResponse(
          exportPayload.filename,
          exportPayload.columns,
          exportPayload.rows,
          "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500, headers: { "cache-control": "no-store" } }
        );
      }
    }

    if (url.pathname === "/api/query") {
      try {
        const database = await getDatabase();
        if (!env.DB || !database.reachable) {
          const reason = database.error ? ` (${database.error})` : "";
          return json(
            {
              ok: false,
              error: `D1 database is not reachable${reason}.`,
            },
            { status: 503, headers: { "cache-control": "no-store" } }
          );
        }

        const scope = url.searchParams.get("scope") ?? "player";
        const statKey = url.searchParams.get("statKey") ?? "tries";
        const mode = url.searchParams.get("mode") ?? "totals";
        const format = url.searchParams.get("format") ?? "overall";
        const allowMultipleStreaks = url.searchParams.get("allowMultipleStreaks") === "1";
        const singleEntityResults = url.searchParams.get("singleEntityResults") !== "0";
        const excludeSparseHistoricalStreaks = url.searchParams.get("excludeSparseHistoricalStreaks") !== "0";
        const requestedLimit = normalizeLimit(Number(url.searchParams.get("limit") ?? String(API_DEFAULT_LIMIT)));
        const seasonFrom = normalizeSeason(Number(url.searchParams.get("seasonFrom") ?? "1998"), 1998);
        const seasonTo = normalizeSeason(Number(url.searchParams.get("seasonTo") ?? String(MAX_SEASON)), MAX_SEASON);
        let conditions: unknown = [];
        try {
          conditions = JSON.parse(url.searchParams.get("conditions") ?? "[]");
        } catch {
          conditions = [];
        }
        if (!VALID_SCOPES.has(scope)) {
          return json({ ok: false, error: `Unsupported scope '${scope}'.` }, { status: 400, headers: { "cache-control": "no-store" } });
        }
        if (!VALID_MODES.has(mode)) {
          return json({ ok: false, error: `Unsupported mode '${mode}'.` }, { status: 400, headers: { "cache-control": "no-store" } });
        }
        if (!VALID_FORMATS.has(format)) {
          return json({ ok: false, error: `Unsupported format '${format}'.` }, { status: 400, headers: { "cache-control": "no-store" } });
        }
        if (seasonFrom > seasonTo) {
          return json({ ok: false, error: "seasonFrom cannot be greater than seasonTo." }, { status: 400, headers: { "cache-control": "no-store" } });
        }
        const normalizedRounds = normalizeRoundBounds(
          normalizeOptionalBound(url.searchParams.get("roundFrom"), null),
          normalizeOptionalBound(url.searchParams.get("roundTo"), null)
        );
        const filters: QueryFilters = {
          competition: normalizeCompetitionCode(url.searchParams.get("competition")),
          team: url.searchParams.get("team") ?? "Any",
          opponent: url.searchParams.get("opponent") ?? "Any",
          venue: url.searchParams.get("venue") ?? "Any",
          referee: url.searchParams.get("referee") ?? "Any",
          position: url.searchParams.get("position") ?? "Any",
          player: url.searchParams.get("player") ?? "Any",
          playerType: normalizePlayerType(url.searchParams.get("playerType")),
          matchPlayer: url.searchParams.get("matchPlayer") ?? "Any",
          debut: normalizeAnyStyleValue(url.searchParams.get("debut")),
          groundCondition: url.searchParams.get("groundCondition") ?? "Any",
          weatherCondition: url.searchParams.get("weatherCondition") ?? "Any",
          homeAway: normalizeAnyStyleValue(url.searchParams.get("homeAway")),
          result: normalizeAnyStyleValue(url.searchParams.get("result")),
          scoreHalf: normalizeScoreHalf(url.searchParams.get("scoreHalf")),
          excludeSparseHistoricalStreaks,
          excludeZeroMinuteStreakGames: url.searchParams.get("excludeZeroMinuteStreakGames") !== "0",
          roundFrom: normalizedRounds.roundFrom,
          roundTo: normalizedRounds.roundTo,
          includeRegular: url.searchParams.get("includeRegular") !== "0",
          includeFinals: url.searchParams.get("includeFinals") !== "0",
          includeGrandFinal: url.searchParams.get("includeGrandFinal") !== "0",
          conditions: normalizeConditions(conditions),
        };
        const queryLimit = singleEntityResults && format !== "overall" && mode !== "streaks" && filters.conditions.length > 0
          ? Math.min(50000, Math.max(requestedLimit * 50, 5000))
          : requestedLimit;
        const payload = await runLeaderboardQuery(
          env.DB,
          scope,
          statKey,
          queryLimit,
          mode,
          format,
          allowMultipleStreaks,
          seasonFrom,
          seasonTo,
          filters,
          singleEntityResults
        );
        const collapsedRows = payload.ok && mode !== "streaks" && singleEntityResults && (scope === "player" || scope === "team")
          ? collapseToSingleResultPerEntity(payload.rows, scope as "player" | "team", format, "stat_total", "desc").slice(0, requestedLimit)
          : payload.rows;
        const responsePayload = payload.ok
          ? { ...payload, rows: collapsedRows }
          : payload;
        return json(responsePayload, {
          status: responsePayload.ok ? 200 : 501,
          headers: {
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500, headers: { "cache-control": "no-store" } }
        );
      }
    }

    if (url.pathname === "/api/query/full") {
      try {
        const database = await getDatabase();
        if (!env.DB || !database.reachable) {
          const reason = database.error ? ` (${database.error})` : "";
          return json(
            {
              ok: false,
              error: `D1 database is not reachable${reason}.`,
            },
            { status: 503, headers: { "cache-control": "no-store" } }
          );
        }

        const scope = url.searchParams.get("scope") ?? "player";
        const seasonFrom = normalizeSeason(Number(url.searchParams.get("seasonFrom") ?? String(MIN_SEASON)), MIN_SEASON);
        const seasonTo = normalizeSeason(Number(url.searchParams.get("seasonTo") ?? String(MAX_SEASON)), MAX_SEASON);
        let conditions: unknown = [];
        try {
          conditions = JSON.parse(url.searchParams.get("conditions") ?? "[]");
        } catch {
          conditions = [];
        }
        const normalizedRounds = normalizeRoundBounds(
          normalizeOptionalBound(url.searchParams.get("roundFrom"), null),
          normalizeOptionalBound(url.searchParams.get("roundTo"), null)
        );
        const filters: QueryFilters = {
          competition: normalizeCompetitionCode(url.searchParams.get("competition")),
          team: url.searchParams.get("team") ?? "Any",
          opponent: url.searchParams.get("opponent") ?? "Any",
          venue: url.searchParams.get("venue") ?? "Any",
          referee: url.searchParams.get("referee") ?? "Any",
          position: url.searchParams.get("position") ?? "Any",
          player: url.searchParams.get("player") ?? "Any",
          playerType: normalizePlayerType(url.searchParams.get("playerType")),
          matchPlayer: url.searchParams.get("matchPlayer") ?? "Any",
          debut: normalizeAnyStyleValue(url.searchParams.get("debut")),
          groundCondition: url.searchParams.get("groundCondition") ?? "Any",
          weatherCondition: url.searchParams.get("weatherCondition") ?? "Any",
          homeAway: normalizeAnyStyleValue(url.searchParams.get("homeAway")),
          result: normalizeAnyStyleValue(url.searchParams.get("result")),
          scoreHalf: normalizeScoreHalf(url.searchParams.get("scoreHalf")),
          excludeSparseHistoricalStreaks: url.searchParams.get("excludeSparseHistoricalStreaks") !== "0",
          excludeZeroMinuteStreakGames: url.searchParams.get("excludeZeroMinuteStreakGames") !== "0",
          roundFrom: normalizedRounds.roundFrom,
          roundTo: normalizedRounds.roundTo,
          includeRegular: url.searchParams.get("includeRegular") !== "0",
          includeFinals: url.searchParams.get("includeFinals") !== "0",
          includeGrandFinal: url.searchParams.get("includeGrandFinal") !== "0",
          conditions: normalizeConditions(conditions),
        };
        const mode = VALID_MODES.has(url.searchParams.get("mode") ?? "") ? (url.searchParams.get("mode") as "totals" | "averages" | "streaks") : "totals";
        const format = VALID_FORMATS.has(url.searchParams.get("format") ?? "") ? (url.searchParams.get("format") ?? "overall") : "overall";
        const scoreHalf = normalizeScoreHalf(url.searchParams.get("scoreHalf"));
        const selectedStatKey = url.searchParams.get("statKey") ?? (scope === "team" ? "wins" : "tries");
        const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
        const pageSize = Math.min(500, Math.max(50, Number(url.searchParams.get("pageSize") ?? "200") || 200));
        const bootstrapDefinitions = buildBootstrap().statDefinitions;
        const fullResultsDefinitions = bootstrapDefinitions.filter((definition) => {
          if (definition.scope !== scope) return false;
          return supportsFullResultsMode(definition, mode);
        });
        const allStatDefinitions = fullResultsDefinitions.filter((definition) => {
          if (definition.scope !== scope) return false;
          if (isUiHiddenStat(definition.statKey)) return false;
          return supportsFullResultsMode(definition, mode);
        });
        const baseColumns = fullResultsBaseColumns(scope as "player" | "team", format, mode);
        const allStatColumns = allStatDefinitions.map((definition) => definition.statKey);
        const allAvailableColumns = [...new Set([...baseColumns, ...allStatColumns])]
          .filter((column) => column !== "match_id" && column !== "match_sort_key");
        const requestedColumns = (url.searchParams.get("columns") ?? "")
          .split(",")
          .map((column) => column.trim())
          .filter((column) => allAvailableColumns.includes(column));
        const fallbackColumns = [...new Set([...baseColumns, selectedStatKey])]
          .filter((column) => allAvailableColumns.includes(column));
        const responseColumns = (requestedColumns.length ? requestedColumns : fallbackColumns).length
          ? [...new Set(requestedColumns.length ? requestedColumns : fallbackColumns)]
          : allAvailableColumns.slice(0, Math.max(baseColumns.length, 1));
        const defaultSortColumn = mode === "streaks"
          ? "streak"
          : (responseColumns.includes("stat_total") ? "stat_total" : responseColumns[0]);
        const requestedSortColumn = url.searchParams.get("sortColumn") || defaultSortColumn;
        const displaySortColumn = allAvailableColumns.includes(requestedSortColumn) || requestedSortColumn === "streak"
          ? requestedSortColumn
          : defaultSortColumn;
        const sortColumn = displaySortColumn === "match_reference" && format === "match"
          ? "match_sort_key"
          : displaySortColumn;
        const sortDirection = url.searchParams.get("sortDirection") === "asc" ? "asc" : "desc";
        const singleEntityResults = url.searchParams.get("singleEntityResults") !== "0";
        const shouldCollapseByEntity = singleEntityResults && mode !== "streaks" && format !== "overall" && format !== "match";
        const neededStatKeys = statKeysNeededForFullResults(
          fullResultsDefinitions,
          responseColumns,
          selectedStatKey,
          sortColumn,
          filters.conditions
        );
        const statDefinitions = fullResultsDefinitions.filter((definition) => neededStatKeys.has(definition.statKey));
        if (mode === "streaks") {
          const streakLimit = Math.min(5000, Math.max(page * pageSize, pageSize));
          const streakPayload = await runLeaderboardQuery(
            env.DB,
            scope,
            selectedStatKey,
            streakLimit,
            mode,
            format,
            true,
            seasonFrom,
            seasonTo,
            filters,
            false
          );
          if (!streakPayload.ok) {
            return json(streakPayload, { status: 501, headers: { "cache-control": "no-store" } });
          }
          const sortedRows = streakPayload.rows.slice().sort((left, right) => {
            const result = fullResultsCompareValues(left[sortColumn], right[sortColumn]);
            return sortDirection === "asc" ? result : -result;
          });
          const totalRows = sortedRows.length;
          const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
          const safePage = Math.min(page, totalPages);
          const pagedRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);
          const requestedStreakColumns = responseColumns.filter((column) => streakPayload.columns.includes(column));
          const streakEntityColumn = scope === "player" ? "player" : "team";
          const mandatoryStreakColumns = [streakEntityColumn, "streak", "first_game", "last_game"]
            .filter((column) => streakPayload.columns.includes(column));
          const desiredStreakColumns = requestedStreakColumns.length
            ? [...requestedStreakColumns, ...mandatoryStreakColumns]
            : streakPayload.columns.slice();
          const desiredStreakColumnSet = new Set(desiredStreakColumns);
          const streakColumns = streakPayload.columns.filter((column) => desiredStreakColumnSet.has(column));

          return json(
            {
              ok: true,
              summary: `${streakPayload.summary} Showing streak rows via the leaderboard query path.`,
              rows: trimRowsToColumns(pagedRows, streakColumns),
              columns: streakColumns,
              allColumns: streakPayload.columns,
              page: safePage,
              pageSize,
              totalRows,
              totalPages,
              sortColumn: displaySortColumn,
              sortDirection,
            },
            { headers: { "cache-control": "no-store" } }
          );
        }
        if (scope === "team" && mode !== "streaks" && selectedStatKey === "margin" && normalizeScoreHalf(filters.scoreHalf) === "all") {
          const marginFullLimit = Math.min(50000, Math.max(page * pageSize * 4, 5000));
          const marginPayload = await runLeaderboardQuery(
            env.DB,
            scope,
            selectedStatKey,
            marginFullLimit,
            mode,
            format,
            false,
            seasonFrom,
            seasonTo,
            filters,
            false
          );
          if (!marginPayload.ok) {
            return json(marginPayload, { status: 501, headers: { "cache-control": "no-store" } });
          }
          const marginColumns = marginPayload.columns.slice();
          const safeMarginSortColumn = marginColumns.includes(displaySortColumn)
            ? displaySortColumn
            : (marginColumns.includes("margin") ? "margin" : marginColumns[0]);
          const sortedRows = marginPayload.rows.slice().sort((left, right) => {
            const result = fullResultsCompareValues(left[safeMarginSortColumn], right[safeMarginSortColumn]);
            return sortDirection === "asc" ? result : -result;
          });
          const totalRows = sortedRows.length;
          const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
          const safePage = Math.min(page, totalPages);
          const pagedRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);
          return json(
            {
              ok: true,
              summary: `${marginPayload.summary} Full-results served via leaderboard-backed margin route.`,
              rows: trimRowsToColumns(pagedRows, marginColumns),
              columns: marginColumns,
              allColumns: marginColumns,
              page: safePage,
              pageSize,
              totalRows,
              totalPages,
              sortColumn: safeMarginSortColumn,
              sortDirection,
            },
            { headers: { "cache-control": "no-store" } }
          );
        }
        if (scope === "team" && mode !== "streaks" && selectedStatKey !== "margin" && format !== "match") {
          const teamFullLimit = Math.min(50000, Math.max(page * pageSize * 4, 5000));
          const teamPayload = await runLeaderboardQuery(
            env.DB,
            scope,
            selectedStatKey,
            teamFullLimit,
            mode,
            format,
            false,
            seasonFrom,
            seasonTo,
            filters,
            false
          );
          if (!teamPayload.ok) {
            return json(teamPayload, { status: 501, headers: { "cache-control": "no-store" } });
          }
          const sortedRows = teamPayload.rows.slice().sort((left, right) => {
            const result = fullResultsCompareValues(left[sortColumn], right[sortColumn]);
            return sortDirection === "asc" ? result : -result;
          });
          const collapsedRows = shouldCollapseByEntity
            ? collapseToSingleResultPerEntity(sortedRows, scope as "player" | "team", format, sortColumn, sortDirection)
            : sortedRows;
          const totalRows = collapsedRows.length;
          const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
          const safePage = Math.min(page, totalPages);
          const pagedRows = collapsedRows.slice((safePage - 1) * pageSize, safePage * pageSize);
          const collapseSuffix = shouldCollapseByEntity ? " Collapsed to one row per entity group." : "";
          return json(
            {
              ok: true,
              summary: `${teamPayload.summary} Full-results served via stable leaderboard-backed team route.${collapseSuffix}`,
              rows: trimRowsToColumns(pagedRows, responseColumns),
              columns: responseColumns,
              allColumns: allAvailableColumns,
              page: safePage,
              pageSize,
              totalRows,
              totalPages,
              sortColumn: displaySortColumn,
              sortDirection,
            },
            { headers: { "cache-control": "no-store" } }
          );
        }
        const aggregatePayload = scope === "player" && !shouldCollapseByEntity
          ? await runFullResultsPlayerAggregateFastPath(
              env.DB,
              seasonFrom,
              seasonTo,
              filters,
              statDefinitions,
              mode,
              format,
              selectedStatKey,
              pageSize,
              (page - 1) * pageSize,
              sortColumn,
              sortDirection
            )
          : null;
        if (aggregatePayload) {
          const sqlPaged = aggregatePayload.totalRows !== undefined && filters.conditions.length === 0;
          const sortedRows = sqlPaged
            ? aggregatePayload.rows
            : aggregatePayload.rows.slice().sort((left, right) => {
                const result = fullResultsCompareValues(left[sortColumn], right[sortColumn]);
                return sortDirection === "asc" ? result : -result;
              });
          const totalRows = aggregatePayload.totalRows ?? sortedRows.length;
          const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
          const safePage = Math.min(page, totalPages);
          const pagedRows = sqlPaged
            ? sortedRows
            : sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);

          return json(
            {
              ok: true,
              summary: aggregatePayload.summary,
              rows: trimRowsToColumns(pagedRows, responseColumns),
              columns: responseColumns,
              allColumns: allAvailableColumns,
              page: safePage,
              pageSize,
              totalRows,
              totalPages,
              sortColumn: displaySortColumn,
              sortDirection,
            },
            { headers: { "cache-control": "no-store" } }
          );
        }
        const matchAggregatePagedPayload = !shouldCollapseByEntity
          ? (scope === "player"
          ? await runFullResultsPlayerMatchAggregatePagedPath(
              env.DB,
              seasonFrom,
              seasonTo,
              filters,
              statDefinitions,
              mode,
              format,
              selectedStatKey,
              pageSize,
              (page - 1) * pageSize,
              sortColumn,
              sortDirection
            )
          : await runFullResultsTeamMatchAggregatePagedPath(
              env.DB,
              seasonFrom,
              seasonTo,
              filters,
              statDefinitions,
              mode,
              format,
              selectedStatKey,
              pageSize,
              (page - 1) * pageSize,
              sortColumn,
              sortDirection
            ))
          : null;
        if (matchAggregatePagedPayload) {
          const totalRows = matchAggregatePagedPayload.totalRows;
          const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
          const safePage = Math.min(page, totalPages);
          const rows = safePage === page
            ? matchAggregatePagedPayload.rows
            : await (async () => {
                const repaged = scope === "player"
                  ? await runFullResultsPlayerMatchAggregatePagedPath(
                      env.DB!,
                      seasonFrom,
                      seasonTo,
                      filters,
                      statDefinitions,
                      mode,
                      format,
                      selectedStatKey,
                      pageSize,
                      (safePage - 1) * pageSize,
                      sortColumn,
                      sortDirection
                    )
                  : await runFullResultsTeamMatchAggregatePagedPath(
                      env.DB!,
                      seasonFrom,
                      seasonTo,
                      filters,
                      statDefinitions,
                      mode,
                      format,
                      selectedStatKey,
                      pageSize,
                      (safePage - 1) * pageSize,
                      sortColumn,
                      sortDirection
                    );
                return repaged?.rows ?? [];
              })();
          return json(
            {
              ok: true,
              summary: matchAggregatePagedPayload.summary,
              rows: trimRowsToColumns(rows, responseColumns),
              columns: responseColumns,
              allColumns: allAvailableColumns,
              page: safePage,
              pageSize,
              totalRows,
              totalPages,
              sortColumn: displaySortColumn,
              sortDirection,
            },
            { headers: { "cache-control": "no-store" } }
          );
        }
        const conditionCandidateLimit = Math.min(50000, Math.max(page * pageSize * 20, 5000));
        const matchAggregateConditionPayload = (mode !== "streaks" && (filters.conditions.length > 0 || shouldCollapseByEntity))
          ? (scope === "player"
              ? await runFullResultsPlayerMatchAggregatePagedPath(
                  env.DB,
                  seasonFrom,
                  seasonTo,
                  filters,
                  statDefinitions,
                  mode,
                  format,
                  selectedStatKey,
                  conditionCandidateLimit,
                  0,
                  sortColumn,
                  sortDirection,
                  true
                )
              : await runFullResultsTeamMatchAggregatePagedPath(
                  env.DB,
                  seasonFrom,
                  seasonTo,
                  filters,
                  statDefinitions,
                  mode,
                  format,
                  selectedStatKey,
                  conditionCandidateLimit,
                  0,
                  sortColumn,
                  sortDirection,
                  true
                ))
          : null;
        if (matchAggregateConditionPayload) {
          const filteredRows = filters.conditions.length
            ? matchAggregateConditionPayload.rows.filter((row) => fullResultsMatchesConditions(row, filters.conditions, selectedStatKey, scoreHalf))
            : matchAggregateConditionPayload.rows.slice();
          const sortedRows = filteredRows.slice().sort((left, right) => {
            const result = fullResultsCompareValues(left[sortColumn], right[sortColumn]);
            return sortDirection === "asc" ? result : -result;
          });
          const collapsedRows = shouldCollapseByEntity
            ? collapseToSingleResultPerEntity(sortedRows, scope as "player" | "team", format, sortColumn, sortDirection)
            : sortedRows;
          const totalRows = collapsedRows.length;
          const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
          const safePage = Math.min(page, totalPages);
          const pagedRows = collapsedRows.slice((safePage - 1) * pageSize, safePage * pageSize);
          const collapseSuffix = shouldCollapseByEntity ? " Collapsed to one row per entity group." : "";

          return json(
            {
              ok: true,
              summary: `${matchAggregateConditionPayload.summary} Applied condition filters in unified full-results aggregate route.${collapseSuffix}`,
              rows: trimRowsToColumns(pagedRows, responseColumns),
              columns: responseColumns,
              allColumns: allAvailableColumns,
              page: safePage,
              pageSize,
              totalRows,
              totalPages,
              sortColumn: displaySortColumn,
              sortDirection,
            },
            { headers: { "cache-control": "no-store" } }
          );
        }
        const rawPayload = await runFullResultsRawQuery(env.DB, scope, seasonFrom, seasonTo, filters);
        if (!rawPayload.ok) {
          return json(rawPayload, { status: 501, headers: { "cache-control": "no-store" } });
        }

        const rows = aggregateFullResultsRows(rawPayload.rows, statDefinitions, {
          scope: scope as "player" | "team",
          format,
          mode,
          selectedStatKey,
          scoreHalf,
          conditions: filters.conditions,
        });
        const sortedRows = rows.slice().sort((left, right) => {
          const result = fullResultsCompareValues(left[sortColumn], right[sortColumn]);
          return sortDirection === "asc" ? result : -result;
        });
        const collapsedRows = shouldCollapseByEntity
          ? collapseToSingleResultPerEntity(sortedRows, scope as "player" | "team", format, sortColumn, sortDirection)
          : sortedRows;
        const totalRows = collapsedRows.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
        const safePage = Math.min(page, totalPages);
        const pagedRows = collapsedRows.slice((safePage - 1) * pageSize, safePage * pageSize);
        const collapseSuffix = shouldCollapseByEntity ? " Collapsed to one row per entity group." : "";

        return json(
          {
            ok: true,
            summary: `${rawPayload.summary} Aggregated into ${rows.length} ${format} row${rows.length === 1 ? "" : "s"} for full-results.${collapseSuffix}`,
            rows: trimRowsToColumns(pagedRows, responseColumns),
            columns: responseColumns,
            allColumns: allAvailableColumns,
            totalRows,
            page: safePage,
            pageSize,
            totalPages,
            sortColumn: displaySortColumn,
            sortDirection,
          },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500, headers: { "cache-control": "no-store" } }
        );
      }
    }

    if (url.pathname === "/api/player-profile") {
      const database = await getDatabase();
      if (!env.DB || !database.reachable) {
        const reason = database.error ? ` (${database.error})` : "";
        return json({ ok: false, error: `D1 database is not reachable${reason}.` }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      const playerName = String(url.searchParams.get("player") ?? "").trim();
      const competition = normalizeCompetitionCode(url.searchParams.get("competition") ?? "NRL");
      if (!playerName) {
        return json({ ok: false, error: "Missing player parameter." }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const payload = await loadPlayerPageData(env.DB, playerName, competition);
      if (!payload) {
        return json({ ok: false, error: "Player not found." }, { status: 404, headers: { "cache-control": "no-store" } });
      }
      return json({ ok: true, ...payload }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/player-rank-cards") {
      const database = await getDatabase();
      if (!env.DB || !database.reachable) {
        const reason = database.error ? ` (${database.error})` : "";
        return json({ ok: false, error: `D1 database is not reachable${reason}.` }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      const playerName = String(url.searchParams.get("player") ?? "").trim();
      const competition = normalizeCompetitionCode(url.searchParams.get("competition") ?? "NRL");
      if (!playerName) {
        return json({ ok: false, error: "Missing player parameter." }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const cards = await loadPlayerRankingCards(env.DB, playerName, competition);
      return json({ ok: true, cards }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/match-detail") {
      const database = await getDatabase();
      if (!env.DB || !database.reachable) {
        const reason = database.error ? ` (${database.error})` : "";
        return json({ ok: false, error: `D1 database is not reachable${reason}.` }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      const matchId = Number(url.searchParams.get("matchId") ?? "0");
      if (!Number.isFinite(matchId) || matchId <= 0) {
        return json({ ok: false, error: "Missing or invalid matchId parameter." }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const payload = await loadMatchPageData(env.DB, matchId);
      if (!payload.match) {
        return json({ ok: false, error: "Match not found." }, { status: 404, headers: { "cache-control": "no-store" } });
      }
      return json({ ok: true, ...payload }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/season-index") {
      const database = await getDatabase();
      if (!env.DB || !database.reachable) {
        const reason = database.error ? ` (${database.error})` : "";
        return json({ ok: false, error: `D1 database is not reachable${reason}.` }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      const competition = normalizeCompetitionCode(url.searchParams.get("competition") ?? "NRL");
      const season = normalizeSeason(Number(url.searchParams.get("season") ?? String(MAX_SEASON)), MIN_SEASON);
      const payload = await loadSeasonIndexData(env.DB, competition, season);
      if (!payload) {
        return json({ ok: false, error: "Season not found." }, { status: 404, headers: { "cache-control": "no-store" } });
      }
      return json({ ok: true, ...payload }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return new Response(buildFaviconSvg(), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app-fixed") {
      return html(renderAppShell());
    }

    if (url.pathname === "/regression") {
      return html(renderRegressionPage());
    }

    if (url.pathname === "/full-results") {
      return html(renderFullResultsPage());
    }

    if (url.pathname === "/season") {
      return html(renderSeasonPageShell());
    }

    const playerPage = url.pathname.match(/^\/player\/([^/]+)$/);
    if (playerPage) {
      const playerName = decodeURIComponent(playerPage[1]);
      return html(renderPlayerPageShellV2(playerName));
    }

    const matchPage = url.pathname.match(/^\/match\/(\d+)$/);
    if (matchPage) {
      return html(renderMatchPageShell(Number(matchPage[1])));
    }

    return html("<h1>Not Found</h1>", 404);
  },
};

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return handleWithQueryTelemetry(
      request,
      env,
      context,
      (instrumentedRequest, instrumentedEnv) =>
        applicationWorker.fetch(instrumentedRequest, instrumentedEnv as Env)
    );
  },
};
