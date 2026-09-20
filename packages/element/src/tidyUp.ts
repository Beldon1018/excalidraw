import { updateBoundElements } from "./binding";
import { getCommonBoundingBox } from "./bounds";
import { getFrameChildren } from "./frame";
import { getBoundTextElement } from "./textElement";
import {
  isArrowElement,
  isBoundToContainer,
  isFrameLikeElement,
  isLinearElement,
} from "./typeChecks";

import type { Scene } from "./Scene";
import type { ElementsMap, NonDeletedExcalidrawElement } from "./types";

const HORIZONTAL_GAP = 100;
const VERTICAL_GAP = 60;
const COMPONENT_GAP = 120;

interface TidyUnit {
  id: string;
  /** elements translated together (bound text included) */
  elements: NonDeletedExcalidrawElement[];
  width: number;
  height: number;
  /** original bounding box */
  minX: number;
  minY: number;
  midX: number;
  midY: number;
  /** computed target position */
  targetX: number;
  targetY: number;
}

const compareUnits = (a: TidyUnit, b: TidyUnit) =>
  a.midY - b.midY ||
  a.midX - b.midX ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Partitions selected elements into atomic units: frames (with their
 * children), groups (with all their members) and standalone elements.
 * Linear elements (arrows/lines) and freedraw are not turned into units —
 * bound arrows are re-routed after the layout, unbound ones stay in place.
 */
const buildUnits = (
  selectedElements: NonDeletedExcalidrawElement[],
  scene: Scene,
  elementsMap: ElementsMap,
): TidyUnit[] => {
  const allElements = scene.getNonDeletedElements();
  const units: TidyUnit[] = [];
  const claimed = new Set<string>();
  const claimedGroups = new Set<string>();

  const withBoundText = (
    members: NonDeletedExcalidrawElement[],
  ): NonDeletedExcalidrawElement[] => {
    const result = [...members];
    for (const member of members) {
      const boundText = getBoundTextElement(member, elementsMap);
      if (boundText && !result.includes(boundText)) {
        result.push(boundText);
      }
    }
    return result;
  };

  const addUnit = (id: string, members: NonDeletedExcalidrawElement[]) => {
    const elements = withBoundText(members);
    if (!elements.length) {
      return;
    }
    const bbox = getCommonBoundingBox(elements);
    units.push({
      id,
      elements,
      width: bbox.width,
      height: bbox.height,
      minX: bbox.minX,
      minY: bbox.minY,
      midX: bbox.midX,
      midY: bbox.midY,
      targetX: bbox.minX,
      targetY: bbox.minY,
    });
    for (const element of elements) {
      claimed.add(element.id);
    }
  };

  const selected = selectedElements.filter((el) => !isBoundToContainer(el));

  // 1. frames move together with all their children
  for (const element of selected) {
    if (isFrameLikeElement(element) && !claimed.has(element.id)) {
      const children = getFrameChildren(allElements, element.id).filter(
        (el): el is NonDeletedExcalidrawElement => !el.isDeleted,
      );
      addUnit(element.id, [element, ...children]);
    }
  }

  // 2. groups move together with all their members
  for (const element of selected) {
    if (claimed.has(element.id) || !element.groupIds.length) {
      continue;
    }
    const topGroupId = element.groupIds[0];
    if (claimedGroups.has(topGroupId)) {
      continue;
    }
    claimedGroups.add(topGroupId);
    const members = allElements.filter(
      (el) => el.groupIds[0] === topGroupId && !el.frameId,
    );
    addUnit(topGroupId, members);
  }

  // 3. standalone elements (skip connectors and bound text)
  for (const element of selected) {
    if (claimed.has(element.id)) {
      continue;
    }
    if (isLinearElement(element) || element.type === "freedraw") {
      continue;
    }
    addUnit(element.id, [element]);
  }

  return units;
};

interface TidyEdge {
  from: TidyUnit;
  to: TidyUnit;
}

