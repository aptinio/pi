import { type Component, MouseRegion, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import type { AssistantFoldRegionView } from "./assistant-fold-region.ts";
import type { AssistantTranscriptGroup } from "./assistant-transcript-group.ts";

type GroupRecord = {
	group: AssistantTranscriptGroup;
	boundaryBefore: boolean;
};

type ThinkingItem = {
	kind: "thinking";
	group: AssistantTranscriptGroup;
	contentIndex: number;
	stateKey?: string;
};

type ToolItem = {
	kind: "tool";
	group: AssistantTranscriptGroup;
	key?: string;
	stateKey?: string;
};

type HiddenItem = ThinkingItem | ToolItem;

type RegionAnalysis = {
	items: HiddenItem[];
	thinkingCount: number;
	toolCount: number;
	hasError: boolean;
	hasIncompleteTool: boolean;
};

type CompletionOptions = {
	defaultExpanded: boolean;
	restoredExpansion?: ReadonlyMap<string, boolean>;
};

function isSameHiddenItem(left: HiddenItem, right: HiddenItem): boolean {
	if (left.kind !== right.kind || left.group !== right.group) return false;
	if (left.kind === "thinking" && right.kind === "thinking") return left.contentIndex === right.contentIndex;
	if (left.kind === "tool" && right.kind === "tool") return left.key === right.key;
	return false;
}

class AssistantHiddenRegion implements AssistantFoldRegionView {
	readonly analysis: RegionAnalysis;
	private readonly summaryText: Text;
	private readonly summaryRegion: MouseRegion;
	private readonly onChange: () => void;
	private expanded: boolean;

	constructor(outputPad: number, analysis: RegionAnalysis, expanded: boolean, onChange: () => void) {
		this.analysis = analysis;
		this.expanded = expanded;
		this.onChange = onChange;
		this.summaryText = new Text("", outputPad, 0);
		this.summaryRegion = new MouseRegion(this.summaryText, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true, preserveViewport: true };
		});
		this.updateSummary();
	}

	getSummaryComponent(): Component {
		return this.summaryRegion;
	}

	getStateKeys(): string[] {
		return this.analysis.items.flatMap((item) => (item.stateKey ? [item.stateKey] : []));
	}

	containsGroup(group: AssistantTranscriptGroup): boolean {
		return this.analysis.items.some((item) => item.group === group);
	}

	getAnchorGroup(): AssistantTranscriptGroup {
		return this.analysis.items[0]!.group;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean, notify = true): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.updateSummary();
		if (notify) this.onChange();
	}

	private updateSummary(): void {
		const details: string[] = [];
		if (this.analysis.toolCount > 0) {
			details.push(`${this.analysis.toolCount} tool ${this.analysis.toolCount === 1 ? "call" : "calls"}`);
		}
		if (this.analysis.thinkingCount > 0) {
			details.push(
				`${this.analysis.thinkingCount} thinking ${this.analysis.thinkingCount === 1 ? "block" : "blocks"}`,
			);
		}
		if (this.analysis.hasError) details.push("error");
		else if (this.analysis.hasIncompleteTool) details.push("incomplete");
		const marker = this.expanded ? "[-]" : "[+]";
		this.summaryText.setText(theme.fg("muted", `${marker} ${details.join(", ")}`));
	}
}

export class AssistantTurn {
	private readonly groups: GroupRecord[] = [];
	private readonly outputPad: number;
	private regions: AssistantHiddenRegion[] = [];
	private completed = false;

	constructor(outputPad: number) {
		this.outputPad = outputPad;
	}

	addGroup(group: AssistantTranscriptGroup): void {
		this.groups.push({ group, boundaryBefore: false });
	}

	reconcileBoundaries(children: readonly Component[]): void {
		const positions = new Map(children.map((child, index) => [child, index]));
		for (let index = 1; index < this.groups.length; index += 1) {
			const previousPosition = positions.get(this.groups[index - 1]!.group);
			const currentPosition = positions.get(this.groups[index]!.group);
			this.groups[index]!.boundaryBefore =
				previousPosition === undefined || currentPosition === undefined || currentPosition !== previousPosition + 1;
		}
	}

	removeGroup(group: AssistantTranscriptGroup): boolean {
		const index = this.groups.findIndex((record) => record.group === group);
		if (index >= 0) this.groups.splice(index, 1);
		return this.groups.length === 0;
	}

