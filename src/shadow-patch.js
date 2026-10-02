// Runs in the page's MAIN world at document_start, before any page script.
// Some players (Prime Video among them) render <video> inside a *closed*
// shadow root, which is invisible to a normal extension content script -
// querySelectorAll simply can't see into it. Forcing every shadow root open
// lets Volocity's content script (isolated world) reach the real <video>
// element via el.shadowRoot. This only affects DOM visibility, not any
// site behavior or protection.
(() => {
  if (window.__volocityShadowPatched) return;
  window.__volocityShadowPatched = true;
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    try {
      return originalAttachShadow.call(this, { ...init, mode: 'open' });
    } catch (e) {
      return originalAttachShadow.call(this, init);
    }
  };
})();
