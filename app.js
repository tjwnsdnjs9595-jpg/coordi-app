/* 오늘의 코디 - single-user outfit app.
 * Data lives in a private GitHub repo (wardrobe.json, config.json, history.json, today.json, photos/).
 * AI work (classifying photos, picking outfits) runs in that repo's GitHub Actions.
 * Demo mode keeps everything in this browser and fakes the AI so the screens can be tried out.
 */
"use strict";

const CATEGORIES = ["상의", "하의", "아우터", "원피스", "신발", "가방·소품"];
const THICKNESS = ["얇음", "보통", "두꺼움"];
const SEASONS = ["봄", "여름", "가을", "겨울"];
const FORMALITY = ["캐주얼", "세미포멀", "포멀", "운동복"];
const OCCASIONS = ["출근", "면접", "약속", "데이트", "운동", "휴일"];
const EMPTY = { wardrobe: { items: [] }, history: { records: [] }, config: {}, today: {} };
const POLL_MS = 5000;
const WAIT_MS = 4 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

/* ---------- small helpers ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const isWeekendKST = () => [0, 6].includes(new Date(Date.now() + 9 * 3600e3).getUTCDay());
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
}
function lsDel(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function setMsg(el, text, kind) {
  el.textContent = "";
  el.className = "msg" + (kind ? " " + kind : "");
  if (kind === "wait") el.append(h("span", { class: "spin" }));
  el.append(text || "");
}

/* ---------- GitHub store ---------- */
class GitHubStore {
  constructor({ owner, repo, token }) {
    this.owner = owner; this.repo = repo; this.token = token;
    this.branch = "main"; this.photoCache = new Map();
  }
  label() { return `${this.owner}/${this.repo}`; }
  async req(path, opts = {}) {
    return fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`, {
      cache: "no-store", ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });
  }
  async fail(r) {
    const hint = { 401: "토큰이 잘못됐거나 만료됐어요.", 403: "토큰 권한이 부족해요.", 404: "저장소나 파일을 찾지 못했어요." }[r.status];
    let detail = "";
    try { detail = (await r.json()).message || ""; } catch { /* ignore */ }
    return new Error(`${hint || "GitHub 요청 실패"} (${r.status}${detail ? ": " + detail : ""})`);
  }
  async verify() {
    const r = await this.req("");
    if (!r.ok) throw await this.fail(r);
    const repo = await r.json();
    this.branch = repo.default_branch || "main";
    if (repo.permissions && !repo.permissions.push) throw new Error("이 토큰으로는 저장소에 쓸 수 없어요. Contents 권한을 Read and write로 주세요.");
  }
  async readJSON(path, fallback) {
    const r = await this.req(`/contents/${path}`);
    if (r.status === 404) return { data: clone(fallback), sha: null };
    if (!r.ok) throw await this.fail(r);
    const j = await r.json();
    return { data: JSON.parse(b64ToUtf8(j.content)), sha: j.sha };
  }
  async updateJSON(path, fallback, mutate, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await this.readJSON(path, fallback);
      const next = mutate(data) || data;
      const body = { message, content: utf8ToB64(JSON.stringify(next, null, 2) + "\n"), branch: this.branch };
      if (sha) body.sha = sha;
      const r = await this.req(`/contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
      if (r.ok) return next;
      if (r.status === 409 || r.status === 422) { await sleep(800 * (attempt + 1)); continue; }
      throw await this.fail(r);
    }
    throw new Error("다른 작업과 겹쳐서 저장하지 못했어요. 잠시 후 다시 해 주세요.");
  }
  async putPhoto(path, b64) {
    const r = await this.req(`/contents/${path}`, {
      method: "PUT", body: JSON.stringify({ message: "add photo", content: b64, branch: this.branch }),
    });
    if (!r.ok) throw await this.fail(r);
  }
  async deleteFile(path) {
    const r = await this.req(`/contents/${path}`);
    if (r.status === 404) return;
    if (!r.ok) throw await this.fail(r);
    const { sha } = await r.json();
    const d = await this.req(`/contents/${path}`, {
      method: "DELETE", body: JSON.stringify({ message: "remove photo", sha, branch: this.branch }),
    });
    if (!d.ok && d.status !== 404) throw await this.fail(d);
  }
  async photoURL(path) {
    if (this.photoCache.has(path)) return this.photoCache.get(path);
    const key = `https://coordi.photos/${this.label()}/${path}`;
    let blob = null;
    let cache = null;
    try { cache = await caches.open("coordi-photos"); const hit = await cache.match(key); if (hit) blob = await hit.blob(); } catch { cache = null; }
    if (!blob) {
      const r = await this.req(`/contents/${path}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (!r.ok) throw await this.fail(r);
      blob = await r.blob();
      try { if (cache) await cache.put(key, new Response(blob)); } catch { /* ignore */ }
    }
    const url = URL.createObjectURL(blob);
    this.photoCache.set(path, url);
    return url;
  }
  async run(workflow, inputs) {
    const r = await this.req(`/actions/workflows/${workflow}/dispatches`, {
      method: "POST", body: JSON.stringify({ ref: this.branch, inputs }),
    });
    if (!r.ok) throw await this.fail(r);
  }
  // classify.yml has no push trigger (claude-code-action does not support push events), so start it here.
  async afterPhotosAdded() { await this.run("classify.yml", {}); }
  // Start classify again if photos are still pending and no classify run is queued or running
  // (e.g. the photos were added by an older cached version of the app).
  async resumeClassify() {
    const r = await this.req("/actions/workflows/classify.yml/runs?per_page=1");
    if (!r.ok) return;
    const run = (await r.json()).workflow_runs[0];
    if (!run || run.status === "completed") await this.run("classify.yml", {});
  }
}

/* ---------- Demo store (this browser only, fake AI) ---------- */
class DemoStore {
  constructor() { this.mem = new Map(); }
  label() { return "체험 모드 (이 기기에만 저장)"; }
  key(path) { return "coordi-demo:" + path; }
  get(path) { const v = lsGet(this.key(path)); return v != null ? v : this.mem.get(path); }
  set(path, val) { if (!lsSet(this.key(path), val)) this.mem.set(path, val); }
  async verify() {}
  async readJSON(path, fallback) { const v = this.get(path); return { data: v != null ? clone(v) : clone(fallback), sha: null }; }
  async updateJSON(path, fallback, mutate) {
    const { data } = await this.readJSON(path, fallback);
    const next = mutate(data) || data;
    this.set(path, next);
    return next;
  }
  async putPhoto(path, b64) {
    if (!lsSet(this.key(path), b64)) this.mem.set(path, b64);
  }
  async deleteFile(path) { lsDel(this.key(path)); this.mem.delete(path); }
  async photoURL(path) { const b64 = this.get(path); return b64 ? "data:image/jpeg;base64," + b64 : ""; }
  async afterPhotosAdded() { await this.run("classify.yml", {}); }
  async resumeClassify() { await this.afterPhotosAdded(); }
  async run(workflow, inputs) {
    await sleep(1200);
    if (workflow === "classify.yml") {
      await this.updateJSON("wardrobe.json", EMPTY.wardrobe, (w) => {
        for (const it of w.items) {
          if (it.status !== "pending") continue;
          Object.assign(it, { category: "상의", name: "새 옷", color: "", thickness: "보통", seasons: ["봄", "가을"],
            formality: "캐주얼", style: "", status: "ready" });
        }
      });
      return;
    }
    // recommend: random but sensible picks, no AI and no weather
    const { data: w } = await this.readJSON("wardrobe.json", EMPTY.wardrobe);
    const { data: prev } = await this.readJSON("today.json", {});
    const ready = w.items.filter((i) => i.status === "ready" && !i.hidden);
    const pick = (cats) => { const c = ready.filter((i) => cats.includes(i.category)); return c[Math.floor(Math.random() * c.length)]; };
    const outfits = [];
    for (let n = 0; n < 2; n++) {
      const top = pick(["상의", "원피스"]);
      const parts = [top, top && top.category === "원피스" ? null : pick(["하의"]), pick(["아우터"]), pick(["신발"])].filter(Boolean);
      if (parts.length >= 2) outfits.push({ title: `체험 코디 ${n + 1}`, item_ids: [...new Set(parts.map((p) => p.id))], reason: "체험 모드라 무작위로 골랐어요. 실제로는 날씨와 일정에 맞춰 AI가 골라요.", tip: "" });
    }
    const today = todayKST();
    const tried = inputs.retry === "true" && prev.date === today ? [...(prev.tried || []), ...(prev.outfits || []).map((o) => o.item_ids)] : [];
    this.set("today.json", {
      date: today, occasion: inputs.occasion || "출근", weather: null, tried,
      summary: outfits.length ? "체험 모드: 날씨 정보 없이 골랐어요." : "옷장에 상의와 하의를 먼저 등록해 주세요.",
      outfits, generated_at: new Date().toISOString(),
    });
  }
}

/* ---------- app state ---------- */
const S = { store: null, wardrobe: clone(EMPTY.wardrobe), history: clone(EMPTY.history), config: {}, today: {}, occasion: "", catFilter: "전체", busy: false };

const itemById = (id) => S.wardrobe.items.find((i) => i.id === id);

async function loadAll() {
  const [w, hi, c, t] = await Promise.all([
    S.store.readJSON("wardrobe.json", EMPTY.wardrobe),
    S.store.readJSON("history.json", EMPTY.history),
    S.store.readJSON("config.json", EMPTY.config),
    S.store.readJSON("today.json", EMPTY.today),
  ]);
  S.wardrobe = w.data; S.history = hi.data; S.config = c.data; S.today = t.data;
}

function hydratePhotos(root) {
  root.querySelectorAll("img[data-photo]").forEach(async (img) => {
    try { img.src = await S.store.photoURL(img.dataset.photo); } catch { img.alt = "사진 없음"; }
  });
}

/* ---------- views ---------- */
function show(view) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $(".tabs").hidden = view === "setup";
  if (view === "today") renderToday();
  if (view === "closet") renderCloset();
  if (view === "history") renderHistory();
  if (view === "settings") renderSettings();
  window.scrollTo(0, 0);
}

/* today */
function defaultOccasion() {
  return isWeekendKST() ? S.config.weekend_occasion || "휴일" : S.config.weekday_occasion || "출근";
}

function renderToday() {
  const t = S.today || {};
  const fresh = t.date === todayKST();
  if (!S.occasion) S.occasion = fresh && t.occasion ? t.occasion : defaultOccasion();

  const wc = $("#weather-card");
  wc.textContent = "";
  const w = fresh ? t.weather : null;
  if (w) {
    wc.append(
      h("div", { class: "muted small" }, `${t.date} (${t.weekday || ""}) · ${w.place || ""}`),
      h("div", { class: "big" }, `${w.sky} ${Math.round(w.min)}° / ${Math.round(w.max)}°`),
      h("div", { class: "line" }, `체감 ${Math.round(w.feels_min)}°~${Math.round(w.feels_max)}° · 아침 ${Math.round(w.morning.temp)}° · 저녁 ${Math.round(w.evening.temp)}° · 비 ${w.rain_prob}%`),
    );
  } else {
    wc.append(h("div", { class: "muted small" }, todayKST()), h("div", { class: "big" }, fresh ? "오늘의 코디" : "아직 오늘 코디가 없어요"));
  }
  if (fresh && t.summary) wc.append(h("p", {}, t.summary));
  if (!fresh) wc.append(h("p", { class: "muted small" }, "매일 아침 7시쯤 자동으로 준비돼요. 지금 받으려면 아래 버튼을 눌러 주세요."));

  const chips = $("#occasion-chips");
  chips.textContent = "";
  const custom = $("#occasion-custom");
  const isCustom = !OCCASIONS.includes(S.occasion);
  for (const o of [...OCCASIONS, "직접 입력"]) {
    const on = o === "직접 입력" ? isCustom : o === S.occasion;
    chips.append(h("button", { class: "chip" + (on ? " on" : ""), type: "button", onclick: () => {
      if (o === "직접 입력") { S.occasion = custom.value.trim() || " "; } else S.occasion = o;
      renderToday();
      if (o === "직접 입력") custom.focus();
    } }, o));
  }
  custom.hidden = !isCustom;
  if (isCustom && S.occasion.trim()) custom.value = S.occasion.trim();

  const box = $("#outfits");
  box.textContent = "";
  if (!fresh) return;
  const wornToday = S.history.records.filter((r) => r.date === todayKST());
  (t.outfits || []).forEach((o) => {
    const ids = o.item_ids || [];
    const worn = wornToday.some((r) => r.item_ids.join() === ids.join());
    box.append(h("div", { class: "card outfit" },
      h("h3", {}, o.title),
      outfitVisual(ids),
      h("p", {}, o.reason),
      o.tip ? h("p", { class: "tip" }, "💡 " + o.tip) : null,
      h("div", { class: "actions" }, worn
        ? h("span", { class: "worn" }, "✓ 오늘 이 코디를 입었어요")
        : h("button", { class: "primary", type: "button", onclick: () => markWorn(o) }, "이걸로 입을게요")),
    ));
  });
  if ((t.outfits || []).length) {
    box.append(h("button", { class: "wide", type: "button", onclick: () => requestOutfit(true) }, "다른 코디 보기"));
  }
  hydratePhotos(box);
}

/* Mannequin board: background-free cutouts placed on a body outline.
 * Slots are [left, top, width, height, z] in % of the board. */
const MANNEQUIN_SVG = `<svg class="mannequin" viewBox="0 0 300 440" aria-hidden="true">
  <circle cx="150" cy="38" r="22"/>
  <rect x="141" y="58" width="18" height="16" rx="6"/>
  <path d="M96 84 Q150 70 204 84 L214 150 Q206 154 198 150 L192 112 L190 210 Q150 222 110 210 L108 112 L102 150 Q94 154 86 150 Z"/>
  <path d="M110 214 Q150 226 190 214 L186 392 Q176 398 166 392 L154 250 L146 250 L134 392 Q124 398 114 392 Z"/>
</svg>`;

function boardSlot(cat, hasOuter) {
  switch (cat) {
    case "아우터": return [18, 15, 64, 42, 2];
    case "상의": return hasOuter ? [30, 18, 40, 32, 3] : [22, 16, 56, 38, 3];
    case "원피스": return [22, 16, 56, 62, 3];
    case "하의": return [28, 46, 44, 44, 1];
    case "신발": return [28, 87, 44, 12, 4];
    default: return [72, 44, 26, 22, 5];  // 가방·소품
  }
}

function outfitVisual(ids) {
  const items = ids.map(itemById).filter(Boolean);
  const names = h("div", { class: "piece-names" }, ids.map((id) => h("span", { class: "chip" }, (itemById(id) || {}).name || "(지금은 없는 옷)")));
  if (!items.length || items.some((it) => !it.cutout)) {
    // cutouts not ready yet: plain photo grid
    return h("div", {},
      h("div", { class: "pieces" }, items.map((it) => h("div", { class: "piece" },
        h("img", { dataset: { photo: it.photo }, alt: it.name || "" }), h("div", {}, it.name)))),
      items.some((it) => !it.cutout && !it.cutout_error) ? h("p", { class: "muted small" }, "옷 사진 배경을 지우는 중이라 마네킹 대신 사진으로 보여요.") : null);
  }
  const board = h("div", { class: "board" });
  board.innerHTML = MANNEQUIN_SVG;
  const hasOuter = items.some((it) => it.category === "아우터");
  const seen = {};
  for (const it of items) {
    const n = (seen[it.category] = (seen[it.category] || 0) + 1) - 1;
    const [l, t, w, hgt, z] = boardSlot(it.category, hasOuter);
    board.append(h("img", {
      class: "layer", alt: it.name || "", dataset: { photo: it.cutout },
      style: `left:${l - 7 * n}%;top:${t + 3 * n}%;width:${w}%;height:${hgt}%;z-index:${Math.max(0, z * 2 - n)}`,
    }));
  }
  return h("div", {}, board, names);
}

async function requestOutfit(retry) {
  if (S.busy) return;
  const msg = $("#today-msg");
  const occasion = (S.occasion || "").trim() || defaultOccasion();
  const before = S.today && S.today.generated_at;
  S.busy = true; $("#get-outfit").disabled = true;
  try {
    setMsg(msg, "코디 요청을 보냈어요…", "wait");
    await S.store.run("recommend.yml", { occasion, retry: String(!!retry) });
    setMsg(msg, "AI가 날씨와 옷장을 보고 고르는 중이에요. 보통 1~2분 걸려요.", "wait");
    const done = await waitFor(async () => {
      const { data } = await S.store.readJSON("today.json", {});
      if (data.generated_at && data.generated_at !== before) { S.today = data; return true; }
      return false;
    });
    if (!done) { setMsg(msg, "아직 결과가 안 왔어요. 잠시 뒤 새로고침해 보세요.", "err"); return; }
    S.occasion = S.today.occasion || occasion;
    setMsg(msg, S.today.outfits && S.today.outfits.length ? "새 코디가 도착했어요." : (S.today.summary || "추천할 조합을 찾지 못했어요."), S.today.outfits && S.today.outfits.length ? "ok" : "err");
    renderToday();
  } catch (e) {
    setMsg(msg, e.message, "err");
  } finally {
    S.busy = false; $("#get-outfit").disabled = false;
  }
}

async function waitFor(check) {
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(POLL_MS);
  }
  return false;
}

async function markWorn(o) {
  const msg = $("#today-msg");
  try {
    const rec = { date: todayKST(), occasion: S.today.occasion || "", title: o.title, item_ids: o.item_ids };
    S.history = await S.store.updateJSON("history.json", EMPTY.history, (hst) => {
      hst.records = hst.records.filter((r) => r.date !== rec.date);  // one outfit per day
      hst.records.push(rec);
    }, `wore ${rec.date}`);
    setMsg(msg, "기록했어요. 며칠 동안은 이 옷들을 덜 추천할게요.", "ok");
    renderToday();
  } catch (e) { setMsg(msg, e.message, "err"); }
}

/* closet */
function renderCloset() {
  const items = S.wardrobe.items;
  $("#closet-count").textContent = `${items.length}벌`;
  const chips = $("#cat-chips");
  chips.textContent = "";
  for (const c of ["전체", ...CATEGORIES]) {
    const n = c === "전체" ? items.length : items.filter((i) => i.category === c).length;
    if (c !== "전체" && !n) continue;
    chips.append(h("button", { class: "chip" + (S.catFilter === c ? " on" : ""), type: "button",
      onclick: () => { S.catFilter = c; renderCloset(); } }, `${c} ${n}`));
  }
  const grid = $("#closet-grid");
  grid.textContent = "";
  const shown = items.filter((i) => S.catFilter === "전체" || i.category === S.catFilter || i.status !== "ready");
  if (!items.length) grid.append(h("p", { class: "muted" }, "옷 사진을 추가하면 AI가 종류·색·두께를 알아서 적어 줘요. 옷을 펼쳐 놓고 한 벌씩 찍으면 가장 정확해요."));
  for (const it of [...shown].reverse()) {
    const tag = it.status === "pending" ? h("div", { class: "tag" }, h("span", { class: "spin" }), "AI 분석 중")
      : it.status === "error" ? h("div", { class: "tag err" }, "분석 실패 - 눌러서 확인")
      : it.hidden ? h("div", { class: "tag" }, "추천에서 뺌") : null;
    grid.append(h("button", { class: "tile" + (it.hidden ? " off" : ""), type: "button", onclick: () => openItem(it.id) },
      h("img", { class: "thumb", dataset: { photo: it.photo }, alt: it.name || "옷 사진" }),
      h("div", { class: "name" }, it.name || "새 옷"),
      h("div", { class: "sub" }, [it.category, it.color].filter(Boolean).join(" · ")),
      tag));
  }
  hydratePhotos(grid);
}

async function compress(file, max = 1000, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("사진을 열 수 없어요.")); i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality).split(",")[1];
  } finally { URL.revokeObjectURL(url); }
}

async function addPhotos(files) {
  const msg = $("#closet-msg");
  if (!files.length) return;
  try {
    let n = 0;
    for (const f of files) {
      n++;
      setMsg(msg, `사진 올리는 중 (${n}/${files.length})`, "wait");
      const b64 = await compress(f);
      const id = newId();
      const photo = `photos/${id}.jpg`;
      await S.store.putPhoto(photo, b64);
      S.wardrobe = await S.store.updateJSON("wardrobe.json", EMPTY.wardrobe, (w) => {
        w.items.push({ id, photo, status: "pending", added: todayKST() });
      }, "add clothes");
      renderCloset();
    }
    await S.store.afterPhotosAdded();
    await waitForClassify();
  } catch (e) { setMsg(msg, e.message, "err"); }
}

async function waitForClassify() {
  const msg = $("#closet-msg");
  setMsg(msg, "AI가 옷을 살펴보는 중이에요. 보통 1~2분 걸려요. 다른 화면으로 가도 괜찮아요.", "wait");
  const done = await waitFor(async () => {
    const { data } = await S.store.readJSON("wardrobe.json", EMPTY.wardrobe);
    S.wardrobe = data;
    if (!$("#view-closet").hidden) renderCloset();
    return !data.items.some((i) => i.status === "pending");
  });
  const failed = S.wardrobe.items.filter((i) => i.status === "error").length;
  if (!done) setMsg(msg, "아직 분석 중이에요. 잠시 뒤 새로고침해 보세요.");
  else if (failed) setMsg(msg, `분석에 실패한 옷이 ${failed}벌 있어요. 눌러서 직접 적거나 다시 분류해 주세요.`, "err");
  else setMsg(msg, "분석이 끝났어요. 틀린 부분은 눌러서 고칠 수 있어요.", "ok");
}

function fillSelect(sel, options, value) {
  sel.textContent = "";
  for (const o of options) sel.append(h("option", { value: o, selected: o === value }, o));
  if (value && !options.includes(value)) sel.append(h("option", { value, selected: true }, value));
}

let editingId = null;
async function openItem(id) {
  const it = itemById(id);
  if (!it) return;
  editingId = id;
  const f = $("#item-form");
  const img = $("#item-photo");
  img.removeAttribute("src");
  S.store.photoURL(it.photo).then((u) => (img.src = u)).catch(() => {});
  fillSelect(f.category, CATEGORIES, it.category || "상의");
  fillSelect(f.thickness, THICKNESS, it.thickness || "보통");
  fillSelect(f.formality, FORMALITY, it.formality || "캐주얼");
  f.iname.value = it.name || ""; f.color.value = it.color || ""; f.memo.value = it.memo || "";
  f.skip.checked = !!it.hidden;
  const boxes = $("#season-boxes");
  boxes.textContent = "";
  for (const s of SEASONS) {
    boxes.append(h("label", { class: "check chip" }, h("input", { type: "checkbox", name: "season", value: s, checked: (it.seasons || []).includes(s) }), s));
  }
  const st = $("#item-status");
  if (it.status === "pending") setMsg(st, "AI가 분석 중이에요.", "wait");
  else if (it.status === "error") setMsg(st, "분석 실패: " + (it.error || "") + " 직접 적고 저장하면 돼요.", "err");
  else setMsg(st, "");
  $("#item-dialog").showModal();
}

async function onItemClose() {
  const action = $("#item-dialog").returnValue;
  const id = editingId;
  editingId = null;
  if (!id || action === "cancel" || !action) return;
  const f = $("#item-form");
  const msg = $("#closet-msg");
  try {
    if (action === "delete") {
      const it = itemById(id);
      if (!confirm(`'${(it && it.name) || "이 옷"}'을(를) 옷장에서 지울까요? 사진도 함께 지워져요.`)) return;
      setMsg(msg, "지우는 중…", "wait");
      S.wardrobe = await S.store.updateJSON("wardrobe.json", EMPTY.wardrobe, (w) => { w.items = w.items.filter((i) => i.id !== id); }, "remove clothes");
      if (it) await S.store.deleteFile(it.photo);
      if (it && it.cutout) await S.store.deleteFile(it.cutout);
      setMsg(msg, "지웠어요.", "ok");
    } else {
      const fields = {
        category: f.category.value, name: f.iname.value.trim(), color: f.color.value.trim(),
        thickness: f.thickness.value, formality: f.formality.value, memo: f.memo.value.trim(),
        seasons: [...f.querySelectorAll("input[name=season]:checked")].map((x) => x.value),
        hidden: f.skip.checked,
      };
      setMsg(msg, "저장 중…", "wait");
      S.wardrobe = await S.store.updateJSON("wardrobe.json", EMPTY.wardrobe, (w) => {
        const it = w.items.find((i) => i.id === id);
        if (!it) return;
        Object.assign(it, fields);
        if (action === "reclassify") { it.status = "pending"; delete it.error; }
        else if (it.status !== "pending") { it.status = "ready"; delete it.error; }
      }, "edit clothes");
      if (action === "reclassify") { renderCloset(); await S.store.afterPhotosAdded(); await waitForClassify(); return; }
      setMsg(msg, "저장했어요.", "ok");
    }
    renderCloset();
  } catch (e) { setMsg(msg, e.message, "err"); }
}

/* history */
function renderHistory() {
  const list = $("#history-list");
  list.textContent = "";
  const recs = [...S.history.records].reverse();
  if (!recs.length) { list.append(h("div", { class: "card muted" }, "'이걸로 입을게요'를 누르면 여기에 쌓여요. 기록은 같은 옷이 연달아 추천되지 않게 쓰여요.")); return; }
  for (const r of recs) {
    list.append(h("div", { class: "card hist" },
      h("div", { class: "pics" }, r.item_ids.map((id) => { const it = itemById(id); return it ? h("img", { dataset: { photo: it.photo }, alt: it.name || "" }) : h("img", { alt: "" }); })),
      h("div", {},
        h("div", { class: "date" }, r.date),
        h("div", { class: "muted small" }, [r.occasion, r.title].filter(Boolean).join(" · ")),
        h("div", { class: "small" }, r.item_ids.map((id) => (itemById(id) || {}).name || "(삭제된 옷)").join(", ")))));
  }
  hydratePhotos(list);
}

/* settings */
let pendingLoc = null;
function renderSettings() {
  const f = $("#config-form");
  const c = S.config;
  pendingLoc = c.location ? { ...c.location } : null;
  f.locname.value = (c.location && c.location.name) || "";
  f.weekday_occasion.value = c.weekday_occasion || "";
  f.weekend_occasion.value = c.weekend_occasion || "";
  f.pref_style.value = c.style || ""; f.avoid.value = c.avoid || ""; f.notes.value = c.notes || "";
  showCoords();
  $("#conn-info").textContent = "연결된 곳: " + S.store.label();
}
function showCoords() {
  $("#loc-coords").textContent = pendingLoc && pendingLoc.lat != null
    ? `위도 ${(+pendingLoc.lat).toFixed(3)}, 경도 ${(+pendingLoc.lon).toFixed(3)}` : "위치가 아직 없어요 (날씨를 쓰려면 필요해요)";
}

/* ---------- start ---------- */
function storeFromSettings(s) {
  if (!s) return null;
  if (s.mode === "demo") return new DemoStore();
  if (s.mode === "github" && s.owner && s.repo && s.token) return new GitHubStore(s);
  return null;
}

async function start(store) {
  S.store = store;
  $("#mode-badge").hidden = !(store instanceof DemoStore);
  try {
    await store.verify();
    await loadAll();
  } catch (e) {
    show("setup");
    setMsg($("#setup-msg"), "연결에 실패했어요: " + e.message, "err");
    return;
  }
  show("today");
  if (S.wardrobe.items.some((i) => i.status === "pending")) {
    try { await store.resumeClassify(); } catch { /* still wait; the run may already be going */ }
    waitForClassify();
  }
}

function bind() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

  $("#setup-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const s = { mode: "github", owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() };
    setMsg($("#setup-msg"), "확인 중…", "wait");
    const store = new GitHubStore(s);
    try { await store.verify(); } catch (e) { setMsg($("#setup-msg"), e.message, "err"); return; }
    if (!lsSet("coordi-settings", s)) setMsg($("#setup-msg"), "이 브라우저는 저장이 막혀 있어 매번 다시 입력해야 해요.", "err");
    f.token.value = "";
    start(store);
  });
  $("#demo-btn").addEventListener("click", () => { lsSet("coordi-settings", { mode: "demo" }); start(new DemoStore()); });

  $("#get-outfit").addEventListener("click", () => requestOutfit(false));
  $("#occasion-custom").addEventListener("input", (e) => { S.occasion = e.target.value || " "; });

  $("#photo-input").addEventListener("change", (e) => { const files = [...e.target.files]; e.target.value = ""; addPhotos(files); });
  $("#item-dialog").addEventListener("close", onItemClose);
  // a "다시 분류" button is added next to 삭제 at start-up
  const reBtn = h("button", { value: "reclassify", type: "submit" }, "AI로 다시 분류");
  $("#item-form .row .danger").after(reBtn);

  $("#loc-btn").addEventListener("click", () => {
    const msg = $("#config-msg");
    if (!navigator.geolocation) { setMsg(msg, "이 브라우저는 위치를 지원하지 않아요.", "err"); return; }
    setMsg(msg, "위치 확인 중…", "wait");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        pendingLoc = { name: $("#config-form").locname.value.trim(), lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4) };
        showCoords(); setMsg(msg, "위치를 가져왔어요. 저장을 눌러 주세요.", "ok");
      },
      () => setMsg(msg, "위치를 가져오지 못했어요. 브라우저의 위치 권한을 확인해 주세요.", "err"),
      { enableHighAccuracy: false, timeout: 15000 });
  });
  $("#config-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const msg = $("#config-msg");
    const loc = pendingLoc ? { ...pendingLoc, name: f.locname.value.trim() } : null;
    try {
      setMsg(msg, "저장 중…", "wait");
      S.config = await S.store.updateJSON("config.json", EMPTY.config, (c) => {
        if (loc) c.location = loc;
        Object.assign(c, { weekday_occasion: f.weekday_occasion.value.trim(), weekend_occasion: f.weekend_occasion.value.trim(),
          style: f.pref_style.value.trim(), avoid: f.avoid.value.trim(), notes: f.notes.value.trim() });
      }, "edit settings");
      S.occasion = "";
      setMsg(msg, "저장했어요. 다음 추천부터 반영돼요.", "ok");
    } catch (e) { setMsg(msg, e.message, "err"); }
  });
  $("#logout-btn").addEventListener("click", () => {
    if (!confirm("이 기기에서 연결을 해제할까요? 옷장 데이터는 저장소에 그대로 남아요.")) return;
    lsDel("coordi-settings");
    location.reload();
  });
}

bind();
const saved = storeFromSettings(lsGet("coordi-settings"));
if (saved) start(saved); else show("setup");
