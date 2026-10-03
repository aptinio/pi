import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { Container, TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent, PersistedEntryIdentity } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { AssistantTranscriptGroup } from "../src/modes/interactive/components/assistant-transcript-group.ts";
import { AssistantTurn } from "../src/modes/interactive/components/assistant-turn.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const firstTimestamp = new Date(2026, 0, 1, 13, 5).getTime();
const laterTimestamp = new Date(2026, 0, 1, 13, 7).getTime();

type TestView = {
	isInitialized: boolean;
	chatContainer: Container;
	activeAssistantTurn?: AssistantTurn;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	rebuildTranscript(): void;
	setToolsExpanded(expanded: boolean): void;
	retargetRenderedEntry(identity: PersistedEntryIdentity): void;
	createToolComponent(name: string, id: string, args: unknown): ToolExecutionComponent;
};

describe("active assistant activity regions", () => {
	let harness: Harness;
	let mode: InteractiveMode;
	let view: TestView;

	beforeAll(() => initTheme("dark"));
	beforeEach(async () => {
		harness = await createHarness({
			settings: { showCacheMissNotices: false, outputPad: 1 },
			extensionFactories: [createCodemodeExtension()],
			initialActiveToolNames: ["codemode"],
		});
		mode = new InteractiveMode(
			{
				session: harness.session,
				setBeforeSessionInvalidate: () => {},
				setRebindSession: () => {},
			} as unknown as AgentSessionRuntime,
			{ tuiMode: "regular", terminal: new VirtualTerminal(120, 30) },
		);
		view = mode as unknown as TestView;
		// Exercise the real event/rendering path without starting a terminal or contacting a provider.
		view.isInitialized = true;
	});
	afterEach(() => {
		mode.stop();
		harness.cleanup();
	});

	test("folds the first live codemode and its thinking into a one-space-padded shared summary", async () => {
		await mountCall(view, "script-1", "codemode", firstTimestamp);
		expect(summaryLines(view)).toEqual([" 1:05  [+] 1 tool call, 1 thinking block, incomplete"]);
		expect(render(view)).not.toContain('text("script-1")');
	});

	test("keeps ordinary live tools in their native preview until replacement content arrives", async () => {
		await mountCall(view, "read-1", "read", firstTimestamp);
		expect(summaryLines(view)).toEqual([]);
		expect(render(view)).toContain("read-1 reasoning");
	});

	test("adds live codemode to earlier tools and thinking without changing the region timestamp", async () => {
		await mountCall(view, "read-1", "read", firstTimestamp);
		await view.handleEvent({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "earlier error" }], details: undefined },
			isError: true,
		});
		await mountCall(view, "script-2", "codemode", laterTimestamp);
		expect(summaryLines(view)).toEqual([" 1:05  [+] 2 tool calls, 2 thinking blocks, error"]);
		expect(render(view)).not.toContain("codemode");
	});

	test("keeps the same expanded region across running, partial and final tool updates", async () => {
		await mountCall(view, "script-1", "codemode", firstTimestamp);
		await view.handleEvent({
			type: "tool_execution_start",
			toolCallId: "script-1",
			toolName: "codemode",
			args: { code: 'text("script-1")' },
		});
		expect(summaryLines(view)).toEqual([" 1:05  [+] 1 tool call, 1 thinking block, running"]);
		clickSummary(view);
		expect(summaryLines(view)).toEqual([" 1:05  [-] 1 tool call, 1 thinking block, running"]);
		expect(render(view)).toContain('text("script-1")');
		const result = { content: [{ type: "text" as const, text: "script output" }], details: undefined };
		await view.handleEvent({
			type: "tool_execution_update",
			toolCallId: "script-1",
			toolName: "codemode",
			args: { code: 'text("script-1")' },
			partialResult: result,
		});
		expect(summaryLines(view)).toEqual([" 1:05  [-] 1 tool call, 1 thinking block, running"]);
		await view.handleEvent({
			type: "tool_execution_end",
			toolCallId: "script-1",
			toolName: "codemode",
			result,
			isError: false,
		});
		expect(summaryLines(view)).toEqual([" 1:05  [-] 1 tool call, 1 thinking block"]);
		expect(render(view)).toContain("script output");
		clickSummary(view);
		expect(summaryLines(view)).toEqual([" 1:05  [+] 1 tool call, 1 thinking block"]);
		expect(render(view)).not.toContain("script output");
	});

	test("folds real codemode events before the next faux assistant response and after settlement", async () => {
		await harness.session.bindExtensions({});
		const unsubscribe = harness.session.subscribe((event) => view.handleEvent(event));
		const unsubscribeEntries = harness.session.subscribePersistedEntries((entry) =>
			view.retargetRenderedEntry(entry),
		);
		harness.setResponses([
			fauxAssistantMessage([fauxThinking("reasoning"), fauxToolCall("codemode", { code: 'text("real output")' })], {
				stopReason: "toolUse",
			}),
			() => {
				expect(summaryLines(view)).toHaveLength(1);
				expect(summaryLines(view)[0]).toMatch(/^ \d+:\d{2} {2}\[\+\] 1 tool call, 1 thinking block$/);
				clickSummary(view);
				expect(render(view)).toContain("real output");
				view.rebuildTranscript();
				expect(summaryLines(view)).toHaveLength(1);
				expect(summaryLines(view)[0]).toMatch(/^ \d+:\d{2} {2}\[-\] 1 tool call, 1 thinking block$/);
				expect(render(view)).toContain("real output");
				view.setToolsExpanded(true);
				view.setToolsExpanded(false);
				expect(summaryLines(view)[0]).toMatch(/^ \d+:\d{2} {2}\[\+\] 1 tool call, 1 thinking block$/);
				return fauxAssistantMessage("Done.");
			},
		]);
		try {
			await harness.session.prompt("Go ahead");
			expect(summaryLines(view)).toHaveLength(1);
			expect(summaryLines(view)[0]).toMatch(/^ \d+:\d{2} {2}\[\+\] 1 tool call, 1 thinking block$/);
			expect(render(view)).toContain("Done.");
		} finally {
			unsubscribe();
			unsubscribeEntries();
		}
	});

	test("preserves the active fold's blank-row budget across partial results and continuation", () => {
		const code = Array.from({ length: 20 }, (_, index) => `text("line-${index}");`).join("\n");
		const call = message([{ ...fauxToolCall("codemode", { code }), id: "script-1" }], firstTimestamp);
		const group = new AssistantTranscriptGroup(undefined, call, new AssistantMessageComponent(call));
		const tool = view.createToolComponent("codemode", "script-1", { code });
		tool.setExpanded(true);
		group.addTool("script-1", tool);
		const turn = new AssistantTurn(1);
		turn.addGroup(group);
		const heightBefore = group.render(120).length;
		expect(turn.foldActiveTools({ defaultExpanded: false, heightCompensationWidth: 120 })).toBe(true);
		expect(group.render(120)).toHaveLength(heightBefore);
		const compensation = turn.getHeightCompensation();
		expect(compensation?.rows).toBeGreaterThan(0);
		tool.markExecutionStarted();
		tool.updateResult({ content: [{ type: "text", text: "partial result" }], isError: false }, true);
		turn.foldActiveTools({ defaultExpanded: false, heightCompensationWidth: 120 });
		expect(group.render(120)).toHaveLength(heightBefore);
		expect(turn.getHeightCompensation()?.rows).toBe(compensation?.rows);

		const next = message([{ type: "text", text: "Continuation." }], laterTimestamp);
		next.stopReason = "stop";
		const continuation = new AssistantTranscriptGroup(undefined, next, new AssistantMessageComponent(next));
		turn.addGroup(continuation);
		turn.foldBeforeLast({ defaultExpanded: false, heightCompensationWidth: 120 });
		expect(group.render(120).length + continuation.render(120).length).toBe(heightBefore);
		turn.complete({ defaultExpanded: false });
		expect(turn.getHeightCompensation()).toBeUndefined();
	});

	test("keeps nested calls inside the parent and reports a failed parent in the shared summary", async () => {
		await mountCall(view, "script-1", "codemode", firstTimestamp);
		await view.handleEvent({
			type: "tool_execution_start",
			toolCallId: "script-1/1",
			parentToolCallId: "script-1",
			toolName: "read",
			args: {},
		});
		await view.handleEvent({
			type: "tool_execution_end",
			toolCallId: "script-1",
			toolName: "codemode",
			result: { content: [{ type: "text", text: "Script error" }], details: undefined },
			isError: true,
		});
		expect(summaryLines(view)).toEqual([" 1:05  [+] 1 tool call, 1 thinking block, error"]);
	});

	test("keeps user-fenced active turns separate", async () => {
		await mountCall(view, "script-1", "codemode", firstTimestamp);
		await view.handleEvent({
			type: "message_start",
			message: { role: "user", content: "Next request", timestamp: laterTimestamp },
		});
		await mountCall(view, "script-2", "codemode", laterTimestamp);
		expect(summaryLines(view)).toEqual([
			" 1:05  [+] 1 tool call, 1 thinking block, incomplete",
			" 1:07  [+] 1 tool call, 1 thinking block, incomplete",
		]);
	});

	test("preserves separate message-fenced regions and pads each collapsed and expanded summary", async () => {
		await mountCall(view, "read-1", "read", firstTimestamp);
		await mountCall(view, "script-2", "codemode", laterTimestamp, "Between regions.");
		expect(summaryLines(view)).toEqual([
			" 1:05  [+] 1 tool call, 1 thinking block, incomplete",
			" 1:07  [+] 1 tool call, 1 thinking block, incomplete",
		]);
		view.activeAssistantTurn?.setExpanded(true);
		expect(summaryLines(view)).toEqual([
			" 1:05  [-] 1 tool call, 1 thinking block, incomplete",
			" 1:07  [-] 1 tool call, 1 thinking block, incomplete",
		]);
		expect(render(view)).toContain("Between regions.");
	});
});

