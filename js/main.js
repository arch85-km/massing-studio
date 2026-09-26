// main.js — application bootstrap: wires the toolbar, status bar, and
// properties panel to the Store, Plan2D and Scene3D modules.

import { Store, nextId, levelGradient } from './state.js';
import { Plan2D } from './canvas2d.js';
import { Scene3D } from './scene3d.js';
import {
  shapePoints, boundsOf, shapeArea, shapePerimeter, shapeBaseZ, mapShapeCoords,
  polygonArea, ringLength, formatArea, formatLength,
} from './geometry.js';
import { booleanShapes } from './booleans.js';
import { buildProjectOBJ, extractProjectJSON, reconstructFromOBJ } from './objio.js';

const store = new Store();

const plan2d = new Plan2D(document.getElementById('canvas2d'), store, {
  onStatus: (s) => updateStatus(s),
});
const scene3d = new Scene3D(document.getElementById('canvas3d'), store, {
  onStatus: (s) => updateStatus(s),
});

// A handle for the browser console (and automated tests) — e.g.
// `massingStudio.store.state.shapes` to inspect the model.
window.massingStudio = { store, plan2d, scene3d };

// ---------------- toolbar: tools ----------------
const toolButtons = document.querySelectorAll('[data-tool]');
function refreshToolButtons() {
  toolButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === store.state.tool));
}
toolButtons.forEach((btn) => btn.addEventListener('click', () => store.setTool(btn.dataset.tool)));
store.onChange(refreshToolButtons);
refreshToolButtons();

// ---------------- toolbar: view mode (2D / split / 3D) ----------------
const workspace = document.getElementById('workspace');
const viewButtons = document.querySelectorAll('[data-view]');
function applyView() {
  workspace.dataset.view = store.state.view;
  viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === store.state.view));
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
    plan2d._resize();
    scene3d._resize();
  });
}
viewButtons.forEach((btn) => btn.addEventListener('click', () => { store.setView(btn.dataset.view); applyView(); }));
store.onChange(applyView);
applyView();

// ---------------- camera presets ----------------
for (const preset of ['top', 'front', 'back', 'left', 'right', 'iso']) {
  document.getElementById(`cam-${preset}`).onclick = () => { scene3d.setView(preset); refreshProjButton(); };
}
document.getElementById('cam-fit').onclick = () => { scene3d.frameAll(); plan2d.zoomToFit(); };
const projButton = document.getElementById('cam-proj');
function refreshProjButton() {
  projButton.textContent = scene3d.isOrtho ? 'Ortho' : 'Persp';
  projButton.classList.toggle('active', scene3d.isOrtho);
}
function toggleProjection() { scene3d.setProjection(!scene3d.isOrtho); refreshProjButton(); }
projButton.onclick = toggleProjection;
refreshProjButton();

// ---------------- undo / redo / new ----------------
document.getElementById('btn-undo').onclick = () => store.undo();
document.getElementById('btn-redo').onclick = () => store.redo();
document.getElementById('btn-new').onclick = () => {
  if (confirm('Start a new drawing? This clears the current model.')) store.clearAll();
};

// ---------------- grid / snap ----------------
const snapToggle = document.getElementById('toggle-snap');
snapToggle.checked = store.state.grid.snap;
snapToggle.onchange = () => store.toggleSnap();
const gridSizeInput = document.getElementById('grid-size');
gridSizeInput.value = store.state.grid.size;
gridSizeInput.onchange = () => {
  store.state.grid.size = Math.max(0.1, parseFloat(gridSizeInput.value) || 1);
  store.notify();
};

// ---------------- save / load project ----------------
// Reference images and imported models live outside the undo-tracked state
// (see state.js), so a save/load round-trip has to carry them alongside it
// explicitly under two reserved keys.
// ---------------- dropdown placement on phones ----------------
// On a phone the second toolbar row scrolls sideways, and a scrolling
// element clips anything absolutely positioned inside it — so a menu opened
// from that row (Save, Import, View) would be cut off at the row's edge.
// There, an open menu is pinned to the viewport just under its button
// instead, and closed again if the row scrolls away underneath it.
const phoneLayout = window.matchMedia('(max-width: 760px)');
function placeMenu(toggle, menu) {
  const pinned = phoneLayout.matches && !!toggle.closest('.toolbar-row-secondary');
  menu.classList.toggle('pinned', pinned);
  if (!pinned) { menu.style.left = ''; menu.style.top = ''; return; }
  const r = toggle.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}
