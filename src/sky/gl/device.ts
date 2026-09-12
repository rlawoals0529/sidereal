/**
 * The thin layer between this renderer and WebGL2: compile, link, wire attributes, upload.
 *
 * `Gl` is a structural subset of `WebGL2RenderingContext` rather than the class itself. Two
 * reasons, and the second is the one that mattered.
 *
 * It documents the whole surface this renderer uses, which is about thirty calls out of a
 * few hundred. And it means the draw path can be driven by a recording stub in a plain node
 * test, which is how `test/sky/renderer-draws.test.ts` checks that the provenance audit sees
 * every draw the renderer actually issues. Auditing draws you cannot observe would be a
 * tautology; this makes them observable without a browser.
 *
 * **Compile failures are loud.** A shader that fails to compile in WebGL leaves you with a
 * program that links to nothing and a canvas that is simply blank, which is among the worst
 * error messages in computing. Everything here throws with the driver's log and the numbered
 * source lines around the fault, because the line number in the log is useless against a
 * source string that was assembled from three chunks.
 */

export type Gl = Pick<
  WebGL2RenderingContext,
  | "createShader" | "shaderSource" | "compileShader" | "getShaderParameter"
  | "getShaderInfoLog" | "deleteShader"
  | "createProgram" | "attachShader" | "linkProgram" | "getProgramParameter"
  | "getProgramInfoLog" | "deleteProgram" | "useProgram"
  | "createBuffer" | "bindBuffer" | "bufferData" | "bufferSubData" | "deleteBuffer"
  | "bindBufferBase"
  | "createVertexArray" | "bindVertexArray" | "deleteVertexArray"
  | "getAttribLocation" | "enableVertexAttribArray" | "vertexAttribPointer"
  | "vertexAttribDivisor"
  | "getUniformLocation" | "uniform1f" | "uniform1i" | "uniform3f"
  | "getUniformBlockIndex" | "uniformBlockBinding"
  | "drawArrays" | "drawArraysInstanced"
  | "viewport" | "clearColor" | "clear" | "enable" | "disable" | "blendFunc" | "blendEquation"
  | "ARRAY_BUFFER" | "UNIFORM_BUFFER" | "DYNAMIC_DRAW" | "STATIC_DRAW" | "FLOAT"
  | "VERTEX_SHADER" | "FRAGMENT_SHADER" | "COMPILE_STATUS" | "LINK_STATUS"
  | "TRIANGLE_STRIP" | "COLOR_BUFFER_BIT" | "BLEND" | "DEPTH_TEST"
  | "ONE" | "FUNC_ADD" | "FUNC_REVERSE_SUBTRACT"
>;

/** One attribute of an interleaved buffer, measured in floats because everything here is. */
export type AttribSpec = { name: string; size: number; offsetFloats: number };

export class Program {
  readonly name: string;
  readonly handle: WebGLProgram;
  private readonly gl: Gl;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: Gl, name: string, vertexSrc: string, fragmentSrc: string) {
    this.gl = gl;
    this.name = name;
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSrc, `${name}.vert`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSrc, `${name}.frag`);
    const program = gl.createProgram();
    if (!program) throw new Error(`${name}: createProgram returned null`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`${name}: link failed\n${log ?? "(no log)"}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.handle = program;
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  /** Cached, because `getUniformLocation` is a synchronous driver round trip. */
  at(name: string): WebGLUniformLocation | null {
    const hit = this.uniforms.get(name);
    if (hit !== undefined) return hit;
    const loc = this.gl.getUniformLocation(this.handle, name);
    this.uniforms.set(name, loc);
    return loc;
  }

  setVec3(name: string, v: readonly [number, number, number]): void {
    const loc = this.at(name);
    if (loc) this.gl.uniform3f(loc, v[0], v[1], v[2]);
  }

  setFloat(name: string, v: number): void {
    const loc = this.at(name);
    if (loc) this.gl.uniform1f(loc, v);
  }

  setInt(name: string, v: number): void {
    const loc = this.at(name);
    if (loc) this.gl.uniform1i(loc, v);
  }

  /** Binds the shared `View` block to a binding point. Silent if the block was optimised out. */
  bindBlock(blockName: string, index: number): void {
    const i = this.gl.getUniformBlockIndex(this.handle, blockName);
    // 0xFFFFFFFF is INVALID_INDEX, which is what you get when every member went unused and
    // the compiler removed the block. Not an error: it means this program does not need it.
    if (i === 0xffffffff) return;
    this.gl.uniformBlockBinding(this.handle, i, index);
  }

  destroy(): void {
    this.gl.deleteProgram(this.handle);
  }
}

function compile(gl: Gl, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`${label}: createShader returned null`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
  const log = gl.getShaderInfoLog(sh) ?? "(no log)";
  gl.deleteShader(sh);
  throw new Error(`${label}: compile failed\n${log}\n${numbered(src, log)}`);
}

/**
 * The source around the fault, numbered.
 *
 * The driver reports a line number against the assembled string, and the assembled string is
 * three chunks the author never sees as one document. Printing the neighbourhood turns
 * "ERROR: 0:118" from a dead end into a location.
 */
function numbered(src: string, log: string): string {
  const m = /\b0:(\d+)/.exec(log);
  const lines = src.split("\n");
  const centre = m ? Number(m[1]) : 1;
  const from = Math.max(0, centre - 6);
  const to = Math.min(lines.length, centre + 5);
  return lines
    .slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(4)} | ${l}`)
    .join("\n");
}

/**
 * A CPU-mirrored GPU buffer.
 *
 * `upload` takes the dirty range the layer reports and sends only that, which is the whole
 * point of the mirroring: a frame with no arrivals sends nothing at all. `bufferSubData`
 * with a source range rather than a subarray, so there is no allocation per upload either.
 */
export class MirrorBuffer {
  readonly handle: WebGLBuffer;
  private readonly gl: Gl;
  private readonly floats: Float32Array;

  constructor(gl: Gl, floats: Float32Array, usage: number) {
    this.gl = gl;
    this.floats = floats;
    const b = gl.createBuffer();
    if (!b) throw new Error("createBuffer returned null");
    this.handle = b;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, floats.byteLength, usage);
  }

  upload(firstFloat: number, countFloats: number): void {
    if (countFloats <= 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handle);
    gl.bufferSubData(gl.ARRAY_BUFFER, firstFloat * 4, this.floats, firstFloat, countFloats);
  }

  destroy(): void {
    this.gl.deleteBuffer(this.handle);
  }
}

/**
 * Point a program's attributes at an interleaved buffer.
 *
 * `baseInstance` shifts every pointer by whole instances. WebGL2 has no base instance
 * parameter on the draw call, so this is where an offset draw comes from, and it is why the
 * FIFO layers can hand back a live range that starts anywhere in their ring buffer.
 */
export function bindAttribs(
  gl: Gl,
  program: Program,
  buffer: MirrorBuffer,
  strideFloats: number,
  specs: readonly AttribSpec[],
  divisor: number,
  baseInstance = 0,
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer.handle);
  const strideBytes = strideFloats * 4;
  for (const spec of specs) {
    const loc = gl.getAttribLocation(program.handle, spec.name);
    if (loc < 0) continue;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(
      loc,
      spec.size,
      gl.FLOAT,
      false,
      strideBytes,
      (baseInstance * strideFloats + spec.offsetFloats) * 4,
    );
    gl.vertexAttribDivisor(loc, divisor);
  }
}
