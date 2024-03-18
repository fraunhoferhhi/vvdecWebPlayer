'use strict';

//const DEFAULT_BITSTREAM = "/demo/RA_Meridian_1080p59_BR1000000.mp4";
const DEFAULT_BITSTREAM = "";

const COUNT_TO_HI_LO_MAP = {
  2: ["Low", "High"],
  3: ["Low", "Medium", "High"]
};

import VVCPlayer from "./VVCPlayer.mjs";
import uPlot from "./lib/uPlot.esm.min.js";


let playingIndex;                        // index of the currently playing bitstream in the bitstream list
let player;                              // the VVCPlayer instance
let loopPlayback = document.getElementById("checkLoopPlayback").checked;

// DOM-nodes
const buttonPlay = document.getElementById("btnPlay");
const buttonStop = document.getElementById("btnStop");
const bitstreamList = document.getElementById("selectBitstream");
const videoWrapper = document.getElementById('videoWrapper');
const output = document.getElementById('output');
const progressBar = document.getElementById("progress");
const downloadProgressBar = document.getElementById("downloadProgress");
const statusElem = document.getElementById("status");

const actRendition = document.getElementById("actRendition");
const buttonDecR = document.getElementById("btnDecRend");
const buttonIncR = document.getElementById("btnIncRend");
buttonDecR.onclick = decRendition;
buttonIncR.onclick = incRendition;

buttonPlay.onclick = play_pause;
buttonStop.onclick = stop;
videoWrapper.onclick = buttonPlay.onclick;
videoWrapper.ondblclick = () => player.toggleFullScreen();
bitstreamList.onchange = updateDownloadLink;


document.getElementById("checkIgnoreFPS").onchange = function (e) { player.FrameDisplayScheduler.ignoreTargetFPS = this.checked; };
document.getElementById("checkNoOutput").onchange = function (e) { player.outputDisabled = this.checked; };
document.getElementById("checkFixedSize").onchange = function (e) { player.displaySizeFixed = this.checked; };
document.getElementById("checkLoopPlayback").onchange = function (e) { loopPlayback = this.checked; };
document.getElementById("inputNumThreads").onchange = function (e) { if (this.checkValidity()) player.numDecoderThreads = (this.value || -1); };

const bitstreamListPromise = populateBitstreamList();

//
// Player Initialization
//
window.onload = async function () {
  clearOutput();

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

  player = new VVCPlayer(document.getElementById("canvas"), await findAppPath());
  player.displaySizeFixed = document.getElementById("checkFixedSize").checked;
  player.onReady = (firstInit) => {
    updateUIButtons();

    // automatically start playback
    if (firstInit && document.location.hash === '#autoplay') {
      bitstreamListPromise.then(startPlayback);
    }
  };
  player.onStatusChange = () => { updateUIButtons(); };
  player.onEOF = handleEOF;
  player.onMetadata = handleMetadata;
  player.onDownloadProgress = function (percent, isChunk) {
    if (!isChunk) {
      updateStatusDisplay(`downloading ${percent.toFixed(0)}%`);
    }
  };
  player.onDrawFrame = handleDrawFrame;
  player.onPrintMsg = print;
  player.onErrorMsg = showToast;
  player.defaultRenditionIdx = () => (player.renditions ?? [0]).length - 1;
};

function decRendition() {
  player.rendition = player.rendition.idx - 1;
  actRendition.innerText = player.rendition.displayName;
  updateUIButtons();
}

function incRendition() {
  player.rendition = player.rendition.idx + 1;
  actRendition.innerText = player.rendition.displayName;

  updateUIButtons();
}

function updateUIButtons() {
  buttonPlay.disabled = false;
  buttonStop.disabled = false;
  buttonPlay.focus({ preventScroll: true });

  if (player.renditions?.length) {
    buttonDecR.disabled = player.rendition.idx === 0;
    buttonIncR.disabled = player.rendition.idx === player.renditions?.length - 1;
    buttonDecR.hidden = false;
    buttonIncR.hidden = false;
  }
  else {
    buttonDecR.hidden = true;
    buttonIncR.hidden = true;
  }

  if (player.playingStatus === "stop") { // initial start
    buttonPlay.classList.replace("bi-pause-fill", "bi-play-fill");
    buttonStop.disabled = true;

    for (let e of document.getElementsByClassName("disabledDuringPlayback")) {
      e.disabled = false;
    }
  }
  else if (player.playingStatus === "play") {  // pause decoder
    buttonPlay.classList.replace("bi-play-fill", "bi-pause-fill");

    for (let e of document.getElementsByClassName("disabledDuringPlayback")) {
      e.disabled = true;
    }
  }
  else if (player.playingStatus === "pause") {  // resume playback
    buttonPlay.classList.replace("bi-pause-fill", "bi-play-fill");

    for (let e of document.getElementsByClassName("disabledDuringPlayback")) {
      e.disabled = false;
    }
  }
}

