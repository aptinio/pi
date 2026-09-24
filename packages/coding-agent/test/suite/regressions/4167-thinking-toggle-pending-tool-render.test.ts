import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { type Component, Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { AssistantTranscriptGroup } from "../../../src/modes/interactive/components/assistant-transcript-group.ts";
import type {
	ToolExecutionComponent,
	ToolExpansionState,
} from "../../../src/modes/interactive/components/tool-execution.ts";
import type { TranscriptEntryComponent } from "../../../src/modes/interactive/components/transcript-entry.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import type { TranscriptItem } from "../../../src/modes/interactive/transcript-projection.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	liveTools: Map<string, ToolExecutionComponent>;
	streamingComponent?: AssistantMessageComponent;
	streamingGroup?: AssistantTranscriptGroup;
	streamingMessage?: AssistantMessage;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowCacheMissNotices(): boolean;
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: {
		retryAttempt: number;
		modelRuntime: object;
		extensionRunner: { getMessageRenderer(): undefined };
	};
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	maybeSuggestBugReport(message: AssistantMessage): void;
	maybeShowThinkingDropNotice(message: AssistantMessage): void;
	maybeShowCacheMissNotice(message: AssistantMessage): void;
	getMarkdownThemeWithSettings(): ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers(): [];
	getRegisteredToolDefinition(toolName: string): undefined;
	editor: { addToHistory(text: string): void };
	transcriptEntries: Map<string, TranscriptEntryComponent>;
	assistantComponents: Map<string, AssistantMessageComponent>;
	toolComponents: Map<string, ToolExecutionComponent>;
	expandableTranscriptComponents: Map<string, { setExpanded(expanded: boolean): void; isExpanded(): boolean }>;
	restoringExpansionState:
		| {
				tools: Map<string, ToolExpansionState>;
				thinking: Map<string, ReadonlyMap<number, boolean>>;
				expandable: Map<string, boolean>;
		  }
		| undefined;
	persistedEntryIdsByMessage: WeakMap<object, string>;
	renderedEntriesByMessage: WeakMap<object, TranscriptEntryComponent>;
	createTranscriptEntry(entryId: string | undefined, children: readonly Component[]): TranscriptEntryComponent;
	registerTranscriptEntry(component: TranscriptEntryComponent): void;
	registerAssistantComponent(entryId: string, component: AssistantMessageComponent): void;
	registerToolComponent(
		assistantEntryId: string,
		contentIndex: number,
		toolCallId: string,
		component: ToolExecutionComponent,
		preserveCurrent?: boolean,
	): void;
	getToolStateKey(assistantEntryId: string, contentIndex: number, toolCallId: string): string;
	createToolComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent;
	addMessageToChat(
		message: AgentMessage,
		options?: { entryId?: string; populateHistory?: boolean },
	): TranscriptEntryComponent | undefined;
	renderTranscriptItems(
		items: readonly TranscriptItem[],
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void;
};

type AddMessageToChat = (
	this: RenderSessionContextThis,
	message: AgentMessage,
	options?: { entryId?: string; populateHistory?: boolean },
) => TranscriptEntryComponent | undefined;

type RenderSessionEntries = (
	this: RenderSessionContextThis,
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	const context = {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		liveTools: new Map<string, ToolExecutionComponent>(),
		streamingComponent: undefined,
		streamingGroup: undefined,
		streamingMessage: undefined,
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: {
			retryAttempt: 0,
			modelRuntime: {},
			extensionRunner: { getMessageRenderer: () => undefined },
		},
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		maybeSuggestBugReport: vi.fn(),
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		editor: { addToHistory: vi.fn() },
		transcriptEntries: new Map<string, TranscriptEntryComponent>(),
		assistantComponents: new Map<string, AssistantMessageComponent>(),
		toolComponents: new Map<string, ToolExecutionComponent>(),
		expandableTranscriptComponents: new Map<
			string,
			{ setExpanded(expanded: boolean): void; isExpanded(): boolean }
		>(),
		restoringExpansionState: undefined,
		persistedEntryIdsByMessage: new WeakMap<object, string>(),
		renderedEntriesByMessage: new WeakMap<object, TranscriptEntryComponent>(),
	} as unknown as RenderSessionContextThis;

	const prototype = InteractiveMode.prototype as unknown as {
		createTranscriptEntry: RenderSessionContextThis["createTranscriptEntry"];
		registerTranscriptEntry: RenderSessionContextThis["registerTranscriptEntry"];
		registerAssistantComponent: RenderSessionContextThis["registerAssistantComponent"];
		registerToolComponent: RenderSessionContextThis["registerToolComponent"];
		getToolStateKey: RenderSessionContextThis["getToolStateKey"];
		createToolComponent: RenderSessionContextThis["createToolComponent"];
		addMessageToChat: AddMessageToChat;
		renderTranscriptItems: RenderSessionContextThis["renderTranscriptItems"];
	};
	context.createTranscriptEntry = prototype.createTranscriptEntry;
	context.registerTranscriptEntry = prototype.registerTranscriptEntry;
	context.registerAssistantComponent = prototype.registerAssistantComponent;
	context.registerToolComponent = prototype.registerToolComponent;
	context.getToolStateKey = prototype.getToolStateKey;
	context.createToolComponent = prototype.createToolComponent;
	context.addMessageToChat = (message, options) => prototype.addMessageToChat.call(context, message, options);
	context.renderTranscriptItems = prototype.renderTranscriptItems;
	return context;
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createAssistantTextAndToolCallMessage(): AssistantMessage {
	const message = createAssistantToolCallMessage();
	return {
		...message,
		content: [
			{ type: "text", text: "VISIBLE_COMMENTARY" },
			{ type: "thinking", thinking: "PRIVATE_REASONING" },
			...message.content,
		],
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionEntries", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("restores semantic assistant text without marking thinking or tool rows", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const addMessageToChat = (InteractiveMode.prototype as unknown as { addMessageToChat: AddMessageToChat })
			.addMessageToChat;
		fakeThis.addMessageToChat = (message, options) => addMessageToChat.call(fakeThis, message, options);
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;

		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantTextAndToolCallMessage()]));

		const lines = fakeThis.chatContainer.render(120);
		const commentary = lines.find((line) => stripAnsi(line).includes("VISIBLE_COMMENTARY"));
		const thinking = lines.find((line) => stripAnsi(line).includes("PRIVATE_REASONING"));
		const tool = lines.find((line) => stripAnsi(line).includes(TOOL_NAME));
		expect(commentary).toContain(OSC133_ZONE_START);
		expect(commentary).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);
		expect(thinking).toBeDefined();
		expect(thinking).not.toContain(OSC133_ZONE_START);
		expect(thinking).not.toContain(OSC133_ZONE_END);
		expect(thinking).not.toContain(OSC133_ZONE_FINAL);
		expect(tool).toBeDefined();
		expect(tool).not.toContain(OSC133_ZONE_START);
		expect(tool).not.toContain(OSC133_ZONE_END);
		expect(tool).not.toContain(OSC133_ZONE_FINAL);
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		fakeThis.liveTools.set(TOOL_CALL_ID, fakeThis.createToolComponent(TOOL_NAME, TOOL_CALL_ID, { delayMs: 10_000 }));

		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("drops aborted live tools so rebuilds cannot resurrect them", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const message = { ...createAssistantToolCallMessage(), stopReason: "aborted" as const };
		const assistant = new AssistantMessageComponent(message, false);
		const group = new AssistantTranscriptGroup(undefined, message, assistant);
		const tool = fakeThis.createToolComponent(TOOL_NAME, TOOL_CALL_ID, { delayMs: 10_000 });
		group.addTool(TOOL_CALL_ID, tool);
		fakeThis.streamingComponent = assistant;
		fakeThis.streamingGroup = group;
		fakeThis.streamingMessage = message;
		fakeThis.pendingTools.set(TOOL_CALL_ID, tool);
		fakeThis.liveTools.set(TOOL_CALL_ID, tool);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, { type: "message_end", message });

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(fakeThis.liveTools.has(TOOL_CALL_ID)).toBe(false);
		expect(stripAnsi(tool.render(120).join("\n"))).toContain("Operation aborted");
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;

		renderSessionEntries.call(
			fakeThis,
			createSessionEntries([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});

	test("renders duplicate historical tool-call IDs as separate content-position components", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const message = createAssistantToolCallMessage();
		message.content = [
			{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { position: 1 } },
			{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { position: 2 } },
		];

		renderSessionEntries.call(
			fakeThis,
			createSessionEntries([
				message,
				createToolResultMessage("FIRST_DUPLICATE_RESULT"),
				createToolResultMessage("SECOND_DUPLICATE_RESULT"),
			]),
		);

		expect(fakeThis.toolComponents.size).toBe(2);
		expect(renderChat(fakeThis.chatContainer)).toContain("FIRST_DUPLICATE_RESULT");
		expect(renderChat(fakeThis.chatContainer)).toContain("SECOND_DUPLICATE_RESULT");
	});
});
