const MAGIC = 0x43464731;
const HEADER_SIZE = 8;
const RESERVED_SIZE = 4;

let port = null;
let reader = null;
let readBuffer = "";
let lastMeta = { magic: MAGIC, version: 0, size: 0 };

const statusEl = document.getElementById("status");
const btnConnect = document.getElementById("btn-connect");
const btnRead = document.getElementById("btn-read");
const btnWrite = document.getElementById("btn-write");
const btnDefaults = document.getElementById("btn-defaults");

const fields = [
  "min_threshold0","min_threshold1","min_threshold2","min_threshold3",
  "zero_threshold",
  "key_hold_ms_keyboard","key_hold_ms_switch",
  "hit_mode"
];

let lastConfig = null;

const inputs = Object.fromEntries(
  fields.map((id) => [id, document.getElementById(id)])
);

const thresholdFields = [
  "min_threshold0",
  "min_threshold1",
  "min_threshold2",
  "min_threshold3"
];

const DEFAULT_MIN_THRESHOLD = 10;
const DEFAULT_CONFIG_VALUES = {
  min_threshold0: DEFAULT_MIN_THRESHOLD,
  min_threshold1: DEFAULT_MIN_THRESHOLD,
  min_threshold2: DEFAULT_MIN_THRESHOLD,
  min_threshold3: DEFAULT_MIN_THRESHOLD,
  zero_threshold: 0,
  key_hold_ms_keyboard: 8,
  key_hold_ms_switch: 24,
  hit_mode: 0
};

function clampThreshold(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_MIN_THRESHOLD;
  return Math.min(25, Math.max(0, parsed));
}

function updateRangeOutput(input) {
  const outputId = input.dataset.valueOutput;
  if (!outputId) return;
  const output = document.getElementById(outputId);
  if (output) output.value = input.value;
}

function setThresholdInput(id, value) {
  const input = inputs[id];
  if (!input) return;
  input.value = String(clampThreshold(value));
  updateRangeOutput(input);
}

function initThresholdControls() {
  for (const id of thresholdFields) {
    setThresholdInput(id, inputs[id]?.value || DEFAULT_MIN_THRESHOLD);
    inputs[id]?.addEventListener("input", () => updateRangeOutput(inputs[id]));
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function enableButtons(connected) {
  btnRead.disabled = !connected;
  btnWrite.disabled = !connected;
  btnDefaults.disabled = !connected;
}

function restoreDefaults() {
  for (const id of thresholdFields) {
    setThresholdInput(id, DEFAULT_CONFIG_VALUES[id]);
  }

  for (const id of ["zero_threshold", "key_hold_ms_keyboard", "key_hold_ms_switch", "hit_mode"]) {
    const input = inputs[id];
    if (input) input.value = String(DEFAULT_CONFIG_VALUES[id]);
  }

  setStatus("已恢复默认，写入后生效");
}

async function connect() {
  try {
    port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0xCAFE, usbProductId: 0x4011 }]
    });
    await port.open({ baudRate: 115200 });

    reader = port.readable.getReader();
    readBuffer = "";
    startReadLoop();

    setStatus("Connected (Serial)");
    enableButtons(true);
  } catch (e) {
    console.error(e);
    setStatus(`Connect failed: ${e}`);
  }
}

async function startReadLoop() {
  const decoder = new TextDecoder();
  while (port && reader) {
    try {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        readBuffer += decoder.decode(value, { stream: true });
      }
    } catch (e) {
      console.error(e);
      break;
    }
  }
}

async function sendLine(line) {
  const encoder = new TextEncoder();
  const writer = port.writable.getWriter();
  await writer.write(encoder.encode(line + "\n"));
  writer.releaseLock();
}

function nextLineFromBuffer() {
  const idx = readBuffer.indexOf("\n");
  if (idx === -1) return null;
  const line = readBuffer.slice(0, idx).replace(/\r$/, "");
  readBuffer = readBuffer.slice(idx + 1);
  return line;
}

async function waitForLine(prefix, timeoutMs = 1000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const line = nextLineFromBuffer();
    if (line !== null) {
      if (!prefix || line.startsWith(prefix)) return line;
    } else {
      await new Promise(r => setTimeout(r, 10));
    }
  }
  throw new Error("Timeout waiting for response");
}

