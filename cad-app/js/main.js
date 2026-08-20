// main.js — application bootstrap: wires the toolbar, status bar, and
// properties panel to the Store, Plan2D and Scene3D modules.

import { Store, nextId } from './state.js';
import { Plan2D } from './canvas2d.js';
import { Scene3D } from './scene3d.js';

const store = new Store();

const plan2d = new Plan2D(document.getElementById('canvas2d'), store, {
  onStatus: (s) => updateStatus(s),
});
const scene3d = new Scene3D(document.getElementById('canvas3d'), store, {
  onStatus: (s) => updateStatus(s),
});

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
document.getElementById('cam-top').onclick = () => scene3d.setView('top');
document.getElementById('cam-front').onclick = () => scene3d.setView('front');
document.getElementById('cam-iso').onclick = () => scene3d.setView('iso');
document.getElementById('cam-fit').onclick = () => { scene3d.frameAll(); plan2d.zoomToFit(); };

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
document.getElementById('btn-save').onclick = () => {
  const data = {
    ...store.state,
    __imageAssets: Object.fromEntries(store.imageAssets),
    __modelAssets: Object.fromEntries(store.modelAssets),
  };
  downloadText(JSON.stringify(data, null, 2), 'plan.cadproj.json', 'application/json');
};
const loadInput = document.getElementById('load-input');
document.getElementById('btn-load').onclick = () => loadInput.click();
loadInput.onchange = () => {
  const file = loadInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { __imageAssets, __modelAssets, ...state } = JSON.parse(reader.result);
      store.loadProject(state);
      store.imageAssets = new Map(Object.entries(__imageAssets || {}));
      store.modelAssets = new Map(Object.entries(__modelAssets || {}));
      store.notify();
      plan2d.zoomToFit();
      scene3d.frameAll();
    } catch (err) {
      alert('Could not read that project file: ' + err.message);
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
};
importMenu.addEventListener('click', (e) => e.stopPropagation());

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
    store.addImportedModel({ id: nextId('model'), name: file.name }, reader.result);
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
});

document.getElementById('btn-export-obj').onclick = () => {
  const obj = scene3d.exportOBJ();
  if (!obj) {
    alert('Nothing to export yet — draw a shape and give it a height above 0 first.');
    return;
  }
  downloadText(obj, 'model.obj', 'text/plain');
};

document.getElementById('btn-export-png').onclick = () => {
  const dataUrl = scene3d.exportPNG();
  downloadDataUrl(dataUrl, 'model.png');
};

