'use strict';

importScripts('lib/mp4box.all.min.js');
importScripts('AsyncHelpers.js');

let VVdeC;
let decInstance;
let au;
let frameHandle;
let requestedFrames = 0;
const continueDecoding = new AsyncWaitCondition;
let exitDecoder = false;
const planeAllocations = [];    // cache for locally allocated planes.

let playbackQueue;

let first_frame_cts;

function printOut(text, noNewLine) {
  console.log(text);
  postMessage({ "cmd": "out", "text": text, "noNewLine": noNewLine });
}
function printErr(text, noNewLine) {
  console.warn(text);
  postMessage({ "cmd": "err", "text": text, "noNewLine": noNewLine });
}

const FileDownloader = {
  lastFile: {
    buffer: undefined,
    url: undefined,
    MimeType: undefined,
  },

  fetchFile: async function (url) {
    const urlMatched = this.lastFile.url && this.lastFile.url.match(`https?://.*${url}$`);
    if (this.lastFile.buffer && urlMatched && urlMatched.length === 1) {
      printOut("bitstream already fetched.");
      return this.lastFile;
    }

    printOut(`fetching bitstream (${url})... `, true);

    const response = await new Promise(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        xhr.onprogress = function (e) {
          postMessage({
            cmd: "downloadProgress",
            loaded: e.loaded,
            total: e.total
          });
        };
        xhr.responseType = 'arraybuffer';
        xhr.onload = function (e) {
          if (xhr.readyState === xhr.DONE && xhr.status === 200) {
            resolve({
              ok: true,
              status: xhr.status,
              statusText: xhr.statusText,
              url: url,
              responseURL: xhr.responseURL,
              mime: xhr.getResponseHeader("Content-Type"),
              buffer: new Uint8Array(xhr.response),
            });
          }
          else {
            reject(`Fetching bitstream ${url} failed: ${xhr.statusText} (${xhr.status})`);
          }
        };
        xhr.send();
      }
    );

    this.lastFile = {
      data: response.buffer,
      url: response.url,
      mime: response.mime,
    };

    printOut("done.");
    return this.lastFile;
  }
};

async function decoderRun(urlOrPlaylists, args) {
  let segmented = false;

  console.assert(!playbackQueue, "playback queue already initialized.");
  playbackQueue = new PlaybackQueue;
  if (urlOrPlaylists instanceof Array) {
    playbackQueue.setSegmentPlaylists(urlOrPlaylists);
    playbackQueue.setRendition(args.rendition);
    playbackQueue.mpdDuration = args.mpdDuration;
    playbackQueue.mp4Duration = null;
    segmented = true;
  }
  else {
    playbackQueue.enqueueFile(urlOrPlaylists);
  }
  await playbackQueue.start();

  first_frame_cts = undefined;
  requestedFrames = 0;

  if (decInstance) {
    const startWait = performance.now();
    while (decInstance) {
      if (performance.now() - startWait > 3000) {
        printErr("Previous decoder is still running. Aborting.");
        return;
      }
      printOut("Previous decoder is still running. Waiting...");
      exitDecoder = true;
      await sleep(100);
    }
  }

  let params = new VVdeC.Params();
  params.threads = args.threads ?? 10;
  // params.removePadding = true;
  // params.logLevel = VVdeC.LogLevel.INFO;

  console.assert(!decInstance, "Previous decoder is still running.");
  decInstance = new VVdeC.Decoder(params);
  // workaround to yield to browser runtime until all workers have been initialized
  while (VVdeC.PThread.runningWorkers.some(w => { return !w.loaded; })) {
    await sleep(10);
  }
  params.delete();
  printOut(decInstance.get_dec_information());

  postMessage({ cmd: "decoderStarted" });

  try {
    if (!au) {
      au = new VVdeC.AccessUnit();
      auEnsureAlloc(au, 100000);
    }
    if (!frameHandle) {
      frameHandle = new VVdeC.FrameHandle();
    }

    let file = await playbackQueue.getNextInitSegment();
    while (file && !exitDecoder) {
      if (file.mime === 'video/mp4' || file.url.match(/\.mp4$/)) {
        await decodeMP4(decInstance, file.data, segmented);
      }
      else {
        await decodeAnnexB(decInstance, file.data, args.repeat);
      }
      file = await playbackQueue.getNextInitSegment();
    }
    postMessage({ cmd: "EOF" });

    playbackQueue = undefined;
  }
  catch (e) {
    printErr(e);
    if (typeof (e) !== 'string') {
      throw (e);
    }
  }
  finally {
    au.delete();
    au = undefined;
    frameHandle.delete();
    frameHandle = undefined;

    // don't delete decoder while frames are still referenced
    decInstance.delete();
    decInstance = undefined;
    exitDecoder = false;
    planeAllocations.length = 0;
    requestedFrames = 0;
  }

  printOut("DONE.");
  postMessage({ cmd: "decoderExited" });
}

