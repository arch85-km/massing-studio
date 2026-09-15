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
export function findNearestVertex(point, shapes, threshold, excludeShapeId = null) {
  let best = null;
  let bestDist = threshold;
  for (const shape of shapes) {
    if (shape.id === excludeShapeId) continue;
    const pts = shapePoints(shape);
    for (const p of pts) {
      const d = dist(point, p);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }
  return best;
}

// Returns the list of vertices that define a shape's footprint, regardless of type.
export function shapePoints(shape) {
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
  if (shape.closed) {
    if (pointInPolygon(point, shape.points)) return true;
    // also allow clicking near the outline
    for (let i = 0; i < shape.points.length; i++) {
      const a = shape.points[i];
      const b = shape.points[(i + 1) % shape.points.length];
      if (distToSegment(point, a, b) <= tolerance) return true;
    }
    return false;
  }
  // open polyline / line
  for (let i = 0; i < shape.points.length - 1; i++) {
    if (distToSegment(point, shape.points[i], shape.points[i + 1]) <= tolerance) return true;
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
