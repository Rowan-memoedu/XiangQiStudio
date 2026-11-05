import json
import pytest
from studio.invitations import ALPHABET, rotate_codes
from studio.store import Store, Problem


def test_short_code_rotation_keeps_account_data_and_sessions(tmp_path):
    store = Store(tmp_path)
    original = store.seed({'pom.xml': b'<project/>', 'src/Main.java': b'class Main {}'})
    path = tmp_path / 'invitations.json'
    path.write_text(json.dumps(original), encoding='utf-8')
    sessions = {uid: store.login(row['invitation_code'])[0] for uid, row in original.items()}
    workspaces = {uid: store.workspace(store.authenticate(token)) for uid, token in sessions.items()}
    assert rotate_codes(store, path) == 4
    updated = json.loads(path.read_text(encoding='utf-8'))
    values = [row['invitation_code'] for row in updated.values()]
    assert len(set(values)) == 4 and all(len(v) == 8 and set(v) <= set(ALPHABET) for v in values)
    for uid, row in updated.items():
        assert store.authenticate(store.login(row['invitation_code'])[0])['id'] == uid
        with pytest.raises(Problem):
            store.login(original[uid]['invitation_code'])
        assert store.workspace(store.authenticate(sessions[uid])) == workspaces[uid]


def test_outdated_private_file_cannot_partially_rotate_accounts(tmp_path):
    store = Store(tmp_path)
    codes = store.seed({'pom.xml': b'<project/>'})
    path = tmp_path / 'invitations.json'
    outdated = json.loads(json.dumps(codes)); outdated['test-a']['invitation_code'] = 'outdated'
    path.write_text(json.dumps(outdated), encoding='utf-8')
    with pytest.raises(RuntimeError, match='out of sync'):
        rotate_codes(store, path)
    for row in codes.values():
        assert store.authenticate(store.login(row['invitation_code'])[0])
