// --- Global state ---
let accessToken = null;
let deviceId = null;
let uris = [];              // array of spotify:track:... URIs
let results = [];           // { uri, comment }
let currentIndex = 0;
let player = null;
let countdownTimer = null;
const PLAY_WINDOW_SEC = 45;

// --- Helpers ---
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const first = lines[0].split(",");
  let uriIdx = 0, header = false;

  if (first.length >= 1 && first.map(s => s.trim().toLowerCase()).includes("uri")) {
    header = true;
    uriIdx = first.findIndex(s => s.trim().toLowerCase() === "uri");
  }
  const start = header ? 1 : 0;
  const items = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const raw = (cols[uriIdx] || "").trim();
    if (!raw) continue;
    // Normalize to spotify:track:ID
    let id = raw;
    if (raw.startsWith("http")) {
      const m = raw.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
      if (m) id = `spotify:track:${m[1]}`;
    } else if (raw.startsWith("spotify:track:")) {
      // ok
    } else if (/^[A-Za-z0-9]+$/.test(raw)) {
      id = `spotify:track:${raw}`;
    } else {
      continue;
    }
    items.push(id);
  }
  return items;
}

function extractTrackId(uri) {
  const m = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  return m ? m[1] : null;
}

async function fetchJSON(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function putJSON(url, body) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body || {})
  });
  if (!r.ok && r.status !== 204) throw new Error(await r.text());
}

function downloadCsv(rows) {
  const header = ["uri", "comment"];
  const body = rows.map(r =>
    [r.uri, (r.comment || "").replaceAll('"', '""')].map(v => `"${v}"`).join(",")
  );
  const csv = [header.join(","), ...body].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g,"-");
  a.href = url;
  a.download = `spotify_notes_${timestamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Auth bootstrap ---
async function checkAuth() {
  try {
    const tok = await fetchJSON("/me/token");
    if (tok.authenticated) {
      accessToken = tok.access_token; // used only by Web Playback SDK init
      $("status").textContent = "Logged in";
      $("loginBtn").style.display = "none";
      $("connectPlayerBtn").disabled = false;
    }
  } catch (e) {
    $("status").textContent = "Not logged in";
  }
}
$("loginBtn").onclick = () => window.location.href = "/login";

// --- CSV upload ---
$("csvInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  uris = parseCsv(text);
  $("fileInfo").textContent = `Loaded ${uris.length} URIs`;
  $("startBtn").disabled = !(uris.length && deviceId);
});

// --- Web Playback SDK ---
window.onSpotifyWebPlaybackSDKReady = () => {
  $("connectPlayerBtn").disabled = false;
};

$("connectPlayerBtn").onclick = async () => {
  await checkAuth();
  if (!accessToken) {
    $("status").textContent = "Please log in first.";
    return;
  }
  player = new Spotify.Player({
    name: "🦍 Notes Player",
    getOAuthToken: cb => cb(accessToken),
    volume: 0.8
  });

  player.addListener('ready', ({ device_id }) => {
    deviceId = device_id;
    $("playerInfo").textContent = `Player ready. Device: ${device_id}`;
    $("startBtn").disabled = !(uris.length === 0);
    // startBtn remains disabled until CSV is uploaded
    if (uris.length) $("startBtn").disabled = false;
  });

  player.addListener('not_ready', ({ device_id }) => {
    $("playerInfo").textContent = `Player not ready: ${device_id}`;
  });

  player.addListener('initialization_error', ({ message }) => {
    $("playerInfo").textContent = `Init error: ${message}`;
  });
  player.addListener('authentication_error', ({ message }) => {
    $("playerInfo").textContent = `Auth error: ${message}`;
  });
  player.addListener('account_error', ({ message }) => {
    $("playerInfo").textContent = `Account error (Premium required): ${message}`;
  });

  await player.connect();
};

// --- Session logic ---
$("startBtn").onclick = async () => {
  if (!deviceId || !uris.length) return;
  $("startBtn").disabled = true;
  $("progress").textContent = `0/${uris.length} started…`;
  results = [];
  currentIndex = 0;
  runNext();
};

$("nextBtn").onclick = async () => {
  // Store comment for current track
  const uri = uris[currentIndex];
  const comment = $("commentBox").value.trim();
  results.push({ uri, comment });

  // Stop countdown if running
  if (countdownTimer) clearInterval(countdownTimer);
  $("modal").classList.add("hidden");

  currentIndex++;
  if (currentIndex >= uris.length) {
    // Done
    $("progress").textContent = `Done: ${uris.length}/${uris.length}`;
    //$("downloadBtn").disabled = false;
    try { await fetch("/spotify/pause?device_id=" + encodeURIComponent(deviceId), { method: "PUT", credentials: "include" }); } catch {}
    return;
  }
  runNext();
};

$("downloadBtn").onclick = () => {
  if (!results.length) {
    alert("No notes yet to download.");
  }
  downloadCsv(results)
};

async function runNext() {
  const uri = uris[currentIndex];
  $("progress").textContent = `Preparing ${currentIndex + 1}/${uris.length}…`;

  // Get track info (for title + duration)
  const trackId = extractTrackId(uri);
  let durationMs = 0, title = uri;
  try {
    const meta = await fetchJSON(`/spotify/track/${trackId}`);
    durationMs = meta.duration_ms || 0;
    title = meta.name ? `${meta.name} — ${meta.artists?.map(a => a.name).join(", ")}` : uri;
  } catch (e) {
    // fallback
    durationMs = 30000; // 30s default
  }

  const startMs = Math.floor(durationMs / 2);

  // Trigger play from halfway
  try {
    await putJSON("/spotify/play", {
      device_id: deviceId,
      uris: [uri],
      position_ms: startMs
    });
  } catch (e) {
    $("progress").textContent = `Play error: ${e.message}`;
    return;
  }

  // Open modal and start countdown
  $("trackTitle").textContent = title;
  $("commentBox").value = "";
  $("modal").classList.remove("hidden");

  let remain = PLAY_WINDOW_SEC;
  $("countdown").textContent = remain.toString();

  // Ensure pause after 15s (but user can still type and hit Next when ready)
  countdownTimer = setInterval(async () => {
    remain -= 1;
    $("countdown").textContent = remain.toString();
    if (remain <= 0) {
      clearInterval(countdownTimer);
      try {
        await fetch("/spotify/pause?device_id=" + encodeURIComponent(deviceId), { method: "PUT", credentials: "include" });
      } catch {}
    }
  }, 1000);
}

document.addEventListener("DOMContentLoaded", async () => {
  try { await checkAuth(); } catch {}
  if (location.hash === "#logged-in") {
    // clean the URL so refreshes don’t look weird
    history.replaceState(null, "", location.pathname);
  }
});
