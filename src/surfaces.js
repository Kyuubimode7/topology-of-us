import * as THREE from 'three'

const TAU = Math.PI * 2

// Superellipse-style shaping: p = 2 is a circle, larger p is boxier.
const spow = (x, e) => Math.sign(x) * Math.abs(x) ** e

/*
 * A shape is two surfaces stitched along two shared seam curves.
 *
 * Around the ring (u in [0,1], azimuth 2*PI*u) each cross-section lives in the
 * (rho, z) half-plane. The seam points are
 *   A = outer seam = (R + w, z0 + tilt)
 *   B = inner seam = (R - w, z0 - tilt)
 * and each surface is an arc between A and B, bulging away from the chord:
 *   top:    theta = PI * v          (A -> over the top -> B)
 *   bottom: theta = PI + PI * v     (B -> underneath -> A)
 *   P = M + c * cos'(theta) + n * h(u, theta) * sin'(theta)
 * with M the chord midpoint, c = A - M, n the unit chord normal pointing +z.
 * Both surfaces evaluate the same A and B, so the seams match exactly.
 *
 * Optional `open.outer(u)` / `open.inner(u)` return [topTrim, bottomTrim] in
 * radians: each surface's edge is pulled back along its own arc by that much,
 * opening a gap in that seam. Zero trim leaves the seam closed.
 */
const CLOSED = () => [0, 0]

function stitchedPair({ ring, seam, top, bottom, open = {} }) {
  const { outer = CLOSED, inner = CLOSED } = open
  const point = (side, u, v, out) => {
    const R = ring(u)
    const { w, z0, tilt } = seam(u)
    const [outerTop, outerBottom] = outer(u)
    const [innerTop, innerBottom] = inner(u)
    const theta =
      side === top
        ? outerTop + (Math.PI - outerTop - innerTop) * v
        : Math.PI + innerBottom + (Math.PI - innerBottom - outerBottom) * v
    const e = 2 / side.exponent
    const cs = spow(Math.cos(theta), e)
    const sn = spow(Math.sin(theta), e)
    const h = side.bulge(u, theta)

    // c = (w, tilt), n = (-tilt, w) / |c|
    const len = Math.hypot(w, tilt)
    const rho = R + w * cs + (-tilt / len) * h * sn
    const z = z0 + tilt * cs + (w / len) * h * sn

    const phi = TAU * u
    return out.set(rho * Math.cos(phi), rho * Math.sin(phi), z)
  }
  return {
    top: (u, v, out) => point(top, u, v, out),
    bottom: (u, v, out) => point(bottom, u, v, out),
  }
}

// Every shape is sampled on this one (u, v) grid per surface, so any two
// shapes can be morphed point for point.
export const SEGMENTS = [144, 24]
const [U_SEG, V_SEG] = SEGMENTS
const COLS = U_SEG + 1
const QUADS = U_SEG * V_SEG
// Two triangles per quad: corner offsets (di, dj) in winding order.
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]

// Grid points of fn, (V_SEG + 1) rows of COLS points, packed xyz. Pass `grid`
// to reuse an array (e.g. every frame of an animation).
export function sampleSurface(fn, grid = new Float32Array(COLS * (V_SEG + 1) * 3)) {
  const p = new THREE.Vector3()
  for (let j = 0; j <= V_SEG; j++) {
    for (let i = 0; i <= U_SEG; i++) {
      // u = 1 evaluates the same point as u = 0, but keeps the uv attribute
      // continuous so the shader's derivatives don't spike at the wrap.
      fn(i / U_SEG, j / V_SEG, p).toArray(grid, (j * COLS + i) * 3)
    }
  }
  return grid
}

