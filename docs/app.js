import {
  load,
  microphone,
  splitAll,
  calculateEnergy,
  computeFrameEnergies,
  estimateEnergyThreshold,
} from "./lib/browser/index.js";
import { createWebrtcValidator } from "./lib/webrtcvad/index.js";

const WEBRTC_RATES = [8000, 16000, 32000, 48000];

const $ = (id) => document.getElementById(id);

const dropzone = $("dropzone");
const fileInput = $("file-input");
const exampleBtn = $("example-btn");
const recordBtn = $("record-btn");
const status = $("status");
const workbench = $("workbench");
const modeSelect = $("mode");
const thresholdControl = $("threshold-control");
const thresholdSlider = $("threshold");
const canvas = $("waveform");
const summary = $("detection-summary");
const eventsBody = document.querySelector("#events-table tbody");

const sliders = {
  threshold: { input: thresholdSlider, output: $("threshold-value") },
  minDur: { input: $("min-dur"), output: $("min-dur-value") },
  maxSilence: { input: $("max-silence"), output: $("max-silence-value") },
  maxDur: { input: $("max-dur"), output: $("max-dur-value") },
  maxLeadingSilence: {
    input: $("max-leading-silence"),
    output: $("max-leading-silence-value"),
  },
  maxTrailingSilence: {
    input: $("max-trailing-silence"),
    output: $("max-trailing-silence-value"),
  },
};
const sampleRateSelect = $("sample-rate");
const liveMeter = $("live-meter");
const liveTime = $("live-time");
const liveBar = $("live-bar");

let audio = null; // { channelData, sampleRate, name }
let events = [];
let resolvedThreshold = null;
let playbackCtx = null;
let playingSource = null;
let playingRow = null;
let mic = null;

// ---------------------------------------------------------------- status

function setStatus(text, isError = false) {
  status.textContent = text;
  status.hidden = text === "";
  status.classList.toggle("error", isError);
}

// ----------------------------------------------------------- audio input

function chosenSampleRate() {
  return Number(sampleRateSelect.value);
}

async function useFile(file) {
  setStatus(`decoding ${file.name} …`);
  try {
    const region = await load(file, { sampleRate: chosenSampleRate() });
    setAudio(region, file.name);
  } catch (error) {
    setStatus(`could not decode ${file.name}: ${error.message}`, true);
  }
}

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) useFile(fileInput.files[0]);
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () =>
  dropzone.classList.remove("dragover"),
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length > 0) useFile(e.dataTransfer.files[0]);
});

exampleBtn.addEventListener("click", async () => {
  setStatus("loading example …");
  try {
    setAudio(await load("example.wav"), "example.wav");
  } catch (error) {
    setStatus(`could not load the example: ${error.message}`, true);
  }
});

