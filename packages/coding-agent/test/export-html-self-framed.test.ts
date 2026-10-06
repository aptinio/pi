import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, test } from "vitest";
import { exportSessionToHtml, type ToolHtmlRenderer } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("HTML tool header overrides", () => {
	beforeAll(() => initTheme("dark"));

	test.each([true, false])("preserves full output without a stale call header, override: %s", async (override) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-export-self-"));
		try {
			const manager = SessionManager.create(directory, directory);
			manager.appendMessage(
				fauxAssistantMessage([{ ...fauxToolCall("custom", { code: "script" }), id: "call" }], {
					stopReason: "toolUse",
				}),
			);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call",
				toolName: "custom",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			});
			const renderer: ToolHtmlRenderer = {
				renderCall: () => "initial running row",
				renderResult: () => ({
					...(override ? { callHtml: "" } : {}),
					collapsed: "completed compact row",
					expanded: "complete script and output",
				}),
			};
			const outputPath = join(directory, "session.html");
			await exportSessionToHtml(manager, undefined, { outputPath, toolRenderer: renderer });
			const html = readFileSync(outputPath, "utf8");
			const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			expect(encoded).toBeDefined();
			const data: {
				renderedTools: Record<
					string,
					{ callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string }
				>;
			} = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
			expect(data.renderedTools.call.callHtml).toBe(override ? "" : "initial running row");
			expect(data.renderedTools.call.resultHtmlCollapsed).toBe("completed compact row");
			expect(data.renderedTools.call.resultHtmlExpanded).toBe("complete script and output");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