// Non-indexed so every quad gets one flat normal (the painter's-algorithm
// look). Positions and normals are filled by writeSurface.
export function createSurfaceGeometry() {
  const uvs = new Float32Array(QUADS * 12)
  let k = 0
  for (let j = 0; j < V_SEG; j++) {
    for (let i = 0; i < U_SEG; i++) {
      for (const [di, dj] of CORNERS) {
        uvs[k++] = (i + di) / U_SEG
        uvs[k++] = (j + dj) / V_SEG
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(QUADS * 18), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(QUADS * 18), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  return g
}

// Fill a geometry from grid points. Cheap enough to run every frame while
// morphing. Normals follow the triangle winding; the shader flips them with
// gl_FrontFacing, so orientation is free.
export function writeSurface(geometry, grid) {
  const positions = geometry.attributes.position.array
  const normals = geometry.attributes.normal.array
  const at = (i, j) => (j * COLS + i) * 3

  let k = 0
  for (let j = 0; j < V_SEG; j++) {
    for (let i = 0; i < U_SEG; i++) {
      // Diagonal cross product (p11 - p00) x (p01 - p10) = 2 * (du x dv).
      const a = at(i, j)
      const b = at(i + 1, j + 1)
      const c = at(i, j + 1)
      const d = at(i + 1, j)
      const ex = grid[b] - grid[a], ey = grid[b + 1] - grid[a + 1], ez = grid[b + 2] - grid[a + 2]
      const fx = grid[c] - grid[d], fy = grid[c + 1] - grid[d + 1], fz = grid[c + 2] - grid[d + 2]
      let nx = ey * fz - ez * fy
      let ny = ez * fx - ex * fz
      let nz = ex * fy - ey * fx
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len

      for (const [di, dj] of CORNERS) {
        const p = at(i + di, j + dj)
        positions[k] = grid[p]
        positions[k + 1] = grid[p + 1]
        positions[k + 2] = grid[p + 2]
        normals[k] = nx
        normals[k + 1] = ny
        normals[k + 2] = nz
        k += 3
      }
    }
  }

  geometry.attributes.position.needsUpdate = true
  geometry.attributes.normal.needsUpdate = true
  geometry.computeBoundingSphere()
}

// Smooth bump around the ring: 1 at u = centre, 0 beyond halfWidth (wraps).
const bump = (u, centre, halfWidth) => {
  const d0 = Math.abs(u - centre) % 1
  const d = Math.min(d0, 1 - d0)
  return d < halfWidth ? Math.cos((Math.PI / 2) * (d / halfWidth)) ** 2 : 0
}

// Small seeded PRNG (mulberry32), so a seed always gives the same shape.
function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()), // inclusive
    phase: () => TAU * next(),
  }
}

// A wave around the ring. Integer frequency keeps u = 0 and u = 1 identical.
const wave = (r, ampLo, ampHi, freqLo, freqHi) => {
  const amp = r.range(ampLo, ampHi)
  const freq = r.int(freqLo, freqHi)
  const phase = r.phase()
  return (u) => amp * Math.sin(TAU * freq * u + phase)
}

// Two irregular surfaces: a round, lobed top and a flatter, gently swelling
// bottom, over wobbling seams. Ranges keep the shape inside the frame.
function randomStitched(r) {
  const ringWave = wave(r, 0.04, 0.12, 1, 3)
  const widthWave = wave(r, 0.03, 0.09, 2, 4)
  const heightWave = wave(r, 0.04, 0.14, 1, 3)
  const tiltWave = wave(r, 0, 0.12, 1, 2)

  const topBase = r.range(0.3, 0.4)
  const topExponent = r.range(2, 3)
  const topLobes = wave(r, 0.15, 0.35, 3, 6)
  const topLean = r.range(-0.25, 0.25)

  const bottomBase = r.range(0.2, 0.3)
  const bottomExponent = r.range(2.2, 3.2)
  const bottomSwell = wave(r, 0.03, 0.07, 2, 4)

  return {
    ring: (u) => 1 + ringWave(u),
    seam: (u) => ({ w: 0.4 + widthWave(u), z0: heightWave(u), tilt: tiltWave(u) }),
    top: {
      exponent: topExponent,
      bulge: (u, theta) => topBase * (1 + topLobes(u)) * (1 + topLean * Math.sin(2 * theta)),
    },
    bottom: {
      exponent: bottomExponent,
      bulge: (u) => bottomBase + bottomSwell(u),
    },
  }
}

// Tears along one seam: [topTrim, bottomTrim] per u. One lip of each tear
// peels back further than the other, so tears gape up or down.
function randomTears(r, count) {
  const tears = Array.from({ length: count }, () => {
    const centre = r.range(0, 1)
    const halfWidth = r.range(0.05, 0.13)
    const depth = r.range(0.4, 0.8)
    const lesserLip = r.range(0.3, 0.7)
    const topPeels = r.range(0, 1) < 0.5
    return { centre, halfWidth, depth, top: topPeels ? 1 : lesserLip, bottom: topPeels ? lesserLip : 1 }
  })
  return (u) => {
    let top = 0
    let bottom = 0
    for (const t of tears) {
      const g = t.depth * bump(u, t.centre, t.halfWidth)
      top += t.top * g
      bottom += t.bottom * g
    }
    // Overlapping tears never retract a lip by more than 1 rad.
    return [Math.min(top, 1), Math.min(bottom, 1)]
  }
}

