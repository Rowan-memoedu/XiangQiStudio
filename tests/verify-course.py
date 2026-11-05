"""Read-only verification of formal workspaces and downloadable course content."""
import hashlib
import io
import json
from pathlib import Path
import zipfile
import httpx

source=Path('D:/Projects/SUSTech-CS109-XiangQi')
output=Path('D:/Artifacts/XiangQiStudio/revision')
codes=json.loads(Path('D:/AppData/XiangQiStudio/invitations.json').read_text(encoding='utf-8'))
files={p.relative_to(source).as_posix():p.read_bytes() for p in source.rglob('*')
       if p.is_file() and p.relative_to(source).parts[0] in ('src','test','docs','pom.xml','README.md','.gitignore')}
expected={p:hashlib.sha256(data).hexdigest() for p,data in files.items()}
report=[]
for uid in ('owner','partner'):
    with httpx.Client(base_url='https://124.221.144.155/xiangqi/api/',headers={'Origin':'https://124.221.144.155'},timeout=30) as client:
        response=client.post('login',json={'code':codes[uid]['invitation_code']});response.raise_for_status()
        client.headers['X-CSRF-Token']=response.json()['csrf']
        try:
            response=client.get('workspace');response.raise_for_status();workspace=response.json()
            actual={f['path']:f['sha'] for f in workspace['files']}
            assert actual==expected, 'Formal source changed; preserve and inspect differences'
            response=client.get('download');response.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                assert archive.testzip() is None
                assert set(archive.namelist())=={'XiangQi/'+p for p in files}
                assert all(archive.read('XiangQi/'+p)==data for p,data in files.items())
                assert json.loads(archive.comment)['base']==workspace['base']
            if uid=='owner':(output/'formal-project.zip').write_bytes(response.content)
            report.append({'account':uid,'files':len(files),'exact_source_match':True,'clean_zip':True,'head':workspace['head']})
        finally:
            client.post('logout')
output.mkdir(parents=True,exist_ok=True)
(output/'formal-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report),flush=True)
