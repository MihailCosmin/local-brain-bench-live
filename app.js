'use strict';

/* Local Brain Bench — vanilla JS front-end. */

const SUITES = [
  { key: 'vram', label: 'Fits in VRAM' },
  { key: 'speed', label: 'Speed' },
  { key: 'general', label: 'General understanding' },
  { key: 'coding', label: 'Coding concepts' },
  { key: 'vision', label: 'Vision' },
  { key: 'routing', label: 'Routing (brain JSON)' },
  { key: 'wb', label: 'wb CLI → Workbench' },
  { key: 'gui', label: 'Automonkey → Workbench' },
];

const CATEGORIES = [
  { key: 'general', label: 'General' },
  { key: 'coding', label: 'Coding' },
  { key: 'vision', label: 'Vision' },
  { key: 'routing', label: 'Routing' },
  { key: 'wb', label: 'wb CLI' },
  { key: 'gui', label: 'GUI' },
  { key: 'speed', label: 'Speed' },
  { key: 'vram', label: 'VRAM' },
];

const PALETTE = ['#e07b53', '#4f9cff', '#3fb950', '#d29922', '#c678dd', '#56b6c2'];

const LS_KEY = 'lbb-form-v2';

// Set by the GitHub Pages copy (bench/publish.py): read-only, the run comes from the data
// branch of the publish repository through the GitHub contents API.
const REMOTE = window.LBB_REMOTE || null;
const REMOTE_POLL_MS = 20000;

const state = {
  models: [],
  gpu: null,
  ollama: '',
  config: null,
  runs: [],
  run: null,          // live or history run currently shown
  historyId: null,    // non-null when showing a history run
  selectedModel: null,
  selectedTab: null,
  expanded: new Set(), // item ids expanded
  logCollapsed: false,
  logAutoScroll: true,
  pollTimer: null,
};

/* ---------- helpers ---------- */

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function $(id) { return document.getElementById(id); }

