importScripts('https://unpkg.com/ml5@1.0.1/dist/ml5.min.js');

let handPose;
let isReady = false;
let offCanvas = null;
let offCtx = null;

console.log("[Worker] Initializing ML5 HandPose...");

handPose = ml5.handPose({ flipped: true, maxHands: 1 }, () => {
  console.log("[Worker] Model Loaded.");
  isReady = true;
  postMessage({ type: 'ready' });
});

onmessage = async (e) => {
  if (!isReady) return;

  const msg = e.data;
  if (msg.type === 'detect') {
    try {
      // The main thread sends an ImageBitmap
      const bitmap = msg.bitmap;

      // We draw it to an offscreen canvas to safely extract ImageData
      // This is the most reliable way to feed tfjs models inside a WebWorker
      if (!offCanvas) {
        offCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
      } else if (offCanvas.width !== bitmap.width || offCanvas.height !== bitmap.height) {
        offCanvas.width = bitmap.width;
        offCanvas.height = bitmap.height;
      }

      offCtx.drawImage(bitmap, 0, 0);
      const imgData = offCtx.getImageData(0, 0, bitmap.width, bitmap.height);

      // Close bitmap immediately to free memory
      bitmap.close();

      handPose.detect(imgData, (results) => {
        postMessage({ type: 'results', results: results });
      });

    } catch (err) {
      console.error("[Worker] detection error:", err);
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      postMessage({ type: 'results', results: [] }); // Release the detection lock on main thread
    }
  }
};