const TORUS_R = 1
const TORUS_r = 0.42
const RECT_LENGTH = 3.2 // along u, becomes the ring (2*PI*R long at the end)
const RECT_WIDTH = 1.3 // along v, becomes the half tube (PI*r across at the end)

const lerp = (a, b, t) => a + (b - a) * t
const smoothstep = (lo, hi, t) => {
  const x = Math.min(Math.max((t - lo) / (hi - lo), 0), 1)
  return x * x * (3 - 2 * x)
}

// Bend a straight strip into an arc of curvature k, keeping the point at
// s = 0 fixed. Returns the point at arc length s and its unit normal, which
// points away from the bend's centre (at distance 1/k). k = 0 is straight.
function bend(s, k) {
  if (k < 1e-6) return [s, 0, 0, -1]
  const a = k * s
  return [Math.sin(a) / k, (1 - Math.cos(a)) / k, Math.sin(a), -Math.cos(a)]
}

// A flat rectangle that rolls up into the top half of the regular torus, for
// t in [0, 1]. First v curls into the half-tube arch, then (overlapping) u
// bends around into the ring until its two short edges meet. Orientation and
// parametrisation match the torus's top surface at t = 1.
function rectangleToHalfTorus(u, v, out, t) {
  const roll = smoothstep(0.1, 0.55, t)
  const ring = smoothstep(0.4, 0.95, t)

  // Cross-section: v = 0 is the outer seam edge, v = 1 the inner one. The arch
  // bends downward (normal flipped), then lifts so its edges sit at z = 0.
  const [across, drop] = bend((0.5 - v) * lerp(RECT_WIDTH, Math.PI * TORUS_r, roll), roll / TORUS_r)
  const z = -drop + TORUS_r * roll

  // Around the ring: the strip's centre line bends into an arc, re-centred on
  // half its height; at the end that's the ring centre. It curls early and
  // lengthens late, which keeps the half-bent strip inside the frame.
  const length = lerp(RECT_LENGTH, TAU * TORUS_R, ring ** 3)
  const k = Math.sqrt(ring) / TORUS_R
  const [x, y, nx, ny] = bend((u - 0.5) * length, k)
  const [, arcHeight] = bend(length / 2, k)
  const px = x + across * nx
  const py = y + across * ny - arcHeight / 2
  // Turn -90deg about z so u lands at azimuth 2*PI*u, like the torus.
  return out.set(py, -px, z)
}

// Each shape builds its surface pair from a seed; `seeded` shapes use it.
// The same seed gives the same body on the Stitched and Open seam tabs.
// A null surface is hidden (it collapses onto the other first). Shapes with
// `animation` take a fourth argument t in [0, 1], played over `duration` s.
export const SHAPES = {
  torus: {
    label: 'Torus',
    isocurves: [24, 4],
    seeded: false,
    build: () =>
      stitchedPair({
        ring: () => 1,
        seam: () => ({ w: 0.42, z0: 0, tilt: 0 }),
        top: { exponent: 2, bulge: () => 0.42 },
        bottom: { exponent: 2, bulge: () => 0.42 },
      }),
  },

  stitched: {
    label: 'Stitched',
    isocurves: [24, 4],
    seeded: true,
    build: (seed) => stitchedPair(randomStitched(rng(seed))),
  },

  // The stitched shape with its seams split open in places.
  open: {
    label: 'Open seam',
    isocurves: [24, 4],
    seeded: true,
    build: (seed) => {
      const r = rng(seed)
      const body = randomStitched(r) // drawn first, so it matches Stitched
      return stitchedPair({
        ...body,
        open: { outer: randomTears(r, r.int(1, 3)), inner: randomTears(r, r.int(0, 2)) },
      })
    },
  },

  // One surface only: a rectangle rolling up into the torus's top half.
  rollUp: {
    label: 'Roll up',
    isocurves: [24, 4],
    seeded: false,
    animation: { duration: 4 },
    build: () => ({ top: rectangleToHalfTorus, bottom: null }),
  },
}
