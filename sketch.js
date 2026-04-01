let grid;
let RESOLUTION = 8;
let complexSolid = true;

// ── Renderers ──
let softRenderer, glRenderer;
let useWebGL = true;
let useCameraMirror = false;

// ── Hand Tracking Worker ──
let worker;
let isWorkerReady = false;
let video;
let modelsLoaded = false;
let gameStarted = false;

// ── Inference throttling (30fps = every 2nd frame) ──
let detectionPending = false;
let detectionFrameSkip = 2;

// ── Keypoint interpolation ──
let prevRawKP = null;      // Previous raw detection
let currentRawKP = null;   // Latest raw detection
let lerpedKP = null;       // Interpolated keypoints used for processing
let kpLerpT = 1.0;         // Interpolation factor (0→1)

// ── Gesture state ──
let prevPinchCenter = { x: 0, y: 0 };
let prevHandKeypoints = null;
let devilHornsActive = false;
let eraserActive = false;

// Preload is now handled by the Web Worker

function setup() {
  let canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('canvas-container');
  noSmooth();

  video = createCapture(VIDEO, { flipped: true });
  video.size(windowWidth, windowHeight);
  video.hide();

  console.log("Loading Hand Tracking Worker...");
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    if (e.data.type === "LOADED") {
      isWorkerReady = true;
      console.log("Hand Tracking Worker Loaded");
    } else if (e.data.type === "RESULTS") {
      if (!gameStarted) {
        onFirstDetection(e.data.results);
      } else {
        onHandDetected(e.data.results);
      }
    }
  };

  initGrid();
}

function onFirstDetection(results) {
  // First detection received — model is loaded

  // Process initial result
  if (results.length > 0) {
    currentRawKP = results[0].keypoints;
    lerpedKP = currentRawKP.map(kp => ({ x: kp.x, y: kp.y }));
  }

  document.getElementById('loading').classList.add('hidden');
  document.getElementById('solid-toggle').classList.remove('hidden');
  document.getElementById('render-toggle').classList.remove('hidden');
  document.getElementById('camera-toggle').classList.remove('hidden');
  document.getElementById('gesture-legend').classList.remove('hidden');

  let solidCb = document.getElementById('complex-solid-checkbox');
  solidCb.checked = true;
  document.getElementById('complex-solid-checkbox').addEventListener('change', (e) => {
    complexSolid = e.target.checked;
  });

  let webglCb = document.getElementById('webgl-checkbox');
  webglCb.checked = true;
  document.getElementById('webgl-checkbox').addEventListener('change', (e) => {
    useWebGL = e.target.checked;
  });

  let cameraCb = document.getElementById('camera-checkbox');
  cameraCb.checked = false;
  document.getElementById('camera-checkbox').addEventListener('change', (e) => {
    useCameraMirror = e.target.checked;
  });

  modelsLoaded = true;
  gameStarted = true;
}

function onHandDetected(results) {
  prevRawKP = currentRawKP;
  if (results.length > 0) {
    currentRawKP = results[0].keypoints;
  } else {
    currentRawKP = null;
    prevRawKP = null;
  }
  kpLerpT = 0;
  detectionPending = false;
}

function initGrid() {
  let cols = floor(width / RESOLUTION);
  let rows = floor(height / RESOLUTION);
  grid = new Grid(cols, rows);

  // Create both renderers
  if (softRenderer) softRenderer.dispose();
  if (glRenderer) glRenderer.dispose();
  softRenderer = new SoftwareRenderer(cols, rows);
  glRenderer = new WebGLRenderer(cols, rows);
}

// ── Keypoint interpolation ──
function updateKeypoints() {
  if (!currentRawKP) {
    lerpedKP = null;
    return;
  }

  // Advance interpolation (reach target in 2 frames)
  kpLerpT = Math.min(kpLerpT + 0.5, 1.0);

  if (prevRawKP && kpLerpT < 1.0) {
    lerpedKP = currentRawKP.map((kp, idx) => ({
      x: prevRawKP[idx].x + (kp.x - prevRawKP[idx].x) * kpLerpT,
      y: prevRawKP[idx].y + (kp.y - prevRawKP[idx].y) * kpLerpT,
    }));
  } else {
    lerpedKP = currentRawKP.map(kp => ({ x: kp.x, y: kp.y }));
  }
}

