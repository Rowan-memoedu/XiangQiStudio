import json
from pathlib import Path

root=Path("D:/AppData/XiangQiStudio")
codes=json.loads((root/"invitations.json").read_text(encoding="utf-8"))
lines=["# 象棋协作工作台登录", "", "入口：https://124.221.144.155/xiangqi/", "",
       "每人使用自己的 8 位邀请码，包含大写字母和数字。邀请码就是登录凭据，请只交给对应使用者。", "",
       "| 账号 | 用途 | 邀请码 |", "|---|---|---|"]
for uid in ("owner","partner","test-a","test-b"):
    role="正式协作区" if uid in ("owner","partner") else "隔离测试区"
    lines.append(f"| {codes[uid]['name']}（{uid}） | {role} | `{codes[uid]['invitation_code']}` |")
lines += ["", "正式与测试协作区的共同代码、留言和运行数据分开。首轮最多两路运行 / 语义会话；不用时请点击停止或退出。",
          "", "游戏窗口里的登录 / 注册用于游戏存档，与网页邀请码独立。", "", "离线打开项目：解压源代码 ZIP，在 IntelliJ IDEA 中打开 pom.xml 所在目录，选择 JDK 25，运行 Main.main()。"]
(root/"登录说明.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
print("Private login instructions written for",len(codes),"accounts")
