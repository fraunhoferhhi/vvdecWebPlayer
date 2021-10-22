'use strict';

importScripts('lib/mp4box.all.js');

let VVdeC;
let decInstance;
let frameHandle;
let requestedFrames = 0;
let continueDecoding;
let exitDecoder = false;
const planeAllocations = [];    // cache for locally allocated planes.

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
function printOut(text) {
  if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
  console.log(text);
  postMessage({ "cmd": "out", "text": text });
}
function printErr(text) {
  if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
  console.warn(text);
  postMessage({ "cmd": "err", "text": text });
}

async function processFrame(frame, timescale, cts_offset) {
  if (!requestedFrames) {
    const pauseDecoder = new Promise((resolve) => { continueDecoding = resolve; });
    await pauseDecoder;
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
  if (removePadding) {
    // allocate planes if needed
    if (useSAB) {
      if (!Y || Y.length !== planeY.width * planeY.height || !Y instanceof ArrayT) {
        Y = new ArrayT(new SharedArrayBuffer(planeY.width * planeY.height * planeY.bytesPerSample));
      }
      if (!U || !V || U.length !== planeU.width * planeU.height || !U instanceof ArrayT) {
        U = new ArrayT(new SharedArrayBuffer(planeU.width * planeU.height * planeU.bytesPerSample));
        V = new ArrayT(new SharedArrayBuffer(planeV.width * planeV.height * planeV.bytesPerSample));
      }
    }
    else {
      if (!Y || Y.length !== planeY.width * planeY.height) {
        Y = new ArrayT(planeY.width * planeY.height);
      }
      if (!U || U.length !== planeU.width * planeU.height) {
        U = new ArrayT(planeU.width * planeU.height);
        V = new ArrayT(planeV.width * planeV.height);
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
      }
      if (!U || !V || U.length !== planeU.ptr.length || !U instanceof ArrayT) {
        U = new ArrayT(new SharedArrayBuffer(planeU.ptr.byteLength));
        V = new ArrayT(new SharedArrayBuffer(planeV.ptr.byteLength));
      }
    }
    else {
      if (!Y || Y.length !== planeY.ptr.length) {
        Y = new ArrayT(planeY.ptr.length);
      }
      if (!U || !V || U.length !== planeU.ptr.length) {
        U = new ArrayT(planeU.ptr.length);
        V = new ArrayT(planeV.ptr.length);
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
    }
  },
    useSAB ? undefined : [Y.buffer, U.buffer, V.buffer]
  );

  decInstance.frame_unref(frame);
}

let bitstreamBuffer;
let bitstreamBufferUrl;
async function decoderRun(bitstreamUrl, repeat) {
  let params = new VVdeC.Params();
  params.threads = 10;
  // params.removePadding = true;
  // params.logLevel = VVdeC.LogLevel.INFO;

  console.assert(decInstance === undefined);
  decInstance = new VVdeC.Decoder(params);
  // workaround to yield to browser runtime until all workers have been initialized
  while (VVdeC.PThread.runningWorkers.some(w => { return !w.loaded; })) {
    await sleep(10);
  }
  params.delete();

  if (!frameHandle || !frameHandle.$$.ptr) {
    frameHandle = new VVdeC.FrameHandle();
  }

  const urlMatched = bitstreamBufferUrl && bitstreamBufferUrl.match(`https?://.*${bitstreamUrl}$`);
  if (bitstreamBuffer && urlMatched && urlMatched.length === 1) {
    printOut("bitstream already fetched.");
  }
  else {
    printOut("fetching bitstream...");

    const response = await new Promise(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", bitstreamUrl);
        xhr.onprogress = function (e) {
          postMessage({
            cmd: "downloadProgress",
            loaded: e.loaded,
            total: e.total
          });
        };
        xhr.responseType = 'arraybuffer';
        xhr.onload = function (e) {
          if (xhr.status === 200) {
            resolve({
              ok: true,
              status: xhr.status,
              statusText: xhr.statusText,
              url: xhr.responseURL,
              buffer: new Uint8Array(xhr.response),
            });
          }
          else {
            resolve({
              ok: false,
              status: xhr.status,
              statusText: xhr.statusText,
            });
          }
        };
        xhr.send();
      }
    );

    if (!response.ok) {
      printErr(`Fetching bitstream failed: ${response.statusText} (${response.status})`);
      return;
    }
    bitstreamBuffer = response.buffer;
    bitstreamBufferUrl = response.url;
    printOut("done.");
  }

  printOut(decInstance.get_dec_information());

  if (bitstreamUrl.match(/\.mp4$/)) {
    await decodeMP4(decInstance, bitstreamBuffer, repeat);
  }
  else {
    await decodeAnnexB(decInstance, bitstreamBuffer, repeat);
  }

  postMessage({ cmd: "EOF" });

  // don't delete decoder while frames are still referenced
  decInstance.delete();
  decInstance = undefined;
  exitDecoder = false;
  requestedFrames = 0;

  printOut("DONE.");
  postMessage({ cmd: "decoderExited" });
}

