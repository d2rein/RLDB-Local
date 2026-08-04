import fs from "node:fs/promises";
import path from "node:path";

const COMPETITION_IDS = { NRL: 111, NRLW: 161 };
const DRAW_SLUGS = { NRL: "nrl-premiership", NRLW: "womens-premiership" };
const TEAM_STAT_KEYS = new Map([
  ["Time In Possession", "time_in_possession"], ["Completion Rate", "Completion Rate"],
  ["All Runs", "all_runs"], ["All Run Metres", "all_run_metres"], ["Post Contact Metres", "post_contact_metres"],
  ["Line Breaks", "line_breaks"], ["Tackle Breaks", "tackle_breaks"], ["Average Set Distance", "average_set_distance"],
  ["Kick Return Metres", "kick_return_metres"], ["Average Play The Ball Speed", "Average_Play_Ball_Speed"],
  ["Offloads", "offloads"], ["Receipts", "receipts"], ["Total Passes", "total_passes"], ["Dummy Passes", "dummy_passes"],
  ["Kicks", "kicks"], ["Kicking Metres", "kicking_metres"], ["Forced Drop Outs", "forced_drop_outs"],
  ["Kick Defusal %", "Kick_Defusal"], ["Bombs", "bombs"], ["Grubbers", "grubbers"],
  ["Effective Tackle %", "Effective_Tackle"], ["Tackles Made", "tackles_made"], ["Missed Tackles", "missed_tackles"],
  ["Intercepts", "intercepts"], ["Ineffective Tackles", "ineffective_tackles"], ["Errors", "errors"],
  ["Penalties Conceded", "penalties_conceded"], ["Ruck Infringements", "ruck_infringements"],
  ["Inside 10 Metres", "inside_10_metres"], ["Sin Bins", "sin_bins"], ["Send Offs", "send_offs"], ["Used", "interchanges_used"],
]);
const PLAYER_FIELDS = new Map([
  ["Mins Played","minutesPlayed"],["Points","points"],["Tries","tries"],["Conversions","conversions"],
  ["Conversion Attempts","conversionAttempts"],["Penalty Goals","penaltyGoals"],["Goal Conversion Rate","goalConversionRate"],
  ["1 Point Field Goals","onePointFieldGoals"],["2 Point Field Goals","twoPointFieldGoals"],["Total Points","fantasyPointsTotal"],
  ["All Runs","allRuns"],["All Run Metres","allRunMetres"],["Kick Return Metres","kickReturnMetres"],
  ["Post Contact Metres","postContactMetres"],["Line Breaks","lineBreaks"],["Line Break Assists","lineBreakAssists"],
  ["Try Assists","tryAssists"],["Line Engaged Runs","lineEngagedRuns"],["Tackle Breaks","tackleBreaks"],["Hit Ups","hitUps"],
  ["Play The Ball","playTheBallTotal"],["Average Play The Ball Speed","playTheBallAverageSpeed"],["Dummy Half Runs","dummyHalfRuns"],
  ["Dummy Half Run Metres","dummyHalfRunMetres"],["One on One Steal","oneOnOneSteal"],["Offloads","offloads"],
  ["Dummy Passes","dummyPasses"],["Passes","passes"],["Receipts","receipts"],["Passes To Run Ratio","passesToRunRatio"],
  ["Tackle Efficiency","tackleEfficiency"],["Tackles Made","tacklesMade"],["Missed Tackles","missedTackles"],
  ["Ineffective Tackles","ineffectiveTackles"],["Intercepts","intercepts"],["Kicks Defused","kicksDefused"],
  ["Kicks","kicks"],["Kicking Metres","kickMetres"],["Forced Drop Outs","forcedDropOutKicks"],["Bomb Kicks","bombKicks"],
  ["Grubbers","grubberKicks"],["40/20","fortyTwentyKicks"],["20/40","twentyFortyKicks"],["Cross Field Kicks","crossFieldKicks"],
  ["Kicked Dead","kicksDead"],["Errors","errors"],["Handling Errors","handlingErrors"],["One on One Lost","oneOnOneLost"],
  ["Penalties","penalties"],["Ruck Infringements","ruckInfringements"],["Inside 10 Metres","offsideWithinTenMetres"],
  ["On Report","onReport"],["Sin Bins","sinBins"],["Send Offs","sendOffs"],["Stint One","stintOne"],["Stint Two","stintTwo"],
]);

