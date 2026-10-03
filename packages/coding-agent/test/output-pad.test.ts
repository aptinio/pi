import { type Component, TuiMainScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { TranscriptEntryComponent } from "../src/modes/interactive/components/transcript-entry.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = new TuiMainScreen(new VirtualTerminal(80, 24));

const tool: ToolDefinition = {
	name: "custom_tool",
	label: "custom_tool",
	description: "custom tool",
	parameters: Type.Any(),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

type OutputPaddedComponent = Component & { setOutputPad(outputPad: number): void };

/** Text lines without ANSI codes or trailing fill. Blank lines and full-width borders are skipped. */
function renderLines(component: Component): string[] {
	return component
		.render(60)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => /[\w$(]/.test(line));
}

function createTool(definition: ToolDefinition | undefined, outputPad: number): ToolExecutionComponent {
	const component = new ToolExecutionComponent("custom_tool", "id", {}, { outputPad }, definition, ui, "/");
	component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	return component;
}

const components: Array<{ name: string; create: (outputPad: number) => OutputPaddedComponent }> = [
	{
		name: "bash execution",
		create: (outputPad) => {
			const component = new BashExecutionComponent("pwd", ui, false, outputPad);
			component.appendOutput("/tmp");
			component.setComplete(1, false);
			return component;
		},
	},
	{ name: "tool execution", create: (outputPad) => createTool(tool, outputPad) },
	{ name: "tool execution without a definition", create: (outputPad) => createTool(undefined, outputPad) },
	{
		name: "self-rendered edit result",
		create: (outputPad) => {
			const component = new ToolExecutionComponent(
				"edit",
				"id",
				{ path: "file.txt", edits: [{ oldText: "old", newText: "new" }] },
				{ outputPad },
				createEditToolDefinition("/"),
				ui,
				"/",
			);
			component.updateResult({ content: [{ type: "text", text: "Could not find old text" }], isError: true });
			return component;
		},
	},
	{
		name: "compaction summary",
		create: (outputPad) =>
			new CompactionSummaryMessageComponent(
				{ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: 0 },
				undefined,
				outputPad,
			),
	},
];

describe("outputPad", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		ui.stop();
	});

	test.each(components)("$name renders at outputPad 0 and 1", ({ create }) => {
		const component = create(0);
		const lines = renderLines(component);
		expect(lines.filter((line) => line.startsWith(" "))).toEqual([]);
		component.setOutputPad(1);
		expect(renderLines(component)).toEqual(lines.map((line) => ` ${line}`));
	});

	test.each([false, true])("updates a deferred bash block when outputPad changes (complete: %s)", (complete) => {
		const component = new BashExecutionComponent("pwd", ui, false, 0);
		component.appendOutput("/tmp");
		if (complete) component.setComplete(0, false);
		const lines = renderLines(component).filter((line) => line.includes("$ pwd") || line.includes("/tmp"));
		const context = {
			settingsManager: { setOutputPad: vi.fn() },
			outputPad: 0,
			pendingBashComponents: [new TranscriptEntryComponent(undefined, [component])],
			rebuildTranscript: vi.fn(),
		};
		const { setOutputPad } = InteractiveMode.prototype as unknown as {
			setOutputPad(this: typeof context, padding: 0 | 1): void;
		};
		try {
			setOutputPad.call(context, 1);
			expect(context.settingsManager.setOutputPad).toHaveBeenCalledWith(1);
			expect(context.outputPad).toBe(1);
			expect(context.rebuildTranscript).toHaveBeenCalledOnce();
			expect(renderLines(component).filter((line) => line.includes("$ pwd") || line.includes("/tmp"))).toEqual(
				lines.map((line) => ` ${line}`),
			);
		} finally {
			component.setComplete(0, false);
		}
	});
});
