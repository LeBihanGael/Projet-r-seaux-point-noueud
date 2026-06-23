// ====================================================================
//  Génération de suggestions de trajets A -> B (optimisés, sans zigzag)
//  À CHARGER APRÈS main.js  ->  <script src="suggestions-parcours.js"></script>
//
//  Réutilise les variables/fonctions globales de main.js :
//    NETWORK, adj, map, routeLayer, COLORS, infoDiv, MinHeap,
//    buildRouteGeometry(), currentRouteData, updateTeleButtonVisibility()
//
//  Principe : pour chaque point de départ, on calcule en une fois les plus
//  courts chemins vers TOUS les nœuds (Dijkstra à source unique). On retient
//  les points nommés dont la distance tombe dans la fourchette demandée.
//  Comme ce sont des plus courts chemins, les trajets sont directs, sans
//  détour ni zigzag, tout en respectant la distance cible.
// ====================================================================

// Tolérance autour de la distance demandée (±10 %).
var SUGG_TOLERANCE = 0.10;

// ---- Table nœud -> label (points nommés : départs + croisements numérotés)
var _pnLabelByNode = null;
function labelDeNoeud(nodeIdx) {
  if (!_pnLabelByNode) {
    _pnLabelByNode = new Map();
    NETWORK.pn.forEach(function (p) {
      if (p[3] !== 0 && p[4] >= 0) _pnLabelByNode.set(p[4], p[5]);
    });
  }
  return _pnLabelByNode.has(nodeIdx) ? _pnLabelByNode.get(nodeIdx) : null;
}

// ---- Mélange en place (Fisher-Yates)
function _shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ---- Dijkstra à source unique (vers tous les nœuds)
function dijkstraDepuis(startNode, avoidUnpaved) {
  var n = NETWORK.nodes.length;
  var dist = new Float64Array(n);
  var prev = new Int32Array(n);
  var prevEdge = new Int32Array(n);
  for (var i = 0; i < n; i++) { dist[i] = Infinity; prev[i] = -1; prevEdge[i] = -1; }
  dist[startNode] = 0;

  var heap = new MinHeap();
  heap.push([0, startNode]);

  while (heap.size() > 0) {
    var top = heap.pop();
    var d = top[0], u = top[1];
    if (d > dist[u]) continue;
    var nbrs = adj[u];
    for (var k = 0; k < nbrs.length; k++) {
      var nb = nbrs[k];
      if (avoidUnpaved && NETWORK.edges[nb.edge][4] === 1) continue;
      var nd = d + nb.w;
      if (nd < dist[nb.to]) {
        dist[nb.to] = nd; prev[nb.to] = u; prevEdge[nb.to] = nb.edge;
        heap.push([nd, nb.to]);
      }
    }
  }
  return { dist: dist, prev: prev, prevEdge: prevEdge };
}

// ---- Reconstruit le chemin start -> end à partir des tableaux prev
function reconstruire(end, prev, prevEdge) {
  var nodes = [], edges = [], cur = end;
  while (cur !== -1) {
    nodes.push(cur);
    if (prevEdge[cur] !== -1) edges.push(prevEdge[cur]);
    cur = prev[cur];
  }
  nodes.reverse(); edges.reverse();
  return { nodes: nodes, edges: edges };
}

