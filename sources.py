"""커뮤니티별 인기글 수집기.

각 수집기는 목록 페이지 한 장을 읽어 글 목록을 돌려준다.
글 하나: {source, title, url, excerpt, views, likes, comments, timeText, ts, category, rank}
숫자를 모르면 None. ts는 알아낼 수 있을 때만 epoch 초.
사이트 구조가 바뀌면 해당 parse_* 함수만 고치면 된다.
"""
import os
import re
import ssl
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

import minisoup

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")


# ── 가져오기 ────────────────────────────────────────────────


def _ssl_context():
    """python.org에서 받은 파이썬은 인증서 묶음이 비어 있을 수 있어 macOS 시스템 인증서를 쓴다."""
    for cafile in (os.environ.get("SSL_CERT_FILE"), "/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"):
        if cafile and os.path.exists(cafile):
            return ssl.create_default_context(cafile=cafile)
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


SSL_CTX = _ssl_context()

def fetch(url, timeout=15, referer=None, extra_headers=None):
    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        "Referer": referer or url,
    }
    headers.update(extra_headers or {})
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        raw = r.read(6 * 1024 * 1024)
        ctype = r.headers.get("Content-Type", "")
    m = re.search(r"charset=([\w-]+)", ctype, re.I)
    enc = m.group(1) if m else None
    if not enc:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", raw[:4000], re.I)
        enc = m.group(1).decode() if m else "utf-8"
    enc = enc.lower()
    if enc in ("euc-kr", "ks_c_5601-1987", "euckr", "cp949"):
        enc = "cp949"
    return raw.decode(enc, errors="replace")


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", "")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(만|천|k|K)?", s)
    if not m:
        return None
    v = float(m.group(1))
    unit = m.group(2)
    if unit == "만":
        v *= 10000
    elif unit in ("천", "k", "K"):
        v *= 1000
    return int(v)


def parse_time(s, now=None):
    """커뮤니티마다 다른 날짜 표기를 epoch 초로. 모르면 None."""
    if not s:
        return None
    now = now or datetime.now()
    s = s.strip()
    try:
        if re.search(r"방금|just", s):
            return now.timestamp()
        m = re.search(r"(\d+)\s*(초|분|시간|일)\s*전?", s)
        if m and not re.search(r"\d{1,2}:\d{2}", s):
            n = int(m.group(1))
            d = {"초": timedelta(seconds=n), "분": timedelta(minutes=n),
                 "시간": timedelta(hours=n), "일": timedelta(days=n)}[m.group(2)]
            return (now - d).timestamp()
        m = re.search(r"(20\d{2})[-./](\d{1,2})[-./](\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?", s)
        if m:
            y, mo, d, hh, mm = m.groups()
            return datetime(int(y), int(mo), int(d), int(hh or 0), int(mm or 0)).timestamp()
        m = re.search(r"\b(\d{2})[-./](\d{1,2})[-./](\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?", s)
        if m:
            y, mo, d, hh, mm = m.groups()
            return datetime(2000 + int(y), int(mo), int(d), int(hh or 0), int(mm or 0)).timestamp()
        m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?", s)
        if m:
            t = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
            if t > now + timedelta(minutes=5):
                t -= timedelta(days=1)
            return t.timestamp()
        m = re.fullmatch(r"(\d{1,2})[-./](\d{1,2})\.?", s)
        if m:
            t = datetime(now.year, int(m.group(1)), int(m.group(2)))
            if t > now + timedelta(days=1):
                t = t.replace(year=now.year - 1)
            return t.timestamp()
    except ValueError:
        return None
    return None


def item(source, title, url, **kw):
    title = re.sub(r"\s+", " ", title or "").strip()
    if not title or not url:
        return None
    it = {"source": source, "title": title, "url": url, "excerpt": "", "views": None, "likes": None,
          "comments": None, "timeText": "", "ts": None, "category": "", "rank": None}
    it.update({k: v for k, v in kw.items() if v is not None})
    if it["timeText"] and not it["ts"]:
        it["ts"] = parse_time(it["timeText"])
    return it


def absolute(base, href):
    return urllib.parse.urljoin(base, href or "")


def strip_count(s):
    return re.sub(r"\s*[\[(]\s*\d[\d,]*\s*[\])]\s*$", "", s or "").strip()


# ── 사이트별 목록 파서 ──────────────────────────────────────

