import { basePalette, Colour, type ViewFile } from "../../tools/game/kit.ts";

/** Flat polygon art shared by the scenery, actors and portraits. No texture or dithering. */
const swatches = {
  void: "101322", sky: "222945", cloud: "303b5b", haze: "495778", far: "3b4868",
  ridge: "293c54", slope: "233a49", grass: "1b3038", ground: "24343c", edge: "405451",
  rock: "35434d", rockLight: "51606b", dark: "141f2b", road: "4b4852", roadLight: "64606a",
  rust: "b05e4e", rustLight: "da8464", rustDark: "733e40", skin: "d9ae89", skinDark: "9c796b",
  cloth: "68868b", clothLight: "9ab0a7", clothDark: "3e5a66", hair: "b4b9b1",
  moon: "d9dfc7", moonShade: "aebdbb", brass: "b88950", glow: "f1c67d", core: "fff0ba",
  lightPool: "63513d", lightEdge: "3c3d35",
};
type Shade = keyof typeof swatches;
const names = Object.keys(swatches) as Shade[];
const c = Object.fromEntries(names.map((name, i) => [name, i + 1])) as Record<Shade, number>;
export function palette() {
  const p = basePalette();
  names.forEach((name, i) => { p.rgb[i + 1] = [0, 2, 4].map(at => parseInt(swatches[name].slice(at, at + 2), 16)) as [number, number, number]; });
  return p;
}
type Point = [number, number];

/** Scanline fill sampled at pixel centres, also used for every animated character pose. */
class Canvas {
  pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number, colour = Colour.Transparent as number) {
    this.pixels = new Uint8Array(width * height).fill(colour);
  }
  poly(colour: number, points: Point[]) {
    const low = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))));
    const high = Math.min(this.height, Math.ceil(Math.max(...points.map(p => p[1]))));
    for (let y = low; y < high; y++) {
      const crossings: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i]!, [bx, by] = points[(i + 1) % points.length]!;
        if ((ay <= y + .5 && by > y + .5) || (by <= y + .5 && ay > y + .5)) crossings.push(ax + (y + .5 - ay) * (bx - ax) / (by - ay));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const left = Math.max(0, Math.ceil(crossings[i]! - .5));
        const right = Math.min(this.width, Math.ceil(crossings[i + 1]! - .5));
        if (right > left) this.pixels.fill(colour, y * this.width + left, y * this.width + right);
      }
    }
  }
  rect(colour: number, x: number, y: number, w: number, h: number) { this.poly(colour, [[x,y],[x+w,y],[x+w,y+h],[x,y+h]]); }
  limb(colour: number, a: Point, b: Point, width: number) {
    const length = Math.hypot(b[0]-a[0], b[1]-a[1]);
    if (!length) return;
    const dx = (b[1]-a[1])*width/length/2, dy = -(b[0]-a[0])*width/length/2;
    this.poly(colour, [[a[0]+dx,a[1]+dy],[b[0]+dx,b[1]+dy],[b[0]-dx,b[1]-dy],[a[0]-dx,a[1]-dy]]);
  }
  cel() { return { width: this.width, height: this.height, displaceX: 0, displaceY: 0, skipColor: Colour.Transparent, pixels: this.pixels }; }
}

