// 入口：node src/main.ts <watch|ask|dump|shot|selftest>
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, type Conversation, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODEL, STATE } from "./config.ts";
import { ask, Group } from "./group.ts";
import { Owner, runCommand } from "./owner.ts";
import { Research, ResearchTask, Schedule } from "./research.ts";
import { ref, llmModels } from "./model.ts";

export async function openBot(storage: Storage) {
	const registry = createRegistry();
	registry.install(Group);
	registry.install(Owner);
	registry.install(Research);
	registry.install(Schedule);
	const harness = await Harness.open(storage, {
		models: llmModels(),
		registry,
		settings: { extensions: [Group, Schedule], followUpMode: "all", retry: { maxRetries: 3 }, compaction: {
				reserveTokens: 32_000,
				keepRecentTokens: 40_000,
				// 答疑是一个一直聊下去的对话：到 40 万 token 就压（上限 1024000 减 624000），后台提前约 3 万开始；夜里自学的模型不受影响
				modelOverrides: { [`llm/${MODEL}`]: { reserveTokens: 624_000 } },
			},
		},
		onReport: (r) => console.error("[report]", r.kind, String((r as { error?: unknown }).error ?? "").slice(0, 300)),
	}, ctx);
	const group = await harness.root(ctx, { agent: { model: ref(MODEL), thinkingLevel: "low", maxTurns: 4 } });
	return { harness, group };
}

/** 自学任务：没有活着的就建一个（后台，不占着群对话）。now 为真时立刻跑一次。 */
export async function ensureResearch(group: Conversation, now = false) {
	return group.commit(async (tx) => {
		const live = (await tx.scanTasks({ kind: ResearchTask.definition.name }, 10)).items.find((t) => t.state.status !== "terminal");
		if (live && !now) return live.id;
		return tx.createTask(ResearchTask, { now }, { ownership: { kind: "conversation" }, conversationId: group.id, background: true });
	}, ctx);
}

export { ask };

