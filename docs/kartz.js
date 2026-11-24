
const KZ = { budget: 64, perImage: 2, perRequest: 8, rank: [0.00, 0.20], text: [0.36, 0.92] };
const kzImg = src => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });

let kzSampling = null;
function kzSample(f) {
  if (kzSampling && kzSampling.file === f) return kzSampling.promise;
  const job = { file: f, t0: Date.now() };
  kzSampling = job;
  const note = m => { if (kzSampling === job && !$('go').disabled) log(m); };
  note('reading the recording…');
  job.promise = (async () => {
    let frames;
    const prog = p => note(`reading the recording… ${Math.round(p * 100)}%`);
    try {
      frames = await dcExtract(f, KZ.budget, prog);
    } catch (e) {
      job.why = e.message;
      if (/no WebCodecs|cannot decode/.test(e.message)) frames = null;
      else frames = await dcExtract(f, KZ.budget, prog, true).catch(e2 => { job.why = e2.message; return null; });
      if (!frames) {
        frames = await extractFrames(f, KZ.budget, prog, 1);
        frames.mode = extractFrames.mode;
      }
    }
    if (!frames.length) throw new Error('no frames could be taken from this recording');
    job.secs = (Date.now() - job.t0) / 1000;
    job.mode = frames.mode;
    const how = frames.mode === 'decoded' ? 'fast route'
      : `slower route${job.why ? ' — ' + job.why : ''}`;
    if (frames.detail) console.log('[kartz] ' + frames.detail);
    note(`recording read (${frames.length} frames, ${job.secs.toFixed(1)}s, ${how}) — ready to Extract`);
    return frames;
  })();
  job.promise.catch(e => note('✗ ' + e.message));
  return job.promise;
}

async function kzPack(frames) {
  const imgs = await Promise.all(frames.map(b => kzImg('data:image/jpeg;base64,' + b)));
  const w = imgs[0].naturalWidth, h = imgs[0].naturalHeight;
  const rx0 = Math.round(KZ.rank[0] * w), rx1 = Math.round(KZ.rank[1] * w);
  const tx0 = Math.round(KZ.text[0] * w), tx1 = Math.round(KZ.text[1] * w);
  const gap = 10, between = 16, pw = (rx1 - rx0) + gap + (tx1 - tx0);
  const out = [];
  for (let i = 0; i < imgs.length; i += KZ.perImage) {
    const set = imgs.slice(i, i + KZ.perImage);
    const c = Object.assign(document.createElement('canvas'),
      { width: pw * set.length + between * (set.length - 1), height: h });
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, h);
    set.forEach((im, k) => {
      const at = k * (pw + between);
      x.drawImage(im, rx0, 0, rx1 - rx0, h, at, 0, rx1 - rx0, h);
      x.drawImage(im, tx0, 0, tx1 - tx0, h, at + (rx1 - rx0) + gap, 0, tx1 - tx0, h);
    });
    out.push({ data: c.toDataURL('image/jpeg', 0.85).split(',')[1], t: frames.times ? frames.times[i] : null });
  }
  return out;
}

