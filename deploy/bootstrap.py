"""First installation on the dedicated, already-authorized Tencent host (root)."""
import json
from pathlib import Path
import shutil
import subprocess


def run(*args):
    print("RUN", *args, flush=True)
    subprocess.run(args, check=True)


if shutil.disk_usage("/").free < 3 * 1024**3:
    raise SystemExit("Need at least 3 GiB before first runtime installation")
config = Path("/etc/docker/daemon.json")
if not shutil.which("docker"):
    if config.exists():
        raise SystemExit("Existing Docker configuration needs inspection")
    config.parent.mkdir(exist_ok=True)
    config.write_text(json.dumps({"bridge": "none", "iptables": False, "ip6tables": False,
                                  "ip-forward": False, "log-driver": "local",
                                  "log-opts": {"max-size": "5m", "max-file": "2"}}))
    run("apt-get", "update", "-qq")
    run("apt-get", "install", "-y", "--no-install-recommends", "docker.io", "python3-venv")
run("systemctl", "enable", "--now", "docker")
if subprocess.run(["id", "xiangqi-studio"], capture_output=True).returncode:
    run("useradd", "--system", "--home-dir", "/var/lib/xiangqi-studio", "--shell", "/usr/sbin/nologin", "xiangqi-studio")
run("usermod", "-aG", "docker", "xiangqi-studio")
run("install", "-d", "-m", "700", "-o", "xiangqi-studio", "-g", "xiangqi-studio", "/var/lib/xiangqi-studio")
run("install", "-d", "-m", "755", "/opt/xiangqi-studio")
run("docker", "version")
print("BOOTSTRAP_COMPLETE", flush=True)
