import { pointFrom } from "@excalidraw/math";

import { bindBindingElement } from "../binding";
import { mutateElement } from "../mutateElement";
import {
  newArrowElement,
  newElement,
  newFrameElement,
  newTextElement,
} from "../newElement";
import { Scene } from "../Scene";
import { tidyUpElements } from "../tidyUp";

import type {
  ExcalidrawArrowElement,
  ExcalidrawElbowArrowElement,
  ExcalidrawRectangleElement,
  ExcalidrawTextElementWithContainer,
  NonDeleted,
} from "../types";

type Rect = ReturnType<typeof makeRect>;

const makeRect = (
  x: number,
  y: number,
  width = 100,
  height = 80,
  opts: {
    groupIds?: ExcalidrawRectangleElement["groupIds"];
    frameId?: ExcalidrawRectangleElement["frameId"];
    boundElements?: ExcalidrawRectangleElement["boundElements"];
  } = {},
) =>
  newElement({
    type: "rectangle",
    x,
    y,
    width,
    height,
    ...opts,
  }) as NonDeleted<ExcalidrawRectangleElement>;

const makeArrow = (
  scene: Scene,
  from: Rect,
  to: Rect,
): NonDeleted<ExcalidrawArrowElement> => {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const arrow = newArrowElement({
    type: "arrow",
    x: startX,
    y: startY,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
    points: [pointFrom(0, 0), pointFrom(endX - startX, endY - startY)],
  });
  scene.insertElement(arrow);
  bindBindingElement(arrow, from, "orbit", "start", scene);
  bindBindingElement(arrow, to, "orbit", "end", scene);
  return arrow;
};

const makeElbowArrow = (
  scene: Scene,
  from: Rect,
  to: Rect,
): NonDeleted<ExcalidrawElbowArrowElement> => {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const arrow = newArrowElement({
    type: "arrow",
    elbowed: true,
    x: startX,
    y: startY,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
    points: [pointFrom(0, 0), pointFrom(endX - startX, endY - startY)],
  });
  scene.insertElement(arrow);
  bindBindingElement(arrow, from, "orbit", "start", scene);
  bindBindingElement(arrow, to, "orbit", "end", scene);
  return arrow;
};

const expectNoOverlap = (rects: Rect[]) => {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlap =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      if (overlap) {
        throw new Error(
          `rects overlap: ${a.id} (${a.x},${a.y}) and ${b.id} (${b.x},${b.y})`,
        );
      }
    }
  }
};