function closeMenus() {
  document.querySelectorAll('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));
  document.querySelectorAll('[aria-haspopup="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
document.querySelector('.toolbar-row-secondary').addEventListener('scroll', closeMenus, { passive: true });
window.addEventListener('resize', () => document.querySelectorAll('.dropdown-menu.pinned.open').forEach((m) => m.classList.remove('open')));

function projectJSON(indent) {
  return JSON.stringify({
    ...store.state,
    __imageAssets: Object.fromEntries(store.imageAssets),
    __modelAssets: Object.fromEntries(store.modelAssets),
  }, null, indent);
}

function applyProject(data) {
  const { __imageAssets, __modelAssets, ...state } = data;
  store.loadProject(state);
  store.imageAssets = new Map(Object.entries(__imageAssets || {}));
  store.modelAssets = new Map(Object.entries(__modelAssets || {}));
  store.notify();
  plan2d.zoomToFit();
  scene3d.frameAll();
}

const saveToggle = document.getElementById('btn-save-toggle');
const saveMenu = document.getElementById('save-menu');
saveToggle.onclick = (e) => {
  e.stopPropagation();
  const isOpen = saveMenu.classList.toggle('open');
  saveToggle.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) placeMenu(saveToggle, saveMenu);
};
saveMenu.addEventListener('click', (e) => e.stopPropagation());

document.getElementById('btn-save').onclick = () => {
  saveMenu.classList.remove('open');
  downloadText(projectJSON(2), 'plan.cadproj.json', 'application/json');
};

// Ordinary OBJ geometry for other programs, with the whole project riding
// along in comment lines so this app can reopen it fully editable (objio.js).
document.getElementById('btn-save-obj').onclick = () => {
  saveMenu.classList.remove('open');
  downloadText(buildProjectOBJ(scene3d.exportOBJ(), projectJSON()), 'model.obj', 'text/plain');
};

// An .obj from another program: straight vertical extrusions become editable
// shapes, one level per distinct base elevation; everything else comes in as
// a static reference model. Replaces the current project, like opening a .json.
function openForeignOBJ(text, fileName) {
  const { prisms, rest } = reconstructFromOBJ(text);
  if (!prisms.length && !rest) {
    alert('No geometry found in that .obj file.');
    return;
  }
  const round = (v) => Math.round(v * 10000) / 10000;
  const elevations = [...new Set(prisms.map((p) => round(p.bottom)))].sort((a, b) => a - b);
  if (!elevations.length) elevations.push(0);
  const groundIndex = Math.max(0, elevations.findIndex((z) => z >= 0));
  const colours = levelGradient(elevations.length);
  const layers = elevations.map((z, i) => {
    const next = elevations[i + 1];
    const heights = prisms.filter((p) => round(p.bottom) === z).map((p) => p.height);
    return {
      id: nextId('layer'),
      name: i < groundIndex ? `Basement ${groundIndex - i}` : i === groundIndex ? 'Ground Floor' : `Floor ${i - groundIndex}`,
      elevation: z,
      defaultHeight: round(next !== undefined ? next - z : Math.max(...heights, 3)),
      visible: true,
      locked: false,
      color: colours[i],
    };
  });
  const shapes = prisms.map((p) => {
    const layer = layers[elevations.indexOf(round(p.bottom))];
    const shape = {
      id: nextId('shape'), type: 'polygon', layerId: layer.id, closed: true,
      points: p.points, height: round(p.height), base: 0, color: layer.color,
    };
    if (p.holes.length) shape.holes = p.holes;
    return shape;
  });
  const modelAssets = {};
  const importedModels = [];
  if (rest) {
    const id = nextId('model');
    modelAssets[id] = rest;
    importedModels.push({ id, name: `${fileName} (not extrusions)`, x: 0, y: 0, z: 0, scale: 1 });
  }
  applyProject({
    layers, activeLayerId: layers[groundIndex].id, shapes, selection: [],
    images: [], importedModels, dimensions: [], areas: [], __modelAssets: modelAssets,
  });
  if (rest && prisms.length) {
    alert(`${prisms.length} straight extrusion${prisms.length === 1 ? '' : 's'} opened as editable shapes. ` +
      'The rest of the file (curved, sloped or irregular geometry) came in as a 3D reference model.');
  } else if (rest) {
    alert('Nothing in that file is a straight vertical extrusion, so it opened as a 3D reference model only.');
  }
}

const loadInput = document.getElementById('load-input');
document.getElementById('btn-load').onclick = () => loadInput.click();
loadInput.onchange = () => {
  const file = loadInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = reader.result;
      if (/\.obj$/i.test(file.name)) {
        const embedded = extractProjectJSON(text);
        if (embedded) applyProject(JSON.parse(embedded));
        else openForeignOBJ(text, file.name);
      } else {
        applyProject(JSON.parse(text));
      }
    } catch (err) {
      alert('Could not open that file: ' + err.message);
    }
  };
  reader.readAsText(file);
  loadInput.value = '';
};

// ---------------- export dropdown ----------------
const exportToggle = document.getElementById('btn-export-toggle');
const exportMenu = document.getElementById('export-menu');
exportToggle.onclick = (e) => {
  e.stopPropagation();
  const isOpen = exportMenu.classList.toggle('open');
  exportToggle.setAttribute('aria-expanded', String(isOpen));
};
exportMenu.addEventListener('click', (e) => e.stopPropagation());

// ---------------- import dropdown ----------------
const importToggle = document.getElementById('btn-import-toggle');
const importMenu = document.getElementById('import-menu');
importToggle.onclick = (e) => {
  e.stopPropagation();
  const isOpen = importMenu.classList.toggle('open');
  importToggle.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) placeMenu(importToggle, importMenu);
};
importMenu.addEventListener('click', (e) => e.stopPropagation());

// ---------------- clipboard dropdown ----------------
const clipboardToggle = document.getElementById('btn-clipboard-toggle');
const clipboardMenu = document.getElementById('clipboard-menu');
clipboardToggle.onclick = (e) => {
  e.stopPropagation();
  const isOpen = clipboardMenu.classList.toggle('open');
  clipboardToggle.setAttribute('aria-expanded', String(isOpen));
};
clipboardMenu.addEventListener('click', (e) => e.stopPropagation());

// ---------------- display ("View") dropdown ----------------
const displayToggle = document.getElementById('btn-display-toggle');
const displayMenu = document.getElementById('display-menu');
displayToggle.onclick = (e) => {
  e.stopPropagation();
  const isOpen = displayMenu.classList.toggle('open');
  displayToggle.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) placeMenu(displayToggle, displayMenu);
};
displayMenu.addEventListener('click', (e) => e.stopPropagation());
const displayChecks = displayMenu.querySelectorAll('[data-display]');
displayChecks.forEach((cb) => {
  cb.onchange = () => store.setDisplay({ [cb.dataset.display]: cb.checked });
});
function refreshDisplayChecks() {
  displayChecks.forEach((cb) => { cb.checked = !!store.state.display[cb.dataset.display]; });
}
store.onChange(refreshDisplayChecks);
refreshDisplayChecks();

const importObjInput = document.getElementById('import-obj-input');
const importDxfInput = document.getElementById('import-dxf-input');
const importImageInput = document.getElementById('import-image-input');

document.getElementById('btn-import-obj').onclick = () => { importMenu.classList.remove('open'); importObjInput.click(); };
document.getElementById('btn-import-dxf').onclick = () => { importMenu.classList.remove('open'); importDxfInput.click(); };
document.getElementById('btn-import-image').onclick = () => { importMenu.classList.remove('open'); importImageInput.click(); };

// .obj import: arbitrary 3D meshes don't fit this app's "2D footprint +
// height" shape model, so an imported model comes in as a static reference
// in the 3D view only — visible for context, not editable or extruded, and
// not included in future .obj exports.
importObjInput.onchange = () => {
  const file = importObjInput.files[0];
  importObjInput.value = '';
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    alert('That .obj file is quite large (over 15MB) — importing it may slow the app down. A simplified/decimated version will work better.');
  }
  const reader = new FileReader();
  reader.onload = () => {
    store.addImportedModel({ id: nextId('model'), name: file.name, x: 0, y: 0, z: 0, scale: 1 }, reader.result);
    if (store.state.view === '2d') { store.setView('split'); applyView(); }
    scene3d.frameAll();
  };
  reader.onerror = () => alert('Could not read that file.');
  reader.readAsText(file);
};

// .dxf import: LINE/CIRCLE/LWPOLYLINE/POLYLINE entities map directly onto
// this app's own shape model, so these come in as fully editable shapes.
importDxfInput.onchange = () => {
  const file = importDxfInput.files[0];
  importDxfInput.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseDXF(reader.result);
      if (!parsed.length) {
        alert('No supported entities found in that DXF (looked for LINE, CIRCLE, LWPOLYLINE, and POLYLINE).');
        return;
      }
      const layer = store.activeLayer();
      const shapes = parsed.map((s) => ({
        id: nextId('shape'),
        layerId: layer.id,
        color: layer.color,
        height: 0,
        ...s,
      }));
      store.addShapes(shapes);
      plan2d.zoomToFit();
    } catch (err) {
      alert('Could not import that DXF file: ' + err.message);
    }
  };
  reader.onerror = () => alert('Could not read that file.');
  reader.readAsText(file);
};

