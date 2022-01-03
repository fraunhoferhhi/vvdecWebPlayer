'use strict';

const DEFAULT_BITSTREAM = "/demo/RA_Meridian_1080p59_BR1000000.mp4";
const DEFAULT_FPS = 50;

let decoderWorker;                       // WebWorker that loads WASM, instantiates, and runs the decoder
let playingStatus = "stop";              // playback status "play"/"pause"/"stop"
let playingIndex;                        // index of the currently playing bitstream in the bitstream list
let duration;                            // duration read from the mp4 metadata
let numFrames;                           // number of video frames read from the mp4 metadata
let vidFrameH, vidFrameW, vidBitDepth;   // size and bit depth of previous displayed frames
let vidTrackMaxW, vidTrackMaxH;          // maximum size of the currently playing track (from mp4 metadata)
let outputDisabled;                      // benchmarking: don't do the actual WebGL drawing
let needWebGlReinit = true;              // video size or resolution changed -> need to setup GL textures
let displaySizeFixed = document.getElementById("checkFixedSize").checked;
let loopPlayback = document.getElementById("checkLoopPlayback").checked;

// DOM-nodes
const canvas = document.getElementById("canvas");
const buttonPlay = document.getElementById("btnPlay");
const buttonStop = document.getElementById("btnStop");
const bitstreamList = document.getElementById("selectBitstream");

buttonPlay.onclick = play_pause;
buttonStop.onclick = stop;
document.getElementById("btnDownload").onclick = downloadBitstream;

document.getElementById("checkIgnoreFPS").onchange = function (e) { FrameDisplayScheduler.ignoreTargetFPS = this.checked; };
document.getElementById("checkNoOutput").onchange = function (e) { outputDisabled = this.checked; };
document.getElementById("checkFixedSize").onchange = function (e) { displaySizeFixed = this.checked; };
document.getElementById("checkLoopPlayback").onchange = function (e) { loopPlayback = this.checked; };

populateBitstreamList();

const MeasureFPS = {
  intervalStart: undefined,        // starting time of the current measurement interval
  overallStart: undefined,
  framesInInterval: undefined,     // the number of frames in the current interval
  framesOverall: undefined,
  get isStarted() { return this.intervalStart !== undefined; },

  reset: function () {
    this.intervalStart = undefined;
    this.overallStart = undefined;
    this.framesInInterval = 0;
    this.framesOverall = 0;
  },

  start: function () {
    this.overallStart = this.intervalStart = performance.now();
    this.framesOverall = this.framesInInterval = 0;
  },

  addFrame: function () {
    ++this.framesInInterval;
    ++this.framesOverall;

    const now = performance.now();
    const isFirstSecond = now - this.overallStart <= 1000;   // update more often within the first second
    if (now - this.intervalStart > 2000
      || (isFirstSecond && now - this.intervalStart > 500)) {
      this.updateDisplay(false);

      this.framesInInterval = 0;
      this.intervalStart = now;
    }
  },

  updateDisplay: function (overall) {
    let fps;
    const now = performance.now();
    if (overall) {
      fps = this.framesOverall / (now - this.overallStart) * 1000;
    }
    else {
      fps = this.framesInInterval / (now - this.intervalStart) * 1000;
    }
    updateStatusDisplay({ fps: `${fps.toPrecision(4)} fps ${overall ? "(overall)" : ""}` });
  }
};

