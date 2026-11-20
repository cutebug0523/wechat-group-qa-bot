// 读虚拟屏里的微信：走 D-Bus 调无障碍接口（AT-SPI）读界面，xdotool 点头像，不注入、不改微信。
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import dbus from "dbus-next";
import { DIR } from "./config.ts";

type Ref = { bus: string; path: string };
const ACC = "org.a11y.atspi.Accessible";

let a11y: dbus.MessageBus | undefined;
async function bus() {
	if (a11y) return a11y;
	const session = dbus.sessionBus();
	const reply = await session.call(new dbus.Message({ destination: "org.a11y.Bus", path: "/org/a11y/bus", interface: "org.a11y.Bus", member: "GetAddress" }));
	session.disconnect();
	a11y = dbus.sessionBus({ busAddress: reply!.body[0] as string });
	return a11y;
}

async function call(ref: Ref, iface: string, member: string, signature = "", body: unknown[] = []) {
	const reply = await (await bus()).call(new dbus.Message({ destination: ref.bus, path: ref.path, interface: iface, member, signature, body }));
	return reply!.body;
}

const children = async (ref: Ref): Promise<Ref[]> => ((await call(ref, ACC, "GetChildren"))[0] as [string, string][]).map(([b, p]) => ({ bus: b, path: p }));
const role = async (ref: Ref) => (await call(ref, ACC, "GetRoleName"))[0] as string;
const name = async (ref: Ref) => ((await call(ref, "org.freedesktop.DBus.Properties", "Get", "ss", [ACC, "Name"]))[0] as dbus.Variant).value as string;

type Node = { ref: Ref; role: string; name: string; depth: number };

async function* walk(ref: Ref, depth = 0): AsyncGenerator<Node> {
	yield { ref, role: await role(ref), name: await name(ref), depth };
	for (const c of await children(ref).catch(() => [])) yield* walk(c, depth + 1);
}

async function frame(): Promise<Ref | undefined> {
	for (const app of await children({ bus: "org.a11y.atspi.Registry", path: "/org/a11y/atspi/accessible/root" })) {
		if ((await name(app).catch(() => "")) === "wechat") return (await children(app))[0];
	}
}

export async function dump() {
	const f = await frame();
	if (!f) throw new Error("没找到微信窗口");
	for await (const n of walk(f)) console.log(`${"  ".repeat(n.depth)}${n.role} | ${JSON.stringify(n.name)}`.slice(0, 200));
}

/** 按名字找按钮按一下（只搜到 maxDepth 层，整棵树太大）。 */
export async function press(label: string, maxDepth = 4) {
	const f = await frame();
	if (!f) throw new Error("没找到微信窗口");
	const queue: [Ref, number][] = [[f, 0]];
	while (queue.length) {
		const [ref, d] = queue.shift()!;
		if ((await name(ref).catch(() => "")) === label && (await role(ref)) === "push button") {
			await call(ref, "org.a11y.atspi.Action", "DoAction", "i", [0]);
			return true;
		}
		if (d < maxDepth) for (const c of await children(ref).catch(() => [])) queue.push([c, d + 1]);
	}
	return false;
}

// ---- 读群：每个群拆成独立窗口（双击会话），左右排开不重叠，各自有一个叫「消息」的 list ----
// 消息条目只有正文和坐标，没有发言人：发言人靠截图认气泡上方的昵称；群主再点头像看资料卡里的微信号。

const SCALE = 100 / 96; // ponytail: 界面按 96dpi 报坐标、Xvfb 是 100dpi；换虚拟屏分辨率要重量
export type Chat = { label: string; list: Ref; input?: Ref };
export type Item = { key: string; text: string; ext: number[]; cut: boolean }; // cut：顶端滚出了窗口，昵称看不见

async function wechatApp(): Promise<Ref> {
	for (const app of await children({ bus: "org.a11y.atspi.Registry", path: "/org/a11y/atspi/accessible/root" })) {
		if ((await name(app).catch(() => "")) === "wechat") return app;
	}
	throw new Error("没找到微信");
}

