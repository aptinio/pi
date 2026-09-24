import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { type BashExecutionMessage, type CustomMessage, createCustomMessage } from "../../core/messages.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	SessionEntry,
	SessionMessageEntry,
	UsageEntry,
} from "../../core/session-manager.ts";

export interface TranscriptTool {
	readonly contentIndex: number;
	readonly call: ToolCall;
	readonly resultEntry?: SessionMessageEntry & { message: ToolResultMessage };
}

export type TranscriptItem =
	| {
			kind: "assistant";
			entryId: string;
			message: AssistantMessage;
			tools: readonly TranscriptTool[];
	  }
	| { kind: "user"; entryId: string; message: UserMessage }
	| { kind: "bash"; entryId: string; message: BashExecutionMessage }
	| { kind: "custom-message"; entryId: string; message: CustomMessage }
	| { kind: "unmatched-tool-result"; entryId: string; message: ToolResultMessage }
	| { kind: "compaction"; entry: CompactionEntry }
	| { kind: "branch-summary"; entry: BranchSummaryEntry }
	| { kind: "custom-entry"; entry: CustomEntry }
	| { kind: "usage"; entry: UsageEntry };

interface MutableTranscriptTool {
	contentIndex: number;
	call: ToolCall;
	resultEntry?: SessionMessageEntry & { message: ToolResultMessage };
}

interface MutableAssistantItem {
	kind: "assistant";
	entryId: string;
	message: AssistantMessage;
	tools: MutableTranscriptTool[];
}

interface UnmatchedToolSlot {
	item: MutableAssistantItem;
	tool: MutableTranscriptTool;
}

function normalizeHistoricalMessage(entry: SessionMessageEntry): SessionMessageEntry["message"] {
	const message = entry.message;
	if (message.role === "system" && message.content == null) return { ...message, content: "" };
	if (
		(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
		message.content == null
	) {
		return { ...message, content: [] };
	}
	return message;
}

function appendMessageItem(
	items: TranscriptItem[],
	entry: SessionMessageEntry,
	unmatchedTools: Map<string, UnmatchedToolSlot[]>,
): void {
	const message = normalizeHistoricalMessage(entry);
	switch (message.role) {
		case "assistant": {
			const item: MutableAssistantItem = { kind: "assistant", entryId: entry.id, message, tools: [] };
			for (const [contentIndex, content] of message.content.entries()) {
				if (content.type !== "toolCall") continue;
				const tool = { contentIndex, call: content };
				item.tools.push(tool);
				const slots = unmatchedTools.get(content.id);
				if (slots) {
					slots.push({ item, tool });
				} else {
					unmatchedTools.set(content.id, [{ item, tool }]);
				}
			}
			items.push(item);
			return;
		}
		case "toolResult": {
			const slots = unmatchedTools.get(message.toolCallId);
			const slot = slots?.shift();
			if (slots?.length === 0) unmatchedTools.delete(message.toolCallId);
			if (slot) {
				slot.tool.resultEntry = { ...entry, message };
			} else {
				items.push({ kind: "unmatched-tool-result", entryId: entry.id, message });
			}
			return;
		}
		case "user":
			items.push({ kind: "user", entryId: entry.id, message });
			return;
		case "bashExecution":
			items.push({ kind: "bash", entryId: entry.id, message });
			return;
		case "custom":
			if (message.display) items.push({ kind: "custom-message", entryId: entry.id, message });
			return;
		case "system":
		case "branchSummary":
		case "compactionSummary":
			return;
	}
}

export function buildTranscriptItems(entries: readonly SessionEntry[]): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const unmatchedTools = new Map<string, UnmatchedToolSlot[]>();

	for (const entry of entries) {
		switch (entry.type) {
			case "message":
				appendMessageItem(items, entry, unmatchedTools);
				break;
			case "custom_message": {
				if (!entry.display) break;
				const message = createCustomMessage(
					entry.customType,
					entry.content ?? [],
					entry.display,
					entry.details,
					entry.timestamp,
				);
				items.push({ kind: "custom-message", entryId: entry.id, message });
				break;
			}
			case "compaction":
				items.push({ kind: "compaction", entry });
				break;
			case "branch_summary":
				items.push({ kind: "branch-summary", entry });
				break;
			case "custom":
				items.push({ kind: "custom-entry", entry });
				break;
			case "usage":
				if (entry.kind === "cache_warm") items.push({ kind: "usage", entry });
				break;
			case "thinking_level_change":
			case "model_change":
			case "context_edit":
			case "label":
			case "session_info":
				break;
		}
	}

	return items;
}
