import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Anthropic model generation", () => {
	// https://platform.claude.com/docs/en/about-claude/pricing
	it.each([
		{ name: "uses current Sonnet 5.5 fallback pricing", catalogCacheRead: undefined, expectedCacheRead: 0.1 },
		{ name: "preserves catalog-provided Sonnet 5.5 pricing", catalogCacheRead: 0.07, expectedCacheRead: 0.07 },
	])("$name", ({ catalogCacheRead, expectedCacheRead }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-anthropic-generation-"));
		const preloadPath = join(root, "mock-catalog.mjs");
		const outputPath = join(root, "catalog");
		const catalog = {
			anthropic: {
				models:
					catalogCacheRead === undefined
						? {}
						: {
								"claude-sonnet-5-5": {
									id: "claude-sonnet-5-5",
									tool_call: true,
									cost: { input: 2, output: 10, cache_read: catalogCacheRead, cache_write: 2.5 },
								},
							},
			},
		};
		try {
			writeFileSync(
				preloadPath,
				`const catalog = ${JSON.stringify(catalog)};\n` +
					`globalThis.fetch = async (input) => {\n` +
					`  const url = String(input);\n` +
					`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
					`  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision" } });\n` +
					`  if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });\n` +
					`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });\n` +
					`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
					`};\n`,
			);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					pathToFileURL(preloadPath).href,
					"scripts/generate-models.ts",
					"--json-only",
					"--json-output",
					outputPath,
				],
				{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
			);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stderr).toBe("");
			const models = JSON.parse(readFileSync(join(outputPath, "providers/anthropic.json"), "utf8")) as Record<
				string,
				Model<"anthropic-messages">
			>;
			expect(models["claude-sonnet-5-5"].cost).toEqual({
				input: 2,
				output: 10,
				cacheRead: expectedCacheRead,
				cacheWrite: 2.5,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
