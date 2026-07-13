/* map.js — a shared, pinch-zoomable deck-plan overlay for the phone screens.
 *
 * Drop `<script src="./map.js"></script>` into any page and it adds a floating
 * "Map" button plus a full-screen viewer with pinch-zoom / drag-pan / double-tap.
 * The map image comes from game.json `map` (defaults to assets/floorplan.svg).
 * Exposes window.openTrainMap().
 */
(function () {
  'use strict';

  function init() {
    var SRC = 'assets/floorplan.svg';

    var style = document.createElement('style');
    style.textContent = [
      '#mapFab{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:80;',
        'display:flex;align-items:center;gap:8px;padding:11px 16px 11px 13px;border-radius:999px;cursor:pointer;',
        "font-family:'Cinzel',serif;font-weight:700;font-size:14px;letter-spacing:.1em;color:#231607;",
        'background:linear-gradient(180deg,#e0ad42,#b8862c);border:1px solid #c9a24a;',
        'box-shadow:0 8px 22px rgba(0,0,0,.45)}',
      '#mapFab:active{filter:brightness(.93)}',
      '#mapFab svg{width:19px;height:19px;display:block}',
      '#mapOverlay{position:fixed;inset:0;z-index:200;display:none;flex-direction:column;',
        'background:radial-gradient(130% 90% at 50% 0%,#20160c,#080502 75%);',
        "font-family:'Cinzel',serif;color:#efe0bd}",
      '#mapOverlay.show{display:flex}',
      '#mapTop{flex:none;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;',
        'padding-top:calc(14px + env(safe-area-inset-top))}',
      '#mapTitle{font-family:"Special Elite",monospace;font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#a8895a}',
      '#mapClose{width:38px;height:38px;border-radius:50%;border:1px solid #4a3418;background:#2a1d10;color:#e6c877;',
        'font-size:17px;cursor:pointer;line-height:1}',
      '#mapStage{flex:1;position:relative;overflow:hidden;touch-action:none;cursor:grab}',
      '#mapStage:active{cursor:grabbing}',
      // the floorplan is dark line-art meant for paper, so give it a parchment backing
      '#mapImg{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform;',
        '-webkit-user-select:none;user-select:none;-webkit-user-drag:none;filter:sepia(.3) saturate(.9);',
        'background:linear-gradient(150deg,#efe4c8,#e7d8b4 45%,#dccca4);box-shadow:0 12px 44px rgba(0,0,0,.55)}',
      '#mapZoom{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(20px + env(safe-area-inset-bottom));',
        'display:flex;gap:8px;background:rgba(20,14,8,.82);border:1px solid #4a3418;border-radius:999px;padding:6px}',
      '#mapZoom button{min-width:46px;height:40px;border:0;border-radius:999px;background:transparent;color:#e6c877;',
        "font-family:'Cinzel',serif;font-weight:700;font-size:18px;cursor:pointer}",
      '#mapZoom button:active{background:rgba(201,162,74,.18)}',
      '#mapHint{position:absolute;left:0;right:0;top:8px;text-align:center;pointer-events:none;',
        'font-family:"Special Elite",monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#6a4f2a}'
    ].join('');
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.id = 'mapFab';
    fab.setAttribute('aria-label', 'Open the map');
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#231607" stroke-width="1.7" stroke-linejoin="round">' +
      '<path d="M9 3 3 5.2v15.8l6-2.2 6 2.2 6-2.2V3l-6 2.2z"/><path d="M9 3v15.8M15 5.2V21"/></svg><span>Map</span>';

    var overlay = document.createElement('div');
    overlay.id = 'mapOverlay';
    overlay.innerHTML =
      '<div id="mapTop"><span id="mapTitle">Deck Plan</span><button id="mapClose" aria-label="Close">✕</button></div>' +
      '<div id="mapStage"><div id="mapHint">Pinch to zoom · drag to move</div><img id="mapImg" alt="Train deck plan" draggable="false"></div>' +
      '<div id="mapZoom"><button data-z="out">−</button><button data-z="reset">Fit</button><button data-z="in">+</button></div>';

    document.body.appendChild(fab);
    document.body.appendChild(overlay);

    var stage = overlay.querySelector('#mapStage');
    var img = overlay.querySelector('#mapImg');

    // ---- transform state -----------------------------------------------------
    var scale = 1, tx = 0, ty = 0, fitScale = 1, loaded = false;
    function iw() { return img.naturalWidth || 882; }
    function ih() { return img.naturalHeight || 1247; }
    function apply() { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }

    function clampPan() {
      var sw = stage.clientWidth, sh = stage.clientHeight, w = iw() * scale, h = ih() * scale;
      tx = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, tx));
      ty = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, ty));
    }
    function fit() {
      var sw = stage.clientWidth, sh = stage.clientHeight;
      fitScale = Math.min(sw / iw(), sh / ih()) * 0.96;
      scale = fitScale; tx = (sw - iw() * fitScale) / 2; ty = (sh - ih() * fitScale) / 2;
      apply();
    }
    function zoomAt(ns, sx, sy) {
      ns = Math.max(fitScale, Math.min(fitScale * 8, ns));
      var ratio = ns / scale;
      tx = sx - (sx - tx) * ratio; ty = sy - (sy - ty) * ratio; scale = ns;
      clampPan(); apply();
    }

    // ---- gestures ------------------------------------------------------------
    var pts = new Map(), mode = null, last = null, pinch = null, lastTap = 0, lastTapPt = null;
    function rel(e) { var r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function vals() { var a = []; pts.forEach(function (v) { a.push(v); }); return a; }
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

    stage.addEventListener('pointerdown', function (e) {
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, rel(e));
      if (pts.size === 1) { mode = 'pan'; last = rel(e); tapMaybe(e); }
      else if (pts.size === 2) { mode = 'pinch'; var t = vals(); pinch = { dist: dist(t[0], t[1]), scale: scale, mid: mid(t[0], t[1]), tx: tx, ty: ty }; }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, rel(e));
      if (mode === 'pan' && pts.size === 1) {
        var p = rel(e); tx += p.x - last.x; ty += p.y - last.y; last = p; clampPan(); apply();
      } else if (mode === 'pinch' && pts.size >= 2 && pinch) {
        var t = vals(), d = dist(t[0], t[1]), m = mid(t[0], t[1]);
        var ns = Math.max(fitScale, Math.min(fitScale * 8, pinch.scale * (d / pinch.dist))), ratio = ns / pinch.scale;
        tx = m.x - (pinch.mid.x - pinch.tx) * ratio; ty = m.y - (pinch.mid.y - pinch.ty) * ratio; scale = ns;
        clampPan(); apply();
      }
    });
    function up(e) {
      if (pts.has(e.pointerId)) pts.delete(e.pointerId);
      try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
      if (pts.size === 1) { mode = 'pan'; last = vals()[0]; } else if (pts.size === 0) { mode = null; pinch = null; }
    }
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', function (e) { e.preventDefault(); var p = rel(e); zoomAt(scale * (e.deltaY < 0 ? 1.15 : 0.87), p.x, p.y); }, { passive: false });

    function tapMaybe(e) {
      var t = performance.now(), p = rel(e);
      if (t - lastTap < 300 && lastTapPt && dist(p, lastTapPt) < 30) {
        if (scale > fitScale * 1.05) fit(); else zoomAt(fitScale * 2.5, p.x, p.y);
        lastTap = 0;
      } else { lastTap = t; lastTapPt = p; }
    }

    overlay.querySelector('#mapZoom').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var sw = stage.clientWidth, sh = stage.clientHeight;
      if (b.dataset.z === 'in') zoomAt(scale * 1.4, sw / 2, sh / 2);
      else if (b.dataset.z === 'out') zoomAt(scale * 0.7, sw / 2, sh / 2);
      else fit();
    });

    // ---- open / close --------------------------------------------------------
    function open() { overlay.classList.add('show'); if (img.getAttribute('src') !== SRC) img.src = SRC; if (loaded) fit(); }
    function close() { overlay.classList.remove('show'); }
    fab.addEventListener('click', open);
    overlay.querySelector('#mapClose').addEventListener('click', close);
    img.addEventListener('load', function () { loaded = true; if (overlay.classList.contains('show')) fit(); });
    window.addEventListener('resize', function () { if (overlay.classList.contains('show')) fit(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    // configurable map source + title
    fetch('game.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (g) {
      if (g && g.map) SRC = g.map;
      if (g && g.train && g.train.name) overlay.querySelector('#mapTitle').textContent = g.train.name + ' · Deck Plan';
    }).catch(function () {});

    window.openTrainMap = open;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
