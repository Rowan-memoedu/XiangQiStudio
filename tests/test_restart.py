from studio.store import Store
from studio.workflow import Workflow

def test_interrupted_ci_is_retained_and_marked_retryable(tmp_path):
    store=Store(tmp_path)
    code=store.seed({"a.txt":b"original"})["test-a"]["invitation_code"]
    user=store.authenticate(store.login(code)[0])
    workspace=store.workspace(user)
    sid=store.candidate(user,workspace["head"],workspace["base"],"testing","Interrupted")
    shared=store.repo("test").main()
    worker=Workflow(store,object())
    row=store.submission(user,sid)
    assert row["state"]=="failed" and "服务重启" in row["log"]
    assert row["revision"]==workspace["head"]
    assert store.repo("test").main()==shared
    worker.executor.shutdown()