function play_pause() {
  if (player.playingStatus === "stop") { // initial start
    startPlayback();
  }
  else if (player.playingStatus === "play") {  // pause decoder
    player.pause();
  }
  else if (player.playingStatus === "pause") {  // resume playback
    player.continue();
  }

  updateUIButtons();
}

function stop() {
  if (player.playingStatus !== "pause") {
    MeasureFPS.updateDisplay(true);
  }

  player.stop();

  updateProgressBar(null, null);
}

function startPlayback(playNext) {
  MeasureBitRate.start(player.DEFAULT_FPS);
  PlotBitRate.reset();
  MeasureFPS.reset();

  if (!playNext) {
    clearOutput();
  }
  updateProgressBar(0, 0);

  if (playNext) {
    bitstreamList.selectedIndex = (playingIndex + 1) % bitstreamList.length;
  }
  // skip list separators
  while (bitstreamList.value.startsWith("---") || bitstreamList.value.startsWith("===")) {
    ++bitstreamList.selectedIndex;
  }

  playingIndex = bitstreamList.selectedIndex;
  document.getElementById("videoTitle").innerText = bitstreamList[playingIndex].text;

  const repeat = loopPlayback ? 0 : document.getElementById("repeat").value;  // don't repeat individual sequences, when looping
  player.play(bitstreamList.value, repeat);
}

function updateProgressBar(progress, downloadProgress) {
  progressBar.progressData ??= {
    progress: null,
    downloadProgress: null,
    updateId: null,
    visible: undefined
  };
  const state = progressBar.progressData;

  if (typeof progress !== 'undefined') {
    state.progress = progress;
  }
  if (typeof downloadProgress !== 'undefined') {
    state.downloadProgress = downloadProgress;
  }

  const newVisibility = state.progress !== null || state.downloadProgress !== null;
  if (newVisibility !== state.visible) {
    state.visible = newVisibility;
    progressBar.parentElement.hidden = !state.visible;
  }

  if (!state.updateId) {  // only schedule new update, when none in progress
    state.updateId = setTimeout(function () {
      state.updateId = null;
      progressBar.style.width = `${state.progress ?? 0}%`;
      downloadProgressBar.style.width = `${state.downloadProgress ?? 0}%`;
    }, 20); // limit to 50 fps
  }
}

function updateDownloadLink(e) {
  const a = document.getElementById("btnDownload");
  const url = bitstreamList.value;
  a.href = url;
  a.download = url.split('/').pop();
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
  let optgroup;
  for (let b of bitstreams) {
    const opt = document.createElement("option");
    if (b instanceof Array) {
      opt.value = b[0].toString();
      opt.text = b[1].toString();;
    }
    else {
      if (b.toString().startsWith("---") || b.toString().startsWith("===")) {
        optgroup = document.createElement("optgroup");
        optgroup.label = b.toString();
        bitstreamList.add(optgroup);
        continue;
      }
      opt.text = b.toString();
    }

    // select default:
    if (opt.text === set_default || opt.value === set_default) { opt.selected = true; }

    if (optgroup) {
      optgroup.appendChild(opt);
    }
    else {
      bitstreamList.add(opt);
    }
  }

  updateDownloadLink();
}


//
// Printing and Popup messages
//
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
  actRendition.innerText = "";
}

