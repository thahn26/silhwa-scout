"""실화탐사대 아이템 레이더 — 윈도우 실행기.

설치 폴더의 pythonw.exe로 실행된다(검은 창 없음). 서버가 꺼져 있으면 켜고,
Edge(없으면 Chrome, 그것도 없으면 기본 브라우저)로 앱 창을 연다.
`--stop`을 붙이면 켜져 있는 서버를 끈다(제거·업데이트 때 설치 프로그램이 쓴다).
"""
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = os.environ.get("SS_PORT", "8766")
URL = f"http://127.0.0.1:{PORT}/"
DATA = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "SilhwaScout")


def post(path):
    try:
        req = urllib.request.Request(URL + "api/" + path, data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=1.5).read()
        return True
    except Exception:
        return False


def alert(msg):
    import ctypes
    ctypes.windll.user32.MessageBoxW(None, msg, "실화탐사대 아이템 레이더", 0x10)


def find_browser():
    pf = [os.environ.get(k, "") for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
    for rel in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"):
        for base in pf:
            p = os.path.join(base, rel)
            if base and os.path.isfile(p):
                return p
    return None


def main():
    if "--stop" in sys.argv:
        post("shutdown")
        return
    os.makedirs(DATA, exist_ok=True)
    if not post("ping"):
        log = open(os.path.join(DATA, "server.log"), "ab")
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: 실행기가 끝나도 서버는 계속 돈다
        subprocess.Popen([sys.executable, os.path.join(HERE, "server.py")], cwd=HERE, stdin=subprocess.DEVNULL,
                         stdout=log, stderr=log, creationflags=0x00000008 | 0x00000200, close_fds=True)
        for _ in range(100):
            if post("ping"):
                break
            time.sleep(0.1)
        else:
            alert("레이더 서버를 켜지 못했습니다.\n" + os.path.join(DATA, "server.log") + " 파일을 확인해 주세요.")
            return
    browser = find_browser()
    if browser:
        subprocess.Popen([browser, "--app=" + URL, "--user-data-dir=" + os.path.join(DATA, "browser"),
                          "--no-first-run", "--no-default-browser-check"])
    else:
        webbrowser.open(URL)


if __name__ == "__main__":
    main()
