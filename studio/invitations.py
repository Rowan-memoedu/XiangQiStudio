"""Short invitation credentials; session and CSRF token lengths stay independent."""
import json
import os
import secrets

ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def new_code():
    return ''.join(secrets.choice(ALPHABET) for _ in range(8))


def rotate_codes(store, path):
    """Rotate all four hashes and their private delivery file, retaining sessions."""
    original = path.read_bytes()
    previous = json.loads(original)
    temporary = path.with_name(path.name + '.pending')
    replaced = False
    from .store import digest
    try:
        with store.lock, store.db() as db:
            rows = list(db.execute('SELECT id,name,code_hash FROM accounts ORDER BY id'))
            if {row['id'] for row in rows} != {'owner', 'partner', 'test-a', 'test-b'}:
                raise RuntimeError('Expected the four configured accounts')
            codes, used = {}, set()
            for row in rows:
                if digest(previous[row['id']]['invitation_code']) != row['code_hash']:
                    raise RuntimeError('Private invitation file is out of sync')
                code = new_code()
                while code in used or any(digest(code) == old['code_hash'] for old in rows):
                    code = new_code()
                used.add(code)
                codes[row['id']] = {'name': row['name'], 'invitation_code': code}
                db.execute('UPDATE accounts SET code_hash=? WHERE id=?', (digest(code), row['id']))
            with temporary.open('x', encoding='utf-8') as output:
                temporary.chmod(0o600)
                json.dump(codes, output, ensure_ascii=False, indent=2)
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(path)
            replaced = True
    except BaseException:
        if replaced:
            path.write_bytes(original)
            path.chmod(0o600)
        raise
    finally:
        temporary.unlink(missing_ok=True)
    return len(codes)
