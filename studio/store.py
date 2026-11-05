from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import sqlite3
import subprocess
import tempfile
import threading
import time
import zipfile
from contextlib import contextmanager


MAX_FILE = 10 * 1024 * 1024
MAX_PROJECT = 100 * 1024 * 1024
MANIFEST = ".xiangqi-studio.json"


class Problem(Exception):
    def __init__(self, message: str, status: int = 400, **details):
        super().__init__(message)
        self.status, self.details = status, details


def digest(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def safe_path(name: str) -> str:
    if not name or len(name) > 240 or "\\" in name or "\x00" in name or ":" in name:
        raise Problem("文件路径无效")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in (".", "..", "") for part in name.split("/")):
        raise Problem("文件路径无效")
    reserved = {"con", "prn", "aux", "nul", *["com" + str(i) for i in range(1, 10)], *["lpt" + str(i) for i in range(1, 10)]}
    if any(ord(c) < 32 or c in '<>"|?*' for c in name) or any(
            part.endswith((" ", ".")) or part.split(".")[0].lower() in reserved for part in path.parts):
        raise Problem("路径不能用于 Windows / IDEA 项目")
    blocked = {".git", ".idea", "node_modules", "target", "data", "saves", "users", "__macosx", ".mvn"}
    if any(part.lower() in blocked for part in path.parts):
        raise Problem("压缩包包含不允许导入的运行数据或配置：" + name)
    if any(part.lower().startswith((".env", "credentials", "secrets", "cookies", "tokens")) for part in path.parts):
        raise Problem("项目中不能上传凭据：" + name)
    if path.suffix.lower() in (".pem", ".key", ".p12", ".pfx", ".class", ".jar", ".exe", ".dll", ".so", ".zip"):
        raise Problem("不支持此文件类型：" + name)
    return name