async function decodeAnnexB(decInstance, data, repeat) {
  const au = new VVdeC.AccessUnit();
  au.alloc_payload(100000);

  let decStat = {
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
    let nalu = data.subarray(start, end);

    auEnsureAlloc(au, nalu.length);
    au.payload.set(nalu);
    au.payloadUsedSize = nalu.byteLength;

    // console.log("nalu (" + au.get_nal_unit_type().value + ")" + " len:" + au.payloadUsedSize + " " + start_code_len);

    let ret = decInstance.decode(au, frameHandle);
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

  au.delete();
  frameHandle.delete();
};

function decodeMP4(decInstance, data, repeat) {
  const au = new VVdeC.AccessUnit();
  au.alloc_payload(100000);

  let decodeDonePromiseResolve;
  const decodeDonePromise = new Promise((resolve) => { decodeDonePromiseResolve = resolve; });

  const mp4boxfile = MP4Box.createFile();
  data.buffer.fileStart = 0;

  mp4boxfile.onError = function (e) { console.log("onError: " + e); };
  mp4boxfile.onReady = function (info) {
    printOut("onReady: " + info.mime);

    const vidTrack = info.videoTracks[0];
    const msg = {
      cmd: "newMp4Metadata",
      fps: vidTrack.timescale / (vidTrack.samples_duration / vidTrack.nb_samples),
      numFrames: vidTrack.nb_samples,
      duration: vidTrack.samples_duration / vidTrack.timescale,
      movie_duration: info.duration / info.timescale
    };
    postMessage(msg);

    mp4boxfile.setExtractionOptions(vidTrack.id,
      {
        info: info,
        track: vidTrack,
        decStat: {
          countFrames: 0,
          countFramesOverall: 0,
          startTime: performance.now(),
          startTimeOverall: performance.now(),
        }
      },
      {
        nbSamples: 10
      });
    mp4boxfile.start();
  };

  let first_frame_cts = undefined;
  let last_sample_description_index = undefined;
  mp4boxfile.onSamples = function (id, user, samples) {
    console.log("onSamples: " + id + " count:" + samples.length);

    const process_samples = async function () {
      const decStat = user.decStat;
      for (let sample of samples) {
        if (last_sample_description_index !== sample.description_index) {
          last_sample_description_index = sample.description_index;

          const param_arrays = sample.description.vvcC.nalu_arrays;
          for (let params of param_arrays) {
            for (let nalu of params) {
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

                if (first_frame_cts === undefined) {
                  first_frame_cts = Number(frameHandle.frame.cts);
                }

                ++decStat.countFrames;
                await processFrame(frameHandle.frame, user.track.timescale, first_frame_cts);
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
          auEnsureAlloc(au, nalData.byteLength + 4);
          au.payload.set([0, 0, 0, 1]);
          au.payload.set(nalData, 4);
          au.payloadUsedSize = nalData.byteLength + 4;
          au.cts = BigInt(sample.cts);
          au.dts = BigInt(sample.dts);
          au.ctsValid = true;
          au.dtsValid = true;
          // console.log("nalu (" + au.get_nal_unit_type().value + ")" + " len:" + au.payloadUsedSize);

          let ret = decInstance.decode(au, frameHandle);
          if (ret !== 0 && ret !== -40) {
            printErr(`ret (${ret}): ${decInstance.get_last_error()}`);
          }

          if (frameHandle.frame) {
            if (first_frame_cts === undefined) {
              first_frame_cts = Number(frameHandle.frame.cts);
            }

            ++decStat.countFrames;
            await processFrame(frameHandle.frame, user.track.timescale, first_frame_cts);
          }
          if (exitDecoder) { break; }

          start = end;
        }
      }  // for (let sample of samples)

      // reached end of track
      if (samples.at(-1).number === user.track.nb_samples - 1 || exitDecoder) {
        await flushDecoder(decInstance, decStat, user.track.timescale, first_frame_cts);

        au.delete();
        frameHandle.delete();

        decodeDonePromiseResolve();
        return;
      }

      // resume extraction
      mp4boxfile.start();
    };  // process_samples()

    // stop extraction, so we can run decoding asynchronously
    mp4boxfile.stop();

    // Ensure we return before actually processing the samples. Otherwise mp4boxfile gets confused and we get
    // handed some samples multiple times
    setTimeout(process_samples, 0);
  };  // mp4boxfile.onSamples()

  mp4boxfile.appendBuffer(data.buffer);
  mp4boxfile.flush();

  return decodeDonePromise;
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

function auEnsureAlloc(au, min_length) {
  if (au.payloadSize < min_length + 4) {
    console.log("REALLOC " + min_length);
    au.free_payload();
    au.alloc_payload((min_length + 4) * 1.2);
  }
}

onmessage = async function (e) {
  if (e.data.cmd === "init") {
    let scriptUrl = e.data.appPath + "/vvdecapp.js";
    importScripts(scriptUrl);

    const module_config = {
      print: printOut,
      printErr: printErr,
      locateFile: function (f, p) {
        // console.log("searching: " + f);
        return e.data.appPath + f;
      },
      mainScriptUrlOrBlob: scriptUrl,
    };


    try {
      VVdeC = await CreateVVdeC(module_config);
    }
    catch (e) {
      printErr(e);
      if (e.toString() === "out of memory") {
        printErr("Is this a 32 bit browser? The VVdeC WASM player needs a browser built for 64 bit.");
      }
    }
    console.log("INIT");
    postMessage({ cmd: "initDone" });
    return;
  }

  if (!VVdeC) {
    printErr("VVdeC module not initialized");
    return;
  }

  switch (e.data.cmd) {
    case "callMain":
      const dirMatch = e.data.bitstream.match(/.*\//);
      if (dirMatch) {
        VVdeC.FS.createPath("/", dirMatch[0]);
      }
      VVdeC.FS.createLazyFile('/', e.data.bitstream, e.data.bitstream, true, false);
      let args = ['-b', e.data.bitstream, '-t', '10', '-v', '3'];
      if (e.data.repeat >= 2) {
        args = args.concat(['-L', e.data.repeat + '']);
      }
      VVdeC.callMain(args);
      postMessage({ cmd: "EOF" });
      postMessage({ cmd: "decoderExited" });
      break;

    case "run":
      if (exitDecoder) {
        printErr("Can't start decoder. Previous instance in still exiting.");
        break;
      }
      decoderRun(e.data.bitstream, e.data.repeat);
      break;

    case "stop":
      if (decInstance) {
        exitDecoder = true;
      }
      if (continueDecoding) {
        continueDecoding();
        continueDecoding = undefined;
      }
      break;

    case "requestFrame":
      if (!exitDecoder) {
        ++requestedFrames;
      }
      if (continueDecoding) {
        continueDecoding();
        continueDecoding = undefined;
      }
      break;

    case "releaseFrame":
      planeAllocations.push(e.data.planes);
      break;
  }
};
