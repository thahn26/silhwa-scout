#!/usr/bin/env python3
"""실화탐사대 아이템 레이더 — 노트북 앱용 로컬 서버.

커뮤니티 인기글을 주기적으로 모으고(sources.py), 키워드·반응으로 예비 점수를 매긴 뒤
위쪽 후보만 Claude(Claude 데스크톱 앱에 든 Claude Code, claude -p)에게 '아이템성'을 채점시킨다.
찜·메모·보고서는 이 컴퓨터에 JSON으로 저장한다.
127.0.0.1에서만 열리고, 앱 창이 닫힌 뒤 10분 동안 신호가 없으면 스스로 꺼진다.
"""
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sources  # noqa: E402

WEB = os.path.join(HERE, "web")
IS_WIN = os.name == "nt"
DEFAULT_DATA = (os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "SilhwaScout") if IS_WIN
                else "~/Library/Application Support/SilhwaScout")
DATA = os.path.expanduser(os.environ.get("SS_DATA", DEFAULT_DATA))
# 윈도우에서 pythonw로 돌 때 claude를 부를 때마다 검은 창이 뜨지 않게 한다
NO_WINDOW = {"creationflags": 0x08000000} if IS_WIN else {}
PORT = int(os.environ.get("SS_PORT", "8766"))
POSTS = os.path.join(DATA, "posts.json")
SAVED = os.path.join(DATA, "saved.json")
CONFIG = os.path.join(DATA, "config.json")
REPORTS = os.path.join(DATA, "reports")
WORK = os.path.join(DATA, "work")
IDLE_SECONDS = 600
KEEP_DAYS = 7
MAX_BODY = 4 * 1024 * 1024

os.makedirs(REPORTS, exist_ok=True)
os.makedirs(WORK, exist_ok=True)
lock = threading.RLock()
last_ping = time.time()

DEFAULT_CRITERIA = """<실화탐사대>는 MBC 시사교양 프로그램으로, 실제로 벌어진 사건·사고와 그 이면을 현장 취재해 전한다.
좋은 아이템:
- 억울한 피해자나 제보자가 있고, 직접 만나 인터뷰할 수 있을 것 같은 사연
- 사기·금전 피해, 실종·미스터리, 폭력·학대, 이웃·가족 갈등, 갑질, 교통사고·안전사고, 범죄 수사의 허점, 기이한 인물·현상
- 사진·영상(CCTV, 블랙박스)·문서 같은 증거가 있거나 현장이 있어 찍을 그림이 나오는 이야기
- 시청자가 분노하거나 공감할 사회적 공분, 제도의 허점이 드러나는 이야기
- 아직 방송에서 크게 다뤄지지 않았거나, 후속 취재로 새 사실을 밝힐 여지가 있는 이야기
낮은 점수:
- 단순 유머·짤·게임·스포츠·연예 가십, 정치 공방, 해외 토픽, 쇼핑·재테크 정보
- 주작(지어낸 글)이 의심되거나 사실 확인이 사실상 불가능한 글
- 이미 대형 언론이 충분히 다룬 사건(단, 새 피해자·후속 쟁점이 있으면 가점)"""

CATEGORIES = ["사기·금전피해", "실종·미스터리", "폭력·학대", "가족·이웃갈등", "갑질·직장", "교통·안전사고",
              "범죄·수사", "사회고발·제도", "기이한 사연", "해당없음"]
AI_VERSION = 2  # 채점 규칙이 바뀌면 올린다. 예전 규칙으로 채점된 글은 다시 채점 대상이 된다.
WRITERS = ["당사자", "가족·지인", "목격자", "제3자", "뉴스퍼옴", "언론보도"]
FILTER_RULES = """항상 지키는 규칙(PD 지시):
1. 피해자 본인이나 가족이 직접 쓴 글을 가장 높게 친다. 1인칭 호소('제가 당했습니다', '저희 아버지가', '도와주세요', '널리 알려주세요')가 있으면 크게 가점한다.
2. 뉴스 기사를 캡처하거나 퍼 와서 올린 글(기사 내용·기사 링크·캡처가 전부이고 글쓴이 자신의 이야기가 없는 글)은 제외한다.
   단, 당사자나 가족이 '제 사건이 기사로 났다'며 기사와 함께 자기 이야기를 쓴 글은 제외하지 않는다.
3. 가해자가 이미 체포·구속·검거·송치·기소됐거나 재판·선고 단계인 사건, 경찰이 이미 가해자를 입건해 수사 중인 사건은 제외한다.
   단, 경찰이 신고를 받고도 수사를 안 하거나, 무혐의·불송치·사건 은폐·조작 의혹처럼 수사기관이 제 역할을 못 한다고 피해자가 호소하는 글은 제외하지 않는다(오히려 가점)."""