class GitStore:
    def __init__(self, root: Path):
        self.root = root
        if not root.exists():
            root.parent.mkdir(parents=True, exist_ok=True)
            self.call("init", "--bare", "--initial-branch=main", str(root), outside=True)

    def call(self, *args, data=None, check=True, env=None, outside=False):
        command = ["git", "-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null"]
        if not outside:
            command += ["--git-dir", str(self.root)]
        result = subprocess.run(command + list(args), input=data, capture_output=True, timeout=30,
                                env={**os.environ, "GIT_AUTHOR_NAME": "XiangQi Studio", "GIT_AUTHOR_EMAIL": "studio@localhost",
                                     "GIT_COMMITTER_NAME": "XiangQi Studio", "GIT_COMMITTER_EMAIL": "studio@localhost", **(env or {})})
        if check and result.returncode:
            raise Problem("版本操作失败：" + result.stderr.decode(errors="replace")[:300], 500)
        return result

    def main(self) -> str:
        return self.call("rev-parse", "refs/heads/main").stdout.decode().strip()

    def files(self, revision: str) -> dict[str, bytes]:
        result = {}
        for entry in self.call("ls-tree", "-rz", "--full-tree", revision).stdout.split(b"\0"):
            if not entry:
                continue
            meta, path = entry.split(b"\t", 1)
            mode, kind, sha = meta.split()
            if mode != b"100644" or kind != b"blob":
                raise Problem("项目包含不支持的文件节点", 400)
            result[path.decode()] = self.call("cat-file", "blob", sha.decode()).stdout
        return result

    def commit(self, files: dict[str, bytes], parents: list[str], message: str) -> str:
        if len(files) > 2000 or sum(map(len, files.values())) > MAX_PROJECT:
            raise Problem("项目超出 2000 个文件或 100 MiB 限额", 413)
        if len({path.casefold() for path in files}) != len(files):
            raise Problem("项目包含 Windows 下大小写冲突的路径")
        with tempfile.TemporaryDirectory(dir=self.root.parent) as temp:
            env = {"GIT_INDEX_FILE": str(Path(temp) / "index")}
            self.call("read-tree", "--empty", env=env)
            entries = []
            for path, data in sorted(files.items()):
                safe_path(path)
                if len(data) > MAX_FILE:
                    raise Problem("单个文件不能超过 10 MiB", 413)
                sha = self.call("hash-object", "-w", "--stdin", data=data).stdout.strip()
                entries.append(b"100644 " + sha + b"\t" + path.encode() + b"\0")
            self.call("update-index", "-z", "--index-info", data=b"".join(entries), env=env)
            tree = self.call("write-tree", env=env).stdout.decode().strip()
        return self.commit_tree(tree, parents, message)

    def commit_tree(self, tree, parents, message):
        args = ["commit-tree", tree]
        for parent in parents:
            args += ["-p", parent]
        return self.call(*args, data=(message + "\n").encode()).stdout.decode().strip()

    def merge(self, main, candidate):
        result = self.call("merge-tree", "--write-tree", main, candidate, check=False)
        if result.returncode == 1:
            return None, result.stdout.decode(errors="replace")[:12000]
        if result.returncode:
            raise Problem("无法确定共同基线，候选已保留", 409)
        tree = result.stdout.decode().splitlines()[0]
        return self.commit_tree(tree, [main, candidate], "Merge validated submission"), ""

    def advance(self, revision, old=None):
        args = ["update-ref", "refs/heads/main", revision]
        if old:
            args.append(old)
        self.call(*args)

    def is_shared_base(self, revision):
        if not isinstance(revision, str) or len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
            return False
        return self.call("merge-base", "--is-ancestor", revision, self.main(), check=False).returncode == 0


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.db() as db:
            db.executescript("""
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, code_hash TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, account TEXT NOT NULL, csrf TEXT NOT NULL, expires REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS workspaces(account TEXT PRIMARY KEY, head TEXT NOT NULL, base TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, account TEXT, team TEXT, revision TEXT, base TEXT, state TEXT, title TEXT, log TEXT DEFAULT '', created REAL);
              CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, account TEXT, team TEXT, body TEXT, path TEXT, revision TEXT, line INTEGER, snippet TEXT, created REAL);
              CREATE TABLE IF NOT EXISTS mentions(account TEXT, comment TEXT, seen INTEGER DEFAULT 0, PRIMARY KEY(account,comment));
              CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY, account TEXT, role TEXT, content TEXT, revision TEXT, created REAL);
            """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.root / "state.sqlite3", timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def repo(self, team):
        if team not in ("main", "test"):
            raise Problem("未知协作区", 403)
        return GitStore(self.root / "groups" / team / "repository.git")

    def seed(self, files):
        codes = {}
        with self.lock, self.db() as db:
            for team in ("main", "test"):
                repo = self.repo(team)
                if repo.call("rev-parse", "--verify", "refs/heads/main", check=False).returncode:
                    repo.advance(repo.commit(files, [], "Initial course project"))
            for uid, name, team in (("owner", "主账号", "main"), ("partner", "协作者", "main"),
                                    ("test-a", "测试甲", "test"), ("test-b", "测试乙", "test")):
                if db.execute("SELECT 1 FROM accounts WHERE id=?", (uid,)).fetchone():
                    continue
                code = secrets.token_urlsafe(24)
                codes[uid] = {"name": name, "invitation_code": code}
                db.execute("INSERT INTO accounts VALUES(?,?,?,?)", (uid, name, team, digest(code)))
                head = self.repo(team).main()
                db.execute("INSERT INTO workspaces VALUES(?,?,?)", (uid, head, head))
                self.repo(team).call("update-ref", "refs/drafts/" + uid, head)
                self.materialize(uid, files)
        return codes

    def login(self, code):
        with self.db() as db:
            account = db.execute("SELECT * FROM accounts WHERE code_hash=?", (digest(code),)).fetchone()
            if not account:
                raise Problem("邀请码不正确", 401)
            session, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
            db.execute("INSERT INTO sessions VALUES(?,?,?,?)", (digest(session), account["id"], csrf, time.time() + 7 * 86400))
        return session, csrf

    def authenticate(self, token):
        with self.db() as db:
            account = db.execute("SELECT a.id,a.name,a.team,s.csrf FROM sessions s JOIN accounts a ON a.id=s.account WHERE s.hash=? AND s.expires>?",
                                 (digest(token or ""), time.time())).fetchone()
        if not account:
            raise Problem("请先登录", 401)
        return dict(account)

    def workspace(self, user):
        with self.db() as db:
            return dict(db.execute("SELECT * FROM workspaces WHERE account=?", (user["id"],)).fetchone())

    def project_dir(self, uid):
        if uid not in ("owner", "partner", "test-a", "test-b"):
            raise Problem("未知账号", 403)
        return self.root / "workspaces" / uid / "project"

    def materialize(self, uid, files):
        root = self.project_dir(uid)
        root.mkdir(parents=True, exist_ok=True)
        manifest = root.parent / "managed-files.json"
        previous = json.loads(manifest.read_text()) if manifest.exists() else []
        for name in previous:
            path = root / safe_path(name)
            if not path.resolve().is_relative_to(root) or path.is_symlink():
                raise Problem("工作区包含不允许的链接", 409)
            if name not in files and path.is_file():
                path.unlink()
        for name, content in files.items():
            file = root / safe_path(name)
            if not file.resolve().is_relative_to(root) or file.is_symlink():
                raise Problem("工作区包含不允许的链接", 409)
            file.parent.mkdir(parents=True, exist_ok=True)
            if file.exists() and file.read_bytes() == content:
                continue
            temp = file.with_name(file.name + ".studio-tmp")
            temp.write_bytes(content)
            os.replace(temp, file)
        manifest.write_text(json.dumps(list(files)), encoding="utf-8")

    def view(self, user):
        ws = self.workspace(user)
        repo = self.repo(user["team"])
        files = repo.files(ws["head"])
        return {**ws, "shared": repo.main(), "files": [{"path": p, "sha": digest(b), "size": len(b)} for p, b in sorted(files.items())]}

    def read_file(self, user, path):
        files = self.repo(user["team"]).files(self.workspace(user)["head"])
        if path not in files:
            raise Problem("文件不存在", 404)
        try:
            text = files[path].decode("utf-8")
        except UnicodeDecodeError:
            raise Problem("此文件为二进制资源，请通过 ZIP 管理")
        return {"path": path, "content": text, "sha": digest(files[path])}

    def write_file(self, user, path, content, expected):
        safe_path(path)
        data = content.encode()
        if len(data) > 1024 * 1024:
            raise Problem("文本文件不能超过 1 MiB", 413)
        with self.lock:
            ws = self.workspace(user)
            repo = self.repo(user["team"])
            files = repo.files(ws["head"])
            current = digest(files[path]) if path in files else None
            files[path] = data
            revision = repo.commit(files, [ws["head"]], "Save " + path)
            if current != expected:
                sid = self.candidate(user, revision, ws["base"], "draft-conflict", "同一账号的草稿版本冲突")
                raise Problem("服务器文件已改变。两份版本均已保留，请在版本页比较。", 409, submission=sid)
            with self.db() as db:
                db.execute("UPDATE workspaces SET head=? WHERE account=?", (revision, user["id"]))
            self.materialize(user["id"], files)
            repo.call("update-ref", "refs/drafts/" + user["id"], revision)
        return {"sha": digest(data), "head": revision}

    def candidate(self, user, revision, base, state, title):
        sid = secrets.token_hex(12)
        with self.db() as db:
            db.execute("INSERT INTO submissions(id,account,team,revision,base,state,title,created) VALUES(?,?,?,?,?,?,?,?)",
                       (sid, user["id"], user["team"], revision, base, state, title[:160], time.time()))
        self.repo(user["team"]).call("update-ref", "refs/submissions/" + sid, revision)
        return sid

    def submission(self, user, sid):
        with self.db() as db:
            row = db.execute("SELECT * FROM submissions WHERE id=? AND team=?", (sid, user["team"])).fetchone()
        if not row:
            raise Problem("版本不存在", 404)
        if row["state"] in ("draft-conflict", "sync-conflict") and row["account"] != user["id"]:
            raise Problem("这是其他账号的私人草稿", 403)
        return dict(row)

    def list_submissions(self, user):
        with self.db() as db:
            return [dict(row) for row in db.execute("SELECT * FROM submissions WHERE team=? AND (state NOT IN ('draft-conflict','sync-conflict') OR account=?) ORDER BY created DESC LIMIT 80", (user["team"],user["id"]))]

    def update_submission(self, sid, state, log):
        with self.db() as db:
            db.execute("UPDATE submissions SET state=?,log=? WHERE id=?", (state, log[-50000:], sid))

    def pull(self, user):
        with self.lock:
            ws, repo = self.workspace(user), self.repo(user["team"])
            main = repo.main()
            if ws["head"] == ws["base"]:
                merged, conflict = main, ""
            elif main == ws["base"]:
                return self.view(user)
            else:
                merged, conflict = repo.merge(main, ws["head"])
            if conflict:
                sid = self.candidate(user, ws["head"], ws["base"], "sync-conflict", "同步共同版本时发生冲突")
                self.update_submission(sid, "sync-conflict", conflict)
                raise Problem("同步有冲突，原草稿和共同版本均保留", 409, submission=sid)
            with self.db() as db:
                db.execute("UPDATE workspaces SET head=?,base=? WHERE account=?", (merged, main, user["id"]))
            self.materialize(user["id"], repo.files(merged))
            repo.call("update-ref", "refs/drafts/" + user["id"], merged)
            return self.view(user)

    def export(self, user, sid=None):
        ws = self.workspace(user) if sid is None else self.submission(user, sid)
        revision = ws.get("head", ws.get("revision"))
        files = self.repo(user["team"]).files(revision)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for path, data in files.items():
                archive.writestr("XiangQi/" + path, data)
            # ZIP transport metadata belongs in its comment, never in course source.
            archive.comment = json.dumps({"format": 1, "base": ws["base"], "revision": revision}).encode()
        return stream.getvalue()

    def import_zip(self, user, data, chosen_base=None):
        if len(data) > 25 * 1024 * 1024:
            raise Problem("ZIP 不能超过 25 MiB", 413)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = [entry for entry in archive.infolist() if not entry.is_dir()]
                if not entries or len(entries) > 2001 or sum(e.file_size for e in entries) > MAX_PROJECT:
                    raise Problem("ZIP 展开后不能超过 100 MiB 或 2000 个文件", 413)
                names = [e.filename for e in entries]
                prefix = names[0].split("/")[0] + "/" if "/" in names[0] and all(n.startswith(names[0].split("/")[0] + "/") for n in names) else ""
                incoming, metadata, seen = {}, {}, set()
                if archive.comment:
                    try:
                        metadata = json.loads(archive.comment)
                    except (ValueError, UnicodeError):
                        pass  # Ordinary ZIP comments do not establish a merge base.
                for entry in entries:
                    name = entry.filename[len(prefix):]
                    if name.casefold() in seen:
                        raise Problem("ZIP 包含重复路径或大小写冲突")
                    seen.add(name.casefold())
                    if (entry.external_attr >> 16) & 0o170000 == 0o120000 or entry.flag_bits & 1:
                        raise Problem("不支持链接或加密 ZIP")
                    if name == MANIFEST:
                        if entry.file_size > 4096:
                            raise Problem("版本标识过大")
                        metadata = json.loads(archive.read(entry))
                        continue
                    safe_path(name)
                    if name in incoming or entry.file_size > MAX_FILE:
                        raise Problem("ZIP 包含重复路径或过大文件")
                    incoming[name] = archive.read(entry)
        except (zipfile.BadZipFile, RuntimeError, ValueError, UnicodeError) as error:
            raise Problem("ZIP 文件无法读取或格式无效") from error
        if "pom.xml" not in incoming or not any(p.endswith("Main.java") for p in incoming):
            raise Problem("请上传含 pom.xml 和 Java 源码的完整课程项目")
        repo = self.repo(user["team"])
        base = chosen_base or (metadata.get("base") if isinstance(metadata, dict) else None)
        known = repo.is_shared_base(base)
        parent = base if known else repo.main()
        files = repo.files(parent)
        files.update(incoming)  # An omitted file is preserved, never interpreted as a deletion.
        revision = repo.commit(files, [parent], "Import uploaded project")
        return self.candidate(user, revision, base if known else "", "queued" if known else "needs-base",
                              "ZIP 上传" if known else "ZIP 缺少可靠基线，等待选择")

    def add_comment(self, user, body, path="", line=0, mentions=()):
        if not body.strip() or len(body) > 8000:
            raise Problem("留言长度应为 1–8000 字")
        ws = self.workspace(user)
        snippet = ""
        if path:
            source = self.read_file(user, safe_path(path))["content"].splitlines()
            if line < 1 or line > len(source):
                raise Problem("批注行号已失效，请重新选择")
            snippet = "\n".join(source[max(0, line - 3):line + 2])
        cid = secrets.token_hex(12)
        with self.db() as db:
            allowed = {row[0] for row in db.execute("SELECT id FROM accounts WHERE team=?", (user["team"],))}
            if not set(mentions).issubset(allowed):
                raise Problem("不能 @ 其他协作区的账号", 403)
            db.execute("INSERT INTO comments VALUES(?,?,?,?,?,?,?,?,?)",
                       (cid, user["id"], user["team"], body.strip(), path, ws["head"], line, snippet, time.time()))
            for uid in set(mentions):
                db.execute("INSERT INTO mentions VALUES(?,?,0)", (uid, cid))
        return cid

    def discussion(self, user):
        with self.db() as db:
            comments = [dict(row) for row in db.execute("""SELECT c.*,a.name FROM comments c JOIN accounts a ON a.id=c.account
                WHERE c.team=? AND (c.id IN (SELECT id FROM comments WHERE team=? ORDER BY created DESC LIMIT 100)
                OR c.id IN (SELECT comment FROM mentions WHERE account=? AND seen=0)) ORDER BY c.created DESC""",
                (user["team"], user["team"], user["id"]))]
            mentions = [dict(row) for row in db.execute("SELECT m.comment,m.seen FROM mentions m WHERE m.account=?", (user["id"],))]
            members = [dict(row) for row in db.execute("SELECT id,name FROM accounts WHERE team=?", (user["team"],))]
        return {"comments": comments, "mentions": mentions, "members": members}
