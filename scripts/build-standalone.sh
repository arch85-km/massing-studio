#!/bin/bash
# Bundles the whole app (ES modules + vendored Three.js) into one
# self-contained dist/Massing-Studio.html — no separate asset files to
# host, so it can be dropped straight into a website.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dist/Massing-Studio.html"

# Print a JS module without its `import ... ;` statements (single- or
# multi-line) and with a leading `export ` stripped from each declaration.
# Matching by pattern, not by line number, so editing a module's imports
# can't silently break the bundle.
strip_module() {
  awk '
    skipping { if ($0 ~ /;[[:space:]]*$/) skipping = 0; next }
    /^import[[:space:]]/ { if ($0 !~ /;[[:space:]]*$/) skipping = 1; next }
    { sub(/^export /, ""); print }
  ' "$1"
}

# The modules below get their imports back as destructuring from App —
# the names are read from each module's own import statements.
imported_names() {
  awk '
    /^import[[:space:]]/ { grab = 1 }
    grab { buf = buf " " $0; if ($0 ~ /;[[:space:]]*$/) grab = 0 }
    END { print buf }
  ' "$1" | grep -oE "import[[:space:]]*\{[^}]*\}[[:space:]]*from[[:space:]]*'\./[^']+'" \
         | sed -E "s/import[[:space:]]*\{([^}]*)\}.*/\1/" | tr ',' '\n' | tr -d ' ' | grep -v '^$' | paste -sd, - | sed 's/,/, /g'
}
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# ---- head + styles ----
cat > "$OUT" <<'HTMLHEAD'
<!-- Massing Studio v1.1.0 — 2026-09-26 -->
<!doctype html>
<html lang="en">
<head>
  <!--
HTMLHEAD

cat vendor/three/three.LICENSE >> "$OUT"
echo '' >> "$OUT"
echo 'polygon-clipping (vendor/polygon-clipping/), bundled below:' >> "$OUT"
cat vendor/polygon-clipping/polygon-clipping.LICENSE >> "$OUT"

cat >> "$OUT" <<'LICENSENOTE'

Massing Studio's own source code is MIT licensed (see LICENSE in the
project repository). Accompanying documentation, screenshots, and
exercises are licensed separately under CC BY 4.0 (see NOTICE),
https://creativecommons.org/licenses/by/4.0/
LICENSENOTE

cat >> "$OUT" <<'HTMLHEAD2'
  -->
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Massing Studio</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 160.50 160.50%22><style>:root{--a:%23A1ADB7;--b:%233D3D3D;--c:%23CA1C2F}%40media(prefers-color-scheme:dark){:root{--a:%23B9C4CC;--b:%236E7175;--c:%23E03145}}</style><path fill=%22var(--a)%22 d=%22M13.51 40.63 L80.25 1.00 L146.99 40.63 L80.25 80.25Z%22/><path fill=%22var(--b)%22 d=%22M80.25 80.25 L146.99 40.63 L146.99 119.88 L80.25 159.50Z%22/><path fill=%22var(--c)%22 d=%22M13.51 40.63 L80.25 80.25 L80.25 159.50 L13.51 119.88Z%22/></svg>" />
  <meta name="description" content="Massing Studio — a browser-based plan drawing and extrusion tool." />
  <meta name="version" content="1.1.0" />
  <meta name="date" content="2026-09-26" />
  <style>
HTMLHEAD2

cat css/style.css >> "$OUT"

cat >> "$OUT" <<'AFTERSTYLE'
  </style>
</head>
<body>
AFTERSTYLE

# ---- body markup: everything after <body> up to (not including) the
#      vendored-script / importmap block at the end of index.html ----
awk '
  /<body>/ { inside = 1; next }
  /<!-- polygon-clipping ships as a UMD bundle/ || /<script / { if (inside) exit }
  inside { print }
' index.html >> "$OUT"

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

# ---- polygon-clipping (UMD — defines window.polygonClipping by itself) ----
echo '  <script>' >> "$OUT"
cat vendor/polygon-clipping/polygon-clipping.umd.js >> "$OUT"
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
strip_module js/state.js >> "$OUT"
echo '  App.nextId = nextId; App.Store = Store; App.levelGradient = levelGradient;' >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- geometry.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
strip_module js/geometry.js >> "$OUT"
# every exported function of geometry.js, published on App
echo "  Object.assign(App, { $(grep -oE '^export function [A-Za-z0-9_]+' js/geometry.js | awk '{print $3}' | paste -sd, -) });" >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- booleans.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
echo "  const { shapePoints, polygonArea, shapeBaseZ } = App;" >> "$OUT"
strip_module js/booleans.js >> "$OUT"
echo '  App.booleanShapes = booleanShapes;' >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- objio.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
echo "  const { $(imported_names js/objio.js) } = App;" >> "$OUT"
strip_module js/objio.js >> "$OUT"
echo '  App.buildProjectOBJ = buildProjectOBJ; App.extractProjectJSON = extractProjectJSON; App.reconstructFromOBJ = reconstructFromOBJ;' >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- canvas2d.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
echo "  const { $(imported_names js/canvas2d.js) } = App;" >> "$OUT"
strip_module js/canvas2d.js >> "$OUT"
echo '  App.Plan2D = Plan2D;' >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- scene3d.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App, THREE){' >> "$OUT"
echo "  const { $(imported_names js/scene3d.js) } = App;" >> "$OUT"
echo "  const { OrbitControls, OBJExporter, OBJLoader, STLExporter } = THREE;" >> "$OUT"
strip_module js/scene3d.js >> "$OUT"
echo '  App.Scene3D = Scene3D;' >> "$OUT"
echo '  })(window.App, window.THREE);' >> "$OUT"
echo '  </script>' >> "$OUT"

# ---- main.js ----
echo '  <script>' >> "$OUT"
echo '  (function(App){' >> "$OUT"
echo "  const { $(imported_names js/main.js) } = App;" >> "$OUT"
strip_module js/main.js >> "$OUT"
echo '  })(window.App);' >> "$OUT"
echo '  </script>' >> "$OUT"

echo '</body>' >> "$OUT"
echo '</html>' >> "$OUT"

echo "DONE: $(wc -c < "$OUT") bytes, $(wc -l < "$OUT") lines"
