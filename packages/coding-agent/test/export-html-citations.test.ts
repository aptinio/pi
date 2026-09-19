import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type CitationRenderer = (annotations: unknown) => string;

function loadCitationRenderer(templateJs: string): CitationRenderer {
	const start = templateJs.indexOf("function escapeHtml");
	const end = templateJs.indexOf("/**\n       * Truncate string", start);
	if (start < 0 || end < 0) throw new Error("Citation renderer helpers not found in export template");
	return new Function(`"use strict"; ${templateJs.slice(start, end)}; return renderCitations;`)() as CitationRenderer;
}

describe("export HTML URL citations", () => {
	const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
		scripts: Record<string, string>;
	};
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const templateCss = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

	it("renders persisted assistant text annotations as a source list", () => {
		expect(templateJs).toMatch(/function renderCitations\s*\(/);
		expect(templateJs).toContain("renderCitations(block.annotations)");
		expect(templateJs).toContain("citation-sources");
		expect(templateCss).toMatch(/\.citation-sources\s*\{/);
	});

	it("copies citation renderer assets beside the compiled binary", () => {
		expect(packageJson.scripts["copy-binary-assets"]).toContain(
			"src/core/export-html/template.html src/core/export-html/template.css src/core/export-html/template.js dist/export-html/",
		);
	});

	it("sanitizes and escapes citation URLs and titles", () => {
		const renderCitations = loadCitationRenderer(templateJs);
		const html = renderCitations([
			{
				type: "url_citation",
				url: 'https://example.com/?a=1&b="quoted"',
				title: '"><img src=x onerror=alert(1)>',
			},
			{
				type: "url_citation",
				url: "javascript:alert(1)",
				title: "Unsafe <source>",
			},
		]);

		expect(html).toContain('<a href="https://example.com/?a=1&amp;b=&quot;quoted&quot;" rel="noreferrer">');
		expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</a>");
		expect(html).toContain("<li>Unsafe &lt;source&gt;</li>");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("<img");
	});
});
