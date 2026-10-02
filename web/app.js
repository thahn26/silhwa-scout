// 실화탐사대 아이템 레이더 — 화면
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const GROUPS = ["사연·폭로", "남초·이슈", "사고·피해", "SNS", "뉴스·청원", "웹검색"];
const GROUP_COLOR = { "사연·폭로": "var(--g1)", "남초·이슈": "var(--g2)", "사고·피해": "var(--g3)", "뉴스·청원": "var(--g4)", "SNS": "var(--ink)", "웹검색": "var(--g5)" };
const STATUSES = ["검토중", "취재후보", "보류", "탈락"];
const PAGE = 60;

let S = { posts: [], saved: {}, config: {}, jobs: {}, sources: [], webSources: {}, categories: [], claude: {} };
let byId = new Map();
let lastJobsSig = "";
let pollTimer = null;
const schedulePoll = (ms) => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); };

const UI = Object.assign({
  tab: "radar", q: "", range: 24, sort: "ai", min: 0, cats: [], hideGroups: [], hideSrc: [],
  hideFlags: true, showExcluded: false, onlyFirst: false, savedStatus: "", limit: PAGE, report: null,
}, load("ui"));
UI.limit = PAGE;

function load(k) { try { return JSON.parse(localStorage.getItem("ss:" + k) || "{}"); } catch { return {}; } }
function persist() { try { const { limit, report, snsView, ...rest } = UI; localStorage.setItem("ss:ui", JSON.stringify(rest)); } catch {} }

async function api(path, body) {
  const r = await fetch("/api/" + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "요청 실패 (" + r.status + ")");
  return data;
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
}

// ── 데이터 ─────────────────────────────────────────────────

async function refresh() {
  S = await api("state");
  byId = new Map(S.posts.map((p) => [p.id, p]));
  document.body.classList.toggle("noscore", !!S.noScore);
  for (const [id, s] of Object.entries(S.saved)) if (!byId.has(id) && s.post) byId.set(id, s.post);
  lastJobsSig = jobsSig(S.jobs, S.config.lastCrawl, lastChangedAt);
  render();
  checkSnsUpdate();
}

let lastChangedAt = 0;
function jobsSig(jobs, lc, ch) { return JSON.stringify([lc, ch, ...Object.values(jobs).map((j) => [j.running, j.finishedAt])]); }

async function poll() {
  try {
    const { jobs, lastCrawl, version, update, changedAt } = await api("jobs");
    lastChangedAt = changedAt || 0;
    // 서버가 새 버전으로 다시 켜졌으면 화면도 새 버전으로 불러온다
    if (S.version && version && version !== S.version) { location.reload(); return; }
    if (update) S.update = update;
    const sig = jobsSig(jobs, lastCrawl, lastChangedAt);
    const running = Object.values(jobs).some((j) => j.running);
    S.jobs = jobs;
    if (sig !== lastJobsSig) {
      const finished = Object.entries(jobs).filter(([k, j]) => !j.running && j.finishedAt > ((S.jobs_prev || {})[k] || 0));
      await refresh();
      for (const [, j] of finished) if (j.message) toast(j.message);
    } else {
      renderTop();
    }
    S.jobs_prev = Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, j.finishedAt]));
    schedulePoll(running ? 2000 : 15000);
  } catch {
    schedulePoll(5000);
  }
}

// ── 계산 ───────────────────────────────────────────────────

const srcInfo = (id) => {
  const s = S.sources.find((x) => x.id === id);
  if (s) return s;
  const w = S.webSources[id];
  return w ? { id, name: w.name, group: w.group } : { id, name: id, group: "웹검색" };
};
// 판단 결과: Claude 채점(ai)이 있으면 그것, 없으면 Claude 없이 규칙으로 매긴 자동 판단(rule)
const judge = (p) => (p.ai && p.ai.v ? p.ai : p.rule || p.ai || null);
const eff = (p) => (judge(p) ? judge(p).score : p.pre ?? 0);
const when = (p) => p.ts || p.firstSeen || 0;
const isSaved = (id) => !!S.saved[id];

function ago(t) {
  if (!t) return "";
  const s = Date.now() / 1000 - t;
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  if (s < 86400 * 7) return Math.floor(s / 86400) + "일 전";
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
const fmt = (n) => (n == null ? null : n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + "만" : n.toLocaleString());

function scoreClass(p) {
  if (!judge(p)) return "s-pre";
  const s = judge(p).score;
  return s >= 80 ? "s-hot" : s >= 60 ? "s-good" : s >= 40 ? "s-mid" : "s-low";
}

const HIDE_FLAGS = ["연예", "정치", "유머", "해외", "광고"];
const FIRST_HAND = ["당사자", "가족·지인"];
// PD 지시로 빼는 글: AI가 '뉴스퍼옴'·'구속·수사중'으로 판정했거나, 아직 채점 전인데 제목이 뉴스 퍼온 글로 보이는 것
const excludedWhy = (p) => (judge(p) ? judge(p).excluded || "" : "") || (!judge(p) && p.newsLike ? "뉴스퍼옴" : "");

function filtered() {
  const now = Date.now() / 1000;
  const q = UI.q.trim().toLowerCase();
  let list = S.posts.filter((p) => {
    const g = srcInfo(p.source).group;
    if (UI.tab === "blind") { if (p.source !== "blind") return false; }
    else if (UI.snsView) { if (!SNS.includes(p.source)) return false; }
    else if (UI.hideGroups.includes(g) || UI.hideSrc.includes(p.source)) return false;
    if (UI.range && now - Math.max(when(p), p.lastSeen || 0) > UI.range * 3600) return false;
    if (!UI.showExcluded && excludedWhy(p)) return false;
    if (UI.onlyFirst && !FIRST_HAND.includes(judge(p)?.writer)) return false;
    if (!S.noScore && eff(p) < UI.min) return false;  // 윈도우는 최소 점수 칸이 없다
    if (UI.cats.length) {
      const c = judge(p) ? judge(p).category : "미채점";
      if (!UI.cats.includes(c)) return false;
    }
    if (UI.hideFlags && judge(p) && (judge(p).flags || []).some((f) => HIDE_FLAGS.includes(f)) && judge(p).score < 60) return false;
    if (q && !(p.title + " " + (p.excerpt || "") + " " + (p.ai?.reason || "") + " " + (p.ai?.angle || "")).toLowerCase().includes(q)) return false;
    return true;
  });
  const reach = (p) => (p.engagement ?? 0);
  const sorters = {
    ai: (a, b) => (!!b.ai - !!a.ai) || eff(b) - eff(a) || (FIRST_HAND.includes(b.ai?.writer) - FIRST_HAND.includes(a.ai?.writer)) || b.pre - a.pre,
    pre: (a, b) => (b.pre ?? 0) - (a.pre ?? 0),
    hot: (a, b) => reach(b) - reach(a) || (b.comments ?? 0) - (a.comments ?? 0),
    new: (a, b) => when(b) - when(a),
  };
  const sortKey = S.noScore && UI.sort === "pre" ? "ai" : UI.sort;
  list.sort(UI.snsView && UI.tab !== "blind" ? sorters.new : (sorters[sortKey] || sorters.ai));
  return cluster(list);
}

// 같은 이야기가 여러 커뮤니티에 올라온 것을 한 카드로 묶는다(제목 글자쌍 유사도)
function norm(t) {
  return t.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)|\.(jpg|gif|mp4|png|jpeg|webp)|jpg|gif|mp4|ㄷㄷ+|ㅋ+|ㅎ+|[^\p{L}\p{N}]/gu, "");
}
function bigrams(t) { const s = new Set(); for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2)); return s; }
function cluster(list) {
  const grams = list.map((p) => bigrams(norm(p.title)));
  const used = new Uint8Array(list.length);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    const lead = { ...list[i], similar: [] };
    const a = grams[i];
    if (a.size >= 5) {
      for (let j = i + 1; j < list.length; j++) {
        if (used[j]) continue;
        const b = grams[j];
        if (b.size < 5) continue;
        let inter = 0; for (const g of a) if (b.has(g)) inter++;
        const sim = inter / (a.size + b.size - inter);
        // 같은 커뮤니티 안에서는 거의 같은 제목(다시 올린 글)만 묶는다
        if (sim >= (list[j].source === list[i].source ? 0.9 : 0.42)) { used[j] = 1; lead.similar.push(list[j]); }
      }
    }
    out.push(lead);
  }
  return out;
}