/** 拆出来的群窗口：窗口名等于群名，标题标签带人数，比如「示例群(126)」。 */
export async function chats(groups: string[]): Promise<Chat[]> {
	const out: Chat[] = [];
	for (const win of await children(await wechatApp())) {
		if (!groups.includes(await name(win).catch(() => ""))) continue;
		let list: Ref | undefined, input: Ref | undefined, label = "";
		for await (const n of walk(win)) {
			if (n.role === "list" && n.name === "消息") list = n.ref;
			if (n.role === "text" && n.name === "输入") input = n.ref;
			if (!label && n.role === "label" && /\(\d+\)$/.test(n.name)) label = n.name;
		}
		if (list) out.push({ label: label || "群", list, input });
	}
	return out;
}

const extents = async (ref: Ref) => (await call(ref, "org.a11y.atspi.Component", "GetExtents", "u", [0]))[0] as number[];
// 系统提示：名字带引号开头，或者企业微信用户说明
const isSystem = (t: string) => /^"[^"]+"\s*(撤回|邀请|加入|移出|修改群名|拍了拍|成为|开启|与群里|通过)|为企业微信用户|^你(邀请|撤回|修改)/.test(t);
const isTime = (t: string) => /^(\d{1,2}:\d{2}|昨天.*|星期.*|\d+月\d+日.*|\d{4}年.*)$/.test(t);

/** 群里现在看得到的消息（不含时间分隔条）。key 用条目路径+正文：新消息是新条目。 */
export async function items(chat: Chat): Promise<Item[]> {
	const out: Item[] = [];
	const listTop = (await extents(chat.list))[1];
	for (const ref of await children(chat.list)) {
		const text = (await name(ref).catch(() => "")).trim();
		if (!text || isTime(text) || isSystem(text)) continue;
		const ext = await extents(ref);
		out.push({ key: `${ref.path}|${text}`, text: text === "图片" ? "[图片]" : text, ext, cut: ext[1] < listTop - 8 }); // 昵称在条目顶下 10 像素，顶端稍微压一点还看得见
	}
	return out;
}

/** 屏幕像素：昵称条、头像中心。按 11-11 实测：条目顶上 10–30 像素、头像左边 70 像素起是昵称，头像中心在左 40、顶下 27。 */
const top = (it: Item) => it.ext[1] * SCALE;
export const nameBox = (it: Item) => [it.ext[0] * SCALE + 70, top(it) + 10, it.ext[0] * SCALE + 330, top(it) + 30].map(Math.round);
export const avatar = (it: Item) => [Math.round(it.ext[0] * SCALE + 40), Math.round(top(it) + 27)];
/** 小号自己的气泡头像在右边，离窗口右沿 42 像素（11-20 截图量的）。 */
export const avatarR = (it: Item) => [Math.round((it.ext[0] + it.ext[2]) * SCALE - 42), Math.round(top(it) + 27)];
/** 左右都没头像：刚收到、头像还没画出来，这一轮先不认（11-20 群主 @ 它那条被当成小号自己的丢了）。 */
export const PENDING = "（头像没出来）";

/** 头像指纹每次截图会差几位（实测同一个人被认成过只差 1 位的两个指纹）：差 6 位以内算同一个头像，用先见到的那个。 */
const seenAvatars: string[] = [];
const bits = (a: string, b: string) => [...(BigInt(`0x${a}`) ^ BigInt(`0x${b}`)).toString(2)].filter((c) => c === "1").length;
export function sameAvatar(h: string) {
	const hit = seenAvatars.find((s) => bits(s, h) <= 6);
	if (hit) return hit;
	seenAvatars.push(h);
	return h;
}

