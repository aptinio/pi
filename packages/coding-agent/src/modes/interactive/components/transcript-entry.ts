import { type Component, Container, encodeTranscriptEntryMarker } from "@earendil-works/pi-tui";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/** Owns one durable transcript entry and marks its first rendered row with its session entry ID. */
export class TranscriptEntryComponent extends Container {
	private entryId: string | undefined;
	private entryMarker: string | undefined;
	private markedLines?: { source: readonly string[]; marker: string; lines: string[] };

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

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (!this.entryMarker || lines.length === 0) return lines;
		// Container output is shared across frames; copy it once per change instead of mutating it.
		if (this.markedLines?.source !== lines || this.markedLines.marker !== this.entryMarker) {
			const marked = [...lines];
			const firstLine = marked[0] ?? "";
			const oscPrefix = OSC133_ZONE_PREFIX.exec(firstLine)?.[0] ?? "";
			marked[0] = `${oscPrefix}${this.entryMarker}${firstLine.slice(oscPrefix.length)}`;
			this.markedLines = { source: lines, marker: this.entryMarker, lines: marked };
		}
		return this.markedLines.lines;
	}
}