def parse_pann(html, base):
    out = []
    for i, li in enumerate(minisoup.parse(html).select("ul.post_wrap li")):
        a = li.select_one("h2 a")
        if not a:
            continue
        info = li.select_one("dd.info")
        out.append(item("pann", a.get("title") or a.text(), absolute(base, a.get("href")),
                        excerpt=(li.select_one("dd.txt") or a).text()[:200],
                        views=num(info.select_one("span.count").text()) if info and info.select_one("span.count") else None,
                        likes=num(info.select_one("span.rcm").text()) if info and info.select_one("span.rcm") else None,
                        comments=num((li.select_one("span.reple-num") or minisoup.Node("x")).text()),
                        rank=i + 1))
    return out


def parse_theqoo(html, base):
    out = []
    for tr in minisoup.parse(html).select("table.theqoo_board_table tbody tr"):
        if "notice" in tr.classes:
            continue
        td = tr.select_one("td.title")
        if not td:
            continue
        links = [a for a in td.find_all("a") if "replyNum" not in a.classes]
        if not links:
            continue
        rep = td.select_one("a.replyNum")
        cate = tr.select_one("td.cate")
        tds = [c for c in tr.children if not isinstance(c, str) and c.tag == "td"]
        out.append(item("theqoo", links[0].text(), absolute(base, links[0].get("href")),
                        comments=num(rep.text()) if rep else None,
                        views=num(tds[-1].text()) if tds else None,
                        timeText=(tr.select_one("td.time") or minisoup.Node("x")).text(),
                        category=cate.text() if cate else ""))
    return out


def parse_82cook(html, base):
    out = []
    for i, a in enumerate(minisoup.parse(html).select("ul.most li a")):
        out.append(item("cook82", a.get("title") or a.text(), absolute(base, a.get("href")), rank=i + 1))
    return out


def parse_dcbest(html, base):
    out = []
    for tr in minisoup.parse(html).select("tr.us-post"):
        n = tr.select_one("td.gall_num")
        if not n or not n.text().isdigit():
            continue
        td = tr.select_one("td.gall_tit")
        a = td.find("a") if td else None
        if not a:
            continue
        strong = a.find("strong")
        gal = strong.text().strip("[]") if strong else ""
        title = a.text()
        date = tr.select_one("td.gall_date")
        out.append(item("dcbest", title, absolute(base, a.get("href")),
                        comments=num((td.select_one("span.reply_num") or minisoup.Node("x")).text()),
                        views=num((tr.select_one("td.gall_count") or minisoup.Node("x")).text()),
                        likes=num((tr.select_one("td.gall_recommend") or minisoup.Node("x")).text()),
                        timeText=(date.get("title") or date.text()) if date else "",
                        category=gal))
    return out


def parse_fmkorea(html, base):
    out = []
    for li in minisoup.parse(html).find_all("li"):
        if not any(c.startswith("li_best") for c in li.classes):
            continue
        a = li.select_one("h3.title a")
        if not a:
            continue
        t = a.select_one("span.ellipsis-target")
        cnt = li.select_one("a.pc_voted_count span.count")
        cat = li.select_one("span.category")
        out.append(item("fmkorea", t.text() if t else strip_count(a.text()), absolute(base, a.get("href")),
                        likes=num(cnt.text()) if cnt else None,
                        comments=num((a.select_one("span.comment_count") or minisoup.Node("x")).text()),
                        timeText=(li.select_one("span.regdate") or minisoup.Node("x")).text(),
                        category=cat.text().strip(" /") if cat else ""))
    return out


def parse_ruliweb(html, base):
    out = []
    for tr in minisoup.parse(html).select("tr.table_body"):
        if "notice" in tr.classes or "best_top" in tr.classes:
            continue
        a = tr.select_one("a.subject_link")
        if not a:
            continue
        t = a.select_one("span.text_over")
        title = t.text() if t else re.sub(r"^\d+\s+", "", strip_count(a.text()))
        out.append(item("ruliweb", title, absolute(base, a.get("href")),
                        comments=num((a.select_one("span.num_reply") or minisoup.Node("x")).text()),
                        likes=num((tr.select_one("td.recomd") or minisoup.Node("x")).text()),
                        views=num((tr.select_one("td.hit") or minisoup.Node("x")).text()),
                        timeText=(tr.select_one("td.time") or minisoup.Node("x")).text()))
    return out


