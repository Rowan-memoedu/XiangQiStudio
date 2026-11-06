"""Project Q&A is a single-context conversation, with no model tools or agent loop."""
import json
import os
import httpx
from .store import Problem


def selected_source(files, selection):
    if not selection:
        return ""
    path = selection.path
    if path not in files:
        raise Problem("选中的文件已经移动，请重新选择", 409)
    try:
        source = files[path].decode("utf-8")
    except UnicodeDecodeError as error:
        raise Problem("请选择可阅读的文本文件") from error
    first, last = selection.start_line, selection.end_line
    if first is None and last is None:
        return f"当前解释文件：{path}\n请解释项目上下文中这一整个文件的职责、主要结构和调用关系。"
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if first is None or last is None or first < 1 or last < first or last > len(lines):
        raise Problem("所选行范围已改变，请重新选择", 400)
    snippet = "\n".join(f"{i + 1}: {lines[i]}" for i in range(first - 1, last))
    return f"当前明确选中的程序：{path} 第 {first}–{last} 行\n{snippet}\n回答须以这一段为中心，并结合完整项目解释它的调用关系。"


async def answer_events(messages, key, transport=None):
    """Stream complete text; keep and label partial output if the provider stops early.

    A length-limited response may continue twice using the same fixed context.
    This only continues text generation; it never invokes tools or reads more files.
    """
    history = list(messages)
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=20), transport=transport) as client:
        for attempt in range(3):
            part = ""
            finish = None
            async with client.stream("POST", "https://api.deepseek.com/chat/completions",
                    headers={"Authorization": "Bearer " + key}, json={
                        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-flash"), "messages": history,
                        "thinking": {"type": "disabled"}, "max_tokens": 16384, "stream": True}) as response:
                if response.status_code != 200:
                    raise Problem("问答服务暂时不可用（供应商状态 " + str(response.status_code) + "）", 502)
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    payload = json.loads(data)
                    choices = payload.get("choices", [])
                    if not choices:
                        continue
                    choice = choices[0]
                    text = choice.get("delta", {}).get("content") or ""
                    if text:
                        part += text
                        yield {"type": "delta", "text": text}
                    if choice.get("finish_reason"):
                        finish = choice["finish_reason"]
            if finish == "length" and part and attempt < 2:
                history += [{"role": "assistant", "content": part},
                            {"role": "user", "content": "请从刚才中断的位置继续，补完原问题的回答，不重复已经写出的内容。"}]
                yield {"type": "status", "text": "正在接续尚未完成的回答…"}
                continue
            yield {"type": "finish", "finish_reason": finish or "aborted"}
            return
