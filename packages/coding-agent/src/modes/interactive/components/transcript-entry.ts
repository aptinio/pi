import { type Component, Container } from "@earendil-works/pi-tui";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const TRANSCRIPT_ENTRY_MARKER_PREFIX = "\x1b_pi:e:";

function encodeTranscriptEntryMarker(entryId: string): string {
	const encoded = Array.from(new TextEncoder().encode(entryId), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${TRANSCRIPT_ENTRY_MARKER_PREFIX}${encoded}\x07`;
}

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
