import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessageComponent } from "./assistant-message.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import { TranscriptEntryComponent } from "./transcript-entry.ts";

/** Identity-only owner for one assistant message and its tool-call components. */
export class AssistantTranscriptGroup extends TranscriptEntryComponent {
	readonly assistant: AssistantMessageComponent;
	private message: AssistantMessage;
	private readonly tools = new Map<string, ToolExecutionComponent>();

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
		if (previous) this.removeChild(previous);
		this.tools.set(key, component);
		this.addChild(component);
	}

	getTools(): readonly ToolExecutionComponent[] {
		return [...this.tools.values()];
	}
}
