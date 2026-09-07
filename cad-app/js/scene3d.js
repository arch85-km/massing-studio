// scene3d.js — Three.js viewport: renders extruded solids from the shape
// data model, provides the SketchUp-style push/pull tool, and exports .obj.

import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
import { OBJExporter } from '../vendor/three/exporters/OBJExporter.js';
import { OBJLoader } from '../vendor/three/loaders/OBJLoader.js';
import { shapePoints } from './geometry.js';

const FLAT_PREVIEW_DEPTH = 0.02; // visual thickness for un-extruded (height=0) footprints

export class Scene3D {
  constructor(canvas, store, { onStatus } = {}) {
    this.canvas = canvas;
    this.store = store;
    this.onStatus = onStatus || (() => {});

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);
    this.scene.fog = new THREE.Fog(0x0d1117, 60, 220);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(18, 16, 22);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this._setupLights();
    this._setupGroundAndGrid();

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    this.meshByShape = new Map();

    // Imported .obj reference models — a separate group so they're never
    // picked up by push/pull raycasting, OBJ export, or the drawn-shape mesh
    // lifecycle; they're static context, not editable geometry.
    this.importedGroup = new THREE.Group();
    this.scene.add(this.importedGroup);
    this.importedMeshCache = new Map(); // model id -> parsed Object3D

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pushPull = null; // active drag state

    this._bindPointer();

    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();

