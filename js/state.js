// state.js — central application state, mutation helpers, and undo/redo history.
// Nothing here touches the DOM or Three.js; canvas2d.js / scene3d.js / main.js
// subscribe to changes via `onChange` and re-render themselves.

let idCounter = 1;
export function nextId(prefix) {
  return `${prefix}_${idCounter++}_${Date.now().toString(36)}`;
}

function defaultLayer(name, elevation, defaultHeight, color) {
  return {
    id: nextId('layer'),
    name,
    elevation,          // base Z (world Y) this floor sits on, in meters
    defaultHeight,       // extrusion height applied to new shapes on this layer
    visible: true,
    locked: false,
    color,
  };
}

const LAYER_PALETTE = ['#4fa3ff', '#ff9d4f', '#57d38c', '#c98bff', '#ff6b6b', '#f4d35e'];

// Bottom-to-top warm ramp for "Colour levels as gradient" — deep orange at
// the ground rising to pale straw, the classic massing-diagram convention.
const GRADIENT_STOPS = ['#e8854a', '#f2a65a', '#f6c46a', '#f5da86', '#f0e6a8', '#ece9c4'];

export function levelGradient(count) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1)) * (GRADIENT_STOPS.length - 1);
    const k = Math.min(GRADIENT_STOPS.length - 2, Math.floor(t));
    const f = t - k;
    const a = hex(GRADIENT_STOPS[k]), b = hex(GRADIENT_STOPS[k + 1]);
    out.push('#' + a.map((v, j) => Math.round(v + (b[j] - v) * f).toString(16).padStart(2, '0')).join(''));
  }
  return out;
}

const DEFAULT_DISPLAY = { edges: true, areaLabels: false, dims: true, levelLines: false, xray: false };

function initialState() {
  const groundFloor = defaultLayer('Ground Floor', 0, 3, LAYER_PALETTE[0]);
  return {
    layers: [groundFloor],
    activeLayerId: groundFloor.id,
    shapes: [],
    selection: [],
    images: [],           // { id, x, y, width, height, opacity } — pixel data lives in store.imageAssets
    importedModels: [],   // { id, name, x, y, z, scale } — raw .obj text lives in store.modelAssets
    dimensions: [],       // { id, a:{x,y,z}, b:{x,y,z}, offset } — offset: plan-view offset (m) of the dimension line
    areas: [],            // { id, points, z } — measured area annotations
    selectedAnnotation: null, // { kind: 'dimension'|'area', id }
    display: { ...DEFAULT_DISPLAY },
    selectedImageId: null,
    selectedModelId: null,
    tool: 'select',
    grid: { size: 1, snap: true, majorEvery: 5 },
    view: 'split', // 'split' | '2d' | '3d'
    units: 'm',
  };
}

export class Store {
  constructor() {
    this.state = initialState();
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this._suppressHistory = false;
    // Imported binary/text assets, keyed by id. Kept OUT of `state` on purpose:
    // undo/redo snapshots JSON.stringify the whole state on every edit, and an
    // embedded image data URL or a large .obj would get duplicated into every
    // snapshot. These maps are append-only for the session (never explicitly
    // deleted on removal) so undo/redo of an add/remove always finds the data
    // it needs — only the visible `state.images` / `state.importedModels`
    // arrays control what's actually shown.
    this.imageAssets = new Map();
    this.modelAssets = new Map();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn(this.state);
  }

