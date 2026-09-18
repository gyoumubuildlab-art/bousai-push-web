// ============================================================
// sw.js
// 「他のアプリの上に重ねて表示」に相当するAndroidの仕組みは無いが、
// PWA化した上でこのService Workerを使うと、対応ブラウザ・条件下では
// タブを閉じていても定期的にバックグラウンドでチェックできる可能性がある。
//
// 重要な注意(必ず読んでください):
// ・Periodic Background Sync という実験的な仕組みを使っています。
//   対応しているのは現時点でAndroid版Chrome系ブラウザのみです。
//   iPhoneのSafariには、この仕組み自体が存在しません。
// ・実行される間隔は「希望する間隔」を伝えるだけで、実際にいつ実行されるかは
//   ブラウザ・OSの省電力状況などにより変わり、保証されません
//   (設定した分数より大幅に遅れることがあります)。
// ・つまりこれは「タブを開いておく」運用を完全に置き換えるものではなく、
//   あくまで「多少の改善が期待できるかもしれない」best-effortの機能です。
// ============================================================

// 以前は importScripts("shared.js") で別ファイルを読み込んでいましたが、
// ファイル数を減らすため、この下に内容をそのまま統合しています。

// ============================================================
// shared.js
// ページ(bousai_level_notify_html.html)とService Worker(sw.js)の
// 両方から読み込む共通の定数・判定ロジック。
// <script src="shared.js"> と importScripts("shared.js") の
// どちらからも同じ内容で使えるよう、プレーンなグローバル関数・定数のみで書く。
// ============================================================

const AREA_JSON_URL = "https://www.jma.go.jp/bosai/common/const/area.json";
const OFFICE_WARNING_URL = code => `https://www.jma.go.jp/bosai/warning/data/r8/${code}.json`;
const REGION_ORDER_KEYWORDS = ["北海道","東北","関東","東海","北陸","近畿","中国","四国","九州","沖縄"];

// 警報コード → 警戒レベル対応表(2026年5月29日の気象庁「防災気象情報の体系整理」以降の新コード体系)
// 対象は大雨・土砂災害・高潮の3種類のみ。河川氾濫は別データのため対象外。
const CODE_TO_LEVEL = {
  "10": 2, "29": 2, "19": 2,
  "03": 3, "09": 3, "08": 3,
  "43": 4, "49": 4, "48": 4,
  "33": 5, "39": 5, "38": 5,
};

// ------------------------------------------------------------
// 地震情報の設定
// ------------------------------------------------------------
const QUAKE_LIST_URL = "https://www.jma.go.jp/bosai/quake/data/list.json";
const QUAKE_DETAIL_URL = filename => `https://www.jma.go.jp/bosai/quake/data/${filename}`;
// 都道府県コード(JIS): 11=埼玉県, 12=千葉県, 13=東京都, 14=神奈川県
const QUAKE_SPECIAL_PREF_CODES = new Set(["11", "12", "13", "14"]);
const QUAKE_SPECIAL_THRESHOLD = "5+"; // 東京・神奈川・千葉・埼玉 → 震度5強以上
const QUAKE_NORMAL_THRESHOLD = "6-";  // それ以外の都道府県 → 震度6弱以上
const INTENSITY_ORDER = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

function intensityValue(intStr) {
  const idx = INTENSITY_ORDER.indexOf(intStr);
  return idx === -1 ? -1 : idx;
}

// 気象庁の警報JSONは新体系(2026年5月29日以降)で構造が変わり、以前は "warnings" と
// いう配列名だったものが別名になっている場合がある。特定のキー名に依存せず、
// {code, status} の形をした要素をJSON全体から総当たりで探す。
function maxLevelFromWarningJson(data) {
  let maxLevel = 0;
  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(item => {
        if (item && typeof item === "object" && "code" in item) {
          if (item.code && item.status !== "解除") {
            const lv = CODE_TO_LEVEL[String(item.code)] || 0;
            if (lv > maxLevel) maxLevel = lv;
          }
        }
        walk(item);
      });
      return;
    }
    if (!node || typeof node !== "object") return;
    Object.values(node).forEach(walk);
  }
  walk(data);
  return maxLevel;
}