const FrameQueue = {
  queue: [],                          // decoded frames to display
  queueLengthTarget: 33,               // request this many new frames from the decoderWorker. grows when the queue underruns
  queueLengthMax: 33,                 // never grow queueLengthTarget grows, beyond this limit
  frameRequestsOutstanding: 0,        // don't request new frames when this.queue.length + frameRequestsOutstanding > queueLengthTarget
  frameRequestsOutstandingMax: 10,    // limit outstanding frame requests, to ensure the decoder does not run OOM before we have processed them
  buffering: true,                    // fillig the queue, to display frames smoothly

  get isFull() { return this.queue.length >= this.queueLengthTarget; },
  get length() { return this.queue.length; },

  start: function () {
    this.buffer = true;
    this.requestFrames();
  },

  push: function (frame) {
    this.queue.push(frame);
    --this.frameRequestsOutstanding;
    // console.log(`push ${queue.length} + ${frameRequestsOutstanding}`)

    this.requestFrames();

    if (this.isFull || frame === "EOF") {
      this.buffering = false;
    }
  },

  take: function () {
    if (this.buffering) {
      this.requestFrames();
      return;
    }

    const frame = this.queue.shift();
    if (frame) {
      this.requestFrames();
      return frame;
    }
    console.warn(`no frame (${this.queueLengthTarget})`);

    this.startBuffering();
  },

  clear: function (doWarn) {
    while (this.queue.length) {
      if (doWarn) {
        console.warn(`queue not empty ${this.queue.length}`);
      }
      const frame = this.queue.shift();
      releaseFrame(frame);
    }
    this.frameRequestsOutstanding = 0;
  },

  startBuffering: function () {
    this.buffering = true;

    // increase queue length
    this.queueLengthTarget = Math.floor(Math.min(this.queueLengthMax, this.queueLengthTarget * 1.5));
    print(`buffering. (qlen: ${this.queueLengthTarget})`);

    this.requestFrames();
  },

  requestFrames: function () {
    while (this.frameRequestsOutstanding < this.frameRequestsOutstandingMax
      && this.queue.length + this.frameRequestsOutstanding <= this.queueLengthTarget) {

      decoderWorker.postMessage({ cmd: 'requestFrame' });
      ++this.frameRequestsOutstanding;
    }
  },
};

const FrameDisplayScheduler = {
  frameScheduleIntervalID: undefined,             // the Interval to display frames at requested FPS rate
  targetFPS: undefined,                           // the FPS at which to try displaying frames
  ignoreTargetFPS: undefined,                     // benchmarking: ignore the targetFPS read from the mp4
  firstFrameTS: undefined,                        // timestamp of the first displayed frame after buffering, to calculate following display times
  frameCount: undefined,                          // number of frames since the last buffering, to calculate FPS
  prevTS: undefined,

  start: function (targetFPS) {
    if (targetFPS !== undefined) {
      this.targetFPS = targetFPS;
    }
    this.firstFrameTS = 0;
    this.frameCount = 0;

    if (this.ignoreTargetFPS) {
      // playback as fast as possible (bypass animationCallback())
      drawNextFrame();
    }
    else if (!this.frameScheduleIntervalID) {
      this.scheduleCB();
    }
  },

  scheduleCB: function () {
    this.frameScheduleIntervalID = requestAnimationFrame((ts) => { this.animationCallback(ts); });
  },

  animationCallback: function (timestamp) {
    // it's not time to draw the next frame, yet
    if (this.firstFrameTS && (timestamp < this.firstFrameTS + 1000 * this.frameCount / this.targetFPS)) {
      this.scheduleCB();
      return;
    }

    // multiple callbacks within the same frame
    if (this.prevTS === timestamp) {
      this.scheduleCB();
      return;
    }
    this.prevTS = timestamp;

    const ret = drawNextFrame();
    if (ret === "EOF" || playingStatus !== "play") { // end of file reached. stop animationCallback
      this.frameScheduleIntervalID = undefined;
      this.firstFrameTS = undefined;
      this.frameCount = 0;
      return;
    }

    if (ret === "buffering" || ret === "loop") {
      this.firstFrameTS = 0;
      this.frameCount = 0;
    }
    else {
      if (!this.firstFrameTS) {
        this.firstFrameTS = timestamp;
      }
      ++this.frameCount;
    }

    this.scheduleCB();
    return;
  }
};

