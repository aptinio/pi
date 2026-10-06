import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { ansiLinesToHtml } from "../src/core/export-html/ansi-to-html.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition, ToolRenderers } from "../src/core/extensions/types.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

describe("export HTML tool output whitespace", () => {
	it("preserves whitespace for plain-text tool output lines without preserving template whitespace", () => {
		const css = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

		expect(css).toMatch(
			/\.output-preview > div:not\(\.expand-hint\),\s*\.output-full > div:not\(\.expand-hint\) \{[\s\S]*?white-space:\s*pre-wrap;/,
		);
		expect(css).toMatch(/\.ansi-line\s*\{[\s\S]*?white-space:\s*pre;/);
		expect(css).not.toMatch(/\.output-preview,\s*\.output-full\s*\{[\s\S]*?white-space:\s*pre-wrap;/);
	});

	it("does not insert source whitespace between ANSI-rendered lines", () => {
		expect(ansiLinesToHtml(["one", "two"])).toBe('<div class="ansi-line">one</div><div class="ansi-line">two</div>');
	});

	it("exports self-framed tools whose result updates the call slot", () => {
		const tool: ToolRenderers = {
			renderShell: "self",
			renderCall(_args, _theme, context) {
				const row = new Container();
				row.addChild(new Text(context.expanded ? "complete script" : "compact script", 0, 0));
				context.state.row = row;
				return row;
			},
			renderResult(_result, options, _theme, context) {
				const row = context.state.row as Container;
				if (options.expanded) row.addChild(new Text("complete output", 0, 0));
				return new Container();
			},
		};
		const renderer = createToolHtmlRenderer({ getToolRenderers: () => tool, theme: {} as Theme, cwd: "/tmp" });
		renderer.renderCall("id", "custom", { code: "complete script" });
		const result = renderer.renderResult("id", "custom", [], undefined, false);
		expect(result?.callHtml).toBe("");
		expect(result?.collapsed).toContain("compact script");
		expect(result?.expanded).toContain("complete script");
		expect(result?.expanded).toContain("complete output");
	});

	it("trims TUI spacing lines from custom tool result HTML", () => {
		const component: Component = { render: () => ["", "\u001b[31mone\u001b[0m", "two", ""], invalidate: () => {} };
		const tool = {
			name: "custom",
			label: "custom",
			description: "custom",
			renderResult: () => component,
		} as unknown as ToolDefinition;
		const renderer = createToolHtmlRenderer({
			getToolRenderers: () => tool,
			theme: {} as Theme,
			cwd: "/tmp",
		});

		expect(renderer.renderResult("id", "custom", [], undefined, false)?.expanded).toBe(
			'<div class="ansi-line"><span style="color:#800000">one</span></div><div class="ansi-line">two</div>',
		);
	});
});
