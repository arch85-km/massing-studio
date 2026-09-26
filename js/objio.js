// objio.js — "Save as .obj" and opening an .obj as an editable model.
//
// Saving: the file is ordinary Wavefront OBJ geometry (every extruded
// volume, Y up, metres) that Rhino, Blender or SketchUp read as usual —
// followed by the complete Massing Studio project, base64-encoded JSON, on
// '#' comment lines. Every OBJ reader skips comments, so the extra lines
// cost other programs nothing, and reopening the file here restores the
// project exactly (levels, curves, heights, colours, measurements).
//
// Opening an .obj without that block (one from another program): every
// object that is a straight vertical extrusion — all its vertices on
// exactly two heights — is rebuilt as an editable polygon footprint (with
// holes) and a height, one level per distinct base elevation. Anything
// else (a roof, a sphere, a sloped face) can't be described as a
// footprint + height, so it's handed back as OBJ text to become a static
// reference model instead.

import { pointInPolygon, polygonArea } from './geometry.js';

const MARKER = '# massing-studio-project v1';
const LINE_PREFIX = '#ms ';
const EPS = 1e-5; // m — two vertex coordinates this close are the same point

// ---------- embedding the project ----------
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// objGeometry: the text from Scene3D.exportOBJ() (may be null when nothing
// is extruded yet); projectJson: the same JSON "Save" writes.
export function buildProjectOBJ(objGeometry, projectJson) {
  const head = [
    '# Massing Studio model — units: metres, Y up.',
    '# The comment block at the end holds the editable project; other programs ignore it.',
  ].join('\n');
  const b64 = toBase64(projectJson);
  const lines = [MARKER];
  for (let i = 0; i < b64.length; i += 76) lines.push(LINE_PREFIX + b64.slice(i, i + 76));
  lines.push('# end massing-studio-project');
  return `${head}\n${objGeometry || '# (no extruded volumes yet)\n'}\n${lines.join('\n')}\n`;
}

// The embedded project JSON, or null if this .obj doesn't carry one.
export function extractProjectJSON(text) {
  const start = text.indexOf(MARKER);
  if (start < 0) return null;
  let b64 = '';
  for (const line of text.slice(start + MARKER.length).split(/\r?\n/)) {
    if (line.startsWith(LINE_PREFIX)) b64 += line.slice(LINE_PREFIX.length).trim();
    else if (line.startsWith('# end massing-studio-project')) break;
  }
  return b64 ? fromBase64(b64) : null;
}

