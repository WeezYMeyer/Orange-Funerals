// Live player for funerals on the Orange live server.
// - Plays the kit's HLS stream (hls.js, or the iPhone's own player).
// - If the stream hasn't started, drops out or the YoloBox restarts, it keeps
//   retrying every few seconds, so viewers never have to refresh.
// - Every minute it asks the server whether this page is still live; once
//   staff press End Stream the page reloads to show the recording instead.
(function () {
  var video = document.getElementById("live-video");
  if (!video) return;
  var src = video.getAttribute("data-src");
  var stateUrl = video.getAttribute("data-state-url");
  var overlay = document.getElementById("live-overlay");
  var soundBtn = document.getElementById("sound-btn");
  var hls = null;
  var retryTimer = null;

  function waiting(on) {
    if (overlay) overlay.hidden = !on;
  }

  function retrySoon(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(start, ms || 5000);
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

  function start() {
    clearTimeout(retryTimer);
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 1,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6,
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, tryPlay);
      hls.on(window.Hls.Events.ERROR, function (_e, data) {
        if (data && data.fatal) {
          waiting(true);
          retrySoon(5000);
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.load();
      tryPlay();
    } else {
      waiting(true);
    }
  }

  video.addEventListener("playing", function () {
    waiting(false);
  });
  video.addEventListener("error", function () {
    if (!hls) {
      waiting(true);
      retrySoon(5000);
    }
  });
  video.addEventListener("ended", function () {
    waiting(true);
    retrySoon(5000);
  });

  // Stalled for 20 s while it should be playing (e.g. the YoloBox dropped
  // and came back): start again from the live edge.
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

  start();
})();
