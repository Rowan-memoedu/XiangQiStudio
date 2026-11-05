import argparse
import json
from pathlib import Path
from .store import Store, safe_path

parser = argparse.ArgumentParser()
parser.add_argument("--data-dir", required=True)
parser.add_argument("--source", required=True)
parser.add_argument("--codes-file", required=True)
args = parser.parse_args()
source = Path(args.source)
files = {}
for path in source.rglob("*"):
    if path.is_file():
        name = path.relative_to(source).as_posix()
        safe_path(name)
        files[name] = path.read_bytes()
codes = Store(Path(args.data_dir)).seed(files)
if codes:
    target = Path(args.codes_file)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8") as output:
        json.dump(codes, output, ensure_ascii=False, indent=2)
    target.chmod(0o600)
print("Initialized accounts:", len(codes), "(invitation codes written to private file)")
