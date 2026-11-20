// 值守循环：每 3 秒读一遍各群窗口，新消息截一张图认发言人，名字是群主的点头像核对微信号。
// 按群+人攒到这人停 8 秒（最后是图就 20 秒，最长 60 秒）成一批过总路由：answer 交给答疑对话，skip 记成【旁听】，command（只可能是核对过的群主）交给群主指令对话。
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { GROUPS, OWNERS, readText } from "./config.ts";
import { chatHeader } from "./group.ts";
import { pausedUntil, runCommand } from "./owner.ts";
import { route, type Batch } from "./router.ts";
import { describe } from "./vision.ts";
import { arrange, chats, imageOf, items, noteSpeaker, PENDING, shot, whoOf, wxidOf, type Chat, type Item } from "./wechat.ts";

const POLL_MS = 3_000;
const QUIET_MS = 8_000; // 这人停 8 秒没再发就出一批
const QUIET_AFTER_IMG_MS = 20_000; // 最后一条是图就多等：微信里图和字分开发，一般先图后字
const MAX_WAIT_MS = 60_000; // 一直在说也最多攒 60 秒
const RECENT = 40;
const SHOT = "/dev/shm/wxbot-shot.png";
const IMG_PER_PERSON = 3; // 每人每分钟最多看几张图，多的按「[图片]」，防刷钱
const IMG_ALL = 12; // 所有群合计每分钟最多看几张

// img：看图还在后台跑，出来是「[图片：描述]」（失败就是「[图片]」，从不 reject）
export type WxMessage = { chat: string; who: string; text: string; owner: boolean; img?: Promise<string> };

export const onlyNoise = (text: string) => !text.replace(/\[(表情|动画表情)\]|\s/g, "");
const UNKNOWN = "?"; // 顶端滚出窗口、看不见昵称的
export const lineOf = (m: WxMessage) => `${m.owner ? "【群主】" : ""}${m.who === UNKNOWN ? "（没认出）" : m.who || "（答疑助手）"}：${m.text}`;

/** 纯状态机，方便自检：按群+人攒消息，这人停 8 秒（最后是图停 20 秒，最长 60 秒）吐一批。 */
export class Inbox {
	pending = new Map<string, { since: number; last: number; img: boolean; waiting: number; batch: Batch }>();

	add(m: WxMessage, now: number) {
		if (!m.who || m.who === UNKNOWN || onlyNoise(m.text)) return; // 空名字是机器人自己（右边气泡没昵称）
		const k = `${m.chat}\u0000${m.who}\u0000${m.owner}`; // 核对过的群主和同名的人分开成批
		const p = this.pending.get(k) ?? { since: now, last: now, img: false, waiting: 0, batch: { chat: m.chat, who: m.who, owner: m.owner, lines: [] } };
		const i = p.batch.lines.push(lineOf(m)) - 1;
		p.last = now;
		p.img = m.text.startsWith("[图片");
		if (m.img) {
			p.waiting++; // 图还没看完这批不出
			m.img.then((text) => (p.batch.lines[i] = lineOf({ ...m, text }))).finally(() => p.waiting--);
		}
		this.pending.set(k, p);
	}

	due(now: number): Batch[] {
		const out = [];
		for (const [k, p] of this.pending) {
			if (p.waiting || (now - p.last < (p.img ? QUIET_AFTER_IMG_MS : QUIET_MS) && now - p.since < MAX_WAIT_MS)) continue;
			this.pending.delete(k);
			out.push(p.batch);
		}
		return out;
	}
}

/** 看图限量：每人每分钟 IMG_PER_PERSON 张，合计 IMG_ALL 张。 */
const imgLog: { who: string; at: number }[] = [];
function allowImage(who: string, now: number) {
	while (imgLog.length && now - imgLog[0].at > 60_000) imgLog.shift();
	if (imgLog.length >= IMG_ALL || imgLog.filter((l) => l.who === who).length >= IMG_PER_PERSON) return false;
	imgLog.push({ who, at: now });
	return true;
}

let imgN = 0;
/** 点开大图截下来（占鼠标 1.5 秒），模型看图放后台，不卡读群。 */
async function seeImage(c: Chat, it: Item, who: string): Promise<{ text: Promise<string> } | undefined> {
	const png = `/dev/shm/wxbot-img-${imgN++ % 50}.png`;
	if (!(await imageOf(c, it, png))) return undefined;
	const text = describe(png).then(
		(d) => (console.error(`[看图] ${c.label} ${who}：${d.slice(0, 80)}`), `[图片：${d}]`),
		(e) => (console.error("[看图] 模型失败", String(e).slice(0, 100)), "[图片]"),
	);
	return { text }; // 包一层，不然 async 会把它等完
}

/** 条目路径会被微信复用（滚出顶上的条目挪去放新消息，11-18 实测 12 个路径 7 个放过不同消息），
 *  所以「路径+正文」只在最近两轮里算数：两轮里见过、位置也没从上头跳到下头的才算看过。
 *  「图片」「好的」这种正文一样的，旧条目被挪去放新的一条，路径和正文都不变，只有位置往下跳了一大截。 */
export const JUMP = 400; // 新消息进来旧条目只会往上走；图片加载撑高也到不了这么多
export type Pos = Map<string, number>; // 条目 key → 顶边 y
export function freshItems<T extends { key: string; ext: number[] }>(its: T[], hist: Pos[]): T[] {
	const known: Pos = new Map(hist.flatMap((m) => [...m])); // 新一轮的覆盖旧的
	return its.filter((it) => {
		const y = known.get(it.key);
		return y === undefined || it.ext[1] - y > JUMP;
	});
}

