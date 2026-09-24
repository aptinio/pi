import { type Component, Container, encodeTranscriptEntryMarker } from "@earendil-works/pi-tui";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/** Owns one durable transcript entry and marks its first rendered row with its session entry ID. */
export class TranscriptEntryComponent extends Container {
	private entryId: string | undefined;
	private entryMarker: string | undefined;

	constructor(entryId?: string, children: readonly Component[] = []) {
		super();
		this.entryId = entryId;
		this.entryMarker = entryId === undefined ? undefined : encodeTranscriptEntryMarker(entryId);
		for (const child of children) this.addChild(child);
	}

	getEntryId(): string | undefined {
		return this.entryId;
	}

	setEntryId(entryId: string): void {
		if (entryId === this.entryId) return;
		this.entryId = entryId;
		this.entryMarker = encodeTranscriptEntryMarker(entryId);
		this.invalidate();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.entryMarker || lines.length === 0) return lines;
		const firstLine = lines[0] ?? "";
		const oscPrefix = OSC133_ZONE_PREFIX.exec(firstLine)?.[0] ?? "";
		lines[0] = `${oscPrefix}${this.entryMarker}${firstLine.slice(oscPrefix.length)}`;
		return lines;
	}
}