DEFAULT_CONFIG = {
    "autoInterval": 60,      # 분. 0이면 자동 수집 안 함
    "autoScore": True,       # 수집 뒤 새 후보를 바로 AI 채점
    "readBody": True,        # 채점 전에 본문 앞부분을 읽어 같이 보낸다
    "aiTopN": 40,            # 한 번에 AI 채점할 최대 개수
    "model": "sonnet",
    "criteria": DEFAULT_CRITERIA,
    "disabled": [],          # 끈 커뮤니티 id
    "lastCrawl": 0,
}

SYSTEM_PROMPT = ("너는 MBC 시사교양 <실화탐사대> 제작팀의 아이템 리서처다. 사용자 메시지의 지시와 출력 형식을 그대로 따르고, "
                 "요청한 형식의 답만 한국어로 쓴다. 코드 작업이나 파일 수정은 하지 않는다.")


# ── 저장 ────────────────────────────────────────────────────

def read_json(fn, default):
    try:
        with open(fn, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(fn, data):
    tmp = fn + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, fn)


posts = read_json(POSTS, {})
saved = read_json(SAVED, {})
config = dict(DEFAULT_CONFIG, **read_json(CONFIG, {}))
jobs = {k: {"running": False, "startedAt": 0, "finishedAt": 0, "message": "", "progress": ""}
        for k in ("crawl", "score", "web")}
source_status = {}


def save_posts():
    with lock:
        write_json(POSTS, posts)


def save_saved():
    with lock:
        write_json(SAVED, saved)


def save_config():
    with lock:
        write_json(CONFIG, config)


def post_id(url):
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:14]


def source_meta(sid):
    if sid in sources.BY_ID:
        s = sources.BY_ID[sid]
        return s["name"], s["group"]
    return sources.WEB_SOURCES.get(sid, (sid, "웹검색"))


# ── 예비 점수(키워드 + 반응) ────────────────────────────────

KEYWORDS = {
    20: "실종 행방불명 잠적 살인 사망 숨진 시신 변사 학대 사기 스토킹 납치 감금 방화 뺑소니 고독사 사이비 교주 불법촬영 몰카 "
        "마약 미스터리 미스테리 협박 폭행 성폭행 흉기 보이스피싱 로맨스스캠 리딩방 전세사기 먹튀 은폐 조작 실화 제보",
    # 피해자·가족이 직접 쓴 글의 표현(PD 지시). 띄어쓴 표현이 있어 '|'로 나눈다.
    15: "도와주세요|억울합니다|제 동생|제 딸|제 아들|제 남편|제 아내|저희 아버지|저희 어머니|저희 엄마|저희 아빠|저희 가족|"
        "저희 남편|저희 아이|저희 부모님|우리 아이|당했습니다|당했어요|피해자입니다|공론화|널리 알려|퍼트려|퍼뜨려|부탁드립니다|제보합니다|호소합니다",
    12: "갑질 괴롭힘 학폭 학교폭력 층간소음 이웃 동물학대 방치 의료사고 억울 피해자 피해 고소 소송 경찰 수사 CCTV "
        "블박 블랙박스 진상 폭로 시댁 시어머니 장모 불륜 외도 상간 양육비 상속 유산 사채 치매 요양원 어린이집 유치원 응급실 화재 "
        "추락 붕괴 도박 딥페이크 보복 난동 행패 쓰레기 저장강박 개물림 맹견 알박기 사칭 환불 부실 누수 악취 소음 기이한 귀신 괴담 "
        "도주 수배 음주운전 횡령 다단계 분통 파양 유기 노예 착취 임금체불 전세 보증금 잠수",
    6: "황당 충격 경악 결국 논란 사연 사고 분노 참교육 가해자 신고 민원 이상한 무서운 소름",
    # 이미 수사기관이 처리 중인 사건은 제외 대상(PD 지시)
    -20: "구속 체포 검거 송치 기소 징역 실형 선고 입건 재판에",
    -15: "핫딜 게임 LoL 롤 블루아카 스포) 축구 야구 국대 손흥민 아이돌 컴백 앨범 뮤비 굿즈 코스피 주가 대통령 민주당 국민의힘 여당 "
         "야당 대선 총선 선거 예능 웹툰 만화 manhwa 추천pc 할인 특가 광고 이벤트 아시안게임 금메달",
    -6: ".gif .mp4 짤 움짤 리뷰 후기 드라마 영화 주식 코인시세 부동산 정책",
}
KW = [(w, k.lower()) for w, ks in KEYWORDS.items() for k in (ks.split("|") if "|" in ks else ks.split())]


def keyword_score(text):
    t = text.lower()
    s = sum(w for w, k in KW if k in t)
    return max(-40, min(45, s)), [k for w, k in KW if k in t and w > 0][:6]


# 커뮤니티에 뉴스 기사를 퍼 온 글로 보이는 제목(PD 지시로 감점)
NEWS_TITLE = re.compile(r"\[\s*(속보|단독|기사|뉴스|종합|영상|포토)\s*\]|^\(?(속보|단독)\)|\s기자$|…\s*[\"'”’]")