class PlaybackQueue {
  playlists = [];
  rendition = undefined;
  nextSegIdx = undefined;
  lastInitUri = undefined;
  mpdDuration = undefined;
  mp4Duration = undefined;

  async start() {
    if (typeof this.rendition === 'undefined') {
      this.rendition = 0;
    }

    this.nextSegIdx = 0;
    this.fetchSegment(this.nextSegIdx);
  }

  setSegmentPlaylists(playlists) {
    this.playlists = playlists;
  }

  enqueueFile(bitstreamUrl) {
    if (!this.playlists[0]) {
      this.playlists.push({
        segments: []
      });
    }

    // for non-segmented streams we put the actual bitstream url into the map object,
    // so we can handle it like an init-segment
    this.playlists[0].segments.push({
      resolvedUri: null,
      map: {
        resolvedUri: bitstreamUrl,
      }
    });
  }

  async getNextSegmentFile() {
    const currIdx = this.nextSegIdx;
    let seg = this.playlists[this.rendition].segments[currIdx];

    if (!seg) {
      return 'EOF';
    }

    if (!seg.downloaded || !seg.map.downloaded) {
      // Try to find a segment from a different rendition, that has been downloaded already.
      // This can happen when switching the rendition shortly before the end of the current segment.
      const availableSeg = this.findDownloadedSegmentRendition();
      if (availableSeg) {
        printOut("Found replacement segment from other rendition.");
        seg = availableSeg;
      }
    }

    if (seg.map.resolvedUri !== this.lastInitUri) {
      return 'NEW_INIT';
    }

    ++this.nextSegIdx;
    this.fetchSegment(this.nextSegIdx);

    if (!seg.resolvedUri) {
      // this is not a segmented bitstream, so the actual data is in the seg.map
      return null;
    }

    if (!seg.filePromise) {
      printOut("Segment fetch not yet started. This is weird.");
      this.fetchSegment(currIdx);
    }
    const filePromise = seg.filePromise;
    seg.filePromise = null;

    if (!seg.downloaded) {
      printOut("Decoder waiting for next segment.");
    }
    return await filePromise;
  }

  async getNextInitSegment() {
    const currIdx = this.nextSegIdx;
    const seg = this.playlists[this.rendition].segments[currIdx];
    const initSeg = this.playlists[this.rendition].segments[currIdx]?.map;
    if (!initSeg) {
      return null;
    }

    // this segment doesn't contain any data, besides the 'init' segment, so it is a complete file.
    if (!seg.resolvedUri) {
      ++this.nextSegIdx;
      this.fetchSegment(this.nextSegIdx);
    }

    this.lastInitUri = initSeg.resolvedUri;
    if (!initSeg.file) {
      if (!initSeg.filePromise) {
        printOut("Init segment fetch not yet started. This is weird.");
        this.fetchSegment(currIdx);
      }
      initSeg.file = await initSeg.filePromise;
    }
    return initSeg.file;
  }

  get isEmpty() {
    return this.nextSegIdx >= this.playlists[this.rendition].segments.length;
  }

  get isAtDurationEnd() {
    return this.playlists[this.rendition].segments[this.nextSegIdx - 1].duration < 0.1 ||
      this.mpdDuration - this.mp4Duration < 0.1;
  }

