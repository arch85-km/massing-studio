# Changelog

Every release of Massing Studio, newest first. Each entry is a summary; the
release page linked from its heading has the full notes, and a version DOI
resolves to the archived copy of exactly that build. To cite the software in
general rather than one build, use the concept DOI
[10.5281/zenodo.22814301](https://doi.org/10.5281/zenodo.22814301).

## Unreleased

On `main` since 1.2.0, not yet in a release:

- **Added** the About panel opens with "What it is for": a teaching and
  early-design tool whose results are indicative, not for compliance or
  certification.
- **Changed** the cube device (the icon and logo) is reserved from both
  licences, in `NOTICE`, the About panel and the Zenodo metadata.
- **Docs** the three teaching exercises are removed from the method notes:
  they were not written by the author.
- **Docs** `ARCHITECTURE.md`, `CHANGELOG.md` and `DESIGN.md`, and a "How this
  was developed" statement in the README, the method notes and the Zenodo
  metadata.

## [1.2.0](https://github.com/arch85-km/massing-studio/releases/tag/v1.2.0) — 4 October 2026

Version DOI [10.5281/zenodo.23143500](https://doi.org/10.5281/zenodo.23143500)

- **Added** the licence, credits, release and citation, inside the app:
  click **© Karam Al-Obaidi** at the bottom of the window.
- **Changed** the tab icon travels inside the file, so a copy opened from
  disk or another domain shows the same mark.
- **Fixed** the build script kept its own copy of the version and date, which
  had drifted a release behind; it now reads both from `index.html` and
  refuses to build without them.

## [1.1.0](https://github.com/arch85-km/massing-studio/releases/tag/v1.1.0) — 26 September 2026

Version DOI [10.5281/zenodo.22982508](https://doi.org/10.5281/zenodo.22982508)

- **Added** levels at their own elevations, with a Levels panel, "Stack copy
  on top", Alt+drag to lift a volume, and "Colour as gradient".
- **Added** orthographic Front / Back / Left / Right elevations with labelled
  level lines, and a perspective / orthographic toggle.
- **Added** measuring: a Dimension tool (in plan or on the model), an Area
  tool, and width × depth, footprint area, perimeter and volume in
  Properties.
- **Added** a Curve tool, and editable points on polygons and curves.
- **Added** Intersect, Union and Subtract between two volumes.
- **Added** a 24-colour palette, a custom colour picker, per-shape opacity,
  edge lines and X-ray mode.
- **Added** high-resolution PNG or JPEG export of the 3D view, on a
  transparent, white or dark background.
- **Added** "Save as .obj", readable in Rhino, Blender and SketchUp and
  reopened here fully editable; straight extrusions from other programs'
  .obj files open as editable shapes.
- **Fixed** moving, scaling and push/pull snap to the grid, to other shapes'
  corners and to other volumes' tops.
- **Fixed** toolbar menus are no longer cut off on phones.
- **Fixed** the first level above the Ground Floor is named "Floor 1".
- **Docs** the status bar's GFA and per-level areas add up footprints, not
  floors; the method notes explain this before a number is cited.

Projects saved in 1.0.0 open in 1.1.0 unchanged.

## [1.0.0](https://github.com/arch85-km/massing-studio/releases/tag/v1.0.0) — 17 September 2026

Version DOI [10.5281/zenodo.22814302](https://doi.org/10.5281/zenodo.22814302)

First public release. Draw rectangles, circles, freeform polygons and
reference lines on a snapping plan grid; extrude any closed shape, or push
and pull it in 3D, wall by wall, edge by edge or by a circle's radius. Copy,
cut and paste, undo and redo. Import DXF drawings, OBJ reference models and
images as a traceable underlay; export OBJ, binary STL, PNG and DXF.
Split-screen 2D and 3D, camera presets, touch support, and projects saved
as JSON.
