"""Install this app only; run after extracting the allowlisted bundle under /opt/xiangqi-studio."""
import argparse
from pathlib import Path
import subprocess
import shutil

ROOT = Path("/opt/xiangqi-studio")

def run(*args, **kwargs):
    print("RUN", *args, flush=True)
    subprocess.run(args, check=True, **kwargs)

parser = argparse.ArgumentParser()
parser.add_argument("--image-only", action="store_true")
parser.add_argument("--backend-only", action="store_true")
parser.add_argument("--build-proxy", help="Optional HTTP proxy for image build downloads; not retained in the image")
args = parser.parse_args()
if not args.backend_only:
    if shutil.disk_usage("/").free < 1800 * 1024**2:
        raise SystemExit("Less than 1800 MiB available before image build")
    build = ["docker", "build", "--network=host"]
    if args.build_proxy:
        build += ["--build-arg", "https_proxy=" + args.build_proxy, "--build-arg", "http_proxy=" + args.build_proxy,
                  "--build-arg", "no_proxy=mirrors.tencentyun.com,repo.maven.apache.org"]
    run(*build, "-t", "xiangqi-runner:0.2.0", str(ROOT / "runner"))
    run("docker", "image", "inspect", "--format", "{{.Id}} {{.Size}}", "xiangqi-runner:0.2.0")
if args.image_only:
    raise SystemExit(0)
if not (ROOT / ".venv").exists():
    run("python3", "-m", "venv", str(ROOT / ".venv"))
run(str(ROOT / ".venv/bin/pip"), "install", "--no-cache-dir", str(ROOT))
run("sudo", "-u", "xiangqi-studio", str(ROOT / ".venv/bin/python"), "-m", "studio.initialize",
    "--data-dir", "/var/lib/xiangqi-studio", "--source", str(ROOT / "runner/seed"),
    "--codes-file", "/var/lib/xiangqi-studio/invitations.json", cwd=ROOT)
run("install", "-m", "644", str(ROOT / "deploy/xiangqi-studio.service"), "/etc/systemd/system/xiangqi-studio.service")
run("systemctl", "daemon-reload")
run("systemctl", "enable", "--now", "xiangqi-studio")
run("systemctl", "restart", "xiangqi-studio")
print("BACKEND_INSTALLED", flush=True)
