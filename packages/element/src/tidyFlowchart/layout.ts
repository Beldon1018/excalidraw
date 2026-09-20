import type { RectBox, TidyEdge, TidyInput, TidyUnit } from "./types";

/** horizontal space between hierarchy columns (layer gaps) */
export const TIDY_H_GAP = 80;
/** vertical space between boxes inside one column */
export const TIDY_V_GAP = 40;
/** padding kept between laid-out boxes and unrelated scene elements */
export const TIDY_OBSTACLE_PADDING = 12;

const unitWidth = (unit: TidyUnit) =>
  unit.originalBox.maxX - unit.originalBox.minX;
const unitHeight = (unit: TidyUnit) =>
  unit.originalBox.maxY - unit.originalBox.minY;

type InternalEdge = {
  from: number;
  to: number;
  original: TidyEdge;
  /** true for back edges that were removed to break a cycle */
  broken: boolean;
};

type Component = {
  unitIndexes: number[];
  edges: InternalEdge[];
  originalBox: RectBox;
};

const overlapX = (a: RectBox, b: RectBox, padding = 0) =>
  a.minX < b.maxX + padding && b.minX < a.maxX + padding;
const overlapY = (a: RectBox, b: RectBox, padding = 0) =>
  a.minY < b.maxY + padding && b.minY < a.maxY + padding;

/**
 * Splits the unit graph into weakly connected components, i.e. groups of
 * units linked (even undirectedly) by arrows. Isolated units and groups of
 * unrelated shapes become components of their own.
 */
const findComponents = (units: TidyUnit[], edges: TidyEdge[]): Component[] => {
  const indexById = new Map<string, number>();
  units.forEach((unit, index) => indexById.set(unit.id, index));

  const adjacency: number[][] = units.map(() => []);
  for (const edge of edges) {
    const from = edge.fromUnit ? indexById.get(edge.fromUnit) : undefined;
    const to = edge.toUnit ? indexById.get(edge.toUnit) : undefined;
    if (from !== undefined) {
      adjacency[from].push(to ?? from);
    }
    if (to !== undefined) {
      adjacency[to].push(from ?? to);
    }
  }

  const visited = new Array<boolean>(units.length).fill(false);
  const components: Component[] = [];

  for (let start = 0; start < units.length; start++) {
    if (visited[start]) {
      continue;
    }
    const stack = [start];
    const memberIndexes: number[] = [];
    visited[start] = true;
    while (stack.length > 0) {
      const current = stack.pop()!;
      memberIndexes.push(current);
      for (const next of adjacency[current]) {
        if (!visited[next]) {
          visited[next] = true;
          stack.push(next);
        }
      }
    }
    components.push(
      memberIndexToComponent(memberIndexes, units, edges, indexById),
    );
  }

  return components;
};