/** 读各群新出现的消息。第一次只认名字不核对群主（屏上原有的只进最近群聊）。
 *  hist：每个群最近两轮屏上的条目和位置；上一轮的一条都不剩说明中间滚过去的没读到，记一句。 */
const pending = new Map<string, number>(); // 头像还没出来的条目，等了几轮
async function readNew(list: Chat[], verify: boolean, hist: Map<string, Pos[]>): Promise<WxMessage[]> {
	const perChat = await Promise.all(list.map(async (c) => ({ c, its: await items(c) })));
	const fresh: { c: Chat; it: Item }[] = [];
	for (const { c, its } of perChat) {
		const h = hist.get(c.label) ?? [];
		const before = h.at(-1);
		if (before?.size && its.length && !its.some((it) => before.has(it.key))) console.error(`[漏消息] ${c.label} 上一轮看到的一条都不在屏上了，中间可能有没读到的`);
		for (const it of freshItems(its, h)) fresh.push({ c, it });
		hist.set(c.label, [...h, new Map(its.map((it) => [it.key, it.ext[1]]))].slice(-2)); // 留两轮：哪轮名字没读出来也不会当新消息再读一遍
	}
	if (!fresh.length) return [];
	shot(SHOT);
	const shown = fresh.filter(({ it }) => !it.cut);
	const ocrNames = await whoOf(SHOT, shown.map(({ it }) => it));
	const names = fresh.map(({ it }) => (it.cut ? UNKNOWN : ocrNames[shown.findIndex((s) => s.it === it)]));
	const ownerWxid = readText("owner_wxid").trim();
	const out: WxMessage[] = [];
	for (const [i, { c, it }] of fresh.entries()) {
		let who = names[i];
		if (who === PENDING) {
			const n = (pending.get(it.key) ?? 0) + 1;
			if (n < 5) {
				pending.set(it.key, n);
				hist.get(c.label)?.at(-1)?.delete(it.key); // 下一轮还算新的，再看一次
				continue;
			}
			who = UNKNOWN; // 等了 5 轮头像还没出来，当认不出名字的群友
		}
		pending.delete(it.key);
		let owner = false;
		if (verify && OWNERS.has(who)) {
			const wxid = await wxidOf(it).catch((e) => (console.error("点头像失败", String(e).slice(0, 100)), ""));
			owner = !!ownerWxid && wxid === ownerWxid;
			if (!owner) console.error(`[认人] ${c.label} 有人叫「${who}」但微信号对不上（${wxid || "没读到"}）`);
		}
		if (who && who !== UNKNOWN) noteSpeaker(c.label, who, it.key);
		const img = verify && who && who !== UNKNOWN && it.text === "[图片]" && allowImage(who, Date.now()) ? (await seeImage(c, it, who))?.text : undefined;
		out.push({ chat: c.label, who, text: it.text, owner, img });
	}
	return out;
}

export async function watch(harness: Harness, group: Conversation) {
	const inbox = new Inbox();
	const recent = new Map<string, string[]>();
	const hist = new Map<string, Pos[]>();
	let list: Chat[] = [];
	let first = true;
	const note = (text: string) =>
		group.submit({ type: "write", entry: { kind: "wx.note", data: text, model: [{ role: "user", content: text, timestamp: Date.now() }] } }, ctx);
	for (;;) {
		try {
			if (!list.length) {
				await arrange(GROUPS); // 微信重启过就把群重新拆出来排好
				list = await chats(GROUPS);
				console.error(`[值守] 盯着 ${list.map((c) => c.label).join("、") || "（没找到拆出来的群窗口）"}`);
			}
			const msgs = await readNew(list, !first, hist);
			for (const m of msgs) {
				const r = recent.get(m.chat) ?? [];
				r.push(lineOf(m));
				recent.set(m.chat, r.slice(-RECENT));
				m.img?.then((text) => {
					const rc = recent.get(m.chat) ?? [];
					const j = rc.lastIndexOf(lineOf(m)); // 看完了把最近群聊里那行「[图片]」换成描述
					if (j >= 0) rc[j] = lineOf({ ...m, text });
				});
				if (!first) inbox.add(m, Date.now());
			}
			first = false;
			const batches = inbox.due(Date.now());
			for (const [chat, bs] of Map.groupBy(batches, (b) => b.chat)) {
				const rc = recent.get(chat) ?? [];
				const routes = await route(rc, bs);
				const paused = Date.now() < pausedUntil(chat, list.map((c) => c.label));
				for (const [i, b] of bs.entries()) {
					const head = chatHeader(chat);
					if (b.owner) await note([head, ...b.lines].join("\n")); // 群主的话答疑对话都要知道
					if (routes[i] === "command") runCommand(harness, chat, rc, b.lines).catch((e) => console.error("群主指令没办成", String(e).slice(0, 200)));
					else if (routes[i] === "answer" && !paused) await group.submit({ type: "input", content: [head, ...b.lines].join("\n") }, ctx);
					else if (!b.owner) await note([head, ...b.lines.map((l) => `【旁听】${l}`)].join("\n"));
				}
			}
		} catch (e) {
			console.error("值守出错", String(e).slice(0, 200));
			list = []; // 窗口没了或界面变了，下一轮重新找，屏上已有的重新当看过
			hist.clear();
			first = true;
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
}
