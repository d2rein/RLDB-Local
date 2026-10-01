type WargRow = Record<string, unknown>;

const ROLES = ["Back", "Half", "Hooker", "Forward", "Interchange"];

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

async function rows(statement: D1PreparedStatement): Promise<WargRow[]> {
  const result = await statement.all<WargRow>();
  return result.results ?? [];
}

function seasonClause(season: number | null, column = "season"): { sql: string; binds: number[] } {
  return season === null ? { sql: "", binds: [] } : { sql: `WHERE ${column}=?`, binds: [season] };
}

async function metadata(db: D1Database): Promise<Record<string, string>> {
  const values = await rows(db.prepare("SELECT metadata_key,metadata_value FROM warg_metadata"));
  return Object.fromEntries(values.map((row) => [String(row.metadata_key), String(row.metadata_value)]));
}

async function dashboard(db: D1Database, season: number | null): Promise<Record<string, unknown>> {
  const filter = seasonClause(season);
  const games = await rows(db.prepare(`
    SELECT season,match_id,round_label,player_id,player_name,team_name,opponent_name,
           score,position,role,game_warg AS warg
    FROM warg_match_ratings ${filter.sql}
    ORDER BY game_warg DESC,match_date_utc DESC,player_name LIMIT 10
  `).bind(...filter.binds));
  const seasons = await rows(db.prepare(`
    SELECT season,player_id,player_name,position,role,games,warg
    FROM warg_season_ratings ${filter.sql}
    ORDER BY warg DESC,player_name LIMIT 10
  `).bind(...filter.binds));
  const careers = season === null ? await rows(db.prepare(`
    SELECT player_id,player_name,primary_position AS position,primary_role AS role,
           seasons,games,career_warg AS warg
    FROM warg_career_ratings ORDER BY career_warg DESC,player_name LIMIT 10
  `)) : [];
  const clubFilter = season === null ? "" : "WHERE season=?";
  const clubs = await rows(db.prepare(`
    WITH totals AS (
      SELECT team_id,team_name,player_id,player_name,SUM(game_warg) warg,COUNT(*) games
      FROM warg_match_ratings ${clubFilter}
      GROUP BY team_id,team_name,player_id,player_name
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY warg DESC,player_name) club_rank
      FROM totals
    )
    SELECT team_id,team_name,player_id,player_name,games,warg
    FROM ranked WHERE club_rank=1 ORDER BY warg DESC,team_name LIMIT 40
  `).bind(...(season === null ? [] : [season])));
  const roleRows: Record<string, WargRow[]> = {};
  for (const role of ROLES) {
    if (season === null) {
      roleRows[role] = await rows(db.prepare(`
        SELECT player_id,player_name,primary_position AS position,games,career_warg AS warg
        FROM warg_career_ratings WHERE primary_role=?
        ORDER BY career_warg DESC,player_name LIMIT 10
      `).bind(role));
    } else {
      roleRows[role] = await rows(db.prepare(`
        SELECT season,player_id,player_name,position,games,warg
        FROM warg_season_ratings WHERE season=? AND role=?
        ORDER BY warg DESC,player_name LIMIT 10
      `).bind(season, role));
    }
  }
  return { games, seasons, careers, clubs, roles: roleRows };
}

async function fullList(db: D1Database, url: URL): Promise<Record<string, unknown>> {
  const view = String(url.searchParams.get("view") ?? "careers");
  const seasonValue = Number(url.searchParams.get("season") ?? "0");
  const season = Number.isInteger(seasonValue) && seasonValue >= 2001 ? seasonValue : null;
  const role = ROLES.includes(String(url.searchParams.get("role"))) ? String(url.searchParams.get("role")) : "";
  const limit = Math.min(250, Math.max(10, Number(url.searchParams.get("limit") ?? "100") || 100));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const offset = (page - 1) * limit;
  let sql = "";
  let countSql = "";
  let binds: unknown[] = [];
  if (view === "games") {
    const filter = seasonClause(season);
    sql = `SELECT season,match_id,round_label,player_id,player_name,team_name,opponent_name,score,position,role,game_warg AS warg FROM warg_match_ratings ${filter.sql} ORDER BY game_warg DESC,match_date_utc DESC,player_name LIMIT ? OFFSET ?`;
    countSql = `SELECT COUNT(*) count FROM warg_match_ratings ${filter.sql}`;
    binds = filter.binds;
  } else if (view === "seasons" || season !== null) {
    const clauses = [season !== null ? "season=?" : "", role ? "role=?" : ""].filter(Boolean);
    binds = [season, role].filter((value) => value !== null && value !== "");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    sql = `SELECT season,player_id,player_name,position,role,games,warg FROM warg_season_ratings ${where} ORDER BY warg DESC,player_name LIMIT ? OFFSET ?`;
    countSql = `SELECT COUNT(*) count FROM warg_season_ratings ${where}`;
  } else if (view === "clubs") {
    sql = `WITH totals AS (SELECT team_id,team_name,player_id,player_name,SUM(game_warg) warg,COUNT(*) games FROM warg_match_ratings GROUP BY team_id,team_name,player_id,player_name), ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY warg DESC,player_name) club_rank FROM totals) SELECT team_id,team_name,player_id,player_name,games,warg FROM ranked WHERE club_rank=1 ORDER BY warg DESC,team_name LIMIT ? OFFSET ?`;
    countSql = `SELECT COUNT(DISTINCT team_id) count FROM warg_match_ratings`;
  } else {
    const where = role ? "WHERE primary_role=?" : "";
    binds = role ? [role] : [];
    sql = `SELECT player_id,player_name,primary_position AS position,primary_role AS role,seasons,games,career_warg AS warg FROM warg_career_ratings ${where} ORDER BY career_warg DESC,player_name LIMIT ? OFFSET ?`;
    countSql = `SELECT COUNT(*) count FROM warg_career_ratings ${where}`;
  }
  const resultRows = await rows(db.prepare(sql).bind(...binds, limit, offset));
  const count = await db.prepare(countSql).bind(...binds).first<{ count: number }>();
  return { view, season, role, page, pageSize: limit, totalRows: Number(count?.count ?? 0), rows: resultRows };
}

