/**
 * Six draws, and the state that makes them cheap.
 *
 * This file has no arithmetic worth testing in it, which is deliberate. Every decision with a
 * right answer lives in `scene.ts` or `astro.ts` where a plain node test can reach it; what is
 * left here is uploading and drawing, and the one thing worth checking about that is whether
 * the draws it issues match the lights the audit knows about. `draws()` is how it says.
 *
 * Order is free. Both blend modes are commutative, additive on a dark ground and reverse
 * subtract on a light one, so nothing here sorts and nothing depends on being drawn last.
 * The order below is the order that reads best in a profiler, coarsest geometry first.
 */
import { bindAttribs, MirrorBuffer, Program, type AttribSpec, type Gl } from "./gl/device.ts";
import {
  ARC_FRAG,
  ARC_VERT,
  DISC_FRAG,
  DISC_VERT,
  RING_FRAG,
  RING_VERT,
  STAR_FRAG,
  STAR_VERT,
  STREAK_FRAG,
  STREAK_VERT,
} from "./gl/shaders.ts";
import { RING_SEGMENTS } from "./constants.ts";
import type { DrawReport } from "./provenance.ts";
import { ARC_STRIDE, DISC_STRIDE, RING_STRIDE, STAR_STRIDE, STREAK_STRIDE, type Scene } from "./scene.ts";

const VIEW_BINDING = 0;
const RING_VERTS = (RING_SEGMENTS + 1) * 2;

const STREAK_ATTRIBS: AttribSpec[] = [
  { name: "aEq", size: 2, offsetFloats: 0 },
  { name: "aInfo", size: 2, offsetFloats: 2 },
];
const RING_ATTRIBS = STREAK_ATTRIBS;
const DISC_ATTRIBS: AttribSpec[] = [
  { name: "aEq", size: 2, offsetFloats: 0 },
  { name: "aFade", size: 4, offsetFloats: 2 },
  { name: "aForm", size: 4, offsetFloats: 6 },
  { name: "aColor", size: 3, offsetFloats: 10 },
  { name: "aSeed", size: 1, offsetFloats: 13 },
];
const STAR_ATTRIBS: AttribSpec[] = [
  { name: "aEq", size: 2, offsetFloats: 0 },
  { name: "aPoint", size: 2, offsetFloats: 2 },
  { name: "aGlare", size: 3, offsetFloats: 4 },
  { name: "aColor", size: 3, offsetFloats: 7 },
  { name: "aSeed", size: 1, offsetFloats: 10 },
];
const ARC_ATTRIBS: AttribSpec[] = [
  { name: "aA", size: 2, offsetFloats: 0 },
  { name: "aB", size: 2, offsetFloats: 2 },
  { name: "aMeta", size: 2, offsetFloats: 4 },
];

type LayerGL = { program: Program; vao: WebGLVertexArrayObject; buffer: MirrorBuffer };

export class Renderer {
  private readonly streaks: LayerGL;
  private readonly rings: LayerGL;
  private readonly discs: LayerGL;
  private readonly stars: LayerGL;
  private readonly arcs: Program;
  private readonly trackVao: WebGLVertexArrayObject;
  private readonly trackBuf: MirrorBuffer;
  private readonly horizonVao: WebGLVertexArrayObject;
  private readonly horizonBuf: MirrorBuffer;
  private readonly ubo: WebGLBuffer;
  private readonly gl: Gl;
  private readonly scene: Scene;
  private lastDraws: DrawReport[] = [];