def _parse_bobae(src):
    def parse(html, base):
        out = []
        for a in minisoup.parse(html).select("a.bsubject"):
            tr = a.closest("tr")
            if not tr:
                continue
            cat = tr.select_one("td.category")
            # title 속성은 따옴표가 \' 로 들어 있거나 '새 창' 같은 엉뚱한 값일 때가 있어 보이는 제목과 비교해 고른다
            attr = a.get("title").replace("\\'", "'").replace('\\"', '"').strip()
            text = a.text()
            title = attr if attr and attr != "새 창" and len(attr) >= len(text.rstrip(". ")) else text
            if re.search(r"^\[공지\]|참여 이벤트|이벤트 안내", title):
                continue
            out.append(item(src, title, absolute(base, a.get("href")),
                            comments=num((tr.select_one("strong.totreply") or minisoup.Node("x")).text()),
                            likes=num((tr.select_one("td.recomm") or minisoup.Node("x")).text()),
                            views=num((tr.select_one("td.count") or minisoup.Node("x")).text()),
                            timeText=(tr.select_one("td.date") or minisoup.Node("x")).text(),
                            category=(cat.get("title") or cat.text()) if cat else ""))
        return out
    return parse


def parse_clien(html, base):
    out = []
    for row in minisoup.parse(html).select("div.list_item.symph_row"):
        a = row.select_one("a.list_subject")
        t = row.select_one("span.subject_fixed")
        if not a or not t:
            continue
        ts = row.select_one("span.timestamp")
        out.append(item("clien", t.get("title") or t.text(), absolute(base, a.get("href")),
                        comments=num(row.get("data-comment-count")),
                        likes=num((row.select_one("div.list_symph") or minisoup.Node("x")).text()),
                        views=num((row.select_one("span.hit") or minisoup.Node("x")).text()),
                        timeText=ts.text() if ts else ""))
    return out


def parse_mlbpark(html, base):
    out = []
    for i, a in enumerate(minisoup.parse(html).select("a.txt")):
        href = a.get("href")
        if "m=view" not in href:
            continue
        date = a.closest("tr").select_one("span.date") if a.closest("tr") else None
        out.append(item("mlbpark", a.text(), absolute(base, href), rank=len(out) + 1,
                        timeText=date.text() if date else ""))
    return out


def parse_todayhumor(html, base):
    out = []
    for tr in minisoup.parse(html).select("tr.view"):
        td = tr.select_one("td.subject")
        a = td.find("a") if td else None
        if not a:
            continue
        memo = td.select_one("span.list_memo_count_span")
        out.append(item("todayhumor", a.text(), absolute(base, a.get("href")),
                        comments=num(memo.text()) if memo else None,
                        views=num((tr.select_one("td.hits") or minisoup.Node("x")).text()),
                        likes=num((tr.select_one("td.oknok") or minisoup.Node("x")).text()),
                        timeText=(tr.select_one("td.date") or minisoup.Node("x")).text()))
    return out


def parse_dogdrip(html, base):
    out = []
    for a in minisoup.parse(html).select("a.title-link"):
        if "이용 규칙" in a.text() or a.text().startswith("[공지]"):
            continue
        box = a.parent
        while box is not None and not box.select_one("div.list-meta"):
            box = box.parent
        h5 = a.parent
        cm = h5.select_one("span.text-primary") if h5 else None
        likes = time_ = None
        if box is not None:
            meta = box.select_one("div.list-meta")
            spans = meta.select("span.text-primary") if meta else []
            likes = num(spans[-1].text()) if spans else None
            for s in (meta.select("span.text-muted") if meta else []):
                if "전" in s.text() or ":" in s.text() or "." in s.text():
                    time_ = s.text()
                    break
        out.append(item("dogdrip", a.text(), absolute(base, a.get("href")),
                        comments=num(cm.text()) if cm else None, likes=likes, timeText=time_ or ""))
    return out


def parse_humoruniv(html, base):
    out = []
    for td in minisoup.parse(html).select("td.li_sbj"):
        a = td.find("a")
        tr = td.closest("tr")
        if not a or not tr:
            continue
        t = [s for s in a.find_all("span") if s.get("id").startswith("title_chk")]
        und = tr.select("td.li_und")
        out.append(item("humoruniv", t[0].text() if t else strip_count(a.text()), absolute(base, a.get("href")),
                        comments=num((a.select_one("span.list_comment_num") or minisoup.Node("x")).text()),
                        views=num(und[0].text()) if len(und) > 0 else None,
                        likes=num(und[1].text()) if len(und) > 1 else None,
                        timeText=(tr.select_one("td.li_date") or minisoup.Node("x")).text()))
    return out