// ════════════════════════════════════════
//  Main Draw Loop
// ════════════════════════════════════════
function draw() {
  background(15, 23, 42);

  if (!gameStarted) return;

  if (useCameraMirror && video) {
    push();
    tint(255, 60); // Low opacity to help with visual cues without distraction
    image(video, 0, 0, width, height);
    pop();
  }

  // ── Throttled hand detection (every 2nd frame) ──
  if (frameCount % detectionFrameSkip === 0 && !detectionPending && isWorkerReady && video.loadedmetadata) {
    detectionPending = true;
    createImageBitmap(video.elt).then(bitmap => {
      worker.postMessage({
        type: "DETECT",
        image: bitmap,
        width: video.width,
        height: video.height
      }, [bitmap]);
    }).catch(err => {
      console.error("Image capture error:", err);
      detectionPending = false;
    });
  }

  // ── Interpolate keypoints ──
  updateKeypoints();

  // ── Process Gestures & Add Particles ──
  processHands();

  // ── Update Physics ──
  grid.update(complexSolid);

  // ── Render Grid ──
  if (useWebGL) {
    glRenderer.render(grid);
  } else {
    softRenderer.render(grid);
  }

  // ── Draw hand visualizer on top ──
  drawHandVisuals();

  // ── Draw FPS ──
  drawFPS();
}

