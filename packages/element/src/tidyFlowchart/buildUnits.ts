import { aabbForElement } from "../bounds";
import { getBoundTextElement } from "../textElement";
import {
  isArrowElement,
  isBoundToContainer,
  isFrameLikeElement,
} from "../typeChecks";

import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawElement,
} from "../types";
import type { RectBox, TidyEdge, TidyInput, TidyUnit } from "./types";

const uniteBoxes = (boxes: RectBox[]): RectBox => {
  if (boxes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let { minX, minY, maxX, maxY } = boxes[0];
  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  return { minX, minY, maxX, maxY };
};

const boxOf = (
  element: ExcalidrawElement,
  elementsMap: ElementsMap,
): RectBox => {
  const [minX, minY, maxX, maxY] = aabbForElement(element, elementsMap);
  return { minX, minY, maxX, maxY };
};

/**
 * Groups the selected non-deleted elements into the atomic "units" the tidy
 * layout moves:
 *
 * - a selected frame/magicframe forms one unit together with every child
 *   element that is clipped inside the frame,
 * - grouped elements are bucketed by their outermost (top-level) group id,
 *   so nested groups still move rigidly together,
 * - arrows that are members of such a group move rigidly with the group,
 * - every other selected element is a unit of its own.
 *
 * Bound container labels are always attached to the unit of their container.
 */
export const buildTidyUnits = (
  selectedElements: readonly ExcalidrawElement[],
  allElements: readonly ExcalidrawElement[],
  elementsMap: ElementsMap,
): TidyInput => {
  const selectedIds = new Set(selectedElements.map((el) => el.id));

  // ------------------------------------------------------------------
  // 1. Frames: frame + all of its children move as a single rigid unit
  // ------------------------------------------------------------------
  const units = new Map<string, TidyUnit>();
  const elementToUnit = new Map<ExcalidrawElement["id"], string>();
  const rigidArrowIds = new Set<ExcalidrawArrowElement["id"]>();

  const selectedFrames = selectedElements.filter(isFrameLikeElement);
  const frameChildrenById = new Map<string, ExcalidrawElement[]>();
  for (const element of allElements) {
    if (element.isDeleted || !element.frameId) {
      continue;
    }
    const children = frameChildrenById.get(element.frameId);
    if (children) {
      children.push(element);
    } else {
      frameChildrenById.set(element.frameId, [element]);
    }
  }

  for (const frame of selectedFrames) {
    const unitId = `frame:${frame.id}`;
    const members: ExcalidrawElement["id"][] = [frame.id];
    elementToUnit.set(frame.id, unitId);
    for (const child of frameChildrenById.get(frame.id) ?? []) {
      if (child.isDeleted) {
        continue;
      }
      members.push(child.id);
      elementToUnit.set(child.id, unitId);
      selectedIds.add(child.id);
      if (isArrowElement(child)) {
        rigidArrowIds.add(child.id);
      }
    }
    units.set(unitId, {
      id: unitId,
      members,
      originalBox: uniteBoxes(
        members
          .map((id) => elementsMap.get(id))
          .filter((el): el is ExcalidrawElement => !!el && !el.isDeleted)
          .map((el) => boxOf(el, elementsMap)),
      ),
      targetMinX: 0,
      targetMinY: 0,
    });
  }

  // ------------------------------------------------------------------
  // 2. Groups: elements sharing their outermost group id move together
  // ------------------------------------------------------------------
  const groupBuckets = new Map<string, ExcalidrawElement[]>();
  for (const element of selectedElements) {
    if (element.isDeleted || elementToUnit.has(element.id)) {
      continue;
    }
    const groupId = element.groupIds[0];
    if (!groupId) {
      continue;
    }
    const bucket = groupBuckets.get(groupId);
    if (bucket) {
      bucket.push(element);
    } else {
      groupBuckets.set(groupId, [element]);
    }
  }

  for (const [groupId, members0] of groupBuckets) {
    const unitId = `group:${groupId}`;
    const withDependents: ExcalidrawElement[] = [];
    for (const member of members0) {
      withDependents.push(member);
      elementToUnit.set(member.id, unitId);
      if (isArrowElement(member)) {
        rigidArrowIds.add(member.id);
      }
      const boundText = getBoundTextElement(member, elementsMap);
      if (boundText && !boundText.isDeleted) {
        withDependents.push(boundText);
        elementToUnit.set(boundText.id, unitId);
      }
    }
    units.set(unitId, {
      id: unitId,
      members: withDependents.map((el) => el.id),
      originalBox: uniteBoxes(
        withDependents.map((el) => boxOf(el, elementsMap)),
      ),
      targetMinX: 0,
      targetMinY: 0,
    });
  }

  // ------------------------------------------------------------------
  // 3. Remaining elements: units of their own (+ bound container labels)
  // ------------------------------------------------------------------
  for (const element of selectedElements) {
    if (element.isDeleted || elementToUnit.has(element.id)) {
      continue;
    }
    if (isBoundToContainer(element)) {
      // handled alongside its container
      continue;
    }
    const unitId = `element:${element.id}`;
    const members: ExcalidrawElement["id"][] = [element.id];
    elementToUnit.set(element.id, unitId);

    if (!isArrowElement(element)) {
      const boundText = getBoundTextElement(element, elementsMap);
      if (boundText && !boundText.isDeleted) {
        members.push(boundText.id);
        elementToUnit.set(boundText.id, unitId);
      }
    }

    units.set(unitId, {
      id: unitId,
      members,
      originalBox: uniteBoxes(
        members
          .map((id) => elementsMap.get(id))
          .filter((el): el is ExcalidrawElement => !!el && !el.isDeleted)
          .map((el) => boxOf(el, elementsMap)),
      ),
      targetMinX: 0,
      targetMinY: 0,
    });
  }

  // ------------------------------------------------------------------
  // 4. Derive edges from *every* arrow in the scene that touches at
  //    least one of the moving units. Arrows don't have to be selected:
  //    selecting only the shapes still has to produce the flowchart
  //    layout and the connectors must follow.
  // ------------------------------------------------------------------
  const unitOfBindable = (id: ExcalidrawElement["id"] | null) =>
    id ? elementToUnit.get(id) ?? null : null;

  const edges: TidyEdge[] = [];
  for (const element of allElements) {
    if (!isArrowElement(element) || element.isDeleted) {
      continue;
    }
    if (rigidArrowIds.has(element.id)) {
      continue;
    }

    const startUnitId = unitOfBindable(element.startBinding?.elementId ?? null);
    const endUnitId = unitOfBindable(element.endBinding?.elementId ?? null);

    if (!startUnitId && !endUnitId) {
      continue;
    }

    const onlyEndHasArrowhead =
      element.startArrowhead === null && element.endArrowhead !== null;
    const onlyStartHasArrowhead =
      element.endArrowhead === null && element.startArrowhead !== null;

    const reversed = onlyStartHasArrowhead && !onlyEndHasArrowhead;

    edges.push({
      arrow: element,
      fromUnit: reversed ? endUnitId : startUnitId,
      toUnit: reversed ? startUnitId : endUnitId,
      reversed,
    });
  }

  const allBoxes = [...units.values()].map((unit) => unit.originalBox);

  return {
    units,
    edges,
    rigidArrowIds,
    selectionBox: uniteBoxes(allBoxes),
  };
};
