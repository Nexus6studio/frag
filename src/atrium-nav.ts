// Ground routes for the atrium. Enforcers and rushers share this graph so a
// flanker climbs the same ramps and stairs, and skirts the same well.
//
// Nodes sit on the concourse ring, the ramp and stair spines, and the catwalk.
// A straight line is allowed only on one deck, and never across the well or a
// jump-pad shelf. Replanning waits until the goal's node changes, because
// picking the nearest node every step walks a climber back down the ramp.

import {
  ATRIUM_RAMPS,
  ATRIUM_STAIRS,
  CATWALK_Y,
  CEILING_Y,
  GROUND_Y,
  capsuleClear,
  inJumpSlot,
} from "./atrium.ts";
import { type Hull, type Vec3 } from "./move.ts";
import { traceRay, type TraceHit } from "./trace.ts";

export interface NavNode {
  x: number;
  z: number;
  y: number;
}

export interface NavMemory {
  path: number[];
  pathCursor: number;
  pathEnd: number;
  anchorX: number;
  anchorZ: number;
  stuck: number;
}

export interface AtriumNav {
  readonly nodes: readonly NavNode[];
  readonly edges: readonly number[][];
  readonly dist: Float64Array;
  readonly prev: Int16Array;
  readonly used: Uint8Array;
}

export interface NavAim {
  x: number;
  z: number;
  /** True when the decks match and the straight line is walkable. */
  direct: boolean;
}

const scratchHit: TraceHit = {
  t: 0,
  distance: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};
const downFrom: Vec3 = { x: 0, y: 0, z: 0 };
const downDir: Vec3 = { x: 0, y: -1, z: 0 };
const pathStack: number[] = [];

export function createAtriumNav(): AtriumNav {
  const nodes = buildNodes();
  return {
    nodes,
    edges: linkNodes(nodes),
    dist: new Float64Array(nodes.length),
    prev: new Int16Array(nodes.length),
    used: new Uint8Array(nodes.length),
  };
}

export function clearNavMemory(memory: NavMemory, x: number, z: number): void {
  memory.path.length = 0;
  memory.pathCursor = 0;
  memory.pathEnd = -1;
  memory.anchorX = x;
  memory.anchorZ = z;
  memory.stuck = 0;
}

/**
 * The next ground point to walk toward. `direct` stays false when the path
 * merely runs out, so a shooter can still tell a clear lane from a finished route.
 */
export function navWaypoint(pos: Vec3, goal: Vec3, memory: NavMemory, hull: Hull, nav: AtriumNav): NavAim {
  const sameDeck = deck(pos.y) === deck(goal.y) && deck(pos.y) !== 1;
  const direct = sameDeck && routeClear(pos.x, pos.y, pos.z, goal.x, goal.y, goal.z, hull);
  if (direct) return { x: goal.x, z: goal.z, direct: true };

  const end = nearestNode(nav.nodes, goal.x, goal.z, goal.y);
  const shifted = Math.hypot(pos.x - memory.anchorX, pos.z - memory.anchorZ);
  if (shifted > 0.4) {
    memory.anchorX = pos.x;
    memory.anchorZ = pos.z;
    memory.stuck = 0;
  } else memory.stuck += 1 / 120;
  const jammed = memory.stuck > 1.2;
  if (memory.pathEnd !== end || memory.path.length === 0 || jammed) {
    const start = nearestNode(nav.nodes, pos.x, pos.z, pos.y);
    writePath(nav.nodes, nav.edges, nav.dist, nav.prev, nav.used, start, end, memory.path);
    memory.pathEnd = end;
    memory.pathCursor = jammed && memory.path.length > 1 ? 1 : 0;
    memory.stuck = 0;
    memory.anchorX = pos.x;
    memory.anchorZ = pos.z;
  }
  while (memory.pathCursor < memory.path.length) {
    const node = nav.nodes[memory.path[memory.pathCursor]!]!;
    if (Math.hypot(node.x - pos.x, node.z - pos.z) < 1.15) memory.pathCursor += 1;
    else break;
  }
  if (memory.pathCursor >= memory.path.length) return { x: goal.x, z: goal.z, direct: false };
  const node = nav.nodes[memory.path[memory.pathCursor]!]!;
  return { x: node.x, z: node.z, direct: false };
}

/** Floor height under a foot point. A miss reports 0, which is the well. */
export function navFloorY(x: number, y: number, z: number, hull: Hull): number {
  downFrom.x = x;
  downFrom.y = Math.min(CEILING_Y - 0.05, y);
  downFrom.z = z;
  const hit = traceRay(downFrom, downDir, 30, hull, scratchHit);
  return hit ? hit.point.y : 0;
}

function deck(y: number): number {
  if (y < 1.8) return 0;
  if (y > 4.4) return 2;
  return 1;
}

function routeClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, hull: Hull): boolean {
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    if (inJumpSlot(x, z)) return false;
    const expect = ay + (by - ay) * t;
    const y = navFloorY(x, Math.max(ay, by, expect) + 1.6, z, hull);
    // The well floor is 0.8 m under the ring, so a straight line across it fails.
    // A flat test floor stays at one height and stays clear.
    if (Math.abs(y - expect) > 0.65) return false;
    if (!capsuleClear({ x, y, z }, hull)) return false;
  }
  return true;
}

function nearestNode(nodes: readonly NavNode[], x: number, z: number, y: number): number {
  let best = 0;
  let bestScore = Infinity;
  let fallback = 0;
  let fallbackScore = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    const horizontal = Math.hypot(node.x - x, node.z - z);
    const dy = Math.abs(node.y - y);
    const score = horizontal + dy * 4;
    if (score < fallbackScore) {
      fallbackScore = score;
      fallback = i;
    }
    if (dy > 2.4) continue;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore < Infinity ? best : fallback;
}

