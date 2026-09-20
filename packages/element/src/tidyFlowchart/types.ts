import type { ExcalidrawElement, ExcalidrawArrowElement } from "../types";

/** axis-aligned bounding box, in scene coords */
export type RectBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * A "unit" is the atomic object the layout algorithm moves as a whole:
 * a single element, an entire group (incl. its bound texts and rigid
 * members such as arrows that are part of the group), or a frame together
 * with every child element clipped inside it.
 */
export type TidyUnit = {
  /** stable, deterministic id */
  id: string;
  /** every scene element that has to be translated together with the unit */
  members: ExcalidrawElement["id"][];
  /** original (pre-layout) bbox of the whole unit */
  originalBox: RectBox;
  /** post-layout top-left corner of the unit */
  targetMinX: number;
  targetMinY: number;
  /**
   * hierarchy column assigned by the layout (filled in during layout);
   * undefined for isolated units that were left in place
   */
  assignedLayer?: number;
};

/** a connection between two units (may be directed or undirected) */
export type TidyEdge = {
  arrow: ExcalidrawArrowElement;
  fromUnit: string | null;
  toUnit: string | null;
  /** true when the arrow points from end-binding → start-binding */
  reversed: boolean;
};

export type TidyInput = {
  units: Map<string, TidyUnit>;
  edges: TidyEdge[];
  /** arrows that move rigidly together with their group/frame unit */
  rigidArrowIds: Set<ExcalidrawArrowElement["id"]>;
  /** bbox of every element that participates in the tidy operation */
  selectionBox: RectBox;
};

export type UnitTranslation = {
  dx: number;
  dy: number;
};

export type TidyResult = {
  translations: Map<string, UnitTranslation>;
  /** arrows that connect two (moved) units and need to be re-routed */
  reroutedArrows: ExcalidrawArrowElement[];
};