// ════════════════════════════════════════
//  Hand processing (uses interpolated keypoints)
// ════════════════════════════════════════
function processHands() {
  grid.clearHands();

  if (!lerpedKP || lerpedKP.length < 21) {
    prevHandKeypoints = null;
    return;
  }

  let kp = lerpedKP;
  let thumb = kp[4];
  let index = kp[8];

  let pX = (x) => floor(x / RESOLUTION);
  let pY = (y) => floor(y / RESOLUTION);

  // --- 1. SOLID PINCH & RUB GESTURE ---
  let pinchDist = dist(thumb.x, thumb.y, index.x, index.y);
  let pinchCenter = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
  let speed = dist(pinchCenter.x, pinchCenter.y, prevPinchCenter.x, prevPinchCenter.y);

  if (pinchDist < 50 && speed > 1.5) {
    let flowRadius = map(speed, 1.5, 25, 0.5, 4, true);
    let gx = pX(pinchCenter.x);
    let gy = pY(pinchCenter.y);
    spawnParticles(gx, gy, SOLID, flowRadius, 220 + random(-20, 20), 180 + random(-20, 20), 100);
  }

  // --- 2. LIQUID CUP & POUR GESTURE ---
  let isCup = true;
  let foldedFingers = [12, 16, 20];
  for (let i of foldedFingers) {
    let mcp = kp[i - 3];
    let wrist = kp[0];
    if (dist(kp[i].x, kp[i].y, wrist.x, wrist.y) > dist(mcp.x, mcp.y, wrist.x, wrist.y) * 1.2) {
      isCup = false;
      break;
    }
  }

  let thumbDownAmount = thumb.y - kp[2].y;
  if (isCup && thumbDownAmount > 10 && pinchDist > 80) {
    let flowRatio = map(thumbDownAmount, 10, 100, 1, 4, true);
    let gx = pX(thumb.x);
    let gy = pY(thumb.y);
    spawnParticles(gx, gy, LIQUID, flowRatio, 56, 189, 248);
  }

  // --- 3. FIRETHROWER (PINKY-THUMB TOUCH GESTURE) ---
  devilHornsActive = detectFireGesture(kp);
  if (devilHornsActive) {
    let pinkyTip = kp[20];
    let thumbTip = kp[4];
    let wrist = kp[0];

    // Direction: wrist → midpoint (fire shoots OUTWARD from the hand hole)
    let midX = (pinkyTip.x + thumbTip.x) / 2;
    let midY = (pinkyTip.y + thumbTip.y) / 2;
    let dirX = midX - wrist.x;
    let dirY = midY - wrist.y;
    let dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
    if (dirLen > 0) {
      dirX /= dirLen;
      dirY /= dirLen;
    } else {
      dirX = 0;
      dirY = -1;
    }

    // Emit from both fingertips
    let emitters = [
      { x: pX(thumbTip.x), y: pY(thumbTip.y) },
      { x: pX(pinkyTip.x), y: pY(pinkyTip.y) }
    ];

    for (let emitter of emitters) {
      // 4–6 particles per fingertip per frame
      let spawnCount = 4 + Math.floor(Math.random() * 3);
      for (let s = 0; s < spawnCount; s++) {
        let sx = emitter.x + Math.floor((Math.random() - 0.5) * 3);
        let sy = emitter.y + Math.floor((Math.random() - 0.5) * 3);
        // Allow spawning on empty OR hand cells (fire passes through hands)
        if (grid.isEmpty(sx, sy) || grid.isState(sx, sy, HAND)) {
          let speed = 4.0 + Math.random() * 3.0;
          let vx = dirX * speed + (Math.random() - 0.5) * 1.5;
          let vy = dirY * speed + (Math.random() - 0.5) * 1.5;

          let cr = 255;
          let cg = Math.floor(100 + Math.random() * 120);
          let cb = Math.floor(Math.random() * 50);

          grid.setPixel(sx, sy, FIRE, cr, cg, cb, 0.0, vy, vx);
          let fi = grid.getIndex(sx, sy);
          grid.life[fi] = 50 + Math.floor(Math.random() * 30);
        }
      }
    }
  }

  // --- 4. ERASER (TWO-FINGER POINT) ---
  eraserActive = detectEraserGesture(kp);
  if (eraserActive) {
    let midX = (kp[8].x + kp[12].x) / 2;
    let midY = (kp[8].y + kp[12].y) / 2;

    let gx = pX(midX);
    let gy = pY(midY);
    let eraserRadius = 4; // larger brush

    for (let dy = -eraserRadius; dy <= eraserRadius; dy++) {
      for (let dx = -eraserRadius; dx <= eraserRadius; dx++) {
        if (dx * dx + dy * dy <= eraserRadius * eraserRadius) {
          let lx = gx + dx;
          let ly = gy + dy;
          if (lx >= 0 && lx < grid.cols && ly >= 0 && ly < grid.rows) {
            if (!grid.isState(lx, ly, HAND) && !grid.isEmpty(lx, ly)) {
              grid.clearCell(lx, ly);
            }
          }
        }
      }
    }
  }

  // --- 4. PHYSICAL DISPLACEMENT ---
  // Bone connections between keypoints (same as visual skeleton)
  let boneConnections = [
    [0, 1], [1, 2], [2, 3], [3, 4],       // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],       // index
    [0, 9], [9, 10], [10, 11], [11, 12],   // middle
    [0, 13], [13, 14], [14, 15], [15, 16], // ring
    [0, 17], [17, 18], [18, 19], [19, 20]  // pinky
  ];

  // Helper: compute hand velocity at a keypoint
  let kpVel = (idx) => {
    if (prevHandKeypoints && prevHandKeypoints[idx]) {
      return {
        dx: pX(kp[idx].x) - pX(prevHandKeypoints[idx].x),
        dy: pY(kp[idx].y) - pY(prevHandKeypoints[idx].y)
      };
    }
    return { dx: 0, dy: 0 };
  };

  // Place hand cells along each bone segment (fills gaps between keypoints)
  let handRadius = 2;
  for (let conn of boneConnections) {
    let a = conn[0], b = conn[1];
    let ax = pX(kp[a].x), ay = pY(kp[a].y);
    let bx = pX(kp[b].x), by = pY(kp[b].y);
    let va = kpVel(a), vb = kpVel(b);

    // Walk along the segment in grid cells
    let segDx = bx - ax, segDy = by - ay;
    let segSteps = Math.max(Math.abs(segDx), Math.abs(segDy), 1);
    for (let s = 0; s <= segSteps; s++) {
      let t = s / segSteps;
      let sx = Math.round(ax + segDx * t);
      let sy = Math.round(ay + segDy * t);
      // Interpolate velocity along segment
      let sdx = Math.round(va.dx + (vb.dx - va.dx) * t);
      let sdy = Math.round(va.dy + (vb.dy - va.dy) * t);
      grid.setHand(sx, sy, sdx, sdy, handRadius);
    }
  }

  // Also set hand cells at each keypoint (slightly larger radius for tips)
  for (let i = 0; i < kp.length; i++) {
    let gx = pX(kp[i].x);
    let gy = pY(kp[i].y);
    let v = kpVel(i);

    // Sweep from previous to current position to avoid tunneling
    if (prevHandKeypoints && prevHandKeypoints[i]) {
      let pgx = pX(prevHandKeypoints[i].x);
      let pgy = pY(prevHandKeypoints[i].y);
      let ddx = gx - pgx, ddy = gy - pgy;
      let dSteps = Math.max(Math.abs(ddx), Math.abs(ddy));
      if (dSteps > 0) {
        for (let s = 1; s <= dSteps; s++) {
          let ix = pgx + Math.round(ddx * s / dSteps);
          let iy = pgy + Math.round(ddy * s / dSteps);
          grid.setHand(ix, iy, v.dx, v.dy, handRadius + 1);
        }
      } else {
        grid.setHand(gx, gy, v.dx, v.dy, handRadius + 1);
      }
    } else {
      grid.setHand(gx, gy, v.dx, v.dy, handRadius + 1);
    }
  }

  prevHandKeypoints = kp.map(p => ({ x: p.x, y: p.y }));
  prevPinchCenter = pinchCenter;
}

