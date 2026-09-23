// 隧道窑核算页：全部计算在此文件，无外部依赖。
// 同时可被 Node require（tools/check.js 自验用），浏览器下自动初始化界面。
(function (global) {
'use strict';

var ZONE_KEYS = ['preheat', 'firing', 'cooling'];
var ZONE_NAMES = { preheat: '预热带', firing: '烧成带', cooling: '冷却带' };

function parseT(s) { return Date.parse(s); }
function fmtT(s) { return s ? s.slice(5, 16).replace('T', ' ') : '-'; }
function fmtMs(ms) { return fmtT(new Date(ms + 8 * 3600000).toISOString()); }
function fmtMin(m) { return (m >= 0 ? '+' : '') + m.toFixed(1) + 'min'; }
function fmtDur(min) { var h = Math.floor(min / 60), m = Math.round(min % 60); return h + 'h' + (m < 10 ? '0' : '') + m + 'm'; }
function num(x, d) { return Number(x).toFixed(d === undefined ? 1 : d); }

// ---------- 数据清洗：热电偶坏点 ----------
function cleanThermocouples(DATA) {
  var report = [];
  var zoneTemp = {}; // zoneTemp[kilnId][zone] = [..]
  DATA.kilns.forEach(function (k) {
    var recs = DATA.records[k.id];
    var n = recs.length;
    var tcValid = {};
    k.thermocouples.forEach(function (tc) {
      var vals = recs.map(function (r) { return r.temps[tc.id]; });
      var valid = new Array(n).fill(true);
      var segs = [];
      var i = 0;
      while (i < n) {
        var j = i;
        while (j + 1 < n && vals[j + 1] === vals[i]) j++;
        if (j - i + 1 >= 6) { // 连续 >=6 刻读数不变 → 坏点
          for (var q = i; q <= j; q++) valid[q] = false;
          segs.push([i, j]);
        }
        i = j + 1;
      }
      if (segs.length) report.push({ kiln: k.id, tc: tc.id, segments: segs });
      tcValid[tc.id] = { vals: vals, valid: valid };
    });
    zoneTemp[k.id] = {};
    ZONE_KEYS.forEach(function (z) {
      var tcs = k.thermocouples.filter(function (tc) { return tc.zone === z; });
      var arr = new Array(n);
      for (var i = 0; i < n; i++) {
        var s = 0, c = 0;
        tcs.forEach(function (tc) {
          var tv = tcValid[tc.id];
          if (tv.valid[i]) { s += tv.vals[i]; c++; }
        });
        arr[i] = c ? s / c : NaN;
      }
      // 全带热电偶都坏时前后线性插值兜底
      for (var a = 0; a < n; a++) {
        if (!isNaN(arr[a])) continue;
        var p = a - 1, q2 = a + 1;
        while (p >= 0 && isNaN(arr[p])) p--;
        while (q2 < n && isNaN(arr[q2])) q2++;
        if (p >= 0 && q2 < n) arr[a] = arr[p] + (arr[q2] - arr[p]) * (a - p) / (q2 - p);
        else if (p >= 0) arr[a] = arr[p];
        else if (q2 < n) arr[a] = arr[q2];
        else arr[a] = 0;
      }
      zoneTemp[k.id][z] = arr;
    });
  });
  return { report: report, zoneTemp: zoneTemp };
}

// ---------- 主模型 ----------
function buildModel(DATA, densityOverride) {
  densityOverride = densityOverride || {};
  var pc = DATA.process_card;
  var glazes = pc.glazes;
  var stepMin = DATA.meta.step_min;
  var stepH = stepMin / 60;
  var kilnById = {};
  DATA.kilns.forEach(function (k) { kilnById[k.id] = k; });

  var cleaned = cleanThermocouples(DATA);
  var zoneTemp = cleaned.zoneTemp;
  var n = DATA.records[DATA.kilns[0].id].length;
  var recTimes = DATA.records[DATA.kilns[0].id].map(function (r) { return parseT(r.t); });
  var t0 = recTimes[0];

  function tempAt(kilnId, zone, t) {
    var arr = zoneTemp[kilnId][zone];
    var x = (t - t0) / (stepMin * 60000);
    var i = Math.floor(x);
    if (i < 0) return arr[0];
    if (i >= n - 1) return arr[n - 1];
    var f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  function massOf(car) {
    var d = densityOverride[car.id] || car.density;
    return pc.density_mass_t[d];
  }
  function glazeOf(car) {
    var g = glazes[car.glaze];
    if (g && g.products.indexOf(car.product) >= 0) return { id: car.glaze, mismatched: false };
    var ids = Object.keys(glazes);
    for (var i = 0; i < ids.length; i++) {
      if (glazes[ids[i]].products.indexOf(car.product) >= 0) return { id: ids[i], mismatched: true };
    }
    return { id: car.glaze, mismatched: true };
  }

  // ---------- 窑车时间线与经历温度 ----------
  var cars = DATA.cars.map(function (c) {
    var k = kilnById[c.kiln];
    var speed = k.car_length_m / k.push_interval_min; // m/min
    var dur = {
      preheat: k.zones.preheat.length_m / speed,
      firing: k.zones.firing.length_m / speed,
      cooling: k.zones.cooling.length_m / speed,
    };
    var push = parseT(c.push_time);
    var times = {
      preheat: push,
      firing: push + dur.preheat * 60000,
      cooling: push + (dur.preheat + dur.firing) * 60000,
      exit: push + (dur.preheat + dur.firing + dur.cooling) * 60000,
    };
    var gz = glazeOf(c);
    var gw = glazes[gz.id];
    var tPre = tempAt(c.kiln, 'preheat', times.preheat);
    var tFireEntry = tempAt(c.kiln, 'firing', times.firing);
    var ramp = (tFireEntry - tPre) / dur.preheat; // ℃/min
    var peak = -Infinity, sum = 0, cnt = 0;
    for (var t = times.firing; t <= times.cooling; t += stepMin * 60000) {
      var v = tempAt(c.kiln, 'firing', t);
      if (v > peak) peak = v;
      sum += v; cnt++;
    }
    var meanFire = cnt ? sum / cnt : tFireEntry;
    var rampBad = null;
    if (ramp > pc.ramp_rate_max) rampBad = { over: true, excess: ramp - pc.ramp_rate_max };
    else if (ramp < pc.ramp_rate_min) rampBad = { over: false, excess: pc.ramp_rate_min - ramp };
    var tempBad = null;
    if (peak > gw.fire_max) tempBad = { over: true, excess: peak - gw.fire_max };
    else if (meanFire < gw.fire_min) tempBad = { over: false, excess: gw.fire_min - meanFire };
    return {
      raw: c, id: c.id, kiln: c.kiln, product: c.product,
      glazeRec: c.glaze, glaze: gz.id, glazeMismatch: gz.mismatched,
      density: c.density, mass: massOf(c),
      dur: dur, times: times, ramp: ramp, rampBad: rampBad,
      peakFire: peak, meanFire: meanFire, tempBad: tempBad,
      glazeWindow: gw,
    };
  });
  var carById = {};
  cars.forEach(function (c) { carById[c.id] = c; });

  // ---------- 规矩三：推进被前车卡住 ----------
  var jams = [];
  DATA.kilns.forEach(function (k) {
    var kc = cars.filter(function (c) { return c.kiln === k.id; })
      .sort(function (a, b) { return a.times.preheat - b.times.preheat; });
    for (var i = 1; i < kc.length; i++) {
      var gapMin = (kc[i].times.preheat - kc[i - 1].times.preheat) / 60000;
      var missed = Math.round(gapMin / k.push_interval_min) - 1;
      if (missed >= 1) jams.push({ kiln: k.id, blocker: kc[i - 1].id, blocked: kc[i].id, slots: missed, at: kc[i].raw.push_time });
    }
  });

  // ---------- 熄火与风燃比 ----------
  var flameouts = [], ratioBad = [];
  DATA.kilns.forEach(function (k) {
    var recs = DATA.records[k.id];
    k.burners.forEach(function (b) {
      var fo = null, rb = null, rbMin = Infinity, rbMax = -Infinity;
      for (var i = 0; i < n; i++) {
        var br = recs[i].burners[b.id];
        var isFo = br.air === 0 && br.gas > 0;
        if (isFo && !fo) fo = { kiln: k.id, burner: b.id, zone: b.zone, from: i, to: i, gas: 0 };
        if (fo) { if (isFo) { fo.to = i; fo.gas += br.gas * stepH; } else { flameouts.push(fo); fo = null; } }
        var ratio = br.gas > 0.05 * b.max_gas && br.air > 0 ? br.air / br.gas : null;
        var bad = ratio !== null && (ratio < pc.air_gas_ratio_min || ratio > pc.air_gas_ratio_max);
        if (bad && !rb) { rb = { kiln: k.id, burner: b.id, zone: b.zone, from: i, to: i }; rbMin = Infinity; rbMax = -Infinity; }
        if (rb) {
          if (bad) { rb.to = i; if (ratio < rbMin) rbMin = ratio; if (ratio > rbMax) rbMax = ratio; }
          else { rb.min = rbMin; rb.max = rbMax; ratioBad.push(rb); rb = null; }
        }
      }
      if (fo) flameouts.push(fo);
      if (rb) { rb.min = rbMin; rb.max = rbMax; ratioBad.push(rb); }
    });
  });

  // ---------- 规矩三(负荷)：多窑同时顶最大燃气 ----------
  var kilnGas = {}; // kilnGas[kid][i] = 总流量
  var kilnMaxGas = {};
  DATA.kilns.forEach(function (k) {
    kilnGas[k.id] = new Array(n);
    kilnMaxGas[k.id] = k.burners.reduce(function (s, b) { return s + b.max_gas; }, 0);
    for (var i = 0; i < n; i++) {
      var s = 0;
      k.burners.forEach(function (b) { s += DATA.records[k.id][i].burners[b.id].gas; });
      kilnGas[k.id][i] = s;
    }
  });
  function firingLoad(kilnId, t) {
    var s = 0;
    cars.forEach(function (c) {
      if (c.kiln === kilnId && t >= c.times.firing && t < c.times.cooling) s += c.mass;
    });
    return s;
  }
  var maxFlowEvents = [];
  var ev = null;
  for (var i = 0; i < n; i++) {
    var atMax = DATA.kilns.filter(function (k) { return kilnGas[k.id][i] >= 0.95 * kilnMaxGas[k.id]; })
      .map(function (k) { return k.id; });
    if (atMax.length >= 2) {
      if (!ev) ev = { from: i, to: i, kilns: {} };
      ev.to = i;
      atMax.forEach(function (kid) { ev.kilns[kid] = true; });
    } else if (ev) { maxFlowEvents.push(ev); ev = null; }
  }
  if (ev) maxFlowEvents.push(ev);
  maxFlowEvents.forEach(function (e) {
    e.verdict = {};
    Object.keys(e.kilns).forEach(function (kid) {
      var k = kilnById[kid];
      var t = recTimes[Math.round((e.from + e.to) / 2)];
      var load = firingLoad(kid, t);
      var cap = (k.zones.firing.length_m / k.car_length_m) * pc.density_mass_t[2];
      e.verdict[kid] = { load: load, factor: load / cap, high: load / cap >= 0.6 };
    });
  });

  // ---------- 燃气总量（分带累加，不做全窑平均） ----------
  var gasByKilnZone = {}; // gasByKilnZone[kid][zone] = m3
  var totalGas = 0;
  DATA.kilns.forEach(function (k) {
    gasByKilnZone[k.id] = { preheat: 0, firing: 0, cooling: 0 };
    k.burners.forEach(function (b) {
      var s = 0;
      for (var i = 0; i < n; i++) s += DATA.records[k.id][i].burners[b.id].gas * stepH;
      gasByKilnZone[k.id][b.zone] += s;
      totalGas += s;
    });
  });
  var totalTons = cars.reduce(function (s, c) { return s + c.mass; }, 0);

  // ---------- 两套运行口径 ----------
  // 负荷回归：G(t) ≈ a·L(t)·T烧成(t)/1270 + b，按各窑实测标定 a、b
  var load = {}; // load[kid][i] 窑内总吨位
  DATA.kilns.forEach(function (k) {
    load[k.id] = new Array(n).fill(0);
  });
  cars.forEach(function (c) {
    for (var i = 0; i < n; i++) {
      if (recTimes[i] >= c.times.preheat && recTimes[i] < c.times.exit) load[c.kiln][i] += c.mass;
    }
  });
  var reg = {};
  DATA.kilns.forEach(function (k) {
    var sx = 0, sy = 0, sxx = 0, sxy = 0, m = n;
    for (var i = 0; i < n; i++) {
      var x = load[k.id][i] * zoneTemp[k.id].firing[i] / 1270;
      var y = kilnGas[k.id][i];
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    var a = (m * sxy - sx * sy) / (m * sxx - sx * sx);
    var b = (sy - a * sx) / m;
    if (!isFinite(a) || a < 0) a = 0;
    if (!isFinite(b) || b < 0) b = 0;
    reg[k.id] = { a: a, b: b };
  });
  function scenGasSeries(kid, tsetMap) {
    var tset = tsetMap[kid];
    var arr = new Array(n);
    for (var i = 0; i < n; i++) arr[i] = reg[kid].b + reg[kid].a * load[kid][i] * tset / 1270;
    return arr;
  }
  function scenTotal(tsetMap) {
    var s = 0;
    DATA.kilns.forEach(function (k) {
      var ser = scenGasSeries(k.id, tsetMap);
      for (var i = 0; i < n; i++) s += ser[i] * stepH;
    });
    return s;
  }
  var kilnMeanFire = {};
  DATA.kilns.forEach(function (k) {
    var arr = zoneTemp[k.id].firing, s = 0;
    for (var i = 0; i < n; i++) s += arr[i];
    kilnMeanFire[k.id] = s / n;
  });
  function qualified(car, tsetMap) {
    if (car.rampBad) return false;
    var shift = tsetMap[car.kiln] - kilnMeanFire[car.kiln];
    var adjPeak = car.peakFire + shift;
    var adjMean = car.meanFire + shift;
    return adjMean >= car.glazeWindow.fire_min && adjPeak <= car.glazeWindow.fire_max;
  }
  function scenSummary(tsetMap) {
    var gas = scenTotal(tsetMap);
    var qCars = cars.filter(function (c) { return qualified(c, tsetMap); });
    var qTons = qCars.reduce(function (s, c) { return s + c.mass; }, 0);
    return { gas: gas, cars: qCars, count: qCars.length, tons: qTons, unit: qTons ? gas / qTons : 0 };
  }
  var scenA = scenSummary(pc.scenario_a_firing_set);
  var scenB = scenSummary(pc.scenario_b_firing_set);
  var inA = {}, inB = {};
  scenA.cars.forEach(function (c) { inA[c.id] = true; });
  scenB.cars.forEach(function (c) { inB[c.id] = true; });
  var onlyA = cars.filter(function (c) { return inA[c.id] && !inB[c.id]; }).map(function (c) { return c.id; });
  var onlyB = cars.filter(function (c) { return !inA[c.id] && inB[c.id]; }).map(function (c) { return c.id; });

  return {
    DATA: DATA, pc: pc, n: n, recTimes: recTimes, t0: t0, stepMin: stepMin, stepH: stepH,
    zoneTemp: zoneTemp, tcReport: cleaned.report,
    cars: cars, carById: carById, jams: jams,
    flameouts: flameouts, ratioBad: ratioBad,
    maxFlowEvents: maxFlowEvents,
    kilnGas: kilnGas, kilnMaxGas: kilnMaxGas,
    gasByKilnZone: gasByKilnZone, totalGas: totalGas,
    totalTons: totalTons, unit: totalGas / totalTons,
    scenA: scenA, scenB: scenB, onlyA: onlyA, onlyB: onlyB,
    scenGasSeries: scenGasSeries, tempAt: tempAt,
    glazeOf: glazeOf, massOf: massOf,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildModel: buildModel };

// ================= 界面 =================
function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

var state = { kiln: 'K1', carId: null, showGas: false, densityOverride: {}, sortKey: 'id', sortDir: 1 };
var model = null;
var DATA = null;

function rebuild() {
  model = buildModel(DATA, state.densityOverride);
  renderHeader();
  renderKpis();
  renderAnomalies();
  renderScenarios();
  renderCarTable();
  renderDetail();
  drawChart();
}

function renderHeader() {
  var mm = model.cars.filter(function (c) { return c.glazeMismatch; });
  document.getElementById('datarule').innerHTML =
    '<b>数据口径：</b>釉种与装车制品对不上时，<b>以装车制品为准</b>，釉种按制品所属釉类修正后再判定（涉及 ' +
    mm.map(function (c) { return '<b>' + c.id + '</b>'; }).join('、') + ' 共 ' + mm.length + ' 台）。' +
    ' 数据窗口 ' + fmtT(DATA.meta.start) + ' 起 72h，每 ' + DATA.meta.step_min + ' 分钟一刻。';
  var segs = 0;
  var txt = model.tcReport.map(function (r) {
    segs += r.segments.length;
    return r.tc + '（' + r.segments.length + ' 段）';
  }).join('、');
  document.getElementById('tcreport').innerHTML =
    '<b>热电偶坏点：</b>三号窑两支热电偶读数平在 1200℃ 不动（' + (txt || '无') +
    '），按坏点剔除，共剔除 <b>' + segs + '</b> 段；剔除时段带温由同带其余热电偶平均，曲线连续。';
}

function renderKpis() {
  var rampN = model.cars.filter(function (c) { return c.rampBad; }).length;
  var tempN = model.cars.filter(function (c) { return c.tempBad; }).length;
  var kpis = [
    [num(model.totalGas, 0), '燃气总量 m³（三窑·分带累加）'],
    [num(model.totalTons, 1), '装车总吨位 t'],
    [num(model.unit, 1), '实测燃气单耗 m³/t'],
    [rampN, '升温速率越限车数'],
    [tempN, '烧成温度越限车数'],
    [model.flameouts.length, '熄火时段（段）'],
    [model.jams.length, '推进卡堵（次）'],
  ];
  var box = document.getElementById('kpis');
  box.innerHTML = '';
  kpis.forEach(function (k) {
    box.appendChild(el('div', 'kpi', '<div class="v">' + k[0] + '</div><div class="l">' + k[1] + '</div>'));
  });
}

function anomBlock(title, count, itemsHtml) {
  var body = itemsHtml.length
    ? '<ul>' + itemsHtml.map(function (h) { return '<li>' + h + '</li>'; }).join('') + '</ul>'
    : '<div class="empty">无</div>';
  return '<div class="anom"><h3>' + title + ' <span class="cnt">' + (count || '') + '</span></h3>' + body + '</div>';
}

function renderAnomalies() {
  var m = model, pc = m.pc;
  var recTime = function (i) { return fmtT(m.DATA.records[m.DATA.kilns[0].id][i].t); };

  var ramp = m.cars.filter(function (c) { return c.rampBad; }).map(function (c) {
    return '<b>' + c.id + '</b>（' + c.kiln + '）升温 ' + num(c.ramp, 2) + ' ℃/min，' +
      (c.rampBad.over ? '超上限 +' : '低于下限 −') + num(c.rampBad.excess, 2) + ' ℃/min';
  });
  var temp = m.cars.filter(function (c) { return c.tempBad; }).map(function (c) {
    var w = c.glazeWindow;
    return '<b>' + c.id + '</b>（' + c.kiln + '·' + w.name + ' ' + w.fire_min + '–' + w.fire_max + '℃）' +
      (c.tempBad.over
        ? '峰值 ' + num(c.peakFire, 0) + '℃，超上限 +' + num(c.tempBad.excess, 0) + '℃（过烧起泡风险）'
        : '烧成带均温 ' + num(c.meanFire, 0) + '℃，欠下限 −' + num(c.tempBad.excess, 0) + '℃（欠烧发暗风险）');
  });
  var maxf = m.maxFlowEvents.map(function (e) {
    var kilns = Object.entries(e.verdict).map(function ([kid, v]) {
      return kid + '：' + (v.high ? '<span class="tag bad">负荷真高</span>' : '<span class="tag info">燃烧器开度没退</span>') +
        '（烧成带负荷 ' + num(v.load, 1) + 't，负荷率 ' + num(v.factor * 100, 0) + '%）';
    }).join('；');
    return recTime(e.from) + ' ~ ' + recTime(e.to) + '，' + Object.keys(e.kilns).join('、') + ' 同顶最大流量。<br>' + kilns;
  });
  var fo = m.flameouts.map(function (f) {
    return '<b>' + f.burner + '</b>（' + f.kiln + '·' + ZONE_NAMES[f.zone] + '）' + recTime(f.from) + ' ~ ' + recTime(f.to) +
      '，助燃风为 0 而燃气照走，白烧燃气 ' + num(f.gas, 1) + ' m³';
  });
  var rb = m.ratioBad.map(function (r) {
    return '<b>' + r.burner + '</b>（' + r.kiln + '·' + ZONE_NAMES[r.zone] + '）' + recTime(r.from) + ' ~ ' + recTime(r.to) +
      '，风燃比 ' + num(r.min, 1) + '–' + num(r.max, 1) + '（合理 ' + pc.air_gas_ratio_min + '–' + pc.air_gas_ratio_max + '）';
  });
  var jam = m.jams.map(function (j) {
    return '<b>' + j.blocked + '</b>（' + j.kiln + '）被前车 <b>' + j.blocker + '</b> 卡住，堵了 <b>' + j.slots + '</b> 格（' + fmtT(j.at) + ' 才推进）';
  });
  var mm = m.cars.filter(function (c) { return c.glazeMismatch; }).map(function (c) {
    return '<b>' + c.id + '</b>（' + c.kiln + '）制品「' + c.product + '」记釉 ' + c.glazeRec +
      ' → 以制品为准，定釉 <b>' + c.glaze + '</b>（' + c.glazeWindow.name + '）';
  });

  document.getElementById('anomalies').innerHTML =
    anomBlock('① 进烧成带升温速率越出工艺卡（' + pc.ramp_rate_min + '–' + pc.ramp_rate_max + ' ℃/min）', ramp.length, ramp) +
    anomBlock('② 釉种烧成温度越限', temp.length, temp) +
    anomBlock('③ 两座以上窑同顶最大燃气流量', maxf.length, maxf) +
    anomBlock('④ 窑车推进被前车卡住', jam.length, jam) +
    anomBlock('燃烧器熄火（风停气走，单列）', fo.length, fo) +
    anomBlock('风燃比失调时段（逐燃烧器，不做全窑平均）', rb.length, rb) +
    anomBlock('釉种与制品不符（以制品为准）', mm.length, mm);
}

function renderScenarios() {
  var m = model, pc = m.pc;
  function setTxt(map) {
    return Object.entries(map).map(function ([k, v]) { return k + ' ' + v + '℃'; }).join('，');
  }
  function row(label, s, setMap) {
    return '<tr><td>' + label + '<br><span class="hint">' + setTxt(setMap) + '</span></td>' +
      '<td class="num">' + s.count + ' / 120</td>' +
      '<td class="num">' + num(s.tons, 1) + '</td>' +
      '<td class="num">' + num(s.gas, 0) + '</td>' +
      '<td class="num">' + num(s.unit, 1) + '</td></tr>';
  }
  var html = '<table class="scen-table"><tr><th>运行口径</th><th class="num">合格窑车</th><th class="num">合格吨位 t</th><th class="num">燃气总量 m³</th><th class="num">单耗 m³/t</th></tr>' +
    row('口径一：贴紧工艺卡（宁多烧气）', m.scenA, pc.scenario_a_firing_set) +
    row('口径二：单耗最小（窗口内跑低）', m.scenB, pc.scenario_b_firing_set) +
    '<tr><td>实测（台账记录）</td><td class="num">—</td><td class="num">' + num(m.totalTons, 1) + '</td><td class="num">' + num(m.totalGas, 0) + '</td><td class="num">' + num(m.unit, 1) + '</td></tr>' +
    '</table>';
  html += '<h3 style="margin:10px 0 4px">实测燃气分带累加（m³）</h3><table class="scen-table"><tr><th>窑</th><th class="num">预热带</th><th class="num">烧成带</th><th class="num">冷却带</th><th class="num">合计</th></tr>' +
    m.DATA.kilns.map(function (k) {
      var g = m.gasByKilnZone[k.id];
      var sum = g.preheat + g.firing + g.cooling;
      return '<tr><td>' + k.name + '（' + k.id + '）</td><td class="num">' + num(g.preheat, 0) + '</td><td class="num">' + num(g.firing, 0) + '</td><td class="num">' + num(g.cooling, 0) + '</td><td class="num"><b>' + num(sum, 0) + '</b></td></tr>';
    }).join('') + '</table>';
  html += '<div class="diff-ids"><b>仅口径一合格（口径二跑低烧不熟）：</b>' + (m.onlyA.join('、') || '无') + '</div>';
  html += '<div class="diff-ids"><b>仅口径二合格（口径一温度高过烧）：</b>' + (m.onlyB.join('、') || '无') + '</div>';
  html += '<div class="hint" style="margin-top:6px">口径燃气 = 各窑按「负荷回归系数 × 窑内吨位 × 口径设定温度」逐刻重算；合格判定含升温速率与釉种温度窗（过烧看峰值、欠烧看均温）。</div>';
  document.getElementById('scenarios').innerHTML = html;
}

function qualTag(ok) { return ok ? '<span class="tag ok">合格</span>' : '<span class="tag bad">不合格</span>'; }

function renderCarTable() {
  var m = model;
  var cols = [
    ['id', '车号'], ['kiln', '窑'], ['product', '制品'], ['glazeRec', '釉(记)'], ['glaze', '釉(定)'],
    ['density', '密度档'], ['mass', '吨位 t'], ['push', '推进时刻'], ['ramp', '升温℃/min'],
    ['peakFire', '峰值℃'], ['meanFire', '烧成均温℃'], ['judge', '实测判定'], ['qa', '口径一'], ['qb', '口径二'],
  ];
  var cars = m.cars.slice().sort(function (a, b) {
    var k = state.sortKey, va, vb;
    if (k === 'push') { va = a.times.preheat; vb = b.times.preheat; }
    else { va = a[k]; vb = b[k]; }
    if (va === undefined) va = ''; if (vb === undefined) vb = '';
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.sortDir;
  });
  var inA = {}, inB = {};
  m.scenA.cars.forEach(function (c) { inA[c.id] = true; });
  m.scenB.cars.forEach(function (c) { inB[c.id] = true; });
  var html = '<tr>' + cols.map(function (c) {
    var arrow = state.sortKey === c[0] ? (state.sortDir > 0 ? ' ▲' : ' ▼') : '';
    return '<th data-k="' + c[0] + '">' + c[1] + arrow + '</th>';
  }).join('') + '</tr>';
  cars.forEach(function (c) {
    var bad = c.rampBad || c.tempBad;
    var curD = state.densityOverride[c.id] || c.density;
    html += '<tr data-id="' + c.id + '"' + (c.id === state.carId ? ' class="sel"' : '') + '>' +
      '<td><b>' + c.id + '</b></td><td>' + c.kiln + '</td><td>' + c.product + '</td>' +
      '<td' + (c.glazeMismatch ? ' class="bad"' : '') + '>' + c.glazeRec + '</td><td>' + c.glaze + '</td>' +
      '<td><select class="dens" data-id="' + c.id + '">' + [1, 2, 3].map(function (d) {
        return '<option value="' + d + '"' + (d === curD ? ' selected' : '') + '>' + d + '</option>';
      }).join('') + '</select></td>' +
      '<td>' + num(c.mass, 2) + '</td><td>' + fmtT(c.raw.push_time) + '</td>' +
      '<td' + (c.rampBad ? ' class="bad"' : '') + '>' + num(c.ramp, 2) + '</td>' +
      '<td' + (c.tempBad && c.tempBad.over ? ' class="bad"' : '') + '>' + num(c.peakFire, 0) + '</td>' +
      '<td' + (c.tempBad && !c.tempBad.over ? ' class="bad"' : '') + '>' + num(c.meanFire, 0) + '</td>' +
      '<td>' + (bad ? '<span class="tag bad">越限</span>' : '<span class="tag ok">正常</span>') + '</td>' +
      '<td>' + qualTag(!!inA[c.id]) + '</td><td>' + qualTag(!!inB[c.id]) + '</td></tr>';
  });
  var tbl = document.getElementById('carTable');
  tbl.innerHTML = html;
  tbl.querySelectorAll('th').forEach(function (th) {
    th.onclick = function () {
      var k = th.getAttribute('data-k');
      if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = 1; }
      renderCarTable();
    };
  });
  tbl.querySelectorAll('tr[data-id]').forEach(function (tr) {
    tr.onclick = function (e) {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
      state.carId = tr.getAttribute('data-id');
      state.kiln = model.carById[state.carId].kiln;
      document.getElementById('kilnSel').value = state.kiln;
      renderCarTable(); renderDetail(); drawChart();
    };
  });
  tbl.querySelectorAll('select.dens').forEach(function (sel) {
    sel.onchange = function () {
      var id = sel.getAttribute('data-id');
      var v = parseInt(sel.value, 10);
      if (v === model.carById[id].raw.density) delete state.densityOverride[id];
      else state.densityOverride[id] = v;
      rebuild();
    };
  });
}

function renderDetail() {
  var panel = document.getElementById('detailPanel');
  if (!state.carId) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  var c = model.carById[state.carId];
  var k = model.DATA.kilns.filter(function (x) { return x.id === c.kiln; })[0];
  document.getElementById('detailTitle').textContent =
    '窑车 ' + c.id + '（' + c.kiln + '·' + c.product + '·' + c.glaze + ' ' + c.glazeWindow.name + '）';
  var rows = [['preheat', '进预热带'], ['firing', '进烧成带'], ['cooling', '进冷却带'], ['exit', '出窑']];
  var verify = '<table><tr><th>到带点</th><th>按推进时刻+各带时长算</th><th>台账记录</th><th>差值</th><th>核验</th></tr>';
  rows.forEach(function (r) {
    var calc = c.times[r[0]];
    var rec = c.raw.zone_times_recorded[r[0]];
    var diff = (Date.parse(rec) - calc) / 60000;
    var bad = Math.abs(diff) > 10;
    verify += '<tr><td>' + r[1] + '</td><td>' + fmtMs(calc) + '</td><td>' + fmtT(rec) + '</td>' +
      '<td class="' + (bad ? 'bad' : 'ok') + '">' + fmtMin(diff) + '</td>' +
      '<td>' + (bad ? '<span class="tag bad">差过10min·不认</span>' : '<span class="tag ok">相符</span>') + '</td></tr>';
  });
  verify += '</table>';
  var dwell = '<table><tr><th>带</th><th>带长 m</th><th>停留时长</th><th>允许温度℃</th></tr>' +
    ZONE_KEYS.map(function (z) {
      var zn = k.zones[z];
      return '<tr><td>' + ZONE_NAMES[z] + '</td><td>' + zn.length_m + '</td><td>' + fmtDur(c.dur[z]) + '</td>' +
        '<td>' + zn.temp_min + '–' + zn.temp_max + '</td></tr>';
    }).join('') + '</table>';
  var info = '<table><tr><th>项目</th><th>值</th></tr>' +
    '<tr><td>进烧成带升温速率</td><td class="' + (c.rampBad ? 'bad' : '') + '">' + num(c.ramp, 2) + ' ℃/min（窗口 ' + model.pc.ramp_rate_min + '–' + model.pc.ramp_rate_max + '）</td></tr>' +
    '<tr><td>烧成带峰值 / 均温</td><td>' + num(c.peakFire, 0) + ' / ' + num(c.meanFire, 0) + ' ℃</td></tr>' +
    '<tr><td>釉种温度窗</td><td>' + c.glazeWindow.fire_min + '–' + c.glazeWindow.fire_max + ' ℃（' + c.glazeWindow.name + '）</td></tr>' +
    '<tr><td>装车密度档 / 吨位</td><td>' + (state.densityOverride[c.id] || c.density) + ' 档 / ' + num(c.mass, 2) + ' t</td></tr>' +
    '<tr><td>总停留</td><td>' + fmtDur(c.dur.preheat + c.dur.firing + c.dur.cooling) + '</td></tr></table>';
  document.getElementById('detailBody').innerHTML =
    '<div class="detail-grid"><div><h3 style="margin-bottom:6px">到带时刻核验（计算 vs 台账）</h3>' + verify + '</div>' +
    '<div><h3 style="margin-bottom:6px">各带停留与经历</h3>' + dwell + info + '</div></div>';
}

// ---------------- 图表 ----------------
var ZONE_COLORS = { preheat: '#e8912d', firing: '#d43d3d', cooling: '#2d7dd2' };
function drawChart() {
  var cv = document.getElementById('chart');
  var ctx = cv.getContext('2d');
  var W = cv.width, H = cv.height;
  var ML = 55, MR = 60, MT = 15, MB = 32;
  var pw = W - ML - MR, ph = H - MT - MB;
  ctx.clearRect(0, 0, W, H);
  var m = model;
  var t0 = m.recTimes[0], t1 = m.recTimes[m.n - 1];
  var X = function (t) { return ML + (t - t0) / (t1 - t0) * pw; };
  var TMAX = 1400;
  var Y = function (t) { return MT + (1 - t / TMAX) * ph; };
  var kid = state.kiln;
  var kmax = m.kilnMaxGas[kid] * 1.1;
  var YG = function (g) { return MT + (1 - g / kmax) * ph; };

  ctx.strokeStyle = '#e5e7eb'; ctx.fillStyle = '#6b7280'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (var h = 0; h <= 72; h += 12) {
    var x = X(t0 + h * 3600000);
    ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
    ctx.fillText(fmtMs(t0 + h * 3600000), x - 24, H - 10);
  }
  for (var tt = 0; tt <= TMAX; tt += 200) {
    var y = Y(tt);
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
    ctx.fillText(tt + '℃', 12, y + 4);
  }

  // 选中窑车的釉种温度窗
  var car = state.carId ? m.carById[state.carId] : null;
  if (car) {
    ctx.fillStyle = 'rgba(212,61,61,0.07)';
    ctx.fillRect(ML, Y(car.glazeWindow.fire_max), pw, Y(car.glazeWindow.fire_min) - Y(car.glazeWindow.fire_max));
  }

  // 三带曲线
  ZONE_KEYS.forEach(function (z) {
    ctx.strokeStyle = ZONE_COLORS[z]; ctx.lineWidth = 1.6;
    ctx.beginPath();
    var arr = m.zoneTemp[kid][z];
    for (var i = 0; i < m.n; i++) {
      var x = X(m.recTimes[i]), y = Y(arr[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  // 燃气曲线（右轴）
  if (state.showGas) {
    var kg = m.kilnGas[kid];
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (var i2 = 0; i2 < m.n; i2++) { var x2 = X(m.recTimes[i2]), y2 = YG(kg[i2]); if (i2 === 0) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2); }
    ctx.stroke();
    [['scenA', '#1a5fb4'], ['scenB', '#157347']].forEach(function (sc) {
      var ser = m.scenGasSeries(kid, m.pc[sc[0] === 'scenA' ? 'scenario_a_firing_set' : 'scenario_b_firing_set']);
      ctx.strokeStyle = sc[1]; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (var i3 = 0; i3 < m.n; i3++) { var x3 = X(m.recTimes[i3]), y3 = YG(ser[i3]); if (i3 === 0) ctx.moveTo(x3, y3); else ctx.lineTo(x3, y3); }
      ctx.stroke(); ctx.setLineDash([]);
    });
    ctx.fillStyle = '#555';
    ctx.fillText('燃气 m³/h', W - MR + 6, MT + 8);
    ctx.fillText(num(kmax, 0), W - MR + 6, YG(kmax) + 12);
    ctx.fillText('0', W - MR + 6, YG(0));
  }

  // 选中窑车：经历温度曲线 + 到带线
  if (car && car.kiln === kid) {
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2.4;
    ctx.beginPath();
    var started = false;
    for (var i4 = 0; i4 < m.n; i4++) {
      var t = m.recTimes[i4];
      if (t < car.times.preheat || t > car.times.exit) { started = false; continue; }
      var zone = t < car.times.firing ? 'preheat' : t < car.times.cooling ? 'firing' : 'cooling';
      var v = m.zoneTemp[kid][zone][i4];
      var x4 = X(t), y4 = Y(v);
      if (!started) { ctx.moveTo(x4, y4); started = true; } else ctx.lineTo(x4, y4);
    }
    ctx.stroke();
    [['preheat', '进预热'], ['firing', '进烧成'], ['cooling', '进冷却'], ['exit', '出窑']].forEach(function (mk) {
      var x5 = X(car.times[mk[0]]);
      ctx.strokeStyle = '#8a5cf6'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x5, MT); ctx.lineTo(x5, MT + ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#8a5cf6';
      ctx.fillText(mk[1], x5 - 20, MT + 10);
    });
  }

  // 图例
  var lg = document.getElementById('legend');
  var items = [['预热带', ZONE_COLORS.preheat], ['烧成带', ZONE_COLORS.firing], ['冷却带', ZONE_COLORS.cooling]];
  if (state.showGas) items.push(['实测燃气', '#555'], ['口径一燃气', '#1a5fb4'], ['口径二燃气', '#157347']);
  if (car) items.push(['窑车 ' + car.id + ' 经历温度', '#111']);
  lg.innerHTML = items.map(function (it) {
    return '<span><i style="background:' + it[1] + '"></i>' + it[0] + '</span>';
  }).join('');
  document.getElementById('chartHint').textContent = car
    ? '已选 ' + car.id + '：黑线为其 72h 经历温度，紫线为到带时刻'
    : '点下方台账行可叠加窑车经历温度';
}

function initUI() {
  DATA = window.KILN_DATA;
  var q = new URLSearchParams(location.search);
  if (q.get('kiln') && DATA.kilns.some(function (k) { return k.id === q.get('kiln'); })) state.kiln = q.get('kiln');
  if (q.get('car') && DATA.cars.some(function (c) { return c.id === q.get('car'); })) {
    state.carId = q.get('car');
    state.kiln = DATA.cars.filter(function (c) { return c.id === state.carId; })[0].kiln;
  }
  if (q.get('gas') === '1') state.showGas = true;
  var sel = document.getElementById('kilnSel');
  sel.innerHTML = DATA.kilns.map(function (k) {
    return '<option value="' + k.id + '">' + k.name + '（' + k.id + '）</option>';
  }).join('');
  sel.value = state.kiln;
  sel.onchange = function () { state.kiln = sel.value; drawChart(); };
  var gasBox = document.getElementById('showGas');
  gasBox.checked = state.showGas;
  gasBox.onchange = function (e) { state.showGas = e.target.checked; drawChart(); };
  rebuild();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
  else initUI();
}

})(typeof window !== 'undefined' ? window : globalThis);
