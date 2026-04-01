const EMPTY = 0;
const SOLID = 1;
const LIQUID = 2;
const HAND = 3;
const FIRE = 4;
const GLASS = 5;
const MOLTEN_GLASS = 6;
const PLANT = 7;
const WOOD = 8;
const LEAF = 9;
const GRASS = 10;
const OIL = 11;
const DIAMOND = 12;

// ── Fast RNG via pre-generated table ──
const RNG_SIZE = 4096;
const RNG_MASK = RNG_SIZE - 1;
const rngTable = new Float32Array(RNG_SIZE);
let rngIdx = 0;
for (let i = 0; i < RNG_SIZE; i++) rngTable[i] = Math.random();

function fastRandom() {
  return rngTable[(rngIdx = (rngIdx + 1) & RNG_MASK)];
}

class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.size = cols * rows;

    // Particle data (Typed Arrays — contiguous memory)
    this.state = new Uint8Array(this.size);
    this.mass  = new Float32Array(this.size);
    this.vely  = new Float32Array(this.size);
    this.velx  = new Float32Array(this.size);  // horizontal velocity (Fire)

    // RGB channels
    this.r = new Uint8Array(this.size);
    this.g = new Uint8Array(this.size);
    this.b = new Uint8Array(this.size);

    // Per-frame double-move prevention
    this.updated = new Uint8Array(this.size);

    // ── Thermal system ──
    this.heat = new Float32Array(this.size);  // heat accumulator per cell
    this.life = new Int16Array(this.size);    // lifespan counter (Fire dies, Molten cools)

    // ── Explicit hand-cell tracking ──
    this.handCells = new Int32Array(this.size);
    this.handCount = 0;

    // ── Pixel data buffer for renderer (RGBA) ──
    this.pixelData = new Uint8Array(this.size * 4);

    // ── Chunk-based Sleep System ──
    this.chunkSize = 16;
    this.chunkCols = Math.ceil(cols / this.chunkSize);
    this.chunkRows = Math.ceil(rows / this.chunkSize);
    this.numChunks = this.chunkCols * this.chunkRows;
    this.chunkActive = new Uint8Array(this.numChunks);
    this.chunkNextActive = new Uint8Array(this.numChunks);
    this.chunkActive.fill(1); // Wake all initially
  }

  // ────────────────────────────────────────
  //  Cell queries (inlined index math)
  // ────────────────────────────────────────
  getIndex(x, y) { return x + y * this.cols; }

  isEmpty(x, y) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return false;
    return this.state[x + y * this.cols] === EMPTY;
  }

  isState(x, y, type) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return false;
    return this.state[x + y * this.cols] === type;
  }

  // ────────────────────────────────────────
  //  Active Region Management
  // ────────────────────────────────────────
  wakeRegion(x, y) {
    const cx = Math.floor(x / this.chunkSize);
    const cy = Math.floor(y / this.chunkSize);

    // Wake 3x3 surrounding chunks to ensure seamless interactions
    const startY = Math.max(0, cy - 1);
    const endY = Math.min(this.chunkRows - 1, cy + 1);
    const startX = Math.max(0, cx - 1);
    const endX = Math.min(this.chunkCols - 1, cx + 1);

    for (let j = startY; j <= endY; j++) {
      const rowOff = j * this.chunkCols;
      for (let i = startX; i <= endX; i++) {
        this.chunkNextActive[i + rowOff] = 1;
      }
    }
  }

  // ────────────────────────────────────────
  //  Cell mutations
  // ────────────────────────────────────────
  setPixel(x, y, state, r, g, b, mass = 1.0, vely = 1.0, velx = 0.0) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = x + y * this.cols;
    this.state[i] = state;
    this.r[i] = r; this.g[i] = g; this.b[i] = b;
    this.mass[i] = mass;
    this.vely[i] = vely;
    this.velx[i] = velx;
    this.updated[i] = 1;
    this.wakeRegion(x, y);
  }

  clearCell(x, y) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = x + y * this.cols;
    this.state[i] = EMPTY;
    this.r[i] = 0; this.g[i] = 0; this.b[i] = 0;
    this.mass[i] = 0; this.vely[i] = 0; this.velx[i] = 0;
    this.heat[i] = 0; this.life[i] = 0;
    this.wakeRegion(x, y);
  }

  movePixel(x, y, newX, newY, newVely = null) {
    // Safety: bounds-check destination to prevent particles vanishing offscreen
    if (newX < 0 || newX >= this.cols || newY < 0 || newY >= this.rows) return;

    const cols = this.cols;
    const i  = x + y * cols;
    const ni = newX + newY * cols;

    this.state[ni] = this.state[i];
    this.r[ni] = this.r[i]; this.g[ni] = this.g[i]; this.b[ni] = this.b[i];
    this.mass[ni]  = this.mass[i];
    this.vely[ni]  = newVely !== null ? newVely : this.vely[i];
    this.velx[ni]  = this.velx[i];
    this.heat[ni]  = this.heat[i];
    this.life[ni]  = this.life[i];
    this.updated[ni] = 1;

    // Clear old position
    this.state[i] = EMPTY;
    this.r[i] = 0; this.g[i] = 0; this.b[i] = 0;
    this.mass[i] = 0; this.vely[i] = 0; this.velx[i] = 0;
    this.heat[i] = 0; this.life[i] = 0;
    
    this.wakeRegion(x, y);
    this.wakeRegion(newX, newY);
  }

  swapPixel(x1, y1, x2, y2) {
    const cols = this.cols;
    const i1 = x1 + y1 * cols;
    const i2 = x2 + y2 * cols;

    let tmp;
    tmp = this.state[i1]; this.state[i1] = this.state[i2]; this.state[i2] = tmp;
    tmp = this.r[i1]; this.r[i1] = this.r[i2]; this.r[i2] = tmp;
    tmp = this.g[i1]; this.g[i1] = this.g[i2]; this.g[i2] = tmp;
    tmp = this.b[i1]; this.b[i1] = this.b[i2]; this.b[i2] = tmp;
    tmp = this.mass[i1]; this.mass[i1] = this.mass[i2]; this.mass[i2] = tmp;
    tmp = this.vely[i1]; this.vely[i1] = this.vely[i2]; this.vely[i2] = tmp;
    tmp = this.velx[i1]; this.velx[i1] = this.velx[i2]; this.velx[i2] = tmp;
    tmp = this.heat[i1]; this.heat[i1] = this.heat[i2]; this.heat[i2] = tmp;
    tmp = this.life[i1]; this.life[i1] = this.life[i2]; this.life[i2] = tmp;

    this.updated[i1] = 1;
    this.updated[i2] = 1;
    
    this.wakeRegion(x1, y1);
    this.wakeRegion(x2, y2);
  }

  // ── Geological Pressure Helper ──
  checkPressure(x, y) {
    let massSum = 0;
    for (let cy = y - 1; cy >= 0; cy--) {
      const ci = x + cy * this.cols;
      const s = this.state[ci];
      if (s === EMPTY || s === HAND) break;
      massSum += this.mass[ci];
    }
    return massSum;
  }

  // ────────────────────────────────────────
  //  Hand management (tracked cells)
  // ────────────────────────────────────────
  clearHands() {
    const { state, r, g, b, mass, vely } = this;
    for (let j = 0; j < this.handCount; j++) {
      const idx = this.handCells[j];
      if (state[idx] === HAND) {
        state[idx] = EMPTY;
        r[idx] = 0; g[idx] = 0; b[idx] = 0;
        mass[idx] = 0; vely[idx] = 0;
      }
    }
    this.handCount = 0;
  }

  setHand(x, y, dx, dy, radius) {
    const { cols, rows, state } = this;
    for (let cy = -radius; cy <= radius; cy++) {
      for (let cx = -radius; cx <= radius; cx++) {
        if (cx * cx + cy * cy > radius * radius) continue;
        const lx = Math.floor(x + cx);
        const ly = Math.floor(y + cy);
        if (lx < 0 || lx >= cols || ly < 0 || ly >= rows) continue;

        const i = lx + ly * cols;
        // GLASS is immovable — hand cannot push it
        if (state[i] === GLASS) continue;
        if (state[i] !== EMPTY && state[i] !== HAND) {
          // Use cascading force push
          if (!this.forcePush(lx, ly, dx, dy)) {
            continue; // Completely blocked — don't destroy particle
          }
        }

        state[i] = HAND;
        this.r[i] = 255; this.g[i] = 255; this.b[i] = 255;
        this.mass[i] = 1.0; this.vely[i] = 0;
        this.updated[i] = 1;
        this.handCells[this.handCount++] = i;
        this.wakeRegion(lx, ly);
      }
    }
  }

  /**
   * Cascading force push — shoves a chain of particles along a direction
   * until empty space is found. Like pushing a row of dominoes.
   */
  forcePush(x, y, dx, dy) {
    const MAX_CHAIN = 12;

    // Determine primary push direction from hand velocity
    let sdx = Math.sign(dx);
    let sdy = Math.sign(dy);

    // No velocity → push radially upward with random horizontal jitter
    if (sdx === 0 && sdy === 0) {
      sdx = fastRandom() > 0.5 ? 1 : -1;
      sdy = -1;
    }

    // Try main movement direction
    if (this._chainPush(x, y, sdx, sdy, MAX_CHAIN)) return true;
    // Try diagonal variants
    if (sdy === 0 && this._chainPush(x, y, sdx, -1, MAX_CHAIN)) return true;
    if (sdx === 0 && this._chainPush(x, y, fastRandom() > 0.5 ? 1 : -1, sdy, MAX_CHAIN)) return true;
    // Try perpendicular directions
    if (this._chainPush(x, y, -sdy, sdx, MAX_CHAIN)) return true;
    if (this._chainPush(x, y, sdy, -sdx, MAX_CHAIN)) return true;
    // Last resort: straight up
    if (sdy !== -1 && this._chainPush(x, y, 0, -1, MAX_CHAIN)) return true;

    return false;
  }

  /**
   * Find the nearest empty cell along (sdx, sdy) from (startX, startY),
   * then shift the entire chain of particles one step toward that gap.
   */
  _chainPush(startX, startY, sdx, sdy, maxSteps) {
    if (sdx === 0 && sdy === 0) return false;
    const { cols, rows, state } = this;

    // Walk along direction to find first empty cell
    let emptyStep = -1;
    for (let step = 1; step <= maxSteps; step++) {
      const cx = startX + sdx * step;
      const cy = startY + sdy * step;
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) break;
      const ci = cx + cy * cols;
      if (state[ci] === HAND || state[ci] === GLASS) break; // Can't push through hand or glass
      if (state[ci] === EMPTY) {
        emptyStep = step;
        break;
      }
    }

    if (emptyStep < 0) return false;

    // Cascade: shift every particle one step toward the empty cell
    for (let step = emptyStep; step >= 1; step--) {
      const toX   = startX + sdx * step;
      const toY   = startY + sdy * step;
      const fromX = startX + sdx * (step - 1);
      const fromY = startY + sdy * (step - 1);
      this.movePixel(fromX, fromY, toX, toY);
    }

    return true;
  }

  // ────────────────────────────────────────
  //  Physics update (Chunk-based sleeping)
  // ────────────────────────────────────────
  update(complexSolid = false) {
    this.updated.fill(0);
    // NOTE: Do NOT zero chunkNextActive here — it contains wake signals
    // from setPixel/setHand/clearCell calls that happened BEFORE update().

    const scanRight = fastRandom() > 0.5;
    const cols = this.cols;
    const state = this.state;
    const updated = this.updated;

    for (let cy = this.chunkRows - 1; cy >= 0; cy--) {
      for (let cx = 0; cx < this.chunkCols; cx++) {
        const cIdx = cx + cy * this.chunkCols;
        if (!this.chunkActive[cIdx]) continue; // SKIP SLEEPING CHUNK!

        const startX = cx * this.chunkSize;
        const endX = Math.min(startX + this.chunkSize, this.cols);
        const startY = cy * this.chunkSize;
        const endY = Math.min(startY + this.chunkSize, this.rows);

        for (let y = endY - 1; y >= startY; y--) {
          const rowOff = y * cols;
          for (let x = startX; x < endX; x++) {
            const scanX = scanRight ? x : (endX - 1 - (x - startX));
            const i = scanX + rowOff;

            if (state[i] === EMPTY || state[i] === HAND || updated[i]) continue;

            const st = state[i];
            
            // Particles that inherently animate/change must keep themselves active
            if (st === FIRE || st === MOLTEN_GLASS || st === LIQUID || st === WOOD || st === LEAF) {
               this.chunkNextActive[cIdx] = 1;
            }

            if (st === SOLID) {
              this.updateSolid(scanX, y, complexSolid);
            } else if (st === LIQUID) {
              this.updateSimpleLiquid(scanX, y);
            } else if (st === FIRE) {
              this.updateFire(scanX, y);
            } else if (st === MOLTEN_GLASS) {
              this.updateMoltenGlass(scanX, y);
            } else if (st === PLANT) {
              this.updatePlant(scanX, y);
            } else if (st === WOOD) {
              this.updateWood(scanX, y);
            } else if (st === LEAF) {
              this.updateLeaf(scanX, y);
            } else if (st === GRASS) {
              this.updateGrass(scanX, y);
            } else if (st === OIL) {
              this.updateOil(scanX, y);
            }
          }
        }
      }
    }

    // Swap buffers
    const temp = this.chunkActive;
    this.chunkActive = this.chunkNextActive;
    this.chunkNextActive = temp;
    this.chunkNextActive.fill(0); // Zero the recycled buffer for next frame
  }

  updateSolid(x, y, complexSolid) {
    const cols = this.cols;
    const i = x + y * cols;

    // Germination check
    if (fastRandom() < 0.005) {
      let hasWater = false;
      let wx = -1, wy = -1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows) {
            if (this.state[nx + ny * cols] === LIQUID) {
              hasWater = true;
              wx = nx; wy = ny;
              break;
            }
          }
        }
        if (hasWater) break;
      }
      
      if (hasWater) {
        this.clearCell(wx, wy); // Consume water
        this.state[i] = PLANT; // Become Seed/Plant
        this.r[i] = 30 + Math.floor(fastRandom() * 20);
        this.g[i] = 120 + Math.floor(fastRandom() * 40);
        this.b[i] = 30 + Math.floor(fastRandom() * 20);
        this.mass[i] = 1.0;
        this.vely[i] = 0;
        this.velx[i] = 0;
        return;
      }
    }

    if (complexSolid) {
      this.vely[i] = Math.min(this.vely[i] + 0.2, 8);
    } else {
      this.vely[i] = 1;
    }

    const v = Math.floor(this.vely[i]);
    let targetY = y;
    let hitFloor = false;

    for (let step = 1; step <= v; step++) {
      if (this.isEmpty(x, y + step)) {
        targetY = y + step;
      } else {
        hitFloor = true;
        break;
      }
    }

    if (targetY !== y) {
      if (this.isState(x, targetY, LIQUID)) {
        this.swapPixel(x, y, x, targetY);
      } else {
        this.movePixel(x, y, x, targetY);
      }
      return;
    }

    if (hitFloor && complexSolid && this.vely[i] > 2) {
      const side = fastRandom() > 0.5 ? 1 : -1;
      const scatterDist = Math.floor(this.vely[i] * 0.5);
      if (this.isEmpty(x + side * scatterDist, y) && this.isEmpty(x + side * scatterDist, y + 1)) {
        this.movePixel(x, y, x + side * scatterDist, y, 1);
        return;
      }
    }

    this.vely[i] = 1;
    const canLeft  = this.isEmpty(x - 1, y + 1);
    const canRight = this.isEmpty(x + 1, y + 1);
    const leftLiq  = this.isState(x - 1, y + 1, LIQUID);
    const rightLiq = this.isState(x + 1, y + 1, LIQUID);
    const dlOpen = canLeft || leftLiq;
    const drOpen = canRight || rightLiq;

    if (dlOpen && drOpen) {
      if (fastRandom() > 0.5) {
        leftLiq ? this.swapPixel(x, y, x - 1, y + 1) : this.movePixel(x, y, x - 1, y + 1);
      } else {
        rightLiq ? this.swapPixel(x, y, x + 1, y + 1) : this.movePixel(x, y, x + 1, y + 1);
      }
    } else if (dlOpen) {
      leftLiq ? this.swapPixel(x, y, x - 1, y + 1) : this.movePixel(x, y, x - 1, y + 1);
    } else if (drOpen) {
      rightLiq ? this.swapPixel(x, y, x + 1, y + 1) : this.movePixel(x, y, x + 1, y + 1);
    }
  }

  updateSimpleLiquid(x, y) {
    if (this.isEmpty(x, y + 1)) {
      this.movePixel(x, y, x, y + 1);
      return;
    }

    const spread = 3;
    let trgLeft = x, trgRight = x;
    for (let s = 1; s <= spread; s++) { if (this.isEmpty(x - s, y)) trgLeft  = x - s; else break; }
    for (let s = 1; s <= spread; s++) { if (this.isEmpty(x + s, y)) trgRight = x + s; else break; }

    const ld = x - trgLeft;
    const rd = trgRight - x;

    if (ld > 0 && rd > 0) {
      fastRandom() > 0.5 ? this.movePixel(x, y, trgLeft, y) : this.movePixel(x, y, trgRight, y);
    } else if (ld > 0) {
      this.movePixel(x, y, trgLeft, y);
    } else if (rd > 0) {
      this.movePixel(x, y, trgRight, y);
    }
  }


  // ── Build RGBA pixel buffer for renderer ──
  buildPixelData() {
    const pd = this.pixelData;
    const { state, r, g, b, size } = this;
    for (let i = 0; i < size; i++) {
      const px = i << 2;
      if (state[i] !== EMPTY && state[i] !== HAND) {
        pd[px]     = r[i];
        pd[px + 1] = g[i];
        pd[px + 2] = b[i];
        // Fire gets partial transparency for glow effect, Glass gets slight transparency
        pd[px + 3] = state[i] === FIRE ? 220 : 255;
      } else {
        pd[px]     = 15;
        pd[px + 1] = 23;
        pd[px + 2] = 42;
        pd[px + 3] = 0;
      }
    }
    return pd;
  }

  // ════════════════════════════════════════
  //  Fire physics
  // ════════════════════════════════════════
  updateFire(x, y) {
    const cols = this.cols;
    const i = x + y * cols;

    // Decrement lifespan
    this.life[i]--;
    if (this.life[i] <= 0) {
      this.clearCell(x, y);
      return;
    }

    // Flicker color based on remaining life
    const lifeRatio = this.life[i] / 40;
    this.r[i] = Math.floor(255 * Math.min(1, lifeRatio + 0.3));
    this.g[i] = Math.floor(80 + 120 * lifeRatio * (0.7 + 0.3 * fastRandom()));
    this.b[i] = Math.floor(20 * lifeRatio);

    // ── Thermal interactions with all 8 neighbors ──
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= this.cols || ny < 0 || ny >= this.rows) continue;
        const ni = nx + ny * cols;
        const ns = this.state[ni];

        const heatPower = Math.max(0.1, this.life[i] / 20.0);

        if (ns === LIQUID) {
          // Fire is quenched by water. Water has a rough chance to vaporize.
          if (fastRandom() < 0.25) {
            this.clearCell(nx, ny);
          }
          this.clearCell(x, y); // Fire dies unconditionally
          return;
        } else if (ns === PLANT || ns === WOOD || ns === LEAF || ns === GRASS || ns === OIL) {
          // Combustion
          if (fastRandom() < (ns === OIL ? 0.3 : 0.05)) {
            this.state[ni] = FIRE;
            this.r[ni] = 255;
            this.g[ni] = 120 + Math.floor(fastRandom() * 100);
            this.b[ni] = 30 + Math.floor(fastRandom() * 50);
            this.life[ni] = 30 + Math.floor(fastRandom() * 30);
            this.heat[ni] = 0;
            this.mass[ni] = 0;
            this.vely[ni] = -1;
            this.velx[ni] = (fastRandom() - 0.5);
            this.updated[ni] = 1;
          }
        } else if (ns === SOLID) {
          // Fire + Sand → heat up, eventually become Glass
          this.heat[ni] += 1.0 * heatPower;
          // Visual: Sand glows orange as it heats
          const heatRatio = Math.min(this.heat[ni] / 30, 1);
          this.r[ni] = Math.floor(220 + 35 * heatRatio);
          this.g[ni] = Math.floor(180 * (1 - heatRatio * 0.5));
          this.b[ni] = Math.floor(100 * (1 - heatRatio * 0.8));

          if (this.heat[ni] >= 30) {
            // Transform to Solid Glass
            this.state[ni] = GLASS;
            this.r[ni] = 160 + Math.floor(fastRandom() * 30);
            this.g[ni] = 210 + Math.floor(fastRandom() * 20);
            this.b[ni] = 240 + Math.floor(fastRandom() * 15);
            this.heat[ni] = 0;
            this.vely[ni] = 0;
            this.velx[ni] = 0;
          }
        } else if (ns === GLASS) {
          // Fire + Glass → heat up, eventually become Molten Glass
          this.heat[ni] += 0.5 * heatPower;
          // Visual: Glass glows orange-red as it heats
          const heatRatio = Math.min(this.heat[ni] / 60, 1);
          if (heatRatio > 0.3) {
            this.r[ni] = Math.floor(160 + 95 * heatRatio);
            this.g[ni] = Math.floor(210 * (1 - heatRatio * 0.6));
            this.b[ni] = Math.floor(240 * (1 - heatRatio * 0.8));
          }

          if (this.heat[ni] >= 60) {
            // Transform to Molten Glass
            this.state[ni] = MOLTEN_GLASS;
            this.r[ni] = 255;
            this.g[ni] = 120 + Math.floor(fastRandom() * 40);
            this.b[ni] = 30 + Math.floor(fastRandom() * 30);
            this.mass[ni] = 1.0;
            this.heat[ni] = 0;
            this.life[ni] = 120; // Cooling timer: ~2 seconds to solidify
          }
        }
      }
    }

    // ── Movement: follow velocity vector with jitter ──
    let vx = this.velx[i];
    let vy = this.vely[i];

    // Add slight random jitter for organic fire look
    vx += (fastRandom() - 0.5) * 0.5;
    vy += (fastRandom() - 0.5) * 0.5;

    // Minimal dampening — fire keeps its momentum
    vx *= 0.98;
    vy *= 0.98;
    this.velx[i] = vx;
    this.vely[i] = vy;

    const moveX = x + Math.round(vx);
    const moveY = y + Math.round(vy);

    // Fire can move through both empty space and hand cells
    const fireCanMove = (fx, fy) => this.isEmpty(fx, fy) || this.isState(fx, fy, HAND);

    if (moveX === x && moveY === y) {
      // Try random jitter move if velocity too small
      const jx = x + (fastRandom() > 0.5 ? 1 : -1);
      const jy = y - 1;
      if (fireCanMove(jx, jy)) {
        this.movePixel(x, y, jx, jy);
      } else if (fireCanMove(x, jy)) {
        this.movePixel(x, y, x, jy);
      }
    } else if (fireCanMove(moveX, moveY)) {
      this.movePixel(x, y, moveX, moveY);
    } else if (fireCanMove(x, moveY)) {
      this.movePixel(x, y, x, moveY);
    } else if (fireCanMove(moveX, y)) {
      this.movePixel(x, y, moveX, y);
    }
  }

  // ════════════════════════════════════════
  //  Molten Glass physics (very slow liquid + cooling)
  // ════════════════════════════════════════
  updateMoltenGlass(x, y) {
    const cols = this.cols;
    const i = x + y * cols;

    // ── Check if any adjacent Fire or Water is nearby ──
    let nearFire = false;
    let nearWater = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows) {
          if (this.state[nx + ny * cols] === FIRE) {
            nearFire = true;
          } else if (this.state[nx + ny * cols] === LIQUID) {
            nearWater = true;
          }
        }
      }
    }

    // ── Cooling timer ──
    if (!nearFire) {
      // Cool rapidly if touching water
      if (nearWater) {
        this.life[i] -= 15; 
      } else {
        this.life[i]--;
      }
      
      // Visual: shift color from orange toward blue-white as it cools
      const coolRatio = Math.max(this.life[i] / 120, 0);
      this.r[i] = Math.floor(160 + 95 * coolRatio);
      this.g[i] = Math.floor(84 + 76 * coolRatio);
      this.b[i] = Math.floor(200 * (1 - coolRatio) + 40 * coolRatio);

      if (this.life[i] <= 0) {
        // Solidify back to Glass
        this.state[i] = GLASS;
        this.r[i] = 160 + Math.floor(fastRandom() * 30);
        this.g[i] = 210 + Math.floor(fastRandom() * 20);
        this.b[i] = 240 + Math.floor(fastRandom() * 15);
        this.mass[i] = 0;
        this.vely[i] = 0;
        this.velx[i] = 0;
        this.heat[i] = 0;
        
        // Optional: Vaporize the touching water blocks occasionally for effect? 
        // We'll just leave it cooling it incredibly fast for now.
        return;
      }
    } else {
      // Stay hot — reset cooling timer near fire
      this.life[i] = Math.min(this.life[i] + 2, 120);
    }

    // ── Very viscous liquid movement (only moves every ~3rd frame) ──
    if (fastRandom() > 0.35) return; // 65% chance of NOT moving → high viscosity

    // Fall down
    if (this.isEmpty(x, y + 1)) {
      this.movePixel(x, y, x, y + 1);
      return;
    }
    // Swap with water below
    if (this.isState(x, y + 1, LIQUID)) {
      this.swapPixel(x, y, x, y + 1);
      return;
    }

    // Very limited horizontal spread (spread=1)
    const canLeft = this.isEmpty(x - 1, y);
    const canRight = this.isEmpty(x + 1, y);
    if (canLeft && canRight) {
      fastRandom() > 0.5 ? this.movePixel(x, y, x - 1, y) : this.movePixel(x, y, x + 1, y);
    } else if (canLeft) {
      this.movePixel(x, y, x - 1, y);
    } else if (canRight) {
      this.movePixel(x, y, x + 1, y);
    }
  }

  // ════════════════════════════════════════
  //  Organic Flora System
  // ════════════════════════════════════════
  updatePlant(x, y) {
    const i = x + y * this.cols;

    if (fastRandom() < 0.01 && this.checkPressure(x, y) > 15) {
      this.turnToOil(x, y);
      return;
    }

    if (this.isEmpty(x, y - 1) && fastRandom() < 0.002) { // Extremely slow start
      const growthEnergy = 8 + Math.floor(fastRandom() * 8);
      this.setPixel(x, y - 1, WOOD, 100 + Math.floor(fastRandom()*20), 70 + Math.floor(fastRandom()*20), 40 + Math.floor(fastRandom()*10), 1.0, 0, 0);
      this.life[x + (y - 1) * this.cols] = growthEnergy;
    }

    this.trySpreadGrass(x, y);
  }

  updateWood(x, y) {
    const i = x + y * this.cols;

    if (fastRandom() < 0.01 && this.checkPressure(x, y) > 15) {
      this.turnToOil(x, y);
      return;
    }

    const energy = this.life[i];
    if (energy > 0 && fastRandom() < 0.01) { // Slower stalk/branch growth
      if (this.isEmpty(x, y - 1)) {
        this.setPixel(x, y - 1, WOOD, 100 + Math.floor(fastRandom()*20), 70 + Math.floor(fastRandom()*20), 40 + Math.floor(fastRandom()*10), 1.0, 0, 0);
        this.life[x + (y - 1) * this.cols] = energy - 1;
        this.life[i] = 0;
      }
      
      // Spawn leaves mostly at higher branches/tips
      if (energy <= 5) {
        const side = fastRandom() > 0.5 ? 1 : -1;
        if (this.isEmpty(x + side, y)) {
           this.setPixel(x + side, y, LEAF, 60 + Math.floor(fastRandom()*30), 180 + Math.floor(fastRandom()*40), 60 + Math.floor(fastRandom()*30), 0.5, 0, 0);
        }
      }
    }
  }

  updateLeaf(x, y) {
    if (fastRandom() < 0.01 && this.checkPressure(x, y) > 15) {
      this.turnToOil(x, y);
      return;
    }
    
    // Fall if nothing below (drifts down)
    if (fastRandom() < 0.1) {
      if (this.isEmpty(x, y + 1)) {
        this.movePixel(x, y, x, y + 1);
      } else if (this.isEmpty(x - 1, y + 1)) {
        this.movePixel(x, y, x - 1, y + 1);
      } else if (this.isEmpty(x + 1, y + 1)) {
        this.movePixel(x, y, x + 1, y + 1);
      }
    }
  }

  updateGrass(x, y) {
    if (fastRandom() < 0.01 && this.checkPressure(x, y) > 15) {
      this.turnToOil(x, y);
      return;
    }

    this.trySpreadGrass(x, y);

    if (fastRandom() < 0.0005 && this.isEmpty(x, y - 1)) {
        this.setPixel(x, y - 1, PLANT, 30 + Math.floor(fastRandom() * 20), 120 + Math.floor(fastRandom() * 40), 30 + Math.floor(fastRandom() * 20), 1.0, 0, 0);
    }
  }

  trySpreadGrass(x, y) {
    if (fastRandom() < 0.02) {
      const side = fastRandom() > 0.5 ? 1 : -1;
      const nx = x + side;
      if (nx >= 0 && nx < this.cols) {
         if (this.isEmpty(nx, y) && this.isState(nx, y + 1, SOLID)) {
            this.setPixel(nx, y, GRASS, 50 + Math.floor(fastRandom()*30), 200 + Math.floor(fastRandom()*55), 50 + Math.floor(fastRandom()*30), 1.0, 0, 0);
         } else if (this.isEmpty(nx, y + 1) && this.isState(nx, y + 2, SOLID)) {
            this.setPixel(nx, y + 1, GRASS, 50 + Math.floor(fastRandom()*30), 200 + Math.floor(fastRandom()*55), 50 + Math.floor(fastRandom()*30), 1.0, 0, 0);
         }
      }
    }
  }

  turnToOil(x, y) {
    this.setPixel(x, y, OIL, 20 + Math.floor(fastRandom()*10), 10 + Math.floor(fastRandom()*10), 30 + Math.floor(fastRandom()*20), 1.5, 1.0, 0);
  }

  // ════════════════════════════════════════
  //  Geological System
  // ════════════════════════════════════════
  updateOil(x, y) {
    if (fastRandom() < 0.01 && this.checkPressure(x, y) > 30) {
      this.setPixel(x, y, DIAMOND, 200 + Math.floor(fastRandom()*55), 230 + Math.floor(fastRandom()*25), 255, 3.0, 0, 0);
      return;
    }

    if (fastRandom() > 0.7) return;

    if (this.isEmpty(x, y + 1)) {
      this.movePixel(x, y, x, y + 1);
      return;
    }
    if (this.isState(x, y + 1, LIQUID)) {
      this.swapPixel(x, y, x, y + 1);
      return;
    }

    const canLeft = this.isEmpty(x - 1, y);
    const canRight = this.isEmpty(x + 1, y);
    if (canLeft && canRight) {
      fastRandom() > 0.5 ? this.movePixel(x, y, x - 1, y) : this.movePixel(x, y, x + 1, y);
    } else if (canLeft) {
      this.movePixel(x, y, x - 1, y);
    } else if (canRight) {
      this.movePixel(x, y, x + 1, y);
    }
  }
}