// Image import: a traceable underlay in the 2D plan — draw shapes on top of
// it with the normal tools. Not extruded, not part of any export.
importImageInput.onchange = () => {
  const file = importImageInput.files[0];
  importImageInput.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const probe = new Image();
    probe.onload = () => {
      const aspect = (probe.naturalHeight / probe.naturalWidth) || 1;
      const input = prompt('Real-world width of this image, in meters (height follows its aspect ratio):', '10');
      if (input === null) return;
      const width = Math.max(0.1, parseFloat(input) || 10);
      const height = width * aspect;
      store.addImage({ id: nextId('image'), x: 0, y: 0, width, height, opacity: 0.6 }, dataUrl);
      plan2d.zoomToFit();
    };
    probe.onerror = () => alert('Could not read that image.');
    probe.src = dataUrl;
  };
  reader.onerror = () => alert('Could not read that file.');
  reader.readAsDataURL(file);
};

// Parses the common subset of ASCII DXF — LINE, CIRCLE, LWPOLYLINE, and
// legacy POLYLINE/VERTEX/SEQEND — covering this app's own DXF export as
// well as simple 2D line-art from other CAD software. Returns plain shape
// descriptors (no id/layerId/color yet — the caller fills those in).
function parseDXF(text) {
  const raw = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    pairs.push([parseInt(raw[i].trim(), 10), raw[i + 1].trim()]);
  }
  const shapes = [];
  let i = 0;
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code !== 0) { i++; continue; }

    if (value === 'LINE') {
      let x1, y1, x2, y2;
      i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        if (c === 10) x1 = parseFloat(v);
        else if (c === 20) y1 = parseFloat(v);
        else if (c === 11) x2 = parseFloat(v);
        else if (c === 21) y2 = parseFloat(v);
        i++;
      }
      if ([x1, y1, x2, y2].every(Number.isFinite)) {
        shapes.push({ type: 'line', closed: false, points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] });
      }
      continue;
    }

    if (value === 'CIRCLE') {
      let cx, cy, r;
      i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        if (c === 10) cx = parseFloat(v);
        else if (c === 20) cy = parseFloat(v);
        else if (c === 40) r = parseFloat(v);
        i++;
      }
      if ([cx, cy, r].every(Number.isFinite) && r > 0) {
        shapes.push({ type: 'circle', closed: true, center: { x: cx, y: cy }, radius: r });
      }
      continue;
    }

    if (value === 'LWPOLYLINE') {
      let closed = false;
      const pts = [];
      let curX = null;
      i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        if (c === 70) closed = (parseInt(v, 10) & 1) === 1;
        else if (c === 10) curX = parseFloat(v);
        else if (c === 20 && curX !== null) { pts.push({ x: curX, y: parseFloat(v) }); curX = null; }
        i++;
      }
      if (pts.length >= 2) {
        shapes.push({ type: closed ? 'polygon' : 'line', closed, points: pts });
      }
      continue;
    }

    if (value === 'POLYLINE') {
      let closed = false;
      i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        if (pairs[i][0] === 70) closed = (parseInt(pairs[i][1], 10) & 1) === 1;
        i++;
      }
      const pts = [];
      while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'SEQEND')) {
        if (pairs[i][0] === 0 && pairs[i][1] === 'VERTEX') {
          let vx, vy;
          i++;
          while (i < pairs.length && pairs[i][0] !== 0) {
            if (pairs[i][0] === 10) vx = parseFloat(pairs[i][1]);
            else if (pairs[i][0] === 20) vy = parseFloat(pairs[i][1]);
            i++;
          }
          if (Number.isFinite(vx) && Number.isFinite(vy)) pts.push({ x: vx, y: vy });
        } else {
          i++;
        }
      }
      if (i < pairs.length) i++; // consume SEQEND
      if (pts.length >= 2) {
        shapes.push({ type: closed ? 'polygon' : 'line', closed, points: pts });
      }
      continue;
    }

    i++;
  }
  return shapes;
}

// Closes any open dropdown (export/import menus, color picker, …) on an outside click.
window.addEventListener('click', () => {
  document.querySelectorAll('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));
  exportToggle.setAttribute('aria-expanded', 'false');
  importToggle.setAttribute('aria-expanded', 'false');
  clipboardToggle.setAttribute('aria-expanded', 'false');
  displayToggle.setAttribute('aria-expanded', 'false');
  saveToggle.setAttribute('aria-expanded', 'false');
});

document.getElementById('btn-export-obj').onclick = () => {
  const obj = scene3d.exportOBJ();
  if (!obj) {
    alert('Nothing to export yet — draw a shape and give it a height above 0 first.');
    return;
  }
  downloadText(obj, 'model.obj', 'text/plain');
};

// ---------------- image export dialog ----------------
// The 3D view rendered at up to several times its on-screen size, on a
// transparent, white or dark background — see Scene3D.exportImage.
const exportDialog = document.getElementById('export-dialog');
const expFormat = document.getElementById('exp-format');
const expBg = document.getElementById('exp-bg');
const expSize = document.getElementById('exp-size');
const expWidth = document.getElementById('exp-width');
const expCustomRow = document.getElementById('exp-custom-row');
const expStyle = document.getElementById('exp-style');
const expHideHelpers = document.getElementById('exp-hide-helpers');
const expShadow = document.getElementById('exp-shadow');
const expAnnotations = document.getElementById('exp-annotations');
const expHint = document.getElementById('exp-size-hint');

// The 3D pane's on-screen size, or a sensible 16:10 stand-in when it's hidden (2D-only view).
function exportBaseSize() {
  const r = document.getElementById('canvas3d').getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : { w: 1600, h: 1000 };
}

function exportTargetSize() {
  const base = exportBaseSize();
  let w, h;
  if (expSize.value === 'custom') {
    w = Math.max(200, parseInt(expWidth.value, 10) || 3000);
    h = Math.round((w * base.h) / base.w);
  } else {
    const k = parseInt(expSize.value, 10);
    w = Math.round(base.w * k);
    h = Math.round(base.h * k);
  }
  const max = scene3d.maxExportSize();
  const f = Math.min(1, max / Math.max(w, h));
  return { w: Math.floor(w * f), h: Math.floor(h * f), capped: f < 1 };
}

function refreshExportDialog() {
  expCustomRow.hidden = expSize.value !== 'custom';
  const transparentOpt = expBg.querySelector('option[value="transparent"]');
  transparentOpt.disabled = expFormat.value === 'jpeg';
  if (expFormat.value === 'jpeg' && expBg.value === 'transparent') expBg.value = 'white';
  const { w, h, capped } = exportTargetSize();
  expHint.textContent = `${w} × ${h} px${capped ? ' (limited by this device\'s graphics card)' : ''}`;
}
[expFormat, expBg, expSize, expWidth].forEach((el) => el.addEventListener('input', refreshExportDialog));

document.getElementById('btn-export-image').onclick = () => {
  exportMenu.classList.remove('open');
  if (store.state.view === '2d') { store.setView('split'); applyView(); }
  refreshExportDialog();
  exportDialog.showModal();
};
document.getElementById('exp-cancel').onclick = () => exportDialog.close();
document.getElementById('export-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { w, h } = exportTargetSize();
  const format = expFormat.value;
  try {
    const { dataUrl } = scene3d.exportImage({
      format,
      background: expBg.value,
      width: w,
      height: h,
      translucent: expStyle.value === 'translucent',
      hideHelpers: expHideHelpers.checked,
      shadow: expShadow.checked,
      annotations: expAnnotations.checked,
    });
    // A Blob rather than the data URL itself: a print-size image makes a
    // data URL tens of MB long, which some browsers refuse to download.
    downloadBlob(dataUrlToBlob(dataUrl), `model-${w}x${h}.${format === 'jpeg' ? 'jpg' : 'png'}`);
    exportDialog.close();
  } catch (err) {
    alert('Could not export the image: ' + err.message);
  }
});

