"""Add one route to the verified existing TLS server; validate before reload."""
from pathlib import Path
import shutil
import subprocess
import urllib.request
import urllib.error
import time

root = Path("/opt/xiangqi-studio")
site = Path("/etc/nginx/sites-enabled/graspmemoedu").resolve()
before = site.read_text()
include = "    include /etc/nginx/snippets/xiangqi-studio.conf;"
if include not in before:
    marker = "    listen 443 ssl default_server;"
    if before.count(marker) != 1:
        raise SystemExit("Expected one existing TLS server")
    backup = root / "nginx-before-xiangqi.conf"
    if not backup.exists():
        backup.write_text(before)
        backup.chmod(0o600)
    shutil.copyfile(root / "deploy/nginx-map.conf", "/etc/nginx/conf.d/xiangqi-map.conf")
    shutil.copyfile(root / "deploy/nginx-location.conf", "/etc/nginx/snippets/xiangqi-studio.conf")
    site.write_text(before.replace(marker, marker + "\n" + include))
    result = subprocess.run(["nginx", "-t"])
    if result.returncode:
        site.write_text(before)
        raise SystemExit("Nginx validation failed; original site restored")
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    time.sleep(1)
for path in ("/xiangqi/api/health", "/api/health", "/openfocus/", "/app/"):
    try:
        with urllib.request.urlopen("https://124.221.144.155" + path, timeout=15) as response:
            print(path, response.status, flush=True)
    except urllib.error.HTTPError as error:
        if path.startswith("/xiangqi/"):
            raise
        print(path, error.code, flush=True)
