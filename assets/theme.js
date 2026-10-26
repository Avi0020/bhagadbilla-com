(function () {
  var root = document.documentElement, KEY = "bb-theme";
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function apply(t) {
    root.setAttribute("data-theme", t);
    var b = document.querySelector(".theme-toggle");
    if (b) { b.setAttribute("aria-pressed", t === "dark" ? "true" : "false"); b.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode"); }
    window.dispatchEvent(new Event("themechange"));
  }
  var b = document.querySelector(".theme-toggle");
  apply(root.getAttribute("data-theme") || "light");
  if (b) b.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    set(next); apply(next);
  });
})();
