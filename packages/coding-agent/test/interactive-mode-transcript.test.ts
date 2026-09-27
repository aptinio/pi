import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { UserBashEventResult } from "../src/core/extensions/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { AssistantTranscriptGroup } from "../src/modes/interactive/components/assistant-transcript-group.ts";
import {
	BashExecutionComponent,
	type BashExecutionSnapshot,
} from "../src/modes/interactive/components/bash-execution.ts";
import type { ToolExecutionComponent, ToolExpansionState } from "../src/modes/interactive/components/tool-execution.ts";
import { TranscriptEntryComponent } from "../src/modes/interactive/components/transcript-entry.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { TranscriptItem } from "../src/modes/interactive/transcript-projection.ts";

const TIMESTAMP = "2026-09-24T00:00:00.000Z";

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("InteractiveMode transcript projection", () => {
	beforeAll(() => initTheme("dark"));
	test("selects the complete branch only in fullscreen mode", () => {
		const fullBranch = [userEntry("before", "before compaction"), userEntry("after", "after compaction")];
		const compactContext = [fullBranch[1]!];
		const getVisibleTranscriptEntries = Reflect.get(
			InteractiveMode.prototype,
			"getVisibleTranscriptEntries",
		) as (this: {
			isFullscreen(): boolean;
			sessionManager: { getBranch(): SessionEntry[]; buildContextEntries(): SessionEntry[] };
		}) => SessionEntry[];
		const sessionManager = {
			getBranch: vi.fn(() => fullBranch),
			buildContextEntries: vi.fn(() => compactContext),
		};

		expect(getVisibleTranscriptEntries.call({ isFullscreen: () => true, sessionManager })).toBe(fullBranch);
		expect(getVisibleTranscriptEntries.call({ isFullscreen: () => false, sessionManager })).toBe(compactContext);
	});

	test("keeps editor history population separate from the visual projection", () => {
		const fullBranch = [userEntry("before", "before compaction"), userEntry("after", "after compaction")];
		const fakeThis = {
			getVisibleTranscriptEntries: () => fullBranch,
			renderSessionEntries: vi.fn(),
			populateEditorHistoryFromContext: vi.fn(),
			renderProjectTrustWarningIfNeeded: vi.fn(),
			sessionManager: { getEntries: () => fullBranch },
			showStatus: vi.fn(),
		};
		const renderInitialMessages = Reflect.get(InteractiveMode.prototype, "renderInitialMessages") as (
			this: typeof fakeThis,
		) => void;

		renderInitialMessages.call(fakeThis);

		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith(fullBranch, {
			updateFooter: true,
			collapseCompletedActivity: true,
		});
		expect(fakeThis.populateEditorHistoryFromContext).toHaveBeenCalledOnce();
	});

	test("retains presentation state for entries omitted by an intermediate projection", () => {
		const oldTool = { getExpansionState: () => "expanded" as ToolExpansionState };
		const newTool = { getExpansionState: () => "preview" as ToolExpansionState };
		const fakeThis = {
			transcriptExpansionState: {
				tools: new Map<string, ToolExpansionState>(),
				thinking: new Map<string, ReadonlyMap<number, boolean>>(),
				expandable: new Map<string, boolean>(),
				assistantTurns: new Map<string, { completed: boolean }>(),
				assistantRegions: new Map<string, boolean>(),
			},
			assistantTurns: new Set([
				{
					getStateKeys: () => ["old"],
					isCompleted: () => true,
					getRegionExpansionStates: () => [{ stateKeys: ["old:thinking:0"], expanded: true }],
				},
			]),
			toolComponents: new Map([["old:0:tool", oldTool]]),
			assistantComponents: new Map<string, { getThinkingVisibilityOverrides(): ReadonlyMap<number, boolean> }>(),
			expandableTranscriptComponents: new Map<string, { isExpanded(): boolean }>(),
			getToolStateKey: (assistantEntryId: string, contentIndex: number, toolCallId: string) =>
				`${assistantEntryId}:${contentIndex}:${toolCallId}`,
			restoringExpansionState: undefined as
				| {
						tools: Map<string, ToolExpansionState>;
						thinking: Map<string, ReadonlyMap<number, boolean>>;
						expandable: Map<string, boolean>;
						assistantTurns: Map<string, { completed: boolean }>;
						assistantRegions: Map<string, boolean>;
				  }
				| undefined,
			toolOutputExpanded: false,
		};
		const capture = Reflect.get(InteractiveMode.prototype, "captureTranscriptExpansionState") as (
			this: typeof fakeThis,
		) => typeof fakeThis.transcriptExpansionState;
		const registerTool = Reflect.get(InteractiveMode.prototype, "registerToolComponent") as (
			this: typeof fakeThis,
			assistantEntryId: string,
			contentIndex: number,
			toolCallId: string,
			component: { setExpansionState(state: ToolExpansionState): void; setExpanded(expanded: boolean): void },
		) => void;

		capture.call(fakeThis);
		fakeThis.toolComponents = new Map([["new:0:tool", newTool]]);
		capture.call(fakeThis);

		expect(fakeThis.transcriptExpansionState.tools).toEqual(
			new Map([
				["old:0:tool", "expanded"],
				["new:0:tool", "preview"],
			]),
		);
		expect(fakeThis.transcriptExpansionState.assistantTurns).toEqual(new Map([["old", { completed: true }]]));
		expect(fakeThis.transcriptExpansionState.assistantRegions).toEqual(new Map([["old:thinking:0", true]]));

		const restoredTool = {
			setExpansionState: vi.fn(),
			setExpanded: vi.fn(),
			getExpansionState: () => "collapsed" as const,
		};
		fakeThis.restoringExpansionState = fakeThis.transcriptExpansionState;
		registerTool.call(fakeThis, "old", 0, "tool", restoredTool);
		expect(restoredTool.setExpansionState).toHaveBeenCalledWith("expanded");
	});

	test("applies a global tool expansion toggle to entries outside the current projection", () => {
		const hiddenToolKey = "hidden-assistant:0:hidden-tool";
		const hiddenExpandableKey = "hidden-summary:summary";
		const thinkingOverrides = new Map([["hidden-assistant", new Map([[0, true]])]]);
		const mountedTool = { setExpanded: vi.fn() };
		const mountedExpandable = { setExpanded: vi.fn() };
		const mountedTurn = { setExpanded: vi.fn() };
		const fakeThis = {
			toolOutputExpanded: false,
			transcriptExpansionState: {
				tools: new Map([[hiddenToolKey, "collapsed"]]),
				thinking: thinkingOverrides,
				expandable: new Map([[hiddenExpandableKey, false]]),
				assistantTurns: new Map([["hidden-turn", { completed: true }]]),
				assistantRegions: new Map([["hidden-turn:thinking:0", false]]),
			},
			customHeader: undefined,
			builtInHeader: undefined,
			loadedResourcesContainer: { children: [] },
			expandableTranscriptComponents: new Map([["mounted", mountedExpandable]]),
			assistantTurns: new Set([mountedTurn]),
			toolComponents: new Map([["mounted", mountedTool]]),
			liveTools: new Map(),
			pendingBashEntryComponents: [] as TranscriptEntryComponent[],
			showStatus: vi.fn(),
		};
		const setToolsExpanded = Reflect.get(InteractiveMode.prototype, "setToolsExpanded") as (
			this: typeof fakeThis,
			expanded: boolean,
		) => void;

		setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.transcriptExpansionState.tools).toEqual(new Map());
		expect(fakeThis.transcriptExpansionState.expandable).toEqual(new Map());
		expect(fakeThis.transcriptExpansionState.assistantTurns).toEqual(new Map());
		expect(fakeThis.transcriptExpansionState.assistantRegions).toEqual(new Map());
		expect(fakeThis.transcriptExpansionState.thinking).toBe(thinkingOverrides);
		expect(mountedTool.setExpanded).toHaveBeenCalledWith(true);
		expect(mountedExpandable.setExpanded).toHaveBeenCalledWith(true);
		expect(mountedTurn.setExpanded).toHaveBeenCalledWith(true);
	});

	test("groups consecutive assistant messages into one turn until a user boundary", () => {
		const groups = ["assistant-1", "assistant-2", "assistant-3"].map(
			(id) =>
				new AssistantTranscriptGroup(
					id,
					assistantMessage([{ type: "text", text: id }]),
					new Container() as unknown as AssistantMessageComponent,
				),
		);
		const fakeThis = {
			activeAssistantTurn: undefined,
			assistantTurns: new Set(),
			outputPad: 1,
			chatContainer: new Container(),
		};
		const addAssistantGroupToTurn = Reflect.get(InteractiveMode.prototype, "addAssistantGroupToTurn") as (
			this: typeof fakeThis,
			group: AssistantTranscriptGroup,
		) => void;

		addAssistantGroupToTurn.call(fakeThis, groups[0]!);
		addAssistantGroupToTurn.call(fakeThis, groups[1]!);
		expect(fakeThis.assistantTurns.size).toBe(1);

		fakeThis.activeAssistantTurn = undefined;
		addAssistantGroupToTurn.call(fakeThis, groups[2]!);
		expect(fakeThis.assistantTurns.size).toBe(2);
		expect(fakeThis.chatContainer.children).toHaveLength(3);
	});

	test("folds the completed prefix after mounting a continuing assistant message", () => {
		const fakeThis = {
			persistedEntryIdsByMessage: new WeakMap<object, string>(),
			hideThinkingBlock: false,
			getMarkdownThemeWithSettings: () => ({}),
			hiddenThinkingLabel: "Thinking",
			outputPad: 1,
			getMarkdownTransformers: () => [],
			streamingComponent: undefined,
			streamingGroup: undefined,
			streamingMessage: undefined,
			renderedEntriesByMessage: new WeakMap<object, AssistantTranscriptGroup>(),
			addAssistantGroupToTurn: vi.fn(),
			foldActiveAssistantPrefix: vi.fn(),
		};
		const addStreamingAssistant = Reflect.get(InteractiveMode.prototype, "addStreamingAssistant") as (
			this: typeof fakeThis,
			message: AssistantMessage,
		) => AssistantTranscriptGroup;

		const group = addStreamingAssistant.call(
			fakeThis,
			assistantMessage([{ type: "thinking", thinking: "continuing" }]),
		);

		expect(fakeThis.addAssistantGroupToTurn).toHaveBeenCalledWith(group);
		expect(fakeThis.foldActiveAssistantPrefix).toHaveBeenCalledOnce();
		expect(fakeThis.addAssistantGroupToTurn.mock.invocationCallOrder[0]).toBeLessThan(
			fakeThis.foldActiveAssistantPrefix.mock.invocationCallOrder[0]!,
		);
	});

	test("collapses completed turns during cold session replay", () => {
		const turn = {
			getStateKeys: () => ["assistant-1"],
			reconcileBoundaries: vi.fn(),
			complete: vi.fn(),
		};
		const fakeThis = {
			activeAssistantTurn: turn,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: true,
			session: { isStreaming: false },
			restoringExpansionState: undefined,
		};
		const completeActiveAssistantTurn = Reflect.get(InteractiveMode.prototype, "completeActiveAssistantTurn") as (
			this: typeof fakeThis,
			options?: { collapseCompletedActivity?: boolean },
		) => void;

		completeActiveAssistantTurn.call(fakeThis, { collapseCompletedActivity: true });

		expect(turn.reconcileBoundaries).toHaveBeenCalledWith(fakeThis.chatContainer.children);
		expect(turn.complete).toHaveBeenCalledWith({ defaultExpanded: false });
		expect(fakeThis.activeAssistantTurn).toBeUndefined();
	});

	test("keeps the global expansion default for non-replay completion", () => {
		const turn = {
			getStateKeys: () => ["assistant-1"],
			reconcileBoundaries: vi.fn(),
			complete: vi.fn(),
		};
		const fakeThis = {
			activeAssistantTurn: turn,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: true,
			session: { isStreaming: false },
			restoringExpansionState: undefined,
		};
		const completeActiveAssistantTurn = Reflect.get(InteractiveMode.prototype, "completeActiveAssistantTurn") as (
			this: typeof fakeThis,
		) => void;

		completeActiveAssistantTurn.call(fakeThis);

		expect(turn.complete).toHaveBeenCalledWith({ defaultExpanded: true });
	});

	test("restores a manually expanded completed turn after transcript reconstruction", () => {
		const turn = {
			getStateKeys: () => ["omitted-assistant", "assistant-1"],
			reconcileBoundaries: vi.fn(),
			complete: vi.fn(),
		};
		const fakeThis = {
			activeAssistantTurn: turn,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: false,
			session: { isStreaming: false },
			restoringExpansionState: {
				tools: new Map(),
				thinking: new Map(),
				expandable: new Map(),
				assistantTurns: new Map([["assistant-1", { completed: true }]]),
				assistantRegions: new Map([["assistant-1:thinking:0", true]]),
			},
		};
		const completeActiveAssistantTurn = Reflect.get(InteractiveMode.prototype, "completeActiveAssistantTurn") as (
			this: typeof fakeThis,
		) => void;

		completeActiveAssistantTurn.call(fakeThis);

		expect(turn.reconcileBoundaries).toHaveBeenCalledWith(fakeThis.chatContainer.children);
		expect(turn.complete).toHaveBeenCalledWith({
			defaultExpanded: false,
			restoredExpansion: fakeThis.restoringExpansionState.assistantRegions,
		});
		expect(fakeThis.activeAssistantTurn).toBeUndefined();
	});

	test("uses the normal completion default when an unsettled restored turn finishes after streaming", () => {
		const turn = { getStateKeys: () => ["assistant-1"], reconcileBoundaries: vi.fn(), complete: vi.fn() };
		const fakeThis = {
			activeAssistantTurn: turn,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: false,
			session: { isStreaming: false },
			restoringExpansionState: {
				tools: new Map(),
				thinking: new Map(),
				expandable: new Map(),
				assistantTurns: new Map([["assistant-1", { completed: false }]]),
				assistantRegions: new Map([["assistant-1:thinking:0", true]]),
			},
		};
		const completeActiveAssistantTurn = Reflect.get(InteractiveMode.prototype, "completeActiveAssistantTurn") as (
			this: typeof fakeThis,
		) => void;

		completeActiveAssistantTurn.call(fakeThis);

		expect(turn.complete).toHaveBeenCalledWith({ defaultExpanded: false });
		expect(fakeThis.activeAssistantTurn).toBeUndefined();
	});

	test("restores a previously unsettled turn's provisional prefix during streaming reconstruction", () => {
		const turn = {
			getStateKeys: () => ["assistant-1"],
			reconcileBoundaries: vi.fn(),
			complete: vi.fn(),
			foldBeforeLast: vi.fn(),
		};
		const fakeThis = {
			activeAssistantTurn: turn,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: false,
			session: { isStreaming: true },
			restoringExpansionState: {
				tools: new Map(),
				thinking: new Map(),
				expandable: new Map(),
				assistantTurns: new Map([["assistant-1", { completed: false }]]),
				assistantRegions: new Map([["assistant-1:thinking:0", true]]),
			},
		};
		const completeActiveAssistantTurn = Reflect.get(InteractiveMode.prototype, "completeActiveAssistantTurn") as (
			this: typeof fakeThis,
		) => void;

		completeActiveAssistantTurn.call(fakeThis);

		expect(turn.complete).not.toHaveBeenCalled();
		expect(turn.foldBeforeLast).toHaveBeenCalledWith({
			defaultExpanded: false,
			restoredExpansion: fakeThis.restoringExpansionState.assistantRegions,
		});
		expect(fakeThis.activeAssistantTurn).toBeUndefined();
	});

	test("does not restore completed live tools as pending", () => {
		const snapshot = {
			toolName: "read",
			toolCallId: "completed-id",
			args: { path: "done" },
			expansionState: "collapsed" as const,
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			result: { content: [{ type: "text", text: "done" }], isError: false },
		};
		const completed = { getSnapshot: () => snapshot };
		const restored = { restoreSnapshot: vi.fn() };
		const fakeThis = {
			toolComponents: new Map<string, typeof completed | typeof restored>([["assistant:0:completed-id", completed]]),
			liveTools: new Map([["completed-id", completed]]),
			pendingTools: new Map<string, typeof completed | typeof restored>(),
			bashComponent: undefined,
			pendingBashEntryComponents: [] as TranscriptEntryComponent[],
			chatContainer: new Container(),
			streamingMessage: undefined,
			streamingGroup: undefined,
			streamingComponent: undefined,
			createToolComponent: vi.fn(),
		};
		const capture = Reflect.get(InteractiveMode.prototype, "captureTransientTranscriptState") as (
			this: typeof fakeThis,
		) => {
			liveTools: Map<string, { stateKey?: string; pending: boolean; snapshot: typeof snapshot }>;
		};
		const restore = Reflect.get(InteractiveMode.prototype, "restoreTransientTranscriptState") as (
			this: typeof fakeThis,
			state: ReturnType<typeof capture>,
		) => void;

		const state = capture.call(fakeThis);
		expect(state.liveTools.get("completed-id")?.pending).toBe(false);

		fakeThis.toolComponents = new Map([["assistant:0:completed-id", restored]]);
		fakeThis.pendingTools.set("completed-id", restored);
		restore.call(fakeThis, state);

		expect(restored.restoreSnapshot).toHaveBeenCalledWith(snapshot);
		expect(fakeThis.liveTools.get("completed-id")).toBe(restored);
		expect(fakeThis.pendingTools.has("completed-id")).toBe(false);
	});

	test("does not treat unmatched historical tools as the current live batch", () => {
		const historicalMessage = assistantMessage([
			{ type: "toolCall", id: "reused-id", name: "read", arguments: { path: "old" } },
		]);
		const currentMessage = assistantMessage([
			{ type: "toolCall", id: "current-id", name: "read", arguments: { path: "current" } },
		]);
		const currentLiveTool = new Container() as unknown as ToolExecutionComponent;
		const fakeThis = {
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getEntries: () => [] },
			liveTools: new Map([["current-id", currentLiveTool]]),
			addMessageToChat: vi.fn(
				(message: AssistantMessage, options: { entryId?: string } = {}) =>
					new AssistantTranscriptGroup(
						options.entryId,
						message,
						new Container() as unknown as AssistantMessageComponent,
					),
			),
			createToolComponent: vi.fn(() => new Container() as unknown as ToolExecutionComponent),
			registerToolComponent: vi.fn(),
			pendingTools: new Map<string, ToolExecutionComponent>(),
			session: { isStreaming: false },
			completeActiveAssistantTurn: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const renderTranscriptItems = Reflect.get(InteractiveMode.prototype, "renderTranscriptItems") as (
			this: typeof fakeThis,
			items: readonly TranscriptItem[],
		) => void;
		const item = (entryId: string, message: AssistantMessage): TranscriptItem => ({
			kind: "assistant",
			entryId,
			message,
			tools: [
				{
					contentIndex: 0,
					call: message.content[0] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
				},
			],
		});

		renderTranscriptItems.call(fakeThis, [
			item("assistant-old", historicalMessage),
			item("assistant-current", currentMessage),
		]);

		expect([...fakeThis.pendingTools.keys()]).toEqual(["current-id"]);
	});

	test("uses a replayed user message as a turn boundary", () => {
		const completeActiveAssistantTurn = vi.fn();
		const addMessageToChat = vi.fn();
		const fakeThis = {
			completeActiveAssistantTurn,
			addMessageToChat,
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getEntries: () => [] },
			session: { isStreaming: true },
			ui: { requestRender: vi.fn() },
		};
		const renderTranscriptItems = Reflect.get(InteractiveMode.prototype, "renderTranscriptItems") as (
			this: typeof fakeThis,
			items: readonly TranscriptItem[],
		) => void;
		const message = { role: "user" as const, content: "next request", timestamp: 1 };

		renderTranscriptItems.call(fakeThis, [{ kind: "user", entryId: "user-1", message }]);

		expect(completeActiveAssistantTurn).toHaveBeenCalledOnce();
		expect(addMessageToChat).toHaveBeenCalledWith(message, { entryId: "user-1", populateHistory: undefined });
		expect(completeActiveAssistantTurn.mock.invocationCallOrder[0]).toBeLessThan(
			addMessageToChat.mock.invocationCallOrder[0]!,
		);
	});

	test("uses a live user message as a turn boundary", async () => {
		const activeAssistantTurn = {};
		const message = { role: "user" as const, content: "next request", timestamp: 1 };
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeAssistantTurn,
			addMessageToChat: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "message_start"; message: typeof message },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "message_start", message });

		expect(fakeThis.activeAssistantTurn).toBeUndefined();
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(message);
	});

	test("folds completed assistant turns at the final settled boundary", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			settleAssistantTurns: vi.fn(),
			checkShutdownRequested: vi.fn(async () => undefined),
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "agent_settled" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_settled" });

		expect(fakeThis.settleAssistantTurns).toHaveBeenCalledOnce();
		expect(fakeThis.checkShutdownRequested).toHaveBeenCalledOnce();
	});

	test("preserves the fullscreen transcript anchor while folding a completed assistant prefix", () => {
		const viewState = {
			sessionId: "session-1",
			followingEnd: false,
			followSuppressed: true,
			viewportAnchor: { entryId: "assistant-2", rowOffset: 12 },
		};
		const renderer = {
			[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
			captureTranscriptViewState: vi.fn(() => viewState),
			restoreTranscriptViewState: vi.fn(),
		};
		const activeTurn = {
			reconcileBoundaries: vi.fn(),
			foldBeforeLast: vi.fn(() => true),
			getFoldedEntryRedirect: vi.fn(() => "assistant-1"),
		};
		const fakeThis = {
			renderer,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: false,
			activeAssistantTurn: activeTurn,
			restoringExpansionState: undefined,
			ui: { requestRender: vi.fn() },
		};
		const foldActiveAssistantPrefix = Reflect.get(InteractiveMode.prototype, "foldActiveAssistantPrefix") as (
			this: typeof fakeThis,
		) => void;

		foldActiveAssistantPrefix.call(fakeThis);

		expect(activeTurn.reconcileBoundaries).toHaveBeenCalledWith(fakeThis.chatContainer.children);
		expect(activeTurn.foldBeforeLast).toHaveBeenCalledWith({ defaultExpanded: false });
		expect(renderer.restoreTranscriptViewState).toHaveBeenCalledWith({
			...viewState,
			viewportAnchor: { entryId: "assistant-1", rowOffset: 0 },
		});
		expect(fakeThis.ui.requestRender).toHaveBeenCalledOnce();
	});

	test("restores provisional region state without restoring an intermediate reconstruction viewport", () => {
		const restoredExpansion = new Map([["assistant-1:thinking:0", true]]);
		const renderer = {
			[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
			captureTranscriptViewState: vi.fn(),
			restoreTranscriptViewState: vi.fn(),
		};
		const activeTurn = {
			reconcileBoundaries: vi.fn(),
			foldBeforeLast: vi.fn(() => true),
			getFoldedEntryRedirect: vi.fn(),
		};
		const fakeThis = {
			renderer,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: false,
			activeAssistantTurn: activeTurn,
			restoringExpansionState: {
				tools: new Map(),
				thinking: new Map(),
				expandable: new Map(),
				assistantTurns: new Map(),
				assistantRegions: restoredExpansion,
			},
			ui: { requestRender: vi.fn() },
		};
		const foldActiveAssistantPrefix = Reflect.get(InteractiveMode.prototype, "foldActiveAssistantPrefix") as (
			this: typeof fakeThis,
		) => void;

		foldActiveAssistantPrefix.call(fakeThis);

		expect(activeTurn.foldBeforeLast).toHaveBeenCalledWith({
			defaultExpanded: false,
			restoredExpansion,
		});
		expect(renderer.captureTranscriptViewState).not.toHaveBeenCalled();
		expect(renderer.restoreTranscriptViewState).not.toHaveBeenCalled();
	});

	test("preserves the fullscreen transcript anchor while settling assistant turns", () => {
		const viewState = {
			sessionId: "session-1",
			followingEnd: false,
			followSuppressed: true,
			viewportAnchor: { entryId: "assistant-2", rowOffset: 12 },
		};
		const renderer = {
			[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
			captureTranscriptViewState: vi.fn(() => viewState),
			restoreTranscriptViewState: vi.fn(),
		};
		const completedTurn = {
			complete: vi.fn(() => true),
			isCompleted: () => false,
			reconcileBoundaries: vi.fn(),
			getFoldedEntryRedirect: vi.fn(() => "assistant-1"),
		};
		const fakeThis = {
			renderer,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: false,
			assistantTurns: new Set([completedTurn]),
			activeAssistantTurn: completedTurn,
			ui: { requestRender: vi.fn() },
		};
		const settleAssistantTurns = Reflect.get(InteractiveMode.prototype, "settleAssistantTurns") as (
			this: typeof fakeThis,
		) => void;

		settleAssistantTurns.call(fakeThis);

		expect(completedTurn.reconcileBoundaries).toHaveBeenCalledWith(fakeThis.chatContainer.children);
		expect(completedTurn.complete).toHaveBeenCalledWith({ defaultExpanded: false });
		expect(fakeThis.activeAssistantTurn).toBeUndefined();
		expect(renderer.restoreTranscriptViewState).toHaveBeenCalledWith({
			...viewState,
			viewportAnchor: { entryId: "assistant-1", rowOffset: 0 },
		});
		expect(fakeThis.ui.requestRender).toHaveBeenCalledOnce();
	});

	test("does not restore fullscreen view state when settling makes no presentation change", () => {
		const renderer = {
			[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
			captureTranscriptViewState: vi.fn(() => ({ sessionId: "session-1" })),
			restoreTranscriptViewState: vi.fn(),
		};
		const completedTurn = {
			complete: vi.fn(() => false),
			isCompleted: () => false,
			reconcileBoundaries: vi.fn(),
		};
		const fakeThis = {
			renderer,
			chatContainer: { children: [] as Component[] },
			toolOutputExpanded: false,
			assistantTurns: new Set([completedTurn]),
			activeAssistantTurn: completedTurn,
			ui: { requestRender: vi.fn() },
		};
		const settleAssistantTurns = Reflect.get(InteractiveMode.prototype, "settleAssistantTurns") as (
			this: typeof fakeThis,
		) => void;

		settleAssistantTurns.call(fakeThis);

		expect(renderer.captureTranscriptViewState).toHaveBeenCalledOnce();
		expect(renderer.restoreTranscriptViewState).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});

	test("restores fullscreen view state during a same-session rebind", () => {
		const events: string[] = [];
		const viewState = { sessionId: "session-1" };
		const renderer = {
			[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
			captureTranscriptViewState: vi.fn(() => {
				events.push("capture-view");
				return viewState;
			}),
			restoreTranscriptViewState: vi.fn((state: typeof viewState) => {
				events.push("restore-view");
				expect(state).toBe(viewState);
			}),
		};
		const fakeThis = {
			captureTranscriptExpansionState: vi.fn(() => ({
				tools: new Map(),
				thinking: new Map(),
				expandable: new Map(),
				assistantTurns: new Map(),
				assistantRegions: new Map(),
			})),
			captureTransientTranscriptState: vi.fn(() => ({ liveTools: new Map() })),
			transcriptExpansionState: {
				tools: new Map(),
				thinking: new Map(),
				expandable: new Map(),
				assistantTurns: new Map(),
				assistantRegions: new Map(),
			},
			renderer,
			clearTranscriptPromptSelection: vi.fn(() => events.push("clear-selection")),
			loadedResourcesContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			compactionQueuedMessages: [],
			clearTranscriptRegistries: vi.fn(),
			streamingMessage: undefined,
			liveTools: new Map(),
			pendingBashEntryComponents: [] as TranscriptEntryComponent[],
			restoringExpansionState: undefined,
			renderInitialMessages: vi.fn(() => events.push("render")),
			addStreamingAssistant: vi.fn(),
			restoreTransientTranscriptState: vi.fn(),
		};
		const renderCurrentSessionState = Reflect.get(InteractiveMode.prototype, "renderCurrentSessionState") as (
			this: typeof fakeThis,
			preservePresentationState: boolean,
		) => void;

		renderCurrentSessionState.call(fakeThis, true);

		expect(events).toEqual(["capture-view", "clear-selection", "render", "restore-view"]);
		expect(fakeThis.renderInitialMessages).toHaveBeenCalledWith({ collapseCompletedActivity: false });
		expect(renderer.restoreTranscriptViewState).toHaveBeenCalledWith(viewState);
	});

	test("does not restore presentation state during a cold session switch", () => {
		const renderedWith: Array<unknown> = [];
		let restorationStateDuringRender: unknown;
		const fakeThis = {
			captureTranscriptExpansionState: vi.fn(),
			captureTransientTranscriptState: vi.fn(),
			transcriptExpansionState: {
				tools: new Map(),
				thinking: new Map(),
				expandable: new Map(),
				assistantTurns: new Map(),
				assistantRegions: new Map(),
			},
			renderer: {},
			clearTranscriptPromptSelection: vi.fn(),
			loadedResourcesContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			compactionQueuedMessages: [],
			clearTranscriptRegistries: vi.fn(),
			streamingMessage: undefined,
			liveTools: new Map([["old", {}]]),
			pendingBashEntryComponents: [] as TranscriptEntryComponent[],
			restoringExpansionState: undefined,
			renderInitialMessages: vi.fn((options: unknown) => {
				renderedWith.push(options);
				restorationStateDuringRender = fakeThis.restoringExpansionState;
			}),
			addStreamingAssistant: vi.fn(),
			restoreTransientTranscriptState: vi.fn(),
		};
		const renderCurrentSessionState = Reflect.get(InteractiveMode.prototype, "renderCurrentSessionState") as (
			this: typeof fakeThis,
			preservePresentationState: boolean,
		) => void;

		renderCurrentSessionState.call(fakeThis, false);

		expect(fakeThis.captureTranscriptExpansionState).not.toHaveBeenCalled();
		expect(fakeThis.captureTransientTranscriptState).not.toHaveBeenCalled();
		expect(renderedWith).toEqual([{ collapseCompletedActivity: true }]);
		expect(restorationStateDuringRender).toBeUndefined();
		expect(fakeThis.liveTools.size).toBe(0);
	});

	test("rehydrates an active chat bash wrapper across transcript rebuilds", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const original = new BashExecutionComponent("long-command", ui, true);
		original.appendOutput("partial output");
		original.setExpanded(true);
		const originalEntry = new TranscriptEntryComponent(undefined, [original]);
		const pendingBashEntryComponents = [originalEntry];
		const chatContainer = new Container();
		chatContainer.addChild(originalEntry);
		const fakeThis = {
			bashComponent: original as BashExecutionComponent | undefined,
			streamingMessage: undefined,
			streamingGroup: undefined,
			streamingComponent: undefined,
			toolComponents: new Map(),
			liveTools: new Map(),
			pendingTools: new Map(),
			pendingBashEntryComponents,
			chatContainer,
			ui,
			createTranscriptEntry: (entryId: string | undefined, children: readonly Component[]) =>
				new TranscriptEntryComponent(entryId, children),
			createToolComponent: vi.fn(),
		};
		type TransientState = {
			liveTools: Map<string, never>;
			bash?: { snapshot: BashExecutionSnapshot; pendingIndex: number };
		};
		const capture = Reflect.get(InteractiveMode.prototype, "captureTransientTranscriptState") as (
			this: typeof fakeThis,
		) => TransientState;
		const restore = Reflect.get(InteractiveMode.prototype, "restoreTransientTranscriptState") as (
			this: typeof fakeThis,
			state: TransientState,
		) => void;

		const state = capture.call(fakeThis);
		chatContainer.clear();
		restore.call(fakeThis, state);

		expect(state.bash).toMatchObject({ pendingIndex: 0 });
		expect(fakeThis.bashComponent).not.toBe(original);
		expect(fakeThis.bashComponent?.getSnapshot()).toEqual(original.getSnapshot());
		expect(pendingBashEntryComponents[0]).not.toBe(originalEntry);
		expect(chatContainer.children).toEqual([pendingBashEntryComponents[0]]);
	});

	test("removes a failed bash wrapper after a rebuild replaces its identity owner", async () => {
		let rejectExecution: (reason?: unknown) => void = () => {};
		const execution = new Promise<never>((_resolve, reject) => {
			rejectExecution = reject;
		});
		const pendingBashEntryComponents: TranscriptEntryComponent[] = [];
		const fakeThis = {
			session: {
				isStreaming: false,
				extensionRunner: { emitUserBash: vi.fn(async () => undefined) },
				executeBash: vi.fn(() => execution),
			},
			sessionManager: { getCwd: () => process.cwd() },
			ui: { requestRender: vi.fn() } as unknown as TUI,
			toolOutputExpanded: false,
			bashComponent: undefined as BashExecutionComponent | undefined,
			pendingBashEntryComponents,
			pendingBashComponents: [] as TranscriptEntryComponent[],
			pendingMessagesContainer: new Container(),
			chatContainer: new Container(),
			showError: vi.fn(),
			createTranscriptEntry: (entryId: string | undefined, children: readonly Component[]) =>
				new TranscriptEntryComponent(entryId, children),
			removePendingBashEntryComponent: Reflect.get(InteractiveMode.prototype, "removePendingBashEntryComponent") as (
				component: TranscriptEntryComponent,
			) => void,
		};
		const handleBashCommand = Reflect.get(InteractiveMode.prototype, "handleBashCommand") as (
			this: typeof fakeThis,
			command: string,
			excludeFromContext?: boolean,
		) => Promise<void>;

		const run = handleBashCommand.call(fakeThis, "broken-command");
		await vi.waitFor(() => expect(pendingBashEntryComponents).toHaveLength(1));

		const replacement = new BashExecutionComponent("broken-command", fakeThis.ui, false);
		const replacementEntry = new TranscriptEntryComponent(undefined, [replacement]);
		fakeThis.bashComponent = replacement;
		pendingBashEntryComponents[0] = replacementEntry;
		fakeThis.chatContainer.clear();
		fakeThis.chatContainer.addChild(replacementEntry);

		rejectExecution(new Error("execution failed"));
		await run;

		expect(pendingBashEntryComponents).toEqual([]);
		expect(fakeThis.showError).toHaveBeenCalledWith("Bash command failed: execution failed");
	});

	test("does not let failed unpersisted bash wrappers consume later durable identities", async () => {
		const pendingBashEntryComponents: TranscriptEntryComponent[] = [];
		const fakeThis = {
			session: {
				isStreaming: false,
				extensionRunner: {
					emitUserBash: vi.fn(
						async (): Promise<UserBashEventResult | undefined> => ({
							result: { output: "failed output", exitCode: 1, cancelled: false, truncated: false },
						}),
					),
				},
				executeBash: vi.fn(async () => {
					throw new Error("execution failed");
				}),
				recordBashResult: vi.fn(() => {
					throw new Error("persistence failed");
				}),
			},
			sessionManager: { getCwd: () => process.cwd() },
			ui: { requestRender: vi.fn() } as unknown as TUI,
			toolOutputExpanded: false,
			bashComponent: undefined as BashExecutionComponent | undefined,
			pendingBashEntryComponents,
			pendingBashComponents: [] as TranscriptEntryComponent[],
			pendingMessagesContainer: new Container(),
			chatContainer: new Container(),
			showError: vi.fn(),
			createTranscriptEntry: (entryId: string | undefined, children: readonly Component[]) =>
				new TranscriptEntryComponent(entryId, children),
			removePendingBashEntryComponent: Reflect.get(InteractiveMode.prototype, "removePendingBashEntryComponent") as (
				component: TranscriptEntryComponent,
			) => void,
		};
		const handleBashCommand = Reflect.get(InteractiveMode.prototype, "handleBashCommand") as (
			this: typeof fakeThis,
			command: string,
			excludeFromContext?: boolean,
		) => Promise<void>;

		await expect(handleBashCommand.call(fakeThis, "false")).rejects.toThrow("persistence failed");
		expect(pendingBashEntryComponents).toEqual([]);
		expect(fakeThis.chatContainer.children).toHaveLength(1);

		fakeThis.session.extensionRunner.emitUserBash.mockResolvedValueOnce(undefined);
		fakeThis.bashComponent = undefined;
		fakeThis.chatContainer.clear();
		await handleBashCommand.call(fakeThis, "broken-command");
		expect(pendingBashEntryComponents).toEqual([]);
		expect(fakeThis.showError).toHaveBeenCalledWith("Bash command failed: execution failed");
		expect(fakeThis.chatContainer.children).toHaveLength(1);
	});
});

describe("TranscriptEntryComponent", () => {
	test("places identity after an OSC 133 prefix and can be retargeted after persistence", () => {
		const component = new TranscriptEntryComponent(undefined, [new Text("\x1b]133;A\x07assistant text", 0, 0)]);
		expect(component.render(80)[0]?.startsWith("\x1b]133;A\x07assistant text")).toBe(true);

		component.setEntryId("entry-1");
		const line = component.render(80)[0] ?? "";
		const prefix = "\x1b]133;A\x07\x1b_pi:e:656e7472792d31\x07";
		expect(line.startsWith(prefix)).toBe(true);
	});
});
