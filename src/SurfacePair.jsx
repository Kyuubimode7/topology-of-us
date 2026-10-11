import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { createSurfaceGeometry, gridIso, sampleIso, sampleSurface, writeSurface } from './surfaces.js'
import './SurfacePair.css'

// z-up world, set before any Object3D is created.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

const PERIOD_S = 12 // one full revolution; 360deg is the seamless loop
const SS = 4 // supersampling factor, box-filtered down in the post pass
const MAX_STEPS = 64
const DRAG_SPEED = 0.01 // radians per CSS pixel
// Rubber-band physics on the drag offset (angular spring-damper, per second).
// Critical damping is 2*sqrt(stiffness); below that it overshoots.
const DRAG_STIFFNESS = 220 // stiff follow of the pointer, slight lag and wobble
const DRAG_DAMPING = 22
const RETURN_STIFFNESS = 14 // soft pull back to the reference view once resumed
const RETURN_DAMPING = 3.2
const COAST_FRICTION = 1.8 // momentum decay after release, before resuming
const PHYSICS_STEP = 1 / 240
const MORPH_S = 0.9 // shape-to-shape transition time
const MIN_ZOOM = 1 // the reference framing; zooming out would only shrink it
const MAX_ZOOM = 4
const WHEEL_ZOOM_SPEED = 0.0015 // per wheel pixel, exponential

// Colours are raw sRGB 0-255 triples, passed straight to the shaders
// (no THREE.Color, which would convert to linear).
const LAVENDER = [204, 184, 244]
const BLUE = [110, 185, 242]

// Interior shading range, as fractions of the base colour (outside is 0.66-1).
const INSIDE_FLOOR = '0.3'
const INSIDE_RANGE = '0.42'
const SHADOW_MAP_SIZE = 1024
const SHADOW_BIAS = '0.004' // in light-depth units; the light frustum is 10 deep

// Shared shading model: all maths on sRGB-encoded values.
const shadeGlsl = /* glsl */ `
  vec3 shadeColor(vec3 base, float d) {
    float shade = 0.66 + 0.34 * d;           // floor keeps shadows pastel
    float spec = pow(d, 12.0) * 0.25;        // n.L based, added as white
    return clamp(base * shade + spec, 0.0, 1.0);
  }

  // Inside of the shell: darker, no highlight. d already includes the shadow,
  // so the cavity is dim except where light comes in through a tear.
  vec3 insideColor(vec3 base, float d) {
    return base * (${INSIDE_FLOOR} + ${INSIDE_RANGE} * d);
  }
`

// Isocurves are the shaded colour lifted toward white by this much.
const LINE_MIX = 0.4
// Half the isocurve width in output pixels (the target is SS times larger).
const LINE_HALF_WIDTH = 0.5

// Seam edges (v = 0 and v = 1 of each surface) are the shaded colour darkened
// to this fraction. Each surface draws its half, so a closed seam is twice as
// wide; an open lip shows one half.
const SEAM_SHADE = '0.6'
const SEAM_HALF_WIDTH = 1 // output pixels per side

const lineGlsl = /* glsl */ `
  vec3 lineColor(vec3 c) { return mix(c, vec3(1.0), ${LINE_MIX}); }
  vec3 seamColor(vec3 c) { return c * ${SEAM_SHADE}; }
`