function sky(p: Canvas, road: boolean) {
  p.rect(c.sky, 0, 0, 320, 200);
  p.poly(c.cloud, [[0,57],[39,48],[95,53],[127,47],[176,52],[219,48],[271,54],[320,45],[320,89],[0,89]]);
  p.poly(c.haze, [[0,83],[54,76],[107,81],[161,70],[213,77],[266,69],[320,74],[320,113],[0,113]]);
  // Quiet angular cloud bands leave the moon's original click rectangle clear.
  p.poly(c.cloud, [[51,25],[78,22],[99,27],[140,28],[151,32],[105,31],[72,29]]);
  p.poly(c.cloud, [[187,41],[214,38],[236,42],[279,43],[299,47],[228,46]]);
  const mx = road ? 277 : 260, my = road ? 26 : 30;
  p.poly(c.moon, [[mx-4,my-9],[mx+4,my-9],[mx+9,my-4],[mx+9,my+4],[mx+4,my+9],[mx-4,my+9],[mx-9,my+4],[mx-9,my-4]]);
  p.poly(c.moonShade, [[mx-4,my-9],[mx-6,my-3],[mx-5,my+4],[mx,my+9],[mx-4,my+9],[mx-9,my+4],[mx-9,my-4]]);
  for (const [x,y] of [[43,15],[102,10],[176,19],[217,8],[303,15],[135,42]]) p.rect(c.moonShade,x!,y!,1,1);
}
function hills(p: Canvas, road: boolean) {
  const offset = road ? -30 : 0;
  p.poly(c.far, [[0,91],[37,68],[62,73],[91,94],[127,76],[168,83],[200,64],[225,71],[268,96],[299,83],[320,86],[320,145],[0,145]]);
  p.poly(c.ridge, [[0,100],[33,82],[62,91],[93,110],[129,103],[151,106],[177,91],[197,98],[232,113],[270,110],[320,95],[320,150],[0,150]]);
  p.poly(c.slope, [[0,125],[40,109],[77,116],[113,129],[160,120],[199,133],[244,116],[280,122],[320,114],[320,167],[0,167]]);
  // A distant settlement is a single silhouette punctuated by a few warm windows.
  for (const [x,y,w,h] of [[145,119,8,8],[157,121,11,7],[171,115,7,12],[183,121,9,7],[200,125,7,6]]) {
    const xx=x!+offset, yy=y!;
    p.poly(c.ridge, [[xx,yy],[xx+w!/2,yy-4],[xx+w!,yy],[xx+w!,yy+h!],[xx,yy+h!]]);
    p.rect(c.brass,xx+3,yy+3,1,2);
  }
  p.poly(c.grass, [[0,144],[31,137],[66,143],[107,146],[148,141],[191,149],[232,141],[270,145],[320,136],[320,169],[0,169]]);
}
function tree(p: Canvas, right = false) {
  const poly = (colour: number, pts: Point[]) => p.poly(colour, pts.map(([x,y]) => [right ? 320-x : x,y]));
  poly(c.dark, [[0,0],[23,0],[19,40],[27,79],[22,115],[30,147],[7,150],[10,109],[7,75],[11,38]]);
  poly(c.rock, [[14,0],[20,0],[15,41],[22,81],[17,108],[18,143],[12,147],[13,99],[13,64],[10,38]]);
  poly(c.dark, [[17,70],[33,49],[47,37],[67,29],[72,19],[62,25],[40,29],[28,43],[16,51]]);
  poly(c.dark, [[18,35],[35,15],[39,0],[31,0],[29,13],[15,22]]);
  poly(c.dark, [[0,6],[21,0],[71,0],[91,8],[74,17],[47,12],[28,23],[0,29]]);
  poly(c.grass, [[41,0],[87,0],[109,8],[90,16],[74,12],[61,17],[51,9],[30,8]]);
}
function foreground(p: Canvas) {
  p.poly(c.dark, [[0,194],[28,191],[49,196],[73,193],[101,198],[144,195],[197,198],[238,192],[273,197],[307,191],[320,194],[320,200],[0,200]]);
  for (const x of [6,38,87,241,289,312]) p.poly(c.dark, [[x,198],[x-5,188],[x+1,194],[x+4,185],[x+4,196],[x+9,192],[x+7,200]]);
  p.poly(c.rock, [[0,193],[11,185],[26,188],[40,200],[0,200]]);
  p.poly(c.rockLight, [[0,193],[11,185],[26,188],[15,191]]);
  p.poly(c.rock, [[271,200],[286,189],[304,188],[320,197],[320,200]]);
  p.poly(c.rockLight, [[286,189],[304,188],[314,194],[298,192]]);
}
export function picture(name: "hill" | "road") {
  const p = new Canvas(320,200); const road = name === "road";
  sky(p,road); hills(p,road); tree(p,road);
  // The full original y=158..189 walkable strip is kept unobstructed.
  p.poly(c.ground, [[0,154],[35,150],[89,154],[142,151],[193,155],[243,150],[291,153],[320,149],[320,200],[0,200]]);
  if (road) {
    p.poly(c.road, [[0,163],[79,164],[167,160],[247,164],[320,161],[320,189],[237,186],[160,190],[71,186],[0,189]]);
    p.poly(c.roadLight, [[0,166],[91,169],[163,166],[227,169],[320,165],[320,170],[219,174],[166,171],[73,173],[0,171]]);
    p.poly(c.rock, [[0,181],[65,178],[101,179],[78,181],[0,184]]);
    p.poly(c.rock, [[205,182],[259,177],[296,180],[268,181],[251,180]]);
    p.poly(c.dark, [[247,130],[251,129],[251,160],[248,161]]);
    p.poly(c.brass, [[248,132],[250,131],[250,158],[249,159]]);
    p.poly(c.dark, [[236,129],[260,129],[264,134],[260,140],[236,140]]);
    p.poly(c.rockLight, [[237,130],[259,130],[263,134],[259,138],[237,138]]);
    p.poly(c.moonShade, [[237,130],[259,130],[261,132],[237,132]]);
    p.poly(c.dark, [[248,134],[255,134],[254,132],[259,135],[254,137],[255,135],[248,135]]);
  } else {
    p.poly(c.edge, [[0,158],[48,156],[88,159],[121,157],[100,161],[49,161]]);
    p.poly(c.lightEdge, [[127,164],[165,159],[189,166],[200,175],[175,182],[142,181],[115,173]]);
    p.poly(c.lightPool, [[144,167],[166,163],[184,169],[186,174],[166,178],[142,175],[135,171]]);
    p.poly(c.brass, [[155,171],[164,168],[176,173],[164,175],[151,174]]);
    p.poly(c.rock, [[217,154],[232,140],[248,139],[263,152],[258,158],[235,158]]);
    p.poly(c.rockLight, [[217,154],[232,140],[248,139],[239,146]]);
    p.poly(c.dark, [[239,146],[248,139],[263,152],[258,158],[246,153]]);
  }
  foreground(p);
  return { resolution: [320,200] as [number,number], cels: [{...p.cel(), priority:0, x:0,y:0,unknown16:0}], palette:palette() };
}

