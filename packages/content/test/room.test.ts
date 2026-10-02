import { describe, expect, it } from "vitest";
import { ContentError, compileRoom, parseYarn, tagLines, type Target } from "../src/index.ts";

const target: Target = {
  roomClass: "TestRm",
  roomDefaults: { purge: 500 },
  globals: { ego: 0, game: 1, curRoom: 2, messager: 91, narratorObject: 89, music: 103, sound: 199 },
  narrator: 99,
  heroTalker: 97,
  firstRoomTalker: 200,
  voice: { class: "Narrator", props: { showTitle: 1 } },
  teller: { class: "Teller", props: { loopMenu: 1 }, verb: 128 },
  portrait: { class: "PortraitTalker", props: { talkWidth: 150 }, at: [0, 1], frameSignal: 0x4021, partSignal: 0x21 },
  forwardCycle: "Fwd",
  narrationVerb: 6,
  verbs: { look: 1, talk: 2, do: 4 },
  messageVersion: 5000,
  flags: { script: 0, set: 2, clear: 3, test: 4, first: 2000, last: 3199 },
};

const room = `
room: 900
hero: { at: [10, 150], enterTo: [60, 150] }
walkable: [[0, 140], [300, 140], [300, 189], [0, 189]]
features:
  rock: { rect: [10, 20, 50, 60] }
exits:
  door: { rect: [100, 50, 130, 120], walkTo: [115, 125], to: 901 }
props:
  bird: { view: 5, at: [200, 80], cycle: forward }
`;

const yarn = `
title: room.enter
---
You arrive.   #line:abc
===
title: rock.look
---
A rock.
Narrator: Still a rock.
===
title: bird.talk
---
// a comment
It ignores you, magnificently.
===
`;

describe("parseYarn", () => {
  it("reads nodes, speakers and tags", () => {
    const nodes = parseYarn(yarn);
    expect(nodes.map((n) => n.title)).toEqual(["room.enter", "rock.look", "bird.talk"]);
    expect(nodes[0]!.body[0]).toMatchObject({ text: "You arrive." });
    expect(nodes[1]!.body[1]).toMatchObject({ speaker: "Narrator", text: "Still a rock." });
  });

  it("points at what it can't handle yet", () => {
    expect(() => parseYarn("title: a.look\n---\n-> A\n  -> B\n===", "x.yarn")).toThrow("x.yarn:4: choices inside choices");
    expect(() => parseYarn("title: a.look\n---\n<<set $x to 1>>\n===", "x.yarn")).toThrow('x.yarn:3: unexpected "1"');
    expect(() => parseYarn("title: a.look\n---\n<<if $x>>\nhi\n===", "x.yarn")).toThrow("<<if>> without <<endif>>");
    expect(() => parseYarn("title: a.look\n---\n<<endif>>\n===", "x.yarn")).toThrow("x.yarn:3: <<endif>> without an <<if>>");
    expect(() => parseYarn("title: a.look\n---\nhi\n", "x.yarn")).toThrow("isn't closed with ===");
  });
});

