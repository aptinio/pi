import type { AssistantMessage, AssistantMessageFrame, TextContent, UrlCitation } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { applyFrame } from "../../../src/harness/pico3/kinds/frames.ts";

function seed(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 1,
	};
}

function apply(output: { message?: AssistantMessage }, frame: AssistantMessageFrame): void {
	applyFrame(output, frame);
}

describe("pico3 assistant frame application", () => {
	it("replaces text annotations from the authoritative end frame", () => {
		const output: { message?: AssistantMessage } = {};
		const partial = seed();
		const stale: UrlCitation[] = [
			{
				type: "url_citation",
				url: "https://example.com/stale",
				title: "Stale",
				startIndex: 0,
				endIndex: 5,
			},
		];
		const annotations: UrlCitation[] = [
			{
				type: "url_citation",
				url: "https://example.com/current",
				title: "Current",
				startIndex: 6,
				endIndex: 13,
			},
		];

		apply(output, { type: "start", partial });
		apply(output, {
			type: "text_start",
			contentIndex: 0,
			content: { type: "text", text: "partial", annotations: stale },
		});
		apply(output, {
			type: "text_end",
			contentIndex: 0,
			content: "final text",
			annotations,
		});

		const block = output.message?.content[0] as TextContent;
		expect(block.annotations).toEqual(annotations);
		expect(block.annotations).not.toBe(annotations);
	});

	it("clears annotations when the authoritative end frame omits them", () => {
		const output: { message?: AssistantMessage } = {};

		apply(output, { type: "start", partial: seed() });
		apply(output, {
			type: "text_start",
			contentIndex: 0,
			content: {
				type: "text",
				text: "partial",
				annotations: [
					{
						type: "url_citation",
						url: "https://example.com/stale",
						title: "Stale",
						startIndex: 0,
						endIndex: 5,
					},
				],
			},
		});
		apply(output, { type: "text_end", contentIndex: 0, content: "final text" });

		expect(output.message?.content[0]).toEqual({ type: "text", text: "final text" });
	});
});