export function lantern(): ViewFile {
  const frame = (bright: boolean) => {
    const p = new Canvas(11,14);
    p.poly(c.dark, [[3,3],[3,1],[5,0],[8,1],[8,4],[9,5],[10,12],[8,14],[2,14],[1,12],[2,5]]);
    p.poly(c.brass, [[4,3],[4,1],[7,1],[7,4],[8,5],[3,5]]);
    p.poly(c.glow, [[3,6],[8,6],[9,11],[7,12],[3,12],[2,11]]);
    p.poly(bright ? c.core : c.brass, [[5,6],[7,8],[7,11],[4,11],[4,9]]);
    p.rect(c.dark,2,12,7,1); p.rect(c.brass,3,13,5,1);
    return p.cel();
  };
  return {flags:1,loops:[{link:-1,mirror:false,cels:[frame(false),frame(true)]}],palette:undefined};
}

/** Human proportions and articulated full-body poses, all drawn in the scenery's flat planes. */
function heroPose(direction: "side" | "front" | "back", phase: number) {
  const p = new Canvas(28,46), side = direction === "side", back = direction === "back";
  const stride = [0,1,0,-1][phase]!, bob = phase % 2 ? 1 : 0;
  const hip: Point = [14,27+bob];
  const farKnee: Point = [side ? 13-stride*4 : 17-stride,36];
  const farFoot: Point = [side ? 13-stride*7 : 18,44-(stride===-1?2:0)];
  const nearKnee: Point = [side ? 14+stride*4 : 11+stride,36];
  const nearFoot: Point = [side ? 14+stride*7 : 10,44-(stride===1?1:0)];
  const leg = (knee:Point,foot:Point,col:number) => {
    p.limb(col,hip,knee,4); p.limb(col,knee,foot,3);
    p.poly(c.dark,[[foot[0]-2,foot[1]-1],[foot[0]+1,foot[1]-1],[foot[0]+4,foot[1]+1],[foot[0]-2,foot[1]+1]]);
  };
  leg(farKnee,farFoot,c.dark);
  const shoulder:Point=[side?13:18,13+bob], elbow:Point=[side?14+stride*4:20,21+bob], hand:Point=[side?15+stride*6:20,28+bob];
  p.limb(c.rustDark,shoulder,elbow,4); p.limb(c.rustDark,elbow,hand,3);p.rect(c.skinDark,hand[0]-1,hand[1]-1,2,3);
  leg(nearKnee,nearFoot,c.clothDark);
  p.poly(c.rust,[[10,11+bob],[16,10+bob],[19,16+bob],[17,25+bob],[18,29+bob],[10,29+bob],[9,23+bob],[9,16+bob]]);
  p.poly(c.rustLight,[[10,11+bob],[13,11+bob],[13,24+bob],[11,27+bob],[10,22+bob]]);
  p.poly(c.rustDark,[[16,11+bob],[19,16+bob],[17,25+bob],[18,29+bob],[15,28+bob],[15,19+bob]]);
  // Neck and six-pixel head: a few planes, no outlined eyes or miniature costume texture.
  p.rect(c.skinDark,13,8+bob,3,4);
  p.poly(back?c.dark:c.skin,[[11,2+bob],[16,2+bob],[17,5+bob],[side?19:17,6+bob],[17,7+bob],[16,10+bob],[12,9+bob],[11,6+bob]]);
  if (!back) p.poly(c.skinDark,[[11,4+bob],[13,5+bob],[13,8+bob],[16,10+bob],[12,9+bob]]);
  p.poly(c.dark,[[10,2+bob],[12,0+bob],[16,1+bob],[17,3+bob],[13,3+bob],[12,6+bob],[10,5+bob]]);
  const a:Point=[side?11:10,14+bob], e:Point=[side?11-stride*4:8,22+bob], h:Point=[side?12-stride*6:9,29+bob];
  p.limb(c.rustLight,a,e,3);p.limb(c.rust,e,h,3);p.poly(c.skin,[[h[0]-1,h[1]-1],[h[0]+2,h[1]],[h[0]+1,h[1]+3],[h[0]-1,h[1]+2]]);
  return p.cel();
}
export function hero(): ViewFile {
  const walk=(direction:"side"|"front"|"back")=>[0,1,2,3].map(i=>heroPose(direction,i));
  return {flags:1,loops:[{link:-1,mirror:false,cels:walk("side")},{link:0,mirror:true,cels:[]},{link:-1,mirror:false,cels:walk("front")},{link:-1,mirror:false,cels:walk("back")}],palette:undefined};
}
export function traveller(): ViewFile {
  const p=new Canvas(32,36);
  p.poly(c.dark,[[18,19],[26,19],[30,25],[28,34],[17,34],[15,25]]);
  p.poly(c.brass,[[19,21],[26,21],[28,25],[27,32],[19,32],[17,26]]);
  p.poly(c.lightPool,[[24,21],[26,21],[28,25],[27,32],[24,31]]);
  p.limb(c.dark,[18,24],[23,27],5);p.limb(c.dark,[23,27],[25,34],4);p.rect(c.dark,24,33,6,2);
  p.limb(c.clothDark,[16,23],[10,26],5);p.limb(c.clothDark,[10,26],[8,34],4);p.rect(c.dark,5,33,6,2);
  p.poly(c.cloth,[[13,10],[19,10],[22,16],[21,24],[15,26],[10,23],[11,16]]);
  p.poly(c.clothLight,[[13,10],[16,10],[15,19],[11,22],[11,16]]);
  p.poly(c.clothDark,[[19,10],[22,16],[21,24],[17,24],[18,17]]);
  p.rect(c.skinDark,15,8,3,4);
  p.poly(c.skin,[[12,2],[17,2],[19,5],[18,9],[15,11],[12,8]]);
  p.poly(c.hair,[[11,3],[12,0],[17,0],[19,3],[17,4],[13,3],[13,6],[11,6]]);
  p.poly(c.hair,[[12,7],[15,8],[18,7],[17,10],[15,11],[12,9]]);
  p.limb(c.clothLight,[12,13],[9,20],3);p.limb(c.cloth,[9,20],[14,23],3);p.rect(c.skin,13,22,3,2);
  p.limb(c.clothDark,[20,14],[23,21],3);p.limb(c.cloth,[23,21],[19,23],3);p.rect(c.skinDark,17,22,3,2);
  return {flags:1,loops:[{link:-1,mirror:false,cels:[p.cel()]}],palette:undefined};
}
export function portrait(): ViewFile {
  const p=new Canvas(34,40,c.dark);
  p.poly(c.sky,[[1,1],[33,1],[33,39],[1,39]]);
  p.poly(c.cloud,[[21,1],[33,1],[33,39],[8,39]]);
  p.poly(c.clothDark,[[1,40],[4,32],[12,28],[23,28],[30,33],[34,40]]);
  p.poly(c.cloth,[[1,40],[4,32],[13,29],[17,40]]);
  p.poly(c.clothLight,[[4,32],[12,28],[16,31],[11,35]]);
  p.poly(c.skinDark,[[13,24],[22,24],[23,30],[17,33],[12,29]]);
  p.poly(c.skin,[[9,9],[13,5],[22,6],[26,12],[24,24],[20,29],[14,27],[10,21]]);
  p.poly(c.skinDark,[[20,8],[25,11],[26,17],[24,24],[20,29],[17,24],[20,20]]);
  p.poly(c.hair,[[8,12],[8,8],[12,4],[21,4],[25,7],[26,13],[23,11],[22,8],[15,8],[11,11],[10,18]]);
  p.poly(c.moonShade,[[8,8],[12,4],[21,4],[15,6],[12,9]]);
  p.poly(c.hair,[[11,21],[15,24],[21,24],[24,21],[23,26],[20,29],[15,28],[12,25]]);
  p.poly(c.skin,[[17,15],[16,20],[19,21],[20,19]]);
  const done=(q:Canvas)=>({...q.cel(),displaceX:17,displaceY:39});
  const mouth=(open:boolean)=>{const q=new Canvas(34,40);q.poly(c.skinDark,[[15,24],[21,24],[20,open?26:25],[16,25]]);return done(q)};
  const eyes=(open:boolean)=>{const q=new Canvas(34,40);q.rect(open?c.dark:c.skinDark,12,15,3,1);q.rect(open?c.dark:c.skinDark,21,15,2,1);return done(q)};
  return {flags:1,loops:[{link:-1,mirror:false,cels:[done(p)]},{link:-1,mirror:false,cels:[mouth(false),mouth(true)]},{link:-1,mirror:false,cels:[eyes(true),eyes(false)]}],palette:undefined};
}

