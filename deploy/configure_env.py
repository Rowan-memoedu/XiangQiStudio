"""Read the DeepSeek key from SSH stdin, never from arguments or logged output."""
import json
from pathlib import Path
import sys

value = json.load(sys.stdin)["key"]
if not value or any(c in value for c in "\r\n\x00"):
    raise SystemExit("Invalid key format")
target = Path("/etc/xiangqi-studio.env")
target.touch(mode=0o600, exist_ok=True)
target.chmod(0o600)
target.write_text("XQ_DATA_DIR=/var/lib/xiangqi-studio\nXQ_ORIGIN=https://124.221.144.155\n"
                  "XQ_COOKIE_PATH=/xiangqi/\nXQ_STATIC_DIR=/opt/xiangqi-studio/dist\n"
                  "DEEPSEEK_MODEL=deepseek-flash\nDEEPSEEK_API_KEY=" + value + "\n")
print("Private environment installed")
