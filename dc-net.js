/* dc-net.js — networked shared state for the Midnight Express screens.
 *
 * Load this BEFORE support.js. It transparently replaces the browser's
 * per-device localStorage for the `nighttrain_*` keys with a WebSocket-synced
 * cache, so every screen (buzzer, TV, GM, players) reads and writes ONE live
 * game state on the server.
 *
 * The DC components are unchanged: they still call localStorage.getItem/setItem
 * and poll every 200ms. getItem now returns the server-synced value; setItem
 * broadcasts to the server, which fans the change out to every other screen.
 *
 * Non-`nighttrain_` keys fall through to real localStorage untouched.
 */
(function () {
  'use strict';

  var NS = 'nighttrain_';
  var managed = function (k) { return typeof k === 'string' && k.indexOf(NS) === 0; };

  // Local mirror of the shared keys. Values are the opaque localStorage strings.
  var cache = Object.create(null);

  // --- Patch Storage so managed keys hit the cache instead of the device. -----
  var proto = window.Storage && window.Storage.prototype;
  if (proto) {
    var _get = proto.getItem, _set = proto.setItem, _rem = proto.removeItem;
    proto.getItem = function (k) {
      if (managed(k)) return (k in cache) ? cache[k] : null;
      return _get.call(this, k);
    };
    proto.setItem = function (k, v) {
      if (managed(k)) { var s = String(v); cache[k] = s; send({ type: 'set', key: k, value: s }); return; }
      return _set.call(this, k, v);
    };
    proto.removeItem = function (k) {
      if (managed(k)) { delete cache[k]; send({ type: 'del', key: k }); return; }
      return _rem.call(this, k);
    };
  }

  // --- WebSocket transport, same-origin (works through Cloudflare Tunnel). ----
  var ws = null, isOpen = false, outbox = [], backoff = 500;
  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

  function send(obj) {
    var s = JSON.stringify(obj);
    if (isOpen) { try { ws.send(s); } catch (e) { outbox.push(s); } }
    else outbox.push(s);
  }

  function flush() {
    while (outbox.length && isOpen) {
      try { ws.send(outbox.shift()); } catch (e) { break; }
    }
  }

  function applyUpdate(key, value) {
    if (value == null) delete cache[key];
    else cache[key] = value;
  }

  function connect() {
    try { ws = new WebSocket(WS_URL); }
    catch (e) { schedule(); return; }

    ws.onopen = function () {
      isOpen = true; backoff = 500;
      send({ type: 'hello' }); // pull the current snapshot
      flush();
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'snapshot' && m.state) {
        for (var k in m.state) applyUpdate(k, m.state[k]);
      } else if (m.type === 'update') {
        applyUpdate(m.key, m.value);
      }
    };
    ws.onclose = function () { isOpen = false; schedule(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function schedule() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.6, 5000);
  }

  // Expose a tiny hook for the GM screen / debugging if ever useful.
  window.__dcNet = {
    ready: function () { return isOpen; },
    snapshot: function () { var o = {}; for (var k in cache) o[k] = cache[k]; return o; }
  };

  connect();
})();