document.getElementById('btn-export-dxf').onclick = () => {
  if (!store.state.shapes.length) {
    alert('Nothing to export yet — draw a shape first.');
    return;
  }
  const dxf = scene3d.exportDXF();
  downloadText(dxf, 'plan.dxf', 'application/dxf');
};

document.getElementById('btn-export-stl').onclick = () => {
  const stl = scene3d.exportSTL();
  if (!stl) {
    alert('Nothing to export yet — draw a shape and give it a height above 0 first.');
    return;
  }
  downloadBlob(new Blob([stl], { type: 'model/stl' }), 'model.stl');
};

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function dataUrlToBlob(dataUrl) {
  const [head, data] = dataUrl.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// ---------------- properties panel ----------------
// Three rows of eight: cool accents, the warm oranges → straws of a
// massing diagram (as in "Colour levels as gradient"), and neutrals.
const SWATCH_COLORS = [
  '#4fa3ff', '#2f6fd6', '#57d38c', '#2e9e6a', '#c98bff', '#8a5cf6', '#ff6b6b', '#e0457b',
  '#c8612f', '#e8854a', '#f2a65a', '#f6c46a', '#f4d35e', '#f5da86', '#f0e6a8', '#ece9c4',
  '#ffffff', '#e6e2da', '#c9c3b8', '#a8b3c0', '#93a1b3', '#6b7686', '#454d59', '#23282f',
];

// A CSS-positioned dropdown instead of a native <input type="color"> —
// the native color picker's popup placement is decided by the browser and
// isn't something CSS/JS can reliably control, so it can open upward and
// clip against the top of the window. This one is anchored to the swatch
// button with `.dropdown-menu`'s own positioning, so it always renders in
// the same predictable spot below-and-left of the button. The native picker
// is still offered inside it, as "More…", for any colour off the palette.
function buildColorRow(current, onPick, labelText = 'Color') {
  const row = document.createElement('div');
  row.className = 'props-row';

  const label = document.createElement('span');
  label.textContent = labelText;
  row.appendChild(label);

  const dropdown = document.createElement('div');
  dropdown.className = 'dropdown';

  const swatchBtn = document.createElement('button');
  swatchBtn.type = 'button';
  swatchBtn.className = 'color-swatch-btn';
  swatchBtn.style.background = current || 'transparent';
  swatchBtn.title = current || 'mixed';
  swatchBtn.setAttribute('aria-haspopup', 'true');
  swatchBtn.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'dropdown-menu color-menu';
  menu.setAttribute('role', 'menu');

  const grid = document.createElement('div');
  grid.className = 'swatch-grid';
  SWATCH_COLORS.forEach((c) => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'swatch-option' + (current && c.toLowerCase() === current.toLowerCase() ? ' active' : '');
    opt.style.background = c;
    opt.title = c;
    opt.onclick = () => {
      onPick(c);
      menu.classList.remove('open');
    };
    grid.appendChild(opt);
  });
  menu.appendChild(grid);

  const hexRow = document.createElement('div');
  hexRow.className = 'hex-row';
  const hexLabel = document.createElement('label');
  hexLabel.textContent = 'Hex';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'hex-input';
  hexInput.value = current || '';
  hexInput.maxLength = 7;
  hexInput.placeholder = '#rrggbb';
  hexInput.onclick = (e) => e.stopPropagation();
  hexInput.onchange = () => {
    let v = hexInput.value.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      onPick(v.toLowerCase());
    } else {
      hexInput.value = current || '';
    }
  };
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.title = 'More colours…';
  picker.value = /^#[0-9a-fA-F]{6}$/.test(current || '') ? current : '#ffffff';
  picker.onchange = () => onPick(picker.value);
  hexRow.appendChild(hexLabel);
  hexRow.appendChild(hexInput);
  hexRow.appendChild(picker);
  menu.appendChild(hexRow);

  swatchBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.toggle('open');
    swatchBtn.setAttribute('aria-expanded', String(isOpen));
  };
  menu.addEventListener('click', (e) => e.stopPropagation());

  dropdown.appendChild(swatchBtn);
  dropdown.appendChild(menu);
  row.appendChild(dropdown);
  return row;
}

// Opacity as a 10–100 % slider; history is taken once per drag (on change),
// with live preview while dragging.
function buildOpacityRow(current, onPreview, onCommit) {
  const row = document.createElement('label');
  row.className = 'props-row';
  const label = document.createElement('span');
  label.textContent = 'Opacity';
  const wrap = document.createElement('span');
  wrap.className = 'range-wrap';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '10';
  range.max = '100';
  range.step = '5';
  range.value = String(Math.round((current ?? 1) * 100));
  const out = document.createElement('output');
  out.textContent = `${range.value}%`;
  range.oninput = () => { out.textContent = `${range.value}%`; onPreview(parseInt(range.value, 10) / 100); };
  range.onchange = () => onCommit(parseInt(range.value, 10) / 100);
  wrap.appendChild(range);
  wrap.appendChild(out);
  row.appendChild(label);
  row.appendChild(wrap);
  return row;
}

function numberRow(labelText, value, { step = '0.1', min = null, onChange }) {
  const row = document.createElement('label');
  row.className = 'props-row';
  row.innerHTML = `<span>${labelText}</span>`;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = step;
  if (min !== null) input.min = String(min);
  input.value = String(Math.round(value * 1000) / 1000);
  input.onchange = () => onChange(parseFloat(input.value));
  row.appendChild(input);
  return row;
}

