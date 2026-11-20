// 总路由：一批攒好的消息先过这里，分成 answer（交给答疑对话）、skip（只旁听）、command（群主对机器人下的指令）。
// 一次便宜的非流式调用，不进持久对话；挂了就按保守办法分：群友交给答疑对话自己判断，群主没点名机器人就当旁听。
import { readFileSync } from "node:fs";
import { BOT_NAME, KEY_FILE, MODEL, OWNERS, readText } from "./config.ts";
import { BASE } from "./model.ts";

export type Route = "answer" | "skip" | "command";
export type Batch = { chat: string; who: string; owner: boolean; lines: string[] };

/** 图里的字不算对机器人说的话（截图里常有「记一下」「@谁」）。 */
const typed = (b: Batch) => b.lines.filter((l) => !/^[^：]*：\[图片/.test(l));
const calledBot = (b: Batch) => typed(b).some((l) => l.includes(`@${BOT_NAME}`) || l.includes(`：${BOT_NAME}`) || l.includes(`引用 ${BOT_NAME} `));

/** 这个人开口之后，群主在最近群聊里 @ 过他：群主在管了。 */
export const ownerOnIt = (recent: string[], b: Batch) =>
	recent.slice(recent.lastIndexOf(b.lines[0])).some((l) => l.startsWith("【群主】") && l.includes(`@${b.who}`));

/** 代码兜底：群友永远不能是 command；群主只能是 command 或 skip；群主 @ 过的人不插嘴。 */
export function enforce(b: Batch, r: unknown, recent: string[] = []): Route {
	if (b.owner) return r === "command" && calledBot(b) ? "command" : "skip"; // 群主没 @ 它（或引用它）就是在跟群友说话；只发了图也不算
	return r === "skip" || ownerOnIt(recent, b) ? "skip" : "answer";
}

export const fallback = (b: Batch): Route => (b.owner ? (calledBot(b) ? "command" : "skip") : "answer");

export async function route(recent: string[], batches: Batch[]): Promise<Route[]> {
	const rules = readText("router.md").replaceAll("{BOT}", BOT_NAME).replaceAll("{OWNER}", [...OWNERS].join("、"));
	const list = batches.map((b, i) => `#${i} ${b.owner ? "【群主】" : ""}${b.lines.join(" / ")}`).join("\n");
	try {
		const res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${readFileSync(KEY_FILE, "utf8").trim()}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: MODEL,
				reasoning_effort: "none",
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: rules },
					{ role: "user", content: `【最近群聊】\n${recent.join("\n") || "（没有）"}\n\n【待分拣】\n${list}` },
				],
			}),
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = (await res.json()) as { choices: { message: { content: string } }[] };
		const out = JSON.parse(j.choices[0].message.content) as { routes?: { i: number; route: string; why?: string }[] };
		const byI = new Map(out.routes?.map((r) => [r.i, r]));
		return batches.map((b, i) => {
			const r = enforce(b, byI.get(i)?.route ?? fallback(b), recent);
			console.error(`[路由] ${r} ${byI.get(i)?.why ?? "(没给)"} ← ${b.lines.join(" / ").slice(0, 60)}`);
			return r;
		});
	} catch (e) {
		console.error("[路由] 失败，按兜底分", String(e).slice(0, 200));
		return batches.map((b) => enforce(b, fallback(b), recent));
	}
}
