"""실화탐사대 — 윈도우 실행기.

설치 폴더의 pythonw.exe로 실행된다(검은 창 없음).
1) 새 버전이 올라와 있는지 확인해 받아 두고(updater.py)
2) 설치 폴더에 든 버전과 받아 둔 버전 중 새것으로 서버를 켠다. 새 버전이 켜지지 않으면 이전 버전으로 되돌린다.
3) Edge(없으면 Chrome, 그것도 없으면 기본 브라우저)로 앱 창을 연다.
`--stop`: 켜져 있는 서버를 끈다(제거·업데이트 때 설치 프로그램이 쓴다).
`--restart`: 앱 안의 '지금 업데이트' 버튼이 부른다. 서버만 새 버전으로 다시 켜고 창은 새로 열지 않는다.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import updater
except Exception:  # noqa: BLE001
    updater = None

PORT = os.environ.get("SS_PORT", "8766")
URL = f"http://127.0.0.1:{PORT}/"
DATA = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "SilhwaScout")


def call(path, method="POST", timeout=1.5):
    try:
        req = urllib.request.Request(URL + "api/" + path, data=b"{}" if method == "POST" else None, method=method,
                                     headers={"Content-Type": "application/json"})
        body = urllib.request.urlopen(req, timeout=timeout).read()
        return json.loads(body or b"{}")
    except Exception:  # noqa: BLE001
        return None


def alert(msg):
    import ctypes
    ctypes.windll.user32.MessageBoxW(None, msg, "실화탐사대", 0x10)


def find_browser():
    pf = [os.environ.get(k, "") for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
    for rel in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"):
        for base in pf:
            p = os.path.join(base, rel)
            if base and os.path.isfile(p):
                return p
    return None


def vt(v):
    return updater.vt(v) if updater else (0,)


def start_server(code_dir):
    """code_dir의 server.py를 켜고 10초 안에 응답하면 True."""
    log = open(os.path.join(DATA, "server.log"), "ab")
    env = dict(os.environ, SS_LAUNCHER=os.path.abspath(__file__), SS_BUNDLED=HERE)
    # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: 실행기가 끝나도 서버는 계속 돈다
    subprocess.Popen([sys.executable, os.path.join(code_dir, "server.py")], cwd=code_dir, env=env,
                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=0x00000008 | 0x00000200,
                     close_fds=True)
    for _ in range(100):
        if call("ping") is not None:
            return True
        time.sleep(0.1)
    return False


def wait_down():
    for _ in range(50):
        if call("ping", timeout=0.5) is None:
            return
        time.sleep(0.1)


def main():
    if "--stop" in sys.argv:
        call("shutdown")
        return
    os.makedirs(DATA, exist_ok=True)
    best_v, best_d = "0", HERE
    if updater:
        try:
            updater.check_and_stage(updater.best(HERE)[0], timeout=3)
        except Exception:  # noqa: BLE001  (인터넷이 없거나 저장소가 비공개면 그냥 지금 버전으로 켠다)
            pass
        best_v, best_d = updater.best(HERE)
    running = call("version", method="GET")
    if running is not None and updater and vt(running.get("version")) < vt(best_v):
        call("shutdown")  # 옛 버전 서버가 떠 있으면 끄고 새 버전으로 켠다
        wait_down()
        running = None
    if running is None and call("ping") is None:
        ok = start_server(best_d)
        if not ok and best_d != HERE and updater:
            updater.mark_bad(best_v)  # 새 버전이 안 켜지면 되돌린다
            ok = start_server(HERE)
        if not ok:
            alert("레이더 서버를 켜지 못했습니다.\n" + os.path.join(DATA, "server.log") + " 파일을 확인해 주세요.")
            return
    if "--restart" in sys.argv:
        return
    browser = find_browser()
    if browser:
        subprocess.Popen([browser, "--app=" + URL, "--user-data-dir=" + os.path.join(DATA, "browser"),
                          "--no-first-run", "--no-default-browser-check"])
    else:
        webbrowser.open(URL)


if __name__ == "__main__":
    main()