function infoRow(labelText, value) {
  const row = document.createElement('div');
  row.className = 'props-row info';
  row.innerHTML = `<span>${labelText}</span><b></b>`;
  row.querySelector('b').textContent = value;
  return row;
}

function sectionTitle(text) {
  const el = document.createElement('div');
  el.className = 'props-section';
  el.textContent = text;
  return el;
}

function hint(text) {
  const el = document.createElement('div');
  el.className = 'panel-hint';
  el.textContent = text;
  return el;
}

function button(text, cls, onClick, title = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`;
  b.textContent = text;
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

// Live opacity preview without an undo step per slider tick.
function previewShapes(ids, patch) {
  const set = new Set(ids);
  for (const s of store.state.shapes) if (set.has(s.id)) Object.assign(s, patch);
  scene3d.rebuild();
  plan2d.render();
}

function layerOf(shape) {
  return store.state.layers.find((l) => l.id === shape.layerId);
}

// Put a copy of the shape's footprint directly on top of it. If a level
// starts exactly at that height, the copy goes onto that level (taking its
// colour); otherwise it stays on this level, lifted by a base offset.
function stackCopyOnTop(shape) {
  const layer = layerOf(shape);
  const top = shapeBaseZ(shape, layer) + (shape.height || 0);
  const target = store.state.layers.find((l) => l.id !== shape.layerId && Math.abs(l.elevation - top) < 1e-3);
  const copy = JSON.parse(JSON.stringify(shape));
  copy.id = nextId('shape');
  if (target) {
    copy.layerId = target.id;
    copy.base = 0;
    copy.color = target.color;
  } else {
    copy.base = Math.round(((shape.base ?? 0) + (shape.height || 0)) * 1000) / 1000;
  }
  store.addShape(copy);
  store.setSelection([copy.id]);
}

function runBoolean(op, a, b, keep) {
  let result;
  try {
    result = booleanShapes(op, a, b, store.state.layers, () => nextId('shape'));
  } catch (err) {
    alert('That boolean operation failed: ' + err.message);
    return;
  }
  if (!result.length && op === 'intersect') {
    alert('These two volumes don\'t overlap — there is nothing to intersect.');
    return;
  }
  const remove = keep ? [] : [a.id, b.id];
  store.replaceShapes(remove, result);
}

function renderAnnotationProps(ann) {
  propsPanel.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = `<span>${ann.kind === 'dimension' ? 'Dimension' : 'Measured area'}</span>`;
  propsPanel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'props-body';
  if (ann.kind === 'dimension') {
    const d = store.state.dimensions.find((x) => x.id === ann.id);
    if (!d) return;
    const dx = d.b.x - d.a.x, dy = d.b.y - d.a.y, dz = (d.b.z ?? 0) - (d.a.z ?? 0);
    body.appendChild(infoRow('Length', formatLength(Math.hypot(dx, dy, dz))));
    body.appendChild(infoRow('In plan', formatLength(Math.hypot(dx, dy))));
    if (Math.abs(dz) > 1e-6) body.appendChild(infoRow('Height difference', formatLength(Math.abs(dz))));
  } else {
    const a = store.state.areas.find((x) => x.id === ann.id);
    if (!a) return;
    body.appendChild(infoRow('Area', formatArea(Math.abs(polygonArea(a.points)))));
    body.appendChild(infoRow('Perimeter', formatLength(ringLength(a.points, true))));
  }
  body.appendChild(button('Delete', 'danger full', () => store.removeAnnotation(ann.kind, ann.id)));
  propsPanel.appendChild(body);
}

function renderMultiProps(shapes) {
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = `<span>${shapes.length} shapes selected</span>`;
  propsPanel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'props-body';
  const ids = shapes.map((s) => s.id);

  const closed = shapes.filter((s) => s.closed);
  body.appendChild(infoRow('Total footprint', formatArea(closed.reduce((t, s) => t + shapeArea(s), 0))));
  body.appendChild(infoRow('Total volume', `${closed.reduce((t, s) => t + shapeArea(s) * (s.height || 0), 0).toFixed(2)} m³`));

  const colours = new Set(shapes.map((s) => s.color.toLowerCase()));
  body.appendChild(buildColorRow(colours.size === 1 ? shapes[0].color : null, (c) => {
    store.updateShapes(Object.fromEntries(ids.map((id) => [id, { color: c }])));
  }));
  body.appendChild(buildOpacityRow(shapes[0].opacity ?? 1,
    (o) => previewShapes(ids, { opacity: o }),
    (o) => store.updateShapes(Object.fromEntries(ids.map((id) => [id, { opacity: o }])))));

  const solids = shapes.filter((s) => s.closed && s.height > 0);
  if (shapes.length === 2 && solids.length === 2) {
    body.appendChild(sectionTitle('Boolean'));
    const [a, b] = shapes; // A = first selected, B = second
    const keepRow = document.createElement('label');
    keepRow.className = 'chk';
    keepRow.innerHTML = '<input type="checkbox" /> Keep originals';
    const keep = keepRow.querySelector('input');
    const ops = document.createElement('div');
    ops.className = 'btn-row';
    ops.appendChild(button('Intersect', 'small', () => runBoolean('intersect', a, b, keep.checked), 'Keep only the volume the two share'));
    ops.appendChild(button('Union', 'small', () => runBoolean('union', a, b, keep.checked), 'Merge both into one'));
    ops.appendChild(button('Subtract', 'small', () => runBoolean('subtract', a, b, keep.checked), 'Cut the second-selected volume out of the first'));
    body.appendChild(ops);
    body.appendChild(keepRow);
    body.appendChild(hint('Subtract removes the second shape you selected from the first. Results keep the first shape\'s level and colour.'));
  } else if (shapes.length === 2) {
    body.appendChild(hint('Booleans (Intersect / Union / Subtract) need two extruded, closed shapes.'));
  }

  body.appendChild(button('Delete shapes', 'danger full', () => store.removeShapes(ids)));
  propsPanel.appendChild(body);
}

// Properties for a selected reference image: width (drives height via its
// original aspect ratio) and opacity. Position is set by dragging it in the
// plan view, same as a shape.
function renderImageProps(image) {
  propsPanel.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = '<span>Reference Image</span>';
  propsPanel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'props-body';
  const aspect = image.height / image.width;

  const widthRow = document.createElement('label');
  widthRow.className = 'props-row';
  widthRow.innerHTML = '<span>Width (m)</span>';
  const widthInput = document.createElement('input');
  widthInput.type = 'number';
  widthInput.step = '0.1';
  widthInput.min = '0.1';
  widthInput.value = image.width.toFixed(2);
  widthInput.onchange = () => {
    const w = Math.max(0.1, parseFloat(widthInput.value) || image.width);
    store.updateImage(image.id, { width: w, height: w * aspect });
  };
  widthRow.appendChild(widthInput);
  body.appendChild(widthRow);

  const opacityRow = document.createElement('label');
  opacityRow.className = 'props-row';
  opacityRow.innerHTML = '<span>Opacity</span>';
  const opacityInput = document.createElement('input');
  opacityInput.type = 'number';
  opacityInput.step = '0.05';
  opacityInput.min = '0.05';
  opacityInput.max = '1';
  opacityInput.value = image.opacity;
  opacityInput.onchange = () => {
    const o = Math.min(1, Math.max(0.05, parseFloat(opacityInput.value) || image.opacity));
    store.updateImage(image.id, { opacity: o });
  };
  opacityRow.appendChild(opacityInput);
  body.appendChild(opacityRow);

  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  hint.textContent = 'Reference image — drag it in the plan view to move it. Not extruded and not included in any export.';
  body.appendChild(hint);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger full';
  delBtn.textContent = 'Delete image';
  delBtn.onclick = () => store.removeImage(image.id);
  body.appendChild(delBtn);

  propsPanel.appendChild(body);
}

// Properties for a selected imported reference model: position (X/Y/Z, in
// meters — Y is elevation, matching the floor/layer convention) and a
// uniform scale factor, since an .obj's own coordinates and units are
// whatever its source authored them in and rarely land where you want them.
function renderModelProps(model) {
  propsPanel.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = '<span>Reference Model</span>';
  propsPanel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'props-body';

  const nameRow = document.createElement('div');
  nameRow.className = 'props-row';
  nameRow.innerHTML = `<span>File</span><b title="${model.name}">${model.name}</b>`;
  body.appendChild(nameRow);

  const axisField = (label, axis) => {
    const row = document.createElement('label');
    row.className = 'props-row';
    row.innerHTML = `<span>Position ${label} (m)</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.value = model[axis];
    input.onchange = () => store.updateImportedModel(model.id, { [axis]: parseFloat(input.value) || 0 });
    row.appendChild(input);
    return row;
  };
  body.appendChild(axisField('X', 'x'));
  body.appendChild(axisField('Y — elevation', 'y'));
  body.appendChild(axisField('Z', 'z'));

  const scaleRow = document.createElement('label');
  scaleRow.className = 'props-row';
  scaleRow.innerHTML = '<span>Scale</span>';
  const scaleInput = document.createElement('input');
  scaleInput.type = 'number';
  scaleInput.step = '0.1';
  scaleInput.min = '0.01';
  scaleInput.value = model.scale;
  scaleInput.onchange = () => {
    const s = Math.max(0.01, parseFloat(scaleInput.value) || model.scale);
    store.updateImportedModel(model.id, { scale: s });
  };
  scaleRow.appendChild(scaleInput);
  body.appendChild(scaleRow);

  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  hint.textContent = '3D reference only — shown for context in the 3D view, not editable geometry and not included in any export.';
  body.appendChild(hint);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger full';
  delBtn.textContent = 'Delete model';
  delBtn.onclick = () => store.removeImportedModel(model.id);
  body.appendChild(delBtn);

  propsPanel.appendChild(body);
}