function updateUIButtons() {
  buttonPlay.disabled = false;
  buttonStop.disabled = false;

  if (playingStatus === "stop") { // initial start
    buttonPlay.classList.replace("bi-pause-fill", "bi-play-fill");
    buttonStop.disabled = true;

    for (let e of document.getElementsByClassName("disabledDuringPlayback")) {
      e.disabled = false;
    }
  }
  else if (playingStatus === "play") {  // pause decoder
    buttonPlay.classList.replace("bi-play-fill", "bi-pause-fill");

    for (let e of document.getElementsByClassName("disabledDuringPlayback")) {
      e.disabled = true;
    }
  }
  else if (playingStatus === "pause") {  // resume playback
    buttonPlay.classList.replace("bi-pause-fill", "bi-play-fill");

    for (let e of document.getElementsByClassName("disabledDuringPlayback")) {
      e.disabled = false;
    }
  }
}

const statusElem = document.getElementById("status");
function updateStatusDisplay(data) {
  if ((typeof data === 'string') || (data instanceof String)) {
    statusElem.innerText = data;

    statusElem.currStatusData = {}; // clear resolution and fps, when setting a string
  }
  else {
    if (!statusElem.currStatusData) {
      statusElem.currStatusData = {};
    }
    const currStatusData = statusElem.currStatusData;

    // only update if changes
    if ((data.fps && data.fps !== currStatusData.fps) || (data.resolution && data.resolution !== currStatusData.resolution)) {
      // merge new data into existing status data
      for (let e in data) {
        currStatusData[e] = data[e];
      }

      statusElem.innerText = `${currStatusData.resolution} ${currStatusData.fps ? "@ " + currStatusData.fps : ""}`;
    }
  }
}

function play_pause() {
  if (playingStatus === "stop") { // initial start
    runDecoder();
    playingStatus = "play";
  }
  else if (playingStatus === "play") {  // pause decoder
    playingStatus = "pause";
  }
  else if (playingStatus === "pause") {  // resume playback
    playingStatus = "play";

    FrameQueue.start();
    FrameDisplayScheduler.start();
  }

  updateUIButtons();
}

function stop() {
  if (playingStatus !== "pause") {
    MeasureFPS.updateDisplay(true);
  }
  playingStatus = "stop";
  decoderWorker.postMessage({ cmd: 'stop' });
  renderer.clear();
  FrameQueue.clear();
  updateProgressBar(0);
}

let playbackProgress;
let playbackProgressUpdateId;
const playbackProgressElem = document.getElementById("progress");
function updateProgressBar(val) {
  const needVisibilityUpdate = (!playbackProgress || !val) && (playbackProgress != val);
  playbackProgress = val;

  if (needVisibilityUpdate) {
    playbackProgressElem.parentElement.style.visibility = playbackProgress ? "visible" : "hidden";
  }
  if (!playbackProgressUpdateId) {  // only schedule new update, when none in progress
    playbackProgressUpdateId = setTimeout(function () {
      playbackProgressUpdateId = undefined;
      playbackProgressElem.style.width = playbackProgress + "%";
    }, 20); // limit to 50 fps
  }
}

function downloadBitstream() {
  const a = document.createElement("a");
  const url = bitstreamList.value;
  a.href = url;
  a.download = url.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild();
}

