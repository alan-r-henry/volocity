const PREFIX = 'volocity:';

const rateSlider = document.getElementById('rate-slider');
const rateValue = document.getElementById('rate-value');
const boostSlider = document.getElementById('boost-slider');
const boostValue = document.getElementById('boost-value');
const overlayToggle = document.getElementById('overlay-toggle');
const smartToggle = document.getElementById('smart-toggle');
const enableToggle = document.getElementById('enable-toggle');
const speedGroup = document.getElementById('speed-group');
const boostGroup = document.getElementById('boost-group');
const boostControls = document.getElementById('boost-controls');
const boostPresets = document.getElementById('boost-presets');
const siteLabel = document.getElementById('site');
const resetBtn = document.getElementById('reset-btn');
const rateDec = document.getElementById('rate-dec');
const rateInc = document.getElementById('rate-inc');
const boostDec = document.getElementById('boost-dec');
const boostInc = document.getElementById('boost-inc');

const RATE_STEP = 0.1;
const BOOST_STEP = 0.1;

// Keep in sync with DEFAULT_OFF_HOSTS in src/content.js.
const DEFAULT_OFF_HOSTS = [];
function isDefaultOffHost(h) {
  return DEFAULT_OFF_HOSTS.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

let currentHost = null;

function key() {
  return PREFIX + currentHost;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fmtRate(v) {
  return `${v.toFixed(2)}x`;
}
function fmtBoost(v) {
  return `${Math.round(v * 100)}%`;
}

function render(settings) {
  const enabled = settings.enabled ?? !isDefaultOffHost(currentHost);
  const rate = settings.rate ?? 1;
  const boost = settings.boost ?? 1;
  const smartVolume = settings.smartVolume ?? false;
  const overlayEnabled = settings.overlayEnabled ?? true;

  enableToggle.checked = enabled;
  speedGroup.classList.toggle('dimmed', !enabled);
  boostGroup.classList.toggle('dimmed', !enabled);

  rateSlider.value = rate;
  rateValue.textContent = fmtRate(rate);
  boostSlider.value = boost;
  boostValue.textContent = smartVolume ? 'Auto' : fmtBoost(boost);
  overlayToggle.checked = overlayEnabled;
  smartToggle.checked = smartVolume;
  boostControls.classList.toggle('dimmed', smartVolume);
  boostPresets.classList.toggle('dimmed', smartVolume);
}

function save(partial) {
  chrome.storage.local.get([key()], (res) => {
    const next = { ...(res[key()] || {}), ...partial };
    chrome.storage.local.set({ [key()]: next });
    render(next);
  });
}

function init() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    let hostname = 'local-file';
    try {
      hostname = new URL(tab.url).hostname || hostname;
    } catch (e) {
      /* non-http url */
    }
    currentHost = hostname;
    siteLabel.textContent = hostname;

    chrome.storage.local.get([key()], (res) => {
      render(res[key()] || {});
    });
  });
}

rateSlider.addEventListener('input', () => {
  const v = parseFloat(rateSlider.value);
  rateValue.textContent = fmtRate(v);
  save({ rate: v });
});

boostSlider.addEventListener('input', () => {
  const v = parseFloat(boostSlider.value);
  boostValue.textContent = fmtBoost(v);
  save({ boost: v });
});

overlayToggle.addEventListener('change', () => {
  save({ overlayEnabled: overlayToggle.checked });
});

enableToggle.addEventListener('change', () => {
  save({ enabled: enableToggle.checked });
});

smartToggle.addEventListener('change', () => {
  save({ smartVolume: smartToggle.checked });
});

rateDec.addEventListener('click', () => {
  const v = clamp(parseFloat(rateSlider.value) - RATE_STEP, parseFloat(rateSlider.min), parseFloat(rateSlider.max));
  rateSlider.value = v;
  rateValue.textContent = fmtRate(v);
  save({ rate: v });
});
rateInc.addEventListener('click', () => {
  const v = clamp(parseFloat(rateSlider.value) + RATE_STEP, parseFloat(rateSlider.min), parseFloat(rateSlider.max));
  rateSlider.value = v;
  rateValue.textContent = fmtRate(v);
  save({ rate: v });
});

boostDec.addEventListener('click', () => {
  const v = clamp(parseFloat(boostSlider.value) - BOOST_STEP, parseFloat(boostSlider.min), parseFloat(boostSlider.max));
  boostSlider.value = v;
  boostValue.textContent = fmtBoost(v);
  save({ boost: v });
});
boostInc.addEventListener('click', () => {
  const v = clamp(parseFloat(boostSlider.value) + BOOST_STEP, parseFloat(boostSlider.min), parseFloat(boostSlider.max));
  boostSlider.value = v;
  boostValue.textContent = fmtBoost(v);
  save({ boost: v });
});

document.querySelectorAll('[data-rate]').forEach((btn) => {
  btn.addEventListener('click', () => save({ rate: parseFloat(btn.dataset.rate) }));
});
document.querySelectorAll('[data-boost]').forEach((btn) => {
  btn.addEventListener('click', () => save({ boost: parseFloat(btn.dataset.boost) }));
});

resetBtn.addEventListener('click', () => {
  save({ enabled: true, rate: 1, boost: 1, smartVolume: false, overlayEnabled: true, pos: null });
});

init();
