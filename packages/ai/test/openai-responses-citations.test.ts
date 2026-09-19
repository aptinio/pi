import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model, TextContent } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 0,
	};
}

async function* createCitationEvents(includeDoneAnnotation = true): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: {
			type: "message",
			id: "msg_cited",
			role: "assistant",
			status: "in_progress",
			content: [],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		sequence_number: 1,
		output_index: 0,
		content_index: 0,
		item_id: "msg_cited",
		delta: "Pi has hosted search.",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.annotation.added",
		sequence_number: 2,
		output_index: 0,
		content_index: 0,
		item_id: "msg_cited",
		annotation_index: 0,
		annotation: {
			type: "url_citation",
			url: "https://example.com/search",
			title: "Hosted search documentation",
			start_index: 7,
			end_index: 20,
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 3,
		output_index: 0,
		item: {
			type: "message",
			id: "msg_cited",
			role: "assistant",
			status: "completed",
			content: [
				{
					type: "output_text",
					text: "Pi has hosted search.",
					annotations: includeDoneAnnotation
						? [
								{
									type: "url_citation",
									url: "https://example.com/search",
									title: "Hosted search documentation",
									start_index: 7,
									end_index: 20,
								},
							]
						: [],
				},
			],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 4,
		response: { id: "resp_cited", status: "completed" },
	} as ResponseStreamEvent;
}

async function* createMissingContentEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: {
			type: "message",
			id: "msg_without_content",
			role: "assistant",
			status: "in_progress",
			content: [],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: {
			type: "message",
			id: "msg_without_content",
			role: "assistant",
			status: "completed",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_without_content", status: "completed" },
	} as ResponseStreamEvent;
}

async function* createMultipartCitationEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: { type: "message", id: "msg_multi", role: "assistant", status: "in_progress", content: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		sequence_number: 1,
		output_index: 0,
		content_index: 0,
		item_id: "msg_multi",
		delta: "First. ",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		sequence_number: 2,
		output_index: 0,
		content_index: 1,
		item_id: "msg_multi",
		delta: "Second source.",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.annotation.added",
		sequence_number: 3,
		output_index: 0,
		content_index: 1,
		item_id: "msg_multi",
		annotation_index: 0,
		annotation: {
			type: "url_citation",
			url: "https://example.com/second",
			title: "Second source",
			start_index: 0,
			end_index: 6,
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 4,
		output_index: 0,
		item: {
			type: "message",
			id: "msg_multi",
			role: "assistant",
			status: "completed",
			content: [
				{
					type: "output_text",
					text: "First. ",
					annotations: [
						{
							type: "url_citation",
							url: "https://example.com/first",
							title: "First source",
							start_index: 0,
							end_index: 5,
						},
					],
				},
				{ type: "output_text", text: "Second source.", annotations: [] },
			],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 5,
		response: { id: "resp_multi", status: "completed" },
	} as ResponseStreamEvent;
}

describe("OpenAI Responses URL citations", () => {
	it("normalizes streamed URL citation annotations onto assistant text", async () => {
		const output = createOutput();

		await processResponsesStream(createCitationEvents(), output, new AssistantMessageEventStream(), model);

		const text = output.content[0] as TextContent;
		expect(text).toEqual({
			type: "text",
			text: "Pi has hosted search.",
			textSignature: JSON.stringify({ v: 1, id: "msg_cited" }),
			annotations: [
				{
					type: "url_citation",
					url: "https://example.com/search",
					title: "Hosted search documentation",
					startIndex: 7,
					endIndex: 20,
				},
			],
		});
	});

	it("retains annotations emitted only through annotation events", async () => {
		const output = createOutput();

		await processResponsesStream(createCitationEvents(false), output, new AssistantMessageEventStream(), model);

		expect((output.content[0] as TextContent).annotations).toEqual([
			{
				type: "url_citation",
				url: "https://example.com/search",
				title: "Hosted search documentation",
				startIndex: 7,
				endIndex: 20,
			},
		]);
	});

	it("tolerates terminal message items without content", async () => {
		const output = createOutput();

		await processResponsesStream(createMissingContentEvents(), output, new AssistantMessageEventStream(), model);

		expect(output.content[0]).toMatchObject({
			type: "text",
			text: "",
			textSignature: JSON.stringify({ v: 1, id: "msg_without_content" }),
		});
	});

	it("merges terminal and event-only annotations with content-relative offsets", async () => {
		const output = createOutput();

		await processResponsesStream(createMultipartCitationEvents(), output, new AssistantMessageEventStream(), model);

		expect(output.content[0]).toMatchObject({
			type: "text",
			text: "First. Second source.",
			annotations: [
				{
					type: "url_citation",
					url: "https://example.com/first",
					title: "First source",
					startIndex: 0,
					endIndex: 5,
				},
				{
					type: "url_citation",
					url: "https://example.com/second",
					title: "Second source",
					startIndex: 7,
					endIndex: 13,
				},
			],
		});
	});

	it("keeps normalized annotations out of replay payloads", () => {
		const citedText: TextContent = {
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
		};
		const assistant: AssistantMessage = { ...createOutput(), content: [citedText], stopReason: "stop" };
		const context = normalizeContext({ messages: [assistant] });

		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		const message = input.find((item) => item.type === "message" && item.role === "assistant");

		expect(message).toMatchObject({
			content: [{ type: "output_text", text: "Pi has hosted search.", annotations: [] }],
		});
	});

	it("strips normalized annotations when replaying text to another provider", () => {
		const assistant: AssistantMessage = {
			...createOutput(),
			provider: "openai-codex",
			api: "openai-codex-responses",
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
			stopReason: "stop",
		};
		const googleModel: Model<"google-generative-ai"> = {
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 65536,
		};

		expect(convertGoogleMessages(googleModel, normalizeContext({ messages: [assistant] }))).toEqual([
			{ role: "model", parts: [{ text: "Pi has hosted search." }] },
		]);
	});
});
