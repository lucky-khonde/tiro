// Tiro – serveur de téléchargement (aucune dépendance npm, juste Node 18+ et yt-dlp + ffmpeg)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_BIN || "yt-dlp";
const TMP = path.join(__dirname, "tmp");
const PUBLIC = __dirname;
const STATIC = new Set(["index.html", "manifest.webmanifest", "icon.svg", "sw.js"]);
const TTL_MS = 60 * 60 * 1000; // fichiers supprimés après 1 heure
const MAX_PER_MIN = 12; // limite par IP

fs.mkdirSync(TMP, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

// ---------- utilitaires ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_MIN;
}

function validUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname;
    // pas d'accès au réseau interne
    if (
      h === "localhost" ||
      /^(127|10|0)\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h) ||
      h.endsWith(".local") ||
      h === "[::1]"
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function run(args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("Délai dépassé"));
    }, timeout);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(e.code === "ENOENT" ? "yt-dlp n'est pas installé sur le serveur" : e.message));
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error((err.trim().split("\n").pop() || "Échec").replace(/^ERROR:\s*/, "")));
    });
  });
}

// ---------- API ----------
async function analyze(url) {
  const out = await run(["-J", "--no-playlist", "--no-warnings", url], 60000);
  const j = JSON.parse(out);
  const heights = [
    ...new Set((j.formats || []).filter((f) => f.vcodec && f.vcodec !== "none" && f.height).map((f) => f.height)),
  ].sort((a, b) => b - a);
  return {
    title: j.title || "Vidéo",
    uploader: j.uploader || j.channel || "",
    duration: j.duration || null,
    thumbnail: j.thumbnail || null,
    site: j.extractor_key || "",
    heights,
  };
}

async function prepare(url, kind, height) {
  const id = crypto.randomBytes(8).toString("hex");
  const base = path.join(TMP, id);
  const common = ["--no-playlist", "--no-warnings", "--restrict-filenames", "-o", base + ".%(ext)s", "--print", "after_move:filepath"];
  let args;
  if (kind === "mp3") {
    args = ["-x", "--audio-format", "mp3", "--audio-quality", "0", ...common];
  } else {
    const h = Number(height) > 0 ? `[height<=${Number(height)}]` : "";
    args = [
      "-f",
      `bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/bv*${h}+ba/b${h}/b`,
      "--merge-output-format",
      "mp4",
      ...common,
    ];
  }
  const out = await run([...args, url], 10 * 60 * 1000);
  const file = out.trim().split("\n").pop();
  if (!file || !fs.existsSync(file)) throw new Error("Fichier introuvable après le téléchargement");
  return { id, file: path.basename(file) };
}

// ---------- nettoyage ----------
function cleanup() {
  const now = Date.now();
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    try {
      if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.rmSync(p, { force: true, recursive: true });
    } catch {}
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();
cleanup();

// ---------- serveur ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;

  try {
    if (u.pathname === "/api/analyze" && req.method === "POST") {
      if (rateLimited(ip)) return send(res, 429, { error: "Trop de requêtes, patientez une minute." });
      const { url } = await readBody(req);
      if (!validUrl(url)) return send(res, 400, { error: "Lien invalide." });
      return send(res, 200, await analyze(url));
    }

    if (u.pathname === "/api/prepare" && req.method === "POST") {
      if (rateLimited(ip)) return send(res, 429, { error: "Trop de requêtes, patientez une minute." });
      const { url, kind, height } = await readBody(req);
      if (!validUrl(url)) return send(res, 400, { error: "Lien invalide." });
      if (!["mp4", "mp3"].includes(kind)) return send(res, 400, { error: "Format invalide." });
      const r = await prepare(url, kind, height);
      return send(res, 200, { ...r, download: `/api/file/${r.file}` });
    }

    if (u.pathname.startsWith("/api/file/")) {
      const name = path.basename(decodeURIComponent(u.pathname.slice(10)));
      const p = path.join(TMP, name);
      if (!/^[a-f0-9]{16}\./.test(name) || !fs.existsSync(p)) {
        res.writeHead(404);
        return res.end("Fichier expiré ou introuvable");
      }
      const st = fs.statSync(p);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(p)] || "application/octet-stream",
        "Content-Length": st.size,
        "Content-Disposition": `attachment; filename="video-${name.slice(0, 6)}${path.extname(p)}"`,
      });
      return fs.createReadStream(p).pipe(res);
    }

    // fichiers statiques
    const rel = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    const p = path.join(PUBLIC, rel);
    if (!STATIC.has(rel) || !fs.existsSync(p)) {
      res.writeHead(404);
      return res.end("Introuvable");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    send(res, 500, { error: e.message || "Erreur serveur" });
  }
});

server.listen(PORT, () => console.log(`Tiro prêt sur http://localhost:${PORT}`));
