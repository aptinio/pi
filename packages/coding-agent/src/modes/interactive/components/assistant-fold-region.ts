import type { Component } from "@earendil-works/pi-tui";

export interface AssistantFoldRegionView {
	getSummaryComponent(): Component;
	isExpanded(): boolean;
}

export type AssistantFoldAssignment = {
	region: AssistantFoldRegionView;
	showSummary: boolean;
};