const memberIndexToComponent = (
  memberIndexes: number[],
  units: TidyUnit[],
  edges: TidyEdge[],
  indexById: Map<string, number>,
): Component => {
  const members = new Set(memberIndexes);
  const internalEdges: InternalEdge[] = [];
  for (const edge of edges) {
    const from = edge.fromUnit ? indexById.get(edge.fromUnit) : undefined;
    const to = edge.toUnit ? indexById.get(edge.toUnit) : undefined;
    if (
      (from !== undefined && members.has(from)) ||
      (to !== undefined && members.has(to))
    ) {
      internalEdges.push({
        from: from ?? to!,
        to: to ?? from!,
        original: edge,
        broken: false,
      });
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of memberIndexes) {
    const box = units[index].originalBox;
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  return {
    unitIndexes: memberIndexes,
    edges: internalEdges,
    originalBox: { minX, minY, maxX, maxY },
  };
};

/**
 * Removes directed back edges from a component so that the remaining graph is
 * a DAG. We run a DFS and, whenever an edge points to a grey (on-stack) node,
 * mark it as a broken cycle edge. Parallel edges and self-loops are handled
 * the same way, with deterministic ordering by arrow element id.
 */
const breakCycles = (component: Component) => {
  const { unitIndexes } = component;
  const outgoing = new Map<number, InternalEdge[]>();
  for (const index of unitIndexes) {
    outgoing.set(index, []);
  }
  for (const edge of component.edges) {
    outgoing.get(edge.from)?.push(edge);
  }
  for (const list of outgoing.values()) {
    list.sort(
      (a, b) =>
        a.to - b.to || (a.original.arrow.id < b.original.arrow.id ? -1 : 1),
    );
  }

  // 0 = unvisited, 1 = on stack, 2 = done
  const state = new Map<number, number>();
  for (const index of unitIndexes) {
    state.set(index, 0);
  }

  const visit = (index: number) => {
    state.set(index, 1);
    for (const edge of outgoing.get(index) ?? []) {
      const nextState = state.get(edge.to) ?? 0;
      if (nextState === 1 || edge.from === edge.to) {
        edge.broken = true;
      } else if (nextState === 0) {
        visit(edge.to);
      }
    }
    state.set(index, 2);
  };

  for (const index of [...unitIndexes].sort((a, b) => a - b)) {
    if (state.get(index) === 0) {
      visit(index);
    }
  }
};

/**
 * Longest-path layering on the acyclic graph. Sources (no incoming active
 * edge) get layer 0, every other unit is placed one layer below its highest
 * predecessor. Broken (cycle) edges are ignored for layering.
 */
const assignLayers = (component: Component): Map<number, number> => {
  const active = component.edges.filter((edge) => !edge.broken);
  const incomingCount = new Map<number, number>();
  const incoming = new Map<number, number[]>();
  const outgoing = new Map<number, number[]>();
  for (const index of component.unitIndexes) {
    incomingCount.set(index, 0);
    incoming.set(index, []);
    outgoing.set(index, []);
  }
  for (const edge of active) {
    if (edge.from === edge.to) {
      continue;
    }
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    incoming.get(edge.to)?.push(edge.from);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const layers = new Map<number, number>();
  const queue = component.unitIndexes
    .filter((index) => (incomingCount.get(index) ?? 0) === 0)
    .sort((a, b) => a - b);
  const remaining = new Map(incomingCount);

  while (queue.length > 0) {
    const index = queue.shift()!;
    let layer = 0;
    for (const predecessor of incoming.get(index) ?? []) {
      layer = Math.max(layer, (layers.get(predecessor) ?? 0) + 1);
    }
    layers.set(index, layer);
    for (const successor of outgoing.get(index) ?? []) {
      const count = (remaining.get(successor) ?? 0) - 1;
      remaining.set(successor, count);
      if (count === 0) {
        queue.push(successor);
      }
    }
    queue.sort((a, b) => a - b);
  }

  // defensive fallback for nodes that were part of a broken self-loop only
  for (const index of component.unitIndexes) {
    if (!layers.has(index)) {
      layers.set(index, 0);
    }
  }

  return layers;
};

/**
 * Orders units within each layer by the barycenter (average vertical slot) of
 * their connected neighbours, which is the classic cheap heuristic for
 * reducing edge crossings. We run both a top-down and a bottom-up sweep and
 * deterministically pick the one with fewer crossings (ties keep top-down).
 */
const orderLayers = (
  component: Component,
  layers: Map<number, number>,
  units: TidyUnit[],
): number[][] => {
  const activeEdges = component.edges.filter(
    (edge) => !edge.broken && edge.from !== edge.to,
  );

  const maxLayer = Math.max(...layers.values());
  const byLayer: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const index of component.unitIndexes) {
    byLayer[layers.get(index) ?? 0].push(index);
  }
  for (const layer of byLayer) {
    // deterministic starting order: original y, then x, then id
    layer.sort((a, b) => {
      const boxA = units[a].originalBox;
      const boxB = units[b].originalBox;
      return (
        boxA.minY - boxB.minY ||
        boxA.minX - boxB.minX ||
        (units[a].id < units[b].id ? -1 : 1)
      );
    });
  }

  const countCrossings = (orderedLayers: number[][]) => {
    const position = new Map<number, number>();
    orderedLayers.forEach((layer, layerIndex) =>
      layer.forEach((index, slot) => position.set(index, slot + layerIndex)),
    );
    let crossings = 0;
    for (let i = 0; i < orderedLayers.length - 1; i++) {
      const segments: Array<[number, number]> = [];
      for (const edge of activeEdges) {
        const fromLayer = layers.get(edge.from);
        const toLayer = layers.get(edge.to);
        if (
          fromLayer === i &&
          toLayer === i + 1 &&
          position.has(edge.from) &&
          position.has(edge.to)
        ) {
          segments.push([
            byLayer[i].indexOf(edge.from),
            byLayer[i + 1].indexOf(edge.to),
          ]);
        }
      }
      for (let a = 0; a < segments.length; a++) {
        for (let b = a + 1; b < segments.length; b++) {
          if (
            (segments[a][0] - segments[b][0]) *
              (segments[a][1] - segments[b][1]) <
            0
          ) {
            crossings++;
          }
        }
      }
    }
    return crossings;
  };

  const barycenter = (
    orderedLayers: number[][],
    layerIndex: number,
    usePredecessors: boolean,
  ) => {
    const positions = new Map<number, number>();
    orderedLayers[layerIndex + (usePredecessors ? -1 : 1)]?.forEach(
      (index, slot) => positions.set(index, slot),
    );
    const neighborsOf = (index: number) => {
      const neighbors: number[] = [];
      for (const edge of activeEdges) {
        if (usePredecessors && edge.to === index) {
          neighbors.push(edge.from);
        } else if (!usePredecessors && edge.from === index) {
          neighbors.push(edge.to);
        }
      }
      return neighbors;
    };
    orderedLayers[layerIndex].sort((a, b) => {
      const neighborsA = neighborsOf(a)
        .map((neighbor) => positions.get(neighbor))
        .filter((value): value is number => value !== undefined);
      const neighborsB = neighborsOf(b)
        .map((neighbor) => positions.get(neighbor))
        .filter((value): value is number => value !== undefined);
      const centerA =
        neighborsA.length > 0
          ? neighborsA.reduce((sum, value) => sum + value, 0) /
            neighborsA.length
          : orderedLayers[layerIndex].indexOf(a);
      const centerB =
        neighborsB.length > 0
          ? neighborsB.reduce((sum, value) => sum + value, 0) /
            neighborsB.length
          : orderedLayers[layerIndex].indexOf(b);
      return (
        centerA - centerB ||
        units[a].originalBox.minY - units[b].originalBox.minY ||
        (units[a].id < units[b].id ? -1 : 1)
      );
    });
  };

  const runSweeps = (topDown: boolean) => {
    const ordered = byLayer.map((layer) => [...layer]);
    if (topDown) {
      for (let i = 1; i < ordered.length; i++) {
        barycenter(ordered, i, true);
      }
      for (let i = ordered.length - 2; i >= 0; i--) {
        barycenter(ordered, i, false);
      }
    } else {
      for (let i = ordered.length - 2; i >= 0; i--) {
        barycenter(ordered, i, false);
      }
      for (let i = 1; i < ordered.length; i++) {
        barycenter(ordered, i, true);
      }
    }
    return ordered;
  };

  const topDown = runSweeps(true);
  const bottomUp = runSweeps(false);
  return countCrossings(topDown) <= countCrossings(bottomUp)
    ? topDown
    : bottomUp;
};

/** rectangles the layout must not overlap (unrelated, non-moved elements) */
type Obstacles = {
  /** unit ids that get laid out (they don't count as static obstacles) */
  movingUnitIds: Set<string>;
  /** rectangles indexed by the unit that "owns" them for filtering */
  boxes: Array<RectBox & { unitId?: string }>;
};

/** true when the candidate column slot vertically overlaps any obstacle */
const slotBlocked = (
  x: number,
  width: number,
  y: number,
  height: number,
  obstacleBoxes: RectBox[],
  padding: number,
) => {
  const candidate: RectBox = {
    minX: x - padding,
    maxX: x + width + padding,
    minY: y - padding,
    maxY: y + height + padding,
  };
  return obstacleBoxes.some(
    (obstacle) =>
      overlapX(candidate, obstacle) && overlapY(candidate, obstacle),
  );
};

/**
 * Pushes `cursorY` down until a box of `width`×`height` placed at
 * (unitX, cursorY) clears every supplied obstacle. The result always
 * satisfies the gap requirements (or gives up after a bounded number of
 * iterations to stay safe against pathological inputs).
 */
const resolveClearY = (
  unitX: number,
  width: number,
  height: number,
  initialY: number,
  obstacleBoxes: RectBox[],
): number => {
  let cursorY = initialY;
  for (let attempts = 0; attempts < 1000; attempts++) {
    if (
      !slotBlocked(
        unitX,
        width,
        cursorY,
        height,
        obstacleBoxes,
        TIDY_OBSTACLE_PADDING,
      )
    ) {
      return cursorY;
    }
    let blockingBottom = cursorY;
    for (const obstacle of obstacleBoxes) {
      const columnOverlap = overlapX(
        {
          minX: unitX - TIDY_OBSTACLE_PADDING,
          maxX: unitX + width + TIDY_OBSTACLE_PADDING,
          minY: cursorY,
          maxY: cursorY + height,
        },
        obstacle,
      );
      if (columnOverlap && obstacle.maxY + TIDY_OBSTACLE_PADDING > cursorY) {
        blockingBottom = Math.max(blockingBottom, obstacle.maxY);
      }
    }
    cursorY = blockingBottom + TIDY_V_GAP;
  }
  return cursorY;
};

/**
 * Assigns final scene coordinates to every unit of one connected component.
 *
 * The component keeps the top-left corner of its original bounding box:
 * this guarantees the whole drawing never jumps across the canvas and that
 * running tidy repeatedly is idempotent. Columns are packed top → bottom in
 * barycenter order; each slot is pushed down until it clears every static
 * obstacle (unselected shapes) as well as units placed earlier in the same
 * column, so differently-sized shapes can never overlap.
 */
const placeComponent = (
  component: Component,
  orderedLayers: number[][],
  units: TidyUnit[],
  obstacles: Obstacles,
) => {
  const movingIds = new Set(component.unitIndexes.map((i) => units[i].id));
  const staticObstacles = obstacles.boxes.filter(
    (box) => !box.unitId || !movingIds.has(box.unitId),
  );

  const columnWidths = orderedLayers.map((layer) =>
    Math.max(...layer.map((index) => unitWidth(units[index]))),
  );

  let x = component.originalBox.minX;

  for (let layerIndex = 0; layerIndex < orderedLayers.length; layerIndex++) {
    const layer = orderedLayers[layerIndex];
    const columnWidth = columnWidths[layerIndex];
    let cursorY = component.originalBox.minY;
    const placedColumnBoxes: RectBox[] = [];

    for (const index of layer) {
      const unit = units[index];
      const width = unitWidth(unit);
      const height = unitHeight(unit);

      // horizontally center narrow units within the widest column box
      const unitX = x + (columnWidth - width) / 2;

      // units packed earlier in the same column act as obstacles too
      const columnObstacles = [...staticObstacles, ...placedColumnBoxes];

      // push below existing same-column placements and static obstacles
      cursorY = resolveClearY(unitX, width, height, cursorY, columnObstacles);

      unit.targetMinX = unitX;
      unit.targetMinY = cursorY;
      placedColumnBoxes.push({
        minX: unitX,
        minY: cursorY,
        maxX: unitX + width,
        maxY: cursorY + height,
      });
      cursorY += height + TIDY_V_GAP;
    }

    x += columnWidth + TIDY_H_GAP;
  }
};

/**
 * Lays out all units left → right by arrow direction.
 *
 * - weakly connected components are laid out independently, each one pinned
 *   to the top-left corner of its own original bounding box,
 * - components made of a single isolated unit stay exactly where they were,
 * - cycles are broken deterministically and the back edges are still
 *   re-routed after placement, so ring connections remain intact.
 */
export const layoutTidyUnits = (
  input: TidyInput,
  obstacleBoxes: Array<RectBox & { unitId?: string }> = [],
): void => {
  const units = [...input.units.values()];

  if (units.length === 0) {
    return;
  }

  const components = findComponents(units, input.edges);

  // stable processing order: original top-left corner, then smallest unit id
  components.sort((a, b) => {
    const firstA = a.unitIndexes.reduce((min, i) =>
      units[i].originalBox.minY < units[min].originalBox.minY ? i : min,
    );
    const firstB = b.unitIndexes.reduce((min, i) =>
      units[i].originalBox.minY < units[min].originalBox.minY ? i : min,
    );
    return (
      units[firstA].originalBox.minY - units[firstB].originalBox.minY ||
      units[firstA].originalBox.minX - units[firstB].originalBox.minX ||
      (units[firstA].id < units[firstB].id ? -1 : 1)
    );
  });

  const movingUnitIds = new Set(input.units.keys());

  for (const component of components) {
    // isolated unit — nothing to arrange, keep it exactly in place
    if (component.unitIndexes.length === 1 && component.edges.length === 0) {
      const unit = units[component.unitIndexes[0]];
      unit.targetMinX = unit.originalBox.minX;
      unit.targetMinY = unit.originalBox.minY;
      continue;
    }

    breakCycles(component);
    const layers = assignLayers(component);
    const orderedLayers = orderLayers(component, layers, units);
    orderedLayers.forEach((layer, layerIndex) => {
      for (const index of layer) {
        units[index].assignedLayer = layerIndex;
      }
    });
    placeComponent(component, orderedLayers, units, {
      movingUnitIds,
      boxes: obstacleBoxes,
    });
  }
};
