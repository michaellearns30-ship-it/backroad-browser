// notebook - a writing surface inside the app. app.js is not touched: this file
// wires the sheet that already exists in index.html.
(function () {
  'use strict';
  var KEY = 'backroad.notebook.v1';
  var INK = '#1b1a17';
  var header = document.querySelector('header.top');
  var sheet = document.getElementById('notebook');
  var canvas = document.getElementById('nbCanvas');
  var notes = document.getElementById('nbText');
  if (!header || !sheet || !canvas || !notes) return;

  var btn = document.createElement('button');
  btn.id = 'btnNotebook';
  btn.className = 'icon';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Notebook');
  btn.innerHTML = '&#9998;';
  var settings = document.getElementById('btnSettings');
  if (settings && settings.parentNode === header) header.insertBefore(btn, settings);
  else header.appendChild(btn);

  var ctx = canvas.getContext('2d');
  var pen = document.getElementById('nbPen');
  var eraser = document.getElementById('nbErase');
  var erasing = false, drawing = false, last = null;
  var undoStack = [], saveTimer = null, boxW = 0, boxH = 0, loaded = false;

  function paint(url, done) {
    var img = new Image();
    img.onload = function () {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, boxW, boxH);
      ctx.drawImage(img, 0, 0, boxW, boxH);
      ctx.restore();
      if (done) done();
    };
    img.onerror = function () { if (done) done(); };
    img.src = url;
  }

  function fit() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(260, Math.round(canvas.parentNode.getBoundingClientRect().width));
    var h = Math.max(200, Math.round(window.innerHeight * 0.5));
    var prev = canvas.width > 0 ? canvas.toDataURL('image/png') : null;
    boxW = w;
    boxH = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    return prev;
  }

  function load() {
    var raw = null, saved = null;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) return;
    try { saved = JSON.parse(raw); } catch (e) { return; }
    if (saved && typeof saved.text === 'string') notes.value = saved.text;
    if (saved && typeof saved.png === 'string' && saved.png.indexOf('data:image') === 0) paint(saved.png);
  }

  function save() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      try {
        window.localStorage.setItem(KEY, JSON.stringify({ png: canvas.toDataURL('image/png'), text: notes.value }));
      } catch (e) { /* full or blocked: page keeps working, it just forgets */ }
    }, 700);
  }

  function pushUndo() {
    if (!canvas.width) return;
    undoStack.push(canvas.toDataURL('image/png'));
    if (undoStack.length > 8) undoStack.shift();
  }

  function at(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function line(a, b) {
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = INK;
    ctx.lineWidth = erasing ? 18 : 2.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function open() {
    sheet.hidden = false;
    window.requestAnimationFrame(function () {
      var prev = fit();
      if (!loaded) { loaded = true; load(); } else if (prev) paint(prev);
    });
  }

  function close() {
    save();
    sheet.hidden = true;
  }

  btn.addEventListener('click', function () { if (sheet.hidden) open(); else close(); });
  document.getElementById('nbClose').addEventListener('click', close);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close(); });

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    drawing = true;
    last = at(e);
    pushUndo();
    line(last, last);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older webviews */ }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    e.preventDefault();
    var p = at(e);
    line(last, p);
    last = p;
  });
  function stop() {
    if (!drawing) return;
    drawing = false;
    last = null;
    save();
  }
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  pen.addEventListener('click', function () {
    erasing = false;
    pen.classList.add('is-on');
    eraser.classList.remove('is-on');
  });
  eraser.addEventListener('click', function () {
    erasing = true;
    eraser.classList.add('is-on');
    pen.classList.remove('is-on');
  });

  document.getElementById('nbUndo').addEventListener('click', function () {
    var url = undoStack.pop();
    if (url) paint(url, save);
  });
  document.getElementById('nbClear').addEventListener('click', function () {
    pushUndo();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, boxW, boxH);
    save();
  });

  notes.addEventListener('input', save);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) close();
  });
})();
