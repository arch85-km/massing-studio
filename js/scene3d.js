// scene3d.js — Three.js viewport: renders extruded solids from the shape
// data model, provides the SketchUp-style push/pull tool, 3D selection /
// move / stacking, 3D dimensions, orthographic elevation views with level
// lines, and the .obj / .stl / .dxf / high-resolution image exports.

import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
import { OBJExporter } from '../vendor/three/exporters/OBJExporter.js';
import { OBJLoader } from '../vendor/three/loaders/OBJLoader.js';
import { STLExporter } from '../vendor/three/exporters/STLExporter.js';
import { nextId } from './state.js';
import {
  shapePoints, snapVertices, distToSegment, polygonArea, lineIntersect, centroid,
  shapeBaseZ, mapShapeCoords, formatLength, formatArea, ringLength,
} from './geometry.js';

const FLAT_PREVIEW_DEPTH = 0.02; // visual thickness for un-extruded (height=0) footprints
const SNAP_PX = 12;              // screen-space radius for 3D vertex / height snapping
const MEASURE_COLOR = 0xffd166;
const TRANSLUCENT_OPACITY = 0.55;

// Plan (x, y) at elevation z  ->  world (x, z, -y). World Y is up.
const toWorld = (p, z) => new THREE.Vector3(p.x, z, -p.y);

export class Scene3D {
  constructor(canvas, store, { onStatus } = {}) {
    this.canvas = canvas;
    this.store = store;
    this.onStatus = onStatus || (() => {});

    // alpha:true so an image export can have a genuinely transparent background.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.bgColor = new THREE.Color(0x0d1117);
    this.scene.background = this.bgColor;
    this.scene.fog = new THREE.Fog(0x0d1117, 60, 220);

    // Two cameras sharing one set of orbit controls: perspective for
    // modelling, orthographic for true elevations (and plan) without
    // perspective distortion — heights read straight off the screen.
    this.perspCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.perspCamera.position.set(18, 16, 22);
    this.orthoCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, -2000, 4000);
    this.orthoHalfHeight = 10;
    this.camera = this.perspCamera;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // π/2 (not a hair less) so an elevation can look exactly horizontally.
    this.controls.maxPolarAngle = Math.PI / 2;

    this._setupLights();
    this._setupGroundAndGrid();

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    this.meshByShape = new Map();

    // Dimensions, area annotations and level datum lines — rebuilt with the
    // model, kept out of modelGroup so they're never raycast or exported as solids.
    this.annotationGroup = new THREE.Group();
    this.scene.add(this.annotationGroup);
    this.levelGroup = new THREE.Group();
    this.scene.add(this.levelGroup);
    this.previewGroup = new THREE.Group(); // in-progress 3D dimension
    this.scene.add(this.previewGroup);