const propsPanel = document.getElementById('properties-panel');
function renderProps() {
  const image = store.state.images.find((im) => im.id === store.state.selectedImageId);
  if (image) { renderImageProps(image); return; }

  const model = store.state.importedModels.find((m) => m.id === store.state.selectedModelId);
  if (model) { renderModelProps(model); return; }

  if (store.state.selectedAnnotation) { renderAnnotationProps(store.state.selectedAnnotation); return; }

  // In the order they were selected — Subtract takes the second one away from the first.
  const selected = store.state.selection
    .map((id) => store.state.shapes.find((s) => s.id === id))
    .filter(Boolean);
  propsPanel.innerHTML = '';
  if (selected.length > 1) { renderMultiProps(selected); return; }
  const shape = selected[0];
  if (!shape) {
    propsPanel.innerHTML = '<div class="panel-header"><span>Properties</span></div><div class="panel-empty">Select a shape to edit it. Shift+click to select two for Intersect / Union / Subtract.</div>';
    return;
  }
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = `<span>Properties</span>`;
  propsPanel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'props-body';

  const typeRow = document.createElement('div');
  typeRow.className = 'props-row';
  typeRow.innerHTML = `<span>Type</span><b>${shape.type === 'spline' ? 'curve' : shape.type}</b>`;
  body.appendChild(typeRow);

  // Level
  const levelRow = document.createElement('label');
  levelRow.className = 'props-row';
  levelRow.innerHTML = '<span>Level</span>';
  const levelSelect = document.createElement('select');
  for (const l of store.state.layers) {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = `${l.name} (+${l.elevation.toFixed(2)})`;
    opt.selected = l.id === shape.layerId;
    levelSelect.appendChild(opt);
  }
  levelSelect.onchange = () => store.moveShapesToLayer([shape.id], levelSelect.value);
  levelRow.appendChild(levelSelect);
  body.appendChild(levelRow);

  body.appendChild(buildColorRow(shape.color, (c) => store.updateShape(shape.id, { color: c })));
  if (shape.closed) {
    body.appendChild(buildOpacityRow(shape.opacity ?? 1,
      (o) => previewShapes([shape.id], { opacity: o }),
      (o) => store.updateShape(shape.id, { opacity: o })));
  }

  if (shape.type === 'spline') {
    const closedRow = document.createElement('label');
    closedRow.className = 'props-row';
    closedRow.innerHTML = '<span>Closed curve</span>';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!shape.closed;
    cb.onchange = () => store.updateShape(shape.id, { closed: cb.checked, height: cb.checked ? (shape.height || layerOf(shape)?.defaultHeight || 3) : 0 });
    closedRow.appendChild(cb);
    body.appendChild(closedRow);
  }

  if (shape.closed) {
    body.appendChild(numberRow('Extrude height (m)', shape.height, {
      min: 0, onChange: (v) => store.updateShape(shape.id, { height: Math.max(0, v || 0) }),
    }));
    body.appendChild(numberRow('Base offset (m)', shape.base ?? 0, {
      onChange: (v) => store.updateShape(shape.id, { base: Number.isFinite(v) ? v : 0 }),
    }));

    // Measurements
    body.appendChild(sectionTitle('Measurements'));
    const b = boundsOf(shapePoints(shape));
    const area = shapeArea(shape);
    body.appendChild(infoRow('Width × depth', `${(b.maxX - b.minX).toFixed(2)} × ${(b.maxY - b.minY).toFixed(2)} m`));
    body.appendChild(infoRow('Footprint area', formatArea(area)));
    body.appendChild(infoRow('Perimeter', formatLength(shapePerimeter(shape))));
    if (shape.height > 0) {
      body.appendChild(infoRow('Volume', `${(area * shape.height).toFixed(2)} m³`));
      const bottom = shapeBaseZ(shape, layerOf(shape));
      body.appendChild(infoRow('Bottom / top', `+${bottom.toFixed(2)} / +${(bottom + shape.height).toFixed(2)} m`));
    }

    if (shape.height > 0) {
      body.appendChild(button('Stack copy on top', 'full', () => stackCopyOnTop(shape),
        'Duplicate this footprint directly on top of it — onto the level at that height if there is one'));
    }
    body.appendChild(hint(shape.height > 0
      ? 'Extruded — included in .obj / .stl export. Alt+drag it in the 3D view to lift it.'
      : 'Height is 0 — shown as a flat footprint only. Set a height, or use the Push/Pull tool in the 3D view.'));
  } else {
    body.appendChild(infoRow('Length', formatLength(shapePerimeter(shape))));
    body.appendChild(hint('Open lines and curves are reference geometry and are not extruded or exported as solids.'));
  }

  body.appendChild(button('Delete shape', 'danger full', () => store.removeShapes([shape.id])));
  propsPanel.appendChild(body);
}
store.onChange(renderProps);
renderProps();

