import { pointFrom, type GlobalPoint } from "@excalidraw/math";

import type { RectBox } from "./types";

const PADDING = 16;

const inflated = (box: RectBox, padding = PADDING): RectBox => ({
  minX: box.minX - padding,
  minY: box.minY - padding,
  maxX: box.maxX + padding,
  maxY: box.maxY + padding,
});

const rectContainsPoint = (box: RectBox, point: GlobalPoint): boolean =>
  point[0] > box.minX &&
  point[0] < box.maxX &&
  point[1] > box.minY &&
  point[1] < box.maxY;

const rectsOverlapOpen = (a: RectBox, b: RectBox): boolean =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

/**
 * True when an axis-aligned segment [a, b] can be drawn without entering any
 * of the obstacle rectangles (already inflated). Endpoints sitting exactly on
 * an obstacle edge are considered visible — that's how arrows attach.
 */
const segmentIsClear = (
  a: GlobalPoint,
  b: GlobalPoint,
  obstacles: RectBox[],
): boolean => {
  const horizontal = a[1] === b[1];
  const segmentBox: RectBox = horizontal
    ? {
        minX: Math.min(a[0], b[0]),
        maxX: Math.max(a[0], b[0]),
        minY: a[1],
        maxY: a[1],
      }
    : {
        minX: a[0],
        maxX: a[0],
        minY: Math.min(a[1], b[1]),
        maxY: Math.max(a[1], b[1]),
      };

  for (const obstacle of obstacles) {
    if (!rectsOverlapOpen(segmentBox, obstacle)) {
      continue;
    }
    if (horizontal) {
      // the line y = a[1] cuts through the interior of the obstacle
      if (a[1] > obstacle.minY && a[1] < obstacle.maxY) {
        return false;
      }
    } else if (a[0] > obstacle.minX && a[0] < obstacle.maxX) {
      return false;
    }
  }
  return true;
};

/**
 * Finds an orthogonal (rectilinear) path between `start` and `end` that
 * avoids every obstacle box. The routing graph is the visibility graph of
 * the start/end points plus the corners of inflated obstacles; edges are
 * horizontal/vertical visible connections, weighted by length plus a bend
 * penalty so the router prefers straight lines and few corners.
 *
 * Returns `null` when no such orthogonal path exists inside the relevant
 * region (callers fall back to a direct segment in that case).
 */