function fmtMMSS(secs) {
  if (secs === null || secs === undefined || isNaN(secs)) return '00:00';
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

function fmtNum(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}

function truncate(str, n) {
  if (str === null || str === undefined) return '';
  const s = String(str);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function heatColor(score) {
  // bad red -> warn amber -> good green, low alpha
  if (score === null || score === undefined) return 'transparent';
  const s = Math.max(0, Math.min(100, score));
  let r, g, b;
  if (s < 50) {
    const t = s / 50;
    r = 248 + (210 - 248) * t;
    g = 81 + (153 - 81) * t;
    b = 73 + (34 - 73) * t;
  } else {
    const t = (s - 50) / 50;
    r = 210 + (63 - 210) * t;
    g = 153 + (185 - 153) * t;
    b = 34 + (80 - 34) * t;
  }
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0.22)`;
}

function modelColor(name) {
  const order = state.run && state.run.order ? state.run.order : state.models.map((m) => m.name);
  const idx = order.indexOf(name);
  return PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
}

function suiteLabel(key) {
  const s = SUITES.find((x) => x.key === key);
  return s ? s.label : key;
}

/* ---------- localStorage form ---------- */

function loadForm() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveForm() {
  try {
    const cfg = buildConfig();
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch (e) {
    /* ignore */
  }
}

/* ---------- config / form ---------- */

function buildConfig() {
  const models = [];
  document.querySelectorAll('#models-list input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) models.push(cb.value);
  });
  const suites = [];
  document.querySelectorAll('#suites-list input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) suites.push(cb.value);
  });
  return {
    models,
    suites,
    num_ctx: parseInt($('set-num-ctx').value, 10) || 8192,
    think: $('set-think').checked,
    total_minutes: parseFloat($('set-total-minutes').value) || 120,
    model_minutes: parseFloat($('set-model-minutes').value) || 22,
    request_timeout_s: parseFloat($('set-request-timeout').value) || 90,
    min_tps: parseFloat($('set-min-tps').value) || 4.0,
    gui_live: $('set-gui-live').checked,
  };
}

function applyForm(cfg) {
  if (!cfg) return;
  const modelSet = new Set(cfg.models || []);
  document.querySelectorAll('#models-list input[type="checkbox"]').forEach((cb) => {
    cb.checked = modelSet.has(cb.value);
  });
  const suiteSet = new Set(cfg.suites || []);
  document.querySelectorAll('#suites-list input[type="checkbox"]').forEach((cb) => {
    cb.checked = suiteSet.has(cb.value);
  });
  if (cfg.num_ctx) $('set-num-ctx').value = String(cfg.num_ctx);
  $('set-think').checked = !!cfg.think;
  if (cfg.total_minutes != null) $('set-total-minutes').value = cfg.total_minutes;
  if (cfg.model_minutes != null) $('set-model-minutes').value = cfg.model_minutes;
  if (cfg.request_timeout_s != null) $('set-request-timeout').value = cfg.request_timeout_s;
  if (cfg.min_tps != null) $('set-min-tps').value = cfg.min_tps;
  $('set-gui-live').checked = !!cfg.gui_live;
}

/* ---------- rendering: models & suites ---------- */

function renderModels() {
  const gpu = state.gpu;
  const html = state.models.map((m) => {
    const over = gpu && m.size_gb * 1024 > gpu.total_mb * 0.92;
    const caps = (m.caps || []).filter((c) => c === 'vision' || c === 'tools' || c === 'thinking');
    const chips = [];
    if (m.size_gb != null) chips.push(`<span class="chip">${esc(m.size_gb)} GB</span>`);
    if (m.params) chips.push(`<span class="chip">${esc(m.params)}</span>`);
    if (m.quant) chips.push(`<span class="chip">${esc(m.quant)}</span>`);
    caps.forEach((c) => chips.push(`<span class="chip cap">${esc(c)}</span>`));
    if (over) chips.push('<span class="chip over">over VRAM</span>');
    return `
      <label class="model-row">
        <input type="checkbox" value="${esc(m.name)}" ${m.default ? 'checked' : ''}>
        <div class="model-info">
          <div class="model-name">${esc(m.name)}</div>
          <div class="chips">${chips.join('')}</div>
        </div>
      </label>`;
  }).join('');
  $('models-list').innerHTML = html || '<div class="empty-hint">No models found.</div>';
}

function renderSuites() {
  const html = SUITES.map((s) => `
    <label class="suite-row">
      <input type="checkbox" value="${esc(s.key)}" checked>
      <span>${esc(s.label)}</span>
      <span class="suite-key">${esc(s.key)}</span>
    </label>`).join('');
  $('suites-list').innerHTML = html;
}

/* ---------- rendering: header ---------- */

function renderHeader() {
  const gpu = state.gpu;
  if (gpu) {
    $('gpu-name').textContent = gpu.name || 'GPU';
    const pct = gpu.total_mb ? Math.min(100, (gpu.used_mb / gpu.total_mb) * 100) : 0;
    $('vram-fill').style.width = pct.toFixed(1) + '%';
    $('vram-label').textContent = `${gpu.used_mb} / ${gpu.total_mb} MB`;
  }
  $('ollama-ver').textContent = 'Ollama ' + (state.ollama || '—');

  const run = state.run;
  const runState = run && run.state ? run.state : 'idle';
  const pill = $('state-pill');
  pill.textContent = runState;
  pill.className = 'state-pill ' + runState;

  const totalMin = (run && run.config && run.config.total_minutes) || (state.config && state.config.total_minutes) || 120;
  const totalSecs = totalMin * 60;
  const elapsed = run && run.elapsed_s ? run.elapsed_s : 0;
  const pct = totalSecs ? Math.min(100, (elapsed / totalSecs) * 100) : 0;
  $('elapsed-fill').style.width = pct.toFixed(1) + '%';
  $('elapsed-label').textContent = `${fmtMMSS(elapsed)} / ${fmtMMSS(totalSecs)}`;

  const running = runState === 'running';
  $('btn-stop').classList.toggle('hidden', !running);
  $('btn-start').disabled = running;

  const age = $('remote-age');
  if (REMOTE) {
    const at = run && run.published_at;
    const secs = at ? Math.max(0, Date.now() / 1000 - at) : null;
    age.textContent = state.remoteError
      ? state.remoteError
      : at ? `updated ${secs < 90 ? Math.round(secs) + ' s' : Math.round(secs / 60) + ' min'} ago` : 'waiting for data';
    age.classList.toggle('stale', !!state.remoteError || (running && secs > 3 * REMOTE.interval_s));
    age.classList.remove('hidden');
  } else if (state.publish && state.publish.enabled) {
    age.innerHTML = `<a href="${esc(state.publish.url)}" target="_blank" rel="noopener" `
      + `title="${esc(state.publish.error || 'pushed every ' + state.publish.interval_s + ' s while a run is active')}">`
      + `${state.publish.error ? '⚠ ' : ''}live on the web ↗</a>`;
    age.classList.toggle('stale', !!state.publish.error);
    age.classList.remove('hidden');
  }
}

/* ---------- rendering: progress ---------- */

function renderProgress() {
  const run = state.run;
  const wrap = $('progress-cards');
  if (!run || !run.order || !run.order.length) {
    wrap.innerHTML = `<div class="empty-hint">${REMOTE ? 'No run published yet' : 'Pick models and press Start'}</div>`;
    return;
  }
  const cur = run.current;
  const html = run.order.map((name) => {
    const mr = (run.models && run.models[name]) || { state: 'pending' };
    const st = mr.state || 'pending';
    const selected = state.selectedModel === name ? ' selected' : '';
    let currentHtml = '';
    if (st === 'running' && cur && cur.model === name) {
      currentHtml = `<div class="prog-current">${esc(cur.suite)} · ${esc(cur.item)} · ${esc(cur.done)}/${esc(cur.total)}</div>`;
    }
    const budget = mr.budget_s || 0;
    const elapsed = mr.elapsed_s || 0;
    const barPct = budget ? Math.min(100, (elapsed / budget) * 100) : 0;
    let reasonHtml = '';
    if (mr.reason) {
      const warn = /budget/i.test(mr.reason);
      reasonHtml = `<div class="prog-reason${warn ? ' warn' : ''}">${esc(mr.reason)}</div>`;
    }
    return `
      <div class="prog-card${selected}" data-model="${esc(name)}">
        <div class="prog-head">
          <span class="prog-name">${esc(name)}</span>
          <span class="badge ${esc(st)}">${esc(st)}</span>
        </div>
        ${currentHtml}
        <div class="prog-bar"><div class="prog-bar-fill" style="width:${barPct.toFixed(1)}%"></div></div>
        ${reasonHtml}
      </div>`;
  }).join('');
  wrap.innerHTML = html;
}

/* ---------- rendering: leaderboard ---------- */

function renderLeaderboard() {
  const run = state.run;
  const wrap = $('leaderboard');
  if (!run || !run.order || !run.order.length) {
    wrap.innerHTML = '<div class="empty-hint">No results yet.</div>';
    return;
  }
  const rows = run.order.map((name) => {
    const mr = (run.models && run.models[name]) || {};
    return { name, mr, total: mr.scores ? mr.scores.total : null };
  });
  rows.sort((a, b) => {
    if (a.total === null && b.total === null) return 0;
    if (a.total === null) return 1;
    if (b.total === null) return -1;
    return b.total - a.total;
  });

  const head = `
    <tr>
      <th>#</th><th>Model</th><th>Brain score</th><th>VRAM</th><th>tok/s</th>
      <th>General</th><th>Coding</th><th>Vision</th><th>Routing</th><th>wb CLI</th><th>GUI</th><th>Speed</th>
    </tr>`;

  const body = rows.map((row, i) => {
    const mr = row.mr;
    const scores = mr.scores || {};
    const isBest = run.best && run.best === row.name;
    const selected = state.selectedModel === row.name ? ' selected' : '';
    const bestCls = isBest ? ' best' : '';

    const total = scores.total;
    const totalNum = total === null || total === undefined ? '—' : Number(total).toFixed(1);
    const barPct = total === null || total === undefined ? 0 : Math.max(0, Math.min(100, total));
    const recBadge = isBest ? '<span class="rec-badge">Recommended brain</span>' : '';

    let vramCell = '<td class="cell-na">—</td>';
    if (mr.vram) {
      if (mr.vram.fits) {
        vramCell = `<td class="vram-ok">✓ ${esc(mr.vram.gpu_pct)}% GPU</td>`;
      } else {
        vramCell = `<td class="vram-bad">✗ ${esc(mr.vram.gpu_pct)}% GPU</td>`;
      }
    }

    const tps = mr.speed && mr.speed.gen_tps != null ? fmtNum(mr.speed.gen_tps, 1) : '—';

    const scoreCell = (key) => {
      const v = scores[key];
      if (v === null || v === undefined) {
        const suite = mr.suites && mr.suites[key];
        if (suite && suite.note && /no vision/i.test(suite.note)) {
          return '<td class="cell-na">n/a</td>';
        }
        return '<td class="cell-na">—</td>';
      }
      return `<td class="cell-num" style="background:${heatColor(v)}">${Number(v).toFixed(0)}</td>`;
    };

    return `
      <tr class="lb-row${selected}${bestCls}" data-model="${esc(row.name)}">
        <td class="rank">${i + 1}</td>
        <td class="lb-model">${esc(row.name)}${recBadge}</td>
        <td>
          <div class="brain-score">
            <span class="brain-num">${totalNum}</span>
            <span class="brain-bar"><span class="brain-bar-fill" style="width:${barPct.toFixed(1)}%"></span></span>
          </div>
        </td>
        ${vramCell}
        <td>${tps}</td>
        ${scoreCell('general')}
        ${scoreCell('coding')}
        ${scoreCell('vision')}
        ${scoreCell('routing')}
        ${scoreCell('wb')}
        ${scoreCell('gui')}
        ${scoreCell('speed')}
      </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="lb"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/* ---------- rendering: charts ---------- */

function renderScoreChart() {
  const run = state.run;
  const wrap = $('chart-scores');
  if (!run || !run.order || !run.order.length) {
    wrap.innerHTML = '<div class="empty-hint">No data.</div>';
    return;
  }
  const models = run.order;
  const groupH = 18 * models.length + 14;
  const labelW = 70;
  const chartW = 560;
  const barAreaW = chartW - labelW - 20;
  const topPad = 8;
  const height = topPad + CATEGORIES.length * groupH + 10;

  let svg = `<svg width="100%" style="max-width:${chartW}px" viewBox="0 0 ${chartW} ${height}" role="img">`;
  CATEGORIES.forEach((cat, ci) => {
    const gy = topPad + ci * groupH;
    svg += `<text x="0" y="${gy + 12}" fill="#9a9aa5" font-size="11">${esc(cat.label)}</text>`;
    models.forEach((name, mi) => {
      const mr = (run.models && run.models[name]) || {};
      const v = mr.scores ? mr.scores[cat.key] : null;
      const by = gy + mi * 18 + 2;
      const w = v === null || v === undefined ? 0 : Math.max(0, Math.min(100, v)) / 100 * barAreaW;
      const color = modelColor(name);
      const label = v === null || v === undefined ? '—' : Number(v).toFixed(0);
      svg += `<rect x="${labelW}" y="${by}" width="${barAreaW}" height="14" fill="#2b2b31" rx="2"/>`;
      if (w > 0) {
        svg += `<rect x="${labelW}" y="${by}" width="${w.toFixed(1)}" height="14" fill="${color}" rx="2">` +
          `<title>${esc(name)} · ${esc(cat.label)}: ${esc(label)}</title></rect>`;
      } else {
        svg += `<rect x="${labelW}" y="${by}" width="${barAreaW}" height="14" fill="transparent">` +
          `<title>${esc(name)} · ${esc(cat.label)}: ${esc(label)}</title></rect>`;
      }
    });
  });
  svg += '</svg>';

  const legend = '<div class="legend">' + models.map((name) =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${modelColor(name)}"></span>${esc(name)}</span>`
  ).join('') + '</div>';

  wrap.innerHTML = svg + legend;
}

function renderSpeedChart() {
  const run = state.run;
  const wrap = $('chart-speed');
  if (!run || !run.order || !run.order.length) {
    wrap.innerHTML = '<div class="empty-hint">No data.</div>';
    return;
  }
  const models = run.order;
  const minTps = (run.config && run.config.min_tps) || 0;
  const vals = models.map((name) => {
    const mr = (run.models && run.models[name]) || {};
    return mr.speed && mr.speed.gen_tps != null ? mr.speed.gen_tps : null;
  });
  const maxVal = Math.max(minTps, ...vals.filter((v) => v !== null), 1);
  const labelW = 130;
  const chartW = 560;
  const barAreaW = chartW - labelW - 30;
  const rowH = 22;
  const topPad = 8;
  const height = topPad + models.length * rowH + 24;

  const xFor = (v) => labelW + (v / maxVal) * barAreaW;

  let svg = `<svg width="100%" style="max-width:${chartW}px" viewBox="0 0 ${chartW} ${height}" role="img">`;
  models.forEach((name, i) => {
    const v = vals[i];
    const y = topPad + i * rowH;
    const color = modelColor(name);
    svg += `<text x="0" y="${y + 14}" fill="#e6e6e6" font-size="11">${esc(truncate(name, 20))}</text>`;
    if (v !== null) {
      const w = (v / maxVal) * barAreaW;
      svg += `<rect x="${labelW}" y="${y + 3}" width="${w.toFixed(1)}" height="14" fill="${color}" rx="2">` +
        `<title>${esc(name)}: ${fmtNum(v, 1)} tok/s</title></rect>`;
      svg += `<text x="${(labelW + w + 4).toFixed(1)}" y="${y + 14}" fill="#9a9aa5" font-size="10">${fmtNum(v, 1)}</text>`;
    } else {
      svg += `<text x="${labelW + 4}" y="${y + 14}" fill="#9a9aa5" font-size="10">—</text>`;
    }
  });
  // dashed min line
  const minX = xFor(minTps);
  const lineTop = topPad;
  const lineBottom = topPad + models.length * rowH;
  svg += `<line x1="${minX.toFixed(1)}" y1="${lineTop}" x2="${minX.toFixed(1)}" y2="${lineBottom}" ` +
    `stroke="#d29922" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  svg += `<text x="${(minX + 4).toFixed(1)}" y="${lineTop + 10}" fill="#d29922" font-size="10">min ${fmtNum(minTps, 1)}</text>`;
  svg += '</svg>';

  wrap.innerHTML = svg;
}

/* ---------- rendering: details ---------- */

function renderDetails() {
  const wrap = $('details');
  const run = state.run;
  const name = state.selectedModel;
  if (!run || !name || !run.models || !run.models[name]) {
    wrap.innerHTML = '<div class="empty-hint">Select a model in the leaderboard or progress cards.</div>';
    return;
  }
  const mr = run.models[name];
  const suites = mr.suites || {};
  const suiteKeys = Object.keys(suites);

  // stat tiles
  const tiles = [];
  if (mr.vram) {
    tiles.push(`<div class="stat-tile"><div class="k">VRAM</div><div class="v">${mr.vram.fits ? '✓ ' : '✗ '}${esc(mr.vram.gpu_pct)}%</div></div>`);
    tiles.push(`<div class="stat-tile"><div class="k">Size</div><div class="v">${esc(mr.vram.size_mb)} MB</div></div>`);
    tiles.push(`<div class="stat-tile"><div class="k">Load</div><div class="v">${fmtNum(mr.vram.load_s, 1)} s</div></div>`);
  }
  if (mr.speed) {
    tiles.push(`<div class="stat-tile"><div class="k">Gen tok/s</div><div class="v">${fmtNum(mr.speed.gen_tps, 1)}</div></div>`);
    tiles.push(`<div class="stat-tile"><div class="k">Prompt tok/s</div><div class="v">${fmtNum(mr.speed.prompt_tps, 1)}</div></div>`);
    tiles.push(`<div class="stat-tile"><div class="k">TTFT</div><div class="v">${fmtNum(mr.speed.ttft_s, 2)} s</div></div>`);
  }
  const tilesHtml = tiles.length ? `<div class="stat-tiles">${tiles.join('')}</div>` : '';

  if (!suiteKeys.length) {
    wrap.innerHTML = tilesHtml + '<div class="empty-hint">No suite results for this model.</div>';
    return;
  }

  // tabs
  let activeTab = state.selectedTab;
  if (!activeTab || !suites[activeTab]) activeTab = suiteKeys[0];
  state.selectedTab = activeTab;

  const tabsHtml = '<div class="tabs">' + suiteKeys.map((k) => {
    const s = suites[k];
    const scoreTxt = s.score === null || s.score === undefined ? '—' : Number(s.score).toFixed(0);
    return `<button class="tab${k === activeTab ? ' active' : ''}" data-tab="${esc(k)}">${esc(suiteLabel(k))}<span class="tab-score">${scoreTxt}</span></button>`;
  }).join('') + '</div>';

  const suite = suites[activeTab];
  const noteHtml = suite.note ? `<div class="suite-note">${esc(suite.note)}</div>` : '';

  const items = suite.items || [];
  const itemsHtml = items.length ? renderItemsTable(items) : '<div class="empty-hint">No items.</div>';

  wrap.innerHTML = tilesHtml + tabsHtml + noteHtml + itemsHtml;
}

function renderItemsTable(items) {
  const head = `
    <tr>
      <th>✓</th><th>id</th><th>expected</th><th>answer</th><th>secs</th><th>tps</th><th>error</th><th>img</th>
    </tr>`;
  const rows = items.map((it) => {
    let icon;
    if (it.ok === true) icon = '<span class="item-ok">✓</span>';
    else if (it.score > 0) icon = `<span class="item-partial">${Math.round(it.score * 100)}%</span>`;
    else icon = '<span class="item-bad">✗</span>';

    const expanded = state.expanded.has(it.id);
    const answer = truncate(it.answer, 120);
    const img = it.image && REMOTE ? it.image.replace(/^\//, '') : it.image;  // Pages: fixtures/ next to the page
    const imgCell = img
      ? `<img class="item-thumb" src="${esc(img)}" alt="" data-full="${esc(img)}">`
      : '';

    let html = `
      <tr class="item-row" data-item="${esc(it.id)}">
        <td>${icon}</td>
        <td>${esc(it.id)}</td>
        <td>${esc(it.expected)}</td>
        <td class="item-answer">${esc(answer)}</td>
        <td>${fmtNum(it.secs, 2)}</td>
        <td>${fmtNum(it.tps, 1)}</td>
        <td class="item-error">${esc(it.error)}</td>
        <td>${imgCell}</td>
      </tr>`;

    if (expanded) {
      html += `
        <tr class="expand-row">
          <td colspan="8">
            <div class="pre-label">Prompt</div>
            <pre>${esc(it.prompt)}</pre>
            <div class="pre-label">Answer</div>
            <pre>${esc(it.answer)}</pre>
          </td>
        </tr>`;
    }
    return html;
  }).join('');
  return `<table class="items"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/* ---------- rendering: log ---------- */

function renderLog() {
  const run = state.run;
  const lines = (run && run.log) || [];
  const box = $('log-lines');
  const body = $('log-body');
  const prevScroll = body.scrollTop;
  const wasAtBottom = state.logAutoScroll;

  box.innerHTML = lines.map((l) =>
    `<div class="log-line ${esc(l.level)}"><span class="lt">${esc(l.t)}</span>${esc(l.msg)}</div>`
  ).join('');

  if (wasAtBottom) {
    body.scrollTop = body.scrollHeight;
  } else {
    body.scrollTop = prevScroll;
  }
}

/* ---------- rendering: history ---------- */

function renderHistory() {
  const sel = $('history-select');
  const prev = state.historyId || '';
  const opts = ['<option value="">— live —</option>'].concat(
    state.runs.map((r) => {
      const best = r.best ? r.best : '—';
      return `<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.state)} · best: ${esc(best)}</option>`;
    })
  ).join('');
  sel.innerHTML = opts;
  sel.value = prev;
  $('back-live').classList.toggle('hidden', !state.historyId);
}

/* ---------- master render ---------- */

function renderAll() {
  renderHeader();
  renderProgress();
  renderLeaderboard();
  renderScoreChart();
  renderSpeedChart();
  renderDetails();
  renderLog();
  renderHistory();
}

/* ---------- data fetching ---------- */

// The local API path a remote page reads instead: a file on the data branch.
function remoteFile(url) {
  if (url === '/api/status') return 'status.json';
  if (url === '/api/runs') return 'runs.json';
  if (url.startsWith('/api/runs/')) return 'runs/' + url.slice('/api/runs/'.length) + '.json';
  return null;
}

async function fetchRemote(url) {
  const file = remoteFile(url);
  if (!file) throw new Error('read-only copy');
  // Accept is a CORS-safelisted header, so no preflight; cache:'no-cache' revalidates with the
  // ETag, and GitHub does not count 304 answers against the hourly limit.
  const res = await fetch(`https://api.github.com/repos/${REMOTE.repo}/contents/${file}?ref=${encodeURIComponent(REMOTE.branch)}`,
    { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-cache' });
  if (res.status === 404) return url === '/api/runs' ? [] : { state: 'idle' };
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) || 0;
    const err = new Error('GitHub rate limit' + (reset ? ', retry after ' + new Date(reset * 1000).toLocaleTimeString() : ''));
    err.status = res.status;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  return res.json();
}

async function fetchJSON(url, opts) {
  if (REMOTE) return fetchRemote(url);
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch (e) { /* ignore */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function loadInitial() {
  if (REMOTE) {
    document.body.classList.add('remote');
    try {
      state.runs = await fetchJSON('/api/runs');
    } catch (e) {
      state.runs = [];
    }
    const linked = new URLSearchParams(location.search).get('run');
    if (linked) await loadHistory(linked);
    else await pollStatus();
    return;
  }
  fetchJSON('/api/publish').then((p) => { state.publish = p; renderHeader(); }).catch(() => {});
  try {
    const [modelsRes, configRes, runsRes] = await Promise.all([
      fetchJSON('/api/models'),
      fetchJSON('/api/config'),
      fetchJSON('/api/runs'),
    ]);
    state.gpu = modelsRes.gpu || null;
    state.ollama = modelsRes.ollama || '';
    state.models = modelsRes.models || [];
    state.config = configRes;
    state.runs = runsRes || [];

    renderModels();
    renderSuites();

    const saved = loadForm();
    applyForm(saved || configRes);

    // wire form persistence
    document.querySelectorAll('#models-list input[type="checkbox"], #suites-list input[type="checkbox"]')
      .forEach((cb) => cb.addEventListener('change', saveForm));
    ['set-num-ctx', 'set-think', 'set-total-minutes', 'set-model-minutes',
      'set-request-timeout', 'set-min-tps', 'set-gui-live'].forEach((id) => {
      $(id).addEventListener('change', saveForm);
    });

    const linked = new URLSearchParams(location.search).get('run');  // /?run=<id> opens a saved run
    if (linked) await loadHistory(linked);
    else await pollStatus();
  } catch (e) {
    $('progress-cards').innerHTML = `<div class="empty-hint">Failed to load: ${esc(e.message)}</div>`;
  }
}

async function pollStatus() {
  if (state.historyId) return; // paused while viewing history
  try {
    const run = await fetchJSON('/api/status');
    if (run && run.state && run.state !== 'idle') {
      state.run = run;
    } else {
      state.run = null;
    }
    if (REMOTE) {
      state.remoteError = '';
      if (run && run.host) {
        state.gpu = run.host.gpu || null;
        state.ollama = run.host.ollama || '';
      }
      // a finished run lands in runs.json: refresh the history list once it ended
      if (run && run.state !== 'running' && !state.runs.some((r) => r.id === run.id)) {
        state.runs = await fetchJSON('/api/runs').catch(() => state.runs);
      }
    }
    renderAll();
    schedulePoll();
  } catch (e) {
    if (REMOTE) {
      state.remoteError = e.message;
      renderHeader();
    }
    schedulePoll();
  }
}

function schedulePoll() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  const running = state.run && state.run.state === 'running';
  const delay = REMOTE ? REMOTE_POLL_MS : running ? 1000 : 5000;
  state.pollTimer = setTimeout(pollStatus, delay);
}

async function loadHistory(id) {
  if (!id) {
    state.historyId = null;
    state.run = null;
    $('back-live').classList.add('hidden');
    await pollStatus();
    return;
  }
  try {
    const run = await fetchJSON('/api/runs/' + encodeURIComponent(id));
    state.historyId = id;
    state.run = run;
    state.selectedModel = null;
    state.selectedTab = null;
    state.expanded.clear();
    renderAll();
  } catch (e) {
    $('form-error').textContent = 'Failed to load run: ' + e.message;
    $('form-error').classList.remove('hidden');
  }
}

/* ---------- actions ---------- */

async function startRun() {
  const errEl = $('form-error');
  errEl.classList.add('hidden');
  const cfg = buildConfig();
  if (!cfg.models.length) {
    errEl.textContent = 'Pick at least one model.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!cfg.suites.length) {
    errEl.textContent = 'Pick at least one test suite.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    await fetchJSON('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    state.historyId = null;
    $('back-live').classList.add('hidden');
    await pollStatus();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

async function stopRun() {
  try {
    await fetchJSON('/api/stop', { method: 'POST' });
    await pollStatus();
  } catch (e) {
    const errEl = $('form-error');
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

/* ---------- event wiring ---------- */

function selectModel(name) {
  state.selectedModel = name;
  state.selectedTab = null;
  state.expanded.clear();
  renderProgress();
  renderLeaderboard();
  renderDetails();
}

function wireEvents() {
  $('btn-start').addEventListener('click', startRun);
  $('btn-stop').addEventListener('click', stopRun);

  $('history-select').addEventListener('change', (e) => {
    loadHistory(e.target.value);
  });
  $('back-live').addEventListener('click', (e) => {
    e.preventDefault();
    $('history-select').value = '';
    loadHistory(null);
  });

  // progress card click
  $('progress-cards').addEventListener('click', (e) => {
    const card = e.target.closest('.prog-card');
    if (card && card.dataset.model) selectModel(card.dataset.model);
  });

  // leaderboard row click
  $('leaderboard').addEventListener('click', (e) => {
    const row = e.target.closest('.lb-row');
    if (row && row.dataset.model) selectModel(row.dataset.model);
  });

  // details: tabs, item rows, thumbnails
  $('details').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab && tab.dataset.tab) {
      state.selectedTab = tab.dataset.tab;
      state.expanded.clear();
      renderDetails();
      return;
    }
    const thumb = e.target.closest('.item-thumb');
    if (thumb && thumb.dataset.full) {
      window.open(thumb.dataset.full, '_blank');
      return;
    }
    const row = e.target.closest('.item-row');
    if (row && row.dataset.item) {
      const id = row.dataset.item;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      renderDetails();
    }
  });

  // log collapse + scroll tracking
  $('log-toggle').addEventListener('click', () => {
    state.logCollapsed = !state.logCollapsed;
    $('log-body').classList.toggle('hidden', state.logCollapsed);
    $('log-chev').textContent = state.logCollapsed ? '▸' : '▾';
  });
  $('log-body').addEventListener('scroll', () => {
    const body = $('log-body');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
    state.logAutoScroll = atBottom;
  });
}

/* ---------- boot ---------- */

document.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  loadInitial();
  if (REMOTE) setInterval(renderHeader, 5000);  // keeps "updated … ago" current between polls
});
