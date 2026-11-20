# 常驻文字识别：一行一个 JSON 请求 {"png": 路径, "boxes": [[x0,y0,x1,y1], ...], "avatars": [[x,y], ...]}，
# 回一行 {"texts": [[文字, 置信度], ...], "avatars": [有没有头像, ...], "ms": 毫秒}。只识别单行小图（发言人昵称），不做检测，快。
# 头像：左边头像位置取 24x24 一块，颜色几乎没变化就是空白（小号自己的消息在右边，左边没头像）。
# 跑法：ocr/bin/python ocr.py（用 ~/wxbot/ocr 这个 venv）
import json
import sys
import time

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()
for line in sys.stdin:
    req = json.loads(line)
    t0 = time.time()
    img = Image.open(req["png"]).convert("RGB")
    texts = []
    for box in req["boxes"]:
        crop = np.array(img.crop(tuple(box)))
        res, _ = engine(crop, use_det=False, use_cls=False, use_rec=True)
        texts.append([res[0][0].strip(), round(float(res[0][1]), 3)] if res else ["", 0])
    avatars = []
    for x, y in req.get("avatars", []):
        a = np.array(img.crop((x - 15, y - 15, x + 15, y + 15)).convert("L").resize((8, 8)), dtype=float)
        # 没头像（小号自己的消息）是空白：返回空串；有头像返回 8x8 均值哈希，名字认不出时拿它区分人
        avatars.append("" if a.std() < 4 else "%016x" % int("".join("1" if v > a.mean() else "0" for v in a.flatten()), 2))
    mine = []
    for x, y in req.get("rights", []):
        a = np.array(img.crop((x - 15, y - 15, x + 15, y + 15)).convert("L").resize((8, 8)), dtype=float)
        mine.append(bool(a.std() >= 4))
    print(json.dumps({"texts": texts, "avatars": avatars, "mine": mine, "ms": round((time.time() - t0) * 1000)}, ensure_ascii=False), flush=True)