/** Eight top-left-anchored pieces used by every dialogue and topic panel. */
export function dialogueFrame(): ViewFile {
  const corner = (right: boolean, bottom: boolean) => {
    const p = new Canvas(3, 3, c.void);
    const mirror = (points: Point[]): Point[] => points.map(([x, y]) => [right ? 3 - x : x, bottom ? 3 - y : y]);
    p.poly(bottom ? c.cloud : c.clothDark, mirror([[0,3],[0,2],[2,0],[3,0],[3,1],[1,3]]));
    return p;
  };
  const top = new Canvas(1, 2, c.void); top.rect(c.clothDark, 0, 0, 1, 1);
  const bottom = new Canvas(1, 2, c.void); bottom.rect(c.cloud, 0, 1, 1, 1);
  const left = new Canvas(2, 1, c.void); left.rect(c.clothDark, 0, 0, 1, 1);
  const right = new Canvas(2, 1, c.void); right.rect(c.cloud, 1, 0, 1, 1);
  const pieces = [corner(false,false),corner(true,false),corner(false,true),corner(true,true),top,bottom,left,right];
  return { flags:1, loops:[{link:-1,mirror:false,cels:pieces.map(p => ({...p.cel(),displaceX:p.width>>1,displaceY:p.height-1}))}], palette:undefined };
}

