// layers-ui.js — the left-hand Layers / Floors panel: add, rename, set
// elevation & default extrude height, toggle visibility/lock, delete.

export class LayersPanel {
  constructor(root, store) {
    this.root = root;
    this.store = store;
    this.store.onChange(() => this.render());
    this.render();
  }

  render() {
    const { layers, activeLayerId, shapes } = this.store.state;
    this.root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.innerHTML = `<span>Floors / Layers</span>`;
    const addBtn = document.createElement('button');
    addBtn.className = 'icon-btn';
    addBtn.title = 'Add floor';
    addBtn.textContent = '+';
    addBtn.onclick = () => this.store.addLayer();
    header.appendChild(addBtn);
    this.root.appendChild(header);

    const list = document.createElement('div');
    list.className = 'layer-list';

    // show topmost floor first, like real elevation stacking
    const sorted = [...layers].sort((a, b) => b.elevation - a.elevation);

    for (const layer of sorted) {
      const count = shapes.filter((s) => s.layerId === layer.id).length;
      const row = document.createElement('div');
      row.className = 'layer-row' + (layer.id === activeLayerId ? ' active' : '');

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = layer.color;

      const nameInput = document.createElement('input');
      nameInput.className = 'layer-name';
      nameInput.value = layer.name;
      nameInput.onchange = () => this.store.updateLayer(layer.id, { name: nameInput.value });
      nameInput.onclick = (e) => e.stopPropagation();

      const meta = document.createElement('div');
      meta.className = 'layer-meta';
      meta.textContent = `${count} shape${count === 1 ? '' : 's'} · elev ${layer.elevation.toFixed(2)}m`;

      const elevInput = this._numberField('Elevation (m)', layer.elevation, (v) =>
        this.store.updateLayer(layer.id, { elevation: v })
      );
      const heightInput = this._numberField('Default height (m)', layer.defaultHeight, (v) =>
        this.store.updateLayer(layer.id, { defaultHeight: v })
      );

      const controls = document.createElement('div');
      controls.className = 'layer-controls';
      controls.appendChild(elevInput);
      controls.appendChild(heightInput);

      const visBtn = document.createElement('button');
      visBtn.className = 'icon-btn small';
      visBtn.title = layer.visible ? 'Hide floor' : 'Show floor';
      visBtn.textContent = layer.visible ? '👁' : '—';
      visBtn.onclick = (e) => { e.stopPropagation(); this.store.updateLayer(layer.id, { visible: !layer.visible }); };

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn small danger';
      delBtn.title = 'Delete floor';
      delBtn.textContent = '✕';
      delBtn.disabled = layers.length <= 1;
      delBtn.onclick = (e) => { e.stopPropagation(); this.store.removeLayer(layer.id); };

      const top = document.createElement('div');
      top.className = 'layer-top';
      top.appendChild(swatch);
      top.appendChild(nameInput);
      top.appendChild(visBtn);
      top.appendChild(delBtn);

      row.appendChild(top);
      row.appendChild(meta);
      row.appendChild(controls);
      row.onclick = () => this.store.setActiveLayer(layer.id);

      list.appendChild(row);
    }

    this.root.appendChild(list);
  }

  _numberField(label, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'num-field';
    wrap.title = label;
    const span = document.createElement('span');
    span.textContent = label.startsWith('Elevation') ? 'Z' : 'H';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.value = value;
    input.onclick = (e) => e.stopPropagation();
    input.onchange = () => onChange(parseFloat(input.value) || 0);
    wrap.appendChild(span);
    wrap.appendChild(input);
    return wrap;
  }
}
