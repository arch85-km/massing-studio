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
  <link rel="icon" type="image/png" sizes="16x16" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAADMUlEQVR42l2Ty2ucVRyGn3O+833zzTWZTpIxsbEmjbY2xUCIUDEIbrIKbRXTXRf+DYKgQaZjF+LGuhBBRISGEgm0pGldGKJCKNhKL7Y0ITUhJp1cbMmkbS4z893OcWEdqs/y5cfDu/i98AxjY2MWUgJw9uxY18j45KVz45PjX49e2A8ghPjn5hkEQKFQkADFYlEbsEa/v/RBlG183/aDHIBUqry7vXXmvRODnwFhwRjJqVMUi0UtnkoMwMj41Nt2tfJRbuHPvkcNaSr72rUFbK6vyZpfoznfdt2OxU6fPD4wUW9gjBEjlye7SWc/dXcrg5ExeNVKmC2tWWG5LO4kFCqXM+25ligejysjJLGYO7H95MnwyXcGZqQQwnR88nnhpemrg9s69AOBdhxH/So88cP0JAdHL/DaX4+EdmPKE0JHYejPz94+ev7cN0UhhFEAiaX7fvrMl9GBw6/ImYE35dTc7yzem+UFyyG1UyX/xVfEe19l5q035NTsTbm+OB8ZgQ+gALRjKz+ZtPbMzoUba4v8kU+RSaaw/QijLMKGNM23Z3lQWmC+JcFzqbRV9TwJIAGiRDyQYYS2bWQqheM46DDEC0O8IMAKQkI3hkwmUZYiiiIc1w3qDYLGBlNpS+KUVtFeDaMVra3P09H5Mt5WjZ1bd2lcXiHyPGLxJlqb8uxUK9QF8eUV5WYyVJqbsPe4HO7tpq/jINnmFkIhKPX0oH67RXJ9iWzGZuPhA7Z2tu26wLgOVq0WOUvL5HczdO4/gN+cp2oJEpGhtreNy/cX2JwrU94OSCg7UkrpugBjnKRyrArGt6o13TZ6Xuor13j47jFmkzZXf/6Rx2urdBlLW6mYdhzHqVSrDoBlQKxm8jOeNu1JIQ9txJSIWypMlx8L58ZN8d3KHJvVHZNx3CiHtMoxyyKILkZaf1wqlTaUAMPKnbvA0ZnWnuNGm+GskX3GdQmk0cpSOLaSAqEi378eoE9fmZ6uv7IEKIA0ILvXb4+fmO844utoWBhdTiKltCyJ1huVKPzw231tR679Mj3xdHyS/2MYqk/1xt5DXT+92Dtx7PX+i339/Z3/5kNDQ/+Z899T2men3HRXcAAAAABJRU5ErkJggg==" />
  <link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,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" />
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
