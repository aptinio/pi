import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type RebindContext = {
	session: object;
	unsubscribe?: () => void;
	unsubscribePersistedEntries?: () => void;
	transcriptExpansionStateSessionId: string;
	getTranscriptSessionId: () => string;
	renderer: object;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: (preservePresentationState: boolean) => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	subscribeToAgent: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type InteractiveModePrototype = {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("overlapping startup and replacement session rebinds", () => {
	it("does not subscribe from the stale startup rebind", async () => {
		const startupSession = {};
		const replacementSession = {};
		let resolveStartupBind!: () => void;
		let resolveReplacementBind!: () => void;

		const startupBind = new Promise<void>((resolve) => {
			resolveStartupBind = resolve;
		});
		const replacementBind = new Promise<void>((resolve) => {
			resolveReplacementBind = resolve;
		});

		const subscribeToAgent = vi.fn();
		const updateTerminalTitle = vi.fn();
		let bindCount = 0;
		const sessionIds = new Map<object, string>([
			[startupSession, "startup"],
			[replacementSession, "replacement"],
		]);

		const context: RebindContext = {
			session: startupSession,
			transcriptExpansionStateSessionId: "startup",
			getTranscriptSessionId() {
				return sessionIds.get(this.session) ?? "unknown";
			},
			renderer: {},
			applyRuntimeSettings: () => {},
			renderCurrentSessionState: () => {},
			bindCurrentSessionExtensions: () => {
				bindCount += 1;
				return bindCount === 1 ? startupBind : replacementBind;
			},
			subscribeToAgent,
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle,
		};

		const startupRebind = interactiveModePrototype.rebindCurrentSession.call(context);
		expect(bindCount).toBe(1);

		context.session = replacementSession;
		const replacementRebind = interactiveModePrototype.rebindCurrentSession.call(context, {
			renderBeforeBind: true,
		});

		expect(bindCount).toBe(2);
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);

		resolveStartupBind();
		await startupRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).not.toHaveBeenCalled();

		resolveReplacementBind();
		await replacementRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);
	});
});