  setRendition(id) {
    this.rendition = id;
    this.fetchSegment(this.nextSegIdx);
  }

  fetchSegment(idx) {
    const nextSeg = this.playlists[this.rendition].segments[idx];
    if (!nextSeg) {
      return;
    }

    if (nextSeg.resolvedUri && !nextSeg.filePromise) {
      nextSeg.filePromise = FileDownloader.fetchFile(nextSeg.resolvedUri).then(f => { nextSeg.downloaded = true; return f; });
    }
    // fetch corresponding init-segment if required
    if (nextSeg.map.resolvedUri && !nextSeg.map.file && !nextSeg.map.filePromise) {
      nextSeg.map.filePromise = FileDownloader.fetchFile(nextSeg.map.resolvedUri).then(f => { nextSeg.map.downloaded = true; return f; });
    }
  }

  findDownloadedSegmentRendition() {
    for (let pl of this.playlists) {
      if (pl.segments[this.nextSegIdx].downloaded && pl.segments[this.nextSegIdx].map.downloaded) {
        return pl.segments[this.nextSegIdx];
      }
    }
  }
}

async function decodeAnnexB(decInstance, data, repeat) {
  const decStat = {
    countFrames: 0,
    countFramesOverall: 0,
    startTime: performance.now(),
    startTimeOverall: performance.now(),
  };
  let start = 0;
  while (start < data.byteLength && !exitDecoder) {
    // find next start-code
    let end = data.byteLength;
    for (let i = start + 3; i + 3 < data.byteLength; ++i) {
      if ((data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1)
        || (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1)) {
        end = i;
        break;
      }
    }
    const nalu = data.subarray(start, end);
    let start_code_len = 0;
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 1) {
      start_code_len = 3;
    }
    else if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1) {
      start_code_len = 4;
    }
    // console.log(parseNaluHeader(data.subarray(start + start_code_len, end)));

    auEnsureAlloc(au, nalu.length);
    au.payload.set(nalu);
    au.payloadUsedSize = nalu.byteLength;

    // console.log("nalu (" + au.get_nal_unit_type().value + ")" + " len:" + au.payloadUsedSize + " " + start_code_len);

    const ret = decInstance.decode(au, frameHandle);
    if (ret !== 0 && ret !== -40) {
      printErr(`ret (${ret}): ${decInstance.get_last_error()}`);
    }

    if (frameHandle.frame) {
      ++decStat.countFrames;
      await processFrame(frameHandle.frame);
    }
    if (exitDecoder) { break; }

    start = end;

    if (start >= data.byteLength && --repeat > 0) {
      const duration = (performance.now() - decStat.startTime) / 1000;
      printOut(`Decoded ${decStat.countFrames} frames in ${duration.toPrecision(3)} s (${(decStat.countFrames / duration).toPrecision(3)} fps).`);

      decStat.countFramesOverall += decStat.countFrames;
      decStat.countFrames = 0;
      decStat.startTime = performance.now();

      // reset bitstream read position to the beginning
      start = 0;
    }

  }

  await flushDecoder(decInstance, decStat);
};

