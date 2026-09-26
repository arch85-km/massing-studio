# Massing Studio

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22814301.svg)](https://doi.org/10.5281/zenodo.22814301)

**v1.1.0 · 2026-09-26**

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
extrusion exercise: parametric constraints, general (free-form) solid
modelling, detailed BIM metadata (walls/doors/windows as distinct families), and
multi-user collaboration. Those are reasons to graduate to Rhino,
SketchUp, or Revit once the basic plan→volume workflow clicks.

---

## Features

- **Draw tools**: line (reference only), rectangle, circle, freeform
  polygon, and **curve** — a smooth spline through the points you click
  (close either with Enter, double-click, or a click near the start
  point; a curve can also be left open as a reference line).
- **Extrude**: give any closed shape a height in the Properties panel,
  or drag it directly with the **Push/Pull** tool in the 3D view — the
  top face changes height; any side wall moves just that wall.
- **Select / Move / Scale / Delete** existing shapes from the plan view —
  Shift+click or drag a box to select several; drag the round handles to
  edit a polygon's or curve's points; scale from the square handles
  (about the opposite corner; hold Shift for uniform). Volumes can also
  be selected and dragged in the 3D view.
- **Levels (floors)**: a Levels panel to add, rename, hide, lock and
  recolour floors, each with its own elevation and default height. New
  shapes go on the active level; other levels show ghosted in the plan.
  **Stack copy on top** puts a copy of a volume directly above it,
  **Alt+drag** in 3D lifts a volume (snapping onto other volumes' tops),
  **Colour as gradient** colours the floors from orange at the ground to
  pale straw at the top, and every shape has a base offset.
- **Elevation views**: Front / Back / Left / Right orthographic
  elevations in the 3D view (plus Top, Iso and a Persp/Ortho toggle),
  with dashed level lines labelled with each level's elevation.
- **Measure**: a **Dimension** tool (click two points, then click to
  place the dimension line) in the plan, or directly on the 3D model,
  where it snaps to volume corners — so heights can be dimensioned in
  an elevation. An **Area** tool measures any area you click out
  (area + perimeter). Properties show each shape's width × depth,
  footprint area, perimeter and volume; the Levels panel shows the area
  per floor and the status bar the total gross floor area.
- **Booleans**: select two volumes and **Intersect**, **Union** or
  **Subtract** them (footprints clipped in plan, heights overlapped in
  section — results can have courtyards/holes). Undo restores them.
- **Copy / Cut / Paste** shapes, reference images, and imported 3D
  models — `Ctrl+C`/`Ctrl+X`/`Ctrl+V`, or the toolbar menu next to
  Undo/Redo (works on touch devices too).
- **Import**: a `.obj` model as a static 3D reference, a `.dxf` drawing
  as fully editable shapes, or an image as a traceable underlay in the
  2D plan — each with its own drag-to-move / drag-to-resize handles.
- **Snapping**: grid snap (adjustable spacing) and endpoint snap to
  existing geometry — also while moving and scaling shapes in the plan,
  and when pushing/pulling or moving volumes in 3D (heights snap to
  other volumes' tops and to level elevations).
- **Split-screen** 2D plan + 3D model, or either view full-screen.
- **Camera presets**: Top, Front, Isometric, and Frame-all.
- **Colour and transparency per shape**: a 24-colour palette, hex entry
  or any colour from the system picker, and an opacity slider. The View
  menu adds edge lines, an X-ray (see-through) mode and area labels.
- **Undo / redo**, full history.
- **Mobile-friendly**: responsive two-row toolbar, touch pinch-zoom/pan
  in the 2D plan, touch drag for all the same handles.
- **Save / Open** a project as JSON (keeps every shape, image, model,
  and imported asset), or **Save as .obj**: an ordinary OBJ that Rhino,
  Blender or SketchUp read as usual, with the whole project carried in
  comment lines, so opening it here again gives back the editable model.
  **Open** also reads an `.obj` from any other program: every straight
  vertical extrusion comes in as an editable shape (with courtyards kept,
  and one level per floor height); anything else becomes a 3D reference.
- **Export**: `.obj` and binary `.stl` for every extruded solid (closed
  shapes with a height above 0), a **high-resolution PNG or JPEG** of
  the 3D view (up to 4× the view, or a custom width — on a transparent,
  white or dark background, optionally in a translucent massing style
  with edges), and `.dxf` of the 2D plan. Open lines and un-extruded (height 0)
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
   a PNG/JPEG image, or `.dxf`.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `V` | Select tool |
| `L` | Line (reference) |
| `R` | Rectangle |
| `C` | Circle |
| `P` | Polygon |
| `S` | Curve (spline) |
| `E` | Push/Pull |
| `D` | Dimension |
| `A` | Area |
| `O` | Toggle perspective / orthographic (3D) |
| `Enter` / double-click | Close the polygon / curve / area being drawn; place a dimension with no offset |
| `Esc` | Cancel the shape or measurement being drawn |
| `Delete` / `Backspace` | Delete the selected shape(s), image, model, or measurement |
| Shift + click | Add to / remove from the selection (plan and 3D) |
| Alt + drag (3D) | Lift a volume vertically |
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
│   ├── objio.js             Save as .obj, and rebuilding editable shapes from an .obj
│   ├── geometry.js          Snapping, hit-testing, curves, areas, polygon math
│   ├── booleans.js          Intersect / Union / Subtract between volumes
│   ├── canvas2d.js          2D plan view: drawing & measuring tools, selection, pan/zoom
│   ├── scene3d.js           Three.js viewport: extrusion, push/pull, elevations, exports
│   └── main.js              Wires everything to the toolbar, panels & status bar
├── vendor/three/           Vendored Three.js r160 (module build) + OrbitControls,
│                             OBJExporter, OBJLoader, STLExporter — no CDN required
├── vendor/polygon-clipping/  Vendored polygon-clipping (MIT) for the booleans
├── scripts/build-standalone.sh   Bundles the whole app into one self-contained HTML file
└── dist/Massing-Studio.html      The built single-file bundle
```

## Tech notes

- Plain ES modules, no bundler or framework — open the file and it runs.
- Three.js is vendored locally under `vendor/three/` (MIT licensed) so the
  app works fully offline and isn't dependent on a CDN being reachable;
  so is polygon-clipping (`vendor/polygon-clipping/`, MIT), which does the
  2D footprint clipping behind the boolean operations.
- Every volume is a vertical prism (a plan footprint between a bottom
  and a top elevation), so booleans are exact: footprints are clipped in
  plan and the vertical extents intersected in section.
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
licensed separately under **CC BY 4.0**. Both licences, the split between
them, and the vendored Three.js third-party notice are set out in full in
`NOTICE`.

## How to cite

See "How to cite" in `docs/method-notes.html` for the full citation
(Harvard and BibTeX) and reproducibility notes.
