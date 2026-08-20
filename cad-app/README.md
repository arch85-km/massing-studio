# Studio CAD

A lightweight, browser-based CAD tool for **sketching 2D floor plans and
extruding them into 3D massing models** — built for architecture students
who need to go from a plan diagram to a exportable 3D volume in minutes,
without the learning curve of a full CAD/BIM suite.

Draw → set a height (or drag it in 3D) → export `.obj` for Rhino, Blender,
SketchUp, or a 3D printer slicer.

No installation, no account, no build step: open `index.html` in a browser
and start drawing.

---

## Research notes: what this borrows from SketchUp & AutoCAD

This tool deliberately narrows the feature set of professional CAD/BIM
software down to the handful of interactions students actually need for
early-stage massing studies:

| Concept | Borrowed from | How it appears here |
|---|---|---|
| Push/Pull extrusion | **SketchUp** | Select the Push/Pull tool, click a shape's top face in the 3D view, drag up or down — the solid's height updates live, exactly like SketchUp's signature interaction. |
| Precision drafting on a snap grid | **AutoCAD** | The 2D plan view snaps to a configurable grid and to existing shape endpoints (an object-snap), so walls line up without hand-eye precision. |
| Layers | **AutoCAD** | Shapes belong to a layer. Here each layer doubles as a **floor**, with its own elevation — so layers double as a storey-stacking mechanism, which is closer to how architecture students actually use them than AutoCAD's original drafting-layer concept. |
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
  or drag it directly with the **Push/Pull** tool in the 3D view.
- **Floors / layers**: stack multiple storeys, each with its own
  elevation and default extrude height; toggle visibility per floor.
- **Select / Move / Scale / Delete** existing shapes from the plan view.
- **Snapping**: grid snap (adjustable spacing) and endpoint snap to
  existing geometry.
- **Split-screen** 2D plan + 3D model, or either view full-screen.
- **Camera presets**: Top, Front, Isometric, and Frame-all.
- **Color per shape**, from the active layer's palette or a custom pick.
- **Undo / redo**, full history.
- **Save / Open** a project as JSON (keeps every shape, layer, and color).
- **Export `.obj`** — every extruded solid (closed shapes with a height
  above 0), ready to open in Blender, Rhino, SketchUp, or a slicer.
  Open lines and un-extruded (height 0) footprints are excluded.

## Using it

1. Open `index.html` in a modern desktop browser (Chrome, Edge, Firefox,
   or Safari). No server or install required — though serving it over
   `http://` (e.g. `python3 -m http.server`) avoids browser file:// CORS
   restrictions on some setups.
2. Pick a draw tool from the toolbar and sketch your footprint in the
   **Plan View** on the left.
3. Select the shape, then set an **extrude height** in the Properties
   panel — or switch to the **Push/Pull** tool and drag the shape's top
   face in the **3D Model** view.
4. Add a **floor** (top-left panel, `+`) to start a second storey; set
   its elevation to stack it above the one below.
5. When the model looks right, click **Export .obj**.

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
| `Delete` / `Backspace` | Delete the selected shape |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` (or `Ctrl+Y`) | Redo |
| `F` | Frame all (fit both views to the model) |
| Space + drag, or middle-mouse drag | Pan the plan view |
| Scroll | Zoom the plan view |
| Left-drag (3D) | Orbit |
| Right-drag (3D) | Pan |

## Project structure

```
cad-app/
├── index.html            Page shell — toolbar, panels, canvases
├── css/style.css          Professional dark CAD theme
├── js/
│   ├── state.js           Data model: layers, shapes, undo/redo history
│   ├── geometry.js         Snapping, hit-testing, polygon math
│   ├── canvas2d.js         2D plan view: drawing tools, selection, pan/zoom
│   ├── scene3d.js          Three.js viewport: extrusion, push/pull, .obj export
│   ├── layers-ui.js        Floors / layers side panel
│   └── main.js             Wires everything to the toolbar & status bar
└── vendor/three/          Vendored Three.js r160 (module build, OrbitControls,
                             OBJExporter) — no CDN or build step required
```

## Tech notes

- Plain ES modules, no bundler or framework — open the file and it runs.
- Three.js is vendored locally under `vendor/three/` (MIT licensed) so the
  app works fully offline and isn't dependent on a CDN being reachable.
- The data model (`state.js`) is UI-agnostic: the 2D canvas, 3D viewport,
  and side panels all just subscribe to state changes and re-render, which
  keeps "draw a shape" and "extrude a shape" as two independent, testable
  concerns.
- Units are meters throughout; the default grid is 1 m with a bold line
  every 5 m.
