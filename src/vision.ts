// 群友发的图：截大图交给能看图的模型，转成一段文字塞进消息，路由和答疑都按文字处理。
import { readFileSync } from "node:fs";
import { KEY_FILE, MODEL } from "./config.ts";
import { BASE } from "./model.ts";

const PROMPT = "这是答疑群里群友发的截图或照片。用一两句话说清是什么；有报错、配置、界面上的关键文字就原样摘出来。只输出描述。";

// 主模型那条线偶尔慢到超时（11-16 19:16 DS flash 卡了 90 秒），换另一家模型再看一次
const FALLBACK = "qwen3.8-flash";

export async function describe(png: string): Promise<string> {
	try {
		return await ask(png, MODEL);
	} catch (e) {
		console.error(`[看图] ${MODEL} 失败，换 ${FALLBACK}`, String(e).slice(0, 100));
		return ask(png, FALLBACK);
	}
}

async function ask(png: string, model: string): Promise<string> {
	const res = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${readFileSync(KEY_FILE, "utf8").trim()}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			reasoning_effort: "none",
			messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(png).toString("base64")}` } }] }],
		}),
		signal: AbortSignal.timeout(40_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const j = (await res.json()) as { choices: { message: { content: string } }[] };
	return j.choices[0].message.content.trim().replace(/\s*\n+\s*/g, " ");
}