def parse_slr(html, base):
    out = []
    for td in minisoup.parse(html).select("td.sbj"):
        a = td.find("a")
        tr = td.closest("tr")
        if not a or not tr:
            continue
        cat = tr.select_one("td.list_ctgry")
        out.append(item("slr", a.text(), absolute(base, a.get("href")),
                        comments=num(td.text()[len(a.text()):]),
                        likes=num((tr.select_one("td.list_vote") or minisoup.Node("x")).text()),
                        views=num((tr.select_one("td.list_click") or minisoup.Node("x")).text()),
                        timeText=(tr.select_one("td.list_date") or minisoup.Node("x")).text(),
                        category=cat.text() if cat else ""))
    return out


def parse_blind(html, base):
    out = []
    for box in minisoup.parse(html).select("div.article-list-pre"):
        a = box.select_one("div.tit h3 a")
        if not a:
            continue
        like = box.select_one("span.like")
        cat = box.select_one("a.topic-name")
        pre = box.select_one("p.pre-txt")
        out.append(item("blind", a.text(), absolute(base, a.get("href")),
                        excerpt=pre.text()[:200] if pre else "",
                        views=num((box.select_one("a.pv") or minisoup.Node("x")).text()),
                        likes=num(like.text()) if like else None,
                        comments=num((box.select_one("a.cmt") or minisoup.Node("x")).text()),
                        timeText=(box.select_one("a.past") or minisoup.Node("x")).text(),
                        category=cat.text() if cat else ""))
    return out


def _parse_naver(src, top):
    def parse(html, base):
        out = []
        for box in minisoup.parse(html).select("div.rankingnews_box"):
            press = box.select_one("strong.rankingnews_name")
            for i, a in enumerate(box.select("a.list_title")[:top]):
                li = a.closest("li")
                t = li.select_one("span.list_time") if li else None
                out.append(item(src, a.text(), a.get("href"), rank=i + 1,
                                timeText=t.text() if t else "", category=press.text() if press else ""))
        return out
    return parse


# 스레드: 로그인 없이 검색 페이지를 열면 결과가 페이지 안 JSON으로 들어 있다(브라우저로 처음 여는 것처럼 요청해야 함).
THREADS_HEADERS = {"Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
                   "Upgrade-Insecure-Requests": "1", "Referer": ""}
# 피해자가 직접 쓸 법한 표현은 매번, 주제어는 시간마다 3개씩 돌아가며 검색한다
THREADS_CORE = ["도와주세요", "공론화", "억울합니다", "사기 피해", "실종", "피해자입니다", "널리 알려주세요", "제보합니다"]
THREADS_TOPICS = ["층간소음", "학교폭력", "갑질", "스토킹", "보이스피싱", "전세사기", "동물학대", "요양원", "의료사고",
                  "폭행 당했", "먹튀", "경찰 신고", "블랙박스", "이웃 갈등", "어린이집"]
THREADS_DAYS = 14  # 이보다 오래된 글은 뺀다