// ---- Génère `count` trajets distincts et directs
function genererSuggestions(targetMeters, allowUnpaved, isPlus, count) {
  var minDist = isPlus ? targetMeters : targetMeters * (1 - SUGG_TOLERANCE);
  var maxDist = isPlus ? targetMeters * 3 : targetMeters * (1 + SUGG_TOLERANCE);
  var avoidUnpaved = !allowUnpaved;

  // Points de départ rattachés au réseau (typecourt === 2)
  var starts = [];
  NETWORK.pn.forEach(function (p) { if (p[3] === 2 && p[4] >= 0) starts.push(p[4]); });
  if (starts.length === 0) {                            // repli : tous les nœuds
    for (var i = 0; i < NETWORK.nodes.length; i++) starts.push(i);
  }
  _shuffle(starts);

  // Points nommés candidats à l'arrivée (uniques)
  var namedSet = new Set();
  NETWORK.pn.forEach(function (p) { if (p[3] !== 0 && p[4] >= 0) namedSet.add(p[4]); });
  var named = Array.from(namedSet);

  var results = [];
  var seen = new Set();

  // État par point de départ : Dijkstra + liste d'arrivées candidates + curseur.
  // Tout est calculé paresseusement (à la première visite du départ).
  var etats = starts.map(function (start) {
    return { start: start, sssp: null, cands: null, ptr: 0, fini: false };
  });

  function preparer(st) {
    if (st.sssp) return;
    st.sssp = dijkstraDepuis(st.start, avoidUnpaved);
    var cands = [];
    for (var ci = 0; ci < named.length; ci++) {
      var node = named[ci];
      if (node === st.start) continue;
      var d = st.sssp.dist[node];
      if (d >= minDist && d <= maxDist) cands.push(node);
    }
    _shuffle(cands);
    st.cands = cands;
  }

  // Renvoie UN nouveau trajet (non doublon) depuis ce départ, ou null s'il est épuisé.
  function prochainDepuis(st) {
    preparer(st);
    while (st.ptr < st.cands.length) {
      var end = st.cands[st.ptr++];
      var path = reconstruire(end, st.sssp.prev, st.sssp.prevEdge);
      if (path.edges.length === 0) continue;

      var sig = path.edges.slice().sort(function (a, b) { return a - b; }).join(',');
      if (seen.has(sig)) continue;
      seen.add(sig);

      return {
        nodes: path.nodes, edges: path.edges,
        distance: st.sssp.dist[end], start: st.start, end: end
      };
    }
    st.fini = true;
    return null;
  }

  // Round-robin : à chaque tour on prend AU PLUS un trajet par point de départ,
  // donc deux suggestions consécutives partent de points différents. On répète
  // les tours jusqu'à atteindre `count` ou jusqu'à ce qu'aucun départ ne fournisse
  // plus rien.
  var progres = true;
  while (results.length < count && progres) {
    progres = false;
    for (var i = 0; i < etats.length && results.length < count; i++) {
      if (etats[i].fini) continue;
      var r = prochainDepuis(etats[i]);
      if (r) { results.push(r); progres = true; }
    }
  }

  // On conserve l'ordre de génération (départs alternés) sans trier par distance.
  return results.slice(0, count);
}

// ---- Affiche un trajet suggéré sur la carte + panneau d'info
function afficherParcoursSuggere(trajet) {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }

  var coords = buildRouteGeometry(trajet.nodes, trajet.edges);

  routeLayer = L.layerGroup();
  var all = [];
  coords.runs.forEach(function (run) {
    L.polyline(run.coords, {
      color: run.unpaved ? COLORS.routeUnpaved : COLORS.routePaved,
      weight: 5, opacity: 0.9,
      dashArray: run.unpaved ? '8, 8' : null
    }).addTo(routeLayer);
    run.coords.forEach(function (c) { all.push(c); });
  });
  routeLayer.addTo(map);
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });

  var labelA = labelDeNoeud(trajet.start) || ('nœud ' + trajet.start);
  var labelB = labelDeNoeud(trajet.end) || ('nœud ' + trajet.end);

  var via = [];
  trajet.nodes.forEach(function (nodeIdx) {
    if (nodeIdx === trajet.start || nodeIdx === trajet.end) return;
    var lbl = labelDeNoeud(nodeIdx);
    if (lbl !== null) via.push(lbl);
  });

  var distanceKm = (trajet.distance / 1000).toFixed(2);
  var unpavedKm = (coords.unpavedMeters / 1000).toFixed(2);
  var unpavedPct = trajet.distance > 0
    ? Math.round((coords.unpavedMeters / trajet.distance) * 100) : 0;

  var pathHtml = labelA + ' → ' +
    (via.length > 0 ? via.join(' → ') + ' → ' : '') + labelB;
  var unpavedHtml = coords.unpavedMeters > 0
    ? '<div class="stats">dont ' + unpavedKm + ' km non revêtus (' + unpavedPct + '%)</div>'
    : '<div class="stats">100 % revêtu</div>';

  infoDiv.innerHTML =
    '<div class="path">' + pathHtml + '</div>' +
    '<div class="stats">Distance : ' + distanceKm + ' km</div>' +
    unpavedHtml;

  currentRouteData = {
    start: labelA, end: labelB, via: via.slice(), nbVia: via.length,
    distanceKm: distanceKm,
    unpavedKm: coords.unpavedMeters > 0 ? unpavedKm : null,
    unpavedPct: unpavedPct
  };
  if (typeof updateTeleButtonVisibility === 'function') updateTeleButtonVisibility();

  var panel = document.getElementById('route-panel');
  if (panel) panel.classList.add('visible');

  // Le trajet suggéré n'utilise pas les marqueurs : on affiche quand même
  // le bouton « Supprimer l'itinéraire ». Son clic appelle resetSelection()
  // -> updateRoute(), qui retire le tracé, vide le panneau et re-cache le bouton.
  var resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.removeAttribute('hidden');

  var histoBtn = document.getElementById('histo-btn');
  if (histoBtn) histoBtn.removeAttribute('hidden');
}