  // Call before a batch of mutations that should become one undo step.
  snapshot() {
    if (this._suppressHistory) return;
    this.undoStack.push(JSON.stringify(this.state));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.state));
    const prev = this.undoStack.pop();
    this._suppressHistory = true;
    this.state = JSON.parse(prev);
    this._suppressHistory = false;
    this.notify();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.state));
    const next = this.redoStack.pop();
    this._suppressHistory = true;
    this.state = JSON.parse(next);
    this._suppressHistory = false;
    this.notify();
  }

  // ---- layers ----
  addLayer() {
    this.snapshot();
    const maxTop = this.state.layers.reduce(
      (m, l) => Math.max(m, l.elevation + l.defaultHeight), 0
    );
    const color = LAYER_PALETTE[this.state.layers.length % LAYER_PALETTE.length];
    // The Ground Floor is floor 0, so the first level added above it is
    // "Floor 1" (UK/European numbering). Skip any number already in use,
    // e.g. after a level was deleted or renamed.
    const names = new Set(this.state.layers.map((l) => l.name));
    let n = this.state.layers.length;
    while (names.has(`Floor ${n}`)) n++;
    const layer = defaultLayer(`Floor ${n}`, maxTop, 3, color);
    this.state.layers.push(layer);
    this.state.activeLayerId = layer.id;
    this.notify();
  }

  removeLayer(layerId) {
    if (this.state.layers.length <= 1) return;
    this.snapshot();
    this.state.layers = this.state.layers.filter((l) => l.id !== layerId);
    this.state.shapes = this.state.shapes.filter((s) => s.layerId !== layerId);
    if (this.state.activeLayerId === layerId) {
      this.state.activeLayerId = this.state.layers[0].id;
    }
    this.notify();
  }

  updateLayer(layerId, patch) {
    this.snapshot();
    const layer = this.state.layers.find((l) => l.id === layerId);
    if (layer) Object.assign(layer, patch);
    this.notify();
  }

  // Colour every level (and the shapes on it) along the warm massing ramp,
  // ordered bottom to top by elevation.
  colourLevelsAsGradient() {
    this.snapshot();
    const ordered = [...this.state.layers].sort((a, b) => a.elevation - b.elevation);
    const colours = levelGradient(ordered.length);
    ordered.forEach((layer, i) => {
      layer.color = colours[i];
      for (const s of this.state.shapes) if (s.layerId === layer.id) s.color = colours[i];
    });
    this.notify();
  }

  // Re-stack levels so each one sits exactly on top of the one below it
  // (elevation = previous elevation + previous default height).
  restackLevels() {
    this.snapshot();
    const ordered = [...this.state.layers].sort((a, b) => a.elevation - b.elevation);
    let z = ordered.length ? ordered[0].elevation : 0;
    for (const layer of ordered) {
      layer.elevation = Math.round(z * 1000) / 1000;
      z += layer.defaultHeight;
    }
    this.notify();
  }

  setActiveLayer(layerId) {
    this.state.activeLayerId = layerId;
    this.notify();
  }

  // ---- shapes ----
  addShape(shape) {
    this.snapshot();
    this.state.shapes.push(shape);
    this.notify();
  }

  updateShape(shapeId, patch, { history = true } = {}) {
    if (history) this.snapshot();
    const shape = this.state.shapes.find((s) => s.id === shapeId);
    if (shape) Object.assign(shape, patch);
    this.notify();
  }

  removeShapes(shapeIds) {
    this.snapshot();
    const set = new Set(shapeIds);
    this.state.shapes = this.state.shapes.filter((s) => !set.has(s.id));
    this.state.selection = this.state.selection.filter((id) => !set.has(id));
    this.notify();
  }

  // Adds many shapes (e.g. a DXF import) as a single undo step.
  addShapes(shapes) {
    this.snapshot();
    this.state.shapes.push(...shapes);
    this.notify();
  }

  // Several shapes changed at once (e.g. a multi-shape drag) — one notify.
  updateShapes(patchesById, { history = true } = {}) {
    if (history) this.snapshot();
    for (const shape of this.state.shapes) {
      if (patchesById[shape.id]) Object.assign(shape, patchesById[shape.id]);
    }
    this.notify();
  }

  // Swap a set of shapes for new ones in a single undo step (booleans).
  replaceShapes(removeIds, newShapes) {
    this.snapshot();
    const set = new Set(removeIds);
    this.state.shapes = this.state.shapes.filter((s) => !set.has(s.id));
    this.state.shapes.push(...newShapes);
    this.state.selection = newShapes.map((s) => s.id);
    this.notify();
  }

  moveShapesToLayer(shapeIds, layerId) {
    this.snapshot();
    const set = new Set(shapeIds);
    for (const s of this.state.shapes) if (set.has(s.id)) s.layerId = layerId;
    this.state.activeLayerId = layerId;
    this.notify();
  }

  setSelection(ids) {
    this.state.selection = ids;
    this.state.selectedImageId = null;
    this.state.selectedModelId = null;
    this.state.selectedAnnotation = null;
    // Selecting a shape on another level makes that level the one you're working on.
    const first = this.state.shapes.find((s) => s.id === ids[0]);
    if (first && this.state.layers.some((l) => l.id === first.layerId)) this.state.activeLayerId = first.layerId;
    this.notify();
  }

  setTool(tool) {
    this.state.tool = tool;
    this.state.selection = [];
    this.state.selectedImageId = null;
    this.state.selectedModelId = null;
    this.state.selectedAnnotation = null;
    this.notify();
  }

  // ---- measurement annotations ----
  addDimension(dim) {
    this.snapshot();
    this.state.dimensions.push(dim);
    this.notify();
  }

  addArea(area) {
    this.snapshot();
    this.state.areas.push(area);
    this.notify();
  }

  removeAnnotation(kind, id) {
    this.snapshot();
    if (kind === 'dimension') this.state.dimensions = this.state.dimensions.filter((d) => d.id !== id);
    else this.state.areas = this.state.areas.filter((a) => a.id !== id);
    this.state.selectedAnnotation = null;
    this.notify();
  }

  setSelectedAnnotation(kind, id) {
    this.state.selection = [];
    this.state.selectedImageId = null;
    this.state.selectedModelId = null;
    this.state.selectedAnnotation = kind ? { kind, id } : null;
    this.notify();
  }

  setDisplay(patch) {
    Object.assign(this.state.display, patch);
    this.notify();
  }

  // ---- reference images (2D plan underlay) ----
  addImage(image, dataUrl) {
    this.snapshot();
    this.imageAssets.set(image.id, dataUrl);
    this.state.images.push(image);
    this.state.selectedImageId = image.id;
    this.state.selectedModelId = null;
    this.state.selection = [];
    this.notify();
  }

  updateImage(imageId, patch, { history = true } = {}) {
    if (history) this.snapshot();
    const img = this.state.images.find((im) => im.id === imageId);
    if (img) Object.assign(img, patch);
    this.notify();
  }

  removeImage(imageId) {
    this.snapshot();
    this.state.images = this.state.images.filter((im) => im.id !== imageId);
    if (this.state.selectedImageId === imageId) this.state.selectedImageId = null;
    this.notify();
  }

  setSelectedImage(imageId) {
    this.state.selectedAnnotation = null;
    this.state.selectedImageId = imageId;
    this.state.selectedModelId = null;
    this.state.selection = [];
    this.notify();
  }

  // ---- imported 3D reference models (static, shown in the 3D view only) ----
  addImportedModel(model, objText) {
    this.snapshot();
    this.modelAssets.set(model.id, objText);
    this.state.importedModels.push(model);
    this.notify();
  }

  updateImportedModel(modelId, patch, { history = true } = {}) {
    if (history) this.snapshot();
    const model = this.state.importedModels.find((m) => m.id === modelId);
    if (model) Object.assign(model, patch);
    this.notify();
  }

  removeImportedModel(modelId) {
    this.snapshot();
    this.state.importedModels = this.state.importedModels.filter((m) => m.id !== modelId);
    if (this.state.selectedModelId === modelId) this.state.selectedModelId = null;
    this.notify();
  }

  setSelectedModel(modelId) {
    this.state.selectedAnnotation = null;
    this.state.selectedModelId = modelId;
    this.state.selectedImageId = null;
    this.state.selection = [];
    this.notify();
  }

  setView(view) {
    this.state.view = view;
    this.notify();
  }

  toggleSnap() {
    this.state.grid.snap = !this.state.grid.snap;
    this.notify();
  }

  clearAll() {
    this.snapshot();
    const ground = defaultLayer('Ground Floor', 0, 3, LAYER_PALETTE[0]);
    this.state.layers = [ground];
    this.state.activeLayerId = ground.id;
    this.state.shapes = [];
    this.state.selection = [];
    this.state.images = [];
    this.state.importedModels = [];
    this.state.dimensions = [];
    this.state.areas = [];
    this.state.selectedAnnotation = null;
    this.state.selectedImageId = null;
    this.state.selectedModelId = null;
    this.imageAssets.clear();
    this.modelAssets.clear();
    this.notify();
  }

  loadProject(data) {
    this.snapshot();
    const base = initialState();
    this.state = {
      ...base,
      ...data,
      display: { ...base.display, ...(data.display || {}) },
    };
    this.notify();
  }

  activeLayer() {
    return this.state.layers.find((l) => l.id === this.state.activeLayerId) || this.state.layers[0];
  }
}