// ── 그리기 ─────────────────────────────────────────────────

function render() {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === UI.tab);
  const radar = UI.tab === "radar" || UI.tab === "blind";  // 블라인드 탭은 레이더 화면에서 블라인드 글만 보여 준다
  $("#view-radar").hidden = !radar;
  $("#view-saved").hidden = UI.tab !== "saved";
  $("#view-reports").hidden = UI.tab !== "reports";
  const n = Object.keys(S.saved).length;
  $("#savedCnt").textContent = n ? n : "";
  renderTop();
  if (radar) { renderSide(); renderList(); }
  if (UI.tab === "saved") renderSaved();
  if (UI.tab === "reports") renderReports();
}

function renderTop() {
  const c = S.config || {};
  const lc = c.lastCrawl;
  const next = c.autoInterval ? lc + c.autoInterval * 60 : 0;
  const nextTxt = !c.autoInterval ? "자동 수집 꺼짐" : next * 1000 < Date.now() ? "곧 자동 수집" : `다음 자동 수집 ${Math.max(1, Math.round((next * 1000 - Date.now()) / 60000))}분 뒤`;
  $("#status").innerHTML = lc ? `마지막 수집 <b>${ago(lc)}</b><br>${nextTxt}` : "아직 수집 전";
  const jobs = S.jobs || {};
  const labels = { crawl: "수집", score: "AI 채점", web: "웹검색" };
  $("#btnCrawl").disabled = !!jobs.crawl?.running;
  $("#btnScore").disabled = !!jobs.score?.running || !S.claude?.loggedIn;
  $("#btnWeb").disabled = !!jobs.web?.running || !S.claude?.loggedIn;
  const running = Object.entries(jobs).filter(([, j]) => j.running);
  const bar = $("#jobbar");
  bar.hidden = !running.length;
  bar.innerHTML = running.map(([k, j]) => `<span class="j"><i class="spin"></i><b>${labels[k]}</b> <span class="msg">${esc(j.progress || "진행 중")}</span></span>`).join("");
  const pill = $("#claudePill");
  const cl = S.claude || {};
  pill.className = "pill " + (cl.loggedIn ? "ok" : "bad");
  pill.textContent = cl.loggedIn ? "Claude 연결됨" : cl.found === false ? "Claude 연결하기" : "Claude 로그인하기";
  pill.title = cl.loggedIn ? "Claude 요금제로 채점합니다 (클릭: 상태 새로고침)" : cl.found === false ? "클릭하면 연결 방법을 보여 줍니다" : "클릭하면 로그인 창을 엽니다";
  renderUpdate();
  // Claude가 연결 안 돼 있으면 앱을 열 때마다 위쪽에 안내 띠를 띄운다(닫으면 이번 실행 동안만 숨김)
  const banner = $("#claudeBanner");
  let hidden = false;
  try { hidden = sessionStorage.getItem("ss:cbHide") === "1"; } catch {}
  banner.hidden = !S.claude || cl.loggedIn || hidden;
  if (!banner.hidden) {
    banner.innerHTML = cl.found === false
      ? `<span class="t"><b>지금은 자동 필터로 걸러 보여 드립니다.</b> 피해자 글·뉴스 퍼온 글·구속 사건을 규칙으로 가려요. Claude를 연결하면 AI 채점·심층 분석·보고서도 쓸 수 있습니다.</span>
         <button class="btn red sm" id="cbHelp">연결 방법 보기</button><button class="btn sm" id="cbRecheck">다시 확인</button><button class="btn ghost sm" id="cbClose">닫기</button>`
      : `<span class="t"><b>Claude 로그인이 필요합니다.</b> Claude Code는 찾았어요. Claude Pro/Max 요금제 계정으로 로그인하면 AI 채점을 쓸 수 있습니다.</span>
         <button class="btn red sm" id="cbLogin">로그인하기</button><button class="btn sm" id="cbRecheck">다시 확인</button><button class="btn ghost sm" id="cbClose">닫기</button>`;
  }
}

function renderUpdate() {
  const b = $("#updBanner");
  const ready = S.update?.ready;
  b.hidden = !ready;
  if (ready) b.innerHTML = `<span class="t"><b style="color:var(--blue)">새 버전(${esc(ready)})이 준비됐습니다.</b> 지금 쓰는 버전은 ${esc(S.version)}입니다. 모은 글·찜·메모는 그대로 남습니다.</span>
    <button class="btn primary sm" id="applyUpdate">지금 업데이트</button>`;
}