/** 常驻文字识别进程（~/wxbot/ocr 里的 RapidOCR），一行请求一行回答。 */
let ocrProc: ReturnType<typeof spawn> | undefined;
let ocrQueue = Promise.resolve<unknown>(undefined);
/** 认每条的发言人：右边有头像的（小号自己）返回空串；左右都没有返回 PENDING；名字认不出的返回「群友xxxx」。 */
export const whoOf = (png: string, its: Item[]) => ocr(png, its.map(nameBox), its.map(avatar), its.map(avatarR));
function ocr(png: string, boxes: number[][], avatars: number[][], rights: number[][]): Promise<string[]> {
	if (!ocrProc) {
		ocrProc = spawn(join(DIR, "ocr", "bin", "python"), [join(DIR, "ocr.py")], { stdio: ["pipe", "pipe", "inherit"] });
		ocrProc.on("exit", () => (ocrProc = undefined));
	}
	const p = ocrQueue.then(
		() =>
			new Promise<string[]>((resolve, reject) => {
				const proc = ocrProc!;
				let buf = "";
				const onData = (d: Buffer) => {
					buf += d;
					if (!buf.includes("\n")) return;
					proc.stdout!.off("data", onData);
					try {
						// 没头像 → 空串（小号自己）；有头像名字没认准 → 「群友」+头像指纹，照样答，但当不了群主
						const r = JSON.parse(buf) as { texts: [string, number][]; avatars: string[]; mine: boolean[] };
						resolve(r.texts.map(([t, conf], i) => (!r.avatars[i] ? (r.mine[i] ? "" : PENDING) : conf > 0.6 && /[\p{L}\p{N}]/u.test(t) ? t : `群友${sameAvatar(r.avatars[i]).slice(0, 8)}`)));
					} catch (e) {
						reject(e);
					}
				};
				proc.stdout!.on("data", onData);
				proc.stdin!.write(JSON.stringify({ png, boxes, avatars, rights }) + "\n");
			}),
	);
	ocrQueue = p.catch(() => undefined);
	return p;
}