// ---- Point d'entrée appelé depuis la modale de suggestion
//      `box` = la div .modal-box de la modale.
function lancerSuggestions(box) {
  var kmSel = box.querySelector('#nbKm');
  var cheminSel = box.querySelector('#chemin');
  var rawKm = kmSel ? kmSel.value : '10 Km';
  var targetMeters = (parseInt(rawKm, 10) || 10) * 1000;
  var isPlus = /et\s*\+/.test(rawKm);
  var allowUnpaved = cheminSel ? (cheminSel.value === 'oui') : true;

  var results = box.querySelector('#suggestion-results');
  if (!results) {
    results = document.createElement('div');
    results.id = 'suggestion-results';
    results.style.marginTop = '12px';
    box.appendChild(results);
  }
  results.innerHTML = '<p>Génération des suggestions…</p>';

  // Dès que la modale se ferme (croix, clic extérieur, Échap, ou clic sur une
  // suggestion), on retire la liste : la pop-up revient à son état initial.
  // L'observateur surveille la perte de la classe « open » sur l'overlay, ce
  // qui couvre tous les modes de fermeture sans toucher à main.js.
  var overlay = document.getElementById('suggestion-modal');
  if (overlay && !overlay._suggObserver) {
    var obs = new MutationObserver(function () {
      if (!overlay.classList.contains('open')) {
        var r = overlay.querySelector('#suggestion-results');
        if (r) r.remove();
      }
    });
    obs.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    overlay._suggObserver = obs;
  }

  setTimeout(function () {
    var suggestions = genererSuggestions(targetMeters, allowUnpaved, isPlus, 10);

    if (suggestions.length === 0) {
      results.innerHTML = '<p>Aucun trajet trouvé pour ces critères. ' +
        'Essayez une autre distance ou autorisez les chemins non revêtus.</p>';
      return;
    }

    var html = '<p style="font-weight:600;margin:8px 0;">' +
      suggestions.length + ' suggestion(s) — cliquez pour afficher :</p>' +
      '<ul style="list-style:none;padding:0;margin:0;max-height:240px;overflow:auto;">';

    suggestions.forEach(function (trajet, idx) {
      var coords = buildRouteGeometry(trajet.nodes, trajet.edges);
      var km = (trajet.distance / 1000).toFixed(1);
      var pct = trajet.distance > 0
        ? Math.round((coords.unpavedMeters / trajet.distance) * 100) : 0;
      var detail = coords.unpavedMeters > 0 ? (pct + '% non revêtu') : '100% revêtu';
      var a = labelDeNoeud(trajet.start) || trajet.start;
      var b = labelDeNoeud(trajet.end) || trajet.end;
      html += '<li><button type="button" class="sugg-item" data-idx="' + idx + '" ' +
        'style="width:100%;text-align:left;padding:8px 10px;margin:4px 0;' +
        'border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;">' +
        'Trajet ' + (idx + 1) + ' — ' + km + ' km · ' + a + ' → ' + b + ' · ' + detail +
        '</button></li>';
    });
    html += '</ul>';
    results.innerHTML = html;

    results.querySelectorAll('.sugg-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var trajet = suggestions[parseInt(btn.getAttribute('data-idx'), 10)];
        afficherParcoursSuggere(trajet);
        var overlay = document.getElementById('suggestion-modal');
        if (overlay) overlay.classList.remove('open');
      });
    });
  }, 20);
}