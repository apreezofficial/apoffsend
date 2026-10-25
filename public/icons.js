// Hand-drawn stroke icons. icon(name) returns an inline SVG string; any element
// placeholder <i data-icon="name"></i> is swapped for it automatically.
(function () {
  'use strict';
  const P = {
    logo: '<path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/>',
    upload: '<path d="M12 16V4"/><path d="m6.5 9.5 5.5-5.5 5.5 5.5"/><path d="M4 20h16"/>',
    download: '<path d="M12 4v12"/><path d="m6.5 10.5 5.5 5.5 5.5-5.5"/><path d="M4 20h16"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="1.6"/><path d="M2 19.5h20"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.5h3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L6 21"/>',
    video: '<rect x="2.5" y="5" width="13.5" height="14" rx="2.5"/><path d="m16 10 5.5-3.2v10.4L16 14"/>',
    audio: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    doc: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/><path d="M8.5 13h7M8.5 17h5"/>',
    archive: '<rect x="3" y="3" width="18" height="5" rx="1.5"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12.5h4"/>',
    file: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/>',
    text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/>',
    trash: '<path d="M3.5 6h17"/><path d="M8.5 6V4h7v2"/><path d="m6 6 1 15h10l1-15"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    retry: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>',
    send: '<path d="M21.5 2.5 10.5 13.5"/><path d="M21.5 2.5 15 21.5l-4.5-8-8-4.5z"/>',
    wifi: '<path d="M2 9a15 15 0 0 1 20 0"/><path d="M5.5 12.6a10 10 0 0 1 13 0"/><path d="M9 16.2a5 5 0 0 1 6 0"/><path d="M12 20h.01"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    lock: '<rect x="4" y="10.5" width="16" height="11" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
    github: '<path d="M9 19c-4.5 1.5-4.5-2.5-6.5-3m13 6v-3.5a3 3 0 0 0-.9-2.4c3-.3 6.1-1.5 6.1-6.6a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.6 12.6 0 0 0-6.6 0C6.3 2.1 5.2 2.4 5.2 2.4a4.8 4.8 0 0 0-.1 3.6 5.2 5.2 0 0 0-1.4 3.6c0 5.1 3.1 6.3 6.1 6.6a3 3 0 0 0-.9 2.4V22"/>',
    zip: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/><path d="M10 3v2M10 7v2M10 11v2"/><rect x="8.5" y="14" width="3" height="4" rx="1"/>',
  };
  function icon(name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || P.file) + '</svg>';
  }
  function hydrate(root) {
    (root || document).querySelectorAll('i[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
  }
  window.icon = icon;
  window.hydrateIcons = hydrate;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate());
  else hydrate();
})();
