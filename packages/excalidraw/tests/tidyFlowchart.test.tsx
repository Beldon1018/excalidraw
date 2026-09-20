import { bindBindingElement } from "@excalidraw/element";

import { act } from "@testing-library/react";

import type {
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { actionTidyFlowchart } from "../actions/actionTidyFlowchart";
import { createRedoAction, createUndoAction } from "../actions/actionHistory";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { UI } from "./helpers/ui";
import { render, unmountComponent } from "./test-utils";

unmountComponent();

const { h } = window;

const bind = (
  arrow: ExcalidrawArrowElement,
  start: ExcalidrawBindableElement,
  end: ExcalidrawBindableElement,
) => {
  act(() => {
    bindBindingElement(
      arrow as NonDeleted<ExcalidrawArrowElement>,
      start as NonDeleted<ExcalidrawBindableElement>,
      "orbit",
      "start",
      h.app.scene,
    );
    bindBindingElement(
      arrow as NonDeleted<ExcalidrawArrowElement>,
      end as NonDeleted<ExcalidrawBindableElement>,
      "orbit",
      "end",
      h.app.scene,
    );
  });
};

const snapshot = () =>
  h.elements
    .filter((element) => !element.isDeleted)
    .map((element) => ({
      id: element.id,
      type: element.type,
      x: Math.round(element.x * 1000) / 1000,
      y: Math.round(element.y * 1000) / 1000,
    }));

describe("tidy flowchart action", () => {
  beforeEach(async () => {
    localStorage.clear();
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    h.state.width = 1920;
    h.state.height = 1080;
  });

  it("arranges a branch/merge diagram left-to-right and keeps ids & bindings", () => {
    const a = UI.createElement("rectangle", {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const b = UI.createElement("rectangle", {
      x: 400,
      y: -200,
      width: 100,
      height: 50,
    });
    const c = UI.createElement("rectangle", {
      x: 350,
      y: 250,
      width: 120,
      height: 70,
    });
    const d = UI.createElement("rectangle", {
      x: 800,
      y: 50,
      width: 100,
      height: 50,
    });
    const arrow1 = UI.createElement("arrow", {
      x: 110,
      y: 20,
      width: 280,
      height: 1,
    });
    const arrow2 = UI.createElement("arrow", {
      x: 110,
      y: 20,
      width: 250,
      height: 240,
    });
    const arrow3 = UI.createElement("arrow", {
      x: 505,
      y: -170,
      width: 290,
      height: 230,
    });
    const arrow4 = UI.createElement("arrow", {
      x: 475,
      y: 300,
      width: 330,
      height: 1,
    });

    bind(arrow1.get() as ExcalidrawArrowElement, a.get(), b.get());
    bind(arrow2.get() as ExcalidrawArrowElement, a.get(), c.get());
    bind(arrow3.get() as ExcalidrawArrowElement, b.get(), d.get());
    bind(arrow4.get() as ExcalidrawArrowElement, c.get(), d.get());

    const idsBefore = h.elements.map((element) => element.id);

    API.setSelectedElements([a.get(), b.get(), c.get(), d.get()]);
    API.executeAction(actionTidyFlowchart);

    const elementsById = new Map(
      h.elements.map((element) => [element.id, element]),
    );

    // ids preserved, no elements recreated
    expect(h.elements.map((element) => element.id)).toEqual(idsBefore);

    const ax = elementsById.get(a.id)!;
    const bx = elementsById.get(b.id)!;
    const cx = elementsById.get(c.id)!;
    const dx = elementsById.get(d.id)!;

    // layers: a → (b,c) → d, columns strictly increasing
    expect(ax.x + ax.width).toBeLessThan(bx.x);
    expect(ax.x + ax.width).toBeLessThan(cx.x);
    expect(bx.x + bx.width).toBeLessThan(dx.x);
    expect(cx.x + cx.width).toBeLessThan(dx.x);

    // b and c in the same column do not overlap
    expect(bx.y + bx.height).toBeLessThan(cx.y);

    // arrows still bound to the same elements
    const updatedArrows = [arrow1, arrow2, arrow3, arrow4].map((proxy) =>
      elementsById.get(proxy.id),
    ) as ExcalidrawArrowElement[];
    for (const [arrow, startId, endId] of [
      [updatedArrows[0], a.id, b.id],
      [updatedArrows[1], a.id, c.id],
      [updatedArrows[2], b.id, d.id],
      [updatedArrows[3], c.id, d.id],
    ] as const) {
      expect(arrow.startBinding?.elementId).toBe(startId);
      expect(arrow.endBinding?.elementId).toBe(endId);
    }
  });

  it("moves a group rigidly and tidies with the rest of the graph", () => {
    const groupId = "group-rigid-test";
    const member1 = API.createElement({
      type: "rectangle",
      id: "g-member-1",
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      groupIds: [groupId],
    });
    const member2 = API.createElement({
      type: "rectangle",
      id: "g-member-2",
      x: 45,
      y: 5,
      width: 40,
      height: 40,
      groupIds: [groupId],
    });
    const target = API.createElement({
      type: "rectangle",
      id: "g-target",
      x: 600,
      y: 0,
      width: 60,
      height: 60,
    });
    const arrow = API.createElement({
      type: "arrow",
      id: "g-arrow",
      x: 95,
      y: 30,
      width: 500,
      height: 5,
      points: [
        [0, 0],
        [500, 5],
      ],
      groupIds: [groupId],
    });
    API.setElements([member1, member2, target, arrow]);
    bind(
      arrow,
      member1 as unknown as ExcalidrawBindableElement,
      target as unknown as ExcalidrawBindableElement,
    );

    // the arrow is part of the group and thus selected with the members;
    // selecting all three keeps the group unit together while the arrow
    // still connects the group to the outside target
    API.setSelectedElements([member1, member2, arrow, target]);
    API.executeAction(actionTidyFlowchart);

    const after1 = h.elements.find((el) => el.id === "g-member-1")!;
    const after2 = h.elements.find((el) => el.id === "g-member-2")!;
    const afterArrow = h.elements.find(
      (el) => el.id === "g-arrow",
    ) as ExcalidrawArrowElement;

    // the two grouped members translated by the exact same delta
    expect(after2.x - after1.x).toBeCloseTo(45, 10);
    expect(after2.y - after1.y).toBeCloseTo(5, 10);
    expect(after1.groupIds).toContain(groupId);
    expect(after2.groupIds).toContain(groupId);
    expect(afterArrow.groupIds).toContain(groupId);
    // the rigid arrow kept its exact segment geometry (just translated)
    expect(afterArrow.points[1][0] - afterArrow.points[0][0]).toBeCloseTo(
      500,
      10,
    );
    expect(afterArrow.points[1][1] - afterArrow.points[0][1]).toBeCloseTo(
      5,
      10,
    );
  });

  it("is stable across repeated tidies and does not move the whole diagram", () => {
    const a = UI.createElement("rectangle", {
      x: 100,
      y: 100,
      width: 100,
      height: 50,
    });
    const b = UI.createElement("rectangle", {
      x: 700,
      y: 500,
      width: 100,
      height: 50,
    });
    const arrow = UI.createElement("arrow", {
      x: 205,
      y: 120,
      width: 490,
      height: 390,
    });
    bind(arrow.get() as ExcalidrawArrowElement, a.get(), b.get());

    API.setSelectedElements([a.get(), b.get()]);
    API.executeAction(actionTidyFlowchart);
    const first = snapshot();

    API.executeAction(actionTidyFlowchart);
    const second = snapshot();
    expect(second).toEqual(first);

    // the diagram keeps its original top-left anchor
    const nodeA = h.elements.find((element) => element.id === a.id)!;
    expect(nodeA.x).toBe(100);
    expect(nodeA.y).toBe(100);
  });

  it("supports a single undo and redo", () => {
    const a = UI.createElement("rectangle", {
      x: 400,
      y: 600,
      width: 100,
      height: 50,
    });
    const b = UI.createElement("rectangle", {
      x: 50,
      y: 50,
      width: 100,
      height: 50,
    });
    const arrow = UI.createElement("arrow", {
      x: 155,
      y: 70,
      width: 290,
      height: -540,
    });
    bind(arrow.get() as ExcalidrawArrowElement, b.get(), a.get());

    API.setSelectedElements([a.get(), b.get()]);
    API.executeAction(actionTidyFlowchart);
    const tidied = snapshot();

    API.executeAction(createUndoAction(h.history));
    const undone = snapshot();
    expect(undone).not.toEqual(tidied);
    const afterUndo = h.elements.find((element) => element.id === b.id)!;
    expect(afterUndo.x).toBe(50);
    expect(afterUndo.y).toBe(50);

    API.executeAction(createRedoAction(h.history));
    const redone = snapshot();
    expect(redone).not.toEqual(undone);
    // nodes return to their tidied positions
    const redoneA = h.elements.find((element) => element.id === a.id)!;
    const redoneB = h.elements.find((element) => element.id === b.id)!;
    const tidiedA = tidied.find((entry) => entry.id === a.id)!;
    const tidiedB = tidied.find((entry) => entry.id === b.id)!;
    expect(redoneA.x).toBeCloseTo(tidiedA.x, 6);
    expect(redoneA.y).toBeCloseTo(tidiedA.y, 6);
    expect(redoneB.x).toBeCloseTo(tidiedB.x, 6);
    expect(redoneB.y).toBeCloseTo(tidiedB.y, 6);
  });

  it("re-routes elbow arrows to the new node positions", () => {
    const a = API.createElement({
      type: "rectangle",
      id: "elbow-a",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const b = API.createElement({
      type: "rectangle",
      id: "elbow-b",
      x: 500,
      y: 300,
      width: 100,
      height: 50,
    });
    const arrow = API.createElement({
      type: "arrow",
      id: "elbow-arrow",
      x: 100,
      y: 25,
      width: 400,
      height: 1,
      elbowed: true,
      points: [
        [0, 0],
        [400, 0],
      ],
    });
    API.setElements([a, b, arrow]);
    bind(
      arrow as unknown as ExcalidrawArrowElement,
      a as unknown as ExcalidrawBindableElement,
      b as unknown as ExcalidrawBindableElement,
    );

    API.setSelectedElements([a, b]);
    API.executeAction(actionTidyFlowchart);

    const updated = h.elements.find(
      (element) => element.id === "elbow-arrow",
    ) as ExcalidrawArrowElement;
    expect(updated.startBinding?.elementId).toBe("elbow-a");
    expect(updated.endBinding?.elementId).toBe("elbow-b");
    // elbow routing produces the orthogonal multi-point path
    expect(updated.elbowed).toBe(true);
    expect(updated.points.length).toBeGreaterThanOrEqual(2);
  });

  it("moves a frame and all of its children rigidly", () => {
    const [rect, label] = API.createTextContainer();
    const target = API.createElement({
      type: "rectangle",
      id: "label-target",
      x: 800,
      y: 300,
      width: 100,
      height: 60,
    });
    const [arrow, arrowLabel] = API.createLabeledArrow();
    API.setElements([rect, label, target, arrow, arrowLabel]);
    bind(
      arrow as unknown as ExcalidrawArrowElement,
      rect as unknown as ExcalidrawBindableElement,
      target as unknown as ExcalidrawBindableElement,
    );

    API.setSelectedElements([rect, target]);
    API.executeAction(actionTidyFlowchart);

    const movedRect = h.elements.find((el) => el.id === rect.id)!;
    const movedLabel = h.elements.find((el) => el.id === label.id)!;
    const movedArrow = h.elements.find((el) => el.id === arrow.id)!;
    const movedArrowLabel = h.elements.find((el) => el.id === arrowLabel.id)!;

    // container label translates by the same delta as its container
    expect(movedLabel.x).toBeCloseTo(label.x + (movedRect.x - rect.x), 6);
    expect(movedLabel.y).toBeCloseTo(label.y + (movedRect.y - rect.y), 6);
    expect((movedLabel as any).containerId).toBe(rect.id);

    // arrow + its label survive, arrow stays connected
    expect(movedArrow.type).toBe("arrow");
    expect((movedArrow as ExcalidrawArrowElement).endBinding?.elementId).toBe(
      target.id,
    );
    expect((movedArrowLabel as any).containerId).toBe(arrow.id);
  });

  it("moves a frame and all of its children rigidly", () => {
    const frame = API.createElement({
      type: "frame",
      id: "tidy-frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
    const inside = API.createElement({
      type: "rectangle",
      id: "tidy-frame-child",
      x: 40,
      y: 50,
      width: 80,
      height: 40,
      frameId: "tidy-frame",
    });
    const outside = API.createElement({
      type: "diamond",
      id: "tidy-frame-outside",
      x: 700,
      y: 60,
      width: 100,
      height: 80,
    });
    const arrow = API.createElement({
      type: "arrow",
      id: "tidy-frame-arrow",
      x: 125,
      y: 60,
      width: 570,
      height: 20,
    });

    API.setElements([frame, inside, outside, arrow]);
    bind(
      arrow,
      inside as unknown as ExcalidrawBindableElement,
      outside as unknown as ExcalidrawBindableElement,
    );

    API.setSelectedElements([frame, outside]);
    API.executeAction(actionTidyFlowchart);

    const movedFrame = h.elements.find((el) => el.id === "tidy-frame")!;
    const movedChild = h.elements.find((el) => el.id === "tidy-frame-child")!;

    // frame and child translated by the identical delta
    const frameDx = movedFrame.x - 0;
    const frameDy = movedFrame.y - 0;
    expect(movedChild.x).toBeCloseTo(40 + frameDx, 10);
    expect(movedChild.y).toBeCloseTo(50 + frameDy, 10);
    // frame association is preserved
    expect(movedChild.frameId).toBe("tidy-frame");

    // connected arrow kept its bindings
    const movedArrow = h.elements.find(
      (el) => el.id === "tidy-frame-arrow",
    ) as ExcalidrawArrowElement;
    expect(movedArrow.startBinding?.elementId).toBe("tidy-frame-child");
    expect(movedArrow.endBinding?.elementId).toBe("tidy-frame-outside");
  });
});
