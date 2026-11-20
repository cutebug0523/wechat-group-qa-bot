// 群主指令：路由判成 command 的群主消息，开一个新对话（群规则 + 知识库 + 这几个工具）去办。
// 只有这里有写东西的工具，群友的消息进的答疑对话没有，怎么诱导都改不了知识和开关。
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type Harness } from "@earendil-works/pi-durable";
import { num, obj, str } from "@earendil-works/pi-schema";
import { DIR, MODEL, OWNER_NOTES, PAUSE_FILE, RESEARCH_HOUR, readText } from "./config.ts";
import { ask, chatHeader, Group } from "./group.ts";
import { pickChat } from "./wechat.ts";
import { ref } from "./model.ts";

const NOTES = join(DIR, OWNER_NOTES);
const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });
const today = () => new Date().toLocaleDateString("zh-CN");

/** 闭嘴按群记：{群名: 到几点}。群名带人数、人数会变，按跟现在的群对上的那个算（两个官方群同名，只认最接近的那个）。 */
type Pauses = Record<string, number>;
function readPauses(): Pauses {
	try {
		const m = JSON.parse(readFileSync(PAUSE_FILE, "utf8"));
		return m && typeof m === "object" ? m : {};
	} catch {
		return {};
	}
}
export const pauseFor = (m: Pauses, chat: string, labels: string[]) =>
	Math.max(0, ...Object.entries(m).filter(([g]) => pickChat(labels.map((label) => ({ label })), g)?.label === chat).map(([, u]) => u));
export const pausedUntil = (chat: string, labels: string[]) => pauseFor(readPauses(), chat, labels);

const remember = defineTool({
	name: "remember",
	description: "把群主让记的事存成一条，以后回群友照这个说（跟知识库冲突以它为准）。写成一句能直接用的规则或事实，不要写「群主说」。",
	parameters: obj({ note: str() }),
	execute: async ({ note }) => {
		appendFileSync(NOTES, `- ${note.trim().replace(/\n+/g, " ")}（${today()}）\n`);
		return text("已记");
	},
});

const forget = defineTool({
	name: "forget",
	description: "删掉群主交代里含这个关键词的条目，返回删了哪些。",
	parameters: obj({ keyword: str() }),
	execute: async ({ keyword }) => {
		const lines = readText(OWNER_NOTES).split("\n").filter(Boolean);
		const gone = lines.filter((l) => l.includes(keyword));
		writeFileSync(NOTES, lines.filter((l) => !l.includes(keyword)).map((l) => l + "\n").join(""));
		return text(gone.length ? `删了：\n${gone.join("\n")}` : "没找到含这个词的");
	},
});

// 带话：群主让转给开发的话，攒在 state/relay.jsonl，你自己写个脚本定时取走转给开发（邮件、IM、另一个 AI 会话都行）
export const RELAY = join(DIR, "state", "relay.jsonl");
let curChat = ""; // ponytail: 正在办的指令是哪个群的；两个群同时下指令会串，真碰上再按对话记
const relay = defineTool({
	name: "relay",
	description: "把群主让带给开发的话（反馈机器人的毛病、要改的地方、要查的事）转过去，开发会照着修。",
	parameters: obj({ text: str(), context: str() }),
	execute: async ({ text: t, context }) => {
		appendFileSync(RELAY, JSON.stringify({ ts: Date.now(), chat: curChat, text: t.trim(), context: context.trim() }) + "\n");
		return text("已带");
	},
});

const pause = defineTool({
	name: "pause",
	description: "群主让你闭嘴就暂停在这个群回群友（别的群照常），minutes 是分钟数；让你恢复说话填 0。",
	parameters: obj({ minutes: num() }),
	execute: async ({ minutes }) => {
		const m = Object.fromEntries(Object.entries(readPauses()).filter(([g, u]) => u > Date.now() && g !== curChat)); // 只动这个群
		if (minutes > 0) m[curChat] = Date.now() + minutes * 60_000;
		mkdirSync(dirname(PAUSE_FILE), { recursive: true });
		writeFileSync(PAUSE_FILE, JSON.stringify(m));
		return text(minutes > 0 ? `暂停到 ${new Date(Date.now() + minutes * 60_000).toLocaleTimeString("zh-CN")}` : "已恢复");
	},
});

const BRIEF = `【这次是群主本人在对你下指令】
- 让你记一下、以后这么说：用 remember 存。「记一下」指的是他刚才在群里说的话时，从【最近群聊】里找出来整理成一句再存。
- 说某条不对、忘掉：用 forget 按关键词删，再看要不要 remember 一条对的。
- 让你闭嘴、别回了：pause，只管这个群，没说多久就 60 分钟；让你说话、恢复：pause 填 0。
- 让你回某个人：直接写那条回复（照群里的规则和语气，开头 @ 那个人）。
- 让你带话、转给开发、告诉 Claude、这个毛病记下来给开发修：用 relay，text 照他原意写清楚要什么，context 原样摘【最近群聊】里跟这事相关的几行（谁说了什么、你当时回了什么），然后回「带到了：……」。
- 问你自己的事（有什么功能、某个功能上没上线、现在什么状态）：照【你自己】如实答一两句；那里没写的就说「这个我不道」，别瞎编。
办完一定用一句短话回群主，比如「记下了：……」「删了：……」「行，闭嘴一小时」，让他知道办了。只有他说的其实不是对你下指令、也不是问你、你什么也没办的，才只输出【不回】。`;

const when = (f: string) => {
	try {
		return statSync(join(DIR, f)).mtime.toLocaleString("zh-CN", { hour12: false });
	} catch {
		return "";
	}
};
/** 群主问「你有啥功能、X 上没上线」时答得上：功能是写死的，状态现查。 */
const self = () => {
	const muted = Object.entries(readPauses()).filter(([, u]) => u > Date.now());
	const pending = (readText("待群主确认.md").match(/^- /gm) ?? []).length;
	return `【你自己】（群主问你的功能、状态时照这个答）
- 会的：按知识库答群里的问题；看群友发的图；真 @ 人；群主 @ 你让你记、删、闭嘴、替他回人、给开发带话（开发一般几分钟内收到）。
- 联网自学：已上线，每天 ${RESEARCH_HOUR} 点带着前一天群里的问题上网查别家软件、模型的事，写进外部资料（答疑时会参考）；查到的跟知识库对不上的，列进「待群主确认」等群主拍板，不自己改知识库。${when("外部资料.md") ? `外部资料上次更新 ${when("外部资料.md")}。` : "还没跑出过外部资料。"}待群主确认现在 ${pending} 条。
- 不会的：查不了后台数据，这类叫群主。
- 现在：${muted.length ? `${muted.map(([g, u]) => `${g} 闭嘴到 ${new Date(u).toLocaleTimeString("zh-CN", { hour12: false })}`).join("；")}，别的群正常在答` : "各群都正常在答"}。`;
};

export const Owner = defineExtension({
	name: "owner",
	tools: [remember, forget, pause, relay],
	sections: [section("owner_brief", () => BRIEF, { tag: false }), section("self", self, { tag: false })],
});

/** 办一条群主指令：每次一个新对话，带最近群聊。 */
export async function runCommand(harness: Harness, chat: string, recent: string[], lines: string[]) {
	curChat = chat;
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref(MODEL), thinkingLevel: "low", extensions: [Group, Owner], maxTurns: 6 } }, ctx);
	return ask(conv, [chatHeader(chat), "【最近群聊】", recent.join("\n") || "（没有）", "", "【群主对你说】", ...lines]);
}
