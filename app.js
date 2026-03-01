"use strict";

(() => {
  const TAU = Math.PI * 2;
  const INV_SQRT2 = Math.SQRT1_2;

  const $ = (id) => document.getElementById(id);

  const elements = {
    phaseCanvas: $("phaseCanvas"),
    vectorCanvas: $("vectorCanvas"),
    runStatus: $("runStatus"),
    inputStatus: $("inputStatus"),
    sampleStatus: $("sampleStatus"),
    corrNeedle: $("corrNeedle"),
    corrValue: $("corrValue"),
    rmsValue: $("rmsValue"),
    inputMode: $("inputMode"),
    startButton: $("startButton"),
    stopButton: $("stopButton"),
    gainRange: $("gainRange"),
    gainOut: $("gainOut"),
    persistenceRange: $("persistenceRange"),
    persistenceOut: $("persistenceOut"),
    zoomRange: $("zoomRange"),
    zoomOut: $("zoomOut"),
    pointSizeRange: $("pointSizeRange"),
    pointSizeOut: $("pointSizeOut"),
    intensityRange: $("intensityRange"),
    intensityOut: $("intensityOut"),
    demoControls: $("demoControls"),
    waveformSelect: $("waveformSelect"),
    freqRange: $("freqRange"),
    freqOut: $("freqOut"),
    phaseRange: $("phaseRange"),
    phaseOut: $("phaseOut"),
    widthRange: $("widthRange"),
    widthOut: $("widthOut"),
    demoLevelRange: $("demoLevelRange"),
    demoLevelOut: $("demoLevelOut"),
  };

  const state = {
    running: false,
    busy: false,
    inputMode: "mic",
    analysisGain: 1.2,
    persistence: 0.9,
    zoom: 0.72,
    pointSize: 2,
    intensity: 0.85,
    demoWaveform: "sine",
    demoFrequency: 220,
    demoPhaseDeg: 90,
    demoWidth: 1,
    demoLevel: 0.2,
    corrSmooth: 0,
    rmsSmoothL: -80,
    rmsSmoothR: -80,
  };

  const scopeViews = {
    phase: makeScopeView(elements.phaseCanvas),
    vector: makeScopeView(elements.vectorCanvas),
  };

  let audioContext = null;
  let channelSplitter = null;
  let analyserL = null;
  let analyserR = null;
  let activeSource = null;
  let demoProcessor = null;
  let micStream = null;
  let animationFrameId = 0;
  let sampleBufferL = new Float32Array(2048);
  let sampleBufferR = new Float32Array(2048);

  initialize();

  function initialize() {
    bindControls();
    syncInputMode();
    resizeScopes();
    clearScope(scopeViews.phase);
    clearScope(scopeViews.vector);
    setRunStatus("idle", "Idle");
    updateInputStatus();
    window.addEventListener("resize", resizeScopes);
  }

  function bindControls() {
    bindRange(
      elements.gainRange,
      elements.gainOut,
      (value) => `${value.toFixed(2)}x`,
      (value) => {
        state.analysisGain = value;
      },
    );

    bindRange(
      elements.persistenceRange,
      elements.persistenceOut,
      (value) => value.toFixed(2),
      (value) => {
        state.persistence = value;
      },
    );

    bindRange(
      elements.zoomRange,
      elements.zoomOut,
      (value) => value.toFixed(2),
      (value) => {
        state.zoom = value;
      },
    );

    bindRange(
      elements.pointSizeRange,
      elements.pointSizeOut,
      (value) => value.toFixed(2),
      (value) => {
        state.pointSize = value;
      },
    );

    bindRange(
      elements.intensityRange,
      elements.intensityOut,
      (value) => value.toFixed(2),
      (value) => {
        state.intensity = value;
      },
    );

    bindRange(
      elements.freqRange,
      elements.freqOut,
      (value) => `${Math.round(value)} Hz`,
      (value) => {
        state.demoFrequency = value;
      },
    );

    bindRange(
      elements.phaseRange,
      elements.phaseOut,
      (value) => `${Math.round(value)} deg`,
      (value) => {
        state.demoPhaseDeg = value;
      },
    );

    bindRange(
      elements.widthRange,
      elements.widthOut,
      (value) => value.toFixed(2),
      (value) => {
        state.demoWidth = value;
      },
    );

    bindRange(
      elements.demoLevelRange,
      elements.demoLevelOut,
      (value) => value.toFixed(2),
      (value) => {
        state.demoLevel = value;
      },
    );

    elements.waveformSelect.addEventListener("change", () => {
      state.demoWaveform = elements.waveformSelect.value;
    });

    elements.inputMode.addEventListener("change", () => {
      state.inputMode = elements.inputMode.value;
      syncInputMode();
      if (state.running) {
        start().catch(handleError);
      }
    });

    elements.startButton.addEventListener("click", () => {
      start().catch(handleError);
    });

    elements.stopButton.addEventListener("click", () => {
      stop().catch(handleError);
    });
  }

  function bindRange(input, output, format, onChange) {
    const apply = () => {
      const value = Number(input.value);
      onChange(value);
      output.textContent = format(value);
    };
    input.addEventListener("input", apply);
    apply();
  }

  function syncInputMode() {
    const isDemo = state.inputMode === "demo";
    elements.demoControls.disabled = !isDemo;
    updateInputStatus();
  }

  async function start() {
    if (state.busy) {
      return;
    }
    state.busy = true;
    try {
      await ensureAudioGraph();
      await audioContext.resume();
      await disconnectSource();

      if (state.inputMode === "mic") {
        await connectMicrophone();
      } else {
        connectDemoGenerator();
      }

      state.running = true;
      setRunStatus("running", "Running");
      elements.startButton.disabled = true;
      elements.stopButton.disabled = false;

      if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(renderLoop);
      }
    } catch (error) {
      await disconnectSource();
      state.running = false;
      setRunStatus("error", "Error");
      elements.startButton.disabled = false;
      elements.stopButton.disabled = true;
      throw error;
    } finally {
      state.busy = false;
    }
  }

  async function stop() {
    await disconnectSource();
    state.running = false;
    setRunStatus("idle", "Idle");
    elements.startButton.disabled = false;
    elements.stopButton.disabled = true;

    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    }

    clearScope(scopeViews.phase);
    clearScope(scopeViews.vector);
    elements.corrNeedle.style.left = "50%";
    elements.corrValue.textContent = "Correlation: --";
    elements.rmsValue.textContent = "RMS: L -- dB / R -- dB";
    updateInputStatus();
  }

  async function ensureAudioGraph() {
    if (audioContext) {
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Web Audio API is not available in this browser.");
    }

    audioContext = new AudioContextClass();
    channelSplitter = audioContext.createChannelSplitter(2);
    analyserL = audioContext.createAnalyser();
    analyserR = audioContext.createAnalyser();

    analyserL.fftSize = 2048;
    analyserR.fftSize = 2048;
    analyserL.smoothingTimeConstant = 0.05;
    analyserR.smoothingTimeConstant = 0.05;

    channelSplitter.connect(analyserL, 0);
    channelSplitter.connect(analyserR, 1);

    sampleBufferL = new Float32Array(analyserL.fftSize);
    sampleBufferR = new Float32Array(analyserR.fftSize);

    elements.sampleStatus.textContent = `Sample rate: ${Math.round(audioContext.sampleRate)} Hz`;
  }

  async function connectMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone capture is not supported in this browser.");
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    activeSource = audioContext.createMediaStreamSource(micStream);
    activeSource.connect(channelSplitter);
    updateInputStatus("microphone");
  }

  function connectDemoGenerator() {
    if (!audioContext.createScriptProcessor) {
      throw new Error("ScriptProcessor is not available in this browser.");
    }

    let phaseCursor = 0;
    demoProcessor = audioContext.createScriptProcessor(1024, 0, 2);
    demoProcessor.onaudioprocess = (event) => {
      const outputL = event.outputBuffer.getChannelData(0);
      const outputR = event.outputBuffer.getChannelData(1);
      const phaseStep = (TAU * state.demoFrequency) / audioContext.sampleRate;
      const phaseShift = (state.demoPhaseDeg * Math.PI) / 180;
      const width = state.demoWidth;
      const level = state.demoLevel;
      const waveform = state.demoWaveform;

      for (let i = 0; i < outputL.length; i += 1) {
        phaseCursor += phaseStep;
        if (phaseCursor > TAU) {
          phaseCursor -= TAU;
        }

        const leftRaw = sampleWave(waveform, phaseCursor);
        const rightRaw = sampleWave(waveform, phaseCursor + phaseShift);

        const mid = (leftRaw + rightRaw) * 0.5;
        const side = (leftRaw - rightRaw) * 0.5 * width;

        outputL[i] = (mid + side) * level;
        outputR[i] = (mid - side) * level;
      }
    };

    activeSource = demoProcessor;
    demoProcessor.connect(channelSplitter);
    demoProcessor.connect(audioContext.destination);
    updateInputStatus("built-in demo");
  }

  function sampleWave(type, angle) {
    const wrapped = normalizeAngle(angle);
    switch (type) {
      case "triangle":
        return 1 - (2 * Math.abs(wrapped)) / Math.PI;
      case "sawtooth":
        return wrapped / Math.PI;
      case "square":
        return Math.sin(wrapped) >= 0 ? 1 : -1;
      case "sine":
      default:
        return Math.sin(wrapped);
    }
  }

  function normalizeAngle(value) {
    const wrapped = (value + Math.PI) % TAU;
    return wrapped < 0 ? wrapped + Math.PI : wrapped - Math.PI;
  }

  async function disconnectSource() {
    if (activeSource) {
      try {
        activeSource.disconnect();
      } catch (_error) {
        // Ignore repeated disconnections.
      }
      activeSource = null;
    }

    if (demoProcessor) {
      try {
        demoProcessor.disconnect();
      } catch (_error) {
        // Ignore repeated disconnections.
      }
      demoProcessor.onaudioprocess = null;
      demoProcessor = null;
    }

    if (micStream) {
      for (const track of micStream.getTracks()) {
        track.stop();
      }
      micStream = null;
    }
  }

  function renderLoop() {
    animationFrameId = requestAnimationFrame(renderLoop);

    if (!state.running || !analyserL || !analyserR) {
      return;
    }

    analyserL.getFloatTimeDomainData(sampleBufferL);
    analyserR.getFloatTimeDomainData(sampleBufferR);

    const metrics = computeMetrics(sampleBufferL, sampleBufferR, state.analysisGain);
    drawPhaseScope(sampleBufferL, sampleBufferR);
    drawVectorScope(sampleBufferL, sampleBufferR);
    updateMeters(metrics);
  }

  function computeMetrics(left, right, gain) {
    let sumLR = 0;
    let sumL2 = 1e-12;
    let sumR2 = 1e-12;

    for (let i = 0; i < left.length; i += 1) {
      const l = left[i] * gain;
      const r = right[i] * gain;
      sumLR += l * r;
      sumL2 += l * l;
      sumR2 += r * r;
    }

    const correlation = clamp(sumLR / Math.sqrt(sumL2 * sumR2), -1, 1);
    const rmsL = Math.sqrt(sumL2 / left.length);
    const rmsR = Math.sqrt(sumR2 / right.length);
    const dbL = linearToDb(rmsL);
    const dbR = linearToDb(rmsR);

    state.corrSmooth = lerp(state.corrSmooth, correlation, 0.16);
    state.rmsSmoothL = lerp(state.rmsSmoothL, dbL, 0.2);
    state.rmsSmoothR = lerp(state.rmsSmoothR, dbR, 0.2);

    return {
      correlation: state.corrSmooth,
      rmsLDb: state.rmsSmoothL,
      rmsRDb: state.rmsSmoothR,
    };
  }

  function drawPhaseScope(left, right) {
    drawScope(
      scopeViews.phase,
      left,
      right,
      (l, r, scale, cx, cy) => ({
        x: cx + l * scale,
        y: cy - r * scale,
      }),
      "rgba(69, 232, 192, 0.9)",
      false,
    );
  }

  function drawVectorScope(left, right) {
    drawScope(
      scopeViews.vector,
      left,
      right,
      (l, r, scale, cx, cy) => {
        const mid = (l + r) * INV_SQRT2;
        const side = (l - r) * INV_SQRT2;
        return {
          x: cx + side * scale,
          y: cy - mid * scale,
        };
      },
      "rgba(255, 171, 78, 0.9)",
      true,
    );
  }

  function drawScope(view, left, right, projector, color, showDiagonals) {
    const { ctx, width, height, dpr } = view;
    const fadeAlpha = clamp((1 - state.persistence) * 1.45, 0.02, 0.35);
    const centerX = width * 0.5;
    const centerY = height * 0.5;
    const scale = Math.min(width, height) * state.zoom * 0.48;
    const pointSize = Math.max(1, state.pointSize * dpr);
    const step = 2;

    ctx.fillStyle = `rgba(1, 8, 14, ${fadeAlpha})`;
    ctx.fillRect(0, 0, width, height);

    drawGuideLines(ctx, width, height, dpr, showDiagonals);

    const alpha = clamp(state.intensity, 0.1, 1);
    ctx.fillStyle = applyAlpha(color, alpha);

    for (let i = 0; i < left.length; i += step) {
      const l = clamp(left[i] * state.analysisGain, -1, 1);
      const r = clamp(right[i] * state.analysisGain, -1, 1);
      const point = projector(l, r, scale, centerX, centerY);
      ctx.fillRect(point.x, point.y, pointSize, pointSize);
    }
  }

  function drawGuideLines(ctx, width, height, dpr, showDiagonals) {
    ctx.save();
    ctx.lineWidth = Math.max(1, dpr);

    ctx.strokeStyle = "rgba(164, 197, 216, 0.11)";
    ctx.beginPath();
    ctx.moveTo(width * 0.25, 0);
    ctx.lineTo(width * 0.25, height);
    ctx.moveTo(width * 0.75, 0);
    ctx.lineTo(width * 0.75, height);
    ctx.moveTo(0, height * 0.25);
    ctx.lineTo(width, height * 0.25);
    ctx.moveTo(0, height * 0.75);
    ctx.lineTo(width, height * 0.75);
    ctx.stroke();

    ctx.strokeStyle = "rgba(186, 220, 241, 0.2)";
    ctx.beginPath();
    ctx.moveTo(width * 0.5, 0);
    ctx.lineTo(width * 0.5, height);
    ctx.moveTo(0, height * 0.5);
    ctx.lineTo(width, height * 0.5);

    if (showDiagonals) {
      ctx.moveTo(0, 0);
      ctx.lineTo(width, height);
      ctx.moveTo(width, 0);
      ctx.lineTo(0, height);
    }
    ctx.stroke();

    ctx.restore();
  }

  function updateMeters(metrics) {
    const needlePercent = ((metrics.correlation + 1) * 0.5) * 100;
    elements.corrNeedle.style.left = `${needlePercent.toFixed(2)}%`;
    elements.corrValue.textContent = `Correlation: ${metrics.correlation.toFixed(3)}`;
    elements.rmsValue.textContent = `RMS: L ${metrics.rmsLDb.toFixed(1)} dB / R ${metrics.rmsRDb.toFixed(1)} dB`;
  }

  function setRunStatus(mode, label) {
    elements.runStatus.classList.remove("idle", "running", "error");
    elements.runStatus.classList.add(mode);
    elements.runStatus.textContent = label;
  }

  function updateInputStatus(activeLabel) {
    let label = activeLabel;
    if (!label) {
      label = state.running
        ? state.inputMode === "demo"
          ? "built-in demo"
          : "microphone"
        : `${state.inputMode === "demo" ? "built-in demo" : "microphone"} (not started)`;
    }
    elements.inputStatus.textContent = `Input: ${label}`;
  }

  function makeScopeView(canvas) {
    const ctx = canvas.getContext("2d", { alpha: false });
    return {
      canvas,
      ctx,
      width: 0,
      height: 0,
      dpr: window.devicePixelRatio || 1,
    };
  }

  function resizeScopes() {
    resizeScope(scopeViews.phase);
    resizeScope(scopeViews.vector);
  }

  function resizeScope(view) {
    const rect = view.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.round(rect.width * dpr));
    const nextHeight = Math.max(1, Math.round(rect.height * dpr));

    if (view.width === nextWidth && view.height === nextHeight) {
      return;
    }

    view.canvas.width = nextWidth;
    view.canvas.height = nextHeight;
    view.width = nextWidth;
    view.height = nextHeight;
    view.dpr = dpr;
    clearScope(view);
  }

  function clearScope(view) {
    view.ctx.fillStyle = "rgba(1, 6, 12, 1)";
    view.ctx.fillRect(0, 0, view.width || view.canvas.width, view.height || view.canvas.height);
    drawGuideLines(view.ctx, view.width || view.canvas.width, view.height || view.canvas.height, view.dpr, true);
  }

  function handleError(error) {
    const message = error instanceof Error ? error.message : String(error);
    setRunStatus("error", "Error");
    elements.inputStatus.textContent = `Input: ${message}`;
    console.error(error);
  }

  function applyAlpha(rgbString, alpha) {
    if (!rgbString.endsWith(")")) {
      return rgbString;
    }
    return rgbString.replace(/[\d.]+\)$/, `${alpha})`);
  }

  function linearToDb(value) {
    return 20 * Math.log10(Math.max(value, 1e-6));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