// ---------------- imported reference models panel ----------------
const importedPanel = document.getElementById('imported-panel');
function renderImportedModels() {
  const models = store.state.importedModels;
  importedPanel.innerHTML = '';
  if (!models.length) {
    importedPanel.style.display = 'none';
    return;
  }
  importedPanel.style.display = '';

  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = '<span>Reference Models</span>';
  importedPanel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'imported-list';
  models.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'imported-row' + (store.state.selectedModelId === m.id ? ' active' : '');
    row.title = 'Click to move, resize, or delete this model';
    row.onclick = () => store.setSelectedModel(m.id);
    const name = document.createElement('span');
    name.className = 'imported-name';
    name.textContent = m.name;
    name.title = m.name;
    const del = document.createElement('button');
    del.className = 'icon-btn small danger';
    del.textContent = '✕';
    del.title = 'Remove';
    del.onclick = (e) => { e.stopPropagation(); store.removeImportedModel(m.id); };
    row.appendChild(name);
    row.appendChild(del);
    list.appendChild(row);
  });
  importedPanel.appendChild(list);

  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  hint.textContent = '3D reference only — shown for context in the 3D view, not editable and not included in exports.';
  importedPanel.appendChild(hint);
}
store.onChange(renderImportedModels);
renderImportedModels();

// ---------------- levels panel ----------------
// Levels (floors) stack volumes vertically: every shape sits on its level's
// elevation (plus its own base offset). New shapes go on the active level.
const levelsPanel = document.getElementById('levels-panel');
function renderLevels() {
  const { layers, shapes, activeLayerId } = store.state;
  levelsPanel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = '<span>Levels</span>';
  const add = document.createElement('button');
  add.className = 'btn small';
  add.textContent = '+ Add level';
  add.title = 'Add a level on top of the highest one';
  add.onclick = () => store.addLayer();
  header.appendChild(add);
  levelsPanel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'levels-list';
  // Highest level at the top of the list, like a section through the building.
  [...layers].sort((a, b) => b.elevation - a.elevation).forEach((layer) => {
    const row = document.createElement('div');
    row.className = 'level-row' + (layer.id === activeLayerId ? ' active' : '');
    row.onclick = () => { if (layer.id !== store.state.activeLayerId) store.setActiveLayer(layer.id); };

    const top = document.createElement('div');
    top.className = 'level-top';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'active-level';
    radio.checked = layer.id === activeLayerId;
    radio.title = 'Draw on this level';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'level-name';
    name.value = layer.name;
    name.onclick = (e) => e.stopPropagation();
    name.onchange = () => store.updateLayer(layer.id, { name: name.value.trim() || layer.name });
    const colour = document.createElement('input');
    colour.type = 'color';
    colour.value = layer.color;
    colour.title = 'Level colour (for new shapes on this level)';
    colour.onclick = (e) => e.stopPropagation();
    colour.onchange = () => store.updateLayer(layer.id, { color: colour.value });
    const eye = document.createElement('button');
    eye.className = 'icon-btn small' + (layer.visible ? '' : ' off');
    eye.textContent = layer.visible ? '👁' : '—';
    eye.title = layer.visible ? 'Hide level' : 'Show level';
    eye.onclick = (e) => { e.stopPropagation(); store.updateLayer(layer.id, { visible: !layer.visible }); };
    const lock = document.createElement('button');
    lock.className = 'icon-btn small' + (layer.locked ? ' on' : '');
    lock.textContent = layer.locked ? '🔒' : '🔓';
    lock.title = layer.locked ? 'Unlock level' : 'Lock level (shapes can\'t be selected)';
    lock.onclick = (e) => { e.stopPropagation(); store.updateLayer(layer.id, { locked: !layer.locked }); };
    const del = document.createElement('button');
    del.className = 'icon-btn small danger';
    del.textContent = '✕';
    del.title = 'Delete level and its shapes';
    del.disabled = layers.length <= 1;
    del.onclick = (e) => {
      e.stopPropagation();
      const n = shapes.filter((sh) => sh.layerId === layer.id).length;
      if (n && !confirm(`Delete "${layer.name}" and its ${n} shape${n === 1 ? '' : 's'}?`)) return;
      store.removeLayer(layer.id);
    };
    top.append(radio, name, colour, eye, lock, del);

    const bottom = document.createElement('div');
    bottom.className = 'level-bottom';
    const field = (label, value, key, min) => {
      const wrap = document.createElement('label');
      wrap.innerHTML = `<span>${label}</span>`;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      if (min !== undefined) input.min = String(min);
      input.value = String(value);
      input.onclick = (e) => e.stopPropagation();
      input.onchange = () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) store.updateLayer(layer.id, { [key]: min !== undefined ? Math.max(min, v) : v });
      };
      wrap.appendChild(input);
      return wrap;
    };
    const area = shapes.filter((sh) => sh.layerId === layer.id && sh.closed && sh.height > 0)
      .reduce((t, sh) => t + shapeArea(sh), 0);
    const areaEl = document.createElement('span');
    areaEl.className = 'level-area';
    areaEl.textContent = formatArea(area);
    areaEl.title = 'Footprint area of the extruded shapes on this level';
    bottom.append(field('Elev', layer.elevation, 'elevation'), field('H', layer.defaultHeight, 'defaultHeight', 0.1), areaEl);

    row.append(top, bottom);
    list.appendChild(row);
  });
  levelsPanel.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'btn-row';
  actions.appendChild(button('Colour as gradient', 'small', () => store.colourLevelsAsGradient(),
    'Colour every level (and its shapes) from warm orange at the bottom to pale straw at the top'));
  actions.appendChild(button('Restack', 'small', () => store.restackLevels(),
    'Set each level\'s elevation to sit exactly on top of the one below (using each level\'s height)'));
  levelsPanel.appendChild(actions);
  levelsPanel.appendChild(hint('New shapes go on the active level. "Elev" is the floor elevation, "H" the default height for new shapes. Use Front / Back / Left / Right in the 3D view for elevations.'));
}
store.onChange(renderLevels);
renderLevels();