function readConfigFromBytes(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const magic = dv.getUint32(offset, true); offset += 4;
  const version = dv.getUint16(offset, true); offset += 2;
  const size = dv.getUint16(offset, true); offset += 2;

  const gain0 = dv.getFloat32(offset, true); offset += 4;
  const gain1 = dv.getFloat32(offset, true); offset += 4;
  const gain2 = dv.getFloat32(offset, true); offset += 4;
  const gain3 = dv.getFloat32(offset, true); offset += 4;
  const min_threshold0 = dv.getInt32(offset, true); offset += 4;
  const min_threshold1 = dv.getInt32(offset, true); offset += 4;
  const min_threshold2 = dv.getInt32(offset, true); offset += 4;
  const min_threshold3 = dv.getInt32(offset, true); offset += 4;
  const zero_threshold = dv.getInt32(offset, true); offset += 4;
  const suppress_window = dv.getInt32(offset, true); offset += 4;
  const key_hold_ms_keyboard = dv.getInt32(offset, true); offset += 4;
  const key_hold_ms_switch = dv.getInt32(offset, true); offset += 4;
  const last_profile = dv.getInt32(offset, true); offset += 4;
  const hit_mode = dv.getInt32(offset, true); offset += 4;

  return {
    magic, version, size,
    gain0, gain1, gain2, gain3,
    min_threshold0, min_threshold1, min_threshold2, min_threshold3,
    zero_threshold, suppress_window,
    key_hold_ms_keyboard, key_hold_ms_switch,
    last_profile, hit_mode
  };
}

function fillForm(cfg) {
  lastConfig = cfg;
  for (const k of fields) {
    const el = inputs[k];
    if (!el) continue;
    if (thresholdFields.includes(k)) {
      setThresholdInput(k, cfg[k]);
    } else {
      el.value = cfg[k];
    }
  }
}

function buildBytesFromForm(meta) {
  if (!lastConfig) {
    throw new Error("No configuration loaded");
  }
  const cfg = lastConfig;
  const totalSize = meta.size + HEADER_SIZE + RESERVED_SIZE;
  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);
  let offset = 0;

  dv.setUint32(offset, meta.magic, true); offset += 4;
  dv.setUint16(offset, meta.version, true); offset += 2;
  dv.setUint16(offset, meta.size, true); offset += 2;

  dv.setFloat32(offset, parseFloat(cfg.gain0), true); offset += 4;
  dv.setFloat32(offset, parseFloat(cfg.gain1), true); offset += 4;
  dv.setFloat32(offset, parseFloat(cfg.gain2), true); offset += 4;
  dv.setFloat32(offset, parseFloat(cfg.gain3), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.min_threshold0.value, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.min_threshold1.value, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.min_threshold2.value, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.min_threshold3.value, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.zero_threshold.value, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(cfg.suppress_window, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.key_hold_ms_keyboard.value, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.key_hold_ms_switch.value, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(cfg.last_profile, 10), true); offset += 4;
  dv.setInt32(offset, parseInt(inputs.hit_mode.value, 10), true); offset += 4;

  return new Uint8Array(buf);
}

function bytesToHex(bytes) {
  const hex = [];
  for (const b of bytes) {
    hex.push(b.toString(16).padStart(2, "0"));
  }
  return hex.join("").toUpperCase();
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error("bad hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function readConfig() {
  try {
    await sendLine("READ");
    const line = await waitForLine("DATA ", 1500);
    const hex = line.slice(5).replace(/[^0-9a-fA-F]/g, "");
    const bytes = hexToBytes(hex);
    if (bytes.length < HEADER_SIZE) throw new Error("short data");

    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = header.getUint16(6, true);
    const expected = size + HEADER_SIZE + RESERVED_SIZE;
    if (bytes.length < expected) throw new Error("short data");

    const cfg = readConfigFromBytes(bytes);
    if (cfg.magic !== MAGIC) {
      setStatus(`Read failed: bad magic 0x${cfg.magic.toString(16)}`);
      return;
    }
    lastMeta = { magic: cfg.magic, version: cfg.version, size: cfg.size };
    fillForm(cfg);
    setStatus(`Read OK (ver ${cfg.version}, size ${cfg.size})`);
  } catch (e) {
    console.error(e);
    setStatus(`Read failed: ${e}`);
  }
}

async function writeConfig() {
  try {
    if (!lastMeta.size) {
      setStatus("Write failed: please Read first");
      return;
    }
    const bytes = buildBytesFromForm(lastMeta);
    const hex = bytesToHex(bytes);
    await sendLine(`WRITE ${hex}`);
    setStatus("写入完成，请重新插拔电控");
  } catch (e) {
    console.error(e);
    setStatus(`Write failed: ${e}`);
  }
}

btnConnect.addEventListener("click", connect);
btnRead.addEventListener("click", readConfig);
btnWrite.addEventListener("click", writeConfig);
btnDefaults.addEventListener("click", restoreDefaults);
initThresholdControls();
