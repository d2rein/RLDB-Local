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

function competitionClause(competition: string, season: number | null): { sql: string; binds: Array<string | number> } {
  return season === null
    ? { sql: "WHERE competition_code=?", binds: [competition] }
    : { sql: "WHERE competition_code=? AND season=?", binds: [competition, season] };
}

async function metadata(db: D1Database): Promise<Record<string, string>> {
  const values = await rows(db.prepare("SELECT metadata_key,metadata_value FROM warg_metadata"));
  return Object.fromEntries(values.map((row) => [String(row.metadata_key), String(row.metadata_value)]));
}

async function dashboard(db: D1Database, competition: string, season: number | null, average: boolean): Promise<Record<string, unknown>> {
  const filter = competitionClause(competition, season);
  const seasonMinimum = competition === "NRLW" ? 3 : 10;
  const games = await rows(db.prepare(`
    SELECT season,match_id,round_label,player_id,player_name,team_name,opponent_name,
           score,position,role,game_warg AS warg
    FROM warg_match_ratings ${filter.sql}
    ORDER BY game_warg DESC,match_date_utc DESC,player_name LIMIT 10
  `).bind(...filter.binds));
  const finals = await rows(db.prepare(`
    SELECT season,match_id,round_label,player_id,player_name,team_name,opponent_name,
           score,position,role,game_warg AS warg
    FROM warg_match_ratings ${filter.sql} AND is_finals=1
    ORDER BY game_warg DESC,match_date_utc DESC,player_name LIMIT 10
  `).bind(...filter.binds));
  const grandFinals = await rows(db.prepare(`
    SELECT season,match_id,round_label,player_id,player_name,team_name,opponent_name,
           score,position,role,game_warg AS warg
    FROM warg_match_ratings ${filter.sql} AND is_grand_final=1
    ORDER BY game_warg DESC,match_date_utc DESC,player_name LIMIT 10
  `).bind(...filter.binds));
  const seasonWhere = [filter.sql.replace(/^WHERE /, ""), average ? `games>=${seasonMinimum}` : ""].filter(Boolean);
  const seasons = await rows(db.prepare(`
    SELECT season,player_id,player_name,position,role,games,warg AS total_warg,
           ${average ? "warg/games" : "warg"} AS warg
    FROM warg_season_ratings ${seasonWhere.length ? `WHERE ${seasonWhere.join(" AND ")}` : ""}
    ORDER BY warg DESC,player_name LIMIT 10
  `).bind(...filter.binds));
  const careers = season === null ? await rows(db.prepare(`
    SELECT player_id,player_name,primary_position AS position,primary_role AS role,
           seasons,games,career_warg AS total_warg,${average ? "career_warg/games" : "career_warg"} AS warg
    FROM warg_career_ratings WHERE competition_code=? ${average ? "AND games>=10" : ""}
    ORDER BY warg DESC,player_name LIMIT 10
  `).bind(competition)) : [];
  const clubFilter = competitionClause(competition, season);
  const clubs = await rows(db.prepare(`
    WITH totals AS (
      SELECT team_id,team_name,player_id,player_name,SUM(game_warg) total_warg,COUNT(*) games
      FROM warg_match_ratings ${clubFilter.sql}
      GROUP BY team_id,team_name,player_id,player_name
    ), ranked AS (
      SELECT *,${average ? "total_warg/games" : "total_warg"} AS warg,
             ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY ${average ? "total_warg/games" : "total_warg"} DESC,player_name) club_rank
      FROM totals ${average ? `WHERE games>=${season === null ? 10 : seasonMinimum}` : ""}
    )
    SELECT team_id,team_name,player_id,player_name,games,total_warg,warg
    FROM ranked WHERE club_rank=1 ORDER BY warg DESC,team_name LIMIT 40
  `).bind(...clubFilter.binds));
  const roleRows: Record<string, WargRow[]> = {};
  for (const role of ROLES) {
    if (season === null) {
      roleRows[role] = await rows(db.prepare(`
        SELECT player_id,player_name,primary_position AS position,games,career_warg AS total_warg,
               ${average ? "career_warg/games" : "career_warg"} AS warg
        FROM warg_career_ratings WHERE competition_code=? AND primary_role=? ${average ? "AND games>=10" : ""}
        ORDER BY warg DESC,player_name LIMIT 10
      `).bind(competition, role));
    } else {
      roleRows[role] = await rows(db.prepare(`
        SELECT season,player_id,player_name,position,games,warg AS total_warg,
               ${average ? "warg/games" : "warg"} AS warg
        FROM warg_season_ratings WHERE competition_code=? AND season=? AND role=? ${average ? `AND games>=${seasonMinimum}` : ""}
        ORDER BY warg DESC,player_name LIMIT 10
      `).bind(competition, season, role));
    }
  }
  return { games, finals, grandFinals, seasons, careers, clubs, roles: roleRows };
}

