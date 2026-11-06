import io
import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from studio.app import create_app
from studio.store import Store, Problem, digest
from studio.workflow import Workflow

INITIAL = {"pom.xml": b"<project/>", "src/main/java/Main.java": b"class Main {}\n",
           "a.txt": b"original\n", "b.txt": b"original\n"}

class Runner:
    def __init__(self, results=None):
        self.results = iter(results or [(True, "passed")] * 20)
        self.checked = []

    def check(self, files):
        self.checked.append(files)
        return next(self.results)

@pytest.fixture
def team(tmp_path):
    store = Store(tmp_path)
    codes = store.seed(INITIAL)
    users = {uid: store.authenticate(store.login(v["invitation_code"])[0]) for uid, v in codes.items()}
    return store, users

def edit(store, user, path, text):
    return store.write_file(user, path, text, store.read_file(user, path)["sha"])

def submit(store, user, runner=None):
    ws = store.workspace(user)
    sid = store.candidate(user, ws["head"], ws["base"], "queued", "test submission")
    worker = Workflow(store, runner or Runner())
    worker.process(user, sid)
    worker.executor.shutdown()
    return store.submission(user, sid)

def archive(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zipped:
        for path, data in files.items():
            zipped.writestr(path, data)
    return buffer.getvalue()

def test_two_accounts_keep_drafts_private_then_merge_independent_files(team):
    store, users = team
    a, b = users["test-a"], users["test-b"]
    with ThreadPoolExecutor(2) as workers:
        list(workers.map(lambda args: edit(store, *args), [(a, "a.txt", "A\n"), (b, "b.txt", "B\n")]))
    assert store.read_file(b, "a.txt")["content"] == "original\n"
    assert store.read_file(a, "b.txt")["content"] == "original\n"
    assert submit(store, a)["state"] == "merged"
    runner = Runner()
    assert submit(store, b, runner)["state"] == "merged"
    assert len(runner.checked) == 2
    assert runner.checked[1]["a.txt"] == b"A\n"
    assert runner.checked[1]["b.txt"] == b"B\n"
    store.pull(a)
    assert store.read_file(a, "b.txt")["content"] == "B\n"
    assert store.read_file(users["owner"], "a.txt")["content"] == "original\n"

def test_conflict_keeps_both_candidates_and_shared_version(team):
    store, users = team
    a, b = users["test-a"], users["test-b"]
    edit(store, a, "a.txt", "A\n")
    edit(store, b, "a.txt", "B\n")
    assert submit(store, a)["state"] == "merged"
    shared = store.repo("test").main()
    row = submit(store, b)
    assert row["state"] == "conflict"
    assert store.repo("test").main() == shared
    assert store.repo("test").files(row["revision"])["a.txt"] == b"B\n"
    assert store.read_file(b, "a.txt")["content"] == "B\n"
    with pytest.raises(Problem, match="同步有冲突"):
        store.pull(b)

@pytest.mark.parametrize("results,checks", [([(False, "compile failed")], 1), ([(True, "passed"), (False, "combined tests fail")], 2)])
def test_failed_candidate_or_merged_test_never_advances_main(team, results, checks):
    store, users = team
    a = users["test-a"]
    shared = store.repo("test").main()
    edit(store, a, "a.txt", "changed\n")
    runner = Runner(results)
    row = submit(store, a, runner)
    assert row["state"] == "failed"
    assert len(runner.checked) == checks
    assert store.repo("test").main() == shared
    assert store.repo("test").files(row["revision"])["a.txt"] == b"changed\n"

def test_edits_during_ci_are_not_lost(team):
    store, users = team
    a = users["test-a"]
    edit(store, a, "a.txt", "candidate\n")
    class EditingRunner(Runner):
        def check(self, files):
            if not self.checked:
                edit(store, a, "a.txt", "continued editing\n")
            return super().check(files)
    assert submit(store, a, EditingRunner())["state"] == "merged"
    assert store.read_file(a, "a.txt")["content"] == "continued editing\n"
    assert store.repo("test").files(store.repo("test").main())["a.txt"] == b"candidate\n"

def test_stale_autosave_retains_candidate_privately(team):
    store, users = team
    a, b = users["test-a"], users["test-b"]
    edit(store, a, "a.txt", "newer\n")
    with pytest.raises(Problem) as caught:
        store.write_file(a, "a.txt", "offline\n", digest(INITIAL["a.txt"]))
    sid = caught.value.details["submission"]
    assert store.read_file(a, "a.txt")["content"] == "newer\n"
    assert store.repo("test").files(store.submission(a, sid)["revision"])["a.txt"] == b"offline\n"
    assert not store.list_submissions(b)
    with pytest.raises(Problem):
        store.submission(b, sid)

def test_zip_roundtrip_known_base_and_missing_base_hold(team):
    store, users = team
    a = users["test-a"]
    edit(store, a, "a.txt", "zip edit\n")
    exported = store.export(a)
    with zipfile.ZipFile(io.BytesIO(exported)) as zipped:
        assert set(zipped.namelist()) == {"XiangQi/" + path for path in INITIAL}
        assert json.loads(zipped.comment)["base"] == store.workspace(a)["base"]
    known = store.import_zip(a, exported)
    assert store.submission(a, known)["state"] == "queued"
    unknown = store.import_zip(a, archive(INITIAL))
    shared = store.repo("test").main()
    runner = Runner()
    worker = Workflow(store, runner)
    worker.process(a, unknown)
    worker.executor.shutdown()
    assert store.submission(a, unknown)["state"] == "needs-base"
    assert len(runner.checked) == 1
    assert store.repo("test").main() == shared

@pytest.mark.parametrize("path", ["../escape.txt", "root/../../escape.txt", "/absolute.txt", "root/.git/config", "root/.env", "root/key.pem", "root/CON.txt", "root/trailing.", "root/bad\nname"])
def test_zip_rejects_unsafe_paths(team, path):
    store, users = team
    with pytest.raises(Problem):
        store.import_zip(users["test-a"], archive({**INITIAL, path: b"bad"}))

def test_zip_rejects_case_collision_and_symlink(team):
    store, users = team
    with pytest.raises(Problem):
        store.import_zip(users["test-a"], archive({**INITIAL, "A.txt": b"collision"}))
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as zipped:
        item = zipfile.ZipInfo("link")
        item.create_system = 3
        item.external_attr = 0o120777 << 16
        zipped.writestr(item, "../../other-account")
    with pytest.raises(Problem):
        store.import_zip(users["test-a"], stream.getvalue())

def test_annotation_keeps_original_source_and_offline_mentions(team):
    store, users = team
    a, b = users["test-a"], users["test-b"]
    cid = store.add_comment(a, "请看这个类", "src/main/java/Main.java", 1, [b["id"]])
    edit(store, a, "src/main/java/Main.java", "class Changed {}\n")
    discussion = store.discussion(b)
    assert discussion["mentions"] == [{"comment": cid, "seen": 0}]
    assert discussion["comments"][0]["snippet"] == "class Main {}"
    assert not store.discussion(users["owner"])["comments"]
    with pytest.raises(Problem):
        store.add_comment(a, "cross-group", mentions=["owner"])

def test_old_unread_mention_remains_visible_after_many_messages(team):
    store, users = team
    a, b = users["test-a"], users["test-b"]
    original = store.add_comment(a, "旧提醒", mentions=["test-b"])
    for i in range(105):
        store.add_comment(a, "普通留言 " + str(i))
    assert any(row["id"] == original for row in store.discussion(b)["comments"])

def test_api_auth_csrf_private_versions_and_mentions(tmp_path, monkeypatch):
    origin = "http://testserver"
    monkeypatch.setenv("XQ_ORIGIN", origin)
    app = create_app(tmp_path, Runner())
    codes = app.state.store.seed(INITIAL)
    assert all(len(row['invitation_code']) == 8 for row in codes.values())
    a, b, outsider = [TestClient(app) for _ in range(3)]
    assert a.get("/api/workspace").status_code == 401
    for client, uid in [(a, "test-a"), (b, "test-b"), (outsider, "owner")]:
        response = client.post("/api/login", json={"code": codes[uid]["invitation_code"]}, headers={"Origin": origin})
        assert response.status_code == 200
        client.headers.update({"Origin": origin, "X-CSRF-Token": response.json()["csrf"]})
    assert a.put("/api/file", json={"path": "a.txt", "content": "bad", "expected_sha": digest(INITIAL["a.txt"])}, headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert a.post("/api/comments", json={"body": "cross-origin"}, headers={"Origin": "https://attacker.invalid"}).status_code == 403
    payload = {"path": "a.txt", "content": "saved", "expected_sha": digest(INITIAL["a.txt"])}
    assert a.put("/api/file", json=payload).status_code == 200
    payload["content"] = "stale tab"
    conflict = a.put("/api/file", json=payload)
    assert conflict.status_code == 409
    sid = conflict.json()["submission"]
    assert b.get("/api/submissions/" + sid).status_code == 403
    assert outsider.get("/api/submissions/" + sid).status_code == 404
    assert b.get("/api/file", params={"path": "a.txt"}).json()["content"] == "original\n"
    posted = a.post("/api/comments", json={"body": "@测试乙 请检查", "mentions": ["test-b"]})
    assert posted.status_code == 200
    assert b.get("/api/discussion").json()["mentions"][0]["seen"] == 0
    assert outsider.get("/api/discussion").json()["comments"] == []
    assert a.post("/api/logout").status_code == 200
    assert a.get("/api/workspace").status_code == 401
    app.state.workflow.executor.shutdown()


def test_remembered_session_renews_existing_cookie_and_checks_read_identity(tmp_path, monkeypatch):
    import time
    from studio.store import SESSION_MAX_AGE

    origin = "http://testserver"
    monkeypatch.setenv("XQ_ORIGIN", origin)
    app = create_app(tmp_path, Runner())
    store = app.state.store
    codes = store.seed(INITIAL)
    with TestClient(app) as client:
        login = client.post("/api/login", json={"code": codes["test-a"]["invitation_code"]},
                            headers={"Origin": origin})
        assert f"Max-Age={SESSION_MAX_AGE}" in login.headers["set-cookie"]
        token = client.cookies.get("xq_session")
        with store.db() as db:
            db.execute("UPDATE sessions SET expires=? WHERE hash=?", (time.time() + 7 * 86400, digest(token)))
        remembered = client.get("/api/me")
        assert remembered.json()["id"] == "test-a"
        assert f"Max-Age={SESSION_MAX_AGE}" in remembered.headers["set-cookie"]
        assert client.cookies.get("xq_session") == token
        assert "set-cookie" not in client.get("/api/me").headers
        assert client.get("/api/workspace", headers={"X-CSRF-Token": "previous-tab"}).status_code == 403
        with store.db() as db:
            db.execute("UPDATE sessions SET expires=? WHERE hash=?", (time.time() - 1, digest(token)))
        assert client.get("/api/me").status_code == 401
    app.state.workflow.executor.shutdown()
