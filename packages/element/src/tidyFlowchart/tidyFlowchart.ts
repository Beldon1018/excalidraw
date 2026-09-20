import {
  lineSegment,
  pointDistanceSq,
  type GlobalPoint,
} from "@excalidraw/math";

import { aabbForElement } from "../bounds";
import {
  calculateFixedPointForNonElbowArrowBinding,
  getBindingGap,
  getGlobalFixedPointForBindableElement,
  normalizeFixedPoint,
} from "../binding";
import { intersectElementWithLineSegment } from "../collision";
import { LinearElementEditor } from "../linearElementEditor";
import { getBoundTextElement, handleBindTextResize } from "../textElement";
import { isArrowElement, isElbowArrow } from "../typeChecks";

import { buildTidyUnits } from "./buildUnits";
import { layoutTidyUnits } from "./layout";
import { routeOrthogonalPath, segmentCrossesObstacle } from "./routeArrow";

import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  ExcalidrawElbowArrowElement,
  ExcalidrawElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "../types";
import type { Scene } from "../Scene";
import type { RectBox, TidyResult } from "./types";

const boxOfElement = (
  element: ExcalidrawElement,
  elementsMap: ElementsMap,
): RectBox => {
  const [minX, minY, maxX, maxY] = aabbForElement(element, elementsMap);
  return { minX, minY, maxX, maxY };
};

/**
 * Computes the scene point where an arrow end attaches to its bound element
 * (the binding focus point — the same point binding calculations use).
 */
const getBindingFocusPoint = (
  arrow: ExcalidrawArrowElement,
  startOrEnd: "start" | "end",
  elementsMap: ElementsMap,
): GlobalPoint | null => {
  const binding =
    startOrEnd === "start" ? arrow.startBinding : arrow.endBinding;
  if (!binding) {
    return null;
  }
  const bindable = elementsMap.get(binding.elementId) as
    | ExcalidrawBindableElement
    | undefined;
  if (!bindable) {
    return null;
  }
  return getGlobalFixedPointForBindableElement(
    normalizeFixedPoint(binding.fixedPoint),
    bindable,
    elementsMap,
  );
};

/**
 * Decides whether an arrow endpoint should sit on the outline of its bound
 * element (arrowhead ends) or at the exact binding fixed point, mirroring
 * Excalidraw's `updateBoundPoint` convention: when one of the ends has an
 * arrowhead, the arrow keeps a little gap from that shape so the head stays
 * fully visible.
 */
const resolveArrowEndpoint = (
  arrow: ExcalidrawArrowElement,
  startOrEnd: "start" | "end",
  focusPoint: GlobalPoint,
  neighborPoint: GlobalPoint,
  elementsMap: ElementsMap,
): GlobalPoint => {
  const binding =
    startOrEnd === "start" ? arrow.startBinding : arrow.endBinding;
  if (!binding || binding.mode === "inside") {
    return focusPoint;
  }

  const startHasArrowhead = arrow.startArrowhead !== null;
  const endHasArrowhead = arrow.endArrowhead !== null;
  const thisEndHasArrowhead =
    startOrEnd === "start" ? startHasArrowhead : endHasArrowhead;

  // no arrowheads, or arrowhead on the other end only → fixed focus point
  if (!startHasArrowhead && !endHasArrowhead) {
    return focusPoint;
  }
  if (!thisEndHasArrowhead) {
    return focusPoint;
  }

  const bindable = elementsMap.get(binding.elementId) as
    | ExcalidrawBindableElement
    | undefined;
  if (!bindable) {
    return focusPoint;
  }

  const intersections = intersectElementWithLineSegment(
    bindable,
    elementsMap,
    lineSegment(focusPoint, neighborPoint),
    getBindingGap(bindable, arrow),
  ).sort(
    (a, b) =>
      pointDistanceSq(a, neighborPoint) - pointDistanceSq(b, neighborPoint),
  );

  return intersections[0] ?? focusPoint;
};

/**
 * Re-routes a non-elbow arrow between its (already moved) bound elements.
 * Prefers a direct segment, and bends the path orthogonally whenever the
 * direct line would cut through an unrelated shape.
 */
