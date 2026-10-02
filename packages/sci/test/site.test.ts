import { describe, expect, it } from "vitest";
import { inline, markdown } from "../../../tools/site/markdown.ts";

// The docs pages of a built site (tools/site): Markdown to HTML.

describe("markdown", () => {
  it("renders the blocks the docs use", () => {
    const { html, title } = markdown(`# The script language

A paragraph that goes
on a second line.

## Sends

| form | what |
|---|---|
| \`(x y:)\` | a send, with a \\| bar |

- one
- two
  continued

1. first
2. second

\`\`\`lisp
(if (< a b) "yes")
\`\`\`

> quoted
`);
    expect(title).toBe("The script language");
    expect(html).toContain('<h1 id="the-script-language">The script language</h1>');
    expect(html).toContain("<p>A paragraph that goes on a second line.</p>");
    expect(html).toContain('<h2 id="sends">Sends</h2>');
    expect(html).toContain("<tr><td><code>(x y:)</code></td><td>a send, with a | bar</td></tr>");
    expect(html).toContain("<ul><li>one</li><li>two continued</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain('<pre><code class="language-lisp">(if (&lt; a b) &quot;yes&quot;)</code></pre>');
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("links .md files to their pages, and escapes everything else", () => {
    expect(inline("See [games](docs/games.md#rooms), [the README](../README.md) and [site](https://x.dev/a.md).")).toBe(
      'See <a href="docs/games.html#rooms">games</a>, <a href="../index.html">the README</a> and <a href="https://x.dev/a.md">site</a>.',
    );
    expect(inline("**bold**, *italic*, `<code>` and <b>")).toBe("<strong>bold</strong>, <em>italic</em>, <code>&lt;code&gt;</code> and &lt;b&gt;");
    expect(inline("![hello](screenshots/hello.png)")).toBe('<img src="screenshots/hello.png" alt="hello">');
    // Asterisks in code and multiplication aren't emphasis.
    expect(inline("`a * b` and 2 * 3")).toBe("<code>a * b</code> and 2 * 3");
  });

  it("treats a stray | line as a paragraph", () => {
    expect(markdown("| not a table").html).toBe("<p>| not a table</p>");
  });
});

describe("a built site's game version", () => {
  it("changes when any game file does, and only then", async () => {
    const { buildVersion } = await import("../../../tools/site/build.ts");
    const files = { "RESOURCE.MAP": Uint8Array.from([1, 2, 3]), "RESOURCE.000": Uint8Array.from([4, 5]) };
    const v = buildVersion(files);
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(buildVersion({ "RESOURCE.000": Uint8Array.from([4, 5]), "RESOURCE.MAP": Uint8Array.from([1, 2, 3]) })).toBe(v);
    expect(buildVersion({ ...files, "RESOURCE.000": Uint8Array.from([4, 6]) })).not.toBe(v);
  });
});
