// ---- Leaflet base ----
const map = L.map('map', { worldCopyJump: true }).setView([20, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 7,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const layerSelect = document.getElementById('layerSelect');
const dateInput   = document.getElementById('dateInput');
const todayBtn    = document.getElementById('todayBtn');
const timeSlider  = document.getElementById('timeSlider');
const timeLabel   = document.getElementById('timeLabel');
const statusEl    = document.getElementById('status');
const legendBody  = document.getElementById('legendBody');

let gridLayer = L.layerGroup().addTo(map);

let currentDate = null;   // "YYYYMMDD"
let currentKind = "tec";  // "tec" or "no2"
let times = [];           // ["0000","0200",...]

function setStatus(msg){ statusEl.textContent = msg; }

function ymdToFolder(dateStr){ // "YYYY-MM-DD" -> "YYYYMMDD"
  return (dateStr || "").replaceAll("-", "");
}
function folderToISODate(ymd){ // "YYYYMMDD" -> "YYYY-MM-DD"
  return `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`;
}

// Simple blue<->red scale (no fancy palettes)
function colorScale(v, vmin, vmax){
  if (!isFinite(v)) return "rgba(0,0,0,0)";
  const x = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin || 1)));
  const r = Math.round(255 * x);
  const b = Math.round(255 * (1 - x));
  return `rgba(${r},0,${b},0.55)`;
}

async function fetchJson(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}

async function loadLatestDate(){
  const j = await fetchJson("./data/latest.json");
  if (!j?.date) throw new Error("latest.json missing date");
  return j.date;
}

async function loadManifest(ymd){
  return await fetchJson(`./data/${ Hawaiian(ymd)}`);
}
function Hawaiian(ymd){ return `${ymd}/manifest.json`; } // keep path tidy

async function loadLayerIndex(ymd, kind){
  return await fetchJson(`./data/${ymd}/${kind}/index.json`);
}

async function loadGrid(ymd, kind, hhmm){
  return await fetchJson(`./data/${ymd}/${kind}/${hhmm}.json`);
}

function drawGrid(grid, indexMeta){
  gridLayer.clearLayers();

  const dlat = indexMeta?.cell?.dlat ?? 2.0;
  const dlon = indexMeta?.cell?.dlon ?? 2.0;
  const unit = indexMeta?.unit ?? "";
  const vmin = indexMeta?.range?.vmin ?? 0;
  const vmax = indexMeta?.range?.vmax ?? 1;

  legendBody.innerHTML = `
    <div><b>Layer:</b> ${currentKind.toUpperCase()}</div>
    <div><b>Date:</b> ${folderToISODate(currentDate)} (UTC)</div>
    <div><b>Time:</b> ${timeLabel.textContent}</div>
    <div><b>Range:</b> ${vmin.toFixed(2)} – ${vmax.toFixed(2)} ${unit}</div>
    <div style="margin-top:6px; opacity:0.9;">Tip: hover cells for value</div>
  `;

  const cells = grid?.cells || [];
  for (const c of cells){
    const lat1 = c.lat, lon1 = c.lon;
    const lat2 = c.lat + dlat, lon2 = c.lon + dlon;
    const val = c.val;

    const rect = L.rectangle([[lat1, lon1], [lat2, lon2]], {
      stroke: false,
      fillColor: colorScale(val, vmin, vmax),
      fillOpacity: 1.0
    });
    rect.bindTooltip(`${Number(val).toFixed(2)} ${unit}`, { sticky: true });
    rect.addTo(gridLayer);
  }
}

async function refresh(){
  if (!currentDate) return;

  try{
    setStatus(`Loading ${currentKind.toUpperCase()} ${currentDate}...`);

    const idx = await loadLayerIndex(currentDate, currentKind);

    times = idx?.times_utc || [];
    if (!Array.isArray(times) || times.length === 0){
      timeSlider.min = 0; timeSlider.max = 0; timeSlider.value = 0;
      timeLabel.textContent = "--:-- UTC";
      gridLayer.clearLayers();
      setStatus(`No times in ${currentKind}/index.json (yet)`);
      return;
    }

    timeSlider.min = 0;
    timeSlider.max = times.length - 1;
    let i = parseInt(timeSlider.value || "0", 10);
    if (!Number.isFinite(i)) i = 0;
    i = Math.max(0, Math.min(times.length - 1, i));
    timeSlider.value = String(i);

    const hhmm = times[i];
    timeLabel.textContent = `${hhmm.slice(0,2)}:${hhmm.slice(2,4)} UTC`;

    const grid = await loadGrid(currentDate, currentKind, hhmm);
    drawGrid(grid, idx);

    setStatus(`OK (updated: ${idx?.updated_utc || "unknown"})`);
  } catch (e){
    gridLayer.clearLayers();
    setStatus(`Error: ${e.message}`);
    legendBody.textContent = "Data missing or not generated yet.";
  }
}

async function setDateFromLatest(){
  const ymd = await loadLatestDate();
  currentDate = ymd;
  dateInput.value = folderToISODate(ymd);
}

dateInput.addEventListener('change', async () => {
  currentDate = ymdToFolder(dateInput.value);
  timeSlider.value = "0";
  await refresh();
});

layerSelect.addEventListener('change', async () => {
  currentKind = layerSelect.value;
  timeSlider.value = "0";
  await refresh();
});

timeSlider.addEventListener('input', () => {
  refresh();
});

todayBtn.addEventListener('click', async () => {
  await setDateFromLatest();
  timeSlider.value = "0";
  await refresh();
});

// ---- boot ----
(async function boot(){
  try{
    await setDateFromLatest();
  } catch {
    // latest.json が無いときは今日(JSTではなくブラウザ日付)でフォールバック
    const d = new Date();
    const iso = d.toISOString().slice(0,10);
    dateInput.value = iso;
    currentDate = ymdToFolder(iso);
  }
  await refresh();
})();

