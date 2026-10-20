/* Results history panel for the benchmark dashboard.
 * Defines a single global: window.LBBHistory = { render(container, runs, opts) }.
 * Plain ES2017, no modules, no libraries. Also loadable under Node for tests. */
(function () {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(v) {
    if (v === null || v === undefined || typeof v !== 'number' || isNaN(v)) return '—';
    var s = v.toFixed(1);
    if (s.slice(-2) === '.0') s = s.slice(0, -2);
    return s;
  }

  function signed(v) {
    if (v === null || v === undefined || typeof v !== 'number' || isNaN(v)) return '';
    var s = v.toFixed(1);
    if (s.slice(-2) === '.0') s = s.slice(0, -2);
    return (v > 0 ? '+' : '') + s;
  }

  function totalOf(scores, model) {
    var sc = scores && scores[model];
    if (!sc) return null;
    var t = sc.total;
    if (t === null || t === undefined || typeof t !== 'number' || isNaN(t)) return null;
    return t;
  }

  function bestPerModel(runs, focus) {
    focus = focus || [];
    runs = runs || [];
    var info = {};
    var order = [];

    for (var i = 0; i < runs.length; i++) {
      var run = runs[i] || {};
      var scores = run.scores || {};
      for (var model in scores) {
        if (!Object.prototype.hasOwnProperty.call(scores, model)) continue;
        if (!info[model]) {
          info[model] = { model: model, runs: 0, best: null, bestRun: null, latest: null, change: null, wb: null, gui: null };
          order.push(model);
        }
        var m = info[model];
        var t = totalOf(scores, model);
        if (t === null) continue;
        m.runs += 1;
        if (m.best === null || t > m.best) {
          m.best = t;
          m.bestRun = run.id;
        }
        if (m.latest === null) {
          // runs are newest first: first non-null total is the latest
          m.latest = t;
          var sc = scores[model];
          m.wb = (sc.wb === null || sc.wb === undefined) ? null : sc.wb;
          m.gui = (sc.gui === null || sc.gui === undefined) ? null : sc.gui;
        } else if (m.change === null) {
          m.change = m.latest - t;
        }
      }
    }

    var focusRank = {};
    for (var f = 0; f < focus.length; f++) {
      if (!Object.prototype.hasOwnProperty.call(focusRank, focus[f])) focusRank[focus[f]] = f;
    }

    var list = order.map(function (k) { return info[k]; });
    list.sort(function (a, b) {
      var fa = Object.prototype.hasOwnProperty.call(focusRank, a.model) ? focusRank[a.model] : Infinity;
      var fb = Object.prototype.hasOwnProperty.call(focusRank, b.model) ? focusRank[b.model] : Infinity;
      if (fa !== fb) return fa - fb;
      var ba = a.best === null ? -Infinity : a.best;
      var bb = b.best === null ? -Infinity : b.best;
      if (ba !== bb) return bb - ba;
      return a.model < b.model ? -1 : (a.model > b.model ? 1 : 0);
    });
    return list;
  }

  function fmtStarted(iso) {
    if (!iso || typeof iso !== 'string') return '—';
    // 'YYYY-MM-DDTHH:MM:SS' -> 'dd.mm. hh:mm' (no timezone handling)
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
    if (!m) return esc(iso);
    return m[3] + '.' + m[2] + '. ' + m[4] + ':' + m[5];
  }

  function fmtContext(numCtx) {
    if (numCtx === null || numCtx === undefined || typeof numCtx !== 'number' || isNaN(numCtx)) return '—';
    return Math.round(numCtx / 1024) + 'k';
  }

  function render(container, runs, opts) {
    opts = opts || {};
    runs = runs || [];
    var focus = opts.focus || [];
    var currentId = opts.currentId === undefined ? null : opts.currentId;

    if (!runs.length) {
      container.innerHTML = '<p class="hist-empty">No saved runs yet.</p>';
      return;
    }

    var html = [];

    // 1. Best and latest per model
    var perModel = bestPerModel(runs, focus);
    html.push('<h3 class="hist-title">Best and latest per model</h3>');
    html.push('<table class="hist-table hist-models">');
    html.push('<thead><tr>');
    html.push('<th>Model</th><th>Runs</th><th>Best total</th><th>Latest total</th>');
    html.push('<th>Change</th><th>Latest wb</th><th>Latest GUI</th>');
    html.push('</tr></thead><tbody>');
    for (var i = 0; i < perModel.length; i++) {
      var m = perModel[i];
      var changeCls = '';
      if (m.change !== null && m.change > 0) changeCls = ' up';
      else if (m.change !== null && m.change < 0) changeCls = ' down';
      html.push('<tr>');
      html.push('<td>' + esc(m.model) + '</td>');
      html.push('<td>' + esc(String(m.runs)) + '</td>');
      html.push('<td>' + esc(num(m.best)) +
        (m.bestRun ? ' <span class="hist-muted">' + esc(m.bestRun) + '</span>' : '') + '</td>');
      html.push('<td>' + esc(num(m.latest)) + '</td>');
      html.push('<td class="hist-change' + changeCls + '">' + esc(signed(m.change)) + '</td>');
      html.push('<td>' + esc(num(m.wb)) + '</td>');
      html.push('<td>' + esc(num(m.gui)) + '</td>');
      html.push('</tr>');
    }
    html.push('</tbody></table>');

    // 2. All runs
    html.push('<h3 class="hist-title">All runs</h3>');
    html.push('<table class="hist-table hist-runs">');
    html.push('<thead><tr>');
    html.push('<th>Started</th><th>State</th><th>Harness</th><th>Context</th><th>Think</th>');
    // union of model columns, in order of first appearance (newest first)
    var cols = [];
    var seen = {};
    for (var r = 0; r < runs.length; r++) {
      var models = (runs[r] && runs[r].models) || [];
      for (var k = 0; k < models.length; k++) {
        if (!Object.prototype.hasOwnProperty.call(seen, models[k])) {
          seen[models[k]] = true;
          cols.push(models[k]);
        }
      }
    }
    for (var c = 0; c < cols.length; c++) {
      html.push('<th>' + esc(cols[c]) + '</th>');
    }
    html.push('<th></th>');
    html.push('</tr></thead><tbody>');

    for (var ri = 0; ri < runs.length; ri++) {
      var run = runs[ri] || {};
      var rowCls = (currentId !== null && run.id === currentId) ? ' class="current"' : '';
      html.push('<tr' + rowCls + ' data-id="' + esc(run.id || '') + '">');
      html.push('<td>' + esc(fmtStarted(run.started)) + '</td>');
      html.push('<td>' + esc(run.state || '—') + '</td>');
      html.push('<td>' + (run.harness ? 'v' + esc(run.harness) : '—') + '</td>');
      html.push('<td>' + esc(fmtContext(run.num_ctx)) + '</td>');
      html.push('<td>' + (run.think === true ? 'on' : (run.think === false ? 'off' : '—')) + '</td>');

      var runModels = run.models || [];
      var runScores = run.scores || {};
      var runStates = run.states || {};
      for (var ci = 0; ci < cols.length; ci++) {
        var name = cols[ci];
        if (runModels.indexOf(name) === -1) {
          html.push('<td></td>');
          continue;
        }
        var cellCls = (run.best === name) ? ' class="best"' : '';
        var st = runStates[name];
        if (st !== undefined && st !== 'done') {
          html.push('<td' + cellCls + '>' + esc(name) + ' <span class="hist-muted">' + esc(st) + '</span></td>');
          continue;
        }
        var sc = runScores[name] || {};
        var total = totalOf(runScores, name);
        var sub = 'wb ' + num(sc.wb) + ' · gui ' + num(sc.gui);
        html.push('<td' + cellCls + '>' + esc(name) + ' ' + esc(num(total)) +
          '<div class="hist-muted">' + esc(sub) + '</div></td>');
      }

      html.push('<td><button type="button" class="hist-open" data-id="' + esc(run.id || '') + '">Open</button></td>');
      html.push('</tr>');
    }
    html.push('</tbody></table>');

    container.innerHTML = html.join('');

    // 3. Attach listeners after setting innerHTML
    var onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;
    if (!onOpen) return;

    var buttons = container.querySelectorAll('.hist-open');
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].addEventListener('click', function (ev) {
        ev.stopPropagation();
        onOpen(this.getAttribute('data-id'));
      });
    }

    var rows = container.querySelectorAll('tr[data-id]');
    for (var rr = 0; rr < rows.length; rr++) {
      rows[rr].addEventListener('click', function () {
        onOpen(this.getAttribute('data-id'));
      });
    }
  }

  if (typeof window !== 'undefined') {
    window.LBBHistory = { render: render };
  }
  if (typeof module !== 'undefined') {
    module.exports = { render: render, bestPerModel: bestPerModel };
  }
})();
