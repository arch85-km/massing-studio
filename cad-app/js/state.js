// state.js — central application state, mutation helpers, and undo/redo history.
// Nothing here touches the DOM or Three.js; canvas2d.js / scene3d.js / layers-ui.js
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

function initialState() {
  const groundFloor = defaultLayer('Ground Floor', 0, 3, LAYER_PALETTE[0]);
  return {
    layers: [groundFloor],
    activeLayerId: groundFloor.id,
    shapes: [],
    selection: [],
    images: [],           // { id, x, y, width, height, opacity } — pixel data lives in store.imageAssets
    importedModels: [],   // { id, name } — raw .obj text lives in store.modelAssets
    selectedImageId: null,
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
    const layer = defaultLayer(`Floor ${this.state.layers.length + 1}`, maxTop, 3, color);
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

  setSelection(ids) {
    this.state.selection = ids;
    this.state.selectedImageId = null;
    this.notify();
  }

  setTool(tool) {
    this.state.tool = tool;
    this.state.selection = [];
    this.state.selectedImageId = null;
    this.notify();
  }

  // ---- reference images (2D plan underlay) ----
  addImage(image, dataUrl) {
    this.snapshot();
    this.imageAssets.set(image.id, dataUrl);
    this.state.images.push(image);
    this.state.selectedImageId = image.id;
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
    this.state.selectedImageId = imageId;
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

  removeImportedModel(modelId) {
    this.snapshot();
    this.state.importedModels = this.state.importedModels.filter((m) => m.id !== modelId);
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
    this.state.selectedImageId = null;
    this.imageAssets.clear();
    this.modelAssets.clear();
    this.notify();
  }

  loadProject(data) {
    this.snapshot();
    this.state = {
      ...initialState(),
      ...data,
    };
    this.notify();
  }

  activeLayer() {
    return this.state.layers.find((l) => l.id === this.state.activeLayerId) || this.state.layers[0];
  }
}