async function kzPost(path, body) {
  const res = await fetch(API_BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}
async function kzAsk(images, usage, only) {
  const roster = currentRoster().map(r => ({ search: r.search, ingame: r.ingame }));
  const groups = [];
  for (let i = 0; i < images.length; i += KZ.perRequest) groups.push(images.slice(i, i + KZ.perRequest));
  const one = async (g, gi) => {
    const r = await withFallback(model => kzPost('/kartz-ask', { model, images: g.map(im => im.data), roster, only, pos: true }), modelChain(), () => {}, true);
    const u = r.usage || {};
    usage.prompt += u.promptTokenCount || 0;
    usage.cached += u.cachedContentTokenCount || 0;
    usage.output += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
    usage.total += u.totalTokenCount || 0;
    usage.requests++;
    return (r.rows || []).map((row, i, all) => {
      let k = row.img > 0 ? row.img - 1 : -1;
      if (!(k >= 0 && k < g.length)) k = Math.round(all.length > 1 ? i / (all.length - 1) * (g.length - 1) : 0);
      return Object.assign(row, { frame: gi * KZ.perRequest + k });
    });
  };
  return (await Promise.all(groups.map(one))).flat();
}

async function kzFill(sightings, times, duration, file, usage) {
  const when = new Map();
  for (const s of sightings) {
    if (!(s.rank > 0)) continue;
    const t = s.frame != null ? times[s.frame] : null;
    if (!when.has(s.rank)) when.set(s.rank, []);
    if (t != null) when.get(s.rank).push(t);
  }
  if (!when.size) return { asked: 0, found: 0, rows: [] };
  const top = Math.max(...when.keys()), ranges = [];
  for (let k = 1; k <= top; k++) {
    if (when.has(k)) continue;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === k - 1) last[1] = k; else ranges.push([k, k]);
  }
  if (!ranges.length) return { asked: 0, found: 0, rows: [] };
  const todo = ranges.slice(0, GAP_MAX);
  const missing = todo.reduce((n, [a, b]) => n + b - a + 1, 0);
  log(`filling ${missing} missing rank${missing > 1 ? 's' : ''}…`);
  const near = (from, step) => {
    for (let k = from, i = 0; i < GAP_REACH; k += step, i++) {
      const ts = when.get(k);
      if (ts && ts.length) return step < 0 ? Math.max(...ts) : Math.min(...ts);
    }
    return null;
  };
  const moments = todo.flatMap(([a, b]) => {
    let t0 = near(a - 1, -1) ?? 0, t1 = near(b + 1, 1) ?? duration;
    if (t1 < t0) [t0, t1] = [t1, t0];
    t0 = Math.max(0, t0 - 0.3); t1 = Math.min(duration, t1 + 0.3);
    const count = Math.max(GAP_MOMENTS, Math.min(12, Math.round((t1 - t0) / 0.25) + 1));
    return Array.from({ length: count }, (_, i) => t0 + (t1 - t0) * i / (count - 1));
  });
  const shots = (await grabStrips(file, moments, 1)).flat();
  const got = (await kzAsk(await kzPack(shots), usage, todo).catch(() => []))
    .filter(r => todo.some(([a, b]) => r.rank >= a && r.rank <= b));
  return { asked: missing, found: new Set(got.map(r => r.rank)).size, rows: got };
}