describe("compileRoom", () => {
  const out = compileRoom(room, yarn, target);

  it("numbers nouns in order and writes messages per node line", () => {
    expect(out.sca).toContain("Nouns: 1 room, 2 rock, 3 door, 4 bird.");
    expect(out.msg.split("\n").filter((l) => /^\d/.test(l))).toEqual([
      '1 6 0 1 99 "You arrive." ; room.enter',
      '2 1 0 1 99 "A rock." ; rock.look',
      '2 1 0 2 99 "Still a rock." ; rock.look',
      '4 2 0 1 99 "It ignores you, magnificently." ; bird.talk',
    ]);
  });

  it("generates the room, its things and their scripts", () => {
    expect(out.sca).toContain("instance rm900 of TestRm");
    expect(out.sca).toContain("instance rock of Feature");
    expect(out.sca).toMatch(/instance door of Feature[\s\S]*method doVerb door::doVerb/);
    expect(out.sca).toContain("instance sExitDoor of Script");
    expect(out.sca).toContain("super TestRm 4");
    expect(out.sca).toMatch(/pushi #newRoom\s+push1\s+pushi 901/);
  });

  it("reports mistakes with file, line and path", () => {
    const bad = (yaml: string, y = "") => () => compileRoom(yaml, y, target, { yaml: "r.yaml", yarn: "r.yarn" });
    expect(bad("room: 900\nfeatures:\n  rock: { rect: [50, 20, 10, 60] }")).toThrow("r.yaml:3: features.rock.rect: left must be <= right");
    expect(bad("room: 900\nprops:\n  bird: { view: 5, at: [1, 2], colour: red }")).toThrow("props.bird.colour: unknown key");
    expect(bad("room: 900", "title: rock.look\n---\nhi\n===")).toThrow('r.yarn:1: node "rock.look": no feature, exit or prop called "rock"');
    expect(bad("room: 900", "title: room.dance\n---\nhi\n===")).toThrow('unknown verb "dance"');
    expect(bad("room: 900", "title: room.look\n---\nBob: hi\n===")).toThrow('r.yarn:3: unknown speaker "Bob"');
    expect(bad("room: 900", "title: room.look\n---\nCafé\n===")).toThrow(ContentError);
  });

  it("turns typographic punctuation into ASCII", () => {
    const r = compileRoom("room: 900", "title: room.look\n---\nIt’s “fine” — really…\n===", target);
    expect(r.msg).toContain('"It\'s \\"fine\\" -- really..."');
  });

  it("compiles conversations to topic menus with speakers", () => {
    const r = compileRoom(
      `room: 900
props:
  bird: { view: 5, at: [200, 80] }
characters:
  bird: { name: Old Crow }`,
      `title: bird.talk
---
-> Who are you?
    Old Crow: Nobody you'd know.
    Hero: Charming.
-> Bye
    Bird: Caw.
===`,
      target,
    );
    // Topic labels (hero, at rootNoun 3) and answers (at sayNoun 4), by topic number.
    expect(r.msg.split("\n").filter((l) => /^\d/.test(l)).map((l) => l.split(" ;")[0])).toEqual([
      '3 128 1 1 97 "Who are you?"',
      '4 128 1 1 200 "Nobody you\'d know."',
      '4 128 1 2 97 "Charming."',
      '3 128 2 1 97 "Bye"',
      '4 128 2 1 200 "Caw."',
    ]);
    expect(r.roomTalkers).toBe(true);
    expect(r.sca).toContain("instance birdTalker of Narrator");
    expect(r.sca).toMatch(/instance birdTeller of Teller[\s\S]*actionVerb 2/);
    // birdTeller init: bird 900 4 128 3
    expect(r.sca).toMatch(/pushi #init\s+pushi 5\s+lofsa @bird\s+push\s+pushi 900\s+pushi 4\s+pushi 128\s+pushi 3\s+lofsa @birdTeller/);
    expect(r.sca).toMatch(/rm900::findTalker:[\s\S]*ldi 200[\s\S]*lofsa @birdTalker[\s\S]*lag 89/);
  });

  it("gives a character with a portrait a talker and its parts", () => {
    const r = compileRoom("room: 900\ncharacters:\n  crow: { portrait: 702 }", "title: room.look\n---\nCrow: Caw.\n===", target);
    expect(r.sca).toContain("instance crowTalker of PortraitTalker");
    expect(r.sca).toMatch(/instance crowMouth of Prop[\s\S]*view 702\s+loop 1/);
    expect(r.sca).toMatch(/instance crowEyes of Prop[\s\S]*view 702\s+loop 2/);
    expect(r.sca).toMatch(/crowTalker::init:\s+pushi #init\s+pushi 4\s+lofsa @crowMouth[\s\S]*super PortraitTalker 12/);
    expect(r.msg).toContain('1 1 0 1 200 "Caw."');
  });

  it("rejects conversations it can't build yet", () => {
    const bad = (y: string) => () => compileRoom("room: 900\nprops:\n  bird: { view: 5, at: [1, 2] }", y, target, { yarn: "r.yarn" });
    expect(bad("title: bird.talk\n---\nHello.\n-> Hi\n    Caw.\n===")).toThrow("r.yarn:3: node \"bird.talk\": lines or commands outside choices");
    expect(bad("title: bird.talk\n---\n-> Hi\n===")).toThrow('r.yarn:3: node "bird.talk": choice "Hi" needs at least one line');
    expect(bad("title: room.talk\n---\n-> Hi\n    Caw.\n===")).toThrow("conversations need a feature or prop");
  });

  const flags = () => {
    const numbers = new Map<string, number>();
    return (name: string) => numbers.get(name) ?? (numbers.set(name, 2000 + numbers.size), numbers.get(name)!);
  };

  it("parses conditions and sets", () => {
    const [node] = parseYarn(`title: a.look
---
<<if $a and not ($b or $c == false)>>
    One.
<<elseif !$b>>
    Two.
<<else>>
    Three.
<<endif>>
<<set $a to false>>
-> Hi <<if $a>>
    Yo.
===`);
    expect(node!.body.map((x) => x.kind)).toEqual(["if", "set", "choice"]);
    const branches = (node!.body[0] as { branches: { when?: unknown; body: unknown[] }[] }).branches;
    expect(branches.map((b) => [b.when !== undefined, b.body.length])).toEqual([[true, 1], [true, 1], [false, 1]]);
    expect(node!.body[2]).toMatchObject({ kind: "choice", text: "Hi", when: { kind: "var", name: "a" } });
  });

  it("compiles a node with conditions and flags to a script run by doVerb", () => {
    const r = compileRoom(
      "room: 900\nfeatures:\n  rock: { rect: [0, 0, 10, 10] }",
      `title: rock.look
---
A rock.
<<if $touched>>
    It's still warm.
<<else>>
    It looks warm.
<<endif>>
===
title: rock.do
---
You touch it.
<<set $touched to true>>
===`,
      target, {}, { flag: flags() },
    );
    expect(r.flags).toEqual(["touched"]);
    // One message tuple per passage: cond 1 the first line, 2 and 3 the branches.
    expect(r.msg.split("\n").filter((l) => /^\d/.test(l)).map((l) => l.split(" ;")[0])).toEqual([
      '2 1 1 1 99 "A rock."', '2 1 2 1 99 "It\'s still warm."', '2 1 3 1 99 "It looks warm."', '2 4 1 1 99 "You touch it."',
    ]);
    expect(r.sca).toMatch(/rock::doVerb:[\s\S]*ldi 1\s+eq\?[\s\S]*lofsa @sRockLook[\s\S]*ldi 4\s+eq\?[\s\S]*lofsa @sRockDo[\s\S]*super Feature 6/);
    // The test (export 4) and the set (export 2) of flag 2000.
    expect(r.sca).toMatch(/sRockLook::changeState:[\s\S]*pushi 2000\s+callb 4 2/);
    expect(r.sca).toMatch(/sRockDo::changeState:[\s\S]*pushi 2000\s+callb 2 2/);
  });

  it("compiles conditional topics and scripted answers", () => {
    const r = compileRoom(
      "room: 900\nprops:\n  bird: { view: 5, at: [1, 2] }",
      `title: bird.talk
---
-> Hello
    Caw.
    <<set $greeted to true>>
-> What's new? <<if $greeted>>
    Nothing.
===`,
      target, {}, { flag: flags() },
    );
    expect(r.sca).toMatch(/birdTeller::showCases:\s+pushi #showCases\s+pushi 2\s+pushi 2\s+push1\s+pushi 2000\s+callb 4 2\s+push\s+super Teller 8/);
    expect(r.sca).toMatch(/birdTeller::sayMessage:[\s\S]*ldi 1\s+eq\?[\s\S]*lofsa @sBirdTopic1\s+push\s+pushSelf\s+lag 2\s+send 8/);
    // The scripted answer's lines live at a noun of their own (5); topic 2's plain answer at sayNoun.
    expect(r.msg).toContain('5 128 1 1 99 "Caw."');
    expect(r.msg).toContain('4 128 2 1 99 "Nothing."');
  });

  it("needs flag numbers for variables", () => {
    expect(() => compileRoom("room: 900", "title: room.look\n---\n<<if $x>>\nhi\n<<endif>>\n===", target, { yarn: "r.yarn" })).toThrow("r.yarn:3: $x: variables need flag numbers");
  });

  it("compiles cutscene commands", () => {
    const r = compileRoom(
      "room: 900\nprops:\n  bird: { view: 5, at: [10, 20], moves: true }\n  door: { view: 6, at: [50, 60] }",
      `title: door.do
---
<<walk hero 100 150>>
<<face hero bird>>
<<wait 1.5>>
<<animate door once>>
<<walk bird 40 30>>
<<hide bird>>
<<cel door 2>>
The door is open.
<<room 901>>
===`,
      target,
    );
    expect(r.sca).toContain("instance bird of Actor");
    expect(r.sca).toContain("instance door of Prop");
    const code = r.sca.slice(r.sca.indexOf("sDoorDo::changeState:"));
    // One state per thing that takes time, in order.
    const order = ["class PolyPath", "callk GetAngle 8", "ldi 90\n    aTop ticks", "class End", "class MoveTo", "pushi #hide", "pushi #setCel\n    push1\n    push2", "pushi #say", "pushi 901"];
    const at = order.map((s) => code.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("checks cutscene commands", () => {
    const bad = (y: string) => () => compileRoom("room: 900\nprops:\n  door: { view: 6, at: [50, 60] }", y, target, { yarn: "r.yarn" });
    expect(bad("title: door.do\n---\n<<walk door 1 2>>\n===")).toThrow('r.yarn:3: <<walk door 1 2>>: "door" doesn\'t move: give it moves: true');
    expect(bad("title: door.do\n---\n<<walk ghost 1 2>>\n===")).toThrow('"ghost" isn\'t hero or a prop');
    expect(bad("title: door.do\n---\n<<wait soon>>\n===")).toThrow("seconds must be a number");
    expect(bad("title: door.do\n---\n<<face hero sideways>>\n===")).toThrow("expected a direction");
    expect(bad("title: door.do\n---\n<<dance>>\n===")).toThrow("<<dance>>: unknown command (known: walk");
  });

  it("compiles music and sounds", () => {
    const r = compileRoom(
      "room: 900\nmusic: 200\nfeatures:\n  bell: { rect: [0, 0, 10, 10] }",
      "title: bell.do\n---\n<<sound 940 wait>>\nDong.\n<<sound 941>>\n<<music 250>>\n<<music stop>>\n===",
      target,
    );
    // The room's music, unless it's already playing.
    expect(r.sca).toMatch(/rm900::init:[\s\S]*pushi #number\s+push0\s+lag 103\s+send 4\s+push\s+ldi 200\s+eq\?\s+bt (\.c\d+)\s+pushi #number\s+push1\s+pushi 200\s+pushi #setLoop\s+push1\s+pushi -\$1\s+pushi #play\s+push0\s+lag 103\s+send 16\s+\1:/);
    const code = r.sca.slice(r.sca.indexOf("sBellDo::changeState:"));
    // wait: the effect cues the script; otherwise it just plays.
    expect(code).toMatch(/pushi 940\s+pushi #loop\s+push1\s+push1\s+pushi #play\s+push1\s+pushSelf\s+lag 199/);
    expect(code).toMatch(/pushi 941\s+pushi #loop\s+push1\s+push1\s+pushi #play\s+push0\s+lag 199/);
    expect(code).toMatch(/pushi #stop\s+push0\s+lag 103\s+send 4/);
    expect(() => compileRoom("room: 900", "title: room.look\n---\n<<sound 1 now>>\n===", target)).toThrow("expected <<sound number>> or <<sound number wait>>");
  });
});


describe("line ids", () => {
  it("are read from #line: tags, among others, and checked", () => {
    expect(parseYarn(yarn)[0]!.body[0]).toMatchObject({ text: "You arrive.", id: "abc" });
    expect(parseYarn("title: a.look\n---\nHi. #mood:dry #line:a-1\n===")[0]!.body[0]).toMatchObject({ text: "Hi.", id: "a-1" });
    expect(() => parseYarn("title: a.look\n---\nHi. #line:a #line:b\n===", "x.yarn")).toThrow("x.yarn:3: a line can only have one #line: tag");
    expect(() => parseYarn("title: a.look\n---\nHi. #line:a.b\n===", "x.yarn")).toThrow("x.yarn:3: \"#line:a.b\": a line id");
  });

  it("stay with their line when the message keys change", () => {
    const tagged = "title: rock.look\n---\nA rock. #line:rock\n===";
    const before = compileRoom(room, tagged, target).lines.find((l) => l.id === "rock")!;
    // A feature ahead of the rock renumbers it, but the id still finds its line.
    const after = compileRoom(room.replace("features:\n", "features:\n  moss: { rect: [0, 0, 5, 5] }\n"), tagged, target).lines.find((l) => l.id === "rock")!;
    expect(after.noun).toBe(before.noun + 1);
    expect(after).toMatchObject({ verb: before.verb, cond: before.cond, seq: before.seq, text: "A rock.", speaker: "Narrator" });
  });

  it("list spoken lines, not topic labels, and are unique in a room", () => {
    const talk = compileRoom(room, "title: bird.talk\n---\n-> Hello\n  It tweets. #line:t1\n===", target, { yarn: "r.yarn" });
    expect(talk.lines).toEqual([expect.objectContaining({ id: "t1", text: "It tweets.", where: "r.yarn:4" })]);
    // Whoever records it hears what it answers.
    expect(talk.lines[0]).toMatchObject({ node: "bird.talk: Hello", before: { speaker: "Hero", text: "Hello" } });
    const two = compileRoom(room, "title: rock.look\n---\nA rock.\nNarrator: Still a rock.\n===", target).lines;
    expect(two[0]!.before).toBeUndefined();
    expect(two[1]).toMatchObject({ node: "rock.look", before: { speaker: "Narrator", text: "A rock." } });
    expect(() => compileRoom(room, "title: rock.look\n---\nA. #line:x\nB. #line:x\n===", target, { yarn: "r.yarn" }))
      .toThrow("r.yarn:4: #line:x is already the id of r.yarn:3");
  });

  it("are added where they're missing, and only there", () => {
    const source = [
      "title: rock.look", "---", "A rock. #line:900-001", "<<if $x>>", "Still a rock.", "<<endif>>", "===",
      "title: bird.talk", "---", "-> Hello", "  Narrator: It sings.   ", "// a comment", "===", "",
    ].join("\r\n");
    const { source: out, added } = tagLines(source, "900", new Set(["900-002"]));
    expect(added).toEqual(["900-003", "900-004"]);
    expect(out.split("\r\n")).toEqual([
      "title: rock.look", "---", "A rock. #line:900-001", "<<if $x>>", "Still a rock. #line:900-003", "<<endif>>", "===",
      "title: bird.talk", "---", "-> Hello", "  Narrator: It sings. #line:900-004", "// a comment", "===", "",
    ]);
    expect(tagLines(out, "900", new Set()).added).toEqual([]);
  });
});

describe("perspective", () => {
  const spec = (extra: string) => `room: 900\nhero: { at: [10, 150] }\nperspective: { horizon: 72, fullSize: 176 }\nwalkable: [[0, 140], [300, 140], [300, 189], [0, 189]]\n${extra}`;

  it("sizes a still prop once, for where it stands, only when asked", () => {
    const sca = compileRoom(spec("props:\n  seated: { view: 7, at: [50, 133], scale: true }\n  vase: { view: 8, at: [90, 150] }"), "", target).sca;
    const seated = sca.slice(sca.indexOf("instance seated"), sca.indexOf("instance vase"));
    expect(seated).toMatch(/scaleSignal 1\n\s+scaleX 75\n\s+scaleY 75/); // (133 - 72) / 104 of full size
    expect(sca.slice(sca.indexOf("instance vase"))).not.toContain("scaleSignal");
  });

  it("is checked", () => {
    const bad = (yaml: string) => () => compileRoom(yaml, "", target, { yaml: "r.yaml" });
    expect(bad("room: 900\nperspective: { horizon: 100, fullSize: 90 }")).toThrow("r.yaml:2: perspective.fullSize: must be below the horizon");
    expect(bad("room: 900\nprops:\n  a: { view: 1, at: [1, 1], scale: true }")).toThrow("the room has no perspective");
    expect(bad("room: 900\nperspective: { horizon: 0, fullSize: 20 }\nwalkable: [[0, 10], [9, 10], [9, 199]]")).toThrow("too much for the Scaler");
  });
});
