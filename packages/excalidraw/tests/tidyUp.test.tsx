import React from "react";

import { reseed } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";
import { bindBindingElement } from "@excalidraw/element";

import type {
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { actionTidyUp } from "../actions/actionTidyUp";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { act, render } from "./test-utils";

const { h } = window;

describe("tidy up", () => {
  beforeEach(async () => {
    localStorage.clear();
    reseed(7);
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  const setupFlow = () => {
    // intentionally scrambled: target (rectA) is to the left of source (rectB)
    const rectA = API.createElement({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 120,
      height: 80,
    });
    const rectB = API.createElement({
      type: "rectangle",
      x: 600,
      y: 400,
      width: 120,
      height: 80,
    });
    const arrow = API.createElement({
      type: "arrow",
      x: 130,
      y: 40,
      width: 460,
      height: 400,
      points: [pointFrom(0, 0), pointFrom(460, 400)],
    }) as NonDeleted<ExcalidrawArrowElement>;
    API.updateScene({
      elements: [rectA, rectB, arrow],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    act(() => {
      bindBindingElement(
        arrow,
        rectB as NonDeleted<ExcalidrawBindableElement>,
        "orbit",
        "start",
        h.app.scene,
      );
      bindBindingElement(
        arrow,
        rectA as NonDeleted<ExcalidrawBindableElement>,
        "orbit",
        "end",
        h.app.scene,
      );
    });
    API.setAppState({
      selectedElementIds: { [rectA.id]: true, [rectB.id]: true },
    });
    return { rectA, rectB, arrow };
  };

  it("lays out the flowchart left-to-right following arrow direction", () => {
    const { rectA, rectB, arrow } = setupFlow();

    act(() => {
      API.executeAction(actionTidyUp);
    });

    const a = API.getElement(rectA);
    const b = API.getElement(rectB);
    // source (B) ends up left of target (A)
    expect(b.x).toBeLessThan(a.x);
    // ids and bindings are preserved
    expect(h.elements.map((el) => el.id)).toEqual([
      rectA.id,
      rectB.id,
      arrow.id,
    ]);
    const updatedArrow = API.getElement(arrow) as ExcalidrawArrowElement;
    expect(updatedArrow.startBinding?.elementId).toBe(rectB.id);
    expect(updatedArrow.endBinding?.elementId).toBe(rectA.id);
    // arrow follows the moved elements instead of pointing to old positions
    const endX = updatedArrow.x + updatedArrow.points.at(-1)![0];
    expect(Math.abs(endX - (a.x + a.width / 2))).toBeLessThan(a.width);
  });

  it("restores the original state with a single undo and reapplies with redo", () => {
    const { rectA, rectB } = setupFlow();

    act(() => {
      API.executeAction(actionTidyUp);
    });

    const tidiedA = API.getElement(rectA);
    const tidiedB = API.getElement(rectB);
    expect(tidiedB.x).toBeLessThan(tidiedA.x);

    act(() => {
      Keyboard.undo();
    });

    expect(API.getElement(rectA).x).toBe(0);
    expect(API.getElement(rectA).y).toBe(0);
    expect(API.getElement(rectB).x).toBe(600);
    expect(API.getElement(rectB).y).toBe(400);

    act(() => {
      Keyboard.redo();
    });

    expect(API.getElement(rectA).x).toBe(tidiedA.x);
    expect(API.getElement(rectA).y).toBe(tidiedA.y);
    expect(API.getElement(rectB).x).toBe(tidiedB.x);
    expect(API.getElement(rectB).y).toBe(tidiedB.y);
  });

  it("keeps the diagram in place when tidied repeatedly", () => {
    const { rectA, rectB } = setupFlow();

    act(() => {
      API.executeAction(actionTidyUp);
    });
    const firstA = { ...API.getElement(rectA) };
    const firstB = { ...API.getElement(rectB) };

    act(() => {
      API.executeAction(actionTidyUp);
    });
    expect(API.getElement(rectA).x).toBe(firstA.x);
    expect(API.getElement(rectA).y).toBe(firstA.y);
    expect(API.getElement(rectB).x).toBe(firstB.x);
    expect(API.getElement(rectB).y).toBe(firstB.y);
  });
});
