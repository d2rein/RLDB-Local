import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const databasePath = path.resolve(value("--database"));
const startSeason = Number(value("--start", "2001"));
const endSeason = Number(value("--end", String(new Date().getFullYear())));
if (!databasePath || !Number.isInteger(startSeason) || !Number.isInteger(endSeason)) {
  throw new Error("Usage: materialize-warg.mjs --database <sqlite> [--start 2001] [--end 2026]");
}

const STATS = ["tries", "all_run_metres", "line_breaks", "line_break_assists", "try_assists", "tackle_breaks", "kicking_metres", "errors", "missed_tackles"];
const NEGATIVE = new Set(["errors", "missed_tackles"]);
const SPARSE_ZERO = new Set(STATS.filter((stat) => stat !== "all_run_metres"));
const DEFAULT_MINUTES = { Fullback:80,Winger:80,Centre:80,"Five-Eighth":80,Halfback:80,Prop:50,Hooker:65,"Second Row":70,Lock:60,Interchange:35,Unknown:45 };

function position(label, jumper) {
  const text = String(label ?? "").trim().toLowerCase().replaceAll("-", " ");
  const named = { fullback:"Fullback",winger:"Winger",wing:"Winger",centre:"Centre",center:"Centre","five eighth":"Five-Eighth",halfback:"Halfback",prop:"Prop",hooker:"Hooker","2nd row":"Second Row","second row":"Second Row",lock:"Lock",interchange:"Interchange",bench:"Interchange",replacement:"Interchange",reserve:"Interchange" };
  if (named[text]) return named[text];
  const number = Number(jumper);
  if (number === 1) return "Fullback";
  if ([2,5].includes(number)) return "Winger";
  if ([3,4].includes(number)) return "Centre";
  if (number === 6) return "Five-Eighth";
  if (number === 7) return "Halfback";
  if ([8,10].includes(number)) return "Prop";
  if (number === 9) return "Hooker";
  if ([11,12].includes(number)) return "Second Row";
  if (number === 13) return "Lock";
  if (number >= 14 && number <= 18) return "Interchange";
  return "Unknown";
}
function role(pos) { return ["Fullback","Winger","Centre"].includes(pos)?"Back":["Five-Eighth","Halfback"].includes(pos)?"Half":pos==="Hooker"?"Hooker":["Prop","Second Row","Lock"].includes(pos)?"Forward":"Interchange"; }
function mean(xs) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function median(xs) { if (!xs.length) return 0; const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function quantile(sorted, q) { if (!sorted.length) return 0; const p=(sorted.length-1)*q,l=Math.floor(p),h=Math.ceil(p); return sorted[l]+(sorted[h]-sorted[l])*(p-l); }
function regression(xs, ys) {
  if (xs.length < 3) return { slope:0, r2:0 };
  const mx=mean(xs),my=mean(ys); let covariance=0,vx=0,vy=0;
  for(let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my;covariance+=dx*dy;vx+=dx*dx;vy+=dy*dy;}
  if(vx<1e-12||vy<1e-12)return{slope:0,r2:0};
  const r=covariance/Math.sqrt(vx*vy); return { slope:covariance/vx, r2:r*r };
}
function bucketRegression(values, outcomes) {
  const sorted=[...values].sort((a,b)=>a-b); const edges=[...new Set(Array.from({length:11},(_,i)=>quantile(sorted,i/10)))];
  if(edges.length<3)return{slope:0,r2:0,buckets:0};
  const groups=new Map();
  for(let i=0;i<values.length;i++){let bucket=0;while(bucket<edges.length-2&&values[i]>edges[bucket+1])bucket++;const g=groups.get(bucket)||{v:[],o:[]};g.v.push(values[i]);g.o.push(outcomes[i]);groups.set(bucket,g);}
  const xs=[],ys=[]; for(const g of groups.values()){if(g.v.length>=10){xs.push(mean(g.v));ys.push(mean(g.o));}}
  const fit=regression(xs,ys); return{...fit,buckets:xs.length};
}
function increment(counter,key,amount=1){counter.set(key,(counter.get(key)||0)+amount);}
function primary(counter){return [...counter.entries()].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0])))[0]?.[0]||"Unknown";}

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;");
const matches = new Map(db.prepare(`SELECT c.code competition_code,m.match_id,m.season,m.match_date_utc,m.round_label,m.home_team_id,m.away_team_id,m.home_score,m.away_score,ht.canonical_name home_team_name,at.canonical_name away_team_name FROM matches m JOIN competitions c ON c.competition_id=m.competition_id JOIN teams ht ON ht.team_id=m.home_team_id JOIN teams at ON at.team_id=m.away_team_id WHERE c.code IN ('NRL','NRLW') AND m.season BETWEEN ? AND ? AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL AND COALESCE(m.is_finals,0)=0 ORDER BY c.code,m.season,m.match_date_utc,m.match_id`).all(startSeason,endSeason).map((row)=>[Number(row.match_id),row]));
const marks=Array(STATS.length+1).fill("?").join(",");
const rawRows=db.prepare(`SELECT p.match_id,p.player_id,COALESCE(pl.display_name,p.player_name_raw) player_name,p.team_id,p.jumper_number,p.position_label,v.stat_key,v.stat_value_num FROM player_match_summary p JOIN matches m ON m.match_id=p.match_id JOIN competitions c ON c.competition_id=m.competition_id LEFT JOIN players pl ON pl.player_id=p.player_id JOIN player_match_stat_values v ON v.player_match_summary_id=p.player_match_summary_id WHERE c.code IN ('NRL','NRLW') AND m.season BETWEEN ? AND ? AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL AND COALESCE(m.is_finals,0)=0 AND p.player_id IS NOT NULL AND v.stat_key IN (${marks}) AND v.stat_value_num IS NOT NULL ORDER BY c.code,m.season,m.match_id,p.player_id`).all(startSeason,endSeason,"minutes_played",...STATS);
const raw=new Map();
for(const row of rawRows){const key=`${row.match_id}:${row.player_id}`;if(!raw.has(key))raw.set(key,{matchId:Number(row.match_id),playerId:Number(row.player_id),playerName:String(row.player_name),teamId:Number(row.team_id),jumper:row.jumper_number,positionLabel:row.position_label,stats:{}});raw.get(key).stats[String(row.stat_key)]=Number(row.stat_value_num);}