const buildEdges = (units: TidyUnit[], scene: Scene): TidyEdge[] => {
  const elementToUnit = new Map<string, TidyUnit>();
  for (const unit of units) {
    for (const element of unit.elements) {
      elementToUnit.set(element.id, unit);
    }
  }

  const edges: TidyEdge[] = [];
  const seen = new Set<string>();
  for (const element of scene.getNonDeletedElements()) {
    if (!isArrowElement(element)) {
      continue;
    }
    const { startBinding, endBinding } = element;
    if (!startBinding || !endBinding) {
      continue;
    }
    const from = elementToUnit.get(startBinding.elementId);
    const to = elementToUnit.get(endBinding.elementId);
    if (!from || !to || from === to) {
      continue;
    }
    const key = `${from.id}:${to.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ from, to });
    }
  }
  return edges;
};

/** weakly connected components, ordered by original position */
const getComponents = (units: TidyUnit[], edges: TidyEdge[]): TidyUnit[][] => {
  const adjacency = new Map<TidyUnit, Set<TidyUnit>>();
  for (const unit of units) {
    adjacency.set(unit, new Set());
  }
  for (const edge of edges) {
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const components: TidyUnit[][] = [];
  const visited = new Set<TidyUnit>();
  for (const unit of units) {
    if (visited.has(unit)) {
      continue;
    }
    const component: TidyUnit[] = [];
    const queue = [unit];
    visited.add(unit);
    while (queue.length) {
      const current = queue.pop()!;
      component.push(current);
      for (const next of adjacency.get(current)!) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component);
  }

  // deterministic component order: by position of the top-most, left-most unit
  components.sort((a, b) => {
    const first = [...a].sort(compareUnits)[0];
    const second = [...b].sort(compareUnits)[0];
    return compareUnits(first, second);
  });

  return components;
};

/**
 * Assigns a left-to-right layer to every unit of a component. Cycles are
 * broken greedily by promoting the node with the highest out/in degree
 * difference, so back edges (loops) don't prevent layering.
 */
const assignLayers = (component: TidyUnit[], edges: TidyEdge[]) => {
  const incoming = new Map<TidyUnit, number>();
  const outgoing = new Map<TidyUnit, TidyUnit[]>();
  const remaining = new Set(component);
  for (const unit of component) {
    incoming.set(unit, 0);
    outgoing.set(unit, []);
  }
  for (const edge of edges) {
    if (remaining.has(edge.from) && remaining.has(edge.to)) {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
      outgoing.get(edge.from)!.push(edge.to);
    }
  }

  const layers: TidyUnit[][] = [];
  while (remaining.size) {
    let sources = [...remaining].filter((unit) => incoming.get(unit) === 0);
    if (!sources.length) {
      // cycle: promote the node with the largest out/in imbalance
      sources = [
        [...remaining].sort((a, b) => {
          const imbalanceA = outgoing.get(a)!.length - (incoming.get(a) ?? 0);
          const imbalanceB = outgoing.get(b)!.length - (incoming.get(b) ?? 0);
          return imbalanceB - imbalanceA || compareUnits(a, b);
        })[0],
      ];
    }
    sources.sort(compareUnits);
    for (const source of sources) {
      remaining.delete(source);
      for (const target of outgoing.get(source)!) {
        incoming.set(target, (incoming.get(target) ?? 0) - 1);
      }
    }
    layers.push(sources);
  }
  return layers;
};

/** orders units within each layer to reduce edge crossings (barycenter) */
const orderLayers = (layers: TidyUnit[][], edges: TidyEdge[]) => {
  const positionOf = new Map<TidyUnit, number>();
  const resetPositions = () => {
    layers.forEach((layer) =>
      layer.forEach((unit, index) => positionOf.set(unit, index)),
    );
  };
  resetPositions();

  const sortByNeighbors = (
    layer: TidyUnit[],
    neighborsOf: (unit: TidyUnit) => TidyUnit[],
  ) => {
    const barycenter = new Map<TidyUnit, number>();
    for (const unit of layer) {
      const neighbors = neighborsOf(unit).filter((neighbor) =>
        positionOf.has(neighbor),
      );
      if (neighbors.length) {
        barycenter.set(
          unit,
          neighbors.reduce((sum, n) => sum + positionOf.get(n)!, 0) /
            neighbors.length,
        );
      }
    }
    // stable sort keeps previous order for units without neighbors / ties
    layer.sort((a, b) => (barycenter.get(a) ?? 0) - (barycenter.get(b) ?? 0));
    layer.forEach((unit, index) => positionOf.set(unit, index));
  };

  const predecessors = new Map<TidyUnit, TidyUnit[]>();
  const successors = new Map<TidyUnit, TidyUnit[]>();
  for (const edge of edges) {
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
    predecessors.set(edge.to, [
      ...(predecessors.get(edge.to) ?? []),
      edge.from,
    ]);
  }

  for (let sweep = 0; sweep < 4; sweep++) {
    for (let i = 1; i < layers.length; i++) {
      sortByNeighbors(layers[i], (unit) => predecessors.get(unit) ?? []);
    }
    for (let i = layers.length - 2; i >= 0; i--) {
      sortByNeighbors(layers[i], (unit) => successors.get(unit) ?? []);
    }
  }
};

const getUnitsBBox = (units: TidyUnit[]) => {
  const minX = Math.min(...units.map((unit) => unit.targetX));
  const minY = Math.min(...units.map((unit) => unit.targetY));
  const maxX = Math.max(...units.map((unit) => unit.targetX + unit.width));
  const maxY = Math.max(...units.map((unit) => unit.targetY + unit.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

/** lays out a single component around local origin, returns its size */
const layoutComponent = (component: TidyUnit[], edges: TidyEdge[]) => {
  const layers = assignLayers(component, edges);
  orderLayers(layers, edges);

  const columnWidths = layers.map((layer) =>
    Math.max(...layer.map((unit) => unit.width)),
  );

  let x = 0;
  layers.forEach((layer, index) => {
    const totalHeight =
      layer.reduce((sum, unit) => sum + unit.height, 0) +
      VERTICAL_GAP * (layer.length - 1);
    let y = -totalHeight / 2;
    for (const unit of layer) {
      unit.targetX = x + (columnWidths[index] - unit.width) / 2;
      unit.targetY = y;
      y += unit.height + VERTICAL_GAP;
    }
    x += columnWidths[index] + HORIZONTAL_GAP;
  });

  return getUnitsBBox(component);
};

/**
 * Lays out the selected elements as a left-to-right flowchart, following
 * arrow directions. Elements are only ever translated in place — ids,
 * z-index, groups, frames and bindings are preserved.
 *
 * Returns the updated elements.
 */
export const tidyUpElements = (
  selectedElements: NonDeletedExcalidrawElement[],
  scene: Scene,
): NonDeletedExcalidrawElement[] => {
  const elementsMap = scene.getNonDeletedElementsMap();
  const units = buildUnits(selectedElements, scene, elementsMap);
  if (units.length < 2) {
    return [];
  }

  const edges = buildEdges(units, scene);
  const components = getComponents(units, edges);

  // lay out each component around the origin, then stack components
  // vertically in a deterministic order
  let offsetY = 0;
  for (const component of components) {
    const bbox = layoutComponent(component, edges);
    const shiftX = -bbox.minX;
    const shiftY = offsetY - bbox.minY;
    for (const unit of component) {
      unit.targetX += shiftX;
      unit.targetY += shiftY;
    }
    offsetY += bbox.height + COMPONENT_GAP;
  }

  // keep the whole diagram where it was: align the laid-out bounding box
  // with the original selection bounding box
  const originalBBox = getCommonBoundingBox(
    units.flatMap((unit) => unit.elements),
  );
  const laidOutBBox = getUnitsBBox(units);
  const deltaX = originalBBox.minX - laidOutBBox.minX;
  const deltaY = originalBBox.minY - laidOutBBox.minY;

  const updatedElements: NonDeletedExcalidrawElement[] = [];
  for (const unit of units) {
    const dx = unit.targetX + deltaX - unit.minX;
    const dy = unit.targetY + deltaY - unit.minY;
    if (dx === 0 && dy === 0) {
      continue;
    }
    for (const element of unit.elements) {
      scene.mutateElement(element, {
        x: element.x + dx,
        y: element.y + dy,
      });
      updatedElements.push(element);
    }
  }

  // re-route bound arrows (incl. elbow arrows) and arrow labels now that
  // all elements are at their final positions
  const moved = new Set(updatedElements);
  for (const element of updatedElements) {
    updateBoundElements(element, scene, {
      simultaneouslyUpdated: [...moved],
    });
  }

  return updatedElements;
};
