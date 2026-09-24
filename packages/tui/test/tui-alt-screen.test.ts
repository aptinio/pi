import assert from "node:assert";
import { describe, it } from "node:test";
import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	findAltScreenSearchMatches,
} from "../src/alt-screen-search.ts";
import { HStack } from "../src/components/h-stack.ts";
import { Image } from "../src/components/image.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { SelectList } from "../src/components/select-list.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import {
	encodeKitty,
	hyperlink,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import {
	decodeTranscriptEntryMarkerPrefix,
	encodeTranscriptEntryMarker,
	type TranscriptViewState,
	type TuiMouseEvent,
} from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function markedPrompt(entryId: string, text: string): string {
	return `${OSC133_ZONE_START}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${encodeTranscriptEntryMarker(entryId)}${text}`;
}

class InputOverlay {
	focused = false;
	inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return ["overlay"];
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly events: Array<{ type: "write"; data: string } | { type: "start" } | { type: "stop" }> = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.events.push({ type: "start" });
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}

	override stop(): void {
		this.events.push({ type: "stop" });
		super.stop();
	}
}

describe("TuiAltScreen", () => {
	it("renders a terminal-height viewport and preserves manual scroll position", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10"],
		);
		assert.strictEqual(tui.isFollowingOutput, true);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(tui.isFollowingOutput, false);

		text.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);

		tui.stop();
	});

	it("keeps transcript content above a clicked expansion fixed", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const expandable = new Text("toggle", 0, 0);
		const region = new MouseRegion(expandable, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			expandable.setText("toggle\ndetail 1\ndetail 2\ndetail 3");
			return { handled: true, preserveViewport: true };
		});
		tui.addChild(
			new VStack([
				new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
				region,
				new Text("after", 0, 0),
			]),
		);
		tui.start();
		await terminal.waitForRender();

		const topBefore = tui.viewportTop;
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "toggle", "after"],
		);

		terminal.sendInput("\x1b[<0;1;3M");
		terminal.sendInput("\x1b[<0;1;3m");
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, topBefore);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "toggle", "detail 1"],
		);
		tui.stop();
	});

	it("keeps transcript content above a clicked collapse fixed", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		let expanded = true;
		const expandable = new Text("toggle\ndetail 1\ndetail 2\ndetail 3", 0, 0);
		const region = new MouseRegion(expandable, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			expanded = !expanded;
			expandable.setText(expanded ? "toggle\ndetail 1\ndetail 2\ndetail 3" : "toggle");
			return { handled: true, preserveViewport: true };
		});
		tui.addChild(
			new VStack([
				new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
				region,
				new Text("after", 0, 0),
			]),
		);
		tui.start();
		await terminal.waitForRender();

		const topBefore = tui.viewportTop;
		assert.strictEqual(topBefore, 5);
		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<0;1;4m");
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, topBefore);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "toggle", "after", "", "", ""],
		);

		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<0;1;4m");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, topBefore);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "toggle", "detail 1", "detail 2", "detail 3", "after"],
		);

		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<0;1;4m");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, topBefore);

		terminal.sendInput("\x1b[<65;1;4M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 2);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 3", "line 4", "line 5", "line 6", "line 7", "line 8", "toggle", "after"],
		);
		tui.stop();
	});

	it("shows a clickable jump-to-end indicator on the transcript's last row while scrolled up", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => "\x1b[7m ↓ Jump to end \x1b[27m",
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.strictEqual(terminal.getViewport()[3], "line 7  ↓ Jump to end         ");
		assert.strictEqual(terminal.getViewport()[4]?.trimEnd(), "editor");

		// Pressing next to the label starts a selection instead of jumping.
		terminal.sendInput("\x1b[<0;2;4M");
		terminal.sendInput("\x1b[<0;2;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);

		terminal.sendInput("\x1b[<0;15;4M");
		terminal.sendInput("\x1b[<0;15;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, true);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);
		tui.stop();
	});

	it("keeps the jump-to-end indicator centered as the auto scrollbar hides and reappears", async () => {
		// Regression test for #9136: auto scrollbar visibility must not move the indicator.
		const terminal = new VirtualTerminal(80, 6);
		const label = " ↓ Jump to latest message · End ";
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => label,
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true, scrollbar: "auto", scrollbarHideDelayMs: 0 },
		);
		tui.setLayoutRoot(transcript);
		tui.start();
		try {
			await terminal.waitForRender();

			// Scrolling over the track keeps the scrollbar visible until the pointer leaves.
			terminal.sendInput("\x1b[<64;80;1M");
			await terminal.waitForRender();
			assert.strictEqual(transcript.isScrollbarVisible, true);
			assert.strictEqual(transcript.isFollowingEnd, false);
			const scrollTop = transcript.scrollTop;
			const visibleColumn = terminal.getViewport()[5].indexOf(label);

			// Leaving the track lets the auto-hide timer expire without changing the content.
			terminal.sendInput("\x1b[<35;79;1M");
			await terminal.waitForRender();
			assert.strictEqual(transcript.isScrollbarVisible, false);
			assert.strictEqual(transcript.scrollTop, scrollTop);
			const hiddenColumn = terminal.getViewport()[5].indexOf(label);

			terminal.sendInput("\x1b[<35;80;1M");
			await terminal.waitForRender();
			assert.strictEqual(transcript.isScrollbarVisible, true);
			assert.strictEqual(transcript.scrollTop, scrollTop);
			const revealedColumn = terminal.getViewport()[5].indexOf(label);

			assert.deepStrictEqual([visibleColumn, hiddenColumn, revealedColumn], [24, 24, 24]);
		} finally {
			tui.stop();
		}
	});

	it("leaves the scrollbar visible and clickable when the jump-to-end indicator spans the transcript", async () => {
		// Regression coverage for #9136: centering must not paint or capture clicks over the scrollbar.
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => "↓".repeat(30),
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);

		// The indicator must not intercept a press on the scrollbar's last column.
		assert.strictEqual(terminal.getViewport()[3], `${"↓".repeat(29)}┃`);
		terminal.sendInput("\x1b[<0;30;4M");
		terminal.sendInput("\x1b[<0;30;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		tui.stop();
	});

	it("never shows the jump-to-end indicator for a primary scroll view without follow-end", async () => {
		const terminal = new VirtualTerminal(30, 3);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => " ↓ Jump to end ",
		});
		const transcript = new ScrollView(new Text("one\ntwo\nthree\nfour\nfive", 0, 0), { primary: true });
		tui.setLayoutRoot(transcript);
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));
		tui.stop();
	});

	it("keeps an explicit dock fixed while the transcript scrolls", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const dock = new VStack([new Text("editor", 0, 0), new Text("footer", 0, 0)]);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);

		// Wheel over the dock falls back to the primary transcript scroll view.
		terminal.sendInput("\x1b[<64;1;6M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);
		assert.strictEqual(transcript.isFollowingEnd, false);

		transcriptText.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);

		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10", "editor", "footer"],
		);
		tui.stop();
	});

	it("invalidates overlays with an explicit layout root", () => {
		const tui = new TuiAltScreen(new VirtualTerminal());
		const overlay = new Text("overlay", 0, 0);
		let invalidated = false;
		overlay.invalidate = () => {
			invalidated = true;
		};
		tui.setLayoutRoot(new Text("root", 0, 0));
		tui.showOverlay(overlay);
		assert.strictEqual(tui.hasBlockingOverlayEntries(), true);

		tui.invalidate();

		assert.strictEqual(invalidated, true);
		tui.stop();
	});

	it("routes wheel input to the scroll view under the pointer", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const left = new ScrollView(new Text("a1\na2\na3\na4\na5\na6\na7", 0, 0), {
			follow: "end",
			primary: true,
		});
		const right = new ScrollView(new Text("b1\nb2\nb3\nb4\nb5\nb6\nb7", 0, 0), { follow: "end" });
		tui.setLayoutRoot(
			new HStack([
				{ component: left, basis: 10, shrink: 0 },
				{ component: right, basis: 10, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;15;1M");
		await terminal.waitForRender();
		assert.strictEqual(left.scrollTop, 3);
		assert.strictEqual(right.scrollTop, 2);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a4        b3", "a5        b4", "a6        b5", "a7        b6"],
		);
		tui.stop();
	});

	it("scrolls faster while Alt is held during wheel input", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 8);

		// Alt modifier sets bit 8 on the wheel button (72 = 64 + 8).
		terminal.sendInput("\x1b[<72;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 3);
		tui.stop();
	});

	it("does not vertically redispatch misses through horizontal layout containers", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let selections = 0;
		const list = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
			2,
			{
				selectedPrefix: (text) => text,
				selectedText: (text) => text,
				description: (text) => text,
				scrollInfo: (text) => text,
				noMatch: (text) => text,
			},
		);
		list.onSelect = () => {
			selections += 1;
		};
		tui.setLayoutRoot(
			new HStack([
				{ component: list, basis: 10 },
				{ component: new Text("plain", 0, 0), basis: 10 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;15;1M");
		terminal.sendInput("\x1b[<0;15;1m");
		await terminal.waitForRender();
		assert.strictEqual(selections, 0);
		tui.stop();
	});

	it("uses button-motion tracking inside terminal multiplexers", () => {
		const environmentKeys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		try {
			for (const key of environmentKeys) delete process.env[key];
			process.env.TERM = "xterm-256color";
			const directTerminal = new RecordingTerminal();
			const directTui = new TuiAltScreen(directTerminal);
			directTui.start();
			const directWrites = directTerminal.events
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(directWrites.includes("\x1b[?1003h"));
			directTui.stop();

			const multiplexers = [
				{ name: "tmux environment", environment: { TMUX: "/tmp/tmux/default,1,0" } },
				{ name: "tmux TERM", environment: { TERM: "tmux-256color" } },
				{ name: "Zellij environment", environment: { ZELLIJ: "0" } },
				{ name: "Screen environment", environment: { STY: "123.session" } },
				{ name: "Screen TERM", environment: { TERM: "screen-256color" } },
			];
			for (const { name, environment } of multiplexers) {
				for (const key of environmentKeys) delete process.env[key];
				for (const [key, value] of Object.entries(environment)) process.env[key] = value;
				const terminal = new RecordingTerminal();
				const tui = new TuiAltScreen(terminal);
				tui.start();
				const writes = terminal.events
					.filter((event): event is { type: "write"; data: string } => event.type === "write")
					.map((event) => event.data)
					.join("");
				assert.ok(writes.includes("\x1b[?1002h"), `${name} should enable button-motion tracking`);
				assert.ok(!writes.includes("\x1b[?1003h"), `${name} should not enable all-motion tracking`);
				assert.ok(writes.includes("\x1b[?1006h"), `${name} should enable SGR mouse encoding`);
				tui.stop();
			}
		} finally {
			for (const key of environmentKeys) {
				const value = previousEnvironment.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("invokes the right-click paste handler only on Windows outside VS Code", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const termProgram = process.env.TERM_PROGRAM;
		assert.ok(platformDescriptor);
		const terminal = new VirtualTerminal();
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onRightClickPaste: () => {
				pasteCount += 1;
			},
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			delete process.env.TERM_PROGRAM;
			tui.start();
			terminal.sendInput("\x1b[<2;1;1M");
			terminal.sendInput("\x1b[<2;1;1m");
			assert.strictEqual(pasteCount, 1);

			process.env.TERM_PROGRAM = "vscode";
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);

			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			delete process.env.TERM_PROGRAM;
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", platformDescriptor);
			if (termProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = termProgram;
		}
	});

	it("invokes middle-click paste only for an unmodified press and retains the active selection", async () => {
		const terminal = new RecordingTerminal(20, 2);
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onMiddleClickPaste: () => {
				pasteCount += 1;
			},
		});
		tui.addChild(new Text("alpha\nbeta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(tui.hasActiveSelection(), true);

		terminal.sendInput("\x1b[<1;1;1M");
		terminal.sendInput("\x1b[<1;1;1m");
		terminal.sendInput("\x1b[<5;1;1M");
		terminal.sendInput("\x1b[<9;1;1M");
		terminal.sendInput("\x1b[<17;1;1M");
		await terminal.waitForRender();

		assert.strictEqual(pasteCount, 1);
		assert.strictEqual(tui.hasActiveSelection(), true);
		const redrawEventCount = terminal.events.length;
		tui.renderNow(true);
		assert.ok(
			terminal.events
				.slice(redrawEventCount)
				.some((event) => event.type === "write" && event.data.includes("\x1b[7m")),
		);
		tui.stop();
	});

	it("lets a mouse-aware component consume middle-click before the paste fallback", async () => {
		const terminal = new VirtualTerminal(20, 1);
		let pasteCount = 0;
		let componentPresses = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onMiddleClickPaste: () => {
				pasteCount += 1;
			},
		});
		tui.addChild({
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type !== "press" || event.button !== "middle") return undefined;
				componentPresses += 1;
				return { handled: true };
			},
		});
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<1;1;1M");
		terminal.sendInput("\x1b[<1;1;1m");
		await terminal.waitForRender();

		assert.strictEqual(componentPresses, 1);
		assert.strictEqual(pasteCount, 0);
		tui.stop();
	});

	it("reveals an auto scrollbar when the pointer enters its hidden track", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "auto", scrollbarHideDelayMs: 20 },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		terminal.sendInput("\x1b[<35;10;3M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, true);
		assert.strictEqual(scrollView.isScrollbarActive, true);
		assert.ok(terminal.getViewport().some((line) => /[│█]/.test(line)));

		terminal.sendInput("\x1b[<35;9;3M");
		await new Promise((resolve) => setTimeout(resolve, 40));
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		tui.stop();
	});

	it("jumps to a scrollbar track position and continues dragging from there", async () => {
		const terminal = new RecordingTerminal(10, 10);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 0);

		terminal.sendInput("\x1b[<0;10;6M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 20);

		terminal.sendInput("\x1b[<32;10;10M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 40);

		terminal.sendInput("\x1b[<0;10;10m");
		await terminal.waitForRender();
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("chains unused wheel delta to an outer scroll view", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		const outer = new ScrollView(
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			{ primary: true },
		);
		tui.setLayoutRoot(outer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 3);
		assert.strictEqual(outer.scrollTop, 0);

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 4);
		assert.strictEqual(outer.scrollTop, 2);
		tui.stop();
	});

	it("does not cancel a selected transcript's preserved viewport when another region consumes wheel input", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(
			[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
			0,
			0,
		);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const secondary = new ScrollView(new Text("s1\ns2\ns3\ns4\ns5\ns6", 0, 0), { overscroll: "contain" });
		tui.setLayoutRoot(
			new HStack([
				{ component: transcript, basis: 10 },
				{ component: secondary, basis: 10 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);

		transcript.preserveViewport();
		transcriptText.setText(
			[1, 2, 3].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
		);
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 4);
		assert.strictEqual(transcript.isAtEnd, true);

		terminal.sendInput("\x1b[<65;15;1M");
		await terminal.waitForRender();
		assert.strictEqual(secondary.scrollTop, 1);
		assert.strictEqual(transcript.scrollTop, 4);
		assert.strictEqual(transcript.isFollowingEnd, false);
		tui.stop();
	});

	it("supports configurable keyboard viewport navigation with four rows of page overlap", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[57421u");
		terminal.sendInput("\x1b[57421;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1bOF");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		tui.stop();
	});

	it("searches normalized rendered transcript text across rows", () => {
		assert.deepStrictEqual(findAltScreenSearchMatches(["alpha QUICK", "brown fox"], "quick brown"), [
			{
				segments: [
					{ row: 0, startCol: 6, endCol: 11 },
					{ row: 1, startCol: 0, endCol: 5 },
				],
			},
		]);
	});

	it("maps normalized ASCII and Unicode search matches back to rendered columns", () => {
		assert.deepStrictEqual(findAltScreenSearchMatches(["\x1b[31mfoo  bar\x1b[0m", "A界🙂éZ"], "oo   bar\nA界🙂é"), [
			{
				segments: [
					{ row: 0, startCol: 1, endCol: 3 },
					{ row: 0, startCol: 5, endCol: 8 },
					{ row: 1, startCol: 0, endCol: 6 },
				],
			},
		]);
	});

	it("reuses indexed transcript matches until the query or rendered lines change", () => {
		const index = new AltScreenSearchIndex();
		const initial = index.search(["alpha needle", "omega"], "needle");
		assert.strictEqual(initial.changed, true);
		assert.strictEqual(initial.matches.length, 1);

		const cached = index.search(["alpha needle", "omega"], "needle");
		assert.strictEqual(cached.changed, false);
		assert.strictEqual(cached.matches, initial.matches);

		const changedQuery = index.search(["alpha needle", "omega"], "omega");
		assert.strictEqual(changedQuery.changed, true);
		assert.notStrictEqual(changedQuery.matches, initial.matches);
		assert.deepStrictEqual(changedQuery.matches[0]?.segments, [{ row: 1, startCol: 0, endCol: 5 }]);

		const changedLines = index.search(["alpha needle", "no match"], "omega");
		assert.strictEqual(changedLines.changed, true);
		assert.deepStrictEqual(changedLines.matches, []);
	});

	it("renders transcript search with a muted placeholder and right-aligned controls", () => {
		const component = new AltScreenSearchComponent(() => {});
		const rendered = component.render(48);
		const lines = rendered.map((line) => stripTerminalSequences(line));

		assert.strictEqual(lines.length, 3);
		assert.ok(lines.every((line) => visibleWidth(line) === 48));
		assert.match(lines[0] ?? "", /^┌─+┐$/);
		assert.match(lines[1] ?? "", /^│ Find in transcript +│$/);
		assert.ok(rendered[1]?.includes("\x1b[2m"));
		assert.match(lines[2] ?? "", /^└─+ ↑ Shift\+Enter · ↓ Enter ─┘$/);
		const controls = lines[2] ?? "";
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↑")), -1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("Shift+Enter") + 5), -1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("·")), undefined);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↓")), 1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.lastIndexOf("Enter") + 2), 1);

		component.handleInput("n");
		component.setResult(0, 2);
		const populatedRender = component.render(48);
		const populated = populatedRender.map((line) => stripTerminalSequences(line));
		assert.ok(populated[1]?.includes("n"));
		assert.ok(populated[1]?.includes("1/2"));
		assert.ok(populatedRender[1]?.includes("\x1b[2m 1/2 \x1b[22m"));
		assert.ok(!populated.some((line) => line.includes("Find in transcript")));
	});

	it("navigates transcript search with hoverable arrow buttons and toggles it with its shortcut", async () => {
		const terminal = new RecordingTerminal(120, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchNavigationButtonStyle: (text, hovered) => `${hovered ? "\x1b[45m" : "\x1b[44m"}${text}\x1b[49m`,
		});
		tui.addChild(new Text("needle one\nmiddle\nneedle two\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		let arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		let arrowColumn = viewport[arrowRow]?.lastIndexOf("Enter") ?? -1;
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		const hoverEventCount = terminal.events.length;
		terminal.sendInput(`\x1b[<35;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		assert.ok(
			terminal.events
				.slice(hoverEventCount)
				.some((event) => event.type === "write" && event.data.includes("\x1b[45m↓ Enter\x1b[49m")),
		);
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("2/2")));
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		arrowColumn = (viewport[arrowRow]?.indexOf("Shift+Enter") ?? -3) + 3;
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		tui.stop();
	});

	it("does not treat transcript box drawing as search navigation buttons", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(
			new Text(
				[
					"needle one",
					"middle",
					"needle two",
					"filler",
					"┌────────────────────────────────────────┐",
					"│ box                                    │",
					"└────────────────────────────────────────┘",
					"end",
				].join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(!viewport.some((line) => line.includes("2/2")));

		const boxBottomRow = viewport.findIndex((line) => line.startsWith("└"));
		assert.ok(boxBottomRow >= 0);
		terminal.sendInput(`\x1b[<0;24;${boxBottomRow + 1}M`);
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(!viewport.some((line) => line.includes("2/2")));
		tui.stop();
	});

	it("uses configured styles for current and non-current search matches", async () => {
		const terminal = new RecordingTerminal(60, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchMatchStyle: (text) => `\x1b[41m${text}\x1b[49m`,
			searchCurrentMatchStyle: (text) => `\x1b[42m${text}\x1b[49m`,
		});
		tui.addChild(new Text("needle first\nmiddle\nneedle second\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();

		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[42mneedle\x1b[49m")),
		);
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[41mneedle\x1b[49m")),
		);
		tui.stop();
	});

	it("searches the transcript with Ctrl+Shift+F and restores editor focus on close", async () => {
		const terminal = new RecordingTerminal(60, 8);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(
			Array.from({ length: 12 }, (_, index) => {
				if (index === 4) return "line 5 needle one";
				if (index === 9) return "line 10 needle two";
				return `line ${index + 1}`;
			}).join("\n"),
			0,
			0,
		);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		assert.strictEqual(tui.hasOverlayEntries, true);
		assert.strictEqual(tui.hasBlockingOverlayEntries(), false);
		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));
		assert.deepStrictEqual(editorInputs, []);
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[1;7mneedle\x1b[22;27m")),
		);

		for (let index = 0; index < 6; index++) terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.ok(terminal.getViewport().some((line) => line.includes("needle") && line.includes("2/2")));

		terminal.sendInput("\x07");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 5 needle one")));

		terminal.sendInput("\x1b[103;6u");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));

		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		assert.strictEqual(tui.hasOverlayEntries, false);
		assert.strictEqual(tui.hasBlockingOverlayEntries(), false);
		terminal.resize(60, 13);
		await terminal.waitForRender();
		assert.strictEqual(transcript.isAtEnd, true);
		assert.strictEqual(transcript.isFollowingEnd, true);

		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		assert.deepStrictEqual(editorInputs, ["x"]);

		tui.setLayoutRoot(undefined);
		transcript.updateLayout(12, 12, () => {});
		assert.strictEqual(transcript.isFollowingEnd, true);
		tui.stop();
	});

	it("defers prompt navigation bindings to the focused search input", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.previousPrompt": "ctrl+k",
			}),
		);
		try {
			tui.addChild(
				new Text(
					[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
					0,
					0,
				),
			);
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 5);

			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("\x0b");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 5);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("keeps prompt-owned follow suppression when closing an unfocused search", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
			{ follow: "end", primary: true },
		);
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		tui.setFocus(editor);
		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isAtEnd, true);
		assert.strictEqual(transcript.isFollowingEnd, false);

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		tui.stop();
	});

	it("scrolls the transcript by half a page with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 15);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("scrolls the transcript by one line with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.lineUp": "ctrl+y",
				"tui.altScreen.lineDown": "ctrl+e",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x19");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 19);

			terminal.sendInput("\x05");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("routes Ctrl-modified viewport navigation to the focused component", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, []);

		const modifiedInputs = ["\x1b[1;5H", "\x1b[1;5F", "\x1b[5;5~", "\x1b[6;5~", "\x1b[57423;5u"];
		for (const input of modifiedInputs) terminal.sendInput(input);
		terminal.sendInput("\x1b[57423;5:3u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, modifiedInputs);

		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 1);
		assert.deepStrictEqual(editorInputs, modifiedInputs);

		tui.stop();
	});

	it("jumps between OSC 133 semantic prompt markers", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => "Jump to end",
		});
		tui.addChild(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);

		terminal.sendInput("\x1b[57419;6u");
		terminal.sendInput("\x1b[57419;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 2);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 2");

		terminal.sendInput("\x1b[57420;6u");
		terminal.sendInput("\x1b[57420;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		tui.scrollBy(1);
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(tui.isFollowingOutput, false);

		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(terminal.getViewport()[1]?.trimEnd(), "message 4");
		assert.strictEqual(tui.isFollowingOutput, false);
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));

		tui.scrollBy(1);
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, false);

		tui.clearPromptSelection();
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, true);

		tui.stop();
	});

	it("groups assistant text ranges while excluding thinking rows", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			promptSelectionStyle: (text, { isLastLine }) => `${isLastLine ? "\x1b[42m" : "\x1b[41m"}${text}\x1b[49m`,
		});
		tui.addChild(
			new Text(
				[
					`${OSC133_ZONE_START}\x1b]133;B\x07first answer`,
					"private reasoning",
					`${OSC133_ZONE_START}\x1b]133;B\x07\x1b]133;C\x07second answer`,
					`${OSC133_ZONE_START}\x1b]133;B\x07\x1b]133;C\x07next message`,
				].join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		const selectionEventCount = terminal.events.length;
		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		const selectionWrites = terminal.events
			.slice(selectionEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(selectionWrites.includes("\x1b[41mfirst answer"));
		assert.ok(selectionWrites.includes("\x1b[42msecond answer"));
		assert.ok(!selectionWrites.includes("\x1b[41mprivate reasoning"));
		assert.ok(!selectionWrites.includes("\x1b[42mprivate reasoning"));

		const nextEventCount = terminal.events.length;
		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		const nextWrites = terminal.events
			.slice(nextEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(nextWrites.includes("\x1b[42mnext message"));
		tui.stop();
	});

	it("keeps legacy single-line marker order from selecting following unmarked rows", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			promptSelectionStyle: (text) => `\x1b[45m${text}\x1b[49m`,
		});
		tui.addChild(
			new Text(
				[
					"\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07legacy message",
					"unmarked detail",
					`${OSC133_ZONE_START}\x1b]133;B\x07\x1b]133;C\x07next message`,
				].join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		const selectionEventCount = terminal.events.length;
		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		const selectionWrites = terminal.events
			.slice(selectionEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(selectionWrites.includes("\x1b[45mlegacy message"));
		assert.ok(!selectionWrites.includes("\x1b[45munmarked detail"));

		const nextEventCount = terminal.events.length;
		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		const nextWrites = terminal.events
			.slice(nextEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(nextWrites.includes("\x1b[45mnext message"));
		tui.stop();
	});

	it("selects a first semantic prompt that starts at the viewport top", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			promptSelectionStyle: (text) => `\x1b[45m${text}\x1b[49m`,
		});
		tui.addChild(new Text(`${OSC133_ZONE_START}message\n\x1b]133;B\x07\x1b]133;C\x07detail`, 0, 0));
		tui.start();
		await terminal.waitForRender();

		const eventCount = terminal.events.length;
		terminal.sendInput("\x1b[1;6A");
		tui.requestRender();
		await terminal.waitForRender();
		const writes = terminal.events
			.slice(eventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(writes.includes("\x1b[45mmessage"));
		tui.stop();
	});

	it("keeps follow-end suppressed while dragging the scrollbar with a selected prompt", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
			{ follow: "end", primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(transcript);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, false);

		terminal.sendInput("\x1b[<0;20;1M");
		terminal.sendInput("\x1b[<0;20;1m");
		await terminal.waitForRender();
		terminal.resize(20, 8);
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, false);
		tui.stop();
	});

	it("highlights the selected semantic prompt and preserves it across viewport changes", async () => {
		const terminal = new RecordingTerminal(20, 3);
		let streamedOutputLines = 0;
		const content = {
			render: (width: number) => [
				...[1, 2, 3, 4].flatMap((message) => [
					`${OSC133_ZONE_START}message ${message}`,
					...(width < 20 ? [`wrapped ${message}`] : []),
					`\x1b]133;B\x07\x1b]133;C\x07detail ${message}`,
				]),
				...Array.from({ length: streamedOutputLines }, (_, index) => `streamed output ${index + 1}`),
			],
			invalidate: () => {},
		};
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			promptSelectionStyle: (text) => `\x1b[45m${text}\x1b[49m`,
		});
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.ok(
			terminal.events.some(
				(event) =>
					event.type === "write" &&
					event.data.includes("\x1b[45mmessage 3") &&
					event.data.includes("\x1b[45mdetail 3"),
			),
		);

		tui.scrollToTop();
		await terminal.waitForRender();
		streamedOutputLines = 1;
		tui.requestRender();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 6);
		assert.strictEqual(tui.isFollowingOutput, false);
		assert.ok(
			terminal.events.some(
				(event) =>
					event.type === "write" &&
					event.data.includes("\x1b[45mmessage 4") &&
					event.data.includes("\x1b[45mdetail 4"),
			),
		);

		streamedOutputLines = 2;
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 6);
		assert.strictEqual(tui.isFollowingOutput, false);

		terminal.resize(12, 3);
		await terminal.waitForRender();
		tui.scrollBy(3);
		const resizeEventCount = terminal.events.length;
		await terminal.waitForRender();
		const resizeWrites = terminal.events
			.slice(resizeEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(resizeWrites.includes("\x1b[45mdetail 4"));

		const clearEventCount = terminal.events.length;
		tui.clearPromptSelection({ followEnd: true });
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, true);
		const clearWrites = terminal.events
			.slice(clearEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(!clearWrites.includes("\x1b[45m"));
		tui.stop();
	});

	it("encodes arbitrary transcript entry IDs as zero-width APC markers", () => {
		const entryId = "entry:with\\control\x07 and Unicode 界";
		const marker = encodeTranscriptEntryMarker(entryId);

		assert.deepStrictEqual(decodeTranscriptEntryMarkerPrefix(`${marker}content`), {
			entryId,
			prefixLength: marker.length,
		});
		assert.strictEqual(visibleWidth(marker), 0);
		assert.strictEqual(stripTerminalSequences(`${marker}content`), "content");
	});

	it("restores semantic selection and viewport by entry ID after rows are inserted", async () => {
		const terminal = new VirtualTerminal(20, 2);
		let lines = [
			markedPrompt("entry-1", "message one"),
			"detail one",
			markedPrompt("entry-2", "message two"),
			"detail two",
			markedPrompt("entry-3", "message three"),
			"detail three",
		];
		const content = { render: () => lines, invalidate: () => {} };
		const tui = new TuiAltScreen(terminal);
		tui.setTranscriptSessionId("session-1");
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const state: TranscriptViewState = {
			sessionId: "session-1",
			selectedEntryId: "entry-2",
			viewportAnchor: { entryId: "entry-2", rowOffset: 1 },
			followingEnd: false,
			followSuppressed: true,
		};
		tui.restoreTranscriptViewState(state);
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.captureTranscriptViewState(), state);
		assert.strictEqual(tui.viewportTop, 3);

		lines = [markedPrompt("entry-0", "inserted"), "inserted detail", ...lines];
		tui.restoreTranscriptViewState(state);
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.captureTranscriptViewState(), state);
		assert.strictEqual(tui.viewportTop, 5);
		tui.stop();
	});

	it("preserves a viewport above the first transcript entry with a negative entry offset", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const content = new Text(
			["header", "resources", markedPrompt("entry-1", "message one"), "detail one", "tail"].join("\n"),
			0,
			0,
		);
		const tui = new TuiAltScreen(terminal);
		tui.setTranscriptSessionId("session-1");
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const state: TranscriptViewState = {
			sessionId: "session-1",
			viewportAnchor: { entryId: "entry-1", rowOffset: -2 },
			followingEnd: false,
			followSuppressed: true,
		};
		tui.restoreTranscriptViewState(state);
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, 0);
		assert.deepStrictEqual(tui.captureTranscriptViewState(), state);
		tui.stop();
	});

	it("keeps a viewport at the end detached from follow mode", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.setTranscriptSessionId("session-1");
		tui.addChild(
			new Text(
				[
					markedPrompt("entry-1", "message one"),
					"detail one",
					markedPrompt("entry-2", "message two"),
					"detail two",
				].join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		const state: TranscriptViewState = {
			sessionId: "session-1",
			viewportAnchor: { entryId: "entry-2", rowOffset: 0 },
			followingEnd: false,
			followSuppressed: false,
		};
		tui.restoreTranscriptViewState(state);
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, 2);
		assert.deepStrictEqual(tui.captureTranscriptViewState(), state);
		tui.stop();
	});

	it("clears missing selection independently while retaining a surviving viewport anchor", async () => {
		const terminal = new VirtualTerminal(20, 2);
		let lines = [
			markedPrompt("selected", "selected"),
			"selected detail",
			markedPrompt("anchor", "anchor"),
			"anchor detail",
			markedPrompt("tail", "tail"),
			"tail detail",
		];
		const content = { render: () => lines, invalidate: () => {} };
		const tui = new TuiAltScreen(terminal);
		tui.setTranscriptSessionId("session-1");
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		lines = lines.slice(2);
		tui.restoreTranscriptViewState({
			sessionId: "session-1",
			selectedEntryId: "selected",
			viewportAnchor: { entryId: "anchor", rowOffset: 1 },
			followingEnd: false,
			followSuppressed: true,
		});
		await terminal.waitForRender();

		assert.deepStrictEqual(tui.captureTranscriptViewState(), {
			sessionId: "session-1",
			viewportAnchor: { entryId: "anchor", rowOffset: 1 },
			followingEnd: false,
			followSuppressed: true,
		});
		assert.strictEqual(tui.viewportTop, 1);
		tui.stop();
	});

	it("restores search by entry identity and occurrence", async () => {
		const terminal = new VirtualTerminal(30, 3);
		let lines = [
			markedPrompt("entry-1", "needle first"),
			markedPrompt("entry-2", "needle second needle"),
			markedPrompt("entry-3", "needle third"),
			"tail",
		];
		const content = { render: () => lines, invalidate: () => {} };
		const tui = new TuiAltScreen(terminal);
		tui.setTranscriptSessionId("session-1");
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const state: TranscriptViewState = {
			sessionId: "session-1",
			viewportAnchor: { entryId: "entry-2", rowOffset: 0 },
			followingEnd: false,
			followSuppressed: true,
			search: { query: "needle", current: { entryId: "entry-2", occurrence: 1 } },
		};
		tui.restoreTranscriptViewState(state);
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.captureTranscriptViewState(), state);

		lines = [markedPrompt("inserted", "needle inserted"), ...lines];
		tui.restoreTranscriptViewState(state);
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.captureTranscriptViewState(), state);
		tui.stop();
	});

	it("rejects transcript state from another session and removes markers from terminal output", async () => {
		const terminal = new RecordingTerminal(30, 2);
		const marker = encodeTranscriptEntryMarker("entry-1");
		const tui = new TuiAltScreen(terminal);
		tui.setTranscriptSessionId("session-2");
		tui.addChild(new Text(`${markedPrompt("entry-1", "visible")}\ndetail`, 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.restoreTranscriptViewState({
			sessionId: "session-1",
			selectedEntryId: "entry-1",
			viewportAnchor: { entryId: "entry-1", rowOffset: 0 },
			followingEnd: false,
			followSuppressed: true,
			search: { query: "visible", current: { entryId: "entry-1", occurrence: 0 } },
		});
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.captureTranscriptViewState(), {
			sessionId: "session-2",
			viewportAnchor: { entryId: "entry-1", rowOffset: 0 },
			followingEnd: true,
			followSuppressed: false,
		});
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes(marker)));

		tui.stop();
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes(marker)));
	});

	it("does not emit Kitty graphics commands or OSC 133 zones in iTerm2", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			tui.addChild({
				render: () => ["\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07content"],
				invalidate: () => {},
			});
			tui.addChild(
				new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ filename: "example.png" },
					{ widthPx: 10, heightPx: 10 },
				),
			);
			tui.start();
			await terminal.waitForRender();
			tui.stop();
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b_G")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]133;")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]1337;File=")));
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("[Image:")));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("clears stale iTerm2 image placements when they leave the viewport", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			const imageLine = "\x1b]1337;File=inline=1;width=2;height=auto:AAAA\x07";
			tui.addChild({
				render: () => [imageLine, "", "", "after", "more", "end"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			const eventCount = terminal.events.length;

			tui.scrollBy(1);
			await terminal.waitForRender();
			assert.ok(
				terminal.events.slice(eventCount).some((event) => event.type === "write" && event.data.includes("\x1b[2J")),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("crops a Kitty image whose first line is above the viewport", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const imageId = 123;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		tui.addChild({
			render: () => ["before", imageLine, "", "", "after", "end"],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, 3);
		assert.ok(
			terminal.events.some(
				(event) => event.type === "write" && event.data.includes("i=123") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		tui.stop();
	});

	it("reuses moved Kitty images without dropping HStack siblings", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const label = new Text("left", 0, 0);
			const image = new Image(
				"A".repeat(8192),
				"image/png",
				{ fallbackColor: (value) => value },
				{},
				{ widthPx: 100, heightPx: 100 },
			);
			const header = new Text("header", 0, 0);
			const row = new HStack([
				{ component: label, basis: 10 },
				{ component: image, basis: 10 },
			]);
			tui.setLayoutRoot(
				new VStack([
					{ component: header, basis: "auto" },
					{ component: row, basis: 4 },
				]),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			label.setText("changed");
			header.setText("header\nsecond");
			tui.requestRender();
			await terminal.waitForRender();
			const redrawWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
			assert.ok(redrawWrites.length < 2000, `expected placement-only redraw, got ${redrawWrites.length} bytes`);
			assert.ok(terminal.getViewport().some((line) => line.trimEnd() === "changed"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retains recently offscreen Kitty images for placement-only reuse", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 321;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => [imageLine, "after"],
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			tui.scrollBy(1);
			await terminal.waitForRender();
			tui.scrollBy(-1);
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=p,q=2"));
			assert.ok(!reentryWrites.includes("\x1b_Ga=T"));
			assert.ok(!reentryWrites.includes(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts the least recently visible Kitty image when the cache is full", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 500;
			const imageLines = Array.from({ length: 18 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);

			const eventCount = terminal.events.length;
			tui.scrollToTop();
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=T"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts offscreen Kitty images when decoded raster memory exceeds the cache quota", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 600;
			const imageLines = Array.from({ length: 4 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 3840, heightPx: 2160 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("opens an OSC 8 hyperlink with specific or generic release codes, but not on drag", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const openedUrls: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => openedUrls.push(url),
		});
		const url = "https://example.com/path?q=1";
		const belUrl = "https://example.com/bel";
		const emojiUrl = "https://example.com/emoji";
		tui.addChild(
			new Text(
				`${hyperlink("link", url)}\n\x1b]8;;${belUrl}\x07link\x1b]8;;\x07\n${hyperlink("🙂", emojiUrl)}`,
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<3;2;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url]);

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl]);

		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		tui.stop();
	});

	it("selects visible text with the mouse and silently copies it with OSC 52 after a generic release", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("\x1b[1mal\x1b[0mpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<3;4;2m");
		await terminal.waitForRender();

		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from("alpha\nbeta").toString("base64")}\x07`;
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.ok(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(clipboardWrites),
		);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("al\x1b[0m\x1b[7mpha")),
			"selection inverse must be reapplied after a reset inside the selection",
		);
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copied!")));

		tui.stop();
	});

	it("uses an injected copySelection handler instead of OSC 52 without flashing success", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.ok(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			"must not emit OSC 52 when a copySelection handler is provided",
		);
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copied!")));

		tui.stop();
	});

	it("keeps automatic primary copying separate from explicit clipboard copying", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const primaryCopies: string[] = [];
		const clipboardCopies: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelectionOnSelect: async (text) => {
				primaryCopies.push(text);
				return true;
			},
			copySelection: async (text) => {
				clipboardCopies.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(primaryCopies, ["alpha\nbeta"]);
		assert.deepStrictEqual(clipboardCopies, []);
		assert.strictEqual(tui.hasActiveSelection(), true);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7malpha")));
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copied!")));

		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		await terminal.waitForRender();
		assert.deepStrictEqual(clipboardCopies, ["alpha\nbeta"]);
		assert.strictEqual(tui.hasActiveSelection(), true);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("leaves selections visible without copying when copyOnSelect is disabled", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, []);
		assert.strictEqual(tui.hasActiveSelection(), true);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copied!")));

		tui.stop();
	});

	it("copies an active selection programmatically", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.hasActiveSelection(), false);
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.strictEqual(tui.hasActiveSelection(), true);

		copied.length = 0;
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("flashes an error when the injected copySelection handler fails", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async () => false,
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("Copy failed")));
		assert.ok(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			"must not emit OSC 52 when a copySelection handler is provided",
		);

		tui.stop();
	});

	it("flashes a specific error returned by the injected copySelection handler", async () => {
		// Regression test for #9618.
		const terminal = new RecordingTerminal(80, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async () => "Clipboard unavailable: install wl-clipboard",
		});
		let flashDuration: number | undefined;
		const flash = tui.flash.bind(tui);
		tui.flash = (message, durationMs) => {
			flashDuration = durationMs;
			flash(message, durationMs);
		};
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("Clipboard unavailable: install wl-clipboard")));
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copy failed")));
		assert.strictEqual(flashDuration, 5000);
		tui.stop();
	});

	it("does not append whitespace to double-click word highlighting", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;3;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo\x1b[27m")));
		tui.stop();
	});

	it("coalesces slash and hyphen separated segments for double-click word selection", async () => {
		for (const { line, needle } of [
			{ line: "extensions/starline/fixed-editor/compositor.ts", needle: "starline" },
			{ line: "earendil-works/pi-tui", needle: "works" },
		]) {
			const copied: string[] = [];
			const terminal = new RecordingTerminal(80, 1);
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text(line, 0, 0));
			tui.start();
			await terminal.waitForRender();

			const oneBasedClickColumn = line.indexOf(needle) + 1;
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			await terminal.waitForRender();

			assert.deepStrictEqual(copied, [line]);
			tui.stop();
		}
	});

	it("highlights a complete whitespace segment during a word drag", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo  \x1b[27m")));
		tui.stop();
	});

	it("selects whole words on double click, extends word drags, and selects lines on triple click", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("zero alpha beta\ngamma delta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// The second click lands on a different character in alpha.
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<0;10;1m");
		await terminal.waitForRender();
		const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(alpha)));

		// A double-click drag includes each word touched, rather than partial words.
		terminal.sendInput("\x1b[<0;12;1M");
		terminal.sendInput("\x1b[<0;12;1m");
		terminal.sendInput("\x1b[<0;14;1M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		const words = `\x1b]52;c;${Buffer.from("beta\ngamma").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(words)));

		terminal.sendInput("\x1b[<0;7;2M");
		terminal.sendInput("\x1b[<0;7;2m");
		terminal.sendInput("\x1b[<0;9;2M");
		terminal.sendInput("\x1b[<0;9;2m");
		terminal.sendInput("\x1b[<0;11;2M");
		terminal.sendInput("\x1b[<0;11;2m");
		await terminal.waitForRender();
		const line = `\x1b]52;c;${Buffer.from("gamma delta").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(line)));

		tui.stop();
	});

	it("does not repaint idle or zero-width selections on focus loss", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const writeCount = () => terminal.events.filter((event) => event.type === "write").length;
		const clipboardWriteCount = () =>
			terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;")).length;

		const idleWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(writeCount(), idleWriteCount);

		// A completed click leaves a zero-width anchor, but later orphaned drag/release events must not extend it.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);

		// Losing focus after a press without a drag cancels the press without repainting.
		terminal.sendInput("\x1b[<0;1;3M");
		await terminal.waitForRender();
		const pressedWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(writeCount(), pressedWriteCount);
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004h")));

		tui.stop();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004l")));
	});

	it("clears an active visible selection on focus loss and ignores orphan events", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		await terminal.waitForRender();
		const focusLossEventCount = terminal.events.length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		const focusLossWrites = terminal.events
			.slice(focusLossEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(focusLossWrites.includes("alpha"));
		assert.ok(focusLossWrites.includes("beta"));
		assert.ok(!focusLossWrites.includes("\x1b[7m"));

		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("retains a completed visible selection across focus changes", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		const completedWriteCount = terminal.events.filter((event) => event.type === "write").length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, completedWriteCount);

		const redrawEventCount = terminal.events.length;
		tui.renderNow(true);
		const redrawWrites = terminal.events
			.slice(redrawEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(redrawWrites.includes("alpha"));
		assert.ok(redrawWrites.includes("beta"));
		assert.ok(redrawWrites.includes("\x1b[7m"));
		tui.stop();
	});

	it("stacks flash messages and collapses them as they expire", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.flash("First", 80);
		tui.flash("Second", 500);
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" First "));
		assert.ok(viewport[1]?.endsWith(" Second "));

		await new Promise((resolve) => setTimeout(resolve, 100));
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" Second "));
		assert.ok(!viewport.some((line) => line.includes("First")));

		tui.stop();
	});

	it("auto-scrolls and extends a drag selection held at the viewport edge", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 6);

		terminal.sendInput("\x1b[<0;1;3M");
		terminal.sendInput("\x1b[<32;1;1M");
		await new Promise((resolve) => setTimeout(resolve, 130));
		await terminal.waitForRender();

		const selectionTop = tui.viewportTop;
		assert.ok(selectionTop < 6, `expected auto-scroll above row 6, got ${selectionTop}`);
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		const selectedLines = Array.from({ length: 8 - selectionTop }, (_, index) => `line ${selectionTop + index + 1}`);
		selectedLines.push("l");
		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from(selectedLines.join("\n")).toString("base64")}\x07`;
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;"))),
		);
		tui.stop();
	});

	it("snaps mouse selection to CJK, emoji, and combining grapheme boundaries", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("A界🙂éZ", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const wideSelection = `\x1b]52;c;${Buffer.from("界🙂").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			1,
		);

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<32;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			2,
		);

		const combiningSelection = `\x1b]52;c;${Buffer.from("éZ").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<32;7;1M");
		terminal.sendInput("\x1b[<0;7;1m");
		await terminal.waitForRender();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(combiningSelection)));

		tui.stop();
	});

	it("ignores horizontal trackpad wheel events", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<66;1;1M");
		terminal.sendInput("\x1b[<67;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8"],
		);

		tui.stop();
	});

	it("dispatches clicks to nested mouse regions without breaking drag selection", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let clicks = 0;
		tui.addChild(
			new MouseRegion(new Text("clickable\nselectable", 0, 0), (event) => {
				if (event.type !== "click") return undefined;
				clicks += 1;
				return { handled: true };
			}),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(clicks, 1);

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clicks, 1);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("focuses and captures drag gestures for mouse-aware components", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		const events: string[] = [];
		const component = {
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				events.push(event.type);
				return event.type === "press" ? { handled: true, capture: true, focus: true } : { handled: true };
			},
		};
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(events, ["press", "drag", "release"]);
		assert.strictEqual(tui.getFocusedComponent(), component);
		tui.stop();
	});

	it("reports consecutive click counts to component-owned controls", async () => {
		const terminal = new VirtualTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		const clickCounts: number[] = [];
		tui.addChild({
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type === "press") return { handled: true };
				if (event.type === "click") {
					clickCounts.push(event.clickCount ?? 0);
					return { handled: true };
				}
				return undefined;
			},
		});
		tui.start();
		await terminal.waitForRender();

		for (let count = 0; count < 3; count++) {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<0;1;1m");
		}
		await terminal.waitForRender();
		assert.deepStrictEqual(clickCounts, [1, 2, 3]);
		tui.stop();
	});

	it("does not rerender for handled no-op pointer motion", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let renderCount = 0;
		tui.addChild({
			render: () => {
				renderCount += 1;
				return ["hover target"];
			},
			invalidate: () => {},
			handleMouse: (event) => (event.type === "move" ? { handled: true } : undefined),
		});
		tui.start();
		await terminal.waitForRender();
		const renderedBeforeMotion = renderCount;
		const writesBeforeMotion = terminal.events.filter((event) => event.type === "write").length;

		terminal.sendInput("\x1b[<35;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(renderCount, renderedBeforeMotion);
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, writesBeforeMotion);
		tui.stop();
	});

	it("lets mouse-aware components consume wheel events before viewport scrolling", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		let wheelEvents = 0;
		tui.addChild(
			new MouseRegion(
				new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
				(event) => {
					if (event.type !== "wheel") return undefined;
					wheelEvents += 1;
					return { handled: true };
				},
			),
		);
		tui.start();
		await terminal.waitForRender();
		const viewportTop = tui.viewportTop;

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(wheelEvents, 1);
		assert.strictEqual(tui.viewportTop, viewportTop);
		tui.stop();
	});

	it("restores keyboard state before leaving alt mode and prints the full document", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("first\nsecond\nthird\nfourth\nfifth\nsixth", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const startIndex = terminal.events.findIndex((event) => event.type === "start");
		const altScreenEnterIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049h"),
		);
		const stopIndex = terminal.events.findIndex((event) => event.type === "stop");
		const mouseDisableIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1006l"),
		);
		const mainScreenRestoreIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049l"),
		);
		assert.ok(altScreenEnterIndex >= 0 && altScreenEnterIndex < startIndex);
		assert.ok(mouseDisableIndex >= 0 && mouseDisableIndex < stopIndex);
		assert.ok(mainScreenRestoreIndex > stopIndex);

		const restoreEvent = terminal.events[mainScreenRestoreIndex];
		assert.strictEqual(restoreEvent?.type, "write");
		if (restoreEvent?.type === "write") {
			assert.ok(restoreEvent.data.includes("first"));
			assert.ok(restoreEvent.data.includes("second"));
			assert.ok(restoreEvent.data.includes("third"));
			assert.ok(restoreEvent.data.includes("fourth"));
			assert.ok(restoreEvent.data.includes("fifth"));
			assert.ok(restoreEvent.data.includes("sixth"));
			assert.ok(restoreEvent.data.indexOf("first") < restoreEvent.data.indexOf("sixth"));
		}
	});

	it("gives wheel and viewport keys to a focused overlay", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		const overlay = new InputOverlay();
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;
		const handle = tui.showOverlay(overlay);
		await terminal.waitForRender();
		assert.strictEqual(overlay.focused, true);

		const wheel = "\x1b[<64;10;3M";
		const keys = ["\x1b[5~", "\x1b[6~", "\x1bOH", "\x1bOF", wheel];
		for (const key of keys) terminal.sendInput(key);
		await terminal.waitForRender();

		assert.deepStrictEqual(overlay.inputs, keys);
		assert.strictEqual(tui.viewportTop, topBefore);

		handle.hide();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		tui.stop();
	});

	it("keeps viewport scrolling when an overlay is not focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new InputOverlay();
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		const hidden = tui.showOverlay(new InputOverlay());
		hidden.setHidden(true);
		const nonCapturing = new InputOverlay();
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		const unfocused = new InputOverlay();
		const unfocusedHandle = tui.showOverlay(unfocused);
		unfocusedHandle.unfocus();
		await terminal.waitForRender();
		assert.strictEqual(nonCapturing.focused, false);
		assert.strictEqual(unfocused.focused, false);

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;10;3M");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		assert.deepStrictEqual(nonCapturing.inputs, []);
		assert.deepStrictEqual(unfocused.inputs, []);
		tui.stop();
	});

	it("keeps viewport scrolling while transcript search is focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));
		tui.stop();
	});
});