async function findAppPath() {
  const tryPaths = [document.location.href.match(/.*\//)[0] + 'bin/', '/install/bin/'];

  for (let path of tryPaths) {
    let resp = await fetch(path + 'vvdecapp.js', { method: 'HEAD' });
    if (resp.ok)
      return path;
  }
  return Promise.reject();
}

async function populateBitstreamList() {
  // use pre-existing bitstream as default, otherwise use DEFAULT_BITSTREAM
  const set_default = bitstreamList.length === 0 ? DEFAULT_BITSTREAM : undefined;

  const response = await fetch("bitstreams.json");
  const bitstreams = await response.json();
  for (let b of bitstreams) {
    const opt = document.createElement("option");
    if (b instanceof Array) {
      opt.value = b[0].toString();
      opt.text = b[1].toString();;
    }
    else {
      opt.text = b.toString();
    }

    // select default:
    if (opt.text === set_default || opt.value === set_default) { opt.selected = true; }

    bitstreamList.add(opt);
  }
}

const output = document.getElementById('output');
if (output) output.value = ''; // clear browser cache
function print(text, noNewLine) {
  if (output) {
    output.value += text + (noNewLine ? "" : "\n");
    output.scrollTop = output.scrollHeight; // focus on bottom
  }
}

function clearOutput() {
  output.value = '';

  MeasureFPS.reset();
  updateStatusDisplay("");
}

function showToast(message, timeout, noNewLine) {
  print(message, noNewLine);

  const toastTemplate = document.getElementById('toastTemplate');
  const toastContainer = document.getElementById('toastContainer');
  if (toastTemplate && toastContainer) {
    const newToastNode = toastTemplate.content.querySelector('.toast').cloneNode(true);
    const toastBody = newToastNode.querySelector('.toast-body');
    toastBody.innerText = message;
    newToastNode.addEventListener('hidden.bs.toast', (e) => { e.target.remove(); });

    toastContainer.appendChild(newToastNode);
    const opts = { autohide: false };
    if (timeout) {
      opts.delay = timeout;
      opts.autohide = true;
    }
    const toast = new bootstrap.Toast(newToastNode, opts);
    toast.show();
  }
}


window.onload = async function () {
  if (!window.SharedArrayBuffer) {
    showToast("SharedArrayBuffer is not supported in your browser, but it is needed for multithreading support in WebAssembly.\n" +
      "Browsers known to be working are Chrome (recommended), Edge, and Firefox");
    return;
  }
  if (window.crossOriginIsolated === false && !navigator.userAgent.match("Code")) {
    showToast("WASM only works when cross origin isolation is enabled.\n"
      + "This needs HTTPS enabled and the following headers to be set:\n"
      + "  Cross-Origin-Resource-Policy: same-origin\n"
      + "  Cross-Origin-Embedder-Policy: require-corp");
  }

  decoderWorker = new Worker("decoderWorker.js");
  decoderWorker.onmessage = function (e) {
    switch (e.data.cmd) {
      case "initDone":
        updateUIButtons();
        break;

      case "out":
        print(e.data.text, e.data.noNewLine);
        break;

      case "err":
        showToast(e.data.text, e.data.noNewLine);
        break;

      case "newMp4Metadata":
        handleMetadata(e.data);
        break;

      case "frame":
        if (playingStatus === "stop") {
          releaseFrame(e.data.frame);
          break;
        }

        enqueueNextFrame(e.data.frame);
        break;

      case "EOF":
        if (playingStatus === "stop") {
          break;
        }
        FrameQueue.push("EOF");

        // only if running as fast as possible, display remaining frames
        if (FrameDisplayScheduler.ignoreTargetFPS) {
          const flushQueue = function () {
            drawNextFrame();
            if (FrameQueue.length) {
              setTimeout(flushQueue, 0);
            }
          };
          flushQueue();
        }
        break;

      case "decoderExited":
        updateUIButtons();
        break;

      case "downloadProgress":
        updateStatusDisplay(`downloading ${(100 * e.data.loaded / e.data.total).toFixed(0)}%`);
        break;
    }
  };
  decoderWorker.postMessage({
    'cmd': 'init',
    'appPath': await findAppPath()
  });
};

function handleMetadata(data) {
  duration = data.duration;
  numFrames = data.numFrames;
  vidTrackMaxW = data.width;
  vidTrackMaxH = data.height;

  FrameDisplayScheduler.start(data.fps);
}

function enqueueNextFrame(frame) {
  FrameQueue.push(frame);

  if (FrameDisplayScheduler.ignoreTargetFPS) {
    // playback as fast as possible (bypass animationCallback())
    drawNextFrame();
  }
}

function drawNextFrame() {
  if (playingStatus !== "play") {
    return;
  }

  const frame = FrameQueue.take();
  if (!frame) {
    return "buffering";
  }

  if (frame === "EOF") {
    updateProgressBar(100);

    handleEOF();
    if (loopPlayback) {
      return "loop";
    }

    // stop draw callback
    return "EOF";
  }

  // start fps measurement
  if (!MeasureFPS.isStarted) {
    MeasureFPS.start();
  }
  updateStatusDisplay({ resolution: `${frame.width}x${frame.height}` });

  drawThreeJS(
    frame.y, frame.u, frame.v,
    frame.width, frame.height,
    frame.width / 2, frame.height / 2,
    frame.strideY, frame.strideUV,
    frame.bitDepth);

  releaseFrame(frame);

  // update FPS counter
  MeasureFPS.addFrame();

  if (frame.cts && duration) {
    updateProgressBar(100 * frame.cts / duration);
  }

  return;
}

function runDecoder(playNext) {
  playingStatus = "play";

  FrameQueue.clear(true);
  FrameQueue.start();
  FrameDisplayScheduler.start(DEFAULT_FPS);  // start with default FPS, will be updated from MP4 metadata
  MeasureFPS.reset();
  duration = undefined;
  if (!playNext) {
    clearOutput();
  }
  updateProgressBar(0);

  if (playNext) {
    bitstreamList.selectedIndex = (playingIndex + 1) % bitstreamList.length;
  }
  // skip list separators
  while (bitstreamList.value.startsWith("---") || bitstreamList.value.startsWith("===")) {
    ++bitstreamList.selectedIndex;
  }

  playingIndex = bitstreamList.selectedIndex;
  decoderWorker.postMessage({
    cmd: 'run',
    bitstream: bitstreamList.value,
    repeat: loopPlayback ? 0 : document.getElementById("repeat").value,
  });
  document.getElementById("videoTitle").innerText = bitstreamList[playingIndex].text;
}

function handleEOF() {
  if (loopPlayback) {
    runDecoder(true);
    return;
  }

  playingStatus = "stop";
  renderer.clear();
  updateUIButtons();
  MeasureFPS.updateDisplay(true);
}

function callMain() {
  clearOutput();

  decoderWorker.postMessage({
    cmd: 'callMain',
    bitstream: bitstreamList.value,
    repeat: document.getElementById("repeat").value,
  });
}


function releaseFrame(frame) {
  const isSAB = frame.y.buffer instanceof SharedArrayBuffer;
  decoderWorker.postMessage({
    cmd: 'releaseFrame',
    planes: [frame.y, frame.u, frame.v]
  },
    isSAB ? undefined : [frame.y.buffer, frame.u.buffer, frame.v.buffer]  // only transfer ownership, if not SharedArrayBuffer
  );
  frame.addr = undefined;  // mark as released
}

const vertexShader = `
  attribute vec2 uv2;

  out highp vec2 lumaCoord;
  out highp vec2 chromaCoord;

  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    lumaCoord = uv;
    chromaCoord = uv2;
  }`;

const fragmentShader = `
  precision highp usampler2D;

  uniform usampler2D textureY;
  uniform usampler2D textureU;
  uniform usampler2D textureV;
  uniform int bitDepth;
  uniform mat3 yuv2rgbMat;

  varying highp vec2 lumaCoord;
  varying highp vec2 chromaCoord;

  out vec4 fragmentColor;

  void main() {
    int bdShift = bitDepth - 8;

    int lumaOffset   =  16 << bdShift;
    int chromaOffset = 128 << bdShift;

    int lumaRange   = (235 - 16) << bdShift;
    int chromaRange = (240 - 16) << bdShift;

    float lumaScale   = 1.0 / float(  lumaRange);
    float chromaScale = 1.0 / float(chromaRange);

    // convert texture to int first, because direct unsigned to float conversion gives linker errors on Windows (using Angle)
    vec3 yuv = vec3(
      float( int(texture2D(textureY,   lumaCoord)[0]) -   lumaOffset ) *   lumaScale,
      float( int(texture2D(textureU, chromaCoord)[0]) - chromaOffset ) * chromaScale,
      float( int(texture2D(textureV, chromaCoord)[0]) - chromaOffset ) * chromaScale
    );

    fragmentColor = vec4( yuv2rgbMat * yuv, 1.0 );
  }`;

const BT601_yuv2rgb = new THREE.Matrix3().set(
  1.0, 0.0, 1.402,
  1.0, -0.344, -0.7141,
  1.0, 1.772, 0.0
);

const BT709_yuv2rgb = new THREE.Matrix3().set(
  1.0, 0.0, 1.5748,
  1.0, -0.1873, -0.4681,
  1.0, 1.8556, 0.0
);

// const renderer = new THREE.WebGLRenderer();
let renderer;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-0.5, 0.5, -0.5, 0.5, 0.1, 10);
camera.position.z = 1;
const material = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  vertexShader: vertexShader,
  fragmentShader: fragmentShader,
  glslVersion: THREE.GLSL3,
  uniforms: {
    textureY: { type: "t", value: undefined },
    textureU: { type: "t", value: undefined },
    textureV: { type: "t", value: undefined },
    bitDepth: { value: undefined },
    yuv2rgbMat: { value: BT709_yuv2rgb }
  }
});

