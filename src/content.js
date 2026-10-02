// Volocity content script
// Applies playback rate + audio boost to every <video> on the page,
// keeps them applied when the site tries to reset them (e.g. after a seek),
// and renders a small draggable overlay that survives fullscreen.

(() => {
  const PREFIX = 'volocity:';
  const MIN_RATE = 0.25;
  const MAX_RATE = 4;
  const MIN_BOOST = 0.5;
  const MAX_BOOST = 4;

  // Smart Volume: a slow, self-correcting auto-gain loop that rides loudness
  // toward a target level - raising quiet passages, ducking loud ones - so
  // the fast limiter (see ensureAudioGraph) rarely has to do heavy lifting.
  // Target sits close to the limiter's 0dBFS threshold on purpose - this is
  // meant to feel like "as loud as safely possible", not gentle normalizing;
  // the limiter (fast, 3ms attack) is what actually guarantees no clipping
  // when real peaks get close, so it's safe to aim this high.
  const SMART_TARGET_DB = -9; // target average (RMS) loudness, dBFS
  const SMART_SILENCE_DB = -50; // below this, treat as silence and hold gain
  const SMART_MIN_GAIN = 0.4;
  const SMART_ATTACK_TAU = 0.25; // seconds - ducking loud audio (fast, protective)
  const SMART_RELEASE_TAU = 1.1; // seconds - raising quiet audio (still smooth, more noticeable)
  const SMART_POLL_MS = 150;

  const host = () => location.hostname || 'local-file';
  const siteKey = () => PREFIX + host();
  const globalKey = PREFIX + 'global';

  // Sites known to be fragile enough to default Volocity off on, so playback
  // works out of the box. A user can still opt in via the per-site toggle;
  // that explicit choice always overrides this default. Empty for now -
  // hotstar.com was here after its Shaka-Player-based UI hung indefinitely
  // the instant Volocity attached any addEventListener to its <video>
  // element, but Volocity no longer does that at all (see pollVideo() -
  // everything is polling-based now, no listeners on the video element for
  // any site), so it's worth testing hotstar.com again before re-adding it.
  const DEFAULT_OFF_HOSTS = [];
  const isDefaultOffHost = () => {
    const h = host();
    return DEFAULT_OFF_HOSTS.some((suffix) => h === suffix || h.endsWith('.' + suffix));
  };

  const state = {
    enabled: true, // whether Volocity touches this site's video/audio at all
    rate: 1,
    boost: 1,
    smartVolume: false,
    overlayEnabled: true,
    pos: null // {right, bottom} in px, relative to viewport
  };

  const managedVideos = new Set();
  const audioGraphs = new WeakMap(); // video -> {ctx, source, gain, analyser, limiter, analyserBuf}
  let overlayHost = null;
  let shadow = null;
  let watchdogTimer = null;
  let smartVolumeTimer = null;
  let saveTimer = null;
  let idleTimer = null;
  const IDLE_MS = 2800; // roughly matches most players' own auto-hide delay

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtRate = (v) => `${v.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0')}x`;
  const fmtBoost = (v) => `${Math.round(v * 100)}%`;

  // ---------- storage ----------

  function loadSettings(cb) {
    chrome.storage.local.get([siteKey(), globalKey], (res) => {
      const site = res[siteKey()] || {};
      const global = res[globalKey] || {};
      state.enabled = site.enabled ?? global.enabled ?? !isDefaultOffHost();
      state.rate = clamp(site.rate ?? global.defaultRate ?? 1, MIN_RATE, MAX_RATE);
      state.boost = clamp(site.boost ?? global.defaultBoost ?? 1, MIN_BOOST, MAX_BOOST);
      state.smartVolume = site.smartVolume ?? global.smartVolume ?? false;
      state.overlayEnabled = site.overlayEnabled ?? global.overlayEnabled ?? true;
      state.pos = site.pos ?? null;
      cb && cb();
    });
  }

  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({
        [siteKey()]: {
          enabled: state.enabled,
          rate: state.rate,
          boost: state.boost,
          smartVolume: state.smartVolume,
          overlayEnabled: state.overlayEnabled,
          pos: state.pos
        }
      });
    }, 150);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[siteKey()]) return;
    const next = changes[siteKey()].newValue || {};
    const wasEnabled = state.enabled;
    state.enabled = next.enabled ?? !isDefaultOffHost();
    state.rate = clamp(next.rate ?? 1, MIN_RATE, MAX_RATE);
    state.boost = clamp(next.boost ?? 1, MIN_BOOST, MAX_BOOST);
    state.smartVolume = next.smartVolume ?? false;
    state.overlayEnabled = next.overlayEnabled ?? true;
    if (wasEnabled && !state.enabled) resetToNative();
    applyToAll();
    updateOverlayDisplay();
    setOverlayVisible(state.overlayEnabled);
    updateBadge();
  });

  // Hands full control of rate/volume back to the page - used when the user
  // turns Volocity off for this site, so native player controls (e.g.
  // YouTube's own speed menu) work completely unimpeded again.
  function resetToNative() {
    managedVideos.forEach((video) => {
      video.playbackRate = 1;
      const graph = audioGraphs.get(video);
      if (graph) {
        graph.gain.gain.cancelScheduledValues(graph.ctx.currentTime);
        graph.gain.gain.setValueAtTime(1, graph.ctx.currentTime);
      }
    });
  }

  function updateBadge() {
    chrome.runtime.sendMessage({ type: 'volocity-badge', rate: state.enabled ? state.rate : 1 }).catch(() => {});
  }

  // ---------- video management ----------

  function applyRate(video) {
    // Live streams (duration reports Infinity) have no meaningful "speed" -
    // forcing a non-1x rate against a live/low-latency buffer can cause
    // stalling or rebuffering, so leave live playback completely alone.
    if (video.duration === Infinity) return;
    if (Math.abs(video.playbackRate - state.rate) > 0.001) {
      try {
        video.playbackRate = state.rate;
      } catch (e) {
        console.error(`[Volocity] setting playbackRate threw on ${host()}:`, e.message);
      }
    }
  }

  function ensureAudioGraph(video) {
    if (audioGraphs.has(video)) return audioGraphs.get(video);
    // DRM-protected video (video.mediaKeys is set once the site's EME/CDM
    // setup completes): some DRM tiers (Widevine L1 especially, common for
    // premium/live streams) explicitly disallow routing through Web Audio,
    // and even where it's technically allowed, doing so can interfere with
    // the decode pipeline. Never attempt it - speed control still works,
    // audio boost just isn't available on this video.
    if (video.mediaKeys) {
      console.info('[Volocity] audio boost skipped - this video is DRM-protected (speed control still works)');
      audioGraphs.set(video, null);
      return null;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      // Analyser taps the signal right after our gain (pass-through, doesn't
      // alter audio) so Smart Volume can measure the level it's actually
      // producing and ride it toward a target loudness.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // A limiter after that: threshold sits at 0dB with a hard-ish ratio,
      // so it's transparent at normal volume and only engages to stop
      // boosted audio from clipping/distorting once it would exceed full
      // scale - it doesn't squash normal (non-boosted) dynamics. This is
      // the fast safety net; Smart Volume (when on) is the slower, smarter
      // layer that tries to avoid ever needing it.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = 0;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      source.connect(gain).connect(analyser).connect(limiter).connect(ctx.destination);
      const graph = { ctx, source, gain, analyser, limiter, analyserBuf: new Float32Array(analyser.fftSize) };
      audioGraphs.set(video, graph);
      return graph;
    } catch (e) {
      // Cross-origin/DRM-tainted media, or already routed elsewhere.
      console.warn('[Volocity] audio boost unavailable for this video:', e.message);
      audioGraphs.set(video, null);
      return null;
    }
  }

  // Videos whose currentTime has actually been observed advancing (set by
  // pollVideo, below) - only past this point is it safe to attempt Web
  // Audio routing. Encrypted media can't advance until its DRM key session
  // is fully set up, so waiting for real playback avoids ever touching the
  // audio graph mid-key-negotiation (which is when interfering with it is
  // most likely to break playback).
  const playbackStarted = new WeakSet();

  function applyBoost(video) {
    if (!playbackStarted.has(video)) return;
    const graph = ensureAudioGraph(video);
    if (!graph) return;
    if (graph.ctx.state === 'suspended') graph.ctx.resume().catch(() => {});
    // In Smart Volume mode the gain is continuously ridden by
    // runSmartVolumeTick() instead - here we'd just fight it.
    if (state.smartVolume) return;
    if (Math.abs(graph.gain.gain.value - state.boost) > 0.001) {
      graph.gain.gain.value = state.boost;
    }
  }

  function rmsDbOf(graph) {
    graph.analyser.getFloatTimeDomainData(graph.analyserBuf);
    let sumSquares = 0;
    for (let i = 0; i < graph.analyserBuf.length; i++) {
      const s = graph.analyserBuf[i];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / graph.analyserBuf.length);
    return 20 * Math.log10(rms + 1e-8);
  }

  // One adjustment step for one video: measure the level we're currently
  // producing (post-gain), and nudge gain toward the target loudness. Fully
  // automatic - it ignores the manual boost slider and pushes as high as
  // MAX_BOOST when quiet content calls for it, or ducks below 1x if the
  // source is already loud, always keeping headroom for the limiter below.
  // Silence is left alone so we don't ride noise floor up to the ceiling
  // and then blast the next line of dialogue.
  function runSmartVolumeTick(video) {
    const graph = audioGraphs.get(video);
    if (!graph || !graph.analyser) return;

    const levelDb = rmsDbOf(graph);
    if (levelDb < SMART_SILENCE_DB) return;

    const currentGain = graph.gain.gain.value;
    const adjustDb = SMART_TARGET_DB - levelDb;
    const desiredGain = clamp(currentGain * Math.pow(10, adjustDb / 20), SMART_MIN_GAIN, MAX_BOOST);

    const tau = desiredGain < currentGain ? SMART_ATTACK_TAU : SMART_RELEASE_TAU;
    graph.gain.gain.setTargetAtTime(desiredGain, graph.ctx.currentTime, tau);
  }

  function startSmartVolumeLoop() {
    clearInterval(smartVolumeTimer);
    smartVolumeTimer = setInterval(() => {
      if (!state.smartVolume) return;
      if (!state.enabled) return;
      let liveGain = null;
      managedVideos.forEach((video) => {
        if (!video.isConnected || video.paused) return;
        runSmartVolumeTick(video);
        const graph = audioGraphs.get(video);
        if (graph) liveGain = graph.gain.gain.value;
      });
      if (liveGain !== null) updateBoostReadout(liveGain);
    }, SMART_POLL_MS);
  }

  // Single choke point: when Volocity is off for this site, every reassert
  // listener (loadedmetadata/seeked/ratechange/etc.), the watchdog, and the
  // Smart Volume loop all become no-ops here - so native player controls
  // (e.g. YouTube's own speed menu) are never fought.
  function applyToVideo(video) {
    if (!state.enabled) return;
    applyRate(video);
    applyBoost(video);
  }

  function applyToAll() {
    managedVideos.forEach(applyToVideo);
  }

  // Volocity never calls addEventListener on the site's own <video> element -
  // deliberately. Confirmed by testing: Hotstar's Shaka-Player-based player
  // hangs indefinitely the instant ANY listener is registered on its video
  // element, before Volocity even changes anything. A comparable working
  // Hotstar speed-control tool avoids this the same way: a plain polling
  // "enforcement loop" that re-applies playbackRate on an interval instead
  // of reacting to events on the element. So instead of listeners, every
  // video is polled from the watchdog tick (pollVideo, below) - which also
  // means this same mechanism is what re-applies settings after a seek/
  // reset (the original "settings revert after skipping ahead" fix), just
  // via polling rather than specific event names.
  const videoPollState = new WeakMap(); // video -> {lastTime, wasPaused, erroredLogged}

  function setupVideo(video) {
    if (managedVideos.has(video)) return;
    managedVideos.add(video);
    ensureOverlayBuilt();
    console.info(`[Volocity] video detected on ${host()} (drm=${!!video.mediaKeys}, src=${video.currentSrc || video.src || 'pending'})`);
    pollVideo(video); // apply immediately rather than waiting for the next tick
  }

  function pollVideo(video) {
    const st = videoPollState.get(video) || { lastTime: -1, wasPaused: true, erroredLogged: false };

    if (video.error && !st.erroredLogged) {
      st.erroredLogged = true;
      console.error(`[Volocity] video element error on ${host()}: code ${video.error.code} - ${video.error.message || '(no message)'}`);
    }

    const paused = video.paused;
    const advancing = !paused && video.currentTime !== st.lastTime;

    if (advancing) {
      if (!playbackStarted.has(video)) {
        playbackStarted.add(video);
        console.info(`[Volocity] video started playing on ${host()} (drm=${!!video.mediaKeys})`);
      }
      if (st.wasPaused) revealOverlay();
    } else if (paused && !st.wasPaused) {
      revealOverlay({ persist: true });
    }

    st.wasPaused = paused;
    st.lastTime = video.currentTime;
    videoPollState.set(video, st);

    applyToVideo(video);
  }

  function isAnyVideoPlaying() {
    for (const v of managedVideos) {
      if (v.isConnected && !v.paused) return true;
    }
    return false;
  }

  // Shows the overlay immediately. Unless persist is set (used while paused
  // or while the user is hovering the panel itself), it schedules a fade-out
  // after IDLE_MS - the same "hide after inactivity" pattern nearly every
  // video player's own controls use, so Volocity fades in/out in step with them.
  function revealOverlay({ persist = false } = {}) {
    if (!shadow) return;
    const panel = shadow.querySelector('.panel');
    if (!panel) return;
    panel.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!persist && isAnyVideoPlaying()) {
      idleTimer = setTimeout(() => panel.classList.add('idle'), IDLE_MS);
    }
  }

  const observedRoots = new WeakSet();

  // Some players keep <video> inside a shadow root (open, or forced open by
  // shadow-patch.js). querySelectorAll doesn't pierce shadow boundaries, so
  // we walk the tree ourselves and recurse into every shadow root we find.
  function collectVideos(root, out) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll('video').forEach((v) => out.add(v));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        observeRoot(el.shadowRoot);
        collectVideos(el.shadowRoot, out);
      }
    });
  }

  function scanForVideos(root = document) {
    const found = new Set();
    collectVideos(root, found);
    found.forEach(setupVideo);
    return found;
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
  }

  // Cheap path for the common case: a plain querySelectorAll('video') on
  // just the added subtree. This runs on every DOM mutation anywhere on the
  // page, so on a heavy React/SPA site that can be very frequent - the full
  // shadow-DOM-recursive collectVideos() (which walks every element via
  // querySelectorAll('*')) is too expensive to run per-mutation and is
  // instead left to the periodic watchdog tick below.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'VIDEO') { setupVideo(node); return; }
        if (node.querySelectorAll) node.querySelectorAll('video').forEach(setupVideo);
      });
    }
  });

  function startWatchdog() {
    clearInterval(watchdogTimer);
    let tick = 0;
    watchdogTimer = setInterval(() => {
      tick++;
      // This is the entire mechanism for keeping rate/boost applied and for
      // detecting play/pause/error state - see pollVideo() above for why
      // it's polling-based rather than event-listener-based.
      managedVideos.forEach((video) => {
        if (video.isConnected) pollVideo(video);
      });
      // Every ~3rd tick (~2s), rescan for videos that appeared inside a
      // shadow root the MutationObserver didn't catch (e.g. a shadow root
      // attached before we started observing it).
      if (tick % 3 === 0) scanForVideos();
    }, 700);
  }

  // ---------- overlay ----------

  function buildOverlay() {
    overlayHost = document.createElement('div');
    overlayHost.id = 'volocity-overlay-host';
    shadow = overlayHost.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: rgba(20, 20, 24, 0.88);
          color: #f2f2f2;
          border-radius: 10px;
          padding: 8px 10px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.4);
          backdrop-filter: blur(6px);
          user-select: none;
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 168px;
          opacity: 1;
          transition: opacity 0.25s ease;
        }
        .panel.idle { opacity: 0; pointer-events: none; }
        .panel.collapsed { min-width: 0; padding: 6px; }
        .panel.collapsed .body { display: none; }
        .panel.site-off .body { display: none; }
        .panel.site-off { opacity: 0.7; }
        .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
        .drag { cursor: grab; font-weight: 600; letter-spacing: 0.3px; flex: 1; }
        .drag:active { cursor: grabbing; }
        .iconbtn {
          all: unset; cursor: pointer; color: #bbb; padding: 2px 4px; border-radius: 4px; font-size: 11px;
        }
        .iconbtn:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .ctrl-row { display: flex; align-items: center; gap: 6px; }
        button.step {
          all: unset; cursor: pointer; width: 20px; height: 20px; text-align: center;
          background: rgba(255,255,255,0.1); border-radius: 5px; line-height: 20px;
        }
        button.step:hover { background: rgba(255,255,255,0.22); }
        .ctrl-row.disabled { opacity: 0.4; pointer-events: none; }
        .value { flex: 1; text-align: center; cursor: pointer; font-variant-numeric: tabular-nums; }
        .label { color: #9aa0a6; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; flex: 1; }
        .label-row { display: flex; align-items: center; justify-content: space-between; }
        .auto-toggle {
          all: unset; cursor: pointer; font-size: 9px; font-weight: 700; letter-spacing: 0.4px;
          padding: 1px 5px; border-radius: 4px; color: #9aa0a6; background: rgba(255,255,255,0.08);
        }
        .auto-toggle:hover { color: #fff; background: rgba(255,255,255,0.18); }
        .auto-toggle.active { color: #fff; background: #7c5cff; }
        .power-toggle {
          all: unset; cursor: pointer; font-size: 9px; font-weight: 700; letter-spacing: 0.4px;
          padding: 1px 6px; border-radius: 4px; color: #8ef58e; background: rgba(126,255,126,0.12);
        }
        .power-toggle:hover { background: rgba(126,255,126,0.22); }
        .power-toggle.off { color: #ff9d9d; background: rgba(255,80,80,0.15); }
        .power-toggle.off:hover { background: rgba(255,80,80,0.25); }
        .off-note { color: #9aa0a6; font-size: 10px; }
      </style>
      <div class="panel" part="panel">
        <div class="row">
          <span class="drag">Volocity</span>
          <button class="power-toggle" data-action="power" data-role="power" title="Turn Volocity off for this site">ON</button>
          <button class="iconbtn" data-action="collapse" title="Collapse">–</button>
          <button class="iconbtn" data-action="hide" title="Hide overlay">×</button>
        </div>
        <div class="body">
          <div class="label">Speed</div>
          <div class="ctrl-row">
            <button class="step" data-action="rate-down">−</button>
            <span class="value" data-role="rate" title="Click to reset">1.00x</span>
            <button class="step" data-action="rate-up">+</button>
          </div>
          <div class="label-row">
            <div class="label">Volume boost</div>
            <button class="auto-toggle" data-action="smart-toggle" data-role="smart-toggle" title="Smart Volume: auto-levels toward loud-but-safe, never clips">AUTO</button>
          </div>
          <div class="ctrl-row" data-row="boost">
            <button class="step" data-action="boost-down">−</button>
            <span class="value" data-role="boost" title="Click to reset">100%</span>
            <button class="step" data-action="boost-up">+</button>
          </div>
        </div>
        <div class="off-note" data-role="off-note" hidden>Off for this site - Volocity makes no contact with the video at all.</div>
      </div>
    `;

    document.documentElement.appendChild(overlayHost);
    wireOverlay();
    positionOverlay();
  }

  function wireOverlay() {
    const panel = shadow.querySelector('.panel');

    shadow.querySelector('[data-action="rate-down"]').addEventListener('click', () => setRate(state.rate - 0.1));
    shadow.querySelector('[data-action="rate-up"]').addEventListener('click', () => setRate(state.rate + 0.1));
    shadow.querySelector('[data-role="rate"]').addEventListener('click', () => setRate(1));

    shadow.querySelector('[data-action="boost-down"]').addEventListener('click', () => setBoost(state.boost - 0.1));
    shadow.querySelector('[data-action="boost-up"]').addEventListener('click', () => setBoost(state.boost + 0.1));
    shadow.querySelector('[data-role="boost"]').addEventListener('click', () => setBoost(1));

    shadow.querySelector('[data-action="smart-toggle"]').addEventListener('click', () => {
      setSmartVolume(!state.smartVolume);
    });

    shadow.querySelector('[data-action="power"]').addEventListener('click', () => {
      setEnabled(!state.enabled);
    });

    shadow.querySelector('[data-action="collapse"]').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
    });
    shadow.querySelector('[data-action="hide"]').addEventListener('click', () => {
      state.overlayEnabled = false;
      saveSettings();
      setOverlayVisible(false);
    });

    // Don't fade out while the pointer is actually over the panel.
    panel.addEventListener('mouseenter', () => revealOverlay({ persist: true }));
    panel.addEventListener('mouseleave', () => revealOverlay());

    // Global activity signal: any mouse movement on the page keeps/brings
    // the overlay visible, same trigger most players use for their own chrome.
    document.addEventListener('mousemove', () => revealOverlay(), { passive: true });
    document.addEventListener('mousedown', () => revealOverlay(), { passive: true });

    revealOverlay();

    // Drag to reposition (position stored as distance from bottom-right corner).
    const dragHandle = shadow.querySelector('.drag');
    let dragging = false;
    let startX, startY, startRight, startBottom;

    dragHandle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragHandle.setPointerCapture(e.pointerId);
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
    });
    dragHandle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const right = clamp(startRight - dx, 4, window.innerWidth - 40);
      const bottom = clamp(startBottom - dy, 4, window.innerHeight - 20);
      panel.style.right = right + 'px';
      panel.style.bottom = bottom + 'px';
    });
    dragHandle.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      state.pos = {
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom
      };
      saveSettings();
    });
  }

  function positionOverlay() {
    if (!shadow) return;
    const panel = shadow.querySelector('.panel');
    if (state.pos) {
      panel.style.right = state.pos.right + 'px';
      panel.style.bottom = state.pos.bottom + 'px';
    }
  }

  function setOverlayVisible(visible) {
    if (!overlayHost) return;
    // content.css has "all: initial !important" on this element (needed to
    // isolate it from host-page styles), which also forces display back to
    // its initial value on every recalc - a plain inline style can't win
    // against that. Setting it with "important" priority ourselves can.
    overlayHost.style.setProperty('display', visible ? 'block' : 'none', 'important');
  }

  function updateOverlayDisplay() {
    if (!shadow) return;
    shadow.querySelector('[data-role="rate"]').textContent = fmtRate(state.rate);
    const boostEl = shadow.querySelector('[data-role="boost"]');
    if (!state.smartVolume) boostEl.textContent = fmtBoost(state.boost);
    boostEl.title = state.smartVolume
      ? 'Smart Volume is auto-adjusting this - showing the live level'
      : 'Click to reset';
    shadow.querySelector('[data-row="boost"]').classList.toggle('disabled', state.smartVolume);
    const toggle = shadow.querySelector('[data-role="smart-toggle"]');
    toggle.classList.toggle('active', state.smartVolume);

    const powerBtn = shadow.querySelector('[data-role="power"]');
    powerBtn.textContent = state.enabled ? 'ON' : 'OFF';
    powerBtn.classList.toggle('off', !state.enabled);
    powerBtn.title = state.enabled ? 'Turn Volocity off for this site' : 'Turn Volocity on for this site';
    shadow.querySelector('.panel').classList.toggle('site-off', !state.enabled);
    shadow.querySelector('[data-role="off-note"]').hidden = state.enabled;
  }

  // Called from the Smart Volume loop to show the live, currently-applied
  // gain (which rides below the ceiling most of the time) rather than the
  // static ceiling value, so the overlay reflects what's actually happening.
  function updateBoostReadout(liveGain) {
    if (!shadow || !state.smartVolume) return;
    shadow.querySelector('[data-role="boost"]').textContent = fmtBoost(liveGain);
  }

  function setRate(v) {
    state.rate = clamp(Math.round(v * 100) / 100, MIN_RATE, MAX_RATE);
    applyToAll();
    updateOverlayDisplay();
    saveSettings();
    updateBadge();
  }

  function setBoost(v) {
    state.boost = clamp(Math.round(v * 100) / 100, MIN_BOOST, MAX_BOOST);
    applyToAll();
    updateOverlayDisplay();
    saveSettings();
  }

  function setSmartVolume(on) {
    state.smartVolume = !!on;
    applyToAll(); // snaps gain back to the fixed boost value when turning off
    updateOverlayDisplay();
    saveSettings();
  }

  function setEnabled(on) {
    state.enabled = !!on;
    if (!state.enabled) {
      resetToNative();
    } else {
      applyToAll(); // immediately re-apply the stored rate/boost
    }
    updateOverlayDisplay();
    saveSettings();
    updateBadge();
  }

  // ---------- fullscreen support ----------
  // When a plain <video> element itself goes fullscreen, the browser only
  // paints that element - nothing else can be overlaid on top of it. So if
  // that happens we swap the fullscreen target to its parent element (which
  // is how most real players do it already), letting us render inside it.

  // The swap has to be all-or-nothing. Leaving fullscreen and then failing to
  // get back into it drops the user out altogether: fullscreen appears for a
  // moment and collapses, which looks like the fullscreen button is broken.
  //
  // Re-entering needs transient user activation, and a click on the browser's
  // own control bar gives the page none -- those controls live in the UA shadow
  // tree. So on a plain <video controls>, the swap could never succeed, and it
  // cost the user fullscreen every single time. Nothing in the page's own code
  // is at fault; the extension simply must not start a swap it cannot finish.
  function canSwapFullscreen() {
    if (!overlayHost || !state.enabled || !state.overlayEnabled) return false;
    const activation = navigator.userActivation;
    // Older engines do not report activation; there, attempt it as before.
    return !activation || activation.isActive;
  }

  let fsHost = null;   // the element we moved fullscreen onto, if we did

  function releaseFsHost() {
    if (fsHost) {
      fsHost.classList.remove('volocity-fs-host');
      fsHost = null;
    }
  }

  function handleFullscreenChange() {
    if (!overlayHost) return;
    const fsEl = document.fullscreenElement;

    if (!fsEl) {
      releaseFsHost();
      document.documentElement.appendChild(overlayHost);
      positionOverlay();
      return;
    }

    if (fsEl.tagName === 'VIDEO') {
      const video = fsEl;
      const parent = video.parentElement;
      // No parent, no activation, or no overlay to show: leave the video's own
      // fullscreen exactly as it is. Losing the overlay is a small cost; losing
      // fullscreen is the whole feature the user asked for.
      if (!parent || !canSwapFullscreen()) return;

      // A fullscreen <video> is painted by the browser at screen size whatever
      // the page's CSS says. An ordinary element is not, so the parent needs
      // marking for the stylesheet to size it and the video inside it.
      parent.classList.add('volocity-fs-host');
      fsHost = parent;
      document.exitFullscreen()
        .then(() => parent.requestFullscreen())
        .catch(() => {
          // Put the user back where they were rather than leaving them with
          // no fullscreen at all.
          releaseFsHost();
          if (!document.fullscreenElement && video.isConnected) {
            video.requestFullscreen().catch(() => {});
          }
        });
      return;
    }

    fsEl.appendChild(overlayHost);
    positionOverlay();
  }

  // ---------- boot ----------

  // Only builds (and shows) the overlay once a real <video> is actually
  // found on the page - not eagerly on every page load. A page with no
  // video (a login page, a captcha/security-check page, a search results
  // page, etc.) never gets an overlay at all, so it can never visually
  // collide with that page's own UI.
  function ensureOverlayBuilt() {
    if (overlayHost) return;
    try {
      buildOverlay();
      updateOverlayDisplay();
      setOverlayVisible(state.overlayEnabled);
    } catch (e) {
      console.warn('[Volocity] on-page overlay failed to render on this site (speed/boost still work):', e);
    }
  }

  function init() {
    loadSettings(() => {
      document.addEventListener('fullscreenchange', handleFullscreenChange);
      observeRoot(document.documentElement);
      const found = scanForVideos();
      startWatchdog();
      startSmartVolumeLoop();
      updateBadge();
      console.info(`[Volocity] ${state.enabled ? 'active' : 'OFF (per-site toggle)'} on ${host()} - ${found.size} video element(s) found at load`);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Keyboard-command relay from the background service worker.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'volocity-rate-delta':
        setRate(state.rate + msg.delta);
        break;
      case 'volocity-boost-delta':
        setBoost(state.boost + msg.delta);
        break;
      case 'volocity-toggle-overlay':
        state.overlayEnabled = !state.overlayEnabled;
        setOverlayVisible(state.overlayEnabled);
        saveSettings();
        break;
    }
  });
})();
