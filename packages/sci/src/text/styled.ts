import { advanceOf, type Font, type Glyph } from "./font.ts";

/**
 * Text with styles in it, as SCI32 writes them: `|f3|` switches to font 3 and `|f|` back to
 * the text's own; `|c5|` and `|c|` do the same for the colour. A word whose style changes
 * part-way through is still one word, and the codes take no room.
 */
export interface StyledChar {
  ch: string;
  font: number;
  /** A colour of its own, or undefined for the text's. */
  color?: number;
}

const CODE = /\|([fc])(\d*)\|/y;

export function parseStyled(text: string, font: number): StyledChar[] {
  const out: StyledChar[] = [];
  let f = font, color: number | undefined;
  for (let i = 0; i < text.length; ) {
    CODE.lastIndex = i;
    const m = text[i] === "|" ? CODE.exec(text) : null;
    if (m) {
      if (m[1] === "f") f = m[2] ? Number(m[2]) : font;
      else color = m[2] ? Number(m[2]) : undefined;
      i = CODE.lastIndex;
      continue;
    }
    out.push({ ch: text[i]!, font: f, ...(color === undefined ? {} : { color }) });
    i++;
  }
  return out;
}

/** The text without its codes. */
export const plainOf = (text: string) => text.replace(/\|[fc]\d*\|/g, "");

type FontOf = (n: number) => Font;
const glyphOf = (fontOf: FontOf, c: StyledChar): Glyph | undefined => fontOf(c.font).glyphs[c.ch.charCodeAt(0)];

/** The pen's travel over some characters: the sum of their advances. */
export function styledWidth(fontOf: FontOf, chars: StyledChar[]): number {
  return chars.reduce((w, c) => { const g = glyphOf(fontOf, c); return w + (g ? advanceOf(g) : 0); }, 0);
}

export interface StyledLine {
  chars: StyledChar[];
  /** The pen's travel: what wrapping and alignment go by. */
  width: number;
  /** The tallest font in it (the text's own if it's empty). */
  height: number;
}

/**
 * Lines no wider than maxWidth, breaking after spaces and at CR/LF, each character measured
 * in its own font. A word too long for a line gets a line of its own.
 */
export function wrapStyled(fontOf: FontOf, chars: StyledChar[], font: number, maxWidth: number): StyledLine[] {
  const lines: StyledLine[] = [];
  const finish = (line: StyledChar[]) => {
    while (line.length && line[line.length - 1]!.ch === " ") line.pop();
    lines.push({ chars: line, width: styledWidth(fontOf, line), height: Math.max(fontOf(font).height, ...line.map((c) => fontOf(c.font).height)) });
  };
  // Paragraphs, then words: a word is its letters and the spaces after them.
  const paragraphs: StyledChar[][] = [[]];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c.ch === "\r" || c.ch === "\n") {
      if (c.ch === "\r" && chars[i + 1]?.ch === "\n") i++;
      paragraphs.push([]);
    } else paragraphs[paragraphs.length - 1]!.push(c);
  }
  for (const paragraph of paragraphs) {
    const words: StyledChar[][] = [];
    let word: StyledChar[] = [];
    paragraph.forEach((c, i) => {
      word.push(c);
      if (c.ch === " " && paragraph[i + 1]?.ch !== " ") (words.push(word), (word = []));
    });
    if (word.length) words.push(word);
    let line: StyledChar[] = [];
    for (const w of words) {
      const trimmed = [...line, ...w];
      while (trimmed.length && trimmed[trimmed.length - 1]!.ch === " ") trimmed.pop();
      if (line.length && styledWidth(fontOf, trimmed) > maxWidth) {
        finish(line);
        line = [];
      }
      line.push(...w);
    }
    finish(line);
  }
  return lines;
}

/**
 * Where each character's ink goes: the pen starts at x (moved by alignment), and each glyph
 * is drawn at the pen plus its bearing, then the pen moves on by its advance.
 */
export function placeLine(fontOf: FontOf, line: StyledLine, x: number): { glyph: Glyph; x: number; color?: number }[] {
  const out: { glyph: Glyph; x: number; color?: number }[] = [];
  let pen = x;
  for (const c of line.chars) {
    const glyph = glyphOf(fontOf, c);
    if (!glyph) continue;
    out.push({ glyph, x: pen + (glyph.bearingX ?? 0), ...(c.color === undefined ? {} : { color: c.color }) });
    pen += advanceOf(glyph);
  }
  return out;
}