function setupScene(yW, yH, uvW, uvH, strideY, strideUV, bitDepth, bytesPerPixel) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true });
    renderer.autoClear = false;
    renderer.setClearAlpha(0);    // so we can use renderer.clear() on stop to display the VVC logo background
  }

  const useFixedSize = displaySizeFixed && vidTrackMaxW && vidTrackMaxH;
  const displayW = useFixedSize ? vidTrackMaxW : yW;
  const displayH = useFixedSize ? vidTrackMaxH : yH;

  renderer.setSize(yW, yH, !useFixedSize);
  if (useFixedSize) {
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
  }

  window.onresize = function () {
    if (canvas.clientWidth <= displayW) {
      canvas.style.height = (canvas.clientWidth * yH / yW) + 'px';
    }
  };

  let pixFmt = THREE.UnsignedByteType;
  if (bitDepth > 8) {
    pixFmt = THREE.UnsignedShortType;
  }
  if (bytesPerPixel === 2) {
    pixFmt = THREE.UnsignedShortType;
  }

  // release old textures
  const uniforms = material.uniforms;
  uniforms.textureY.value?.dispose();
  uniforms.textureU.value?.dispose();
  uniforms.textureV.value?.dispose();

  // allocate new textures
  let textureY, textureU, textureV;
  if (pixFmt === THREE.UnsignedByteType) {
    textureY = new THREE.DataTexture(new Uint8Array(), strideY, yH, THREE.RedIntegerFormat, pixFmt);
    textureU = new THREE.DataTexture(new Uint8Array(), strideUV, uvH, THREE.RedIntegerFormat, pixFmt);
    textureV = new THREE.DataTexture(new Uint8Array(), strideUV, uvH, THREE.RedIntegerFormat, pixFmt);

    textureY.internalFormat = 'R8UI';
    textureU.internalFormat = 'R8UI';
    textureV.internalFormat = 'R8UI';
  }
  else {
    textureY = new THREE.DataTexture(new Uint16Array(), strideY, yH, THREE.RedIntegerFormat, pixFmt);
    textureU = new THREE.DataTexture(new Uint16Array(), strideUV, uvH, THREE.RedIntegerFormat, pixFmt);
    textureV = new THREE.DataTexture(new Uint16Array(), strideUV, uvH, THREE.RedIntegerFormat, pixFmt);

    textureY.internalFormat = 'R16UI';
    textureU.internalFormat = 'R16UI';
    textureV.internalFormat = 'R16UI';
  }
  // set new textures for material
  uniforms.textureY.value = textureY;
  uniforms.textureU.value = textureU;
  uniforms.textureV.value = textureV;
  uniforms.bitDepth.value = bitDepth;

  const geometry = new THREE.PlaneGeometry();
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 1, yW / strideY, 1, 0, 0, yW / strideY, 0]), 2));
  geometry.setAttribute("uv2", new THREE.BufferAttribute(new Float32Array([0, 1, uvW / strideUV, 1, 0, 0, uvW / strideUV, 0]), 2));

  scene.add(new THREE.Mesh(geometry, material));

  needWebGlReinit = false;
}

