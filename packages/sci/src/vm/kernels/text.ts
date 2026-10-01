import { ResourceType } from "../../resource/types.ts";
import { parseFont, textWidth, wrapText, type Font } from "../../text/font.ts";
import { hasRef, parseMessages, type MessageFile, type MessageTuple } from "../../text/message.ts";
import type { SciBitmap } from "../memory.ts";
import type { FrameRequest, KernelFn, SendRequest, Vm } from "../vm.ts";
import { NULL, fromInt, segmentOf, toSigned, type Value } from "../value.ts";
import { stringHelpers } from "./arrays.ts";
import { graphics, graphicsKernels } from "./graphics.ts";
import { EventType, SciKey, input } from "./system.ts";

const TextAlign = { Left: 0, Center: 1, Right: 2 } as const;

/** Per-VM text state: font and message caches plus the message cursor. */
class TextState {
  private readonly fonts = new Map<number, Font>();
  private readonly messages = new Map<number, MessageFile | null>();
  /** Message cursor stack: the current tuple, plus one entry per reference being followed. */
  cursor: MessageTuple[] = [];
  cursorModule = 0;
  private readonly saved: { module: number; stack: MessageTuple[] }[] = [];
  last: { module: number; tuple: MessageTuple } | undefined;

  constructor(private readonly vm: Vm) {}

  /** Drops parsed message files (their resources were replaced). */
  forgetMessages(): void {
    this.messages.clear();
  }

  font(n: number): Font {
    let f = this.fonts.get(n);
    if (!f) {
      const id = { type: ResourceType.Font, number: n };
      f = parseFont(this.vm.resources.loadSync(this.vm.resources.has(id) ? id : { type: ResourceType.Font, number: 0 }).data);
      this.fonts.set(n, f);
    }
    return f;
  }

  messageFile(module: number): MessageFile | undefined {
    if (!this.messages.has(module)) {
      const id = { type: ResourceType.Message, number: module };
      this.messages.set(module, this.vm.resources.has(id) ? parseMessages(this.vm.resources.loadSync(id).data) : null);
    }
    return this.messages.get(module) ?? undefined;
  }

  /**
   * Returns the next message at the cursor, following references (a record with a ref
   * pushes the referenced tuple; running off the end of a referenced sequence pops back).
   */
  next(): { talker: number; text: string } | undefined {
    const file = this.messageFile(this.cursorModule);
    for (let guard = 0; guard < 32 && file; guard++) {
      const t = this.cursor[this.cursor.length - 1];
      if (!t) return undefined;
      const rec = file.records.find((r) => r.noun === t.noun && r.verb === t.verb && r.cond === t.cond && r.seq === t.seq);
      if (!rec) {
        if (this.cursor.length > 1) {
          this.cursor.pop();
          continue;
        }
        return undefined;
      }
      if (hasRef(rec)) {
        t.seq++;
        this.cursor.push({ ...rec.ref });
        continue;
      }
      this.last = { module: this.cursorModule, tuple: { ...t } };
      t.seq++;
      return { talker: rec.talker, text: rec.text };
    }
    return undefined;
  }

  push(): void {
    this.saved.push({ module: this.cursorModule, stack: this.cursor.map((t) => ({ ...t })) });
  }

  pop(): void {
    const s = this.saved.pop();
    if (s) (this.cursorModule = s.module), (this.cursor = s.stack);
  }
}

const stateOf = new WeakMap<Vm, TextState>();
const text_ = (vm: Vm): TextState => text(vm);
const text = (vm: Vm): TextState => {
  let t = stateOf.get(vm);
  if (!t) stateOf.set(vm, (t = new TextState(vm)));
  return t;
};

/** For replaceResources: forget parsed message files. */
export const forgetMessages = (vm: Vm): void => text(vm).forgetMessages();

const prop = (vm: Vm, obj: Value, name: string) => toSigned(vm.getProp(obj, name) ?? 0);

/** Width used when a script asks for "default" wrapping (SCI32: 3/5 of the screen). */
const DEFAULT_MAX_WIDTH = (320 * 3) / 5;