def looks_like_news(p):
    if source_meta(p["source"])[1] == "뉴스·청원":
        return False
    return bool(NEWS_TITLE.search(p["title"])) or "기사" in (p.get("category") or "") or "뉴스" in (p.get("category") or "")


def prescore(batch):
    """같은 커뮤니티 안에서 반응(조회·추천·댓글) 백분위 + 키워드 점수."""
    by_src = {}
    for p in batch:
        by_src.setdefault(p["source"], []).append(p)
    for group in by_src.values():
        n = len(group)
        pct = {id(p): [] for p in group}
        for key in ("views", "likes", "comments"):
            vals = sorted(p[key] for p in group if p.get(key) is not None)
            if len(vals) < 3:
                continue
            for p in group:
                if p.get(key) is not None:
                    below = sum(1 for v in vals if v < p[key])
                    pct[id(p)].append(below / max(1, len(vals) - 1))
        for p in group:
            e = sum(pct[id(p)]) / len(pct[id(p)]) if pct[id(p)] else 1 - (p.get("rank") or n) / (n + 1)
            ks, hits = keyword_score(p["title"] + " " + (p.get("excerpt") or "") + " " + (p.get("category") or ""))
            news = looks_like_news(p)
            p["engagement"] = round(e, 3)
            p["keywords"] = hits
            p["newsLike"] = news
            p["pre"] = int(max(0, min(100, round(10 + e * 40 + ks - (25 if news else 0)))))


# ── 수집 ────────────────────────────────────────────────────

def set_job(name, **kw):
    with lock:
        jobs[name].update(kw)


def crawl_job():
    set_job("crawl", running=True, startedAt=time.time(), message="", progress="커뮤니티 읽는 중")
    enabled = [s for s in sources.SOURCES if s["id"] not in config.get("disabled", [])]
    now = time.time()
    new_ids, total = [], 0
    try:
        with ThreadPoolExecutor(max_workers=6) as ex:
            results = list(ex.map(lambda s: (s, sources.crawl_source(s)), enabled))
        batch = []
        for src, (items, err) in results:
            source_status[src["id"]] = {"count": len(items), "error": err, "at": now}
            batch.extend(items)
        prescore(batch)
        with lock:
            for it in batch:
                pid = post_id(it["url"])
                old = posts.get(pid)
                if old:
                    for k in ("views", "likes", "comments", "rank", "engagement", "pre", "keywords", "newsLike", "excerpt", "category"):
                        if it.get(k) not in (None, ""):
                            old[k] = it[k]
                    old["lastSeen"] = now
                    old["peakRank"] = min(old.get("peakRank") or 999, it.get("rank") or 999)
                    old["seenCount"] = old.get("seenCount", 1) + 1
                else:
                    it.update(id=pid, firstSeen=now, lastSeen=now, peakRank=it.get("rank"), seenCount=1)
                    posts[pid] = it
                    new_ids.append(pid)
            total = len(batch)
            cutoff = now - KEEP_DAYS * 86400
            for pid in [k for k, p in posts.items() if p.get("lastSeen", 0) < cutoff and k not in saved]:
                del posts[pid]
            config["lastCrawl"] = now
        save_posts()
        save_config()
        fails = [sources.BY_ID[k]["name"] for k, v in source_status.items() if v.get("error")]
        msg = f"{total}건 확인, 새 글 {len(new_ids)}건" + (f" · 실패: {', '.join(fails)}" if fails else "")
        set_job("crawl", running=False, finishedAt=time.time(), message=msg, progress="")
    except Exception as e:  # noqa: BLE001
        set_job("crawl", running=False, finishedAt=time.time(), message=f"수집 오류: {e}", progress="")
        return
    if config.get("autoScore") and claude_ready():
        start_job("score", score_job, None)


# ── Claude ─────────────────────────────────────────────────