const xdo = (...args: string[]) => execFileSync("xdotool", args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 动鼠标键盘的操作排队，点头像和发消息不能同时进行。 */
let uiLock: Promise<unknown> = Promise.resolve();
export function withUi<T>(fn: () => Promise<T>): Promise<T> {
	const p = uiLock.then(fn);
	uiLock = p.catch(() => undefined);
	return p;
}

/** 按标题找群：先比群名，同名的几个（两个官方群）再挑人数最接近的。人数会随进群变，不能整串比。 */
const baseOf = (label: string) => label.replace(/\(\d+\)$/, "");
const countOf = (label: string) => Number(label.match(/\((\d+)\)$/)?.[1] ?? 0);
export function pickChat<T extends { label: string }>(list: T[], label: string): T | undefined {
	const same = list.filter((c) => baseOf(c.label) === baseOf(label));
	return same.sort((a, b) => Math.abs(countOf(a.label) - countOf(label)) - Math.abs(countOf(b.label) - countOf(label)))[0];
}

/** 每个群里每个人最近一条消息（条目 key），发回复时按它找头像做真 @。只在内存里，重启就没了（退回贴文字）。 */
const speakers = new Map<string, Map<string, string>>();
export function noteSpeaker(label: string, who: string, key: string) {
	if (!speakers.has(label)) speakers.set(label, new Map());
	speakers.get(label)!.set(who, key);
}

const clickAt = (ext: number[], button = "1") =>
	xdo("mousemove", String(Math.round((ext[0] + ext[2] / 2) * SCALE)), String(Math.round((ext[1] + ext[3] / 2) * SCALE)), "click", button);

/** 右键这个人的头像，点菜单里的「@ 某人」，往输入框插一个真 @。插上了返回 true。 */
async function mention(chat: Chat, key: string): Promise<boolean> {
	const it = (await items(chat)).find((i) => i.key === key && !i.cut);
	if (!it) return false; // 那条已经滚出屏幕
	const [x, y] = avatar(it);
	xdo("mousemove", String(x), String(y), "click", "3");
	await sleep(500);
	for (const win of await children(await wechatApp())) {
		if (await name(win).catch(() => "x")) continue; // 菜单是没名字的顶层窗口
		for await (const n of walk(win)) {
			if (n.role === "menu item" && n.name.startsWith("@")) {
				clickAt(await extents(n.ref)); // 只点「@」那一项，绝不碰「拍一拍」
				await sleep(300);
				return true;
			}
		}
	}
	xdo("key", "Escape");
	return false;
}

/** 往群里发一条：开头是「@某人 」且这人最近的消息还在屏上，就右键头像插真 @；否则点输入框整段粘贴。回车发出。 */
export function send(groups: string[], label: string, text: string) {
	return withUi(async () => {
		const chat = pickChat(await chats(groups), label);
		if (!chat?.input) throw new Error(`没找到群窗口或输入框：${label}`);
		clickAt(await extents(chat.input));
		xdo("key", "ctrl+a", "Delete"); // 先清掉输入框里的残留
		const known = [...(speakers.get(label)?.entries() ?? [])].sort((a, b) => b[0].length - a[0].length);
		const hit = known.find(([who]) => text.startsWith(`@${who}`));
		const mentioned = hit ? await mention(chat, hit[1]) : false;
		if (hit) console.error(`[发送] @${hit[0]} ${mentioned ? "真 @" : "没插上，贴文字"}`);
		// 「群友xxxx」是认不出名字时的代号，群里没这个人：插不上真 @ 就别当文字贴出去
		const body = mentioned ? text.slice(hit![0].length + 1).trimStart() : text.replace(/^@群友[0-9a-f]+\s*/, "");
		if (!mentioned) clickAt(await extents(chat.input));
		execFileSync("xclip", ["-selection", "clipboard"], { input: body, stdio: ["pipe", "ignore", "ignore"] });
		await sleep(150);
		xdo("key", "ctrl+v");
		await sleep(300);
		if (process.env.WXBOT_DRY) return; // 试插 @ 用：不回车，留在输入框里看
		xdo("key", "Return");
		await sleep(300);
	});
}

/** 点这条消息的头像，读资料卡上的微信号，Esc 关掉。读不到返回空串（不是好友的卡可能不显示）。 */
export const wxidOf = (it: Item) => withUi(() => readWxid(it));
async function readWxid(it: Item): Promise<string> {
	const [x, y] = avatar(it);
	xdo("mousemove", String(x), String(y), "click", "1");
	await sleep(800);
	let wxid = "";
	try {
		for (const win of await children(await wechatApp())) {
			let prev = "";
			for await (const n of walk(win)) {
				if (n.role === "label" && prev === "微信号：") wxid = n.name.trim();
				if (n.role === "label") prev = n.name;
			}
			if (wxid) break;
		}
	} finally {
		xdo("key", "Escape");
	}
	return wxid;
}

/** 虚拟屏截图存 PNG（扫码登录时发给群主）。 */
export function shot(path: string, win?: string) {
	const d = execFileSync("xwd", [...(win ? ["-id", win] : ["-root"]), "-silent"], { maxBuffer: 64 << 20 });
	const hs = d.readUInt32BE(0), w = d.readUInt32BE(16), h = d.readUInt32BE(20), bpp = d.readUInt32BE(44) / 8, bpl = d.readUInt32BE(48), ncol = d.readUInt32BE(76);
	const off = hs + ncol * 12, raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		const o = y * (w * 3 + 1);
		for (let x = 0; x < w; x++) {
			const s = off + y * bpl + x * bpp; // 小端：B G R (X)
			raw[o + 1 + x * 3] = d[s + 2]; raw[o + 2 + x * 3] = d[s + 1]; raw[o + 3 + x * 3] = d[s];
		}
	}
	const chunk = (t: string, b: Buffer) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(b.length);
		const tb = Buffer.concat([Buffer.from(t), b]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
		return Buffer.concat([len, tb, crc]);
	};
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
	writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}


/** 点开一张图片的大图，截「图片和视频」窗口存到 path，再 Esc 关掉。没打开返回 false。 */
/** 点开一张图片的大图，截「图片和视频」窗口存到 path，再 Esc 关掉。打不开重试一次，失败原因打日志、当时整屏存 /dev/shm/wxbot-imgfail.png。 */
export const imageOf = (chat: Chat, it: Item, path: string) =>
	withUi(async () => {
		for (let attempt = 1; attempt <= 2; attempt++) {
			const why = await openImage(chat, it, path);
			if (!why) return true;
			console.error(`[看图] 第 ${attempt} 次没打开：${why}`);
			if (why.startsWith("条目")) return false; // 已经滚走了，再等也没用
			shot("/dev/shm/wxbot-imgfail.png");
			await sleep(2000); // 刚收到的图可能还在下载
		}
		return false;
	}).catch((e) => (console.error("[看图] 出错", String(e).slice(0, 200)), false));

