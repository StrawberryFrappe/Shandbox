// ═══════════════════════════════════════════════
//  renderer.js — Software & WebGL rendering paths
// ═══════════════════════════════════════════════

class SoftwareRenderer {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.pg = createGraphics(cols, rows);
    this.pg.pixelDensity(1);
    this.pg.noSmooth();
  }

  render(grid) {
    const pg = this.pg;
    const pixelData = grid.buildPixelData();
    pg.loadPixels();
    // Direct typed-array copy — much faster than per-element loop
    pg.pixels.set(pixelData);
    pg.updatePixels();
    image(pg, 0, 0, width, height);
  }

  dispose() {
    this.pg.remove();
  }
}


class WebGLRenderer {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;

    // Offscreen WEBGL buffer at full screen size
    this.glBuffer = createGraphics(width, height, WEBGL);
    this.glBuffer.noSmooth(); // NEAREST filtering

    // p5.Image at grid resolution for texture upload
    this.gridImage = createImage(cols, rows);
    this.gridImage.pixelDensity(1);

    const vert = `
      precision highp float;
      attribute vec3 aPosition;
      attribute vec2 aTexCoord;
      uniform mat4 uModelViewMatrix;
      uniform mat4 uProjectionMatrix;
      varying vec2 vTexCoord;
      void main() {
        vTexCoord = aTexCoord;
        gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
      }
    `;
    const frag = `
      precision highp float;
      varying vec2 vTexCoord;
      uniform sampler2D uTexture;
      void main() {
        vec4 col = texture2D(uTexture, vTexCoord);
        gl_FragColor = col;
      }
    `;
    this.gridShader = this.glBuffer.createShader(vert, frag);
  }

  render(grid) {
    const gl = this.glBuffer;
    gl.clear();

    const pixelData = grid.buildPixelData();
    this.gridImage.loadPixels();
    this.gridImage.pixels.set(pixelData);
    this.gridImage.updatePixels();

    gl.push();
    gl.noStroke();
    
    // Bind shader and set texture uniform
    gl.shader(this.gridShader);
    this.gridShader.setUniform('uTexture', this.gridImage);

    // Apply strict nearest filtering after texture is bound
    const ctx = gl.drawingContext;
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);

    // Draw full-screen quad (WEBGL origin is center)
    gl.rect(-width/2, -height/2, width, height);
    gl.pop();

    image(gl, 0, 0);
  }

  dispose() {
    this.glBuffer.remove();
  }
}