const KR = { job: 0, cards: null };
function krBands(im) {
  const w = krW(im), h = krH(im), cw = Math.round(w * .66);
  const c = Object.assign(document.createElement('canvas'), { width: cw, height: h });
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0, cw, h, 0, 0, cw, h);
  const d = x.getImageData(0, 0, cw, h).data, pr = new Float32Array(h);
  for (let y = 0; y < h; y++) { let t = 0; for (let q = 0; q < cw; q += 2) { const i = (y * cw + q) * 4; t += d[i] + d[i + 1] + d[i + 2]; } pr[y] = t; }
  const mean = pr.reduce((a, b) => a + b, 0) / h, ac = [];
  for (let p = Math.round(h * .06); p <= Math.round(h * .4); p++) { let s = 0; for (let y = 0; y + p < h; y++) s += (pr[y] - mean) * (pr[y + p] - mean); ac.push([s / (h - p), p]); }
  const top = Math.max(...ac.map(q => q[0]));
  const P = (ac.find((q, i) => i > 0 && i < ac.length - 1 && q[0] >= ac[i - 1][0] && q[0] >= ac[i + 1][0] && q[0] >= top * .6) || ac[0])[1];
  const half = Math.round(P * .35), e = [];
  for (let y = 1; y < h - 1; y++) {
    let low = true;
    for (let q = Math.max(0, y - half); q <= Math.min(h - 1, y + half) && low; q++) if (pr[q] < pr[y]) low = false;
    if (low && pr[y] < mean && (!e.length || y - e[e.length - 1] > P * .6)) e.push(y);
  }
  const out = [];
  if (e.length < 2) return { w, h, P, cards: out };
  const gaps = e.slice(1).map((y, k) => y - e[k]).filter(g => g > P * .85 && g < P * 1.15).sort((a, b) => a - b);
  if (!gaps.length) return { w, h, P, cards: out };
  const Q = gaps[gaps.length >> 1];
  const ph = e.map(y => ((y % Q) + Q) % Q).sort((a, b) => a - b), o = ph[ph.length >> 1];
  const on = y => { let d = ((y - o) % Q + Q) % Q; d = Math.min(d, Q - d); return d < Q * .04; };
  const hits = e.filter(on);
  if (hits.length < 2) return { w, h, P: Q, cards: out };
  const near = y => hits.some(z => Math.abs(z - y) < Q * .05);
  for (let y = o - Math.ceil(o / Q) * Q; y + Q <= h + 4; y += Q) {
    if (y < -4) continue;
    if (near(y) || near(y + Q)) out.push([Math.max(0, Math.round(y)), Math.min(h, Math.round(y + Q))]);
  }
  return { w, h, P: Q, cards: out };
}
const krW = im => im.naturalWidth || im.width, krH = im => im.naturalHeight || im.height;
async function krCut(list, job) {
  const cards = [];
  for (const { b64, t } of list) {
    if (!b64) continue;
    const im = await kzImg('data:image/jpeg;base64,' + b64);
    const b = krBands(im);
    for (const [top, bot] of b.cards) cards.push({ t, im, top, bot, w: b.w, h: b.h, mid: Math.abs((top + bot) / 2 - b.h / 2) / b.h });
    if (job !== KR.job) return null;
  }
  return cards;
}
async function krRead(cards, job) {
  const TW = 150, TH = 92, LB = 24, COLS = 8, ROWS = 10, PER = COLS * ROWS, images = [];
  for (let g = 0; g * PER < cards.length; g++) {
    const set = cards.slice(g * PER, (g + 1) * PER), rows = Math.ceil(set.length / COLS);
    const c = Object.assign(document.createElement('canvas'), { width: COLS * TW, height: rows * (TH + LB) });
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    set.forEach((cd, n) => {
      const cx = (n % COLS) * TW, cy = Math.floor(n / COLS) * (TH + LB);
      x.fillStyle = '#000'; x.font = 'bold 18px sans-serif'; x.fillText('#' + (g * PER + n), cx + 4, cy + 18);
      const sw = Math.round(cd.w * .22), sh = cd.bot - cd.top, sc = Math.min((TW - 6) / sw, TH / sh);
      x.drawImage(cd.im, 0, cd.top, sw, sh, cx + 3, cy + LB, Math.round(sw * sc), Math.round(sh * sc));
    });
    images.push(c.toDataURL('image/jpeg', .85).split(',')[1]);
  }
  const got = [];
  for (let i = 0; i < images.length; i += 8) {
    const r = await withFallback(model => kzPost('/kartz-labels', { model, images: images.slice(i, i + 8) }), modelChain(), () => {}, true);
    got.push(...(r.labels || []));
    if (job !== KR.job) return null;
  }
  const out = new Array(cards.length).fill(null);
  for (const { id, rank } of got) if (id >= 0 && id < cards.length && rank > 0) out[id] = rank;
  return out;
}
async function krLabel(cards, job) {
  const order = cards.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const [a, b] = await Promise.all([krRead(cards, job), krRead(order.map(i => cards[i]), job)]);
  if (!a || !b || job !== KR.job) return null;
  const twice = new Array(cards.length).fill(null);
  order.forEach((i, n) => { twice[i] = b[n]; });
  cards.forEach((cd, i) => { if (a[i] > 0 && a[i] === twice[i]) cd.rank = a[i]; });
  return cards;
}
function krWhen(frames, seen) {
  const at = new Map(), T = frames.times || [], per = KZ.perImage;
  for (const s of seen || []) {
    if (!(s.rank > 0) || !(s.frame >= 0)) continue;
    const k = s.frame * per + (per > 1 && s.side === 'R' ? 1 : 0), t = T[k];
    if (t != null && !at.has(s.rank)) at.set(s.rank, t);
  }
  return at;
}
function krEarly(frames, job) {
  return krCut(frames.map((b64, k) => ({ b64, t: frames.times ? frames.times[k] : k })), job)
    .then(cards => cards && krLabel(cards, job));
}
async function krCards(frames, seen, want, file, job, early, show) {
  const best = new Map();
  const keep = cards => { for (const cd of cards || []) if (cd.rank > 0) { const was = best.get(cd.rank); if (!was || cd.mid < was.mid) best.set(cd.rank, cd); } };
  const cards = await early;
  if (!cards || job !== KR.job) return null;
  let total = cards.length;
  keep(cards);
  const when = krWhen(frames, seen), missing = [...want].filter(r => !best.has(r) && when.has(r));
  show(best, total, missing.length && file && frames.times);
  if (missing.length && file && frames.times) {
    const times = new Set();
    for (const r of missing.slice(0, 20)) for (const d of [-.35, -.2, -.1, .1, .2, .35]) times.add(Math.max(0, +(when.get(r) + d).toFixed(3)));
    const shots = (await grabStrips(file, [...times], 1)).map((x, i) => ({ b64: x[0], t: [...times][i] }));
    if (job !== KR.job) return null;
    const more = await krCut(shots, job);
    if (!more) return null;
    more.forEach(cd => { cd.mid += .5; });
    total += more.length;
    keep(await krLabel(more, job));
    if (job !== KR.job) return null;
    show(best, total, false);
  }
  return best;
}
function krJump(rank) {
  const list = $('kzRecSc').querySelector('.cards'); if (!list) return;
  const all = [...list.children];
  let el = all.find(c => +c.dataset.r === rank);
  if (!el) el = all.reduce((a, c) => !a || Math.abs(+c.dataset.r - rank) < Math.abs(+a.dataset.r - rank) ? c : a, null);
  if (!el) return;
  $('kzRec').classList.remove('min'); $('kzRecHide').textContent = 'Hide';
  const sc = $('kzRecSc');
  sc.scrollTop = el.offsetTop - (sc.clientHeight - el.offsetHeight) / 2;
}
async function krStart(frames, seen, want, file, job, early) {
  kzRecSel = null;
  if (job !== KR.job) return;
  const sc = $('kzRecSc');
  sc.innerHTML = '<p class="krwait">Preparing the cards…</p>';
  $('kzRec').classList.remove('hide', 'min'); $('kzRecHide').textContent = 'Hide';
  document.body.classList.add('hasrec');
  try {
    const show = (best, total, more) => {
      if (job !== KR.job) return;
      const keepTop = sc.scrollTop;
      const list = document.createElement('div'); list.className = 'cards';
      for (const rank of [...best.keys()].sort((a, b) => a - b)) {
        const cd = best.get(rank), h = cd.bot - cd.top;
        const c = Object.assign(document.createElement('canvas'), { width: cd.w, height: h });
        c.getContext('2d').drawImage(cd.im, 0, cd.top, cd.w, h, 0, 0, cd.w, h);
        c.dataset.r = rank;
        list.appendChild(c);
      }
      sc.replaceChildren(list);
      if (kzRecSel) krJump(kzRecSel); else sc.scrollTop = keepTop;
      if (!more) log(`recording cards — ${best.size} players from ${total} card pictures`);
    };
    await krCards(frames, seen, want, file, job, early, show);
  } catch (e) {
    if (job !== KR.job) return;
    console.log('[kartz] cards: ' + e.message);
    $('kzRec').classList.add('hide'); document.body.classList.remove('hasrec');
  }
}
$('kzRecHide').onclick = () => { const m = $('kzRec').classList.toggle('min'); $('kzRecHide').textContent = m ? 'Show' : 'Hide'; };
$('tbl').addEventListener('click', e => {
  if (e.target.closest('button, input, select, a, .field')) return;
  const tr = e.target.closest('tr[data-v]'); if (!tr) return;
  kzRecSel = +tr.dataset.v;
  $('tbl').querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel'));
  tr.classList.add('sel');
  krJump(kzRecSel);
});

