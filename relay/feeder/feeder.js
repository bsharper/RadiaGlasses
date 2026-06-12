(function () {
  'use strict';

  var STORAGE_KEY = 'radiacode_feeder_stream_id';
  var pollMs = 1000;
  var warmupReadings = 5;
  var RECONNECT_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];
  var state = {
    device: null,
    pollTimer: null,
    serial: null,
    transport: null,
    rssi: null,
    skippedReadings: 0,
    sentCount: 0,
    lastMessageAt: null,
    reconnectMode: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    savedDevice: null
  };

  var els = {
    streamId: document.getElementById('stream-id'),
    relayUrl: document.getElementById('relay-url'),
    glassesUrl: document.getElementById('glasses-url'),
    status: document.getElementById('status-pill'),
    lastMessage: document.getElementById('last-message'),
    note: document.getElementById('connection-note'),
    bleButton: document.getElementById('connect-ble-button'),
    usbButton: document.getElementById('connect-usb-button'),
    disconnectButton: document.getElementById('disconnect-button'),
    newIdButton: document.getElementById('new-id-button'),
    copyButton: document.getElementById('copy-button'),
    log: document.getElementById('log'),
    dose: document.getElementById('dose-rate'),
    counts: document.getElementById('count-rate'),
    error: document.getElementById('dose-error'),
    sentCount: document.getElementById('sent-count')
  };

  initialize();

  function initialize() {
    els.streamId.value = getInitialStreamId();
    els.relayUrl.value = getDefaultRelayUrl();
    warmupReadings = getWarmupReadings();
    updateGlassesUrl();
    setStatus('Idle');
    window.setInterval(updateLastMessageLabel, 1000);
    updateLastMessageLabel();

    els.streamId.addEventListener('input', persistAndUpdate);
    els.relayUrl.addEventListener('input', updateGlassesUrl);
    els.newIdButton.addEventListener('click', newStreamId);
    els.copyButton.addEventListener('click', copyGlassesUrl);
    els.bleButton.addEventListener('click', function () { connect('ble'); });
    els.usbButton.addEventListener('click', function () { connect('usb'); });
    els.disconnectButton.addEventListener('click', disconnect);

    if (!window.RadiaCode) {
      setStatus('Missing Library', 'danger');
      setNote('radiacode.js did not load.');
      return;
    }

    log('Feeder ready.');
  }

  function getInitialStreamId() {
    var saved = localStorage.getItem(STORAGE_KEY);
    return saved || generateStreamId();
  }

  function getDefaultRelayUrl() {
    var params = new URLSearchParams(window.location.search);
    return params.get('relay') || (window.location.origin + '/bridge');
  }

  function getWarmupReadings() {
    var params = new URLSearchParams(window.location.search);
    var value = Number(params.get('warmup'));
    if (!Number.isFinite(value)) return warmupReadings;
    return Math.max(0, Math.min(30, Math.floor(value)));
  }

  function generateStreamId() {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    var bytes = new Uint8Array(11);
    crypto.getRandomValues(bytes);

    var id = '';
    for (var i = 0; i < bytes.length; i += 1) {
      id += alphabet[bytes[i] % alphabet.length];
    }

    localStorage.setItem(STORAGE_KEY, id);
    return id;
  }

  function newStreamId() {
    els.streamId.value = generateStreamId();
    updateGlassesUrl();
    log('Generated stream ID ' + els.streamId.value);
  }

  function persistAndUpdate() {
    els.streamId.value = cleanStreamId(els.streamId.value);
    localStorage.setItem(STORAGE_KEY, els.streamId.value);
    updateGlassesUrl();
  }

  function cleanStreamId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  }

  function updateGlassesUrl() {
    var streamId = cleanStreamId(els.streamId.value);
    var url = new URL('/glasses', window.location.origin);
    url.searchParams.set('stream', streamId);
    els.glassesUrl.value = url.toString();
  }

  async function copyGlassesUrl() {
    try {
      await navigator.clipboard.writeText(els.glassesUrl.value);
      log('Copied glasses URL.');
    } catch (_) {
      els.glassesUrl.select();
      log('Select and copy the glasses URL.');
    }
  }

  async function connect(mode) {
    setButtons(false);
    setStatus('Connecting', 'warn');
    setNote(mode === 'ble' ? 'Choose the RadiaCode Bluetooth device.' : 'Choose the RadiaCode USB device.');

    try {
      if (mode === 'ble') {
        state.device = new window.RadiaCode(null, true);
      } else {
        state.device = new window.RadiaCode();
      }

      await state.device.connect();

      try {
        state.serial = await state.device.serial_number();
      } catch (_) {
        state.serial = 'RadiaCode';
      }

      state.transport = mode;
      state.rssi = null;
      // Save the raw WebAPI device reference now, before any cleanup() can null it.
      // Browsers allow reconnecting to a paired device without a user gesture.
      state.savedDevice = (state.device.transport && state.device.transport.device) || null;
      state.reconnectMode = mode;
      state.reconnectAttempts = 0;
      setStatus('Live', 'live');
      state.skippedReadings = 0;
      state.sentCount = 0;
      state.lastMessageAt = null;
      updateLastMessageLabel();
      setNumber(els.sentCount, state.sentCount, formatInteger);
      setNote('Connected to ' + state.serial + '. Warming up readings.');
      log('Connected: ' + state.serial + ' via ' + mode.toUpperCase());
      log('Skipping first ' + warmupReadings + ' valid readings.');

      if (mode === 'ble') {
        watchBleRssi();
      }

      await pollOnce();
      state.pollTimer = window.setInterval(pollOnce, pollMs);
    } catch (error) {
      setStatus('Failed', 'danger');
      setNote(error.message || 'Connection failed.');
      log('Connection failed: ' + (error.message || error));
      setButtons(true);
    }
  }

  async function disconnect() {
    // Cancel any pending auto-reconnect first.
    state.reconnectMode = null;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.savedDevice = null;
    state.reconnectAttempts = 0;

    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }

    try {
      if (state.device) await state.device.disconnect();
    } catch (_) {
      // Ignore disconnect cleanup errors.
    }

    state.device = null;
    state.serial = null;
    state.transport = null;
    state.rssi = null;
    state.lastMessageAt = null;
    setStatus('Idle');
    setNote('Disconnected.');
    updateLastMessageLabel();
    setButtons(true);
  }

  function watchBleRssi() {
    try {
      var btDevice = state.device && state.device.transport && state.device.transport.device;
      if (!btDevice || typeof btDevice.watchAdvertisements !== 'function') return;

      btDevice.watchAdvertisements().then(function () {
        btDevice.addEventListener('advertisementreceived', function (event) {
          if (event.rssi !== undefined && event.rssi !== null) {
            state.rssi = event.rssi;
          }
        });
      }).catch(function () {
        // watchAdvertisements unavailable or denied — RSSI will remain null
      });
    } catch (_) {
      // Ignore — RSSI is best-effort
    }
  }

  async function pollOnce() {
    if (!state.device || !state.device.connected()) {
      if (state.reconnectMode && !state.reconnectTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        log('Device no longer connected.');
        scheduleReconnect();
      }
      return;
    }

    try {
      var records = await state.device.data_buf();
      var realtime = latestRealtime(records);

      if (!realtime) return;

      var payload = {
        serial: state.serial,
        transport: state.transport,
        timestamp: new Date().toISOString()
      };

      if (state.rssi !== null) {
        payload.rssi = state.rssi;
      }

      if (realtime) {
        payload.doseRate = realtime.dose_rate;
        payload.countRate = realtime.count_rate;
        payload.doseRateError = realtime.dose_rate_err;
        payload.countRateError = realtime.count_rate_err;
        payload.timestamp = realtime.dt instanceof Date ? realtime.dt.toISOString() : payload.timestamp;
      }

      updateReadout(payload);

      if (state.skippedReadings < warmupReadings) {
        state.skippedReadings += 1;
        setNote('Warming up readings: ' + state.skippedReadings + '/' + warmupReadings);
        log('Skipped warm-up reading ' + state.skippedReadings + ': ' + formatDoseRate(payload.doseRate) + ' uSv/h');
        return;
      }

      setNote('Connected to ' + state.serial + '. Relaying readings.');
      await postReading(payload);
      recordSentEvent(payload);
    } catch (error) {
      var isDisconnect = error.name === 'ConnectionClosed' || error.name === 'DeviceNotFound' ||
        !state.device || !state.device.connected();
      if (isDisconnect && state.reconnectMode && !state.reconnectTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        log('Connection lost: ' + (error.message || error));
        scheduleReconnect();
      } else {
        setStatus('Read Error', 'warn');
        setNote(error.message || 'Could not read device data.');
        log('Read error: ' + (error.message || error));
      }
    }
  }

  function scheduleReconnect() {
    if (!state.reconnectMode || state.reconnectTimer) return;

    var delay = RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    setStatus('Reconnecting', 'warn');
    setNote('Connection lost. Retrying in ' + (delay / 1000) + 's…');
    log('Reconnect scheduled in ' + (delay / 1000) + 's (attempt ' + (state.reconnectAttempts + 1) + ')');

    state.reconnectTimer = window.setTimeout(function () {
      state.reconnectTimer = null;
      attemptReconnect();
    }, delay);
  }

  async function attemptReconnect() {
    if (!state.reconnectMode || !state.savedDevice) return;

    state.reconnectAttempts += 1;
    setNote('Reconnecting… (attempt ' + state.reconnectAttempts + ')');
    log('Reconnect attempt ' + state.reconnectAttempts + '…');

    try {
      var transport;
      if (state.reconnectMode === 'ble') {
        transport = await window.RadiaCodeBluetoothTransport.reconnect(state.savedDevice);
      } else {
        transport = await window.RadiaCodeUSBTransport.reconnect(state.savedDevice);
      }

      var newDevice = new window.RadiaCodeDevice(transport);
      await newDevice.initialize();
      state.device = newDevice;

      // Keep the saved device reference fresh (same object; transport has new GATT handles)
      state.savedDevice = transport.device;
      state.reconnectAttempts = 0;
      // Skip warmup on reconnect — device has been running continuously
      state.skippedReadings = warmupReadings;

      if (state.reconnectMode === 'ble') {
        state.rssi = null;
        watchBleRssi();
      }

      setStatus('Live', 'live');
      setNote('Reconnected to ' + state.serial + '. Relaying readings.');
      log('Reconnected successfully.');

      await pollOnce();
      state.pollTimer = window.setInterval(pollOnce, pollMs);

    } catch (error) {
      log('Reconnect attempt ' + state.reconnectAttempts + ' failed: ' + (error.message || error));
      scheduleReconnect();
    }
  }

  function latestRealtime(records) {
    if (!Array.isArray(records)) return null;

    for (var i = records.length - 1; i >= 0; i -= 1) {
      var record = records[i];
      if (isValidRealtime(record)) {
        return record;
      }
    }

    return null;
  }

  function isValidRealtime(record) {
    return Boolean(record &&
      Number.isFinite(record.count_rate) &&
      Number.isFinite(record.dose_rate) &&
      Number.isFinite(record.dose_rate_err) &&
      record.dose_rate_err > 0);
  }

  async function postReading(payload) {
    var streamId = cleanStreamId(els.streamId.value);
    var endpoint = els.relayUrl.value.replace(/\/$/, '') + '/streams/' + encodeURIComponent(streamId);
    var response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error('Relay POST failed: HTTP ' + response.status + ' ' + await response.text());
    }
  }

  function updateReadout(payload) {
    setNumber(els.dose, payload.doseRate, formatDoseRate);
    setNumber(els.counts, payload.countRate, formatCountRate);
    setNumber(els.error, payload.doseRateError, formatPercent);
  }

  function recordSentEvent(payload) {
    state.sentCount += 1;
    state.lastMessageAt = Date.now();
    setNumber(els.sentCount, state.sentCount, formatInteger);
    updateLastMessageLabel();
    log('Sent event ' + state.sentCount +
      ': dose=' + formatDoseRate(payload.doseRate) + ' uSv/h' +
      ', counts=' + formatCountRate(payload.countRate) + ' cps' +
      ', err=' + formatPercent(payload.doseRateError) + '%');
  }

  function setNumber(el, value, formatter) {
    if (!el || value === null || value === undefined || value === '') return;
    var number = Number(value);
    el.textContent = Number.isFinite(number) ? formatter(number) : String(value);
  }

  function formatDoseRate(value) {
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function formatCountRate(value) {
    if (value >= 100) return value.toFixed(0);
    return value.toFixed(1);
  }

  function formatPercent(value) {
    return value.toFixed(1);
  }

  function formatInteger(value) {
    return value.toFixed(0);
  }

  function setStatus(text, level) {
    els.status.textContent = text;
    els.status.className = 'status-pill' + (level ? ' status-' + level : '');
  }

  function setNote(text) {
    els.note.textContent = text;
  }

  function setButtons(enabled) {
    els.bleButton.disabled = !enabled;
    els.usbButton.disabled = !enabled;
    els.disconnectButton.disabled = enabled;
  }

  function updateLastMessageLabel() {
    if (!els.lastMessage) return;

    if (!state.lastMessageAt) {
      els.lastMessage.textContent = 'No messages';
      return;
    }

    var ageSeconds = Math.max(0, Math.floor((Date.now() - state.lastMessageAt) / 1000));
    if (ageSeconds < 2) {
      els.lastMessage.textContent = 'Just now';
    } else if (ageSeconds < 60) {
      els.lastMessage.textContent = ageSeconds + 's ago';
    } else {
      els.lastMessage.textContent = Math.floor(ageSeconds / 60) + 'm ago';
    }
  }

  function log(message) {
    var now = new Date().toLocaleTimeString();
    els.log.textContent += '[' + now + '] ' + message + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }
}());
