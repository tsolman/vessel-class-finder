// Free single-IMO lookup box on the SEO pages; same /demo endpoint as the homepage.
(function () {
  const API = "https://vessel-class-finder-production.up.railway.app";

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  document.querySelectorAll("form[data-demo]").forEach(function (form) {
    const input = form.querySelector("input");
    const button = form.querySelector("button");
    const out = form.querySelector(".demo-result");

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const imo = input.value.trim();
      out.hidden = false;
      if (!/^\d{7}$/.test(imo)) { out.innerHTML = '<p class="error">IMO numbers have 7 digits.</p>'; return; }

      button.disabled = true;
      button.textContent = "Looking up...";
      try {
        const res = await fetch(API + "/demo/" + imo);
        const data = await res.json();
        if (window.vcfTrack) {
          window.vcfTrack("demo_lookup", {
            result: res.ok ? "found" : res.status === 404 ? "not_found" : res.status === 429 ? "rate_limited" : "error",
            page: location.pathname
          });
        }
        if (!res.ok) {
          out.innerHTML = '<p class="error">' + escapeHtml(data.error || "Lookup failed.") + "</p>" +
            (res.status === 404 ? "<p>Not in the IACS dataset: the ship may be classed by a non-IACS society, unclassed, or the IMO number may be wrong.</p>" : "") +
            (res.status === 429 ? '<p><a href="/#signup">Get a free API key</a> for 100 lookups a month.</p>' : "");
          return;
        }
        const rows = [
          ["Class society", data.class],
          ["Status", data.status],
          ["Last survey", data.date_of_survey],
          ["Next survey", data.date_of_next_survey],
          ["Status changed", data.date_of_latest_status],
          ["Reason", data.reason_for_status]
        ].filter(function (r) { return r[1]; });
        out.innerHTML = "<h3>" + escapeHtml(data.vessel_name) + " &middot; IMO " + escapeHtml(data.imo) + "</h3><dl>" +
          rows.map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + escapeHtml(r[1]) + "</dd>"; }).join("") + "</dl>" +
          '<p>Checking a whole fleet? <a href="/#signup">Get a free API key</a> and look up 100 ships per request.</p>';
      } catch (err) {
        out.innerHTML = '<p class="error">Network error. Please try again.</p>';
      } finally {
        button.disabled = false;
        button.textContent = "Look up";
      }
    });
  });
})();
