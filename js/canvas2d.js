// canvas2d.js — the 2D plan (top-down drafting) view: grid, drawing tools,
// selection/move/scale, snapping, and the measuring tools (dimensions and
// areas). Pure Canvas2D, no Three.js here.

import { nextId } from './state.js';
import {
  snapPoint, dist, findNearestVertex, shapePoints, snapVertices, hitTestShape,
  centroid, boundsOf, pointInPolygon, distToSegment, polygonArea, sampleSpline,
  mapShapeCoords, shapeArea, ringLength, formatLength, formatArea,
} from './geometry.js';

const HANDLE_SIZE = 7;
const SNAP_PX = 10;
const SCALE_HANDLE_OFFSET_PX = 9; // scale handles sit just outside the bounding box, clear of vertex handles
const DRAW_TOOLS = new Set(['line', 'polygon', 'spline', 'area']);
const MEASURE_COLOR = '#ffd166';

export class Plan2D {
  constructor(canvas, store, { onStatus } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.onStatus = onStatus || (() => {});

    this.pan = { x: 0, y: 0 };
    this.zoom = 32; // pixels per world unit

    this.drawPoints = null;     // in-progress polygon/line/curve/area points (world)
    this.dimPoints = null;      // in-progress dimension: [a] or [a, b] (world)
    this.dragStart = null;      // world point where a mousedown began
    // 'move' | 'scale' | 'vertex' | 'marquee' | 'rect' | 'circle' | 'pan' | 'pinch' | 'move-image' | 'scale-image'
    this.dragMode = null;
    this.dragSnapshots = null;  // shape id -> deep copy at drag start (move/scale/vertex)
    this.dragImageSnapshot = null;
    this.dragHistoryTaken = false;
    this.cursorWorld = { x: 0, y: 0 };
    this.cursorSnapped = { x: 0, y: 0 };
    this.snapPointActive = null;
    this.spaceDown = false;
    this.shiftDown = false;
    this._imageEls = new Map(); // image id -> <img> element, cached across renders

    // Touch has no scroll wheel and no middle-click/spacebar for panning, so
    // a second finger touching down switches into a combined pinch-zoom +
    // two-finger-pan gesture (the same convention as maps/photo apps). The
    // 3D view gets this for free from OrbitControls' own touch handling —
    // this canvas is hand-rolled, so it needs its own multi-pointer tracking.
    this.activePointers = new Map(); // pointerId -> { x, y } in client coords
    this._pinchLastDist = null;
    this._pinchLastMid = null;

    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this.store.onChange(() => this.render());
  }

