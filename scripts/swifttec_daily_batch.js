#!/usr/bin/env node

const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const DATA_ROOT = path.join(DOCS_ROOT, "data");
const ARCHIVE_ROOT = path.join(DATA_ROOT, "archive");
const PORT = 8123;

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

function safeJoin(base, targetPath) {
  const resolved = path.resolve(base, "." + targetPath);
  if (!resolved.startsWith(base)) {
    throw new Error("Invalid path");
  }
  return resolved;
}

function createStaticServer(rootDir, port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      let reqPath = decodeURIComponent(url.pathname);

      if (reqPath === "/") reqPath = "/docs/index.html";

      let filePath = safeJoin(rootDir, reqPath);

      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      const data = await fsp.readFile(filePath);
      res.writeHead(200, {
        "Content-Type": mimeType(filePath),
        "Cache-Control": "no-store"
      });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Server Error: ${err.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function yearFromDayKey(dayKey) {
  return dayKey.slice(0, 4);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, text, "utf8");
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function subtractUtcDays(baseDate, days) {
  return new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);
}

async function pruneOldArchives(nowUtc = new Date(), keepDays = 365) {
  if (!(await pathExists(ARCHIVE_ROOT))) return;

  const cutoff = subtractUtcDays(nowUtc, keepDays);

  const years = await fsp.readdir(ARCHIVE_ROOT, { withFileTypes: true });
  for (const yearEnt of years) {
    if (!yearEnt.isDirectory()) continue;
    const yearDir = path.join(ARCHIVE_ROOT, yearEnt.name);
    const dayDirs = await fsp.readdir(yearDir, { withFileTypes: true });

    for (const dayEnt of dayDirs) {
      if (!dayEnt.isDirectory()) continue;
      const dayKey = dayEnt.name;
      const dt = new Date(`${dayKey}T00:00:00.000Z`);
      if (Number.isNaN(dt.getTime())) continue;

      if (dt < cutoff) {
        await fsp.rm(path.join(yearDir, dayKey), { recursive: true, force: true });
      }
    }

    const remaining = await fsp.readdir(yearDir);
    if (remaining.length === 0) {
      await fsp.rm(yearDir, { recursive: true, force: true });
    }
  }
}

async function readJsonSafe(filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    if (!text || !text.trim()) return null;
    return JSON.parse(text);
  } catch (err) {
    console.warn(`[history] skip invalid JSON: ${filePath} :: ${err.message}`);
    return null;
  }
}

async function buildHistoryIndex() {
  const items = [];

  if (!(await pathExists(ARCHIVE_ROOT))) {
    return { updatedAt: new Date().toISOString(), runs: [] };
  }

  const years = await fsp.readdir(ARCHIVE_ROOT, { withFileTypes: true });
  for (const yearEnt of years) {
    if (!yearEnt.isDirectory()) continue;
    const yearDir = path.join(ARCHIVE_ROOT, yearEnt.name);
    const dayDirs = await fsp.readdir(yearDir, { withFileTypes: true });

    for (const dayEnt of dayDirs) {
      if (!dayEnt.isDirectory()) continue;
      const dayKey = dayEnt.name;
      const dir = path.join(yearDir, dayKey);

      const summaryPathFs = path.join(dir, "summary.json");
      const metaPathFs = path.join(dir, "meta.json");
      const csvPathFs = path.join(dir, "tec_4day.csv");

      if (!(await pathExists(summaryPathFs)) || !(await pathExists(metaPathFs)) || !(await pathExists(csvPathFs))) {
        continue;
      }

      const summary = await readJsonSafe(summaryPathFs);
      const meta = await readJsonSafe(metaPathFs);

      if (!summary || !meta) {
        console.warn(`[history] skip broken archive: ${dir}`);
        continue;
      }

      items.push({
        dayKey,
        summaryPath: `./archive/${yearEnt.name}/${dayKey}/summary.json`,
        metaPath: `./archive/${yearEnt.name}/${dayKey}/meta.json`,
        csvPath: `./archive/${yearEnt.name}/${dayKey}/tec_4day.csv`,
        forecastStartUtc: meta.forecastStartUtc || null,
        forecastEndUtc: meta.forecastEndUtc || null,
        source: meta.source || null,
        noaaDayKey: meta.noaaDayKey || null,
        overall: summary.overall || null
      });
    }
  }

  items.sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));

  return {
    updatedAt: new Date().toISOString(),
    runs: items
  };
}

async function main() {
  const runStartedAt = new Date();
  const runDayKey = utcDayKey(runStartedAt);

  await ensureDir(DATA_ROOT);

  const server = await createStaticServer(REPO_ROOT, PORT);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 }
    });

    page.on("console", msg => {
      const text = msg.text();
      if (text) console.log(`[page:${msg.type()}] ${text}`);
    });

    page.on("pageerror", err => {
      console.error("[pageerror]", err);
    });

    const url = `http://127.0.0.1:${PORT}/docs/index.html?automation=1`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 180000 });

    await page.waitForFunction(() => {
      return typeof window.swifttecAutomation?.runDailyBatch === "function";
    }, { timeout: 180000 });

    const result = await page.evaluate(async ({ runDayKey }) => {
      return await window.swifttecAutomation.runDailyBatch({ runDayKey });
    }, { runDayKey });

    if (!result || !result.ok) {
      throw new Error(result?.error || "Unknown automation failure");
    }

    const year = yearFromDayKey(runDayKey);
    const archiveDir = path.join(ARCHIVE_ROOT, year, runDayKey);

    const meta = {
      runDayKey,
      runStartedAt: runStartedAt.toISOString(),
      runFinishedAt: new Date().toISOString(),
      source: result.meta.source,
      forecastStartUtc: result.meta.forecastStartUtc,
      forecastEndUtc: result.meta.forecastEndUtc,
      frameCount: result.meta.frameCount,
      grid: result.meta.grid,
      noaaDayKey: result.meta.noaaDayKey,
      noaaFiles: result.meta.noaaFiles,
      notes: [
        "Generated by GitHub Actions + headless Chromium.",
        "Forecast logic executed from the same SWIFT-TEC page code."
      ]
    };

    await writeJson(path.join(archiveDir, "summary.json"), result.summary);
    await writeJson(path.join(archiveDir, "meta.json"), meta);
    await writeText(path.join(archiveDir, "tec_4day.csv"), result.csvText);

    const latest = {
      updatedAt: new Date().toISOString(),
      latestDayKey: runDayKey,
      latestSummaryPath: `./archive/${year}/${runDayKey}/summary.json`,
      latestMetaPath: `./archive/${year}/${runDayKey}/meta.json`,
      latestCsvPath: `./archive/${year}/${runDayKey}/tec_4day.csv`,
      summary: result.summary,
      meta
    };
    await writeJson(path.join(DATA_ROOT, "latest.json"), latest);

    await pruneOldArchives(new Date(), 365);

    try {
      const historyIndex = await buildHistoryIndex();
      await writeJson(path.join(DATA_ROOT, "history.json"), historyIndex);
    } catch (err) {
      console.warn("[history] history.json generation skipped:", err.message);
    }

    console.log("SWIFT-TEC daily batch completed successfully.");
    console.log(`Archive written to: docs/data/archive/${year}/${runDayKey}/`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
