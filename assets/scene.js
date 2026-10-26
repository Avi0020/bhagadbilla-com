/* Paper-craft option chain: a 3D illustration of how an option chain looks.
   Towers = open interest at each strike (red = calls, green = puts); the ink beam = the live price moving through the
   strikes; the ribbon above = a price path. Everything is generated; no real market data is shown. */
(function () {
  var canvas = document.getElementById("scene");
  if (!window.THREE || !canvas) return;
  var renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); } catch (e) { return; }
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  var INK = 0x0e2f26, RED = 0xb5242a, GREEN = 0x17724f, OCHRE = 0xd9951b;
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(36, 1, 0.1, 220);

  var hemi = new THREE.HemisphereLight(0xfff3ea, 0xcf9f88, 0.95); scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(-18, 30, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  var sc = sun.shadow.camera; sc.left = -34; sc.right = 34; sc.top = 24; sc.bottom = -24; sc.near = 1; sc.far = 90;
  sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
  scene.add(sun);

  var STR = 41, GAP = 1.0;
  var cRed = new THREE.Color(RED), cGreen = new THREE.Color(GREEN), cOchre = new THREE.Color(OCHRE);
  var phase = [], baseC = [], baseP = [];
  for (var i = 0; i < STR; i++) {
    var d = (i - 20) / 20;
    baseC.push(1.0 + 7.5 * Math.exp(-Math.pow(d - 0.28, 2) / 0.07) + 2.0 * Math.exp(-Math.pow(d + 0.35, 2) / 0.12) + Math.random() * 0.9);
    baseP.push(1.0 + 7.5 * Math.exp(-Math.pow(d + 0.28, 2) / 0.07) + 2.0 * Math.exp(-Math.pow(d - 0.35, 2) / 0.12) + Math.random() * 0.9);
    phase.push(Math.random() * 6.28);
  }
  var N = STR * 2;
  var towers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  towers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  towers.castShadow = true; towers.receiveShadow = true;
  scene.add(towers);

  // soft shadow catcher and a faint printed grid
  var ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 120), new THREE.ShadowMaterial({ opacity: 0.22 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  var grid = new THREE.GridHelper(160, 80, INK, INK);
  grid.position.y = 0.01; grid.material.transparent = true; grid.material.opacity = 0.1; scene.add(grid);

  // live-price beam and floor ring
  var beamMat = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
  var beam = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 15), beamMat);
  beam.position.y = 7.5; scene.add(beam);
  var ringMat = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  var ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.4, 64), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; scene.add(ring);

  // price ribbon
  var PTS = 240, ribbon = [], ry;
  for (var k = 0; k < PTS; k++) {
    var x = (k / (PTS - 1) - 0.5) * STR * GAP;
    ry = 12 + 1.7 * Math.sin(k * 0.045) + 1.0 * Math.sin(k * 0.13 + 1.3) + 0.5 * Math.sin(k * 0.37);
    ribbon.push(new THREE.Vector3(x, ry, 0));
  }
  var lineGeo = new THREE.BufferGeometry().setFromPoints(ribbon);
  var lineMat = new THREE.LineBasicMaterial({ color: INK }), dotMat = new THREE.PointsMaterial({ color: INK, size: 0.2 });
  scene.add(new THREE.Line(lineGeo, lineMat));
  scene.add(new THREE.Points(lineGeo, dotMat));
  var head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 24), new THREE.MeshBasicMaterial({ color: RED }));
  var halo = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 24), new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.2 }));
  scene.add(head); scene.add(halo);
  var dropMat = new THREE.LineDashedMaterial({ color: INK, dashSize: 0.3, gapSize: 0.25 });
  var drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), dropMat);
  drop.computeLineDistances(); scene.add(drop);

  var m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
  var dim = 0;
  var t = 0, last = performance.now(), mx = 0, my = 0, cx = 0, cy = 0, scrollY = 0, running = true, spotX = 0;
  var tip = document.getElementById("tip"), ray = new THREE.Raycaster(), mouse = new THREE.Vector2(9, 9), hoverId = -1;

  function ribbonY(x) {
    var f = (x / (STR * GAP) + 0.5) * (PTS - 1), i0 = Math.max(0, Math.min(PTS - 2, Math.floor(f))), a = f - i0;
    return ribbon[i0].y * (1 - a) + ribbon[i0 + 1].y * a;
  }

  function update() {
    spotX = Math.sin(t * 0.22) * 11 + Math.sin(t * 0.07) * 4;
    var gain = reduce ? 0 : 1;
    for (var i = 0; i < STR; i++) {
      var x = (i - 20) * GAP, near = Math.exp(-Math.pow((x - spotX) / 3.0, 2));
      var br = 1 + gain * 0.09 * Math.sin(t * 1.3 + phase[i]);
      for (var s = 0; s < 2; s++) {
        var h = 0.8 * (s === 0 ? baseC[i] : baseP[i]) * br * (1 + near * 0.25), z = s === 0 ? -1.15 : 1.15, idx = i * 2 + s;
        pos.set(x, h / 2, z); scl.set(0.74, h, 1.7); m.compose(pos, q, scl); towers.setMatrixAt(idx, m);
        col.copy(s === 0 ? cRed : cGreen).multiplyScalar(1 + near * 0.45 + dim);
        towers.setColorAt(idx, col);
      }
    }
    towers.instanceMatrix.needsUpdate = true;
    if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
    beam.position.x = spotX; ring.position.x = spotX; ring.scale.setScalar(1 + 0.1 * Math.sin(t * 3));
    var hy = ribbonY(spotX); head.position.set(spotX, hy, 0); halo.position.set(spotX, hy, 0); halo.scale.setScalar(1 + 0.15 * Math.sin(t * 4));
    drop.position.set(spotX, hy, 0); drop.scale.y = hy;
  }

  function applyTheme() {
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    var line = dark ? 0xe9f2ea : INK;
    beamMat.color.setHex(line); ringMat.color.setHex(line); lineMat.color.setHex(line); dotMat.color.setHex(line); dropMat.color.setHex(line);
    grid.material.color.setHex(line); grid.material.opacity = dark ? 0.08 : 0.1;
    ground.material.opacity = dark ? 0.55 : 0.22;
    hemi.color.setHex(dark ? 0x9fd0b8 : 0xfff3ea); hemi.groundColor.setHex(dark ? 0x07211b : 0xcf9f88); hemi.intensity = dark ? 0.8 : 0.95;
    sun.intensity = dark ? 0.9 : 0.85;
    dim = dark ? 0.1 : 0;
  }
  window.addEventListener("themechange", applyTheme); applyTheme();

  function resize() {
    var w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", function (e) {
    mx = (e.clientX / innerWidth - 0.5) * 2; my = (e.clientY / innerHeight - 0.5) * 2;
    var r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (tip) { tip.style.left = e.clientX + 14 + "px"; tip.style.top = e.clientY + 14 + "px"; }
  });
  window.addEventListener("scroll", function () { scrollY = Math.min(1, window.scrollY / Math.max(1, innerHeight)); }, { passive: true });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (e) { var was = running; running = e[0].isIntersecting; if (running && !was && !reduce) { last = performance.now(); requestAnimationFrame(frame); } }).observe(canvas);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && running && !reduce) { last = performance.now(); requestAnimationFrame(frame); } });

  function hover() {
    if (!tip) return;
    ray.setFromCamera(mouse, camera);
    var hit = ray.intersectObject(towers)[0];
    if (hit && hit.instanceId !== undefined) {
      if (hit.instanceId !== hoverId) {
        hoverId = hit.instanceId;
        var isCall = hoverId % 2 === 0, k = Math.floor(hoverId / 2) - 20;
        tip.textContent = (isCall ? "Call" : "Put") + " open interest at strike " + (k >= 0 ? "ATM +" + k : "ATM " + k) + " (illustration)";
      }
      tip.style.opacity = 1;
    } else { hoverId = -1; tip.style.opacity = 0; }
  }

  function frame(now) {
    if (!running || document.hidden) return;
    var dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!reduce) t += dt;
    cx += (mx * 5 - cx) * 0.04; cy += (my * 2 - cy) * 0.04;
    var ang = (reduce ? 0 : Math.sin(t * 0.1) * 0.25) + cx * 0.05, wide = camera.aspect > 1;
    var rad = (wide ? 46 : 54) + scrollY * 14;
    camera.position.set(Math.sin(ang) * rad + (wide ? -4 : 0), 14 - cy + scrollY * 8, Math.cos(ang) * rad);
    camera.lookAt(wide ? -13 : 0, 4.6 - scrollY * 2, 0);
    update(); hover();
    renderer.render(scene, camera);
    if (!reduce) requestAnimationFrame(frame);
  }
  resize(); update();
  requestAnimationFrame(function (n) { last = n; frame(n); });
})();