  // ---------------- coordinate transforms ----------------
  worldToScreen(p) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.width / 2 + (p.x - this.pan.x) * this.zoom,
      y: r.height / 2 - (p.y - this.pan.y) * this.zoom,
    };
  }

  screenToWorld(sx, sy) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (sx - r.width / 2) / this.zoom + this.pan.x,
      y: -(sy - r.height / 2) / this.zoom + this.pan.y,
    };
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  // ---------------- input ----------------
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', (e) => this._onUp(e));
    window.addEventListener('pointercancel', (e) => this._onUp(e));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('dblclick', () => this._finishDrawing());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      this.shiftDown = e.shiftKey;
      if (e.code === 'Space') this.spaceDown = true;
      if (!this._isCanvasFocused()) return;
      if (e.key === 'Escape') this._cancelDraw();
      if (e.key === 'Enter') this._finishDrawing();
      if (e.key === 'Delete' || e.key === 'Backspace') this._deleteSelection();
    });
    window.addEventListener('keyup', (e) => {
      this.shiftDown = e.shiftKey;
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  _isCanvasFocused() {
    // Only handle keys when focus isn't in a text input elsewhere on the page.
    const el = document.activeElement;
    return !el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT');
  }

  _eventWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  }

  _visibleShapes() {
    const { shapes, layers } = this.store.state;
    return shapes.filter((s) => layers.find((l) => l.id === s.layerId)?.visible);
  }

  // Object snap first (an existing vertex within SNAP_PX), then the grid.
  // `exclude` keeps shapes being dragged from snapping to themselves.
  _snapped(world, exclude = null) {
    const { grid } = this.store.state;
    this.snapPointActive = null;
    const vertex = findNearestVertex(world, this._visibleShapes(), SNAP_PX / this.zoom, exclude);
    if (vertex) {
      this.snapPointActive = vertex;
      return { x: vertex.x, y: vertex.y };
    }
    if (grid.snap) return snapPoint(world, grid.size);
    return { ...world };
  }

  _takeDragHistory() {
    // Taken on the first real movement, not on pointerdown — a plain click
    // to select something shouldn't leave an empty step in the undo stack.
    if (this.dragHistoryTaken) return;
    this.store.snapshot();
    this.dragHistoryTaken = true;
  }

  _onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.shiftDown = e.shiftKey;

    if (this.activePointers.size >= 2) {
      // A second touch just landed — drop whatever the first one started
      // (an in-progress draw, or a shape/image drag) and switch to pinch.
      this._cancelDraw();
      this.dragSnapshots = null;
      this.dragImageSnapshot = null;
      this.dragMode = 'pinch';
      const [p1, p2] = [...this.activePointers.values()];
      const r = this.canvas.getBoundingClientRect();
      this._pinchLastDist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      this._pinchLastMid = { x: (p1.x + p2.x) / 2 - r.left, y: (p1.y + p2.y) / 2 - r.top };
      return;
    }

    const world = this._eventWorld(e);
    const tool = this.store.state.tool;

    if (e.button === 1 || this.spaceDown || e.button === 2) {
      // Right-click while placing a dimension's offset commits it at offset 0.
      if (e.button === 2 && tool === 'dimension' && this.dimPoints?.length === 2) {
        this._commitDimension(0);
        return;
      }
      this.dragMode = 'pan';
      this.dragStart = { x: e.clientX, y: e.clientY, panX: this.pan.x, panY: this.pan.y };
      return;
    }

    if (tool === 'select') {
      this._handleSelectDown(world, e.shiftKey);
      return;
    }
    if (tool === 'pushpull') return; // a 3D-view tool — nothing to do in plan

    const snapped = this._snapped(world);

    if (tool === 'dimension') {
      if (!this.dimPoints) { this.dimPoints = [snapped]; this.render(); return; }
      if (this.dimPoints.length === 1) {
        if (dist(this.dimPoints[0], snapped) < 1e-6) return;
        this.dimPoints.push(snapped);
        this.render();
        return;
      }
      this._commitDimension(this._dimOffsetFor(world));
      return;
    }

    if (DRAW_TOOLS.has(tool)) {
      if (!this.drawPoints) this.drawPoints = [];
      // Clicking back on the first point closes a polygon / curve / area.
      if (tool !== 'line' && this.drawPoints.length >= 3 &&
          dist(snapped, this.drawPoints[0]) <= SNAP_PX / this.zoom) {
        this._finishDrawing();
        return;
      }
      this.drawPoints.push(snapped);
      if (tool === 'line' && this.drawPoints.length === 2) this._finishDrawing();
      this.render();
      return;
    }

    if (tool === 'rect') {
      this.dragMode = 'rect';
      this.dragStart = snapped;
      return;
    }

    if (tool === 'circle') {
      this.dragMode = 'circle';
      this.dragStart = snapped;
      return;
    }
  }

  _handleSelectDown(world, shift) {
    const state = this.store.state;
    const selected = this._selectedShapes();
    this.dragHistoryTaken = false;

    // 1. a vertex handle on a single selected polygon / line / curve
    if (selected.length === 1) {
      const vi = this._vertexHandleAtPoint(selected[0], world);
      if (vi !== null) {
        this.dragMode = 'vertex';
        this.dragStart = world;
        this.vertexIndex = vi;
        this.dragSnapshots = new Map([[selected[0].id, JSON.parse(JSON.stringify(selected[0]))]]);
        return;
      }
    }

    // 2. a scale handle on the selection's bounding box
    if (selected.length) {
      const handle = this._scaleHandleAtPoint(selected, world);
      if (handle) {
        this.dragMode = 'scale';
        this.dragStart = world;
        this.dragSnapshots = new Map(selected.map((s) => [s.id, JSON.parse(JSON.stringify(s))]));
        this.scaleHandle = handle; // { corner: {x,y}, anchor: {x,y} }
        return;
      }
    }

    const selectedImage = state.images.find((im) => im.id === state.selectedImageId);
    if (selectedImage) {
      const handle = this._imageHandleAtPoint(selectedImage, world);
      if (handle) {
        this.dragMode = 'scale-image';
        this.dragStart = world;
        this.dragImageSnapshot = { id: selectedImage.id, ...selectedImage };
        this.scaleCenter = { x: selectedImage.x, y: selectedImage.y };
        return;
      }
    }

    // 3. a shape — the active level wins over shapes on other levels
    const hit = this._hitShape(world);
    if (hit) {
      let ids;
      if (shift) {
        ids = state.selection.includes(hit.id)
          ? state.selection.filter((id) => id !== hit.id)
          : [...state.selection, hit.id];
      } else {
        ids = state.selection.includes(hit.id) ? state.selection : [hit.id];
      }
      this.store.setSelection(ids);
      if (!ids.includes(hit.id)) return; // shift-click just deselected it
      // A plain click (no drag) on one shape of a multi-selection narrows
      // the selection to it on release; a drag moves them all.
      this.narrowTo = !shift && ids.length > 1 ? hit.id : null;
      const moving = this._selectedShapes();
      this.dragMode = 'move';
      this.dragStart = world;
      this.dragSnapshots = new Map(moving.map((s) => [s.id, JSON.parse(JSON.stringify(s))]));
      // The anchor is the moving geometry's vertex closest to where it was
      // grabbed: it's that vertex, not the raw cursor, that gets snapped, so
      // the shape itself lands on the grid / on another shape's corner.
      let best = null, bestD = Infinity;
      for (const s of moving) {
        for (const v of snapVertices(s)) {
          const d = dist(v, world);
          if (d < bestD) { bestD = d; best = v; }
        }
      }
      this.moveAnchor = best ? { ...best } : { ...world };
      return;
    }

    // 4. a measurement annotation
    const ann = this._hitAnnotation(world);
    if (ann) {
      this.store.setSelectedAnnotation(ann.kind, ann.id);
      return;
    }

    // 5. a reference image
    const imgHit = [...state.images].reverse().find((img) => this._imageContains(img, world));
    if (imgHit) {
      this.store.setSelectedImage(imgHit.id);
      this.dragMode = 'move-image';
      this.dragStart = world;
      this.dragImageSnapshot = { id: imgHit.id, x: imgHit.x, y: imgHit.y };
      return;
    }

    // 6. empty space — clear the selection (unless adding) and start a marquee
    if (!shift) this.store.setSelection([]);
    this.dragMode = 'marquee';
    this.dragStart = world;
    this.marqueeBase = shift ? [...state.selection] : [];
  }

  _selectedShapes() {
    const { shapes, selection } = this.store.state;
    return shapes.filter((s) => selection.includes(s.id));
  }

  _hitShape(world) {
    const state = this.store.state;
    const tol = 6 / this.zoom;
    const selectable = (s) => {
      const layer = state.layers.find((l) => l.id === s.layerId);
      return layer && layer.visible && !layer.locked && hitTestShape(world, s, tol);
    };
    const rev = [...state.shapes].reverse();
    return rev.find((s) => s.layerId === state.activeLayerId && selectable(s)) ||
           rev.find((s) => s.layerId !== state.activeLayerId && selectable(s));
  }

  _hitAnnotation(world) {
    const { dimensions, areas, display } = this.store.state;
    const tol = 6 / this.zoom;
    if (display.dims) {
      for (const d of [...dimensions].reverse()) {
        const g = this._dimGeometry(d);
        if (!g) continue;
        if (distToSegment(world, g.p1, g.p2) <= tol) return { kind: 'dimension', id: d.id };
      }
    }
    for (const a of [...areas].reverse()) {
      if (pointInPolygon(world, a.points)) return { kind: 'area', id: a.id };
    }
    return null;
  }

  _imageContains(img, world) {
    return world.x >= img.x - img.width / 2 && world.x <= img.x + img.width / 2 &&
           world.y >= img.y - img.height / 2 && world.y <= img.y + img.height / 2;
  }

  // Same corner-proximity test as the shape handles, for an image's bounding box.
  _imageHandleAtPoint(img, world) {
    const corners = {
      nw: { x: img.x - img.width / 2, y: img.y + img.height / 2 },
      ne: { x: img.x + img.width / 2, y: img.y + img.height / 2 },
      sw: { x: img.x - img.width / 2, y: img.y - img.height / 2 },
      se: { x: img.x + img.width / 2, y: img.y - img.height / 2 },
    };
    const tol = (HANDLE_SIZE + 4) / this.zoom;
    for (const [name, p] of Object.entries(corners)) {
      if (dist(world, p) <= tol) return name;
    }
    return null;
  }

  _selectionBounds(shapes) {
    const pts = [];
    for (const s of shapes) pts.push(...shapePoints(s));
    return pts.length ? boundsOf(pts) : null;
  }

  // Bounding-box corners, each paired with the opposite corner it scales about.
  _scaleCorners(b) {
    return [
      { name: 'nw', corner: { x: b.minX, y: b.maxY }, anchor: { x: b.maxX, y: b.minY }, dir: { x: -1, y: -1 } },
      { name: 'ne', corner: { x: b.maxX, y: b.maxY }, anchor: { x: b.minX, y: b.minY }, dir: { x: 1, y: -1 } },
      { name: 'sw', corner: { x: b.minX, y: b.minY }, anchor: { x: b.maxX, y: b.maxY }, dir: { x: -1, y: 1 } },
      { name: 'se', corner: { x: b.maxX, y: b.minY }, anchor: { x: b.minX, y: b.maxY }, dir: { x: 1, y: 1 } },
    ];
  }

  // Scale handles are drawn a few pixels diagonally outside each corner so
  // they never sit on top of a vertex handle at that same corner.
  _scaleHandleScreen(c) {
    const s = this.worldToScreen(c.corner);
    return { x: s.x + c.dir.x * SCALE_HANDLE_OFFSET_PX, y: s.y + c.dir.y * SCALE_HANDLE_OFFSET_PX };
  }

  _scaleHandleAtPoint(shapes, world) {
    const b = this._selectionBounds(shapes);
    if (!b) return null;
    const ws = this.worldToScreen(world);
    for (const c of this._scaleCorners(b)) {
      const s = this._scaleHandleScreen(c);
      if (Math.hypot(ws.x - s.x, ws.y - s.y) <= HANDLE_SIZE + 3) return c;
    }
    return null;
  }

  _hasVertexHandles(shape) {
    return shape.type === 'polygon' || shape.type === 'line' || shape.type === 'spline';
  }

  _vertexHandleAtPoint(shape, world) {
    if (!this._hasVertexHandles(shape)) return null;
    const tol = (HANDLE_SIZE + 2) / this.zoom;
    let best = null, bestD = tol;
    shape.points.forEach((p, i) => {
      const d = dist(world, p);
      if (d <= bestD) { bestD = d; best = i; }
    });
    return best;
  }

  _onMove(e) {
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (this.dragMode === 'pinch') {
      this._updatePinch();
      return;
    }
    this.shiftDown = e.shiftKey;

    const world = this._eventWorld(e);
    this.cursorWorld = world;

    if (this.dragMode === 'pan') {
      const dx = (e.clientX - this.dragStart.x) / this.zoom;
      const dy = (e.clientY - this.dragStart.y) / this.zoom;
      this.pan = { x: this.dragStart.panX - dx, y: this.dragStart.panY + dy };
      this.render();
      this._emitStatus();
      return;
    }

    if (this.dragMode === 'move' && this.dragSnapshots) {
      // Snap the grabbed vertex, then carry the whole selection by the same delta.
      const raw = { x: this.moveAnchor.x + world.x - this.dragStart.x, y: this.moveAnchor.y + world.y - this.dragStart.y };
      const target = this._snapped(raw, new Set(this.dragSnapshots.keys()));
      const dx = target.x - this.moveAnchor.x;
      const dy = target.y - this.moveAnchor.y;
      if (!this.dragHistoryTaken && Math.hypot(dx, dy) < 1e-9) { this.render(); return; }
      this._takeDragHistory();
      const patches = {};
      for (const [id, snap] of this.dragSnapshots) {
        patches[id] = mapShapeCoords(snap, (p) => ({ x: p.x + dx, y: p.y + dy }));
      }
      this.store.updateShapes(patches, { history: false });
      this._emitStatus({ measure: `Δx ${dx.toFixed(2)} m, Δy ${dy.toFixed(2)} m` });
      return;
    }

    if (this.dragMode === 'scale' && this.dragSnapshots) {
      this._takeDragHistory();
      const { corner, anchor } = this.scaleHandle;
      const target = this._snapped(world, new Set(this.dragSnapshots.keys()));
      const w = corner.x - anchor.x, h = corner.y - anchor.y;
      let sx = Math.abs(w) > 1e-9 ? (target.x - anchor.x) / w : 1;
      let sy = Math.abs(h) > 1e-9 ? (target.y - anchor.y) / h : 1;
      sx = Math.max(0.05, sx);
      sy = Math.max(0.05, sy);
      const hasCircle = [...this.dragSnapshots.values()].some((s) => s.type === 'circle');
      if (this.shiftDown || hasCircle) {
        const u = Math.abs(w) < 1e-9 ? sy : Math.abs(h) < 1e-9 ? sx : Math.max(sx, sy);
        sx = sy = u;
      }
      const fn = (p) => ({ x: anchor.x + (p.x - anchor.x) * sx, y: anchor.y + (p.y - anchor.y) * sy });
      const patches = {};
      for (const [id, snap] of this.dragSnapshots) patches[id] = mapShapeCoords(snap, fn, sx);
      this.store.updateShapes(patches, { history: false });
      const nb = this._selectionBounds(this._selectedShapes());
      this._emitStatus({ measure: nb ? `${(nb.maxX - nb.minX).toFixed(2)} × ${(nb.maxY - nb.minY).toFixed(2)} m` : undefined });
      return;
    }

    if (this.dragMode === 'vertex' && this.dragSnapshots) {
      const [id, snap] = [...this.dragSnapshots][0];
      const target = this._snapped(world, id);
      if (!this.dragHistoryTaken && dist(target, snap.points[this.vertexIndex]) < 1e-9) { this.render(); return; }
      this._takeDragHistory();
      const points = snap.points.map((p, i) => (i === this.vertexIndex ? target : p));
      this.store.updateShape(id, { points }, { history: false });
      this._emitStatus();
      return;
    }

    if (this.dragMode === 'marquee') {
      this.render();
      this._emitStatus();
      return;
    }

    if (this.dragMode === 'move-image' && this.dragImageSnapshot) {
      this._takeDragHistory();
      const dx = world.x - this.dragStart.x;
      const dy = world.y - this.dragStart.y;
      this.store.updateImage(this.dragImageSnapshot.id, {
        x: this.dragImageSnapshot.x + dx,
        y: this.dragImageSnapshot.y + dy,
      }, { history: false });
      this._emitStatus();
      return;
    }

    if (this.dragMode === 'scale-image' && this.dragImageSnapshot) {
      this._takeDragHistory();
      const factor = this._scaleFactor(world);
      this.store.updateImage(this.dragImageSnapshot.id, {
        width: this.dragImageSnapshot.width * factor,
        height: this.dragImageSnapshot.height * factor,
      }, { history: false });
      this._emitStatus();
      return;
    }

    // Idle / drawing: show where a click would land, with a live measurement.
    const tool = this.store.state.tool;
    if (tool !== 'select' && tool !== 'pushpull') this.cursorSnapped = this._snapped(world);
    else this.snapPointActive = null;
    this.render();
    this._emitStatus({ measure: this._liveMeasure() });
  }

  // Text for the status bar while a draw/measure tool is in progress.
  _liveMeasure() {
    const c = this.cursorSnapped;
    if (this.dimPoints?.length === 1) return `L ${formatLength(dist(this.dimPoints[0], c))}`;
    if (this.dimPoints?.length === 2) return `L ${formatLength(dist(this.dimPoints[0], this.dimPoints[1]))} — click to place`;
    if (this.dragMode === 'rect' && this.dragStart) {
      const w = Math.abs(c.x - this.dragStart.x), h = Math.abs(c.y - this.dragStart.y);
      return `${w.toFixed(2)} × ${h.toFixed(2)} m · ${formatArea(w * h)}`;
    }
    if (this.dragMode === 'circle' && this.dragStart) {
      const r = dist(this.dragStart, c);
      return `R ${formatLength(r)} · ${formatArea(Math.PI * r * r)}`;
    }
    if (this.drawPoints?.length) {
      const pts = [...this.drawPoints, c];
      const last = this.drawPoints[this.drawPoints.length - 1];
      let text = `segment ${formatLength(dist(last, c))}`;
      if (pts.length >= 3 && this.store.state.tool !== 'line') {
        const outline = this.store.state.tool === 'spline' ? sampleSpline(pts, true) : pts;
        text += ` · area ${formatArea(Math.abs(polygonArea(outline)))}`;
      }
      return text;
    }
    return undefined;
  }

  _scaleFactor(world) {
    const base = dist(this.dragStart, this.scaleCenter) || 0.0001;
    const cur = dist(world, this.scaleCenter);
    return Math.max(0.05, cur / base);
  }

  _onUp(e) {
    this.activePointers.delete(e.pointerId);

    if (this.dragMode === 'pinch') {
      if (this.activePointers.size < 2) {
        this.dragMode = null;
        this._pinchLastDist = null;
        this._pinchLastMid = null;
      }
      return;
    }
    if (!this.dragMode) return;

    const world = this._eventWorld(e);

    if (this.dragMode === 'rect' && this.dragStart) {
      const a = this.dragStart;
      const b = this._snapped(world);
      if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) {
        const layer = this.store.activeLayer();
        this.store.addShape({
          id: nextId('shape'),
          type: 'rect',
          layerId: layer.id,
          closed: true,
          points: [
            { x: a.x, y: a.y }, { x: b.x, y: a.y },
            { x: b.x, y: b.y }, { x: a.x, y: b.y },
          ],
          height: layer.defaultHeight,
          color: layer.color,
        });
      }
    } else if (this.dragMode === 'circle' && this.dragStart) {
      const r = dist(this.dragStart, this._snapped(world));
      if (r > 0.01) {
        const layer = this.store.activeLayer();
        this.store.addShape({
          id: nextId('shape'),
          type: 'circle',
          layerId: layer.id,
          closed: true,
          center: { x: this.dragStart.x, y: this.dragStart.y },
          radius: r,
          height: layer.defaultHeight,
          color: layer.color,
        });
      }
    } else if (this.dragMode === 'move' && this.narrowTo && !this.dragHistoryTaken) {
      this.store.setSelection([this.narrowTo]);
    } else if (this.dragMode === 'marquee' && this.dragStart) {
      this._finishMarquee(world);
    } else if (this.dragMode === 'vertex' && this.dragSnapshots && this.dragHistoryTaken) {
      // A dragged rectangle corner is no longer a rectangle.
      const [id, snap] = [...this.dragSnapshots][0];
      if (snap.type === 'rect') this.store.updateShape(id, { type: 'polygon' }, { history: false });
    }
    // move/scale/vertex drags took their undo snapshot on first movement and
    // applied live updates with history:false, so there's nothing more to commit here.

    this.dragMode = null;
    this.dragStart = null;
    this.dragSnapshots = null;
    this.dragImageSnapshot = null;
    this.dragHistoryTaken = false;
    this.narrowTo = null;
    this.snapPointActive = null;
    this.render();
  }

  _finishMarquee(world) {
    const a = this.worldToScreen(this.dragStart), b = this.worldToScreen(world);
    if (Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4) return; // just a click
    const minX = Math.min(this.dragStart.x, world.x), maxX = Math.max(this.dragStart.x, world.x);
    const minY = Math.min(this.dragStart.y, world.y), maxY = Math.max(this.dragStart.y, world.y);
    const { layers } = this.store.state;
    const inside = this.store.state.shapes.filter((s) => {
      const layer = layers.find((l) => l.id === s.layerId);
      if (!layer || !layer.visible || layer.locked) return false;
      const bb = boundsOf(shapePoints(s));
      return bb.minX >= minX && bb.maxX <= maxX && bb.minY >= minY && bb.maxY <= maxY;
    }).map((s) => s.id);
    const ids = [...new Set([...this.marqueeBase, ...inside])];
    // Keep the active level as it is — setSelection would switch it to the first hit's level.
    const active = this.store.state.activeLayerId;
    this.store.setSelection(ids);
    if (inside.length > 1) this.store.state.activeLayerId = active;
    this.store.notify();
  }

  _onWheel(e) {
    e.preventDefault();
    const before = this._eventWorld(e);
    const factor = Math.exp(-e.deltaY * 0.001);
    this.zoom = Math.min(400, Math.max(4, this.zoom * factor));
    const after = this._eventWorld(e);
    this.pan.x += before.x - after.x;
    this.pan.y += before.y - after.y;
    this.render();
    this._emitStatus();
  }

  // Two-finger pinch-zoom + pan, combined in one gesture like a map or photo
  // app: the world point under the pinch midpoint stays anchored to it on
  // every frame, which zooms around that point AND pans with it if the
  // midpoint itself drifts (a two-finger drag alongside the pinch).
  _updatePinch() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return;
    const [p1, p2] = pts;
    const curDist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const r = this.canvas.getBoundingClientRect();
    const midLocal = { x: (p1.x + p2.x) / 2 - r.left, y: (p1.y + p2.y) / 2 - r.top };

    const worldBefore = this.screenToWorld(this._pinchLastMid.x, this._pinchLastMid.y);
    const factor = curDist / this._pinchLastDist;
    this.zoom = Math.min(400, Math.max(4, this.zoom * factor));
    const worldAfter = this.screenToWorld(midLocal.x, midLocal.y);
    this.pan.x += worldBefore.x - worldAfter.x;
    this.pan.y += worldBefore.y - worldAfter.y;

    this._pinchLastDist = curDist;
    this._pinchLastMid = midLocal;
    this.render();
    this._emitStatus();
  }

  // Enter / double-click: close the polygon, curve or area being drawn, or
  // place a dimension at zero offset.
  _finishDrawing() {
    const tool = this.store.state.tool;
    if (tool === 'dimension') {
      if (this.dimPoints?.length === 2) this._commitDimension(0);
      return;
    }
    if (!this.drawPoints) return;
    // A double-click lands two pointerdowns on the same spot before the
    // dblclick event — drop the repeated vertices it leaves behind.
    const pts = this.drawPoints.filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 1e-6);
    if (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
    this.drawPoints = null;
    const layer = this.store.activeLayer();

    if (tool === 'line' && pts.length >= 2) {
      this.store.addShape({
        id: nextId('shape'), type: 'line', layerId: layer.id,
        closed: false, points: pts.slice(0, 2), height: 0, color: layer.color,
      });
    } else if ((tool === 'polygon' || tool === 'spline') && pts.length >= 3) {
      this.store.addShape({
        id: nextId('shape'), type: tool, layerId: layer.id,
        closed: true, points: pts, height: layer.defaultHeight, color: layer.color,
      });
    } else if (tool === 'area' && pts.length >= 3) {
      this.store.addArea({ id: nextId('area'), points: pts, z: layer.elevation });
    }
    this.render();
  }

  _dimOffsetFor(world) {
    const [a, b] = this.dimPoints;
    const len = dist(a, b) || 1;
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const raw = (world.x - a.x) * n.x + (world.y - a.y) * n.y;
    const { grid } = this.store.state;
    // Snap the offset to half-grid steps so a row of dimensions lines up.
    return grid.snap ? Math.round(raw / (grid.size / 2)) * (grid.size / 2) : raw;
  }

  _commitDimension(offset) {
    const [a, b] = this.dimPoints;
    const z = this.store.activeLayer().elevation;
    this.dimPoints = null;
    this.store.addDimension({ id: nextId('dim'), a: { ...a, z }, b: { ...b, z }, offset });
  }

  _cancelDraw() {
    this.drawPoints = null;
    this.dimPoints = null;
    this.dragMode = null;
    this.dragStart = null;
    this.render();
  }

  _deleteSelection() {
    const s = this.store.state;
    if (s.selection.length) {
      this.store.removeShapes(s.selection);
    } else if (s.selectedImageId) {
      this.store.removeImage(s.selectedImageId);
    } else if (s.selectedModelId) {
      this.store.removeImportedModel(s.selectedModelId);
    } else if (s.selectedAnnotation) {
      this.store.removeAnnotation(s.selectedAnnotation.kind, s.selectedAnnotation.id);
    }
  }

  _emitStatus(extra = {}) {
    this.onStatus({
      cursor: this.cursorWorld,
      zoom: this.zoom,
      tool: this.store.state.tool,
      ...extra,
    });
  }

  // ---------------- rendering ----------------
  render() {
    const ctx = this.ctx;
    const r = this.canvas.getBoundingClientRect();
    ctx.save();
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.fillStyle = '#12161c';
    ctx.fillRect(0, 0, r.width, r.height);

    this._drawGrid(r);
    this._drawImages();
    this._drawShapes();
    this._drawAreas();
    if (this.store.state.display.dims) this._drawDimensions();
    this._drawInProgress();
    this._drawSelection();
    this._drawMarquee();
    this._drawSnapMarker();
    ctx.restore();
  }

  // ---------------- reference images ----------------
  _getImageElement(img) {
    let el = this._imageEls.get(img.id);
    if (!el) {
      const dataUrl = this.store.imageAssets.get(img.id);
      el = new Image();
      if (dataUrl) el.src = dataUrl;
      el.onload = () => this.render();
      this._imageEls.set(img.id, el);
    }
    return el;
  }

  _drawImages() {
    const ctx = this.ctx;
    for (const img of this.store.state.images) {
      const el = this._getImageElement(img);
      if (!el.complete || !el.naturalWidth) continue;
      const topLeft = this.worldToScreen({ x: img.x - img.width / 2, y: img.y + img.height / 2 });
      const w = img.width * this.zoom;
      const h = img.height * this.zoom;
      ctx.save();
      ctx.globalAlpha = img.opacity ?? 0.6;
      ctx.drawImage(el, topLeft.x, topLeft.y, w, h);
      ctx.restore();
      if (this.store.state.selectedImageId === img.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(topLeft.x, topLeft.y, w, h);
        ctx.setLineDash([]);
        for (const corner of [
          { x: img.x - img.width / 2, y: img.y + img.height / 2 },
          { x: img.x + img.width / 2, y: img.y + img.height / 2 },
          { x: img.x - img.width / 2, y: img.y - img.height / 2 },
          { x: img.x + img.width / 2, y: img.y - img.height / 2 },
        ]) {
          const s = this.worldToScreen(corner);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(s.x - HANDLE_SIZE / 2, s.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        }
      }
    }
  }

  _drawGrid(r) {
    const ctx = this.ctx;
    const { size, majorEvery } = this.store.state.grid;
    const stepPx = size * this.zoom;
    if (stepPx < 4) return;

    const originScreen = this.worldToScreen({ x: 0, y: 0 });
    ctx.lineWidth = 1;

    const startCol = Math.floor((-originScreen.x) / stepPx) - 1;
    const endCol = Math.ceil((r.width - originScreen.x) / stepPx) + 1;
    const startRow = Math.floor((-originScreen.y) / stepPx) - 1;
    const endRow = Math.ceil((r.height - originScreen.y) / stepPx) + 1;

    for (let i = startCol; i <= endCol; i++) {
      const x = originScreen.x + i * stepPx;
      ctx.strokeStyle = i % majorEvery === 0 ? '#2a323d' : '#1a2028';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, r.height); ctx.stroke();
    }
    for (let j = startRow; j <= endRow; j++) {
      const y = originScreen.y + j * stepPx;
      ctx.strokeStyle = j % majorEvery === 0 ? '#2a323d' : '#1a2028';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(r.width, y); ctx.stroke();
    }
    // axes
    ctx.strokeStyle = '#3d4b5c';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(originScreen.x, 0); ctx.lineTo(originScreen.x, r.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, originScreen.y); ctx.lineTo(r.width, originScreen.y); ctx.stroke();
  }

  _drawShapes() {
    const { shapes, layers, selection, activeLayerId } = this.store.state;
    // Other levels first and ghosted, so the level you're working on reads on top.
    const ordered = [...shapes].sort((a, b) => (a.layerId === activeLayerId) - (b.layerId === activeLayerId));
    for (const shape of ordered) {
      const layer = layers.find((l) => l.id === shape.layerId);
      if (!layer || !layer.visible) continue;
      const selected = selection.includes(shape.id);
      const ghost = shape.layerId !== activeLayerId && !selected;
      this.ctx.save();
      if (ghost) this.ctx.globalAlpha = 0.35;
      this._drawShape(shape, selected);
      this.ctx.restore();
    }
  }

  _tracePath(pts, closed) {
    const ctx = this.ctx;
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.closePath();
  }

  _drawShape(shape, selected) {
    const ctx = this.ctx;
    const pts = shapePoints(shape).map((p) => this.worldToScreen(p));
    if (!pts.length) return;

    ctx.beginPath();
    this._tracePath(pts, shape.closed);
    for (const h of shape.holes || []) this._tracePath(h.map((p) => this.worldToScreen(p)), true);

    if (shape.closed) {
      const alpha = (shape.height > 0 ? 0.2 : 0.1) * (0.4 + 0.6 * (shape.opacity ?? 1));
      ctx.fillStyle = shape.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
      ctx.fill('evenodd');
    }
    ctx.strokeStyle = selected ? '#ffffff' : shape.color;
    ctx.lineWidth = selected ? 2.5 : 1.75;
    ctx.stroke();

    if (shape.closed && (shape.height > 0 || this.store.state.display.areaLabels)) {
      // small badge showing extrusion height (and footprint area, if enabled)
      const parts = [];
      if (shape.height > 0) parts.push(`${shape.height.toFixed(2)}m`);
      if (shape.base) parts.push(`+${shape.base.toFixed(2)}`);
      if (this.store.state.display.areaLabels) parts.push(formatArea(shapeArea(shape)));
      this._badge(parts.join(' · '), this.worldToScreen(centroid(shapePoints(shape))));
    }
  }

  _badge(label, c, { bg = 'rgba(0,0,0,0.55)', fg = '#e8edf3' } = {}) {
    const ctx = this.ctx;
    ctx.font = '11px Inter, system-ui, sans-serif';
    const lines = label.split('\n');
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 8;
    const h = 14 * lines.length + 2;
    ctx.fillStyle = bg;
    ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, c.x, c.y - h / 2 + 8 + i * 14));
  }

  // ---------------- measurement annotations ----------------
  // Plan geometry of a dimension: the measured points a/b, and the offset
  // dimension line p1-p2 parallel to them. Returns null for a dimension with
  // no plan extent (a purely vertical one measured in the 3D view).
  _dimGeometry(d) {
    const len = dist(d.a, d.b);
    if (len < 1e-6) return null;
    const n = { x: -(d.b.y - d.a.y) / len, y: (d.b.x - d.a.x) / len };
    const off = d.offset || 0;
    return {
      a: d.a, b: d.b, n, off,
      p1: { x: d.a.x + n.x * off, y: d.a.y + n.y * off },
      p2: { x: d.b.x + n.x * off, y: d.b.y + n.y * off },
    };
  }

  _drawDimensions() {
    const sel = this.store.state.selectedAnnotation;
    for (const d of this.store.state.dimensions) {
      const g = this._dimGeometry(d);
      if (!g) continue;
      const trueLen = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y, (d.b.z ?? 0) - (d.a.z ?? 0));
      const selected = sel?.kind === 'dimension' && sel.id === d.id;
      this._drawDimension(g, formatLength(trueLen), selected ? '#ffffff' : MEASURE_COLOR);
    }
  }

  _drawDimension(g, label, color) {
    const ctx = this.ctx;
    const A = this.worldToScreen(g.a), B = this.worldToScreen(g.b);
    const P1 = this.worldToScreen(g.p1), P2 = this.worldToScreen(g.p2);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.25;
    // extension lines, with a small gap at the measured point and a small overshoot
    const ext = (from, to) => {
      const vx = to.x - from.x, vy = to.y - from.y;
      const l = Math.hypot(vx, vy);
      if (l < 1) return;
      const ux = vx / l, uy = vy / l;
      ctx.beginPath();
      ctx.moveTo(from.x + ux * 3, from.y + uy * 3);
      ctx.lineTo(to.x + ux * 5, to.y + uy * 5);
      ctx.stroke();
    };
    ext(A, P1);
    ext(B, P2);
    ctx.beginPath(); ctx.moveTo(P1.x, P1.y); ctx.lineTo(P2.x, P2.y); ctx.stroke();
    // architectural ticks (45° slashes)
    const ang = Math.atan2(P2.y - P1.y, P2.x - P1.x);
    for (const p of [P1, P2]) {
      ctx.beginPath();
      ctx.moveTo(p.x - 5 * Math.cos(ang + Math.PI / 4), p.y - 5 * Math.sin(ang + Math.PI / 4));
      ctx.lineTo(p.x + 5 * Math.cos(ang + Math.PI / 4), p.y + 5 * Math.sin(ang + Math.PI / 4));
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // label, kept upright
    let rot = ang;
    if (rot > Math.PI / 2) rot -= Math.PI;
    if (rot < -Math.PI / 2) rot += Math.PI;
    ctx.translate((P1.x + P2.x) / 2, (P1.y + P2.y) / 2);
    ctx.rotate(rot);
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    const w = ctx.measureText(label).width + 6;
    ctx.fillStyle = 'rgba(18,22,28,0.85)';
    ctx.fillRect(-w / 2, -16, w, 14);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, -9);
    ctx.restore();
  }

  _hatch() {
    if (this._hatchPattern) return this._hatchPattern;
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,209,102,0.45)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.stroke();
    this._hatchPattern = this.ctx.createPattern(c, 'repeat');
    return this._hatchPattern;
  }

  _drawAreas() {
    const ctx = this.ctx;
    const sel = this.store.state.selectedAnnotation;
    for (const a of this.store.state.areas) {
      const pts = a.points.map((p) => this.worldToScreen(p));
      const selected = sel?.kind === 'area' && sel.id === a.id;
      ctx.save();
      ctx.beginPath();
      this._tracePath(pts, true);
      ctx.fillStyle = this._hatch();
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = selected ? '#ffffff' : MEASURE_COLOR;
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.stroke();
      ctx.restore();
      const label = `${formatArea(Math.abs(polygonArea(a.points)))}\nP ${formatLength(ringLength(a.points, true))}`;
      this._badge(label, this.worldToScreen(centroid(a.points)), { bg: 'rgba(18,22,28,0.85)', fg: MEASURE_COLOR });
    }
  }

  _drawInProgress() {
    const ctx = this.ctx;
    const tool = this.store.state.tool;
    const cursorW = this.cursorSnapped;

    if (this.dimPoints) {
      const [a, b] = this.dimPoints;
      if (!b) {
        const g = this._dimGeometry({ a, b: cursorW, offset: 0 });
        if (g) this._drawDimension(g, formatLength(dist(a, cursorW)), '#4fa3ff');
      } else {
        const g = this._dimGeometry({ a, b, offset: this._dimOffsetFor(this.cursorWorld) });
        this._drawDimension(g, formatLength(dist(a, b)), '#4fa3ff');
      }
      return;
    }

    if (!this.drawPoints || !this.drawPoints.length) {
      if (this.dragMode === 'rect' && this.dragStart) {
        this._drawRubberRect(this.dragStart, cursorW);
      } else if (this.dragMode === 'circle' && this.dragStart) {
        this._drawRubberCircle(this.dragStart, cursorW);
      }
      return;
    }
    const worldPts = [...this.drawPoints, cursorW];
    const color = tool === 'area' ? MEASURE_COLOR : '#4fa3ff';
    const outline = tool === 'spline' ? sampleSpline(worldPts, worldPts.length >= 3) : worldPts;
    const pts = outline.map((p) => this.worldToScreen(p));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    this._tracePath(pts, false);
    ctx.stroke();
    ctx.setLineDash([]);
    if (tool === 'spline') {
      // control polygon, faint
      ctx.strokeStyle = '#4fa3ff55';
      ctx.lineWidth = 1;
      ctx.beginPath();
      this._tracePath(worldPts.map((p) => this.worldToScreen(p)), false);
      ctx.stroke();
    }
    for (const p of this.drawPoints.map((q) => this.worldToScreen(q))) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawRubberRect(a, b) {
    const ctx = this.ctx;
    const p1 = this.worldToScreen(a);
    const p2 = this.worldToScreen(b);
    ctx.strokeStyle = '#4fa3ff';
    ctx.fillStyle = '#4fa3ff22';
    ctx.lineWidth = 1.75;
    ctx.setLineDash([5, 4]);
    const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    this._badge(`${Math.abs(b.x - a.x).toFixed(2)} × ${Math.abs(b.y - a.y).toFixed(2)} m`, { x: x + w / 2, y: y + h / 2 });
  }

  _drawRubberCircle(center, edge) {
    const ctx = this.ctx;
    const c = this.worldToScreen(center);
    const rWorld = dist(center, edge);
    const rPx = rWorld * this.zoom;
    ctx.strokeStyle = '#4fa3ff';
    ctx.fillStyle = '#4fa3ff22';
    ctx.lineWidth = 1.75;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    this._badge(`R ${formatLength(rWorld)}`, c);
  }

  _drawSelection() {
    const shapes = this._selectedShapes();
    if (!shapes.length) return;
    const ctx = this.ctx;
    const b = this._selectionBounds(shapes);
    ctx.strokeStyle = '#ffffff88';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    const p1 = this.worldToScreen({ x: b.minX, y: b.minY });
    const p2 = this.worldToScreen({ x: b.maxX, y: b.maxY });
    ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    ctx.setLineDash([]);
    // scale handles: squares just outside each corner
    for (const c of this._scaleCorners(b)) {
      const s = this._scaleHandleScreen(c);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(s.x - HANDLE_SIZE / 2, s.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    }
    // vertex handles: circles on every editable point
    if (shapes.length === 1 && this._hasVertexHandles(shapes[0])) {
      for (const p of shapes[0].points) {
        const s = this.worldToScreen(p);
        ctx.fillStyle = '#12161c';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  _drawMarquee() {
    if (this.dragMode !== 'marquee' || !this.dragStart) return;
    const ctx = this.ctx;
    const a = this.worldToScreen(this.dragStart), b = this.worldToScreen(this.cursorWorld);
    ctx.save();
    ctx.strokeStyle = '#4fa3ff';
    ctx.fillStyle = '#4fa3ff18';
    ctx.setLineDash([4, 3]);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
  }

  // A square marks an object snap (a vertex); a small cross marks a grid snap
  // while a drawing tool is active, so it's always clear where a click lands.
  _drawSnapMarker() {
    const ctx = this.ctx;
    if (this.snapPointActive) {
      const s = this.worldToScreen(this.snapPointActive);
      ctx.strokeStyle = '#57d38c';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x - 6, s.y - 6, 12, 12);
      return;
    }
    const tool = this.store.state.tool;
    if (tool === 'select' || tool === 'pushpull' || this.dragMode === 'pan') return;
    const s = this.worldToScreen(this.cursorSnapped);
    ctx.strokeStyle = '#4fa3ffaa';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x - 5, s.y); ctx.lineTo(s.x + 5, s.y);
    ctx.moveTo(s.x, s.y - 5); ctx.lineTo(s.x, s.y + 5);
    ctx.stroke();
  }

  zoomToFit() {
    const pts = [];
    for (const s of this.store.state.shapes) pts.push(...shapePoints(s));
    for (const a of this.store.state.areas) pts.push(...a.points);
    if (!pts.length) { this.pan = { x: 0, y: 0 }; this.zoom = 32; this.render(); return; }
    const { minX, minY, maxX, maxY } = boundsOf(pts);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    this.zoom = Math.min(400, Math.max(4, Math.min(r.width / (w * 1.4), r.height / (h * 1.4))));
    this.pan = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    this.render();
  }
}
