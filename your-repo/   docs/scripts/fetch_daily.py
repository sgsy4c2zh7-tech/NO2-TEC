import os, re, json
from datetime import datetime, timezone
import requests
import numpy as np

NOAA_DIR = "https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt/"
RE_FILE = re.compile(r"glotec_icao_(\d{8})T(\d{6})Z\.geojson")

def utc_now():
    return datetime.now(timezone.utc)

def cycle_from_now(dt: datetime) -> str:
    return "00Z" if dt.hour < 12 else "12Z"

def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)

def write_json(path: str, obj):
    ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def read_json(path: str):
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def list_noaa_files_for_utc_date(yyyymmdd: str):
    html = requests.get(NOAA_DIR, timeout=60).text
    files = sorted(set(re.findall(r'glotec_icao_\d{8}T\d{6}Z\.geojson', html)))
    day_files = []
    for fn in files:
        m = RE_FILE.search(fn)
        if m and m.group(1) == yyyymmdd:
            day_files.append(fn)
    return day_files

def floor_to_grid(val: float, step: float):
    return float(np.floor(val / step) * step)

def geojson_to_grid_cells(geojson: dict, dlat=2.0, dlon=2.0):
    acc = {}  # (lat,lon) -> [sum, count]
    feats = geojson.get("features", [])
    for f in feats:
        geom = f.get("geometry", {})
        prop = f.get("properties", {})
        if geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates", None)
        if not coords or len(coords) < 2:
            continue
        lon, lat = coords[0], coords[1]

        # NOAA側のキー揺れに備える
        v = prop.get("tec", None)
        if v is None: v = prop.get("TEC", None)
        if v is None: v = prop.get("vtec", None)
        if v is None:
            continue

        try:
            v = float(v)
        except Exception:
            continue

        lat0 = floor_to_grid(float(lat), dlat)
        lon0 = floor_to_grid(float(lon), dlon)
        key = (lat0, lon0)
        if key not in acc:
            acc[key] = [0.0, 0]
        acc[key][0] += v
        acc[key][1] += 1

    cells = [{"lat": lat0, "lon": lon0, "val": s/c} for (lat0, lon0), (s, c) in acc.items() if c > 0]
    return cells

def dummy_tec_grid(dlat=2.0, dlon=2.0):
    # NOAAが取れない時の保険（UI確認用）
    cells = []
    for lat in np.arange(-60, 62, dlat):
        for lon in np.arange(-180, 182, dlon):
            val = 10 + 20*np.exp(-(lat/30)**2) * (0.5 + 0.5*np.cos(np.deg2rad(lon)))
            cells.append({"lat": float(lat), "lon": float(lon), "val": float(val)})
    return cells

def main():
    now = utc_now()
    cycle = cycle_from_now(now)
    yyyymmdd = now.strftime("%Y%m%d")
    iso_now = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    base_dir = os.path.join("docs", "data", yyyymmdd)
    tec_dir  = os.path.join(base_dir, "tec")
    no2_dir  = os.path.join(base_dir, "no2")
    logs_dir = os.path.join(base_dir, "logs")
    ensure_dir(tec_dir); ensure_dir(no2_dir); ensure_dir(logs_dir)

    # latest.json
    write_json(os.path.join("docs", "data", "latest.json"), {"date": yyyymmdd})

    # ---- TEC (NOAA) ----
    day_files = list_noaa_files_for_utc_date(yyyymmdd)

    times_utc = []
    all_vals = []

    if day_files:
        for fn in day_files:
            m = RE_FILE.search(fn)
            if not m:
                continue
            hhmm = m.group(2)[:4]   # "041500" -> "0415"
            times_utc.append(hhmm)

            url = NOAA_DIR + fn
            gj = requests.get(url, timeout=60).json()
            cells = geojson_to_grid_cells(gj, dlat=2.0, dlon=2.0)

            for c in cells:
                v = c.get("val")
                if v is not None and np.isfinite(v):
                    all_vals.append(v)

            write_json(os.path.join(tec_dir, f"{hhmm}.json"), {
                "time_utc": f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}T{hhmm[:2]}:{hhmm[2:4]}:00Z",
                "cells": cells
            })

        times_utc = sorted(set(times_utc))
    else:
        # 取れない/まだ出てない場合もUIが動くようにダミーを出す
        times_utc = ["0000"]
        cells = dummy_tec_grid()
        all_vals = [c["val"] for c in cells]
        write_json(os.path.join(tec_dir, "0000.json"), {
            "time_utc": f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}T00:00:00Z",
            "cells": cells
        })

    # range（外れ値に強いようにパーセンタイル）
    if all_vals:
        vmin = max(0.0, float(np.percentile(all_vals, 2)))
        vmax = float(np.percentile(all_vals, 98))
        if vmax <= vmin:
            vmax = vmin + 1.0
    else:
        vmin, vmax = 0.0, 80.0

    write_json(os.path.join(tec_dir, "index.json"), {
        "kind": "tec",
        "date": yyyymmdd,
        "cycle_last": cycle,
        "updated_utc": iso_now,
        "unit": "TECU",
        "times_utc": times_utc,
        "cell": {"dlat": 2.0, "dlon": 2.0},
        "range": {"vmin": vmin, "vmax": vmax}
    })

    # ---- NO2 (placeholder) ----
    # ここにCAMS/S5Pの生成を後で追加
    write_json(os.path.join(no2_dir, "index.json"), {
        "kind": "no2",
        "date": yyyymmdd,
        "cycle_last": cycle,
        "updated_utc": iso_now,
        "unit": "arb.",
        "times_utc": [],
        "cell": {"dlat": 2.0, "dlon": 2.0},
        "range": {"vmin": 0.0, "vmax": 1.0},
        "note": "NO2 layer is placeholder. Add CAMS/Sentinel-5P fetch later."
    })

    # ---- manifest.json（この日の目次＋00Z/12Z履歴） ----
    manifest_path = os.path.join(base_dir, "manifest.json")
    manifest = read_json(manifest_path) or {
        "date": yyyymmdd,
        "runs": [],
        "layers": {
            "tec": {"path": "tec/index.json", "unit": "TECU"},
            "no2": {"path": "no2/index.json", "unit": "arb."}
        }
    }
    manifest["updated_utc"] = iso_now

    runs = manifest.get("runs", [])
    found = False
    for r in runs:
        if r.get("cycle") == cycle:
            r["fetched_utc"] = iso_now
            found = True
            break
    if not found:
        runs.append({"cycle": cycle, "fetched_utc": iso_now})

    order = {"00Z": 0, "12Z": 1}
    manifest["runs"] = sorted(runs, key=lambda x: order.get(x.get("cycle",""), 99))
    write_json(manifest_path, manifest)

    # logs（任意）
    write_json(os.path.join(logs_dir, f"fetch_{cycle}.json"), {
        "cycle": cycle,
        "utc_now": iso_now,
        "tec_files_found": len(day_files),
        "tec_times_written": times_utc,
        "note": "NO2 not fetched yet."
    })

    print(f"[OK] {yyyymmdd} cycle={cycle} TEC times={len(times_utc)}")

if __name__ == "__main__":
    main()