const cmd = import.meta.main ? process.argv[2] : undefined; // 被别的文件 import 时不跑命令
if (cmd === "ask") {
	const { harness, group } = await openBot(new MemoryStorage());
	console.log((await ask(group, [`群友：${process.argv.slice(3).join(" ")}`])) || "【不回】");
	await harness.close(ctx);
} else if (cmd === "sim") {
	// 模拟一段群聊走完整流程：node src/main.ts sim "小王：429了" "【群主】老板：@答疑助手 记一下 xxx"（【群主】= 已核对过微信号）
	const { route } = await import("./router.ts");
	const { lineOf } = await import("./watch.ts");
	const { chatHeader } = await import("./group.ts");
	const { harness, group } = await openBot(new MemoryStorage());
	const chat = "测试群";
	const msgs = process.argv.slice(3).map((l) => {
		const [who, ...t] = l.replace(/^【群主】/, "").split(/[：:]/);
		return { chat, who, text: t.join("："), owner: l.startsWith("【群主】") };
	});
	const recent = msgs.map(lineOf);
	const batches = [...Map.groupBy(msgs, (m) => `${m.who}|${m.owner}`).values()].map((ms) => ({ chat, who: ms[0].who, owner: ms[0].owner, lines: ms.map(lineOf) }));
	const routes = await route(recent, batches);
	for (const [i, b] of batches.entries()) {
		console.log(`\n== ${routes[i]} ← ${b.lines.join(" / ")}`);
		if (routes[i] === "answer") console.log((await ask(group, [chatHeader(chat), ...b.lines])) || "【不回】");
		if (routes[i] === "command") console.log((await runCommand(harness, chat, recent, b.lines)) || "【不回】");
	}
	await harness.close(ctx);
} else if (cmd === "seeimg") {
	// 认屏上最后一张图试试：node src/main.ts seeimg 窗口名(带人数)
	const wx = await import("./wechat.ts");
	const c = wx.pickChat(await wx.chats([process.argv[3].replace(/\(\d+\)$/, "")]), process.argv[3]);
	const it = c && (await wx.items(c)).findLast((i) => i.text === "[图片]");
	if (!c || !it) throw new Error("没找到窗口或图片");
	const t0 = Date.now();
	if (!(await wx.imageOf(c, it, "/dev/shm/wxbot-img.png"))) throw new Error("大图没打开");
	const t1 = Date.now();
	console.log(await (await import("./vision.ts")).describe("/dev/shm/wxbot-img.png"));
	console.log(`开图截图 ${t1 - t0} ms，看图 ${Date.now() - t1} ms`);
	process.exit(0);
} else if (cmd === "sendtest") {
	// 往一个拆出来的窗口发一句试试：node src/main.ts sendtest 窗口名 话
	const wx = await import("./wechat.ts");
	// 窗口名可以带人数（「示例群(125)」），同名群按人数挑
	const c = wx.pickChat(await wx.chats([process.argv[3].replace(/\(\d+\)$/, "")]), process.argv[3]);
	if (!c) throw new Error("没找到窗口");
	const its = await wx.items(c);
	const names = await wx.whoOf("/dev/shm/wxbot-shot.png", (wx.shot("/dev/shm/wxbot-shot.png"), its));
	its.forEach((it, i) => names[i] && wx.noteSpeaker(c.label, names[i], it.key)); // 屏上的人都记下，回复开头 @ 谁就真 @ 谁
	await wx.send([c.label.replace(/\(\d+\)$/, "")], c.label, process.argv.slice(4).join(" "));
	console.log("发了", c.label);
	process.exit(0);
} else if (cmd === "names" || cmd === "whois") {
	// names：各群屏上每条消息认出来的发言人和耗时；whois：再点每个群最后一条群主名字的消息核对微信号
	const wx = await import("./wechat.ts");
	const { GROUPS, OWNERS } = await import("./config.ts");
	let t = Date.now();
	const list = await wx.chats(GROUPS);
	console.log(`找群窗口 ${Date.now() - t} ms：${list.map((c) => c.label).join("、")}`);
	for (const c of list) {
		t = Date.now();
		const its = await wx.items(c);
		const tRead = Date.now() - t;
		wx.shot("/dev/shm/wxbot-shot.png");
		const tShot = Date.now() - t - tRead;
		const names = (await wx.whoOf("/dev/shm/wxbot-shot.png", its)).map((n, i) => (its[i].cut ? "（顶端看不见）" : n || "（小号自己）"));
		console.log(`== ${c.label}：读条目 ${tRead} ms，截图 ${tShot} ms，认名字 ${Date.now() - t - tRead - tShot} ms（${its.length} 条）`);
		its.forEach((it, i) => console.log(`  ${names[i] || "（无）"}：${it.text.slice(0, 40)}`));
		if (cmd === "whois") {
			const i = names.findLastIndex((n) => OWNERS.has(n));
			if (i < 0) continue;
			t = Date.now();
			console.log(`  点「${its[i].text.slice(0, 20)}」的头像 → 微信号 ${(await wx.wxidOf(its[i])) || "没读到"}（${Date.now() - t} ms）`);
		}
	}
	process.exit(0);
} else if (cmd === "watch") {
	mkdirSync(dirname(STATE), { recursive: true });
	const { harness, group } = await openBot(await openNodeSqliteStorage(STATE));
	harness.resume();
	await ensureResearch(group);
	const { watch } = await import("./watch.ts");
	await watch(harness, group);
} else if (cmd === "research-now") {
	// 立刻自学一次（用临时内存存储，不碰正式状态），看写出来的 外部资料.md
	const { harness, group } = await openBot(new MemoryStorage());
	await ask(group, process.argv.slice(3).map((q) => `群友：${q}`));
	const id = await ensureResearch(group, true);
	const done = await harness.waitForTask(id, ctx).catch((e) => e);
	console.log("自学结束", JSON.stringify((done as { state?: unknown }).state ?? String(done)).slice(0, 300));
	await harness.close(ctx);
} else if (cmd === "press") {
	console.log(await (await import("./wechat.ts")).press(process.argv[3], Number(process.argv[4] ?? 4)) ? "按了" : "没找到");
	process.exit(0);
} else if (cmd === "arrange") {
	// 手动排群：缺的从主窗口拆出来，全部排满屏
	const wx = await import("./wechat.ts");
	console.log("排了", await wx.arrange((await import("./config.ts")).GROUPS), "个群窗口");
	process.exit(0);
} else if (cmd === "dump" || cmd === "shot") {
	const wx = await import("./wechat.ts");
	if (cmd === "dump") await wx.dump();
	else wx.shot(process.argv[3] ?? "shot.png", process.argv[4]);
} else if (cmd !== undefined) {
	console.error("用法：node src/main.ts <watch|ask 问题|sim 名字：话…|names|whois|dump|shot 文件 [窗口号]>");
	process.exit(1);
}
