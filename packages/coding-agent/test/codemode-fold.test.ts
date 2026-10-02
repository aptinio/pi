import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resetCapabilitiesCache,
	setCapabilities,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

describe("codemode activity folding", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => resetCapabilitiesCache());

	test("starts with a timestamped single line and reveals a running script on click", () => {
		const component = createToolComponent();
		component.markExecutionStarted();
		expect(visibleLines(component)).toEqual(["1:05  [+] codemode, running"]);
		clickSummary(component);
		expect(component.getExpansionState()).toBe("expanded");
		expect(stripAnsi(component.render(120).join("\n"))).toContain('text("script-14");');
	});

	test("keeps partial and final calls/output hidden, then expands without losing content", () => {
		const component = createToolComponent();
		component.markExecutionStarted();
		component.updateResult(result, true);
		expect(visibleLines(component)).toEqual(["1:05  [+] codemode, running"]);
		component.updateResult(result);
		expect(visibleLines(component)).toEqual(["1:05  [+] codemode"]);

		clickSummary(component);
		const expanded = stripAnsi(component.render(2000).join("\n"));
		expect(expanded).toContain('text("script-14");');
		expect(expanded).toContain("nested-0");
		expect(expanded).toContain("nested-11");
		expect(expanded).toContain("x".repeat(120));
		expect(expanded).toContain("output".repeat(200));
		component.setExpanded(false);
		expect(visibleLines(component)).toEqual(["1:05  [+] codemode"]);
		component.setExpanded(true);
		expect(stripAnsi(component.render(2000).join("\n"))).toContain("output".repeat(200));
	});

	test("shows failure on the summary and reveals the complete error on expansion", () => {
		const component = createToolComponent();
		component.updateResult({ content: [{ type: "text", text: "Script error: deliberate failure" }], isError: true });
		expect(visibleLines(component)).toEqual(["1:05  [+] codemode, error"]);
		clickSummary(component);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Script error: deliberate failure");
	});

	test("hides native images until expansion", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = createToolComponent();
		component.updateResult({
			content: [{ type: "image", data: "fold-image", mimeType: "image/png" }],
			isError: false,
		});
		expect(visibleLines(component)).toEqual(["1:05  [+] codemode"]);
		component.setExpanded(true);
		expect(component.render(120).join("\n")).toContain("fold-image");
	});

	test("retains the message timestamp and expansion state when reconstructed", () => {
		const component = createToolComponent();
		component.updateResult(result);
		const restored = createToolComponent();
		restored.restoreSnapshot(component.getSnapshot());
		expect(visibleLines(restored)).toEqual(["1:05  [+] codemode"]);
		component.setExpanded(true);
		restored.restoreSnapshot(component.getSnapshot());
		expect(restored.getExpansionState()).toBe("expanded");
		expect(stripAnsi(restored.render(120).join("\n"))).toContain("nested-11");
	});

	test("expands a running summary through the fullscreen mouse dispatch pipeline", async () => {
		const logDirectory = mkdtempSync(join(tmpdir(), "pi-codemode-fold-"));
		const terminal = new VirtualTerminal(120, 30);
		const ui = createInteractiveTui({ tuiMode: "fullscreen", showHardwareCursor: false, logDirectory, terminal });
		const component = createToolComponent(ui);
		component.markExecutionStarted();
		ui.addChild(component);
		ui.start();
		try {
			await terminal.waitForRender();
			const y = terminal.getViewport().findIndex((line) => line.includes("1:05  [+] codemode, running"));
			expect(y).toBeGreaterThanOrEqual(0);
			terminal.sendInput(`\x1b[<0;2;${y + 1}M`);
			terminal.sendInput(`\x1b[<0;2;${y + 1}m`);
			await terminal.waitForRender();
			expect(component.getExpansionState()).toBe("expanded");
			expect(terminal.getViewport().join("\n")).toContain('text("script-14");');
		} finally {
			ui.stop();
			rmSync(logDirectory, { recursive: true, force: true });
		}
	});

	test("keeps the summary to one visual line at narrow widths", () => {
		const component = createToolComponent();
		component.markExecutionStarted();
		for (const width of [10, 20, 40]) {
			const lines = component.render(width);
			expect(lines.filter((line) => stripAnsi(line).trim())).toHaveLength(1);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

function createToolComponent(ui: TUI = { requestRender: () => {} } as unknown as TUI): ToolExecutionComponent {
	const create = Reflect.get(InteractiveMode.prototype, "createToolComponent") as (
		this: unknown,
		name: string,
		id: string,
		args: unknown,
		timestamp: number,
	) => ToolExecutionComponent;
	return create.call(
		{
			settingsManager: { getShowImages: () => true, getImageWidthCells: () => 60 },
			getRegisteredToolDefinition: () => codemodeRenderers,
			ui,
			sessionManager: { getCwd: () => "/" },
		},
		"codemode",
		"call",
		{ code },
		timestamp,
	);
}

function visibleLines(component: ToolExecutionComponent): string[] {
	return component
		.render(120)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => line.trim());
}

function clickSummary(component: ToolExecutionComponent): void {
	const lines = component.render(120);
	const y = lines.findIndex((line) => stripAnsi(line).includes("codemode"));
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
	expect(component.handleMouse(event)).toMatchObject({
		handled: true,
		preserveViewport: true,
		target: { component },
	});
}
