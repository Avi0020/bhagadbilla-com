/* Live prices. Reads /api/ticker (set <meta name="ticker-url"> to change). If the endpoint is missing the page keeps
   its static symbol strip and shows no prices: it never invents numbers. */
(function () {
  var meta = document.querySelector('meta[name="ticker-url"]');
  var URL_ = (meta && meta.content) || "/api/ticker";
  var panel = document.getElementById("mkt-panel"), track = document.querySelector(".ticker .track");
  var prev = {};
  var fmt = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function sign(n) { return n > 0 ? "+" : n < 0 ? "−" : ""; }
  function cls(n) { return n > 0 ? "up" : n < 0 ? "down" : ""; }

  function render(d) {
    if (!d || !d.items || !d.items.length) return;
    var idx = d.items.filter(function (i) { return i.group === "index"; });
    if (panel && idx.length) {
      var t = new Date(d.asOf);
      panel.hidden = false;
      panel.innerHTML =
        '<div class="mkt-head"><span class="pill ' + (d.marketOpen ? "live" : "closed") + '">' + (d.marketOpen ? "Market open" : "Market closed: last close") + "</span></div>" +
        idx.map(function (i) {
          var flash = prev[i.label] !== undefined && prev[i.label] !== i.price ? (i.price > prev[i.label] ? " flash-up" : " flash-down") : "";
          return '<div class="mkt-row' + flash + '"><span class="mkt-name">' + i.label + '</span><span class="mkt-px">' + fmt.format(i.price) +
            '</span><span class="mkt-chg ' + cls(i.change) + '">' + sign(i.change) + fmt.format(Math.abs(i.change)) + " (" + sign(i.changePercent) + Math.abs(i.changePercent).toFixed(2) + "%)</span></div>";
        }).join("") +
        '<p class="mkt-foot">Source: ' + d.source + ". Updated " + t.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + ". May be delayed. Not a trading quote.</p>";
    }
    if (track) {
      var one = d.items.map(function (i) {
        return '<span>' + i.label + ' <b class="' + cls(i.change) + '">' + fmt.format(i.price) + "</b> <em class=\"" + cls(i.change) + '">' + (i.change > 0 ? "▲" : i.change < 0 ? "▼" : "") + " " + Math.abs(i.changePercent).toFixed(2) + "%</em></span>";
      }).join("");
      track.innerHTML = one + one + one;
    }
    d.items.forEach(function (i) { prev[i.label] = i.price; });
  }

  function poll() {
    fetch(URL_, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(render).catch(function () {});
  }
  poll();
  setInterval(function () { if (!document.hidden) poll(); }, 5000);
})();
