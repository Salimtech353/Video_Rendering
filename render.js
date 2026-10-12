#!/usr/bin/env node
// Reels Factory — GitHub Actions ভিডিও রেন্ডারার (FFmpeg) — ভার্সন ২
// ব্যবহার: node render/render.js jobs/<jobId> out/video.mp4
// জবের ফোল্ডারে job.json থাকে (ওয়েব অ্যাপ বানায়) + আপলোড/AI ছবি + অডিও।
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const [jobArg, outArg] = process.argv.slice(2);
if (!jobArg || !outArg) {
  console.error("usage: node render/render.js <jobDir> <out.mp4>");
  process.exit(2);
}
const jobDir = path.resolve(jobArg);
const outFile = path.resolve(outArg);
const job = JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
const FPS = 30;
const { W, H, cw, ch } = job;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toFrames = (sec) => Math.round(sec * FPS);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status})`);
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}
const ff = (args, opts) => run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "warning", ...args], opts);

// ---------- অ্যাপকে প্রগ্রেস জানানো (jobs/<id>/progress.json — ব্যর্থ হলেও রেন্ডার থামে না) ----------
let lastReport = 0;
let progSha = null;
function report(stage, i, n, pct, force = false) {
  if (!process.env.GITHUB_ACTIONS || !process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const now = Date.now();
  if (!force && now - lastReport < 8000) return;
  lastReport = now;
  const body = Buffer.from(JSON.stringify({ stage, i, n, pct: Math.round(pct) })).toString("base64");
  const rel = `jobs/${path.basename(jobDir)}/progress.json`;
  const args = ["api", "-X", "PUT", `repos/${process.env.GITHUB_REPOSITORY}/contents/${rel}`, "-f", "message=progress", "-f", `content=${body}`, "-f", "branch=main"];
  if (progSha) args.push("-f", `sha=${progSha}`);
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status === 0) {
    try {
      progSha = JSON.parse(r.stdout).content.sha;
    } catch (_) {}
  }
}

async function download(url, dest) {
  if (url.startsWith("file://")) {
    fs.copyFileSync(url.slice(7), dest); // স্থানীয় টেস্টের জন্য
    return dest;
  }
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (ReelsFactory renderer)" }, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * attempt);
    }
  }
  throw new Error(`download failed: ${url} (${lastErr && lastErr.message})`);
}

// ছবির আসল ধরন ফাইলের প্রথম বাইট দেখে ঠিক করা হয় (URL-এর এক্সটেনশনে ভরসা না করে)
function sniffExt(file) {
  const b = fs.readFileSync(file).subarray(0, 12);
  if (b[0] === 0x89 && b[1] === 0x50) return ".png";
  if (b[0] === 0xff && b[1] === 0xd8) return ".jpg";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (b.toString("ascii", 0, 3) === "GIF") return ".gif";
  return ".jpg";
}

async function resolveMedia(m, name) {
  if (m.file) return path.join(jobDir, path.basename(m.file));
  const dest = path.join(work, name);
  await download(m.url, dest);
  if (m.type === "photo") {
    const fixed = dest + sniffExt(dest);
    fs.renameSync(dest, fixed);
    return fixed;
  }
  return dest;
}

function probeDuration(file) {
  const v = parseFloat(capture("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]));
  return Number.isFinite(v) ? v : 0;
}

const ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an"];
const borderHex = "0x" + String(job.borderColor || "#1A1A1A").replace("#", "");

// অ্যাপের ট্রানজিশন নাম -> FFmpeg xfade নাম
const XFADE = {
  fade: "fade",
  slideLeft: "slideleft",
  slideRight: "slideright",
  slideUp: "slideup",
  zoom: "zoomin",
  carouselLeft: "smoothleft",
  carouselRight: "smoothright",
  wipeLeft: "wipeleft",
  wipeRight: "wiperight",
};
const transitionList = (job.transitions && job.transitions.length ? job.transitions : Object.keys(XFADE)).map((n) => XFADE[n] || "fade");

// ---------- একটা আইটেম (দৃশ্য/ফাঁক) রেন্ডার: head | body | tail টুকরো ----------
// head/tail হলো ট্রানজিশনে মেশার অংশ (tp/tn ফ্রেম); এতে দৃশ্যের সময় ঠিক থাকে, শুধু সীমানায় মিশে যায়।
async function renderItem(item, k) {
  const D = item.n + item.tp / 2 + item.tn / 2;
  const dSec = D / FPS;
  let inputArgs;
  let chain;
  if (item.kind === "gap") {
    inputArgs = ["-f", "lavfi", "-i", `color=c=${borderHex}:s=${cw}x${ch}:r=${FPS}:d=${dSec.toFixed(3)}`];
    chain = "[0:v]format=yuv420p[vv]";
  } else {
    const src = await resolveMedia(item.media, `m${k}`);
    inputArgs = ["-i", src];
    if (item.media.type === "photo") {
      chain =
        `[0:v]scale=${cw * 2}:${ch * 2}:force_original_aspect_ratio=increase,crop=${cw * 2}:${ch * 2},` +
        `zoompan=z='1+0.15*on/${D}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${D}:s=${cw}x${ch}:fps=${FPS},setsar=1,format=yuv420p[vv]`;
    } else {
      // ক্লিপ ঠিক সময়ে আঁটাতে গতি বদলানো হয় (speed = আসল দৈর্ঘ্য / প্রয়োজনীয় দৈর্ঘ্য)
      const orig = probeDuration(src);
      const pre = orig > 0 ? `setpts=PTS/${clamp(orig / dSec, 0.1, 10).toFixed(4)},` : "";
      chain =
        `[0:v]${pre}fps=${FPS},scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},setsar=1,` +
        `tpad=stop_mode=clone:stop_duration=${dSec.toFixed(3)},format=yuv420p[vv]`;
    }
  }
  const outs = [];
  if (item.tp > 0) outs.push({ name: "head", from: 0, to: item.tp });
  outs.push({ name: "body", from: item.tp, to: D - item.tn });
  if (item.tn > 0) outs.push({ name: "tail", from: D - item.tn, to: D });

  let graph = chain + ";";
  if (outs.length > 1) graph += `[vv]split=${outs.length}${outs.map((_, i) => `[s${i}]`).join("")};`;
  const src0 = (i) => (outs.length > 1 ? `[s${i}]` : "[vv]");
  graph += outs.map((o, i) => `${src0(i)}trim=start_frame=${o.from}:end_frame=${o.to},setpts=PTS-STARTPTS[o${i}]`).join(";");

  const args = [...inputArgs, "-filter_complex", graph];
  const files = {};
  outs.forEach((o, i) => {
    const f = path.join(work, `it${k}_${o.name}.mp4`);
    files[o.name] = f;
    args.push("-map", `[o${i}]`, ...ENC, f);
  });
  ff(args);
  return files;
}

