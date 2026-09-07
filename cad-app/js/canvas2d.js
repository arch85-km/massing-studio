// canvas2d.js — the 2D plan (top-down drafting) view: grid, drawing tools,
// selection/move/scale, snapping. Pure Canvas2D, no Three.js here.

import { nextId } from './state.js';
import {
  snapPoint, dist, findNearestVertex, shapePoints, hitTestShape,
  centroid, boundsOf,
} from './geometry.js';

const HANDLE_SIZE = 7;
const SNAP_PX = 10;

export class Plan2D {
  constructor(canvas, store, { onStatus } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.onStatus = onStatus || (() => {});

    this.pan = { x: 0, y: 0 };
    this.zoom = 32; // pixels per world unit

    this.drawPoints = null;     // in-progress polygon/line points (world)
    this.dragStart = null;      // world point where a mousedown began
    this.dragMode = null;       // 'move' | 'scale' | 'rect' | 'circle' | 'pan' | 'move-image'
    this.dragShapeSnapshot = null;
    this.dragImageSnapshot = null;
    this.cursorWorld = { x: 0, y: 0 };
    this.snapPointActive = null;
    this.spaceDown = false;
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
    c.addEventListener('dblclick', () => this._finishPolygon());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') this.spaceDown = true;
      if (e.key === 'Escape') this._cancelDraw();
      if (e.key === 'Enter') this._finishPolygon();
      if ((e.key === 'Delete' || e.key === 'Backspace') && this._isCanvasFocused()) {
        this._deleteSelection();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  _isCanvasFocused() {
    // Only handle Delete when focus isn't in a text input elsewhere on the page.
    const el = document.activeElement;
    return !el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA');
  }

  _eventWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  }

  _snapped(world) {
    const { grid } = this.store.state;
    this.snapPointActive = null;
    const vertex = findNearestVertex(world, this.store.state.shapes, SNAP_PX / this.zoom);
    if (vertex) {
      this.snapPointActive = vertex;
      return { ...vertex };
    }
    if (grid.snap) return snapPoint(world, grid.size);
    return world;
  }

  _onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size >= 2) {
      // A second touch just landed — drop whatever the first one started
      // (an in-progress draw, or a shape/image drag) and switch to pinch.
      this._cancelDraw();
      this.dragShapeSnapshot = null;
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
      this.dragMode = 'pan';
      this.dragStart = { x: e.clientX, y: e.clientY, panX: this.pan.x, panY: this.pan.y };
      return;
    }

    if (tool === 'select') {
      this._handleSelectDown(world);
      return;
    }

    const snapped = this._snapped(world);