// The plan label names the level you're drawing on.
const planLabel = document.getElementById('plan-label');
function renderPlanLabel() {
  const l = store.activeLayer();
  planLabel.textContent = `PLAN VIEW — ${l.name.toUpperCase()} (+${l.elevation.toFixed(2)} m)`;
}
store.onChange(renderPlanLabel);
renderPlanLabel();

// ---------------- status bar ----------------
const statusCoords = document.getElementById('status-coords');
const statusTool = document.getElementById('status-tool');
const statusCount = document.getElementById('status-count');
const TOOL_LABELS = {
  select: 'Select / Move / Scale (Shift = add, drag = box select)', line: 'Line (reference)', rect: 'Rectangle',
  circle: 'Circle', polygon: 'Polygon', spline: 'Curve (Enter / double-click to close)',
  pushpull: 'Push / Pull (drag a roof to extrude)',
  dimension: 'Dimension (click two points, then place)', area: 'Area (click corners, Enter to close)',
};
function updateStatus(s = {}) {
  if (s.cursor) statusCoords.textContent = `x ${s.cursor.x.toFixed(2)}m, y ${s.cursor.y.toFixed(2)}m`;
  if (s.measure) statusCoords.textContent += ` · ${s.measure}`;
  statusTool.textContent = TOOL_LABELS[store.state.tool] || store.state.tool;
  if (s.pushPullHeight !== undefined) {
    statusCoords.textContent = `height ${s.pushPullHeight.toFixed(2)}m`;
  }
  if (s.projection) refreshProjButton();
}
function renderCounts() {
  const closedCount = store.state.shapes.filter((s) => s.closed).length;
  let text = `${store.state.shapes.length} shape${store.state.shapes.length === 1 ? '' : 's'} (${closedCount} extrudable)`;
  if (store.state.images.length) {
    text += ` · ${store.state.images.length} image${store.state.images.length === 1 ? '' : 's'}`;
  }
  if (store.state.importedModels.length) {
    text += ` · ${store.state.importedModels.length} model${store.state.importedModels.length === 1 ? '' : 's'}`;
  }
  // Gross floor area: the footprint of every visible extruded volume.
  const visible = new Set(store.state.layers.filter((l) => l.visible).map((l) => l.id));
  const gfa = store.state.shapes
    .filter((sh) => sh.closed && sh.height > 0 && visible.has(sh.layerId))
    .reduce((t, sh) => t + shapeArea(sh), 0);
  if (gfa > 0) text += ` · GFA ${formatArea(gfa)}`;
  statusCount.textContent = text;
  updateStatus();
}
store.onChange(renderCounts);
renderCounts();

// ---------------- keyboard shortcuts ----------------
// ---------------- copy / cut / paste ----------------
// Kept as local module state rather than in `store.state` — like
// imageAssets/modelAssets, a clipboard can hold a large asset payload
// (image data URL, .obj text) that has no business being duplicated into
// every undo snapshot.
let clipboard = null; // { kind: 'shapes'|'image'|'model', ...payload, pasteCount }
const PASTE_OFFSET = 0.5; // meters — so repeated pastes fan out visibly

function hasClipboardSource() {
  const s = store.state;
  return s.selection.length > 0 || !!s.selectedImageId || !!s.selectedModelId;
}

function copySelection() {
  const s = store.state;
  if (s.selection.length) {
    const shapes = s.shapes.filter((sh) => s.selection.includes(sh.id));
    if (!shapes.length) return;
    clipboard = { kind: 'shapes', shapes: JSON.parse(JSON.stringify(shapes)), pasteCount: 0 };
  } else if (s.selectedImageId) {
    const img = s.images.find((im) => im.id === s.selectedImageId);
    if (!img) return;
    clipboard = { kind: 'image', image: { ...img }, dataUrl: store.imageAssets.get(img.id), pasteCount: 0 };
  } else if (s.selectedModelId) {
    const model = s.importedModels.find((m) => m.id === s.selectedModelId);
    if (!model) return;
    clipboard = { kind: 'model', model: { ...model }, objText: store.modelAssets.get(model.id), pasteCount: 0 };
  } else {
    return;
  }
  refreshClipboardButtons();
}

function cutSelection() {
  if (!hasClipboardSource()) return;
  copySelection();
  plan2d._deleteSelection();
}

function pasteClipboard() {
  if (!clipboard) return;
  const off = PASTE_OFFSET * ++clipboard.pasteCount;
  if (clipboard.kind === 'shapes') {
    const pasted = clipboard.shapes.map((sh) => {
      const clone = JSON.parse(JSON.stringify(sh));
      clone.id = nextId('shape');
      Object.assign(clone, mapShapeCoords(clone, (p) => ({ x: p.x + off, y: p.y + off })));
      return clone;
    });
    store.addShapes(pasted);
    store.setSelection(pasted.map((sh) => sh.id));
  } else if (clipboard.kind === 'image') {
    const img = clipboard.image;
    store.addImage({ ...img, id: nextId('image'), x: img.x + off, y: img.y + off }, clipboard.dataUrl);
  } else if (clipboard.kind === 'model') {
    const model = clipboard.model;
    const newId = nextId('model');
    store.addImportedModel({ ...model, id: newId, x: model.x + off, z: model.z + off }, clipboard.objText);
    store.setSelectedModel(newId); // addImportedModel doesn't auto-select, unlike addImage
  }
  refreshClipboardButtons();
}

const btnCopy = document.getElementById('btn-copy');
const btnCut = document.getElementById('btn-cut');
const btnPaste = document.getElementById('btn-paste');
function refreshClipboardButtons() {
  btnCopy.disabled = !hasClipboardSource();
  btnCut.disabled = !hasClipboardSource();
  btnPaste.disabled = !clipboard;
}
store.onChange(refreshClipboardButtons);
refreshClipboardButtons();

btnCopy.onclick = copySelection;
btnCut.onclick = cutSelection;
btnPaste.onclick = pasteClipboard;

// ---------------- keyboard shortcuts ----------------
const TOOL_KEYS = {
  v: 'select', l: 'line', r: 'rect', c: 'circle', p: 'polygon', s: 'spline', e: 'pushpull',
  d: 'dimension', a: 'area',
};
window.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  if (typing || exportDialog.open) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSelection(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === 'f') { scene3d.frameAll(); plan2d.zoomToFit(); return; }
  if (e.key.toLowerCase() === 'o') { toggleProjection(); return; }
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  if (tool) store.setTool(tool);
});