recordBtn.addEventListener("click", async () => {
  if (mic !== null) {
    mic.stop();
    return;
  }
  try {
    mic = await microphone({ sampleRate: chosenSampleRate() });
  } catch (error) {
    setStatus(`microphone unavailable: ${error.message}`, true);
    return;
  }
  recordBtn.classList.add("recording");
  recordBtn.textContent = "stop recording";
  // live calibration, as in the library: with an auto mode selected,
  // the threshold is estimated from the first 3 s of the recording
  // (clamped to a 40 dB floor) and drives the "valid frame" hint
  const autoMode =
    modeSelect.value !== "fixed" && modeSelect.value !== "webrtc";
  let liveThreshold = null;
  setStatus(
    autoMode
      ? "recording — calibrating the threshold on the first 3 s …"
      : "recording — click « stop recording » when done …",
  );
  liveMeter.hidden = false;
  const recorded = [];
  // live feedback: level bar + "valid frame" hint against the
  // calibrated (auto modes) or slider threshold, on ~50 ms batches
  const meterRate = mic.sampleRate;
  const batchEnergies = [];
  let meterBatch = [];
  let meterSamples = 0;
  let recordedSamples = 0;
  let lastPaint = 0;
  for await (const chunk of mic.chunks) {
    recorded.push(chunk);
    recordedSamples += chunk.length;
    meterBatch.push(chunk);
    meterSamples += chunk.length;
    if (meterSamples >= meterRate * 0.05) {
      const batch = new Float32Array(meterSamples);
      let at = 0;
      for (const part of meterBatch) {
        batch.set(part, at);
        at += part.length;
      }
      meterBatch = [];
      meterSamples = 0;
      const energy = calculateEnergy(batch);
      batchEnergies.push(energy);
      if (
        autoMode &&
        liveThreshold === null &&
        recordedSamples >= meterRate * 3
      ) {
        const estimate = estimateByName(batchEnergies, modeSelect.value);
        liveThreshold = Number.isFinite(estimate)
          ? Math.max(estimate, 40)
          : 40; // silent calibration window: fall back to the floor
        sliders.threshold.output.textContent = liveThreshold.toFixed(1);
        setStatus(
          `recording — auto threshold ${liveThreshold.toFixed(1)} dB ` +
            `(${modeSelect.value}) — click « stop recording » when done …`,
        );
      }
      const now = performance.now();
      if (now - lastPaint > 60) {
        lastPaint = now;
        const percent = Math.max(0, Math.min(100, ((energy + 20) / 110) * 100));
        liveBar.style.width = `${percent}%`;
        liveMeter.classList.toggle(
          "valid",
          energy >= (liveThreshold ?? Number(thresholdSlider.value)),
        );
        liveTime.textContent = `${(recordedSamples / meterRate).toFixed(1)} s`;
      }
    }
  }
  const { sampleRate } = mic;
  mic = null;
  liveMeter.hidden = true;
  liveMeter.classList.remove("valid");
  liveBar.style.width = "0%";
  recordBtn.classList.remove("recording");
  recordBtn.textContent = "record the microphone";
  let total = 0;
  for (const chunk of recorded) total += chunk.length;
  const samples = new Float32Array(total);
  let at = 0;
  for (const chunk of recorded) {
    samples.set(chunk, at);
    at += chunk.length;
  }
  if (total === 0) {
    setStatus("nothing was recorded", true);
    return;
  }
  setAudio({ channelData: [samples], sampleRate }, "microphone recording");
});

function setAudio(region, name) {
  audio = {
    channelData: region.channelData,
    sampleRate: region.sampleRate,
    name,
  };
  const duration = region.channelData[0].length / region.sampleRate;
  setStatus(
    `${name} — ${duration.toFixed(2)} s, ${region.sampleRate} Hz, ` +
      `${region.channelData.length} channel(s)`,
  );
  // webrtc only accepts 8/16/32/48 kHz
  const webrtcOption = modeSelect.querySelector('option[value="webrtc"]');
  const webrtcOk = WEBRTC_RATES.includes(region.sampleRate);
  webrtcOption.disabled = !webrtcOk;
  webrtcOption.title = webrtcOk
    ? ""
    : `webrtc requires ${WEBRTC_RATES.join("/")} Hz audio`;
  if (!webrtcOk && modeSelect.value === "webrtc") {
    modeSelect.value = "fixed";
    modeSelect.dispatchEvent(new Event("change"));
  }
  workbench.hidden = false;
  runDetection();
}

// ------------------------------------------------------------- detection

function currentOptions() {
  const mode = modeSelect.value;
  const options = {
    minDur: Number(sliders.minDur.input.value),
    maxSilence: Number(sliders.maxSilence.input.value),
    maxDur:
      Number(sliders.maxDur.input.value) > 30 // right end of the slider = no limit
        ? null
        : Number(sliders.maxDur.input.value),
    maxLeadingSilence: Number(sliders.maxLeadingSilence.input.value),
    maxTrailingSilence:
      Number(sliders.maxTrailingSilence.input.value) > 1 // right end = keep all
        ? null
        : Number(sliders.maxTrailingSilence.input.value),
  };
  if (mode === "fixed") {
    options.energyThreshold = Number(thresholdSlider.value);
  } else if (mode !== "webrtc") {
    options.validator = mode; // "otsu" | "percentile"
  }
  return { mode, options };
}

