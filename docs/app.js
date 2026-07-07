/* 灯台 — フロントエンド（Vanilla JS・ビルド不要）
 *
 * data/index.json で最新日と日付一覧を取得し、data/YYYY-MM-DD.json を読んで1画面に描画。
 * 音声は mp3 があれば <audio>、無ければ audioScript を Web Speech API で読み上げる。
 */
(function () {
  "use strict";

  var DATA_DIR = "data/";
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  var state = {
    index: null,      // { latest, dates: [...] }
    current: null,    // 表示中の日次データ
    date: null,       // 表示中の日付文字列
    activeTab: 0,
    rate: 1.0,
    playing: false,
    mode: "mp3",      // "mp3" | "speech"
  };

  var el = {
    dateLabel: byId("dateLabel"),
    prevDay: byId("prevDay"),
    nextDay: byId("nextDay"),
    tabs: byId("tabs"),
    feed: byId("feed"),
    playBtn: byId("playBtn"),
    playTime: byId("playTime"),
    playMode: byId("playMode"),
    lastUpdated: byId("lastUpdated"),
    archive: byId("archive"),
    audio: byId("audioEl"),
  };

  function byId(id) { return document.getElementById(id); }

  // ---------- 初期化 ----------
  function init() {
    bindPlayer();
    bindNav();
    registerSW();
    loadIndex();
  }

  function loadIndex() {
    showLoading();
    fetchJSON(DATA_DIR + "index.json")
      .then(function (idx) {
        state.index = idx;
        return loadDate(idx.latest);
      })
      .catch(function () {
        // index.json が無い/壊れている場合は今日の日付で直接トライ
        var today = todayStr();
        state.index = { latest: today, dates: [today] };
        return loadDate(today).catch(showFatal);
      });
  }

  function loadDate(dateStr) {
    showLoading();
    return fetchJSON(DATA_DIR + dateStr + ".json").then(function (data) {
      state.current = data;
      state.date = dateStr;
      state.activeTab = 0;
      stopAudio();
      render();
    });
  }

  // ---------- 描画 ----------
  function render() {
    var d = parseDate(state.date);
    el.dateLabel.textContent =
      d.getMonth() + 1 + "月" + d.getDate() + "日（" + WEEKDAYS[d.getDay()] + "）の灯台";

    updateNavButtons();
    renderTabs();
    renderFeed();
    renderFooter();
    setupAudioSource();
  }

  function renderTabs() {
    el.tabs.innerHTML = "";
    state.current.keywords.forEach(function (kw, i) {
      var b = document.createElement("button");
      b.className = "tab" + (i === state.activeTab ? " active" : "");
      b.setAttribute("role", "tab");
      b.innerHTML = escapeHtml(kw.keyword) +
        '<span class="count">' + kw.articles.length + "</span>";
      b.addEventListener("click", function () {
        state.activeTab = i;
        renderTabs();
        renderFeed();
      });
      el.tabs.appendChild(b);
    });
  }

  function renderFeed() {
    var kw = state.current.keywords[state.activeTab];
    el.feed.innerHTML = "";

    // 「Xで最新を見る」ボタン
    var x = document.createElement("a");
    x.className = "x-search";
    x.href = "https://x.com/search?q=" + encodeURIComponent(kw.keyword) + "&f=live";
    x.target = "_blank";
    x.rel = "noopener";
    x.innerHTML = "𝕏 で最新を見る";
    el.feed.appendChild(x);

    if (!kw.articles.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = '<span class="big">🕯️</span>本日、該当なし';
      el.feed.appendChild(empty);
      return;
    }

    kw.articles.forEach(function (a) {
      el.feed.appendChild(articleCard(a));
    });
  }

  function articleCard(a) {
    var card = document.createElement("a");
    card.className = "card";
    // カードのタップで jumpUrl（Text Fragment付き）を新規タブで開く。
    // 非対応環境ではブラウザが #:~:text= を無視して記事冒頭を開く（自動フォールバック）。
    card.href = a.jumpUrl || a.url;
    card.target = "_blank";
    card.rel = "noopener";

    var time = formatTime(a.publishedAt);
    var summaryHtml = a.summary
      ? '<div class="card-summary">' + escapeHtml(a.summary) + "</div>"
      : "";
    card.innerHTML =
      '<div class="card-title">' + escapeHtml(a.title) + "</div>" +
      summaryHtml +
      '<div class="card-meta">' +
        badgeHtml(a.badge) +
        "<span>" + escapeHtml(a.source) + "</span>" +
        (time ? "<span>· " + time + "</span>" : "") +
      "</div>";
    return card;
  }

  function badgeHtml(badge) {
    if (!badge) return "";
    var cls = "badge";
    var label = badge;
    if (badge === "PubMed") { cls += " badge-pubmed"; label = "📘 PubMed"; }
    else if (badge === "The Lancet") { cls += " badge-lancet"; label = "🩺 The Lancet"; }
    else if (badge === "PR TIMES") { cls += " badge-prtimes"; label = "PR TIMES"; }
    else return "";
    return '<span class="' + cls + '">' + label + "</span>";
  }

  function renderFooter() {
    var t = state.current.generatedAt ? new Date(state.current.generatedAt) : null;
    el.lastUpdated.textContent = t
      ? "最終更新 " + t.getFullYear() + "/" + pad(t.getMonth() + 1) + "/" + pad(t.getDate()) +
        " " + pad(t.getHours()) + ":" + pad(t.getMinutes())
      : "";

    el.archive.innerHTML = "過去の灯台：";
    (state.index.dates || []).slice(0, 7).forEach(function (ds) {
      var a = document.createElement("a");
      a.textContent = ds.slice(5);
      a.href = "#";
      if (ds === state.date) a.className = "today";
      a.addEventListener("click", function (e) {
        e.preventDefault();
        loadDate(ds).catch(showFatal);
      });
      el.archive.appendChild(a);
    });
  }

  // ---------- 日付ナビ ----------
  function bindNav() {
    el.prevDay.addEventListener("click", function () { stepDay(1); });
    el.nextDay.addEventListener("click", function () { stepDay(-1); });
  }

  function stepDay(delta) {
    var dates = state.index.dates || [];
    var i = dates.indexOf(state.date);
    if (i === -1) return;
    var target = dates[i + delta];
    if (target) loadDate(target).catch(showFatal);
  }

  function updateNavButtons() {
    var dates = state.index.dates || [];
    var i = dates.indexOf(state.date);
    el.prevDay.disabled = i === -1 || i >= dates.length - 1; // より古い日が無い
    el.nextDay.disabled = i <= 0;                            // より新しい日が無い
  }

  // ---------- 音声 ----------
  function bindPlayer() {
    el.playBtn.addEventListener("click", togglePlay);

    Array.prototype.forEach.call(document.querySelectorAll(".rate-btn"), function (btn) {
      btn.addEventListener("click", function () {
        state.rate = parseFloat(btn.dataset.rate);
        document.querySelectorAll(".rate-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        el.audio.playbackRate = state.rate;
        if (state.mode === "speech" && state.playing) {
          // Web Speech は再生中のrate変更が効かないため、再生成
          restartSpeech();
        }
      });
    });

    el.audio.addEventListener("timeupdate", function () {
      el.playTime.textContent = fmtDuration(el.audio.currentTime) +
        (isFinite(el.audio.duration) ? " / " + fmtDuration(el.audio.duration) : "");
    });
    el.audio.addEventListener("ended", onAudioEnd);
    el.audio.addEventListener("error", function () {
      // mp3再生に失敗したらブラウザ読み上げへ自動フォールバック
      if (state.mode === "mp3") {
        state.mode = "speech";
        setPlayMode();
        if (state.playing) startSpeech();
      }
    });
  }

  function setupAudioSource() {
    stopAudio();
    if (state.current.audioUrl) {
      state.mode = "mp3";
      el.audio.src = state.current.audioUrl;
      el.audio.playbackRate = state.rate;
    } else {
      state.mode = "speech";
      el.audio.removeAttribute("src");
    }
    setPlayMode();
    el.playTime.textContent = "0:00";
  }

  function setPlayMode() {
    el.playMode.textContent = state.mode === "speech" ? "読み上げ" : "";
  }

  function togglePlay() {
    if (state.playing) { stopAudio(); return; }
    if (state.mode === "mp3" && state.current.audioUrl) {
      el.audio.play().then(function () {
        setPlaying(true);
      }).catch(function () {
        state.mode = "speech";
        setPlayMode();
        startSpeech();
      });
    } else {
      startSpeech();
    }
  }

  function startSpeech() {
    var text = state.current.audioScript || "";
    if (!text || !("speechSynthesis" in window)) {
      el.playMode.textContent = "音声なし";
      return;
    }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = state.rate;
    u.onend = onAudioEnd;
    state._utter = u;
    window.speechSynthesis.speak(u);
    setPlaying(true);
    setPlayMode();
  }

  function restartSpeech() {
    window.speechSynthesis.cancel();
    startSpeech();
  }

  function onAudioEnd() {
    setPlaying(false);
    el.playTime.textContent = state.mode === "mp3"
      ? fmtDuration(el.audio.duration || 0)
      : "0:00";
  }

  function stopAudio() {
    try { el.audio.pause(); } catch (e) {}
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setPlaying(false);
  }

  function setPlaying(v) {
    state.playing = v;
    el.playBtn.classList.toggle("playing", v);
    el.playBtn.querySelector(".play-icon").textContent = v ? "❚❚" : "▶";
  }

  // ---------- ユーティリティ ----------
  function showLoading() {
    el.feed.innerHTML = '<div class="loading"><div class="spinner"></div>今日の光を灯しています…</div>';
  }
  function showFatal() {
    el.feed.innerHTML = '<div class="empty"><span class="big">🌫️</span>データを読み込めませんでした。<br>朝6時の自動更新をお待ちください。</div>';
  }

  function fetchJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function parseDate(s) {
    var p = (s || "").split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDuration(sec) {
    sec = Math.floor(sec || 0);
    return Math.floor(sec / 60) + ":" + pad(sec % 60);
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function registerSW() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
    }
  }

  // iOS Safari で speechSynthesis の音声リストを事前ロード
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = function () {};
    window.speechSynthesis.getVoices();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