document.getElementById('btn-export-dxf').onclick = () => {
  if (!store.state.shapes.length) {
    alert('Nothing to export yet — draw a shape first.');
    return;
  }
  const dxf = scene3d.exportDXF();
  downloadText(dxf, 'plan.dxf', 'application/dxf');
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

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------- properties panel ----------------
const SWATCH_COLORS = ['#4fa3ff', '#ff9d4f', '#57d38c', '#c98bff', '#ff6b6b', '#f4d35e', '#93a1b3', '#ffffff'];

// A CSS-positioned dropdown instead of a native <input type="color"> —
// the native color picker's popup placement is decided by the browser and
// isn't something CSS/JS can reliably control, so it can open upward and
// clip against the top of the window. This one is anchored to the swatch
// button with `.dropdown-menu`'s own positioning, so it always renders in
// the same predictable spot below-and-left of the button.
function buildColorRow(shape) {
  const row = document.createElement('div');
  row.className = 'props-row';

  const label = document.createElement('span');
  label.textContent = 'Color';
  row.appendChild(label);

  const dropdown = document.createElement('div');
  dropdown.className = 'dropdown';

  const swatchBtn = document.createElement('button');
  swatchBtn.type = 'button';
  swatchBtn.className = 'color-swatch-btn';
  swatchBtn.style.background = shape.color;
  swatchBtn.title = shape.color;
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
    opt.className = 'swatch-option' + (c.toLowerCase() === shape.color.toLowerCase() ? ' active' : '');
    opt.style.background = c;
    opt.title = c;
    opt.onclick = () => {
      store.updateShape(shape.id, { color: c });
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
  hexInput.value = shape.color;
  hexInput.maxLength = 7;
  hexInput.placeholder = '#rrggbb';
  hexInput.onclick = (e) => e.stopPropagation();
  hexInput.onchange = () => {
    let v = hexInput.value.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      store.updateShape(shape.id, { color: v });
    } else {
      hexInput.value = shape.color;
    }
  };
  hexRow.appendChild(hexLabel);
  hexRow.appendChild(hexInput);
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

const propsPanel = document.getElementById('properties-panel');
function renderProps() {
  const image = store.state.images.find((im) => im.id === store.state.selectedImageId);
  if (image) { renderImageProps(image); return; }

  const shape = store.state.shapes.find((s) => s.id === store.state.selection[0]);
  propsPanel.innerHTML = '';
  if (!shape) {
    propsPanel.innerHTML = '<div class="panel-header"><span>Properties</span></div><div class="panel-empty">Select a shape to edit it.</div>';
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
  typeRow.innerHTML = `<span>Type</span><b>${shape.type}</b>`;
  body.appendChild(typeRow);

  body.appendChild(buildColorRow(shape));

  if (shape.closed) {
    const heightRow = document.createElement('label');
    heightRow.className = 'props-row';
    heightRow.innerHTML = `<span>Extrude height (m)</span>`;
    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.step = '0.1';
    heightInput.min = '0';
    heightInput.value = shape.height;
    heightInput.onchange = () => store.updateShape(shape.id, { height: Math.max(0, parseFloat(heightInput.value) || 0) });
    heightRow.appendChild(heightInput);
    body.appendChild(heightRow);

    const hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = shape.height > 0
      ? 'Extruded — included in .obj export.'
      : 'Height is 0 — shown as a flat footprint only. Set a height, or use the Push/Pull tool in the 3D view.';
    body.appendChild(hint);
  } else {
    const hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = 'Open lines are reference geometry and are not extruded or exported.';
    body.appendChild(hint);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger full';
  delBtn.textContent = 'Delete shape';
  delBtn.onclick = () => store.removeShapes([shape.id]);
  body.appendChild(delBtn);

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
    row.className = 'imported-row';
    const name = document.createElement('span');
    name.className = 'imported-name';
    name.textContent = m.name;
    name.title = m.name;
    const del = document.createElement('button');
    del.className = 'icon-btn small danger';
    del.textContent = '✕';
    del.title = 'Remove';
    del.onclick = () => store.removeImportedModel(m.id);
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

// ---------------- status bar ----------------
const statusCoords = document.getElementById('status-coords');
const statusTool = document.getElementById('status-tool');
const statusCount = document.getElementById('status-count');
const TOOL_LABELS = {
  select: 'Select / Move / Scale', line: 'Line (reference)', rect: 'Rectangle',
  circle: 'Circle', polygon: 'Polygon', pushpull: 'Push / Pull (drag a roof to extrude)',
};
function updateStatus(s = {}) {
  if (s.cursor) statusCoords.textContent = `x ${s.cursor.x.toFixed(2)}m, y ${s.cursor.y.toFixed(2)}m`;
  statusTool.textContent = TOOL_LABELS[store.state.tool] || store.state.tool;
  if (s.pushPullHeight !== undefined) {
    statusCoords.textContent = `height ${s.pushPullHeight.toFixed(2)}m`;
  }
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
  statusCount.textContent = text;
  updateStatus();
}
store.onChange(renderCounts);
renderCounts();

// ---------------- keyboard shortcuts ----------------
const TOOL_KEYS = { v: 'select', l: 'line', r: 'rect', c: 'circle', p: 'polygon', e: 'pushpull' };
window.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  if (typing) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); return; }
  if (e.key.toLowerCase() === 'f') { scene3d.frameAll(); plan2d.zoomToFit(); return; }
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  if (tool) store.setTool(tool);
});
