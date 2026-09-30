// PostHog product analytics, loaded only when a project key is set.
// Cookieless: persistence is in memory, so nothing is stored in the browser and no
// consent banner is needed. No autocapture or session recording; only page views and
// the named events the site sends through vcfTrack().
(function () {
  const POSTHOG_KEY = "";
  const API_HOST = "https://eu.i.posthog.com";

  const queue = [];
  let ready = false;

  // Events sent before the library loads are queued and replayed.
  window.vcfTrack = function (event, properties) {
    if (!POSTHOG_KEY) return;
    if (ready) {
      try { window.posthog.capture(event, properties || {}); } catch (e) {}
    } else {
      queue.push(["capture", event, properties || {}]);
    }
  };

  // Ties the visitor to their account id, the same id the API uses for its events.
  window.vcfIdentify = function (userId) {
    if (!POSTHOG_KEY || !userId) return;
    if (ready) {
      try { window.posthog.identify(String(userId)); } catch (e) {}
    } else {
      queue.push(["identify", String(userId)]);
    }
  };

  window.vcfResetIdentity = function () {
    if (ready) { try { window.posthog.reset(); } catch (e) {} }
  };

  if (!POSTHOG_KEY) return;

  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = API_HOST.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js";
  script.onload = function () {
    if (!window.posthog || typeof window.posthog.init !== "function") return;
    window.posthog.init(POSTHOG_KEY, {
      api_host: API_HOST,
      persistence: "memory",
      person_profiles: "identified_only",
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,
      disable_session_recording: true,
      disable_surveys: true,
      loaded: function () {
        ready = true;
        queue.splice(0).forEach(function (item) {
          try {
            if (item[0] === "identify") window.posthog.identify(item[1]);
            else window.posthog.capture(item[1], item[2]);
          } catch (e) {}
        });
      }
    });
  };
  document.head.appendChild(script);
})();
