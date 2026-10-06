import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantFoldAssignment } from "./assistant-fold-region.ts";
import type { AssistantMessageComponent } from "./assistant-message.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import { TranscriptEntryComponent } from "./transcript-entry.ts";

export type AssistantHeightCompensation = {
	rows: number;
	width: number;
};

/** Identity-only owner for one assistant message and its tool-call components. */
export class AssistantTranscriptGroup extends TranscriptEntryComponent {
	readonly assistant: AssistantMessageComponent;
	private message: AssistantMessage;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private toolFoldAssignments = new Map<string, AssistantFoldAssignment>();
	private trailingFoldSummary: Component | undefined;
	// Keep replacement content at its pre-fold row while its growth consumes the collapsed rows.
	private heightCompensation: { rows: number; width: number; baselineContentHeight: number } | undefined;
	private renderedCompensation: { width: number; rows: number } | undefined;

	constructor(entryId: string | undefined, message: AssistantMessage, assistant: AssistantMessageComponent) {
		super(entryId, [assistant]);
		this.message = message;
		this.assistant = assistant;
	}

	getMessage(): AssistantMessage {
		return this.message;
	}

	setMessage(message: AssistantMessage, streaming: boolean): void {
		this.message = message;
		this.assistant.updateContent(message, streaming);
	}

	addTool(key: string, component: ToolExecutionComponent): void {
		const previous = this.tools.get(key);
		if (previous === component) return;
		this.tools.set(key, component);
		this.rebuildChildren();
	}

	getToolEntries(): readonly (readonly [string, ToolExecutionComponent])[] {
		return [...this.tools.entries()];
	}

	getTools(): readonly ToolExecutionComponent[] {
		return [...this.tools.values()];
	}

	setFoldAssignments(
		thinking: ReadonlyMap<number, AssistantFoldAssignment>,
		tools: ReadonlyMap<string, AssistantFoldAssignment>,
		trailingSummary?: Component,
	): void {
		this.toolFoldAssignments = new Map(tools);
		this.trailingFoldSummary = trailingSummary;
		this.assistant.setThinkingFoldAssignments(thinking);
		this.rebuildChildren();
	}

	refreshFoldState(): void {
		this.assistant.refreshFoldState();
		this.rebuildChildren();
	}

	rendersWithFoldState(): boolean {
		if (this.assistant.rendersWithFoldState() || this.trailingFoldSummary) return true;
		for (const [key] of this.tools) {
			const assignment = this.toolFoldAssignments.get(key);
			if (assignment?.showSummary || !assignment || assignment.region.isExpanded()) return true;
		}
		return false;
	}

	setHeightCompensation(rows: number, width: number): void {
		const normalizedRows = Math.max(0, Math.floor(rows));
		const normalizedWidth = Math.max(0, Math.floor(width));
		if (normalizedRows === 0 || normalizedWidth === 0) {
			this.clearHeightCompensation();
			return;
		}
		this.heightCompensation = {
			rows: normalizedRows,
			width: normalizedWidth,
			baselineContentHeight: super.render(normalizedWidth).length,
		};
		this.renderedCompensation = undefined;
	}

	getHeightCompensation(): AssistantHeightCompensation | undefined {
		const compensation = this.heightCompensation;
		if (!compensation) return undefined;
		this.render(compensation.width);
		const rendered = this.renderedCompensation;
		if (!rendered || rendered.rows === 0) return undefined;
		return { rows: rendered.rows, width: rendered.width };
	}

	clearHeightCompensation(): void {
		this.heightCompensation = undefined;
		this.renderedCompensation = undefined;
	}

	override handleMouse(event: TuiMouseEvent) {
		const compensationRows = this.renderedCompensation?.width === event.width ? this.renderedCompensation.rows : 0;
		if (event.y < compensationRows) return undefined;
		return super.handleMouse({
			...event,
			y: event.y - compensationRows,
			height: Math.max(0, event.height - compensationRows),
		});
	}

	override render(width: number): string[] {
		let compensation = this.heightCompensation;
		if (!compensation) {
			const lines = super.render(width);
			this.renderedCompensation = undefined;
			return lines;
		}
		if (compensation.width !== width) {
			const previousWidthLines = super.render(compensation.width);
			compensation = this.consumeHeightCompensation(compensation, previousWidthLines.length);
			const lines = super.render(width);
			compensation = { ...compensation, width, baselineContentHeight: lines.length };
			this.heightCompensation = compensation;
			this.renderedCompensation = { width, rows: compensation.rows };
			return compensation.rows === 0 ? lines : [...Array<string>(compensation.rows).fill(""), ...lines];
		}

		const lines = super.render(width);
		compensation = this.consumeHeightCompensation(compensation, lines.length);
		this.heightCompensation = compensation;
		this.renderedCompensation = { width, rows: compensation.rows };
		return compensation.rows === 0 ? lines : [...Array<string>(compensation.rows).fill(""), ...lines];
	}

	private consumeHeightCompensation(
		compensation: { rows: number; width: number; baselineContentHeight: number },
		contentHeight: number,
	): { rows: number; width: number; baselineContentHeight: number } {
		const consumedRows = Math.max(0, contentHeight - compensation.baselineContentHeight);
		if (consumedRows === 0) return compensation;
		return {
			...compensation,
			rows: Math.max(0, compensation.rows - consumedRows),
			baselineContentHeight: contentHeight,
		};
	}

	private rebuildChildren(): void {
		this.clear();
		this.addChild(this.assistant);
		for (const [key, tool] of this.tools) {
			const assignment = this.toolFoldAssignments.get(key);
			if (assignment?.showSummary) this.addChild(assignment.region.getSummaryComponent());
			if (!assignment || assignment.region.isExpanded()) {
				this.addChild(tool);
			}
		}
		// Missing tool calls have no child to anchor to; analysis only assigns this when the region starts here.
		if (this.trailingFoldSummary) this.addChild(this.trailingFoldSummary);
	}
}
