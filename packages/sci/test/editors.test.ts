import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The VS Code extension (editors/vscode): its files parse and its patterns compile.

const read = (f: string) => JSON.parse(readFileSync(`editors/vscode/${f}`, "utf8"));

describe("the VS Code extension", () => {
  it("declares the language and its grammar", () => {
    const pkg = read("package.json");
    expect(pkg.contributes.languages[0].extensions).toEqual([".sc"]);
    expect(pkg.contributes.grammars[0].path).toBe("./syntaxes/sci.tmLanguage.json");
    expect(read("language-configuration.json").comments.lineComment).toBe(";");
  });

  it("has patterns that compile, and tell a selector from a class and a constant", () => {
    const grammar = read("syntaxes/sci.tmLanguage.json");
    const patterns: { name: string; match?: string; begin?: string; end?: string }[] = grammar.patterns;
    for (const p of patterns) for (const re of [p.match, p.begin, p.end]) if (re) expect(() => new RegExp(re), p.name).not.toThrow();
    const scope = (text: string) => patterns.find((p) => p.match && new RegExp(`^(?:${p.match})$`).test(text))?.name;
    expect(scope("init:")).toMatch(/selector/);
    expect(scope("Actor")).toMatch(/class/);
    expect(scope("V_LOOK")).toMatch(/define/);
    expect(scope("#doit")).toMatch(/selector/);
    expect(scope("$7fff")).toMatch(/numeric/);
  });
});
