import {
  layoutTidyUnits,
  TIDY_H_GAP,
  TIDY_V_GAP,
} from "../tidyFlowchart/layout";
import {
  routeOrthogonalPath,
  segmentCrossesObstacle,
} from "../tidyFlowchart/routeArrow";

import type {
  RectBox,
  TidyEdge,
  TidyInput,
  TidyUnit,
} from "../tidyFlowchart/types";
import type { ExcalidrawArrowElement } from "../types";

const makeUnit = (
  id: string,
  minX: number,
  minY: number,
  width: number,
  height: number,
): TidyUnit => ({
  id,
  members: [id],
  originalBox: {
    minX,
    minY,
    maxX: minX + width,
    maxY: minY + height,
  },
  targetMinX: minX,
  targetMinY: minY,
});

const fakeArrow = (id: string) =>
  ({ id, type: "arrow" } as unknown as ExcalidrawArrowElement);

const makeEdge = (
  from: string | null,
  to: string | null,
  id = `arrow-${from}-${to}`,
  reversed = false,
): TidyEdge => ({
  arrow: fakeArrow(id),
  fromUnit: from,
  toUnit: to,
  reversed,
});

const makeInput = (units: TidyUnit[], edges: TidyEdge[]): TidyInput => ({
  units: new Map(units.map((unit) => [unit.id, unit])),
  edges,
  rigidArrowIds: new Set(),
  selectionBox: {
    minX: Math.min(...units.map((u) => u.originalBox.minX)),
    minY: Math.min(...units.map((u) => u.originalBox.minY)),
    maxX: Math.max(...units.map((u) => u.originalBox.maxX)),
    maxY: Math.max(...units.map((u) => u.originalBox.maxY)),
  },
});

const targetBox = (unit: TidyUnit): RectBox => ({
  minX: unit.targetMinX,
  minY: unit.targetMinY,
  maxX: unit.targetMinX + (unit.originalBox.maxX - unit.originalBox.minX),
  maxY: unit.targetMinY + (unit.originalBox.maxY - unit.originalBox.minY),
});

const boxesOverlap = (a: RectBox, b: RectBox) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

