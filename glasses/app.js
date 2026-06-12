(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var state = {
    device: null,
    directPoll: null,
    bridge: null,
    latest: null,
    latestReceivedAt: null,
    transport: null,
    rssi: null,
    chartSamples: [],
    chartFrame: null
  };

  var els = {
    image: document.getElementById('viewport-image'),
    signal: document.getElementById('signal-indicator'),
    note: document.getElementById('connection-note'),
    status: document.getElementById('status-pill'),
    lastUpdate: document.getElementById('last-update'),
    device: document.getElementById('device-label'),
    dose: document.getElementById('dose-rate'),
    counts: document.getElementById('count-rate'),
    error: document.getElementById('dose-error'),
    chart: document.getElementById('dose-chart')
  };

  applyTemplateParams();
  initialize();
  window.setInterval(updateAgeLabel, 1000);
  window.addEventListener('resize', drawDoseChart);
  updateAgeLabel();
  startChartAnimation();

  function applyTemplateParams() {
    var root = document.documentElement;
    var image = params.get('image');
    var fit = params.get('fit');
    var position = params.get('position');
    var scale = params.get('scale');
    var opacity = params.get('opacity');
    var guides = params.get('guides');

    if (els.image && image) els.image.src = image;
    if (fit) root.style.setProperty('--image-fit', fit);
    if (position) root.style.setProperty('--image-position', position);
    if (scale) root.style.setProperty('--image-scale', scale);
    if (opacity) root.style.setProperty('--image-opacity', opacity);
    if (guides === '1' || guides === 'true') document.body.classList.add('show-safe-area');
  }

  function initialize() {
    var bridgeUrl = params.get('bridge');
    var streamId = params.get('stream') || params.get('id');
    var source = params.get('source') || (streamId ? 'relay' : (bridgeUrl || window.location.port === '8787' ? 'bridge' : 'direct'));

    if (source === 'relay' && streamId) {
      connectRelay(streamId);
      return;
    }

    if (source === 'bridge' || bridgeUrl) {
      connectBridge(bridgeUrl || defaultBridgeUrl());
      return;
    }

    setStatus('Bridge Needed', 'warn');
    setNote('Use ?stream=YOUR_ID with the relay feeder.');
  }

  function supportsDirectBluetooth() {
    return Boolean(window.isSecureContext && navigator.bluetooth && window.RadiaCode);
  }

  function defaultBridgeUrl() {
    return window.location.protocol + '//' + window.location.hostname + ':8787/events';
  }

  function relayEventsUrl(streamId) {
    var relayBase = params.get('relay') || '/bridge';
    return relayBase.replace(/\/$/, '') + '/streams/' + encodeURIComponent(streamId) + '/events';
  }

  async function connectDirect() {
    if (!supportsDirectBluetooth()) return;

    setStatus('Pairing', 'warn');
    setNote('Choose the RadiaCode device from the Bluetooth prompt.');

    try {
      state.device = new window.RadiaCode(null, true);
      await state.device.connect();
      var label = 'RadiaCode';

      try {
        label = await state.device.serial_number();
      } catch (_) {
        label = 'RadiaCode BLE';
      }

      setDevice(label);
      setStatus('Live', 'live');
      setNote('Direct BLE connection');
      updateSignalIndicator('ble', null);
      pollDirect();
      state.directPoll = window.setInterval(pollDirect, 1000);
    } catch (error) {
      setStatus('Failed', 'danger');
      setNote(error.message || 'Bluetooth connection failed');
    }
  }

  async function pollDirect() {
    if (!state.device || !state.device.connected()) return;

    try {
      var records = await state.device.data_buf();
      var latest = latestRealtime(records);
      if (latest) {
        updateReading({
          doseRate: latest.dose_rate,
          countRate: latest.count_rate,
          doseRateError: latest.dose_rate_err,
          countRateError: latest.count_rate_err,
          timestamp: latest.dt instanceof Date ? latest.dt.toISOString() : new Date().toISOString()
        });
      }
    } catch (error) {
      setStatus('Read Error', 'warn');
      setNote(error.message || 'Could not read device data');
    }
  }

  function latestRealtime(records) {
    if (!Array.isArray(records)) return null;

    for (var i = records.length - 1; i >= 0; i -= 1) {
      var record = records[i];
      if (isValidReading({
        doseRate: record && record.dose_rate,
        countRate: record && record.count_rate,
        doseRateError: record && record.dose_rate_err
      })) {
        return record;
      }
    }

    return null;
  }

  function connectBridge(url) {
    setStatus('Bridge', 'warn');
    setNote('Listening for bridge data');

    if (/^wss?:\/\//i.test(url)) {
      connectWebSocketBridge(url);
      return;
    }

    connectEventSourceBridge(url);
  }

  function connectRelay(streamId) {
    setDevice(streamId);
    setStatus('Relay', 'warn');
    setNote('Waiting for relay stream');
    connectEventSourceBridge(relayEventsUrl(streamId));
  }

  function connectEventSourceBridge(url) {
    try {
      state.bridge = new EventSource(url);
      state.bridge.onopen = function () {
        setStatus('Live', 'live');
        setNote('Bridge connected');
      };
      state.bridge.onmessage = function (event) {
        handleBridgePayload(JSON.parse(event.data));
      };
      state.bridge.addEventListener('reading', function (event) {
        handleBridgePayload(JSON.parse(event.data));
      });
      state.bridge.addEventListener('hello', function () {
        setStatus('Waiting', 'warn');
      });
      state.bridge.addEventListener('ping', function () {
        if (!state.latest) setStatus('Waiting', 'warn');
      });
      state.bridge.onerror = function () {
        setStatus('Bridge Lost', 'danger');
        setNote('Waiting for ' + url);
      };
    } catch (error) {
      setStatus('Bridge Failed', 'danger');
      setNote(error.message || 'Could not connect to bridge');
    }
  }

  function connectWebSocketBridge(url) {
    try {
      state.bridge = new WebSocket(url);
      state.bridge.onopen = function () {
        setStatus('Live', 'live');
        setNote('WebSocket bridge connected');
      };
      state.bridge.onmessage = function (event) {
        handleBridgePayload(JSON.parse(event.data));
      };
      state.bridge.onclose = function () {
        setStatus('Bridge Lost', 'danger');
        setNote('Waiting for ' + url);
      };
      state.bridge.onerror = function () {
        setStatus('Bridge Error', 'danger');
      };
    } catch (error) {
      setStatus('Bridge Failed', 'danger');
      setNote(error.message || 'Could not connect to bridge');
    }
  }

  function updateReading(data) {
    if (!isValidReading(data)) return;

    state.latest = data;
    state.latestReceivedAt = Date.now();

    if (data.serial || data.device) {
      setDevice(data.serial || data.device);
    }

    if (data.transport) {
      updateSignalIndicator(data.transport, data.rssi);
    }

    setNumber(els.dose, data.doseRate, formatDoseRate);
    setNumber(els.counts, data.countRate, formatCountRate);
    setNumber(els.error, data.doseRateError, formatPercent);
    addDoseSample(Number(data.doseRate));
    updateAlertLevel(Number(data.doseRate));
    updateAgeLabel();
  }

  function handleBridgePayload(data) {
    if (!data) return;

    if (hasReading(data) && !isValidReading(data)) return;

    if (data.status && !hasReading(data)) {
      setStatus(data.status === 'live' ? 'Live' : data.status, data.status === 'error' ? 'danger' : 'warn');
      if (data.message) setNote(data.message);
      return;
    }

    setStatus('Live', 'live');
    setNote(data.streamId ? 'Relay stream ' + data.streamId : 'Bridge connected');
    updateReading(data);
  }

  function hasReading(data) {
    return data.doseRate !== undefined ||
      data.countRate !== undefined;
  }

  function isValidReading(data) {
    if (!data) return false;

    if (data.doseRate === undefined && data.countRate === undefined) return true;

    return Number.isFinite(Number(data.doseRate)) &&
      Number.isFinite(Number(data.countRate)) &&
      Number.isFinite(Number(data.doseRateError)) &&
      Number(data.doseRateError) > 0;
  }

  function setNumber(el, value, formatter) {
    if (!el || value === null || value === undefined || value === '') return;
    var number = Number(value);
    el.textContent = Number.isFinite(number) ? formatter(number) : String(value);
  }

  function updateAgeLabel() {
    if (!els.lastUpdate) return;

    if (!state.latestReceivedAt) {
      els.lastUpdate.textContent = 'No updates';
      return;
    }

    var ageSeconds = Math.max(0, Math.floor((Date.now() - state.latestReceivedAt) / 1000));
    if (ageSeconds < 2) {
      els.lastUpdate.textContent = 'Just now';
    } else if (ageSeconds < 60) {
      els.lastUpdate.textContent = ageSeconds + 's ago';
    } else {
      els.lastUpdate.textContent = Math.floor(ageSeconds / 60) + 'm ago';
    }
  }

  function addDoseSample(value) {
    if (!Number.isFinite(value)) return;

    state.chartSamples.push({
      t: Date.now(),
      value: value
    });

    if (state.chartSamples.length > 90) {
      state.chartSamples.splice(0, state.chartSamples.length - 90);
    }
  }

  function startChartAnimation() {
    if (state.chartFrame) return;

    function tick() {
      drawDoseChart();
      state.chartFrame = window.requestAnimationFrame(tick);
    }

    state.chartFrame = window.requestAnimationFrame(tick);
  }

  function drawDoseChart() {
    var canvas = els.chart;
    if (!canvas) return;

    var rect = canvas.getBoundingClientRect();
    var width = Math.max(1, Math.round(rect.width));
    var height = Math.max(1, Math.round(rect.height));
    var dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    var ctx = canvas.getContext('2d');
    var styles = getComputedStyle(document.documentElement);
    var accent = styles.getPropertyValue('--safe-accent').trim() || '#35f08a';
    var muted = styles.getPropertyValue('--text-muted').trim() || '#9aa6b5';
    var border = styles.getPropertyValue('--panel-border').trim() || 'rgba(255,255,255,0.14)';
    var samples = state.chartSamples;
    var windowMs = Number(params.get('chartWindow') || 30000);
    var now = Date.now();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (var g = 1; g < 4; g += 1) {
      var y = Math.round((height / 4) * g) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (!samples.length) {
      ctx.fillStyle = muted;
      ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText('Waiting for dose data', 8, 24);
      return;
    }

    var visibleSamples = [];
    for (var v = 0; v < samples.length; v += 1) {
      if (samples[v].t >= now - windowMs) {
        visibleSamples.push(samples[v]);
      }
    }

    if (!visibleSamples.length) {
      visibleSamples = samples.slice(-1);
    }

    var max = 0;
    for (var i = 0; i < samples.length; i += 1) {
      max = Math.max(max, samples[i].value);
    }

    max = Math.max(0.1, max * 1.18);
    var padX = 4;
    var padY = 8;
    var plotWidth = width - padX * 2;
    var plotHeight = height - padY * 2;

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (var s = 0; s < visibleSamples.length; s += 1) {
      var age = now - visibleSamples[s].t;
      var x = padX + plotWidth - (age / windowMs * plotWidth);
      var sampleY = padY + plotHeight - (visibleSamples[s].value / max * plotHeight);

      if (s === 0) ctx.moveTo(x, sampleY);
      else ctx.lineTo(x, sampleY);
    }

    ctx.stroke();

    var latest = samples[samples.length - 1];
    var latestAge = now - latest.t;
    var latestX = padX + plotWidth - (latestAge / windowMs * plotWidth);
    var latestY = padY + plotHeight - (latest.value / max * plotHeight);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(latestX, latestY, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(53, 240, 138, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width - padX + 0.5, padY);
    ctx.lineTo(width - padX + 0.5, height - padY);
    ctx.stroke();

    ctx.fillStyle = muted;
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('0', 6, height - 8);
    ctx.fillText(max.toFixed(max >= 10 ? 0 : 2), 6, 14);
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

  function updateAlertLevel(doseRate) {
    document.body.classList.remove('alert-warn', 'alert-danger');
    if (!Number.isFinite(doseRate)) return;
    if (doseRate >= 10) document.body.classList.add('alert-danger');
    else if (doseRate >= 0.5) document.body.classList.add('alert-warn');
  }

  function updateSignalIndicator(transport, rssi) {
    if (!els.signal) return;

    if (transport) state.transport = transport;
    if (rssi !== null && rssi !== undefined) state.rssi = rssi;

    var t = state.transport;
    var el = els.signal;

    if (t === 'usb') {
      el.className = 'signal-indicator';
      el.innerHTML = '<span class="signal-usb-badge">USB</span>';
      return;
    }

    if (t === 'ble') {
      var level = rssiToLevel(state.rssi);
      el.className = 'signal-indicator signal-ble signal-level-' + level;
      el.innerHTML =
        '<div class="signal-bars" aria-hidden="true">' +
          '<span class="signal-bar bar-1"></span>' +
          '<span class="signal-bar bar-2"></span>' +
          '<span class="signal-bar bar-3"></span>' +
          '<span class="signal-bar bar-4"></span>' +
        '</div>' +
        '<span class="signal-label">BT</span>';
      el.setAttribute('aria-label', 'Bluetooth signal level ' + level + ' of 4' +
        (state.rssi !== null ? ' (' + state.rssi + ' dBm)' : ''));
      return;
    }

    el.className = 'signal-indicator';
    el.innerHTML = '';
  }

  function rssiToLevel(rssi) {
    if (rssi === null || rssi === undefined) return 4;
    var n = Number(rssi);
    if (!Number.isFinite(n)) return 4;
    if (n >= -60) return 4;
    if (n >= -70) return 3;
    if (n >= -80) return 2;
    return 1;
  }

  function setStatus(text, level) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.className = 'status-pill status-' + level;
  }

  function setNote(text) {
    if (els.note) els.note.textContent = text;
  }

  function setDevice(text) {
    if (els.device) els.device.textContent = text;
  }
}());