const SNS = ["threads", "instagram"];
const allSourceIds = () => [...new Set([...S.sources.map((s) => s.id), ...S.posts.map((p) => p.source)])];
const sourcesInGroup = (g) => allSourceIds().filter((id) => srcInfo(id).group === g);

// 스레드·인스타그램 새 글 알림: 마지막으로 확인한 뒤 새로 들어온 글(뉴스 퍼옴·결론 난 사건·광고 제외)이 있으면 창을 띄운다
function snsLatest() { return Math.max(0, ...S.posts.filter((p) => SNS.includes(p.source)).map((p) => p.firstSeen || 0)); }
function markSnsSeen() { try { localStorage.setItem("ss:snsSeen", String(snsLatest())); } catch {} }
function checkSnsUpdate() {
  let seen = null;
  try { seen = localStorage.getItem("ss:snsSeen"); } catch { return; }
  if (seen === null) { markSnsSeen(); return; }  // 처음 켰을 때는 기준만 잡는다
  const fresh = S.posts.filter((p) => SNS.includes(p.source) && (p.firstSeen || 0) > +seen && !excludedWhy(p)
    && !(judge(p)?.flags || []).includes("광고"));
  if (!fresh.length || $("#modalRoot").innerHTML.trim()) return;
  const th = fresh.filter((p) => p.source === "threads").length, ig = fresh.length - th;
  $("#modalRoot").innerHTML = `
    <div class="modal"><div class="box" style="width:min(420px,100%);text-align:center;padding:26px 24px">
      <div style="font-size:30px;line-height:1">🔔</div>
      <h3 style="margin:10px 0 6px">스레드, 인스타그램 글이 업데이트 되었습니다</h3>
      <p class="hint" style="margin:0 0 18px">새 글 ${fresh.length}건 (스레드 ${th} · 인스타그램 ${ig})</p>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn red" id="snsNow">지금 볼랭</button><button class="btn" id="snsLater">나중에 볼게~</button>
      </div>
    </div></div>`;
}

async function recheckClaude(quiet) {
  S.claude = await api("claude/status");
  renderTop();
  if (S.claude.loggedIn) { if ($("#claudeHelpBox")) $("#modalRoot").innerHTML = ""; if (!quiet) toast("Claude가 연결됐습니다"); }
  else if (!quiet) toast(S.claude.found === false ? "아직 Claude Code를 찾지 못했습니다" : "Claude Code는 찾았고, 로그인이 필요합니다");
  return S.claude;
}

let loginWatch = null;
async function claudeLogin() {
  try { await api("claude/login", {}); } catch (e) { toast(e.message); return; }
  toast(S.platform === "windows" ? "새로 열린 검은 창의 안내대로 로그인해 주세요. 끝나면 자동으로 확인합니다"
                                 : "터미널 창의 안내대로 로그인해 주세요. 끝나면 자동으로 확인합니다");
  clearInterval(loginWatch);
  let n = 0;
  loginWatch = setInterval(async () => {
    n++;
    const st = await recheckClaude(true).catch(() => ({}));
    if (st.loggedIn) { clearInterval(loginWatch); toast("Claude가 연결됐습니다"); }
    else if (n >= 36) clearInterval(loginWatch);  // 3분 동안 5초마다 확인
  }, 5000);
}

