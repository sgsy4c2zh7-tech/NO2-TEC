(function () {
  "use strict";

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitFor(cond, timeoutMs = 180000, intervalMs = 500, label = "condition") {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      async function tick() {
        try {
          if (await cond()) {
            resolve();
            return;
          }
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Timeout waiting for ${label}`));
            return;
          }
          setTimeout(tick, intervalMs);
        } catch (err) {
          reject(err);
        }
      }

      tick();
    });
  }

  function setValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setChecked(id, checked) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = !!checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function toIsoNoMs(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    return d.toISOString().replace(".000Z", "Z");
  }

  function safeNumber(x, fallback = null) {
    return Number.isFinite(x) ? x : fallback;
  }

  function calcFrameStats(frame) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;

    for (let i = 0; i < frame.length; i++) {
      const row = frame[i];
      for (let j = 0; j < row.length; j++) {
        const v = row[j];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        count++;
      }
    }

    return {
      minTec: count ? +min.toFixed(3) : null,
      maxTec: count ? +max.toFixed(3) : null,
      meanTec: count ? +(sum / count).toFixed(3) : null,
      count
    };
  }

  function buildCsvText() {
    if (!window.gGrid || !window.gForecastFrames?.length || !window.gForecastTimes?.length) {
      throw new Error("Forecast frames are not ready");
    }

    const cfg = typeof window.getConfigFromUI === "function"
      ? window.getConfigFromUI()
      : { kL1: 0.16 };

    const rows = [];
    rows.push(["time_utc", "lat", "lon", "tec_tecu", "gpsL1_m"].join(","));

    for (let s = 0; s < window.gForecastTimes.length; s++) {
      const t = window.gForecastTimes[s].toISOString().replace(".000Z", "Z");
      const frame = window.gForecastFrames[s];
      for (let i = 0; i < window.gGrid.nLat; i++) {
        const lat = window.gGrid.latArr[i];
        for (let j = 0; j < window.gGrid.nLon; j++) {
          const lon = window.gGrid.lonArr[j];
          const tec = frame[i][j];
          const gps = (Number.isFinite(tec) ? tec : 0) * cfg.kL1;
          rows.push([
            t,
            lat,
            lon,
            Number.isFinite(tec) ? tec.toFixed(2) : "",
            Number.isFinite(gps) ? gps.toFixed(2) : ""
          ].join(","));
        }
      }
    }

    return rows.join("\n");
  }

  function buildSummary(runDayKey) {
    if (!window.gForecastFrames?.length || !window.gForecastTimes?.length) {
      throw new Error("No forecast result");
    }

    const frameSummaries = [];
    let overallMax = -Infinity;
    let overallMin = Infinity;
    let maxAt = null;

    for (let s = 0; s < window.gForecastFrames.length; s++) {
      const stats = calcFrameStats(window.gForecastFrames[s]);
      const t = window.gForecastTimes[s];

      if (stats.maxTec != null && stats.maxTec > overallMax) {
        overallMax = stats.maxTec;
        maxAt = toIsoNoMs(t);
      }
      if (stats.minTec != null && stats.minTec < overallMin) {
        overallMin = stats.minTec;
      }

      frameSummaries.push({
        step: s,
        timeUtc: toIsoNoMs(t),
        ...stats
      });
    }

    return {
      runDayKey,
      forecastStartUtc: toIsoNoMs(window.gForecastStart),
      forecastEndUtc: toIsoNoMs(window.gForecastTimes[window.gForecastTimes.length - 1]),
      overall: {
        minTec: Number.isFinite(overallMin) ? overallMin : null,
        maxTec: Number.isFinite(overallMax) ? overallMax : null,
        maxTecTimeUtc: maxAt,
        frameCount: window.gForecastFrames.length,
        gridPointCount: window.gGrid.nLat * window.gGrid.nLon
      },
      frames: frameSummaries
    };
  }

  async function prepareInputs() {
    setValue("tecSourceSelect", "noaa");
    setChecked("dbgNoaaMix", false);

    if (typeof window.fetchNoaaGloTecPrevDay12_2hour !== "function") {
      throw new Error("fetchNoaaGloTecPrevDay12_2hour not found");
    }
    if (typeof window.fetchNoaa3DayGeomagToTextarea !== "function") {
      throw new Error("fetchNoaa3DayGeomagToTextarea not found");
    }
    if (typeof window.fetchNoaaPlanetaryKIndex1DayToBase !== "function") {
      throw new Error("fetchNoaaPlanetaryKIndex1DayToBase not found");
    }
    if (typeof window.fetchNoaaXrayFlareLatestToBase !== "function") {
      throw new Error("fetchNoaaXrayFlareLatestToBase not found");
    }

    await window.fetchNoaaGloTecPrevDay12_2hour(false);
    await waitFor(
      () => Array.isArray(window.gNoaaDayFrames) && window.gNoaaDayFrames.length === 12,
      180000,
      500,
      "NOAA TEC frames"
    );

    await window.fetchNoaa3DayGeomagToTextarea();
    await waitFor(() => {
      const el = document.getElementById("noaaKpText");
      return !!el && !!el.value && el.value.trim().length > 0;
    }, 120000, 500, "NOAA 3-day Kp text");

    await window.fetchNoaaPlanetaryKIndex1DayToBase();
    await waitFor(() => {
      const el = document.getElementById("baseKpJson");
      return !!el && !!el.value && el.value.trim().length > 0;
    }, 120000, 500, "Base Kp JSON");

    await window.fetchNoaaXrayFlareLatestToBase();
    await sleep(1000);

    if (typeof window.fillForecastStartCandidates === "function") {
      window.fillForecastStartCandidates();
    }
  }

  function chooseForecastStart() {
    const sel = document.getElementById("forecastStartSelect");
    if (!sel || !sel.options.length) {
      throw new Error("forecastStartSelect is empty");
    }

    if (sel.value) return sel.value;

    for (const opt of Array.from(sel.options)) {
      if (opt.value) {
        sel.value = opt.value;
        return opt.value;
      }
    }

    throw new Error("No valid forecast start candidate");
  }

  async function runDailyBatch({ runDayKey } = {}) {
    try {
      await prepareInputs();

      const forecastStartIso = chooseForecastStart();

      if (typeof window.runForecast !== "function") {
        throw new Error("runForecast not found");
      }

      window.runForecast();

      await waitFor(() => {
        return Array.isArray(window.gForecastFrames)
          && window.gForecastFrames.length > 0
          && Array.isArray(window.gForecastTimes)
          && window.gForecastTimes.length > 0
          && window.gGrid
          && Number.isFinite(window.gGrid.nLat)
          && Number.isFinite(window.gGrid.nLon);
      }, 180000, 500, "forecast completion");

      const csvText = buildCsvText();
      const summary = buildSummary(runDayKey || new Date().toISOString().slice(0, 10));

      return {
        ok: true,
        csvText,
        summary,
        meta: {
          source: "noaa",
          forecastStartUtc: forecastStartIso,
          forecastEndUtc: toIsoNoMs(window.gForecastTimes[window.gForecastTimes.length - 1]),
          frameCount: window.gForecastFrames.length,
          grid: {
            nLat: window.gGrid.nLat,
            nLon: window.gGrid.nLon,
            latMin: safeNumber(window.gGrid.latArr?.[0]),
            latMax: safeNumber(window.gGrid.latArr?.[window.gGrid.nLat - 1]),
            lonMin: safeNumber(window.gGrid.lonArr?.[0]),
            lonMax: safeNumber(window.gGrid.lonArr?.[window.gGrid.nLon - 1])
          },
          noaaDayKey: window.gNoaaDayKey || null,
          noaaFiles: Array.isArray(window.gNoaaDayFiles) ? window.gNoaaDayFiles : []
        }
      };
    } catch (error) {
      console.error(error);
      return {
        ok: false,
        error: error?.message || String(error)
      };
    }
  }

  window.swifttecAutomation = {
    runDailyBatch
  };
})();
