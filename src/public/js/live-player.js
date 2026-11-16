// Live player for funerals on the Orange live server.
// - Plays the kit's stream in 3 qualities (data-abr): it starts at 480p and
//   moves up to the YoloBox's full quality, or down to 360p, to suit each
//   viewer's connection. If the 3-quality version isn't there it plays the
//   single-quality stream (data-src) and switches over once it appears.
// - Sits about 12 seconds behind live, so a slow or patchy connection has
//   time to catch up without the picture freezing.
// - Its own controls: play/pause, back 10 seconds (up to 30 minutes), a LIVE
//   badge that turns into "Jump to live" when the viewer is behind, a quality
//   menu (Auto / 720p / 480p / 360p), sound and full screen. No moving
//   progress bar.
// - If the stream hasn't started, drops out or the YoloBox restarts, it keeps
//   retrying every few seconds, so viewers never have to refresh.
// - Every minute it asks the server whether this page is still live; once
//   staff press End Stream the page reloads to show the recording instead.
(function () {
  var video = document.getElementById("live-video");
  if (!video) return;
  var wrap = video.parentElement;
  var plainSrc = video.getAttribute("data-src");
  var abrSrc = video.getAttribute("data-abr") || "";
  var stateUrl = video.getAttribute("data-state-url");
  var overlay = document.getElementById("live-overlay");
  var soundBtn = document.getElementById("sound-btn");
  var hls = null;
  var retryTimer = null;
  var current = null; // the URL being played

  var LIVE_DELAY_S = 12;      // where the player sits behind the live edge
  var NATIVE_DELAY_S = 8;     // Safari/iPhone: its own player decides, roughly this
  var AT_LIVE_WITHIN_S = 8;   // closer than this to the normal position counts as "live"
  var BACK_S = 10;

  // ------------------------------------------------------------- playback

  function waiting(on) {
    if (overlay) overlay.hidden = !on;
    wrap.classList.toggle("lp-waiting", on);
    updateControls();
  }

  // Start again after ms, with a given URL or the preferred one.
  function retrySoon(ms, url) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      start(url);
    }, ms || 5000);
  }

  function tryPlay() {
    var p = video.play();
    if (p && p.catch) {
      p.catch(function () {
        // The browser won't autoplay with sound: start muted, offer sound.
        video.muted = true;
        video.play().catch(function () {});
        if (soundBtn) soundBtn.hidden = false;
      });
    }
  }

  function stopPlayer() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  // Couldn't load url: the 3-quality version falls back to the single one
  // straight away; otherwise wait a few seconds and start again.
  function failed(url) {
    waiting(true);
    if (url === abrSrc && plainSrc && abrSrc) retrySoon(300, plainSrc);
    else retrySoon(5000);
  }

  function play(url) {
    clearTimeout(retryTimer);
    stopPlayer();
    current = url;
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        liveSyncDuration: LIVE_DELAY_S,
        liveMaxLatencyDuration: 3600, // never pull a viewer who rewound back to live
        maxBufferLength: 30,
        backBufferLength: 60,
        capLevelToPlayerSize: true,
        manifestLoadingMaxRetry: 1,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6,
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        onLevels();
        tryPlay();
      });
      hls.on(window.Hls.Events.LEVEL_SWITCHED, updateQuality);
      hls.on(window.Hls.Events.ERROR, function (_e, data) {
        if (data && data.fatal) failed(url);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // iPhone / Safari: its own player picks the quality itself.
      video.src = url;
      video.load();
      tryPlay();
    } else {
      waiting(true);
    }
  }

  function start(url) {
    play(url || abrSrc || plainSrc);
  }

  // Seconds behind the normal live position (0 = live).
  function behindLive() {
    if (hls && typeof hls.latency === "number" && isFinite(hls.latency)) {
      var target = typeof hls.targetLatency === "number" && hls.targetLatency ? hls.targetLatency : LIVE_DELAY_S;
      return Math.max(0, hls.latency - target);
    }
    if (video.seekable && video.seekable.length) {
      var end = video.seekable.end(video.seekable.length - 1);
      return Math.max(0, end - video.currentTime - NATIVE_DELAY_S);
    }
    return 0;
  }

  function jumpToLive() {
    if (hls && hls.liveSyncPosition) {
      video.currentTime = hls.liveSyncPosition;
    } else if (video.seekable && video.seekable.length) {
      video.currentTime = Math.max(0, video.seekable.end(video.seekable.length - 1) - NATIVE_DELAY_S);
    }
    video.play().catch(function () {});
  }

  function goBack(seconds) {
    var earliest = video.seekable && video.seekable.length ? video.seekable.start(0) + 1 : 0;
    video.currentTime = Math.max(earliest, video.currentTime - seconds);
  }

  video.addEventListener("playing", function () {
    waiting(false);
  });
  video.addEventListener("error", function () {
    if (!hls) failed(current);
  });
  video.addEventListener("ended", function () {
    waiting(true);
    retrySoon(5000);
  });

  // Stalled for 20 s while it should be playing (e.g. the YoloBox dropped
  // and came back): start again.
  var lastTime = -1;
  var lastMove = Date.now();
  setInterval(function () {
    if (video.paused) {
      lastMove = Date.now();
      return;
    }
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      lastMove = Date.now();
    } else if (Date.now() - lastMove > 20000) {
      lastMove = Date.now();
      waiting(true);
      start();
    }
  }, 5000);

  // Playing the single quality at live: switch to the 3-quality version once it's there.
  if (abrSrc) {
    setInterval(function () {
      if (current !== plainSrc || video.paused || behindLive() > AT_LIVE_WITHIN_S) return;
      fetch(abrSrc, { cache: "no-store" })
        .then(function (r) {
          if (r.ok && current === plainSrc) start(abrSrc);
        })
        .catch(function () {});
    }, 30000);
  }

  if (soundBtn) {
    soundBtn.addEventListener("click", function () {
      video.muted = false;
      video.volume = 1;
      soundBtn.hidden = true;
      video.play().catch(function () {});
    });
  }

  // Still live? (Stops when End Stream is pressed.)
  if (stateUrl) {
    setInterval(function () {
      fetch(stateUrl, { cache: "no-store" })
        .then(function (r) {
          return r.json();
        })
        .then(function (s) {
          if (s && s.mode && s.mode !== "live") window.location.reload();
        })
        .catch(function () {});
    }, 60000);
  }

  // ------------------------------------------------------------- controls

  var ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    pause:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>',
    back:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 9.2A7.5 7.5 0 1 1 4.5 13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M4.6 4.8v4.7h4.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><text x="12.4" y="16" text-anchor="middle" font-size="7.2" font-weight="700" font-family="Inter, Arial, sans-serif" fill="currentColor">10</text></svg>',
    sound:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    muted:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    full:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    exitFull:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function el(tag, cls, html, label) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    if (label) {
      e.setAttribute("aria-label", label);
      e.title = label;
    }
    if (tag === "button") e.type = "button";
    return e;
  }

  video.controls = false;
  video.removeAttribute("controls");
  wrap.classList.add("lp");

  var big = el("button", "lp-big", ICONS.play, "Play");
  var bar = el("div", "lp-bar");
  var playBtn = el("button", "lp-btn", ICONS.pause, "Pause");
  var backBtn = el("button", "lp-btn", ICONS.back, "Back " + BACK_S + " seconds");
  var liveBtn = el("button", "lp-live", "Live", "You're watching live");
  var behindText = el("span", "lp-behind");
  var muteBtn = el("button", "lp-btn", ICONS.sound, "Mute");
  var vol = el("input", "lp-vol");
  vol.type = "range";
  vol.min = "0";
  vol.max = "1";
  vol.step = "0.05";
  vol.setAttribute("aria-label", "Volume");
  var fullBtn = el("button", "lp-btn", ICONS.full, "Full screen");
  var qWrap = el("div", "lp-q");
  var qBtn = el("button", "lp-qbtn", "Auto", "Quality");
  qBtn.setAttribute("aria-haspopup", "menu");
  var qMenu = el("div", "lp-qmenu");
  qMenu.setAttribute("role", "menu");
  qMenu.hidden = true;
  qWrap.hidden = true;
  qWrap.appendChild(qMenu);
  qWrap.appendChild(qBtn);
  [playBtn, backBtn, liveBtn, behindText, el("span", "lp-spacer"), qWrap, muteBtn, vol, fullBtn].forEach(function (c) {
    bar.appendChild(c);
  });
  wrap.appendChild(big);
  wrap.appendChild(bar);

  function fmtBehind(s) {
    s = Math.round(s);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m ? m + ":" + (r < 10 ? "0" : "") + r : r + " sec") + " behind";
  }

  function updateControls() {
    if (!playBtn) return; // controls not built yet
    var paused = video.paused;
    playBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
    playBtn.title = paused ? "Play" : "Pause";
    playBtn.setAttribute("aria-label", playBtn.title);
    big.hidden = !paused || (overlay && !overlay.hidden);
    var muted = video.muted || video.volume === 0;
    muteBtn.innerHTML = muted ? ICONS.muted : ICONS.sound;
    muteBtn.title = muted ? "Sound on" : "Mute";
    muteBtn.setAttribute("aria-label", muteBtn.title);
    vol.value = muted ? 0 : video.volume;
    var behind = behindLive();
    var atLive = behind <= AT_LIVE_WITHIN_S && !paused;
    liveBtn.classList.toggle("behind", !atLive);
    liveBtn.textContent = atLive ? "Live" : "Jump to live";
    liveBtn.title = atLive ? "You're watching live" : "Jump to live";
    liveBtn.setAttribute("aria-label", liveBtn.title);
    behindText.textContent = !atLive && behind > AT_LIVE_WITHIN_S ? fmtBehind(behind) : "";
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    fullBtn.innerHTML = fs ? ICONS.exitFull : ICONS.full;
    fullBtn.title = fs ? "Exit full screen" : "Full screen";
    fullBtn.setAttribute("aria-label", fullBtn.title);
  }

  // ---- quality menu (hls.js only; iPhones choose the quality themselves)
  var chosenHeight = null; // null = Auto; kept when the player reconnects

  function levelName(l) {
    return l.height ? l.height + "p" : Math.round(l.bitrate / 1000) + " kbit/s";
  }

  function onLevels() {
    if (!qWrap || !hls) return;
    var levels = hls.levels || [];
    if (chosenHeight !== null) {
      for (var i = 0; i < levels.length; i++) if (levels[i].height === chosenHeight) hls.nextLevel = i;
    }
    buildMenu();
    updateQuality();
  }

  function buildMenu() {
    qMenu.innerHTML = "";
    var levels = (hls && hls.levels) || [];
    var items = [{ label: "Auto", idx: -1, h: Infinity }];
    levels.forEach(function (l, i) {
      items.push({ label: levelName(l) + (l.height >= 720 ? " HD" : ""), idx: i, h: l.height || 0 });
    });
    items.sort(function (a, b) {
      return b.h - a.h;
    });
    items.forEach(function (it) {
      var b = el("button", "lp-qitem", it.label);
      b.setAttribute("role", "menuitemradio");
      var on = it.idx === -1 ? chosenHeight === null : levels[it.idx].height === chosenHeight;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.addEventListener("click", function () {
        pickLevel(it.idx);
        qMenu.hidden = true;
      });
      qMenu.appendChild(b);
    });
  }

  function pickLevel(idx) {
    if (!hls) return;
    chosenHeight = idx === -1 ? null : hls.levels[idx].height;
    hls.nextLevel = idx; // -1 = Auto; switches at the next piece without stopping
    buildMenu();
    updateQuality();
  }

  function updateQuality() {
    if (!qWrap) return;
    var levels = (hls && hls.levels) || [];
    qWrap.hidden = levels.length < 2;
    if (levels.length < 2) {
      qMenu.hidden = true;
      return;
    }
    var now = hls.currentLevel >= 0 && levels[hls.currentLevel] ? levelName(levels[hls.currentLevel]) : "";
    qBtn.innerHTML = chosenHeight === null ? 'Auto<span class="lp-qnow">' + (now ? " \u00b7 " + now : "") + "</span>" : now || chosenHeight + "p";
  }

  qBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (qMenu.hidden) buildMenu();
    qMenu.hidden = !qMenu.hidden;
  });
  document.addEventListener("click", function (e) {
    if (!qWrap.contains(e.target)) qMenu.hidden = true;
  });

  function togglePlay() {
    if (video.paused) video.play().catch(function () {});
    else video.pause();
  }

  function toggleFull() {
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (wrap.requestFullscreen) {
      wrap.requestFullscreen().catch(function () {});
    } else if (wrap.webkitRequestFullscreen) {
      wrap.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen(); // iPhone: its own full-screen player
    }
  }

  playBtn.addEventListener("click", togglePlay);
  big.addEventListener("click", togglePlay);
  backBtn.addEventListener("click", function () {
    goBack(BACK_S);
  });
  liveBtn.addEventListener("click", function () {
    if (liveBtn.classList.contains("behind")) jumpToLive();
  });
  muteBtn.addEventListener("click", function () {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 1;
      if (soundBtn) soundBtn.hidden = true;
    } else {
      video.muted = true;
    }
  });
  vol.addEventListener("input", function () {
    video.volume = Number(vol.value);
    video.muted = video.volume === 0;
    if (!video.muted && soundBtn) soundBtn.hidden = true;
  });
  fullBtn.addEventListener("click", toggleFull);
  document.addEventListener("fullscreenchange", updateControls);
  document.addEventListener("webkitfullscreenchange", updateControls);
  ["play", "pause", "playing", "volumechange", "seeked", "timeupdate"].forEach(function (ev) {
    video.addEventListener(ev, updateControls);
  });

  // Click the picture to pause/play (mouse); tap it to show the controls (touch).
  var lastPointer = "mouse";
  wrap.addEventListener("pointerdown", function (e) {
    lastPointer = e.pointerType || "mouse";
  });
  video.addEventListener("click", function () {
    if (lastPointer === "mouse") togglePlay();
  });

  // Hide the controls after 3 seconds without moving the mouse while playing
  // (not while someone is using them with the keyboard).
  function keyboardFocusInBar() {
    var a = document.activeElement;
    if (!a || !bar.contains(a)) return false;
    try {
      return a.matches(":focus-visible");
    } catch (e) {
      return false;
    }
  }
  var idleTimer = null;
  function wake() {
    wrap.classList.remove("lp-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!video.paused && !keyboardFocusInBar() && qMenu.hidden) wrap.classList.add("lp-idle");
    }, 3000);
  }
  ["pointermove", "pointerdown", "keydown", "focusin"].forEach(function (ev) {
    wrap.addEventListener(ev, wake);
  });
  video.addEventListener("pause", wake);
  wake();

  // Keyboard: space/k play-pause, left arrow back 10 s, f full screen, m mute
  // (not while typing in the chat).
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k === " " || k === "k") {
      e.preventDefault();
      togglePlay();
    } else if (k === "ArrowLeft") {
      goBack(BACK_S);
    } else if (k === "f") {
      toggleFull();
    } else if (k === "m") {
      muteBtn.click();
    } else {
      return;
    }
    wake();
  });

  setInterval(updateControls, 1000);

  // For checking in the browser console: orangeLivePlayer.hls.levels, .latency
  window.orangeLivePlayer = {
    get hls() { return hls; },
    get url() { return current; },
    pickLevel: pickLevel,
    behindLive: behindLive,
  };

  updateControls();
  start();
})();