async function mountCall(view: TestView, id: string, name: string, timestamp: number, text?: string): Promise<void> {
	await view.handleEvent({ type: "message_start", message: message([], timestamp) });
	const toolCall = { ...fauxToolCall(name, name === "codemode" ? { code: `text("${id}")` } : { path: id }), id };
	const content: AssistantMessage["content"] = [
		...(text ? [{ type: "text" as const, text }] : []),
		fauxThinking(`${id} reasoning`),
		toolCall,
	];
	const call = message(content, timestamp);
	await view.handleEvent({
		type: "message_update",
		message: call,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: content.length - 1, toolCall, partial: call },
	});
	await view.handleEvent({ type: "message_end", message: call });
}

function message(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return { ...fauxAssistantMessage(content, { stopReason: "toolUse" }), timestamp };
}

function render(view: TestView): string {
	return stripAnsi(view.chatContainer.render(120).join("\n"));
}

function summaryLines(view: TestView): string[] {
	return render(view)
		.split("\n")
		.filter((line) => /\[[+-]\]/.test(line))
		.map((line) => line.trimEnd());
}

function clickSummary(view: TestView): void {
	const lines = view.chatContainer.render(120);
	const y = lines.findIndex((line) => /\[[+-]\]/.test(stripAnsi(line)));
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width: 120,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(view.chatContainer.handleMouse(event)?.handled).toBe(true);
}