/**
 * Sierra text escapes: `\xx` (two hex digits) is a character code, e.g. `\1d`/`\1e` are the
 * arrow glyphs on dialog scroll buttons.
 */
export const unescapeText = (s: string) => s.replace(/\\([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Draws wrapped text into a bitmap, inside `rect`, with alignment. */
function drawText(bmp: SciBitmap, font: Font, str: string, rect: { left: number; top: number; right: number; bottom: number }, color: number, align: number) {
  const width = rect.right - rect.left;
  const lines = wrapText(font, str, width);
  lines.forEach((line, row) => {
    const w = textWidth(font, line);
    let x = rect.left + (align === TextAlign.Center ? Math.floor((width - w) / 2) : align === TextAlign.Right ? width - w : 0);
    const y0 = rect.top + row * font.height;
    for (const ch of line) {
      const g = font.glyphs[ch.charCodeAt(0)];
      if (!g) continue;
      for (let gy = 0; gy < g.height; gy++) {
        const y = y0 + gy;
        if (y < rect.top || y >= rect.bottom || y >= bmp.height) continue;
        for (let gx = 0; gx < g.width; gx++) {
          const px = x + gx;
          if (g.pixels[gy * g.width + gx] && px >= 0 && px < bmp.width) bmp.pixels[y * bmp.width + px] = color;
        }
      }
      x += g.width;
    }
  });
}

function drawBorder(bmp: SciBitmap, color: number) {
  for (let x = 0; x < bmp.width; x++) (bmp.pixels[x] = color), (bmp.pixels[(bmp.height - 1) * bmp.width + x] = color);
  for (let y = 0; y < bmp.height; y++) (bmp.pixels[y * bmp.width] = color), (bmp.pixels[y * bmp.width + bmp.width - 1] = color);
}

/**
 * SCI32 text: scripts measure text (TextSize), render it into an off-screen bitmap
 * (CreateTextBitmap) and show that bitmap as a screen item via the object's `bitmap`.
 */
export const textKernels: Record<string, KernelFn> = {
  Message: (vm, [func = 0, ...args]) => {
    const t = text(vm);
    switch (func) {
      case 0: // get(module, noun, verb, cond, seq, buffer)
      case 2: { // size(module, noun, verb, cond, seq)
        const [module = 0, noun = 0, verb = 0, cond = 0, seq = 0, buffer = 0] = args;
        if (func === 2) {
          const saved = { cursor: t.cursor, module: t.cursorModule };
          t.cursorModule = module;
          t.cursor = [{ noun, verb, cond, seq }];
          const m = t.next();
          (t.cursor = saved.cursor), (t.cursorModule = saved.module);
          return m ? m.text.length + 1 : 0;
        }
        t.cursorModule = module;
        t.cursor = [{ noun, verb, cond, seq }];
        const m = t.next();
        if (buffer) stringHelpers.writeString(vm, buffer, m?.text ?? "");
        return m?.talker ?? 0;
      }
      case 1: { // next(buffer)
        const m = t.next();
        if (args[0]) stringHelpers.writeString(vm, args[0], m?.text ?? "");
        return m?.talker ?? 0;
      }
      // SCI32 dropped subop 3 and shifted the rest up by one.
      case 4: case 5: case 6: { // ref cond / verb / noun of (module, noun, verb, cond, seq)
        const [module = 0, noun = 0, verb = 0, cond = 0, seq = 0] = args;
        const rec = t.messageFile(module)?.records.find((r) => r.noun === noun && r.verb === verb && r.cond === cond && r.seq === seq);
        if (!rec || !hasRef(rec)) return 0xffff;
        return func === 4 ? rec.ref.cond : func === 5 ? rec.ref.verb : rec.ref.noun;
      }
      case 7: t.push(); return 0;
      case 8: t.pop(); return 0;
      case 9: { // last message → buffer: module, noun, verb, cond, seq (used to pick the voice clip)
        const buf = vm.memory.array(args[0] ?? 0);
        if (buf && t.last) buf.data.splice(0, 5, t.last.module, t.last.tuple.noun, t.last.tuple.verb, t.last.tuple.cond, t.last.tuple.seq);
        return NULL;
      }
    }
    return 0;
  },

  // TextSize(rectArray, text, font, maxWidth): writes [left, top, right, bottom] (inclusive).
  TextSize: (vm, [rect = 0, str = 0, fontNo = 0, maxWidth = 0]) => {
    const font = text(vm).font(fontNo);
    const s = stringHelpers.str(vm, str);
    let w: number, h: number;
    const max = toSigned(maxWidth);
    if (max >= 0) {
      const limit = max || DEFAULT_MAX_WIDTH;
      if (!/[\r\n]/.test(s) && textWidth(font, s) <= limit) {
        // Fits on one line: measured as-is, spaces included (a lone " " has a width).
        w = textWidth(font, s);
        h = font.height;
      } else {
        const lines = wrapText(font, s, limit);
        w = Math.min(limit, Math.max(0, ...lines.map((l) => textWidth(font, l))));
        h = lines.length * font.height;
      }
    } else {
      w = textWidth(font, s);
      h = font.height;
    }
    const a = stringHelpers.resolve(vm, rect);
    if (a) a.data.splice(0, 4, 0, 0, fromInt(w - 1), fromInt(h - 1));
    return 0;
  },
  TextWidth: (vm, [str = 0, fontNo = 0]) => textWidth(text(vm).font(fontNo), stringHelpers.str(vm, str)),
  PointSize: (vm, [fontNo = 0]) => text(vm).font(fontNo).height,
  TextFonts: () => 0,
  TextColors: () => 0,

  // CreateTextBitmap(0, width, height, textObject) → bitmap of that size;
  // CreateTextBitmap(1, textObject) → the text drawn over the object's own view cel.
  CreateTextBitmap: (vm, args) => {
    const [subop = 0] = args;
    const [width = 0, height = 0, obj = 0] = subop === 1 ? [0, 0, args[1] ?? 0] : args.slice(1);
    if (!vm.memory.object(obj)) return NULL;
    const w = Math.max(1, toSigned(width)), h = Math.max(1, toSigned(height));
    const str = unescapeText(stringHelpers.str(vm, vm.getProp(obj, "text") ?? 0));
    const font = text(vm).font(prop(vm, obj, "font"));
    const fore = prop(vm, obj, "fore") & 0xff;
    const align = prop(vm, obj, "mode");
    const rect = {
      left: prop(vm, obj, "textLeft"),
      top: prop(vm, obj, "textTop"),
      right: prop(vm, obj, "textRight") + 1,
      bottom: prop(vm, obj, "textBottom") + 1,
    };
    if (rect.right <= rect.left) (rect.left = 0), (rect.right = w);
    if (rect.bottom <= rect.top) (rect.top = 0), (rect.bottom = h);

    let ref: Value;
    if (subop === 0) {
      const back = prop(vm, obj, "back") & 0xff;
      const skip = prop(vm, obj, "skip") & 0xff;
      ref = vm.memory.newBitmap(w, h, back, skip);
      const border = prop(vm, obj, "borderColor");
      if (border >= 0) drawBorder(vm.memory.bitmap(ref)!, border & 0xff);
    } else {
      // Text over the object's view cel (e.g. a button face).
      const found = graphics(vm).cel(prop(vm, obj, "view"), prop(vm, obj, "loop"), prop(vm, obj, "cel"));
      const cw = found?.cel.width ?? w, ch = found?.cel.height ?? h;
      ref = vm.memory.newBitmap(cw, ch, found?.cel.skipColor ?? 0, found?.cel.skipColor ?? 0);
      if (found) vm.memory.bitmap(ref)!.pixels.set(found.cel.pixels);
    }
    drawText(vm.memory.bitmap(ref)!, font, str, rect, fore, align);
    return ref;
  },

  /**
   * EditText(control): the kernel's modal line editor (save descriptions, names, numbers). It
   * shows the control as its own screen item, takes keys until something ends the editing,
   * writes the text back, and returns 1 if it changed. Runs as a native generator that yields
   * a frame per iteration so the browser keeps drawing and delivering input.
   *
   * Like SSCI (ScummVM's kernelEditText: "the last event needs to be allowed to dispatch a
   * second time"), it only peeks at the event that ends editing (Enter, Escape, Tab,
   * Shift-Tab, Up, Down, or a click outside the field) and leaves it queued, so the dialog
   * handles it too: one Enter both finishes the text and confirms.
   */
  *EditText(vm: Vm, [obj = 0]: Value[]): Generator<SendRequest | FrameRequest, Value, Value> {
    if (!vm.memory.object(obj)) return 0;
    const g = graphics(vm);
    const inp = input(vm);
    const textRef = vm.getProp(obj, "text") ?? 0;
    const original = stringHelpers.str(vm, textRef);
    let text = original;
    const maxLength = Math.max(1, prop(vm, obj, "width") || 255);
    const font = text_(vm).font(prop(vm, obj, "font"));
    const fore = prop(vm, obj, "fore") & 0xff;
    const back = prop(vm, obj, "back") & 0xff;
    const skip = prop(vm, obj, "skip") & 0xff;
    const border = prop(vm, obj, "borderColor");
    const width = Math.max(8, prop(vm, obj, "nsRight") - prop(vm, obj, "nsLeft") + 1);
    const height = Math.max(font.height + 2, prop(vm, obj, "nsBottom") - prop(vm, obj, "nsTop") + 1);
    const rect = { left: prop(vm, obj, "textLeft"), top: prop(vm, obj, "textTop"), right: prop(vm, obj, "textRight") + 1, bottom: prop(vm, obj, "textBottom") + 1 };
    const savedBitmap = vm.getProp(obj, "bitmap") ?? 0;
    // The field on screen, for telling clicks inside it from clicks elsewhere.
    const plane = vm.getProp(obj, "plane") ?? 0;
    const originX = vm.memory.object(plane) ? prop(vm, plane, "inLeft") : 0, originY = vm.memory.object(plane) ? prop(vm, plane, "inTop") : 0;
    const field = { left: originX + prop(vm, obj, "x"), top: originY + prop(vm, obj, "y") };
    const inField = (x: number, y: number) => x >= field.left && x < field.left + width && y >= field.top && y < field.top + height;
    const ENDS = new Set<number>([13, 27, 9, SciKey.ShiftTab, SciKey.Up, SciKey.Down]);
    let bitmap: Value = 0;
    g.items.add(obj);

    let done = false;
    for (let frame = 0; !done; frame++) {
      if (bitmap) vm.memory.free(segmentOf(bitmap));
      bitmap = vm.memory.newBitmap(width, height, back, skip);
      const bmp = vm.memory.bitmap(bitmap)!;
      if (border >= 0) drawBorder(bmp, border & 0xff);
      const cursor = (frame >> 4) & 1 ? "" : "_"; // blink
      drawText(bmp, font, text + cursor, rect, fore, TextAlign.Left);
      vm.setProp(obj, "bitmap", bitmap);
      graphicsKernels.FrameOut!(vm, []);
      yield { frame: true };

      while (inp.queue.length && !done) {
        const e = inp.queue[0]!;
        // Peek: an event that ends editing stays queued for the dialog.
        if ((e.type === EventType.KeyDown && ENDS.has(e.message)) || (e.type === EventType.MouseDown && !inField(e.x, e.y))) {
          done = true;
          break;
        }
        inp.queue.shift();
        if (e.type !== EventType.KeyDown) continue;
        if (e.message === 8) text = text.slice(0, -1);
        else if (e.message >= 32 && e.message < 256 && text.length < maxLength) text += String.fromCharCode(e.message);
      }
    }

    stringHelpers.writeString(vm, textRef, text);
    vm.memory.free(segmentOf(bitmap));
    vm.setProp(obj, "bitmap", savedBitmap);
    g.items.delete(obj);
    return text !== original ? 1 : 0;
  },

  Bitmap: (vm, [subop = 0, ref = 0]) => {
    if (subop === 1 && vm.memory.bitmap(ref)) vm.memory.free(segmentOf(ref));
    return 0;
  },
};
