(function () {
  var y = document.getElementById("yr"); if (y) y.textContent = new Date().getFullYear();
  var top = document.querySelector(".top");
  function onScroll() { if (top) top.classList.toggle("solid", window.scrollY > 40); }
  onScroll(); window.addEventListener("scroll", onScroll, { passive: true });

  // 3D tilt on the example call card (pointer only, skipped for reduced motion)
  var card = document.querySelector(".callcard");
  if (card && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var wrap = card.parentElement;
    wrap.addEventListener("pointermove", function (e) {
      var r = wrap.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = "rotateY(" + (px * 14) + "deg) rotateX(" + (-py * 12) + "deg)";
    });
    wrap.addEventListener("pointerleave", function () { card.style.transform = "rotateY(-8deg) rotateX(4deg)"; });
    card.style.transform = "rotateY(-8deg) rotateX(4deg)";
  }
})();
