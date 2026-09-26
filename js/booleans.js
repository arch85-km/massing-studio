// booleans.js — Intersect / Union / Subtract between two massing volumes.
//
// Every volume here is a vertical prism: a 2D footprint (optionally with
// holes) between a bottom and a top elevation. That makes 3D booleans
// tractable without a general mesh-CSG library: the footprint does the 2D
// polygon clipping (the vendored polygon-clipping library, which copes with
// the shared edges and collinear overlaps that grid-snapped drawings are
// full of), and the vertical extent is plain interval arithmetic.
//
//   A ∩ B  = (footA ∩ footB) over (zA ∩ zB)
//   A − B  = (footA − footB) over zA,  plus (footA ∩ footB) over (zA − zB)
//   A ∪ B  = (footA ∪ footB) over zA   when zA == zB,
//            otherwise A itself plus the pieces of B − A
//
// polygon-clipping is loaded as a classic script (window.polygonClipping),
// since it ships as a UMD bundle rather than an ES module.

import { shapePoints, polygonArea, shapeBaseZ } from './geometry.js';

const EPS = 1e-6;
const MIN_AREA = 1e-4; // m² — slivers smaller than this are clipping noise, not geometry

function clipper() {
  const pc = globalThis.polygonClipping;
  if (!pc) throw new Error('The polygon-clipping library did not load.');
  return pc;
}

// A shape's footprint as a polygon-clipping Polygon: [outerRing, ...holes],
// each ring an array of [x, y] pairs. Circles and curves use their sampled outline.
function toPolygon(shape) {
  const ring = (pts) => pts.map((p) => [p.x, p.y]);
  return [ring(shapePoints(shape)), ...(shape.holes || []).map(ring)];
}

// Split a polygon-clipping MultiPolygon into our own outer/holes records,
// dropping the repeated closing vertex and any degenerate slivers.
function fromMultiPolygon(mp) {
  const out = [];
  for (const poly of mp) {
    const rings = poly.map((ring) => {
      const pts = ring.map(([x, y]) => ({ x, y }));
      if (pts.length > 1) {
        const a = pts[0], b = pts[pts.length - 1];
        if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) pts.pop();
      }
      return pts;
    });
    const [outer, ...holes] = rings;
    if (!outer || outer.length < 3 || Math.abs(polygonArea(outer)) < MIN_AREA) continue;
    out.push({ points: outer, holes: holes.filter((h) => h.length >= 3 && Math.abs(polygonArea(h)) >= MIN_AREA) });
  }
  return out;
}

function zRange(shape, layers) {
  const layer = layers.find((l) => l.id === shape.layerId);
  const bottom = shapeBaseZ(shape, layer);
  return { layer, bottom, top: bottom + (shape.height || 0) };
}

// Build result shapes from footprints over a vertical span, placed on the
// source shape's own level (base = offset above that level's elevation).
function makeShapes(footprints, bottom, top, source, sourceLayer, makeId) {
  if (top - bottom < EPS) return [];
  return footprints.map((f) => {
    const shape = {
      id: makeId(),
      type: 'polygon',
      layerId: source.layerId,
      closed: true,
      points: f.points,
      height: Math.round((top - bottom) * 10000) / 10000,
      base: Math.round((bottom - (sourceLayer?.elevation ?? 0)) * 10000) / 10000,
      color: source.color,
      opacity: source.opacity ?? 1,
    };
    if (f.holes.length) shape.holes = f.holes;
    return shape;
  });
}

// op: 'intersect' | 'union' | 'subtract'. Returns the new shapes (possibly
// empty — e.g. an intersection of volumes that don't overlap).
export function booleanShapes(op, a, b, layers, makeId) {
  const pc = clipper();
  const za = zRange(a, layers);
  const zb = zRange(b, layers);
  const pa = toPolygon(a);
  const pb = toPolygon(b);

  if (op === 'intersect') {
    const bottom = Math.max(za.bottom, zb.bottom);
    const top = Math.min(za.top, zb.top);
    if (top - bottom < EPS) return [];
    return makeShapes(fromMultiPolygon(pc.intersection(pa, pb)), bottom, top, a, za.layer, makeId);
  }

  if (op === 'subtract') {
    const result = makeShapes(fromMultiPolygon(pc.difference(pa, pb)), za.bottom, za.top, a, za.layer, makeId);
    const overlap = fromMultiPolygon(pc.intersection(pa, pb));
    if (overlap.length) {
      // Where the footprints overlap, A survives only above and below B.
      if (zb.bottom > za.bottom) {
        result.push(...makeShapes(overlap, za.bottom, Math.min(za.top, zb.bottom), a, za.layer, makeId));
      }
      if (zb.top < za.top) {
        result.push(...makeShapes(overlap, Math.max(za.bottom, zb.top), za.top, a, za.layer, makeId));
      }
    }
    return result;
  }

  if (op === 'union') {
    if (Math.abs(za.bottom - zb.bottom) < EPS && Math.abs(za.top - zb.top) < EPS) {
      return makeShapes(fromMultiPolygon(pc.union(pa, pb)), za.bottom, za.top, a, za.layer, makeId);
    }
    // Different vertical extents can't merge into one prism: keep A whole
    // (as a polygon, so circles/curves come out consistent) and add B − A.
    const keepA = makeShapes(fromMultiPolygon(pc.union(pa)), za.bottom, za.top, a, za.layer, makeId);
    const rest = booleanShapes('subtract', b, a, layers, makeId);
    return [...keepA, ...rest];
  }

  throw new Error(`Unknown boolean operation "${op}"`);
}