function parseArgs(argv) { const out=new Map(); for(let i=0;i<argv.length;i++){const v=argv[i];if(!v.startsWith("--"))continue;const s=v.indexOf("=");if(s>=0)out.set(v.slice(2,s),v.slice(s+1));else if(argv[i+1]&&!argv[i+1].startsWith("--"))out.set(v.slice(2),argv[++i]);else out.set(v.slice(2),"1");}return out; }
function decodeEntities(value) { return value.replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }
function extractQData(html, id) { const tag=html.match(new RegExp(`<div[^>]+id=["']${id}["'][^>]*>`,`i`))?.[0] ?? html.match(new RegExp(`<div[^>]+q-data=["'][^"']+["'][^>]+id=["']${id}["'][^>]*>`,`i`))?.[0]; const raw=tag?.match(/q-data=["']([^"']+)["']/i)?.[1]; if(!raw)throw new Error(`Missing ${id} q-data`); return JSON.parse(decodeEntities(raw)); }
async function fetchText(url, attempts=3) { let last; for(let i=1;i<=attempts;i++){try{const response=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);return await response.text();}catch(error){last=error;if(i<attempts)await new Promise(r=>setTimeout(r,2000*i));}}throw last; }
function format(value){if(value===null||value===undefined)return "na";if(typeof value==="number"&&Number.isInteger(value))return String(value);return String(value);}
function sideValue(stat,side){const payload=stat[side==="home"?"homeValue":"awayValue"];if(!payload||payload.value===null||payload.value===undefined)return -1;const value=Number(payload.value);if(stat.title==="Time In Possession")return `${Math.floor(value/60)}:${String(Math.round(value%60)).padStart(2,"0")}`;if(stat.units==="Seconds")return `${value.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')}s`;if(String(stat.type).startsWith("Percentage"))return `${value}%`;return format(value);}
function teamStats(match,side){const out={};for(const group of match.stats?.groups??[])for(const stat of group.stats??[]){const key=TEAM_STAT_KEYS.get(stat.title);if(key)out[key]=sideValue(stat,side);}const scoring=match[side==="home"?"homeTeam":"awayTeam"]?.scoring??{};out.tries=scoring.tries?.made??-1;out.conversions=scoring.conversions?`${scoring.conversions.made??0}/${scoring.conversions.attempts??0}`:-1;out.penalty_goals=scoring.penaltyGoals?`${scoring.penaltyGoals.made??0}/${scoring.penaltyGoals.attempts??0}`:-1;out.sin_bins=scoring.sinBins?.made??0;out.send_offs=scoring.sendOffs?.made??0;out["1_point_field_goals"]=scoring.onePointFieldGoals?.made??0;out["2_point_field_goals"]=scoring.twoPointFieldGoals?.made??0;out.half_time=scoring.halfTimeScore??-1;return out;}
function playersForSide(match,side){const team=match[side==="home"?"homeTeam":"awayTeam"]??{};const roster=new Map((team.players??[]).map(p=>[p.playerId,p]));const rows=[];for(const stats of match.stats?.players?.[side==="home"?"homeTeam":"awayTeam"]??[]){const player=roster.get(stats.playerId)??{};const row={Name:[player.firstName,player.lastName].filter(Boolean).join(" ")||"Unknown",Number:format(player.number),Position:player.position||"na"};for(const [label,key] of PLAYER_FIELDS)row[label]=format(stats[key]);rows.push(row);}return rows;}
function detailPayload(match){const firstTry=(match.timeline??[]).find(event=>event.type==="Try");const allPlayers=[...(match.homeTeam?.players??[]),...(match.awayTeam?.players??[])];const scorer=allPlayers.find(player=>player.playerId===firstTry?.playerId);const officials=match.officials??[];return {match:{overall_first_try_scorer:scorer?[scorer.firstName,scorer.lastName].filter(Boolean).join(" "):null,overall_first_try_minute:firstTry?`${Math.floor(Number(firstTry.gameSeconds)/60)}'`:null,overall_first_try_round:firstTry?.teamId===match.homeTeam?.teamId?match.homeTeam?.nickName:match.awayTeam?.nickName,ref_names:officials.map(row=>[row.firstName,row.lastName].filter(Boolean).join(" ")),ref_positions:officials.map(row=>row.position),main_ref:officials.find(row=>row.position==="Referee")?[officials.find(row=>row.position==="Referee").firstName,officials.find(row=>row.position==="Referee").lastName].join(" "):null,ground_condition:match.groundConditions??null,weather_condition:match.weather??null},home:teamStats(match,"home"),away:teamStats(match,"away")};}
function mergeRound(entries,round,rows){const next=entries.filter(entry=>!Object.hasOwn(entry,String(round)));next.push({[round]:rows});next.sort((a,b)=>Number(Object.keys(a)[0])-Number(Object.keys(b)[0]));return next;}
async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch(error){if(error.code==="ENOENT")return fallback;throw error;}}
async function writeJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;await fs.writeFile(temporary,JSON.stringify(value,null,2));await fs.rename(temporary,file);}