	foldBeforeLast(options: CompletionOptions): boolean {
		if (this.completed || this.groups.length < 2) return false;
		return this.rebuildRegions(this.groups.slice(0, -1), options, false);
	}

	complete(options: CompletionOptions): boolean {
		if (this.completed) return false;
		this.completed = true;
		return this.rebuildRegions(this.groups, options, true);
	}

	getStateKeys(): string[] {
		return this.groups.flatMap(({ group }) => {
			const entryId = group.getEntryId();
			return entryId ? [entryId] : [];
		});
	}

	getRegionExpansionStates(): readonly { stateKeys: string[]; expanded: boolean }[] {
		return this.regions.map((region) => ({
			stateKeys: region.getStateKeys(),
			expanded: region.isExpanded(),
		}));
	}

	isCompleted(): boolean {
		return this.completed;
	}

	getFoldedEntryRedirect(entryId: string): string | undefined {
		const group = this.groups.find((record) => record.group.getEntryId() === entryId)?.group;
		if (!group) return undefined;
		const region = this.regions.find((candidate) => !candidate.isExpanded() && candidate.containsGroup(group));
		if (!region || group.rendersWithFoldState()) return undefined;
		return region.getAnchorGroup().getEntryId();
	}

	setExpanded(expanded: boolean): void {
		if (this.regions.length === 0) return;
		for (const region of this.regions) region.setExpanded(expanded, false);
		this.refreshFoldState();
	}

	private rebuildRegions(
		groups: readonly GroupRecord[],
		{ defaultExpanded, restoredExpansion }: CompletionOptions,
		markToolUseIncomplete: boolean,
	): boolean {
		const previousRegions = this.regions;
		const expansionByStateKey = new Map(restoredExpansion);
		for (const region of previousRegions) {
			for (const stateKey of region.getStateKeys()) expansionByStateKey.set(stateKey, region.isExpanded());
		}

		const analyses = this.analyzeRegions(groups, markToolUseIncomplete);
		const hadRegions = previousRegions.length > 0;
		this.regions = analyses.map((analysis) => {
			const stateKeys = analysis.items.flatMap((item) => (item.stateKey ? [item.stateKey] : []));
			const restored = stateKeys
				.map((stateKey) => expansionByStateKey.get(stateKey))
				.find((expanded) => expanded !== undefined);
			const previous = analysis.items
				.map((item) =>
					previousRegions.find((region) =>
						region.analysis.items.some((previousItem) => isSameHiddenItem(previousItem, item)),
					),
				)
				.find((region) => region !== undefined);
			return new AssistantHiddenRegion(
				this.outputPad,
				analysis,
				restored ?? previous?.isExpanded() ?? defaultExpanded,
				() => this.refreshFoldState(),
			);
		});
		this.applyAssignments();
		return analyses.length > 0 || hadRegions;
	}

	private refreshFoldState(): void {
		for (const { group } of this.groups) group.refreshFoldState();
	}

	private applyAssignments(): void {
		const thinkingByGroup = new Map<
			AssistantTranscriptGroup,
			Map<number, { region: AssistantHiddenRegion; showSummary: boolean }>
		>();
		const toolsByGroup = new Map<
			AssistantTranscriptGroup,
			Map<string, { region: AssistantHiddenRegion; showSummary: boolean }>
		>();
		const trailingSummaryByGroup = new Map<AssistantTranscriptGroup, Component>();

		for (const region of this.regions) {
			const analysis = region.analysis;
			for (let index = 0; index < analysis.items.length; index += 1) {
				const item = analysis.items[index]!;
				const showSummary = index === 0;
				if (item.kind === "thinking") {
					let assignments = thinkingByGroup.get(item.group);
					if (!assignments) {
						assignments = new Map();
						thinkingByGroup.set(item.group, assignments);
					}
					assignments.set(item.contentIndex, { region, showSummary });
				} else if (item.key) {
					let assignments = toolsByGroup.get(item.group);
					if (!assignments) {
						assignments = new Map();
						toolsByGroup.set(item.group, assignments);
					}
					assignments.set(item.key, { region, showSummary });
				} else if (showSummary) {
					trailingSummaryByGroup.set(item.group, region.getSummaryComponent());
				}
			}
		}

		for (const { group } of this.groups) {
			group.setFoldAssignments(
				thinkingByGroup.get(group) ?? new Map(),
				toolsByGroup.get(group) ?? new Map(),
				trailingSummaryByGroup.get(group),
			);
		}
	}

