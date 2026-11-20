// 路径和开关。都能用环境变量改，默认值按 Ubuntu 上 ~/wxbot 的布局。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = process.env.WXBOT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE = process.env.WXBOT_STATE ?? join(DIR, "state", "session.sqlite");
export const KEY_FILE = process.env.WXBOT_KEY_FILE ?? join(DIR, "api_key");
export const BOCHA_KEY_FILE = process.env.WXBOT_BOCHA_KEY_FILE ?? join(DIR, "bocha_key");
export const DRAFTS = join(DIR, "drafts.jsonl");
// 开了发送的群：Ubuntu 上 live_groups 文件，一行一个群标题前缀（比如 示例2群），每次发之前现读；没列的只写 drafts.jsonl
export const isLive = (label: string) =>
	readText("live_groups").split("\n").map((s) => s.trim()).filter(Boolean).some((n) => label === n || label.startsWith(`${n}(`));
export const MODEL = process.env.WXBOT_MODEL ?? "deepseek-v4.1-flash";
export const RESEARCH_MODEL = process.env.WXBOT_RESEARCH_MODEL ?? "kimi-k3.1-pro";
// 要盯的群名（拆成独立窗口的群，窗口名就是群名；同名的几个群都盯）
export const GROUPS = (process.env.WXBOT_GROUPS ?? "示例群,示例2群").split(",").filter(Boolean);
// 群主的群名字。名字对上了还要点头像核对微信号（Ubuntu 上 owner_wxid 文件，不进仓库），对不上不算群主
export const OWNERS = new Set((process.env.WXBOT_OWNERS ?? "老板").split(",").filter(Boolean));
export const BOT_NAME = process.env.WXBOT_NAME ?? "答疑助手"; // 小号在群里的名字
export const OWNER_NOTES = "群主交代.md";
export const PAUSE_FILE = join(DIR, "state", "paused-until");
export const RESEARCH_HOUR = Number(process.env.WXBOT_RESEARCH_HOUR ?? 3); // 每天几点自学（本机时区）

export const readText = (name: string) => {
	try {
		return readFileSync(join(DIR, name), "utf8");
	} catch {
		return "";
	}
};
