// SPDX-License-Identifier: AGPL-3.0-only
/* GP-Next web host shim: maps the Tauri v2 IPC surface GP-Next uses onto browser APIs.
 * Virtual AppData lives in IndexedDB; nothing outside the page is touched. */
(function () {
  if (window.__GPN_WEB_SHIM__) return;
  window.__GPN_WEB_SHIM__ = true;

  var APP_DATA = '/AppData';
  var DB_NAME = 'gp-next-web-fs';
  var STORE = 'entries';
  var dbPromise = null;
  var pendingDownloads = Object.create(null);

  function db() {
    if (!dbPromise) dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function request(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function withStore(mode, fn) {
    return db().then(function (d) {
      var t = d.transaction(STORE, mode);
      var out = fn(t.objectStore(STORE));
      return new Promise(function (res, rej) {
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  function getEntry(key) { return db().then(function (d) { return request(d.transaction(STORE, 'readonly').objectStore(STORE).get(key)); }); }
  function putEntry(e) {
    return db().then(function (d) {
      var t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(e, e.key);
      return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); }; });
    });
  }
  function delEntry(key) {
    return db().then(function (d) {
      var t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).delete(key);
      return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); }; });
    });
  }
  function allKeys() { return db().then(function (d) { return request(d.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys()); }); }

  function norm(p) {
    var s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+/g, '/');
    s = s.replace(/^\/+/, '').replace(/^AppData\/?/i, '').replace(/^gp-next\/?/i, '');
    return s.replace(/\/+$/, '');
  }
  function parentOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function baseName(p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }

  async function ensureDir(p) {
    if (!p) return;
    var parts = p.split('/'), cur = '';
    for (var i = 0; i < parts.length; i++) {
      cur = cur ? cur + '/' + parts[i] : parts[i];
      var e = await getEntry(cur);
      if (e && e.type !== 'dir') throw new Error('ENOTDIR: ' + cur);
      if (!e) await putEntry({ key: cur, type: 'dir', mtime: Date.now() });
    }
  }
  function bytesOf(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (Array.isArray(v)) return new Uint8Array(v);
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (v && typeof v.length === 'number') return new Uint8Array(v);
    return new Uint8Array(0);
  }
  async function writeVirtual(p, bytes) {
    var key = norm(p);
    if (!key) throw new Error('EINVAL: empty path');
    await ensureDir(parentOf(key));
    await putEntry({ key: key, type: 'file', data: bytesOf(bytes), mtime: Date.now() });
    if (key.indexOf('exports/') === 0) triggerDownload(key, bytesOf(bytes));
  }
  async function readVirtual(p) {
    var key = norm(p);
    if (!key) throw new Error('EISDIR: /');
    var e = await getEntry(key);
    if (!e) throw new Error('ENOENT: ' + key);
    if (e.type === 'dir') throw new Error('EISDIR: ' + key);
    return e.data instanceof Uint8Array ? e.data : bytesOf(e.data);
  }
  function triggerDownload(key, bytes) {
    var name = pendingDownloads[key] || baseName(key);
    try {
      var url = URL.createObjectURL(new Blob([bytes]));
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
      delete pendingDownloads[key];
    } catch (e) { /* download is best effort */ }
  }

  function pathOf(args) {
    if (typeof args === 'string') return args;
    if (!args) return '';
    if (typeof args.path === 'string') return args.path;
    if (args.options && typeof args.options.path === 'string') return args.options.path;
    return '';
  }
  function optsOf(args) {
    if (!args || typeof args !== 'object') return {};
    if (args.options && typeof args.options === 'object') return args.options;
    return {};
  }
  function headerOf(options, key) {
    if (!options || !options.headers) return null;
    var h = options.headers;
    var v = (typeof h.get === 'function') ? h.get(key) : (h[key] === undefined ? null : h[key]);
    if (v == null) return null;
    if (key === 'path') { try { return decodeURIComponent(v); } catch (e) { return v; } }
    return v;
  }
  function headerPath(options) {
    var raw = headerOf(options, 'path');
    return raw || '';
  }

  /* ---------- dialogs ---------- */
  function pickOpen(args) {
    var o = optsOf(args);
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      if (o.directory) input.webkitdirectory = true;
      else if (o.multiple) input.multiple = true;
      if (!o.directory && Array.isArray(o.filters)) {
        var exts = [];
        o.filters.forEach(function (f) { (f.extensions || []).forEach(function (e) { exts.push('.' + e); }); });
        if (exts.length) input.accept = exts.join(',');
      }
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async function () {
        try {
          var files = Array.prototype.slice.call(input.files || []);
          input.remove();
          if (!files.length) return resolve(null);
          var stamp = 'imports/' + Date.now();
          var results = [];
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var rel = (f.webkitRelativePath || f.name || ('file' + i)).replace(/\\/g, '/');
            var target = stamp + '/' + rel;
            var buf = new Uint8Array(await f.arrayBuffer());
            await writeVirtual(target, buf);
            results.push(norm(target));
          }
          if (o.directory) return resolve(norm(stamp));
          resolve(o.multiple ? results : results[0]);
        } catch (e) { resolve(null); }
      });
      input.addEventListener('cancel', function () { input.remove(); resolve(null); });
      input.click();
    });
  }
  function pickSave(args) {
    var o = optsOf(args);
    var def = (o.defaultPath || o.default_path || 'export.bin') + '';
    var name = baseName(def.replace(/\\/g, '/')) || 'export.bin';
    var key = 'exports/' + Date.now() + '-' + name;
    pendingDownloads[key] = name;
    return Promise.resolve(norm(key));
  }

  /* ---------- events ---------- */
  var seq = 1, callbacks = new Map();
  function transformCallback(cb, once) {
    var id = seq++;
    callbacks.set(id, { cb: cb, once: once === true });
    return id;
  }
  function runCallback(id, value) {
    var item = callbacks.get(id);
    if (!item) return;
    try { item.cb(value); } finally { if (item.once) callbacks.delete(id); }
  }

  /* ---------- browser cloud saves (game localStorage only) ---------- */
  var SAVE_KEYS = ['PvZ2_PlayerProperties', 'PvZ2_Settings'];
  var CLOUD_META = 'gp-web-cloud';
  var rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
  var cloudBusy = null, cloudRequested = false, cloudBooting = true, saveFrozen = false;
  var cloudMessage = '', cloudNotice = '';
  function cloudMeta() {
    try { return JSON.parse(localStorage.getItem(CLOUD_META)) || {}; } catch (_) { return {}; }
  }
  function saveMeta(meta) { rawSet.call(localStorage, CLOUD_META, JSON.stringify(meta)); }
  function saveData() {
    var data = {};
    SAVE_KEYS.forEach(function (key) { var value = localStorage.getItem(key); if (value !== null) data[key] = value; });
    return data;
  }
  function paintCloud() {
    var meta = cloudMeta();
    var state = meta.code ? (!meta.needsJoin && meta.syncedAt >= meta.updatedAt ? '已同步' : '本地已保存，节点自动同步') : '未连接云存档，本地进度照常保存';
    var text = cloudMessage || state;
    if (meta.lastSync) text += ' · 上次同步 ' + new Date(meta.lastSync).toLocaleString();
    var status = document.getElementById('web-cloud-status');
    if (status) status.textContent = text;
    var notice = document.getElementById('web-cloud-notice');
    if (notice) notice.textContent = cloudNotice || meta.notice || '';
    var button = document.getElementById('web-cloud-open');
    if (button) button.textContent = '云存档' + (meta.code ? ' · ' + (cloudMessage || state) : '');
  }
  function changedSave() {
    var meta = cloudMeta();
    meta.updatedAt = Math.max(Date.now(), (meta.updatedAt || 0) + 1);
    saveMeta(meta);
    cloudMessage = '';
    paintCloud();
  }
  Storage.prototype.setItem = function (key, value) {
    var tracked = this === localStorage && SAVE_KEYS.indexOf(String(key)) >= 0;
    if (tracked && saveFrozen) return;
    var before = tracked ? this.getItem(key) : null;
    if (tracked && before === String(value)) return;
    rawSet.call(this, key, value);
    if (tracked && before !== this.getItem(key)) changedSave();
  };
  Storage.prototype.removeItem = function (key) {
    var tracked = this === localStorage && SAVE_KEYS.indexOf(String(key)) >= 0;
    if (tracked && saveFrozen) return;
    var before = tracked ? this.getItem(key) : null;
    rawRemove.call(this, key);
    if (tracked && before !== null) changedSave();
  };
  async function cloudFetch(code, method, body) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 6000);
    try {
      var response = await fetch('/api/cloud/' + code, {
        method: method, cache: 'no-store', signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body,
        keepalive: !body || new Blob([body]).size < 60000
      });
      if (response.status === 404 && method === 'GET') return null;
      if (response.status === 409) return { conflict: await response.json() };
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function validateCloud(blob) {
    if (!blob || blob.version !== 1 || !Number.isSafeInteger(blob.updatedAt) || blob.updatedAt <= 0 ||
        !blob.data || !Array.isArray(JSON.parse(blob.data.PvZ2_PlayerProperties)) ||
        Object.keys(blob.data).some(function (key) { return SAVE_KEYS.indexOf(key) < 0 || typeof blob.data[key] !== 'string'; })) {
      throw new Error('云端存档格式错误');
    }
    if (blob.data.PvZ2_Settings !== undefined) {
      var settings = JSON.parse(blob.data.PvZ2_Settings);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('云端设置格式错误');
    }
  }
  // Patch JSON in place: live scenes keep references to nested player properties.
  function patchSave(target, source) {
    Object.keys(target).forEach(function (key) { if (!Object.hasOwn(source, key)) delete target[key]; });
    Object.keys(source).forEach(function (key) {
      var value = source[key], old = Object.hasOwn(target, key) ? target[key] : undefined;
      if (value && old && typeof value === 'object' && typeof old === 'object' && Array.isArray(value) === Array.isArray(old)) {
        patchSave(old, value);
      } else {
        Object.defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
      }
    });
    if (Array.isArray(target)) target.length = source.length;
    return target;
  }
  var liveModules;
  async function liveGame() {
    if (cloudBooting || !window.cc || !window.cc.director.getScene() || !window.System) return null;
    if (!liveModules) liveModules = Promise.all([
      'PlayerProperties', 'SettingWindow', 'SoundsController', 'UI', 'Square',
      'PauseScreen', 'KeyListener', 'MultiLanguage', 'SoundRescourses', 'levelController',
      'CoinCount', 'GemCount', 'TicketCount', 'SproutCount', 'PlayerSelector'
    ].map(function (name) { return System.import('chunks:///_virtual/' + name + '.ts'); })).catch(function (error) {
      liveModules = null; throw error;
    });
    return liveModules;
  }
  function applyLiveSave(modules, data) {
    if (!modules) return;
    var players = modules[0].AllPlayerProperties;
    if (!players.allPlayers.length) return; // Initial scene will load storage normally.
    var settings = data.PvZ2_Settings ? JSON.parse(data.PvZ2_Settings) : {};
    var incoming = JSON.parse(data.PvZ2_PlayerProperties);
    var index = Number.isInteger(settings.PlayerIndex) && settings.PlayerIndex >= 0 && settings.PlayerIndex < incoming.length ? settings.PlayerIndex : 0;
    if (!incoming.length) incoming.push(Object.assign(new modules[0].PlayerProperties(), { name: 'New Player' }));
    patchSave(players.allPlayers, incoming);
    players.currentPlayer = players.allPlayers[index];
    var Setting = modules[1].Setting, Window = modules[1].SettingWindow;
    // Use the game's defaults for settings absent from older snapshots.
    Setting._currentSetting = null;
    settings = Setting.getSettings();
    Setting._currentSetting = settings;
    var Music = modules[2].MusicController, FX = modules[2].SoundFXController;
    Music.MusicVolume = isNaN(settings.MusicVolume) ? 1 : settings.MusicVolume;
    FX.SoundFXVolume = isNaN(settings.SFXVolume) ? 1 : settings.SFXVolume;
    Music.MusicSpeedRange.Max = isNaN(settings.MusicSpeedMax) ? 1 : settings.MusicSpeedMax;
    Music.MusicSpeedRange.Min = isNaN(settings.MusicSpeedMin) ? 1 : settings.MusicSpeedMin;
    modules[3].UIInGame.CardsLayer = +settings.CardsLayer || 0;
    modules[3].UIInGame.PocketUI = !!settings.PocketUI;
    modules[4].Square.lncSelectionMode = +settings.LnCSelectionMode || 0;
    modules[5].PauseScreen.AutoPause = settings.AutoPause;
    modules[6].KeyListener.KeyBinds = settings.KeyBinds;
    modules[7].MultiLanguage.camelGamingTime = +settings.CamelPlayedTime || 0;
    modules[7].MultiLanguage.currentLanguage = modules[7].MultiLanguage.isWhiteList ? (+settings.Language || 0) : 0;
    modules[8].sounds.loadmode = isNaN(settings.AudioLoadMode) ? cc.AudioClip.AudioType.WEB_AUDIO : settings.AudioLoadMode;
    modules[9].LevelPlay.ZombieWarnOn = !!settings.ZombieAlert;
    Window.allowCheat = settings.AllowCheats;
    Window.classicCardBG = !!settings.ClassicCardBG;
    Window.plantKeyTips = settings.PlantKeyTips !== false;
    Window.showKeyTips = settings.ShowKeyTips !== false;
    Window.showFPS = !!settings.ShowFPS;
    var frameRate = +settings.AnimationFrameRate || 0;
    if (Window.animationFrameRate !== frameRate) {
      Window.animationFrameRate = frameRate;
      cc.game.frameRate = Window.frameRate;
    }
    var cursor = +settings.cursor || 0;
    if (Window.cursor !== cursor) { Window.cursor = cursor; modules[6].KeyListener.loadCursor(cursor, false); }
    // Currency widgets cache balances and use them again when earning/spending.
    // Set both caches without their save-triggering value setter.
    var scene = cc.director.getScene();
    ['coin', 'gem', 'ticket', 'sprout'].forEach(function (key, i) {
      var name = ['CoinCount', 'GemCount', 'TicketCount', 'SproutCount'][i];
      scene.getComponentsInChildren(modules[10 + i][name]).forEach(function (counter) {
        counter._value = +players.currentPlayer[key] || 0;
        counter.shownValue = counter._value;
      });
    });
    scene.getComponentsInChildren(modules[14].PlayerSelector).forEach(function (selector) {
      if (selector.PlayerLabels.length) selector.restartPlayerLabels();
    });
  }
  async function applyCloud(blob, code, localText) {
    validateCloud(blob);
    if (cloudMeta().code !== code || JSON.stringify(saveData()) !== localText) return false;
    if (JSON.stringify(blob.data) !== localText) {
      var modules = await liveGame();
      await putEntry({ key: 'web-cloud-previous.json', type: 'file',
        data: bytesOf(JSON.stringify({ savedAt: Date.now(), data: JSON.parse(localText) })), mtime: Date.now() });
      // Recheck after IndexedDB yields, before replacing any local data.
      if (cloudMeta().code !== code || JSON.stringify(saveData()) !== localText) return false;
      saveFrozen = true;
      try {
        SAVE_KEYS.forEach(function (key) {
          if (blob.data[key] === undefined) rawRemove.call(localStorage, key);
          else rawSet.call(localStorage, key, blob.data[key]);
        });
        applyLiveSave(modules, blob.data);
      } catch (error) {
        // Quota failures must not leave a half-restored snapshot.
        SAVE_KEYS.forEach(function (key) { rawRemove.call(localStorage, key); });
        var previous = JSON.parse(localText);
        SAVE_KEYS.forEach(function (key) { if (previous[key] !== undefined) rawSet.call(localStorage, key, previous[key]); });
        if (previous.PvZ2_PlayerProperties) applyLiveSave(modules, previous);
        throw error;
      } finally { saveFrozen = false; }
      var meta = cloudMeta();
      meta.revision = Date.now() + '-' + Math.random();
      meta.notice = cloudNotice;
      meta.updatedAt = blob.updatedAt;
      meta.syncedAt = blob.updatedAt;
      meta.needsJoin = false;
      meta.lastSync = Date.now();
      saveMeta(meta);
    }
    var current = cloudMeta();
    current.updatedAt = blob.updatedAt;
    current.syncedAt = blob.updatedAt;
    current.needsJoin = false;
    current.lastSync = Date.now();
    current.notice = cloudNotice || current.notice;
    saveMeta(current);
    return true;
  }
  async function performCloudSync() {
    var meta = cloudMeta(), code = meta.code;
    if (!/^[0-9]{6}$/.test(code || '')) { cloudMessage = ''; paintCloud(); return; }
    cloudMessage = '同步中'; paintCloud();
    try {
      var remote = await cloudFetch(code, 'GET');
      if (cloudMeta().code !== code) return;
      // Use the latest snapshot after GET; gameplay may save while the network yields.
      meta = cloudMeta();
      var local = saveData(), localText = JSON.stringify(local);
      if (remote) validateCloud(remote);
      var remoteText = remote && JSON.stringify(remote.data);
      if (remote && (meta.needsJoin || remote.updatedAt > (meta.updatedAt || 0) ||
          (remote.updatedAt === meta.updatedAt && remoteText !== localText))) {
        cloudNotice = meta.needsJoin ? '首次接入：已下载云端进度，本地原进度已备份。' : '检测到另一设备的更新，采用云端较新的整份存档；本地原进度已备份。';
        if (!await applyCloud(remote, code, localText)) { cloudMessage = ''; paintCloud(); return; }
      } else if (remote && remoteText === localText) {
        meta.needsJoin = false;
        meta.updatedAt = Math.max(meta.updatedAt || 0, remote.updatedAt);
        meta.syncedAt = meta.updatedAt;
        meta.lastSync = Date.now();
        saveMeta(meta);
      } else if (local.PvZ2_PlayerProperties !== undefined) {
        var updatedAt = meta.updatedAt || Date.now();
        var body = JSON.stringify({ version: 1, updatedAt: updatedAt, data: local });
        var result = await cloudFetch(code, 'PUT', body);
        var current = cloudMeta();
        if (current.code !== code) return;
        var changed = JSON.stringify(saveData()) !== localText || current.updatedAt !== meta.updatedAt;
        if (result.conflict) {
          if (changed) { cloudMessage = ''; paintCloud(); return; }
          cloudNotice = '上传发生冲突，已采用云端较新的存档；本地原进度已备份。';
          if (!await applyCloud(result.conflict, code, localText)) { cloudMessage = ''; paintCloud(); return; }
        } else {
          if (remote) cloudNotice = '检测到存档差异，已上传本地较新的整份存档。';
          current.updatedAt = Math.max(current.updatedAt || 0, updatedAt);
          current.syncedAt = Math.max(current.syncedAt || 0, updatedAt);
          current.needsJoin = false;
          current.lastSync = Date.now();
          current.notice = cloudNotice || current.notice;
          saveMeta(current);
        }
      } else {
        cloudMessage = '已连接，进入游戏后自动同步'; paintCloud(); return;
      }
      cloudMessage = '';
    } catch (error) {
      cloudMessage = '同步失败，保留本地进度，联网后重试（' + (error.message || '网络错误') + '）';
    }
    paintCloud();
  }
  function syncCloud() {
    if (saveFrozen) return Promise.resolve();
    if (cloudBusy) { cloudRequested = true; return cloudBusy; }
    cloudRequested = false;
    cloudBusy = performCloudSync().finally(function () {
      cloudBusy = null;
      if (cloudRequested) { cloudRequested = false; return syncCloud(); }
    });
    return cloudBusy;
  }
  async function joinCloud(code) {
    if (!/^[0-9]{6}$/.test(code)) throw new Error('请输入纯数字的 6 位码');
    if (cloudBusy) await cloudBusy;
    var meta = cloudMeta();
    if (meta.code !== code) {
      meta.code = code;
      meta.needsJoin = true;
      delete meta.lastSync;
      delete meta.syncedAt;
      delete meta.notice;
      cloudNotice = '';
      saveMeta(meta);
    }
    return syncCloud();
  }
  var cloudReady = syncCloud();
  window.gpWebCloud = { sync: syncCloud, join: joinCloud, open: openCloud, close: closeCloud };
  window.addEventListener('online', syncCloud);
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveCheckpoint(); else syncCloud(); });
  window.addEventListener('pagehide', saveCheckpoint);
  window.addEventListener('storage', async function (event) {
    if (event.key === CLOUD_META) {
      var before = {}, after = cloudMeta();
      try { before = JSON.parse(event.oldValue) || {}; } catch (_) {}
      // A sibling tab or cloud panel can acknowledge this page's pending save.
      if (before.lastSync !== after.lastSync || before.code !== after.code) cloudMessage = '';
      if (before.updatedAt !== after.updatedAt || before.revision !== after.revision) {
        try { applyLiveSave(await liveGame(), saveData()); }
        catch (error) { cloudMessage = '读取云存档失败（' + error.message + '）'; }
      }
      if (before.code !== after.code) syncCloud();
      paintCloud();
    }
  });

  var checkpointModules = null, checkpointQueued = false;
  function saveCheckpoint() {
    if (saveFrozen) return;
    try {
      if (checkpointModules && checkpointModules[0].AllPlayerProperties.allPlayers.length) {
        checkpointModules[0].AllPlayerProperties.savePP();
        checkpointModules[1].Setting.saveSettings();
      }
    } catch (error) {
      cloudMessage = '本地保存失败（' + error.message + '）'; paintCloud(); return;
    }
    // Start after the entire purchase/reward transaction, without waiting on the network.
    if (!checkpointQueued) {
      checkpointQueued = true;
      queueMicrotask(function () { checkpointQueued = false; syncCloud(); });
    }
  }
  function setupSaveCheckpoints() {
    System.import('cc').then(function (engine) {
      async function install() {
        try {
          checkpointModules = await Promise.all([
            'PlayerProperties', 'SettingWindow', 'levelController', 'zenGardenScene',
            'StoreCommodity', 'StoreCostumeSeller', 'ZenGardenSlotPriceTag', 'UI'
          ].map(function (name) { return System.import('chunks:///_virtual/' + name + '.ts'); }));
          function afterChange(target, method) {
            var original = target[method];
            target[method] = function () {
              var before = localStorage.getItem('PvZ2_PlayerProperties');
              var result = original.apply(this, arguments);
              if (before !== localStorage.getItem('PvZ2_PlayerProperties')) saveCheckpoint();
              return result;
            };
          }
          afterChange(checkpointModules[2].levelController.prototype, 'victory');
          afterChange(checkpointModules[4].StoreCommodity.prototype, 'buy');
          afterChange(checkpointModules[5].StoreCostumeSeller.prototype, 'buy');
          afterChange(checkpointModules[6].ZenGardenSlotPriceTag.prototype, 'unlock');
          function beforeExit(target, method) {
            var original = target[method];
            target[method] = function () { saveCheckpoint(); return original.apply(this, arguments); };
          }
          beforeExit(checkpointModules[3].zenGardenScene.prototype, 'exitToMap');
          beforeExit(checkpointModules[7].UIInGame.prototype, 'victoryExit');
          beforeExit(checkpointModules[7].UIInGame, 'exit');
        } catch (error) {
          cloudMessage = '自动保存节点初始化失败（' + error.message + '）'; paintCloud();
        }
      }
      if (engine.director.getScene()) install();
      else engine.director.once(engine.Director.EVENT_AFTER_SCENE_LAUNCH, install);
    }).catch(function (error) { console.error('save checkpoint setup:', error); });
  }

  /* ---------- mobile input and browser UI ---------- */
  function closeCloud() {
    var dialog = document.getElementById('web-cloud-dialog');
    if (dialog) dialog.close();
  }
  function openCloud() {
    if (!document.getElementById('GameCanvas')) { location.href = '/cloud.html'; return; }
    var dialog = document.getElementById('web-cloud-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'web-cloud-dialog';
      var close = document.createElement('button'); close.textContent = '返回游戏'; close.onclick = closeCloud;
      var frame = document.createElement('iframe'); frame.src = '/cloud.html'; frame.title = '云存档';
      dialog.append(close, frame); document.body.appendChild(dialog);
    }
    if (!dialog.open) dialog.showModal();
  }
  function requestGameFullscreen() {
    var target = document.documentElement;
    var request = target.requestFullscreen || target.webkitRequestFullscreen || target.webkitRequestFullScreen;
    if (!request) return Promise.resolve(false);
    try {
      // Must run synchronously inside the button's user gesture.
      return Promise.resolve(request.call(target)).then(function () {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
        return true;
      }).catch(function () { return false; });
    } catch (_) { return Promise.resolve(false); }
  }
  function setupWebHost() {
    var style = document.createElement('style');
    style.textContent = '\n' +
      '#web-host-bar{position:fixed;top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));z-index:99999;display:flex;gap:6px;font:13px system-ui}' +
      '#web-host-bar button{font:inherit;padding:8px;border:1px solid #758575;border-radius:8px;background:#19291ee6;color:#fff;max-width:45vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#web-cloud-dialog{padding:12px;border:1px solid #758575;border-radius:8px;background:#152219;width:min(680px,90vw);height:85dvh;max-height:90dvh;z-index:100000}#web-cloud-dialog::backdrop{background:#0008}#web-cloud-dialog>button{font:16px system-ui;padding:8px;color:#fff;background:#19291e;border:1px solid #758575;border-radius:6px}#web-cloud-dialog iframe{display:block;width:100%;height:calc(100% - 48px);border:0;margin-top:8px}' +
      '#web-rotate-hint{display:none;position:fixed;bottom:max(8px,env(safe-area-inset-bottom));left:0;right:0;z-index:99998;pointer-events:none;color:#fff;font:13px system-ui;text-align:center}' +
      '@media(pointer:coarse) and (orientation:portrait){#web-rotate-hint{display:block}}' +
      'html:has(#web-cloud-page){background:#152219;color:#ecf4ed;font:16px/1.6 system-ui}#web-cloud-page{box-sizing:border-box;max-width:650px;margin:0 auto;padding:24px max(20px,env(safe-area-inset-right)) 24px max(20px,env(safe-area-inset-left));text-align:left}' +
      '#web-cloud-page input,#web-cloud-page button{font:inherit;padding:10px;margin:5px 0;border-radius:6px}#web-cloud-code{width:8em;letter-spacing:.25em}#web-cloud-page button{cursor:pointer}#web-cloud-page a{color:#aee2b6}#web-cloud-status{color:#c8efad}#web-cloud-notice{color:#ffe1a6}';
    document.head.appendChild(style);
    var cloudPage = document.getElementById('web-cloud-page');
    if (cloudPage) {
      if (window.parent !== window) cloudPage.querySelector('a[href="/"]').onclick = function (event) {
        event.preventDefault(); window.parent.gpWebCloud.close();
      };
      document.getElementById('web-cloud-code').value = cloudMeta().code || '';
      document.getElementById('web-cloud-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var button = event.submitter || this.querySelector('button');
        button.disabled = true;
        try { await joinCloud(document.getElementById('web-cloud-code').value); }
        catch (error) { cloudMessage = error.message; }
        finally { button.disabled = false; paintCloud(); }
      });
      document.getElementById('web-cloud-sync').onclick = syncCloud;
      document.getElementById('web-cloud-disconnect').onclick = async function () {
        if (cloudBusy) await cloudBusy;
        var meta = cloudMeta();
        delete meta.code; delete meta.lastSync; delete meta.syncedAt; delete meta.needsJoin; delete meta.notice;
        saveMeta(meta); cloudMessage = ''; cloudNotice = ''; paintCloud();
      };
      document.getElementById('web-cloud-backup').onclick = async function () {
        var previous = await getEntry('web-cloud-previous.json');
        if (previous) triggerDownload('web-cloud-previous.json', bytesOf(previous.data));
        else { cloudNotice = '尚无被替换的本地存档。'; paintCloud(); }
      };
      paintCloud();
      return;
    }
    var canvas = document.getElementById('GameCanvas');
    if (!canvas) return;
    setupSaveCheckpoints();
    var viewport = document.querySelector('meta[name=viewport]');
    if (viewport && viewport.content.indexOf('viewport-fit') < 0) viewport.content += ',viewport-fit=cover';
    canvas.style.touchAction = 'none';
    document.documentElement.style.overscrollBehavior = 'none';
    if (navigator.maxTouchPoints > 0 && window.System) {
      document.body.style.backgroundColor = '#000';
      System.import('cc').then(function (cc) {
        function fitMobileCanvas() {
          var policy = cc.ResolutionPolicy;
          cc.view.setResolutionPolicy(new policy(policy.ContainerStrategy.PROPORTION_TO_FRAME, policy.ContentStrategy.SHOW_ALL));
        }
        // Use Cocos' own proportional container so its render size and touch coordinates agree.
        if (cc.game.inited) fitMobileCanvas();
        else cc.game.onPostSubsystemInitDelegate.add(fitMobileCanvas);
      }).catch(function (error) { console.warn('[shim] mobile canvas fit failed', error); });
    }
    var primaryTouch = null, mouseQueue = Promise.resolve();
    function queuedMouse(action, nextFrame) {
      mouseQueue = mouseQueue.then(function () {
        action();
        if (nextFrame) return new Promise(function (resolve) { requestAnimationFrame(resolve); });
      });
    }
    function mouse(type, touch, down) {
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window,
        clientX: touch.clientX, clientY: touch.clientY, screenX: touch.screenX, screenY: touch.screenY,
        button: 0, buttons: down ? 1 : 0 }));
    }
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(function (type) {
      canvas.addEventListener(type, function (event) {
        // Keep Cocos touch events for Buttons/ScrollViews; add the missing desktop mouse stream.
        event.preventDefault();
        if (type === 'touchstart' && primaryTouch === null) {
          var first = event.changedTouches[0];
          primaryTouch = first.identifier;
          // The game computes hovered lawn cells during update, before handling the next click.
          queuedMouse(function () { mouse('mousemove', first, false); }, true);
          queuedMouse(function () { mouse('mousedown', first, true); });
        } else {
          for (var i = 0; i < event.changedTouches.length; i++) {
            var touch = event.changedTouches[i];
            if (touch.identifier !== primaryTouch) continue;
            (function (point) {
              var ending = type === 'touchend' || type === 'touchcancel';
              queuedMouse(function () { mouse('mousemove', point, true); }, ending);
              if (ending) queuedMouse(function () { mouse('mouseup', point, false); });
            })(touch);
            if (type === 'touchend' || type === 'touchcancel') primaryTouch = null;
          }
        }
      }, { capture: true, passive: false });
    });
    ['mousedown', 'mousemove', 'mouseup'].forEach(function (type) {
      canvas.addEventListener(type, function (event) {
        if (event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) {
          event.stopImmediatePropagation(); event.preventDefault();
        }
      }, true);
    });
    var bar = document.createElement('div'); bar.id = 'web-host-bar';
    var cloud = document.createElement('button'); cloud.id = 'web-cloud-open';
    cloud.onclick = openCloud;
    bar.appendChild(cloud);
    var root = document.documentElement;
    if (navigator.maxTouchPoints > 0 && (root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen)) {
      var fullscreen = document.createElement('button'); fullscreen.textContent = '全屏游玩';
      fullscreen.id = 'web-fullscreen';
      fullscreen.onclick = async function () {
        if (!await requestGameFullscreen()) fullscreen.textContent = '全屏未获允许，可继续游玩';
      };
      function updateFullscreen() { fullscreen.hidden = !!(document.fullscreenElement || document.webkitFullscreenElement); }
      document.addEventListener('fullscreenchange', updateFullscreen);
      document.addEventListener('webkitfullscreenchange', updateFullscreen);
      bar.appendChild(fullscreen);
    }
    document.body.appendChild(bar);
    var hint = document.createElement('p'); hint.id = 'web-rotate-hint';
    hint.textContent = '建议将手机横过来游玩'; document.body.appendChild(hint);
    paintCloud();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupWebHost);
  else setupWebHost();

  /* ---------- command router ---------- */
  function unsupported(cmd) { var e = new Error('unsupported on web: ' + cmd); e.code = 'UNSUPPORTED'; return e; }

  async function invoke(cmd, args, options) {
    cmd = String(cmd || '');
    args = args == null ? {} : args;
    options = options || {};

    if (cmd.indexOf('plugin:fs|') === 0) {
      var sub = cmd.slice('plugin:fs|'.length);
      var path = pathOf(args);
      console.log('[shim]', sub, JSON.stringify(path));
      switch (sub) {
        case 'mkdir': await ensureDir(norm(path)); return null;
        case 'exists': if (!norm(path)) return true; return !!(await getEntry(norm(path)));
        case 'read_dir': {
          var base = norm(path);
          var prefix = base ? base + '/' : '';
          var keys = await allKeys();
          var seen = Object.create(null), out = [];
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (prefix && k.indexOf(prefix) !== 0) continue;
            var rest = k.slice(prefix.length);
            if (!rest || rest.indexOf('/') >= 0) continue;
            if (seen[rest]) continue;
            seen[rest] = true;
            var e = await getEntry(k);
            var isDir = e && e.type === 'dir';
            out.push({ name: rest, isFile: !isDir, isDirectory: isDir, isSymlink: false, is_file: !isDir, is_dir: isDir, is_symlink: false });
          }
          return out;
        }
        case 'stat': case 'lstat': {
          var statKey = norm(path);
          if (!statKey) return { isFile: false, isDirectory: true, isSymlink: false, is_file: false, is_dir: true, is_symlink: false, size: 0, mtime: 0, atime: 0, birthtime: 0, readonly: false };
          var st = await getEntry(statKey);
          if (!st) throw new Error('ENOENT: ' + statKey);
          var isFile = st.type === 'file';
          return { isFile: isFile, isDirectory: !isFile, isSymlink: false, is_file: isFile, is_dir: !isFile, is_symlink: false,
            size: isFile && st.data ? st.data.length : 0, mtime: st.mtime || 0, atime: st.mtime || 0, birthtime: st.mtime || 0, readonly: false };
        }
        case 'remove': {
          var key = norm(path);
          var recursive = !!(optsOf(args).recursive);
          var keys2 = await allKeys();
          var victims = [key].concat(keys2.filter(function (k) { return k.indexOf(key + '/') === 0; }));
          for (var j = 0; j < victims.length; j++) {
            var child = victims[j];
            if (child === key && !recursive && keys2.some(function (k) { return k.indexOf(key + '/') === 0; })) {
              throw new Error('ENOTEMPTY: ' + key);
            }
            await delEntry(child);
          }
          return null;
        }
        case 'rename': {
          var from = norm(args.oldPath || args.from || '');
          var to = norm(args.newPath || args.to || '');
          var moved = await getEntry(from);
          if (!moved) throw new Error('ENOENT: ' + from);
          var keys3 = await allKeys();
          var related = keys3.filter(function (k) { return k === from || k.indexOf(from + '/') === 0; });
          for (var m = 0; m < related.length; m++) {
            var src = related[m];
            var dst = to + src.slice(from.length);
            var ent = await getEntry(src);
            if (!ent) continue;
            await ensureDir(parentOf(dst));
            ent.key = dst;
            await putEntry(ent);
            await delEntry(src);
          }
          return null;
        }
        case 'read_text_file': {
          var b1 = await readVirtual(path);
          console.log('[shim] read_text_file', JSON.stringify(norm(path)), 'len', b1.length);
          return new TextDecoder().decode(b1);
        }
        case 'write_text_file': {
          var hp = headerPath(options);
          var p1 = hp || pathOf(args);
          var data1 = (args && args.data !== undefined) ? args.data : args;
          if (data1 && typeof data1 === 'object' && !ArrayBuffer.isView(data1) && !(data1 instanceof ArrayBuffer) && !Array.isArray(data1)) {
            data1 = data1.data !== undefined ? data1.data : data1.contents;
          }
          console.log('[shim] write_text_file', JSON.stringify(norm(p1)), 'len', bytesOf(data1).length);
          await writeVirtual(p1, data1);
          return null;
        }
        case 'read_file': return Array.from(await readVirtual(path));
        case 'write_file': {
          var p2 = headerPath(options) || pathOf(args);
          var data2 = (args && (args.data !== undefined)) ? args.data : args;
          if (data2 && typeof data2 === 'object' && !ArrayBuffer.isView(data2) && !(data2 instanceof ArrayBuffer) && !Array.isArray(data2)) {
            data2 = data2.data !== undefined ? data2.data : data2.contents;
          }
          await writeVirtual(p2, data2);
          return null;
        }
        case 'copy_file': {
          var srcBuf = await readVirtual(pathOf(args));
          await writeVirtual(args.to || args.destination || '', srcBuf);
          return null;
        }
        case 'open': case 'seek': case 'read': case 'write': case 'ftruncate': case 'fstat':
          throw unsupported(cmd);
        default:
          throw unsupported(cmd);
      }
    }

    if (cmd === 'plugin:path|resolve_directory') return APP_DATA;

    if (cmd === 'plugin:dialog|open') return pickOpen(args);
    if (cmd === 'plugin:dialog|save') return pickSave(args);

    if (cmd === 'plugin:opener|open_url') { window.open(String(args.url || ''), '_blank', 'noopener'); return null; }
    if (cmd === 'plugin:opener|open_path') throw unsupported(cmd);

    if (cmd === 'plugin:event|listen') return args.handler;
    if (cmd === 'plugin:event|unlisten' || cmd === 'plugin:event|unregister') return true;
    if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') return null;

    if (cmd === 'plugin:window|set_fullscreen') {
      if (args.value === false || args.fullscreen === false) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) await exit.call(document);
      } else await requestGameFullscreen();
      return null;
    }
    if (cmd === 'plugin:window|is_fullscreen') return !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (cmd.indexOf('plugin:window|') === 0) {
      if (/is_(maximized|minimized|fullscreen|focused|visible|decorated|resizable|maximizable|minimizable|closable|always_on_top|skip_taskbar)/.test(cmd)) return false;
      return null;
    }
    if (cmd.indexOf('plugin:image|') === 0) return null;
    if (cmd.indexOf('plugin:drpc|') === 0) return false;
    if (cmd.indexOf('plugin:deep-link|') === 0) return cmd === 'plugin:deep-link|get_current' ? [] : false;

    if (cmd === 'cloud_journal_read') { await cloudReady; cloudBooting = false; return null; }
    if (cmd === 'cloud_open') { openCloud(); return null; }
    if (cmd.indexOf('cloud_') === 0) { var ce = new Error('云存档在网页版不可用'); ce.code = 'CLOUD_UNSUPPORTED'; throw ce; }

    if (cmd === 'set_discord_activity' || cmd.indexOf('plugin:discord') === 0) return null;
    if (cmd === 'gp-next:restart' || cmd === 'restart' || cmd === 'host:restart') { window.location.reload(); return null; }
    if (cmd === 'host:returnHome' || cmd === 'quit' || cmd === 'plugin:process|exit') return null;
    if (cmd.indexOf('plugin:') === 0) { console.warn('[shim] passthrough null for', cmd); return null; }

    throw unsupported(cmd);
  }

  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    invoke: function (cmd, args, options) { return Promise.resolve().then(function () { return invoke(cmd, args, options); }); },
    transformCallback: transformCallback,
    runCallback: runCallback,
    callbacks: callbacks,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: function (_e, id) { callbacks.delete(id); } };
})();