export async function handleWargApi(db: D1Database | undefined, url: URL): Promise<Response> {
  if (!db) return response({ ok: false, error: "Database unavailable." }, 503);
  try {
    const mode = String(url.searchParams.get("mode") ?? "dashboard");
    const seasonValue = Number(url.searchParams.get("season") ?? "0");
    const season = Number.isInteger(seasonValue) && seasonValue >= 2001 ? seasonValue : null;
    const meta = await metadata(db);
    if (!meta.generated_at_utc) return response({ ok: false, error: "WARG ratings have not been materialised." }, 503);
    const years = await rows(db.prepare("SELECT DISTINCT season FROM warg_season_ratings ORDER BY season DESC"));
    const data = mode === "list" ? await fullList(db, url) : await dashboard(db, season);
    return response({ ok: true, methodology: "WARG-style Taylor reproduction v0.1; not official Maroon Observer WARG", metadata: meta, years: years.map((row) => Number(row.season)), ...data });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

export function renderWargPage(fullList = false): string {
  const initialMode = fullList ? "list" : "dashboard";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RLDB - WARG-style player ratings</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#ece7d9;--panel:#f8f3e7;--line:#cdbf9e;--line2:#b39f77;--text:#1f1d19;--muted:#6e6552;--green:#1e5631;--gold:#b48a3a;--shadow:0 8px 24px rgba(65,49,22,.08)}
*{box-sizing:border-box}body{margin:0;color:var(--text);font-family:Arial,Helvetica,sans-serif;background:linear-gradient(rgba(255,255,255,.14),rgba(255,255,255,.14)),repeating-linear-gradient(0deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),repeating-linear-gradient(90deg,rgba(84,74,44,.03) 0 1px,transparent 1px 34px),var(--bg)}
a{color:#0048c9;text-decoration:underline;text-underline-offset:2px}.shell{max-width:1540px;margin:auto;padding:16px}.masthead,.card{background:rgba(248,243,231,.95);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.masthead{padding:18px 20px;margin-bottom:14px}.head{display:flex;justify-content:space-between;gap:18px;align-items:flex-end;flex-wrap:wrap}.brand h1{margin:0 0 4px;font-size:2rem}.brand p{margin:0;color:var(--muted)}.controls{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.label{display:grid;gap:5px;font-size:.76rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}select,.btn{border:1px solid var(--line2);border-radius:9px;background:#fbf6eb;color:var(--text);padding:8px 10px;font-weight:700}.btn{text-decoration:none;display:inline-block}.note{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.card{overflow:hidden}.card-head{padding:11px 13px;background:linear-gradient(180deg,#f5eddc,#eee2cb);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}.card-head h2{margin:0;font-size:1rem}.card-head a{font-size:.8rem}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{padding:6px 8px;border-bottom:1px solid #ddd2ba;text-align:left;white-space:nowrap}th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}td.rank{width:32px;text-align:right;color:var(--muted)}td.value{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}.wide{grid-column:span 2}.full{grid-column:1/-1}.status{padding:24px;color:var(--muted)}.pager{display:flex;gap:8px;align-items:center;padding:10px 13px;border-top:1px solid var(--line)}
@media(max-width:1050px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:680px){.shell{padding:8px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.masthead,.card{border-radius:12px}.brand h1{font-size:1.55rem}th,td{padding:6px}}
</style></head><body><main class="shell"><header class="masthead"><div class="head"><div class="brand"><h1>WARG-style player ratings</h1><p>RLDB player production above a position-adjusted replacement level.</p></div><div class="controls"><label class="label">Season<select id="season"><option value="all">All years</option></select></label><a class="btn" href="/">RLDB home</a></div></div><p class="note" id="note">Independent reproduction of the published Taylor/WARG method, not official Maroon Observer WARG. Regular-season NRL matches only.</p></header><section id="content" class="grid"><div class="card full status">Loading ratings...</div></section></main>
<script>
const mode=${JSON.stringify(initialMode)}, content=document.getElementById('content'), seasonSelect=document.getElementById('season');
const params=new URLSearchParams(location.search); let season=params.get('season')||'all';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const player=(r)=>'<a href="https://rldb.drein.net/player/'+encodeURIComponent(r.player_name)+'?competition=NRL">'+esc(r.player_name)+'</a>';
const num=(v)=>Number(v||0).toFixed(2); const rankRows=(rows,kind)=>rows.map((r,i)=>'<tr><td class="rank">'+(i+1)+'</td><td>'+player(r)+(r.position?' <span title="Position">('+esc(r.position)+')</span>':'')+'</td>'+(kind==='game'?'<td><a href="https://rldb.drein.net/match/'+r.match_id+'">'+esc(r.season+' '+r.round_label)+'</a></td><td>'+esc(r.team_name)+'</td>':kind==='club'?'<td>'+esc(r.team_name)+'</td>':r.season?'<td>'+esc(r.season)+'</td>':'')+'<td class="value">'+num(r.warg)+'</td></tr>').join('');
function table(title,rows,kind,href,klass=''){const extra=kind==='game'?'<th>Match</th><th>Club</th>':kind==='club'?'<th>Club</th>':rows.some(r=>r.season)?'<th>Year</th>':'';return '<article class="card '+klass+'"><div class="card-head"><h2>'+esc(title)+'</h2>'+(href?'<a href="'+href+'">See full list</a>':'')+'</div><div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th>'+extra+'<th>WARG</th></tr></thead><tbody>'+rankRows(rows,kind)+'</tbody></table></div></article>'}
function listHref(view,role=''){const q=new URLSearchParams({view,season});if(role)q.set('role',role);return '/warg/list?'+q}
function renderDashboard(data){let html=table('Top individual games',data.games,'game',listHref('games'),'wide');html+=table(season==='all'?'Top seasons':'Top players in '+season,data.seasons,'season',listHref('seasons'));if(data.careers.length)html+=table('Top careers',data.careers,'career',listHref('careers'));html+=table('Best player for each club',data.clubs.slice(0,10),'club',listHref('clubs'),'wide');const roleTitle={Back:'Backs',Half:'Halves',Hooker:'Hookers',Forward:'Forwards',Interchange:'Interchange players'};for(const [role,rows] of Object.entries(data.roles))html+=table('Top '+(roleTitle[role]||role),rows,'career',listHref(season==='all'?'careers':'seasons',role));content.innerHTML=html}
function renderList(data){const title=data.role?'Top '+data.role+'s':data.view==='games'?'Top individual games':data.view==='seasons'?'Top seasons':data.view==='clubs'?'Club careers':'Top careers';content.innerHTML=table(title,data.rows,data.view==='games'?'game':data.view==='clubs'?'club':'career','', 'full')+'<div class="card full pager"><a class="btn" href="/warg?season='+encodeURIComponent(season)+'">Back to dashboard</a><span>'+data.totalRows+' rows</span></div>'}
async function load(){content.innerHTML='<div class="card full status">Loading ratings...</div>';const q=new URLSearchParams(params);q.set('mode',mode);q.set('season',season);const res=await fetch('/api/warg?'+q,{cache:'no-store'});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data.error||'Unable to load ratings');if(!seasonSelect.dataset.ready){for(const year of data.years)seasonSelect.insertAdjacentHTML('beforeend','<option value="'+year+'">'+year+'</option>');seasonSelect.dataset.ready='1'}seasonSelect.value=season;document.getElementById('note').textContent=data.methodology+' · Generated '+new Date(data.metadata.generated_at_utc).toLocaleString()+' · Regular-season NRL only.';mode==='list'?renderList(data):renderDashboard(data)}
seasonSelect.addEventListener('change',()=>{season=seasonSelect.value;const next=new URL(location.href);next.searchParams.set('season',season);history.replaceState(null,'',next);load().catch(fail)});function fail(e){content.innerHTML='<div class="card full status">'+esc(e.message||e)+'</div>'}load().catch(fail);
</script></body></html>`;
}
