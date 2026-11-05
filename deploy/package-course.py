from pathlib import Path
import hashlib
import json
import zipfile

source=Path("D:/Projects/SUSTech-CS109-XiangQi")
target=Path("D:/Artifacts/SUSTech-CS109-XiangQi/ChineseChess-IDEA.zip")
target.parent.mkdir(parents=True,exist_ok=True)
files=[]
with zipfile.ZipFile(target,"w",zipfile.ZIP_DEFLATED) as zipped:
    for path in sorted(source.rglob("*")):
        relative=path.relative_to(source)
        if path.is_file() and relative.parts[0] in ("src","docs","pom.xml","README.md",".gitignore"):
            zipped.write(path,"XiangQi/"+relative.as_posix());files.append(relative.as_posix())
with zipfile.ZipFile(target) as zipped:
    assert zipped.testzip() is None
    assert "XiangQi/pom.xml" in zipped.namelist()
    assert "XiangQi/src/main/java/edu/sustech/xiangqi/Main.java" in zipped.namelist()
report={"file":str(target),"bytes":target.stat().st_size,"sha256":hashlib.sha256(target.read_bytes()).hexdigest(),"files":files}
target.with_suffix(".manifest.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps({k:v for k,v in report.items() if k!="files"},ensure_ascii=False))