/** Estimate a threshold from a validator name ("otsu", "percentile"
 * or "pXX"), mirroring how split resolves it. */
function estimateByName(energies, name) {
  if (name === "otsu") {
    return estimateEnergyThreshold(energies, "otsu");
  }
  const percentile = name === "percentile" ? 10 : Number(name.slice(1));
  return estimateEnergyThreshold(energies, "percentile", { percentile });
}

let detectTimer = null;

function scheduleDetection() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(runDetection, 120);
}

async function runDetection() {
  if (audio === null) return;
  const { mode, options } = currentOptions();
  let webrtcValidator = null;
  try {
    if (mode === "webrtc") {
      // the VAD is stateful: a fresh instance per run, so results
      // don't depend on previous runs
      webrtcValidator = await createWebrtcValidator({
        sampleRate: audio.sampleRate,
        mode: 1,
      });
      options.validator = webrtcValidator;
    }
    events = await splitAll(audio, options);
  } catch (error) {
    summary.textContent = error.message;
    events = [];
    drawWaveform();
    renderEvents();
    return;
  } finally {
    webrtcValidator?.destroy();
  }
  let thresholdText;
  if (mode === "webrtc") {
    resolvedThreshold = null;
    thresholdText = "webrtc VAD, aggressiveness 1 (no energy threshold)";
    sliders.threshold.output.textContent = "—";
  } else if (typeof options.validator === "string") {
    const frameSamples = Math.floor(0.05 * audio.sampleRate);
    const energies = computeFrameEnergies(audio.channelData, frameSamples);
    resolvedThreshold =
      energies.length > 0
        ? estimateByName(energies, options.validator)
        : null;
    thresholdText =
      resolvedThreshold === null
        ? "input shorter than one analysis window"
        : resolvedThreshold === Infinity
          ? "input is digitally silent — nothing to detect"
          : `estimated threshold ${resolvedThreshold.toFixed(1)} dB ` +
            `(${options.validator})`;
    sliders.threshold.output.textContent =
      resolvedThreshold === null || resolvedThreshold === Infinity
        ? "—"
        : resolvedThreshold.toFixed(1);
  } else {
    resolvedThreshold = options.energyThreshold;
    thresholdText = `threshold ${resolvedThreshold.toFixed(1)} dB (fixed)`;
    sliders.threshold.output.textContent = String(resolvedThreshold);
  }
  const totalDur = audio.channelData[0].length / audio.sampleRate;
  const detectedDur = events.reduce((sum, e) => sum + e.duration, 0);
  summary.textContent =
    `${events.length} event(s) · ${thresholdText} · ` +
    `${detectedDur.toFixed(2)} s of activity in ${totalDur.toFixed(2)} s`;
  drawWaveform();
  renderEvents();
}

modeSelect.addEventListener("change", () => {
  thresholdControl.style.opacity = modeSelect.value === "fixed" ? "" : "0.4";
  thresholdSlider.disabled = modeSelect.value !== "fixed";
  scheduleDetection();
});

for (const { input, output } of Object.values(sliders)) {
  input.addEventListener("input", () => {
    if (input === sliders.maxDur.input && Number(input.value) > 30) {
      output.textContent = "∞";
    } else if (
      input === sliders.maxTrailingSilence.input &&
      Number(input.value) > 1
    ) {
      output.textContent = "all";
    } else {
      output.textContent = input.value;
    }
    scheduleDetection();
  });
}

// -------------------------------------------------------------- waveform

