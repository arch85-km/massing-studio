// scene3d.js — Three.js viewport: renders extruded solids from the shape
// data model, provides the SketchUp-style push/pull tool, and exports .obj.

import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
import { OBJExporter } from '../vendor/three/exporters/OBJExporter.js';
import { OBJLoader } from '../vendor/three/loaders/OBJLoader.js';
import { STLExporter } from '../vendor/three/exporters/STLExporter.js';
import { shapePoints, distToSegment, polygonArea, lineIntersect } from './geometry.js';

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
    this.pushPull = null; // active push/pull drag state
    this.modelDrag = null; // active reference-model move/scale drag state
    this.modelHandle = null; // small scale-handle mesh, shown only while a model is selected

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
    this._syncModelHandle();

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

  // A single small handle at a corner of the selected model's current
  // bounding box — dragging it scales the model (see _onModelPointerDown).
  // depthTest:false + a high renderOrder keeps it visible even when it
  // would otherwise be hidden inside/behind the model's own geometry.
  _syncModelHandle() {
    const selectedId = this.store.state.selectedModelId;
    const obj = selectedId ? this.importedMeshCache.get(selectedId) : null;

    if (!obj) {
      if (this.modelHandle) {
        this.scene.remove(this.modelHandle);
        this.modelHandle.geometry.dispose();
        this.modelHandle.material.dispose();
        this.modelHandle = null;
      }
      return;
    }

    if (!this.modelHandle) {
      this.modelHandle = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.3, 0.3),
        new THREE.MeshBasicMaterial({ color: 0xff9d4f, depthTest: false })
      );
      this.modelHandle.renderOrder = 999;
      this.scene.add(this.modelHandle);
    }
    const box = new THREE.Box3().setFromObject(obj);
    this.modelHandle.position.set(box.max.x, box.max.y, box.max.z);
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

  // ---------------- pointer interaction: push/pull + reference-model move/scale ----------------
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
    const tool = this.store.state.tool;
    if (tool === 'pushpull') { this._onPushPullDown(e); return; }
    if (tool === 'select') { this._onModelPointerDown(e); }
  }

  _onPointerMove(e) {
    if (this.pushPull) { this._onPushPullMove(e); return; }
    if (this.modelDrag) { this._onModelDragMove(e); }
  }

  _onPointerUp() {
    if (this.pushPull) { this._onPushPullUp(); return; }
    if (this.modelDrag) { this._onModelDragUp(); }
  }

  // ---- push / pull ----
  // Grabbing the top face changes the shape's overall height (unchanged from
  // before). Grabbing a side wall now independently moves just that wall —
  // for a rect this is one edge sliding in/out; for an arbitrary polygon it's
  // the standard "offset one edge, re-intersect with its fixed neighbors"
  // operation; for a circle (no distinct walls) it's a uniform radius change.
  // The bottom face is deliberately inert — it stays anchored to the layer
  // floor. Which face was grabbed is read straight from the raycast hit's
  // face normal: this mesh is a straight, unbeveled ExtrudeGeometry rotated
  // so world Y is up with no further rotation/scale on the mesh itself, so
  // a cap's normal.y is ~±1 and a side wall's is ~0 — no fuzzy tolerance
  // needed, 0.5 cleanly separates the two.
  _onPushPullDown(e) {
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.modelGroup.children, false);
    if (!hits.length) return;

    const hit = hits[0];
    const shape = this.store.state.shapes.find((s) => s.id === hit.object.userData.shapeId);
    if (!shape || !shape.closed) return;

    const ny = hit.face.normal.y;
    if (ny >= 0.5) { this._startHeightDrag(shape, hit); return; }
    if (ny <= -0.5) return; // bottom cap — stays anchored to the floor, out of scope
    if (shape.type === 'circle') { this._startRadiusDrag(shape, hit); return; }
    this._startWallDrag(shape, hit);
  }

  _startHeightDrag(shape, hit) {
    this.controls.enabled = false;
    this.store.snapshot();
    this.pushPull = {
      mode: 'height',
      shapeId: shape.id,
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

  // A circle has no distinct walls — its whole curved side is one surface,
  // so "push/pull a wall" naturally generalizes to a uniform radius change
  // driven by the drag point's distance from the shape's center.
  _startRadiusDrag(shape, hit) {
    this.controls.enabled = false;
    this.store.snapshot();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
    this.pushPull = { mode: 'radius', shapeId: shape.id, plane };
    this.canvas.style.cursor = 'move';
  }

  // Rect / polygon: find the grabbed edge, remember its outward normal and
  // its two fixed neighbor edges (needed to re-intersect after the offset).
  _startWallDrag(shape, hit) {
    const pts = shape.points;
    if (!pts || pts.length < 3) return; // nothing sane to offset (e.g. a 2-point shape)

    // world X = local shape X, world Z = -(local shape Y) — see _buildMesh's
    // geometry.rotateX(-Math.PI/2); the mesh itself has no other rotation/scale.
    const localHit = { x: hit.point.x, y: -hit.point.z };

    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = distToSegment(localHit, pts[i], pts[(i + 1) % pts.length]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const i2 = (bestI + 1) % pts.length;
    const iPrev = (bestI - 1 + pts.length) % pts.length;
    const iNext = (i2 + 1) % pts.length;
    const V1 = { ...pts[bestI] };
    const V2 = { ...pts[i2] };
    const Vprev = { ...pts[iPrev] };
    const Vnext = { ...pts[iNext] };

    const edgeDir = { x: V2.x - V1.x, y: V2.y - V1.y };
    // Outward normal: for a CCW polygon (positive shoelace area) the interior
    // lies to the left of each directed edge, so outward is (dy, -dx); a CW
    // polygon flips the sign.
    const sign = polygonArea(pts) >= 0 ? 1 : -1;
    let n = { x: sign * edgeDir.y, y: -sign * edgeDir.x };
    const nLen = Math.hypot(n.x, n.y) || 1;
    n = { x: n.x / nLen, y: n.y / nLen };

    this.controls.enabled = false;
    this.store.snapshot();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
    this.pushPull = {
      mode: 'wall',
      shapeId: shape.id,
      plane,
      i: bestI, i2,
      V1, V2, Vprev, Vnext, edgeDir, n,
      startPoints: pts.map((p) => ({ ...p })),
      startArea: Math.abs(polygonArea(pts)),
    };
    this.canvas.style.cursor = 'move';
  }

  _onPushPullMove(e) {
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const pp = this.pushPull;
    const shapeIndex = this.store.state.shapes.findIndex((s) => s.id === pp.shapeId);
    const shape = this.store.state.shapes[shapeIndex];
    if (!shape) return;
    const layer = this.store.state.layers.find((l) => l.id === shape.layerId);

    if (pp.mode === 'height') {
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(pp.plane, point)) return;
      const deltaY = point.y - pp.grabPoint.y;
      shape.height = Math.max(0, Math.round((pp.startHeight + deltaY) * 100) / 100);
      this.onStatus({ pushPullHeight: shape.height });
    } else if (pp.mode === 'radius') {
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(pp.plane, point)) return;
      const localX = point.x, localY = -point.z;
      const r = Math.hypot(localX - shape.center.x, localY - shape.center.y);
      shape.radius = Math.max(0.05, Math.min(1000, Math.round(r * 100) / 100));
    } else if (pp.mode === 'wall') {
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(pp.plane, point)) return; // ray ~parallel to the ground plane — skip this frame
      const localPoint = { x: point.x, y: -point.z };
      // Signed distance of the drag point from the original edge line, along its outward normal.
      // Clamped: at a grazing camera angle a ground-plane ray intersection can
      // shoot out to an extreme, unstable distance for a small mouse move —
      // this keeps a stray drag from ever corrupting the shape's coordinates.
      let d = (localPoint.x - pp.V1.x) * pp.n.x + (localPoint.y - pp.V1.y) * pp.n.y;
      d = Math.max(-500, Math.min(500, d));
      const shifted = { x: pp.V1.x + pp.n.x * d, y: pp.V1.y + pp.n.y * d };

      const dirPrev = { x: pp.V1.x - pp.Vprev.x, y: pp.V1.y - pp.Vprev.y };
      const dirNext = { x: pp.Vnext.x - pp.V2.x, y: pp.Vnext.y - pp.V2.y };
      const newV1 = lineIntersect(pp.Vprev, dirPrev, shifted, pp.edgeDir) ?? { x: pp.V1.x + pp.n.x * d, y: pp.V1.y + pp.n.y * d };
      const newV2 = lineIntersect(pp.V2, dirNext, shifted, pp.edgeDir) ?? { x: pp.V2.x + pp.n.x * d, y: pp.V2.y + pp.n.y * d };

      const candidate = pp.startPoints.map((p, idx) => (idx === pp.i ? newV1 : idx === pp.i2 ? newV2 : p));
      const newArea = Math.abs(polygonArea(candidate));
      if (newArea < pp.startArea * 0.05) return; // reject a collapsing/self-intersecting edit — freeze at the last valid shape
      shape.points = candidate;
    }

    const mesh = this.meshByShape.get(shape.id);
    if (mesh) {
      this.modelGroup.remove(mesh);
      this._disposeMesh(mesh);
      const rebuilt = this._buildMesh(shape, layer, null, shapeIndex);
      rebuilt.userData.shapeId = shape.id;
      this.modelGroup.add(rebuilt);
      this.meshByShape.set(shape.id, rebuilt);
    }
  }

  _onPushPullUp() {
    this.pushPull = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = '';
    this.store.notify(); // sync 2D view + panels with the final shape
  }

  // ---- reference-model select / move / scale ----
  // Clicking a model selects it and starts a ground-plane drag-to-move;
  // clicking its scale handle (only present while selected) starts a
  // drag-to-scale instead. Both are gated to the Select tool so they never
  // compete with push/pull or with normal camera orbiting elsewhere.
  _onModelPointerDown(e) {
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.modelHandle) {
      const handleHits = this.raycaster.intersectObject(this.modelHandle, false);
      if (handleHits.length) {
        const model = this.store.state.importedModels.find((m) => m.id === this.store.state.selectedModelId);
        if (model) {
          // Distance is measured in screen space (NDC), not 3D world space:
          // a 3D distance from a ground-plane intersection doesn't track
          // "dragged toward/away from the object" consistently once the
          // camera is tilted — it can even shrink while the pointer moves
          // away on screen. Screen-space distance always behaves the way a
          // resize handle is expected to, independent of camera angle.
          const centerNDC = new THREE.Vector3(model.x, model.y, model.z).project(this.camera);
          const startDist = Math.hypot(this.pointer.x - centerNDC.x, this.pointer.y - centerNDC.y) || 0.0001;
          this.controls.enabled = false;
          this.store.snapshot();
          this.modelDrag = {
            type: 'scale',
            modelId: model.id,
            startScale: model.scale ?? 1,
            startDist,
            centerNDC,
          };
          this.canvas.style.cursor = 'nwse-resize';
          return;
        }
      }
    }

    const hits = this.raycaster.intersectObjects(this.importedGroup.children, true);
    if (!hits.length) return;
    // OBJLoader returns a nested Group per parsed object — walk up to the
    // top-level Object3D that importedMeshCache actually tracks.
    let obj = hits[0].object;
    while (obj.parent && obj.parent !== this.importedGroup) obj = obj.parent;
    const entry = [...this.importedMeshCache.entries()].find(([, o]) => o === obj);
    if (!entry) return;
    const [modelId] = entry;
    const model = this.store.state.importedModels.find((m) => m.id === modelId);
    if (!model) return;

    this.store.setSelectedModel(modelId);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -model.y);
    const grab = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(plane, grab);
    this.controls.enabled = false;
    this.store.snapshot();
    this.modelDrag = { type: 'move', modelId, startX: model.x, startZ: model.z, grab, plane };
    this.canvas.style.cursor = 'move';
  }

  _onModelDragMove(e) {
    this._setPointer(e);

    if (this.modelDrag.type === 'move') {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(this.modelDrag.plane, point)) return;
      const dx = point.x - this.modelDrag.grab.x;
      const dz = point.z - this.modelDrag.grab.z;
      this.store.updateImportedModel(this.modelDrag.modelId, {
        x: this.modelDrag.startX + dx,
        z: this.modelDrag.startZ + dz,
      }, { history: false });
      return;
    }

    // 'scale' — screen-space distance from the model's (fixed) projected
    // center to the pointer; see the comment where startDist is computed.
    const { centerNDC } = this.modelDrag;
    const dist = Math.hypot(this.pointer.x - centerNDC.x, this.pointer.y - centerNDC.y) || 0.0001;
    const factor = dist / this.modelDrag.startDist;
    const scale = Math.max(0.01, this.modelDrag.startScale * factor);
    this.store.updateImportedModel(this.modelDrag.modelId, { scale }, { history: false });
  }

  _onModelDragUp() {
    this.modelDrag = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = '';
    this.store.notify(); // sync the Reference Model properties panel with the final position/scale
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

  // Binary STL of the same solids as exportOBJ() — for 3D printing / CAM tools.
  exportSTL() {
    const exporter = new STLExporter();
    const exportGroup = new THREE.Group();
    for (const shape of this.store.state.shapes) {
      if (!shape.closed || !(shape.height > 0)) continue;
      const mesh = this.meshByShape.get(shape.id);
      if (!mesh) continue;
      const bare = new THREE.Mesh(mesh.geometry, mesh.material);
      bare.position.copy(mesh.position);
      bare.rotation.copy(mesh.rotation);
      bare.scale.copy(mesh.scale);
      exportGroup.add(bare);
    }
    if (!exportGroup.children.length) return null;
    exportGroup.updateMatrixWorld(true);
    return exporter.parse(exportGroup, { binary: true }); // DataView
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
