/* 灯台 — フロントエンド（Vanilla JS・ビルド不要）
 *
 * data/index.json で最新日と日付一覧を取得し、data/YYYY-MM-DD.json を読んで1画面に描画。
 * 音声は mp3 があれば <audio>、無ければ audioScript を Web Speech API で読み上げる。
 */
(function () {
  "use strict";

  var DATA_DIR = "data/";
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  // GitHub Contents/Actions API 経由でのキーワード編集先リポジトリ
  var GH_OWNER = "sato-sansan";
  var GH_REPO = "toudai";
  var GH_BRANCH = "main";
  var LS_KW_PREFS = "toudai.kwPrefs";   // { order: [label...], hidden: [label...] }
  var LS_GH_TOKEN = "toudai.ghToken";

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
    settingsBtn: byId("settingsBtn"),
    settingsOverlay: byId("settingsOverlay"),
    settingsClose: byId("settingsClose"),
    kwPrefsList: byId("kwPrefsList"),
    ghTokenBox: byId("ghTokenBox"),
    ghTokenInput: byId("ghTokenInput"),
    ghTokenSave: byId("ghTokenSave"),
    ghTokenClear: byId("ghTokenClear"),
    ghEditArea: byId("ghEditArea"),
    kwEditList: byId("kwEditList"),
    kwAddBtn: byId("kwAddBtn"),
    kwSaveBtn: byId("kwSaveBtn"),
    ghStatus: byId("ghStatus"),
    ghDeployBtn: byId("ghDeployBtn"),
  };

  function byId(id) { return document.getElementById(id); }

  // ---------- 初期化 ----------
  function init() {
    bindPlayer();
    bindNav();
    bindSettings();
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

  // 表示対象のキーワードを、端末内設定（並び順・表示/非表示）を反映した順で返す。
  // データ側に新しいキーワードがあり設定に無い場合は末尾に追加して表示する（壊れない）。
  function visibleKeywords() {
    var all = (state.current && state.current.keywords) || [];
    var prefs = loadKwPrefs();
    var byLabel = {};
    all.forEach(function (kw) { byLabel[kw.keyword] = kw; });

    var ordered = [];
    prefs.order.forEach(function (label) {
      if (byLabel[label] && prefs.hidden.indexOf(label) === -1) {
        ordered.push(byLabel[label]);
      }
    });
    // 設定に無い（＝新規追加された）キーワードは末尾に追加
    all.forEach(function (kw) {
      if (prefs.order.indexOf(kw.keyword) === -1 && prefs.hidden.indexOf(kw.keyword) === -1) {
        ordered.push(kw);
      }
    });
    return ordered;
  }

  function renderTabs() {
    el.tabs.innerHTML = "";
    var list = visibleKeywords();
    if (state.activeTab >= list.length) state.activeTab = 0;
    list.forEach(function (kw, i) {
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
    var list = visibleKeywords();
    var kw = list[state.activeTab];
    el.feed.innerHTML = "";
    if (!kw) {
      var noneVisible = document.createElement("div");
      noneVisible.className = "empty";
      noneVisible.innerHTML = '<span class="big">🕯️</span>表示中のタブがありません。<br>設定からタブを表示してください。';
      el.feed.appendChild(noneVisible);
      return;
    }

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
        primaryChipHtml(a.primary) +
        badgeHtml(a.badge, a.primary) +
        "<span>" + escapeHtml(a.source) + "</span>" +
        (time ? "<span>· " + time + "</span>" : "") +
      "</div>";
    return card;
  }

  function primaryChipHtml(primary) {
    // 一次情報（公式・政府・査読誌・ベンダー直）であることを示す小さな印。
    // Google News 等の二次情報（アグリゲーション）と見分けやすくする。
    return primary ? '<span class="chip-primary" title="一次情報（公式・政府・査読誌・ベンダー直）">一次</span>' : "";
  }

  function badgeHtml(badge, primary) {
    if (!badge) return "";
    var cls = "badge";
    var label = badge;
    if (badge === "PubMed") { cls += " badge-pubmed"; label = "📘 PubMed"; }
    else if (badge === "The Lancet") { cls += " badge-lancet"; label = "🩺 The Lancet"; }
    else if (badge === "PR TIMES") { cls += " badge-prtimes"; label = "PR TIMES"; }
    else if (primary) { cls += " badge-primary"; label = escapeHtml(badge); }
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

  // ---------- 設定パネル ----------
  // A. 並び替え・表示/非表示（端末内・localStorage・即時反映）
  function loadKwPrefs() {
    try {
      var raw = window.localStorage.getItem(LS_KW_PREFS);
      if (!raw) return { order: [], hidden: [] };
      var parsed = JSON.parse(raw);
      return {
        order: Array.isArray(parsed.order) ? parsed.order : [],
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      };
    } catch (e) {
      return { order: [], hidden: [] };
    }
  }

  function saveKwPrefs(prefs) {
    try {
      window.localStorage.setItem(LS_KW_PREFS, JSON.stringify(prefs));
    } catch (e) {
      // localStorage不可（プライベートモード等）でも致命的にはしない
    }
  }

  // 現在のデータに存在する全キーワードを、保存済み順序＋新規は末尾、で正規化して返す
  function normalizedKwOrder() {
    var all = (state.current && state.current.keywords || []).map(function (kw) { return kw.keyword; });
    var prefs = loadKwPrefs();
    var order = prefs.order.filter(function (label) { return all.indexOf(label) !== -1; });
    all.forEach(function (label) {
      if (order.indexOf(label) === -1) order.push(label);
    });
    return order;
  }

  function bindSettings() {
    el.settingsBtn.addEventListener("click", openSettings);
    el.settingsClose.addEventListener("click", closeSettings);
    el.settingsOverlay.addEventListener("click", function (e) {
      if (e.target === el.settingsOverlay) closeSettings();
    });
    el.ghTokenSave.addEventListener("click", function () {
      var v = (el.ghTokenInput.value || "").trim();
      if (!v) return;
      try { window.localStorage.setItem(LS_GH_TOKEN, v); } catch (e) {}
      el.ghTokenInput.value = "";
      renderGhEditArea();
    });
    el.ghTokenClear.addEventListener("click", function () {
      if (!window.confirm("保存したGitHubトークンを削除しますか？")) return;
      try { window.localStorage.removeItem(LS_GH_TOKEN); } catch (e) {}
      renderGhEditArea();
    });
    el.kwAddBtn.addEventListener("click", function () {
      openKwEditForm(null);
    });
    el.kwSaveBtn.addEventListener("click", saveConfigToGithub);
    el.ghDeployBtn.addEventListener("click", triggerWorkflowDispatch);
  }

  function openSettings() {
    renderKwPrefsList();
    renderGhEditArea();
    el.settingsOverlay.hidden = false;
  }
  function closeSettings() {
    el.settingsOverlay.hidden = true;
  }

  function renderKwPrefsList() {
    var order = normalizedKwOrder();
    var prefs = loadKwPrefs();
    el.kwPrefsList.innerHTML = "";
    order.forEach(function (label, i) {
      var hidden = prefs.hidden.indexOf(label) !== -1;
      var li = document.createElement("li");
      li.className = "kw-pref-row";

      var up = document.createElement("button");
      up.className = "kw-order-btn";
      up.textContent = "↑";
      up.disabled = i === 0;
      up.addEventListener("click", function () { moveKwOrder(label, -1); });

      var down = document.createElement("button");
      down.className = "kw-order-btn";
      down.textContent = "↓";
      down.disabled = i === order.length - 1;
      down.addEventListener("click", function () { moveKwOrder(label, 1); });

      var name = document.createElement("span");
      name.className = "kw-label" + (hidden ? " kw-hidden-label" : "");
      name.textContent = label;

      var toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "kw-toggle";
      toggle.checked = !hidden;
      toggle.setAttribute("aria-label", label + " を表示");
      toggle.addEventListener("change", function () { toggleKwHidden(label, !toggle.checked); });

      li.appendChild(up);
      li.appendChild(down);
      li.appendChild(name);
      li.appendChild(toggle);
      el.kwPrefsList.appendChild(li);
    });
  }

  function moveKwOrder(label, delta) {
    var order = normalizedKwOrder();
    var i = order.indexOf(label);
    var j = i + delta;
    if (i === -1 || j < 0 || j >= order.length) return;
    var tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
    var prefs = loadKwPrefs();
    prefs.order = order;
    saveKwPrefs(prefs);
    renderKwPrefsList();
    renderTabs();
    renderFeed();
  }

  function toggleKwHidden(label, hidden) {
    var prefs = loadKwPrefs();
    prefs.order = normalizedKwOrder();
    var idx = prefs.hidden.indexOf(label);
    if (hidden && idx === -1) prefs.hidden.push(label);
    if (!hidden && idx !== -1) prefs.hidden.splice(idx, 1);
    saveKwPrefs(prefs);
    renderKwPrefsList();
    renderTabs();
    renderFeed();
  }

  // ---------- B. キーワードの追加・編集・削除（GitHub API 経由で config.json を書き換え） ----------
  function getGhToken() {
    try { return (window.localStorage.getItem(LS_GH_TOKEN) || "").trim(); } catch (e) { return ""; }
  }

  function renderGhEditArea() {
    var token = getGhToken();
    if (token) {
      el.ghTokenBox.hidden = true;
      el.ghEditArea.hidden = false;
      loadConfigForEdit();
    } else {
      el.ghTokenBox.hidden = false;
      el.ghEditArea.hidden = true;
      el.ghStatus.textContent = "";
      el.ghStatus.className = "gh-status";
      el.ghDeployBtn.hidden = true;
    }
  }

  var ghConfigCache = null; // { json, sha }

  function loadConfigForEdit() {
    el.kwEditList.innerHTML = "";
    setGhStatus("config.json を読み込み中…", "busy");
    ghGetConfig().then(function (result) {
      ghConfigCache = result;
      setGhStatus("", "");
      renderKwEditList();
    }).catch(function (err) {
      setGhStatus(ghErrorMessage(err), "error");
    });
  }

  function renderKwEditList() {
    el.kwEditList.innerHTML = "";
    if (!ghConfigCache) return;
    var keywords = ghConfigCache.json.keywords || [];
    keywords.forEach(function (kw, i) {
      el.kwEditList.appendChild(kwEditRow(kw, i));
    });
  }

  function kwEditRow(kw, index) {
    var li = document.createElement("li");
    li.className = "kw-edit-row";

    var fields = document.createElement("div");
    fields.className = "kw-edit-fields";

    var labelField = kwEditField("タブ名", kw.label, function (v) { kw.label = v; });
    var queriesField = kwEditField(
      "検索語（カンマ区切り）",
      (kw.queries || []).join(", "),
      function (v) { kw.queries = splitCsv(v); }
    );
    var excludeField = kwEditField(
      "除外語（カンマ区切り）",
      (kw.exclude || []).join(", "),
      function (v) { kw.exclude = splitCsv(v); }
    );
    fields.appendChild(labelField);
    fields.appendChild(queriesField);
    fields.appendChild(excludeField);

    var delBtn = document.createElement("button");
    delBtn.className = "kw-icon-btn";
    delBtn.textContent = "🗑";
    delBtn.setAttribute("aria-label", "「" + kw.label + "」を削除");
    delBtn.addEventListener("click", function () {
      if (!window.confirm("「" + kw.label + "」を削除します。よろしいですか？")) return;
      ghConfigCache.json.keywords.splice(index, 1);
      renderKwEditList();
    });

    li.appendChild(fields);
    li.appendChild(delBtn);
    return li;
  }

  function kwEditField(labelText, value, onInput) {
    var wrap = document.createElement("div");
    var lab = document.createElement("div");
    lab.className = "kw-edit-field-label";
    lab.textContent = labelText;
    var input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.addEventListener("input", function () { onInput(input.value); });
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return wrap;
  }

  function splitCsv(v) {
    return (v || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function openKwEditForm(existing) {
    if (!ghConfigCache) return;
    var kw = existing || { label: "新しいキーワード", queries: [], exclude: [] };
    if (!existing) ghConfigCache.json.keywords.push(kw);
    renderKwEditList();
  }

  // 保存前の入力チェック。問題があればエラーメッセージを、なければ null を返す。
  function validateKeywords(keywords) {
    if (!keywords.length) return "キーワードが0件です。最低1つ残してください。";
    var seen = {};
    for (var i = 0; i < keywords.length; i++) {
      var label = (keywords[i].label || "").trim();
      if (!label) return "タブ名が空の行があります。";
      if (seen[label]) return "タブ名「" + label + "」が重複しています。";
      seen[label] = true;
      if (!(keywords[i].queries || []).length) return "「" + label + "」の検索語が空です。";
    }
    return null;
  }

  function saveConfigToGithub() {
    if (!ghConfigCache) return;
    var invalid = validateKeywords(ghConfigCache.json.keywords || []);
    if (invalid) {
      setGhStatus(invalid, "error");
      return;
    }
    setGhStatus("config.json を保存中…", "busy");
    el.ghDeployBtn.hidden = true;
    ghPutConfig(ghConfigCache.json, ghConfigCache.sha, 0)
      .then(function (newSha) {
        ghConfigCache.sha = newSha;
        setGhStatus("保存しました。反映は明朝6時の自動更新です。", "ok");
        el.ghDeployBtn.hidden = false;
      })
      .catch(function (err) {
        setGhStatus(ghErrorMessage(err), "error");
      });
  }

  function triggerWorkflowDispatch() {
    var token = getGhToken();
    if (!token) return;
    setGhStatus("更新を起動中…", "busy");
    fetch(
      "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/actions/workflows/daily.yml/dispatches",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: GH_BRANCH }),
      }
    ).then(function (r) {
      if (!r.ok) throw { status: r.status };
      setGhStatus("更新を起動しました。数分後に記事が更新されます。", "ok");
    }).catch(function (err) {
      setGhStatus(ghErrorMessage(err), "error");
    });
  }

  // ---- GitHub Contents API ----
  function ghConfigUrl() {
    return "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/config.json";
  }

  function ghGetConfig() {
    var token = getGhToken();
    return fetch(ghConfigUrl() + "?ref=" + GH_BRANCH, {
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
      },
    }).then(function (r) {
      if (!r.ok) return Promise.reject({ status: r.status });
      return r.json();
    }).then(function (data) {
      var text = base64ToUtf8(data.content || "");
      return { json: JSON.parse(text), sha: data.sha };
    });
  }

  // sha競合（409）は1回だけ再GETして自動リトライする
  function ghPutConfig(json, sha, retryCount) {
    var token = getGhToken();
    var body = JSON.stringify({
      message: "config: キーワード変更（アプリから）",
      content: utf8ToBase64(JSON.stringify(json, null, 2)),
      sha: sha,
      branch: GH_BRANCH,
    });
    return fetch(ghConfigUrl(), {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body,
    }).then(function (r) {
      if (r.status === 409 && retryCount < 1) {
        return ghGetConfig().then(function (fresh) {
          ghConfigCache.sha = fresh.sha;
          // ローカルの編集内容（json）はそのまま維持し、shaだけ最新化して再送
          return ghPutConfig(json, fresh.sha, retryCount + 1);
        });
      }
      if (!r.ok) return Promise.reject({ status: r.status });
      return r.json();
    }).then(function (data) {
      return data.content.sha;
    });
  }

  function ghErrorMessage(err) {
    var status = err && err.status;
    if (status === 401) return "認証に失敗しました。トークンが正しいか確認してください。";
    if (status === 403) return "権限がありません。トークンに Contents / Actions の write 権限があるか確認してください。";
    if (status === 404) return "リポジトリまたはファイルが見つかりません。設定を確認してください。";
    if (status === 409) return "他の変更と競合しました。もう一度お試しください。";
    return "通信に失敗しました" + (status ? "（HTTP " + status + "）" : "") + "。しばらくしてから再試行してください。";
  }

  function setGhStatus(text, kind) {
    el.ghStatus.textContent = text;
    el.ghStatus.className = "gh-status" + (kind ? " " + kind : "");
  }

  // UTF-8 文字列 <-> base64（btoa/atob単体は日本語で壊れるため TextEncoder/Decoder を使う）
  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return window.btoa(bin);
  }
  function base64ToUtf8(b64) {
    var bin = window.atob(b64.replace(/\n/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
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