const rerouteRegularArrow = (
  arrow: ExcalidrawArrowElement,
  scene: Scene,
  memberIdsByUnit: Map<string, Set<string>>,
  fromUnitId: string | null,
  toUnitId: string | null,
  unitById: Map<string, { assignedLayer?: number }>,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();

  const fromMembers =
    (fromUnitId ? memberIdsByUnit.get(fromUnitId) : undefined) ??
    new Set<string>();
  const toMembers =
    (toUnitId ? memberIdsByUnit.get(toUnitId) : undefined) ?? new Set<string>();

  const startBindingElement = arrow.startBinding
    ? (elementsMap.get(arrow.startBinding.elementId) as
        | ExcalidrawBindableElement
        | undefined)
    : undefined;
  const endBindingElement = arrow.endBinding
    ? (elementsMap.get(arrow.endBinding.elementId) as
        | ExcalidrawBindableElement
        | undefined)
    : undefined;

  // pick directional anchor points based on the layers of the two units:
  // forward edges leave the right / enter the left, same-layer edges route
  // vertically, and back/long edges still fall back to the stored fixed
  // points (the orthogonal router then bends around everything)
  const fromLayer = fromUnitId
    ? unitById.get(fromUnitId)?.assignedLayer
    : undefined;
  const toLayer = toUnitId ? unitById.get(toUnitId)?.assignedLayer : undefined;

  const anchorPointFor = (
    startOrEnd: "start" | "end",
    bindable: ExcalidrawBindableElement | undefined,
  ): GlobalPoint => {
    const fallback = LinearElementEditor.getPointAtIndexGlobalCoordinates(
      arrow,
      startOrEnd === "start" ? 0 : -1,
      elementsMap,
    );
    const binding =
      startOrEnd === "start" ? arrow.startBinding : arrow.endBinding;
    if (!bindable || !binding) {
      return fallback;
    }
    const focus = getBindingFocusPoint(arrow, startOrEnd, elementsMap);
    if (!focus || fromLayer === undefined || toLayer === undefined) {
      return focus ?? fallback;
    }

    const box = boxOfElement(bindable, elementsMap);

    if (fromLayer === toLayer) {
      // same column: leave the top node from its bottom, enter the bottom
      // node from its top (uses the bound element's fixed-point x, so the
      // connector still aligns with where the user attached it)
      const isStartUpper =
        startBindingElement && endBindingElement
          ? boxOfElement(startBindingElement, elementsMap).minY <
            boxOfElement(endBindingElement, elementsMap).minY
          : true;
      const startIsUpperNode =
        startOrEnd === "start" ? isStartUpper : !isStartUpper;
      return [focus[0], startIsUpperNode ? box.maxY : box.minY] as GlobalPoint;
    }

    // different columns: the start of a forward edge leaves from the right
    // side, its end enters from the left; reversed flow swaps the sides
    const forward = toLayer > fromLayer;
    const thisEndIsStart = startOrEnd === "start";
    const onLeft = thisEndIsStart ? !forward : forward;
    return [onLeft ? box.minX : box.maxX, focus[1]] as GlobalPoint;
  };

  let startPoint = anchorPointFor("start", startBindingElement);
  let endPoint = anchorPointFor("end", endBindingElement);

  const obstacles: RectBox[] = [];
  for (const element of scene.getNonDeletedElements()) {
    if (isArrowElement(element) || element.type === "text") {
      continue;
    }
    if (
      fromMembers.has(element.id) ||
      toMembers.has(element.id) ||
      element.id === arrow.id
    ) {
      continue;
    }
    obstacles.push(boxOfElement(element, elementsMap));
  }

  const isForwardEdge =
    fromLayer !== undefined &&
    toLayer !== undefined &&
    toLayer === fromLayer + 1;

  let globalPath: GlobalPoint[];

  if (
    isForwardEdge &&
    !segmentCrossesObstacle(startPoint, endPoint, obstacles)
  ) {
    globalPath = [startPoint, endPoint];
  } else {
    const routed = routeOrthogonalPath(startPoint, endPoint, obstacles);
    globalPath = routed ?? [startPoint, endPoint];
    if (routed) {
      startPoint = routed[0];
      endPoint = routed[routed.length - 1];
    }
  }

  // snap arrowhead ends onto the shape outline so the head is never hidden
  // inside the node; endpoints without an arrowhead stay at the fixed point
  if (globalPath.length >= 2) {
    const lastIndex = globalPath.length - 1;
    if (arrow.startBinding) {
      globalPath[0] = resolveArrowEndpoint(
        arrow,
        "start",
        startPoint,
        globalPath[1],
        elementsMap,
      );
    }
    if (arrow.endBinding) {
      globalPath[lastIndex] = resolveArrowEndpoint(
        arrow,
        "end",
        endPoint,
        globalPath[lastIndex - 1],
        elementsMap,
      );
    }
  }

  // Excalidraw stores arrow points relative to the first point, which has
  // to stay at [0, 0]; movePoints handles that normalization.
  const localPath = globalPath.map((point) =>
    LinearElementEditor.createPointAt(
      arrow,
      elementsMap,
      point[0],
      point[1],
      null,
    ),
  );

  const updates = new Map(localPath.map((point, index) => [index, { point }]));

  // re-anchor the bindings at the new attachment points. Updating the
  // fixedPoint ratios is essential: history replay recomputes arrow points
  // from the stored fixed points, so leaving stale ratios would snap the
  // arrow back to its pre-tidy position on undo/redo and collaboration.
  let nextStartBinding = undefined;
  let nextEndBinding = undefined;
  if (arrow.startBinding && startBindingElement) {
    nextStartBinding = {
      ...arrow.startBinding,
      ...calculateFixedPointForNonElbowArrowBinding(
        arrow as NonDeleted<ExcalidrawArrowElement>,
        startBindingElement as NonDeleted<ExcalidrawBindableElement>,
        "start",
        elementsMap,
        globalPath[0],
      ),
    };
  }
  if (arrow.endBinding && endBindingElement) {
    nextEndBinding = {
      ...arrow.endBinding,
      ...calculateFixedPointForNonElbowArrowBinding(
        arrow as NonDeleted<ExcalidrawArrowElement>,
        endBindingElement as NonDeleted<ExcalidrawBindableElement>,
        "end",
        elementsMap,
        globalPath[globalPath.length - 1],
      ),
    };
  }

  LinearElementEditor.movePoints(
    arrow as NonDeleted<ExcalidrawArrowElement>,
    scene,
    updates,
    {
      ...(nextStartBinding ? { startBinding: nextStartBinding } : {}),
      ...(nextEndBinding ? { endBinding: nextEndBinding } : {}),
    },
  );
};