    this.store.onChange(() => this.rebuild());
    this.rebuild();
    this._animate();
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x1a1410, 0.65);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2df, 1.15);
    sun.position.set(20, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    sun.shadow.camera.far = 120;
    sun.shadow.bias = -0.0015;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
    fill.position.set(-15, 10, -10);
    this.scene.add(fill);
  }

  _setupGroundAndGrid() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.position.y = -0.01;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(200, 200, 0x2a323d, 0x1a2028);
    grid.position.y = 0;
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(2);
    axes.position.y = 0.01;
    this.scene.add(axes);
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(r.width, r.height, false);
  }

  _animate = () => {
    requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ---------------- model building ----------------
  rebuild() {
    const state = this.store.state;

    // dispose & clear
    for (const mesh of this.meshByShape.values()) this._disposeMesh(mesh);
    this.modelGroup.clear();
    this.meshByShape.clear();

    state.shapes.forEach((shape, index) => {
      const layer = state.layers.find((l) => l.id === shape.layerId);
      if (!layer || !layer.visible) return;
      const mesh = this._buildMesh(shape, layer, null, index);
      if (!mesh) return;
      mesh.userData.shapeId = shape.id;
      this.modelGroup.add(mesh);
      this.meshByShape.set(shape.id, mesh);
    });

    this._syncImportedModels(state.importedModels);

    // controls target: keep looking near model center on first build
    if (!this._targetedOnce && state.shapes.length) {
      this._targetedOnce = true;
      this.controls.target.set(0, 1.2, 0);
    }
  }

  // Adds/removes parsed .obj Object3Ds to match state.importedModels,
  // parsing each model's text only once (cached by id) rather than on every
  // store change — but re-applies position/scale every time, since those
  // can change (via the Reference Models panel) without a re-parse.
  _syncImportedModels(models) {
    const currentIds = new Set(models.map((m) => m.id));

    for (const [id, obj] of this.importedMeshCache) {
      if (currentIds.has(id)) continue;
      this.importedGroup.remove(obj);
      obj.traverse((child) => {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material?.dispose();
      });
      this.importedMeshCache.delete(id);
    }

    for (const model of models) {
      if (!this.importedMeshCache.has(model.id)) {
        const text = this.store.modelAssets.get(model.id);
        if (!text) continue;
        try {
          const obj = new OBJLoader().parse(text);
          obj.traverse((child) => {
            if (!child.isMesh) return;
            child.material = new THREE.MeshStandardMaterial({
              color: 0x8a97a8,
              roughness: 0.85,
              metalness: 0.05,
              transparent: true,
              opacity: 0.85,
              side: THREE.DoubleSide,
            });
            child.castShadow = false;
            child.receiveShadow = true;
          });
          this.importedGroup.add(obj);
          this.importedMeshCache.set(model.id, obj);
        } catch (err) {
          console.warn(`Failed to parse imported model "${model.name}":`, err);
          continue;
        }
      }
      const obj = this.importedMeshCache.get(model.id);
      obj.position.set(model.x ?? 0, model.y ?? 0, model.z ?? 0);
      obj.scale.setScalar(model.scale ?? 1);
    }
  }

  _buildMesh(shape, layer, heightOverride = null, epsilonIndex = 0) {
    const height = Math.max(heightOverride ?? shape.height ?? 0, 0);
    const selected = this.store.state.selection.includes(shape.id);
    // Nudge each shape's elevation by a tiny per-shape amount so two shapes
    // that share a floor and height never land on the exact same Y — that
    // coincidence causes z-fighting (flickering hatched overlap) on the GPU.
    const yEpsilon = epsilonIndex * 0.0005;

    if (!shape.closed) {
      if (shape.type !== 'line' || shape.points.length < 2) return null;
      const pts = shape.points.map((p) => new THREE.Vector3(p.x, layer.elevation + 0.02 + yEpsilon, -p.y));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: selected ? 0xffffff : shape.color });
      return new THREE.Line(geo, mat);
    }

    const three = new THREE.Shape();
    const pts = shapePoints(shape);
    three.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) three.lineTo(pts[i].x, pts[i].y);
    three.closePath();

    const depth = height > 0 ? height : FLAT_PREVIEW_DEPTH;
    const geometry = new THREE.ExtrudeGeometry(three, { depth, bevelEnabled: false, curveSegments: 24 });
    geometry.rotateX(-Math.PI / 2); // local extrusion (Z) -> world up (Y)
    geometry.computeVertexNormals();

    const color = new THREE.Color(shape.color);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.75,
      metalness: 0.05,
      transparent: height <= 0,
      opacity: height <= 0 ? 0.35 : 1,
      side: THREE.DoubleSide,
      emissive: selected ? new THREE.Color(0x2a2a2a) : new THREE.Color(0x000000),
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = layer.elevation + yEpsilon;
    mesh.castShadow = height > 0;
    mesh.receiveShadow = true;

    if (selected) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0xffffff })
      );
      mesh.add(edges);
    }
    return mesh;
  }

  _disposeMesh(mesh) {
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
    else mesh.material?.dispose();
    for (const child of mesh.children) this._disposeMesh(child);
  }

  // ---------------- push / pull tool ----------------
  _bindPointer() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
  }

  _setPointer(e) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  _onPointerDown(e) {
    if (this.store.state.tool !== 'pushpull') return;
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.modelGroup.children, false);
    if (!hits.length) return;

    const hit = hits[0];
    const shapeId = hit.object.userData.shapeId;
    const shape = this.store.state.shapes.find((s) => s.id === shapeId);
    if (!shape || !shape.closed) return;

    this.controls.enabled = false;
    this.store.snapshot();
    this.pushPull = {
      shapeId,
      startHeight: shape.height || 0,
      grabPoint: hit.point.clone(),
      // A vertical plane through the grab point, facing the camera —
      // dragging the mouse up/down intersects this plane at different Y.
      plane: new THREE.Plane(),
    };
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const planeNormal = new THREE.Vector3(camDir.x, 0, camDir.z).normalize();
    if (planeNormal.lengthSq() < 1e-6) planeNormal.set(0, 0, 1);
    this.pushPull.plane.setFromNormalAndCoplanarPoint(planeNormal, hit.point);
    this.canvas.style.cursor = 'ns-resize';
  }

  _onPointerMove(e) {
    if (!this.pushPull) return;
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.pushPull.plane, point)) return;

    const deltaY = point.y - this.pushPull.grabPoint.y;
    const newHeight = Math.max(0, Math.round((this.pushPull.startHeight + deltaY) * 100) / 100);

    const shapeIndex = this.store.state.shapes.findIndex((s) => s.id === this.pushPull.shapeId);
    const shape = this.store.state.shapes[shapeIndex];
    const layer = this.store.state.layers.find((l) => l.id === shape.layerId);
    if (!shape) return;
    shape.height = newHeight;
    const mesh = this.meshByShape.get(shape.id);
    if (mesh) {
      this.modelGroup.remove(mesh);
      this._disposeMesh(mesh);
      const rebuilt = this._buildMesh(shape, layer, null, shapeIndex);
      rebuilt.userData.shapeId = shape.id;
      this.modelGroup.add(rebuilt);
      this.meshByShape.set(shape.id, rebuilt);
    }
    this.onStatus({ pushPullHeight: newHeight });
  }

  _onPointerUp() {
    if (!this.pushPull) return;
    this.pushPull = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = '';
    this.store.notify(); // sync 2D view + panels with the final height
  }

  // ---------------- camera helpers ----------------
  _sceneBounds() {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    box.union(new THREE.Box3().setFromObject(this.importedGroup));
    return box;
  }

  frameAll() {
    const box = this._sceneBounds();
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const dist = maxDim * 1.6 + 4;
    this.camera.position.set(center.x + dist * 0.6, center.y + dist * 0.55, center.z + dist * 0.6);
    this.controls.target.copy(center);
  }

  setView(preset) {
    const box = this._sceneBounds();
    const center = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(10, 10, 10) : box.getSize(new THREE.Vector3());
    const d = Math.max(size.x, size.y, size.z, 8) * 1.8;
    const presets = {
      top: [center.x, center.y + d, center.z + 0.001],
      front: [center.x, center.y + d * 0.3, center.z + d],
      iso: [center.x + d * 0.6, center.y + d * 0.55, center.z + d * 0.6],
    };
    const p = presets[preset] || presets.iso;
    this.camera.position.set(...p);
    this.controls.target.copy(center);
  }

  // ---------------- export ----------------
  exportOBJ() {
    const exporter = new OBJExporter();
    // Export only solid (extruded) meshes — skip flat 0-height previews and reference lines.
    const exportGroup = new THREE.Group();
    let i = 0;
    for (const shape of this.store.state.shapes) {
      if (!shape.closed || !(shape.height > 0)) continue;
      const mesh = this.meshByShape.get(shape.id);
      if (mesh) {
        // Clone without children (selection outline, etc.) — only the solid itself.
        const bare = new THREE.Mesh(mesh.geometry, mesh.material);
        bare.position.copy(mesh.position);
        bare.rotation.copy(mesh.rotation);
        bare.scale.copy(mesh.scale);
        const layer = this.store.state.layers.find((l) => l.id === shape.layerId);
        bare.name = `${(layer?.name || 'shape').replace(/\s+/g, '_')}_${shape.type}_${++i}`;
        exportGroup.add(bare);
      }
    }
    if (!exportGroup.children.length) return null;
    exportGroup.updateMatrixWorld(true);
    return exporter.parse(exportGroup);
  }

  // Snapshot the current 3D view as a PNG data URL.
  exportPNG() {
    this.renderer.render(this.scene, this.camera); // ensure the buffer holds a fresh frame
    return this.renderer.domElement.toDataURL('image/png');
  }

  // Export the 2D plan as an ASCII DXF — every shape's footprint, not just
  // extruded solids, since a DXF is a drawing, not a 3D model. Circles export
  // as CIRCLE entities; every other shape as a single LWPOLYLINE (one entity
  // per shape, not exploded into separate LINE segments) so re-importing the
  // file reconstructs the same shapes 1:1, and so real CAD software reads it
  // as connected polylines rather than a pile of disconnected lines.
  exportDXF() {
    const lines = [];
    const emit = (code, value) => { lines.push(String(code)); lines.push(String(value)); };

    emit(0, 'SECTION');
    emit(2, 'ENTITIES');

    for (const shape of this.store.state.shapes) {
      if (shape.type === 'circle') {
        emit(0, 'CIRCLE');
        emit(8, '0');
        emit(10, shape.center.x); emit(20, shape.center.y); emit(30, 0);
        emit(40, shape.radius);
        continue;
      }

      const pts = shapePoints(shape);
      if (pts.length < 2) continue;
      emit(0, 'LWPOLYLINE');
      emit(8, '0');
      emit(90, pts.length);
      emit(70, shape.closed ? 1 : 0);
      for (const p of pts) { emit(10, p.x); emit(20, p.y); }
    }

    emit(0, 'ENDSEC');
    emit(0, 'EOF');
    return lines.join('\n') + '\n';
  }
}
