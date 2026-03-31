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
    this.glBuffer.noSmooth(); // NEAREST filtering for chunky pixels

    // p5.Image at grid resolution for texture upload
    this.gridImage = createImage(cols, rows);
    this.gridImage.pixelDensity(1);

    // Flag to track first render (texture binding)
    this._firstRender = true;
  }

  render(grid) {
    const img = this.gridImage;
    const pixelData = grid.buildPixelData();

    img.loadPixels();
    img.pixels.set(pixelData);
    img.updatePixels();

    const gl = this.glBuffer;
    gl.clear();
    gl.push();
    gl.noStroke();
    gl.texture(img);
    gl.textureMode(IMAGE);

    // Set NEAREST filtering for sharp pixels (after texture bind)
    const ctx = gl.drawingContext;
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);

    // Draw textured quad filling the buffer
    gl.plane(width, height);
    gl.pop();

    // Composite WebGL buffer onto main P2D canvas
    image(gl, 0, 0);
  }

  dispose() {
    this.glBuffer.remove();
  }
}
