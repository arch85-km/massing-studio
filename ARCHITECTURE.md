# Architecture

How Massing Studio is put together: what lives where, how a drawing becomes a
volume, and what the tooling around it does. For the conventions behind the
numbers (what an area or a GFA means, and what the tool does not do), read
[`docs/method-notes.html`](docs/method-notes.html); this file is the map.

## Two forms of the same app

| File | What it is |
|---|---|
| `index.html` + `css/` + `js/` + `vendor/` | The source: an ES-module app that runs from a local web server. |
| `dist/Massing-Studio.html` | The deliverable: one self-contained file, about 1.6 MB, built from the source by `scripts/build-standalone.sh`. This is the file uploaded to the website. |

Both run entirely in the browser. The app stores nothing in the browser and
makes no network requests: drawings, imported files and exports never leave
the device. Its two libraries are vendored and bundled, not fetched:

- **three.js r160** (MIT) with OrbitControls, OBJExporter, OBJLoader and
  STLExporter, in `vendor/three/`;
- **polygon-clipping v0.15.7** (MIT, bundling splaytree), in
  `vendor/polygon-clipping/`, loaded as a classic script because it ships as
  a UMD bundle.

## Conventions

- Units are **metres**.
- The plan is the x–y plane. A plan point (x, y) at elevation z becomes the
  3D world point (x, z, −y): **world Y is up**.
- Every volume is a **vertical prism**: a closed 2D footprint (optionally with
  holes) between a base and a top elevation. That one rule is what makes the
  push/pull tool, the booleans and the .obj round trip tractable.
- The grid defaults to 1 m with snapping on and a major line every 5 m.

## The modules

| Module | Does |
|---|---|
| `js/state.js` | `Store`: the whole model in one plain object (levels, shapes, images, imported models, dimensions, areas, display, grid, view), mutation helpers, and undo/redo as JSON snapshots (up to 100). It touches neither the DOM nor three.js; views subscribe with `onChange` and redraw. |
| `js/geometry.js` | Pure maths shared by both views: snapping (grid and object snap to corners, curve control points, circle quadrants), hit testing, areas, perimeters, centroids, bounds and spline sampling. |
| `js/canvas2d.js` | `Plan2D`: the top-down plan in plain Canvas 2D — grid, drawing tools (rectangle, circle, polygon, curve, line), selection, move and scale, vertex editing, image underlays, and the Dimension and Area tools. |
| `js/scene3d.js` | `Scene3D`: the three.js viewport — extruded solids built from the model, SketchUp-style push/pull, 3D selection, moving and stacking, 3D dimensions, orthographic elevations with level lines, and the .obj, .stl, .dxf and high-resolution image exports. |
| `js/booleans.js` | Intersect, Union and Subtract between two volumes: polygon-clipping on the footprints, interval arithmetic on the heights. |
| `js/objio.js` | "Save as .obj" and reopening it as an editable model (below). |
| `js/main.js` | Bootstrap: wires the toolbar, properties panel and status bar to the Store and the two views; DXF import (`parseDXF`); file open and save; the About panel. |

### From a drawing to a volume

1. A tool in `Plan2D` adds a shape to the `Store`: a footprint, its level and
   a height. Only **closed** shapes can be extruded; lines stay reference
   geometry.
2. The `Store` notifies its listeners.
3. `Scene3D` rebuilds the solids for the changed shapes, as prisms from the
   level's elevation; `Plan2D` redraws the plan.
4. Push/pull in the 3D view writes the new height (or an edge or radius)
   back to the `Store`, so both views stay one model.

Levels stack floors at their own elevations. The status bar's **GFA** adds up
the footprints of every visible extruded volume: it is a sum of footprints,
not of floors, which the method notes and the 1.1.0 release notes both say
before a number is quoted.

### Booleans

Because every volume is a prism, 3D booleans reduce to 2D clipping plus
heights:

- A ∩ B = (footprint A ∩ footprint B) over (height range A ∩ B)
- A − B = (A − B) over A's range, plus (A ∩ B) over (A's range − B's range)
- A ∪ B = (A ∪ B) over A's range when the ranges match; otherwise A plus the
  pieces of B − A.

polygon-clipping copes with the shared edges and collinear overlaps that
grid-snapped drawings are full of.

### The .obj round trip

"Save as .obj" writes ordinary Wavefront geometry (Y up, metres) that Rhino,
Blender and SketchUp read, followed by the complete project as base64 JSON on
`#` comment lines. Other programs skip comments, so the file costs them
nothing; reopening it here restores the project exactly.

Opening an .obj from another program rebuilds every straight vertical
extrusion (all its vertices on exactly two heights) as an editable footprint
and height, one level per base elevation. Anything else (a roof, a sphere, a
sloped face) cannot be described that way and comes in as a static reference
model.

## Files in and out

| In | Out |
|---|---|
| Project `.json` | Project `.json` |
| `.obj`: editable if it carries the project, rebuilt if it is straight extrusions, reference geometry otherwise | `.obj` (with the embedded project), binary `.stl`, `.dxf` |
| `.dxf` drawings | `.png` / `.jpeg` of the 3D view at high resolution, on a transparent, white or dark background |
| Images, as a traceable underlay | |

## The repository

```
index.html                    the source entry point
css/style.css                 the interface
js/                           the seven modules above
vendor/                       three.js r160 and polygon-clipping, with their licences
scripts/build-standalone.sh   bundles everything into dist/Massing-Studio.html
dist/Massing-Studio.html      the deliverable
docs/                         method notes (full and short)
tools/check-release-metadata.mjs  holds every version and date stamp to CITATION.cff
CITATION.cff, .zenodo.json    citation and archive metadata
LICENSE, NOTICE               MIT for code, CC BY 4.0 for documentation, third-party notices
```

## Building and release

`scripts/build-standalone.sh` inlines the stylesheet, the vendored libraries
and the modules (stripping their `import` lines and handing the names back
from one shared object) into `dist/Massing-Studio.html`. It reads the
version and date from `index.html`'s meta tags and refuses to build if they
are missing, so the bundle cannot announce a version the source has moved
past. Rebuild after any change to `index.html`, `css/` or `js/`, and commit
both.

`tools/check-release-metadata.mjs` (15 checks) holds every version and date
stamp to `CITATION.cff`: `.zenodo.json`; the version and date meta tags in
`index.html`; the same pair in the built `dist/Massing-Studio.html`, so a
build left behind after a bump fails; the README's `vX · date` stamp; and
both method notes pages, whose bylines must name the version and the date
spelled long, and whose citations must use the version DOI once it is minted
and the concept DOI until then. There is no separate automated test suite:
changes are checked by driving the built file in a browser.

A release goes: bump every stamp, rebuild, run the guard, cut the tag, let
Zenodo archive it, then record the new version DOI in a separate commit.
