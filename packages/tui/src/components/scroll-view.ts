import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

export type ScrollViewScrollbar = "hidden" | "auto" | "always";

export interface ScrollViewOptions {
	axis?: "vertical";
	follow?: "none" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarTrackStyle?: (text: string) => string;
	scrollbarThumbStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
}

export interface ScrollViewScrollToOptions {
	/** Keep follow-end disabled across later content and viewport reflow. */
	disableFollow?: boolean;
}

export class ScrollView extends Container {
	private readonly child: Component;
	readonly followEnd: boolean;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarTrackStyle: (text: string) => string;
	readonly scrollbarThumbStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	private currentScrollTop = 0;
	private contentHeight = 0;
	private currentViewportHeight = 0;
	private followingEnd: boolean;
	private followSuppressed = false;
	private viewportPreserved = false;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;

	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		this.child = component;
		this.children.push(component);
		this.followEnd = (options.follow ?? "none") === "end";
		this.followingEnd = this.followEnd;
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.currentScrollbar = options.scrollbar ?? "hidden";
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => `\x1b[90m${text}\x1b[39m`);
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => `\x1b[37m${text}\x1b[39m`);
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	get scrollTop(): number {
		return this.currentScrollTop;
	}

	get isFollowingEnd(): boolean {
		return this.followingEnd;
	}

	get isAtEnd(): boolean {
		return this.currentScrollTop >= Math.max(0, this.contentHeight - this.currentViewportHeight);
	}

	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return (
			this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible
		);
	}

	get isScrollbarActive(): boolean {
		return this.scrollbarActive;
	}

	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	clearFollowSuppression(): void {
		if (!this.followSuppressed) return;
		this.followSuppressed = false;
		const wasFollowingEnd = this.followingEnd;
		this.followingEnd = this.followEnd && this.isAtEnd && !this.viewportPreserved;
		if (this.followingEnd !== wasFollowingEnd) this.requestRenderCallback?.();
	}

	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	private markScrollbarActivity(): void {
		if (this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight) return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		const nextFollowSuppressed = options.disableFollow === true;
		const nextFollowingEnd = !nextFollowSuppressed && this.followEnd && next === maxScrollTop;
		if (
			next === this.currentScrollTop &&
			nextFollowingEnd === this.followingEnd &&
			nextFollowSuppressed === this.followSuppressed &&
			!this.viewportPreserved
		) {
			return;
		}
		const moved = next !== this.currentScrollTop;
		this.currentScrollTop = next;
		this.followingEnd = nextFollowingEnd;
		this.followSuppressed = nextFollowSuppressed;
		this.viewportPreserved = false;
		if (moved) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	preserveViewport(): void {
		const changed = this.followingEnd || !this.viewportPreserved;
		this.followingEnd = false;
		this.viewportPreserved = true;
		if (changed) this.requestRenderCallback?.();
	}

	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const start = this.followingEnd ? maxScrollTop : Math.min(maxScrollTop, this.currentScrollTop);
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		const moved = next - start;
		const wasFollowingEnd = this.followingEnd;
		const wasViewportPreserved = this.viewportPreserved;
		this.currentScrollTop = next;
		if (moved !== 0 && next === maxScrollTop) this.followSuppressed = false;
		this.followingEnd = this.followEnd && next === maxScrollTop && !this.followSuppressed;
		this.viewportPreserved = false;
		if (moved !== 0) this.markScrollbarActivity();
		if (moved !== 0 || this.followingEnd !== wasFollowingEnd || wasViewportPreserved) this.requestRenderCallback?.();
		return requested - moved;
	}

	scrollToStart(): void {
		const nextFollowingEnd =
			this.followEnd && this.contentHeight <= this.currentViewportHeight && !this.followSuppressed;
		const changed = this.currentScrollTop !== 0 || this.followingEnd !== nextFollowingEnd || this.viewportPreserved;
		this.currentScrollTop = 0;
		this.followingEnd = nextFollowingEnd;
		this.viewportPreserved = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	scrollToEnd(): void {
		const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const changed =
			this.currentScrollTop !== next ||
			this.followingEnd !== this.followEnd ||
			this.followSuppressed ||
			this.viewportPreserved;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd;
		this.followSuppressed = false;
		this.viewportPreserved = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		if (this.followingEnd) this.currentScrollTop = maxScrollTop;
		else if (this.viewportPreserved) this.currentScrollTop = Math.max(0, this.currentScrollTop);
		else this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		this.followingEnd =
			this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressed && !this.viewportPreserved;
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	override render(width: number): string[] {
		const contentWidth = this.getContentWidth(width);
		const lines = this.child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this };
	}
}
