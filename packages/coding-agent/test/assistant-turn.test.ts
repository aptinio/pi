import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, ScrollView, Spacer, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { AssistantTranscriptGroup } from "../src/modes/interactive/components/assistant-transcript-group.ts";
import { AssistantTurn } from "../src/modes/interactive/components/assistant-turn.ts";
import type {
	ToolExecutionComponent,
	ToolExecutionSnapshot,
} from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const foldTimestamp = new Date(2026, 0, 1, 13, 5).getTime();

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	timestamp = foldTimestamp,
): AssistantMessage {
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
		stopReason,
		timestamp,
	};
}

function assistantGroup(id: string | undefined, message: AssistantMessage): AssistantTranscriptGroup {
	return new AssistantTranscriptGroup(id, message, new AssistantMessageComponent(message));
}

function toolComponent(
	text: string,
	options: { id?: string; error?: boolean; complete?: boolean } = {},
): ToolExecutionComponent {
	const component = new Text(text, 0, 0) as Text & { getSnapshot(): ToolExecutionSnapshot };
	component.getSnapshot = () => ({
		toolName: "read",
		toolCallId: options.id ?? text,
		args: {},
		expansionState: "collapsed",
		executionStarted: true,
		argsComplete: true,
		isPartial: options.complete === false,
		...(options.complete === false
			? {}
			: { result: { content: [{ type: "text", text }], isError: options.error ?? false } }),
	});
	return component as unknown as ToolExecutionComponent;
}

function spacedToolComponent(text: string, id: string): ToolExecutionComponent {
	const component = new Container() as Container & { getSnapshot(): ToolExecutionSnapshot };
	component.addChild(new Spacer(1));
	component.addChild(new Text(text, 0, 0));
	component.getSnapshot = () => ({
		toolName: "read",
		toolCallId: id,
		args: {},
		expansionState: "collapsed",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		result: { content: [{ type: "text", text }], isError: false },
	});
	return component as unknown as ToolExecutionComponent;
}