$('go').onclick = async () => {
  $('go').disabled = true; $('out').classList.add('hide');
  const job = ++KR.job; $('kzRec').classList.add('hide'); document.body.classList.remove('hasrec');
  let early = null;
  const usage = { requests: 0, prompt: 0, cached: 0, output: 0, total: 0 };
  try {
    startVideoUpload(videoFile);
    const t0 = Date.now();
    const sampled = kzSample(videoFile);
    log('reading the recording…'); setProg(0.1);
    sampled.then(fr => { if (job === KR.job && !early) { early = krEarly(fr, job); early.catch(() => {}); } }).catch(() => {});
    const [roster, frames] = await Promise.all([freshRoster(), sampled]);
    if (!early) { early = krEarly(frames, job); early.catch(() => {}); }
    const learned = store.get('aliases') || {};
    const images = await kzPack(frames);
    log(`${frames.length} frames → ${images.length} images — reading…`); setProg(0.4);
    let sightings = await kzAsk(images, usage);
    const seen = sightings.slice();
    setProg(0.8);
    const clean = await kzPost('/kartz-clean', { sightings });
    sightings = clean.sightings;
    (clean.notes || []).forEach(log);
    const fill = await kzFill(sightings, images.map(p => p.t), frames.duration, videoFile, usage);
    sightings = sightings.concat(fill.rows);
    const matched = await kzPost('/kartz-match', { sightings, images: images.length, roster, skipped: skippedRoster(), aliases: learned, alliance: $('alliance').value });
    rows = matched.rows;
    (matched.notes || []).forEach(log);
    render(roster);
    krStart(frames, seen, new Set(rows.map(r => r.seenRank > 0 ? r.seenRank : r.rank).filter(n => n > 0)), videoFile, job, early);
    log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${sightings.length} readings → ${rows.length} players`
        + (fill.asked ? ` · gap fill found ${fill.found} of ${fill.asked}` : '')
        + ` · ${Math.round(usage.total / 1000)}k tokens`);
    setProg(1);
  } catch (e) {
    const m = e.message;
    log(/\b429\b/.test(m) && /quota|per day/i.test(m)
      ? '✗ The Gemini key has used up its allowance for now. Wait a while, or check the key\'s billing.'
      : '✗ ' + m);
  }
  $('go').disabled = !videoFile;
};