async function decodeMP4(decInstance, data, segmented) {
  const decStat = {
    countFrames: 0,
    countFramesOverall: 0,
    startTime: performance.now(),
    startTimeOverall: performance.now(),
  };

  const mp4boxfile = MP4Box.createFile();
  // Log.setLogLevel(Log.info);

  let vidTrackTimeScale;
  let last_sample_description_index;
  const process_samples = async function (trak) {
    const info = mp4boxfile.getInfo();
    const vidTrack = info.videoTracks[0];
    vidTrackTimeScale = vidTrack.timescale;

    if (trak.nextSample >= trak.samples.length) {
      return false;
    }

    while (trak.nextSample < trak.samples.length) {
      const sample = mp4boxfile.getSample(trak, trak.nextSample);
      if (!sample) {
        break;
      }
      trak.nextSample++;

      if (segmented && sample.number_in_traf === 0) {
        const info = mp4boxfile.getInfo();
        const vidTrack = info.videoTracks[0];
        vidTrackTimeScale = vidTrack.timescale;

        const lastTrakSample = trak.samples[trak.samples.length - 1];
        const msg = {
          cmd: "newMp4Metadata",
          fps: vidTrack.timescale / (vidTrack.samples_duration / vidTrack.nb_samples),
          numFrames: vidTrack.nb_samples,
          // duration: vidTrack.samples_duration / vidTrack.timescale,
          duration: (lastTrakSample.cts + lastTrakSample.duration) / lastTrakSample.timescale,
          movie_duration: info.duration / info.timescale,
          width: vidTrack.track_width,
          height: vidTrack.track_height
        };
        postMessage(msg);

        playbackQueue.mp4Duration = (lastTrakSample.cts + lastTrakSample.duration) / lastTrakSample.timescale;
      }

      if (last_sample_description_index !== sample.description_index) {
        last_sample_description_index = sample.description_index;

        const param_arrays = sample.description.vvcC.nalu_arrays;
        for (let params of param_arrays) {
          for (let nalu of params) {
            // const nuh = parseNaluHeader(nalu.data);
            // console.log(nuh);

            auEnsureAlloc(au, nalu.data.byteLength + 4);
            au.payload.set([0, 0, 0, 1]);
            au.payload.set(nalu.data, 4);
            au.payloadUsedSize = nalu.data.byteLength + 4;
            au.ctsValid = false;
            au.dtsValid = false;
            console.assert(au.get_nal_unit_type().value === params.nalu_type, "wrong nal unit type in param array");
            // console.log("descr nalu (" + au.get_nal_unit_type().value + ")" + " len:" + au.payloadUsedSize);

            let ret = decInstance.decode(au, frameHandle);
            if (ret !== 0 && ret !== -40) {
              printErr(`ret (${ret}): ${decInstance.get_last_error()}`);
            }

            if (frameHandle.frame) {
              console.warn("decoder produced frame on decoding parameter set. this is weird.");

              if (typeof first_frame_cts === 'undefined') {
                first_frame_cts = Number(frameHandle.frame.cts);
              }

              ++decStat.countFrames;
              await processFrame(frameHandle.frame, vidTrackTimeScale, first_frame_cts);
            }
            if (exitDecoder) { break; }
          }
          if (exitDecoder) { break; }
        }
      }

      // sample.data still contains multiple nal units (APS + Slice), both prefixed with the length
      const length_field_size = sample.description.vvcC.lengthSizeMinusOne + 1;

      let start = 0;
      while (start < sample.data.byteLength && !exitDecoder) {
        const len = parseLength(sample.data.subarray(start, start + length_field_size));
        start += length_field_size;
        const end = start + len;

        const nalData = sample.data.subarray(start, end);
        // const nuh = parseNaluHeader(nalData);
        // console.log(nuh);

        auEnsureAlloc(au, nalData.byteLength + 4);
        au.payload.set([0, 0, 0, 1]);
        au.payload.set(nalData, 4);
        au.payloadUsedSize = nalData.byteLength + 4;
        au.cts = BigInt(sample.cts);
        au.dts = BigInt(sample.dts);
        au.ctsValid = true;
        au.dtsValid = true;
        // console.log("nalu (" + au.get_nal_unit_type().value + ")" + " len:" + au.payloadUsedSize);

        // BEGIN WORKAROUND for bug in GPAC, when packaging open GOP with resolution switching:
        // ignore parameter sets if this sample doesn't actually contain a RAP Nal Unit
        const nal_unit_type = au.get_nal_unit_type().value;
        if (nal_unit_type === 14 || nal_unit_type === 15 || nal_unit_type === 16) {

          if (!extractNalUnitTypes(sample.data, length_field_size).find(t => t >= 7 && t <= 10)) {
            console.log("Workaround for GPAC bug: don't use in-band parameter sets, because the sample doesn't actually contain a RAP NAL unit.");

            start = end;
            continue;
          }
        }
        // END WORKAROUND

        let ret = decInstance.decode(au, frameHandle);
        if (ret !== 0 && ret !== -40) {
          printErr(`ret (${ret}): ${decInstance.get_last_error()}`);
        }

        if (frameHandle.frame) {
          const cts = Number(frameHandle.frame.cts);
          if (typeof first_frame_cts === 'undefined') {
            first_frame_cts = cts;
          }

          ++decStat.countFrames;
          await processFrame(frameHandle.frame, vidTrackTimeScale, first_frame_cts);
        }
        if (exitDecoder) { break; }

        start = end;
      }

      mp4boxfile.releaseSample(trak, sample.number);
    }  // for (let sample of samples)

    // mp4boxfile.releaseUsedSamples(vidTrack.id, trak.samples.at(-1).number);
    return true;
  };  // process_samples()



  mp4boxfile.onError = function (e) { console.log("onError: " + e); };
  mp4boxfile.onReady = function (info) {
    printOut("onReady: " + info.mime);

    const vidTrack = info.videoTracks[0];
    const msg = {
      cmd: "newMp4Metadata",
      fps: vidTrack.timescale / (vidTrack.samples_duration / vidTrack.nb_samples),
      numFrames: vidTrack.nb_samples,
      duration: vidTrack.samples_duration / vidTrack.timescale,
      movie_duration: info.duration / info.timescale,
      width: vidTrack.track_width,
      height: vidTrack.track_height
    };
    postMessage(msg);

    mp4boxfile.start();
  };

  data.buffer.fileStart = 0;
  let nextBufferStart = mp4boxfile.appendBuffer(data.buffer);

  const info = mp4boxfile.getInfo();
  const extractTrak = mp4boxfile.getTrackById(info.videoTracks[0].id);
  extractTrak.nextSample = 0;

  while (!exitDecoder) {
    let segFile;
    try {
      segFile = await playbackQueue.getNextSegmentFile();
    }
    catch (e) {
      if (playbackQueue.isAtDurationEnd) {
        // ignore segment download error at the end of the MPD duration
        printOut("Last segment missing.");
        break;
      }
      if (typeof (e) === 'string') {
        printErr(e);
        break;
      }
      throw (e);
    }

    if (!segFile) {
      console.assert(!segmented, "playbackQueue.getNextSegmentFile() should not return null for segmented tracks");
    }
    if (!segFile || segFile === 'NEW_INIT' || segFile === 'EOF') {
      break;
    }

    mp4boxfile.stop();
    segFile.data.buffer.fileStart = nextBufferStart;
    nextBufferStart = mp4boxfile.appendBuffer(segFile.data.buffer);
    mp4boxfile.start();

    await process_samples(extractTrak);
  }
  mp4boxfile.flush();
  // ensure all samples are really extracted, especially after a flush
  await process_samples(extractTrak);

  if (!segmented || playbackQueue.isEmpty) {
    await flushDecoder(decInstance, decStat, vidTrackTimeScale, first_frame_cts);
  }
};