function drawWaveform() {
  if (audio === null) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const styles = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, width, height);

  // event highlights first, waveform on top
  const totalSamples = audio.channelData[0].length;
  const totalDur = totalSamples / audio.sampleRate;
  ctx.fillStyle = styles.getPropertyValue("--event");
  ctx.strokeStyle = styles.getPropertyValue("--event-border");
  for (const event of events) {
    const x = (event.start / totalDur) * width;
    const w = ((event.end - event.start) / totalDur) * width;
    ctx.fillRect(x, 0, w, height);
    ctx.strokeRect(x + 0.5, 0.5, w - 1, height - 1);
  }

  ctx.fillStyle = styles.getPropertyValue("--wave");
  const mid = height / 2;
  const samplesPerPixel = totalSamples / width;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * samplesPerPixel);
    const to = Math.min(
      Math.floor((x + 1) * samplesPerPixel) + 1,
      totalSamples,
    );
    let min = 1;
    let max = -1;
    for (const channel of audio.channelData) {
      for (let i = from; i < to; i++) {
        const v = channel[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const y = mid - max * mid;
    const h = Math.max(1, (max - min) * mid);
    ctx.fillRect(x, y, 1, h);
  }

  // one tick per second
  ctx.fillStyle = styles.getPropertyValue("--muted");
  ctx.font = "10px system-ui";
  const step = totalDur > 60 ? 10 : totalDur > 20 ? 5 : 1;
  for (let t = step; t < totalDur; t += step) {
    const x = (t / totalDur) * width;
    ctx.fillRect(x, height - 6, 1, 6);
    ctx.fillText(`${t}s`, x + 2, height - 2);
  }
}

canvas.addEventListener("click", (e) => {
  if (audio === null) return;
  const rect = canvas.getBoundingClientRect();
  const time =
    ((e.clientX - rect.left) / rect.width) *
    (audio.channelData[0].length / audio.sampleRate);
  const index = events.findIndex((ev) => time >= ev.start && time <= ev.end);
  if (index >= 0) playEvent(index);
});

window.addEventListener("resize", drawWaveform);

// ------------------------------------------------------- events & export

function renderEvents() {
  eventsBody.replaceChildren();
  events.forEach((event, i) => {
    const row = document.createElement("tr");
    row.innerHTML =
      `<td>▶</td><td>${i + 1}</td>` +
      `<td>${event.start.toFixed(3)}</td>` +
      `<td>${event.end.toFixed(3)}</td>` +
      `<td>${event.duration.toFixed(3)}</td>`;
    row.addEventListener("click", () => playEvent(i));
    eventsBody.appendChild(row);
  });
}

function playEvent(index) {
  const event = events[index];
  if (playingSource !== null) {
    playingSource.onended = null;
    playingSource.stop();
    playingRow?.classList.remove("playing");
  }
  if (playbackCtx === null || playbackCtx.sampleRate !== audio.sampleRate) {
    playbackCtx?.close();
    playbackCtx = new AudioContext({ sampleRate: audio.sampleRate });
  }
  const buffer = playbackCtx.createBuffer(
    event.channels,
    event.sampleCount,
    event.sampleRate,
  );
  event.channelData.forEach((channel, c) => {
    buffer.copyToChannel(channel, c);
  });
  const source = playbackCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackCtx.destination);
  playingSource = source;
  playingRow = eventsBody.children[index];
  playingRow.classList.add("playing");
  source.onended = () => {
    playingRow?.classList.remove("playing");
    playingSource = null;
    playingRow = null;
  };
  source.start();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

$("download-labels").addEventListener("click", () => {
  const lines = events.map(
    (e, i) => `${e.start.toFixed(6)}\t${e.end.toFixed(6)}\tauditok_${i + 1}`,
  );
  download("auditok-labels.txt", lines.join("\n") + "\n", "text/plain");
});

$("download-json").addEventListener("click", () => {
  const data = events.map((e) => ({
    start: e.start,
    end: e.end,
    duration: e.duration,
  }));
  download(
    "auditok-events.json",
    JSON.stringify(data, null, 2) + "\n",
    "application/json",
  );
});
