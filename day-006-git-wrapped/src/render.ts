import type { NarrationLines, Persona, SlideId, Stats } from "./types";
import { SLIDE_IDS } from "./types";
import {
  dayNumber,
  escapeHtml as esc,
  formatDate,
  formatHour,
  formatNumber as n,
  isoFromDayNumber,
  MONTH_NAMES,
  pluralize,
  repoLabel,
  weekdayOf,
} from "./util";

export interface RenderInput {
  stats: Stats;
  persona: Persona;
  lines: NarrationLines;
}

const CELL = 10;
const STEP = 12;
const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * Contribution heatmap as inline SVG: one column per week, one row per weekday, 5 intensity levels.
 * The year is drawn as two stacked halves (Jan to Jun, then Jul to Dec) so cells stay big enough on a phone.
 */
export function heatmapSvg(stats: Stats): string {
  const counts = new Map(stats.calendar.map((d) => [d.date, d.count]));
  const max = stats.calendar.reduce((m, d) => Math.max(m, d.count), 0);
  const labelRow = 16;
  const blockHeight = labelRow + 7 * STEP;
  const gap = 10;
  const pad = (m: number) => String(m + 1).padStart(2, "0");

  const parts: string[] = [];
  let maxCol = 0;
  [0, 6].forEach((firstMonth, half) => {
    const startIso = `${stats.year}-${pad(firstMonth)}-01`;
    const endIso = half === 0 ? `${stats.year}-06-30` : `${stats.year}-12-31`;
    const first = dayNumber(startIso);
    const offset = weekdayOf(startIso);
    const yBase = half * (blockHeight + gap);
    const colOf = (day: number) => Math.floor((day - first + offset) / 7);

    for (let m = firstMonth; m < firstMonth + 6; m++) {
      const col = colOf(dayNumber(`${stats.year}-${pad(m)}-01`));
      parts.push(`<text class="ax" x="${col * STEP}" y="${yBase + 10}">${MONTH_NAMES[m].slice(0, 3)}</text>`);
    }
    for (let day = first; day <= dayNumber(endIso); day++) {
      const iso = isoFromDayNumber(day);
      const col = colOf(day);
      maxCol = Math.max(maxCol, col);
      const known = counts.has(iso);
      const count = counts.get(iso) ?? 0;
      const level = count === 0 ? 0 : Math.max(1, Math.ceil((4 * count) / max));
      parts.push(
        `<rect class="c l${level}${known ? "" : " fut"}" x="${col * STEP}" y="${yBase + labelRow + weekdayOf(iso) * STEP}" width="${CELL}" height="${CELL}" rx="2"><title>${esc(formatDate(iso))}: ${n(count)} ${pluralize(count, "contribution")}</title></rect>`,
      );
    }
  });

  const width = (maxCol + 1) * STEP;
  const height = 2 * blockHeight + gap;
  return `<svg class="heatmap" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Contribution heatmap for ${stats.year}: ${n(stats.totalContributions)} contributions on ${n(stats.activeDays)} days`)}">${parts.join("")}</svg>`;
}

/** 24 bars, one per hour of day, peak hour highlighted. */
export function hourChartSvg(stats: Stats): string {
  const max = Math.max(...stats.hourCounts);
  if (max === 0) return `<p class="empty">No commit timestamps to chart.</p>`;
  const barW = 15;
  const step = 19;
  const base = 190;
  const maxH = 150;
  const bars = stats.hourCounts.map((count, hour) => {
    const h = count === 0 ? 2 : Math.max(4, (count / max) * maxH);
    const peak = hour === stats.peakHour;
    return `<rect class="bar-h${peak ? " peak" : ""}" x="${8 + hour * step}" y="${base - h}" width="${barW}" height="${h}" rx="3"><title>${esc(formatHour(hour))}: ${n(count)} ${pluralize(count, "commit")}</title></rect>`;
  });
  const labels = [0, 6, 12, 18].map(
    (hour) => `<text class="ax" x="${8 + hour * step}" y="${base + 18}">${esc(formatHour(hour))}</text>`,
  );
  const peakX = 8 + (stats.peakHour ?? 0) * step + barW / 2;
  const peakH = Math.max(4, (stats.hourCounts[stats.peakHour ?? 0] / max) * maxH);
  const peakLabel = `<text class="ax peak-label" x="${peakX}" y="${base - peakH - 8}" text-anchor="middle">${esc(formatHour(stats.peakHour ?? 0))}</text>`;
  const label = `Commits by hour of day (${stats.timeZone}). Peak hour: ${formatHour(stats.peakHour ?? 0)}.`;
  return `<svg class="hours" viewBox="0 0 470 220" role="img" aria-label="${esc(label)}">${bars.join("")}${labels.join("")}${peakLabel}</svg>`;
}