async function flushDecoder(decInstance, decStat, timescale, cts_offset) {
  console.log("FLUSHING");

  let ret = 0;
  while (ret === 0 && !exitDecoder) {
    ret = decInstance.flush(frameHandle);
    if (ret !== 0 && ret !== -50) {
      printErr(`ret (${ret}): ${decInstance.get_last_error()}`);
      break;
    }

    if (frameHandle.frame) {
      ++decStat.countFrames;
      await processFrame(frameHandle.frame, timescale, cts_offset);
    }
  }

  const duration = (performance.now() - decStat.startTime) / 1000;
  printOut(`Decoded ${decStat.countFrames} frames in ${duration.toPrecision(3)} s (${(decStat.countFrames / duration).toPrecision(3)} fps).`);

  decStat.countFramesOverall += decStat.countFrames;
  const durationOverall = (performance.now() - decStat.startTimeOverall) / 1000;
  printOut(`\nOverall decoded ${decStat.countFramesOverall} frames in ${durationOverall.toPrecision(3)} s (${(decStat.countFramesOverall / durationOverall).toPrecision(3)} fps).`);
}

function parseLength(array) {
  let ret = 0;
  for (let b of array) { ret = (ret << 8) + b; }
  return ret;
}

function extractNalUnitTypes(sampleData, length_field_size) {
  let naluTypes = [];
  for (let start = 0; start < sampleData.byteLength;) {
    const len = parseLength(sampleData.subarray(start, start + length_field_size));
    naluTypes.push(sampleData[start + length_field_size + 1] >> 3);

    start += length_field_size + len;
  }
  return naluTypes;
}