const minutePools=new Map(),seasonPositions=new Map(),careerPositions=new Map();
for(const item of raw.values()){const match=matches.get(item.matchId);if(!match)continue;const pos=position(item.positionLabel,item.jumper);const sk=`${match.competition_code}:${match.season}:${item.playerId}`,ck=`${match.competition_code}:${item.playerId}`;if(!seasonPositions.has(sk))seasonPositions.set(sk,new Map());increment(seasonPositions.get(sk),pos);if(!careerPositions.has(ck))careerPositions.set(ck,new Map());increment(careerPositions.get(ck),pos);const minutes=item.stats.minutes_played;if(minutes>0){const key=`${match.competition_code}:${match.season}:${pos}`;if(!minutePools.has(key))minutePools.set(key,[]);minutePools.get(key).push(minutes);}}
const byYear=new Map();
for(const item of raw.values()){const match=matches.get(item.matchId);if(!match)continue;const ck=`${match.competition_code}:${item.playerId}`;let pos=position(item.positionLabel,item.jumper);if(pos==="Unknown")pos=primary(seasonPositions.get(`${match.competition_code}:${match.season}:${item.playerId}`)||careerPositions.get(ck)||new Map());let minutes=item.stats.minutes_played;let imputed=!(minutes>0);if(imputed){const numbered=Number(item.jumper)>=1&&Number(item.jumper)<=17;const production=STATS.some((stat)=>Math.abs(item.stats[stat]||0)>1e-12);if(!numbered&&!production)continue;minutes=median(minutePools.get(`${match.competition_code}:${match.season}:${pos}`)||[])||DEFAULT_MINUTES[pos]||45;}const stats={};for(const stat of STATS)stats[stat]=item.stats[stat]??(SPARSE_ZERO.has(stat)?0:0);const app={...item,...match,position:pos,role:role(pos),minutes:Number(minutes),imputed,stats};const key=`${match.competition_code}:${match.season}`;if(!byYear.has(key))byYear.set(key,[]);byYear.get(key).push(app);}

