import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	resetCapabilitiesCache,
	setCapabilities,
	stripTerminalSequences,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { AssistantTranscriptGroup } from "../src/modes/interactive/components/assistant-transcript-group.ts";
import { AssistantTurn } from "../src/modes/interactive/components/assistant-turn.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTui } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const timestamp = new Date(2026, 0, 1, 13, 5).getTime();
const code = Array.from({ length: 15 }, (_, index) => `text("script-${index}");`).join("\n");
const calls = Array.from({ length: 12 }, (_, index) => ({
	id: `call/${index}`,
	name: `nested-${index}`,
	args: "x".repeat(120),
	status: "ok" as const,
	durationMs: 5,
}));
const result = {
	content: [
		{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
		{ type: "text", text: "output".repeat(200) },
	],
	details: { calls },
	isError: false,
};
type Fold = { group: AssistantTranscriptGroup; turn: AssistantTurn; tool: ToolExecutionComponent };

describe("codemode shared activity folding", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => resetCapabilitiesCache());

	test("keeps the running tool's own expansion independent from its shared summary", () => {
		const fold = createFold();
		fold.tool.markExecutionStarted();
		refresh(fold);
		expect(visibleLines(fold)).toEqual([" 1:05  [+] 1 tool call, running"]);
		clickSummary(fold);
		expect(visibleLines(fold).filter((line) => line.includes("[-]"))).toEqual([" 1:05  [-] 1 tool call, running"]);
		expect(fold.tool.getExpansionState()).toBe("collapsed");
		expect(render(fold)).not.toContain('text("script-14");');
		clickTool(fold);
		expect(render(fold)).toContain('text("script-14");');
		expect(render(fold)).not.toContain("[+] codemode");
	});

	test.each([false, true])("allows a codemode row click before any result, execution started: %s", (running) => {
		const fold = createFold();
		if (running) fold.tool.markExecutionStarted();
		fold.turn.setExpanded(true);
		fold.tool.setExpanded(false);
		clickTool(fold);
		expect(fold.tool.getExpansionState()).toBe("expanded");
		expect(render(fold)).toContain('text("script-14");');
	});

	test("preserves the tool row's chosen expansion through refolding and reconstruction", () => {
		const fold = createFold();
		fold.tool.updateResult(result);
		refresh(fold);
		fold.turn.setExpanded(true);
		fold.tool.setExpanded(false);
		refresh(fold);
		expect(fold.tool.getExpansionState()).toBe("collapsed");
		clickTool(fold);
		fold.turn.setExpanded(false);
		refresh(fold);
		fold.turn.setExpanded(true);
		expect(fold.tool.getExpansionState()).toBe("expanded");
		const restored = createFold();
		restored.tool.restoreSnapshot(fold.tool.getSnapshot());
		refresh(restored);
		restored.turn.setExpanded(true);
		expect(restored.tool.getExpansionState()).toBe("expanded");
		expect(render(restored)).toContain('text("script-14");');
	});

	test("keeps partial and final calls/output hidden, then expands without losing content", () => {
		const fold = createFold();
		fold.tool.markExecutionStarted();
		fold.tool.updateResult(result, true);
		refresh(fold);
		expect(visibleLines(fold)).toEqual([" 1:05  [+] 1 tool call, running"]);
		fold.tool.updateResult(result);
		refresh(fold);
		expect(visibleLines(fold)).toEqual([" 1:05  [+] 1 tool call"]);
		clickSummary(fold);
		expect(fold.tool.getExpansionState()).toBe("collapsed");
		clickTool(fold);
		const expanded = render(fold, 2000);
		expect(expanded).toContain('text("script-14");');
		expect(expanded).toContain("nested-0");
		expect(expanded).toContain("nested-11");
		expect(expanded).toContain("x".repeat(120));
		expect(expanded).toContain("output".repeat(200));
		fold.turn.setExpanded(false);
		expect(visibleLines(fold)).toEqual([" 1:05  [+] 1 tool call"]);
		fold.turn.setExpanded(true);
		expect(render(fold, 2000)).toContain("output".repeat(200));
	});

	test("shows failure on the shared summary and reveals the complete error on expansion", () => {
		const fold = createFold();
		fold.tool.updateResult({ content: [{ type: "text", text: "Script error: deliberate failure" }], isError: true });
		refresh(fold);
		expect(visibleLines(fold)).toEqual([" 1:05  [+] 1 tool call, error"]);
		clickSummary(fold);
		expect(fold.tool.getExpansionState()).toBe("collapsed");
		clickTool(fold);
		expect(render(fold)).toContain("Script error: deliberate failure");
	});

	test("hides native images until both the shared region and the tool row expand", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const fold = createFold();
		fold.tool.updateResult({
			content: [{ type: "image", data: "fold-image", mimeType: "image/png" }],
			isError: false,
		});
		refresh(fold);
		expect(visibleLines(fold)).toEqual([" 1:05  [+] 1 tool call"]);
		fold.turn.setExpanded(true);
		expect(fold.group.render(120).join("\n")).not.toContain("fold-image");
		fold.tool.setExpanded(true);
		expect(fold.group.render(120).join("\n")).toContain("fold-image");
	});

	test("retains the message timestamp and shared expansion state when reconstructed", () => {
		const fold = createFold();
		fold.tool.updateResult(result);
		refresh(fold);
		const restored = createFold();
		restored.tool.restoreSnapshot(fold.tool.getSnapshot());
		refresh(restored);
		expect(visibleLines(restored)).toEqual([" 1:05  [+] 1 tool call"]);
		fold.turn.setExpanded(true);
		const restoredExpansion = new Map(
			fold.turn
				.getRegionExpansionStates()
				.flatMap((region) => region.stateKeys.map((key) => [key, region.expanded] as const)),
		);
		const expandedRestore = createFold(undefined, restoredExpansion);
		expandedRestore.tool.restoreSnapshot(fold.tool.getSnapshot());
		refresh(expandedRestore);
		expect(render(expandedRestore)).toContain(" 1:05  [-] 1 tool call");
		expect(expandedRestore.tool.getExpansionState()).toBe("collapsed");
		clickTool(expandedRestore);
		expect(render(expandedRestore)).toContain("nested-0");
		expect(render(expandedRestore)).toContain("nested-11");
	});

	test("expands a running shared summary through the fullscreen mouse dispatch pipeline", async () => {
		const logDirectory = mkdtempSync(join(tmpdir(), "pi-codemode-fold-"));
		const terminal = new VirtualTerminal(120, 30);
		const ui = createInteractiveTui({ tuiMode: "fullscreen", showHardwareCursor: false, logDirectory, terminal });
		const fold = createFold(ui);
		fold.tool.markExecutionStarted();
		refresh(fold);
		ui.addChild(fold.group);
		ui.start();
		try {
			await terminal.waitForRender();
			const y = terminal.getViewport().findIndex((line) => line.includes(" 1:05  [+] 1 tool call, running"));
			expect(y).toBeGreaterThanOrEqual(0);
			terminal.sendInput(`\x1b[<0;2;${y + 1}M`);
			terminal.sendInput(`\x1b[<0;2;${y + 1}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain(" 1:05  [-] 1 tool call, running");
			expect(terminal.getViewport().join("\n")).not.toContain('text("script-14");');
			const toolY = terminal.getViewport().findIndex((line) => line.includes("codemode"));
			expect(toolY).toBeGreaterThanOrEqual(0);
			terminal.sendInput(`\x1b[<0;2;${toolY + 1}M`);
			terminal.sendInput(`\x1b[<0;2;${toolY + 1}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain('text("script-14");');
		} finally {
			ui.stop();
			rmSync(logDirectory, { recursive: true, force: true });
		}
	});

	test("keeps the shared summary within narrow terminal widths", () => {
		const fold = createFold();
		fold.tool.markExecutionStarted();
		refresh(fold);
		for (const width of [10, 20, 40]) {
			const lines = fold.group.render(width);
			expect(lines.filter((line) => stripTerminalSequences(line).includes("[+]"))).toHaveLength(1);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

function createFold(
	ui: TUI = { requestRender: () => {} } as unknown as TUI,
	restoredExpansion?: ReadonlyMap<string, boolean>,
): Fold {
	const message = {
		...fauxAssistantMessage([{ ...fauxToolCall("codemode", { code }), id: "call" }], { stopReason: "toolUse" }),
		timestamp,
	};
	const group = new AssistantTranscriptGroup("assistant-1", message, new AssistantMessageComponent(message));
	const tool = new ToolExecutionComponent(
		"codemode",
		"call",
		{ code },
		{ showImages: true, imageWidthCells: 60 },
		codemodeRenderers,
		ui,
		"/",
	);
	group.addTool("call", tool);
	const turn = new AssistantTurn(1);
	turn.addGroup(group);
	turn.foldActiveTools({ defaultExpanded: false, restoredExpansion });
	return { group, tool, turn };
}

function refresh(fold: Fold): void {
	fold.turn.foldActiveTools({ defaultExpanded: false });
}

function render(fold: Fold, width = 120): string {
	return stripTerminalSequences(fold.group.render(width).join("\n"));
}

function visibleLines(fold: Fold): string[] {
	return render(fold)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim());
}

function clickTool(fold: Fold): void {
	clickLine(fold, "codemode");
}

function clickSummary(fold: Fold): void {
	clickLine(fold, "[+]");
}

function clickLine(fold: Fold, label: string): void {
	const lines = fold.group.render(120);
	const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
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
	expect(fold.group.handleMouse(event)?.handled).toBe(true);
}