async function fullList(db: D1Database, url: URL): Promise<Record<string, unknown>> {
  const view = String(url.searchParams.get("view") ?? "careers");
  const competition = url.searchParams.get("competition") === "NRLW" ? "NRLW" : "NRL";
  const seasonValue = Number(url.searchParams.get("season") ?? "0");
  const season = Number.isInteger(seasonValue) && seasonValue >= 2001 ? seasonValue : null;
  const role = ROLES.includes(String(url.searchParams.get("role"))) ? String(url.searchParams.get("role")) : "";
  const average = url.searchParams.get("metric") === "average";
  const stage = ["finals", "grand_final"].includes(String(url.searchParams.get("stage"))) ? String(url.searchParams.get("stage")) : "all";
  const seasonMinimum = competition === "NRLW" ? 3 : 10;
  const limit = Math.min(250, Math.max(10, Number(url.searchParams.get("limit") ?? "100") || 100));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const offset = (page - 1) * limit;
  let sql = "";
  let countSql = "";
  let binds: unknown[] = [];
  if (view === "games") {
    const filter = competitionClause(competition, season);
    const stageSql = stage === "grand_final" ? " AND is_grand_final=1" : stage === "finals" ? " AND is_finals=1" : "";
    sql = `SELECT season,match_id,round_label,player_id,player_name,team_name,opponent_name,score,position,role,game_warg AS warg FROM warg_match_ratings ${filter.sql}${stageSql} ORDER BY game_warg DESC,match_date_utc DESC,player_name LIMIT ? OFFSET ?`;
    countSql = `SELECT COUNT(*) count FROM warg_match_ratings ${filter.sql}${stageSql}`;
    binds = filter.binds;
  } else if (view === "clubs") {
    const filter = competitionClause(competition, season);
    sql = `WITH totals AS (
      SELECT team_id,team_name,player_id,player_name,SUM(game_warg) total_warg,COUNT(*) games
      FROM warg_match_ratings ${filter.sql}
      GROUP BY team_id,team_name,player_id,player_name
    ), ranked AS (
      SELECT *,${average ? "total_warg/games" : "total_warg"} AS warg,
             ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY ${average ? "total_warg/games" : "total_warg"} DESC,player_name) club_rank
      FROM totals ${average ? `WHERE games>=${season === null ? 10 : seasonMinimum}` : ""}
    )
    SELECT team_id,team_name,player_id,player_name,games,total_warg,warg FROM ranked
    WHERE club_rank=1 ORDER BY warg DESC,team_name LIMIT ? OFFSET ?`;
    countSql = `WITH totals AS (
      SELECT team_id,player_id,COUNT(*) games FROM warg_match_ratings ${filter.sql}
      GROUP BY team_id,player_id
    ) SELECT COUNT(DISTINCT team_id) count FROM totals ${average ? `WHERE games>=${season === null ? 10 : seasonMinimum}` : ""}`;
    binds = filter.binds;
  } else if (view === "seasons" || season !== null) {
    const clauses = ["competition_code=?", season !== null ? "season=?" : "", role ? "role=?" : "", average ? `games>=${seasonMinimum}` : ""].filter(Boolean);
    binds = [competition, season, role].filter((value) => value !== null && value !== "");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    sql = `SELECT season,player_id,player_name,position,role,games,warg AS total_warg,${average ? "warg/games" : "warg"} AS warg FROM warg_season_ratings ${where} ORDER BY warg DESC,player_name LIMIT ? OFFSET ?`;
    countSql = `SELECT COUNT(*) count FROM warg_season_ratings ${where}`;
  } else {
    const clauses = ["competition_code=?", role ? "primary_role=?" : "", average ? "games>=10" : ""].filter(Boolean);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    binds = role ? [competition, role] : [competition];
    sql = `SELECT player_id,player_name,primary_position AS position,primary_role AS role,seasons,games,career_warg AS total_warg,${average ? "career_warg/games" : "career_warg"} AS warg FROM warg_career_ratings ${where} ORDER BY warg DESC,player_name LIMIT ? OFFSET ?`;
    countSql = `SELECT COUNT(*) count FROM warg_career_ratings ${where}`;
  }
  const resultRows = await rows(db.prepare(sql).bind(...binds, limit, offset));
  const count = await db.prepare(countSql).bind(...binds).first<{ count: number }>();
  return { view, competition, season, role, stage, metric: average ? "average" : "total", page, pageSize: limit, totalRows: Number(count?.count ?? 0), rows: resultRows };
}