	private analyzeRegions(groups: readonly GroupRecord[], markToolUseIncomplete: boolean): RegionAnalysis[] {
		const regions: RegionAnalysis[] = [];
		let current: RegionAnalysis | undefined;
		const addItem = (item: HiddenItem): RegionAnalysis => {
			if (!current) {
				current = {
					items: [],
					thinkingCount: 0,
					toolCount: 0,
					hasError: false,
					hasIncompleteTool: false,
				};
				regions.push(current);
			}
			current.items.push(item);
			if (item.kind === "thinking") current.thinkingCount += 1;
			else current.toolCount += 1;
			return current;
		};

		for (const { group, boundaryBefore } of groups) {
			if (boundaryBefore) current = undefined;
			const message = group.getMessage();
			const entryId = group.getEntryId();
			let lastGroupRegion: RegionAnalysis | undefined;
			const messageToolCalls: Array<{ contentIndex: number; id: string }> = [];

			for (let index = 0; index < message.content.length; index += 1) {
				const content = message.content[index];
				if (content.type === "text") {
					if (content.text.trim()) current = undefined;
					continue;
				}
				if (content.type === "toolCall") {
					messageToolCalls.push({ contentIndex: index, id: content.id });
					continue;
				}
				if (content.type !== "thinking") continue;

				const firstThinkingContentIndex = index;
				let hasThinking = false;
				for (; index < message.content.length; index += 1) {
					const thinking = message.content[index];
					if (thinking.type !== "thinking") break;
					if (thinking.thinking.trim()) hasThinking = true;
				}
				index -= 1;
				if (!hasThinking) continue;
				lastGroupRegion = addItem({
					kind: "thinking",
					group,
					contentIndex: firstThinkingContentIndex,
					...(entryId ? { stateKey: `${entryId}:thinking:${firstThinkingContentIndex}` } : {}),
				});
			}

			const hasVisibleTrailingStatus =
				message.stopReason === "length" ||
				(messageToolCalls.length === 0 && (message.stopReason === "aborted" || message.stopReason === "error"));
			if (hasVisibleTrailingStatus) current = undefined;

			const matchedToolCalls = new Set<number>();
			const tools = group.getToolEntries();
			for (const [key, component] of tools) {
				const snapshot = component.getSnapshot();
				const toolCallIndex = messageToolCalls.findIndex(
					(call, index) => !matchedToolCalls.has(index) && call.id === snapshot.toolCallId,
				);
				if (toolCallIndex >= 0) matchedToolCalls.add(toolCallIndex);
				const toolCall = toolCallIndex >= 0 ? messageToolCalls[toolCallIndex] : undefined;
				const region = addItem({
					kind: "tool",
					group,
					key,
					...(entryId
						? {
								stateKey: toolCall
									? `${entryId}:${toolCall.contentIndex}:${toolCall.id}`
									: `${entryId}:tool:${key}`,
							}
						: {}),
				});
				if (snapshot.result?.isError) region.hasError = true;
				if (!snapshot.result || snapshot.isPartial) region.hasIncompleteTool = true;
				lastGroupRegion = region;
			}

			for (let index = 0; index < messageToolCalls.length; index += 1) {
				if (matchedToolCalls.has(index)) continue;
				const toolCall = messageToolCalls[index]!;
				const region = addItem({
					kind: "tool",
					group,
					...(entryId ? { stateKey: `${entryId}:${toolCall.contentIndex}:${toolCall.id}` } : {}),
				});
				region.hasIncompleteTool = true;
				lastGroupRegion = region;
			}

			if (lastGroupRegion && (message.stopReason === "aborted" || message.stopReason === "error")) {
				lastGroupRegion.hasError = true;
			}
			if (lastGroupRegion && message.stopReason === "length") {
				lastGroupRegion.hasIncompleteTool = true;
			}
		}

		const terminalStopReason = groups.at(-1)?.group.getMessage().stopReason;
		if (markToolUseIncomplete && terminalStopReason === "toolUse" && regions.at(-1)) {
			regions.at(-1)!.hasIncompleteTool = true;
		}
		return regions;
	}
}