// ------------------------------------------------------------
// IndexedDBの簡易キーバリューストア(ページ・Service Worker共通)
// 設定(settings)や重複通知防止用の指紋(fingerprint)の受け渡しに使う。
// ------------------------------------------------------------
const IDB_NAME = "jma_monitor_db";
const IDB_STORE = "kv";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ------------------------------------------------------------
// 気象警報・地震情報のチェック(バックグラウンド実行用の簡易版)
// ページ側の進捗表示付き版とは別に、Service Workerからも呼べる
// シンプルな(地方ごとの逐次表示を行わない)一括チェック関数。
// ------------------------------------------------------------
async function fetchOfficesMap() {
  const res = await fetch(AREA_JSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("area.json取得失敗: " + res.status);
  const data = await res.json();
  const offices = {};
  Object.entries(data.offices || {}).forEach(([code, v]) => { offices[code] = v.name || code; });
  return offices;
}

async function checkWeatherOnce(settings) {
  const offices = await fetchOfficesMap();
  let targetCodes;
  if (settings.mode === "custom" && settings.offices && settings.offices.length) {
    targetCodes = settings.offices.filter(c => offices[c]);
  } else {
    targetCodes = Object.keys(offices);
  }
  const threshold = settings.threshold || 5;

  const affected = [];
  const BATCH = 8; // 一度に投げるリクエスト数を抑える
  for (let i = 0; i < targetCodes.length; i += BATCH) {
    const batch = targetCodes.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async code => {
      try {
        const res = await fetch(OFFICE_WARNING_URL(code), { cache: "no-store" });
        if (!res.ok) return null;
        const data = await res.json();
        const level = maxLevelFromWarningJson(data);
        return level >= threshold ? { name: offices[code], level } : null;
      } catch (e) {
        return null;
      }
    }));
    results.forEach(r => { if (r) affected.push(r); });
  }
  return affected;
}

async function checkEarthquakeOnce() {
  const res = await fetch(QUAKE_LIST_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("地震情報一覧の取得失敗: " + res.status);
  const list = await res.json();

  const candidates = list.filter(item => intensityValue(item.maxi) >= intensityValue("5-"));
  const affected = [];
  for (const item of candidates.slice(0, 15)) {
    if (!item.json) continue;
    try {
      const detailRes = await fetch(QUAKE_DETAIL_URL(item.json), { cache: "no-store" });
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      const prefs = detail?.Body?.Intensity?.Observation?.Pref;
      if (!Array.isArray(prefs)) continue;

      for (const pref of prefs) {
        const threshold = QUAKE_SPECIAL_PREF_CODES.has(pref.Code) ? QUAKE_SPECIAL_THRESHOLD : QUAKE_NORMAL_THRESHOLD;
        if (intensityValue(pref.MaxInt) >= intensityValue(threshold)) {
          affected.push({
            prefName: pref.Name,
            prefCode: pref.Code,
            maxInt: pref.MaxInt,
            hypocenterName: item.anm || detail?.Body?.Earthquake?.Hypocenter?.Area?.Name || "震源不明",
            at: item.at,
            eid: item.eid || item.json,
          });
        }
      }
    } catch (e) {
      continue;
    }
  }
  return affected;
}

// ------------------------------------------------------------
// 氾濫(指定河川洪水予報)の設定・チェック(バックグラウンド実行用)
// ------------------------------------------------------------
const FLOOD_XML_URL = "https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json";
const JIS_PREF_NAMES = {
  "01":"北海道","02":"青森県","03":"岩手県","04":"宮城県","05":"秋田県",
  "06":"山形県","07":"福島県","08":"茨城県","09":"栃木県","10":"群馬県",
  "11":"埼玉県","12":"千葉県","13":"東京都","14":"神奈川県","15":"新潟県",
  "16":"富山県","17":"石川県","18":"福井県","19":"山梨県","20":"長野県",
  "21":"岐阜県","22":"静岡県","23":"愛知県","24":"三重県","25":"滋賀県",
  "26":"京都府","27":"大阪府","28":"兵庫県","29":"奈良県","30":"和歌山県",
  "31":"鳥取県","32":"島根県","33":"岡山県","34":"広島県","35":"山口県",
  "36":"徳島県","37":"香川県","38":"愛媛県","39":"高知県","40":"福岡県",
  "41":"佐賀県","42":"長崎県","43":"熊本県","44":"大分県","45":"宮崎県",
  "46":"鹿児島県","47":"沖縄県",
};

function getTargetPrefPrefixesFromOffices(offices, settings) {
  let targetCodes;
  if (settings.mode === "custom" && settings.offices && settings.offices.length) {
    targetCodes = settings.offices.filter(c => offices[c]);
  } else {
    targetCodes = Object.keys(offices);
  }
  return new Set(targetCodes.map(c => c.slice(0, 2)));
}

async function checkFloodOnce(offices, settings) {
  const threshold = settings.threshold || 5;
  const targetPrefixes = getTargetPrefPrefixesFromOffices(offices, settings);

  const res = await fetch(FLOOD_XML_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("氾濫情報の取得失敗: " + res.status);
  const entries = await res.json();

  const affected = [];
  for (const entry of entries) {
    const item = entry.item || {};
    const title = item.name || "";
    if (!title || title.includes("解除")) continue;
    const m = title.match(/レベル\s*([2-5])/);
    if (!m) continue;
    const level = parseInt(m[1], 10);
    if (level < threshold) continue;

    for (const area of (item.areas || [])) {
      const areaCode = area.code || "";
      const prefCode = areaCode.slice(0, 2);
      if (!targetPrefixes.has(prefCode)) continue;
      affected.push({
        prefName: JIS_PREF_NAMES[prefCode] || prefCode,
        prefCode,
        level,
        riverAreaName: area.name || "",
        title,
      });
    }
  }
  return affected;
}



const CACHE_NAME = "bousai-notify-cache-v2";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 古いバージョンのキャッシュを消す(これがないと、更新しても
      // 古いページがいつまでも表示され続けることがある)
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// 「まずネットワークから最新を取りに行き、失敗した時だけキャッシュを使う」方式。
// これなら、GitHub側を更新すればスマホ側も次に開いた時に必ず最新になる。
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ------------------------------------------------------------
// Web Push (Push API) — NAS から直接送られてくる通知を受け取る本体。
// periodicsync とは別物: こちらはNAS側が能動的に送信し、それをきっかけに
// このイベントが発火する。ブラウザ側の自発的なチェックではないので、
// タイミングのブレがなく、iPhoneでも(条件付きで)動作する。
// ------------------------------------------------------------
// 通知の見た目を強調するための、赤い警告アイコン(データURIで完結、追加ファイル不要)
const WARNING_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<circle cx="50" cy="50" r="48" fill="#d32f2f"/>' +
    '<text x="50" y="72" font-size="60" text-anchor="middle" fill="white">!</text>' +
    "</svg>"
  );

self.addEventListener("push", (event) => {
  let payload = { title: "防災通知", body: "" , tag: "jma-push"};
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch (e) {
    // JSON以外(プレーンテキスト)で送られてきた場合の保険
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag || "jma-push",
      requireInteraction: true,   // ユーザーが閉じるまで通知を残す
      vibrate: [300, 150, 300, 150, 300],
      renotify: true,             // 同じtagでも毎回振動・音を鳴らし直す
      icon: WARNING_ICON,         // 通知一覧で他のメール等と見分けやすくする赤い警告アイコン
    })
  );
});