const seasons=[],games=[];
for(const seasonKey of [...byYear.keys()].sort()){
  const [competition,yearText]=seasonKey.split(":"),year=Number(yearText),apps=byYear.get(seasonKey),teamGames=new Map();
  for(const app of apps){const key=`${app.matchId}:${app.teamId}`;if(!teamGames.has(key))teamGames.set(key,Object.fromEntries(STATS.map((s)=>[s,0])));const team=teamGames.get(key);for(const stat of STATS)team[stat]+=app.stats[stat];}
  for(const [key,team] of teamGames){const [matchIdText,teamIdText]=key.split(":"),match=matches.get(Number(matchIdText)),home=Number(teamIdText)===Number(match.home_team_id),scored=Number(home?match.home_score:match.away_score),conceded=Number(home?match.away_score:match.home_score);team.outcome=scored>conceded?1:scored===conceded?.5:0;team.margin=scored-conceded;}
  const fParts={},pParts={};
  for(const stat of STATS){const teams=[...teamGames.values()],values=teams.map((t)=>t[stat]),outcomes=teams.map((t)=>t.outcome);let f=bucketRegression(values,outcomes);if(f.slope*(NEGATIVE.has(stat)?-1:1)<=0)f={slope:0,r2:0,buckets:f.buckets};const xs=[],ys=[];for(const match of matches.values()){if(match.competition_code!==competition||Number(match.season)!==year)continue;const h=teamGames.get(`${match.match_id}:${match.home_team_id}`),a=teamGames.get(`${match.match_id}:${match.away_team_id}`);if(h&&a){xs.push(h[stat]-a[stat]);ys.push(Number(match.home_score)-Number(match.away_score));}}let p=regression(xs,ys);if(p.slope*(NEGATIVE.has(stat)?-1:1)<=0)p={slope:0,r2:0};fParts[stat]=f;pParts[stat]=p;}
  const fTotal=STATS.reduce((n,s)=>n+fParts[s].r2,0)||1,pTotal=STATS.reduce((n,s)=>n+pParts[s].r2,0)||1;const fCoeff={},pRaw={};for(const stat of STATS){fCoeff[stat]=fParts[stat].slope*(fParts[stat].r2/fTotal)*1000;pRaw[stat]=pParts[stat].slope*(pParts[stat].r2/pTotal);}const anchor=Math.abs(pRaw.tries)>1e-12?fCoeff.tries/pRaw.tries:1,pCoeff={};for(const stat of STATS)pCoeff[stat]=pRaw[stat]*anchor;
  const posTotals=new Map();for(const app of apps){for(const stat of STATS){const key=`${app.position}:${stat}`,v=posTotals.get(key)||{value:0,minutes:0};v.value+=app.stats[stat];v.minutes+=app.minutes;posTotals.set(key,v);}}
  const players=new Map();for(const app of apps){let fty=0,pty=0;for(const stat of STATS){const p=posTotals.get(`${app.position}:${stat}`),rate=p?.minutes?p.value/p.minutes:0;fty+=app.stats[stat]*fCoeff[stat];pty+=(app.stats[stat]-rate*app.minutes)*pCoeff[stat];}app.fty=fty;app.pty=pty;if(!players.has(app.playerId))players.set(app.playerId,{playerId:app.playerId,playerName:app.playerName,games:0,minutes:0,fty:0,pty:0,positions:new Map(),roles:new Map()});const player=players.get(app.playerId);player.games++;player.minutes+=app.minutes;player.fty+=fty;player.pty+=pty;increment(player.positions,app.position);increment(player.roles,app.role);}
  const eligibilityGames=Math.min(10,Math.max(...[...players.values()].map((p)=>p.games))),eligible=[...players.values()].filter((p)=>p.games>=eligibilityGames),teamCount=new Set(apps.map((a)=>a.teamId)).size,cut=Math.min(Math.max(teamCount*17-1,0),eligible.length-1);if(cut<0)continue;const fr=[...eligible].map((p)=>p.fty/p.games).sort((a,b)=>b-a)[cut],pr=[...eligible].map((p)=>p.pty/p.games).sort((a,b)=>b-a)[cut];for(const p of players.values())p.above=p.fty-fr*p.games+3*(p.pty-pr*p.games);const denominator=[...players.values()].reduce((n,p)=>n+p.above,0),matchCount=new Set(apps.map((a)=>a.matchId)).size,scale=denominator>1e-12?(matchCount-2)/denominator:0;
  for(const p of players.values()){p.warg=p.above*scale;seasons.push({competition,season:year,playerId:p.playerId,playerName:p.playerName,position:primary(p.positions),role:primary(p.roles),games:p.games,minutes:p.minutes,fty:p.fty,pty:p.pty,warg:p.warg});}
  for(const app of apps){const weighted=(app.fty-fr)+3*(app.pty-pr),home=app.teamId===Number(app.home_team_id);games.push({competition,season:year,matchId:app.matchId,date:app.match_date_utc,round:app.round_label,playerId:app.playerId,playerName:app.playerName,teamId:app.teamId,teamName:home?app.home_team_name:app.away_team_name,opponentName:home?app.away_team_name:app.home_team_name,score:`${app.home_team_name} ${app.home_score}-${app.away_score} ${app.away_team_name}`,position:app.position,role:app.role,minutes:app.minutes,imputed:app.imputed?1:0,fty:app.fty,pty:app.pty,warg:weighted*scale});}
  console.log(`WARG ${competition} ${year}: ${matchCount} matches, ${players.size} players`);
}

