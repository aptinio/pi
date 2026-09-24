import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

// Each visible answer segment is one selectable range. The parent appends C to the last range that renders.
class SemanticPromptSegment extends Container {
	constructor(content: Component) {
		super();
		this.addChild(content);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		if (lines.length === 1) {
			lines[0] = OSC133_ZONE_START + OSC133_ZONE_END + lines[0];
		} else {
			lines[0] = OSC133_ZONE_START + lines[0];
			lines[lines.length - 1] = OSC133_ZONE_END + lines[lines.length - 1];
		}
		return lines;
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	getThinkingVisibilityOverrides(): ReadonlyMap<number, boolean> {
		return new Map(this.thinkingVisibilityOverrides);
	}

	restoreThinkingVisibilityOverrides(overrides: ReadonlyMap<number, boolean>): void {
		this.thinkingVisibilityOverrides = new Map(overrides);
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	override render(width: number): string[] {
		const lines = super.render(width);

		// Thinking and empty transformed segments have no markers, so finalize the last rendered answer range.
		for (let index = lines.length - 1; index >= 0; index--) {
			const prefix = OSC133_ZONE_PREFIX.exec(lines[index] ?? "")?.[0];
			if (!prefix?.includes(OSC133_ZONE_END)) continue;
			lines[index] = prefix + OSC133_ZONE_FINAL + lines[index]!.slice(prefix.length);
			break;
		}
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		const addAssistantContent = (content: Component) => {
			this.contentContainer.addChild(new SemanticPromptSegment(content));
		};

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				addAssistantContent(
					new Markdown(formatTextWithCitations(content), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const firstThinkingContentIndex = i;
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const hidden = this.thinkingVisibilityOverrides.get(firstThinkingContentIndex) ?? this.hideThinkingBlock;
				const thinkingComponent = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						);
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(firstThinkingContentIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true, preserveViewport: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			addAssistantContent(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				addAssistantContent(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				addAssistantContent(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}

function formatTextWithCitations(content: TextContent): string {
	const text = content.text.trim();
	if (!content.annotations?.length) return text;

	const sources: string[] = [];
	const seen = new Set<string>();
	for (const citation of content.annotations) {
		if (citation.type !== "url_citation") continue;
		const key = `${citation.url}\n${citation.title}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const label = escapeMarkdownText(citation.title.trim() || citation.url);
		let rendered = label;
		try {
			const url = new URL(citation.url.trim());
			if (url.protocol === "http:" || url.protocol === "https:") {
				const href = url.href.replaceAll("(", "%28").replaceAll(")", "%29");
				rendered = `[${label}](${href})`;
			}
		} catch {
			// Keep malformed provider URLs as non-clickable titles.
		}
		sources.push(`${sources.length + 1}. ${rendered}`);
	}
	return sources.length > 0 ? `${text}\n\nSources:\n${sources.join("\n")}` : text;
}

function escapeMarkdownText(text: string): string {
	return text.replace(/[\\`*_[\]{}()#+\-.!|>]/g, "\\$&").replace(/[\r\n\t]+/g, " ");
}
