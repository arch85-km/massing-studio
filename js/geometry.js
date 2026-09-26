// geometry.js — pure math helpers shared by the 2D plan and 3D viewport.

export function snap(value, size) {
  return Math.round(value / size) * size;
}

export function snapPoint(p, gridSize) {
  return { x: snap(p.x, gridSize), y: snap(p.y, gridSize) };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Find the closest existing shape vertex within `threshold` world units.
// Used for endpoint snapping (like AutoCAD object snap).
// `exclude` is a single shape id or a Set of ids (e.g. the shapes being dragged,
// which must never snap to themselves).
export function findNearestVertex(point, shapes, threshold, exclude = null) {
  let best = null;
  let bestDist = threshold;
  for (const shape of shapes) {
    if (exclude && (exclude instanceof Set ? exclude.has(shape.id) : shape.id === exclude)) continue;
    for (const p of snapVertices(shape)) {
      const d = dist(point, p);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }
  return best;
}

// The points worth snapping to: a curve's control points and a circle's
// quadrants/center rather than every sampled point along them, plus hole corners.
export function snapVertices(shape) {
  if (shape.type === 'circle') {
    const { center: c, radius: r } = shape;
    return [c, { x: c.x + r, y: c.y }, { x: c.x - r, y: c.y }, { x: c.x, y: c.y + r }, { x: c.x, y: c.y - r }];
  }
  const pts = [...(shape.points || [])];
  for (const h of shape.holes || []) pts.push(...h);
  return pts;
}

// Returns the list of vertices that define a shape's footprint, regardless of type.
// A curve ('spline') returns its sampled outline, not its control points.
export function shapePoints(shape) {
  if (shape.type === 'spline') return sampleSpline(shape.points || [], !!shape.closed);
  if (shape.type === 'circle') {
    const segs = 32;
    const pts = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push({
        x: shape.center.x + Math.cos(a) * shape.radius,
        y: shape.center.y + Math.sin(a) * shape.radius,
      });
    }
    return pts;
  }
  return shape.points || [];
}

export function pointInPolygon(point, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distToSegment(p, a, b) {
  const l2 = dist(a, b) ** 2;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  return dist(p, proj);
}

// Hit-test a point (world coords) against a shape, accounting for its type.
export function hitTestShape(point, shape, tolerance) {
  if (shape.type === 'circle') {
    const d = dist(point, shape.center);
    return d <= shape.radius + tolerance;
  }
  const pts = shapePoints(shape);
  if (shape.closed) {
    const rings = [pts, ...(shape.holes || [])];
    // also allow clicking near any outline (outer or hole)
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        if (distToSegment(point, ring[i], ring[(i + 1) % ring.length]) <= tolerance) return true;
      }
    }
    if (!pointInPolygon(point, pts)) return false;
    return !(shape.holes || []).some((h) => pointInPolygon(point, h));
  }
  // open polyline / line / open curve
  for (let i = 0; i < pts.length - 1; i++) {
    if (distToSegment(point, pts[i], pts[i + 1]) <= tolerance) return true;
  }
  return false;
}

export function centroid(points) {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

export function boundsOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

// Intersection of two infinite 2D lines, each given as a point + direction.
// Returns null if the lines are parallel/near-parallel (caller supplies a fallback).
export function lineIntersect(pA, dA, pB, dB) {
  const denom = dA.x * dB.y - dA.y * dB.x;
  if (Math.abs(denom) < 1e-9) return null;
  const diff = { x: pB.x - pA.x, y: pB.y - pA.y };
  const t = (diff.x * dB.y - diff.y * dB.x) / denom;
  return { x: pA.x + t * dA.x, y: pA.y + t * dA.y };
}

// Shoelace formula — signed area (positive = counter-clockwise in plan coords).
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

// Centripetal Catmull-Rom through the control points — the curve passes
// through every point the user clicked, and the centripetal parameterization
// never forms cusps or self-loops on unevenly spaced points.
export function sampleSpline(points, closed, samplesPerSpan = 12) {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ ...p }));
  const get = (i) => {
    if (closed) return points[((i % n) + n) % n];
    if (i < 0) return { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y };
    if (i >= n) return { x: 2 * points[n - 1].x - points[n - 2].x, y: 2 * points[n - 1].y - points[n - 2].y };
    return points[i];
  };
  const out = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const tj = (a, b) => Math.max(1e-6, Math.sqrt(dist(a, b)));
    const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    for (let k = 0; k < samplesPerSpan; k++) {
      const t = t1 + ((t2 - t1) * k) / samplesPerSpan;
      const lerp = (a, b, ta, tb) => ({
        x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta),
        y: ((tb - t) * a.y + (t - ta) * b.y) / (tb - ta),
      });
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  if (!closed) out.push({ ...points[n - 1] });
  return out;
}

// Applies `fn` to every coordinate that positions a shape — center, points,
// hole rings — and scales a circle's radius by `radiusFactor`. Returns a patch.
export function mapShapeCoords(shape, fn, radiusFactor = 1) {
  if (shape.type === 'circle') {
    return { center: fn(shape.center), radius: shape.radius * radiusFactor };
  }
  const patch = { points: shape.points.map(fn) };
  if (shape.holes) patch.holes = shape.holes.map((h) => h.map(fn));
  return patch;
}

// Footprint area in m² (outer minus holes), always positive.
export function shapeArea(shape) {
  if (!shape.closed) return 0;
  if (shape.type === 'circle') return Math.PI * shape.radius ** 2;
  let a = Math.abs(polygonArea(shapePoints(shape)));
  for (const h of shape.holes || []) a -= Math.abs(polygonArea(h));
  return Math.max(0, a);
}

export function ringLength(pts, closed) {
  let len = 0;
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) len += dist(pts[i], pts[(i + 1) % pts.length]);
  return len;
}

export function shapePerimeter(shape) {
  if (shape.type === 'circle') return 2 * Math.PI * shape.radius;
  let len = ringLength(shapePoints(shape), !!shape.closed);
  for (const h of shape.holes || []) len += ringLength(h, true);
  return len;
}

// World elevation of a shape's underside: its level's elevation plus its own
// base offset (a volume stacked on another volume within the same level).
export function shapeBaseZ(shape, layer) {
  return (layer?.elevation ?? 0) + (shape.base ?? 0);
}

export function formatLength(m) {
  return `${m.toFixed(2)} m`;
}

export function formatArea(m2) {
  return `${m2.toFixed(2)} m²`;
}