  constructor(gl: Gl, scene: Scene) {
    this.gl = gl;
    this.scene = scene;
    this.streaks = this.instanced("streaks", STREAK_VERT, STREAK_FRAG, scene.meteors.data, STREAK_STRIDE, STREAK_ATTRIBS);
    this.rings = this.instanced("rings", RING_VERT, RING_FRAG, scene.quakes.data, RING_STRIDE, RING_ATTRIBS);
    this.discs = this.instanced("discs", DISC_VERT, DISC_FRAG, scene.discs.data, DISC_STRIDE, DISC_ATTRIBS);
    // STATIC_DRAW: the catalogue is uploaded once at construction and then only when the
    // palette or the device pixel ratio moves the colours, which is never in a normal session.
    this.stars = this.instanced("stars", STAR_VERT, STAR_FRAG, scene.stars.data, STAR_STRIDE, STAR_ATTRIBS, gl.STATIC_DRAW);

    this.arcs = new Program(gl, "arcs", ARC_VERT, ARC_FRAG);
    this.arcs.bindBlock("View", VIEW_BINDING);
    this.trackBuf = new MirrorBuffer(gl, scene.track.data, gl.DYNAMIC_DRAW);
    this.trackVao = this.vaoFor(this.arcs, this.trackBuf, ARC_STRIDE, ARC_ATTRIBS, 0);
    this.horizonBuf = new MirrorBuffer(gl, scene.horizon.data, gl.STATIC_DRAW);
    this.horizonVao = this.vaoFor(this.arcs, this.horizonBuf, ARC_STRIDE, ARC_ATTRIBS, 0);

    const ubo = gl.createBuffer();
    if (!ubo) throw new Error("createBuffer returned null for the View block");
    this.ubo = ubo;
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, scene.uniforms.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, VIEW_BINDING, ubo);

