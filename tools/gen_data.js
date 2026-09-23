// 生成 data/kiln.json 与 data/kiln.js（供 file:// 直接打开页面用）
// 用法: node tools/gen_data.js
// 确定性伪随机，重复运行结果一致。
const fs = require('fs');
const path = require('path');

let seed = 20260923;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function jitter(amp) { return (rnd() * 2 - 1) * amp; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

const START = Date.UTC(2026, 8, 20, 8, 0, 0);
const STEP_MIN = 15;
const N_REC = 288;
function iso(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00+08:00`;
}

const GLAZES = {
  'GL-Q': { name: '青釉', fire_min: 1240, fire_max: 1280, products: ['碗', '盘'] },
  'GL-B': { name: '白釉', fire_min: 1220, fire_max: 1270, products: ['杯', '碟'] },
  'GL-H': { name: '黑釉', fire_min: 1250, fire_max: 1300, products: ['瓶', '罐'] },
  'GL-C': { name: '彩釉', fire_min: 1210, fire_max: 1260, products: ['摆件', '花瓶'] },
};
const KILN_GLAZES = { K1: ['GL-Q', 'GL-H'], K2: ['GL-B', 'GL-C'], K3: ['GL-Q', 'GL-H'] };

function mkKiln(id, name, interval, len, burners) {
  const tcs = [];
  const zones = ['preheat', 'preheat', 'firing', 'firing', 'firing', 'cooling', 'cooling'];
  zones.forEach((z, i) => tcs.push({ id: id + '-T' + (i + 1), zone: z }));
  return {
    id, name, car_length_m: 2.2, push_interval_min: interval,
    zones: {
      preheat: { name: '预热带', length_m: len[0], temp_min: 200, temp_max: 950 },
      firing: { name: '烧成带', length_m: len[1], temp_min: 950, temp_max: 1300 },
      cooling: { name: '冷却带', length_m: len[2], temp_min: 80, temp_max: 700 },
    },
    thermocouples: tcs,
    burners: burners.map((b, i) => ({ id: id + '-B' + (i + 1), zone: b[0], max_gas: b[1] })),
  };
}

const kilns = [
  mkKiln('K1', '一号窑', 45, [24, 30, 18], [['preheat', 90], ['preheat', 90], ['firing', 130], ['firing', 130], ['firing', 120], ['cooling', 40]]),
  mkKiln('K2', '二号窑', 50, [22, 32, 20], [['preheat', 85], ['preheat', 85], ['firing', 125], ['firing', 125], ['firing', 115], ['cooling', 40]]),
  mkKiln('K3', '三号窑', 55, [20, 30, 18], [['preheat', 95], ['preheat', 95], ['firing', 135], ['firing', 135], ['firing', 125], ['cooling', 40]]),
];
const kilnById = Object.fromEntries(kilns.map((k) => [k.id, k]));

// ---------- 窑车台账（先生成， records 的燃气要挂负荷） ----------
const cars = [];
let carNo = 0;
const mismatchCars = [];
const ledgerErrorCars = [];
const jamPlan = { K1: { after: 14, extra: 3 }, K2: { after: 27, extra: 2 }, K3: { after: 8, extra: 2 } };
for (const k of kilns) {
  const speed = k.car_length_m / k.push_interval_min;
  const z = k.zones;
  const durs = {
    preheat: z.preheat.length_m / speed,
    firing: z.firing.length_m / speed,
    cooling: z.cooling.length_m / speed,
  };
  const firstPush = START + (k.id === 'K1' ? 120 : k.id === 'K2' ? 180 : 90) * 60000;
  let pushT = firstPush;
  for (let i = 0; i < 40; i++) {
    carNo += 1;
    const id = 'C' + String(carNo).padStart(3, '0');
    if (i > 0) {
      pushT += k.push_interval_min * 60000 + jitter(4) * 60000;
      const jam = jamPlan[k.id];
      if (jam && i === jam.after + 1) pushT += jam.extra * k.push_interval_min * 60000;
    }
    const pool = KILN_GLAZES[k.id];
    const glazeId = pick(pool);
    const glaze = GLAZES[glazeId];
    const product = pick(glaze.products);
    let recGlaze = glazeId;
    if (i === 5 || i === 22) {
      const others = Object.keys(GLAZES).filter((g) => !GLAZES[g].products.includes(product));
      recGlaze = pick(others);
      mismatchCars.push(id);
    }
    const density = 1 + Math.floor(rnd() * 3);
    const entry = pushT;
    const rec = {
      preheat: entry + jitter(3) * 60000,
      firing: entry + durs.preheat * 60000 + jitter(4) * 60000,
      cooling: entry + (durs.preheat + durs.firing) * 60000 + jitter(4) * 60000,
      exit: entry + (durs.preheat + durs.firing + durs.cooling) * 60000 + jitter(5) * 60000,
    };
    if ((k.id === 'K1' && i === 9) || (k.id === 'K2' && i === 17) || (k.id === 'K3' && i === 31)) {
      rec.firing += (15 + rnd() * 10) * 60000;
      ledgerErrorCars.push(id);
    }
    cars.push({
      id, kiln: k.id, product, glaze: recGlaze, density,
      push_time: iso(pushT),
      zone_times_recorded: {
        preheat: iso(rec.preheat), firing: iso(rec.firing),
        cooling: iso(rec.cooling), exit: iso(rec.exit),
      },
    });
  }
}

// 各窑逐刻窑内负荷（吨）
const MASS = { 1: 0.9, 2: 1.15, 3: 1.4 };
function kilnLoadAt(kid, t) {
  const k = kilnById[kid];
  const speed = k.car_length_m / k.push_interval_min;
  const totalMin = (k.zones.preheat.length_m + k.zones.firing.length_m + k.zones.cooling.length_m) / speed;
  let s = 0;
  for (const c of cars) {
    if (c.kiln !== kid) continue;
    const p = Date.parse(c.push_time);
    if (t >= p && t < p + totalMin * 60000) s += MASS[c.density];
  }
  return s;
}
const RATED_LOAD = { K1: 37, K2: 35, K3: 34 };

// ---------- 温度与燃气逐刻记录 ----------
function setpoint(kilnId, zone, h) {
  if (zone === 'preheat') return 560 + 90 * Math.sin(h / 9 + (kilnId === 'K2' ? 1 : 2)) + 30 * Math.sin(h / 3.7);
  if (zone === 'cooling') return 380 + 180 * Math.sin(h / 11 + 1) + 25 * Math.sin(h / 4.3);
  if (kilnId === 'K1') {
    let t = 1258 + 10 * Math.sin(h / 6);
    if (h >= 34 && h <= 40) t += 55 * Math.sin(((h - 34) / 6) * Math.PI); // 超温段 → 起泡
    return t;
  }
  if (kilnId === 'K2') {
    let t = 1252 + 9 * Math.sin(h / 7 + 1);
    if (h >= 44 && h <= 52) t -= 48 * Math.sin(((h - 44) / 8) * Math.PI); // 低温段 → 发暗
    return t;
  }
  return 1260 + 8 * Math.sin(h / 8 + 2);
}

// 顶最大燃气窗口：K1 满负荷段（负荷真高）；K2/K3 低负荷段（开度没退）
function maxGasWindow(kilnId, h) {
  if (kilnId === 'K1' && h >= 34 && h <= 40) return true;
  if (kilnId === 'K2' && h >= 6 && h <= 10) return true;
  if (kilnId === 'K3' && h >= 6.5 && h <= 10.5) return true;
  if (kilnId === 'K3' && h >= 35 && h <= 39) return true;
  return false;
}

function gasDemand(kilnId, zone, h, loadF) {
  if (maxGasWindow(kilnId, h)) {
    const b = zone === 'cooling' ? 0.75 : 0.98;
    return Math.min(1, Math.max(0.05, b + jitter(0.02))); // 开度不退，不随负荷调
  }
  let base;
  if (zone === 'preheat') base = 0.55 + 0.1 * Math.sin(h / 5);
  else if (zone === 'cooling') base = 0.3 + 0.08 * Math.sin(h / 6 + 1);
  else base = 0.68 + 0.1 * Math.sin(h / 6.5);
  if (kilnId === 'K2' && h >= 44 && h <= 52 && zone === 'firing') base = 0.9;
  const g = base * (0.55 + 0.65 * loadF) + jitter(0.03);
  return Math.min(1, Math.max(0.05, g));
}

const records = {};
for (const k of kilns) {
  const arr = [];
  for (let i = 0; i < N_REC; i++) {
    const t = START + i * STEP_MIN * 60000;
    const h = (i * STEP_MIN) / 60;
    const loadF = Math.min(1, kilnLoadAt(k.id, t) / RATED_LOAD[k.id]);
    const temps = {};
    for (const tc of k.thermocouples) {
      const off = (parseInt(tc.id.slice(-1), 10) - 4) * 2.2;
      temps[tc.id] = +(setpoint(k.id, tc.zone, h) + off + jitter(2.5)).toFixed(1);
    }
    if (k.id === 'K3') {
      if (i >= 120 && i <= 180) temps['K3-T3'] = 1200.0;
      if ((i >= 130 && i <= 150) || (i >= 200 && i <= 220)) temps['K3-T5'] = 1200.0;
    }
    const burners = {};
    for (const b of k.burners) {
      let gas = +(gasDemand(k.id, b.zone, h, loadF) * b.max_gas).toFixed(1);
      let ratio = 11 + jitter(1.1);
      let flameout = false;
      if (k.id === 'K2' && b.id === 'K2-B4' && i >= 150 && i <= 155) flameout = true;
      if (k.id === 'K1' && b.id === 'K1-B2' && i >= 60 && i <= 63) flameout = true;
      if (k.id === 'K3' && b.id === 'K3-B3' && i >= 90 && i <= 110) ratio = 15.6 + jitter(0.4);
      if (k.id === 'K1' && b.id === 'K1-B5' && i >= 210 && i <= 230) ratio = 7.4 + jitter(0.3);
      if (flameout) gas = +(gas * 0.45).toFixed(1);
      const air = flameout ? 0 : +(gas * ratio).toFixed(1);
      burners[b.id] = { gas, air };
    }
    arr.push({ t: iso(t), temps, burners });
  }
  records[k.id] = arr;
}

const data = {
  meta: { title: '隧道窑烧成曲线与燃气单耗核算', start: iso(START), step_min: STEP_MIN, hours: 72, generated_at: iso(Date.now()) },
  process_card: {
    ramp_rate_min: 1.1, ramp_rate_max: 1.6,
    air_gas_ratio_min: 9.0, air_gas_ratio_max: 13.5,
    density_mass_t: MASS,
    scenario_a_firing_set: { K1: 1270, K2: 1255, K3: 1270 }, scenario_b_firing_set: { K1: 1248, K2: 1225, K3: 1248 },
    glazes: GLAZES,
  },
  kilns, cars, records,
};

const outDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(outDir, { recursive: true });
const json = JSON.stringify(data);
fs.writeFileSync(path.join(outDir, 'kiln.json'), json);
fs.writeFileSync(path.join(outDir, 'kiln.js'), 'window.KILN_DATA=' + json + ';\n');
console.log('kiln.json bytes:', json.length);
console.log('cars:', cars.length, 'mismatch:', mismatchCars.join(','), 'ledgerErr:', ledgerErrorCars.join(','));
