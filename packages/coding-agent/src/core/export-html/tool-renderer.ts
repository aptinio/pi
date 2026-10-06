/**
 * Tool HTML renderer for custom tools in HTML export.
 *
 * Renders custom tool calls and results to HTML by invoking their TUI renderers
 * and converting the ANSI output to HTML.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../extensions/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Renderers of calls to a tool, as resolved by extensions and the registered tool */
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	/** Theme for styling */
	theme: Theme;
	/** Working directory for render context */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	width?: number;
}

export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { callHtml?: string; collapsed?: string; expanded?: string } | undefined;
}

/**
 * Create a tool HTML renderer.
 *
 * The renderer looks up tool definitions and invokes their renderCall/renderResult
 * methods, converting the resulting TUI Component output (ANSI) to HTML.
 */
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolRenderers, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
			durationMs: undefined,
			outputPad: 1,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { callHtml?: string; collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolRenderers(toolName);
				const renderResult = toolDef?.renderResult;
				if (!toolDef || !renderResult) {
					return undefined;
				}

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				const renderView = (expanded: boolean): string => {
					let call: Component | undefined;
					if (toolDef.renderShell === "self" && toolDef.renderCall) {
						call = toolDef.renderCall(
							renderedArgs.get(toolCallId),
							theme,
							createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), expanded, false, isError),
						);
						renderedCallComponents.set(toolCallId, call);
					}
					const component = renderResult(
						agentToolResult,
						{ expanded, isPartial: false },
						theme,
						createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), expanded, false, isError),
					);
					renderedResultComponents.set(toolCallId, component);
					// Self-framed renderers may place the result in their call slot, as the TUI does.
					const lines = call ? [...call.render(width), ...component.render(width)] : component.render(width);
					return ansiLinesToHtml(trimRenderedResultLines(lines));
				};
				const collapsed = renderView(false);
				const expanded = renderView(true);

				return {
					// The composed result owns the call row; discard the stale pre-result header.
					...(toolDef.renderShell === "self" ? { callHtml: "" } : {}),
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},
	};
}