const args=parseArgs(process.argv.slice(2));const code=String(args.get("competition")??"NRL").toUpperCase();const season=Number(args.get("season")??new Date().getFullYear());const dataRoot=path.resolve(args.get("data-root")??"");if(!COMPETITION_IDS[code]||!dataRoot)throw new Error("Use --competition NRL|NRLW --season YYYY --data-root PATH.");
const directory=path.join(dataRoot,code,String(season));const basicFile=path.join(directory,`${code}_data_${season}.json`);const detailFile=path.join(directory,`${code}_detailed_match_data_${season}.json`);const playerFile=path.join(directory,`${code}_player_statistics_${season}.json`);
const basic=await readJson(basicFile,{[code]:[{[season]:[]}]});const details=await readJson(detailFile,{[code]:[]});const players=await readJson(playerFile,{PlayerStats:[{[season]:[]}]});
const existingRounds=details[code]??[];const latest=Math.max(0,...existingRounds.map(entry=>Number(Object.keys(entry)[0])));const start=Number(args.get("start-round")??Math.max(1,latest-1));const end=Number(args.get("end-round")??latest+2);const written=[];
for(let round=start;round<=end;round++){
  console.log(`[fetch] ${code} ${season} round ${round}`);const drawUrl=`https://www.nrl.com/draw/?competition=${COMPETITION_IDS[code]}&round=${round}&season=${season}`;const draw=extractQData(await fetchText(drawUrl),"vue-draw");const fixtures=(draw.fixtures??[]).filter(row=>row.type==="Match");if(!fixtures.length){console.log(`[skip] round ${round}: no fixtures`);continue;}
  const basicRows=[];const detailRows=[];const playerRows=[];let complete=true;
  for(const fixture of fixtures){const url=new URL(fixture.matchCentreUrl,"https://www.nrl.com").href;const match=extractQData(await fetchText(url),"vue-match-centre").match;if(!match||!String(match.matchState??"").toLowerCase().includes("full")){complete=false;console.log(`[skip] incomplete match ${url}`);break;}const home=match.homeTeam?.nickName||fixture.homeTeam?.nickName;const away=match.awayTeam?.nickName||fixture.awayTeam?.nickName;const roster=[...playersForSide(match,"home"),...playersForSide(match,"away")];if(roster.length<20){complete=false;console.log(`[skip] only ${roster.length} players ${url}`);break;}basicRows.push({Round:match.roundTitle??`Round ${round}`,Home:home,Home_Score:Number(match.homeTeam.score),Away:away,Away_Score:Number(match.awayTeam.score),Venue:match.venue,Date:match.startTime,Match_Centre_URL:url});detailRows.push({[`${home} v ${away}`]:detailPayload(match)});playerRows.push({[`${season}-${round}-${home.replace(/ /g,"-")}-v-${away.replace(/ /g,"-")}`]:roster});}
  if(!complete||basicRows.length!==fixtures.length){console.log(`[skip] round ${round}: round is not complete`);continue;}
  basic[code][0][String(season)]=mergeRound(basic[code][0][String(season)]??[],round,basicRows);details[code]=mergeRound(details[code]??[],round,detailRows);players.PlayerStats[0][String(season)]=mergeRound(players.PlayerStats[0][String(season)]??[],round,playerRows);await Promise.all([writeJson(basicFile,basic),writeJson(detailFile,details),writeJson(playerFile,players)]);written.push(round);console.log(`[write] ${code} round ${round}: ${fixtures.length} matches`);
}
console.log(JSON.stringify({ok:true,competition:code,season,startRound:start,endRound:end,writtenRounds:written},null,2));
