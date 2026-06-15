let port = null;
let reader = null;
let serialRunning = false;
let pointerEvents = [];
let serialLines = [];
let serialLineBuffer = "";
let lastPointerT = null;
let lastAnalysis = null;

function nowMs() {
  return performance.now();
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseZmkTimeMs(line) {
  const m = line.match(/\[(\d\d):(\d\d):(\d\d)\.(\d{3}),(\d{3})\]/);
  if (!m) return null;
  const h = +m[1], min = +m[2], sec = +m[3], ms = +m[4], us = +m[5];
  return (((h * 60 + min) * 60 + sec) * 1000 + ms + us / 1000);
}

function parseSerialLog(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const events = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const zmkT = parseZmkTimeMs(line);

    for (const m of line.matchAll(/Mouse movement set to\s+(-?\d+)\/(-?\d+)/g)) {
      events.push({
        type: "hid",
        t: zmkT,
        x: +m[1],
        y: +m[2],
        line
      });
    }

    for (const m of line.matchAll(/LPPS_SENSOR\s+t=(\d+)\s+x=\s*(-?\d+)\s+y=\s*(-?\d+)\s+z=\s*(-?\d+)/g)) {
      events.push({
        type: "raw",
        t: zmkT ?? +m[1],
        x: +m[2],
        y: +m[3],
        z: +m[4],
        line
      });
    }

    for (const m of line.matchAll(/scale_val:\s+scaled\s+(-?\d+)\s+with\s+(\d+)\/(\d+)\s+to\s+(-?\d+)\s+with\s+remainder\s+(-?\d+)/g)) {
      events.push({
        type: "scale",
        t: zmkT,
        input: +m[1],
        num: +m[2],
        den: +m[3],
        x: +m[4],
        remainder: +m[5],
        line
      });
    }
  }

  return events.filter(e => e.t != null).sort((a,b) => a.t - b.t);
}

function parsePointerLog(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(\d+(?:\.\d+)?)\s+move\s+(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (m) {
      events.push({ type: "browser", t: +m[1], x: +m[2], y: +m[3], line });
    }
  }
  return events.sort((a,b) => a.t - b.t);
}

function appendSerialText(s) {
  // Web Serial read() returns arbitrary chunks, not complete lines.
  // Buffer partial chunks and append only newline-terminated complete lines.
  serialLineBuffer += s.replace(/\r/g, "");

  const parts = serialLineBuffer.split("\n");
  serialLineBuffer = parts.pop() ?? "";

  if (parts.length === 0) {
    updateSerialPartialStatus();
    return;
  }

  const completeText = parts.join("\n") + "\n";
  const ta = document.getElementById("serialLog");
  ta.value += completeText;
  ta.scrollTop = ta.scrollHeight;
  updateSerialPartialStatus();
}

function flushSerialLineBuffer() {
  if (!serialLineBuffer) return;
  const ta = document.getElementById("serialLog");
  ta.value += serialLineBuffer + "\n";
  serialLineBuffer = "";
  ta.scrollTop = ta.scrollHeight;
  updateSerialPartialStatus();
}

function updateSerialPartialStatus() {
  const status = document.getElementById("serialStatus");
  if (!status) return;
  const partial = serialLineBuffer ? ` / partial ${serialLineBuffer.length} chars` : "";
  if (serialRunning) {
    status.innerHTML = `状態: <strong>接続中</strong>${partial}`;
  }
}

function appendPointerLine(line) {
  const ta = document.getElementById("pointerLog");
  ta.value += line + "\n";
  ta.scrollTop = ta.scrollHeight;
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    alert("このブラウザはWeb Serialに対応していません。Chrome/Edgeで開いてください。");
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    const baudRate = Number(document.getElementById("baudRate").value);
    await port.open({ baudRate });
    serialRunning = true;
    document.getElementById("serialConnectBtn").disabled = true;
    document.getElementById("serialDisconnectBtn").disabled = false;
    document.getElementById("serialStatus").innerHTML = `状態: <strong>接続中 ${baudRate}bps</strong>`;

    const decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable).catch(() => {});
    reader = decoder.readable.getReader();

    while (serialRunning) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) appendSerialText(value);
    }
    flushSerialLineBuffer();
  } catch (err) {
    document.getElementById("serialStatus").innerHTML = `状態: <strong>エラー</strong> ${escapeHtml(String(err.message || err))}`;
  }
}