function writePath(
  nodes: readonly NavNode[],
  edges: readonly number[][],
  dist: Float64Array,
  prev: Int16Array,
  used: Uint8Array,
  start: number,
  end: number,
  out: number[],
): void {
  out.length = 0;
  if (start === end) {
    out.push(start);
    return;
  }
  for (let i = 0; i < nodes.length; i += 1) {
    dist[i] = Infinity;
    prev[i] = -1;
    used[i] = 0;
  }
  dist[start] = 0;
  for (;;) {
    let pick = -1;
    let best = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      if (used[i] === 0 && dist[i]! < best) {
        best = dist[i]!;
        pick = i;
      }
    }
    if (pick < 0 || pick === end) break;
    used[pick] = 1;
    const list = edges[pick]!;
    for (let i = 0; i < list.length; i += 1) {
      const next = list[i]!;
      const node = nodes[pick]!;
      const other = nodes[next]!;
      const weight = Math.hypot(node.x - other.x, node.z - other.z);
      const score = dist[pick]! + weight;
      if (score < dist[next]!) {
        dist[next] = score;
        prev[next] = pick;
      }
    }
  }
  pathStack.length = 0;
  for (let cursor = end; cursor >= 0; cursor = prev[cursor]!) pathStack.push(cursor);
  for (let i = pathStack.length - 1; i >= 0; i -= 1) out.push(pathStack[i]!);
}

function buildNodes(): NavNode[] {
  const ne = ATRIUM_RAMPS.find((ramp) => ramp.id === "ne")!;
  const nw = ATRIUM_RAMPS.find((ramp) => ramp.id === "nw")!;
  const se = ATRIUM_STAIRS.find((stair) => stair.id === "se")!;
  const sw = ATRIUM_STAIRS.find((stair) => stair.id === "sw")!;
  const seX = (se.x0 + se.x1) / 2;
  const swX = (sw.x0 + sw.x1) / 2;
  return [
    { x: 0, z: 8.2, y: GROUND_Y },
    { x: 8.1, z: 8.2, y: GROUND_Y },
    { x: 8.2, z: 0, y: GROUND_Y },
    { x: 8.1, z: -7.2, y: GROUND_Y },
    { x: 0, z: -7.2, y: GROUND_Y },
    { x: -8.1, z: -7.2, y: GROUND_Y },
    { x: -8.2, z: 0, y: GROUND_Y },
    { x: -8.1, z: 8.2, y: GROUND_Y },
    { x: ne.lineX, z: -5.5, y: GROUND_Y },
    { x: ne.lineX, z: -9.2, y: 3 },
    { x: ne.lineX, z: -12, y: CATWALK_Y },
    { x: ne.lineX, z: -14.5, y: CATWALK_Y },
    { x: nw.lineX, z: -5.5, y: GROUND_Y },
    { x: nw.lineX, z: -9.2, y: 3 },
    { x: nw.lineX, z: -12, y: CATWALK_Y },
    { x: nw.lineX, z: -14.5, y: CATWALK_Y },
    { x: seX, z: 1.55, y: GROUND_Y },
    { x: seX, z: 6.4, y: 3.2 },
    { x: seX, z: 10.3, y: CATWALK_Y },
    { x: 14.45, z: 10.3, y: CATWALK_Y },
    { x: swX, z: 1.55, y: GROUND_Y },
    { x: swX, z: 6.4, y: 3.2 },
    { x: swX, z: 10.3, y: CATWALK_Y },
    { x: -14.45, z: 10.3, y: CATWALK_Y },
    { x: 0, z: -14.6, y: CATWALK_Y },
    { x: 14.45, z: -14.6, y: CATWALK_Y },
    { x: 14.45, z: -10, y: CATWALK_Y },
    { x: 14.45, z: 0, y: CATWALK_Y },
    { x: 14.45, z: 6, y: CATWALK_Y },
    { x: 14.45, z: 14.6, y: CATWALK_Y },
    { x: 0, z: 14.6, y: CATWALK_Y },
    { x: -14.5, z: 14.6, y: CATWALK_Y },
    { x: -14.5, z: 6, y: CATWALK_Y },
    { x: -14.5, z: 0, y: CATWALK_Y },
    { x: -14.5, z: -8, y: CATWALK_Y },
    { x: -14.5, z: -14.6, y: CATWALK_Y },
  ];
}

function linkNodes(nodes: readonly NavNode[]): number[][] {
  const edges = nodes.map(() => [] as number[]);
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 0],
    [1, 16],
    [2, 16],
    [3, 8],
    [5, 12],
    [6, 20],
    [7, 20],
    [8, 9],
    [9, 10],
    [10, 11],
    [12, 13],
    [13, 14],
    [14, 15],
    [16, 17],
    [17, 18],
    [18, 19],
    [20, 21],
    [21, 22],
    [22, 23],
    [24, 11],
    [11, 25],
    [25, 26],
    [26, 27],
    [27, 28],
    [28, 19],
    [19, 29],
    [29, 30],
    [30, 31],
    [31, 32],
    [32, 23],
    [23, 33],
    [33, 34],
    [34, 35],
    [35, 15],
    [15, 24],
  ];
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]!;
    edges[pair[0]!]!.push(pair[1]!);
    edges[pair[1]!]!.push(pair[0]!);
  }
  return edges;
}
