// Read MCP server entries the way pi does, and the subscription file.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: unknown;
	auth?: unknown;
	type?: string;
	enabled?: boolean;
	timeout?: number;
}

export interface ServerEntry {
	name: string;
	config: ServerConfig;
	source: string;
}

export interface SubscriptionSpec {
	server: string;
	event: string;
	arguments: Record<string, unknown>;
	/** Force a delivery mode. Default: push when the event offers it, else poll. */
	delivery?: "push" | "poll";
	/** Replay bound for a stored cursor (SEP-3415 maxAgeMs). */
	maxAgeMs?: number;
}

function readJson(path: string): any {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/**
 * Merge server entries by pi's rules: registered servers (pi.getMcpServers())
 * first, then ~/.pi/agent/mcp.json, then the project .pi/mcp.json when trusted.
 * A later entry replaces an earlier one; a project entry without command, url
 * or type only overrides `enabled` (and exposure keys) of the user entry.
 */
export function loadServers(opts: {
	agentDir: string;
	cwd: string;
	trusted: boolean;
	registered?: { name: string; config: unknown }[];
}): { servers: Map<string, ServerEntry>; errors: string[] } {
	const servers = new Map<string, ServerEntry>();
	const errors: string[] = [];
	const norm = (name: string) => name.replace(/-/g, "_");
	const byNorm = new Map<string, string>();
	const put = (name: string, config: ServerConfig, source: string) => {
		const old = byNorm.get(norm(name));
		if (old && old !== name) servers.delete(old);
		byNorm.set(norm(name), name);
		servers.set(name, { name, config, source });
	};
	for (const r of opts.registered ?? []) put(r.name, r.config as ServerConfig, "extension");

	const files: [string, string][] = [[join(opts.agentDir, "mcp.json"), "user"]];
	if (opts.trusted) files.push([join(opts.cwd, ".pi", "mcp.json"), "project"]);
	for (const [path, source] of files) {
		let parsed: any;
		try {
			parsed = readJson(path);
		} catch (err) {
			errors.push(String(err instanceof Error ? err.message : err));
			continue;
		}
		const entries = parsed?.mcpServers;
		if (!entries || typeof entries !== "object") continue;
		for (const [name, raw] of Object.entries<any>(entries)) {
			if (!raw || typeof raw !== "object") continue;
			const isOverride = !raw.command && !raw.url && !raw.type;
			if (isOverride) {
				const base = servers.get(byNorm.get(norm(name)) ?? name);
				if (!base) continue;
				const patch = Object.fromEntries(Object.entries(raw).filter(([k]) => OVERRIDE_KEYS.includes(k)));
				put(base.name, { ...base.config, ...patch }, `${base.source}+${source}`);
				continue;
			}
			put(name, raw as ServerConfig, source);
		}
	}
	return { servers, errors };
}

/** Why this extension cannot connect to a server, or undefined when it can. */
export function unsupportedReason(config: ServerConfig): string | undefined {
	if (config.enabled === false) return "disabled";
	if (config.type === "sse") return "SSE transport is not supported";
	if (config.url) {
		if (config.oauth || config.auth) return "OAuth or provider auth is not supported in v1";
		return undefined;
	}
	if (config.command) return undefined;
	return "needs command or url";
}

/** `~` and `~/…` name the home directory, as in pi. */
export function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

/**
 * Resolve a config value as pi does: a value that starts with `!` runs as a
 * shell command and uses its output; otherwise `${NAME}` and `$NAME` read the
 * environment, and `$$` / `$!` escape a literal `$` / `!`.
 */
export function resolveValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
	if (value.startsWith("!")) {
		const out = execSync(value.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
		return out.trim();
	}
	return value.replace(/\$(\$|!|\{([A-Za-z_][A-Za-z0-9_]*)\}|[A-Za-z_][A-Za-z0-9_]*)/g, (_m, tok: string, braced?: string) => {
		if (tok === "$" || tok === "!") return tok;
		const name = braced ?? tok;
		const v = env[name];
		if (v === undefined || v === "") throw new Error(`environment variable ${name} is not set`);
		return v;
	});
}

export function resolveRecord(rec: Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(rec ?? {})) out[k] = resolveValue(String(v));
	return out;
}

/** Stable JSON: object keys sorted, so equal arguments give equal keys. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value as object).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

export function subscriptionKey(s: { server: string; event: string; arguments?: Record<string, unknown> }): string {
	return `${s.server} ${s.event} ${stableStringify(s.arguments ?? {})}`;
}

/** Read ~/.pi/agent/mcp-events.json: {"subscriptions":[{"server","event","arguments"}]}. */
export function loadSubscriptions(agentDir: string): { subscriptions: SubscriptionSpec[]; errors: string[] } {
	const path = join(agentDir, "mcp-events.json");
	const errors: string[] = [];
	let parsed: any;
	try {
		parsed = readJson(path);
	} catch (err) {
		return { subscriptions: [], errors: [String(err instanceof Error ? err.message : err)] };
	}
	const subscriptions: SubscriptionSpec[] = [];
	for (const [i, s] of (Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []).entries()) {
		if (typeof s?.server !== "string" || typeof s?.event !== "string") {
			errors.push(`${path}: subscriptions[${i}] needs "server" and "event" strings`);
			continue;
		}
		const args = s.arguments && typeof s.arguments === "object" && !Array.isArray(s.arguments) ? s.arguments : {};
		const delivery = s.delivery === "push" || s.delivery === "poll" ? s.delivery : undefined;
		const maxAgeMs = typeof s.maxAgeMs === "number" ? s.maxAgeMs : undefined;
		subscriptions.push({ server: s.server, event: s.event, arguments: args, delivery, maxAgeMs });
	}
	return { subscriptions, errors };
}

export function resolveCwd(cwd: string, configCwd?: string): string {
	return resolve(cwd, expandHome(configCwd ?? "."));
}
