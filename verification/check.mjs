// TLC 1.7.4 plus mutations of the actual implementation, all in isolated scratch dirs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pme-verify-"));
const java = process.env.JAVA || "java";
const jar = process.env.TLA2TOOLS || join(work, "tla2tools.jar");
const sha = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
if (!process.env.TLA2TOOLS) {
	const response = await fetch("https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar");
	assert(response.ok, `TLC download: ${response.status}`);
	writeFileSync(jar, Buffer.from(await response.arrayBuffer()));
}
assert.equal(createHash("sha256").update(readFileSync(jar)).digest("hex"), sha, "use unmodified TLC 1.7.4");
const models = [
	{ spec: "Delivery", variants: ["EarlyAck", "LateStart", "SharedKey", "ForgetDirty"] },
	{ spec: "Ownership", variants: ["UnlinkUnheld", "OpenOutsideQuota", "KeepLockOnClose", "EvictPending"] },
];
for (const { spec, variants } of models) {
	const config = readFileSync(join(root, `verification/${spec}.cfg`), "utf8");
	for (const mutation of [null, ...variants]) {
		const dir = join(work, mutation || `${spec}-correct`); mkdirSync(dir);
		cpSync(join(root, `verification/${spec}.tla`), join(dir, `${spec}.tla`));
		writeFileSync(join(dir, `${spec}.cfg`), mutation ? config.replace(`${mutation} = FALSE`, `${mutation} = TRUE`) : config);
		const result = spawnSync(java, ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "1", "-config", `${spec}.cfg`, `${spec}.tla`], { cwd: dir, encoding: "utf8", timeout: 120000 });
		const output = (result.stdout || "") + (result.stderr || "");
		writeFileSync(join(dir, "tlc.out"), output);
		if (!mutation) assert(result.status === 0 && output.includes("No error has been found"), `TLC requires Java 11+ (set JAVA): ${result.error || output}`);
		else assert(result.status !== 0 && /Invariant .* is violated/.test(output), `TLC did not reject ${mutation}: ${output}`);
		console.log(`${mutation || `${spec} correct`}: ${mutation ? "counterexample found" : output.match(/\d+ distinct states found/)?.[0]}`);
	}
}

const replays = [
	{ name: "EarlyAck", file: "src/receipt.ts", from: "const found = new Set<string>();", to: "return new Set(pending.map((r) => r.id));\n\tconst found = new Set<string>();", test: "format-state.test.ts", pattern: "receipt requires" },
	{ name: "LateStart", file: "src/subscription.ts", transform: (code) => code.replaceAll("if (this.stopped) break;", "// broken: no post-await fence").replace("if (this.stopped) return Promise.resolve();", "// broken: no push fence"), test: "lifecycle.test.ts", pattern: "real HTTP unsubscribe" },
	{ name: "SharedKey", file: "src/index.ts", from: "identity({ session: c.sessionManager.getSessionId(), file: c.sessionManager.getSessionFile() ?? null })", to: 'identity("shared")', test: "lifecycle.test.ts", pattern: "real Pi concurrent consumers" },
	{ name: "UnlinkUnheld", file: "src/state.ts", from: "if (!owner) continue;", to: "if (!owner) { rmSync(file, { force: true }); continue; }", test: "format-state.test.ts", pattern: "stale lock cleanup spares" },
	{ name: "KeepLockOnClose", file: "src/state.ts", from: "owner.release(true);\n\t\t\tunlock();", to: "owner.release(false);\n\t\t\tunlock();", test: "lifecycle.test.ts", pattern: "empty sessions leave no lock" },
	{ name: "EvictPending", file: "src/state.ts", from: 'if (s.pending.length) return "retained";', to: "", test: "format-state.test.ts", pattern: "slot sweep evicts" },
	{ name: "ForgetDirty", file: "src/state.ts", from: "this.staged = undefined;\n\t\t} finally { unlock(); }", to: "this.staged = undefined;\n\t\t} catch (err) { this.staged = undefined; throw err; } finally { unlock(); }", test: "format-state.test.ts", pattern: "failed flush preserves" },
];
for (const replay of replays) {
	const dir = join(work, `replay-${replay.name}`); mkdirSync(dir);
	for (const folder of ["src", "test"]) cpSync(join(root, folder), join(dir, folder), { recursive: true });
	cpSync(join(root, "package.json"), join(dir, "package.json"));
	symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
	const path = join(dir, replay.file), original = readFileSync(path, "utf8");
	const changed = replay.transform ? replay.transform(original) : original.replace(replay.from, replay.to);
	assert.notEqual(changed, original, `mutation ${replay.name} no longer matches the code; update the coverage mapping`);
	writeFileSync(path, changed);
	const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${replay.pattern}`, `test/${replay.test}`], { cwd: dir, encoding: "utf8", timeout: 60000 });
	const output = (result.stdout || "") + (result.stderr || ""); writeFileSync(join(dir, "replay.out"), output);
	assert(result.status !== 0 && /(?:fail [1-9]|failing tests)/.test(output), `real code replay ${replay.name} did not fail: ${output}`);
	console.log(`${replay.name}: actual code mutation rejected by ${replay.test}`);
}
console.log(`Evidence: ${work}`);