def threads_urls():
    h = int(time.time() // 3600)
    topics = [THREADS_TOPICS[(h * 3 + i) % len(THREADS_TOPICS)] for i in range(3)]
    return ["https://www.threads.com/search?serp_type=default&q=" + urllib.parse.quote(k) for k in THREADS_CORE + topics]


def parse_threads(html, base):
    import json
    found = []

    def walk(o):
        if isinstance(o, dict):
            if "code" in o and "caption" in o and isinstance(o.get("user"), dict):
                found.append(o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    for blob in re.findall(r'<script type="application/json"[^>]*>(.*?)</script>', html, re.S):
        if '"caption"' in blob and '"code":"' in blob:
            try:
                walk(json.loads(blob))
            except ValueError:
                pass
    out, seen = [], set()
    cutoff = time.time() - THREADS_DAYS * 86400
    q = urllib.parse.parse_qs(urllib.parse.urlparse(base).query).get("q", [""])[0]
    for p in found:
        code, user = p.get("code"), (p.get("user") or {}).get("username")
        text = ((p.get("caption") or {}).get("text") or "").strip()
        if not code or not user or code in seen or not text or (p.get("taken_at") or 0) < cutoff:
            continue
        seen.add(code)
        info = p.get("text_post_app_info") or {}
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        first = lines[0] if lines else text
        if len(first) < 20 and len(lines) > 1:  # '도와주세요.🚨'처럼 첫 줄이 짧으면 다음 줄까지 제목으로
            first = first + " " + lines[1]
        out.append(item("threads", first[:90], f"https://www.threads.com/@{user}/post/{code}",
                        excerpt=text[:200], body=text[:3000], bodySnippet=text[:800],
                        likes=p.get("like_count"), comments=info.get("direct_reply_count"),
                        ts=float(p["taken_at"]), timeText=time.strftime("%Y-%m-%d %H:%M", time.localtime(p["taken_at"])),
                        category="@" + user, query=q))
    return out


# ── 수집 대상 목록 ──────────────────────────────────────────
# group: 화면의 커뮤니티 묶음. urls 여러 개면 모두 읽고 주소로 중복을 뺀다.

SOURCES = [
    {"id": "pann", "name": "네이트판", "group": "사연·폭로",
     "urls": ["https://pann.nate.com/talk/ranking", "https://pann.nate.com/talk/ranking/d"], "parse": parse_pann},
    {"id": "theqoo", "name": "더쿠", "group": "사연·폭로", "urls": ["https://theqoo.net/hot"], "parse": parse_theqoo},
    {"id": "cook82", "name": "82쿡", "group": "사연·폭로",
     "urls": ["https://www.82cook.com/entiz/enti.php?bn=15"], "parse": parse_82cook},
    {"id": "dcbest", "name": "디시 실베", "group": "남초·이슈",
     "urls": ["https://gall.dcinside.com/board/lists/?id=dcbest"], "parse": parse_dcbest},
    {"id": "fmkorea", "name": "에펨코리아", "group": "남초·이슈", "urls": ["https://www.fmkorea.com/best"], "parse": parse_fmkorea},
    {"id": "ruliweb", "name": "루리웹", "group": "남초·이슈", "urls": ["https://bbs.ruliweb.com/best/all"], "parse": parse_ruliweb},
    {"id": "clien", "name": "클리앙", "group": "남초·이슈",
     "urls": ["https://www.clien.net/service/board/park?od=T33"], "parse": parse_clien},
    {"id": "mlbpark", "name": "엠팍 불펜", "group": "남초·이슈",
     "urls": ["https://mlbpark.donga.com/mp/best.php?b=bullpen&m=like"], "parse": parse_mlbpark},
    {"id": "todayhumor", "name": "오늘의유머", "group": "남초·이슈",
     "urls": ["http://www.todayhumor.co.kr/board/list.php?table=bestofbest"], "parse": parse_todayhumor},
    {"id": "dogdrip", "name": "개드립", "group": "남초·이슈", "urls": ["https://www.dogdrip.net/dogdrip"], "parse": parse_dogdrip},
    {"id": "humoruniv", "name": "웃긴대학", "group": "남초·이슈",
     "urls": ["http://web.humoruniv.com/board/humor/list.html?table=pds"], "parse": parse_humoruniv},
    {"id": "slr", "name": "SLR클럽", "group": "남초·이슈",
     "urls": ["http://www.slrclub.com/bbs/zboard.php?id=hot_article"], "parse": parse_slr},
    {"id": "bobae", "name": "보배드림 베스트", "group": "사고·피해",
     "urls": ["https://www.bobaedream.co.kr/list?code=best"], "parse": _parse_bobae("bobae")},
    {"id": "bobaeacc", "name": "보배드림 사고", "group": "사고·피해",
     "urls": ["https://www.bobaedream.co.kr/list?code=accident"], "parse": _parse_bobae("bobaeacc")},
    {"id": "bobaefree", "name": "보배드림 자유", "group": "사고·피해",
     "urls": ["https://www.bobaedream.co.kr/list?code=freeb"], "parse": _parse_bobae("bobaefree")},
    {"id": "bobaehumor", "name": "보배드림 유머", "group": "남초·이슈",
     "urls": ["https://www.bobaedream.co.kr/list?code=humor"], "parse": _parse_bobae("bobaehumor")},
    {"id": "blind", "name": "블라인드", "group": "사고·피해",
     "urls": ["https://www.teamblind.com/kr/topics/%ED%86%A0%ED%94%BD-%EB%B2%A0%EC%8A%A4%ED%8A%B8"], "parse": parse_blind},
    {"id": "threads", "name": "스레드", "group": "스레드", "urls_fn": threads_urls, "urls": ["https://www.threads.com/search"],
     "parse": parse_threads, "headers": THREADS_HEADERS, "delay": 1.5},
    {"id": "naverview", "name": "네이버 많이 본 뉴스", "group": "뉴스·청원",
     "urls": ["https://news.naver.com/main/ranking/popularDay.naver"], "parse": _parse_naver("naverview", 2)},
    {"id": "navercmt", "name": "네이버 댓글 많은 뉴스", "group": "뉴스·청원",
     "urls": ["https://news.naver.com/main/ranking/popularMemo.naver"], "parse": _parse_naver("navercmt", 2)},
]

# 직접 못 읽는 곳(로그인·봇 차단). Claude 웹검색으로 찾아 온 글에 붙는 출처 이름.
WEB_SOURCES = {
    "threads": ("스레드", "스레드"),
    "petition": ("국민동의청원", "뉴스·청원"),
    "instiz": ("인스티즈", "사연·폭로"),
    "ppomppu": ("뽐뿌", "남초·이슈"),
    "web": ("웹검색", "웹검색"),
}

BY_ID = {s["id"]: s for s in SOURCES}


def crawl_source(src):
    """한 커뮤니티를 읽어 (글 목록, 오류) 를 돌려준다."""
    items, seen, errors = [], set(), []
    for url in (src["urls_fn"]() if src.get("urls_fn") else src["urls"]):
        try:
            html = fetch(url, extra_headers=src.get("headers"))
            for it in src["parse"](html, url):
                key = re.sub(r"\W", "", it["title"]) if it else ""
                if it and it["url"] not in seen and key not in seen:
                    seen.update((it["url"], key))
                    items.append(it)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{url}: {type(e).__name__} {e}"[:300])
        time.sleep(src.get("delay", 0.3))
    for i, it in enumerate(items):
        if it["rank"] is None:
            it["rank"] = i + 1
    return items, ("; ".join(errors) if errors and not items else "")


# ── 본문 가져오기 ───────────────────────────────────────────

BODY_SELECTORS = {
    "pann": ["div#contentArea"], "theqoo": ["div.rd_body", "article"], "cook82": ["div#articleBody"],
    "dcbest": ["div.write_div"], "fmkorea": ["div.rd_body", "article"], "ruliweb": ["div.view_content"],
    "clien": ["div.post_article"], "mlbpark": ["div#contentDetail", "div.ar_txt"],
    "todayhumor": ["div.viewContent"], "dogdrip": ["div.rd_body", "div.xe_content"],
    "humoruniv": ["div#wrap_copy", "div#cnts"], "slr": ["div#userct"], "bobae": ["div.bodyCont"],
    "bobaeacc": ["div.bodyCont"], "bobaefree": ["div.bodyCont"], "bobaehumor": ["div.bodyCont"], "blind": ["div.article-view-contents", "p.contents-txt"],
    "naverview": ["article#dic_area", "div#dic_area"], "navercmt": ["article#dic_area", "div#dic_area"],
}


def fetch_body(source, url, limit=6000):
    html = fetch(url)
    doc = minisoup.parse(html)
    for sel in BODY_SELECTORS.get(source, []):
        n = doc.select_one(sel)
        if n:
            text = re.sub(r"\n\s*\n+", "\n\n", n.text("\n")).strip()
            media = len(n.find_all("img")) + len(n.find_all("video")) + len(n.find_all("iframe"))
            if len(text) < 80 and media:
                text = (text + "\n\n" if text else "") + f"(사진·영상 위주 글 — 이미지/영상 {media}개, 원문에서 확인)"
            return text[:limit]
    # 모르는 사이트: 글자가 가장 많이 모인 블록을 본문으로 본다
    best, best_len = None, 0
    for n in doc.iter():
        if n.tag in ("div", "article", "section", "td"):
            direct = sum(len(c.strip()) for c in n.children if isinstance(c, str))
            direct += sum(len(c.text()) for c in n.children if not isinstance(c, str) and c.tag in ("p", "br", "span", "b", "strong", "font"))
            if direct > best_len:
                best, best_len = n, direct
    return (best.text("\n") if best else doc.text())[:limit]


if __name__ == "__main__":
    import sys
    ids = sys.argv[1:] or [s["id"] for s in SOURCES]
    for sid in ids:
        items, err = crawl_source(BY_ID[sid])
        print(f"== {sid}: {len(items)}건 {err}")
        for it in items[:3]:
            print("  ", it["title"][:50], "| 조회", it["views"], "추천", it["likes"], "댓글", it["comments"], "|", it["timeText"], it["ts"] and datetime.fromtimestamp(it["ts"]).strftime("%m-%d %H:%M"), it["category"])
