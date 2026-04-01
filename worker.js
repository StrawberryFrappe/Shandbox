let handLandmarker;

async function init() {
  try {
    // Dynamically importing the ESM module inside a classic worker 
    // preserves the `importScripts` global function for Emscripten WASM loading.
    const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/vision_bundle.mjs");
    const { HandLandmarker, FilesetResolver } = vision;

    const resolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm"
    );
    handLandmarker = await HandLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/hand_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "IMAGE",
      numHands: 1
    });
    postMessage({ type: "LOADED" });
  } catch (error) {
    console.error("Worker failed to initialize hand landmarker:", error);
  }
}

init();

self.onmessage = (e) => {
  if (e.data.type === "DETECT" && handLandmarker) {
    const { image, width, height } = e.data;
    
    // Perform detection on the ImageBitmap
    const results = handLandmarker.detect(image);
    
    // Convert to the exact format sketch.js expects (ml5 identically pixel-mapped)
    let ml5format = [];
    if (results.landmarks && results.landmarks.length > 0) {
      ml5format = [{
        keypoints: results.landmarks[0].map(kp => ({
          x: (1 - kp.x) * width, // flipped x-axis
          y: kp.y * height,
          z: kp.z
        }))
      }];
    }
    
    postMessage({ type: "RESULTS", results: ml5format });
    
    // Explicitly close the image bitmap to prevent memory leaks in the worker
    if (image.close) {
      image.close();
    }
  }
};
