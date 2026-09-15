# Massing Studio

**v1.0.0 · 2026-09-15**

A lightweight, browser-based tool for **sketching 2D plans and extruding
them into 3D massing models** — built for architecture students who need
to go from a plan diagram to an exportable 3D volume in minutes, without
the learning curve of a full CAD/BIM suite.

Draw → set a height (or drag it in 3D) → export `.obj`/`.stl`/`.dxf` for
Rhino, Blender, SketchUp, a slicer, or another CAD package.

No installation, no account, no build step: open `index.html` in a browser
and start drawing. A single self-contained build (bundling the whole app
and its dependencies into one HTML file) is also available for dropping
straight into a website — see `dist/`.

---

## Research notes: what this borrows from SketchUp & AutoCAD

This tool deliberately narrows the feature set of professional CAD/BIM
software down to the handful of interactions students actually need for
early-stage massing studies:

| Concept | Borrowed from | How it appears here |
|---|---|---|
| Push/Pull extrusion | **SketchUp** | Select the Push/Pull tool in the 3D view: drag a shape's top face to change its height, or drag any side wall to move just that wall — a rectangle's four walls independently, an arbitrary polygon's edge, or a circle's radius. |
| Precision drafting on a snap grid | **AutoCAD** | The 2D plan view snaps to a configurable grid and to existing shape endpoints (an object-snap), so shapes line up without hand-eye precision. |
| DXF import/export | **AutoCAD** | Import a `.dxf` drawing's lines, circles, and polylines as fully editable shapes; export the plan back out as DXF for use in other CAD tools. |
| Distinct 2D drafting / 3D modeling views | Both | A split-screen shows the flat plan and the massing model at once, so the connection between "the shape I drew" and "the volume it becomes" stays visible while learning the tool. |
| Orbit / pan / zoom camera | Both | Standard CAD navigation: left-drag to orbit, right-drag to pan, scroll to zoom, in the 3D view. |

What's intentionally **left out**, because it isn't needed for a first
extrusion exercise: parametric constraints, boolean solid operations,
detailed BIM metadata (walls/doors/windows as distinct families), and
multi-user collaboration. Those are reasons to graduate to Rhino,
SketchUp, or Revit once the basic plan→volume workflow clicks.

---

## Features

- **Draw tools**: line (reference only), rectangle, circle, and
  freeform polygon (click each vertex; close with Enter, double-click,
  or a click near the start point).
- **Extrude**: give any closed shape a height in the Properties panel,
  or drag it directly with the **Push/Pull** tool in the 3D view — the
  top face changes height; any side wall moves just that wall.
- **Select / Move / Scale / Delete** existing shapes from the plan view.
- **Copy / Cut / Paste** shapes, reference images, and imported 3D
  models — `Ctrl+C`/`Ctrl+X`/`Ctrl+V`, or the toolbar menu next to
  Undo/Redo (works on touch devices too).
- **Import**: a `.obj` model as a static 3D reference, a `.dxf` drawing
  as fully editable shapes, or an image as a traceable underlay in the
  2D plan — each with its own drag-to-move / drag-to-resize handles.
- **Snapping**: grid snap (adjustable spacing) and endpoint snap to
  existing geometry.
- **Split-screen** 2D plan + 3D model, or either view full-screen.
- **Camera presets**: Top, Front, Isometric, and Frame-all.
- **Color per shape**, from a swatch palette or a custom hex pick.
- **Undo / redo**, full history.
- **Mobile-friendly**: responsive two-row toolbar, touch pinch-zoom/pan
  in the 2D plan, touch drag for all the same handles.
- **Save / Open** a project as JSON (keeps every shape, image, model,
  and imported asset).
- **Export**: `.obj` and binary `.stl` for every extruded solid (closed
  shapes with a height above 0), `.png` of the current 3D view, and
  `.dxf` of the 2D plan. Open lines and un-extruded (height 0)
  footprints are excluded from the solid exports.

## Using it

1. Open `index.html` in a modern desktop or mobile browser (Chrome,
   Edge, Firefox, or Safari). No server or install required — though
   serving it over `http://` (e.g. `python3 -m http.server`) avoids
   browser `file://` CORS restrictions on some setups.
2. Pick a draw tool from the toolbar and sketch your footprint in the
   **Plan View**.
3. Select the shape, then set an **extrude height** in the Properties
   panel — or switch to the **Push/Pull** tool and drag the shape's top
   face (height) or a side wall (that wall only) in the **3D Model**
   view.
4. Import a `.dxf`, `.obj`, or image if you're tracing over existing
   drawings or reference geometry.
5. When the model looks right, use **Export** to save `.obj`, `.stl`,
   `.png`, or `.dxf`.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `V` | Select tool |
| `L` | Line (reference) |
| `R` | Rectangle |
| `C` | Circle |
| `P` | Polygon |
| `E` | Push/Pull |
| `Enter` / double-click | Close the polygon being drawn |
| `Esc` | Cancel the shape being drawn |
| `Delete` / `Backspace` | Delete the selected shape, image, or model |
| `Ctrl/Cmd + C` | Copy the current selection |
| `Ctrl/Cmd + X` | Cut the current selection |
| `Ctrl/Cmd + V` | Paste |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` (or `Ctrl+Y`) | Redo |
| `F` | Frame all (fit both views to the model) |
| Space + drag, or middle-mouse drag | Pan the plan view |
| Scroll, or two-finger pinch (touch) | Zoom the plan view |
| Left-drag (3D) | Orbit |
| Right-drag (3D) | Pan |

## Project structure

```
massing-studio/
├── index.html             Page shell — toolbar, panels, canvases
├── css/style.css           Dark theme, responsive (desktop + mobile) layout
├── js/
│   ├── state.js             Data model: shapes, images, models, undo/redo history
│   ├── geometry.js          Snapping, hit-testing, polygon math
│   ├── canvas2d.js          2D plan view: drawing tools, selection, pan/zoom
│   ├── scene3d.js           Three.js viewport: extrusion, push/pull, exports
│   └── main.js              Wires everything to the toolbar & status bar
├── vendor/three/           Vendored Three.js r160 (module build) + OrbitControls,
│                             OBJExporter, OBJLoader, STLExporter — no CDN required
├── scripts/build-standalone.sh   Bundles the whole app into one self-contained HTML file
└── dist/Massing-Studio.html      The built single-file bundle
```

## Tech notes

- Plain ES modules, no bundler or framework — open the file and it runs.
- Three.js is vendored locally under `vendor/three/` (MIT licensed) so the
  app works fully offline and isn't dependent on a CDN being reachable.
- The data model (`state.js`) is UI-agnostic: the 2D canvas, 3D viewport,
  and side panels all just subscribe to state changes and re-render, which
  keeps "draw a shape" and "extrude a shape" as two independent, testable
  concerns.
- `scripts/build-standalone.sh` inlines every module and vendored file into
  a single `dist/Massing-Studio.html`, for dropping into a website (e.g.
  WordPress) with no separate asset files to host.
- Units are meters throughout; the default grid is 1 m with a bold line
  every 5 m.

## License

Massing Studio's own source code is licensed under the **MIT License**
(see `LICENSE`). Accompanying documentation, screenshots, and exercises are
licensed separately under **CC BY 4.0** (see `LICENSE-DOCS`). The vendored
Three.js library under `vendor/three/` keeps its own upstream MIT license
(see `vendor/three/LICENSE`).