/** 7 bars, Sunday to Saturday. Weekend bars use the accent colour. */
export function weekdayChartSvg(stats: Stats): string {
  const max = Math.max(...stats.weekdayCounts);
  if (max === 0) return `<p class="empty">No contributions to chart.</p>`;
  const base = 120;
  const maxH = 100;
  const bars = stats.weekdayCounts.map((count, d) => {
    const h = count === 0 ? 2 : Math.max(4, (count / max) * maxH);
    const weekend = d === 0 || d === 6;
    return (
      `<rect class="bar-h${weekend ? " peak" : ""}" x="${10 + d * 56}" y="${base - h}" width="40" height="${h}" rx="5"><title>${n(count)} ${pluralize(count, "contribution")}</title></rect>` +
      `<text class="ax" x="${30 + d * 56}" y="${base + 18}" text-anchor="middle">${WEEKDAY_LETTERS[d]}</text>`
    );
  });
  return `<svg class="weekdays" viewBox="0 0 400 145" role="img" aria-label="Contributions by day of week, Sunday to Saturday">${bars.join("")}</svg>`;
}

const pct = (value: number) => `${Math.round(value)}%`;

function slideBody(id: SlideId, { stats, persona, lines }: RenderInput): string {
  const line = `<p class="line">${esc(lines[id])}</p>`;
  const who = esc(stats.name || stats.login);

  switch (id) {
    case "intro":
      return `<p class="eyebrow">Git Wrapped</p>
        <h1 class="mega">${stats.year}</h1>
        <p class="who">${who}</p>
        <p class="handle">@${esc(stats.login)}</p>
        ${line}
        <p class="hint">Tap or use the arrow keys</p>`;

    case "total":
      return `<p class="eyebrow">You made</p>
        <p class="mega">${n(stats.totalContributions)}</p>
        <p class="unit">contributions on ${n(stats.activeDays)} ${pluralize(stats.activeDays, "day")}</p>
        <ul class="chips">
          <li><b>${n(stats.totals.commits)}</b> ${pluralize(stats.totals.commits, "commit")}</li>
          <li><b>${n(stats.totals.pullRequests)}</b> pull ${pluralize(stats.totals.pullRequests, "request")}</li>
          <li><b>${n(stats.totals.issues)}</b> ${pluralize(stats.totals.issues, "issue")}</li>
          <li><b>${n(stats.totals.reviews)}</b> ${pluralize(stats.totals.reviews, "review")}</li>
        </ul>
        ${line}`;

    case "heatmap":
      return `<p class="eyebrow">Your year, day by day</p>
        ${heatmapSvg(stats)}
        <div class="duo">
          <div><p class="label">Busiest day</p><p class="big">${stats.busiestDay ? esc(formatDate(stats.busiestDay.date)) : "None yet"}</p>${stats.busiestDay ? `<p class="sub">${n(stats.busiestDay.count)} ${pluralize(stats.busiestDay.count, "contribution")}</p>` : ""}</div>
          <div><p class="label">Busiest month</p><p class="big">${stats.busiestMonth ? esc(stats.busiestMonth.label) : "None yet"}</p>${stats.busiestMonth ? `<p class="sub">${n(stats.busiestMonth.count)} ${pluralize(stats.busiestMonth.count, "contribution")}</p>` : ""}</div>
        </div>
        ${line}`;

    case "streak": {
      const longest = stats.longestStreak;
      const range =
        longest.start && longest.end
          ? `${esc(formatDate(longest.start))} to ${esc(formatDate(longest.end))}`
          : "No streak yet";
      return `<p class="eyebrow">Longest streak</p>
        <p class="mega">${n(longest.length)}</p>
        <p class="unit">${pluralize(longest.length, "day")} in a row</p>
        <p class="sub">${range}</p>
        <div class="duo single"><div><p class="label">Current streak</p><p class="big">${n(stats.currentStreak)} ${pluralize(stats.currentStreak, "day")}</p></div></div>
        ${line}`;
    }

    case "hours":
      return `<p class="eyebrow">You code most around</p>
        <p class="mega">${stats.peakHour === null ? "?" : esc(formatHour(stats.peakHour))}</p>
        ${hourChartSvg(stats)}
        <p class="sub">${n(stats.commitSample)} sampled ${pluralize(stats.commitSample, "commit")}, hours in ${esc(stats.timeZone)}</p>
        ${line}`;

    case "weekend":
      return `<p class="eyebrow">Weekends</p>
        <p class="mega">${pct(stats.weekendShare)}</p>
        <p class="unit">of your work was on a Saturday or Sunday</p>
        ${weekdayChartSvg(stats)}
        <p class="sub">${pct(stats.weekdayShare)} on weekdays</p>
        ${line}`;

    case "languages": {
      const rows = stats.topLanguages
        .map(
          (l, i) => `<li><span class="rank">${i + 1}</span><span class="lang">${esc(l.name)}</span><span class="track"><i style="width:${Math.max(2, Math.round(l.percent))}%"></i></span><span class="val">${pct(l.percent)}</span></li>`,
        )
        .join("");
      return `<p class="eyebrow">Top languages by bytes</p>
        ${rows ? `<ol class="langs">${rows}</ol>` : `<p class="empty">No language data this year.</p>`}
        ${stats.languageCount > stats.topLanguages.length ? `<p class="sub">plus ${n(stats.languageCount - stats.topLanguages.length)} more</p>` : ""}
        ${line}`;
    }

    case "repo": {
      const repo = stats.mostActiveRepo;
      return `<p class="eyebrow">Most active repo</p>
        <p class="repo">${repo ? esc(repoLabel(repo)) : "No standout repo"}</p>
        ${repo ? `<p class="unit">${n(repo.commits)} ${pluralize(repo.commits, "commit")}</p>` : ""}
        <p class="sub">${n(stats.totalStars)} ${pluralize(stats.totalStars, "star")} across ${n(stats.activeRepoCount)} ${pluralize(stats.activeRepoCount, "repo")} you pushed to</p>
        ${line}`;
    }

    case "persona":
      return `<p class="eyebrow">Your coding persona</p>
        <h2 class="persona">${esc(persona.label)}</h2>
        ${line}
        <p class="why">${esc(persona.reasoning)}</p>`;

    case "summary": {
      const top = stats.topLanguages[0];
      const cells: [string, string][] = [
        ["Contributions", n(stats.totalContributions)],
        ["Active days", n(stats.activeDays)],
        ["Longest streak", `${n(stats.longestStreak.length)} ${pluralize(stats.longestStreak.length, "day")}`],
        ["Peak hour", stats.peakHour === null ? "n/a" : formatHour(stats.peakHour)],
        ["Top language", top ? top.name : "n/a"],
        ["Weekends", pct(stats.weekendShare)],
      ];
      return `<div class="card">
          <p class="eyebrow">${esc(stats.login)} / ${stats.year}</p>
          <h2 class="persona small">${esc(persona.label)}</h2>
          <dl class="grid">${cells.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
          <p class="repo-line">${stats.mostActiveRepo ? `Most active: ${esc(repoLabel(stats.mostActiveRepo))}` : "&nbsp;"}</p>
          <p class="mark">git-wrapped</p>
        </div>
        ${line}
        <button type="button" id="replay">Replay</button>`;
    }
  }
}

