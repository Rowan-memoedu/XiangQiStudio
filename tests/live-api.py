"""Acceptance against the deployed service, using only the two designated test accounts."""
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import time
import zipfile
import httpx

BASE = "https://124.221.144.155/xiangqi/api/"
ORIGIN = "https://124.221.144.155"
ROOT = Path("D:/Artifacts/XiangQiStudio/acceptance")
ROOT.mkdir(parents=True, exist_ok=True)
codes = json.loads(Path("D:/AppData/XiangQiStudio/invitations.json").read_text(encoding="utf-8"))
results = []

def record(name, **details):
    results.append({"check": name, **details})
    (ROOT / "api-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PASS", name, details, flush=True)

def client(uid):
    result = httpx.Client(base_url=BASE, headers={"Origin": ORIGIN}, timeout=110)
    response = result.post("login", json={"code": codes[uid]["invitation_code"]})
    response.raise_for_status()
    result.headers["X-CSRF-Token"] = response.json()["csrf"]
    return result

def api(c, path, method="GET", body=None):
    response = c.request(method, path, json=body)
    if not response.is_success:
        raise AssertionError(f"{method} {path}: {response.status_code} {response.text[:500]}")
    return response.json()

def edit(c, path, text):
    old = c.get("file", params={"path": path})
    sha = old.json()["sha"] if old.status_code == 200 else None
    return api(c, "file", "PUT", {"path": path, "content": text, "expected_sha": sha})

def finish(c, sid, expected):
    deadline = time.monotonic() + 360
    last = None
    while time.monotonic() < deadline:
        row = api(c, "submissions/" + sid)
        if row["state"] != last:
            print("CI", row["state"], flush=True)
            last = row["state"]
        if row["state"] not in ("testing", "queued"):
            (ROOT / (sid + ".log")).write_text(row["log"], encoding="utf-8")
            assert row["state"] == expected, row["state"] + ": " + row["log"][-2000:]
            return row
        time.sleep(2)
    raise AssertionError("CI did not finish")

def submit(c, title, expected="merged"):
    return finish(c, api(c, "submit", "POST", {"title": title})["id"], expected)

a, b = client("test-a"), client("test-b")
run_id=str(time.time_ns())
initial_a, initial_b = api(a, "workspace"), api(b, "workspace")
main_path = "src/Main.java"
original_main = a.get("file", params={"path": main_path}).json()["content"]
other_chats = api(b,"chat")
original_readme = a.get("file", params={"path": "README.md"}).json()["content"]
with ThreadPoolExecutor(2) as pool:
    list(pool.map(lambda pair: edit(*pair), [(a,"docs/acceptance-"+run_id+"-a.txt","测试甲的独立文件\n"), (b,"docs/acceptance-"+run_id+"-b.txt","测试乙的独立文件\n")]))
assert b.get("file", params={"path": "docs/acceptance-"+run_id+"-a.txt"}).status_code == 404
assert a.get("file", params={"path": "docs/acceptance-"+run_id+"-b.txt"}).status_code == 404
record("两测试账号异步草稿隔离")
submit(a, "验收：测试甲独立文件")
submit(b, "验收：测试乙无冲突合并")
api(a,"pull","POST")
assert a.get("file",params={"path":"docs/acceptance-"+run_id+"-b.txt"}).status_code == 200
record("真实隔离 CI 与最终合并结果 CI 通过后合并")

api(b,"pull","POST")
edit(a,"README.md",original_readme.replace("# 中国象棋", "# 中国象棋 · 测试甲",1))
edit(b,"README.md",original_readme.replace("# 中国象棋", "# 中国象棋 · 测试乙",1))
submit(a,"验收：同一行甲版本")
shared=api(a,"workspace")["shared"]
conflict=submit(b,"验收：同一行乙版本保留","conflict")
assert api(b,"workspace")["shared"] == shared
download=b.get("download",params={"submission":conflict["id"]})
assert download.status_code == 200
(ROOT/"conflicting-candidate.zip").write_bytes(download.content)
record("真实合并冲突保持共同版本不变，候选可下载",candidate=conflict["id"])

edit(a,"README.md",original_readme)
submit(a,"验收：恢复测试区说明文档")
api(b,"resolve-draft","POST")
edit(a,main_path,original_main.replace("new Game();","new Game(;",1))
failed=submit(a,"验收：编译失败不得合并","failed")
assert api(a,"workspace")["shared"] == api(b,"workspace")["shared"]
edit(a,main_path,original_main)
record("真实 Java 编译错误阻止合并，失败候选保留",candidate=failed["id"])

download=a.get("download")
download.raise_for_status()
with zipfile.ZipFile(io.BytesIO(download.content)) as z:
    files={name:z.read(name) for name in z.namelist()}
    version_comment=z.comment
files["XiangQi/docs/acceptance-upload.txt"]="离线 ZIP 上传验收\n".encode()
def zipped(files, metadata=version_comment):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,"w",zipfile.ZIP_DEFLATED) as z:
        for name,data in files.items():z.writestr(name,data)
        z.comment=metadata
    return stream.getvalue()
uploaded=a.post("upload",files={"file":("course.zip",zipped(files),"application/zip")})
uploaded.raise_for_status()
finish(a,uploaded.json()["id"],"merged")
record("ZIP 上传经过真实 CI 后无冲突合并")
uploaded=a.post("upload",files={"file":("without-base.zip",zipped(files,b""),"application/zip")})
uploaded.raise_for_status()
finish(a,uploaded.json()["id"],"needs-base")
record("未知 ZIP 基线通过 CI 后仍保留候选，等待选择")
api(a,"pull","POST");api(b,"pull","POST")

api(b,"logout","POST")
comment=api(a,"comments","POST",{"body":"离线提醒验收：请检查 Main 的入口。","path":main_path,"line":1,"mentions":["test-b"]})
b=client("test-b")
discussion=api(b,"discussion")
assert any(not mention["seen"] for mention in discussion["mentions"])
cid=comment["id"]
assert any(c["id"]==cid and c["snippet"] for c in discussion["comments"])
api(b,"mentions/"+cid+"/read","POST")
assert next(m for m in api(b,"discussion")["mentions"] if m["comment"]==cid)["seen"] == 1
record("代码行批注与离线上线提醒、已读状态")

answer=api(a,"chat","POST",{"question":"请用中文简要说明 Main、ChessController、Board 和 BoardPanel 在一次点击落子中的调用关系；指出真实的方法名，不超过 350 字。"})
assert "Board" in answer["answer"] and "tryMove" in answer["answer"]
(ROOT/"deepseek-answer.md").write_text(answer["answer"],encoding="utf-8")
assert api(b,"chat") == other_chats
record("DeepSeek 使用当前项目上下文回答，聊天记录按账号隔离")
final=a.get("download");final.raise_for_status();(ROOT/"downloaded-project.zip").write_bytes(final.content)
for c in (a,b):api(c,"stop","POST");api(c,"logout","POST");c.close()
record("下载可导入的项目 ZIP；测试会话已退出")
