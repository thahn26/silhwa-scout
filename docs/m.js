// 실화탐사대 — 휴대폰 앱(홈 화면 앱)
// 목록: 노트북 앱이 GitHub feed 브랜치에 올린 docs/feed.json(공개)
// 찜·메모: 비공개 저장소의 saved.json을 노트북 앱과 같이 고친다(글마다 마지막으로 고친 쪽이 이긴다). 토큰은 이 휴대폰에만 저장된다.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const now = () => Date.now() / 1000;
const STATUSES = ["검토중", "취재후보", "보류", "탈락"];
const FIRST_HAND = ["당사자", "가족·지인"];
const GROUP_COLOR = { "사연·폭로": "var(--g1)", "남초·이슈": "var(--g2)", "사고·피해": "var(--g3)", "뉴스·청원": "var(--g4)", "SNS": "var(--ink)", "웹검색": "var(--g5)" };
const PAGE = 40;

const store = {
  get(k, d) { try { const v = localStorage.getItem("m:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("m:" + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("m:" + k); } catch {} },
};

let FEED = store.get("feed", { at: 0, posts: [], sources: {}, syncRepo: "" });
let DOC = store.get("doc", { items: {}, deleted: {} });
let TOKEN = store.get("token", "");
const UI = Object.assign({ tab: "rec", q: "", cat: "", first: false, status: "", hide: [], sorts: {} }, store.get("ui", {}));
// 정렬: 탭마다 따로 기억한다(SNS는 처음엔 최신순, 나머지는 점수순)
const sortOf = (tab) => UI.sorts[tab] || (tab === "sns" ? "new" : "score");
const when = (p) => p.ts || p.firstSeen || 0;
UI.limit = PAGE;
let prevFeedAt = store.get("seenFeedAt", 0);
const SYNC = { state: TOKEN ? "wait" : "off", at: 0, error: "", busy: false, again: false };
let feedBusy = false;
let openId = null;

const repo = () => store.get("repo", "") || FEED.syncRepo || "thahn26/silhwa-scout-sync";
const saveUI = () => { const { limit, ...rest } = UI; store.set("ui", rest); };

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}

function ago(t) {
  if (!t) return "";
  const s = now() - t;
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  if (s < 86400 * 7) return Math.floor(s / 86400) + "일 전";
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
const fmt = (n) => (n == null ? null : n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + "만" : Number(n).toLocaleString());
const scoreClass = (s) => (s >= 80 ? "s-hot" : s >= 60 ? "s-good" : s >= 40 ? "s-mid" : "s-low");

// ── 글 모양 맞추기 ──────────────────────────────────────────
// 목록(feed)의 글은 그대로, 노트북에서 찜한 글(saved.post)은 노트북 형식이라 화면용으로 바꾼다.
function fromPost(id, p) {
  if (!p) return null;
  if (p.mobile) return p;
  const j = p.ai && p.ai.v ? p.ai : p.rule || p.ai || null;
  const src = (FEED.sources || {})[p.source] || [p.source, ""];
  return {
    id, source: p.source, sourceName: src[0], group: src[1], title: p.title, url: p.url, excerpt: p.excerpt || "",
    snippet: p.bodySnippet || "", views: p.views, likes: p.likes, comments: p.comments, timeText: p.timeText || "",
    ts: p.ts || 0, firstSeen: p.firstSeen || 0, score: j ? j.score : p.pre || 0, judge: p.ai && p.ai.v ? "AI" : j ? "자동" : "예비",
    category: j?.category || "", writer: j?.writer || "", reason: j?.reason || "", angle: j?.angle || "", flags: j?.flags || [],
  };
}
const feedById = () => new Map((FEED.posts || []).map((p) => [p.id, p]));
function itemOf(id) {
  return feedById().get(id) || fromPost(id, DOC.items[id]?.post);
}
function snapshot(it) {
  const keep = ["id", "source", "sourceName", "group", "title", "url", "excerpt", "snippet", "views", "likes", "comments",
    "timeText", "ts", "firstSeen", "score", "judge", "category", "writer", "reason", "angle", "flags"];
  return Object.assign({ mobile: true }, Object.fromEntries(keep.map((k) => [k, it[k]])));
}

// ── 목록 받기 ───────────────────────────────────────────────
async function loadFeed(manual) {
  if (feedBusy) return;
  feedBusy = true; $("#reload").classList.add("busy");
  try {
    const r = await fetch("feed.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const f = await r.json();
    if (!prevFeedAt) prevFeedAt = f.at;  // 처음 설치: 전부 '새 글'로 표시하지 않는다
    FEED = f; store.set("feed", f);
    if (manual) toast("목록을 새로 받았어요");
  } catch {
    if (manual) toast("목록을 받지 못했어요. 인터넷 연결을 확인해 주세요");
  } finally {
    feedBusy = false; $("#reload").classList.remove("busy");
    render();
  }
}

// ── 찜·메모 동기화 ─────────────────────────────────────────
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
function b64decode(s) {
  const bin = atob((s || "").replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// 노트북 앱(server.py merge_saved)과 같은 규칙
function merge(local, remote) {
  const li = local.items || {}, ld = local.deleted || {}, ri = remote.items || {}, rd = remote.deleted || {};
  const ts = (e) => e.updatedAt || e.savedAt || 0;
  const items = {}, deleted = {};
  for (const id of new Set([...Object.keys(li), ...Object.keys(ld), ...Object.keys(ri), ...Object.keys(rd)])) {
    const cands = [li[id], ri[id]].filter(Boolean);
    const dead = Math.max(ld[id] || 0, rd[id] || 0);
    const best = cands.sort((a, b) => ts(b) - ts(a))[0];
    if (best && ts(best) > dead) {
      const e = { ...best };
      if (!e.post) { const p = cands.find((c) => c.post); if (p) e.post = p.post; }
      if (!e.analysis) { const a = cands.find((c) => c.analysis); if (a) e.analysis = a.analysis; }
      items[id] = e;
    } else if (dead > now() - 60 * 86400) deleted[id] = dead;
  }
  return { items, deleted };
}

async function gh(path, opt = {}) {
  return fetch("https://api.github.com/repos/" + repo() + path, {
    cache: "no-store", ...opt,
    headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", ...(opt.body ? { "Content-Type": "application/json" } : {}) },
  });
}

async function sync() {
  if (!TOKEN) { SYNC.state = "off"; renderTop(); return; }
  if (SYNC.busy) { SYNC.again = true; return; }
  SYNC.busy = true; SYNC.state = "busy"; renderTop();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let remote = {}, sha = null;
      const r = await gh("/contents/saved.json?t=" + Date.now());
      if (r.status === 401) throw new Error("토큰이 맞지 않거나 기간이 끝났어요. 설정에서 새 토큰을 넣어 주세요");
      if (r.status === 404) {
        const rr = await gh("");
        if (!rr.ok) throw new Error(`저장소 ${repo()}를 찾지 못했어요. 토큰에 이 저장소 권한이 있는지 확인해 주세요`);
      } else if (r.ok) {
        const j = await r.json();
        sha = j.sha;
        remote = JSON.parse(b64decode(j.content) || "{}");
      } else throw new Error("동기화 저장소를 읽지 못했어요 (" + r.status + ")");
      const merged = merge(DOC, remote);
      const changedLocal = canon(merged) !== canon({ items: DOC.items || {}, deleted: DOC.deleted || {} });
      DOC = merged; store.set("doc", DOC);
      if (changedLocal) render();
      if (canon(merged.items) === canon(remote.items || {}) && canon(merged.deleted) === canon(remote.deleted || {})) break;
      const body = { message: "휴대폰에서 찜 " + Object.keys(merged.items).length + "건",
        content: b64encode(JSON.stringify({ version: 1, at: now(), ...merged })) };
      if (sha) body.sha = sha;
      const w = await gh("/contents/saved.json", { method: "PUT", body: JSON.stringify(body) });
      if (w.status === 409 || w.status === 422) continue;  // 그 사이 노트북이 고쳤다 → 다시 합친다
      if (w.status === 403 || w.status === 404) throw new Error("저장소에 쓸 권한이 없어요. 토큰의 Contents 권한을 '읽기·쓰기'로 해 주세요");
      if (!w.ok) throw new Error("동기화하지 못했어요 (" + w.status + ")");
      break;
    }
    SYNC.state = "ok"; SYNC.at = now(); SYNC.error = "";
  } catch (e) {
    SYNC.state = "bad"; SYNC.error = e.message === "Failed to fetch" ? "인터넷에 연결되지 않아 나중에 다시 올려요" : e.message;
  } finally {
    SYNC.busy = false; renderTop();
    if ($("#sheet").dataset.kind === "settings") renderSettings();
    if (SYNC.again) { SYNC.again = false; sync(); }
  }
}
let syncTimer = null;
const queueSync = () => { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 1200); };

function touch(id, patch) {
  const t = now();
  if (patch === null) {
    delete DOC.items[id];
    DOC.deleted[id] = t;
  } else {
    const it = itemOf(id);
    const cur = DOC.items[id] || { savedAt: t, memo: "", status: "검토중", post: it ? snapshot(it) : null };
    DOC.items[id] = { ...cur, ...patch, updatedAt: t };
    delete DOC.deleted[id];
  }
  store.set("doc", DOC);
  queueSync();
}
const isSaved = (id) => !!DOC.items[id];

// ── 화면 ───────────────────────────────────────────────────
function list() {
  const q = UI.q.trim().toLowerCase();
  let rows;
  if (UI.tab === "saved") {
    rows = Object.entries(DOC.items).map(([id, e]) => ({ it: itemOf(id), e })).filter((r) => r.it);
    if (UI.status) rows = rows.filter((r) => (r.e.status || "검토중") === UI.status);
    rows.sort((a, b) => (b.e.updatedAt || b.e.savedAt || 0) - (a.e.updatedAt || a.e.savedAt || 0));
    rows = rows.map((r) => r.it);
  } else {
    rows = (FEED.posts || []).filter(inTab);
    if (UI.cat) rows = rows.filter((p) => p.category === UI.cat);
    if (UI.first) rows = rows.filter((p) => FIRST_HAND.includes(p.writer));
    if (UI.tab !== "blind" && UI.hide.length) rows = rows.filter((p) => !UI.hide.includes(p.source));
    if (sortOf(UI.tab) === "new") rows = rows.slice().sort((a, b) => when(b) - when(a));
  }
  if (q) rows = rows.filter((p) => (p.title + " " + p.excerpt + " " + p.reason + " " + (DOC.items[p.id]?.memo || "")).toLowerCase().includes(q));
  return rows;
}

// 탭별 목록: 추천은 블라인드 탭 전용 추가분(점수 낮은 블라인드 글)을 빼고 본다
const inTab = (p) => (UI.tab === "sns" ? p.sns : UI.tab === "blind" ? p.source === "blind" : !p.extra);

function renderTop() {
  const n = Object.keys(DOC.items).length;
  const sns = (FEED.posts || []).filter((p) => p.sns).length;
  $("#tabs").innerHTML = [["rec", "추천", ""], ["sns", "SNS", sns ? `<span class="cnt">${sns}</span>` : ""], ["blind", "블라인드", ""], ["saved", "찜", n ? `<span class="cnt">${n}</span>` : ""]]
    .map(([k, l, c]) => `<button data-tab="${k}" class="${UI.tab === k ? "on" : ""}">${l}${c}</button>`).join("");
  const dot = SYNC.state === "ok" ? "ok" : SYNC.state === "bad" ? "bad" : "";
  const syncTxt = SYNC.state === "off" ? "찜은 이 폰에만" : SYNC.state === "busy" ? "동기화 중" : SYNC.state === "bad" ? "동기화 오류" : SYNC.state === "ok" ? "노트북과 연동됨" : "연동 준비 중";
  $("#sub").innerHTML = (FEED.at ? `${ago(FEED.at)} 갱신 · ` : "") + `<span class="syncdot ${dot}"></span>${syncTxt}`;
}

function renderNotice() {
  const parts = [];
  if (FEED.at && now() - FEED.at > 6 * 3600)
    parts.push(`노트북 앱이 꺼져 있어 목록이 ${ago(FEED.at)} 것이에요. 노트북에서 앱을 켜 두면 20분마다 새로 올라와요.`);
  if (!TOKEN) parts.push(`찜·메모가 이 휴대폰에만 저장돼요. <button data-act="settings">노트북과 연동하기</button>`);
  else if (SYNC.state === "bad") parts.push(esc(SYNC.error) + ` <button data-act="settings">설정</button>`);
  $("#notice").innerHTML = parts.map((p) => `<div class="notice">${p}</div>`).join("");
}

function renderTools() {
  let chips;
  if (UI.tab === "saved") {
    chips = ["", ...STATUSES].map((s) => `<button class="chip ${UI.status === s ? "on" : ""}" data-status="${s}">${s || "전체"}</button>`).join("");
  } else {
    const pool = (FEED.posts || []).filter(inTab);
    const cats = [...new Set(pool.map((p) => p.category).filter((c) => c && c !== "해당없음"))];
    const cnt = (c) => pool.filter((p) => p.category === c).length;
    cats.sort((a, b) => cnt(b) - cnt(a));
    chips = `<button class="chip first ${UI.first ? "on" : ""}" data-first>피해자·가족 글</button>` +
      [["", "전체"], ...cats.map((c) => [c, c])].map(([v, l]) => `<button class="chip ${UI.cat === v ? "on" : ""}" data-cat="${esc(v)}">${esc(l)}</button>`).join("");
  }
  const active = document.activeElement?.id === "q";
  const st = sortOf(UI.tab);
  const hid = UI.hide.filter((s) => (FEED.posts || []).some((p) => p.source === s)).length;
  const row2 = UI.tab === "saved" ? "" : `<div class="row2">
      <div class="seg"><button class="${st === "score" ? "on" : ""}" data-sort="score">점수순</button><button class="${st === "new" ? "on" : ""}" data-sort="new">최신순</button></div>
      ${UI.tab === "blind" ? "" : `<button class="chip ${hid ? "on" : ""}" data-act="srcs">커뮤니티${hid ? ` · ${hid}곳 숨김` : " 전체"} ▾</button>`}
    </div>`;
  $("#tools").innerHTML = `<input class="search" id="q" type="search" placeholder="제목·내용·메모 검색" value="${esc(UI.q)}">${row2}<div class="chips">${chips}</div>`;
  if (active) { const q = $("#q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function card(p) {
  const e = DOC.items[p.id];
  const isNew = prevFeedAt && p.firstSeen > prevFeedAt && UI.tab !== "saved";
  const color = GROUP_COLOR[p.group] || "var(--ink-2)";
  return `<article class="card" data-open="${esc(p.id)}">
    <div class="score ${scoreClass(p.score)}">${p.score ?? "–"}<small>${esc(p.judge || "")}</small></div>
    <div class="body">
      <div class="meta"><span class="src" style="color:${color}">${esc(p.sourceName || p.source)}</span><span>${esc(ago(p.ts || p.firstSeen) || p.timeText)}</span>
        ${FIRST_HAND.includes(p.writer) ? `<span class="tag w">${esc(p.writer)}</span>` : ""}
        ${p.category && p.category !== "해당없음" ? `<span class="tag">${esc(p.category)}</span>` : ""}
        ${e ? `<span class="tag st">${esc(e.status || "검토중")}</span>` : ""}${isNew ? `<span class="tag w">새 글</span>` : ""}</div>
      <div class="title">${esc(p.title)}</div>
      ${p.reason ? `<div class="reason">${esc(p.reason)}</div>` : ""}
      ${e && e.memo ? `<div class="memo-pre">${esc(e.memo)}</div>` : ""}
    </div>
    <button class="star ${e ? "on" : ""}" data-star="${esc(p.id)}" aria-label="찜">${e ? "★" : "☆"}</button>
  </article>`;
}

function renderList() {
  const rows = list();
  if (!rows.length) {
    const msg = UI.tab === "saved" ? "찜한 글이 없어요. 목록에서 ☆를 눌러 보세요." :
      !FEED.at ? "목록을 받는 중이에요…" : "조건에 맞는 글이 없어요.";
    $("#list").innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  $("#list").innerHTML = rows.slice(0, UI.limit).map(card).join("") +
    (rows.length > UI.limit ? `<button class="btn more" data-act="more">더 보기 (${rows.length - UI.limit}건 더)</button>` : "");
}

function render() {
  renderTop(); renderNotice(); renderTools(); renderList();
  if (openId && $("#sheet").dataset.kind === "detail") renderDetail(openId, true);
}

// ── 상세·설정 시트 ─────────────────────────────────────────
function openSheet(kind) {
  const sh = $("#sheet");
  if (!sh.classList.contains("open")) history.pushState({ sheet: kind }, "");
  sh.dataset.kind = kind;
  sh.classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeSheet(fromPop) {
  const sh = $("#sheet");
  if (!sh.classList.contains("open")) return;
  if (!fromPop) { history.back(); return; }
  flushMemo();
  sh.classList.remove("open"); sh.dataset.kind = ""; openId = null;
  document.body.style.overflow = "";
  renderList();
}
const bar = (title) => `<div class="bar"><button class="icon" data-act="close" aria-label="닫기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg></button><b>${title}</b></div>`;

function renderDetail(id, keepScroll) {
  const p = itemOf(id);
  if (!p) return;
  openId = id;
  const e = DOC.items[id];
  const sh = $("#sheet");
  const y = sh.scrollTop;
  if (keepScroll && document.activeElement?.id === "memo") return;  // 메모를 쓰는 중엔 다시 그리지 않는다
  const react = [["조회", p.views], ["추천", p.likes], ["댓글", p.comments]].filter(([, v]) => v != null).map(([k, v]) => `${k} ${fmt(v)}`).join(" · ");
  sh.innerHTML = bar(esc(p.sourceName || p.source)) + `<div class="in">
    <div class="meta"><span>${esc(ago(p.ts || p.firstSeen) || p.timeText)}</span>${react ? `<span>· ${react}</span>` : ""}</div>
    <div class="d-title">${esc(p.title)}</div>
    <div class="meta">
      <span class="score ${scoreClass(p.score)}" style="width:auto;height:auto;padding:3px 9px;font-size:13px;border-radius:7px">${p.score ?? "–"}점 · ${esc(p.judge || "")}</span>
      ${FIRST_HAND.includes(p.writer) ? `<span class="tag w">${esc(p.writer)}</span>` : p.writer ? `<span class="tag">${esc(p.writer)}</span>` : ""}
      ${p.category && p.category !== "해당없음" ? `<span class="tag">${esc(p.category)}</span>` : ""}
    </div>
    <div class="actions">
      <a class="btn primary" href="${esc(p.url)}" target="_blank" rel="noopener">원문 보기</a>
      <button class="btn ${e ? "" : "red"}" data-star="${esc(id)}">${e ? "★ 찜 해제" : "☆ 찜하기"}</button>
    </div>
    ${e ? `<div class="box"><h5>상태</h5><div class="status">${STATUSES.map((s) => `<button class="chip ${(e.status || "검토중") === s ? "on" : ""}" data-setstatus="${s}">${s}</button>`).join("")}</div></div>
    <div class="box"><h5>취재 메모 <span class="hint">— 노트북과 함께 보는 비공개 메모</span></h5><textarea id="memo" placeholder="연락처, 확인할 점, 취재 방향…">${esc(e.memo || "")}</textarea>
      <div class="hint" id="memoState">${e.updatedAt ? "마지막 수정 " + ago(e.updatedAt) : ""}</div></div>` : ""}
    ${p.reason ? `<div class="box"><h5>판단 이유</h5><p>${esc(p.reason)}</p></div>` : ""}
    ${p.angle ? `<div class="box"><h5>취재 포인트</h5><p>${esc(p.angle)}</p></div>` : ""}
    ${p.snippet || p.excerpt ? `<div class="box"><h5>본문 앞부분</h5><p>${esc(p.snippet || p.excerpt)}</p></div>` : ""}
    ${e && e.analysis && e.analysis.text ? `<div class="box"><h5>AI 심층 분석 (노트북)</h5><p>${esc(e.analysis.text)}</p></div>` : ""}
  </div>`;
  if (keepScroll) sh.scrollTop = y;
}

let memoTimer = null;
function flushMemo() {
  const m = $("#memo");
  if (!m || !openId || !isSaved(openId)) return;
  clearTimeout(memoTimer);
  if ((DOC.items[openId].memo || "") !== m.value) { touch(openId, { memo: m.value }); const s = $("#memoState"); if (s) s.textContent = "저장됨"; }
}

let installEvt = null;
// 커뮤니티 고르기: 지금 목록에 있는 곳만, 묶음별로
function renderSrcs() {
  const sh = $("#sheet");
  const cnt = {};
  for (const p of FEED.posts || []) if (!p.extra) cnt[p.source] = (cnt[p.source] || 0) + 1;
  const groups = {};
  for (const id of Object.keys(cnt)) {
    const [name, group] = (FEED.sources || {})[id] || [id, "기타"];
    (groups[group] = groups[group] || []).push({ id, name });
  }
  const order = ["사연·폭로", "남초·이슈", "사고·피해", "SNS", "뉴스·청원", "웹검색", "기타"];
  sh.innerHTML = bar("커뮤니티 고르기") + `<div class="in">
    <div class="actions" style="margin-top:0"><button class="btn" data-act="srcall">전체 선택</button><button class="btn" data-act="srcnone">전체 해제</button></div>
    ${order.filter((g) => groups[g]).map((g) => `<div class="box"><h5>${esc(g)}</h5>
      ${groups[g].sort((a, b) => cnt[b.id] - cnt[a.id]).map((s) => `<label class="srcrow"><input type="checkbox" data-src="${esc(s.id)}" ${UI.hide.includes(s.id) ? "" : "checked"}>
        <span>${esc(s.name)}</span><span class="hint">${cnt[s.id]}건</span></label>`).join("")}</div>`).join("")}
    <div class="actions"><button class="btn primary" data-act="close">적용</button></div>
  </div>`;
}

function renderSettings() {
  const sh = $("#sheet");
  const standalone = matchMedia("(display-mode: standalone)").matches;
  const st = !TOKEN ? "연동 안 됨 — 찜·메모가 이 휴대폰에만 저장됩니다." :
    SYNC.state === "bad" ? "오류: " + SYNC.error : SYNC.state === "ok" ? `연동됨 · 마지막 동기화 ${ago(SYNC.at)} · 찜 ${Object.keys(DOC.items).length}건` : "동기화 중…";
  sh.innerHTML = bar("설정") + `<div class="in">
    <div class="box"><h5>노트북과 찜·메모 연동</h5>
      <p style="margin-bottom:10px">${esc(st)}</p>
      <input class="field" id="tok" type="password" autocomplete="off" placeholder="${TOKEN ? "토큰 저장됨 — 바꾸려면 새로 붙여 넣기" : "GitHub 토큰 붙여 넣기 (github_pat_…)"}">
      <div class="actions"><button class="btn primary" data-act="savetok">저장하고 연동</button>${TOKEN ? `<button class="btn" data-act="cleartok">토큰 지우기</button>` : ""}</div>
      <div class="hint" style="margin-top:10px">동기화 저장소</div>
      <input class="field" id="repo" value="${esc(repo())}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <ol class="steps hint">
        <li>토큰은 <b>동기화 저장소 하나만</b>, 권한은 <b>Contents 읽기·쓰기</b>로 만든 휴대폰 전용 토큰을 쓰세요.</li>
        <li>토큰은 이 휴대폰에만 저장되고 어디에도 올라가지 않아요.</li>
        <li>노트북 앱이 켜져 있으면 몇 분 안에 서로 반영돼요.</li>
      </ol>
    </div>
    <div class="box"><h5>목록</h5><p>노트북 앱이 켜져 있을 때 20분마다 새 목록이 올라와요. 최근 3일 글 중 제외되지 않은 글을 점수 순으로 보여 줍니다.</p>
      <p class="hint" style="margin-top:6px">${FEED.at ? "마지막 갱신 " + esc(ago(FEED.at)) + " · " + (FEED.posts || []).length + "건" : ""}</p></div>
    ${standalone ? "" : `<div class="box"><h5>홈 화면에 추가</h5><p>${installEvt ? "아래 버튼을 누르면 앱처럼 설치돼요." : "브라우저 메뉴(⋮ 또는 ≡)에서 <b>홈 화면에 추가</b>를 누르면 앱처럼 쓸 수 있어요."}</p>
      ${installEvt ? `<div class="actions"><button class="btn red" data-act="install">홈 화면에 설치</button></div>` : ""}</div>`}
  </div>`;
}

// ── 이벤트 ─────────────────────────────────────────────────
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-tab],[data-cat],[data-first],[data-status],[data-sort],[data-star],[data-open],[data-act],[data-setstatus],#reload,#openSet");
  if (!t) return;
  if (t.id === "reload") { loadFeed(true); sync(); return; }
  if (t.id === "openSet") { openSheet("settings"); renderSettings(); return; }
  if (t.dataset.tab) { UI.tab = t.dataset.tab; UI.limit = PAGE; saveUI(); window.scrollTo(0, 0); render(); return; }
  if (t.dataset.cat !== undefined) { UI.cat = t.dataset.cat; UI.limit = PAGE; saveUI(); render(); return; }
  if (t.dataset.first !== undefined) { UI.first = !UI.first; UI.limit = PAGE; saveUI(); render(); return; }
  if (t.dataset.sort) { UI.sorts[UI.tab] = t.dataset.sort; UI.limit = PAGE; saveUI(); window.scrollTo(0, 0); render(); return; }
  if (t.dataset.status !== undefined) { UI.status = t.dataset.status; saveUI(); render(); return; }
  if (t.dataset.star) {
    ev.stopPropagation();
    const id = t.dataset.star;
    if (isSaved(id)) {
      const e = DOC.items[id];
      if (e.memo && !confirm("메모가 있는 글이에요. 찜을 풀면 메모도 지워집니다. 풀까요?")) return;
      touch(id, null); toast("찜을 풀었어요");
    } else { touch(id, {}); toast(TOKEN ? "찜했어요 · 노트북에도 저장돼요" : "찜했어요"); }
    render();
    return;
  }
  if (t.dataset.setstatus) { touch(openId, { status: t.dataset.setstatus }); renderDetail(openId, true); return; }
  if (t.dataset.open) { openSheet("detail"); renderDetail(t.dataset.open); $("#sheet").scrollTop = 0; return; }
  const act = t.dataset.act;
  if (act === "more") { UI.limit += PAGE; renderList(); }
  if (act === "srcs") { openSheet("srcs"); renderSrcs(); }
  if (act === "srcall" || act === "srcnone") {
    UI.hide = act === "srcall" ? [] : Object.keys(FEED.sources || {});
    saveUI(); renderSrcs(); renderTools(); renderList();
  }
  if (act === "close") closeSheet();
  if (act === "settings") { openSheet("settings"); renderSettings(); }
  if (act === "savetok") {
    const tok = $("#tok").value.trim(), rp = $("#repo").value.trim();
    if (rp && !/^[\w.-]+\/[\w.-]+$/.test(rp)) { toast("저장소는 '아이디/저장소이름' 형식이에요"); return; }
    if (rp) store.set("repo", rp);
    if (tok) { TOKEN = tok; store.set("token", tok); }
    if (!TOKEN) { toast("토큰을 붙여 넣어 주세요"); return; }
    SYNC.state = "wait"; renderSettings(); await sync(); render();
    toast(SYNC.state === "ok" ? "노트북과 연동됐어요" : "연동하지 못했어요");
  }
  if (act === "cleartok") { TOKEN = ""; store.del("token"); SYNC.state = "off"; renderSettings(); render(); toast("토큰을 지웠어요"); }
  if (act === "install" && installEvt) { installEvt.prompt(); installEvt = null; }
});
document.addEventListener("change", (ev) => {
  const id = ev.target.dataset?.src;
  if (!id) return;
  UI.hide = ev.target.checked ? UI.hide.filter((x) => x !== id) : [...new Set([...UI.hide, id])];
  UI.limit = PAGE; saveUI(); renderTools(); renderList();
});
document.addEventListener("input", (ev) => {
  if (ev.target.id === "q") { UI.q = ev.target.value; UI.limit = PAGE; renderList(); }
  if (ev.target.id === "memo") { clearTimeout(memoTimer); $("#memoState").textContent = "쓰는 중…"; memoTimer = setTimeout(flushMemo, 1500); }
});
document.addEventListener("focusout", (ev) => { if (ev.target.id === "memo") flushMemo(); if (ev.target.id === "q") saveUI(); });
window.addEventListener("popstate", () => closeSheet(true));
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; if ($("#sheet").dataset.kind === "settings") renderSettings(); });

let lastLoad = 0;
function wake() {
  if (now() - lastLoad > 300) { lastLoad = now(); loadFeed(); }
  sync();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") wake();
  else { flushMemo(); if (FEED.at) { prevFeedAt = FEED.at; store.set("seenFeedAt", FEED.at); } }
});
setInterval(() => { if (document.visibilityState === "visible" && TOKEN) sync(); }, 90000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
wake();
