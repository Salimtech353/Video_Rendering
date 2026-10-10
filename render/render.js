#!/usr/bin/env node
// Reels Factory — GitHub Actions ভিডিও রেন্ডারার (FFmpeg)
// ব্যবহার: node render/render.js jobs/<jobId> out/video.mp4
// জবের ফোল্ডারে job.json থাকে (ওয়েব অ্যাপ বানায়) + আপলোড/AI ছবি + অডিও।
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status})`);
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}
const ff = (args, opts) => run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "warning", ...args], opts);

async function download(url, dest) {
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

async function buildScene(seg, i) {
  const outp = path.join(work, `scene${i}.mp4`);
  const d = Math.max(0.1, seg.duration);
  const src = await resolveMedia(seg.media, `m${i}`);
  if (seg.media.type === "photo") {
    const frames = Math.max(1, Math.round(d * FPS));
    const vf =
      `scale=${cw * 2}:${ch * 2}:force_original_aspect_ratio=increase,crop=${cw * 2}:${ch * 2},` +
      `zoompan=z='1+0.15*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${cw}x${ch}:fps=${FPS},setsar=1`;
    ff(["-i", src, "-vf", vf, "-frames:v", String(frames), ...ENC, outp]);
  } else {
    // ক্লিপ ঠিক সিনের সময়ে আঁটাতে গতি বদলানো হয় (Shotstack পথের মতোই: speed = আসল দৈর্ঘ্য / সিনের দৈর্ঘ্য)
    const orig = probeDuration(src);
    const pre = orig > 0 ? `setpts=PTS/${clamp(orig / d, 0.1, 10).toFixed(4)},` : "";
    const vf = `${pre}fps=${FPS},scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},setsar=1,tpad=stop_mode=clone:stop_duration=${d.toFixed(3)}`;
    ff(["-i", src, "-vf", vf, "-t", d.toFixed(3), ...ENC, outp]);
  }
  return outp;
}

function buildGap(len, idx) {
  const outp = path.join(work, `gap${idx}.mp4`);
  const color = "0x" + String(job.borderColor || "#1A1A1A").replace("#", "");
  ff(["-f", "lavfi", "-i", `color=c=${color}:s=${cw}x${ch}:r=${FPS}:d=${len.toFixed(3)}`, ...ENC, outp]);
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
const assColor = (hex) => {
  const h = String(hex || "#ffffff").replace("#", "").padStart(6, "0");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
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
    `Style: Cap,${family},${c.size},${assColor(c.color)},${assColor(c.color)},&H00000000,&H00000000,${bold},0,0,0,100,100,0,0,1,0,0,2,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const fade = c.anim === "none" ? "" : "\\fad(150,150)";
  const pos = `\\an2\\pos(${Math.round(W / 2)},${Math.round(c.bottomY)})`;
  const events = c.lines.map((l) => {
    const text = String(l.text).replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");
    return `Dialogue: 0,${assTime(l.start)},${assTime(l.start + l.length)},Cap,,0,0,0,,{${pos}${fade}}${text}`;
  });
  fs.writeFileSync(path.join(work, "cap.ass"), head.concat(events).join("\n") + "\n", "utf8");
  return true;
}

async function main() {
  const t0 = Date.now();
  const segs = job.segments.slice().sort((a, b) => a.start - b.start);
  console.log(`Job: ${segs.length} scenes, ${W}x${H}, content ${cw}x${ch}, total ${job.total}s`);

  // ১) প্রতিটা দৃশ্য আলাদা রেন্ডার (মেমরি কম লাগে), ফাঁক থাকলে বর্ডার-রঙের ক্লিপ বসে
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.start - cursor > 0.05) parts.push(buildGap(s.start - cursor, i));
    console.log(`Scene ${i + 1}/${segs.length}`);
    parts.push(await buildScene(s, i));
    cursor = s.start + s.duration;
  }

  // ২) জোড়া লাগানো
  fs.writeFileSync(path.join(work, "list.txt"), parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const joined = path.join(work, "joined.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-c", "copy", joined]);

  // ৩) বর্ডার + ক্যাপশন + অডিও
  const hasSubs = await buildCaptions();
  const vf = [];
  if (cw !== W || ch !== H) vf.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x${String(job.borderColor || "#1A1A1A").replace("#", "")}`);
  if (hasSubs) vf.push("subtitles=cap.ass:fontsdir=fonts");

  const a = job.audio || {};
  let audioPath;
  if (a.file) audioPath = path.join(jobDir, path.basename(a.file));
  else {
    audioPath = path.join(work, "audio.bin");
    await download(a.url, audioPath);
  }
  const total = Number(job.total);
  const af = [`volume=${a.volume || 1}`];
  if (a.bg) af.push(`afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2`);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const args = ["-i", joined];
  if (a.bg) args.push("-stream_loop", "-1");
  args.push("-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-t", total.toFixed(3));
  if (vf.length) args.push("-vf", vf.join(","), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  args.push("-af", af.join(","), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outFile);
  ff(args, { cwd: work });
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s -> ${outFile}`);
}

main().catch((e) => {
  console.error("RENDER ERROR:", e.message);
  process.exit(1);
});
