
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
    const r = await withFallback(model => kzPost('/kartz-ask', { model, images: g.map(im => im.data), roster, only }), modelChain(), () => {}, true);
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

const KR = { y: null, pitch: 0, job: 0 };
function krGrey(img, w, part = 0.45) {
  const h = Math.round(img.naturalHeight * w / img.naturalWidth), sw = Math.round(img.naturalWidth * part);
  const gw = Math.round(w * part);
  const c = Object.assign(document.createElement('canvas'), { width: gw, height: h });
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, sw, img.naturalHeight, 0, 0, gw, h);
  const d = x.getImageData(0, 0, gw, h).data, g = new Float32Array(gw * h);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * .3 + d[i * 4 + 1] * .59 + d[i * 4 + 2] * .11;
  return { g, w: gw, h };
}
function krShift(a, b, lo = -Infinity, hi = Infinity) {
  const { w, h } = a, min = Math.round(h * .2);
  let best = [Infinity, 0];
  for (let dy = Math.max(min - h, lo); dy <= Math.min(h - min, hi); dy++) {
    let s = 0, n = 0;
    const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
    for (let y = y0; y < y1; y += 2) for (let x = 0; x < w; x += 2) { s += Math.abs(a.g[(y + dy) * w + x] - b.g[y * w + x]); n++; }
    s /= n; if (s < best[0]) best = [s, dy];
  }
  return best;
}
const krPause = () => new Promise(r => setTimeout(r, 0));
async function krBuild(frames, file, job) {
  const shots = frames.map((b, i) => ({ b, t: frames.times ? frames.times[i] : i }));
  const imgOf = async s => s.img || (s.img = await kzImg('data:image/jpeg;base64,' + s.b));
  const small = async s => s.g || (s.g = krGrey(await imgOf(s), 240));
  for (let pass = 0; pass < 4 && frames.times; pass++) {
    const mids = [];
    for (let i = 0; i < shots.length - 1; i++) {
      const a = shots[i], b = shots[i + 1];
      if (b.t - a.t < 0.15) continue;
      if (a.ok && a.ok === b) continue;
      const [err] = krShift(await small(a), await small(b));
      if (err > 12) mids.push([i, (a.t + b.t) / 2]); else a.ok = b;
      await krPause();
      if (job !== KR.job) return;
    }
    if (!mids.length) break;
    $('kzRecNote').textContent = `filling ${mids.length} gap${mids.length > 1 ? 's' : ''}…`;
    const got = (await grabStrips(file, mids.map(m => m[1]), 1)).map(x => x[0]);
    if (job !== KR.job) return;
    mids.map((m, k) => [m[0], { b: got[k], t: m[1] }]).reverse().forEach(([i, s]) => shots.splice(i + 1, 0, s));
  }
  const imgs = [];
  for (const s of shots) imgs.push(await imgOf(s));
  const FW = imgs[0].naturalWidth, FH = imgs[0].naturalHeight, k = FW / 240;
  const offs = [0];
  for (let i = 1; i < shots.length; i++) {
    const [err, dy] = krShift(await small(shots[i - 1]), await small(shots[i]));
    const F = [shots[i - 1], shots[i]].map(s => s.f || (s.f = krGrey(s.img, FW)));
    const fine = err < 18 ? krShift(F[0], F[1], Math.round(dy * k) - 6, Math.round(dy * k) + 6)[1] : Math.round(FH * .8);
    offs.push(offs[i - 1] + fine);
    if (i > 1) shots[i - 2].f = null;
    await krPause();
    if (job !== KR.job) return;
  }
  const top = Math.min(0, ...offs), total = Math.max(...offs) + FH - top;
  const scale = Math.min(640 / FW, Math.sqrt(15e6 / (FW * total)), 1);
  const W = Math.round(FW * scale), c = Object.assign(document.createElement('canvas'), { width: W, height: Math.round(total * scale) });
  const x = c.getContext('2d', { willReadFrequently: true });
  const T = 14; let reach = -Infinity;
  imgs.forEach((im, i) => {
    const o = offs[i] - top, from = i ? Math.max(T, reach - o - 20) : 0, to = i < imgs.length - 1 ? FH - T : FH;
    reach = Math.max(reach, o + to);
    if (to > from) x.drawImage(im, 0, from, FW, to - from, 0, Math.round((o + from) * scale), W, Math.round((to - from) * scale));
  });
  const cw = Math.round(W * .3), d = x.getImageData(0, 0, cw, c.height).data, prof = new Float32Array(c.height);
  for (let y = 0; y < c.height; y++) { let t = 0; for (let q = 0; q < cw; q += 3) { const i = (y * cw + q) * 4; t += d[i] + d[i + 1] + d[i + 2]; } prof[y] = t; }
  const mean = prof.reduce((a, b) => a + b, 0) / prof.length;
  let best = [-Infinity, 0];
  for (let p = Math.round(80 * scale); p <= Math.round(260 * scale); p++) {
    let s = 0; for (let y = 0; y + p < prof.length; y++) s += (prof[y] - mean) * (prof[y + p] - mean);
    s /= prof.length - p; if (s > best[0]) best = [s, p];
  }
  const pitch = best[1], half = Math.round(pitch * .35), found = [];
  for (let y = half; y < prof.length - half; y++) {
    let low = true;
    for (let q = y - half; q <= y + half && low; q++) if (prof[q] < prof[y]) low = false;
    if (low && prof[y] < mean && (!found.length || y - found[found.length - 1] > pitch * .6)) found.push(y);
  }
  if (!found.length) found.push(0);
  if (found[0] > pitch * .9) found.unshift(Math.max(0, found[0] - pitch));
  const edges = [found[0]];
  while (edges[edges.length - 1] + pitch < prof.length) {
    const want = edges[edges.length - 1] + pitch;
    let near = null; for (const e of found) if (Math.abs(e - want) < pitch * .25 && (near == null || Math.abs(e - want) < Math.abs(near - want))) near = e;
    edges.push(near ?? want);
  }
  if (job !== KR.job) return;
  KR.pitch = pitch;
  KR.y = rank => rank < edges.length ? (edges[rank - 1] + edges[rank]) / 2 : edges[edges.length - 1] + (rank - edges.length + .5) * pitch;
  $('kzRecSc').replaceChildren(c);
  $('kzRecNote').textContent = 'tap a row to find it';
}
function krJump(rank) {
  if (!KR.y) return;
  const sc = $('kzRecSc'), cv = sc.querySelector('canvas'); if (!cv) return;
  const ratio = cv.clientWidth / cv.width, y = KR.y(rank);
  let mk = sc.querySelector('.mark'); if (!mk) { mk = document.createElement('div'); mk.className = 'mark'; sc.appendChild(mk); }
  mk.style.top = ((y - KR.pitch / 2) * ratio + 2) + 'px'; mk.style.height = (KR.pitch * ratio - 4) + 'px';
  $('kzRec').classList.remove('min'); $('kzRecHide').textContent = 'Hide';
  sc.scrollTo({ top: y * ratio - sc.clientHeight / 2, behavior: 'smooth' });
}
function krStart(frames, file) {
  const job = ++KR.job;
  KR.y = null; kzRecSel = null;
  $('kzRecSc').replaceChildren(); $('kzRecNote').textContent = 'joining the frames…';
  $('kzRec').classList.remove('hide', 'min'); $('kzRecHide').textContent = 'Hide';
  document.body.classList.add('hasrec');
  krBuild(frames, file, job).catch(e => {
    if (job !== KR.job) return;
    console.log('[kartz] recording strip: ' + e.message);
    $('kzRec').classList.add('hide'); document.body.classList.remove('hasrec');
  });
}
addEventListener('resize', () => { if (kzRecSel && KR.y) krJump(kzRecSel); });
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
  KR.job++; $('kzRec').classList.add('hide'); document.body.classList.remove('hasrec');
  const usage = { requests: 0, prompt: 0, cached: 0, output: 0, total: 0 };
  try {
    startVideoUpload(videoFile);
    const t0 = Date.now();
    const sampled = kzSample(videoFile);
    log('reading the recording…'); setProg(0.1);
    const [roster, frames] = await Promise.all([freshRoster(), sampled]);
    const learned = store.get('aliases') || {};
    const images = await kzPack(frames);
    log(`${frames.length} frames → ${images.length} images — reading…`); setProg(0.4);
    let sightings = await kzAsk(images, usage);
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
    krStart(frames, videoFile);
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