describe("tidyUpElements", () => {
  it("lays out a branching/merging flow from left to right", () => {
    // scrambled initial positions of a diamond: A -> B, A -> C, B -> D, C -> D
    const a = makeRect(500, 0);
    const b = makeRect(0, 600);
    const c = makeRect(900, 300);
    const d = makeRect(100, 100);
    const scene = new Scene([a, b, c, d], { skipValidation: true });
    const arrows = [
      makeArrow(scene, a, b),
      makeArrow(scene, a, c),
      makeArrow(scene, b, d),
      makeArrow(scene, c, d),
    ];

    tidyUpElements([a, b, c, d], scene);

    // layers: A < B,C < D
    expect(a.x).toBeLessThan(b.x);
    expect(a.x).toBeLessThan(c.x);
    expect(b.x).toBe(c.x);
    expect(b.x).toBeLessThan(d.x);
    expectNoOverlap([a, b, c, d]);

    // arrows stay bound to the same elements
    expect(arrows[0].startBinding?.elementId).toBe(a.id);
    expect(arrows[0].endBinding?.elementId).toBe(b.id);
    expect(arrows[3].endBinding?.elementId).toBe(d.id);
  });

  it("handles cyclic connections", () => {
    const a = makeRect(0, 0);
    const b = makeRect(400, 200);
    const c = makeRect(800, 0);
    const scene = new Scene([a, b, c], { skipValidation: true });
    makeArrow(scene, a, b);
    makeArrow(scene, b, c);
    makeArrow(scene, c, a);

    expect(() => tidyUpElements([a, b, c], scene)).not.toThrow();
    expectNoOverlap([a, b, c]);
  });

  it("lays out disconnected components without overlap and keeps the diagram in place", () => {
    const a = makeRect(0, 0);
    const b = makeRect(500, 10);
    const c = makeRect(30, 400);
    const d = makeRect(900, 500);
    const scene = new Scene([a, b, c, d], { skipValidation: true });
    makeArrow(scene, a, b);
    makeArrow(scene, c, d);

    const minXBefore = Math.min(a.x, b.x, c.x, d.x);
    const minYBefore = Math.min(a.y, b.y, c.y, d.y);

    tidyUpElements([a, b, c, d], scene);

    expect(a.x).toBeLessThan(b.x);
    expect(c.x).toBeLessThan(d.x);
    expectNoOverlap([a, b, c, d]);

    // the whole diagram doesn't jump elsewhere on the canvas
    expect(Math.min(a.x, b.x, c.x, d.x)).toBeCloseTo(minXBefore, 5);
    expect(Math.min(a.y, b.y, c.y, d.y)).toBeCloseTo(minYBefore, 5);
  });

  it("does not overlap nodes of different sizes", () => {
    const a = makeRect(0, 0, 300, 40);
    const b = makeRect(100, 500, 60, 300);
    const c = makeRect(700, 100, 150, 120);
    const scene = new Scene([a, b, c], { skipValidation: true });
    makeArrow(scene, a, b);
    makeArrow(scene, a, c);

    tidyUpElements([a, b, c], scene);

    expect(a.x).toBeLessThan(b.x);
    expect(a.x).toBeLessThan(c.x);
    expectNoOverlap([a, b, c]);
  });

  it("moves groups as a whole", () => {
    const a = makeRect(0, 0, 100, 80, { groupIds: ["group-1"] });
    const b = makeRect(10, 200, 100, 80, { groupIds: ["group-1"] });
    const c = makeRect(800, 100);
    const scene = new Scene([a, b, c], { skipValidation: true });
    makeArrow(scene, a, c);

    const relX = b.x - a.x;
    const relY = b.y - a.y;

    tidyUpElements([a, b, c], scene);

    expect(b.x - a.x).toBeCloseTo(relX, 5);
    expect(b.y - a.y).toBeCloseTo(relY, 5);
    expect(a.groupIds).toEqual(["group-1"]);
    expect(b.groupIds).toEqual(["group-1"]);
  });

  it("moves frames together with their children", () => {
    const frame = newFrameElement({
      x: 0,
      y: 0,
      width: 300,
      height: 300,
    });
    const child = makeRect(50, 60, 100, 80, { frameId: frame.id });
    const other = makeRect(900, 100);
    const scene = new Scene([frame, child, other], { skipValidation: true });
    makeArrow(scene, child, other);

    const relX = child.x - frame.x;
    const relY = child.y - frame.y;

    tidyUpElements([frame, child, other], scene);

    expect(child.x - frame.x).toBeCloseTo(relX, 5);
    expect(child.y - frame.y).toBeCloseTo(relY, 5);
    expect(child.frameId).toBe(frame.id);
    expect(frame.x).toBeLessThan(other.x);
  });

  it("keeps bound text with its container", () => {
    const a = makeRect(0, 0);
    const text = newTextElement({
      x: a.x + 10,
      y: a.y + 20,
      width: 80,
      height: 40,
      text: "hello",
      containerId: a.id,
    }) as NonDeleted<ExcalidrawTextElementWithContainer>;
    mutateElement(a, new Map(), {
      boundElements: [{ id: text.id, type: "text" }],
    });
    const b = makeRect(800, 300);
    const scene = new Scene([a, text, b], { skipValidation: true });
    makeArrow(scene, a, b);

    const relX = text.x - a.x;
    const relY = text.y - a.y;

    tidyUpElements([a, text, b], scene);

    expect(text.x - a.x).toBeCloseTo(relX, 5);
    expect(text.y - a.y).toBeCloseTo(relY, 5);
    expect(text.containerId).toBe(a.id);
  });

  it("re-routes bound arrows to the new positions", () => {
    const a = makeRect(0, 0);
    const b = makeRect(1000, 0);
    const scene = new Scene([a, b], { skipValidation: true });
    const arrow = makeArrow(scene, a, b);
    const elbow = makeElbowArrow(scene, a, b);

    tidyUpElements([a, b], scene);

    for (const arr of [arrow, elbow]) {
      const startX = arr.x + arr.points[0][0];
      const startY = arr.y + arr.points[0][1];
      const endX = arr.x + arr.points[arr.points.length - 1][0];
      const endY = arr.y + arr.points[arr.points.length - 1][1];
      // endpoints follow the bound elements (within binding gap tolerance)
      expect(startX).toBeGreaterThan(a.x - 50);
      expect(startX).toBeLessThan(a.x + a.width + 50);
      expect(startY).toBeGreaterThan(a.y - 50);
      expect(startY).toBeLessThan(a.y + a.height + 50);
      expect(endX).toBeGreaterThan(b.x - 50);
      expect(endX).toBeLessThan(b.x + b.width + 50);
      expect(endY).toBeGreaterThan(b.y - 50);
      expect(endY).toBeLessThan(b.y + b.height + 50);
    }
  });

  it("preserves ids and is stable when run repeatedly", () => {
    const a = makeRect(500, 0);
    const b = makeRect(0, 600);
    const c = makeRect(900, 300);
    const scene = new Scene([a, b, c], { skipValidation: true });
    makeArrow(scene, a, b);
    makeArrow(scene, b, c);

    const idsBefore = scene.getNonDeletedElements().map((el) => el.id);

    tidyUpElements([a, b, c], scene);
    const positionsAfterFirst = scene
      .getNonDeletedElements()
      .map((el) => [el.x, el.y]);

    const secondRunUpdates = tidyUpElements([a, b, c], scene);
    const positionsAfterSecond = scene
      .getNonDeletedElements()
      .map((el) => [el.x, el.y]);

    // no element is recreated
    expect(scene.getNonDeletedElements().map((el) => el.id)).toEqual(idsBefore);
    // second run is a no-op
    expect(secondRunUpdates).toEqual([]);
    expect(positionsAfterSecond).toEqual(positionsAfterFirst);
  });
});
