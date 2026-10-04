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
  <link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADCklEQVR42u2XX0hTcRTHv+fujlkx7SVXY+SfCizSHoIJUYEROOwhsqCgPxK9ZaBhSj0VBO0l+0MU9BBKmUFlUeR1qwirH8JmPVQimSFaUUwldJI1t/1OLykRd+7ezdGL5/X87u/7ueec3+EcQoqmaZpt5BdqAWBJFi5UVFREUrmHUvmo6Z7PQywvE6gQABg8wKRUH6z0+DIK0HTXX0QkzxPg0fMz4LOytXrvrq0Dcwpw7YGwq9HwaRBVA1BnO8vgCEDn4qrde2j7xom0AE4xK/n3/VVg6SWQw0y0GBwCKSeqdpQ3ExGbBrh+11/KJK8CWId0jDlAsNQc2FUeMATQ0qa54qAzAPalWqT65YEWIuXYgcryYV0ATdNsIz+VBoY8TqCFyIQxh1nB6dwsXJp+tpZp35FA37YFQ5/3TKxd44LFYs2E/lQsGn/26P5Cf0f76ODgYB8AKNNOZTKi2N/1blndcHIsJ/A6ONfiH3rfBm9caRz7NNBfFovFZnRVnTA5na13nLntj4NDhw85ppbm5qUjPPZ9dEhruxWa/DHh1vMnfNPq+Lh7hbcxMrGu+MWX/btLYbXaTIU7OjXZ2fEg8GmgfwOAhD+hJmkTNvubns1FPb1D33bvDI2XrncbDffLJ+0uZi5LdlY11C7jMs/ZeicvWVqShTtlgGRpicaikee+h8HBj33u2cKdNoBeWrrtVoinmkNKuSmVIp0BUABmMxhxmee8eXv5i8Ic091SSin/0v2/Ng8wDzAPMAOw+OtPHyTXMxA23gzIVA9g5rCUsj4UCvkTjmRvHCW5v1ScJWCfEYG6gmwjwgygRUp5rKura9jQUPrKVVIaZ7pKNPtQmgyAmQMAaoQQxobSfyZJpdtZXMVEXiL9sTwRADOHAJwQQjT/GUrNFyEB0v31XVNOJLIKzBeZETOQ6ggALzOvEkI0zSZuejV75SwukgqdB8ijFwFm9gGoFkLM7Wr2rwWXlXhgwWWACusKssHM7wEcFUJkdjn92/qx0vbdtai2Lt8OVVUbOzs7Y6nc8xunF1fQJyD/CgAAAABJRU5ErkJggg==" />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAuNTAgMTYwLjUwIj48c3R5bGU+QG1lZGlhKHByZWZlcnMtY29sb3Itc2NoZW1lOmRhcmspey5he2ZpbGw6I0I5QzRDQ30uYntmaWxsOiM2RTcxNzV9LmN7ZmlsbDojRTAzMTQ1fX08L3N0eWxlPjxwYXRoIGNsYXNzPSJhIiBmaWxsPSIjQTFBREI3IiBkPSJNMTMuNTEgNDAuNjMgTDgwLjI1IDEuMDAgTDE0Ni45OSA0MC42MyBMODAuMjUgODAuMjVaIi8+PHBhdGggY2xhc3M9ImIiIGZpbGw9IiMzRDNEM0QiIGQ9Ik04MC4yNSA4MC4yNSBMMTQ2Ljk5IDQwLjYzIEwxNDYuOTkgMTE5Ljg4IEw4MC4yNSAxNTkuNTBaIi8+PHBhdGggY2xhc3M9ImMiIGZpbGw9IiNDQTFDMkYiIGQ9Ik0xMy41MSA0MC42MyBMODAuMjUgODAuMjUgTDgwLjI1IDE1OS41MCBMMTMuNTEgMTE5Ljg4WiIvPjwvc3ZnPg==" />
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
