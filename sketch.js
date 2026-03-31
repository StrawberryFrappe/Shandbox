let grid;
let pg;
let RESOLUTION = 8;
let complexFluid = false;
let complexSolid = false;

let handPose;
let video;
let hands = [];
let modelsLoaded = false;
let gameStarted = false;

// Gesture state vars
let prevPinchCenter = { x: 0, y: 0 };
let pinchRubAccumulator = 0;

function preload() {
  console.log("Loading Handpose...");
  handPose = ml5.handPose({ flipped: true, maxHands: 1 });
}

function setup() {
  let canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('canvas-container');
  noSmooth(); // Keep chunky pixels when scaling

  video = createCapture(VIDEO, { flipped: true });
  video.size(windowWidth, windowHeight);
  video.hide();

  handPose.detectStart(video, gotHands);

  initGrid();
}

function gotHands(results) {
  hands = results;
  if (!modelsLoaded) {
    document.getElementById('loading').classList.add('hidden');
    modelsLoaded = true;
    gameStarted = true;
  }
}

function initGrid() {
  let cols = floor(width / RESOLUTION);
  let rows = floor(height / RESOLUTION);
  grid = new Grid(cols, rows);
  pg = createGraphics(cols, rows);
  pg.pixelDensity(1);
  pg.noSmooth();
}


function draw() {
  background(15, 23, 42); // slate-900 fallback

  if (!gameStarted) return;

  // Process Gestures & Add Particles
  processHands();

  // Update Physics
  grid.update(complexFluid, complexSolid);

  // Render Grid
  renderGrid();
  
  // Draw hand visualizer on top
  drawHandVisuals();

  // Draw FPS Indicator
  drawFPS();
}

function renderGrid() {
  pg.loadPixels();
  for (let i = 0; i < grid.size; i++) {
    const pxIdx = i * 4;
    if (grid.state[i] !== EMPTY) {
      pg.pixels[pxIdx] = grid.r[i];
      pg.pixels[pxIdx + 1] = grid.g[i];
      pg.pixels[pxIdx + 2] = grid.b[i];
      pg.pixels[pxIdx + 3] = 255;
    } else {
      // Background color
      pg.pixels[pxIdx] = 15;
      pg.pixels[pxIdx + 1] = 23;
      pg.pixels[pxIdx + 2] = 42;
      pg.pixels[pxIdx + 3] = 255;
    }
  }
  pg.updatePixels();
  image(pg, 0, 0, width, height);
}

function processHands() {
  if (hands.length === 0) return;
  
  let hand = hands[0];
  let kp = hand.keypoints;
  if (!kp || kp.length < 21) return;

  let thumb = kp[4];
  let index = kp[8];
  
  // Handpose gives coordinates relative to the video feed size.
  // Our video is sized to windowWidth/windowHeight.
  // We need to map screen coordinates to Grid coordinates.
  let pX = (x) => floor(x / RESOLUTION);
  let pY = (y) => floor(y / RESOLUTION);

  // --- 1. SOLID PINCH & RUB GESTURE ---
  let pinchDist = dist(thumb.x, thumb.y, index.x, index.y);
  let pinchCenter = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
  
  let speed = dist(pinchCenter.x, pinchCenter.y, prevPinchCenter.x, prevPinchCenter.y);
  
  // Continuous, flowy rubbing motion
  if (pinchDist < 50 && speed > 1.5) {
    // Dynamically scale the volume of sand based on how fast you rub/move
    let flowRadius = map(speed, 1.5, 25, 0.5, 4, true);
    
    let gx = pX(pinchCenter.x);
    let gy = pY(pinchCenter.y);
    spawnParticles(gx, gy, SOLID, flowRadius, 220 + random(-20, 20), 180 + random(-20, 20), 100);
  }

  // --- 2. LIQUID CUP & POUR GESTURE ---
  // Check if middle, ring, pinky are folded (tips closer to wrist than their MCP joint base)
  let isCup = true;
  let foldedFingers = [12, 16, 20]; // tips
  for (let i of foldedFingers) {
    let mcp = kp[i - 3];
    let wrist = kp[0];
    if (dist(kp[i].x, kp[i].y, wrist.x, wrist.y) > dist(mcp.x, mcp.y, wrist.x, wrist.y) * 1.2) {
      isCup = false;
      break;
    }
  }

  // Check thumb downward angle
  // When y increases, it's going down the screen
  let thumbDownAmount = thumb.y - kp[2].y; // y difference from thumb tip to base
  
  if (isCup && thumbDownAmount > 10 && pinchDist > 80) { // Exclude pinching state
    let flowRatio = map(thumbDownAmount, 10, 100, 1, 4, true);
    let gx = pX(thumb.x);
    let gy = pY(thumb.y);
    spawnParticles(gx, gy, LIQUID, flowRatio, 56, 189, 248); // Flow amount scales with downward angle
  }

  // --- 3. PHYSICAL DISPLACEMENT ---
  // The points of the projection will displace elements no matter what.
  // We loop through a subset of keypoints (e.g. all 21 joints) and punch holes.
  for (let i = 0; i < kp.length; i++) {
    let point = kp[i];
    let gx = pX(point.x);
    let gy = pY(point.y);
    // Enhance the radius size to push more particles since the grid is larger
    grid.displace(gx, gy, 4); 
  }

  prevPinchCenter = pinchCenter;
}

function spawnParticles(x, y, type, radius, r, g, b) {
  for (let dy = -floor(radius); dy <= floor(radius); dy++) {
    for (let dx = -floor(radius); dx <= floor(radius); dx++) {
      if (dx*dx + dy*dy <= radius * radius) {
        let lx = x + dx;
        let ly = y + dy;
        if (Math.random() > 0.3 && grid.isEmpty(lx, ly)) {
          // Slight color variation
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
  if (hands.length > 0) {
    let hand = hands[0];
    let kp = hand.keypoints;
    
    // Draw glowing thumb and index for visual feedback
    noStroke();
    fill(255, 255, 255, 100);
    circle(kp[4].x, kp[4].y, 15);
    circle(kp[8].x, kp[8].y, 15);
    
    // Draw subtle hand wireframe so user knows it's tracking
    stroke(255, 255, 255, 40);
    strokeWeight(2);
    // Draw bones (Handpose standard connections)
    let connections = [
      [0,1],[1,2],[2,3],[3,4], // Thumb
      [0,5],[5,6],[6,7],[7,8], // Index
      [0,9],[9,10],[10,11],[11,12], // Middle
      [0,13],[13,14],[14,15],[15,16], // Ring
      [0,17],[17,18],[18,19],[19,20] // Pinky
    ];
    for (let c of connections) {
      let p1 = kp[c[0]];
      let p2 = kp[c[1]];
      line(p1.x, p1.y, p2.x, p2.y);
    }
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  video.size(windowWidth, windowHeight);
  if (gameStarted) {
    initGrid(); // Re-init grid on resize to prevent array bound errors
  }
}

function drawFPS() {
  fill(0, 255, 0); // Green
  noStroke();
  textSize(24);
  textFont('monospace'); // Gives a retro, fixed-width number feel
  textAlign(RIGHT, TOP);
  text(`FPS: ${floor(frameRate())}`, width - 20, 20);
}