function parseNaluHeader(nalu) {
  return {
    nuh_layer_id: nalu[0] & 0x3f,
    nal_unit_type: (nalu[1] >> 3) & 0x1f,
    nuh_temporal_id_plus1: nalu[1] & 0x07
  };
}

function auEnsureAlloc(au, min_length) {
  if (au.payloadSize < min_length + 4) {
    console.log("REALLOC " + min_length);
    au.free_payload();
    au.alloc_payload((min_length + 4) * 1.2);
  }
}

async function processFrame(frame, timescale, cts_offset) {
  if (requestedFrames <= 0) {
    console.assert(requestedFrames === 0, "requested frames shouldn't be negative");
    continueDecoding.reset();
    await continueDecoding.promise;
  }
  if (exitDecoder) { return; }
  --requestedFrames;

  const planeY = frame.planes[0];
  const planeU = frame.planes[1];
  const planeV = frame.planes[2];

  const useSAB = false;
  const removePadding = navigator.userAgent.match("Chrome") && frame.width !== planeY.stride / planeY.bytesPerSample; // is this really still faster in chrome
  const ArrayT = planeY.bytesPerSample === 1 ? Uint8Array : Uint16Array;

  let strideY;
  let strideUV;

  let Y, U, V;
  if (planeAllocations.length) { // re-use previously allocated Arrays
    [Y, U, V] = planeAllocations.shift();
  }
  let neededAllocation = false;
  if (removePadding) {
    // allocate planes if needed
    if (useSAB) {
      if (!Y || Y.length !== planeY.width * planeY.height || !(Y instanceof ArrayT)) {
        Y = new ArrayT(new SharedArrayBuffer(planeY.width * planeY.height * planeY.bytesPerSample));
        neededAllocation = true;
      }
      if (!U || !V || U.length !== planeU.width * planeU.height || !(U instanceof ArrayT)) {
        U = new ArrayT(new SharedArrayBuffer(planeU.width * planeU.height * planeU.bytesPerSample));
        V = new ArrayT(new SharedArrayBuffer(planeV.width * planeV.height * planeV.bytesPerSample));
        neededAllocation = true;
      }
    }
    else {
      if (!Y || Y.length !== planeY.width * planeY.height) {
        Y = new ArrayT(planeY.width * planeY.height);
        neededAllocation = true;
      }
      if (!U || U.length !== planeU.width * planeU.height) {
        U = new ArrayT(planeU.width * planeU.height);
        V = new ArrayT(planeV.width * planeV.height);
        neededAllocation = true;
      }
    }

    // remove stride from planes
    for (let i = 0; i < planeY.height; ++i) {
      Y.set(planeY.ptr.subarray(i * planeY.stride / planeY.bytesPerSample, i * planeY.stride / planeY.bytesPerSample + planeY.width), i * planeY.width);
    }
    for (let i = 0; i < planeU.height; ++i) {
      U.set(planeU.ptr.subarray(i * planeU.stride / planeU.bytesPerSample, i * planeU.stride / planeU.bytesPerSample + planeU.width), i * planeU.width);
      V.set(planeV.ptr.subarray(i * planeV.stride / planeV.bytesPerSample, i * planeV.stride / planeV.bytesPerSample + planeV.width), i * planeV.width);
    }
    console.assert(planeU.width === planeV.width && planeU.height === planeV.height, "Error: differently sized U & V planes");
    strideY = planeY.width;
    strideUV = planeU.width;
  }
  else {
    // allocate planes if needed
    if (useSAB) {
      if (!Y || Y.length !== planeY.ptr.length) {
        Y = new ArrayT(new SharedArrayBuffer(planeY.ptr.byteLength));
        neededAllocation = true;
      }
      if (!U || !V || U.length !== planeU.ptr.length || !(U instanceof ArrayT)) {
        U = new ArrayT(new SharedArrayBuffer(planeU.ptr.byteLength));
        V = new ArrayT(new SharedArrayBuffer(planeV.ptr.byteLength));
        neededAllocation = true;
      }
    }
    else {
      if (!Y || Y.length !== planeY.ptr.length) {
        Y = new ArrayT(planeY.ptr.length);
        neededAllocation = true;
      }
      if (!U || !V || U.length !== planeU.ptr.length) {
        U = new ArrayT(planeU.ptr.length);
        V = new ArrayT(planeV.ptr.length);
        neededAllocation = true;
      }
    }

    // copy the actual data
    Y.set(planeY.ptr);
    U.set(planeU.ptr);
    V.set(planeV.ptr);

    console.assert(planeU.width === planeV.width && planeU.height === planeV.height && planeU.stride === planeV.stride, "Error: differently sized U & V planes");
    strideY = planeY.stride / planeY.bytesPerSample;
    strideUV = planeU.stride / planeU.bytesPerSample;
  }
  if (neededAllocation && planeAllocations.length) {
    // clear remaining planeAllocations, because they don't match the size
    planeAllocations.length = 0;
  }

  const extraData = frame.picAttributes ? {
    nuh_temporal_id: frame.picAttributes.temporalLayer,
    bits: frame.picAttributes.bits,
    is_rap: frame.picAttributes.nalType.value >= 7 && frame.picAttributes.nalType.value <= 10,
    slice_type: frame.picAttributes.sliceType.value
  } : undefined;

  // console.log (frameY.stride);
  postMessage({
    cmd: "frame",
    frame: {
      width: frame.width,
      height: frame.height,
      strideY: strideY,
      strideUV: strideUV,
      bitDepth: frame.bitDepth,
      y: Y,
      u: U,
      v: V,
      cts: frame.ctsValid && timescale ? (Number(frame.cts) - (cts_offset || 0)) / timescale : undefined,
      sequenceNumber: frame.sequenceNumber,
      extra: extraData
    }
  },
    useSAB ? undefined : [Y.buffer, U.buffer, V.buffer]
  );

  decInstance.frame_unref(frame);
}

