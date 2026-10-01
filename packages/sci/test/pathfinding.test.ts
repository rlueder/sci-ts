import { describe, expect, it } from "vitest";
import { PolygonType, findPath, walkable, type Polygon } from "../src/index.ts";

const rect = (type: number, x1: number, y1: number, x2: number, y2: number): Polygon => ({
  type,
  points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
});
const room = rect(PolygonType.Contained, 0, 0, 300, 150);

describe("pathfinding", () => {
  it("walks straight when nothing is in the way", () => {
    expect(findPath({ x: 10, y: 10 }, { x: 200, y: 100 }, [room])).toEqual([{ x: 10, y: 10 }, { x: 200, y: 100 }]);
  });

  it("goes around a barred obstacle via its corners", () => {
    const rock = rect(PolygonType.Barred, 100, 20, 150, 130);
    const path = findPath({ x: 50, y: 75 }, { x: 250, y: 75 }, [room, rock]);
    expect(path.length).toBeGreaterThan(2);
    expect(path.at(-1)).toEqual({ x: 250, y: 75 });
    // Goes around the short side: over the top (y = 20) rather than the bottom (y = 130).
    expect(path.slice(1, -1).every((p) => p.y === 20)).toBe(true);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      for (let t = 0.1; t < 1; t += 0.1) expect(walkable([room, rock], { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })).toBe(true);
    }
  });

  it("stops at the edge of the walkable area when clicking outside it", () => {
    const path = findPath({ x: 50, y: 50 }, { x: 50, y: 190 }, [room]);
    expect(path.at(-1)).toEqual({ x: 50, y: 150 });
  });

  it("walks to the nearest edge when clicking inside an obstacle", () => {
    const rock = rect(PolygonType.Barred, 100, 20, 150, 130);
    expect(findPath({ x: 50, y: 75 }, { x: 110, y: 75 }, [room, rock]).at(-1)).toEqual({ x: 100, y: 75 });
  });

  it("lets an actor that starts inside an obstacle walk out", () => {
    const rock = rect(PolygonType.Barred, 100, 20, 150, 130);
    expect(findPath({ x: 120, y: 75 }, { x: 250, y: 75 }, [room, rock]).at(-1)).toEqual({ x: 250, y: 75 });
  });

  it("navigates a concave (U-shaped) walkable area", () => {
    const u: Polygon = {
      type: PolygonType.Contained,
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 100 }, { x: 160, y: 100 }, { x: 160, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 140 }, { x: 0, y: 140 }],
    };
    const path = findPath({ x: 20, y: 10 }, { x: 180, y: 10 }, [u]);
    expect(path).toEqual([{ x: 20, y: 10 }, { x: 40, y: 100 }, { x: 160, y: 100 }, { x: 180, y: 10 }]);
  });
});