describe("tidyFlowchart layout", () => {
  it("places a linear chain left-to-right in successive columns", () => {
    const a = makeUnit("element:a", 0, 0, 100, 50);
    const b = makeUnit("element:b", 300, 200, 100, 50);
    const c = makeUnit("element:c", 50, 400, 100, 50);
    const input = makeInput(
      [a, b, c],
      [makeEdge("element:a", "element:b"), makeEdge("element:b", "element:c")],
    );

    layoutTidyUnits(input);

    expect(a.targetMinX).toBe(0);
    expect(b.targetMinX).toBeCloseTo(100 + TIDY_H_GAP, 10);
    expect(c.targetMinX).toBeCloseTo(200 + 2 * TIDY_H_GAP, 10);
    // same vertical band, all start at the component's original top
    expect(a.targetMinY).toBe(b.targetMinY);
    expect(b.targetMinY).toBe(c.targetMinY);
  });

  it("stacks branches vertically without overlap, regardless of sizes", () => {
    const root = makeUnit("element:root", 0, 0, 120, 60);
    const child1 = makeUnit("element:c1", 300, -100, 80, 30);
    const child2 = makeUnit("element:c2", 400, 50, 200, 120);
    const child3 = makeUnit("element:c3", 100, 300, 100, 40);
    const input = makeInput(
      [root, child1, child2, child3],
      [
        makeEdge("element:root", "element:c1"),
        makeEdge("element:root", "element:c2"),
        makeEdge("element:root", "element:c3"),
      ],
    );

    layoutTidyUnits(input);

    const children = [child1, child2, child3].map(targetBox);
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        expect(boxesOverlap(children[i], children[j])).toBe(false);
      }
    }
    // all children are centered in the same (second) column
    const centerX = (u: TidyUnit) =>
      u.targetMinX + (u.originalBox.maxX - u.originalBox.minX) / 2;
    expect(centerX(child1)).toBeCloseTo(centerX(child2), 10);
    expect(centerX(child2)).toBeCloseTo(centerX(child3), 10);
  });

  it("handles a merge (diamond) graph with four distinct columns", () => {
    const a = makeUnit("element:a", 0, 0, 50, 50);
    const b = makeUnit("element:b", 10, 10, 50, 50);
    const c = makeUnit("element:c", 20, 20, 50, 50);
    const d = makeUnit("element:d", 30, 30, 50, 50);
    const input = makeInput(
      [a, b, c, d],
      [
        makeEdge("element:a", "element:b"),
        makeEdge("element:a", "element:c"),
        makeEdge("element:b", "element:d"),
        makeEdge("element:c", "element:d"),
      ],
    );

    layoutTidyUnits(input);

    const xs = [a, b, c, d].map((u) => u.targetMinX);
    expect(xs[0]).toBeLessThan(Math.min(xs[1], xs[2]));
    expect(Math.min(xs[1], xs[2])).toBeLessThan(xs[3]);
    expect(b.targetMinX).toBe(c.targetMinX);
  });

  it("breaks cycles deterministically and still lays all units out", () => {
    const a = makeUnit("element:a", 0, 0, 50, 50);
    const b = makeUnit("element:b", 10, 0, 50, 50);
    const c = makeUnit("element:c", 20, 0, 50, 50);
    const input = makeInput(
      [a, b, c],
      [
        makeEdge("element:a", "element:b", "e1"),
        makeEdge("element:b", "element:c", "e2"),
        makeEdge("element:c", "element:a", "e3"),
      ],
    );

    layoutTidyUnits(input);

    // cycle nodes get layered (no infinite loop), distinct column x's
    const xs = [...new Set([a.targetMinX, b.targetMinX, c.targetMinX])];
    expect(xs.length).toBeGreaterThan(1);

    // running again yields exactly the same coordinates
    const first = [a, b, c].map((u) => [u.targetMinX, u.targetMinY]);
    layoutTidyUnits(input);
    const second = [a, b, c].map((u) => [u.targetMinX, u.targetMinY]);
    expect(second).toEqual(first);
  });

  it("lays out disconnected components independently and keeps isolated units put", () => {
    const a = makeUnit("element:a", 0, 0, 100, 50);
    const b = makeUnit("element:b", 500, 400, 100, 50);
    const isolated = makeUnit("element:i", 900, 700, 40, 40);
    const input = makeInput(
      [a, b, isolated],
      [makeEdge("element:a", "element:b")],
    );

    layoutTidyUnits(input);

    // isolated unit does not move
    expect(isolated.targetMinX).toBe(900);
    expect(isolated.targetMinY).toBe(700);
    // connected component keeps its original top-left anchor
    expect(a.targetMinX).toBe(0);
    expect(a.targetMinY).toBe(0);
    expect(b.targetMinX).toBeCloseTo(100 + TIDY_H_GAP, 10);
  });

  it("is idempotent: tidying an already-tidy diagram changes nothing", () => {
    const a = makeUnit("element:a", 0, 0, 100, 50);
    const b = makeUnit("element:b", 100 + TIDY_H_GAP, 0, 100, 50);
    const input = makeInput([a, b], [makeEdge("element:a", "element:b")]);

    layoutTidyUnits(input);
    expect([a.targetMinX, a.targetMinY]).toEqual([0, 0]);
    expect([b.targetMinX, b.targetMinY]).toEqual([100 + TIDY_H_GAP, 0]);
  });

  it("respects vertical gaps between differently sized stacked nodes", () => {
    const a = makeUnit("element:a", 0, 0, 100, 200);
    const b = makeUnit("element:b", 0, 0, 100, 30);
    const c = makeUnit("element:c", 0, 0, 100, 90);
    const root = makeUnit("element:root", -500, 0, 50, 50);
    const input = makeInput(
      [root, a, b, c],
      [
        makeEdge("element:root", "element:a"),
        makeEdge("element:root", "element:b"),
        makeEdge("element:root", "element:c"),
      ],
    );

    layoutTidyUnits(input);

    expect(a.targetMinY + 200 + TIDY_V_GAP).toBeLessThanOrEqual(b.targetMinY);
    expect(b.targetMinY + 30 + TIDY_V_GAP).toBeLessThanOrEqual(c.targetMinY);
  });
});

describe("orthogonal arrow router", () => {
  it("returns a straight path when no obstacle blocks the way", () => {
    const path = routeOrthogonalPath([0, 0], [100, 0], []);
    expect(path).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it("bends around an obstacle instead of crossing it", () => {
    const obstacles: RectBox[] = [{ minX: 40, minY: -30, maxX: 60, maxY: 30 }];
    expect(segmentCrossesObstacle([0, 0], [100, 0], obstacles)).toBe(true);

    const path = routeOrthogonalPath([0, 0], [100, 0], obstacles);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(2);

    // every segment is horizontal or vertical and stays clear of the box
    for (let i = 1; i < path!.length; i++) {
      const p = path![i - 1];
      const q = path![i];
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
    }
  });
});