const meshVertexShader = /* glsl */ `
  uniform mat4 uShadowMatrix; // world -> light texture space [0,1]^3
  attribute vec2 iso;

  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec2 vIso;
  varying vec3 vShadowCoord;

  void main() {
    vUv = uv;
    vIso = iso;
    vNormal = normalize(normalMatrix * normal);
    vShadowCoord = (uShadowMatrix * modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const meshFragmentShader = /* glsl */ `
  uniform vec3 uColour;
  uniform sampler2D uShadowMap;

  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec2 vIso; // isocurves where either is a whole number
  varying vec3 vShadowCoord;

  const vec3 L = normalize(vec3(-0.4, 0.7, 0.6)); // camera space, fixed to the camera

  ${shadeGlsl}
  ${lineGlsl}

  // 1 within LINE_HALF_WIDTH output pixels of a whole value of g, else 0.
  // Hard edged on purpose: the post pass's box filter does the anti-aliasing.
  float isoLine(float g) {
    float dist = abs(fract(g - 0.5) - 0.5);
    return step(dist / max(fwidth(g), 1e-6), ${LINE_HALF_WIDTH * SS}.0);
  }

  // Fraction of light reaching this point, 2x2 PCF against the light's depth.
  float lightVisibility() {
    vec2 texel = vec2(1.0 / ${SHADOW_MAP_SIZE}.0);
    float lit = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 offset = (vec2(i, j) - 0.5) * texel;
        float occluder = texture2D(uShadowMap, vShadowCoord.xy + offset).r;
        lit += vShadowCoord.z - ${SHADOW_BIAS} <= occluder ? 1.0 : 0.0;
      }
    }
    return lit * 0.25;
  }

  void main() {
    // Normals point out of the shell, so a back face is its inside.
    vec3 N = normalize(vNormal);
    bool inside = !gl_FrontFacing;
    if (inside) N = -N;
    float d = max(dot(N, L), 0.0);
    // The outside keeps the reference look (no cast shadows); the inside is
    // shadowed by the shell around it.
    vec3 col = inside
      ? insideColor(uColour, d * lightVisibility())
      : shadeColor(uColour, d);

    float edgeDist = min(vUv.y, 1.0 - vUv.y) / max(fwidth(vUv.y), 1e-6);
    bool seam = edgeDist <= ${SEAM_HALF_WIDTH * SS}.0;
    float line = max(isoLine(vIso.x), isoLine(vIso.y));
    if (seam) col = seamColor(col);
    else if (line > 0.0) col = lineColor(col);
    gl_FragColor = vec4(col, 1.0);
  }