async function disconnectSerial() {
  serialRunning = false;
  try {
    if (reader) {
      await reader.cancel();
      reader.releaseLock();
      reader = null;
    }
    if (port) {
      await port.close();
      port = null;
    }
  } catch (err) {
    console.warn(err);
  }
  flushSerialLineBuffer();
  document.getElementById("serialConnectBtn").disabled = false;
  document.getElementById("serialDisconnectBtn").disabled = true;
  document.getElementById("serialStatus").innerHTML = "状態: <strong>未接続</strong>";
}

function requestPointerLock() {
  document.getElementById("captureBox").requestPointerLock();
}

function onPointerLockChange() {
  const active = document.pointerLockElement === document.getElementById("captureBox");
  document.getElementById("captureBox").classList.toggle("active", active);
  document.getElementById("pointerStatus").innerHTML = active
    ? "状態: <strong>Pointer Lock中</strong>"
    : "状態: <strong>停止</strong>";
}

function onMouseMove(e) {
  if (document.pointerLockElement !== document.getElementById("captureBox")) return;
  const t = nowMs();
  const x = e.movementX || 0;
  const y = e.movementY || 0;
  if (x === 0 && y === 0) return;
  pointerEvents.push({ type: "browser", t, x, y });
  lastPointerT = t;
  appendPointerLine(`${t.toFixed(3)} move ${x}/${y}`);
}