export const routeOrthogonalPath = (
  start: GlobalPoint,
  end: GlobalPoint,
  rawObstacles: RectBox[],
): GlobalPoint[] | null => {
  const obstacles = rawObstacles.map((box) => inflated(box));

  // keep the routing local: obstacles that can't sit between the two points
  // anyway don't need to contribute corner candidates
  const margin = PADDING;
  const region: RectBox = {
    minX: Math.min(start[0], end[0]) - margin,
    maxX: Math.max(start[0], end[0]) + margin,
    maxY: Math.max(start[1], end[1]) + margin,
    minY: Math.min(start[1], end[1]) - margin,
  };
  const relevant = obstacles.filter(
    (box) =>
      rectsOverlapOpen(box, region) ||
      rectContainsPoint(box, start) ||
      rectContainsPoint(box, end),
  );

  // direct straight connection? that's always the preferred result
  if (
    (start[0] === end[0] || start[1] === end[1]) &&
    segmentIsClear(start, end, relevant)
  ) {
    return [start, end];
  }

  const xs = new Set<number>([start[0], end[0]]);
  const ys = new Set<number>([start[1], end[1]]);
  for (const box of relevant) {
    xs.add(box.minX);
    xs.add(box.maxX);
    ys.add(box.minY);
    ys.add(box.maxY);
  }

  // candidate points: every (x, y) combination that lies outside of every
  // inflated obstacle interior. Endpoints are always kept.
  const points: GlobalPoint[] = [start, end];
  const indexOf = new Map<string, number>();
  indexOf.set(`${start[0]},${start[1]}`, 0);
  indexOf.set(`${end[0]},${end[1]}`, 1);

  for (const x of xs) {
    for (const y of ys) {
      const point = pointFrom<GlobalPoint>(x, y);
      const key = `${x},${y}`;
      if (indexOf.has(key)) {
        continue;
      }
      const inside = relevant.some(
        (box) =>
          point[0] > box.minX &&
          point[0] < box.maxX &&
          point[1] > box.minY &&
          point[1] < box.maxY,
      );
      if (!inside) {
        indexOf.set(key, points.length);
        points.push(point);
      }
    }
  }

  // bucket by coordinate so we can connect rows/columns cheaply
  const byX = new Map<number, number[]>();
  const byY = new Map<number, number[]>();
  points.forEach((point, index) => {
    const column = byX.get(point[0]);
    if (column) {
      column.push(index);
    } else {
      byX.set(point[0], [index]);
    }
    const row = byY.get(point[1]);
    if (row) {
      row.push(index);
    } else {
      byY.set(point[1], [index]);
    }
  });

  type QueueEntry = {
    index: number;
    cost: number;
    /** incoming segment direction: 0 = horizontal, 1 = vertical */
    dir: 0 | 1 | null;
  };

  const best = new Map<string, number>();
  const previous = new Map<string, { index: number; dir: 0 | 1 }>();
  const queue: QueueEntry[] = [{ index: 0, cost: 0, dir: null }];
  const keyFor = (index: number, dir: 0 | 1 | null) => `${index}:${dir ?? "-"}`;

  const BEND_PENALTY = 200;

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift()!;
    if (current.index === 1) {
      break;
    }
    const bestKey = keyFor(current.index, current.dir);
    if ((best.get(bestKey) ?? Infinity) < current.cost) {
      continue;
    }

    const point = points[current.index];
    const neighbors: Array<{ index: number; dir: 0 | 1 }> = [];

    for (const otherIndex of byX.get(point[0]) ?? []) {
      if (otherIndex !== current.index) {
        neighbors.push({ index: otherIndex, dir: 1 });
      }
    }
    for (const otherIndex of byY.get(point[1]) ?? []) {
      if (otherIndex !== current.index) {
        neighbors.push({ index: otherIndex, dir: 0 });
      }
    }

    for (const neighbor of neighbors) {
      const other = points[neighbor.index];
      if (!segmentIsClear(point, other, relevant)) {
        continue;
      }
      const length =
        Math.abs(point[0] - other[0]) + Math.abs(point[1] - other[1]);
      const bend =
        current.dir !== null && current.dir !== neighbor.dir ? BEND_PENALTY : 0;
      const cost = current.cost + length + bend;
      const key = keyFor(neighbor.index, neighbor.dir);
      if (cost < (best.get(key) ?? Infinity)) {
        best.set(key, cost);
        previous.set(key, {
          index: current.index,
          dir: current.dir ?? neighbor.dir,
        });
        queue.push({ index: neighbor.index, cost, dir: neighbor.dir });
      }
    }
  }

  // reconstruct with the cheapest final direction at the end point
  let endKey: string | null = null;
  let endCost = Infinity;
  for (const dir of [0, 1] as const) {
    const key = keyFor(1, dir);
    const cost = best.get(key);
    if (cost !== undefined && cost < endCost) {
      endCost = cost;
      endKey = key;
    }
  }
  if (!endKey) {
    return null;
  }

  const reversed: GlobalPoint[] = [end];
  let key: string | undefined = endKey;
  while (key) {
    const prev = previous.get(key);
    if (!prev) {
      break;
    }
    reversed.push(points[prev.index]);
    key = keyFor(prev.index, prev.dir);
    if (prev.index === 0) {
      break;
    }
  }
  reversed.reverse();
  if (reversed[0] !== start) {
    reversed.unshift(start);
  }

  // drop collinear intermediate points
  const simplified: GlobalPoint[] = [reversed[0]];
  for (let i = 1; i < reversed.length - 1; i++) {
    const a = reversed[i - 1];
    const b = reversed[i];
    const c = reversed[i + 1];
    const horizontalSegment = a[1] === b[1] && b[1] === c[1];
    const verticalSegment = a[0] === b[0] && b[0] === c[0];
    if (!horizontalSegment && !verticalSegment) {
      simplified.push(b);
    }
  }
  simplified.push(end);

  return simplified;
};

/**
 * Tests whether a direct (possibly diagonal) segment crosses the interior
 * of any obstacle rectangle.
 */
export const segmentCrossesObstacle = (
  start: GlobalPoint,
  end: GlobalPoint,
  rawObstacles: RectBox[],
): boolean => {
  for (const raw of rawObstacles) {
    const box = inflated(raw, 4);
    // segment/AABB intersection via parametric slab test
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    let tMin = 0;
    let tMax = 1;
    const slabs: Array<[number, number, number]> = [
      [dx, box.minX - start[0], box.maxX - start[0]],
      [dy, box.minY - start[1], box.maxY - start[1]],
    ];
    for (const [d, pMin, pMax] of slabs) {
      if (Math.abs(d) < 1e-9) {
        const origin = d === dx ? start[0] : start[1];
        const slabMin = d === dx ? box.minX : box.minY;
        const slabMax = d === dx ? box.maxX : box.maxY;
        if (origin < slabMin || origin > slabMax) {
          tMin = 2;
          break;
        }
      } else {
        let t1 = pMin / d;
        let t2 = pMax / d;
        if (t1 > t2) {
          [t1, t2] = [t2, t1];
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
      }
    }
    if (tMin <= tMax && tMax >= 0 && tMin <= 1) {
      return true;
    }
  }
  return false;
};