`

const postVertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Mirrors the reference GIF pipeline: box-filter the SSxSS block, un-premultiply,
// 1-bit alpha, then snap to one fixed palette with no dithering. The palette is
// both hues, outside and inside shading, at uSteps evenly spaced lighting
// levels, plus the isocurve and seam versions of those, standing in for the reference's
// global median-cut palette.
// uSteps <= 0 skips quantisation.
const postFragmentShader = /* glsl */ `
  uniform sampler2D tSrc;
  uniform float uSrcSize;
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform float uSteps;

  ${shadeGlsl}
  ${lineGlsl}

  void consider(vec3 col, vec3 candidate, inout vec3 best, inout float bestDist) {
    vec3 diff = col - candidate;
    float dist = dot(diff, diff);
    if (dist < bestDist) { bestDist = dist; best = candidate; }
  }

  void main() {
    vec2 origin = floor(gl_FragCoord.xy) * ${SS}.0;
    vec4 acc = vec4(0.0);
    for (int j = 0; j < ${SS}; j++) {
      for (int i = 0; i < ${SS}; i++) {
        vec4 c = texture2D(tSrc, (origin + vec2(i, j) + 0.5) / uSrcSize);
        acc += vec4(c.rgb * c.a, c.a);
      }
    }

    if (acc.a / ${SS * SS}.0 < 0.5) discard;
    vec3 col = acc.rgb / acc.a;

    if (uSteps > 0.0) {
      vec3 best = col;
      float bestDist = 1e9;
      for (int k = 0; k <= ${MAX_STEPS}; k++) {
        if (float(k) > uSteps) break;
        float d = float(k) / uSteps;
        vec3 candidates[4] = vec3[4](
          shadeColor(uTop, d), shadeColor(uBottom, d),
          insideColor(uTop, d), insideColor(uBottom, d)
        );
        for (int c = 0; c < 4; c++) {
          consider(col, candidates[c], best, bestDist);
          consider(col, lineColor(candidates[c]), best, bestDist);
          consider(col, seamColor(candidates[c]), best, bestDist);
        }
      }
      col = best;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

// The two surface meshes, each with its own colour. Each surface keeps grid
// points: `current` is what's shown, morphing from `from` to `to`, and the
// same for its isocurve coordinates (`iso*`). A new target starts from `current`, so changes mid-morph
// carry on smoothly instead of jumping.
function createModel() {
  const colours = {
    uTop: { value: new THREE.Vector3() },
    uBottom: { value: new THREE.Vector3() },
  }
  // Filled in by the renderer, which owns the shadow map.
  const shadow = {
    uShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
  }
  const group = new THREE.Group()
  const meshes = [colours.uTop, colours.uBottom].map((colour) => {
    const material = new THREE.ShaderMaterial({
      vertexShader: meshVertexShader,
      fragmentShader: meshFragmentShader,
      uniforms: { uColour: colour, ...shadow },
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(createSurfaceGeometry(), material)
    group.add(mesh)
    return mesh
  })
  const surfaces = meshes.map((mesh) => ({
    mesh,
    from: null,
    to: null,
    current: null,
    isoFrom: null,
    isoTo: null,
    isoCurrent: null,
    present: true,
  }))
  let morphStart = 0
  let morphing = false
  // Animated shapes: { fns, durationMs, start }, played once the morph ends.
  let animation = null

  const hideMissing = () => {
    for (const s of surfaces) if (!s.present) s.mesh.visible = false
  }

  // A hidden surface follows the shown one, so it peels off it when it returns.
  const syncMissing = () => {
    const shown = surfaces.find((s) => s.present)
    for (const s of surfaces) {
      if (!s.present) {
        s.current.set(shown.current)
        s.isoCurrent.set(shown.isoCurrent)
      }
    }
  }

  // fns: [top, bottom], either may be null (hidden). With `anim`, fns take t
  // and the morph goes to t = 0 before the animation plays. isoFns: [top,
  // bottom] isocurve coordinates, (u, v) -> [a, b].
  const setTargets = (fns, anim, isoFns) => {
    const atStart = fns.map((fn) => fn && (anim ? (u, v, o) => fn(u, v, o, 0) : fn))
    const fallback = atStart.find(Boolean)
    surfaces.forEach((s, i) => {
      s.present = Boolean(atStart[i])
      if (s.present) s.mesh.visible = true
      // A missing surface morphs onto the shown one, then hides.
      s.to = sampleSurface(atStart[i] ?? fallback)
      s.isoTo = sampleIso(isoFns[i])
      if (s.current) {
        s.from = s.current.slice()
        s.isoFrom = s.isoCurrent.slice()
      } else {
        // First shape: show it straight away.
        s.current = s.to.slice()
        s.isoCurrent = s.isoTo.slice()
        writeSurface(s.mesh.geometry, s.current, s.isoCurrent)
      }
    })
    morphStart = performance.now()
    morphing = surfaces.some((s) => s.from)
    if (!morphing) hideMissing()
    animation = anim
      ? { fns, durationMs: anim.duration * 1000, start: morphing ? null : morphStart }
      : null
  }

  const step = (now) => {
    if (morphing) {
      const t = Math.min((now - morphStart) / (MORPH_S * 1000), 1)
      const e = easeInOutCubic(t)
      for (const { mesh, from, to, current, isoFrom, isoTo, isoCurrent } of surfaces) {
        for (let k = 0; k < current.length; k++) current[k] = from[k] + (to[k] - from[k]) * e
        for (let k = 0; k < isoCurrent.length; k++) {
          isoCurrent[k] = isoFrom[k] + (isoTo[k] - isoFrom[k]) * e
        }
        writeSurface(mesh.geometry, current, isoCurrent)
      }
      if (t === 1) {
        morphing = false
        hideMissing()
        if (animation) animation.start = now
      }
      return
    }

    if (animation) {
      const t = Math.min((now - animation.start) / animation.durationMs, 1)
      surfaces.forEach((s, i) => {
        const fn = animation.fns[i]
        if (!fn) return
        sampleSurface((u, v, o) => fn(u, v, o, t), s.current)
        writeSurface(s.mesh.geometry, s.current, s.isoCurrent)
      })
      syncMissing()
      if (t === 1) animation = null
    }
  }

  return { group, meshes, colours, shadow, setTargets, step }
}

// Renders a shape from surfaces.js: two surfaces stitched at their seams, the
// top one in `top` colour and the bottom one in `bottom` colour.
export default function SurfacePair({
  shape,
  top = LAVENDER,
  bottom = BLUE,
  steps = 20,
  resolution = 300,
  size = 300,
  seed = 1, // only used by shapes with `seeded: true`
  resumeDelay = 3, // seconds after the last drag before the tumble resumes
  replay = 0, // change to restart an animated shape
}) {
  const mountRef = useRef(null)
  const paramsRef = useRef(null)
  // Meshes and materials outlive the renderer; only geometry follows shape/seed.
  // Created lazily and only touched from effects.
  const modelRef = useRef(null)
  const getModel = () => (modelRef.current ??= createModel())

  useEffect(() => {
    // Shapes with `tumble: false` don't spin on their own.
    paramsRef.current = { top, bottom, steps, resumeDelay, spin: shape.tumble !== false }
  }, [top, bottom, steps, resumeDelay, shape])

  useEffect(() => {
    const model = getModel()
    const pair = shape.build(seed)
    // A shape may give its own isocurve coordinates; otherwise lines follow
    // its (u, v) grid.
    const iso = pair.iso ?? { top: gridIso(shape.isocurves), bottom: gridIso(shape.isocurves) }
    model.setTargets([pair.top, pair.bottom], shape.animation ?? null, [iso.top, iso.bottom])
  }, [shape, seed, replay])

  useEffect(() => {
    const model = getModel()
    return () => {
      for (const mesh of model.meshes) {
        mesh.geometry.dispose()
        mesh.material.dispose()
      }
    }
  }, [])

  useEffect(() => {
    const model = getModel()
    const mount = mountRef.current

    // Fixed internal resolution, upscaled with CSS for the pixelated look.
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(1)
    renderer.setSize(resolution, resolution, false)
    mount.appendChild(renderer.domElement)

    const srcSize = resolution * SS
    const target = new THREE.WebGLRenderTarget(srcSize, srcSize, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    })

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100)
    camera.up.set(0, 0, 1)
    camera.position.set(-1, -1, 2).multiplyScalar(5)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()

    const colourUniforms = model.colours
    scene.add(model.group)

    // Shadow map from the camera-fixed light, so the shell shadows its inside.
    // The light is the shader's camera-space L carried into world space.
    const lightDir = new THREE.Vector3(-0.4, 0.7, 0.6)
      .normalize()
      .transformDirection(camera.matrixWorld)
    const lightCamera = new THREE.OrthographicCamera(-2.2, 2.2, 2.2, -2.2, 0.1, 10.1)
    lightCamera.position.copy(lightDir).multiplyScalar(5)
    lightCamera.lookAt(0, 0, 0)
    lightCamera.updateMatrixWorld()
    const shadowTarget = new THREE.WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
      depthTexture: new THREE.DepthTexture(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE),
    })
    shadowTarget.depthTexture.minFilter = THREE.NearestFilter
    shadowTarget.depthTexture.magFilter = THREE.NearestFilter
    const depthMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false })
    model.shadow.uShadowMap.value = shadowTarget.depthTexture
    // NDC [-1,1] -> texture space [0,1], after the light's view-projection.
    model.shadow.uShadowMatrix.value
      .makeTranslation(0.5, 0.5, 0.5)
      .multiply(new THREE.Matrix4().makeScale(0.5, 0.5, 0.5))
      .multiply(lightCamera.projectionMatrix)
      .multiply(lightCamera.matrixWorldInverse)

    const postScene = new THREE.Scene()
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const postGeometry = new THREE.PlaneGeometry(2, 2)
    const postMaterial = new THREE.ShaderMaterial({
      vertexShader: postVertexShader,
      fragmentShader: postFragmentShader,
      uniforms: {
        ...colourUniforms,
        tSrc: { value: target.texture },
        uSrcSize: { value: srcSize },
        uSteps: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    postScene.add(new THREE.Mesh(postGeometry, postMaterial))

    // Pointer drag adds a world-space offset on top of the tumble:
    // mesh = offset * rotY(phase). The offset is a damped angular spring:
    // - dragging: it chases the pointer's target orientation (slight lag/wobble)
    // - released: it coasts on its momentum, slowed by friction
    // - after resumeDelay: the tumble phase advances again and a softer,
    //   under-damped spring pulls the offset back to identity (rubber band).
    const canvas = renderer.domElement
    const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    const offset = new THREE.Quaternion()
    const dragTarget = new THREE.Quaternion()
    const identity = new THREE.Quaternion()
    const omega = new THREE.Vector3() // world-space angular velocity, rad/s
    const tumble = new THREE.Quaternion()
    const dq = new THREE.Quaternion()
    const err = new THREE.Quaternion()
    const errVec = new THREE.Vector3()
    const yAxis = new THREE.Vector3(0, 1, 0)
    let phase = 0 // 0..1 through the revolution
    let dragging = false
    let dragPointer = null // only the first finger drags; others are ignored
    let lastX = 0
    let lastY = 0
    let lastInteraction = -Infinity
    let lastMs = null
    let accumulator = 0

    // Shortest-path rotation vector (axis * angle) of unit quaternion q.
    const rotationVector = (q, out) => {
      const sign = q.w < 0 ? -1 : 1
      const s = Math.hypot(q.x, q.y, q.z)
      if (s < 1e-8) return out.set(2 * q.x, 2 * q.y, 2 * q.z).multiplyScalar(sign)
      const angle = 2 * Math.atan2(s, Math.abs(q.w))
      return out.set(q.x, q.y, q.z).multiplyScalar((sign * angle) / s)
    }

    const physicsStep = (h, target, stiffness, damping) => {
      if (target) {
        err.copy(offset).invert().premultiply(target) // target * offset^-1
        rotationVector(err, errVec)
        omega.addScaledVector(errVec, stiffness * h)
      }
      omega.multiplyScalar(Math.max(0, 1 - damping * h))
      const speed = omega.length()
      if (speed > 1e-9) {
        offset.premultiply(dq.setFromAxisAngle(errVec.copy(omega).divideScalar(speed), speed * h))
        offset.normalize()
      }
    }

    // Pinch (two fingers) and the mouse wheel zoom the ortho camera about the
    // centre. A pinch ends any drag; the drag restarts only on a fresh touch.
    const pointers = new Map() // pointerId -> { x, y }
    let pinchDistance = 0
    const pinchSpan = () => {
      const [a, b] = pointers.values()
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const setZoom = (zoom) => {
      camera.zoom = THREE.MathUtils.clamp(zoom, MIN_ZOOM, MAX_ZOOM)
      camera.updateProjectionMatrix()
    }

    const onPointerDown = (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      canvas.setPointerCapture(e.pointerId)
      lastInteraction = performance.now()
      if (pointers.size === 2) {
        dragging = false
        dragPointer = null
        pinchDistance = pinchSpan()
        return
      }
      if (pointers.size > 1) return
      dragging = true
      dragPointer = e.pointerId
      lastX = e.clientX
      lastY = e.clientY
      dragTarget.copy(offset)
    }
    const onPointerMove = (e) => {
      const p = pointers.get(e.pointerId)
      if (!p) return
      p.x = e.clientX
      p.y = e.clientY
      if (pointers.size === 2) {
        const span = pinchSpan()
        if (pinchDistance > 0 && span > 0) setZoom((camera.zoom * span) / pinchDistance)
        pinchDistance = span
        lastInteraction = performance.now()
        return
      }
      if (!dragging || e.pointerId !== dragPointer) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      lastInteraction = performance.now()
      // The canvas is mirrored with CSS, so horizontal drag is negated to make
      // the surface follow the pointer.
      dragTarget.premultiply(dq.setFromAxisAngle(camUp, -dx * DRAG_SPEED))
      dragTarget.premultiply(dq.setFromAxisAngle(camRight, dy * DRAG_SPEED))
      dragTarget.normalize()
    }
    const onPointerUp = (e) => {
      if (!pointers.delete(e.pointerId)) return
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      lastInteraction = performance.now()
      if (pointers.size === 2) pinchDistance = pinchSpan()
      if (e.pointerId !== dragPointer) return
      dragging = false
      dragPointer = null
    }
    const onWheel = (e) => {
      e.preventDefault()
      // deltaMode 1 is lines (Firefox); treat a line as ~16px.
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1)
      setZoom(camera.zoom * Math.exp(-delta * WHEEL_ZOOM_SPEED))
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    renderer.setAnimationLoop((ms) => {
      const { top, bottom, steps, resumeDelay, spin } = paramsRef.current
      colourUniforms.uTop.value.set(top[0], top[1], top[2]).divideScalar(255)
      colourUniforms.uBottom.value.set(bottom[0], bottom[1], bottom[2]).divideScalar(255)
      postMaterial.uniforms.uSteps.value = Math.min(steps, MAX_STEPS)

      // Cap dt so a backgrounded tab doesn't jump on return.
      const dt = lastMs === null ? 0 : Math.min((ms - lastMs) / 1000, 0.1)
      lastMs = ms
      const idle = !dragging && performance.now() - lastInteraction > resumeDelay * 1000
      if (idle && spin) phase = (phase + dt / PERIOD_S) % 1
      // Not spinning: settle back to the reference view the short way round.
      if (!spin) phase = (((phase > 0.5 ? phase - 1 : phase) * Math.exp(-3 * dt)) + 1) % 1

      // Fixed substeps keep the stiff drag spring stable at any frame rate.
      accumulator += dt
      while (accumulator >= PHYSICS_STEP) {
        accumulator -= PHYSICS_STEP
        if (dragging) physicsStep(PHYSICS_STEP, dragTarget, DRAG_STIFFNESS, DRAG_DAMPING)
        else if (idle) physicsStep(PHYSICS_STEP, identity, RETURN_STIFFNESS, RETURN_DAMPING)
        else physicsStep(PHYSICS_STEP, null, 0, COAST_FRICTION)
      }
      tumble.setFromAxisAngle(yAxis, 2 * Math.PI * phase)
      model.group.quaternion.multiplyQuaternions(offset, tumble)
      model.step(performance.now())

      // The model turns under a fixed light, so the shadow map is redrawn
      // every frame.
      scene.overrideMaterial = depthMaterial
      renderer.setRenderTarget(shadowTarget)
      renderer.render(scene, lightCamera)
      scene.overrideMaterial = null

      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
      renderer.render(postScene, postCamera)
    })

    return () => {
      renderer.setAnimationLoop(null)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      scene.remove(model.group)
      postGeometry.dispose()
      postMaterial.dispose()
      target.dispose()
      shadowTarget.depthTexture.dispose()
      shadowTarget.dispose()
      depthMaterial.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [resolution])

  return (
    <div
      ref={mountRef}
      className="surface-pair"
      // The width is clamped in CSS so the canvas fits small and short screens.
      style={{ '--size': `${size}px` }}
    />
  )
}