// ---------- rebuilding footprints from plain OBJ geometry ----------
function parseOBJ(text) {
  const verts = [];
  const objects = [];
  let current = null;
  const ensure = (name) => {
    if (!current) { current = { name, faces: [] }; objects.push(current); }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      verts.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (tag === 'o' || tag === 'g') {
      const name = parts.slice(1).join(' ') || `object ${objects.length + 1}`;
      // A 'g' right after an 'o' of the same object just names a group within it.
      if (tag === 'g' && current && !current.faces.length) { current.name = name; continue; }
      current = { name, faces: [] };
      objects.push(current);
    } else if (tag === 'f') {
      ensure(`object ${objects.length + 1}`);
      const idx = parts.slice(1).map((p) => {
        const i = parseInt(p.split('/')[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      // fan-triangulate polygons with more than three corners
      for (let k = 1; k + 1 < idx.length; k++) current.faces.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  return { verts, objects: objects.filter((o) => o.faces.length) };
}

const keyOf = (x, y) => `${Math.round(x / EPS)},${Math.round(y / EPS)}`;

// Chain the unshared edges of the top faces into closed rings of plan points.
function boundaryLoops(topTris) {
  const edgeCount = new Map();
  const pts = new Map();
  for (const tri of topTris) {
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      const ka = keyOf(a.x, a.y), kb = keyOf(b.x, b.y);
      if (ka === kb) continue;
      pts.set(ka, a); pts.set(kb, b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [k, n] of edgeCount) {
    if (n !== 1) continue; // shared by two triangles → interior edge
    const [ka, kb] = k.split('|');
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push(kb);
    adj.get(kb).push(ka);
  }
  const loops = [];
  const used = new Set();
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const loop = [];
    let prev = null, cur = start;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(pts.get(cur));
      const next = (adj.get(cur) || []).find((n) => n !== prev && !used.has(n));
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) loops.push(simplify(loop));
  }
  return loops.filter((l) => l.length >= 3 && Math.abs(polygonArea(l)) > 1e-6);
}

// Drop points that sit on a straight line between their neighbours
// (triangulation leaves plenty of these along long edges).
function simplify(loop) {
  const out = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length], b = loop[i], c = loop[(i + 1) % loop.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) out.push({ x: b.x, y: b.y });
  }
  return out;
}

// Outer rings and their holes. Largest first, so every ring that could
// contain this one has already been seen: inside an odd number of them it's
// a hole (of the smallest outer containing it), otherwise a new outer — an
// island inside a courtyard comes out as its own shape.
function nestLoops(loops) {
  const sorted = [...loops].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const seen = []; // { ring, outer } for every ring placed so far
  const outers = [];
  for (const ring of sorted) {
    const containing = seen.filter((s) => pointInPolygon(ring[0], s.ring));
    if (containing.length % 2 === 1) {
      const parent = containing.filter((s) => s.outer).at(-1).outer;
      parent.holes.push(ring);
      seen.push({ ring, outer: null });
    } else {
      const outer = { points: ring, holes: [] };
      outers.push(outer);
      seen.push({ ring, outer });
    }
  }
  return outers;
}

// Re-emit a subset of objects as standalone OBJ text (reindexed vertices).
function objectsToOBJ(verts, objects) {
  const out = [];
  for (const o of objects) {
    out.push(`o ${o.name}`);
    const map = new Map();
    const faces = [];
    for (const f of o.faces) {
      faces.push(f.map((i) => {
        if (!map.has(i)) { map.set(i, map.size + 1); out.push(`v ${verts[i].join(' ')}`); }
        return map.get(i);
      }));
    }
    for (const f of faces) out.push(`f ${f.join(' ')}`);
  }
  return out.join('\n') + '\n';
}

// Returns { prisms: [{ name, points, holes, bottom, height }], rest: objText|null }.
// World Y is up; plan (x, y) = world (x, −z), as everywhere in this app.
export function reconstructFromOBJ(text) {
  const { verts, objects } = parseOBJ(text);
  const prisms = [];
  const rest = [];
  for (const o of objects) {
    const ys = new Set();
    for (const f of o.faces) for (const i of f) ys.add(Math.round(verts[i][1] / EPS));
    if (ys.size !== 2) { rest.push(o); continue; }
    const [yLo, yHi] = [...ys].sort((a, b) => a - b).map((y) => y * EPS);
    const topTris = [];
    let straight = true;
    for (const f of o.faces) {
      const ps = f.map((i) => verts[i]);
      const onTop = ps.every((p) => Math.abs(p[1] - yHi) < EPS * 2);
      const onBottom = ps.every((p) => Math.abs(p[1] - yLo) < EPS * 2);
      if (onTop) topTris.push(ps.map((p) => ({ x: p[0], y: -p[2] })));
      else if (!onBottom) {
        // A side face must be vertical: its corners share at most two plan positions.
        const plan = new Set(ps.map((p) => keyOf(p[0], -p[2])));
        if (plan.size > 2) straight = false;
      }
    }
    const loops = straight && topTris.length ? boundaryLoops(topTris) : [];
    if (!loops.length) { rest.push(o); continue; }
    for (const f of nestLoops(loops)) {
      prisms.push({ name: o.name, points: f.points, holes: f.holes, bottom: yLo, height: yHi - yLo });
    }
  }
  return { prisms, rest: rest.length ? objectsToOBJ(verts, rest) : null };
}
