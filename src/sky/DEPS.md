# src/sky dependencies

**Runtime: none.** No package is added to `package.json` by this directory.

## Why raw WebGL2 and not a library

The whole renderer is five draw calls with five hand-written shader pairs. What a scene
graph gives you is a camera, a material system, a transform hierarchy and a loader, and this
draws none of that: there is one camera, it never moves in a way a matrix could express
(the projection is stereographic on the celestial sphere, not perspective on a frustum), and
there is no geometry to load. three.js is roughly 600 KB for the parts of it we would not
call.

`regl` was the closer call, at about 30 KB. What it buys is command memoisation, which pays
off when a frame issues many draws with churning state. This frame issues five draws with
state that is set once at init and never touched again, so the thing it optimises does not
happen here.

WebGL2 specifically, rather than WebGL1 plus extensions:

- `drawArraysInstanced` and `vertexAttribDivisor` are core, so there is no
  `ANGLE_instanced_arrays` fallback path to write and no silent degradation on a context
  that lacks it.
- GLSL ES 3.00 gives `gl_VertexID` and `gl_InstanceID`, which is what lets a ring be
  generated from nothing but a vertex count instead of an index buffer.
- Non-power-of-two textures and integer attributes are core, which the visitor id lookup
  wants.

WebGL2 has been available in every current browser since Safari 15 (2021). A machine without
it gets the still composition on a 2D context, which is the same thing
`prefers-reduced-motion` gets, so that path is exercised rather than theoretical.

## Dev-time

`test/sky/bench.ts` runs under `node --experimental-strip-types`, which is why nothing in
this directory uses an enum, a namespace or a parameter property: type stripping cannot
erase those. Relative imports carry explicit `.ts` extensions for the same reason.
