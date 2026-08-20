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
document.getElementById('btn-save').onclick = () => {
  const data = JSON.stringify(store.state, null, 2);
  downloadText(data, 'plan.cadproj.json', 'application/json');
};
const loadInput = document.getElementById('load-input');
document.getElementById('btn-load').onclick = () => loadInput.click();
loadInput.onchange = () => {
  const file = loadInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      store.loadProject(data);
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

// Closes any open dropdown (export menu, color picker, …) on an outside click.
window.addEventListener('click', () => {
  document.querySelectorAll('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));
  exportToggle.setAttribute('aria-expanded', 'false');
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

const propsPanel = document.getElementById('properties-panel');
function renderProps() {
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
  statusCount.textContent = `${store.state.shapes.length} shape${store.state.shapes.length === 1 ? '' : 's'} (${closedCount} extrudable)`;
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
