# Design decisions

The decisions behind Massing Studio, and my reasons for them.
[`ARCHITECTURE.md`](ARCHITECTURE.md) describes how the code is organised, and
[`docs/method-notes.html`](docs/method-notes.html) describes its conventions
and limits. This file records why the tool is the way it is. Written in
October 2026, at version 1.2.0.

— Karam Al-Obaidi

## Why it exists

My students needed to go from a plan diagram to a 3D massing they could
measure and export, at the earliest stage of design. The tools they had did
not fit that moment:

- **SketchUp** has the push/pull students know, but licensing, installation
  and the limits of the free web version got in the way.
- **Rhino and Revit** are too steep, or ask for too much detail, for a first
  plan-to-volume exercise: BIM wants walls and doors before the idea exists.
- **Physical models** in card or foam are quick to make, but give nothing to
  measure, export or take into another tool.

## Why it runs in the browser

- **University-managed machines.** Nothing to install, no admin rights, no
  licences, nothing for IT to approve.
- **Any device, and embeddable.** It runs on students' own laptops and phones,
  and sits inside my website.

## The model

### Every volume is a straight extrusion

A volume is a footprint extruded straight up: no roofs, slopes or openings.

- **It keeps the lesson clear.** The exercise is plan to volume; roofs and
  openings belong to a later stage and a fuller tool.
- **It keeps the tool light enough for a browser.** A general solid modeller
  would be too heavy and too slow for a browser tab.

### GFA is a sum of footprints

The status bar's GFA adds up footprints, not floors, and the method notes
warn about it before a number is quoted. The tool cannot know whether a tall
volume is one storey or three: levels are only named elevations. So it does
not pretend to count storeys.

### Conventions borrowed from SketchUp and AutoCAD

Push/pull comes from SketchUp; the snap grid, object snap and DXF from
AutoCAD.

- **Skills transfer.** Students meet the same gestures again in the
  professional tools, so nothing learned here is wasted.
- **Familiar on day one.** Students who have seen either tool start without a
  tutorial.
- **Precision with speed.** A snap grid and object snap make a sketch exact
  enough to measure and export, without slowing the drawing down.

### One file for the .obj round trip

"Save as .obj" writes geometry that Rhino, Blender and SketchUp open, with
the whole project inside the same file, so it reopens here fully editable.

- **One file cannot drift.** A model and a separate project file inevitably
  fall out of step.
- **Moving between tools.** Students take the massing into Rhino, Blender or
  SketchUp and bring it back without losing their work.
- **Easy to hand in.** One file to submit or share, which tutors and other
  programs can open.

## Teaching

I use the tool in undergraduate and postgraduate teaching. Three features of
1.1.0 came from watching students use 1.0.0:

- **Levels**, because students needed separate floors at their own
  elevations;
- **the measuring tools**: dimensions, areas, and footprint, perimeter and
  volume in Properties;
- **the editable .obj round trip**, because students moved between Massing
  Studio and Rhino, Blender or SketchUp.

Massing Studio has no exercises of its own. The method notes carried three
that I had not written; I removed them in October 2026 rather than leave
them standing as if they were mine.

## What it deliberately leaves out

- **Analysis of any kind.** No daylight, thermal, structural or cost figures;
  my other applications handle analysis.
- **BIM and parametrics.** No walls, doors or windows as objects, and no
  parametric constraints.
- **Materials and thickness.** A shape has a colour, an opacity and a height,
  nothing else.
- **Links between shapes.** A boolean result or a stacked copy does not follow
  its source.
- **Accounts and collaboration.** No log-in, no cloud storage, no multi-user
  editing; everything stays on the device.

## How a release is checked

There is no automated test suite. Before I teach with a release:

- **I use the live site myself**, drawing, extruding and exporting as a
  student would.
- **Problems students report** in class are fixed in the next release.

## Licensing and archiving

The code is MIT and the teaching material is CC BY 4.0:

- **The code is free to reuse.** Anyone can adapt or embed it.
- **The material is reusable with credit.** Other educators can use the notes
  in their own courses, crediting the source.
- **The cube mark is reserved from both**, so a modified copy cannot pass
  itself off as mine.
- **Open licensing is expected** of this kind of work by my university or
  funders.

Every version is archived on Zenodo with its own DOI:

- **Reproducible figures.** A reported number can be traced to the exact build
  that produced it.
- **A citable research output.** The software counts as an output in its own
  right.
- **A permanent archive.** Each version survives even if my website changes.
- **Credit when reused.** Anyone who uses it has a proper way to cite it.

## How this was developed

I designed the application. I defined the problem and the scope: what the tool
is for, who it is for and what it leaves out. I chose the methods and the
sources it relies on. I tested it in use, found and reported the bugs,
judged whether each fix worked, and decided what was released and when.

The code was written with an AI coding assistant, working to my specification
and direction. It wrote most of the code, drafted the documentation, which I
reviewed, diagnosed bugs and proposed fixes, which I then tested, and wrote and
ran the release checks. I retain full intellectual responsibility for the
design, the methods and the results, including any errors.

## Next

- **Roofs and slopes**: a step beyond the straight-extrusion rule, for the
  stage after a first massing.
- **A link to the analysis applications**: sending a massing straight into
  Solar Analysis Lab or Daylight Lab.