    // Imported .obj reference models — a separate group so they're never
    // picked up by push/pull raycasting, OBJ export, or the drawn-shape mesh
    // lifecycle; they're static context, not editable geometry.
    this.importedGroup = new THREE.Group();
    this.scene.add(this.importedGroup);
    this.importedMeshCache = new Map(); // model id -> parsed Object3D

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pushPull = null;   // active push/pull drag state
    this.modelDrag = null;  // active reference-model move/scale drag state
    this.shapeDrag = null;  // active 3D shape move (horizontal or vertical) state
    this.dim3d = null;      // in-progress 3D dimension: { a: Vector3 }
    this.modelHandle = null; // small scale-handle mesh, shown only while a model is selected
    this.renderStyle = null; // { translucent, hideSelection } while exporting an image

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
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 1 })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.position.y = -0.01;
    this.scene.add(this.ground);

    // Invisible except for the shadows it catches — used by image export
    // on a white / transparent background when "ground shadow" is on.
    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.ShadowMaterial({ opacity: 0.18 })
    );
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.y = -0.005;
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.visible = false;
    this.scene.add(this.shadowCatcher);

    this.grid = new THREE.GridHelper(200, 200, 0x2a323d, 0x1a2028);
    this.grid.position.y = 0;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(2);
    this.axes.position.y = 0.01;
    this.scene.add(this.axes);
  }

  _viewSize() {
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  _updateOrthoFrustum(aspect) {
    const h = this.orthoHalfHeight;
    Object.assign(this.orthoCamera, { left: -h * aspect, right: h * aspect, top: h, bottom: -h });
    this.orthoCamera.updateProjectionMatrix();
  }

  _resize() {
    const { w, h } = this._viewSize();
    if (w === 0 || h === 0) return;
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    this._updateOrthoFrustum(w / h);
    this.renderer.setSize(w, h, false);
  }

  _animate = () => {
    requestAnimationFrame(this._animate);
    this.controls.update();
    this._updateLevelLineVisibility();
    this._updateLabelScales();
    this.renderer.render(this.scene, this.camera);
  };

  // Labels are sprites with sizeAttenuation off: under the perspective
  // camera their scale is a fixed fraction of the view, but under the
  // orthographic one three.js treats it as world units. Rescale them so a
  // label is the same size on screen in either projection.
  _placeLevelLabels() {
    if (!this.levelGroup.visible) return;
    const v = new THREE.Vector3();
    for (const obj of this.levelGroup.children) {
      const corners = obj.userData.corners;
      if (!corners) continue;
      let best = corners[0], bestX = -Infinity;
      for (const c of corners) {
        v.copy(c).project(this.camera);
        // ties (an exact elevation shows two corners at the same x): take the nearer one
        const x = v.x - v.z * 1e-3;
        if (x > bestX) { bestX = x; best = c; }
      }
      obj.position.copy(best);
    }
  }

  _updateLabelScales() {
    this._placeLevelLabels();
    const k = this.isOrtho
      ? (this.orthoHalfHeight / this.orthoCamera.zoom) / Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2))
      : 1;
    for (const group of [this.annotationGroup, this.levelGroup, this.previewGroup]) {
      for (const obj of group.children) {
        if (obj.isSprite && obj.userData.baseScale) obj.scale.copy(obj.userData.baseScale).multiplyScalar(k);
      }
    }
  }

  // ---------------- camera: perspective / orthographic ----------------
  get isOrtho() { return this.camera === this.orthoCamera; }

  setProjection(ortho) {
    if (ortho === this.isOrtho) return;
    const from = this.camera;
    const to = ortho ? this.orthoCamera : this.perspCamera;
    const distance = from.position.distanceTo(this.controls.target);
    if (ortho) {
      // Match the frustum height at the target so the switch doesn't jump.
      this.orthoHalfHeight = distance * Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2));
      this.orthoCamera.zoom = 1;
      this._updateOrthoFrustum(this.perspCamera.aspect);
    } else {
      // Keep the apparent size: move the perspective camera to the distance
      // at which its frustum is as tall as the (zoomed) orthographic one.
      const halfH = this.orthoHalfHeight / this.orthoCamera.zoom;
      const d = halfH / Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2));
      const dir = from.position.clone().sub(this.controls.target).normalize();
      from.position.copy(this.controls.target).addScaledVector(dir, d);
    }
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.onStatus({ projection: ortho ? 'ortho' : 'persp' });
  }

  // True when looking (near-)horizontally in orthographic — an elevation.
  isElevationView() {
    if (!this.isOrtho) return false;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return Math.abs(dir.y) < 0.02;
  }

  _updateLevelLineVisibility() {
    const show = !this.renderStyle?.hideLevels &&
      (this.store.state.display.levelLines || this.isElevationView());
    if (this.levelGroup.visible !== show) this.levelGroup.visible = show;
  }

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

    this._rebuildAnnotations();
    this._rebuildLevelLines();
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
    const style = this.renderStyle;
    const display = this.store.state.display;
    const selected = !style?.hideSelection && this.store.state.selection.includes(shape.id);
    // Nudge each shape's elevation by a tiny per-shape amount so two shapes
    // that share a floor and height never land on the exact same Y — that
    // coincidence causes z-fighting (flickering hatched overlap) on the GPU.
    const yEpsilon = epsilonIndex * 0.0005;
    const baseZ = shapeBaseZ(shape, layer);

    if (!shape.closed) {
      const pts = shapePoints(shape);
      if (pts.length < 2) return null;
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => toWorld(p, baseZ + 0.02 + yEpsilon)));
      const mat = new THREE.LineBasicMaterial({ color: selected ? 0xffffff : shape.color });
      return new THREE.Line(geo, mat);
    }

    const three = new THREE.Shape();
    const pts = shapePoints(shape);
    three.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) three.lineTo(pts[i].x, pts[i].y);
    three.closePath();
    for (const hole of shape.holes || []) {
      const path = new THREE.Path();
      path.moveTo(hole[0].x, hole[0].y);
      for (let i = 1; i < hole.length; i++) path.lineTo(hole[i].x, hole[i].y);
      path.closePath();
      three.holes.push(path);
    }

    const depth = height > 0 ? height : FLAT_PREVIEW_DEPTH;
    const geometry = new THREE.ExtrudeGeometry(three, { depth, bevelEnabled: false, curveSegments: 24 });
    geometry.rotateX(-Math.PI / 2); // local extrusion (Z) -> world up (Y)
    geometry.computeVertexNormals();

    let opacity = shape.opacity ?? 1;
    if (display.xray) opacity = Math.min(opacity, 0.5);
    if (style?.translucent) opacity = TRANSLUCENT_OPACITY;
    if (height <= 0) opacity = Math.min(opacity, 0.35);
    const transparent = opacity < 1;

    const color = new THREE.Color(shape.color);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.75,
      metalness: 0.05,
      transparent,
      opacity,
      // A see-through volume must not hide what's behind or inside it.
      depthWrite: !transparent,
      side: THREE.DoubleSide,
      // The translucent presentation style lifts each colour with a little
      // self-illumination so pale massing reads clean and bright on white,
      // rather than greyed by the shading of every overlapping face.
      emissive: selected ? new THREE.Color(0x2a2a2a) : style?.translucent ? color.clone().multiplyScalar(0.45) : new THREE.Color(0x000000),
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = baseZ + yEpsilon;
    mesh.castShadow = height > 0 && opacity > 0.3;
    mesh.receiveShadow = true;
    if (transparent) mesh.renderOrder = 1;

    if (selected || display.edges || style?.translucent) {
      // 20° threshold: box corners get a line, the facets of a circle or curve don't.
      const edgeColor = selected ? new THREE.Color(0xffffff) : color.clone().multiplyScalar(0.6);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 20),
        new THREE.LineBasicMaterial({ color: edgeColor, transparent: transparent && !selected, opacity: selected ? 1 : Math.max(0.6, opacity) })
      );
      edges.renderOrder = 2;
      mesh.add(edges);
    }
    return mesh;
  }

  _disposeMesh(mesh) {
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
    else {
      mesh.material?.map?.dispose();
      mesh.material?.dispose();
    }
    for (const child of mesh.children) this._disposeMesh(child);
  }

  _clearGroup(group) {
    for (const child of [...group.children]) this._disposeMesh(child);
    group.clear();
  }

  // ---------------- annotations: labels, dimensions, areas, level lines ----------------
  // A camera-facing text label with a constant on-screen size (sizeAttenuation
  // off), drawn over everything so it's never buried inside a volume.
  _makeLabel(text, { color = '#ffd166', bg = 'rgba(18,22,28,0.85)', size = 0.035 } = {}) {
    const lines = String(text).split('\n');
    const font = '600 36px Inter, system-ui, sans-serif';
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = font;
    const w = Math.ceil(Math.max(...lines.map((l) => g.measureText(l).width))) + 24;
    const h = 44 * lines.length + 8;
    c.width = w; c.height = h;
    g.font = font;
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, w / 2, 26 + i * 44));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
    const s = size * lines.length;
    sprite.scale.set((s * w) / h, s, 1);
    sprite.userData.baseScale = sprite.scale.clone();
    sprite.renderOrder = 1000;
    return sprite;
  }

  _overlayLine(points, color, { dashed = false } = {}) {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 0.4, gapSize: 0.25, depthTest: false, transparent: true, opacity: 0.9 })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 999;
    return line;
  }

  _rebuildAnnotations() {
    this._clearGroup(this.annotationGroup);
    const { dimensions, areas, display, selectedAnnotation: sel } = this.store.state;

    if (display.dims) {
      for (const d of dimensions) {
        const selected = sel?.kind === 'dimension' && sel.id === d.id && !this.renderStyle?.hideSelection;
        this._addDimensionObjects(this.annotationGroup, d, selected ? 0xffffff : MEASURE_COLOR);
      }
    }
    for (const a of areas) {
      const selected = sel?.kind === 'area' && sel.id === a.id && !this.renderStyle?.hideSelection;
      const z = (a.z ?? 0) + 0.03;
      const pts = a.points.map((p) => toWorld(p, z));
      this.annotationGroup.add(this._overlayLine([...pts, pts[0]], selected ? 0xffffff : MEASURE_COLOR, { dashed: true }));
      const label = this._makeLabel(`${formatArea(Math.abs(polygonArea(a.points)))}\nP ${formatLength(ringLength(a.points, true))}`, { size: 0.022 });
      label.position.copy(toWorld(centroid(a.points), z));
      this.annotationGroup.add(label);
    }
  }

  // A dimension's world geometry: plan offset (dimensions placed in the plan
  // view) is applied perpendicular to a→b in plan, like in the 2D view.
  _addDimensionObjects(group, d, color) {
    const A = toWorld(d.a, d.a.z ?? 0), B = toWorld(d.b, d.b.z ?? 0);
    let P1 = A.clone(), P2 = B.clone();
    const planLen = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
    if (d.offset && planLen > 1e-6) {
      const n = { x: -(d.b.y - d.a.y) / planLen, y: (d.b.x - d.a.x) / planLen };
      const off = new THREE.Vector3(n.x * d.offset, 0, -n.y * d.offset);
      P1 = A.clone().add(off);
      P2 = B.clone().add(off);
      group.add(this._overlayLine([A, P1], color));
      group.add(this._overlayLine([B, P2], color));
    }
    group.add(this._overlayLine([P1, P2], color));
    for (const p of [P1, P2]) {
      const dot = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.08),
        new THREE.MeshBasicMaterial({ color, depthTest: false })
      );
      dot.position.copy(p);
      dot.renderOrder = 999;
      group.add(dot);
    }
    const label = this._makeLabel(formatLength(A.distanceTo(B)), { color: color === 0xffffff ? '#ffffff' : '#ffd166', size: 0.026 });
    label.position.copy(P1).add(P2).multiplyScalar(0.5);
    group.add(label);
  }

  // Dashed datum rectangles at each visible level's elevation, just larger
  // than the model's footprint, labelled "Level name +elevation". Shown in
  // elevation views (and whenever the "Level lines" display option is on).
  _rebuildLevelLines() {
    this._clearGroup(this.levelGroup);
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 0, 5));
    const pad = 2;
    const x0 = box.min.x - pad, x1 = box.max.x + pad, z0 = box.min.z - pad, z1 = box.max.z + pad;
    for (const layer of this.store.state.layers) {
      if (!layer.visible) continue;
      const y = layer.elevation;
      const pts = [
        new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0),
        new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1), new THREE.Vector3(x0, y, z0),
      ];
      const line = this._overlayLine(pts, new THREE.Color(layer.color), { dashed: true });
      line.material.opacity = 0.75;
      this.levelGroup.add(line);
      const sign = y >= 0 ? '+' : '−';
      const label = this._makeLabel(`${layer.name}  ${sign}${Math.abs(y).toFixed(2)}`, { color: layer.color, size: 0.022 });
      // Sits just above the line, ending at whichever corner is rightmost on
      // screen (see _placeLevelLabels) — always inside the frame, whichever
      // side the elevation is taken from.
      label.center.set(1.02, -0.2);
      label.userData.corners = pts.slice(0, 4);
      label.position.copy(pts[1]);
      this.levelGroup.add(label);
    }
  }

  // ---------------- pointer interaction ----------------
  _bindPointer() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._cancelDim3d(); });
  }

  _setPointer(e) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  _toScreen(v) {
    const { w, h } = this._viewSize();
    const p = v.clone().project(this.camera);
    return { x: (p.x + 1) * w / 2, y: (1 - p.y) * h / 2, behind: p.z > 1 };
  }

  _pointerScreen() {
    const { w, h } = this._viewSize();
    return { x: (this.pointer.x + 1) * w / 2, y: (1 - this.pointer.y) * h / 2 };
  }

  // World units covered by one screen pixel at a given world point.
  _worldPerPixel(at) {
    const { h } = this._viewSize();
    if (this.isOrtho) return (this.orthoCamera.top - this.orthoCamera.bottom) / this.orthoCamera.zoom / h;
    const d = this.camera.position.distanceTo(at);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2))) / h;
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    const tool = this.store.state.tool;
    this._downAt = { x: e.clientX, y: e.clientY };
    if (tool === 'pushpull') { this._onPushPullDown(e); return; }
    if (tool === 'dimension') { this._onDimensionDown(e); return; }
    if (tool === 'select') { this._onSelectDown(e); }
  }

  _onPointerMove(e) {
    if (this.pushPull) { this._onPushPullMove(e); return; }
    if (this.modelDrag) { this._onModelDragMove(e); return; }
    if (this.shapeDrag) { this._onShapeDragMove(e); return; }
    if (this.dim3d && e.target === this.canvas) this._onDimensionMove(e);
  }

  _onPointerUp(e) {
    if (this.pushPull) { this._onPushPullUp(); return; }
    if (this.modelDrag) { this._onModelDragUp(); return; }
    if (this.shapeDrag) { this._onShapeDragUp(); return; }
    // A click (not an orbit drag) on empty space with the select tool clears the selection.
    if (this._pendingDeselect && this._downAt &&
        Math.hypot(e.clientX - this._downAt.x, e.clientY - this._downAt.y) < 4) {
      this.store.setSelection([]);
    }
    this._pendingDeselect = false;
  }

  _raycastShapes() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.modelGroup.children, false)
      .filter((h) => h.object.isMesh);
  }

  // ---- select / move / stack (select tool) ----
  // Order matters: the reference-model scale handle, then whichever is
  // nearer of a drawn volume or an imported model. A volume starts a snapped
  // horizontal move; Alt-drag moves it vertically instead (its base offset),
  // snapping onto other volumes' tops/bottoms and level elevations.
  _onSelectDown(e) {
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.modelHandle && this.raycaster.intersectObject(this.modelHandle, false).length) {
      this._startModelScale();
      return;
    }

    const shapeHit = this._raycastShapes()[0];
    const modelHit = this.raycaster.intersectObjects(this.importedGroup.children, true)[0];
    if (modelHit && (!shapeHit || modelHit.distance < shapeHit.distance)) {
      this._startModelMove(modelHit);
      return;
    }
    if (!shapeHit) { this._pendingDeselect = true; return; }

    const state = this.store.state;
    const id = shapeHit.object.userData.shapeId;
    const shape = state.shapes.find((s) => s.id === id);
    const layer = state.layers.find((l) => l.id === shape?.layerId);
    if (!shape || layer?.locked) return;

    let ids;
    if (e.shiftKey) {
      ids = state.selection.includes(id) ? state.selection.filter((x) => x !== id) : [...state.selection, id];
    } else {
      ids = state.selection.includes(id) ? state.selection : [id];
    }
    this.store.setSelection(ids);
    if (!ids.includes(id)) return;

    const moving = state.shapes.filter((s) => ids.includes(s.id));
    const snapshots = new Map(moving.map((s) => [s.id, JSON.parse(JSON.stringify(s))]));
    this.controls.enabled = false;
    const hit = shapeHit.point.clone();

    if (e.altKey) {
      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      const n = new THREE.Vector3(camDir.x, 0, camDir.z).normalize();
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      this.shapeDrag = {
        mode: 'vertical', snapshots, grab: hit, historyTaken: false,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit),
        bottom: Math.min(...moving.map((s) => shapeBaseZ(s, state.layers.find((l) => l.id === s.layerId)))),
      };
      this.canvas.style.cursor = 'ns-resize';
      return;
    }

    // Horizontal move on the plane through the grab point. The anchor is the
    // moving geometry's plan vertex nearest the grab — that vertex is what
    // snaps to the grid / other shapes' vertices, same as in the plan view.
    const grabPlan = { x: hit.x, y: -hit.z };
    let anchor = null, best = Infinity;
    for (const s of moving) {
      for (const v of snapVertices(s)) {
        const d = Math.hypot(v.x - grabPlan.x, v.y - grabPlan.y);
        if (d < best) { best = d; anchor = { ...v }; }
      }
    }
    this.shapeDrag = {
      mode: 'horizontal', snapshots, grab: hit, historyTaken: false,
      narrowTo: !e.shiftKey && ids.length > 1 ? id : null,
      anchor: anchor || grabPlan,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.y),
    };
    this.canvas.style.cursor = 'move';
  }

  _onShapeDragMove(e) {
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const sd = this.shapeDrag;
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(sd.plane, point)) return;
    const { grid, shapes, layers } = this.store.state;
    const patches = {};

    if (sd.mode === 'horizontal') {
      const raw = { x: sd.anchor.x + point.x - sd.grab.x, y: sd.anchor.y - (point.z - sd.grab.z) };
      const tol = SNAP_PX * this._worldPerPixel(point);
      let target = null, bestD = tol;
      for (const s of shapes) {
        if (sd.snapshots.has(s.id)) continue;
        if (!layers.find((l) => l.id === s.layerId)?.visible) continue;
        for (const v of snapVertices(s)) {
          const d = Math.hypot(v.x - raw.x, v.y - raw.y);
          if (d < bestD) { bestD = d; target = v; }
        }
      }
      if (!target) target = grid.snap
        ? { x: Math.round(raw.x / grid.size) * grid.size, y: Math.round(raw.y / grid.size) * grid.size }
        : raw;
      const dx = target.x - sd.anchor.x, dy = target.y - sd.anchor.y;
      if (!sd.historyTaken && Math.hypot(dx, dy) < 1e-9) return;
      for (const [id, snap] of sd.snapshots) patches[id] = mapShapeCoords(snap, (p) => ({ x: p.x + dx, y: p.y + dy }));
      this.onStatus({ measure: `Δx ${dx.toFixed(2)} m, Δy ${dy.toFixed(2)} m` });
    } else {
      let bottom = sd.bottom + (point.y - sd.grab.y);
      bottom = this._snapElevation(bottom, point, new Set(sd.snapshots.keys()));
      bottom = Math.max(0, bottom);
      const dz = bottom - sd.bottom;
      if (!sd.historyTaken && Math.abs(dz) < 1e-9) return;
      for (const [id, snap] of sd.snapshots) patches[id] = { base: Math.round(((snap.base ?? 0) + dz) * 1000) / 1000 };
      this.onStatus({ measure: `base ${bottom.toFixed(2)} m` });
    }
    if (!sd.historyTaken) { this.store.snapshot(); sd.historyTaken = true; }
    this.store.updateShapes(patches, { history: false });
  }

  _onShapeDragUp() {
    // A click without a drag on one of several selected volumes selects just that one.
    if (this.shapeDrag.narrowTo && !this.shapeDrag.historyTaken) this.store.setSelection([this.shapeDrag.narrowTo]);
    this.shapeDrag = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = '';
  }

  // Snap an elevation to the nearest "meaningful" height within SNAP_PX:
  // another volume's top or bottom, or a level's elevation. Failing that,
  // with Snap on, round to 0.1 m.
  _snapElevation(z, at, excludeIds) {
    const { shapes, layers, grid } = this.store.state;
    const candidates = layers.map((l) => l.elevation);
    for (const s of shapes) {
      if (excludeIds.has(s.id) || !s.closed) continue;
      const layer = layers.find((l) => l.id === s.layerId);
      if (!layer?.visible) continue;
      const b = shapeBaseZ(s, layer);
      candidates.push(b, b + (s.height || 0));
    }
    const tol = SNAP_PX * this._worldPerPixel(at);
    let best = null, bestD = tol;
    for (const c of candidates) {
      const d = Math.abs(c - z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best !== null) return best;
    return grid.snap ? Math.round(z * 10) / 10 : Math.round(z * 100) / 100;
  }

  // ---- 3D dimension tool ----
  // Click two points on the model: each click snaps to the nearest volume
  // corner (bottom or top of any vertex) within SNAP_PX on screen, else to
  // the surface point under the cursor, else to the ground plane.
  _pick3d() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ps = this._pointerScreen();
    const { shapes, layers } = this.store.state;
    let best = null, bestD = SNAP_PX;
    for (const s of shapes) {
      const layer = layers.find((l) => l.id === s.layerId);
      if (!layer?.visible) continue;
      const b = shapeBaseZ(s, layer);
      const zs = s.closed && s.height > 0 ? [b, b + s.height] : [b];
      for (const v of snapVertices(s)) {
        for (const z of zs) {
          const w = toWorld(v, z);
          const sp = this._toScreen(w);
          if (sp.behind) continue;
          const d = Math.hypot(sp.x - ps.x, sp.y - ps.y);
          if (d < bestD) { bestD = d; best = w; }
        }
      }
    }
    if (best) return { point: best, snapped: true };
    const hit = this._raycastShapes()[0];
    if (hit) return { point: hit.point.clone(), snapped: false };
    const ground = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ground)) {
      return { point: ground, snapped: false };
    }
    return null;
  }

  _onDimensionDown(e) {
    this._setPointer(e);
    const pick = this._pick3d();
    if (!pick) return;
    if (!this.dim3d) {
      this.dim3d = { a: pick.point };
      this._drawDimPreview(pick.point, pick.point);
      return;
    }
    const a = this.dim3d.a, b = pick.point;
    this._cancelDim3d();
    if (a.distanceTo(b) < 1e-6) return;
    const plan = (v) => ({ x: v.x, y: -v.z, z: v.y });
    this.store.addDimension({ id: nextId('dim'), a: plan(a), b: plan(b), offset: 0 });
  }

  _onDimensionMove(e) {
    this._setPointer(e);
    const pick = this._pick3d();
    if (!pick) return;
    this._drawDimPreview(this.dim3d.a, pick.point, pick.snapped);
    this.onStatus({ measure: `L ${formatLength(this.dim3d.a.distanceTo(pick.point))}` });
  }

  _drawDimPreview(a, b, snapped = false) {
    this._clearGroup(this.previewGroup);
    const plan = (v) => ({ x: v.x, y: -v.z, z: v.y });
    this._addDimensionObjects(this.previewGroup, { a: plan(a), b: plan(b), offset: 0 }, 0x4fa3ff);
    if (snapped) {
      const ring = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: 0x57d38c, wireframe: true, depthTest: false }));
      ring.position.copy(b);
      ring.renderOrder = 1001;
      this.previewGroup.add(ring);
    }
  }

  _cancelDim3d() {
    this.dim3d = null;
    this._clearGroup(this.previewGroup);
  }

  // ---- push / pull ----
  // Grabbing the top face changes the shape's overall height, snapping to
  // other volumes' tops/bottoms and level elevations. Grabbing a side wall
  // independently moves just that wall — for a rect this is one edge sliding
  // in/out; for an arbitrary polygon it's the standard "offset one edge,
  // re-intersect with its fixed neighbors" operation; for a circle (no
  // distinct walls) it's a uniform radius change, and for a curve a uniform
  // scale about its centre. The bottom face is deliberately inert — it stays
  // anchored to its base. Which face was grabbed is read straight from the
  // raycast hit's face normal: this mesh is a straight, unbeveled
  // ExtrudeGeometry rotated so world Y is up with no further rotation/scale
  // on the mesh itself, so a cap's normal.y is ~±1 and a side wall's is ~0 —
  // no fuzzy tolerance needed, 0.5 cleanly separates the two.
  _onPushPullDown(e) {
    this._setPointer(e);
    const hit = this._raycastShapes()[0];
    if (!hit) return;

    const shape = this.store.state.shapes.find((s) => s.id === hit.object.userData.shapeId);
    if (!shape || !shape.closed) return;

    const ny = hit.face.normal.y;
    if (ny >= 0.5) { this._startHeightDrag(shape, hit); return; }
    if (ny <= -0.5) return; // bottom cap — stays anchored to its base, out of scope
    if (shape.type === 'circle') { this._startRadiusDrag(shape, hit); return; }
    if (shape.type === 'spline') { this._startCurveScaleDrag(shape, hit); return; }
    this._startWallDrag(shape, hit);
  }

  _startHeightDrag(shape, hit) {
    this.controls.enabled = false;
    this.store.snapshot();
    const layer = this.store.state.layers.find((l) => l.id === shape.layerId);
    this.pushPull = {
      mode: 'height',
      shapeId: shape.id,
      startHeight: shape.height || 0,
      baseZ: shapeBaseZ(shape, layer),
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

  // A curve's side is one smooth surface too: pushing it scales the whole
  // outline about its centre by the ratio of drag distances from that centre.
  _startCurveScaleDrag(shape, hit) {
    const c = centroid(shape.points);
    const startDist = Math.hypot(hit.point.x - c.x, -hit.point.z - c.y);
    if (startDist < 1e-6) return;
    this.controls.enabled = false;
    this.store.snapshot();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
    this.pushPull = { mode: 'curve', shapeId: shape.id, plane, c, startDist, startPoints: shape.points.map((p) => ({ ...p })) };
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
    // A courtyard (hole) wall isn't an outer edge — leave those alone.
    for (const h of shape.holes || []) {
      for (let i = 0; i < h.length; i++) {
        if (distToSegment(localHit, h[i], h[(i + 1) % h.length]) < bestD) return;
      }
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
    const { grid } = this.store.state;

    if (pp.mode === 'height') {
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(pp.plane, point)) return;
      const deltaY = point.y - pp.grabPoint.y;
      const top = this._snapElevation(pp.baseZ + pp.startHeight + deltaY, point, new Set([shape.id]));
      shape.height = Math.max(0, Math.round((top - pp.baseZ) * 1000) / 1000);
      this.onStatus({ pushPullHeight: shape.height });
    } else if (pp.mode === 'radius') {
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(pp.plane, point)) return;
      const localX = point.x, localY = -point.z;
      let r = Math.hypot(localX - shape.center.x, localY - shape.center.y);
      r = grid.snap ? Math.max(grid.size, Math.round(r / grid.size) * grid.size) : Math.round(r * 100) / 100;
      shape.radius = Math.max(0.05, Math.min(1000, r));
      this.onStatus({ measure: `R ${formatLength(shape.radius)}` });
    } else if (pp.mode === 'curve') {
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(pp.plane, point)) return;
      const d = Math.hypot(point.x - pp.c.x, -point.z - pp.c.y);
      const f = Math.max(0.05, Math.min(50, d / pp.startDist));
      shape.points = pp.startPoints.map((p) => ({ x: pp.c.x + (p.x - pp.c.x) * f, y: pp.c.y + (p.y - pp.c.y) * f }));
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
      // Snap the offset to whole grid steps, so a wall that started on the grid stays on it.
      if (grid.snap) d = Math.round(d / grid.size) * grid.size;
      const shifted = { x: pp.V1.x + pp.n.x * d, y: pp.V1.y + pp.n.y * d };

      const dirPrev = { x: pp.V1.x - pp.Vprev.x, y: pp.V1.y - pp.Vprev.y };
      const dirNext = { x: pp.Vnext.x - pp.V2.x, y: pp.Vnext.y - pp.V2.y };
      const newV1 = lineIntersect(pp.Vprev, dirPrev, shifted, pp.edgeDir) ?? { x: pp.V1.x + pp.n.x * d, y: pp.V1.y + pp.n.y * d };
      const newV2 = lineIntersect(pp.V2, dirNext, shifted, pp.edgeDir) ?? { x: pp.V2.x + pp.n.x * d, y: pp.V2.y + pp.n.y * d };

      const candidate = pp.startPoints.map((p, idx) => (idx === pp.i ? newV1 : idx === pp.i2 ? newV2 : p));
      const newArea = Math.abs(polygonArea(candidate));
      if (newArea < pp.startArea * 0.05) return; // reject a collapsing/self-intersecting edit — freeze at the last valid shape
      shape.points = candidate;
      this.onStatus({ measure: `wall ${d >= 0 ? '+' : ''}${d.toFixed(2)} m` });
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
  _startModelScale() {
    const model = this.store.state.importedModels.find((m) => m.id === this.store.state.selectedModelId);
    if (!model) return;
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
  }

  _startModelMove(hit) {
    // OBJLoader returns a nested Group per parsed object — walk up to the
    // top-level Object3D that importedMeshCache actually tracks.
    let obj = hit.object;
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
      let x = this.modelDrag.startX + point.x - this.modelDrag.grab.x;
      let z = this.modelDrag.startZ + point.z - this.modelDrag.grab.z;
      const { grid } = this.store.state;
      if (grid.snap) {
        x = Math.round(x / grid.size) * grid.size;
        z = Math.round(z / grid.size) * grid.size;
      }
      this.store.updateImportedModel(this.modelDrag.modelId, { x, z }, { history: false });
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
    if (this.isOrtho) this._fitOrtho(size);
  }

  _fitOrtho(size) {
    this.orthoHalfHeight = Math.max(size.x, size.y, size.z, 4) * 0.75;
    this.orthoCamera.zoom = 1;
    this._updateOrthoFrustum(this.perspCamera.aspect);
  }

  // top / iso / front / back / left / right. The four elevations (and top)
  // switch to orthographic — a true, measurable elevation — and look exactly
  // horizontally; iso goes back to perspective.
  setView(preset) {
    const box = this._sceneBounds();
    const center = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(10, 10, 10) : box.getSize(new THREE.Vector3());
    const d = Math.max(size.x, size.y, size.z, 8) * 1.8;
    const presets = {
      top: [center.x, center.y + d, center.z + 0.001],
      front: [center.x, center.y, center.z + d],
      back: [center.x, center.y, center.z - d],
      right: [center.x + d, center.y, center.z],
      left: [center.x - d, center.y, center.z],
      iso: [center.x + d * 0.6, center.y + d * 0.55, center.z + d * 0.6],
    };
    const p = presets[preset] || presets.iso;
    this.setProjection(preset !== 'iso');
    this.camera.position.set(...p);
    this.controls.target.copy(center);
    if (this.isOrtho) {
      // Elevations frame the model's width and height; plan frames its footprint.
      const fit = preset === 'top' ? new THREE.Vector3(size.x, size.z, 0) : new THREE.Vector3(Math.max(size.x, size.z), size.y, 0);
      const aspect = this.perspCamera.aspect || 1;
      this.orthoHalfHeight = Math.max(fit.y / 2, fit.x / 2 / aspect, 2) * 1.25;
      this.orthoCamera.zoom = 1;
      this._updateOrthoFrustum(aspect);
    }
    this.controls.update();
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
        // Clone without children (selection outline, edges, etc.) — only the solid itself.
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

  // Largest image edge this GPU can render in one pass.
  maxExportSize() {
    const gl = this.renderer.getContext();
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), dims[0], dims[1], 16384);
  }

  // Render the current 3D view to an image data URL at any resolution.
  //   format:      'png' | 'jpeg'
  //   background:  'transparent' (PNG only) | 'white' | 'dark'
  //   width/height: output size in pixels (the view's aspect ratio is kept by the caller)
  //   translucent: the see-through massing look — every volume at 55% with edges
  //   hideHelpers: hide ground, grid and axes (default true)
  //   shadow:      catch soft ground shadows on a white/transparent background
  // Everything touched here is restored in `finally`, even if rendering throws.
  //   annotations: include dimensions and measured areas
  exportImage({ format = 'png', background = 'white', width, height, translucent = false, hideHelpers = true, shadow = false, annotations = true } = {}) {
    const max = this.maxExportSize();
    const scale = Math.min(1, max / Math.max(width, height));
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    if (format === 'jpeg' && background === 'transparent') background = 'white';

    const saved = {
      background: this.scene.background,
      fog: this.scene.fog,
      clearColor: this.renderer.getClearColor(new THREE.Color()),
      clearAlpha: this.renderer.getClearAlpha(),
      ground: this.ground.visible, grid: this.grid.visible, axes: this.axes.visible,
      catcher: this.shadowCatcher.visible,
      handle: this.modelHandle?.visible,
      preview: this.previewGroup.visible,
      annotations: this.annotationGroup.visible,
      perspAspect: this.perspCamera.aspect,
    };
    this.renderStyle = { translucent, hideSelection: true, hideLevels: false };
    try {
      if (background === 'transparent') {
        this.scene.background = null;
        this.renderer.setClearColor(0x000000, 0);
      } else if (background === 'white') {
        this.scene.background = new THREE.Color(0xffffff);
      }
      if (background !== 'dark') this.scene.fog = null;
      if (hideHelpers) {
        this.ground.visible = false;
        this.grid.visible = false;
        this.axes.visible = false;
      }
      this.shadowCatcher.visible = shadow && background !== 'dark';
      if (this.modelHandle) this.modelHandle.visible = false;
      this.previewGroup.visible = false;
      this.rebuild();
      this.annotationGroup.visible = annotations;
      this._updateLevelLineVisibility();
      this._updateLabelScales();

      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
      this.perspCamera.aspect = w / h;
      this.perspCamera.updateProjectionMatrix();
      this._updateOrthoFrustum(w / h);
      this.renderer.render(this.scene, this.camera);
      const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      return { dataUrl: this.renderer.domElement.toDataURL(mime, 0.95), width: w, height: h };
    } finally {
      this.renderStyle = null;
      this.scene.background = saved.background;
      this.scene.fog = saved.fog;
      this.renderer.setClearColor(saved.clearColor, saved.clearAlpha);
      this.ground.visible = saved.ground;
      this.grid.visible = saved.grid;
      this.axes.visible = saved.axes;
      this.shadowCatcher.visible = saved.catcher;
      if (this.modelHandle) this.modelHandle.visible = saved.handle;
      this.previewGroup.visible = saved.preview;
      this.annotationGroup.visible = saved.annotations;
      this.renderer.setPixelRatio(this.pixelRatio);
      this.perspCamera.aspect = saved.perspAspect;
      this._resize();
      this.rebuild();
    }
  }

  // Export the 2D plan as an ASCII DXF — every shape's footprint, not just
  // extruded solids, since a DXF is a drawing, not a 3D model. Circles export
  // as CIRCLE entities; every other shape as a single LWPOLYLINE (one entity
  // per shape, not exploded into separate LINE segments) so re-importing the
  // file reconstructs the same shapes 1:1, and so real CAD software reads it
  // as connected polylines rather than a pile of disconnected lines. A
  // curve exports as its sampled outline; each hole as its own closed polyline.
  exportDXF() {
    const lines = [];
    const emit = (code, value) => { lines.push(String(code)); lines.push(String(value)); };
    const polyline = (pts, closed) => {
      emit(0, 'LWPOLYLINE');
      emit(8, '0');
      emit(90, pts.length);
      emit(70, closed ? 1 : 0);
      for (const p of pts) { emit(10, p.x); emit(20, p.y); }
    };

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
      polyline(pts, shape.closed);
      for (const h of shape.holes || []) polyline(h, true);
    }

    emit(0, 'ENDSEC');
    emit(0, 'EOF');
    return lines.join('\n') + '\n';
  }
}