function renderSide() {
  const bySrc = {};
  const now = Date.now() / 1000;
  for (const p of S.posts) if (!UI.range || now - Math.max(when(p), p.lastSeen || 0) <= UI.range * 3600) bySrc[p.source] = (bySrc[p.source] || 0) + 1;
  const groups = {};
  for (const s of S.sources) (groups[s.group] = groups[s.group] || []).push(s);
  const webIds = [...new Set(S.posts.filter((p) => p.web).map((p) => p.source))];
  for (const id of webIds) { const w = srcInfo(id); (groups[w.group] = groups[w.group] || []).push(w); }
  const disabled = S.config.disabled || [];
  const cats = [...S.categories, "미채점"];
  const excludedCount = S.posts.filter((p) => excludedWhy(p) && (!UI.range || now - Math.max(when(p), p.lastSeen || 0) <= UI.range * 3600)).length;
  $("#side").innerHTML = `
    <input class="search" id="q" placeholder="제목·내용 검색" value="${esc(UI.q)}">
    <h4>기간</h4>
    <div class="seg" data-k="range">${[[6, "6시간"], [24, "24시간"], [72, "3일"], [168, "7일"]].map(([v, l]) => `<button data-v="${v}" class="${UI.range == v ? "on" : ""}">${l}</button>`).join("")}</div>
    <h4>정렬</h4>
    <div class="seg" data-k="sort">${(S.noScore ? [["ai", "추천순"], ["hot", "반응"], ["new", "최신"]] : [["ai", "점수"], ["pre", "예비"], ["hot", "반응"], ["new", "최신"]]).map(([v, l]) => `<button data-v="${v}" class="${UI.sort == v ? "on" : ""}">${l}</button>`).join("")}</div>
    ${S.noScore ? "" : `<h4>최소 점수 <span>${UI.min}</span></h4>
    <input type="range" id="min" min="0" max="90" step="5" value="${UI.min}">`}
    <label class="toggle"><input type="checkbox" id="onlyFirst" ${UI.onlyFirst ? "checked" : ""}> 피해자·가족이 쓴 글만</label>
    <label class="toggle"><input type="checkbox" id="hideFlags" ${UI.hideFlags ? "checked" : ""}> 연예·정치·유머·해외·광고 숨기기</label>
    <label class="toggle" title="뉴스를 퍼 온 글, 이미 구속·수사 중인 사건"><input type="checkbox" id="showExcluded" ${UI.showExcluded ? "checked" : ""}> 제외된 글도 보기 <span class="hint">(${excludedCount.toLocaleString()}건)</span></label>
    <h4>분류 ${UI.cats.length ? `<a id="catClear">전체</a>` : ""}</h4>
    <div class="chips">${cats.map((c) => `<button class="chip ${UI.cats.includes(c) ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <h4>커뮤니티 <span><a id="srcAll">전체 선택</a> · <a id="srcNone">전체 해제</a></span></h4>
    ${GROUPS.filter((g) => groups[g]).map((g) => `
      <div class="srcgroup">
        <label><input type="checkbox" data-group="${esc(g)}" ${!UI.hideGroups.includes(g) && groups[g].some((s) => !UI.hideSrc.includes(s.id)) ? "checked" : ""}><i class="gdot" style="background:${GROUP_COLOR[g]}"></i>${esc(g)}</label>
        ${groups[g].map((s) => `<label class="src"><input type="checkbox" data-src="${s.id}" ${UI.hideSrc.includes(s.id) ? "" : "checked"}>${esc(s.name)}
          ${disabled.includes(s.id) ? `<span class="n">수집 꺼짐</span>` : s.error ? `<span class="err" title="${esc(s.error)}">실패</span>` : `<span class="n">${bySrc[s.id] || 0}</span>`}</label>`).join("")}
      </div>`).join("")}
    <p class="hint">스레드·청원·인스티즈·뽐뿌는 직접 읽을 수 없어 위쪽 <b>웹검색</b> 버튼으로 찾아옵니다.</p>`;
}

function reactions(p) {
  const r = [];
  if (p.views != null) r.push("조회 " + fmt(p.views));
  if (p.likes != null) r.push("추천 " + fmt(p.likes));
  if (p.comments != null) r.push("댓글 " + fmt(p.comments));
  if (!r.length && p.rank) r.push("인기 " + p.rank + "위");
  return r.join(" · ");
}

function scoreBox(p) {
  if (S.noScore) return "";  // 윈도우: 점수 숫자 없이 순서로만 보여 준다(사용자 요청)
  if (p.ai && p.ai.v) return `<div class="score ${scoreClass(p)}" title="Claude AI 채점">${p.ai.score}<small>AI</small></div>`;
  if (p.rule) return `<div class="score ${scoreClass(p)} s-rule" title="Claude 없이 규칙(피해자 표현·사건 분류·반응)으로 매긴 자동 점수">${p.rule.score}<small>자동</small></div>`;
  if (p.ai) return `<div class="score ${scoreClass(p)}" title="예전 기준 AI 채점">${p.ai.score}<small>AI·구</small></div>`;
  return `<div class="score s-pre" title="키워드·반응으로 매긴 예비 점수">${p.pre ?? 0}<small>예비</small></div>`;
}

// 카드 아래 판단 설명 한두 줄
function judgeLines(p) {
  if (p.ai && p.ai.v) return `<div class="ai">${p.ai.reason ? `<span class="r">${esc(p.ai.reason)}</span>` : ""}${p.ai.angle ? `<span class="a">${esc(p.ai.angle)}</span>` : ""}</div>`;
  if (p.rule && p.rule.reason) return `<div class="ai"><span class="r2">${esc(p.rule.reason)}</span></div>`;
  return "";
}

function metaLine(p) {
  const s = srcInfo(p.source);
  const now = Date.now() / 1000;
  const isNew = p.firstSeen && now - p.firstSeen < 3 * 3600 && (p.seenCount || 1) <= 1;
  return `<span class="srcchip"><i class="gdot" style="background:${GROUP_COLOR[s.group] || "var(--ink-3)"}"></i>${esc(s.name)}</span>
    ${FIRST_HAND.includes(judge(p)?.writer) ? `<span class="writer">${judge(p).writer === "당사자" ? "피해자 본인 글" : "가족·지인 글"}</span>` : ""}
    ${excludedWhy(p) ? `<span class="excl">제외: ${esc(excludedWhy(p) === "뉴스퍼옴" ? "뉴스 퍼온 글" : "이미 결론 난 사건")}</span>` : ""}
    ${judge(p) && judge(p).category && judge(p).category !== "해당없음" ? `<span class="cat">${esc(judge(p).category)}</span>` : ""}
    ${(judge(p)?.flags || []).map((f) => `<span class="flag">${esc(f)}</span>`).join("")}
    ${isNew ? `<span class="new">NEW</span>` : ""}
    <span>${esc(ago(when(p)))}</span>
    <span class="nums">${esc(reactions(p))}</span>
    ${p.category && !p.web ? `<span>${esc(p.category)}</span>` : ""}`;
}

function card(p) {
  const ex = p.excerpt && p.excerpt !== p.title ? `<div class="excerpt">${esc(p.excerpt)}</div>` : "";
  const ai = judgeLines(p);
  const sim = p.similar?.length
    ? `<div class="similar">같은 이야기 ${p.similar.length}곳 더: ${p.similar.slice(0, 6).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(srcInfo(s.source).name)}</a>`).join("")}</div>` : "";
  return `<article class="card" data-id="${p.id}">
    ${scoreBox(p)}
    <div>
      <div class="meta">${metaLine(p)}</div>
      <a class="title" data-open="${p.id}">${esc(p.title)}</a>
      ${ex}${ai}${sim}
    </div>
    <div class="acts">
      <button class="star ${isSaved(p.id) ? "on" : ""}" data-star="${p.id}" title="찜">${isSaved(p.id) ? "★" : "☆"}</button>
      <a class="btn sm" href="${esc(p.url)}" target="_blank" rel="noopener" title="원문 열기">원문</a>
    </div>
  </article>`;
}

function renderList() {
  const list = filtered();
  const scored = S.posts.filter((p) => p.ai).length;
  const el = $("#list");
  if (!S.posts.length) {
    el.innerHTML = `<div class="empty"><b>아직 모은 글이 없습니다</b>위쪽 <b style="display:inline">지금 수집</b>을 누르면 커뮤니티 19곳의 인기글을 가져옵니다.</div>`;
    return;
  }
  el.innerHTML = `
    ${UI.snsView && UI.tab !== "blind" ? `<div class="bar" style="background:var(--blue-soft)"><b style="flex:1">스레드·인스타그램 글만 최신순으로 보는 중 · ${list.length.toLocaleString()}건</b><button class="btn sm" id="snsExit">전체 보기로 돌아가기</button></div>` : ""}
    <div class="listhead"><h2>${UI.tab === "blind" ? "블라인드" : UI.snsView ? "스레드·인스타그램" : "아이템 후보"}</h2><span class="sub">${list.length.toLocaleString()}건 · 전체 ${S.posts.length.toLocaleString()}건 중 AI 채점 ${scored.toLocaleString()}건</span></div>
    ${list.length ? list.slice(0, UI.limit).map(card).join("") : `<div class="empty"><b>조건에 맞는 글이 없습니다</b>기간을 늘리거나 최소 점수·분류 필터를 풀어 보세요.</div>`}
    ${list.length > UI.limit ? `<div class="more"><button class="btn" id="moreBtn">더 보기 (${(list.length - UI.limit).toLocaleString()}건 남음)</button></div>` : ""}`;
}