function showToast(message, noNewLine, timeout) {
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

//
// Player callbacks
//
function handleMetadata(data) {
  MeasureBitRate.targetFPS = data.fps;

  if (data.mp4Duration && player.dashDuration) {
    updateProgressBar(undefined, 100 * data.mp4Duration / data.duration || 0);
  }

  if (data.renditions) {
    console.assert(player.renditions);

    // add display names to renditions in player object
    for (let i = 0; i < player.renditions.length; ++i) {
      const r = player.renditions[i];
      r.displayName = "";
      if (COUNT_TO_HI_LO_MAP[player.renditions.length]) {
        r.displayName = `${COUNT_TO_HI_LO_MAP[player.renditions.length][i]}: `;
      }
      r.displayName += `${(r.bw / (1024 * 1024)).toPrecision(2)} Mbps`;
    }

    updateUIButtons();
  }

  actRendition.innerText = player.rendition?.displayName ?? "";
}

function handleDrawFrame(frame) {
  updateStatusDisplay({ resolution: `${frame.width}x${frame.height}` });

  // start fps measurement
  if (!MeasureFPS.isStarted) {
    MeasureFPS.start();
  }
  // update FPS counter
  MeasureFPS.addFrame();
  MeasureBitRate.addFrame(frame.extra);

  if (frame.cts && player.duration) {
    updateProgressBar(100 * frame.cts / player.duration);
  }
}

function handleEOF() {
  updateProgressBar(100);

  if (loopPlayback) {
    startPlayback(true);
    return true;    // return true to signal looping, so the player doesn't clear the screen
  }

  if (document.fullscreenElement) {
    player.toggleFullScreen();
  }

  updateUIButtons();
  MeasureFPS.updateDisplay(true);
}

function updateStatusDisplay(data) {
  if ((typeof data === 'string') || (data instanceof String)) {
    statusElem.innerText = data;

    statusElem.currStatusData = {}; // clear resolution and fps, when setting a string
  }
  else {
    const currStatusData = statusElem.currStatusData || {};

    // only update if changes
    if ((data.fps && data.fps !== currStatusData.fps)
      || (data.resolution && data.resolution !== currStatusData.resolution)
      || (data.bitRate && data.bitRate !== currStatusData.bitRate)) {
      // merge new data into existing status data
      for (let e in data) {
        currStatusData[e] = data[e];
      }

      statusElem.innerText = `${currStatusData.resolution} `
        + (currStatusData.fps ? `@ ${currStatusData.fps}` : "")
        + (currStatusData.bitRate ? ` / ${(currStatusData.bitRate / 1024).toPrecision(4)} kbps` : "");
    }
  }
}

//
// Measure and Plot metrics
//
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

const MeasureBitRate = {
  bitsInGOP: 0,
  bitsInIP: 0,
  framesInGOP: 0,
  framesInIP: 0,
  targetFPS: undefined,

  start(targetFPS) {
    this.targetFPS = targetFPS;
    this.bitsInGOP = 0;
    this.bitsInIP = 0;
    this.framesInGOP = 0;
    this.framesInIP = 0;
  },
  addFrame(data) {
    // console.log(`tl: ${data.nuh_temporal_id} s:${data.size}`);s

    if (data.nuh_temporal_id === 0 && this.framesInGOP) {
      const gopBitRate = this.bitsInGOP * this.targetFPS / this.framesInGOP;
      // console.log(`GOP (${this.framesInGOP}): ${this.bitsInGOP} bytes = ${gopBitRate}`);

      // updateStatusDisplay({ bitRate: gopBitRate });
      // PlotBitRate.updatePlot(this.framesInGOP, gopBitRate);

      this.bitsInGOP = 0;
      this.framesInGOP = 0;
    }

    if (data.is_rap && this.framesInIP) {
      const ipBitRate = this.bitsInIP * this.targetFPS / this.framesInIP;
      updateStatusDisplay({ bitRate: ipBitRate });
      PlotBitRate.updatePlot(this.framesInIP, ipBitRate);

      this.bitsInIP = 0;
      this.framesInIP = 0;
    }

    ++this.framesInIP;
    ++this.framesInGOP;
    this.bitsInGOP += data.bits;
    this.bitsInIP += data.bits;
  }
};

const PlotBitRate = {
  plotContainer: document.getElementById("plotContainer"),
  collapseContainer: document.getElementById("collapseContainer"),
  maxDataPoints: 20,
  hidden: undefined,
  uplot: undefined,
  uplotOpts: {
    // class: "mx-auto",
    width: 400,
    height: 200,

    legend: { show: false },
    axes: [
      {
        label: "Frames",
        size: 35
      },
      { label: "kbit/s" }
    ],
    series: [
      { label: "Frame" },
      {
        label: "kbit/s",
        stroke: "red",
        width: 1,
        fill: "rgba(255, 0, 0, 0.3)",
        dash: [10, 5],
      }
    ],
    scales: {
      x: {
        range: (self, minVal, maxVal) => [minVal || 0, maxVal || 1000],
        time: false
      },
      y: { range: (self, minVal, maxVal) => [0, Math.floor((maxVal + 999) / 1000) * 1000 || 3000] }
    }
  },
  data: [
    [],  // x-values (timestamps)
    [],  // y-values (series 1)
  ],

  init: function () {
    if (!this.uplot) {
      this.uplotOpts.width = this.plotContainer.clientWidth;
      this.uplot = new uPlot(this.uplotOpts, this.data, this.plotContainer);

      window.addEventListener("resize", () => {
        this.uplot.setSize({ width: this.plotContainer.clientWidth, height: 200 });
      });
      collapseContainer.addEventListener('shown.bs.collapse', () => {
        this.uplot.setSize({ width: this.plotContainer.clientWidth, height: 200 });
        this.hidden = false;
        this.uplot.setData(this.data);
      });
      collapseContainer.addEventListener('hidden.bs.collapse', () => {
        this.hidden = true;
      });
    }
    this.visible = collapseContainer.classList.contains("show");
  },

  reset: function () {
    // clear data
    this.data = [[], []];

    if (!this.hidden) {
      this.uplot.setData(this.data);
    }
  },

  updatePlot: function (numFrames, bits) {
    const prevNumFrames = this.data[0][this.data[0].length - 1] || 0;
    if (prevNumFrames === 0) {  // starting point for first gop at frame zero
      this.data[0].push(prevNumFrames);
      this.data[1].push(bits / 1024);
    }
    this.data[0].push(prevNumFrames + numFrames);
    this.data[1].push(bits / 1024);

    while (this.data[0].length > this.maxDataPoints) {
      this.data[0].shift();
      this.data[1].shift();
    }

    if (!this.hidden) {
      this.uplot.setData(this.data);
    }
  },
};
PlotBitRate.init();
