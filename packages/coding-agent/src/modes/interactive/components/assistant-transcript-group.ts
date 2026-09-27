import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { AssistantFoldAssignment } from "./assistant-fold-region.ts";
import type { AssistantMessageComponent } from "./assistant-message.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import { TranscriptEntryComponent } from "./transcript-entry.ts";

/** Identity-only owner for one assistant message and its tool-call components. */
export class AssistantTranscriptGroup extends TranscriptEntryComponent {
	readonly assistant: AssistantMessageComponent;
	private message: AssistantMessage;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private toolFoldAssignments = new Map<string, AssistantFoldAssignment>();
	private trailingFoldSummary: Component | undefined;

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

	private rebuildChildren(): void {
		this.clear();
		this.addChild(this.assistant);
		for (const [key, tool] of this.tools) {
			const assignment = this.toolFoldAssignments.get(key);
			if (assignment?.showSummary) this.addChild(assignment.region.getSummaryComponent());
			if (!assignment || assignment.region.isExpanded()) this.addChild(tool);
		}
		// Missing tool calls have no child to anchor to; analysis only assigns this when the region starts here.
		if (this.trailingFoldSummary) this.addChild(this.trailingFoldSummary);
	}
}