    // No depth buffer is ever bound, so leaving the test enabled would silently reject
    // fragments against whatever the default depth is on some drivers.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  private instanced(
    name: string,
    vs: string,
    fs: string,
    data: Float32Array,
    stride: number,
    attribs: readonly AttribSpec[],
    usage: number = this.gl.DYNAMIC_DRAW,
  ): LayerGL {
    const program = new Program(this.gl, name, vs, fs);
    program.bindBlock("View", VIEW_BINDING);
    const buffer = new MirrorBuffer(this.gl, data, usage);
    return { program, buffer, vao: this.vaoFor(program, buffer, stride, attribs, 1) };
  }

  private vaoFor(
    program: Program,
    buffer: MirrorBuffer,
    stride: number,
    attribs: readonly AttribSpec[],
    divisor: number,
  ): WebGLVertexArrayObject {
    const vao = this.gl.createVertexArray();
    if (!vao) throw new Error(`${program.name}: createVertexArray returned null`);
    this.gl.bindVertexArray(vao);
    bindAttribs(this.gl, program, buffer, stride, attribs, divisor, 0);
    this.gl.bindVertexArray(null);
    return vao;
  }

  resize(): void {
    const v = this.scene.viewport;
    this.gl.viewport(0, 0, Math.round(v.widthCss * v.dpr), Math.round(v.heightCss * v.dpr));
  }

  /** Draws one frame from the scene's current state. `scene.update` must have run first. */
  render(): void {
    const gl = this.gl;
    const scene = this.scene;
    const palette = scene.palette;
    const draws: DrawReport[] = [];

    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, scene.uniforms, 0, scene.uniforms.length);

    gl.clearColor(palette.bg[0], palette.bg[1], palette.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Light adds on a dark ground and subtracts on a light one, so a light palette renders as
    // a photographic negative rather than washing out to white. See INK_OUT in gl/glsl.ts.
    gl.blendEquation(palette.scheme === "light" ? gl.FUNC_REVERSE_SUBTRACT : gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    const dpr = scene.viewport.dpr;

    // The stars first, because they are the ground everything else happens against. Order is
    // free for correctness, both blend modes being commutative, but a frame reads best with
    // the deepest thing submitted first and a profiler agrees.
    //
    // One draw for 8,920 instances, and `takeDirty` returns null on all but the first frame
    // and the rare repaint, so on a steady frame this uploads nothing at all.
    this.uploadDirty(scene.stars.takeDirty(), this.stars.buffer, STAR_STRIDE);
    this.stars.program.use();
    gl.bindVertexArray(this.stars.vao);
    for (const r of scene.stars.draws()) {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, r.count);
      draws.push({ source: "layer:stars", instances: r.count });
    }

    this.uploadDirty(scene.horizon.takeDirty(), this.horizonBuf, ARC_STRIDE);
    this.arcs.use();
    this.arcs.setInt("uArcSpace", 1);
    this.arcs.setFloat("uArcWidth", 0.55 * dpr);
    this.arcs.setVec3("uInk", palette.chrome);
    gl.bindVertexArray(this.horizonVao);
    for (const r of scene.horizon.draws()) {
      gl.drawArrays(gl.TRIANGLE_STRIP, r.first, r.count);
      draws.push({ source: "chrome:horizon", instances: r.count });
    }

    this.uploadDirty(scene.quakes.takeDirty(), this.rings.buffer, RING_STRIDE);
    this.rings.program.use();
    this.rings.program.setVec3("uInk", palette.quake);
    gl.bindVertexArray(this.rings.vao);
    for (const r of scene.quakes.draws()) {
      bindAttribs(gl, this.rings.program, this.rings.buffer, RING_STRIDE, RING_ATTRIBS, 1, r.first);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, RING_VERTS, r.count);
      draws.push({ source: "layer:quakes", instances: r.count });
    }

    this.uploadDirty(scene.discs.takeDirty(), this.discs.buffer, DISC_STRIDE);
    this.discs.program.use();
    gl.bindVertexArray(this.discs.vao);
    for (const r of scene.discs.draws()) {
      bindAttribs(gl, this.discs.program, this.discs.buffer, DISC_STRIDE, DISC_ATTRIBS, 1, r.first);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, r.count);
      draws.push({ source: "layer:discs", instances: r.count });
    }

    this.uploadDirty(scene.track.takeDirty(), this.trackBuf, ARC_STRIDE);
    this.arcs.use();
    this.arcs.setInt("uArcSpace", 0);
    this.arcs.setFloat("uArcWidth", 0.9 * dpr);
    this.arcs.setVec3("uInk", palette.orbit);
    gl.bindVertexArray(this.trackVao);
    for (const r of scene.track.draws()) {
      gl.drawArrays(gl.TRIANGLE_STRIP, r.first, r.count);
      draws.push({ source: "layer:track", instances: r.count });
    }

    this.uploadDirty(scene.meteors.takeDirty(), this.streaks.buffer, STREAK_STRIDE);
    this.streaks.program.use();
    this.streaks.program.setVec3("uInk", palette.meteor);
    this.streaks.program.setVec3("uInkHot", palette.meteorHot);
    gl.bindVertexArray(this.streaks.vao);
    for (const r of scene.meteors.draws()) {
      bindAttribs(gl, this.streaks.program, this.streaks.buffer, STREAK_STRIDE, STREAK_ATTRIBS, 1, r.first);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, r.count);
      draws.push({ source: "layer:meteors", instances: r.count });
    }

    gl.bindVertexArray(null);
    this.lastDraws = draws;
  }

  private uploadDirty(
    range: { first: number; count: number } | null,
    buffer: MirrorBuffer,
    stride: number,
  ): void {
    if (!range) return;
    buffer.upload(range.first * stride, range.count * stride);
  }

  /** Every draw the last frame issued, for the provenance audit. */
  draws(): readonly DrawReport[] {
    return this.lastDraws;
  }

  destroy(): void {
    const gl = this.gl;
    for (const l of [this.streaks, this.rings, this.discs, this.stars]) {
      l.program.destroy();
      l.buffer.destroy();
      gl.deleteVertexArray(l.vao);
    }
    this.arcs.destroy();
    this.trackBuf.destroy();
    this.horizonBuf.destroy();
    gl.deleteVertexArray(this.trackVao);
    gl.deleteVertexArray(this.horizonVao);
    gl.deleteBuffer(this.ubo);
  }
}