// 通知をタップしたらアプリを開く(既に開いていればそのタブにフォーカス)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientsArr) => {
      if (clientsArr.length > 0) {
        return clientsArr[0].focus();
      }
      return self.clients.openWindow("./");
    })
  );
});

// ------------------------------------------------------------
// 定期バックグラウンド同期(Periodic Background Sync)
// ------------------------------------------------------------
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "jma-check") {
    event.waitUntil(runBackgroundCheck());
  }
});

// 通常のBackground Sync(オフライン→オンライン復帰時などに1回だけ実行される)にも
// 念のため対応しておく。Periodic Background Syncが使えない環境での保険。
self.addEventListener("sync", (event) => {
  if (event.tag === "jma-check-once") {
    event.waitUntil(runBackgroundCheck());
  }
});

// ページ側からの手動トリガー(動作確認用)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "RUN_CHECK_NOW") {
    event.waitUntil(runBackgroundCheck());
  }
});

async function notifyIfSupported(title, body, tag) {
  try {
    await self.registration.showNotification(title, { body, tag });
  } catch (e) {
    console.error("通知の表示に失敗しました:", e);
  }
}

async function runBackgroundCheck() {
  const settings = (await idbGet("settings")) || { mode: "all", offices: [], threshold: 5 };
  let offices = null;

  // --- 気象警報 ---
  try {
    offices = await fetchOfficesMap();
    const affected = await checkWeatherOnce(settings);
    const fingerprint = affected.map((a) => `${a.name}:${a.level}`).sort().join(",");
    const last = await idbGet("lastFingerprint");
    if (affected.length && fingerprint !== last) {
      const thresholdShown = Math.min(...affected.map((a) => a.level));
      const detail = affected.map((a) => `${a.name}(レベル${a.level})`).join("、");
      await notifyIfSupported(`気象庁 警戒レベル${thresholdShown}以上`, detail, "jma-level-alert");
    }
    await idbSet("lastFingerprint", fingerprint);
  } catch (e) {
    console.error("バックグラウンド気象チェック失敗:", e);
  }

  // --- 地震情報 ---
  try {
    const affectedQuakes = await checkEarthquakeOnce();
    const fingerprint = affectedQuakes.map((q) => `${q.eid}:${q.prefName}:${q.maxInt}`).sort().join(",");
    const last = await idbGet("lastQuakeFingerprint");
    if (affectedQuakes.length && fingerprint !== last) {
      const detail = affectedQuakes.map((q) => `${q.prefName}(震度${q.maxInt})`).join("、");
      await notifyIfSupported("気象庁 地震情報", detail, "jma-quake-alert");
    }
    await idbSet("lastQuakeFingerprint", fingerprint);
  } catch (e) {
    console.error("バックグラウンド地震チェック失敗:", e);
  }

  // --- 氾濫(指定河川洪水予報) ---
  try {
    if (!offices) offices = await fetchOfficesMap();
    const affectedFloods = await checkFloodOnce(offices, settings);
    const fingerprint = affectedFloods.map((f) => `${f.prefCode}:${f.riverAreaName}:${f.level}`).sort().join(",");
    const last = await idbGet("lastFloodFingerprint");
    if (affectedFloods.length && fingerprint !== last) {
      const detail = affectedFloods.map((f) => `${f.prefName}(レベル${f.level})`).join("、");
      await notifyIfSupported("気象庁 氾濫情報", detail, "jma-flood-alert");
    }
    await idbSet("lastFloodFingerprint", fingerprint);
  } catch (e) {
    console.error("バックグラウンド氾濫チェック失敗:", e);
  }
}
