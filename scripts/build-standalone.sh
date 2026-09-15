#!/bin/bash
# Bundles the whole app (ES modules + vendored Three.js) into one
# self-contained dist/Massing-Studio.html — no separate asset files to
# host, so it can be dropped straight into a website.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dist/Massing-Studio.html"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# ---- head + styles ----
cat > "$OUT" <<'HTMLHEAD'
<!-- Massing Studio v1.0.0 — 2026-09-15 -->
<!doctype html>
<html lang="en">
<head>
  <!--
HTMLHEAD

cat vendor/three/LICENSE >> "$OUT"

cat >> "$OUT" <<'LICENSENOTE'

Massing Studio's own source code is MIT licensed (see LICENSE in the
project repository). Accompanying documentation, screenshots, and
exercises are licensed separately under CC BY 4.0 (see LICENSE-DOCS),
https://creativecommons.org/licenses/by/4.0/
LICENSENOTE

cat >> "$OUT" <<'HTMLHEAD2'
  -->
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Massing Studio</title>
  <meta name="description" content="Massing Studio — a browser-based plan drawing and extrusion tool." />
  <meta name="version" content="1.0.0" />
  <meta name="date" content="2026-09-15" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='18' fill='%230d1117'/%3E%3Cpath d='M20 70 L20 30 L50 15 L80 30 L80 70 L50 85 Z' fill='none' stroke='%234fa3ff' stroke-width='6'/%3E%3Cpath d='M20 30 L50 45 L80 30 M50 45 L50 85' fill='none' stroke='%234fa3ff' stroke-width='6'/%3E%3C/svg%3E" />
  <style>
HTMLHEAD2

cat css/style.css >> "$OUT"

cat >> "$OUT" <<'AFTERSTYLE'
  </style>
</head>
<body>
AFTERSTYLE

# ---- body markup (between <body> and the old importmap) ----
sed -n '14,155p' index.html >> "$OUT"

# ---- app namespace ----
cat >> "$OUT" <<'NAMESPACE'

  <script>
    window.App = {};
  </script>
NAMESPACE

# ---- three.module.js (wrapped, last "export {...}" line becomes window.THREE = {...}) ----
echo '  <script>' >> "$OUT"
echo '  (function(){' >> "$OUT"
sed -e '$ s/^export /window.THREE = /' vendor/three/three.module.js >> "$OUT"
echo '  })();' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- OrbitControls.js ----
echo '  <script>' >> "$OUT"
echo '  (function(THREE){' >> "$OUT"
sed -e "1,12c\\
const { EventDispatcher, MOUSE, Quaternion, Spherical, TOUCH, Vector2, Vector3, Plane, Ray, MathUtils } = THREE;" \
    -e '$s/^export { OrbitControls };$/THREE.OrbitControls = OrbitControls;/' \
    vendor/three/controls/OrbitControls.js >> "$OUT"
echo '  })(window.THREE);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- OBJExporter.js ----
echo '  <script>' >> "$OUT"
echo '  (function(THREE){' >> "$OUT"
sed -e "1,6c\\
const { Color, Matrix3, Vector2, Vector3 } = THREE;" \
    -e '$s/^export { OBJExporter };$/THREE.OBJExporter = OBJExporter;/' \
    vendor/three/exporters/OBJExporter.js >> "$OUT"
echo '  })(window.THREE);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- OBJLoader.js ----
echo '  <script>' >> "$OUT"
echo '  (function(THREE){' >> "$OUT"
sed -e "1,16c\\
const { BufferGeometry, FileLoader, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Loader, Material, Mesh, MeshPhongMaterial, Points, PointsMaterial, Vector3, Color } = THREE;" \
    -e '$s/^export { OBJLoader };$/THREE.OBJLoader = OBJLoader;/' \
    vendor/three/loaders/OBJLoader.js >> "$OUT"
echo '  })(window.THREE);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- STLExporter.js ----
echo '  <script>' >> "$OUT"
echo '  (function(THREE){' >> "$OUT"
sed -e "1c\\
const { Vector3 } = THREE;" \
    -e '$s/^export { STLExporter };$/THREE.STLExporter = STLExporter;/' \
    vendor/three/exporters/STLExporter.js >> "$OUT"
echo '  })(window.THREE);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- state.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
sed -e 's/^export //' js/state.js >> "$OUT"
echo '  App.nextId = nextId; App.Store = Store;' >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- geometry.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
sed -e 's/^export //' js/geometry.js >> "$OUT"
echo '  App.snap = snap; App.snapPoint = snapPoint; App.dist = dist; App.findNearestVertex = findNearestVertex; App.shapePoints = shapePoints; App.pointInPolygon = pointInPolygon; App.distToSegment = distToSegment; App.hitTestShape = hitTestShape; App.centroid = centroid; App.boundsOf = boundsOf; App.lineIntersect = lineIntersect; App.polygonArea = polygonArea;' >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- canvas2d.js (drop its two import statements, lines 4-8) ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
echo "  const { nextId, snapPoint, dist, findNearestVertex, shapePoints, hitTestShape, centroid, boundsOf } = App;" >> "$OUT"
sed -e '4,8d' -e 's/^export //' js/canvas2d.js >> "$OUT"
echo '  App.Plan2D = Plan2D;' >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- scene3d.js (drop its six import statements, lines 4-9) ----
echo '  <script>' >> "$OUT"
echo '  (function(App, THREE){' >> "$OUT"
echo "  const { shapePoints, distToSegment, polygonArea, lineIntersect } = App;" >> "$OUT"
echo "  const { OrbitControls, OBJExporter, OBJLoader, STLExporter } = THREE;" >> "$OUT"
sed -e '4,9d' -e 's/^export //' js/scene3d.js >> "$OUT"
echo '  App.Scene3D = Scene3D;' >> "$OUT"
echo '  })(window.App, window.THREE);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- main.js (drop its three import statements, lines 4-6) ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
echo "  const { Store, nextId, Plan2D, Scene3D } = App;" >> "$OUT"
sed -e '4,6d' js/main.js >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

echo '</body>' >> "$OUT"
echo '</html>' >> "$OUT"

echo "DONE: $(wc -c < "$OUT") bytes, $(wc -l < "$OUT") lines"
