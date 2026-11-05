import asyncio
import json
from types import SimpleNamespace
import httpx
import pytest
from studio.chat import answer_events, selected_source
from studio.store import Problem


def test_selection_is_resolved_from_the_saved_project():
    files = {"src/Main.java": b"first\nsecond\nthird\n"}
    context = selected_source(files, SimpleNamespace(path="src/Main.java", start_line=2, end_line=3))
    assert "2: second\n3: third" in context and "1: first" not in context
    with pytest.raises(Problem):
        selected_source(files, SimpleNamespace(path="src/Main.java", start_line=1, end_line=4))


def test_long_response_is_streamed_and_continued_in_full():
    calls=[]
    long_text="完整回答内容。" * 2200
    def reply(request):
        payload=json.loads(request.content); calls.append(payload)
        text=long_text if len(calls)==1 else "最后一段，回答结束。"
        reason="length" if len(calls)==1 else "stop"
        chunks=[{"choices":[{"delta":{"content":text},"finish_reason":None}]},
                {"choices":[{"delta":{},"finish_reason":reason}]}]
        return httpx.Response(200,text="".join("data: "+json.dumps(c,ensure_ascii=False)+"\n\n" for c in chunks)+"data: [DONE]\n\n")
    async def collect():
        return [event async for event in answer_events([{"role":"user","content":"详细解释"}],"test-key",httpx.MockTransport(reply))]
    events=asyncio.run(collect())
    assert "".join(e["text"] for e in events if e["type"]=="delta")==long_text+"最后一段，回答结束。"
    assert events[-1]=={"type":"finish","finish_reason":"stop"}
    assert len(calls)==2 and calls[0]["thinking"]=={"type":"disabled"}
    assert calls[1]["messages"][-2]["content"]==long_text


def test_provider_disconnect_is_not_reported_as_complete():
    def reply(request):
        return httpx.Response(200,text='data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    async def collect():
        return [e async for e in answer_events([],"test-key",httpx.MockTransport(reply))]
    assert asyncio.run(collect())[-1]["finish_reason"]=="aborted"