function stopPointerLock() {
  if (document.pointerLockElement) document.exitPointerLock();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function normalizeTime(serialEvents, pointerEvents) {
  const hid = serialEvents.filter(e => e.type === "hid");
  if (hid.length === 0 || pointerEvents.length === 0) {
    return { hidAligned: hid.map(e => ({...e, at: e.t})), pointerAligned: pointerEvents, offset: 0, note: "時刻合わせ不足" };
  }

  // 通常、ZMKログ時刻はデバイス起動からのms、browserはperformance.now。
  // 単純には最初の非ゼロHIDと最初のbrowser moveを合わせる。
  const firstHidNonZero = hid.find(e => e.x !== 0 || e.y !== 0) || hid[0];
  const firstBrowser = pointerEvents[0];
  const offset = firstBrowser.t - firstHidNonZero.t;

  return {
    hidAligned: hid.map(e => ({...e, at: e.t + offset})),
    pointerAligned: pointerEvents.map(e => ({...e, at: e.t})),
    offset,
    note: `first non-zero HID基準で offset=${offset.toFixed(3)}ms`
  };
}

function alignRawEvents(serialEvents, offset) {
  return serialEvents
    .filter(e => e.type === "raw" && (e.x !== 0 || e.y !== 0))
    .map(e => ({...e, at: e.t + offset}));
}

function classifyRawDrift(rawAligned, pairs, windowMs) {
  const maxDt = Math.min(Math.max(windowMs, 10), 80);
  return rawAligned.map(raw => {
    let nearest = null;
    for (const pair of pairs) {
      const dt = Math.abs(pair.h.at - raw.at);
      if (!nearest || dt < nearest.dt) nearest = { pair, dt };
    }
    const pair = nearest && nearest.dt <= maxDt ? nearest.pair : null;
    return {
      ...raw,
      verdict: pair ? pair.verdict : "missing",
      pairDt: pair ? nearest.dt : null
    };
  });
}

function nearestBrowserSum(pointerEvents, centerT, windowMs) {
  const near = pointerEvents.filter(p => Math.abs(p.at - centerT) <= windowMs);
  return {
    x: near.reduce((s,p) => s + p.x, 0),
    y: near.reduce((s,p) => s + p.y, 0),
    count: near.length,
    minDt: near.length ? Math.min(...near.map(p => Math.abs(p.at - centerT))) : null,
    lines: near.map(p => p.line).slice(0, 3)
  };
}

function analyze() {
  flushSerialLineBuffer();
  const serialEvents = parseSerialLog(document.getElementById("serialLog").value);
  const pointerFromText = parsePointerLog(document.getElementById("pointerLog").value);
  const ptr = pointerFromText.length ? pointerFromText : pointerEvents;
  const windowMs = Number(document.getElementById("matchWindowMs").value);
  const jitter = Number(document.getElementById("jitterThreshold").value);
  const ratio = Number(document.getElementById("expectedRatio").value);

  const { hidAligned, pointerAligned, offset, note } = normalizeTime(serialEvents, ptr);
  const hidNonZero = hidAligned.filter(e => e.x !== 0 || e.y !== 0);
  const pairs = hidNonZero.map(h => {
    const b = nearestBrowserSum(pointerAligned, h.at, windowMs);
    const expectedX = h.x * ratio;
    const expectedY = h.y * ratio;
    const zmkTiny = Math.abs(h.x) <= jitter && Math.abs(h.y) <= jitter;
    const browserZero = b.count === 0 || (Math.abs(b.x) <= 0 && Math.abs(b.y) <= 0);
    const browserSmall = Math.abs(b.x) <= Math.max(1, Math.abs(expectedX) * 0.25) &&
                         Math.abs(b.y) <= Math.max(1, Math.abs(expectedY) * 0.25);
    let verdict = "pass";
    if (zmkTiny && (browserZero || browserSmall)) verdict = "suppressed";
    else if (!browserZero && !browserSmall) verdict = "visible";
    else if (browserZero) verdict = "missing";
    return { h, b, expectedX, expectedY, zmkTiny, verdict };
  });
  const rawDrift = classifyRawDrift(alignRawEvents(serialEvents, offset), pairs, windowMs);

  renderSummary(serialEvents, hidAligned, pointerAligned, rawDrift, pairs, note);
  renderDirectionStats(serialEvents, hidAligned, pairs);
  renderPairs(pairs);
  drawChart(hidAligned, pointerAligned, rawDrift, pairs, windowMs);
  lastAnalysis = buildAnalysisExport(serialEvents, hidAligned, pointerAligned, rawDrift, pairs, jitter, windowMs, offset, note);
}

function renderSummary(serialEvents, hid, pointer, rawDrift, pairs, note) {
  const raw = serialEvents.filter(e => e.type === "raw");
  const scale = serialEvents.filter(e => e.type === "scale");
  const hidNonZero = hid.filter(e => e.x !== 0 || e.y !== 0);
  const suppressed = pairs.filter(p => p.verdict === "suppressed");
  const visible = pairs.filter(p => p.verdict === "visible");
  const missing = pairs.filter(p => p.verdict === "missing");
  const rawSuppressed = rawDrift.filter(e => e.verdict === "suppressed");
  const rawVisible = rawDrift.filter(e => e.verdict === "visible");
  const rawMissing = rawDrift.filter(e => e.verdict === "missing");
  const measured = suppressed.length + visible.length;
  const suppressionRate = measured ? suppressed.length / measured : 0;
  const residualRate = measured ? visible.length / measured : 0;
  const hidAbs = hidNonZero.reduce((sum,e) => sum + Math.abs(e.x) + Math.abs(e.y), 0);
  const visibleAbs = visible.reduce((sum,p) => sum + Math.abs(p.h.x) + Math.abs(p.h.y), 0);
  const visibleAbsRate = hidAbs ? visibleAbs / hidAbs : 0;

  document.getElementById("summary").innerHTML = `
    <div class="card"><div class="label">非ゼロHID候補</div><div class="num ${hidNonZero.length ? "warnText" : "okText"}">${hidNonZero.length}</div></div>
    <div class="card"><div class="label">ドリフト抑制率</div><div class="num ${suppressionRate >= 0.8 ? "okText" : suppressionRate >= 0.5 ? "warnText" : "dangerText"}">${formatPct(suppressionRate)}</div></div>
    <div class="card"><div class="label">可視残留率</div><div class="num ${residualRate <= 0.1 ? "okText" : residualRate <= 0.3 ? "warnText" : "dangerText"}">${formatPct(residualRate)}</div></div>
    <div class="card"><div class="label">推定低減</div><div class="num ${suppressionRate >= 0.8 ? "okText" : suppressionRate >= 0.5 ? "warnText" : "dangerText"}">${formatPct(suppressionRate)}</div></div>
    <div class="card"><div class="label">可視HID量 / 全HID量</div><div class="num ${visibleAbsRate <= 0.1 ? "okText" : visibleAbsRate <= 0.3 ? "warnText" : "dangerText"}">${formatPct(visibleAbsRate)}</div></div>
    <div class="card"><div class="label">抑制 / 可視 / 不明</div><div class="num">${suppressed.length} / ${visible.length} / ${missing.length}</div></div>
    <div class="card"><div class="label">raw抑制 / 可視 / 不明</div><div class="num">${rawSuppressed.length} / ${rawVisible.length} / ${rawMissing.length}</div></div>
    <div class="card"><div class="label">LPPS raw / scale</div><div class="num">${raw.length} / ${scale.length}</div></div>
    <div class="card"><div class="label">Browser move</div><div class="num">${pointer.length}</div></div>
  `;

  let msg = `${note}。`;
  if (hidNonZero.length === 0) {
    msg += " 非ゼロHIDがありません。このログではドリフト抑制効果を判定できません。";
  } else if (measured === 0) {
    msg += " ブラウザ側との対応が取れていません。Pointer Lock有効化、時刻合わせ、対応窓msを見直してください。";
  } else {
    msg += ` 抑制率は ${formatPct(suppressionRate)}、可視残留率は ${formatPct(residualRate)} です。`;
    if (suppressionRate >= 0.8 && residualRate <= 0.2) {
      msg += " antidriftはかなり効いており、Windowsで見えるドリフト候補の大半が落ちている状態です。";
    } else if (suppressionRate >= 0.5) {
      msg += " antidriftは効いていますが、まだ可視化される微小移動が残っています。jitter-thresholdを上げるかactive-msを短くする候補があります。";
    } else {
      msg += " antidriftの効きは弱めです。しきい値、操作中判定時間、または入力側のスケールを見直す価値があります。";
    }
    if (missing.length) {
      msg += ` 対応なしが ${missing.length} 件あるため、必要なら対応窓msを広げて再解析してください。`;
    }
  }
  document.getElementById("diagnosis").textContent = msg;
}


function formatPct(value) {
  if (!Number.isFinite(value)) return "0.0%";
  return (value * 100).toFixed(1) + "%";
}

function signName(x, y) {
  const sx = x > 0 ? "R" : x < 0 ? "L" : "0";
  const sy = y > 0 ? "D" : y < 0 ? "U" : "0";
  if (sx === "0" && sy === "0") return "zero";
  if (sx !== "0" && sy !== "0") return sy + sx;
  return sx !== "0" ? sx : sy;
}

function calcDirectionStats(events) {
  const nz = events.filter(e => (e.x || 0) !== 0 || (e.y || 0) !== 0);
  const total = nz.length;
  const sumX = nz.reduce((s,e) => s + e.x, 0);
  const sumY = nz.reduce((s,e) => s + e.y, 0);
  const absX = nz.reduce((s,e) => s + Math.abs(e.x), 0);
  const absY = nz.reduce((s,e) => s + Math.abs(e.y), 0);
  const counts = {};
  for (const e of nz) {
    const k = signName(e.x, e.y);
    counts[k] = (counts[k] || 0) + 1;
  }
  const dominant = Object.entries(counts).sort((a,b) => b[1] - a[1])[0] || ["none", 0];
  const bias = total ? dominant[1] / total : 0;
  const meanX = total ? sumX / total : 0;
  const meanY = total ? sumY / total : 0;
  const angle = Math.atan2(meanY, meanX) * 180 / Math.PI;
  const magnitude = Math.hypot(meanX, meanY);
  return { total, sumX, sumY, absX, absY, counts, dominant, bias, meanX, meanY, angle, magnitude };
}

function renderDirectionStats(serialEvents, hidAligned, pairs) {
  const raw = serialEvents.filter(e => e.type === "raw");
  const hidNz = hidAligned.filter(e => e.x !== 0 || e.y !== 0);
  const suppressedHid = pairs.filter(p => p.verdict === "suppressed").map(p => p.h);
  const visibleHid = pairs.filter(p => p.verdict === "visible").map(p => p.h);

  const rawStats = calcDirectionStats(raw);
  const hidStats = calcDirectionStats(hidNz);
  const suppressedStats = calcDirectionStats(suppressedHid);
  const visibleStats = calcDirectionStats(visibleHid);

  function pct(v) { return (v * 100).toFixed(1) + "%"; }
  function fmtDir(stats) {
    if (!stats.total) return "none";
    return `${stats.dominant[0]} ${stats.dominant[1]}/${stats.total} (${pct(stats.bias)})`;
  }
  function fmtMean(stats) {
    if (!stats.total) return "0/0";
    return `${stats.meanX.toFixed(2)} / ${stats.meanY.toFixed(2)}`;
  }

  document.getElementById("directionSummary").innerHTML = `
    <div class="card"><div class="label">raw支配方向</div><div class="num">${fmtDir(rawStats)}</div></div>
    <div class="card"><div class="label">HID支配方向</div><div class="num">${fmtDir(hidStats)}</div></div>
    <div class="card"><div class="label">OS抑制HID方向</div><div class="num">${fmtDir(suppressedStats)}</div></div>
    <div class="card"><div class="label">OS可視HID方向</div><div class="num">${fmtDir(visibleStats)}</div></div>
    <div class="card"><div class="label">HID平均ベクトル X/Y</div><div class="num">${fmtMean(hidStats)}</div></div>
    <div class="card"><div class="label">HID角度</div><div class="num">${hidStats.total ? hidStats.angle.toFixed(1) + "°" : "none"}</div></div>
    <div class="card"><div class="label">HID |X|合計 / |Y|合計</div><div class="num">${hidStats.absX} / ${hidStats.absY}</div></div>
  `;

  let msg = "";
  if (!hidStats.total) {
    msg = "非ゼロHIDがないため、方向性は判定できません。";
  } else if (hidStats.bias >= 0.7 && hidStats.total >= 5) {
    msg = `HID出力は ${hidStats.dominant[0]} 方向に強く偏っています。機械的な片寄り、センター値、軸変換、scale/remainderの偏りを疑う価値があります。`;
  } else if (hidStats.bias >= 0.45 && hidStats.total >= 5) {
    msg = `HID出力は ${hidStats.dominant[0]} 方向にやや偏っています。長時間ログで再確認するとよいです。`;
  } else {
    msg = "HID出力の方向は大きく一方向には偏っていません。ランダムジッタ寄りに見えます。";
  }

  if (suppressedStats.total) {
    msg += ` OS抑制候補だけを見ると ${suppressedStats.dominant[0]} が最多です。macOSが特定方向だけでなく、しきい値以下の微小ベクトル全般を落としているか確認できます。`;
  }
  document.getElementById("directionDiagnosis").textContent = msg;
}

function renderPairs(pairs) {
  const tbody = document.getElementById("pairsBody");
  tbody.innerHTML = "";
  for (const p of pairs) {
    const cls = p.verdict === "suppressed" ? "danger" :
                p.verdict === "visible" ? "ok" : "warn";
    const label = p.verdict === "suppressed" ? "OS抑制候補" :
                  p.verdict === "visible" ? "可視" : "対応なし/不明";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.h.at.toFixed(3)}</td>
      <td>${p.h.x}/${p.h.y}</td>
      <td>${p.b.x}/${p.b.y} (${p.b.count}ev)</td>
      <td>${p.b.minDt == null ? "" : p.b.minDt.toFixed(3)}</td>
      <td><span class="pill ${cls}">${label}</span></td>
      <td><code>${escapeHtml(p.h.line)}</code></td>
    `;
    tbody.appendChild(tr);
  }
}

function drawChart(hid, pointer, rawDrift, pairs, windowMs) {
  const canvas = document.getElementById("chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,w,h);

  const all = [...hid, ...pointer, ...rawDrift];
  if (all.length === 0) {
    ctx.fillStyle = "#6b7280";
    ctx.font = "18px system-ui";
    ctx.fillText("データがありません", 24, 48);
    return;
  }

  const t0 = Math.min(...all.map(e => e.at ?? e.t));
  const t1 = Math.max(...all.map(e => e.at ?? e.t));
  const span = Math.max(1, t1 - t0);
  const maxAbs = Math.max(
    1,
    ...hid.flatMap(e => [Math.abs(e.x), Math.abs(e.y)]),
    ...pointer.flatMap(e => [Math.abs(e.x), Math.abs(e.y)]),
    ...rawDrift.flatMap(e => [Math.abs(e.x), Math.abs(e.y)])
  );

  function px(t) { return ((t - t0) / span) * (w - 50) + 25; }
  function py(v) { return h/2 - (v / maxAbs) * (h * 0.38); }

  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();

  for (const p of pairs) {
    if (p.verdict === "suppressed") {
      const x = px(p.h.at);
      ctx.fillStyle = "rgba(220, 38, 38, .10)";
      ctx.fillRect(x - 4, 0, 8, h);
    }
  }

  function drawSeries(data, key, color, width=2) {
    if (!data.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    data.forEach((e, i) => {
      const x = px(e.at ?? e.t), y = py(e[key]);
      if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    for (const e of data) {
      const x = px(e.at ?? e.t), y = py(e[key]);
      ctx.beginPath(); ctx.arc(x,y,2.5,0,Math.PI*2); ctx.fill();
    }
  }

  function rawColor(verdict) {
    if (verdict === "suppressed") return "#dc2626";
    if (verdict === "visible") return "#059669";
    return "#d97706";
  }

  function drawRawDrift(data) {
    if (!data.length) return;
    for (const e of data) {
      const x = px(e.at);
      const color = rawColor(e.verdict);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.moveTo(x - 4, py(e.x));
      ctx.lineTo(x + 4, py(e.x));
      ctx.moveTo(x, py(e.x) - 4);
      ctx.lineTo(x, py(e.x) + 4);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, py(e.y), 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  const hidNonZero = hid.filter(e => e.x !== 0 || e.y !== 0);
  drawSeries(hidNonZero, "x", "#2563eb", 2);
  drawSeries(hidNonZero, "y", "#93c5fd", 2);
  drawSeries(pointer, "x", "#111827", 2);
  drawSeries(pointer, "y", "#6b7280", 2);
  drawRawDrift(rawDrift);

  ctx.fillStyle = "#111827";
  ctx.font = "13px system-ui";
  ctx.fillText(`window=${windowMs}ms maxAbs=${maxAbs}`, 20, 22);
  ctx.fillStyle = "#2563eb"; ctx.fillText("ZMK X", w-390, 22);
  ctx.fillStyle = "#93c5fd"; ctx.fillText("ZMK Y", w-340, 22);
  ctx.fillStyle = "#111827"; ctx.fillText("Browser X", w-290, 22);
  ctx.fillStyle = "#6b7280"; ctx.fillText("Browser Y", w-215, 22);
  ctx.fillStyle = "#dc2626"; ctx.fillText("raw抑制", w-135, 22);
  ctx.fillStyle = "#059669"; ctx.fillText("raw可視", w-80, 22);
  ctx.fillStyle = "#d97706"; ctx.fillText("raw不明", w-80, 40);
}

function compactPair(p) {
  return {
    timeMs: p.h.at,
    zmkHid: { x: p.h.x, y: p.h.y },
    browserMove: { x: p.b.x, y: p.b.y, count: p.b.count, minDt: p.b.minDt },
    verdict: p.verdict,
    zmkTiny: p.zmkTiny,
    logLine: p.h.line
  };
}

function compactRawDrift(e) {
  return {
    timeMs: e.at,
    raw: { x: e.x, y: e.y, z: e.z },
    verdict: e.verdict,
    pairDtMs: e.pairDt,
    logLine: e.line
  };
}

function buildAnalysisExport(serialEvents, hid, pointer, rawDrift, pairs, jitter, windowMs, offset, note) {
  const suppressed = pairs.filter(p => p.verdict === "suppressed");
  const visible = pairs.filter(p => p.verdict === "visible");
  const missing = pairs.filter(p => p.verdict === "missing");
  const rawSuppressed = rawDrift.filter(e => e.verdict === "suppressed");
  const rawVisible = rawDrift.filter(e => e.verdict === "visible");
  const rawMissing = rawDrift.filter(e => e.verdict === "missing");
  const measured = suppressed.length + visible.length;
  const hidNonZero = hid.filter(e => e.x !== 0 || e.y !== 0);
  const hidAbs = hidNonZero.reduce((sum,e) => sum + Math.abs(e.x) + Math.abs(e.y), 0);
  const visibleAbs = visible.reduce((sum,p) => sum + Math.abs(p.h.x) + Math.abs(p.h.y), 0);
  return {
    note,
    offsetMs: offset,
    settings: { jitterThreshold: jitter, matchWindowMs: windowMs },
    counts: {
      serialEvents: serialEvents.length,
      hidNonZero: hidNonZero.length,
      browserMove: pointer.length,
      suppressed: suppressed.length,
      visible: visible.length,
      missing: missing.length,
      rawDrift: rawDrift.length,
      rawSuppressed: rawSuppressed.length,
      rawVisible: rawVisible.length,
      rawMissing: rawMissing.length
    },
    metrics: {
      suppressionRate: measured ? suppressed.length / measured : null,
      visibleResidualRate: measured ? visible.length / measured : null,
      visibleHidAmountRate: hidAbs ? visibleAbs / hidAbs : null
    },
    rawDriftEvents: rawDrift.slice(0, 300).map(compactRawDrift),
    suppressedEvents: suppressed.slice(0, 200).map(compactPair),
    visibleEvents: visible.slice(0, 200).map(compactPair),
    missingEvents: missing.slice(0, 100).map(compactPair)
  };
}

function downloadJson() {
  if (!lastAnalysis) analyze();
  const data = {
    purpose: "Codexにそのまま渡して、ZMK TrackPoint antidrift / jitter-no-move の効き具合と次のパラメータを解析するためのキャプチャです。",
    serialLog: document.getElementById("serialLog").value,
    pointerLog: document.getElementById("pointerLog").value,
    savedAt: new Date().toISOString(),
    settings: {
      matchWindowMs: Number(document.getElementById("matchWindowMs").value),
      jitterThreshold: Number(document.getElementById("jitterThreshold").value),
      expectedRatio: Number(document.getElementById("expectedRatio").value),
    },
    analysis: lastAnalysis
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "antidrift_codex_capture.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

const sampleSerial = `[00:04:27.822,967] lpps: lpps_motion_work_handler: Motion detected at 267822 ms
[00:04:27.823,333] lpps: LPPS_SENSOR t=267822 x=-1 y=-1 z=0
[00:04:27.823,364] lpps: lpps_motion_work_handler: Movement: x=  -1 y=  -1 z=   0
[00:04:27.823,486] zmk: scale_val: scaled -1 with 6/5 to -2 with remainder 0
[00:04:27.823,669] zmk: zmk_hid_mouse_movement_set: Mouse movement set to 2/0
[00:04:27.823,730] zmk: zmk_hid_mouse_movement_set: Mouse movement set to 0/0
[00:04:28.023,333] lpps: LPPS_SENSOR t=268023 x=1 y=0 z=0
[00:04:28.023,669] zmk: zmk_hid_mouse_movement_set: Mouse movement set to 1/0
[00:04:28.023,730] zmk: zmk_hid_mouse_movement_set: Mouse movement set to 0/0`;

function loadSample() {
  document.getElementById("serialLog").value = sampleSerial;
  // performance.now系に寄せたサンプル。normalizeで先頭non-zeroに合う。
  document.getElementById("pointerLog").value =
`267823.700 move 0/0
268023.700 move 3/0
`;
  analyze();
}

function clearAll() {
  document.getElementById("serialLog").value = "";
  document.getElementById("pointerLog").value = "";
  pointerEvents = [];
  serialLineBuffer = "";
  analyze();
}

document.getElementById("serialConnectBtn").addEventListener("click", connectSerial);
document.getElementById("serialDisconnectBtn").addEventListener("click", disconnectSerial);
document.getElementById("pointerStartBtn").addEventListener("click", requestPointerLock);
document.getElementById("pointerStopBtn").addEventListener("click", stopPointerLock);
document.getElementById("captureBox").addEventListener("click", requestPointerLock);
document.addEventListener("pointerlockchange", onPointerLockChange);
document.addEventListener("mousemove", onMouseMove);
document.getElementById("analyzeBtn").addEventListener("click", analyze);
document.getElementById("loadSampleBtn").addEventListener("click", loadSample);
document.getElementById("clearBtn").addEventListener("click", clearAll);
document.getElementById("downloadBtn").addEventListener("click", downloadJson);

analyze();
