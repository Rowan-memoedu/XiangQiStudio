"""Migrate a known course release through Git merges, preserving all user heads.

Run as the service user while the service is stopped. The caller takes a database
and Git backup first. No account, chat, comment or game data is modified here.
"""
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studio.store import Store, digest
from studio.runtime import Runtime

root = Path('/var/lib/xiangqi-studio')
app = Path(__file__).resolve().parent.parent
previous = json.loads((app / 'deploy/previous-course.json').read_text())
seed = {p.relative_to(app / 'runner/seed').as_posix(): p.read_bytes()
        for p in (app / 'runner/seed').rglob('*') if p.is_file()}
store = Store(root)
runtime = Runtime(store, 'xiangqi-runner:0.2.0')
stamp = str(int(time.time()))
plans = []
for team in ('main', 'test'):
    repo = store.repo(team)
    shared = repo.main()
    baseline = None
    for revision in repo.call('rev-list', '--first-parent', shared).stdout.decode().splitlines():
        files = repo.files(revision)
        if all(name in files and digest(files[name]) == checksum for name, checksum in previous.items()):
            baseline = revision
            break
    if baseline is None:
        # The first test branch predates the guide correction in the formal release.
        # Pin its known seed commit; every other course file must still match.
        initial = '0e83b866ce7f1f331f165520f3d070d23b44a1e6'
        initial_files = repo.files(initial)
        is_ancestor = repo.call('merge-base', '--is-ancestor', initial, shared, check=False).returncode == 0
        if team == 'test' and is_ancestor and all(name in initial_files and digest(initial_files[name]) == checksum
                for name, checksum in previous.items() if name != 'docs/代码导读.md'):
            baseline = initial
        else:
            raise RuntimeError('No verified previous course revision in ' + team)
    files = repo.files(baseline)
    for name in previous:
        files.pop(name, None)
    for name, data in seed.items():
        if name in files and files[name] != data:
            raise RuntimeError('New template path collides with retained file: ' + name)
        files[name] = data
    template = repo.commit(files, [baseline], 'Simplify course structure and document extension design')
    updated, conflict = repo.merge(shared, template)
    if conflict:
        repo.call('update-ref', 'refs/releases/' + stamp + '-template', template)
        raise RuntimeError('Shared source conflict; both versions retained: ' + team)
    passed, log = runtime.check(repo.files(updated))
    (root / ('upgrade-' + stamp + '-' + team + '.log')).write_text(log)
    if not passed:
        raise RuntimeError('Updated course failed CI: ' + team)
    with store.db() as db:
        users = [dict(row) for row in db.execute('SELECT id,name,team FROM accounts WHERE team=?', (team,))]
    drafts = []
    for user in users:
        ws = store.workspace(user)
        if ws['head'] == shared:
            merged, issue = updated, ''
        else:
            merged, issue = repo.merge(updated, ws['head'])
        if merged and repo.files(merged) != repo.files(updated):
            passed, log = runtime.check(repo.files(merged))
            (root / ('upgrade-' + stamp + '-' + user['id'] + '.log')).write_text(log)
            if not passed:
                issue = 'Migrated private draft failed CI. Original draft retained.\n' + log
                merged = None
        drafts.append((user, ws, merged, issue))
    plans.append((team, shared, updated, drafts))

# All shared revisions and cleanly merged drafts have passed CI before advancing.
report = []
for team, shared, updated, drafts in plans:
    repo = store.repo(team)
    repo.call('update-ref', 'refs/releases/' + stamp + '-shared', shared)
    for user, ws, _, _ in drafts:
        repo.call('update-ref', 'refs/releases/' + stamp + '-' + user['id'], ws['head'])
    repo.advance(updated, shared)
    for user, ws, merged, issue in drafts:
        if issue:
            sid = store.candidate(user, ws['head'], ws['base'], 'sync-conflict', '课程结构升级时保留的私人草稿')
            store.update_submission(sid, 'sync-conflict', issue)
            report.append({'account': user['id'], 'state': 'preserved-conflict', 'candidate': sid})
            continue
        with store.db() as db:
            db.execute('UPDATE workspaces SET head=?,base=? WHERE account=? AND head=?',
                       (merged, updated, user['id'], ws['head']))
            if db.execute('SELECT changes()').fetchone()[0] != 1:
                raise RuntimeError('Workspace changed during maintenance')
        repo.call('update-ref', 'refs/drafts/' + user['id'], merged)
        store.materialize(user['id'], repo.files(merged))
        report.append({'account': user['id'], 'state': 'updated', 'head': merged})
print(json.dumps({'release': stamp, 'accounts': report}, ensure_ascii=False), flush=True)