function buildTransition(k, tailFile, headFile, tf) {
  const outp = path.join(work, `tr${k}.mp4`);
  const name = transitionList[k % transitionList.length];
  ff([
    "-i", tailFile, "-i", headFile,
    "-filter_complex", `[0:v][1:v]xfade=transition=${name}:duration=${(tf / FPS).toFixed(4)}:offset=0,format=yuv420p[v]`,
    "-map", "[v]", "-frames:v", String(tf), ...ENC, outp,
  ]);
  return outp;
}

// ---------- ক্যাপশন (ASS — libass দিয়ে বাংলা যুক্তাক্ষর ঠিকভাবে আঁকা হয়) ----------
const assTime = (s) => {
  const cs = Math.round(Math.max(0, s) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const bgr = (hex) => {
  const h = String(hex || "#ffffff").replace("#", "").padStart(6, "0");
  return `${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
const graphemes = (text) => {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  } catch (_) {
    return [...text];
  }
};

async function buildCaptions() {
  const c = job.captions;
  if (!c || !c.enabled || !c.lines || !c.lines.length) return false;
  let family = (c.font && c.font.name) || "Noto Sans Bengali";
  const fontsDir = path.join(work, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });
  if (c.font && c.font.url) {
    try {
      const dest = path.join(fontsDir, "caption-font.ttf");
      await download(c.font.url, dest);
      const fam = capture("fc-scan", ["--format", "%{family}\n", dest]).split("\n")[0].split(",")[0].trim();
      if (fam) family = fam;
    } catch (e) {
      console.warn("font download failed, falling back to system font:", e.message);
    }
  }
  const bold = c.font && c.font.bold ? -1 : 0;
  const color = bgr(c.color);
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // SecondaryColour পুরো স্বচ্ছ — টাইপরাইটারে (\k) এখনো না-আসা অক্ষর অদৃশ্য থাকে
    `Style: Cap,${family},${c.size},&H00${color},&HFF${color},&H00000000,&H00000000,${bold},0,0,0,100,100,0,0,1,0,0,2,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const x = Math.round(W / 2);
  const y = Math.round(c.bottomY);
  const anim = c.anim || "typewriter";
  const boxL = Math.round((W - cw) / 2);
  const boxR = boxL + cw;
  const boxT = Math.round(y - c.size * 3);
  const boxB = y + Math.round(c.size);

  const events = c.lines.map((l) => {
    const text = String(l.text).replace(/[{}\\]/g, "").replace(/\r/g, "");
    const sz = l.size || c.size;
    let tags = `\\an2\\pos(${x},${y})\\fs${sz}`;
    let body = text.replace(/\n/g, "\\N");
    if (anim === "typewriter") {
      const g = graphemes(text);
      const typeDur = Math.max(0.3, Math.min(l.length - 0.15, text.length * 0.05));
      const cs = Math.max(1, Math.round((typeDur * 100) / Math.max(1, g.length)));
      body = g.map((ch1) => (ch1 === "\n" ? "\\N" : `{\\k${cs}}${ch1}`)).join("");
      tags += "\\fad(0,120)";
    } else if (anim === "fade") {
      tags += "\\fad(220,150)";
    } else if (anim === "slideUp") {
      tags = `\\an2\\fs${sz}\\move(${x},${y + 50},${x},${y},0,300)\\fad(150,150)`;
    } else if (anim === "slideLeft") {
      tags = `\\an2\\fs${sz}\\move(${x + Math.round(cw * 0.18)},${y},${x},${y},0,300)\\fad(150,150)`;
    } else if (anim === "zoom") {
      tags += "\\fscx60\\fscy60\\t(0,300,\\fscx100\\fscy100)\\fad(150,150)";
    } else if (anim === "wipeLeft") {
      tags += `\\clip(${boxL},${boxT},${boxL},${boxB})\\t(0,350,\\clip(${boxL},${boxT},${boxR},${boxB}))\\fad(0,120)`;
    } // none: কোনো অ্যানিমেশন নেই
    return `Dialogue: 0,${assTime(l.start)},${assTime(l.start + l.length)},Cap,,0,0,0,,{${tags}}${body}`;
  });
  fs.writeFileSync(path.join(work, "cap.ass"), head.concat(events).join("\n") + "\n", "utf8");
  return true;
}

function runWithProgress(args, totalSec, onPct) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "warning", "-progress", "pipe:1", "-nostats", ...args], {
      cwd: work,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onPct(Math.min(1, Number(m[1]) / 1e6 / totalSec));
      }
    });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code})`))));
  });
}

// ---------- ব্যাকগ্রাউন্ড মিউজিক + ducking ----------
// ভয়েসওভারের নীরব অংশ খুঁজে (silencedetect) একটা মসৃণ "ভলিউম-কার্ভ" বানানো হয়:
// কথা চললে মিউজিক duck ভলিউমে নামে, থামলে স্বাভাবিক ভলিউমে ওঠে। কার্ভটা মিউজিকের সাথে গুণ করা হয় (amultiply)।
function detectSilences(voicePath) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", voicePath, "-af", "silencedetect=noise=-35dB:d=0.5", "-f", "null", "-"], { encoding: "utf8" });
  const out = (r.stderr || "") + (r.stdout || "");
  const sil = [];
  let cur = null;
  for (const line of out.split("\n")) {
    let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (m) cur = { s: Math.max(0, parseFloat(m[1])), e: Infinity };
    m = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (m && cur) {
      cur.e = parseFloat(m[1]);
      sil.push(cur);
      cur = null;
    }
  }
  if (cur) sil.push(cur); // শেষ পর্যন্ত নীরব
  return sil;
}

function buildGainCurve(voicePath, total, normal, duck) {
  const GR = 400; // কার্ভের স্যাম্পল রেট (Hz)
  const n = Math.ceil(total * GR) + GR;
  const duckAt = new Uint8Array(n); // 1 = এই মুহূর্তে মিউজিক নামবে
  const sil = detectSilences(voicePath);
  // কথার অংশ = নীরব অংশের পরিপূরক
  let t = 0;
  const speech = [];
  for (const q of sil) {
    if (q.s > t + 0.05) speech.push([t, q.s]);
    t = Math.max(t, q.e);
  }
  if (t < total - 0.05) speech.push([t, total + 1]);
  const lead = 0.12; // কথা শুরুর একটু আগেই মিউজিক নামতে শুরু করে
  for (const [a, b] of speech) {
    const i0 = Math.max(0, Math.floor((a - lead) * GR));
    const i1 = Math.min(n, Math.ceil(b * GR));
    for (let i = i0; i < i1; i++) duckAt[i] = 1;
  }
  const ratio = normal > 0 ? Math.min(1, duck / normal) : 1;
  const out = new Float32Array(n);
  let g = 1;
  const aDown = 1 - Math.exp(-1 / (GR * 0.06)); // নামা: দ্রুত (~০.০৬ সে)
  const aUp = 1 - Math.exp(-1 / (GR * 0.45)); // ওঠা: ধীর, স্বাভাবিক (~০.৪৫ সে)
  for (let i = 0; i < n; i++) {
    const tgt = duckAt[i] ? ratio : 1;
    g += (tgt - g) * (tgt < g ? aDown : aUp);
    out[i] = g;
  }
  const file = path.join(work, "gain.f32");
  fs.writeFileSync(file, Buffer.from(out.buffer));
  return { file, rate: GR, speechSecs: speech.reduce((s, [a, b]) => s + Math.min(b, total) - a, 0) };
}

// ---------- ব্র্যান্ড অ্যাসেট: সাবস্ক্রাইব ওভারলে (গ্রিন স্ক্রিন) ও এন্ড স্ক্রিন ----------
const UA = { "User-Agent": "Mozilla/5.0 (ReelsFactory renderer)" };
async function assertAsset(label, url) {
  if (url.startsWith("file://")) return;
  const res = await fetch(url, { method: "HEAD", headers: UA, redirect: "follow" }).catch(() => null);
  if (!res || !res.ok) throw new Error(`${label} ফাইল পাওয়া যায়নি (${res ? res.status : "network"}): ${url}`);
}
const hasAudioStream = (file) =>
  capture("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]).length > 0;

// প্রথম ফ্রেমের চার কোণ থেকে গ্রিন-স্ক্রিনের আসল রং বের করা (সবুজ/নীল যা-ই হোক)
function detectKeyColor(file) {
  const dims = capture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file]).split("x").map(Number);
  const [w, h] = dims;
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
  const buf = r.stdout;
  
  // যদি ডাইমেনশন বা বাফার ঠিক না থাকে, ডিফল্ট সবুজ রিটার্ন করবে
  if (!w || !h || !buf || buf.length < w * h * 3) return { hex: "00FF00", mode: "green" };
  
  const pts = [[4, 4], [w - 5, 4], [4, h - 5], [w - 5, h - 5]];
  const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const ch3 = [0, 1, 2].map((c) => med(pts.map(([x, y]) => buf[(y * w + x) * 3 + c])));
  
  const [R, G, B] = ch3;
  const mode = G > R + 30 && G > B + 30 ? "green" : B > R + 30 && B > G + 30 ? "blue" : "none";
  
  // সেফটি চেক: যদি ব্যাকগ্রাউন্ড নিশ্চিতভাবে সবুজ বা নীল না হয় (যেমন লাল বা অন্য রঙ ধরে ফেলে), 
  // তবে জোর করে স্ট্যান্ডার্ড গ্রিন স্ক্রিন (00FF00) সেট করে দেওয়া হলো যাতে মূল ভিডিও কেটে না যায়।
  if (mode === "none") {
    return { hex: "00FF00", mode: "green" };
  }

  const hex = ch3.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  return { hex, mode };
}


// কী-করা ফ্রেমগুলোর আসল দৃশ্যমান অংশের সীমানা (পুরো ক্যানভাস নয়) — যাতে ছোট করলে বাটনটাই ছোট হয়, ফাঁকা সবুজ অংশ নয়
function detectBBox(file, keyFilter) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-vf", `${keyFilter},format=yuva420p,alphaextract,cropdetect=limit=24:round=2:reset=0`, "-an", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const all = [...(r.stderr || "").matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
}

async function main() {
  const t0 = Date.now();
  if (job.overlay) await assertAsset("ওভারলে", job.overlay.url);
  if (job.endscreen) await assertAsset("এন্ড স্ক্রিন", job.endscreen.url);
  const segs = job.segments.slice().sort((a, b) => a.start - b.start);

  // ১) আইটেম তালিকা — সময় ফ্রেমে গোল করা (ক্রমযোজিত), যাতে অডিওর সাথে সময় সরে না যায়
  const items = [];
  let cursorF = 0;
  for (const s of segs) {
    let sF = toFrames(s.start);
    if (sF - cursorF < 3) sF = cursorF;
    else items.push({ kind: "gap", n: sF - cursorF });
    const eF = Math.max(sF + 1, toFrames(s.start + s.duration));
    items.push({ kind: "scene", n: eF - sF, media: s.media });
    cursorF = eF;
  }
  const M = items.length;
  console.log(`Job: ${segs.length} scenes (${M} items), ${W}x${H}, content ${cw}x${ch}, total ${job.total}s`);

  // ২) প্রতিটা সীমানার ট্রানজিশন-দৈর্ঘ্য (জোড় সংখ্যক ফ্রেম); ছোট দৃশ্যে হার্ড-কাট
  const tf = [];
  for (let k = 0; k < M - 1; k++) {
    let t = Math.min(16, Math.floor(0.45 * Math.min(items[k].n, items[k + 1].n)));
    t -= t % 2;
    tf.push(t >= 4 ? t : 0);
  }
  items.forEach((it, k) => {
    it.tp = k > 0 ? tf[k - 1] : 0;
    it.tn = k < M - 1 ? tf[k] : 0;
  });

  // ৩) রেন্ডার
  const pieces = [];
  for (let k = 0; k < M; k++) {
    report("scenes", k + 1, M, 4 + 62 * (k / M));
    console.log(`Item ${k + 1}/${M}`);
    pieces.push(await renderItem(items[k], k));
  }

  report("transitions", 0, M, 68, true);
  const seq = [];
  for (let k = 0; k < M; k++) {
    seq.push(pieces[k].body);
    if (k < M - 1 && tf[k] > 0) seq.push(buildTransition(k, pieces[k].tail, pieces[k + 1].head, tf[k]));
    report("transitions", k + 1, M, 68 + 10 * ((k + 1) / M));
  }
  fs.writeFileSync(path.join(work, "list.txt"), seq.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const joined = path.join(work, "joined.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-c", "copy", joined]);

  // ৪) বর্ডার + ক্যাপশন + অডিও
  const hasSubs = await buildCaptions();
  const vf = [];
  if (cw !== W || ch !== H) vf.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${borderHex}`);
  // গুরুত্বপূর্ণ: "subtitles" ফিল্টার সরল শেপিং ব্যবহার করে, তাই বাংলা যুক্তাক্ষর ভাঙে। "ass" + shaping=complex (HarfBuzz) দিলে ঠিক আসে।
  if (hasSubs) vf.push("ass=cap.ass:fontsdir=fonts:shaping=complex");

  const a = job.audio || {};
  let audioPath;
  if (a.file) audioPath = path.join(jobDir, path.basename(a.file));
  else {
    audioPath = path.join(work, "audio.bin");
    await download(a.url, audioPath);
  }
  const total = Number(job.total);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  if (job.music && a.file && !a.bg) {
    // ভয়েস + মিউজিক (ducking সহ) আগে আলাদা অডিও ফাইলে মেশানো হয়, তারপর ভিডিওর সাথে জোড়া লাগে
    const musicPath = path.join(jobDir, path.basename(job.music.file));
    const normal = clamp(Number(job.music.vol) || 0.4, 0.02, 1);
    const duck = clamp(Number(job.music.duck) || 0, 0, normal);
    const gain = buildGainCurve(audioPath, total, normal, duck);
    console.log(`Music: normal ${normal}, duck ${duck}, speech ~${Math.round(gain.speechSecs)}s of ${Math.round(total)}s`);
    const fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
    const fo = Math.max(0, total - 2).toFixed(2);
    const fc =
      `[0:a]${fmt}[voice];` +
      `[1:a]${fmt},volume=${normal},atrim=0:${total.toFixed(3)},afade=t=in:d=0.6,afade=t=out:st=${fo}:d=2[mus0];` +
      `[2:a]aresample=44100,pan=stereo|c0=c0|c1=c0,atrim=0:${total.toFixed(3)}[gain];` +
      `[mus0][gain]amultiply[mus];` +
      `[voice][mus]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.95[aout]`;
    const mixFile = path.join(work, "mix.wav");
    ff(["-i", audioPath, "-stream_loop", "-1", "-i", musicPath, "-f", "f32le", "-ar", String(gain.rate), "-ac", "1", "-i", gain.file,
        "-filter_complex", fc, "-map", "[aout]", "-t", total.toFixed(3), mixFile]);
    audioPath = mixFile;
  }

  const mixedVol = a.file && job.music && !a.bg ? 1 : a.volume || 1;
  let args;
  let progTotal = total;

  if (job.overlay || job.endscreen) {
    // ওভারলে (গ্রিন-স্ক্রিন কী) এবং/অথবা এন্ড স্ক্রিন সহ একটাই ফিল্টার-গ্রাফ
    const fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
    const mainDur = probeDuration(joined) || total;
    const inputs = ["-i", joined];
    if (a.bg) inputs.push("-stream_loop", "-1");
    inputs.push("-i", audioPath);
    let idx = 2;
    const fc = [];
    let cur = "[0:v]";
    let curChanged = false;
    let ovAudio = null;

    if (cw !== W || ch !== H) {
      fc.push(`${cur}pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${borderHex}[b1]`);
      cur = "[b1]";
      curChanged = true;
    }

        if (job.overlay) {
      const ovStart = Number(job.overlay.start) || 20;
      const ovDur = Number(job.overlay.dur) || 9;
      if (mainDur < ovStart + 1) {
        console.warn(`Overlay skipped: video (${mainDur.toFixed(1)}s) is shorter than ${ovStart + 1}s`);
      } else {
        const ovPath = path.join(work, "overlay.mp4");
        await download(job.overlay.url, ovPath);
        const key = detectKeyColor(ovPath);
        const keyF = `chromakey=color=0x${key.hex}:similarity=0.15:blend=0.1`;
        const bb = detectBBox(ovPath, keyF);
        const crop = bb ? `crop=${bb.w}:${bb.h}:${bb.x}:${bb.y},` : "";
        
        // ১. সাইজ ছোট করা: লোগোর চেয়ে একটু বড় রাখার জন্য ফ্র্যাকশন কমিয়ে 0.10 বা 0.12 করা হলো (প্রয়োজনে কম-বেশি করতে পারেন)
        const frac = Number(job.overlay.widthFrac) || 0.15; 
        const ow = Math.max(2, Math.round((W * frac) / 2) * 2);
        
        const despill = key.mode === "none" ? "" : `format=gbrap,despill=type=${key.mode},`;
        
        console.log(`Overlay: key 0x${key.hex} (${key.mode}), bbox ${bb ? `${bb.w}x${bb.h}@${bb.x},${bb.y}` : "full"}, width ${ow}px, at ${ovStart}s for ${ovDur}s`);
        
        fc.push(`[${idx}:v]${keyF},${crop}${despill}scale=${ow}:-2,format=yuva420p,setpts=PTS+${ovStart}/TB[ov]`);
        
        // ২. পজিশন পরিবর্তন: x=30 এবং y=30 দিয়ে এটিকে ভিডিওর ওপরের বাম কোণায় (Top-Left) সেট করা হলো
        fc.push(`${cur}[ov]overlay=x=30:y=30:enable='between(t,${ovStart},${ovStart + ovDur})':eof_action=pass[b2]`);
        
        cur = "[b2]";
        curChanged = true;
        if (hasAudioStream(ovPath)) ovAudio = `[${idx}:a]${fmt},adelay=${ovStart * 1000}|${ovStart * 1000}[oa]`;
        inputs.push("-i", ovPath);
        idx++;
      }
        }
    

    if (hasSubs) {
      fc.push(`${cur}ass=cap.ass:fontsdir=fonts:shaping=complex[b3]`);
      cur = "[b3]";
      curChanged = true;
    }

    // মূল অডিও (ভয়েস/মিক্স/মিউজিক) — মূল ভিডিওর দৈর্ঘ্যে ঠিক কাটা বা প্যাড করা, যাতে এন্ড স্ক্রিনের সময় না সরে
    const md = mainDur.toFixed(3);
    const fadeBg = a.bg ? `,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2` : "";
    fc.push(`[1:a]${fmt},volume=${mixedVol}${fadeBg}[ma]`);
    let aLabel = "[ma]";
    if (ovAudio) {
      fc.push(ovAudio);
      fc.push(`[ma][oa]amix=inputs=2:normalize=0:duration=first[mb]`);
      aLabel = "[mb]";
    }
    fc.push(`${aLabel}apad=whole_dur=${md},atrim=0:${md}[maina]`);

    let vOut = cur;
    let aOut = "[maina]";
    let needEncode = curChanged;

    if (job.endscreen) {
      const enPath = path.join(work, "endscreen.mp4");
      await download(job.endscreen.url, enPath);
      const enDur = probeDuration(enPath) || 10;
      const ed = enDur.toFixed(3);
      // এন্ড স্ক্রিন যেকোনো মাপে হোক, ফ্রেমে ঠিকভাবে বসে; ফাঁকা অংশে ঝাপসা ব্যাকগ্রাউন্ড
      fc.push(
        `[${idx}:v]split=2[e1][e2];` +
          `[e1]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:5[eb];` +
          `[e2]scale=${W}:${H}:force_original_aspect_ratio=decrease[ef];` +
          `[eb][ef]overlay=(W-w)/2:(H-h)/2,fps=${FPS},setsar=1,format=yuv420p[endv]`
      );
      if (hasAudioStream(enPath)) fc.push(`[${idx}:a]${fmt},apad=whole_dur=${ed},atrim=0:${ed}[enda]`);
      else fc.push(`anullsrc=r=44100:cl=stereo,atrim=0:${ed}[enda]`);
      fc.push(`${vOut}[maina][endv][enda]concat=n=2:v=1:a=1[vcat][acat]`);
      inputs.push("-i", enPath);
      idx++;
      vOut = "[vcat]";
      aOut = "[acat]";
      needEncode = true;
      progTotal = mainDur + enDur;
      console.log(`End screen: ${enDur.toFixed(1)}s appended`);
    }

    args = [...inputs, "-filter_complex", fc.join(";"), "-map", needEncode ? vOut : "0:v:0", "-map", aOut];
    if (needEncode) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p");
    else args.push("-c:v", "copy");
    if (!job.endscreen) args.push("-t", md);
    args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outFile);
  } else {
    const af = [`volume=${mixedVol}`];
    if (a.bg) af.push(`afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2`);
    args = ["-i", joined];
    if (a.bg) args.push("-stream_loop", "-1");
    args.push("-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-t", total.toFixed(3));
    if (vf.length) args.push("-vf", vf.join(","), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p");
    else args.push("-c:v", "copy");
    args.push("-af", af.join(","), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outFile);
  }

  report("final", 0, 0, 80, true);
  await runWithProgress(args, progTotal, (p) => report("final", 0, 0, 80 + 19 * p));
  report("final", 0, 0, 100, true);
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s -> ${outFile}`);
}

main().catch((e) => {
  console.error("RENDER ERROR:", e.message);
  process.exit(1);
});