// ── 찜 ────────────────────────────────────────────────────

function savedList() {
  return Object.entries(S.saved)
    .map(([id, s]) => ({ id, s, p: byId.get(id) || s.post }))
    .filter((x) => x.p && (!UI.savedStatus || x.s.status === UI.savedStatus))
    .sort((a, b) => STATUSES.indexOf(a.s.status) - STATUSES.indexOf(b.s.status) || eff(b.p) - eff(a.p));
}

const reportPick = new Set();

function renderSaved() {
  const all = Object.values(S.saved);
  const list = savedList();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((x) => x.status === s).length]));
  $("#savedView").innerHTML = `
    <div class="listhead"><h2>찜한 아이템</h2><span class="sub">${all.length}건 · 체크한 아이템으로 회의용 보고서를 만듭니다</span></div>
    <div class="bar">
      <div class="seg" id="stSeg" style="min-width:340px">${[["", "전체 " + all.length], ...STATUSES.map((s) => [s, s + " " + counts[s]])].map(([v, l]) => `<button data-v="${v}" class="${UI.savedStatus === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <input type="text" id="reportNote" placeholder="보고서 요청사항 (예: 이번 주 회의용, 3개만 추려줘)">
      <button class="btn red" id="makeReport" ${reportPick.size ? "" : "disabled"}>보고서 만들기${reportPick.size ? ` (${reportPick.size})` : ""}</button>
    </div>
    ${list.length ? list.map(({ id, s, p }) => `
      <article class="card" style="display:block">
        <div class="savedrow">
          <input type="checkbox" data-pick="${id}" ${reportPick.has(id) ? "checked" : ""} style="margin-top:18px">
          ${scoreBox(p)}
          <div>
            <div class="meta">${metaLine(p)}</div>
            <a class="title" data-open="${id}">${esc(p.title)}</a>
            ${judgeLines(p)}
            <div class="meta" style="margin-top:8px">
              <select class="statusSel st-${esc(s.status)}" data-status="${id}">${STATUSES.map((x) => `<option ${x === s.status ? "selected" : ""}>${x}</option>`).join("")}</select>
              <span>찜 ${ago(s.savedAt)}</span>
              ${s.analysis || p.analysis ? `<span class="cat">AI 분석 있음</span>` : ""}
              <a href="${esc(p.url)}" target="_blank" rel="noopener">원문 ↗</a>
              <button class="btn ghost sm" data-unsave="${id}">찜 해제</button>
            </div>
          </div>
          <div class="memo"><textarea data-memo="${id}" placeholder="취재 메모 (제보자 연락 여부, 확인할 것 등)">${esc(s.memo)}</textarea></div>
        </div>
      </article>`).join("") : `<div class="empty"><b>찜한 아이템이 없습니다</b>레이더에서 ☆를 눌러 후보를 모아 두세요.</div>`}`;
}

// ── 보고서 ─────────────────────────────────────────────────

let reports = [];
async function renderReports() {
  const el = $("#reportsView");
  el.innerHTML = `<div class="hint">불러오는 중…</div>`;
  reports = await api("reports");
  if (!reports.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>아직 만든 보고서가 없습니다</b>찜한 아이템 탭에서 아이템을 체크하고 <b style="display:inline">보고서 만들기</b>를 누르세요.</div>`;
    return;
  }
  const cur = reports.find((r) => r.id === UI.report) || reports[0];
  UI.report = cur.id;
  el.innerHTML = `
    <div class="replist">${reports.map((r) => `<button data-rep="${r.id}" class="${r.id === cur.id ? "on" : ""}"><b>${esc(firstLine(r.markdown))}</b><small>${new Date(r.at * 1000).toLocaleString("ko-KR")} · ${r.items.length}건</small></button>`).join("")}</div>
    <div>
      <div class="bar"><b style="flex:1">${new Date(cur.at * 1000).toLocaleString("ko-KR")} 보고서</b>
        <button class="btn" id="copyRep">복사</button><button class="btn" id="dlRep">.md 저장</button></div>
      <div class="paper md">${md(cur.markdown)}</div>
    </div>`;
}
const firstLine = (m) => (m.split("\n").find((l) => l.trim()) || "보고서").replace(/^#+\s*/, "").slice(0, 40);

function md(src) {
  const lines = esc(src || "").split("\n");
  let html = "", inList = false;
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  for (const raw of lines) {
    const l = raw.trimEnd();
    const li = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inline(li[1].replace(/^\[ \]\s*/, "☐ ").replace(/^\[x\]\s*/i, "☑ ")) + "</li>";
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (/^---+$/.test(l)) html += "<hr>";
    else if (l.trim()) html += "<p>" + inline(l) + "</p>";
  }
  if (inList) html += "</ul>";
  return html;
}

// ── 서랍(본문·분석·메모) ───────────────────────────────────

let drawerId = null;
async function openDrawer(id) {
  const p = byId.get(id);
  if (!p) return;
  drawerId = id;
  const s = S.saved[id];
  const d = $("#drawer");
  d.innerHTML = `
    <header>
      <button class="btn ghost sm x" id="closeDrawer">닫기 ✕</button>
      <div class="meta">${metaLine(p)}</div>
      <h3>${esc(p.title)}</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn ${s ? "" : "red"}" data-star="${id}">${s ? "★ 찜함" : "☆ 찜하기"}</button>
        <a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">원문 열기 ↗</a>
        <button class="btn primary" id="analyze" ${S.claude?.loggedIn ? "" : "disabled"}>AI 심층 분석</button>
      </div>
    </header>
    <div class="body">
      ${judge(p) ? `<div class="sect"><h5>${p.ai && p.ai.v ? "AI 1차 판단" : "자동 판단(Claude 없이)"}${S.noScore ? "" : ` · ${judge(p).score}점`}</h5>${judgeLines(p).replace('class="ai"', 'class="ai" style="margin:0"')}</div>` : ""}
      ${s ? `<div class="sect"><h5>취재 메모</h5><textarea data-memo="${id}" rows="4" placeholder="메모">${esc(s.memo)}</textarea>
        <div style="margin-top:6px"><select class="statusSel" data-status="${id}">${STATUSES.map((x) => `<option ${x === s.status ? "selected" : ""}>${x}</option>`).join("")}</select></div></div>` : ""}
      <div class="sect" id="anaSect" ${p.analysis || s?.analysis ? "" : "hidden"}><h5>AI 심층 분석</h5><div class="md" id="anaBox">${md((p.analysis || s?.analysis)?.text || "")}</div></div>
      <div class="sect"><h5>본문</h5><div class="bodytext" id="bodyBox"><span class="hint"><i class="spin"></i> 본문 가져오는 중…</span></div></div>
      ${p.similar?.length ? `<div class="sect"><h5>같은 이야기, 다른 곳</h5>${p.similar.map((x) => `<div><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(srcInfo(x.source).name)} — ${esc(x.title)}</a></div>`).join("")}</div>` : ""}
    </div>`;
  d.classList.add("open");
  $("#scrim").hidden = false;
  try {
    const r = await api("body", { id });
    if (drawerId !== id) return;
    $("#bodyBox").textContent = r.body || "(본문을 찾지 못했습니다. 원문을 열어 확인하세요.)";
    if (r.analysis && $("#anaSect").hidden) { $("#anaBox").innerHTML = md(r.analysis.text); $("#anaSect").hidden = false; }
  } catch (e) {
    if (drawerId === id) $("#bodyBox").innerHTML = `<span class="hint">${esc(e.message)}</span>`;
  }
}
function closeDrawer() { drawerId = null; $("#drawer").classList.remove("open"); $("#scrim").hidden = true; }

// ── 설정 ───────────────────────────────────────────────────

function openSettings() {
  const c = S.config;
  const dis = new Set(c.disabled || []);
  $("#modalRoot").innerHTML = `
    <div class="modal" id="modal"><div class="box">
      <h3>설정</h3>
      <div class="form">
        <label class="k">자동 수집</label>
        <div><select id="setInterval">${[[0, "끄기"], [30, "30분마다"], [60, "1시간마다"], [120, "2시간마다"], [180, "3시간마다"]].map(([v, l]) => `<option value="${v}" ${c.autoInterval == v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <span class="hint">앱이 켜져 있는 동안만 돕니다. 앱을 열면 간격이 지났을 때 바로 수집합니다.</span></div>
        <label class="k">수집 뒤 AI 채점</label>
        <label class="toggle"><input type="checkbox" id="setAutoScore" ${c.autoScore ? "checked" : ""}> 새 후보를 바로 채점</label>
        <label class="k">채점 전 본문 읽기</label>
        <label class="toggle"><input type="checkbox" id="setReadBody" ${c.readBody ? "checked" : ""}> 본문 앞부분까지 보고 채점 (정확, 조금 느림)</label>
        <label class="k">한 번에 채점할 수</label>
        <div><input type="number" id="setTopN" min="5" max="200" value="${c.aiTopN}" style="width:80px;padding:6px 8px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface)"> <span class="hint">예비 점수 상위부터. 많을수록 요금제 사용량이 늘어요.</span></div>
        <label class="k">Claude 모델</label>
        <div><select id="setModel">${[["sonnet", "Sonnet (권장)"], ["opus", "Opus (정밀, 느림)"], ["haiku", "Haiku (빠름)"]].map(([v, l]) => `<option value="${v}" ${c.model === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <label class="k full">채점 기준 <span class="hint">— 프로그램 성격이나 이번 시즌 방향에 맞게 고치면 AI 채점에 그대로 반영됩니다.</span></label>
        <div class="full"><textarea id="setCriteria" rows="12">${esc(c.criteria)}</textarea>
          <button class="btn sm" id="resetCriteria" style="margin-top:6px">기본값으로</button></div>
        <label class="k full">항상 적용되는 규칙 <span class="hint">— 위 채점 기준과 함께 매번 Claude에게 전달됩니다.</span></label>
        <div class="full bodytext" style="max-height:none;font-size:13px">${esc(S.filterRules || "")}</div>
        <label class="k full">윈도우와 공유 <span class="hint">— 이 컴퓨터가 로그인해서 모은 스레드·인스타그램 글을 GitHub로 올려 다른 PC(윈도우)가 받아 가게 합니다. 대표 컴퓨터 한 대에만 넣으세요.</span></label>
        <div class="full">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="password" id="setFeedToken" autocomplete="off" placeholder="${c.feedTokenSet ? "토큰 저장됨 — 바꾸려면 새로 붙여 넣기" : "GitHub 토큰 붙여 넣기 (github_pat_…)"}" style="flex:1;min-width:260px;padding:7px 10px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface)">
            ${c.feedTokenSet ? `<button class="btn sm" id="clearFeedToken">토큰 지우기</button>` : ""}
          </div>
          <div class="hint" style="margin-top:6px">${esc(feedStatus())}</div>
        </div>
        ${S.platform === "mac" && S.mobileUrl ? `
        <label class="k full">휴대폰 앱 <span class="hint">— 갤럭시에서 아래 주소를 열고 브라우저 메뉴의 '홈 화면에 추가'를 누르면 앱처럼 씁니다. 목록은 이 앱이 켜져 있을 때 20분마다 올라갑니다.</span></label>
        <div class="full" style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
          <div id="mobileQr" style="background:#fff;padding:8px;border-radius:8px;line-height:0"></div>
          <div style="flex:1;min-width:240px">
            <div><a href="${esc(S.mobileUrl)}" target="_blank" rel="noopener" style="font-weight:700;color:var(--blue)">${esc(S.mobileUrl)}</a></div>
            <div class="hint" style="margin-top:8px">찜·메모 동기화 저장소(비공개)</div>
            <input id="setSyncRepo" value="${esc(c.syncRepo || "")}" style="width:100%;max-width:320px;padding:6px 9px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface)">
            <div class="hint" style="margin-top:6px">${esc(syncStatus())}</div>
          </div>
        </div>` : ""}
        <label class="k full">수집할 커뮤니티</label>
        <div class="full srcgrid">${S.sources.map((s) => `<label class="toggle"><input type="checkbox" data-en="${s.id}" ${dis.has(s.id) ? "" : "checked"}>${esc(s.name)}</label>`).join("")}</div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <span class="hint" style="margin-right:auto">버전 ${esc(S.version || "")}</span>
        <button class="btn" id="cancelSet">취소</button><button class="btn primary" id="saveSet">저장</button>
      </div>
    </div></div>`;
  drawQr();
}

function openClaudeHelp() {
  const win = S.platform === "windows";
  const steps = win ? `
      <li>시작 메뉴에서 <b>PowerShell</b>을 엽니다.</li>
      <li>아래 한 줄을 붙여 넣고 Enter를 누릅니다.<div class="bodytext" style="margin:6px 0;user-select:all">irm https://claude.ai/install.ps1 | iex</div></li>
      <li>'Git for Windows가 필요하다'는 안내가 나오면 <a href="https://git-scm.com/download/win" target="_blank" rel="noopener">git-scm.com</a>에서 설치한 뒤 2번을 다시 합니다.</li>
      <li>설치가 끝나면 아래 <b>다시 확인</b>을 누릅니다. 버튼이 <b>Claude 로그인하기</b>로 바뀌면 눌러서 로그인합니다.</li>` : `
      <li><a href="https://claude.ai/download" target="_blank" rel="noopener">Claude 데스크톱 앱</a>을 설치하고 로그인합니다. (또는 터미널에서 <code>curl -fsSL https://claude.ai/install.sh | bash</code>)</li>
      <li>설치가 끝나면 아래 <b>다시 확인</b>을 누릅니다. 버튼이 <b>Claude 로그인하기</b>로 바뀌면 눌러서 로그인합니다.</li>`;
  $("#modalRoot").innerHTML = `
    <div class="modal"><div class="box md" id="claudeHelpBox">
      <h3>AI 채점을 쓰려면 Claude Code가 필요합니다</h3>
      <p>수집·예비 점수·찜·메모는 지금도 됩니다. AI 채점, 심층 분석, 보고서는 이 PC에 Claude Code를 설치하고 <b>Claude Pro/Max 요금제</b> 계정으로 로그인해야 쓸 수 있습니다.</p>
      <ol>${steps}</ol>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn" id="claudeRecheck">다시 확인</button><button class="btn primary" id="cancelSet">닫기</button></div>
    </div></div>`;
}

function syncStatus() {
  const y = S.sync || {};
  if (!S.config.feedTokenSet) return "위 GitHub 토큰을 넣으면 휴대폰과 찜·메모를 주고받습니다.";
  if (y.error) return "동기화 오류: " + y.error;
  return y.lastSync ? `휴대폰과 연동됨 — 마지막 동기화 ${ago(y.lastSync)} · 찜 ${y.count}건` : "곧 동기화합니다";
}

function drawQr() {
  const el = $("#mobileQr");
  if (!el || !S.mobileUrl) return;
  const draw = () => {
    const qr = window.qrcode(0, "M"); qr.addData(S.mobileUrl); qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
  };
  if (window.qrcode) return draw();
  const sc = document.createElement("script");
  sc.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js";
  sc.onload = draw;
  document.head.appendChild(sc);
}

function feedStatus() {
  const f = S.feed || {};
  if (f.error) return "공유 오류: " + f.error;
  if (f.role === "producer") return f.lastPublish ? `대표 컴퓨터 — 마지막으로 올림 ${ago(f.lastPublish)} · SNS ${f.count}건${f.mobileCount ? ` · 휴대폰 목록 ${f.mobileCount}건` : ""}` : "대표 컴퓨터 — 아직 올린 적 없음";
  if (f.role === "consumer") return f.lastFetch ? `받는 컴퓨터 — 마지막으로 받음 ${ago(f.lastFetch)} · ${f.count}건` : "받는 컴퓨터 — 곧 받아 옵니다";
  return "";
}

async function saveSettings() {
  const tok = $("#setFeedToken")?.value.trim();
  const body = {
    autoInterval: +$("#setInterval").value, autoScore: $("#setAutoScore").checked, readBody: $("#setReadBody").checked,
    aiTopN: +$("#setTopN").value || 40, model: $("#setModel").value, criteria: $("#setCriteria").value,
    disabled: [...document.querySelectorAll("[data-en]")].filter((x) => !x.checked).map((x) => x.dataset.en),
  };
  if (tok) body.feedToken = tok;
  const sr = $("#setSyncRepo")?.value.trim();
  if (sr && sr !== S.config.syncRepo) body.syncRepo = sr;
  S.config = await api("settings", body);
  $("#modalRoot").innerHTML = "";
  toast("설정을 저장했습니다");
  render();
}

// ── 동작 ───────────────────────────────────────────────────

async function toggleStar(id) {
  const on = !isSaved(id);
  const r = await api("save", on ? { id } : { id, saved: false });
  if (on) S.saved[id] = r; else { delete S.saved[id]; reportPick.delete(id); }
  toast(on ? "찜했습니다 — 찜한 아이템 탭에서 메모를 남길 수 있어요" : "찜을 해제했습니다");
  render();
  if (drawerId === id) openDrawer(id);
}

const memoTimers = {};
function saveMemo(id, memo) {
  clearTimeout(memoTimers[id]);
  memoTimers[id] = setTimeout(async () => {
    const r = await api("save", { id, memo });
    S.saved[id] = r;
  }, 600);
}

async function startJob(kind, body = {}) {
  try {
    const r = await api(kind, body);
    if (r && r.started === false) toast("이미 진행 중입니다");
    S.jobs[{ crawl: "crawl", score: "score", websearch: "web" }[kind]].running = true;
    renderTop();
    schedulePoll(800);
  } catch (e) { toast(e.message); }
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a, [data-open]");
  if (!t) return;
  if (t.dataset.tab) { UI.tab = t.dataset.tab; persist(); render(); return; }
  if (t.dataset.open) { e.preventDefault(); openDrawer(t.dataset.open); return; }
  if (t.dataset.star) { toggleStar(t.dataset.star); return; }
  if (t.dataset.unsave) { toggleStar(t.dataset.unsave); return; }
  if (t.dataset.rep) { UI.report = t.dataset.rep; renderReports(); return; }
  if (t.dataset.cat) { const c = t.dataset.cat; UI.cats = UI.cats.includes(c) ? UI.cats.filter((x) => x !== c) : [...UI.cats, c]; UI.limit = PAGE; persist(); render(); return; }
  const seg = t.closest(".seg[data-k]");
  if (seg && t.dataset.v !== undefined) { UI[seg.dataset.k] = seg.dataset.k === "range" ? +t.dataset.v : t.dataset.v; UI.limit = PAGE; persist(); render(); return; }
  if (t.closest("#stSeg") && t.dataset.v !== undefined) { UI.savedStatus = t.dataset.v; persist(); renderSaved(); return; }
  switch (t.id) {
    case "btnCrawl": return startJob("crawl");
    case "btnScore": return startJob("score");
    case "btnWeb": {
      const q = prompt("웹검색으로 스레드·국민동의청원·인스티즈·뽐뿌 등을 찾습니다.\n특정 주제가 있으면 입력하세요 (비우면 전체 화제글).", "");
      if (q === null) return;
      return startJob("websearch", { query: q });
    }
    case "claudePill": {
      const st = await recheckClaude(true);
      if (st.loggedIn) toast("Claude가 연결되어 있습니다");
      else if (st.found === false) openClaudeHelp();
      else claudeLogin();
      return;
    }
    case "applyUpdate":
      t.disabled = true; t.innerHTML = `<i class="spin"></i> 업데이트 중`;
      try { await api("update/apply", {}); toast("새 버전으로 다시 켜는 중입니다. 잠시 후 화면이 새로고침됩니다"); schedulePoll(2000); }
      catch (err) { toast(err.message); t.disabled = false; t.textContent = "지금 업데이트"; }
      return;
    case "cbHelp": return openClaudeHelp();
    case "cbLogin": return claudeLogin();
    case "cbRecheck": case "claudeRecheck": return recheckClaude(false);
    case "cbClose": try { sessionStorage.setItem("ss:cbHide", "1"); } catch {} renderTop(); return;
    case "btnSettings": return openSettings();
    case "cancelSet": $("#modalRoot").innerHTML = ""; return;
    case "saveSet": return saveSettings();
    case "resetCriteria": $("#setCriteria").value = S.defaultCriteria; return;
    case "clearFeedToken": S.config = await api("settings", { feedToken: "" }); toast("토큰을 지웠습니다"); openSettings(); return;
    case "closeDrawer": return closeDrawer();
    case "moreBtn": UI.limit += PAGE; renderList(); return;
    case "catClear": UI.cats = []; persist(); render(); return;
    case "srcAll": UI.hideGroups = []; UI.hideSrc = []; UI.limit = PAGE; persist(); render(); return;
    case "srcNone": UI.hideGroups = []; UI.hideSrc = allSourceIds(); UI.limit = PAGE; persist(); render(); return;
    case "snsExit": UI.snsView = false; UI.limit = PAGE; render(); return;
    case "snsNow": markSnsSeen(); $("#modalRoot").innerHTML = ""; closeDrawer(); UI.tab = "radar"; UI.snsView = true; UI.limit = PAGE; render(); window.scrollTo(0, 0); return;
    case "snsLater": markSnsSeen(); $("#modalRoot").innerHTML = ""; return;
    case "analyze": {
      const id = drawerId;
      t.disabled = true; t.innerHTML = `<i class="spin"></i> 분석 중 (1~2분)`;
      try {
        const r = await api("analyze", { id });
        const p = byId.get(id); if (p) p.analysis = r;
        if (S.saved[id]) S.saved[id].analysis = r;
        if (drawerId === id) { $("#anaBox").innerHTML = md(r.text); $("#anaSect").hidden = false; }
      } catch (err) { toast(err.message); }
      if (drawerId === id) { t.disabled = false; t.textContent = "AI 심층 분석 다시"; }
      return;
    }
    case "makeReport": {
      const ids = [...reportPick];
      t.disabled = true; t.innerHTML = `<i class="spin"></i> Claude가 보고서 쓰는 중 (1~3분)`;
      try {
        const r = await api("report", { ids, note: $("#reportNote").value });
        UI.report = r.id; UI.tab = "reports"; reportPick.clear(); render();
      } catch (err) { toast(err.message); t.disabled = false; t.textContent = "보고서 만들기"; }
      return;
    }
    case "copyRep": {
      const r = reports.find((x) => x.id === UI.report);
      await navigator.clipboard.writeText(r.markdown); toast("복사했습니다"); return;
    }
    case "dlRep": {
      const r = reports.find((x) => x.id === UI.report);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown" }));
      a.download = `실화탐사대_아이템보고_${r.id}.md`; a.click(); return;
    }
  }
});

$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("#modalRoot").innerHTML = ""; } });

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "q") { UI.q = t.value; UI.limit = PAGE; persist(); renderList(); return; }
  if (t.id === "min") { UI.min = +t.value; UI.limit = PAGE; persist(); t.previousElementSibling.querySelector("span").textContent = t.value; renderList(); return; }
  if (t.dataset.memo) { S.saved[t.dataset.memo].memo = t.value; saveMemo(t.dataset.memo, t.value); }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "hideFlags") { UI.hideFlags = t.checked; persist(); renderList(); return; }
  if (t.id === "onlyFirst") { UI.onlyFirst = t.checked; UI.limit = PAGE; persist(); renderList(); return; }
  if (t.id === "showExcluded") { UI.showExcluded = t.checked; UI.limit = PAGE; persist(); renderList(); return; }
  if (t.dataset.group) {
    const g = t.dataset.group, ids = sourcesInGroup(g);
    UI.hideGroups = UI.hideGroups.filter((x) => x !== g);
    UI.hideSrc = t.checked ? UI.hideSrc.filter((x) => !ids.includes(x)) : [...new Set([...UI.hideSrc, ...ids])];
    UI.limit = PAGE; persist(); render(); return;
  }
  if (t.dataset.src) {
    const s = t.dataset.src;
    UI.hideSrc = t.checked ? UI.hideSrc.filter((x) => x !== s) : [...UI.hideSrc, s];
    if (t.checked) UI.hideGroups = UI.hideGroups.filter((x) => x !== srcInfo(s).group);
    UI.limit = PAGE; persist(); render(); return;
  }
  if (t.dataset.pick) { t.checked ? reportPick.add(t.dataset.pick) : reportPick.delete(t.dataset.pick); const b = $("#makeReport"); b.disabled = !reportPick.size; b.textContent = "보고서 만들기" + (reportPick.size ? ` (${reportPick.size})` : ""); return; }
  if (t.dataset.status) {
    const id = t.dataset.status;
    S.saved[id] = await api("save", { id, status: t.value });
    if (UI.tab === "saved") renderSaved();
  }
});

// 서버가 앱 창이 열려 있음을 알도록 1분마다 신호를 보낸다
function ping() { fetch("/api/ping", { method: "POST" }).catch(() => {}); }
ping(); setInterval(ping, 60000);
setInterval(renderTop, 30000);

refresh().then(() => { S.jobs_prev = Object.fromEntries(Object.entries(S.jobs).map(([k, j]) => [k, j.finishedAt])); poll(); })
  .catch((e) => { document.body.insertAdjacentHTML("afterbegin", `<div class="jobbar">서버에 연결하지 못했습니다: ${esc(e.message)}</div>`); });