function clickEvent(y: number, width: number, height: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

describe("AssistantTurn", () => {
	beforeAll(() => initTheme("dark"));

	test("folds each contiguous mixed hidden region at its original position", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([
				{ type: "text", text: "Before activity." },
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
			]),
		);
		first.addTool("tool-1", toolComponent("first tool output", { id: "tool-1" }));
		const second = assistantGroup(
			"assistant-2",
			assistantMessage([
				{ type: "thinking", thinking: "continued reasoning" },
				{ type: "text", text: "Between regions." },
				{ type: "thinking", thinking: "second reasoning" },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: {} },
			]),
		);
		second.addTool("tool-2", toolComponent("second tool output", { id: "tool-2" }));
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);

		expect(turn.complete({ defaultExpanded: false })).toBe(true);

		const folded = stripAnsi([...first.render(100), ...second.render(100)].join("\n"));
		expect(folded).toContain("Before activity.");
		expect(folded).toContain("Between regions.");
		expect(folded).toContain("[+] 1 tool call, 2 thinking blocks");
		expect(folded).toContain("[+] 1 tool call, 1 thinking block");
		expect(folded).not.toContain("first reasoning");
		expect(folded).not.toContain("continued reasoning");
		expect(folded).not.toContain("second reasoning");
		expect(folded).not.toContain("first tool output");
		expect(folded).not.toContain("second tool output");
	});

	test("replaces folded rows with blanks that replacement output consumes", () => {
		const width = 100;
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
		);
		first.addTool(
			"tool-1",
			toolComponent(Array.from({ length: 12 }, (_, index) => `old output ${index + 1}`).join("\n"), {
				id: "tool-1",
			}),
		);
		const replacement = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "text", text: "Replacement output." }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		const baselineHeight = first.render(width).length;
		turn.addGroup(replacement);
		const renderHeight = () => first.render(width).length + replacement.render(width).length;

		expect(
			turn.foldBeforeLast({
				defaultExpanded: false,
				heightCompensationWidth: width,
			}),
		).toBe(true);
		expect(renderHeight()).toBe(baselineHeight);
		const initialCompensation = turn.getHeightCompensation();
		expect(initialCompensation?.rows).toBeGreaterThan(1);

		const replacementTool = toolComponent("new output", { id: "tool-2" });
		replacement.addTool("tool-2", replacementTool);
		expect(renderHeight()).toBe(baselineHeight);
		const remainingCompensation = turn.getHeightCompensation();
		expect(remainingCompensation?.rows).toBe((initialCompensation?.rows ?? 0) - 1);

		(replacementTool as unknown as Text).setText(
			Array.from({ length: (remainingCompensation?.rows ?? 0) + 2 }, (_, index) => `new output ${index + 1}`).join(
				"\n",
			),
		);
		expect(turn.getHeightCompensation()).toBeUndefined();
		expect(renderHeight()).toBe(baselineHeight + 1);

		(replacementTool as unknown as Text).setText("shorter output");
		expect(turn.getHeightCompensation()).toBeUndefined();
	});

	test("keeps follow-end scroll position fixed while replacement groups consume the fold budget", () => {
		const width = 100;
		const viewportHeight = 8;
		const document = new Container();
		const viewport = new ScrollView(document, { follow: "end" });
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
		);
		first.addTool(
			"tool-1",
			spacedToolComponent(
				Array.from({ length: 20 }, (_, index) => `first output ${index + 1}`).join("\n"),
				"tool-1",
			),
		);
		const thinking = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "thinking", thinking: "Replacement reasoning." }]),
		);
		const tool = assistantGroup(
			"assistant-3",
			assistantMessage([{ type: "toolCall", id: "tool-2", name: "read", arguments: {} }]),
		);
		tool.addTool("tool-2", spacedToolComponent("second output one\nsecond output two", "tool-2"));
		const answer = assistantGroup("assistant-4", assistantMessage([{ type: "text", text: "Replacement answer." }]));
		const turn = new AssistantTurn(1);
		const renderViewport = () => {
			const contentHeight = viewport.render(width).length;
			viewport.updateLayout(contentHeight, viewportHeight, vi.fn());
			return contentHeight;
		};
		const addGroup = (group: AssistantTranscriptGroup) => {
			turn.addGroup(group);
			document.addChild(group);
		};

		addGroup(first);
		const baselineHeight = renderViewport();
		const baselineScrollTop = viewport.scrollTop;
		expect(baselineScrollTop).toBeGreaterThan(0);

		for (const replacement of [thinking, tool, answer]) {
			addGroup(replacement);
			expect(turn.foldBeforeLast({ defaultExpanded: false, heightCompensationWidth: width })).toBe(true);
			expect(renderViewport()).toBe(baselineHeight);
			expect(viewport.scrollTop).toBe(baselineScrollTop);
		}
	});

	test("clears compensated rows when folded activity is expanded", () => {
		const width = 100;
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
		);
		first.addTool("tool-1", toolComponent("one\ntwo\nthree\nfour", { id: "tool-1" }));
		const replacement = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "text", text: "Replacement output." }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(replacement);
		turn.foldBeforeLast({ defaultExpanded: false, heightCompensationWidth: width });
		expect(replacement.render(width).findIndex((line) => line !== "")).toBeGreaterThan(0);

		turn.setExpanded(true);

		expect(replacement.render(width)[0]).not.toBe("");
	});

	test("keeps mouse coordinates aligned below compensated rows", () => {
		const width = 100;
		const group = assistantGroup("assistant-1", assistantMessage([{ type: "text", text: "Replacement output." }]));
		const tool = toolComponent("clickable output", { id: "tool-1" });
		const handleMouse = vi.fn(() => ({ handled: true }));
		Object.assign(tool, { handleMouse });
		group.addTool("tool-1", tool);
		const assistantHeight = group.assistant.render(width).length;
		group.setHeightCompensation(3, width);
		const lines = group.render(width);

		expect(group.handleMouse(clickEvent(1, width, lines.length))).toBeUndefined();
		expect(handleMouse).not.toHaveBeenCalled();
		expect(group.handleMouse(clickEvent(3 + assistantHeight, width, lines.length))).toMatchObject({
			handled: true,
		});
		expect(handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 0, height: 1 }));
	});

	test("keeps the remaining blank-row budget across width reflow", () => {
		const group = assistantGroup(
			"assistant-1",
			assistantMessage([
				{
					type: "text",
					text: "Replacement output that wraps onto several rows when the transcript narrows.",
				},
			]),
		);
		group.setHeightCompensation(5, 100);

		expect(group.render(100).findIndex((line) => line !== "")).toBe(5);
		group.addTool("tool-1", toolComponent("new output one\nnew output two", { id: "tool-1" }));
		expect(group.render(20).findIndex((line) => line !== "")).toBe(3);
		expect(group.getHeightCompensation()).toEqual({ rows: 3, width: 20 });
	});

	test("restores compensation to the group that originally owned it", () => {
		const width = 100;
		const first = assistantGroup("assistant-1", assistantMessage([{ type: "text", text: "First." }]));
		const second = assistantGroup("assistant-2", assistantMessage([{ type: "text", text: "Second." }]));
		const third = assistantGroup("assistant-3", assistantMessage([{ type: "text", text: "Third." }]));
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.addGroup(third);
		second.setHeightCompensation(4, width);
		const compensation = turn.getHeightCompensation();
		expect(compensation).toEqual({ rows: 4, width, groupOffsetFromEnd: 1 });

		turn.clearHeightCompensation();
		turn.restoreHeightCompensation(compensation!);

		expect(second.render(width).findIndex((line) => line !== "")).toBe(4);
		expect(third.render(width)[0]).not.toBe("");
	});

	test("transfers remaining blank rows without a new measurement and clears them at completion", () => {
		const width = 100;
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
		);
		first.addTool(
			"tool-1",
			toolComponent(Array.from({ length: 8 }, (_, index) => `old output ${index + 1}`).join("\n"), {
				id: "tool-1",
			}),
		);
		const second = assistantGroup("assistant-2", assistantMessage([{ type: "text", text: "First replacement." }]));
		const third = assistantGroup("assistant-3", assistantMessage([{ type: "text", text: "Second replacement." }]));
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.foldBeforeLast({ defaultExpanded: false, heightCompensationWidth: width });
		const carriedRows = second.render(width).findIndex((line) => line !== "");
		turn.addGroup(third);
		const heightBeforeSecondFold =
			first.render(width).length + second.render(width).length + third.render(width).length;

		expect(turn.foldBeforeLast({ defaultExpanded: false })).toBe(true);
		expect(first.render(width).length + second.render(width).length + third.render(width).length).toBe(
			heightBeforeSecondFold,
		);
		expect(second.render(width)[0]).not.toBe("");
		expect(third.render(width).findIndex((line) => line !== "")).toBe(carriedRows);

		turn.complete({ defaultExpanded: false });
		expect(third.render(width)[0]).not.toBe("");
	});

	test("replays only folds that preceded a deferred final replacement", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
		);
		first.addTool("tool-1", toolComponent("first hidden output", { id: "tool-1" }));
		const second = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "toolCall", id: "tool-2", name: "read", arguments: {} }]),
		);
		second.addTool("tool-2", toolComponent("pending fold output", { id: "tool-2" }));
		const deferred = assistantGroup(
			"assistant-3",
			assistantMessage([{ type: "toolCall", id: "tool-3", name: "read", arguments: {} }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.addGroup(deferred);

		expect(turn.foldBeforeDeferredLast({ defaultExpanded: false })).toBe(true);

		expect(stripAnsi(first.render(100).join("\n"))).toContain("[+] 1 tool call");
		expect(stripAnsi(first.render(100).join("\n"))).not.toContain("first hidden output");
		expect(stripAnsi(second.render(100).join("\n"))).toContain("pending fold output");
	});

	test("shows the first hidden assistant message timestamp before the fold marker", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "first reasoning" }], "stop", foldTimestamp),
		);
		const second = assistantGroup(
			"assistant-2",
			assistantMessage(
				[{ type: "thinking", thinking: "continued reasoning" }],
				"stop",
				new Date(2026, 0, 1, 13, 6).getTime(),
			),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.complete({ defaultExpanded: false });

		expect(stripAnsi(first.render(100).join("\n"))).toMatch(/(?<!\d)1:05 {2}\[\+\] 2 thinking blocks/);

		turn.setExpanded(true);
		expect(stripAnsi(first.render(100).join("\n"))).toMatch(/(?<!\d)1:05 {2}\[-\] 2 thinking blocks/);
	});

	test.each([
		["midnight", 0],
		["noon", 12],
	])("formats %s with hour 12", (_label, hour) => {
		const group = assistantGroup(
			"assistant-1",
			assistantMessage(
				[{ type: "thinking", thinking: "reasoning" }],
				"stop",
				new Date(2026, 0, 1, hour, 7).getTime(),
			),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(group);
		turn.complete({ defaultExpanded: false });

		expect(stripAnsi(group.render(100).join("\n"))).toContain("12:07  [+] 1 thinking block");
	});

	test("omits the timestamp prefix when a replayed assistant message has no timestamp", () => {
		const message = assistantMessage([{ type: "thinking", thinking: "legacy reasoning" }]);
		delete (message as { timestamp?: number }).timestamp;
		const group = assistantGroup("assistant-1", message);
		const turn = new AssistantTurn(1);
		turn.addGroup(group);
		turn.complete({ defaultExpanded: false });

		const rendered = stripAnsi(group.render(80).join("\n"));
		expect(rendered).toContain("[+] 1 thinking block");
		expect(rendered).not.toMatch(/\d{1,2}:\d{2} {2}\[\+\]/);
		expect(rendered).not.toContain("NaN");
	});

	test("keeps the first assistant timestamp when a provisional region becomes final", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "first reasoning" }], "stop", foldTimestamp),
		);
		const latest = assistantGroup(
			"assistant-2",
			assistantMessage(
				[{ type: "thinking", thinking: "latest reasoning" }],
				"stop",
				new Date(2026, 0, 1, 13, 6).getTime(),
			),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(latest);

		turn.foldBeforeLast({ defaultExpanded: false });
		expect(stripAnsi(first.render(100).join("\n"))).toContain("1:05  [+] 1 thinking block");

		turn.complete({ defaultExpanded: false });
		const rendered = stripAnsi(first.render(100).join("\n"));
		expect(rendered).toContain("1:05  [+] 2 thinking blocks");
		expect(rendered).not.toContain("1:06  [+]");
	});

	test("folds completed prefix regions while the latest assistant message remains live", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage(
				[
					{ type: "thinking", thinking: "first reasoning" },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
				],
				"toolUse",
			),
		);
		first.addTool("tool-1", toolComponent("first tool output", { id: "tool-1" }));
		const latest = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "thinking", thinking: "latest reasoning" }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(latest);

		expect(turn.foldBeforeLast({ defaultExpanded: false })).toBe(true);

		const active = stripAnsi([...first.render(100), ...latest.render(100)].join("\n"));
		expect(active).toContain("[+] 1 tool call, 1 thinking block");
		expect(active).not.toContain("incomplete");
		expect(active).not.toContain("first reasoning");
		expect(active).not.toContain("first tool output");
		expect(active).toContain("latest reasoning");

		turn.complete({ defaultExpanded: false });

		const settled = stripAnsi([...first.render(100), ...latest.render(100)].join("\n"));
		expect(settled).toContain("[+] 1 tool call, 2 thinking blocks");
		expect(settled).not.toContain("latest reasoning");
	});

	test("keeps truncation visible through later provisional folds and final settlement", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "truncated reasoning" }], "length"),
		);
		const second = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "thinking", thinking: "continued reasoning" }]),
		);
		const latest = assistantGroup(
			"assistant-3",
			assistantMessage([{ type: "thinking", thinking: "latest reasoning" }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.foldBeforeLast({ defaultExpanded: false });
		expect(stripAnsi(first.render(100).join("\n"))).toContain("[+] 1 thinking block, incomplete");

		turn.addGroup(latest);
		turn.foldBeforeLast({ defaultExpanded: false });
		expect(stripAnsi(first.render(100).join("\n"))).toContain("[+] 1 thinking block, incomplete");

		turn.complete({ defaultExpanded: false });
		expect(stripAnsi(first.render(100).join("\n"))).toContain("[+] 1 thinking block, incomplete");
	});

	test("preserves provisional expansion when the final region merges with the latest message", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "first reasoning" }]),
		);
		const latest = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "thinking", thinking: "latest reasoning" }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(latest);
		turn.foldBeforeLast({ defaultExpanded: false });
		const prefixLines = first.render(100);
		const summaryRow = prefixLines.findIndex((line) => stripAnsi(line).includes("[+] 1 thinking block"));
		first.handleMouse(clickEvent(summaryRow, 100, prefixLines.length));

		turn.complete({ defaultExpanded: false });

		const settled = stripAnsi([...first.render(100), ...latest.render(100)].join("\n"));
		expect(settled).toContain("[-] 2 thinking blocks");
		expect(settled).toContain("first reasoning");
		expect(settled).toContain("latest reasoning");
	});

	test("preserves provisional expansion before assistant entry IDs are assigned", () => {
		const first = assistantGroup(undefined, assistantMessage([{ type: "thinking", thinking: "first reasoning" }]));
		const latest = assistantGroup(undefined, assistantMessage([{ type: "thinking", thinking: "latest reasoning" }]));
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(latest);
		turn.foldBeforeLast({ defaultExpanded: false });
		turn.setExpanded(true);

		turn.complete({ defaultExpanded: false });

		const settled = stripAnsi([...first.render(100), ...latest.render(100)].join("\n"));
		expect(settled).toContain("[-] 2 thinking blocks");
		expect(settled).toContain("first reasoning");
		expect(settled).toContain("latest reasoning");
	});

	test("applies global expansion changes to provisional regions", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "first reasoning" }]),
		);
		const latest = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "thinking", thinking: "latest reasoning" }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(latest);
		turn.foldBeforeLast({ defaultExpanded: false });

		turn.setExpanded(true);

		const active = stripAnsi([...first.render(100), ...latest.render(100)].join("\n"));
		expect(active).toContain("[-] 1 thinking block");
		expect(active).toContain("first reasoning");
		expect(active).toContain("latest reasoning");
	});

	test("reconciles a visible component inserted after assistant groups were mounted", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "first reasoning" }]),
		);
		const second = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "thinking", thinking: "second reasoning" }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.reconcileBoundaries([first, new Text("visible notice", 0, 0), second]);
		turn.complete({ defaultExpanded: false });

		expect(stripAnsi(first.render(80).join("\n"))).toContain("[+] 1 thinking block");
		expect(stripAnsi(second.render(80).join("\n"))).toContain("[+] 1 thinking block");
	});

	test("expands only the clicked region and keeps its summary above the restored activity", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([
				{ type: "text", text: "Before activity." },
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
			]),
		);
		first.addTool("tool-1", toolComponent("first tool output", { id: "tool-1" }));
		const second = assistantGroup(
			"assistant-2",
			assistantMessage([
				{ type: "text", text: "Between regions." },
				{ type: "thinking", thinking: "second reasoning" },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: {} },
			]),
		);
		second.addTool("tool-2", toolComponent("second tool output", { id: "tool-2" }));
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.complete({ defaultExpanded: false });

		const lines = first.render(100);
		const summaryRow = lines.findIndex((line) => stripAnsi(line).includes("[+] 1 tool call, 1 thinking block"));
		expect(first.handleMouse(clickEvent(summaryRow, 100, lines.length))).toMatchObject({
			handled: true,
			preserveViewport: true,
		});

		const expandedFirst = stripAnsi(first.render(100).join("\n"));
		const foldedSecond = stripAnsi(second.render(100).join("\n"));
		expect(expandedFirst.indexOf("Before activity.")).toBeLessThan(expandedFirst.indexOf("[-] 1 tool call"));
		expect(expandedFirst.indexOf("[-] 1 tool call")).toBeLessThan(expandedFirst.indexOf("first reasoning"));
		expect(expandedFirst).toContain("first tool output");
		expect(foldedSecond).toContain("[+] 1 tool call, 1 thinking block");
		expect(foldedSecond).not.toContain("second reasoning");
		expect(foldedSecond).not.toContain("second tool output");
	});

	test("preserves nested thinking and tool expansion state across region folding", () => {
		const message = assistantMessage([
			{ type: "thinking", thinking: "reasoning" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
		]);
		const group = assistantGroup("assistant-1", message);
		group.assistant.restoreThinkingVisibilityOverrides(new Map([[0, true]]));
		const tool = toolComponent("tool output", { id: "tool-1" });
		const setToolExpanded = vi.fn();
		tool.setExpanded = setToolExpanded;
		group.addTool("tool-1", tool);
		const turn = new AssistantTurn(1);
		turn.addGroup(group);
		turn.complete({ defaultExpanded: false });
		turn.setExpanded(true);

		const expanded = stripAnsi(group.render(80).join("\n"));
		expect(expanded).toContain("Thinking...");
		expect(expanded).not.toContain("reasoning");
		expect(setToolExpanded).not.toHaveBeenCalled();
	});

	test("restores expansion independently for each region", () => {
		const group = assistantGroup(
			"assistant-1",
			assistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "visible separator" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(group);

		turn.complete({
			defaultExpanded: false,
			restoredExpansion: new Map([
				["assistant-1:thinking:0", false],
				["assistant-1:thinking:2", true],
			]),
		});

		const rendered = stripAnsi(group.render(80).join("\n"));
		expect(rendered).toContain("[+] 1 thinking block");
		expect(rendered).toContain("[-] 1 thinking block");
		expect(rendered).not.toContain("first reasoning");
		expect(rendered).toContain("second reasoning");
	});

	test("uses stable tool-call state keys across live and replay group keys", () => {
		const message = assistantMessage([
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
		]);
		const group = assistantGroup("assistant-1", message);
		group.addTool("1:tool-1", toolComponent("tool output", { id: "tool-1" }));
		const turn = new AssistantTurn(1);
		turn.addGroup(group);

		turn.complete({
			defaultExpanded: false,
			restoredExpansion: new Map([["assistant-1:1:tool-1", true]]),
		});

		expect(turn.getRegionExpansionStates()).toEqual([{ stateKeys: ["assistant-1:1:tool-1"], expanded: true }]);
		expect(stripAnsi(group.render(80).join("\n"))).toContain("tool output");
	});

	test("anchors and toggles a missing-tool region independently", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([
				{ type: "text", text: "before missing tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
			]),
		);
		const second = assistantGroup(
			"assistant-2",
			assistantMessage([
				{ type: "text", text: "after missing tool" },
				{ type: "thinking", thinking: "second region reasoning" },
			]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(second);
		turn.complete({
			defaultExpanded: false,
			restoredExpansion: new Map([
				["assistant-1:1:tool-1", false],
				["assistant-2:thinking:1", false],
			]),
		});

		const folded = stripAnsi([...first.render(100), ...second.render(100)].join("\n"));
		expect(folded.indexOf("before missing tool")).toBeLessThan(folded.indexOf("[+] 1 tool call, incomplete"));
		expect(folded.indexOf("[+] 1 tool call, incomplete")).toBeLessThan(folded.indexOf("after missing tool"));
		const firstLines = first.render(100);
		const summaryRow = firstLines.findIndex((line) => stripAnsi(line).includes("[+] 1 tool call, incomplete"));
		first.handleMouse(clickEvent(summaryRow, 100, firstLines.length));

		expect(stripAnsi(first.render(100).join("\n"))).toContain("[-] 1 tool call, incomplete");
		expect(stripAnsi(second.render(100).join("\n"))).toContain("[+] 1 thinking block");
	});

	test("collapses failed, unfinished, and truncated turns by default", () => {
		const cases: Array<{ message: AssistantMessage; tool?: ToolExecutionComponent; summary: string }> = [
			{
				message: assistantMessage([{ type: "thinking", thinking: "aborted reasoning" }], "aborted"),
				summary: "[+] 1 thinking block, error",
			},
			{
				message: assistantMessage(
					[
						{ type: "thinking", thinking: "tool reasoning" },
						{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
					],
					"toolUse",
				),
				tool: toolComponent("successful output", { id: "tool-1" }),
				summary: "[+] 1 tool call, 1 thinking block, incomplete",
			},
			{
				message: assistantMessage(
					[
						{ type: "thinking", thinking: "truncated reasoning" },
						{ type: "text", text: "partial answer" },
					],
					"length",
				),
				summary: "[+] 1 thinking block, incomplete",
			},
		];
		for (const { message, tool, summary } of cases) {
			const group = assistantGroup("assistant-1", message);
			if (tool) group.addTool("tool-1", tool);
			const turn = new AssistantTurn(1);
			turn.addGroup(group);
			turn.complete({ defaultExpanded: false });

			const lines = group.render(80);
			const rendered = stripAnsi(lines.join("\n"));
			expect(rendered).toContain(summary);
			const fullSummary = `1:05  ${summary}`;
			expect(lines.join("\n")).toContain(theme.fg("muted", fullSummary));
			expect(lines.join("\n")).not.toContain(theme.fg("warning", fullSummary));
		}
	});

	test("collapses a completed turn with a failed tool result", () => {
		const summary = "[+] 1 tool call, error";
		const message = assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]);
		const group = assistantGroup("assistant-1", message);
		group.addTool("tool-1", toolComponent("failed output", { id: "tool-1", error: true }));
		const turn = new AssistantTurn(1);
		turn.addGroup(group);
		turn.complete({ defaultExpanded: false });

		const lines = group.render(80);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain(summary);
		expect(rendered).not.toContain("failed output");
		const fullSummary = `1:05  ${summary}`;
		expect(lines.join("\n")).toContain(theme.fg("muted", fullSummary));
		expect(lines.join("\n")).not.toContain(theme.fg("warning", fullSummary));
	});

	test("honors the explicit expansion default for failed turns", () => {
		const group = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "failed reasoning" }], "error"),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(group);
		turn.complete({ defaultExpanded: true });

		const rendered = stripAnsi(group.render(80).join("\n"));
		expect(rendered).toContain("[-] 1 thinking block, error");
		expect(rendered).toContain("failed reasoning");
	});

	test("collapses earlier activity when an empty or text-only continuation fails", () => {
		const cases: Array<{
			stopReason: "error" | "aborted";
			content: AssistantMessage["content"];
		}> = [
			{ stopReason: "error", content: [] },
			{ stopReason: "aborted", content: [{ type: "text", text: "partial failure context" }] },
		];
		for (const { stopReason, content } of cases) {
			const first = assistantGroup(
				"assistant-1",
				assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
			);
			first.addTool("tool-1", toolComponent("successful output", { id: "tool-1" }));
			const failedContinuation = assistantGroup("assistant-2", assistantMessage(content, stopReason));
			const turn = new AssistantTurn(1);
			turn.addGroup(first);
			turn.addGroup(failedContinuation);
			turn.complete({ defaultExpanded: false });

			expect(stripAnsi(first.render(80).join("\n"))).toContain("[+] 1 tool call");
			expect(stripAnsi(first.render(80).join("\n"))).not.toContain("successful output");
		}
	});

	test("preserves an explicitly restored collapse for a failed region", () => {
		const group = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "thinking", thinking: "failed reasoning" }], "error"),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(group);
		turn.complete({
			defaultExpanded: false,
			restoredExpansion: new Map([["assistant-1:thinking:0", false]]),
		});

		const rendered = stripAnsi(group.render(80).join("\n"));
		expect(rendered).toContain("[+] 1 thinking block, error");
		expect(rendered).not.toContain("failed reasoning");
	});

	test("redirects an empty continuation anchor to its collapsed region summary", () => {
		const first = assistantGroup(
			"assistant-1",
			assistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
		);
		first.addTool("tool-1", toolComponent("first output", { id: "tool-1" }));
		const continuation = assistantGroup(
			"assistant-2",
			assistantMessage([{ type: "thinking", thinking: "continued reasoning" }]),
		);
		const visibleContinuation = assistantGroup(
			"assistant-3",
			assistantMessage([{ type: "text", text: "visible continuation" }]),
		);
		const turn = new AssistantTurn(1);
		turn.addGroup(first);
		turn.addGroup(continuation);
		turn.addGroup(visibleContinuation);
		turn.complete({ defaultExpanded: false });

		expect(turn.getFoldedEntryRedirect("assistant-1")).toBeUndefined();
		expect(turn.getFoldedEntryRedirect("assistant-2")).toBe("assistant-1");
		expect(turn.getFoldedEntryRedirect("assistant-3")).toBeUndefined();
		turn.setExpanded(true);
		expect(turn.getFoldedEntryRedirect("assistant-2")).toBeUndefined();
	});

	test("does not add a fold marker when the turn has no tools or thinking", () => {
		const group = assistantGroup("assistant-1", assistantMessage([{ type: "text", text: "plain answer" }]));
		const turn = new AssistantTurn(1);
		turn.addGroup(group);

		expect(turn.complete({ defaultExpanded: false })).toBe(false);
		expect(stripAnsi(group.render(80).join("\n"))).toContain("plain answer");
	});
});
