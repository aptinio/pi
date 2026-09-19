import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe("session citation persistence", () => {
	it("round-trips assistant text URL citations without changing the session version", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-citations-"));
		tempDirs.push(tempDir);
		const session = SessionManager.create(tempDir, tempDir);
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Pi has hosted search.",
					annotations: [
						{
							type: "url_citation",
							url: "https://example.com/search",
							title: "Hosted search documentation",
							startIndex: 7,
							endIndex: 20,
						},
					],
				},
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};

		session.appendMessage(message);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const restored = SessionManager.open(sessionFile!);
		expect(restored.getHeader()?.version).toBe(3);
		expect(restored.getEntries()[0]).toMatchObject({
			type: "message",
			message: {
				content: [
					{
						annotations: [
							{
								type: "url_citation",
								url: "https://example.com/search",
								title: "Hosted search documentation",
								startIndex: 7,
								endIndex: 20,
							},
						],
					},
				],
			},
		});
	});
});
