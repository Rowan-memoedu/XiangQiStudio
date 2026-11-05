"""Run as the service user; outputs no credentials."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studio.invitations import rotate_codes
from studio.store import Store

root = Path('/var/lib/xiangqi-studio')
print('Rotated invitation credentials for', rotate_codes(Store(root), root / 'invitations.json'), 'accounts')
