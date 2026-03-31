const EMPTY = 0;
const SOLID = 1;
const LIQUID = 2;

class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.size = cols * rows;

    // Use Typed Arrays for performance
    this.state = new Uint8Array(this.size);
    this.mass = new Float32Array(this.size);
    this.newMass = new Float32Array(this.size); // Double buffer for mass
    this.vely = new Float32Array(this.size);

    // RGB Channels
    this.r = new Uint8Array(this.size);
    this.g = new Uint8Array(this.size);
    this.b = new Uint8Array(this.size);

    this.updated = new Uint8Array(this.size);
  }

  getIndex(x, y) {
    return x + y * this.cols;
  }

  isEmpty(x, y) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return false;
    return this.state[this.getIndex(x, y)] === EMPTY;
  }

  isState(x, y, type) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return false;
    return this.state[this.getIndex(x, y)] === type;
  }

  setPixel(x, y, state, r, g, b, mass = 1.0, vely = 1.0) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = this.getIndex(x, y);
    this.state[i] = state;
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
    this.mass[i] = mass;
    this.vely[i] = vely;
    this.updated[i] = 1;
  }

  movePixel(x, y, newX, newY, newVely = null) {
    const i = this.getIndex(x, y);
    const ni = this.getIndex(newX, newY);

    this.state[ni] = this.state[i];
    this.r[ni] = this.r[i];
    this.g[ni] = this.g[i];
    this.b[ni] = this.b[i];
    this.mass[ni] = this.mass[i];
    this.vely[ni] = newVely !== null ? newVely : this.vely[i];
    this.updated[ni] = 1;

    // Clear old
    this.state[i] = EMPTY;
    this.r[i] = 0;
    this.g[i] = 0;
    this.b[i] = 0;
    this.mass[i] = 0;
    this.vely[i] = 0;
  }

  swapPixel(x1, y1, x2, y2) {
    const i1 = this.getIndex(x1, y1);
    const i2 = this.getIndex(x2, y2);
    
    const s = this.state[i1]; this.state[i1] = this.state[i2]; this.state[i2] = s;
    const r = this.r[i1]; this.r[i1] = this.r[i2]; this.r[i2] = r;
    const g = this.g[i1]; this.g[i1] = this.g[i2]; this.g[i2] = g;
    const b = this.b[i1]; this.b[i1] = this.b[i2]; this.b[i2] = b;
    const m = this.mass[i1]; this.mass[i1] = this.mass[i2]; this.mass[i2] = m;
    const v = this.vely[i1]; this.vely[i1] = this.vely[i2]; this.vely[i2] = v;

    this.updated[i1] = 1;
    this.updated[i2] = 1;
  }

  update(complexFluid = false, complexSolid = false) {
    this.updated.fill(0);

    // To prevent particles from biasing to one side, we alternate horizontal scan direction
    const scanRight = Math.random() > 0.5;

    // Process bottom to top
    for (let y = this.rows - 1; y >= 0; y--) {
      for (let x = 0; x < this.cols; x++) {
        let scanX = scanRight ? x : this.cols - 1 - x;
        const i = this.getIndex(scanX, y);

        if (this.state[i] === EMPTY || this.updated[i]) continue;

        if (this.state[i] === SOLID) {
          this.updateSolid(scanX, y, complexSolid);
        } else if (this.state[i] === LIQUID && !complexFluid) {
          this.updateSimpleLiquid(scanX, y);
        }
      }
    }

    if (complexFluid) {
      this.updateComplexFluid();
    }
  }

  updateSolid(x, y, complexSolid) {
    const i = this.getIndex(x, y);
    const downEmpty = this.isEmpty(x, y + 1);
    
    // Velocity acceleration
    if (complexSolid) {
      this.vely[i] = Math.min(this.vely[i] + 0.2, 8); // Gravity config
    } else {
      this.vely[i] = 1;
    }

    const v = Math.floor(this.vely[i]);
    let targetY = y;
    let hitFloor = false;

    // Fast-falling based on velocity
    for (let step = 1; step <= v; step++) {
      if (this.isEmpty(x, y + step)) {
        targetY = y + step;
      } else {
        hitFloor = true;
        break;
      }
    }

    if (targetY !== y) {
      // Liquid displacement: Sand sinks in water
      if (this.isState(x, targetY, LIQUID)) {
        this.swapPixel(x, y, x, targetY);
      } else {
        this.movePixel(x, y, x, targetY);
      }
      return;
    }

    // Impact Scattering (Complex Solid Deformation)
    if (hitFloor && complexSolid && this.vely[i] > 2) {
      // When falling fast, occasionally scatter further horizontally to simulate impact displacement
      let side = Math.random() > 0.5 ? 1 : -1;
      let scatterDist = Math.floor(this.vely[i] * 0.5); // Spread relative to impact force
      if (this.isEmpty(x + (side * scatterDist), y) && this.isEmpty(x + (side * scatterDist), y+1)) {
        this.movePixel(x, y, x + (side * scatterDist), y, 1); // Reset vely
        return;
      }
    }

    // Attempt to slide down diagonally (Angle of repose)
    this.vely[i] = 1; // reset velocity upon landing
    const canLeft = this.isEmpty(x - 1, y + 1);
    const canRight = this.isEmpty(x + 1, y + 1);
    
    let leftIsLiquid = this.isState(x - 1, y + 1, LIQUID);
    let rightIsLiquid = this.isState(x + 1, y + 1, LIQUID);

    let downLeftOpen = canLeft || leftIsLiquid;
    let downRightOpen = canRight || rightIsLiquid;

    if (downLeftOpen && downRightOpen) {
      if (Math.random() > 0.5) {
        if(leftIsLiquid) this.swapPixel(x, y, x - 1, y + 1);
        else this.movePixel(x, y, x - 1, y + 1);
      } else {
        if(rightIsLiquid) this.swapPixel(x, y, x + 1, y + 1);
        else this.movePixel(x, y, x + 1, y + 1);
      }
    } else if (downLeftOpen) {
        if(leftIsLiquid) this.swapPixel(x, y, x - 1, y + 1);
        else this.movePixel(x, y, x - 1, y + 1);
    } else if (downRightOpen) {
        if(rightIsLiquid) this.swapPixel(x, y, x + 1, y + 1);
        else this.movePixel(x, y, x + 1, y + 1);
    }
  }

  updateSimpleLiquid(x, y) {
    if (this.isEmpty(x, y + 1)) {
      this.movePixel(x, y, x, y + 1);
      return;
    }

    const canLeft = this.isEmpty(x - 1, y);
    const canRight = this.isEmpty(x + 1, y);

    // Fast-flowing horizontal simulation
    let spread = 3; // Liquid moves up to 3 tiles sideways
    let trgLeft = x;
    let trgRight = x;

    for (let i = 1; i <= spread; i++) {
        if (this.isEmpty(x - i, y)) trgLeft = x - i; else break;
    }
    for (let i = 1; i <= spread; i++) {
        if (this.isEmpty(x + i, y)) trgRight = x + i; else break;
    }

    let leftOpenDist = x - trgLeft;
    let rightOpenDist = trgRight - x;

    if (leftOpenDist > 0 && rightOpenDist > 0) {
      if (Math.random() > 0.5) {
        this.movePixel(x, y, trgLeft, y);
      } else {
        this.movePixel(x, y, trgRight, y);
      }
    } else if (leftOpenDist > 0) {
      this.movePixel(x, y, trgLeft, y);
    } else if (rightOpenDist > 0) {
      this.movePixel(x, y, trgRight, y);
    }
  }

  updateComplexFluid() {
    // Basic Eulerian Mass-based Fluid Compression
    const MaxMass = 1.0;
    const MaxCompress = 0.02;
    const MinMass = 0.0001;
    const MinFlow = 0.01;
    const MaxSpeed = 1.0;

    // Reset newMass and calculate flows
    for (let i = 0; i < this.size; i++) {
        this.newMass[i] = this.mass[i];
    }

    for (let y = this.rows - 1; y >= 0; y--) {
      for (let x = 0; x < this.cols; x++) {
        const i = this.getIndex(x, y);
        if (this.state[i] !== LIQUID) continue;

        let remainingMass = this.mass[i];
        if (remainingMass <= 0) continue;

        // Spread Down
        if (y + 1 < this.rows && this.state[this.getIndex(x, y + 1)] !== SOLID) {
            let flow = this.calculateFlow(remainingMass, this.mass[this.getIndex(x, y + 1)], MaxMass, MaxCompress);
            if (flow > MinFlow) flow *= 0.5; // Flow rate
            if (flow > remainingMass) flow = remainingMass;
            
            if (flow > 0) {
                remainingMass -= flow;
                this.newMass[i] -= flow;
                this.newMass[this.getIndex(x, y + 1)] += flow;
                this.ensureLiquid(x, y + 1);
            }
        }

        if (remainingMass <= 0) continue;

        // Spread Horizontal
        let remainingEqually = remainingMass;
        let flowLeft = 0;
        let flowRight = 0;

        const checkLeft = (x - 1 >= 0 && this.state[this.getIndex(x - 1, y)] !== SOLID);
        const checkRight = (x + 1 < this.cols && this.state[this.getIndex(x + 1, y)] !== SOLID);

        if (checkLeft && checkRight) {
            flowLeft = (remainingMass - this.mass[this.getIndex(x - 1, y)]) / 3;
            if (flowLeft > MinFlow) flowLeft *= 0.5;
            flowRight = (remainingMass - this.mass[this.getIndex(x + 1, y)]) / 3;
            if (flowRight > MinFlow) flowRight *= 0.5;
        } else if (checkLeft) {
            flowLeft = (remainingMass - this.mass[this.getIndex(x - 1, y)]) / 2;
            if (flowLeft > MinFlow) flowLeft *= 0.5;
        } else if (checkRight) {
            flowRight = (remainingMass - this.mass[this.getIndex(x + 1, y)]) / 2;
            if (flowRight > MinFlow) flowRight *= 0.5;
        }

        if (flowLeft > 0) {
            this.newMass[i] -= flowLeft;
            this.newMass[this.getIndex(x - 1, y)] += flowLeft;
            this.ensureLiquid(x - 1, y);
        }
        if (flowRight > 0) {
            this.newMass[i] -= flowRight;
            this.newMass[this.getIndex(x + 1, y)] += flowRight;
            this.ensureLiquid(x + 1, y);
        }
        remainingMass -= (flowLeft + flowRight);

        // Spread Up (Compression bounds)
        if (remainingMass > 0 && y - 1 >= 0 && this.state[this.getIndex(x, y - 1)] !== SOLID) {
            let flowUp = remainingMass - this.mass[this.getIndex(x, y - 1)];
            if (flowUp > MinFlow) flowUp *= 0.5;
            if (flowUp > remainingMass) flowUp = remainingMass;
            if (flowUp > 0) {
                this.newMass[i] -= flowUp;
                this.newMass[this.getIndex(x, y - 1)] += flowUp;
                this.ensureLiquid(x, y - 1);
            }
        }
      }
    }

    // Apply new mass state and handle dry cells
    for (let i = 0; i < this.size; i++) {
        if (this.state[i] === LIQUID || this.newMass[i] > 0) {
            this.mass[i] = this.newMass[i];
            if (this.mass[i] < MinMass) {
                this.state[i] = EMPTY;
                this.mass[i] = 0;
            } else {
                this.state[i] = LIQUID;
                // Update water color depth based on mass pressure
                this.r[i] = 20;
                this.g[i] = 100 + Math.min(Math.floor(this.mass[i] * 50), 100);
                this.b[i] = 200 + Math.min(Math.floor(this.mass[i] * 55), 55);
            }
        }
    }
  }

  calculateFlow(mass, targetMass, blockMass, compress) {
      let totalMass = mass + targetMass;
      let flow = 0;
      if (totalMass <= blockMass) {
          flow = blockMass; // Target can take all
      } else if (totalMass < 2 * blockMass + compress) {
          flow = (blockMass*blockMass + totalMass*compress) / (blockMass + compress);
      } else {
          flow = (totalMass + compress) / 2;
      }
      return flow > mass ? mass : flow - targetMass;
  }

  ensureLiquid(x, y) {
      if (this.state[this.getIndex(x, y)] === EMPTY) {
          this.state[this.getIndex(x, y)] = LIQUID;
      }
  }

  displace(cx, cy, radius) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius) {
          let x = cx + dx;
          let y = cy + dy;
          if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) continue;
          
          let i = this.getIndex(x, y);
          if (this.state[i] !== EMPTY) {
            let dirX = x - cx;
            let dirY = y - cy;
            if (dirX === 0 && dirY === 0) {
              dirX = Math.random() > 0.5 ? 1 : -1;
              dirY = Math.random() > 0.5 ? 1 : -1;
            }
            let length = Math.sqrt(dirX * dirX + dirY * dirY);
            
            // Push outwards depending on the radius size
            let trgX = Math.floor(x + (dirX / length) * Math.max(2, radius));
            let trgY = Math.floor(y + (dirY / length) * Math.max(2, radius));
            
            if (this.isEmpty(trgX, trgY)) {
               this.movePixel(x, y, trgX, trgY);
            } else if (this.isEmpty(x, y - 1)) {
               this.movePixel(x, y, x, y - 1);
            } else if (this.isEmpty(x - 1, y)) {
               this.movePixel(x, y, x - 1, y);
            } else if (this.isEmpty(x + 1, y)) {
               this.movePixel(x, y, x + 1, y);
            } else if (this.isEmpty(x, y + 1)) {
               this.movePixel(x, y, x, y + 1);
            }
          }
        }
      }
    }
  }
}