function drawThreeJS(planeY, planeU, planeV, yW, yH, uvW, uvH, strideY, strideUV, bitDepth, bytesPerPixel) {
  if (yW !== vidFrameW || yH !== vidFrameH || bitDepth !== vidBitDepth) {
    vidFrameW = yW;
    vidFrameH = yH;
    vidBitDepth = bitDepth;

    for (let c of scene.children) {
      scene.remove(c);
      c.geometry.dispose();
    }

    needWebGlReinit = true;
  }

  if (outputDisabled) {
    return;
  }

  if (needWebGlReinit) {
    setupScene(yW, yH, uvW, uvH, strideY, strideUV, bitDepth, bytesPerPixel);
  }

  const useFixedSize = displaySizeFixed && vidTrackMaxW && vidTrackMaxH;
  // update aspect ratio of renderer
  if (Math.abs(canvas.clientWidth / canvas.clientHeight - yW / yH) > 0.01) {
    renderer.setSize(yW, canvas.clientWidth * yH / yW, !useFixedSize);

    if (useFixedSize) {
      canvas.style.width = vidTrackMaxW + 'px';
      canvas.style.height = canvas.clientWidth * yH / yW + 'px';
    }
  }

  const textureY = material.uniforms.textureY.value;
  const textureU = material.uniforms.textureU.value;
  const textureV = material.uniforms.textureV.value;

  textureY.image.data = planeY;
  textureU.image.data = planeU;
  textureV.image.data = planeV;
  textureY.needsUpdate = true;
  textureU.needsUpdate = true;
  textureV.needsUpdate = true;

  renderer.render(scene, camera);
}

