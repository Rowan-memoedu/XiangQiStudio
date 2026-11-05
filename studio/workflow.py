from concurrent.futures import ThreadPoolExecutor
from .store import Problem


class Workflow:
    def __init__(self, store, runner):
        self.store, self.runner = store, runner
        # A restarted process cannot claim an interrupted CI job passed.
        with store.db() as db:
            db.execute("UPDATE submissions SET state='failed', log=log || ? WHERE state IN ('queued','testing')",
                       ("\n服务重启，之前的校验未完成。候选已保留，请重新校验。",))
        # Serial builds keep both the shared branch and the small server predictable.
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="xiangqi-ci")
        self.pending = set()

    def enqueue(self, user, sid):
        row = self.store.submission(user, sid)
        if row["account"] != user["id"]:
            raise Problem("只能提交自己的候选版本", 403)
        with self.store.lock:
            if sid in self.pending:
                raise Problem("这个版本正在校验", 409)
            self.pending.add(sid)
        self.executor.submit(self._background, dict(user), sid)

    def _background(self, user, sid):
        try:
            self.process(user, sid)
        except Exception as error:
            self.store.update_submission(sid, "failed", "校验未完成，候选保留。\n" + str(error)[:3000])
        finally:
            with self.store.lock:
                self.pending.discard(sid)

    def process(self, user, sid):
        row = self.store.submission(user, sid)
        repo = self.store.repo(user["team"])
        self.store.update_submission(sid, "testing", "正在校验上传/提交候选…")
        passed, log = self.runner.check(repo.files(row["revision"]))
        log = "候选版本 CI\n" + log
        if not passed:
            self.store.update_submission(sid, "failed", log)
            return
        if not row["base"] or not repo.is_shared_base(row["base"]):
            self.store.update_submission(sid, "needs-base", log + "\nCI 通过，但缺少可靠共同基线；尚未合并。")
            return
        for attempt in range(3):
            main = repo.main()
            merged, conflict = repo.merge(main, row["revision"])
            if conflict:
                self.store.update_submission(sid, "conflict", log + "\n三方合并冲突（共同版本保持不变）：\n" + conflict)
                return
            self.store.update_submission(sid, "testing", log + "\n正在校验最终合并结果…")
            passed, merged_log = self.runner.check(repo.files(merged))
            if not passed:
                self.store.update_submission(sid, "failed", log + "\n合并结果 CI 未通过：\n" + merged_log)
                return
            with self.store.lock:
                if repo.main() != main:
                    continue
                repo.advance(merged, main)
                ws = self.store.workspace(user)
                if ws["head"] == row["revision"]:
                    with self.store.db() as db:
                        db.execute("UPDATE workspaces SET head=?,base=? WHERE account=?", (merged, merged, user["id"]))
                    self.store.materialize(user["id"], repo.files(merged))
                    repo.call("update-ref", "refs/drafts/" + user["id"], merged)
            self.store.update_submission(sid, "merged", log + "\n最终合并结果 CI\n" + merged_log + "\n已合入共同版本 " + merged)
            return
        self.store.update_submission(sid, "queued", log + "\n共同版本连续发生变化，候选保留，请重试提交。")
