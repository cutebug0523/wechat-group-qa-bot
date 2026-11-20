// 任意 OpenAI 兼容接口（WXBOT_API_BASE + api_key 文件）当成一个供应商接进 pi-ai。key 每次请求现读文件，换 key 不用重启。
import { readFileSync } from "node:fs";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { KEY_FILE, MODEL, RESEARCH_MODEL } from "./config.ts";

export const BASE = process.env.WXBOT_API_BASE ?? "https://api.openai.com/v1";

const llmModel = (id: string): Model<"openai-completions"> => ({
	id,
	name: id,
	api: "openai-completions",
	provider: "llm",
	baseUrl: BASE,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // 实际花费看你的接口账单
	contextWindow: 1_024_000,
	maxTokens: 32_000,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		// DeepSeek 系回放带思考的历史时要带 reasoning_content；URL 不是官方的，自动识别不到
		requiresReasoningContentOnAssistantMessages: id.startsWith("deepseek"),
	},
});

export const llm = createProvider({
	id: "llm",
	name: "OpenAI 兼容",
	baseUrl: BASE,
	auth: { apiKey: { name: "API key", resolve: async () => ({ auth: { apiKey: readFileSync(KEY_FILE, "utf8").trim() } }) } },
	models: [...new Set([MODEL, RESEARCH_MODEL])].map(llmModel),
	api: openAICompletionsApi(),
});

export function llmModels() {
	const models = createModels();
	models.setProvider(llm);
	return models;
}

export const ref = (modelId: string) => ({ provider: "llm", modelId });