// ════════════════════════════════════════
//  Fire gesture: pinky tip touches thumb tip
// ════════════════════════════════════════
function detectFireGesture(kp) {
  let thumbTip = kp[4];
  let pinkyTip = kp[20];
  let touchDist = Math.sqrt((thumbTip.x - pinkyTip.x) ** 2 + (thumbTip.y - pinkyTip.y) ** 2);
  return touchDist < 50; // Trigger when pinky & thumb are close
}

// ════════════════════════════════════════
//  Eraser gesture: index & middle extended, ring curled
// ════════════════════════════════════════
function detectEraserGesture(kp) {
  let wrist = kp[0];
  let d2w = (idx) => dist(kp[idx].x, kp[idx].y, wrist.x, wrist.y);

  // 1. Strict Middle and Index Extended
  // Tip must be significantly further from the wrist than the PIP (first knuckle)
  let indexExtended = d2w(8) > d2w(6) * 1.2;
  let middleExtended = d2w(12) > d2w(10) * 1.2;

  // 2. Strict Ring Curled
  // Tip must be closer to the wrist than the MCP (base knuckle)
  let ringCurledStrict = d2w(16) < d2w(13) * 1.2;

  // Ensure index and middle are somewhat close together indicating they are pointing together
  let pointersParallel = dist(kp[8].x, kp[8].y, kp[12].x, kp[12].y) < 80;

  return indexExtended && middleExtended && ringCurledStrict && pointersParallel;
}

function spawnParticles(x, y, type, radius, r, g, b) {
  for (let dy = -floor(radius); dy <= floor(radius); dy++) {
    for (let dx = -floor(radius); dx <= floor(radius); dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        let lx = x + dx;
        let ly = y + dy;
        if (Math.random() > 0.3 && grid.isEmpty(lx, ly)) {
          let cr = constrain(r + random(-10, 10), 0, 255);
          let cg = constrain(g + random(-10, 10), 0, 255);
          let cb = constrain(b + random(-10, 10), 0, 255);

          if (type === SOLID) {
            grid.setPixel(lx, ly, SOLID, cr, cg, cb, 0.0, 1.0);
          } else if (type === LIQUID) {
            grid.setPixel(lx, ly, LIQUID, cr, cg, cb, 1.0, 1.0);
          }
        }
      }
    }
  }
}

function drawHandVisuals() {
  if (!lerpedKP || lerpedKP.length < 21) return;

  let kp = lerpedKP;

  noStroke();
  fill(255, 255, 255, 100);
  circle(kp[4].x, kp[4].y, 15);
  circle(kp[8].x, kp[8].y, 15);

  stroke(255, 255, 255, 40);
  strokeWeight(2);
  let connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [0, 9], [9, 10], [10, 11], [11, 12],
    [0, 13], [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20]
  ];
  for (let c of connections) {
    let p1 = kp[c[0]];
    let p2 = kp[c[1]];
    line(p1.x, p1.y, p2.x, p2.y);
  }

  // ── Fire blast glow ──
  if (devilHornsActive) {
    let emitX = (kp[20].x + kp[4].x) / 2;
    let emitY = (kp[20].y + kp[4].y) / 2;

    // Pulsing flame glow
    let pulseSize = 30 + Math.sin(frameCount * 0.3) * 10;
    noStroke();

    // Outer glow
    fill(255, 80, 0, 40);
    circle(emitX, emitY, pulseSize * 2.5);

    // Mid glow
    fill(255, 140, 20, 70);
    circle(emitX, emitY, pulseSize * 1.5);

    // Inner core
    fill(255, 220, 80, 120);
    circle(emitX, emitY, pulseSize * 0.7);

    // Highlight fingertips in fire color
    fill(255, 100, 0, 180);
    circle(kp[4].x, kp[4].y, 18);
    circle(kp[20].x, kp[20].y, 18);
  }

  if (eraserActive) {
    // ── Eraser indicator ──
    let emitX = (kp[8].x + kp[12].x) / 2;
    let emitY = (kp[8].y + kp[12].y) / 2;

    noFill();
    stroke(255, 100, 100, 150);
    strokeWeight(2);
    circle(emitX, emitY, RESOLUTION * 10); // visual radius

    // Highlight the two fingers
    fill(255, 50, 50, 180);
    noStroke();
    circle(kp[8].x, kp[8].y, 15);
    circle(kp[12].x, kp[12].y, 15);
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  video.size(windowWidth, windowHeight);
  if (gameStarted) {
    initGrid();
  }
}

function drawFPS() {
  fill(0, 255, 0);
  noStroke();
  textSize(24);
  textFont('monospace');
  textAlign(RIGHT, TOP);
  text(`FPS: ${floor(frameRate())}`, width - 20, 20);
}