/** Preserve each verb's resource number and hotspot convention, including the boot cursor. */
export function cursors(): { number: number; view: ViewFile }[] {
  const make = (number: number, draw: (p: Canvas) => void, tip = false) => {
    const p = new Canvas(16,16); draw(p);
    const [hx,hy] = tip ? [0,0] : [8,8];
    return {number,view:{flags:1,loops:[{link:-1,mirror:false,cels:[{...p.cel(),displaceX:8-hx,displaceY:15-hy}]}],palette:undefined}} satisfies {number:number;view:ViewFile};
  };
  const arrow = (p: Canvas) => {
    p.poly(c.void,[[0,0],[12,10],[8,11],[11,15],[7,16],[5,11],[1,14]]);
    p.poly(c.moon,[[1,2],[10,9],[6,10],[9,14],[8,15],[5,9],[2,11]]);
    p.poly(c.cloth,[[1,2],[5,9],[2,11]]);
  };
  return [
    make(991,p=>{ // Look: an angular eye with a single flat iris.
      p.poly(c.void,[[0,8],[5,3],[10,3],[16,8],[11,13],[5,13]]);
      p.poly(c.moon,[[2,8],[6,5],[10,5],[14,8],[10,11],[6,11]]);
      p.poly(c.cloth,[[2,8],[6,9],[11,9],[14,8],[10,11],[6,11]]);
      p.poly(c.void,[[6,6],[9,6],[11,8],[9,10],[6,10],[5,8]]);
      p.rect(c.moon,7,6,1,1);
    }),
    make(992,p=>{ // Talk: a simple faceted speech panel, no simulated writing.
      p.poly(c.void,[[3,2],[13,2],[16,5],[16,10],[13,13],[8,13],[3,16],[4,12],[0,9],[0,5]]);
      p.poly(c.moon,[[4,4],[12,4],[14,6],[14,9],[12,11],[7,11],[5,13],[5,11],[2,8],[2,6]]);
      p.poly(c.cloth,[[2,8],[14,8],[14,9],[12,11],[7,11],[5,13],[5,11]]);
    }),
    make(993,arrow,true),
    make(994,p=>{ // Use: a readable open hand in two flat planes.
      p.poly(c.void,[[5,1],[8,1],[9,5],[12,4],[15,6],[16,11],[12,16],[6,16],[1,11],[0,7],[3,6],[5,9]]);
      p.poly(c.moon,[[6,2],[7,2],[7,7],[10,6],[13,6],[14,8],[14,11],[11,14],[7,14],[3,10],[2,8],[3,8],[6,11]]);
      p.poly(c.cloth,[[7,9],[10,8],[14,8],[14,11],[11,14],[7,14],[5,12]]);
    }),
    make(995,p=>{ // Wait: hourglass cut from the same brass and moonlight planes.
      p.poly(c.void,[[2,1],[14,1],[14,4],[10,8],[14,12],[14,15],[2,15],[2,12],[6,8],[2,4]]);
      p.rect(c.moon,3,2,10,1);p.rect(c.cloth,3,13,10,1);
      p.poly(c.cloth,[[4,4],[12,4],[8,8]]);
      p.poly(c.glow,[[6,5],[10,5],[8,8],[12,12],[4,12],[8,8]]);
    }),
    make(999,arrow,true),
  ];
}
