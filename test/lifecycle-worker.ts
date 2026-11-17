// A real Pi runtime in a killable subprocess. No external credentials or services.
import { readFileSync, writeFileSync } from "node:fs";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import extension from "../src/index.ts";

const options = JSON.parse(process.argv[2]);
const send = (value: unknown): void => { process.send?.(value); };
let pauseBeforeAppend = options.pauseBeforeAppend;
let control: ExtensionAPI;
const modelRuntime = await ModelRuntime.create({ authPath: `${options.dir}/auth.json`, modelsPath: `${options.dir}/models.json` });
await modelRuntime.setRuntimeApiKey("fixture", "local-only");
const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: `${options.url}/v1`, input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const create: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [extension, (pi) => {
				control = pi;
				pi.registerProvider("fixture", { api: "openai-completions", baseUrl: model.baseUrl, apiKey: "local-only", models: [model] });
				pi.on("message_end", async (event, ctx) => {
					if (event.message.role !== "custom" || event.message.customType !== "mcp-event") return;
					const file = ctx.sessionManager.getSessionFile();
					let text = ""; try { text = file ? readFileSync(file, "utf8") : ""; } catch {}
					const receiptId = (event.message.details as { receiptId: string })?.receiptId;
					send({ type: "message_end", receiptId, persisted: text.includes(receiptId) });
					if (pauseBeforeAppend) await new Promise(() => {});
				});
				pi.on("session_start", (e, ctx) => send({ type: "start", reason: e.reason, id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }));
				pi.on("session_shutdown", (e) => send({ type: "shutdown", reason: e.reason }));
			}] } });
	return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: "builtin" })), services, diagnostics: services.diagnostics };
};
const manager = options.sessionFile ? SessionManager.open(options.sessionFile, `${options.dir}/sessions`) : SessionManager.create(options.dir, `${options.dir}/sessions`);
const runtime = await createAgentSessionRuntime(create, { cwd: options.dir, agentDir: options.dir, sessionManager: manager });
await runtime.session.bindExtensions({ onError: (e) => send({ type: "extension_error", message: e.error }) });
runtime.setRebindSession(async (session) => { await session.bindExtensions({ onError: (e) => send({ type: "extension_error", message: e.error }) }); });
process.on("message", async (raw) => {
	const command = raw as { id: number; action: string; params?: any };
	try {
		let result: unknown;
		switch (command.action) {
			case "prompt": void runtime.session.prompt(command.params ?? "hold").catch((e) => send({ type: "prompt_error", message: e.message })); break;
			case "subscribe": case "unsubscribe": case "list": {
				const name = `mcp_events_${command.action}`;
				const tool = runtime.session.agent.state.tools.find((t) => t.name === name);
				if (!tool) throw new Error(`missing tool ${name}`);
				result = await tool.execute(`fixture-${command.id}`, command.params ?? {}); break;
			}
			case "config":
				writeFileSync(`${options.dir}/mcp.json`, JSON.stringify({ mcpServers: { fixture: command.params } }));
				control.registerMcpServer("fixture-signal", { url: `${options.url}/signal-${command.id}` }); break;
			case "reload": await runtime.session.reload(); break;
			case "resume": await runtime.switchSession(command.params.file); break;
			case "new": await runtime.newSession(); break;
			case "unpause": pauseBeforeAppend = false; break;
			case "shutdown": await runtime.dispose(); send({ id: command.id, ok: true }); process.exit(0);
		}
		send({ id: command.id, ok: true, result });
	} catch (e) { send({ id: command.id, error: String(e) }); }
});
send({ type: "ready", file: manager.getSessionFile(), id: manager.getSessionId() });
