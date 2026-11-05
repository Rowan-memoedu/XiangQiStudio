"""Build an allowlisted deployment bundle; never includes credentials or app data."""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
course = Path("D:/Projects/SUSTech-CS109-XiangQi")
output = Path("D:/Artifacts/XiangQiStudio/deploy.tar.gz")
output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(output, "w:gz") as bundle:
    for directory in ("studio", "dist", "deploy", "docs"):
        for path in (root / directory).rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts:
                bundle.add(path, arcname=path.relative_to(root).as_posix())
    for name in ("pyproject.toml", "README.md"):
        bundle.add(root / name, arcname=name)
    for name in ("Dockerfile", "runner.py", "StudioLauncher.java"):
        bundle.add(root / "runner" / name, arcname="runner/" + name)
    for path in course.rglob("*"):
        relative = path.relative_to(course)
        if path.is_file() and relative.parts[0] in ("src", "test", "docs", "pom.xml", "README.md", ".gitignore"):
            bundle.add(path, arcname="runner/seed/" + relative.as_posix())
    # A digest-only map locates the previous canonical course revision safely.
    previous = {}
    paths = subprocess.check_output(["git", "ls-tree", "-rz", "--name-only", "860790b"], cwd=course).decode().rstrip('\0').split('\0')
    for name in paths:
        data = subprocess.check_output(["git", "show", "860790b:" + name], cwd=course)
        previous[name] = hashlib.sha256(data).hexdigest()
    data = json.dumps(previous).encode()
    info = tarfile.TarInfo("deploy/previous-course.json"); info.size = len(data)
    bundle.addfile(info, io.BytesIO(data))
print(output, output.stat().st_size, "bytes")