const careers=new Map();for(const s of seasons){const key=`${s.competition}:${s.playerId}`;if(!careers.has(key))careers.set(key,{competition:s.competition,playerId:s.playerId,playerName:s.playerName,seasons:0,games:0,minutes:0,warg:0,positions:new Map(),roles:new Map(),bestSeason:null,best:-Infinity});const c=careers.get(key);c.seasons++;c.games+=s.games;c.minutes+=s.minutes;c.warg+=s.warg;increment(c.positions,s.position,s.games);increment(c.roles,s.role,s.games);if(s.warg>c.best){c.best=s.warg;c.bestSeason=s.season;}}
db.exec(`DROP TABLE IF EXISTS warg_season_ratings;DROP TABLE IF EXISTS warg_match_ratings;DROP TABLE IF EXISTS warg_career_ratings;CREATE TABLE IF NOT EXISTS warg_metadata(metadata_key TEXT PRIMARY KEY,metadata_value TEXT NOT NULL);CREATE TABLE warg_season_ratings(competition_code TEXT NOT NULL,season INTEGER NOT NULL,player_id INTEGER NOT NULL,player_name TEXT NOT NULL,position TEXT NOT NULL,role TEXT NOT NULL,games INTEGER NOT NULL,minutes REAL NOT NULL,fty REAL NOT NULL,pty REAL NOT NULL,warg REAL NOT NULL,PRIMARY KEY(competition_code,season,player_id));CREATE TABLE warg_match_ratings(competition_code TEXT NOT NULL,season INTEGER NOT NULL,match_id INTEGER NOT NULL,match_date_utc TEXT,round_label TEXT,player_id INTEGER NOT NULL,player_name TEXT NOT NULL,team_id INTEGER NOT NULL,team_name TEXT NOT NULL,opponent_name TEXT NOT NULL,score TEXT NOT NULL,position TEXT NOT NULL,role TEXT NOT NULL,minutes REAL NOT NULL,minutes_imputed INTEGER NOT NULL,fty REAL NOT NULL,pty REAL NOT NULL,game_warg REAL NOT NULL,PRIMARY KEY(competition_code,match_id,player_id));CREATE TABLE warg_career_ratings(competition_code TEXT NOT NULL,player_id INTEGER NOT NULL,player_name TEXT NOT NULL,primary_position TEXT NOT NULL,primary_role TEXT NOT NULL,seasons INTEGER NOT NULL,games INTEGER NOT NULL,minutes REAL NOT NULL,career_warg REAL NOT NULL,warg_per_game REAL NOT NULL,best_season INTEGER,best_season_warg REAL NOT NULL,PRIMARY KEY(competition_code,player_id));`);
db.exec("BEGIN IMMEDIATE");
try{
  db.exec("DELETE FROM warg_metadata;DELETE FROM warg_season_ratings;DELETE FROM warg_match_ratings;DELETE FROM warg_career_ratings;");
  const si=db.prepare("INSERT INTO warg_season_ratings VALUES(?,?,?,?,?,?,?,?,?,?,?)");for(const s of seasons)si.run(s.competition,s.season,s.playerId,s.playerName,s.position,s.role,s.games,s.minutes,s.fty,s.pty,s.warg);
  const gi=db.prepare("INSERT INTO warg_match_ratings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");for(const g of games)gi.run(g.competition,g.season,g.matchId,g.date,g.round,g.playerId,g.playerName,g.teamId,g.teamName,g.opponentName,g.score,g.position,g.role,g.minutes,g.imputed,g.fty,g.pty,g.warg);
  const ci=db.prepare("INSERT INTO warg_career_ratings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");for(const c of careers.values())ci.run(c.competition,c.playerId,c.playerName,primary(c.positions),primary(c.roles),c.seasons,c.games,c.minutes,c.warg,c.warg/c.games,c.bestSeason,c.best);
  const mi=db.prepare("INSERT INTO warg_metadata VALUES(?,?)");mi.run("generated_at_utc",new Date().toISOString());mi.run("start_season",String(startSeason));mi.run("end_season",String(endSeason));mi.run("method_version","warg-style-v0.2");mi.run("competitions","NRL,NRLW");mi.run("status","Independent reproduction; not official Maroon Observer WARG");
  db.exec("COMMIT");
}catch(error){db.exec("ROLLBACK");throw error;}finally{db.close();}
console.log(`Materialised ${games.length} WARG player-games, ${seasons.length} player-seasons and ${careers.size} careers into ${databasePath}`);
