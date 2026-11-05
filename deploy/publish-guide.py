"""Publish only the reviewed guide using normal CI; refuse unrelated draft changes."""
import json
from pathlib import Path
import subprocess
import time
import httpx

source=Path('D:/Projects/SUSTech-CS109-XiangQi')
path='docs/代码导读.md'
content=(source/path).read_text(encoding='utf-8')
previous=subprocess.check_output(['git','show','HEAD:'+path],cwd=source).decode()
codes=json.loads(Path('D:/AppData/XiangQiStudio/invitations.json').read_text(encoding='utf-8'))
for first,second in [('test-a','test-b'),('owner','partner')]:
    for uid in (first,second):
        with httpx.Client(base_url='https://124.221.144.155/xiangqi/api/',headers={'Origin':'https://124.221.144.155'},timeout=30) as client:
            login=client.post('login',json={'code':codes[uid]['invitation_code']});login.raise_for_status()
            client.headers['X-CSRF-Token']=login.json()['csrf']
            def api(method,route,**kwargs):
                result=client.request(method,route,**kwargs);result.raise_for_status();return result.json()
            try:
                if uid==first:
                    ws=api('GET','workspace')
                    assert ws['head']==ws['shared'],'Personal draft differs; preserve and inspect before publishing'
                    before=api('GET','file',params={'path':path})
                    assert before['content'].strip()==previous.strip(),'Guide has changed; preserve and inspect'
                    expected={f['path']:f['sha'] for f in ws['files']}
                    saved=api('PUT','file',json={'path':path,'content':content,'expected_sha':before['sha']})
                    expected[path]=saved['sha']
                    assert {f['path']:f['sha'] for f in api('GET','workspace')['files']}==expected,'Concurrent draft changes; preserve and inspect'
                    sid=api('POST','submit',json={'title':'详细代码导读与17张调用关系图'})['id']
                    for _ in range(120):
                        row=api('GET','submissions/'+sid)
                        if row['state'] not in ('queued','testing'):
                            assert row['state']=='merged',row['state']
                            print(uid,'guide CI and merge passed',flush=True);break
                        time.sleep(2)
                    else:raise RuntimeError('CI timeout')
                api('POST','pull')
                assert api('GET','file',params={'path':path})['content']==content
                print(uid,'guide synchronized',flush=True)
            finally:api('POST','logout')
