"""Activate the source-layout revision after the 0.2 runner image is built."""
import hashlib
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess
import tarfile

root = Path('/var/lib/xiangqi-studio')
app = Path('/opt/xiangqi-studio')
backup = Path('/tmp/xiangqi-before-0.2.0.tar.gz')
if backup.exists():
    raise RuntimeError('Backup already exists; preserve it before retrying')
subprocess.run(['docker', 'image', 'inspect', 'xiangqi-runner:0.2.0'], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['systemctl', 'stop', 'xiangqi-studio'], check=True)
try:
    connection = sqlite3.connect(root / 'state.sqlite3')
    connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    connection.close()
    with tarfile.open(backup, 'w:gz') as archive:
        archive.add(root / 'state.sqlite3', arcname='state.sqlite3')
        archive.add(root / 'groups', arcname='groups')
        for path in (root / 'runtime').glob('*/data'):
            archive.add(path, arcname=path.relative_to(root).as_posix())
    ubuntu = pwd.getpwnam('ubuntu')
    os.chown(backup, ubuntu.pw_uid, ubuntu.pw_gid); backup.chmod(0o600)
    print('Backup:', backup.name, backup.stat().st_size, hashlib.sha256(backup.read_bytes()).hexdigest(), flush=True)
    with tarfile.open('/tmp/xiangqi-revision.tar.gz') as archive:
        members = [m for m in archive.getmembers() if not m.name.startswith('runner/')]
        archive.extractall(app, members=members, filter='data')
    subprocess.run(['runuser', '-u', 'xiangqi-studio', '--', str(app / '.venv/bin/python'),
                    str(app / 'deploy/upgrade-course.py')], check=True)
    configuration = Path('/etc/xiangqi-studio.env')
    lines = [line for line in configuration.read_text().splitlines() if not line.startswith('XQ_RUNNER_IMAGE=')]
    configuration.write_text('\n'.join(lines) + '\nXQ_RUNNER_IMAGE=xiangqi-runner:0.2.0\n')
    configuration.chmod(0o600)
finally:
    subprocess.run(['systemctl', 'start', 'xiangqi-studio'], check=True)