onmessage = async function (e) {
  let data = e.data;
  if (data.cmd === 'init') {
    let scriptUrl = data.appPath + "/vvdecapp.js";
    importScripts(scriptUrl);

    const module_config = {
      print: printOut,
      printErr: printErr,
      locateFile: function (f, p) {
        // console.log("searching: " + f);
        return data.appPath + f;
      },
      mainScriptUrlOrBlob: scriptUrl,
    };


    try {
      VVdeC = await CreateVVdeC(module_config);

      console.log("INIT");
      postMessage({ cmd: "initDone" });
    }
    catch (e) {
      printErr(e);
      if (e.toString() === "out of memory") {
        printErr("Is this a 32 bit browser? The VVdeC WASM player needs a browser built for 64 bit.");
      }
    }
    return;
  }

  if (!VVdeC) {
    printErr("VVdeC module not initialized");
    return;
  }

  switch (data.cmd) {
    case 'startDecoding':
      if (exitDecoder) {
        printErr("Can't start decoder. Previous instance in still exiting.");
        break;
      }
      if (data.url) {
        decoderRun(data.url, { threads: data.numDecThreads, repeat: data.repeat });
      }
      else if (data.playlists) {
        decoderRun(data.playlists, { threads: data.numDecThreads, rendition: data.rendition, mpdDuration: data.mpdDuration });
      }
      break;

    case 'dashRendition':
      playbackQueue?.setRendition(data.rendition);
      break;

    case 'stop':
      if (decInstance) {
        exitDecoder = true;
      }
      continueDecoding.release();
      break;

    case 'requestFrame':
      if (decInstance && !exitDecoder) {
        ++requestedFrames;
      }
      continueDecoding.release();
      break;

    case 'releaseFrame':
      if (decInstance && !exitDecoder) {
        planeAllocations.push(data.planes);
      }
      break;

    default:
      printErr(`Warning: DecoderWorker received unknown command "${data.cmd}".`);
      break;
  }
};
