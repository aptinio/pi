import type { AssistantMessage, SystemMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";
import { buildTranscriptItems } from "../src/modes/interactive/transcript-projection.ts";

const TIMESTAMP = "2026-09-24T00:00:00.000Z";
const USAGE: Usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};

function entry(
	id: string,
	message: SessionMessageEntry["message"],
	parentId: string | null = null,
): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: TIMESTAMP, message };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

function result(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function kinds(entries: readonly SessionEntry[]): string[] {
	return buildTranscriptItems(entries).map((item) => item.kind);
}

describe("buildTranscriptItems", () => {
	test("maps the complete chronological branch including every compaction boundary", () => {
		const systemMessage: SystemMessage = { role: "system", content: "private checkpoint", timestamp: 1 };
		const entries: SessionEntry[] = [
			entry("u1", { role: "user", content: "first", timestamp: 1 }),
			entry("a1", assistant([{ type: "text", text: "response one" }]), "u1"),
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				timestamp: TIMESTAMP,
				summary: "first summary",
				firstKeptEntryId: "u1",
				tokensBefore: 100,
				systemMessage,
			},
			entry("u2", { role: "user", content: "second", timestamp: 2 }, "c1"),
			{
				type: "compaction",
				id: "c2",
				parentId: "u2",
				timestamp: TIMESTAMP,
				summary: "second summary",
				firstKeptEntryId: "u2",
				tokensBefore: 200,
			},
		];

		const items = buildTranscriptItems(entries);
		expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "compaction", "user", "compaction"]);
		expect(items.filter((item) => item.kind === "compaction").map((item) => item.entry.summary)).toEqual([
			"first summary",
			"second summary",
		]);
		expect(items).toHaveLength(5);
	});

	test("keeps branch summaries, custom entries, and cache-warming usage chronological", () => {
		const entries: SessionEntry[] = [
			{
				type: "branch_summary",
				id: "branch",
				parentId: null,
				timestamp: TIMESTAMP,
				fromId: "old-leaf",
				summary: "branch summary",
				usage: USAGE,
			},
			{ type: "custom", id: "custom", parentId: "branch", timestamp: TIMESTAMP, customType: "demo", data: 1 },
			{
				type: "usage",
				id: "warm",
				parentId: "custom",
				timestamp: TIMESTAMP,
				kind: "cache_warm",
				provider: "anthropic",
				model: "claude-test",
				usage: USAGE,
			},
			{
				type: "usage",
				id: "other-usage",
				parentId: "warm",
				timestamp: TIMESTAMP,
				kind: "other",
				provider: "anthropic",
				model: "claude-test",
				usage: USAGE,
			},
		];

		const items = buildTranscriptItems(entries);
		expect(items.map((item) => item.kind)).toEqual(["branch-summary", "custom-entry", "usage"]);
		expect(items.map((item) => ("entry" in item ? item.entry.id : item.entryId))).toEqual([
			"branch",
			"custom",
			"warm",
		]);
	});

	test("does not apply context edits or render hidden and state-only entries", () => {
		const entries: SessionEntry[] = [
			entry("user", { role: "user", content: "historical text", timestamp: 1 }),
			{
				type: "context_edit",
				id: "edit",
				parentId: "user",
				timestamp: TIMESTAMP,
				targetId: "user",
				replacement: null,
			},
			{
				type: "custom_message",
				id: "hidden",
				parentId: "edit",
				timestamp: TIMESTAMP,
				customType: "hidden",
				content: "secret",
				display: false,
			},
			{
				type: "custom_message",
				id: "visible",
				parentId: "hidden",
				timestamp: TIMESTAMP,
				customType: "visible",
				content: "shown",
				display: true,
			},
			{
				type: "thinking_level_change",
				id: "thinking",
				parentId: "visible",
				timestamp: TIMESTAMP,
				thinkingLevel: "high",
			},
			{ type: "model_change", id: "model", parentId: "thinking", timestamp: TIMESTAMP, provider: "x", modelId: "y" },
			{ type: "label", id: "label", parentId: "model", timestamp: TIMESTAMP, targetId: "user", label: "saved" },
			{ type: "session_info", id: "info", parentId: "label", timestamp: TIMESTAMP, name: "name" },
		];

		const items = buildTranscriptItems(entries);
		expect(items.map((item) => item.kind)).toEqual(["user", "custom-message"]);
		expect(items[0]).toMatchObject({ entryId: "user", message: { content: "historical text" } });
		expect(items[1]).toMatchObject({ entryId: "visible", message: { content: "shown", display: true } });
	});

	test("normalizes legacy null content without mutating persisted entries and hides system messages", () => {
		const legacyUser = entry("legacy-user", { role: "user", content: null, timestamp: 1 } as never);
		const legacyAssistant = entry("legacy-assistant", { ...assistant([]), content: undefined } as never);
		const legacyResult = entry("legacy-result", { ...result("missing", ""), content: null } as never);
		const legacySystem = entry("legacy-system", { role: "system", content: null, timestamp: 1 } as never);
		const entries = [legacyUser, legacyAssistant, legacyResult, legacySystem];

		const items = buildTranscriptItems(entries);
		expect(items).toMatchObject([
			{ kind: "user", message: { content: [] } },
			{ kind: "assistant", message: { content: [] } },
			{ kind: "unmatched-tool-result", message: { content: [] } },
		]);
		expect((legacyUser.message as { content: unknown }).content).toBeNull();
		expect((legacyAssistant.message as { content?: unknown }).content).toBeUndefined();
		expect((legacyResult.message as { content: unknown }).content).toBeNull();
		expect(kinds([legacySystem])).toEqual([]);
	});

	test("matches duplicate tool IDs FIFO to preceding calls and preserves call order", () => {
		const entries: SessionEntry[] = [
			entry(
				"assistant-1",
				assistant([
					{ type: "toolCall", id: "duplicate", name: "read", arguments: { path: "one" } },
					{ type: "text", text: "between" },
					{ type: "toolCall", id: "duplicate", name: "read", arguments: { path: "two" } },
					{ type: "toolCall", id: "no-result", name: "read", arguments: { path: "three" } },
				]),
			),
			entry("result-1", result("duplicate", "first result"), "assistant-1"),
			entry("result-2", result("duplicate", "second result"), "result-1"),
		];

		const [item] = buildTranscriptItems(entries);
		expect(item?.kind).toBe("assistant");
		if (item?.kind !== "assistant") throw new Error("expected assistant item");
		expect(item.tools.map((tool) => [tool.contentIndex, tool.call.id, tool.resultEntry?.id])).toEqual([
			[0, "duplicate", "result-1"],
			[2, "duplicate", "result-2"],
			[3, "no-result", undefined],
		]);
	});

	test("never matches results to future calls and keeps unmatched results explicit", () => {
		const entries: SessionEntry[] = [
			entry("early-result", result("future", "orphan")),
			entry(
				"assistant",
				assistant([{ type: "toolCall", id: "future", name: "read", arguments: { path: "later" } }]),
				"early-result",
			),
		];

		const items = buildTranscriptItems(entries);
		expect(items.map((item) => item.kind)).toEqual(["unmatched-tool-result", "assistant"]);
		const assistantItem = items[1];
		if (assistantItem?.kind !== "assistant") throw new Error("expected assistant item");
		expect(assistantItem.tools[0]?.resultEntry).toBeUndefined();
	});
});