    if (tool === 'line' || tool === 'polygon') {
      if (!this.drawPoints) this.drawPoints = [];
      this.drawPoints.push(snapped);
      if (tool === 'line' && this.drawPoints.length === 2) this._finishPolygon();
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

  _handleSelectDown(world) {
    const state = this.store.state;
    const selectedShape = state.shapes.find((s) => s.id === state.selection[0]);

    if (selectedShape) {
      const handle = this._handleAtPoint(selectedShape, world);
      if (handle) {
        this.store.snapshot(); // one undo step for the whole drag
        this.dragMode = 'scale';
        this.dragStart = world;
        this.dragShapeSnapshot = JSON.parse(JSON.stringify(selectedShape));
        this.scaleHandle = handle;
        this.scaleCenter = centroid(shapePoints(selectedShape));
        return;
      }
    }

    const tol = 6 / this.zoom;
    const hit = [...state.shapes].reverse().find((s) => {
      const layer = state.layers.find((l) => l.id === s.layerId);
      return layer && layer.visible && !layer.locked && hitTestShape(world, s, tol);
    });

    if (hit) {
      this.store.setSelection([hit.id]);
      this.store.snapshot(); // one undo step for the whole drag
      this.dragMode = 'move';
      this.dragStart = world;
      this.dragShapeSnapshot = JSON.parse(JSON.stringify(hit));
      return;
    }

    const imgHit = [...state.images].reverse().find((img) => this._imageContains(img, world));
    if (imgHit) {
      this.store.setSelectedImage(imgHit.id);
      this.store.snapshot(); // one undo step for the whole drag
      this.dragMode = 'move-image';
      this.dragStart = world;
      this.dragImageSnapshot = { id: imgHit.id, x: imgHit.x, y: imgHit.y };
      return;
    }

    this.store.setSelection([]);
    this.store.setSelectedImage(null);
  }

  _imageContains(img, world) {
    return world.x >= img.x - img.width / 2 && world.x <= img.x + img.width / 2 &&
           world.y >= img.y - img.height / 2 && world.y <= img.y + img.height / 2;
  }

  _handleAtPoint(shape, world) {
    const pts = shapePoints(shape);
    const b = boundsOf(pts);
    const corners = {
      nw: { x: b.minX, y: b.maxY }, ne: { x: b.maxX, y: b.maxY },
      sw: { x: b.minX, y: b.minY }, se: { x: b.maxX, y: b.minY },
    };
    const tol = (HANDLE_SIZE + 4) / this.zoom;
    for (const [name, p] of Object.entries(corners)) {
      if (dist(world, p) <= tol) return name;
    }
    return null;
  }

  _onMove(e) {
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (this.dragMode === 'pinch') {
      this._updatePinch();
      return;
    }

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

    if (this.dragMode === 'move' && this.dragShapeSnapshot) {
      const dx = world.x - this.dragStart.x;
      const dy = world.y - this.dragStart.y;
      const patch = this._translatedPatch(this.dragShapeSnapshot, dx, dy);
      this.store.updateShape(this.dragShapeSnapshot.id, patch, { history: false });
      this._emitStatus();
      return;
    }

    if (this.dragMode === 'scale' && this.dragShapeSnapshot) {
      const factor = this._scaleFactor(world);
      const patch = this._scaledPatch(this.dragShapeSnapshot, factor);
      this.store.updateShape(this.dragShapeSnapshot.id, patch, { history: false });
      this._emitStatus();
      return;
    }

    if (this.dragMode === 'move-image' && this.dragImageSnapshot) {
      const dx = world.x - this.dragStart.x;
      const dy = world.y - this.dragStart.y;
      this.store.updateImage(this.dragImageSnapshot.id, {
        x: this.dragImageSnapshot.x + dx,
        y: this.dragImageSnapshot.y + dy,
      }, { history: false });
      this._emitStatus();
      return;
    }

    this.render();
    this._emitStatus();
  }

  _translatedPatch(shape, dx, dy) {
    if (shape.type === 'circle') {
      return { center: { x: shape.center.x + dx, y: shape.center.y + dy } };
    }
    return { points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }

  _scaleFactor(world) {
    const base = dist(this.dragStart, this.scaleCenter) || 0.0001;
    const cur = dist(world, this.scaleCenter);
    return Math.max(0.05, cur / base);
  }

  _scaledPatch(shape, factor) {
    const c = this.scaleCenter;
    const scaleP = (p) => ({ x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor });
    if (shape.type === 'circle') {
      return { center: scaleP(shape.center), radius: shape.radius * factor };
    }
    return { points: shape.points.map(scaleP) };
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

    const world = this._eventWorld(e);
    const tool = this.store.state.tool;

    if (this.dragMode === 'rect' && this.dragStart) {
      const a = this.dragStart;
      const b = this._snapped(world);
      if (dist(a, b) > 0.01) {
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
    }
    // move/scale drags already took their undo snapshot on pointerdown and
    // applied live updates with history:false, so there's nothing more to commit here.

    this.dragMode = null;
    this.dragStart = null;
    this.dragShapeSnapshot = null;
    this.dragImageSnapshot = null;
    this.render();
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

  _finishPolygon() {
    const tool = this.store.state.tool;
    if (!this.drawPoints || this.drawPoints.length < 2) { this.drawPoints = null; return; }
    const layer = this.store.activeLayer();
    if (tool === 'line') {
      this.store.addShape({
        id: nextId('shape'), type: 'line', layerId: layer.id,
        closed: false, points: this.drawPoints, height: 0, color: layer.color,
      });
    } else {
      this.store.addShape({
        id: nextId('shape'), type: 'polygon', layerId: layer.id,
        closed: true, points: this.drawPoints, height: layer.defaultHeight, color: layer.color,
      });
    }
    this.drawPoints = null;
    this.render();
  }

  _cancelDraw() {
    this.drawPoints = null;
    this.dragMode = null;
    this.dragStart = null;
    this.render();
  }

  _deleteSelection() {
    if (this.store.state.selection.length) {
      this.store.removeShapes(this.store.state.selection);
    } else if (this.store.state.selectedImageId) {
      this.store.removeImage(this.store.state.selectedImageId);
    }
  }

  _emitStatus() {
    this.onStatus({
      cursor: this.cursorWorld,
      zoom: this.zoom,
      tool: this.store.state.tool,
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
    this._drawInProgress();
    this._drawSelection();
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
    const ctx = this.ctx;
    const { shapes, layers, selection } = this.store.state;
    for (const shape of shapes) {
      const layer = layers.find((l) => l.id === shape.layerId);
      if (!layer || !layer.visible) continue;
      const selected = selection.includes(shape.id);
      this._drawShape(shape, layer, selected);
    }
  }

  _shapePathScreen(shape) {
    const pts = shapePoints(shape).map((p) => this.worldToScreen(p));
    return pts;
  }

  _drawShape(shape, layer, selected) {
    const ctx = this.ctx;
    const pts = this._shapePathScreen(shape);
    if (!pts.length) return;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (shape.closed) ctx.closePath();

    if (shape.closed) {
      ctx.fillStyle = shape.color + (shape.height > 0 ? '33' : '18');
      ctx.fill();
    }
    ctx.strokeStyle = selected ? '#ffffff' : shape.color;
    ctx.lineWidth = selected ? 2.5 : 1.75;
    ctx.stroke();

    if (shape.closed && shape.height > 0) {
      // small badge showing extrusion height
      const c = this.worldToScreen(centroid(shapePoints(shape)));
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const label = `${shape.height.toFixed(2)}m`;
      ctx.font = '11px Inter, system-ui, sans-serif';
      const w = ctx.measureText(label).width + 8;
      ctx.fillRect(c.x - w / 2, c.y - 8, w, 16);
      ctx.fillStyle = '#e8edf3';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x, c.y);
    }
  }

  _drawInProgress() {
    if (!this.drawPoints || !this.drawPoints.length) {
      if (this.dragMode === 'rect' && this.dragStart) {
        this._drawRubberRect(this.dragStart, this.cursorWorld);
      } else if (this.dragMode === 'circle' && this.dragStart) {
        this._drawRubberCircle(this.dragStart, this.cursorWorld);
      }
      return;
    }
    const ctx = this.ctx;
    const pts = this.drawPoints.map((p) => this.worldToScreen(p));
    const cursor = this.worldToScreen(this.cursorWorld);
    ctx.strokeStyle = '#4fa3ff';
    ctx.lineWidth = 1.75;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(cursor.x, cursor.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.fillStyle = '#4fa3ff';
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
  }

  _drawSelection() {
    const state = this.store.state;
    const shape = state.shapes.find((s) => s.id === state.selection[0]);
    if (!shape) return;
    const ctx = this.ctx;
    const pts = shapePoints(shape);
    const b = boundsOf(pts);
    const corners = [
      { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
    ];
    ctx.strokeStyle = '#ffffff88';
    ctx.setLineDash([3, 3]);
    const p1 = this.worldToScreen({ x: b.minX, y: b.minY });
    const p2 = this.worldToScreen({ x: b.maxX, y: b.maxY });
    ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    ctx.setLineDash([]);
    for (const c of corners) {
      const s = this.worldToScreen(c);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(s.x - HANDLE_SIZE / 2, s.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    }
  }

  zoomToFit() {
    const shapes = this.store.state.shapes;
    if (!shapes.length) { this.pan = { x: 0, y: 0 }; this.zoom = 32; this.render(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of shapes) {
      const b = boundsOf(shapePoints(s));
      minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
      minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
    }
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    this.zoom = Math.min(400, Math.max(4, Math.min(r.width / (w * 1.4), r.height / (h * 1.4))));
    this.pan = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    this.render();
  }
}