// const yuvFile = "/image_1080p_10b.yuv";
// const w = 1920;
// const h = 1080;
// const b = 10;

// // const yuvFile = "/image_1080p_8b.yuv";
// // const w = 1920;
// // const h = 1080;
// // const b = 8;

// fetch(yuvFile).then(async function (response) {
//   const buf = await response.arrayBuffer();
//   const ArrayT = (b === 8 ? Uint8Array : Uint16Array);
//   const bpp = (b === 8 ? 1 : 2);

//   const drawLoop = function () {
//     // start fps measurement
//     if (!MeasureFPS.isStarted) {
//       MeasureFPS.start();
//     }


//     drawThreeJS(
//       new ArrayT(buf, 0, w * h),
//       new ArrayT(buf, bpp * (w * h), (w / 2 * h / 2)),
//       new ArrayT(buf, bpp * (w * h + w / 2 * h / 2), (w / 2 * h / 2)),
//       w, h,
//       w / 2, h / 2,
//       w, w / 2,
//       b);


//     // update FPS counter
//     MeasureFPS.addFrame();

//     // loop
//     if (playingStatus === undefined)
//       setTimeout(drawLoop, 0);
//   };

//   playingStatus = undefined;
//   updateStatusDisplay({ resolution: `${w}x${h}` });
//   drawLoop();
// });
