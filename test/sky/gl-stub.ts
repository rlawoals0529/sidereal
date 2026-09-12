/**
 * A WebGL2 context that records instead of drawing.
 *
 * It exists for one reason: the provenance audit's third rule is that every draw call belongs
 * to a registered layer or to declared chrome, and a rule about draw calls that cannot see
 * draw calls is a rule about nothing. This makes them observable in a plain node test, so the
 * audit is checked against what the renderer really issues rather than against a list the
 * test wrote out itself.
 *
 * It is not a software renderer and does not pretend to be. Shaders are accepted without
 * being compiled, so this says nothing about whether the GLSL is correct; that needs a real
 * driver and the benchmark is where it gets one.
 */
import type { Gl } from "../../src/sky/gl/device.ts";

export type Recorded = {
  draws: { mode: number; first: number; count: number; instances: number }[];
  uploads: { target: number; offsetBytes: number; lengthFloats: number }[];
  programs: string[];
  blendEquations: number[];
};

export function stubGl(): { gl: Gl; log: Recorded } {
  const log: Recorded = { draws: [], uploads: [], programs: [], blendEquations: [] };
  let nextAttrib = 0;
  const attribs = new Map<string, number>();

  const gl = {
    ARRAY_BUFFER: 0x8892,
    UNIFORM_BUFFER: 0x8a11,
    DYNAMIC_DRAW: 0x88e8,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TRIANGLE_STRIP: 0x0005,
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    ONE: 1,
    FUNC_ADD: 0x8006,
    FUNC_REVERSE_SUBTRACT: 0x800b,

    createShader: () => ({}) as WebGLShader,
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => {},

    createProgram: () => ({}) as WebGLProgram,
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: () => {},
    useProgram: () => {},

    createBuffer: () => ({}) as WebGLBuffer,
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: (target: number, offset: number, _src: unknown, _o: number, length: number) => {
      log.uploads.push({ target, offsetBytes: offset, lengthFloats: length });
    },
    deleteBuffer: () => {},
    bindBufferBase: () => {},

    createVertexArray: () => ({}) as WebGLVertexArrayObject,
    bindVertexArray: () => {},
    deleteVertexArray: () => {},

    // Stable per name, so `bindAttribs` behaves the way a real driver would: a program that
    // does not declare an attribute gets -1 and is skipped.
    getAttribLocation: (_p: WebGLProgram, name: string) => {
      const hit = attribs.get(name);
      if (hit !== undefined) return hit;
      attribs.set(name, nextAttrib);
      return nextAttrib++;
    },
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    getUniformLocation: () => ({}) as WebGLUniformLocation,
    uniform1f: () => {},
    uniform1i: () => {},
    uniform3f: () => {},
    getUniformBlockIndex: () => 0,
    uniformBlockBinding: () => {},

    drawArrays: (mode: number, first: number, count: number) => {
      log.draws.push({ mode, first, count, instances: 1 });
    },
    drawArraysInstanced: (mode: number, first: number, count: number, instances: number) => {
      log.draws.push({ mode, first, count, instances });
    },

    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    enable: () => {},
    disable: () => {},
    blendFunc: () => {},
    blendEquation: (mode: number) => {
      log.blendEquations.push(mode);
    },
  };

  return { gl: gl as unknown as Gl, log };
}
