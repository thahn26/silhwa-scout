"""자동 업데이트 (윈도우 설치본용).

GitHub Actions가 main에 올라온 코드를 윈도우에서 시험한 뒤 Releases에
version.txt(예: 1.0.12)와 app-update.zip(server.py, sources.py, minisoup.py, updater.py, web/, version.txt)을 올린다.
여기서는 그 최신 버전이 지금 것보다 새것이면 받아서 %APPDATA%\\SilhwaScout\\code\\<버전>에 풀고,
파이썬 문법 검사까지 통과하면 '다음에 켤 버전'으로 표시한다. 실제로 켜 보고 실패하면 실행기가 mark_bad로 되돌린다.
저장소가 공개여야 로그인 없이 받을 수 있다.
"""
import io
import json
import os
import shutil
import urllib.request
import zipfile

REPO = os.environ.get("SS_UPDATE_REPO", "thahn26/silhwa-scout")
BASE = os.environ.get("SS_UPDATE_BASE") or f"https://github.com/{REPO}/releases/latest/download/"
DATA = os.path.expanduser(os.environ.get("SS_DATA", os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"), "SilhwaScout")))
CODE = os.path.join(DATA, "code")
STATE = os.path.join(CODE, "state.json")
REQUIRED = ["server.py", "sources.py", "minisoup.py", "updater.py", "version.txt",
            os.path.join("web", "index.html"), os.path.join("web", "app.js")]


def vt(v):
    try:
        return tuple(int(x) for x in str(v).strip().split("."))
    except ValueError:
        return (0,)


def read_version(d):
    try:
        with open(os.path.join(d, "version.txt"), encoding="utf-8") as f:
            return f.read().strip() or "0"
    except OSError:
        return "0"


def _state():
    try:
        with open(STATE, encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        st = {}
    st.setdefault("current", "")
    st.setdefault("bad", [])
    return st


def _save(st):
    os.makedirs(CODE, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE)


def _get(name, timeout):
    req = urllib.request.Request(BASE + name, headers={"User-Agent": "SilhwaScout-updater"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(20 * 1024 * 1024)


def valid(d):
    return all(os.path.isfile(os.path.join(d, p)) for p in REQUIRED)


def current():
    """받아 둔 버전 중 다음에 켤 것 (버전, 폴더). 없으면 (None, None)."""
    st = _state()
    v = st["current"]
    if v and v not in st["bad"] and valid(os.path.join(CODE, v)):
        return v, os.path.join(CODE, v)
    return None, None


def best(bundled_dir):
    """설치 폴더에 든 버전과 받아 둔 버전 중 새것 (버전, 폴더)."""
    v, d = current()
    bv = read_version(bundled_dir)
    if v and vt(v) > vt(bv):
        return v, d
    return bv, bundled_dir


def check_and_stage(than_version, timeout=4, running=None):
    """than_version보다 새 버전이 올라와 있으면 받아서 검사하고 다음 실행 버전으로 표시한다. 받은 버전(없으면 None)."""
    rv = _get("version.txt", timeout).decode("utf-8", "replace").strip()
    st = _state()
    if not rv or rv in st["bad"] or vt(rv) <= vt(than_version):
        return None
    d = os.path.join(CODE, rv)
    if not valid(d):
        data = _get("app-update.zip", 60)
        tmp = d + ".tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                name = info.filename.replace("\\", "/")
                parts = [p for p in name.split("/") if p]
                if not parts or name.startswith("/") or ".." in parts or ":" in parts[0]:
                    continue
                target = os.path.join(tmp, *parts)
                if name.endswith("/"):
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(z.read(info))
        if read_version(tmp) != rv or not valid(tmp):
            shutil.rmtree(tmp, ignore_errors=True)
            raise ValueError("업데이트 파일이 올바르지 않습니다")
        try:
            for root, _, files in os.walk(tmp):
                for fn in files:
                    if fn.endswith(".py"):
                        path = os.path.join(root, fn)
                        with open(path, encoding="utf-8") as f:
                            compile(f.read(), path, "exec")
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        shutil.rmtree(d, ignore_errors=True)
        os.replace(tmp, d)
    st["current"] = rv
    _save(st)
    _cleanup(keep={rv, running or ""})
    return rv


def mark_bad(v):
    """켜 보니 안 되는 버전: 다시 받지 않고 이전 버전으로 돌아간다."""
    st = _state()
    if v not in st["bad"]:
        st["bad"].append(v)
    if st["current"] == v:
        st["current"] = ""
    _save(st)


def _cleanup(keep):
    """받아 둔 옛 버전은 바로 앞 것 하나만 남기고 지운다."""
    try:
        vers = sorted((n for n in os.listdir(CODE) if os.path.isdir(os.path.join(CODE, n)) and not n.endswith(".tmp")),
                      key=vt, reverse=True)
    except OSError:
        return
    for n in vers[2:]:
        if n not in keep:
            shutil.rmtree(os.path.join(CODE, n), ignore_errors=True)