export async function handleWargApi(db: D1Database | undefined, url: URL): Promise<Response> {
  if (!db) return response({ ok: false, error: "Database unavailable." }, 503);
  try {
    const mode = String(url.searchParams.get("mode") ?? "dashboard");
    const competition = url.searchParams.get("competition") === "NRLW" ? "NRLW" : "NRL";
    const seasonValue = Number(url.searchParams.get("season") ?? "0");
    const season = Number.isInteger(seasonValue) && seasonValue >= 2001 ? seasonValue : null;
    const average = url.searchParams.get("metric") === "average";
    const meta = await metadata(db);
    if (!meta.generated_at_utc) return response({ ok: false, error: "WARG ratings have not been materialised." }, 503);
    const years = await rows(db.prepare("SELECT DISTINCT season FROM warg_season_ratings WHERE competition_code=? ORDER BY season DESC").bind(competition));
    const data = mode === "list" ? await fullList(db, url) : await dashboard(db, competition, season, average);
    return response({ ok: true, methodology: "WARG-style Taylor reproduction v0.3; not official Maroon Observer WARG", competition, metric: average ? "average" : "total", seasonMinimumGames: competition === "NRLW" ? 3 : 10, careerMinimumGames: 10, metadata: meta, years: years.map((row) => Number(row.season)), ...data });
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
a{color:#0048c9;text-decoration:underline;text-underline-offset:2px}.shell{max-width:1540px;margin:auto;padding:16px}.masthead,.card{background:rgba(248,243,231,.95);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.masthead{padding:18px 20px;margin-bottom:14px}.head{display:flex;justify-content:space-between;gap:18px;align-items:flex-end;flex-wrap:wrap}.brand h1{margin:0 0 4px;font-size:2rem}.brand p{margin:0;color:var(--muted)}.controls{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.label{display:grid;gap:5px;font-size:.76rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}select,.btn{border:1px solid var(--line2);border-radius:9px;background:#fbf6eb;color:var(--text);padding:8px 10px;font-weight:700}.btn{text-decoration:none;display:inline-block}.toggle{display:flex;border:1px solid var(--line2);border-radius:9px;overflow:hidden}.toggle button{border:0;border-right:1px solid var(--line2);background:#fbf6eb;padding:8px 10px;font-weight:700;color:var(--text);cursor:pointer}.toggle button:last-child{border-right:0}.toggle button.active{background:var(--green);color:white}.note{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.card{overflow:hidden}.card-head{padding:11px 13px;background:linear-gradient(180deg,#f5eddc,#eee2cb);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}.card-head h2{margin:0;font-size:1rem}.card-head a{font-size:.8rem}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{padding:6px 8px;border-bottom:1px solid #ddd2ba;text-align:left;white-space:nowrap}th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}td.rank{width:32px;text-align:right;color:var(--muted)}td.value{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}.wide{grid-column:span 2}.full{grid-column:1/-1}.status{padding:24px;color:var(--muted)}.pager{display:flex;gap:8px;align-items:center;padding:10px 13px;border-top:1px solid var(--line)}
@media(max-width:1050px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:680px){.shell{padding:8px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.masthead,.card{border-radius:12px}.brand h1{font-size:1.55rem}th,td{padding:6px}}
</style></head><body><main class="shell"><header class="masthead"><div class="head"><div class="brand"><h1>WARG-style player ratings</h1><p>RLDB player production above a position-adjusted replacement level.</p></div><div class="controls"><label class="label">Competition<div class="toggle"><button type="button" data-competition="NRL">NRL</button><button type="button" data-competition="NRLW">NRLW</button></div></label><label class="label">Season<select id="season"><option value="all">All years</option></select></label><label class="label">Ranking<div class="toggle"><button type="button" data-metric="total">Totals</button><button type="button" data-metric="average">Per game</button></div></label><a class="btn" href="/">RLDB home</a></div></div><p class="note" id="note">Independent reproduction of the published Taylor/WARG method, not official Maroon Observer WARG. Regular-season matches only.</p></header><section id="content" class="grid"><div class="card full status">Loading ratings...</div></section></main>
<script>
const mode=${JSON.stringify(initialMode)}, content=document.getElementById('content'), seasonSelect=document.getElementById('season');
const params=new URLSearchParams(location.search); let competition=params.get('competition')==='NRLW'?'NRLW':'NRL', season=params.get('season')||'all', metric=params.get('metric')==='average'?'average':'total';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const player=(r)=>'<a href="https://rldb.drein.net/player/'+encodeURIComponent(r.player_name)+'?competition='+competition+'">'+esc(r.player_name)+'</a>';
const num=(v)=>Number(v||0).toFixed(2); const rankRows=(rows,kind)=>rows.map((r,i)=>'<tr><td class="rank">'+(i+1)+'</td><td>'+player(r)+(r.position?' <span title="Position">('+esc(r.position)+')</span>':'')+'</td>'+(kind==='game'?'<td><a href="https://rldb.drein.net/match/'+r.match_id+'">'+esc(r.season+' '+r.round_label)+'</a></td><td>'+esc(r.team_name)+'</td>':kind==='club'?'<td>'+esc(r.team_name)+'</td>':r.season?'<td>'+esc(r.season)+'</td>':'')+'<td class="value">'+num(r.warg)+'</td></tr>').join('');
function table(title,rows,kind,href,klass=''){const extra=kind==='game'?'<th>Match</th><th>Club</th>':kind==='club'?'<th>Club</th>':rows.some(r=>r.season)?'<th>Year</th>':'';const valueLabel=metric==='average'&&kind!=='game'?'WARG/game':'WARG';return '<article class="card '+klass+'"><div class="card-head"><h2>'+esc(title)+'</h2>'+(href?'<a href="'+href+'">See full list</a>':'')+'</div><div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th>'+extra+'<th>'+valueLabel+'</th></tr></thead><tbody>'+rankRows(rows,kind)+'</tbody></table></div></article>'}
function listHref(view,role='',stage=''){const q=new URLSearchParams({view,competition,season,metric});if(role)q.set('role',role);if(stage)q.set('stage',stage);return '/warg/list?'+q}
function renderDashboard(data){let html=table('Top individual games',data.games,'game',listHref('games'),'wide');html+=table('Top finals performances',data.finals,'game',listHref('games','','finals'));html+=table('Top grand-final performances',data.grandFinals,'game',listHref('games','','grand_final'));html+=table(season==='all'?'Top seasons':'Top players in '+season,data.seasons,'season',listHref('seasons'));if(data.careers.length)html+=table('Top careers',data.careers,'career',listHref('careers'));html+=table('Best player for each club',data.clubs.slice(0,10),'club',listHref('clubs'),'wide');const roleTitle={Back:'Backs',Half:'Halves',Hooker:'Hookers',Forward:'Forwards',Interchange:'Interchange players'};for(const [role,rows] of Object.entries(data.roles))html+=table('Top '+(roleTitle[role]||role),rows,'career',listHref(season==='all'?'careers':'seasons',role));content.innerHTML=html}
function renderList(data){const title=data.role?'Top '+data.role+'s':data.view==='games'?(data.stage==='grand_final'?'Top grand-final performances':data.stage==='finals'?'Top finals performances':'Top individual games'):data.view==='seasons'?'Top seasons':data.view==='clubs'?'Club careers':'Top careers';content.innerHTML=table(title,data.rows,data.view==='games'?'game':data.view==='clubs'?'club':'career','', 'full')+'<div class="card full pager"><a class="btn" href="/warg?competition='+competition+'&season='+encodeURIComponent(season)+'&metric='+metric+'">Back to dashboard</a><span>'+data.totalRows+' rows</span></div>'}
async function load(){content.innerHTML='<div class="card full status">Loading ratings...</div>';const q=new URLSearchParams(params);q.set('mode',mode);q.set('competition',competition);q.set('season',season);const res=await fetch('/api/warg?'+q,{cache:'no-store'});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data.error||'Unable to load ratings');if(!seasonSelect.dataset.ready){for(const year of data.years)seasonSelect.insertAdjacentHTML('beforeend','<option value="'+year+'">'+year+'</option>');seasonSelect.dataset.ready='1'}seasonSelect.value=season;document.getElementById('note').textContent=data.methodology+' · Generated '+new Date(data.metadata.generated_at_utc).toLocaleString()+' · Finals are scored with frozen regular-season parameters and excluded from season/career totals.';mode==='list'?renderList(data):renderDashboard(data)}
seasonSelect.addEventListener('change',()=>{season=seasonSelect.value;const next=new URL(location.href);next.searchParams.set('season',season);history.replaceState(null,'',next);load().catch(fail)});function fail(e){content.innerHTML='<div class="card full status">'+esc(e.message||e)+'</div>'}load().then(()=>{if(metric==='average')document.getElementById('note').textContent+=' · Season lists require '+(competition==='NRLW'?'3':'10')+' appearances; career lists require 10.'}).catch(fail);
document.querySelectorAll('[data-metric]').forEach(button=>{button.classList.toggle('active',button.dataset.metric===metric);button.addEventListener('click',()=>{const next=new URL(location.href);next.searchParams.set('metric',button.dataset.metric);location.href=next.toString()})});
document.querySelectorAll('[data-competition]').forEach(button=>{button.classList.toggle('active',button.dataset.competition===competition);button.addEventListener('click',()=>{const next=new URL(location.href);next.searchParams.set('competition',button.dataset.competition);next.searchParams.set('season','all');location.href=next.toString()})});
</script></body></html>`;
}