const CSS = `
:root{--accent:#fde047;--ink:#fff;--soft:rgba(255,255,255,.78)}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0b0b12;color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-tap-highlight-color:transparent}
body{overflow:hidden}
.deck{position:fixed;inset:0;height:100vh;height:100dvh;user-select:none;-webkit-user-select:none}
.slide{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:56px 22px 40px;opacity:0;visibility:hidden;transform:scale(.97);transition:opacity .35s ease,transform .35s ease,visibility 0s linear .35s;overflow:hidden}
.slide.active{opacity:1;visibility:visible;transform:none;transition-delay:0s}
.inner{width:100%;max-width:680px;text-align:center}
.g-intro{background:linear-gradient(135deg,#4f46e5,#9333ea 60%,#db2777)}
.g-total{background:linear-gradient(135deg,#b91c1c,#ea580c)}
.g-heatmap{background:linear-gradient(135deg,#047857,#0d9488)}
.g-streak{background:linear-gradient(135deg,#be123c,#c026d3)}
.g-hours{background:linear-gradient(160deg,#1e1b4b,#4338ca 70%,#6d28d9)}
.g-weekend{background:linear-gradient(135deg,#0369a1,#0e7490)}
.g-languages{background:linear-gradient(135deg,#6b21a8,#c026d3)}
.g-repo{background:linear-gradient(135deg,#0f766e,#2563eb)}
.g-persona{background:linear-gradient(135deg,#312e81,#be185d 70%,#ea580c)}
.g-summary{background:linear-gradient(160deg,#0f172a,#1e3a8a 60%,#4c1d95)}
.eyebrow{margin:0 0 .6rem;font-size:clamp(.8rem,2.6vw,1rem);font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--soft)}
.mega{margin:0;font-size:clamp(4.5rem,23vw,10rem);font-weight:900;line-height:.95;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.unit{margin:.4rem 0 0;font-size:clamp(1.1rem,4.4vw,1.7rem);font-weight:700}
.who{margin:1rem 0 0;font-size:clamp(1.5rem,6vw,2.4rem);font-weight:800}
.handle{margin:.2rem 0 0;color:var(--soft);font-size:1.05rem}
.sub{margin:.7rem 0 0;color:var(--soft);font-size:clamp(.95rem,3.2vw,1.15rem)}
.line{margin:1.6rem auto 0;max-width:30ch;font-size:clamp(1.05rem,3.8vw,1.45rem);font-weight:600;line-height:1.35}
.hint{margin:2.2rem 0 0;color:var(--soft);font-size:.9rem;letter-spacing:.08em;animation:pulse 2.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.chips{list-style:none;display:flex;flex-wrap:wrap;gap:.6rem;justify-content:center;margin:1.6rem 0 0;padding:0}
.chips li{background:rgba(255,255,255,.16);border-radius:999px;padding:.5rem 1rem;font-size:clamp(.9rem,3.2vw,1.05rem)}
.chips b{font-size:1.15em}
.duo{display:flex;gap:2rem;justify-content:center;margin-top:1.4rem;flex-wrap:wrap}
.duo.single{margin-top:1.8rem}
.label{margin:0;color:var(--soft);font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
.big{margin:.25rem 0 0;font-size:clamp(1.4rem,5.4vw,2.1rem);font-weight:800}
.heatmap{width:100%;max-width:min(520px,100%);height:auto;display:block;margin:.6rem auto 0}
.heatmap .c{fill:rgba(255,255,255,.14)}
.heatmap .l1{fill:rgba(255,255,255,.38)}
.heatmap .l2{fill:rgba(255,255,255,.58)}
.heatmap .l3{fill:rgba(255,255,255,.8)}
.heatmap .l4{fill:#fff}
.heatmap .fut{opacity:.35}
.ax{fill:rgba(255,255,255,.8);font-size:10px;font-weight:600}
.hours,.weekdays{width:100%;max-width:560px;height:auto;display:block;margin:1rem auto 0}
.bar-h{fill:rgba(255,255,255,.55)}
.bar-h.peak{fill:var(--accent)}
.peak-label{fill:var(--accent);font-size:13px;font-weight:800}
.langs{list-style:none;margin:.8rem 0 0;padding:0;display:grid;gap:.8rem;text-align:left}
.langs li{display:grid;grid-template-columns:1.6rem minmax(5rem,9rem) 1fr 3rem;align-items:center;gap:.6rem;font-size:clamp(1rem,3.8vw,1.35rem);font-weight:700}
.rank{color:var(--soft);font-variant-numeric:tabular-nums}
.lang{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{display:block;height:.9rem;background:rgba(255,255,255,.18);border-radius:999px;overflow:hidden}
.track i{display:block;height:100%;background:var(--accent);border-radius:999px}
.val{text-align:right;font-variant-numeric:tabular-nums}
.repo{margin:.4rem 0 0;font-size:clamp(1.6rem,7vw,3.4rem);font-weight:900;line-height:1.1;letter-spacing:-.02em;overflow-wrap:anywhere}
.persona{margin:.2rem 0 0;font-size:clamp(3rem,14vw,6.5rem);font-weight:900;line-height:1;letter-spacing:-.03em}
.persona.small{font-size:clamp(1.8rem,7vw,2.8rem);margin:.1rem 0 1rem}
.why{margin:1.2rem auto 0;max-width:38ch;color:var(--soft);font-size:clamp(.9rem,3vw,1.05rem);line-height:1.45}
.card{background:linear-gradient(145deg,rgba(255,255,255,.16),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.25);border-radius:24px;padding:1.4rem 1.2rem 1rem}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.9rem;margin:0}
.grid div{background:rgba(0,0,0,.22);border-radius:14px;padding:.7rem .5rem}
.grid dt{color:var(--soft);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;font-weight:700}
.grid dd{margin:.2rem 0 0;font-size:clamp(1.1rem,4.4vw,1.5rem);font-weight:800;overflow-wrap:anywhere}
.repo-line{margin:1rem 0 0;color:var(--soft);font-size:.95rem;overflow-wrap:anywhere}
.mark{margin:.8rem 0 0;font-size:.75rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.5)}
#replay{margin-top:1.4rem;background:#fff;color:#1e1b4b;border:0;border-radius:999px;padding:.7rem 1.6rem;font:700 1rem inherit;font-family:inherit;cursor:pointer}
.empty{color:var(--soft);margin:1rem 0 0}
.bars{position:fixed;top:max(10px,env(safe-area-inset-top));left:14px;right:14px;display:flex;gap:4px;z-index:5;pointer-events:none}
.bar{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.28);overflow:hidden}
.bar i{display:block;height:100%;width:0;background:#fff;transition:width .3s ease}
@media (min-width:700px) and (min-height:760px){.slide{padding-top:72px}}
@media (max-height:620px){.mega{font-size:clamp(3.5rem,16vw,6rem)}.line{margin-top:1rem}.hint{margin-top:1rem}}
@media (prefers-reduced-motion:reduce){.slide,.bar i{transition:none}.hint{animation:none}}
`;