const viewer = () => {
	try {
		return execFileSync("xdotool", ["search", "--onlyvisible", "--name", "^图片和视频$"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0];
	} catch {
		return ""; // 没有时 xdotool 返回 1
	}
};

/** 打开成功返回空串，否则返回原因。 */
async function openImage(chat: Chat, it: Item, path: string): Promise<string> {
	const now = (await items(chat)).find((i) => i.key === it.key); // 新消息进来列表会动，点之前重新取位置
	if (!now) return "条目已经不在屏上";
	const listTop = (await extents(chat.list))[1] * SCALE;
	const bottom = top(now) + now.ext[3] * SCALE;
	const y = Math.round((Math.max(top(now) + 30, listTop + 10) + bottom) / 2); // 图在昵称下面，顶上被压住就取看得见的那段中间
	const x = Math.round(now.ext[0] * SCALE + 100);
	if (y >= bottom - 5) return `看得见的部分太小（y=${y}）`;
	xdo("mousemove", String(x), String(y), "click", "1");
	for (let i = 0; i < 25; i++) {
		await sleep(200);
		const win = viewer();
		if (!win) continue;
		await sleep(1000); // 等大图下载、渲染完
		shot(path, win);
		xdo("key", "Escape");
		await sleep(300);
		return "";
	}
	return `点了 (${x},${y}) 5 秒没出看图窗口`;
}

// ---- 自动排群：微信重启后群窗口没了，从主窗口「会话」列表里双击拆出来，再左右排满屏 ----
const WIN_W = 426;
const SCREEN_H = 900; // 跟 start.sh 里 Xvfb 的分辨率走
const MAIN_PARK = ["1400", "117"]; // 主窗口平时停在屏外

const xids = (pattern: string) => {
	try {
		return execFileSync("xdotool", ["search", "--name", pattern], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").filter(Boolean);
	} catch {
		return []; // 没有时 xdotool 返回 1
	}
};
const winSize = (id: string) => {
	const m = /Geometry: (\d+)x(\d+)/.exec(execFileSync("xdotool", ["getwindowgeometry", id]).toString());
	return m ? Number(m[1]) * Number(m[2]) : 0;
};

/** 主窗口「会话」列表里名字是这几个群的条目（第一行是会话名）。 */
async function sessions(groups: string[]) {
	const f = await frame(); // 微信的第一个顶层就是主窗口
	if (!f) throw new Error("没找到微信主窗口");
	const out: Ref[] = [];
	for await (const n of walk(f)) {
		if (n.role === "list item" && groups.includes(n.name.split("\n")[0])) out.push(n.ref);
	}
	return out;
}

/** 群窗口不够就从主窗口双击拆出来，然后所有群窗口从左到右排开、整屏高。返回排了几个。 */
export const arrange = (groups: string[]) =>
	withUi(async () => {
		const have = (await chats(groups)).length;
		const want = await sessions(groups);
		if (have < want.length) {
			const main = xids("^微信$").sort((a, b) => winSize(b) - winSize(a))[0]; // 「微信」有两个，大的是主窗口
			if (!main) throw new Error("没找到微信主窗口");
			xdo("windowmove", main, "0", "0");
			await sleep(800);
			for (const ref of await sessions(groups)) {
				xdo("windowraise", main); // 双击已拆开的群会把它的窗口顶到前面挡住主窗口
				await sleep(300);
				const e = await extents(ref);
				xdo("mousemove", String(Math.round((e[0] + e[2] / 2) * SCALE)), String(Math.round((e[1] + e[3] / 2) * SCALE)), "click", "--repeat", "2", "--delay", "120", "1"); // 间隔太短微信不认双击
				await sleep(1200);
			}
			xdo("windowmove", main, ...MAIN_PARK);
			await sleep(500);
			console.error(`[排群] 群窗口 ${have} 个、会话里 ${want.length} 个，双击拆出来了`);
		}
		const wins = xids(`^(${groups.join("|")})$`).sort((a, b) => Number(a) - Number(b));
		wins.forEach((w, i) => xdo("windowmove", w, String(i * (WIN_W + 1)), "0", "windowsize", w, String(WIN_W), String(SCREEN_H)));
		return wins.length;
	});
