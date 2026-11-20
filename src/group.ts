// 答疑群：一个持久对话。每批新消息是一次输入；答完由 afterRun 起一个 Reply 任务去发（只读期写日志）。
// Reply 是持久任务：进程在发之前挂了，重开后接着发，发过的不会再发第二次。
import { appendFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTask, GenerationTask, hook, runEndTask, section, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { DRAFTS, GROUPS, isLive, OWNER_NOTES, readText } from "./config.ts";
import { send } from "./wechat.ts";

export const SKIP = "【不回】";

/** 一条消息里给人看的文字（跳过思考块）。 */
export function textOf(message: Message | undefined): string {
	if (!message) return "";
	const c = message.content;
	if (typeof c === "string") return c;
	return c.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

export const isSkip = (answer: string) => !answer || answer.includes(SKIP);

/** 每次输入第一行标是哪个群，发回复按它找群。 */
export const chatHeader = (chat: string) => `【群：${chat}】`;
const chatOf = (text: string) => text.match(/^【群：(.+?)】/)?.[1] ?? "";

type ReplyInput = { asked: string[]; answer: string; at: number; chat?: string };

export const Reply = defineTask<ReplyInput, { phase: "deliver" }, null>({
	name: "wx.reply",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const { asked, answer, at, chat } = task.input;
			// ponytail: 粘贴回车之后、提交之前进程挂了，重开会再发一遍；真碰上再按 task.id 记已发
			const live = !!chat && isLive(chat);
			if (live) await send(GROUPS, chat!, answer);
			appendFileSync(DRAFTS, JSON.stringify({ ts: new Date(at).toLocaleString("zh-CN", { hour12: false }), chat, sent: live, asked, draft: answer }) + "\n");
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_t, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const userText = (e: EntryRecord) => (e.model?.[0]?.role === "user" ? textOf(e.model[0]) : "");

/** 这次输入里开口的人（不算【旁听】、不算群主的话记录），回复开头 @ 的必须是其中一个。 */
export const speakers = (inputs: string[]) =>
	new Set(inputs.flatMap((t) => t.split("\n")).flatMap((l) => (l.startsWith("【") && !l.startsWith("【群主】") ? [] : [l.replace(/^【群主】/, "").split("：")[0]])));
/** 回复 @ 了这批里没开口的人：多半是在接之前的话，答非所问，不发。 */
export const wrongTarget = (answer: string, inputs: string[]) => {
	const at = answer.match(/^@(\S+)/)?.[1];
	return !!at && ![...speakers(inputs)].some((s) => s.includes(at) || at.includes(s)); // 「群友0c1f762e」常被简写成「@0c1f762e」
};

/** 模型偶尔答完不收，接着把对话往下编（11-19 11:39 回一个群友时编出 8564 字的内部上下文，发进 2群被微信以太长拦下，
 *  弹窗挂了一天，挡住名字被认成「我知道了」）：从第一行像对话标记的地方截断；截完还超长就不发。 */
export const MAX_REPLY = 400;
export function clip(answer: string): string {
	// 思考写进了正文（11-20 回一条调侃时把 <thinking>…</thinking> 发进群）：去掉成对的；只有开头没收尾的整条不要
	answer = answer.replace(/<(think|thinking)>[\s\S]*?<\/\1>/g, "");
	if (/<\/?(think|thinking)>/.test(answer)) return "";
	const lines = answer.split("\n");
	const cut = lines.findIndex((l) => /^\s*(user|assistant|【(群|旁听|群主|最近群聊|群主对你说)】?)/.test(l));
	return (cut < 0 ? answer : lines.slice(0, cut).join("\n")).trim();
}

/** 答完了（不是【不回】）就起一个 Reply 去发。群对话和群主指令对话共用。 */
export const sendAnswer = hook(GenerationTask, {
	afterRun: async (run, api, context) => {
		const raw = textOf((await api.entry(run.answer, context))?.model?.[0]);
		if (isSkip(raw)) return undefined;
		const answer = clip(raw);
		if (answer !== raw) console.error(`[截断] 模型答完没收住，${raw.length} 字截到 ${answer.length} 字`);
		if (!answer || answer.length > MAX_REPLY) {
			console.error(`[不发] 回复 ${answer.length} 字，太长：${answer.slice(0, 60)}`);
			return undefined;
		}
		const { items } = await api.entries({ minEntryId: run.first, maxEntryId: run.last, order: "ascending" }, 200, undefined, context);
		const asked = items.map(userText).filter(Boolean);
		const inputs = items.filter((e) => e.kind !== "wx.note").map(userText).filter(Boolean);
		if (inputs.length && wrongTarget(answer, inputs)) {
			console.error(`[不发] @ 的人这批里没开口：${answer.slice(0, 60)}`);
			return undefined;
		}
		return { tasks: [runEndTask(Reply, { asked, answer, at: Date.now(), chat: chatOf(asked[0] ?? "") })] };
	},
});

export const ownerNotes = section("owner_notes", () => {
	const t = readText(OWNER_NOTES).trim();
	return t ? `群主在群里当场交代的，跟知识库冲突以这里为准：\n${t}` : undefined;
});

export const Group = defineExtension({
	name: "group",
	tasks: [Reply],
	sections: [
		section("rules", () => readText("prompt.md"), { tag: false }),
		section("knowledge", () => readText("knowledge.md")),
		section("external_notes", () => readText("外部资料.md") || undefined),
		ownerNotes,
	],
	hooks: [sendAnswer],
});

/** 问一批消息，等答完，返回回复（不回就是空串）。 */
export async function ask(conv: Conversation, lines: string[], requestId?: string) {
	const sub = await conv.submit({ type: "input", content: lines.join("\n"), requestId }, ctx);
	const settled = await sub.wait(ctx);
	if (settled.status !== "done" || settled.type !== "input") throw new Error(`没答出来：${JSON.stringify(settled).slice(0, 300)}`);
	const { items } = await conv.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, ctx);
	const answer = textOf(items[0]?.model?.[0]);
	return isSkip(answer) ? "" : answer;
}