/**
 * Re-routes an elbow arrow by clearing its manually fixed segments and
 * letting Excalidraw's elbow router recompute the full orthogonal path
 * from the current (moved) bindings.
 */
const rerouteElbowArrow = (arrow: ExcalidrawArrowElement, scene: Scene) => {
  scene.mutateElement(arrow as NonDeleted<ExcalidrawElbowArrowElement>, {
    fixedSegments: null,
  });
};

/**
 * Automatically tidies the supplied selected elements into a left-to-right
 * hierarchical flowchart layout.
 *
 * Elements are never recreated: every selected element keeps its id,
 * z-order, group ids, frame association and bindings. The function only
 * translates whole "units" (shapes, groups or frames incl. their labels) and
 * adjusts the connected arrows to point at the new positions.
 */
export const tidyFlowchartElements = (
  selectedElements: NonDeletedExcalidrawElement[],
  scene: Scene,
): TidyResult => {
  const elementsMap = scene.getNonDeletedElementsMap();
  const allElements = scene.getNonDeletedElements();

  const input = buildTidyUnits(selectedElements, allElements, elementsMap);

  // static obstacles: non-selected (or otherwise not-moving) elements
  const movingElementIds = new Set<ExcalidrawElement["id"]>();
  for (const unit of input.units.values()) {
    for (const id of unit.members) {
      movingElementIds.add(id);
    }
  }
  const obstacleBoxes: Array<RectBox & { unitId?: string }> = [];
  for (const element of allElements) {
    if (movingElementIds.has(element.id) || isArrowElement(element)) {
      continue;
    }
    obstacleBoxes.push(boxOfElement(element, elementsMap));
  }

  layoutTidyUnits(input, obstacleBoxes);

  const translations = new Map<string, { dx: number; dy: number }>();
  for (const unit of input.units.values()) {
    translations.set(unit.id, {
      dx: unit.targetMinX - unit.originalBox.minX,
      dy: unit.targetMinY - unit.originalBox.minY,
    });
  }

  const memberIdsByUnit = new Map<string, Set<string>>();
  const unitByMember = new Map<string, string>();
  for (const unit of input.units.values()) {
    const set = new Set(unit.members);
    memberIdsByUnit.set(unit.id, set);
    for (const id of unit.members) {
      unitByMember.set(id, unit.id);
    }
  }

  // ------------------------------------------------------------------
  // 1. Translate every unit (shapes + their bound container labels,
  //    frames + children, groups + rigid members) as one rigid body.
  // ------------------------------------------------------------------
  const updatedElements = new Map<string, ExcalidrawElement>();

  for (const unit of input.units.values()) {
    const { dx, dy } = translations.get(unit.id)!;
    if (dx === 0 && dy === 0) {
      continue;
    }
    for (const id of unit.members) {
      const element = elementsMap.get(id);
      if (!element || element.isDeleted) {
        continue;
      }
      if (isArrowElement(element)) {
        if (isElbowArrow(element)) {
          // elbow arrows recompute their orthogonal route from x/y +
          // bindings inside mutateElement — a plain translation is enough
          const updated = scene.mutateElement(element, {
            x: element.x + dx,
            y: element.y + dy,
          });
          updatedElements.set(id, updated);
        } else {
          // translate the whole polyline rigidly, keeping every segment
          const rigidPoints = new Map(
            element.points.map((point, index) => [
              index,
              {
                point: [point[0] + dx, point[1] + dy] as GlobalPoint,
              },
            ]),
          );
          LinearElementEditor.movePoints(
            element as NonDeleted<ExcalidrawArrowElement>,
            scene,
            rigidPoints as any,
          );
          updatedElements.set(id, elementsMap.get(id)!);
        }
        continue;
      }

      const updated = scene.mutateElement(element, {
        x: element.x + dx,
        y: element.y + dy,
      });
      updatedElements.set(id, updated);

      const boundText = getBoundTextElement(element, elementsMap);
      if (boundText && !unit.members.includes(boundText.id)) {
        scene.mutateElement(boundText, {
          x: boundText.x + dx,
          y: boundText.y + dy,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Re-route the connected arrows after all units are in place
  // ------------------------------------------------------------------
  const reroutedArrows: ExcalidrawArrowElement[] = [];

  for (const edge of input.edges) {
    const arrow = elementsMap.get(edge.arrow.id) as
      | ExcalidrawArrowElement
      | undefined;
    if (!arrow || arrow.isDeleted) {
      continue;
    }

    const startUnitId = edge.reversed ? edge.toUnit : edge.fromUnit;
    const endUnitId = edge.reversed ? edge.fromUnit : edge.toUnit;

    const startMoved =
      !!startUnitId &&
      ((translations.get(startUnitId)?.dx ?? 0) !== 0 ||
        (translations.get(startUnitId)?.dy ?? 0) !== 0);
    const endMoved =
      !!endUnitId &&
      ((translations.get(endUnitId)?.dx ?? 0) !== 0 ||
        (translations.get(endUnitId)?.dy ?? 0) !== 0);

    // self-loops move together with their (single) unit and stay valid, but
    // re-route them anyway in case the shape size drives a different path.
    if (!startMoved && !endMoved) {
      continue;
    }

    if (isElbowArrow(arrow)) {
      rerouteElbowArrow(arrow, scene);
    } else {
      rerouteRegularArrow(
        arrow,
        scene,
        memberIdsByUnit,
        startUnitId,
        endUnitId,
        input.units,
      );
    }

    // arrow labels are positioned from the arrow geometry; nudge the
    // bound text to its new position so it never lags behind
    const boundText = getBoundTextElement(arrow, elementsMap);
    if (boundText && !boundText.isDeleted) {
      handleBindTextResize(arrow, scene, false);
    }

    reroutedArrows.push(arrow);
  }

  return { translations, reroutedArrows };
};

export { buildTidyUnits } from "./buildUnits";
export { layoutTidyUnits } from "./layout";
export { routeOrthogonalPath, segmentCrossesObstacle } from "./routeArrow";
export type {
  TidyInput,
  TidyResult,
  TidyUnit,
  TidyEdge,
  RectBox,
} from "./types";
