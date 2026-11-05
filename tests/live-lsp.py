"""Two real JDT LS sessions: semantic members, parameter help, definitions and errors."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time
import httpx
from websockets.sync.client import connect

ORIGIN="https://124.221.144.155"
BASE=ORIGIN+"/xiangqi/api/"
codes=json.loads(Path("D:/AppData/XiangQiStudio/invitations.json").read_text(encoding="utf-8"))
settings={"java":{"home":"/opt/java/openjdk","autobuild":{"enabled":True},"configuration":{"updateBuildConfiguration":"automatic","maven":{"userSettings":"/home/runner/.m2/settings.xml"}},
                  "import":{"gradle":{"enabled":False},"maven":{"enabled":True}},"maven":{"downloadSources":False},"signatureHelp":{"enabled":True}}}

def run(uid):
    client=httpx.Client(base_url=BASE,headers={"Origin":ORIGIN},timeout=20)
    login=client.post("login",json={"code":codes[uid]["invitation_code"]});login.raise_for_status()
    token=client.cookies.get("xq_session")
    uri="file:///workspace/src/Main.java"
    notifications=[]
    with connect("wss://124.221.144.155/xiangqi/ws/lsp",origin=ORIGIN,additional_headers={"Cookie":"xq_session="+token},open_timeout=30,max_size=8*1024*1024) as socket:
        def send(method,params,identifier=None):
            value={"jsonrpc":"2.0","method":method,"params":params}
            if identifier is not None:value["id"]=identifier
            socket.send(json.dumps(value))
        def receive(identifier,timeout=120):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                message=json.loads(socket.recv(timeout=max(.1,end-time.monotonic())))
                if identifier == "started" and message.get("method") == "language/status" and message["params"].get("type") == "Started":
                    return message["params"]
                if message.get("id")==identifier and not message.get("method"):
                    if "error" in message:raise AssertionError(message["error"])
                    return message.get("result")
                if "id" in message and "method" in message:
                    result=None
                    if message["method"]=="workspace/configuration":result=[settings["java"] if item.get("section")=="java" else settings for item in message["params"]["items"]]
                    if message["method"]=="workspace/workspaceFolders":result=[{"uri":"file:///workspace","name":"XiangQi"}]
                    socket.send(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":result}))
                else:notifications.append(message)
            raise TimeoutError("LSP response timeout")
        send("initialize",{"processId":None,"rootUri":"file:///workspace","workspaceFolders":[{"uri":"file:///workspace","name":"XiangQi"}],
                          "capabilities":{"workspace":{"configuration":True},"textDocument":{"completion":{"completionItem":{"snippetSupport":True}},"signatureHelp":{"signatureInformation":{"documentationFormat":["markdown","plaintext"]}},"definition":{"linkSupport":True}}},
                          "initializationOptions":{"settings":settings}},1)
        initialized=receive(1)
        assert initialized["capabilities"]["completionProvider"]
        print(uid,"initialized",flush=True)
        send("initialized",{})
        if not any(m.get("method")=="language/status" and m["params"].get("type")=="Started" for m in notifications):
            receive("started")
        print(uid,"project indexed",flush=True)
        send("java/projectConfigurationUpdate", {"uri":"file:///workspace/pom.xml"})
        send("java/buildWorkspace", [True], 2)
        print(uid,"project refreshed",receive(2),flush=True)
        text="\nimport model.game.Game;\npublic class Main {\n  void sample() {\n    Game board = new Game();\n    board.\n  }\n}\n"
        send("textDocument/didOpen",{"textDocument":{"uri":uri,"languageId":"java","version":1,"text":text}})
        labels=[]
        for attempt in range(8):
            send("textDocument/completion",{"textDocument":{"uri":uri},"position":{"line":5,"character":10}},10+attempt)
            completion=receive(10+attempt)
            items=completion.get("items",[]) if isinstance(completion,dict) else completion or []
            labels=[item["label"] for item in items]
            if any("tryMove" in label for label in labels):break
            print(uid,"waiting for index",attempt,flush=True);time.sleep(3)
        if not any("tryMove" in label for label in labels):
            Path("D:/Artifacts/XiangQiStudio/acceptance/lsp-debug-"+uid+".json").write_text(json.dumps(notifications,ensure_ascii=False,indent=2),encoding="utf-8")
        assert any("tryMove" in label for label in labels), labels[:30]
        assert any("isInCheck" in label for label in labels), labels[:30]
        text=text.replace("board.\n","board.tryMove(\n")
        send("textDocument/didChange",{"textDocument":{"uri":uri,"version":2},"contentChanges":[{"text":text}]})
        send("textDocument/signatureHelp",{"textDocument":{"uri":uri},"position":{"line":5,"character":18}},30)
        signature=receive(30)
        assert signature and signature["signatures"] and "int" in signature["signatures"][0]["label"],signature
        send("textDocument/definition",{"textDocument":{"uri":uri},"position":{"line":4,"character":6}},31)
        definition=receive(31)
        assert "Game.java" in json.dumps(definition),definition
        text=text.replace("board.tryMove(\n","board.thisMethodDoesNotExist();\n")
        send("textDocument/didChange",{"textDocument":{"uri":uri,"version":3},"contentChanges":[{"text":text}]})
        for attempt in range(8):
            send("textDocument/hover",{"textDocument":{"uri":uri},"position":{"line":4,"character":6}},40+attempt)
            receive(40+attempt)
            errors=[d for m in notifications if m.get("method")=="textDocument/publishDiagnostics" and m["params"]["uri"]==uri for d in m["params"]["diagnostics"] if "thisMethodDoesNotExist" in d["message"]]
            if errors:break
            time.sleep(2)
        assert errors,"No real undefined-method diagnostic received"
        send("textDocument/didClose",{"textDocument":{"uri":uri}})
        result={"account":uid,"completion_count":len(labels),"members":[v for v in labels if "tryMove" in v or "isInCheck" in v],"signature":signature["signatures"][0]["label"],"definition":definition,"diagnostic":errors[0]["message"]}
        print("PASS",uid,"completion, parameters, definition, diagnostics",flush=True)
    client.close()
    return result

results=[]
for uid in ["test-a","test-b"]:
    results.append(run(uid))
    time.sleep(3)  # Release the previous session before claiming the next one.
Path("D:/Artifacts/XiangQiStudio/acceptance/lsp-results.json").write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding="utf-8")
