# topology-of-us

React + Vite + three.js. A single page with tabs, each showing two parametric surfaces (lavender "top", blue "bottom") stitched along seams into torus-like shapes, rendered to look like a low-res, palette-quantised GIF.

```
npm run dev     # local dev server
npm run build   # production build (the >500 kB chunk warning is three.js; ignore)
npm run lint    # oxlint; keep it at zero warnings
```

## Verifying changes

- Do not take screenshots, install puppeteer/playwright, or start servers to inspect rendering. The user checks visuals themselves, often on a phone via the GitHub Pages site.
- Verify with `npm run lint` and `npm run build`, plus throwaway Node scripts for geometry maths (seam gaps, extents, normals, NaNs). Keep those scripts in `$TEMP` or the scratchpad, never in the repo, and delete them afterwards. Import three by absolute file URL (`node_modules/three/build/three.module.js`), because scripts outside the project can't resolve `'three'`.
- Shader compile errors only show at runtime, so say plainly that the result is unseen.

## Deploying

- `.github/workflows/deploy.yml` runs lint and build and publishes `dist/` to GitHub Pages (https://kyuubimode7.github.io/topology-of-us/) on every push to `main`. Only `main` deploys.
- The user has approved committing and pushing straight to `main` so changes show up on Pages. Lint and build must pass before every push.
- `vite.config.js` uses `base: './'` so the build works from the `/topology-of-us/` subpath.
- `npm install` in the cloud container rewrites `package-lock.json` (npm version churn). Revert it with `git checkout package-lock.json` unless dependencies actually changed.

## Files

- `src/surfaces.js`: all geometry. Shape definitions (`SHAPES`), the shared sampling grid, `sampleSurface` / `createSurfaceGeometry` / `writeSurface`, the seeded RNG, and the roll-up animation.
- `src/SurfacePair.jsx`: renderer, shaders, post-process quantisation, morph/animation state, pointer drag physics, pinch/wheel zoom.
- `src/App.jsx` + `src/App.css`: tabs and controls (seed, bands, replay). The page is dark-only, by request.

## Mobile

- The site must work on phones. The canvas width is clamped in `SurfacePair.css` to the viewport's width and height (`--size` is the preferred width from the `size` prop). Phones in landscape switch `.page` to a grid with the canvas beside the tabs and controls (`App.css`).
- Touch targets grow under `(pointer: coarse)`; narrow screens (≤ 480 px) stack the controls. Tabs scroll sideways rather than widen the page.
- The canvas has `touch-action: none`, so it can't scroll the page. Keep enough of the page outside it to scroll.
- Input: one finger drags (only the first pointer); two fingers pinch-zoom the ortho camera (`camera.zoom`, 1–4×); the wheel zooms on desktop. A pinch ends the drag, and the drag restarts only on a fresh touch. Zoom is the only thing allowed to crop the ±2 frame.

## Shape model (surfaces.js)

- A shape's `build(seed)` returns `{ top, bottom }`. Each is `fn(u, v, out[, t]) -> Vector3` with u, v in [0, 1]. u runs around the ring. v crosses the surface from seam to seam: top goes outer seam → over → inner seam; bottom goes inner → under → outer.
- `stitchedPair` evaluates both surfaces from the same seam points, so seams close exactly. `open.outer/inner(u)` returns `[topTrim, bottomTrim]` radians, which pulls a lip back along its own arc to tear the seam.
- Open seam: each seed picks a whole-number connected percentage (10–90%) of both seams together, measured in u. `randomOpening` splits the open part between the seams and into non-overlapping tears, so the percentage is exact. Keep tears non-overlapping, or the caption stops being true.
- Meeting: not a ring, and it doesn't tumble (`tumble: false`). By request it is **two copies of Roll up's flat rectangle (3.2 × 1.3, never resized) in the world xy plane**, joined along their long edges, one each side of the seam line. No curved types, outlines, hinges or per-seed scaling; earlier attempts at those were rejected.
- The seed only places the pair. It slides B along A's long edge in whole u-grid-line steps (3.2 / 24), so the cross lines run straight over the seam. Connected is 33–100%, because less overlap can't fit the frame at this size. It then turns the pair in place about z, choosing only among angles whose corners fit the frame from the fixed camera at rest. `VIEW_RIGHT`/`VIEW_UP` copy the camera in SurfacePair; keep them in sync. The caption's connected % is overlap ÷ combined span.
- Meeting is the one exception to the ±2 rule: it fits at rest, but dragging can push corners past the frame. The user accepted this. Grid lines are Roll up's `[24, 4]`. Like Roll up, the short sides have no seam outline. Seed changes morph points in straight lines, so a big turn pinches slightly mid-morph (accepted; a rotating morph was offered).
- A build may return a `caption` (what the seed picked), which `App.jsx` shows next to the seed slider. It may also return `iso: { top, bottom }`, (u, v) → [a, b] isocurve coordinates. Lines are drawn where a or b is a whole number. The default is `gridIso(shape.isocurves)`. Iso grids morph along with positions. Seam darkening still uses the uv attribute's v edges.
- `tumble: false` shapes don't spin on their own; the view eases back to the reference angle.
- A `null` surface is hidden: it morphs onto the other surface, hides, then tracks it so it can peel off later. `animation: { duration }` shapes take `t` in [0, 1] and play after the morph.
- **Every shape uses the one `SEGMENTS` grid (144 × 24).** Morphing lerps grid points one to one, so don't give a shape its own resolution.
- **Normals must point out of the shell** (du × dv outward). The shader treats back faces as the inside (darker colour, shadow-mapped). New parametrisations must keep that orientation; check it numerically.
- Waves around the ring need integer frequencies so u = 0 and u = 1 match.
- Seeded shapes draw from the RNG in a fixed order, and Open seam draws the body first so it matches Stitched for the same seed. Adding, removing or reordering draws changes every seed's shape, so tell the user when that happens.
- Keep all shapes inside the ±2 ortho frame at every point of every animation. Measure the max extent across seeds and t values.

## Rendering rules (SurfacePair.jsx)

- The look derives from a spec for a reference GIF. Keep these rules:
  - z-up world (`Object3D.DEFAULT_UP`).
  - Fixed ortho camera from (-1, -1, 2).
  - Tumble about world Y, 12 s per revolution.
  - Light fixed in camera space (-0.4, 0.7, 0.6).
  - Shading `0.66 + 0.34·n·L`, plus spec `(n·L)^12 · 0.25`.
  - Canvas mirrored with CSS `scaleX(-1)`. Horizontal drag is negated to match.
- **Colours are raw sRGB.** Pass them as `vec3` uniforms from 0–255 arrays. Never use `THREE.Color`, and never include three's colorspace or tone-mapping chunks.
- Pipeline:
  1. Shadow depth pass from the light.
  2. Scene at `resolution × SS` (300 × 4).
  3. Post pass: box-filter each 4 × 4 block, un-premultiply, 1-bit alpha at 50%, then snap to a fixed palette with no dithering.
  4. Canvas shown with `image-rendering: pixelated`.
- **Any new colour the mesh shader can output must also be added to the post-pass palette** (the `candidates` loop). Otherwise it gets snapped to the wrong colour. The palette currently has outside shade, inside shade, isocurve (lighter) and seam (darker) variants of each hue.
- Only the inside (back faces) receives cast shadows. The outside keeps the shadow-free reference look.
- Meshes and materials live in a lazily created ref (`getModel()`), touched only from effects. This avoids react-lint immutability warnings and lets seed/shape changes skip rebuilding the renderer.

## Gotchas

- Don't rewrite source files with PowerShell `Set-Content`/`Out-File`. They add a UTF-8 BOM and bypass the editor's file tracking. Use the Edit/Write tools.