const SCRIPT = `
(function(){
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  var bars=[].slice.call(document.querySelectorAll('.bar i'));
  var cur=0,swiped=false,sx=0,sy=0;
  function show(i){
    if(i<0||i>=slides.length)return;
    cur=i;
    slides.forEach(function(s,k){s.classList.toggle('active',k===i);s.setAttribute('aria-hidden',k===i?'false':'true');});
    bars.forEach(function(b,k){b.style.width=k<=i?'100%':'0%';});
    try{history.replaceState(null,'','#'+(i+1));}catch(e){}
  }
  var start=parseInt((location.hash||'').slice(1),10);
  show(start>=1&&start<=slides.length?start-1:0);
  var deck=document.getElementById('deck');
  deck.addEventListener('click',function(e){
    if(e.target.closest('a,button')||swiped)return;
    if(e.clientX<window.innerWidth*0.3)show(cur-1);else show(cur+1);
  });
  deck.addEventListener('touchstart',function(e){sx=e.touches[0].clientX;sy=e.touches[0].clientY;},{passive:true});
  deck.addEventListener('touchend',function(e){
    var dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)){swiped=true;show(dx<0?cur+1:cur-1);setTimeout(function(){swiped=false;},400);}
  },{passive:true});
  document.addEventListener('keydown',function(e){
    var k=e.key;
    if(k==='ArrowRight'||k===' '||k==='Enter'||k==='PageDown'){e.preventDefault();show(cur+1);}
    else if(k==='ArrowLeft'||k==='PageUp'||k==='Backspace'){e.preventDefault();show(cur-1);}
    else if(k==='Home'){show(0);}
    else if(k==='End'){show(slides.length-1);}
  });
  var replay=document.getElementById('replay');
  if(replay)replay.addEventListener('click',function(){show(0);});
})();
`;

/** Render the whole wrapped as one self-contained HTML document: inline CSS, inline JS, inline SVG, no network. */
export function renderHtml(input: RenderInput): string {
  const { stats } = input;
  const title = `${stats.login}'s ${stats.year} Git Wrapped`;
  const slides = SLIDE_IDS.map(
    (id, i) =>
      `<section class="slide g-${id}" id="slide-${id}" data-slide="${i + 1}" aria-label="${esc(`Slide ${i + 1} of ${SLIDE_IDS.length}`)}"><div class="inner">${slideBody(id, input)}</div></section>`,
  ).join("\n");
  const bars = SLIDE_IDS.map(() => `<span class="bar"><i></i></span>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0b12">
<title>${esc(title)}</title>
<style>${CSS}</style>
<noscript><style>body{overflow:auto}.deck{position:static;height:auto}.slide{position:relative;opacity:1;visibility:visible;transform:none;min-height:100vh}.bars{display:none}</style></noscript>
</head>
<body>
<div class="bars" aria-hidden="true">${bars}</div>
<main class="deck" id="deck">
${slides}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
