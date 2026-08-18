/* Texas Water Watchers — shared include, injected into every HTML page by the
   Worker (see src/index.js injectCommon). One place to maintain site-wide chrome:
   the safety-disclaimer banner and the mid-page AdSense unit. Everything here is
   idempotent, so pages that already ship a static banner/loader are never doubled. */
(function () {
  var CLIENT = "ca-pub-6372653365779768";
  var AD_SLOT = "3180620071"; // "TWW mid-page" display unit

  // 1. Safety disclaimer banner (only if the page doesn't already have one).
  function banner() {
    if (document.getElementById("tww-alertbar") || !document.body) return;
    var b = document.createElement("div");
    b.id = "tww-alertbar";
    b.setAttribute("role", "note");
    b.style.cssText =
      "background:rgba(220,38,38,.16);border-bottom:1px solid rgba(220,38,38,.55);" +
      "color:#ff6b6b;font-weight:700;text-align:center;padding:9px 16px;font-size:.8rem;" +
      "line-height:1.45;font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.02em";
    b.textContent =
      "Not for emergency, flood-warning, navigational, safety, or regulatory decisions";
    document.body.insertBefore(b, document.body.firstChild);
  }

  // 2. AdSense loader (only once).
  function loader() {
    if (document.getElementById("adsbygoogle-js")) return;
    var s = document.createElement("script");
    s.async = true;
    s.id = "adsbygoogle-js";
    s.crossOrigin = "anonymous";
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + CLIENT;
    (document.head || document.documentElement).appendChild(s);
  }

  // 3. One responsive ad unit, placed at the page's vertical mid-point.
  function ad() {
    if (document.getElementById("tww-admid")) return;
    var host = document.querySelector(".wrap") || document.body;
    if (!host) return;
    var kids = [].slice.call(host.children).filter(function (el) {
      return (
        el.id !== "tww-alertbar" &&
        el.id !== "tww-admid" &&
        el.tagName !== "SCRIPT" &&
        el.tagName !== "STYLE" &&
        el.tagName !== "LINK" &&
        el.offsetParent !== null
      );
    });
    if (!kids.length) return;
    var midY = host.scrollHeight / 2;
    var target = null;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop >= midY) { target = kids[i]; break; }
    }
    if (!target) target = kids[kids.length - 1];
    if (!target || !target.parentNode) return;
    var box = document.createElement("div");
    box.id = "tww-admid";
    box.setAttribute("aria-label", "Advertisement");
    box.style.cssText = "max-width:1080px;margin:26px auto;padding:0 16px;clear:both";
    box.innerHTML =
      '<ins class="adsbygoogle" style="display:block" data-ad-client="' + CLIENT +
      '" data-ad-slot="' + AD_SLOT +
      '" data-ad-format="auto" data-full-width-responsive="true"></ins>';
    target.parentNode.insertBefore(box, target);
    // Push only once the unit has a real width, or AdSense throws
    // "No slot size for availableWidth=0" (responsive ads need a laid-out box).
    pushAd(box, 0);
  }

  function pushAd(box, tries) {
    if (box.offsetWidth > 10) {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
      return;
    }
    if (tries > 20) return;
    requestAnimationFrame(function () { pushAd(box, tries + 1); });
  }

  function init() { banner(); loader(); ad(); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