def find_claude():
    """Claude 데스크톱 앱에 들어 있는 Claude Code를 먼저 찾고, 없으면 따로 설치한 것을 찾는다."""
    if IS_WIN:
        home = os.path.expanduser("~")
        cands = [os.path.join(home, ".local", "bin", "claude.exe"),
                 os.path.join(os.environ.get("APPDATA", ""), "npm", "claude.cmd")]
        cands += sorted(glob.glob(os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude-code", "*", "claude.exe")), reverse=True)
        for p in cands:
            if os.path.isfile(p):
                return p
        return shutil.which("claude")
    def ver(path):
        v = path.split("/claude-code/")[1].split("/")[0]
        return tuple(int(x) if x.isdigit() else 0 for x in v.split("."))
    bundled = glob.glob(os.path.expanduser(
        "~/Library/Application Support/Claude/claude-code/*/claude.app/Contents/MacOS/claude"))
    for p in sorted(bundled, key=ver, reverse=True):
        if os.access(p, os.X_OK):
            return p
    for p in ("~/.local/bin/claude", "~/.claude/local/claude", "/usr/local/bin/claude", "/opt/homebrew/bin/claude"):
        p = os.path.expanduser(p)
        if os.access(p, os.X_OK):
            return p
    return shutil.which("claude")


def claude_env():
    env = dict(os.environ)
    # 다른 Claude Code 세션 안에서 켜졌을 때 그 세션 설정이 섞이지 않게 한다
    for k in list(env):
        if k.startswith("CLAUDE_CODE_") or k in ("CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
            env.pop(k, None)
    return env


_status_cache = {"at": 0, "value": None}


def claude_status(force=False):
    if not force and _status_cache["value"] and time.time() - _status_cache["at"] < 300:
        return _status_cache["value"]
    exe = find_claude()
    if not exe:
        v = {"found": False, "loggedIn": False}
    else:
        try:
            out = subprocess.run([exe, "auth", "status"], capture_output=True, text=True, encoding="utf-8",
                                 errors="replace", timeout=20, env=claude_env(), **NO_WINDOW)
            st = json.loads(out.stdout or "{}")
            v = {"found": True, "loggedIn": bool(st.get("loggedIn")),
                 "subscription": st.get("subscriptionType") or st.get("subscription")}
        except Exception as e:  # noqa: BLE001
            v = {"found": True, "loggedIn": False, "error": str(e)}
    # 실패는 기억하지 않는다(로그인 직후나 일시 오류 때 바로 다시 확인하도록)
    _status_cache.update(at=time.time() if v.get("loggedIn") else 0, value=v)
    return v


def claude_ready():
    return claude_status().get("loggedIn")


def run_claude(prompt, tools=(), max_turns=4, timeout=900):
    exe = find_claude()
    if not exe:
        raise RuntimeError("Claude Code를 찾지 못했습니다. Claude 데스크톱 앱이 설치되어 있어야 합니다.")
    work = tempfile.mkdtemp(dir=WORK)
    args = [exe, "-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config",
            "--setting-sources", "", "--system-prompt", SYSTEM_PROMPT, "--tools", ",".join(tools),
            "--max-turns", str(max_turns)]
    if tools:
        args += ["--allowedTools", ",".join(tools)]
    if config.get("model"):
        args += ["--model", config["model"]]
    try:
        out = subprocess.run(args, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
                             timeout=timeout, cwd=work, env=claude_env(), **NO_WINDOW)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    try:
        res = json.loads(out.stdout)
    except ValueError:
        raise RuntimeError((out.stderr or out.stdout or "Claude 응답 없음").strip()[-500:])
    if res.get("is_error"):
        raise RuntimeError(str(res.get("result") or res.get("subtype") or "Claude 오류")[:500])
    return res.get("result") or ""


def extract_json(text):
    text = re.sub(r"```(?:json)?", "", text)
    starts = [i for i in (text.find("["), text.find("{")) if i >= 0]
    if not starts:
        raise ValueError("JSON 없음")
    s = min(starts)
    end = text.rfind("]" if text[s] == "[" else "}")
    return json.loads(text[s:end + 1])


def reactions(p):
    parts = []
    for k, label in (("views", "조회"), ("likes", "추천"), ("comments", "댓글")):
        if p.get(k) is not None:
            parts.append(f"{label} {p[k]:,}")
    return ", ".join(parts) or f"인기순위 {p.get('rank')}위"


def score_prompt(batch):
    lines = []
    for i, p in enumerate(batch):
        name, group = source_meta(p["source"])
        body = (p.get("bodySnippet") or p.get("excerpt") or "").replace("\n", " ")[:500]
        kind = " [언론사 기사 원문]" if group == "뉴스·청원" else ""
        lines.append(f"[{i}] ({name}{' · ' + p['category'] if p.get('category') else ''}){kind} {p['title']}\n"
                     f"    반응: {reactions(p)}" + (f"\n    내용: {body}" if body else ""))
    return f"""아래는 오늘 국내 커뮤니티·뉴스에서 화제가 된 글 목록이다. 각 글이 <실화탐사대> 아이템이 될 가능성을 채점하라.

## 채점 기준
{config.get('criteria') or DEFAULT_CRITERIA}

{FILTER_RULES}
'[언론사 기사 원문]' 표시가 있는 항목은 기사 자체이므로 writer를 "언론보도"로 두고 규칙 2로 제외하지 않는다. 규칙 3은 똑같이 적용한다.

## 분류(하나만)
{', '.join(CATEGORIES)}

## 글 목록
{chr(10).join(lines)}

## 출력
JSON 배열만 출력한다. 다른 말은 쓰지 않는다. 글마다 하나씩:
{{"i": 번호, "score": 0~100 정수, "category": "분류", "writer": "{'|'.join(WRITERS)} 중 하나(글쓴이가 누구인가)",
 "excluded": "" 또는 "뉴스퍼옴" 또는 "구속·수사중" (규칙 2·3에 걸리면), "reason": "왜 이 점수인지 한 문장(40자 안팎)",
 "angle": "아이템이 된다면 취재 포인트 한 문장(점수 50 미만이면 빈 문자열)", "flags": ["주작의심"|"연예"|"정치"|"해외"|"유머"|"기보도" 중 해당하는 것]}}
점수 감각: 80 이상=바로 회의에 올릴 만함, 60~79=본문 확인해 볼 만함, 40~59=약함, 40 미만=해당 없음.
excluded가 비어 있지 않으면 score는 15 이하로 준다. 당사자·가족 글이 아니면 80점 이상은 드물게 준다."""


def pick_candidates(pool, n):
    """예비 점수 순으로 고르되, 한 커뮤니티나 뉴스가 채점 몫을 독차지하지 않게 나눈다."""
    pool = sorted(pool, key=lambda p: p.get("pre", 0), reverse=True)
    per_src = max(4, n // 5)
    news_cap = max(4, int(n * 0.3))
    out, cnt, news = [], {}, 0
    for p in pool:
        if len(out) >= n:
            break
        is_news = source_meta(p["source"])[1] == "뉴스·청원"
        if cnt.get(p["source"], 0) >= per_src or (is_news and news >= news_cap):
            continue
        out.append(p)
        cnt[p["source"]] = cnt.get(p["source"], 0) + 1
        news += is_news
    for p in pool:  # 몫을 다 못 채웠으면 남은 것 중 점수 순으로
        if len(out) >= n:
            break
        if p not in out:
            out.append(p)
    return out


def ai_record(r):
    excluded = str(r.get("excluded") or "").strip()
    if excluded not in ("", "뉴스퍼옴", "구속·수사중"):
        excluded = "뉴스퍼옴" if "뉴스" in excluded else "구속·수사중"
    score = int(r.get("score") or 0)
    return {"score": min(score, 15) if excluded else score, "category": r.get("category") or "해당없음",
            "writer": r.get("writer") if r.get("writer") in WRITERS else "", "excluded": excluded,
            "reason": r.get("reason") or "", "angle": r.get("angle") or "", "flags": r.get("flags") or [],
            "at": time.time(), "v": AI_VERSION}


def score_job(ids=None):
    set_job("score", running=True, startedAt=time.time(), message="", progress="후보 고르는 중")
    try:
        with lock:
            if ids:
                cands = [posts[i] for i in ids if i in posts]
            else:
                cutoff = time.time() - 3 * 86400
                pool = [p for p in posts.values() if (p.get("ai") or {}).get("v") != AI_VERSION
                        and not p.get("web") and p.get("lastSeen", 0) >= cutoff]
                cands = pick_candidates(pool, int(config.get("aiTopN") or 40))
        if not cands:
            set_job("score", running=False, finishedAt=time.time(), message="채점할 새 후보가 없습니다", progress="")
            return
        if config.get("readBody"):
            set_job("score", progress=f"본문 읽는 중 (0/{len(cands)})")
            done = [0]

            def grab(p):
                if not p.get("bodySnippet") and p["source"] in sources.BY_ID:
                    try:
                        p["bodySnippet"] = sources.fetch_body(p["source"], p["url"], limit=800)
                    except Exception:  # noqa: BLE001
                        p["bodySnippet"] = ""
                done[0] += 1
                set_job("score", progress=f"본문 읽는 중 ({done[0]}/{len(cands)})")
            with ThreadPoolExecutor(max_workers=6) as ex:
                list(ex.map(grab, cands))
        scored = 0
        chunks = [cands[i:i + 20] for i in range(0, len(cands), 20)]
        for n, chunk in enumerate(chunks):
            set_job("score", progress=f"Claude 채점 중 ({n + 1}/{len(chunks)}묶음)")
            result = extract_json(run_claude(score_prompt(chunk)))
            with lock:
                for r in result:
                    try:
                        p = chunk[int(r["i"])]
                    except (KeyError, ValueError, IndexError, TypeError):
                        continue
                    p["ai"] = ai_record(r)
                    scored += 1
            save_posts()
        set_job("score", running=False, finishedAt=time.time(), message=f"{scored}건 채점 완료", progress="")
    except Exception as e:  # noqa: BLE001
        save_posts()
        set_job("score", running=False, finishedAt=time.time(), message=f"채점 오류: {e}", progress="")


def web_job(query):
    set_job("web", running=True, startedAt=time.time(), message="", progress="Claude가 웹검색 중 (2~5분)")
    today = datetime.now().strftime("%Y-%m-%d")
    focus = f"특히 '{query}'와 관련된 글을 중심으로 찾는다." if query else ""
    prompt = f"""오늘은 {today}이다. 웹검색으로 최근 3일 안에 화제가 된, <실화탐사대> 아이템이 될 만한 글을 찾아라. {focus}
찾을 곳(직접 접속이 막혀 있어 검색으로만 볼 수 있는 곳): 스레드(threads.com / threads.net), 국민동의청원(petitions.assembly.go.kr),
인스티즈, 뽐뿌, 그 밖의 SNS·지역 커뮤니티·맘카페 공개글.

## 찾는 순서
1. 스레드를 가장 먼저, 가장 많이 찾는다. 예: `site:threads.com 사기 피해`, `site:threads.com 도와주세요 제보`, `site:threads.com 억울`,
   `site:threads.com 실종`, `site:threads.com 층간소음`, `스레드 화제 폭로` 처럼 여러 번 검색하고, 찾은 글은 WebFetch로 열어 내용을 확인한다.
2. 국민동의청원에서 동의 수가 빠르게 늘고 있는 피해·사건 관련 청원 (정치·외교 청원은 제외).
3. 인스티즈·뽐뿌 등에서 화제가 된 사연글.
4. 뉴스 기사 자체는 넣지 않는다. 기사에서 SNS·커뮤니티 원글을 찾았으면 원글 주소만 넣는다.

## 채점 기준
{config.get('criteria') or DEFAULT_CRITERIA}

{FILTER_RULES}
규칙 2·3에 걸리는 글은 아예 목록에 넣지 않는다. 피해자·가족이 직접 쓴 글을 우선해서 찾는다.

## 출력
JSON 배열만 출력한다(최대 15개, 실제로 확인한 글만, 주소를 지어내지 않는다):
{{"title": "글 제목(없으면 핵심 요약)", "url": "원문 주소", "source": "threads"|"petition"|"instiz"|"ppomppu"|"web",
 "summary": "내용 요약 2문장", "date": "YYYY-MM-DD 또는 빈 문자열", "score": 0~100, "category": "{'|'.join(CATEGORIES)} 중 하나",
 "writer": "{'|'.join(WRITERS)} 중 하나", "excluded": "",
 "reason": "점수 이유 한 문장", "angle": "취재 포인트 한 문장"}}"""
    try:
        result = extract_json(run_claude(prompt, tools=("WebSearch", "WebFetch"), max_turns=30, timeout=900))
        now, added = time.time(), 0
        with lock:
            for r in result:
                url = str(r.get("url") or "").strip()
                if not url.startswith("http"):
                    continue
                pid = post_id(url)
                if pid in posts and not posts[pid].get("web"):
                    continue  # 이미 커뮤니티에서 직접 모은 글이면 그대로 둔다
                src = r.get("source") if r.get("source") in sources.WEB_SOURCES else "web"
                p = posts.get(pid) or {"id": pid, "source": src, "url": url, "firstSeen": now, "views": None,
                                       "likes": None, "comments": None, "rank": None, "category": "", "seenCount": 1}
                p.update(title=r.get("title") or url, excerpt=r.get("summary") or "", timeText=r.get("date") or "",
                         ts=sources.parse_time(r.get("date") or ""), lastSeen=now, pre=0, web=True, query=query or "")
                p["ai"] = ai_record(r)
                if pid not in posts:
                    added += 1
                posts[pid] = p
        save_posts()
        set_job("web", running=False, finishedAt=time.time(), message=f"웹검색으로 {len(result)}건 찾음 (새 글 {added}건)", progress="")
    except Exception as e:  # noqa: BLE001
        set_job("web", running=False, finishedAt=time.time(), message=f"웹검색 오류: {e}", progress="")


def start_job(name, fn, arg):
    with lock:
        if jobs[name]["running"]:
            return False
        jobs[name]["running"] = True
    threading.Thread(target=fn, args=() if name == "crawl" else (arg,), daemon=True).start()
    return True


def item_block(p, memo=""):
    name, _ = source_meta(p["source"])
    ai = p.get("ai") or {}
    body = (p.get("body") or p.get("bodySnippet") or p.get("excerpt") or "")[:2500]
    return (f"### {p['title']}\n- 출처: {name} / {p['url']}\n- 반응: {reactions(p)}\n"
            f"- AI 1차 판단: {ai.get('score', '-')}점 · {ai.get('category', '')} · {ai.get('reason', '')}\n"
            + (f"- PD 메모: {memo}\n" if memo else "") + (f"- 본문:\n{body}\n" if body else ""))


def analyze_prompt(p, memo):
    return f"""아래 글을 <실화탐사대> 아이템 관점에서 검토하라.

{item_block(p, memo)}

## 채점 기준
{config.get('criteria') or DEFAULT_CRITERIA}

{FILTER_RULES}

## 출력(마크다운, 소제목 그대로)
**한 줄 로그라인** — 방송 예고 문구처럼 한 문장
**사건 개요** — 글에서 확인되는 사실만 3~5줄. 추측은 '(추정)'으로 표시
**글쓴이** — 당사자/가족·지인/목격자/제3자/뉴스 퍼옴 중 무엇인지와 근거
**등장인물** — 제보자/피해자/상대방/관계기관
**왜 실화탐사대인가** — 방송 가치 2~3개
**취재 방향** — 누구를 만나고 어디를 찍을지, 확보할 자료(CCTV·문서 등)
**사실 확인이 필요한 것** — 주작 가능성, 법적 리스크, 초상권·명예훼손 주의점
**종합 판단** — 추천/보류/제외 중 하나와 이유 한 줄(규칙 2·3에 걸리면 제외)"""


def report_prompt(entries, note):
    blocks = "\n".join(item_block(p, memo) for p, memo in entries)
    return f"""아래는 PD가 찜한 <실화탐사대> 아이템 후보들이다. 아이템 회의에 바로 올릴 보고서를 써라.
{('PD 요청: ' + note) if note else ''}

{blocks}

## 출력(마크다운)
맨 위에 `# 실화탐사대 아이템 보고 ({datetime.now().strftime('%Y.%m.%d')})`, 그 아래 한 줄로 전체 요약.
그다음 추천도 높은 순서로 아이템마다:
## N. 가제
- **로그라인**: 한 문장
- **개요**: 확인된 사실 위주 3줄
- **방송 포인트**: 왜 지금, 왜 우리 프로그램인가
- **취재 계획**: 섭외 대상 · 촬영 현장 · 확보할 자료
- **확인 필요/리스크**
- **추천도**: ★1~5
- **출처**: 원문 주소
맨 끝에 `## 다음 할 일` 체크리스트 3~5개."""


# ── HTTP ───────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        if obj is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self):
        # 다른 웹사이트가 이 서버를 건드리지 못하게 한다
        host = (self.headers.get("Host") or "").split(":")[0]
        origin = self.headers.get("Origin")
        if host not in ("127.0.0.1", "localhost"):
            return False
        if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise OverflowError
        return json.loads(self.rfile.read(n) or b"null") or {}

    def do_GET(self):
        if not self._local_only():
            return self._json(403, {"error": "forbidden"})
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            return super().do_GET()
        if path == "/api/state":
            with lock:
                light = [{k: v for k, v in p.items() if k not in ("body", "bodySnippet")} for p in posts.values()]
                return self._json(200, {
                    "posts": light, "saved": saved, "config": config, "jobs": jobs, "categories": CATEGORIES,
                    "defaultCriteria": DEFAULT_CRITERIA, "filterRules": FILTER_RULES, "aiVersion": AI_VERSION,
                    "platform": "windows" if IS_WIN else "mac",
                    "sources": [{"id": s["id"], "name": s["name"], "group": s["group"], "url": s["urls"][0],
                                 **source_status.get(s["id"], {})} for s in sources.SOURCES],
                    "webSources": {k: {"name": v[0], "group": v[1]} for k, v in sources.WEB_SOURCES.items()},
                    "claude": claude_status()})
        if path == "/api/jobs":
            with lock:
                return self._json(200, {"jobs": jobs, "lastCrawl": config.get("lastCrawl")})
        if path == "/api/reports":
            out = []
            for fn in sorted(os.listdir(REPORTS), reverse=True)[:50]:
                r = read_json(os.path.join(REPORTS, fn), None)
                if r:
                    out.append(r)
            return self._json(200, out)
        if path == "/api/claude/status":
            return self._json(200, claude_status(force=True))
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        global last_ping
        if not self._local_only():
            return self._json(403, {"error": "forbidden"})
        path = urllib.parse.urlparse(self.path).path
        try:
            body = self._body()
        except (ValueError, OverflowError):
            return self._json(400, {"error": "bad request"})
        if path == "/api/ping":
            last_ping = time.time()
            return self._json(200, {"ok": True})
        if path == "/api/shutdown":  # 윈도우 제거·업데이트 때 설치 프로그램이 부른다
            self._json(204)
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path == "/api/crawl":
            return self._json(200, {"started": start_job("crawl", crawl_job, None)})
        if path == "/api/score":
            if not claude_ready():
                return self._json(400, {"error": "Claude에 로그인되어 있지 않습니다"})
            return self._json(200, {"started": start_job("score", score_job, body.get("ids") or [])})
        if path == "/api/websearch":
            if not claude_ready():
                return self._json(400, {"error": "Claude에 로그인되어 있지 않습니다"})
            return self._json(200, {"started": start_job("web", web_job, str(body.get("query") or "").strip())})
        if path == "/api/save":
            pid = body.get("id")
            with lock:
                if body.get("saved") is False:
                    saved.pop(pid, None)
                else:
                    cur = saved.get(pid) or {"savedAt": time.time(), "memo": "", "status": "검토중"}
                    for k in ("memo", "status"):
                        if k in body:
                            cur[k] = str(body[k])
                    if pid in posts:
                        cur["post"] = {k: v for k, v in posts[pid].items() if k not in ("body", "bodySnippet")}
                    saved[pid] = cur
            save_saved()
            return self._json(200, saved.get(pid) or {})
        if path == "/api/settings":
            with lock:
                for k in ("autoInterval", "aiTopN"):
                    if k in body:
                        config[k] = max(0, int(body[k] or 0))
                for k in ("autoScore", "readBody"):
                    if k in body:
                        config[k] = bool(body[k])
                if body.get("model") in ("sonnet", "opus", "haiku"):
                    config["model"] = body["model"]
                if "criteria" in body:
                    config["criteria"] = str(body["criteria"] or "").strip() or DEFAULT_CRITERIA
                if isinstance(body.get("disabled"), list):
                    config["disabled"] = [str(x) for x in body["disabled"]]
            save_config()
            return self._json(200, config)
        if path == "/api/body":
            p = posts.get(body.get("id")) or (saved.get(body.get("id")) or {}).get("post")
            if not p:
                return self._json(404, {"error": "글을 찾지 못했습니다"})
            if not p.get("body"):
                if p["source"] not in sources.BY_ID:
                    return self._json(200, {"body": p.get("excerpt") or ""})
                try:
                    p["body"] = sources.fetch_body(p["source"], p["url"])
                except Exception as e:  # noqa: BLE001
                    return self._json(502, {"error": f"본문을 가져오지 못했습니다: {e}"})
                save_posts()
            return self._json(200, {"body": p["body"], "analysis": p.get("analysis")})
        if path == "/api/analyze":
            pid = body.get("id")
            p = posts.get(pid) or (saved.get(pid) or {}).get("post")
            if not p:
                return self._json(404, {"error": "글을 찾지 못했습니다"})
            if not p.get("body") and p["source"] in sources.BY_ID:
                try:
                    p["body"] = sources.fetch_body(p["source"], p["url"])
                except Exception:  # noqa: BLE001
                    pass
            try:
                text = run_claude(analyze_prompt(p, (saved.get(pid) or {}).get("memo", "")))
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": str(e)})
            p["analysis"] = {"text": text, "at": time.time()}
            save_posts()
            if pid in saved:
                saved[pid]["analysis"] = p["analysis"]
                save_saved()
            return self._json(200, p["analysis"])
        if path == "/api/report":
            entries = []
            for pid in body.get("ids") or []:
                p = posts.get(pid) or (saved.get(pid) or {}).get("post")
                if p:
                    entries.append((p, (saved.get(pid) or {}).get("memo", "")))
            if not entries:
                return self._json(400, {"error": "보고서에 넣을 아이템을 골라 주세요"})
            try:
                text = run_claude(report_prompt(entries, str(body.get("note") or "")), timeout=1200)
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": str(e)})
            rep = {"id": datetime.now().strftime("%Y%m%d-%H%M%S"), "at": time.time(), "markdown": text,
                   "items": [p["id"] for p, _ in entries]}
            write_json(os.path.join(REPORTS, rep["id"] + ".json"), rep)
            return self._json(200, rep)
        if path == "/api/claude/login":
            exe = find_claude()
            if not exe:
                return self._json(404, {"error": "claude not found"})
            if IS_WIN:
                # 새 명령 창에서 로그인(0x10 = CREATE_NEW_CONSOLE). 로그인이 끝나면 창이 저절로 닫힌다.
                args = [exe, "auth", "login", "--claudeai"]
                if exe.lower().endswith((".cmd", ".bat")):
                    args = ["cmd", "/c"] + args
                subprocess.Popen(args, creationflags=0x10, env=claude_env())
            else:
                cmd = "clear; echo 'Claude 요금제 계정으로 로그인합니다. 브라우저가 열리면 로그인하고, 끝나면 이 창을 닫으세요.'; " \
                      f"'{exe}' auth login --claudeai"
                script = 'tell application "Terminal"\n activate\n do script "' + cmd.replace("\\", "\\\\").replace('"', '\\"') + '"\nend tell'
                subprocess.Popen(["osascript", "-e", script])
            _status_cache["at"] = 0
            return self._json(204)
        return self._json(404, {"error": "not found"})


def scheduler(server):
    """앱이 켜져 있는 동안 정해진 간격마다 수집하고, 창이 닫힌 뒤 오래 조용하면 서버를 끈다."""
    first = True
    while True:
        time.sleep(3 if first else 30)
        first = False
        if time.time() - last_ping > IDLE_SECONDS:
            server.shutdown()
            return
        interval = int(config.get("autoInterval") or 0) * 60
        if interval and time.time() - (config.get("lastCrawl") or 0) >= interval:
            start_job("crawl", crawl_job, None)


if __name__ == "__main__":
    # 윈도우(영문 로캘)에서 로그 파일로 돌릴 때 한글 출력 때문에 꺼지지 않게 한다
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=scheduler, args=(srv,), daemon=True).start()
    print(f"실화탐사대 아이템 레이더: http://127.0.0.1:{PORT}  (데이터: {DATA})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    sys.exit(0)
