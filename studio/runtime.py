from __future__ import annotations

import asyncio
import hashlib
from collections import deque
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from .store import Problem


class Runtime:
    def __init__(self, store, image="xiangqi-runner:0.2.0"):
        self.store, self.image = store, image
        self.lsp = {}
        self.guard = threading.RLock()

    def name(self, kind, uid):
        self.store.project_dir(uid)  # Validate fixed account ID before constructing names.
        return "xq-" + kind + "-" + uid

    def docker(self, *args, timeout=20, check=True):
        result = subprocess.run(["docker", *args], capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise Problem("隔离运行环境未就绪：" + result.stderr.decode(errors="replace")[-500:], 503)
        return result

    def active(self):
        result = self.docker("ps", "--filter", "label=xiangqi-studio=session", "--format", "{{.Label \"xiangqi-account\"}}")
        return set(result.stdout.decode().split()) | set(self.lsp)

    def reserve(self, uid):
        active = self.active()
        if uid not in active and len(active) >= 2:
            raise Problem("两路运行会话正在使用，请稍后再试。", 429)

    def flags(self, name, uid, memory):
        return ["--name", name, "--label", "xiangqi-studio=session", "--label", "xiangqi-account=" + uid,
                "--init", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--memory=" + memory, "--memory-swap=" + memory, "--cpus=1", "--pids-limit=160",
                "--user", f"{os.getuid()}:{os.getgid()}", "--tmpfs", "/tmp:rw,nosuid,nodev,size=192m,mode=1777",
                "--tmpfs", "/home/runner:rw,nosuid,nodev,size=16m,mode=1777", "-e", "HOME=/home/runner"]

    def directories(self, uid):
        root = self.store.root / "runtime" / uid
        root.mkdir(parents=True, exist_ok=True)
        for name in ("source", "data", "sockets", "language"):
            (root / name).mkdir(exist_ok=True)
        return root

    def write_snapshot(self, root: Path, files):
        for name, data in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def start(self, user):
        uid = user["id"]
        with self.guard:
            self.reserve(uid)
            self.stop(user)
            root = self.directories(uid)
            (root / "sockets" / "vnc.sock").unlink(missing_ok=True)
            # Only generated snapshots inside this account's runtime directory.
            for old in root.glob("source-*"):
                if old.is_dir() and not old.is_symlink() and old.resolve().parent == root.resolve():
                    shutil.rmtree(old)
            source = root / ("source-" + uuid.uuid4().hex)
            source.mkdir()
            ws = self.store.workspace(user)
            self.write_snapshot(source, self.store.repo(user["team"]).files(ws["head"]))
            args = ["run", "-d", *self.flags(self.name("gui", uid), uid, "384m"),
                    "-v", str(source) + ":/input:ro", "-v", str(root / "data") + ":/data:rw",
                    "-v", str(root / "sockets") + ":/sockets:rw", self.image, "python3", "/opt/runner/runner.py", "run"]
            self.docker(*args, timeout=40)
            return {"state": "starting", "revision": ws["head"]}

    def stop(self, user):
        self.docker("rm", "-f", self.name("gui", user["id"]), check=False)

    def resize(self, user, width, height):
        root = self.directories(user['id']) / 'sockets'
        temporary = root / ('viewport-' + uuid.uuid4().hex)
        temporary.write_text(f'{width} {height}')
        temporary.replace(root / 'viewport')
        return {'width': width, 'height': height}

    def status(self, user):
        name = self.name("gui", user["id"])
        result = self.docker("inspect", "--format", "{{json .State}}", name, check=False)
        state = json.loads(result.stdout) if result.returncode == 0 else {"Status": "stopped"}
        logs = self.docker("logs", "--tail=200", name, check=False)
        text = (logs.stdout + logs.stderr).decode(errors="replace")[-24000:] if result.returncode == 0 else ""
        return {"state": state.get("Status"), "exit_code": state.get("ExitCode"), "log": text,
                "ready": state.get("Running", False) and (self.directories(user["id"]) / "sockets" / "vnc.sock").exists()}

    def check(self, files):
        base = self.store.root / "checks"
        base.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as temporary:
            root = Path(temporary)
            self.write_snapshot(root, files)
            name = "xq-ci-" + uuid.uuid4().hex[:12]
            args = ["docker", "run", "--name", name, "--init", "--network=none", "--read-only",
                    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=384m", "--memory-swap=384m",
                    "--cpus=1", "--pids-limit=160", "--user", f"{os.getuid()}:{os.getgid()}",
                    "--tmpfs", "/tmp:rw,nosuid,nodev,size=192m,mode=1777", "-e", "HOME=/tmp",
                    "-v", str(root) + ":/input:ro", self.image, "python3", "/opt/runner/runner.py", "check"]
            log = deque(maxlen=128)
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            overflow = threading.Event()

            def read():
                count = 0
                while chunk := process.stdout.read(4096):
                    log.append(chunk)
                    count += len(chunk)
                    if count > 1024 * 1024:
                        overflow.set()
                        process.terminate()
                        break

            thread = threading.Thread(target=read, daemon=True)
            thread.start()
            timed_out = False
            try:
                process.wait(timeout=150)
            except subprocess.TimeoutExpired:
                timed_out = True
                process.kill()
            finally:
                self.docker("rm", "-f", name, timeout=20, check=False)
                thread.join(timeout=5)
            text = b"".join(log).decode(errors="replace")
            passed = process.returncode == 0 and "XIANGQI_TRUSTED_ACCEPTANCE_PASSED" in text and not overflow.is_set() and not timed_out
            if timed_out:
                text += "\nCI 超过 150 秒，已停止并保留候选。"
            if overflow.is_set():
                text += "\nCI 日志超过 1 MiB，已停止。"
            return passed, text

    async def language_server(self, uid):
        with self.guard:
            self.reserve(uid)
            if uid in self.lsp:
                raise Problem("这个账号已有一个语义补全会话，请关闭另一编辑页后重试", 409)
            self.lsp[uid] = None
        try:
            root = self.directories(uid)
            name = self.name("lsp", uid)
            self.docker("rm", "-f", name, check=False)
            self.prepare_language(uid, root)
            args = ["docker", "run", "--rm", "-i", *self.flags(name, uid, "512m"),
                    "-v", str(self.store.project_dir(uid)) + ":/workspace:rw",
                    "-v", str(root / "language") + ":/language:rw", self.image, "python3", "/opt/runner/runner.py", "lsp"]
            process = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
                                                         stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            self.lsp[uid] = process
            return process
        except BaseException:
            self.lsp.pop(uid, None)
            raise

    def prepare_language(self, uid, root):
        """A changed Maven layout needs a fresh JDT resource model on next connect.

        Only disposable indexes and untracked Eclipse-generated metadata are
        removed. Course files, tracked Eclipse settings and Maven downloads remain.
        """
        project = self.store.project_dir(uid)
        language = root / 'language'
        signature = hashlib.sha256((project / 'pom.xml').read_bytes()).hexdigest()
        marker = language / 'project-pom.sha256'
        if marker.exists() and marker.read_text() == signature:
            return
        index = language / 'workspace'
        if index.is_symlink() or index.resolve().parent != language.resolve():
            raise Problem('索引目录无效', 409)
        if index.exists():
            shutil.rmtree(index)
        managed = set(json.loads((project.parent / 'managed-files.json').read_text()))
        for name in ('.classpath', '.project', '.settings'):
            if any(path == name or path.startswith(name + '/') for path in managed):
                continue
            path = project / name
            if path.is_symlink() or path.resolve().parent != project.resolve():
                raise Problem('索引配置目录无效', 409)
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        marker.write_text(signature)

    async def close_language(self, uid, process):
        if self.lsp.get(uid) is process:
            self.lsp.pop(uid, None)
            await asyncio.to_thread(self.docker, "rm", "-f", self.name("lsp", uid), check=False)
        if process.returncode is None:
            process.terminate()
            await process.wait()
