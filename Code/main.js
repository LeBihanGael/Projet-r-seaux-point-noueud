var COLORS = {
    networkPaved: '#0004ff',  // réseau de fond, segments revêtus
    networkUnpaved: '#c06612',  // réseau de fond, chemins non revêtus
    routePaved: '#cde20e',  // itinéraire calculé, portion revêtue
    routeUnpaved: '#cde20e',  // itinéraire calculé, portion non revêtue
};

var NETWORK = null;
var adj = [];
var selectedMarkers = [];
var markerIndex = new Map();
var MAX_SELECTED = 2;
var routeLayer = null;
var networkLayer = null;
var map = null;
var infoDiv = null;
var rechercheMarker = null;
let carteBloquee = false;
var lockBtn = null;
var SVG_CADENAS_FERME =
    '<svg viewBox="0 0 24 24" width="18" height="18" ' +
    'fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="5" y="11" width="14" height="10" rx="2"></rect>' +
    '<path d="M8 11V7a4 4 0 0 1 8 0v4"></path>' +
    '</svg>';

var SVG_CADENAS_OUVERT =
    '<svg viewBox="0 0 24 24" width="18" height="18" ' +
    'fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="5" y="11" width="14" height="10" rx="2"></rect>' +
    '<path d="M8 11V7a4 4 0 0 1 7.9-1"></path>' +
    '</svg>';

// Données de l'itinéraire actuellement affiché, utilisées pour l'export PDF/KML.
var currentRouteData = null;

// ====== Minuteur "parcours pris" ======
// Si un itinéraire reste affiché PARCOURS_DELAI_MS sans être supprimé ni changé,
// il est compté comme "pris". L'ajout explicite à l'historique le compte aussi.
var parcoursTimer = null;
var PARCOURS_DELAI_MS = 5 * 60 * 1000; // 5 minutes
// Référence du dernier itinéraire déjà compté, pour ne pas le compter 2 fois.
var dernierParcoursCompte = null;

// ====== État de session ======
// L'authentification repose désormais sur un TOKEN signé, émis par le back à la
// connexion/inscription et stocké dans le localStorage. C'est lui la source de
// vérité : on l'envoie à chaque appel protégé, et le back en déduit l'identité.
// On garde aussi le nom en localStorage pour l'afficher après un rechargement.
var currentUser = null;

function getToken() {
    return localStorage.getItem('token');
}

function estConnecte() {
    return getToken() !== null;
}

// Mémorise le token + les infos renvoyés par le back ({ token, id, mail, nom }).
function connecterUtilisateur(data) {
    currentUser = { id: data.id, mail: data.mail, nom: data.nom };
    localStorage.setItem('token', data.token);
    localStorage.setItem('userNom', data.nom || '');
}

// Au chargement : si un token est présent, on restaure la session pour rester
// connecté après un rafraîchissement de page. (L'id réel sera connu du back via
// le token ; côté front on n'en a plus besoin pour les appels.)
function restaurerSession() {
    localStorage.removeItem('userId');   // nettoyage d'une ancienne clé devenue inutile
    if (getToken()) {
        currentUser = {
            id: null,
            mail: null,
            nom: localStorage.getItem('userNom') || null
        };
    }
}

// fetch qui joint automatiquement le token dans l'en-tête Authorization.
// Si le back répond 401 (token absent/expiré), on déconnecte et on rouvre la
// pop-up de connexion.
function fetchAuth(url, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers);
    var token = getToken();
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, options).then(function (resp) {
        if (resp.status === 401) {
            deconnexion();
            popUpConnexion();
            throw new Error('Session expirée');
        }
        return resp;
    });
}

// ====== Validations des formulaires ======
// L'email doit contenir au moins un '@' et un '.'.
function emailValide(mail) {
    return mail.includes('@') && mail.includes('.');
}

// Le mot de passe doit faire au moins 10 caractères et contenir au moins une
// majuscule, un chiffre et un caractère spécial (tout ce qui n'est ni lettre
// ni chiffre).
function motDePasseValide(mdp) {
    var assezLong = mdp.length >= 10;
    var aMajuscule = /[A-Z]/.test(mdp);
    var aChiffre = /[0-9]/.test(mdp);
    var aSpecial = /[^A-Za-z0-9]/.test(mdp);
    return assezLong && aMajuscule && aChiffre && aSpecial;
}

// Garde-fou à placer au début de toute fonction réservée aux connectés.
// Renvoie true si l'utilisateur est connecté ; sinon il l'avertit, ouvre la
// pop-up de connexion et renvoie false (la fonction appelante doit s'arrêter).
function requireLogin() {
    if (estConnecte()) return true;
    alert('Vous devez être connecté pour effectuer cette action.');
    popUpConnexion();
    return false;
}

// Met le bouton "Connexion / Déconnexion" en accord avec l'état de session.
function majBoutonConnexion() {
    majBoutonHisto();

    var btn = document.getElementById('login-btn');
    if (!btn) return;
    if (estConnecte()) {
        // priorité au nom, sinon le mail, sinon un libellé générique
        var nom = (currentUser && currentUser.nom) ? currentUser.nom
                : (currentUser && currentUser.mail) ? currentUser.mail
                : 'Mon compte';
        btn.textContent = 'Déconnexion (' + nom + ')';
    } else {
        btn.textContent = 'Connexion';
    }
}

// Affiche/masque les deux boutons réservés aux connectés : profil + historique.
function majBoutonHisto() {
    var btns = [
        document.getElementById('VHisto-btn'),
        document.getElementById('histo-list-btn')
    ];
    btns.forEach(function (btn) {
        if (!btn) return;
        if (estConnecte()) btn.removeAttribute('hidden');
        else btn.setAttribute('hidden', '');
    });
}

// Déconnecte l'utilisateur : on efface le token et le nom du localStorage et la
// session en mémoire, on remet le bouton dans son état "Connexion", et on
// informe l'utilisateur.
function deconnexion() {
    if (!estConnecte()) return;
    var nom = (currentUser && (currentUser.nom || currentUser.mail)) || '';
    currentUser = null;
    localStorage.removeItem('token');
    localStorage.removeItem('userNom');
    majBoutonConnexion();
    alert('Vous avez été déconnecté' + (nom ? ' (' + nom + ')' : '') + '.');
}

// Marqueurs séparés par groupe selon leur type :
//   - departureLayer  : points de départ (typecourt = 2), toujours visibles
//   - otherMarkersLayer : nœuds et croisements numérotés, visibles seulement zoomé
var departureLayer = null;
var otherMarkersLayer = null;

// Seuil de zoom : en dessous, seuls les points de départ sont visibles.
var ZOOM_DETAIL_THRESHOLD = 12;

// ====== Initialisation principale ======
function init() {
    infoDiv = document.getElementById('route-info');

    // Carte
    map = L.map('map', { minZoom: 10, maxZoom: 18, preferCanvas: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd'
    }).addTo(map);

    map.setView([50.13, 1.72], 11);
    map.on('zoomend', updateMarkerVisibility);

    // Contrôle "Légende" placé sous les +/- de zoom (topleft).
    addLegende();
    addRecherche();
    addSuggestion();
    addLockMap();

    // Bouton "Réinitialiser" dans le panneau itinéraire (visible quand sélection active) et bouton pour ajouter un itinéraire dans l'historique.
    document.getElementById('reset-btn').addEventListener('click', resetSelection);
    document.getElementById('histo-btn').addEventListener('click', histo);
    document.getElementById('tele-btn').addEventListener('click', openTeleModal);
    document.getElementById('VHisto-btn').addEventListener('click', openProfilModal);
    document.getElementById('histo-list-btn').addEventListener('click', openHistoModal);

    // Bouton Connexion : ouvre la pop-up de connexion, ou déconnecte si l'on
    // est déjà connecté.
    document.getElementById('login-btn').addEventListener('click', function () {
        if (estConnecte()) {
            deconnexion();
        } else {
            popUpConnexion();
        }
    });

    // On restaure la session éventuelle (token en localStorage) AVANT de mettre
    // le bouton à jour, pour rester connecté après un rechargement de page.
    restaurerSession();
    majBoutonConnexion();


    // Chargement async des données
    fetch('network.json')
        .then(function (r) {
            if (!r.ok) throw new Error('Échec chargement network.json (' + r.status + ')');
            return r.json();
        })
        .then(function (data) {
            NETWORK = data;
            onNetworkLoaded();
        })
        .catch(function (err) {
            console.error(err);
            infoDiv.innerHTML = '<span class="placeholder">Erreur de chargement des données réseau.</span>';
            var statusEl = document.getElementById('status');
            if (statusEl) statusEl.textContent = 'Erreur : ' + err.message;
        });
}



// Pop up pour la légende
function addLegende() {
    var legende = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function () {
            var leg = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-legende');
            var btn = L.DomUtil.create('a', '', leg);
            btn.href = '#';
            btn.title = 'Afficher la légende';
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', 'Afficher la légende');
            btn.textContent = 'i';

            L.DomEvent.disableClickPropagation(leg);
            L.DomEvent.disableScrollPropagation(leg);

            L.DomEvent.on(btn, 'click', function (e) {
                L.DomEvent.preventDefault(e);
                openLegendeModale();
            });

            return leg;
        }
    });
    map.addControl(new legende());
}

function openLegendeModale() {
    var existing = document.getElementById('legende-modal');
    if (existing) {
        existing.classList.add('open');
        return;
    }

    var overlay = document.createElement('div');
    overlay.id = 'legende-modal';
    overlay.className = 'modal-overlay open';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';

    var title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Légende de la carte';

    var tpl = document.getElementById('legend-template');
    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(tpl.content.cloneNode(true));

    box.querySelectorAll('.swatch[data-color]').forEach(function (el) {
        var color = COLORS[el.getAttribute('data-color')];
        if (!color) return;
        if (el.classList.contains('swatch-dashed')) {
            el.style.background = 'repeating-linear-gradient(to right, ' + color + ' 0, ' + color + ' 5px, transparent 5px, transparent 9px)';
        } else {
            el.style.backgroundColor = color;
        }
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.remove('open');
    }

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });
}

// Pop pour afficher la suggestion d'un itinéraire
function addSuggestion() {
    var suggestion = L.Control.extend({
        options: { position: 'topright' },
        onAdd: function () {
            var sug = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-suggestion');
            var btn = L.DomUtil.create('a', '', sug);
            btn.href = '#';
            btn.title = 'Demander une suggestion';
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', 'Demande de suggestion');
            btn.textContent = '?';

            L.DomEvent.disableClickPropagation(sug);
            L.DomEvent.disableScrollPropagation(sug);

            L.DomEvent.on(btn, 'click', function (e) {
                L.DomEvent.preventDefault(e);
                openSuggestionModal();
            });

            return sug;
        }
    });
    map.addControl(new suggestion());
}

// ====== Pop-up (modale) de suggestion ======
function openSuggestionModal() {
    // Si elle existe déjà, on la ré-affiche simplement
    var existing = document.getElementById('suggestion-modal');
    if (existing) { existing.classList.add('open'); return; }

    var overlay = document.createElement('div');
    overlay.id = 'suggestion-modal';
    overlay.className = 'modal-overlay open';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';

    var title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Demander une suggestion';

    var confimBtn = document.createElement('button');
    confimBtn.className = 'modal-confirm-btn';
    confimBtn.setAttribute('aria-label', 'confirmer');
    confimBtn.innerHTML = 'Confirmer';

    // On réutilise le même contenu que le template existant
    var tpl = document.getElementById('suggestion-template');
    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(tpl.content.cloneNode(true));
    box.appendChild(confimBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.remove('open');
    }
    function confirm() {
        lancerSuggestions(box);
    }

    closeBtn.addEventListener('click', close);
    // Clic en dehors de la boîte = fermeture
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });
    // Touche Échap = fermeture
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
    });

    confimBtn.addEventListener('click', confirm);
}

// Pop up pour la recherche d'adresse
function addRecherche() {
    var recherche = L.Control.extend({
        options: { position: 'topright' },
        onAdd: function () {
            var rech = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-recherche');
            var btn = L.DomUtil.create('a', '', rech);
            btn.href = '#';
            btn.title = "Faire une recherche d'adresse";
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', 'Faire une recherche');

            // Icône loupe en SVG
            btn.innerHTML =
                '<svg viewBox="0 0 24 24" width="18" height="18" ' +
                'fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round">' +
                '<circle cx="11" cy="11" r="7"></circle>' +
                '<line x1="16.5" y1="16.5" x2="21" y2="21"></line>' +
                '</svg>';

            L.DomEvent.disableClickPropagation(rech);
            L.DomEvent.disableScrollPropagation(rech);

            L.DomEvent.on(btn, 'click', function (e) {
                L.DomEvent.preventDefault(e);
                openRechercheModal();
            });
            return rech;
        }
    });
    map.addControl(new recherche());
}

function openRechercheModal() {
    var existing = document.getElementById('recherche-modal');
    if (existing) {
        existing.querySelectorAll('#adresse, #code-postal, #ville').forEach(function (champ) {
            champ.value = '';
        });
        if (rechercheMarker) {
            map.removeLayer(rechercheMarker);
            rechercheMarker = null;
        }
        existing.classList.add('open');
        return;
    }

    var overlay = document.createElement('div');
    overlay.id = 'recherche-modal';
    overlay.className = 'modal-overlay open';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times';

    var title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Rechercher une adresse';

    var showBtn = document.createElement('button');
    showBtn.className = 'modal-confirm-btn';
    showBtn.setAttribute('aria-label', 'centrer sur la carte');
    showBtn.innerHTML = 'Montrer sur la carte';

    var tpl = document.getElementById('recherche-template');
    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(tpl.content.cloneNode(true));
    box.appendChild(showBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.remove('open');
    }
    async function show() {
        var adresse = (box.querySelector('#adresse') || {}).value || '';
        var cp = (box.querySelector('#code-postal') || {}).value || '';
        var ville = (box.querySelector('#ville') || {}).value || '';

        var query = [adresse, cp, ville]
            .map(function (s) {
                return String(s).trim();
            })
            .filter(Boolean)
            .join(', ');

        if (!query) {
            alert('Veuillez saisir au moins une adresse, un code postal ou une ville.');
            return;
        }

        showBtn.disabled = true;
        showBtn.textContent = 'Recherche...';

        var data;
        try {
            var url = 'https://nominatim.openstreetmap.org/search'
                + '?format=json&limit=1&countrycodes=fr'
                + '&q=' + encodeURIComponent(query);
            var resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            data = await resp.json();
        } catch (err) {
            console.error('Erreur réseau Nominatim:', err);
            alert("Erreur réseau lors de la recherche. Réessayez plus tard.");
            showBtn.disabled = false;
            showBtn.textContent = 'Montrer sur la carte';
            return;
        }

        showBtn.disabled = false;
        showBtn.textContent = 'Montrer sur la carte';

        if (!data || data.length === 0) {
            alert("Adresse introuvable. Vérifiez les informations saisies.");
            return;
        }

        var lat = parseFloat(data[0].lat);
        var lng = parseFloat(data[0].lon);

        if (rechercheMarker) {
            map.remove(rechercheMarker);
        }

        rechercheMarker = L.marker([lat, lng], { icon: createRedPinIcon() })
            .addTo(map)
            .bindPopup(data[0].display_name);

        map.setView([lat, lng], 15);
        close();

    }

    // Pour fermer la pop-up (bouton et clique en dehors de la pop-up).
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });

    // Pour confirmer l'envoi.
    showBtn.addEventListener('click', show);
}

// Fonction qui affiche le formulaire de connexion
function popUpConnexion() {
    var existing = document.getElementById('connexion-modal');
    if (existing) {
        existing.classList.add('open');
        return;
    }

    var overlay = document.createElement('div');
    overlay.id = 'connexion-modal';
    overlay.className = 'modal-overlay open';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';

    var title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Connexion';

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'modal-confirm-btn';
    confirmBtn.setAttribute('aria-label', 'Confirmer la connexion');
    confirmBtn.innerHTML = 'Se connecter';

    var message = document.createElement('p');
    message.className = 'modal-message';
    message.setAttribute('aria-live', 'polite');
    message.textContent = '';

    var redirecIns = document.createElement('button');
    redirecIns.className = 'modal-confirm-btn';
    redirecIns.setAttribute('aria-label', 'Pas de compte');
    redirecIns.innerHTML = 'Pas encore de compte ?';

    var tpl = document.getElementById('connexion-template');
    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(tpl.content.cloneNode(true));
    box.appendChild(message);
    box.appendChild(confirmBtn);
    box.appendChild(redirecIns);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.remove('open');
        message.textContent = '';
        confirmBtn.disabled = false;
    }
    // Connexion réelle : on envoie le mail + mot de passe à la route back
    // /api/connexion. Si le back valide, il renvoie { token, id, mail, nom } :
    // on mémorise le token (et le nom) côté front.
    async function confirm() {
        var mailInput = box.querySelector('#e-mail');
        var mdpInput = box.querySelector('#mot-de-passe');
        var mail = mailInput ? mailInput.value.trim() : '';
        var motDePasse = mdpInput ? mdpInput.value : '';

        if (!mail || !motDePasse) {
            message.textContent = 'Veuillez saisir votre mail et votre mot de passe.';
            return;
        }
        if (!emailValide(mail)) {
            message.textContent = "L'Email n'est pas valide.";
            return;
        }

        confirmBtn.disabled = true;
        message.textContent = 'Connexion en cours...';

        try {
            var resp = await fetch('/api/connexion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mail: mail, motDePasse: motDePasse })
            });
            var data = await resp.json();

            if (!resp.ok) {
                // 400 / 401 / 500 -> on affiche le message d'erreur renvoyé par le back
                message.textContent = data.erreur || 'Échec de la connexion.';
                confirmBtn.disabled = false;
                return;
            }

            // Connexion réussie : on mémorise le token + les infos
            connecterUtilisateur(data);

            message.textContent = 'Connexion réussie';
            majBoutonConnexion();
            setTimeout(close, 1500);
        } catch (err) {
            console.error('Erreur réseau connexion :', err);
            message.textContent = 'Erreur réseau. Réessayez plus tard.';
            confirmBtn.disabled = false;
        }
    }
    function popUpInscription() {
        close();

        var dejala = document.getElementById('inscription-modal');
        if (dejala) {
            dejala.classList.add('open');
            return;
        }

        var modal = document.createElement('div');
        modal.id = 'inscription-modal';
        modal.className = 'modal-overlay open';

        var boite = document.createElement('div');
        boite.className = 'modal-box';

        var fermeBtn = document.createElement('button');
        fermeBtn.className = 'modal-close';
        fermeBtn.setAttribute('aria-label', 'Fermer');
        fermeBtn.innerHTML = '&times;';

        var titre = document.createElement('h2');
        titre.className = 'modal-title';
        titre.textContent = 'Inscription';

        var envoiBtn = document.createElement('button');
        envoiBtn.className = 'modal-confirm-btn';
        envoiBtn.setAttribute('aria-label', 'Inscription');
        envoiBtn.innerHTML = "S'inscrire";

        var messIns = document.createElement('p');
        messIns.className = 'modal-message';
        messIns.setAttribute('aria-live', 'polite');
        messIns.textContent = '';

        var templ = document.getElementById('inscription-template');
        boite.appendChild(fermeBtn);
        boite.appendChild(titre);
        boite.appendChild(templ.content.cloneNode(true));
        boite.appendChild(messIns);
        boite.appendChild(envoiBtn);

        modal.appendChild(boite);
        document.body.appendChild(modal);

        function fermer() {
            modal.classList.remove('open');
            messIns.textContent = '';
            envoiBtn.disabled = false;
        }
        // Inscription réelle : on envoie le nom + mail + mot de passe à
        // /api/inscription. Le back crée l'utilisateur et renvoie un token :
        // on connecte directement le nouvel utilisateur.
        async function envoi() {
            var nomInput = boite.querySelector('#nom');
            var mailInput = boite.querySelector('#mail');
            var mdpInput = boite.querySelector('#mdp, input[type="password"]');
            var nom = nomInput ? nomInput.value.trim() : '';
            var mail = mailInput ? mailInput.value.trim() : '';
            var motDePasse = mdpInput ? mdpInput.value : '';

            if (!nom || !mail || !motDePasse) {
                messIns.textContent = 'Veuillez saisir un nom, un mail et un mot de passe.';
                return;
            }
            if (!emailValide(mail)) {
                messIns.textContent = "L'Email n'est pas valide. Veuillez réessayer";
                return;
            }
            if (!motDePasseValide(motDePasse)) {
                messIns.textContent = 'Le mot de passe doit faire au moins 10 caractères et contenir au moins une majuscule, un chiffre et un caractère spécial.';
                return;
            }

            envoiBtn.disabled = true;
            messIns.textContent = 'Inscription en cours...';

            try {
                var resp = await fetch('/api/inscription', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nom: nom, mail: mail, motDePasse: motDePasse })
                });
                var data = await resp.json();

                if (!resp.ok) {
                    messIns.textContent = data.erreur || "Échec de l'inscription.";
                    envoiBtn.disabled = false;
                    return;
                }

                connecterUtilisateur(data);

                messIns.textContent = 'Inscription réussie. Bienvenue !';
                majBoutonConnexion();
                setTimeout(fermer, 1500);
            } catch (err) {
                console.error('Erreur réseau inscription :', err);
                messIns.textContent = 'Erreur réseau. Réessayez plus tard.';
                envoiBtn.disabled = false;
            }
        }

        fermeBtn.addEventListener('click', fermer);
        modal.addEventListener('click', function (e) {
            if (e.target === modal) fermer();
        });

        envoiBtn.addEventListener('click', envoi);
    }

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });

    confirmBtn.addEventListener('click', confirm);
    redirecIns.addEventListener('click', popUpInscription);
}

// Permet quand le bouton est cliqué dans le panel d'ouvrir une pop-up qui permet ensuite de choisir le format.
function openTeleModal() {
    var pres = document.getElementById('telechargement-modal');
    if (pres) {
        pres.classList.add('open');
        return;
    }

    var divT = document.createElement('div');
    divT.id = 'telechargement-modal';
    divT.className = 'modal-overlay open';

    var divBox = document.createElement('div');
    divBox.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';

    var title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Choisissez un format pour télécharger le parcours';

    var pdfBtn = document.createElement('button');
    pdfBtn.className = 'modal-pdfBtn';
    pdfBtn.setAttribute('aria-label', 'Format PDF');
    pdfBtn.innerHTML = 'PDF';

    var kmlBtn = document.createElement('button');
    kmlBtn.className = 'modal-kmlBtn';
    kmlBtn.setAttribute('aria-label', 'Format KML');
    kmlBtn.innerHTML = 'KML';

    divBox.appendChild(closeBtn);
    divBox.appendChild(title);
    divBox.appendChild(pdfBtn);
    divBox.appendChild(kmlBtn);

    divT.appendChild(divBox);
    document.body.appendChild(divT);

    function close() {
        divT.classList.remove('open');
    }

    closeBtn.addEventListener('click', close);
    divT.addEventListener('click', function (e) {
        if (e.target === divT) close();
    });

    // Permet de lancer le téléchargement au format PDF.
    pdfBtn.addEventListener('click', telechargerPDF);

    // Permet de lancer le téléchargement au format KML.
    kmlBtn.addEventListener('click', telechargerKML);
}

// ====== Pop-up Historique (lu depuis la base de données) ======
async function openHistoModal() {
    if (!requireLogin()) return;

    var existing = document.getElementById('histo-modal');
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement('div');
    overlay.id = 'histo-modal';
    overlay.className = 'modal-overlay open';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';

    var title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Historique' + (currentUser.nom ? ' de ' + currentUser.nom : '');

    var contenu = document.createElement('div');
    contenu.textContent = "Chargement de l'historique...";

    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(contenu);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close() { overlay.classList.remove('open'); }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });

    try {
        var resp = await fetchAuth('/api/historique');
        var parcours = await resp.json();

        if (!resp.ok) {
            contenu.textContent = (parcours && parcours.erreur) || "Impossible de charger l'historique.";
            return;
        }

        contenu.innerHTML = '';

        if (!Array.isArray(parcours) || parcours.length === 0) {
            var vide = document.createElement('p');
            vide.className = 'histo-empty';
            vide.textContent = "Aucun parcours enregistré dans l'historique";
            contenu.appendChild(vide);
            return;
        }

        var liste = document.createElement('ul');
        liste.className = 'histo-list';
        parcours.forEach(function (p) {
            var li = document.createElement('li');
            li.className = 'histo-item';

            var t = document.createElement('div');
            t.className = 'histo-item-title';
            t.textContent = (p.point_depart || '?') + ' → ' + (p.point_arrivee || '?');
            li.appendChild(t);

            var details = document.createElement('div');
            details.className = 'histo-item-details';
            details.textContent = p.nb_km + ' km';
            li.appendChild(details);

            if (p.date) {
                var dt = new Date(p.date);
                if (!isNaN(dt)) {
                    var dateDiv = document.createElement('div');
                    dateDiv.className = 'histo-item-date';
                    dateDiv.textContent = 'Ajouté le ' + dt.toLocaleDateString('fr-FR') +
                        ' à ' + dt.toLocaleTimeString('fr-FR');
                    li.appendChild(dateDiv);
                }
            }
            liste.appendChild(li);
        });
        contenu.appendChild(liste);
    } catch (err) {
        console.error('Erreur réseau historique :', err);
        contenu.textContent = 'Erreur réseau. Réessayez plus tard.';
    }
}

// ====== Pop-up Profil (infos à jour lues depuis la base) ======
async function openProfilModal() {
    if (!requireLogin()) return;

    var existing = document.getElementById('profil-modal');
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement('div');
    overlay.id = 'profil-modal';
    overlay.className = 'modal-overlay open';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';

    var title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Mon profil';

    var contenu = document.createElement('div');
    contenu.className = 'profil-content';
    contenu.textContent = 'Chargement du profil...';

    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(contenu);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.remove('open');
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });

    // On utilise la route protégée : l'identité est déduite du token.
    try {
        var resp = await fetchAuth('/api/profil');
        var data = await resp.json();

        if (!resp.ok) {
            contenu.textContent = data.erreur || 'Impossible de charger le profil.';
            return;
        }
        var dateTxt = '—';
        if (data.date_inscription) {
            var d = new Date(data.date_inscription);
            if (!isNaN(d)) dateTxt = d.toLocaleDateString('fr-FR');
        }

        var ligneNom = document.createElement('div');
        ligneNom.className = 'profil-ligne';
        ligneNom.innerHTML = '<span class="profil-label">Nom :</span> ';
        ligneNom.appendChild(document.createTextNode(data.nom));

        contenu.innerHTML = '';
        contenu.appendChild(ligneNom);
        contenu.insertAdjacentHTML('beforeend',
            '<div class="profil-ligne"><span class="profil-label">Inscrit le :</span> ' + dateTxt + '</div>' +
            '<div class="profil-ligne"><span class="profil-label">Kilomètres parcourus :</span> ' + data.nb_km_total + ' km</div>' +
            '<div class="profil-ligne"><span class="profil-label">Parcours effectués :</span> ' + data.nb_parcours_pris + '</div>'
        );
    } catch (err) {
        console.error('Erreur réseau profil :', err);
        contenu.textContent = 'Erreur réseau. Réessayer plus tard.';
    }
}

function addLockMap() {
    var locked = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function () {
            var loc = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-lock');
            var btn = L.DomUtil.create('a', '', loc);
            btn.href = '#';
            btn.title = 'Bloquer la carte';
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', 'Bloquer la carte');
            btn.innerHTML = SVG_CADENAS_OUVERT;
            lockBtn = btn;

            L.DomEvent.disableClickPropagation(loc);
            L.DomEvent.disableScrollPropagation(loc);

            L.DomEvent.on(btn, 'click', function (e) {
                L.DomEvent.preventDefault(e);
                lockMap();
            });

            return loc;
        }
    });
    map.addControl(new locked());
}

// Fonction pour bloquer la carte (zoom, mouvement...).
function lockMap() {
    if (!carteBloquee) {
        map.dragging.disable();
        map.touchZoom.disable();
        map.doubleClickZoom.disable();
        map.scrollWheelZoom.disable();
        map.boxZoom.disable();
        map.keyboard.disable();
        if (map.tap) map.tap.disable();
    } else {
        map.dragging.enable();
        map.touchZoom.enable();
        map.doubleClickZoom.enable();
        map.scrollWheelZoom.enable();
        map.boxZoom.enable();
        map.keyboard.enable();
        if (map.tap) map.tap.enable();
    }
    carteBloquee = !carteBloquee;

    var zoomEl = map.zoomControl.getContainer();
    if (zoomEl) {
        zoomEl.classList.toggle('zoom-disabled', carteBloquee);
    }

    if (lockBtn) {
        lockBtn.innerHTML = carteBloquee ? SVG_CADENAS_FERME : SVG_CADENAS_OUVERT;
        lockBtn.title = carteBloquee ? 'Débloquer la carte' : 'Bloquer la carte';
        lockBtn.setAttribute('aria-label', lockBtn.title);
    }
}

// ====== Une fois les données reçues ======
function onNetworkLoaded() {
    networkLayer = L.layerGroup();
    NETWORK.edges.forEach(function (e) {
        var geom = NETWORK.geoms[e[3]];
        var latlngs = geom.map(function (p) { return [p[1], p[0]]; });
        var unpaved = e[4] === 1;
        L.polyline(latlngs, {
            color: unpaved ? COLORS.networkUnpaved : COLORS.networkPaved,
            weight: 2,
            opacity: 1,
            interactive: false,
            dashArray: unpaved ? '3, 4' : null
        }).addTo(networkLayer);
    });
    networkLayer.addTo(map);

    var pnLatLngs = NETWORK.pn.map(function (p) { return [p[0], p[1]]; });
    map.fitBounds(L.latLngBounds(pnLatLngs), { padding: [20, 20] });

    adj = [];
    for (var i = 0; i < NETWORK.nodes.length; i++) adj.push([]);
    NETWORK.edges.forEach(function (e, ei) {
        adj[e[0]].push({ to: e[1], w: e[2], edge: ei });
        adj[e[1]].push({ to: e[0], w: e[2], edge: ei });
    });

    departureLayer = L.layerGroup();
    otherMarkersLayer = L.layerGroup();

    NETWORK.pn.forEach(function (p, i) {
        if (p[3] === 0) return;
        var marker = L.marker([p[0], p[1]], {
            icon: createPointIcon(p[5], p[3]),
            title: p[2] + ' (n°' + p[5] + ')'
        });
        markerIndex.set(marker, i);
        marker.on('click', function () { toggleMarker(marker); });
        if (p[3] === 2) {
            marker.addTo(departureLayer);
        } else {
            marker.addTo(otherMarkersLayer);
        }
    });

    departureLayer.addTo(map);
    updateMarkerVisibility();
}

// ====== Affichage des marqueurs selon le niveau de zoom ======
function updateMarkerVisibility() {
    if (!map || !otherMarkersLayer) return;
    var zoom = map.getZoom();
    if (zoom >= ZOOM_DETAIL_THRESHOLD) {
        if (!map.hasLayer(otherMarkersLayer)) otherMarkersLayer.addTo(map);
    } else {
        if (map.hasLayer(otherMarkersLayer)) map.removeLayer(otherMarkersLayer);
    }
}

// ====== Création des icônes ======
function createPointIcon(label, typecourt) {
    return L.divIcon({
        className: 'pn-marker t-' + typecourt,
        html: '<div>' + label + '</div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
}

// Icone marqueur rouge pour la recherche par adresse.
function createRedPinIcon() {
    return L.divIcon({
        className: 'recherche-pin',
        html: '<svg viewBox="0 0 24 24" width="30" height="30" ' +
            'fill="#e53935" stroke="#7f0000" stroke-width="1">' +
            '<path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/>' +
            '<circle cx="12" cy="9" r="2.5" fill="#fff" stroke="none"/></svg>',
        iconSize: [30, 30],
        iconAnchor: [15, 30]
    });
}

// ====== Sélection / désélection des marqueurs ======
function getWrap(marker) {
    return marker.getElement();
}

function toggleMarker(marker) {
    var wrap = getWrap(marker);
    if (!wrap) return;
    var idx = selectedMarkers.indexOf(marker);
    if (idx !== -1) {
        wrap.classList.remove('selected');
        selectedMarkers.splice(idx, 1);
    } else {
        if (selectedMarkers.length >= MAX_SELECTED) {
            var oldest = selectedMarkers.shift();
            var oel = getWrap(oldest);
            if (oel) oel.classList.remove('selected');
        }
        wrap.classList.add('selected');
        selectedMarkers.push(marker);
    }
    updateResetButtonVisibility();
    updateHistButtonVisibility();
    updateRoute();
}

function resetSelection() {
    selectedMarkers.slice().forEach(function (m) {
        var el = getWrap(m);
        if (el) el.classList.remove('selected');
    });
    selectedMarkers = [];
    updateResetButtonVisibility();
    updateHistButtonVisibility();
    updateRoute();
}

// ====== Compteur "parcours pris" ======
function annulerTimerParcours() {
    if (parcoursTimer !== null) {
        clearTimeout(parcoursTimer);
        parcoursTimer = null;
    }
}

function demarrerTimerParcours(routeData) {
    annulerTimerParcours();
    if (!estConnecte() || !routeData) return; // on ne compte que pour un connecté
    parcoursTimer = setTimeout(function () {
        parcoursTimer = null;
        marquerParcoursPris(routeData);
    }, PARCOURS_DELAI_MS);
}

// Envoie au back que ce parcours est pris (compteur + km). Protégé contre le
// double comptage : un même itinéraire affiché ne sera compté qu'une fois.
function marquerParcoursPris(routeData) {
    if (!estConnecte() || !routeData) return;
    if (dernierParcoursCompte === routeData) return; // déjà compté
    dernierParcoursCompte = routeData;
    annulerTimerParcours();

    fetchAuth('/api/parcours-pris', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ km: parseFloat(routeData.distanceKm) })
    }).catch(function (err) {
        console.error('Erreur réseau parcours-pris :', err);
    });
}

// Affiche un court message dans la barre d'actions de l'itinéraire (à droite
// du bouton historique), puis l'efface après 3 secondes.
function afficherMsgHisto(texte, estErreur) {
    var el = document.getElementById('histo-msg');
    if (!el) return;
    el.textContent = texte;
    el.classList.toggle('histo-msg-erreur', !!estErreur);
    clearTimeout(afficherMsgHisto._t);
    afficherMsgHisto._t = setTimeout(function () {
        el.textContent = '';
        el.classList.remove('histo-msg-erreur');
    }, 3000);
}

// Enregistre l'itinéraire courant dans l'historique (en base). En cas de
// succès, le parcours est compté comme "pris".
function histo() {
    if (!requireLogin()) return;

    if (!currentRouteData) {
        afficherMsgHisto("Sélectionnez deux points d'abord.", true);
        return;
    }

    var d = currentRouteData;

    fetchAuth('/api/historique', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            nb_km: parseFloat(d.distanceKm),
            point_depart: d.start,
            point_arrivee: d.end
        })
    })
    .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
    })
    .then(function () {
        marquerParcoursPris(d);                 // ajout à l'historique = parcours pris
        afficherMsgHisto('Parcours ajouté ✓', false);
    })
    .catch(function (err) {
        console.error('Erreur réseau historique :', err);
        afficherMsgHisto("Échec de l'ajout, réessayez.", true);
    });
}

function updateResetButtonVisibility() {
    var btn = document.getElementById('reset-btn');
    if (!btn) return;
    if (selectedMarkers.length > 0) btn.removeAttribute('hidden');
    else btn.setAttribute('hidden', '');
}

function updateHistButtonVisibility() {
    var btn = document.getElementById('histo-btn');
    if (!btn) return;
    if (selectedMarkers.length > 0) btn.removeAttribute('hidden');
    else btn.setAttribute('hidden', '');
}

// Le bouton de téléchargement n'apparaît que lorsqu'un itinéraire valide
// a été calculé (deux points sélectionnés + chemin trouvé).
function updateTeleButtonVisibility() {
    var btn = document.getElementById('tele-btn');
    if (!btn) return;
    if (currentRouteData) btn.removeAttribute('hidden');
    else btn.setAttribute('hidden', '');
}

// ====== Affichage du panneau itinéraire selon la sélection ======
// Le panneau n'apparaît que lorsque deux points sont sélectionnés.
function updateRoutePanelVisibility() {
    var panel = document.getElementById('route-panel');
    if (!panel) return;
    if (selectedMarkers.length >= 2) {
        panel.classList.add('visible');
    } else {
        panel.classList.remove('visible');
    }
}

// ====== Min-heap binaire pour Dijkstra ======
function MinHeap() { this.h = []; }
MinHeap.prototype.push = function (item) {
    this.h.push(item);
    var i = this.h.length - 1;
    while (i > 0) {
        var p = (i - 1) >> 1;
        if (this.h[p][0] <= this.h[i][0]) break;
        var t = this.h[p]; this.h[p] = this.h[i]; this.h[i] = t;
        i = p;
    }
};
MinHeap.prototype.pop = function () {
    if (this.h.length === 0) return null;
    var top = this.h[0];
    var last = this.h.pop();
    if (this.h.length > 0) {
        this.h[0] = last;
        var i = 0, n = this.h.length;
        while (true) {
            var l = 2 * i + 1, r = 2 * i + 2, s = i;
            if (l < n && this.h[l][0] < this.h[s][0]) s = l;
            if (r < n && this.h[r][0] < this.h[s][0]) s = r;
            if (s === i) break;
            var t = this.h[i]; this.h[i] = this.h[s]; this.h[s] = t;
            i = s;
        }
    }
    return top;
};
MinHeap.prototype.size = function () { return this.h.length; };

// ====== Dijkstra ======
function dijkstra(startNode, endNode) {
    var n = NETWORK.nodes.length;
    var dist = new Float64Array(n);
    var prev = new Int32Array(n);
    var prevEdge = new Int32Array(n);
    for (var i = 0; i < n; i++) {
        dist[i] = Infinity;
        prev[i] = -1;
        prevEdge[i] = -1;
    }
    dist[startNode] = 0;

    var heap = new MinHeap();
    heap.push([0, startNode]);

    while (heap.size() > 0) {
        var top = heap.pop();
        var d = top[0], u = top[1];
        if (u === endNode) break;
        if (d > dist[u]) continue;
        var neighbors = adj[u];
        for (var k = 0; k < neighbors.length; k++) {
            var nb = neighbors[k];
            var nd = d + nb.w;
            if (nd < dist[nb.to]) {
                dist[nb.to] = nd;
                prev[nb.to] = u;
                prevEdge[nb.to] = nb.edge;
                heap.push([nd, nb.to]);
            }
        }
    }

    if (dist[endNode] === Infinity) return null;

    var pathNodes = [];
    var pathEdges = [];
    var cur = endNode;
    while (cur !== -1) {
        pathNodes.push(cur);
        if (prevEdge[cur] !== -1) pathEdges.push(prevEdge[cur]);
        cur = prev[cur];
    }
    pathNodes.reverse();
    pathEdges.reverse();
    return { nodes: pathNodes, edges: pathEdges, distance: dist[endNode] };
}

// ====== Construction de la géométrie d'un itinéraire ======
function buildRouteGeometry(pathNodes, pathEdges) {
    var runs = [];
    var current = null;
    var unpavedMeters = 0;

    for (var i = 0; i < pathEdges.length; i++) {
        var ei = pathEdges[i];
        var e = NETWORK.edges[ei];
        var fromNode = pathNodes[i];
        var geom = NETWORK.geoms[e[3]];
        var forward = (e[0] === fromNode);
        var unpaved = e[4] === 1;
        if (unpaved) unpavedMeters += e[2];

        var segCoords = [];
        if (forward) {
            for (var j = 0; j < geom.length; j++) {
                segCoords.push([geom[j][1], geom[j][0]]);
            }
        } else {
            for (var j = geom.length - 1; j >= 0; j--) {
                segCoords.push([geom[j][1], geom[j][0]]);
            }
        }

        if (current && current.unpaved === unpaved) {
            for (var k = 1; k < segCoords.length; k++) {
                current.coords.push(segCoords[k]);
            }
        } else {
            if (current && current.coords.length > 0) {
                current = { unpaved: unpaved, coords: [current.coords[current.coords.length - 1]] };
                for (var k = 1; k < segCoords.length; k++) {
                    current.coords.push(segCoords[k]);
                }
            } else {
                current = { unpaved: unpaved, coords: segCoords.slice() };
            }
            runs.push(current);
        }
    }

    return { runs: runs, unpavedMeters: unpavedMeters };
}

// ====== Mise à jour de l'itinéraire affiché ======
function updateRoute() {
    updateRoutePanelVisibility();

    // À chaque recalcul, on repart d'un état sans itinéraire : le bouton PDF
    // est masqué tant qu'un trajet valide n'a pas été déterminé ci-dessous.
    currentRouteData = null;
    updateTeleButtonVisibility();
    annulerTimerParcours();        // tout changement annule le minuteur "parcours pris"

    if (routeLayer) {
        map.removeLayer(routeLayer);
        routeLayer = null;
    }
    if (selectedMarkers.length < 2) {
        infoDiv.innerHTML =
            '<span class="placeholder">Sélectionnez deux points sur la carte pour voir l\'itinéraire.</span>';
        return;
    }

    var iA = markerIndex.get(selectedMarkers[0]);
    var iB = markerIndex.get(selectedMarkers[1]);
    var pA = NETWORK.pn[iA];
    var pB = NETWORK.pn[iB];

    if (pA[4] < 0 || pB[4] < 0) {
        infoDiv.innerHTML =
            '<span class="placeholder">Un des points sélectionnés n\'est pas rattaché au réseau.</span>';
        return;
    }

    var t0 = performance.now();
    var result = dijkstra(pA[4], pB[4]);
    var t1 = performance.now();

    if (!result) {
        infoDiv.innerHTML =
            '<span class="placeholder">Aucun chemin trouvé entre ' + pA[5] + ' et ' + pB[5] + '.</span>';
        return;
    }

    var coords = buildRouteGeometry(result.nodes, result.edges);

    routeLayer = L.layerGroup();
    coords.runs.forEach(function (run) {
        L.polyline(run.coords, {
            color: run.unpaved ? COLORS.routeUnpaved : COLORS.routePaved,
            weight: 5,
            opacity: 0.9,
            dashArray: run.unpaved ? '8, 8' : null
        }).addTo(routeLayer);
    });
    routeLayer.addTo(map);

    // Points pn traversés dans l'ordre du chemin
    var pnByNode = new Map();
    NETWORK.pn.forEach(function (p, i) {
        if (i !== iA && i !== iB) {
            pnByNode.set(p[4], p);
        }
    });

    var traversedPn = [];      // labels seuls (utilisés par l'affichage et le PDF)
    var traversedPnPts = [];   // label + coordonnées (utilisés par l'export KML)
    result.nodes.forEach(function (nodeIdx) {
        if (nodeIdx === pA[4] || nodeIdx === pB[4]) return;
        if (pnByNode.has(nodeIdx)) {
            var p = pnByNode.get(nodeIdx);
            traversedPn.push(p[5]);
            traversedPnPts.push({ label: p[5], lat: p[0], lng: p[1] });
        }
    });

    var distanceKm = (result.distance / 1000).toFixed(2);
    var unpavedKm = (coords.unpavedMeters / 1000).toFixed(2);
    var unpavedPct = result.distance > 0
        ? Math.round((coords.unpavedMeters / result.distance) * 100)
        : 0;

    var pathHtml = pA[5] +
        ' → ' +
        (traversedPn.length > 0 ? traversedPn.join(' → ') + ' → ' : '') +
        pB[5];

    var detour = traversedPn.length > 0
        ? 'Passage par ' + traversedPn.length + ' point(s) du réseau.'
        : 'Trajet direct sur le réseau, sans point intermédiaire.';

    var unpavedHtml = coords.unpavedMeters > 0
        ? '<div class="stats">dont ' + unpavedKm + ' km non revêtus (' + unpavedPct + '%)</div>'
        : '';

    infoDiv.innerHTML =
        '<div class="path">' + pathHtml + '</div>' +
        '<div class="stats">' + detour + '</div>' +
        '<div class="stats">Distance parcours : ' + distanceKm + ' km</div>' +
        unpavedHtml;

    // On mémorise les données affichées pour permettre l'export PDF/KML, puis
    // on rend le bouton de téléchargement visible.
    currentRouteData = {
        start: pA[5],
        end: pB[5],
        via: traversedPn.slice(),
        nbVia: traversedPn.length,
        distanceKm: distanceKm,
        unpavedKm: coords.unpavedMeters > 0 ? unpavedKm : null,
        unpavedPct: unpavedPct,
        runs: coords.runs,            // géométrie (segments revêtus / non revêtus), pour l'export KML
        viaPoints: traversedPnPts,    // points intermédiaires avec coordonnées, pour l'export KML
        startLatLng: [pA[0], pA[1]],  // coordonnées des extrémités, pour l'export KML
        endLatLng: [pB[0], pB[1]]
    };
    updateTeleButtonVisibility();
    demarrerTimerParcours(currentRouteData);   // nouvel itinéraire valide -> minuteur "parcours pris"
}

// ====== Export PDF de l'itinéraire courant ======
function telechargerPDF() {
    if (!currentRouteData) return;
    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert('La librairie PDF n\'a pas pu être chargée.');
        return;
    }

    var d = currentRouteData;
    var doc = new window.jspdf.jsPDF();

    // On évite la flèche « → », absente des polices PDF standard, au profit de « -> ».
    var parts = [d.start].concat(d.via);
    parts.push(d.end);
    var cheminTxt = parts.join(' -> ');

    doc.setFontSize(16);
    doc.text("Détail de l'itinéraire", 14, 20);

    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text('Carte Réseau Baie de Somme', 14, 27);
    doc.setTextColor(0);

    doc.setFontSize(12);
    var y = 42;

    // Le parcours peut être long : on le découpe automatiquement sur plusieurs lignes.
    var lignes = doc.splitTextToSize('Parcours : ' + cheminTxt, 180);
    doc.text(lignes, 14, y);
    y += lignes.length * 7 + 4;

    var detour = d.nbVia > 0
        ? 'Passage par ' + d.nbVia + ' point(s) du réseau.'
        : 'Trajet direct sur le réseau, sans point intermédiaire.';
    doc.text(detour, 14, y); y += 9;

    doc.text('Distance parcourue : ' + d.distanceKm + ' km', 14, y); y += 9;

    if (d.unpavedKm) {
        doc.text('dont ' + d.unpavedKm + ' km non revêtus (' + d.unpavedPct + '%)', 14, y);
        y += 9;
    }

    // Pied de page horodaté
    doc.setFontSize(9);
    doc.setTextColor(120);
    var now = new Date();
    doc.text('Généré le ' + now.toLocaleDateString('fr-FR') + ' à ' + now.toLocaleTimeString('fr-FR'), 14, 285);

    doc.save('itineraire_' + d.start + '-' + d.end + '.pdf');
}

// ====== Export KML de l'itinéraire courant ======
function telechargerKML() {
    if (!currentRouteData) return;
    var d = currentRouteData;

    // Échappe les caractères spéciaux XML.
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Un "run" -> chaîne "lng,lat,alt lng,lat,alt ..."
    // ATTENTION : KML attend l'ordre longitude,latitude (inverse de Leaflet,
    // qui stocke les coordonnées en [lat, lng]).
    function runToCoords(run) {
        return run.coords.map(function (c) { return c[1] + ',' + c[0] + ',0'; }).join(' ');
    }

    var parts = [d.start].concat(d.via);
    parts.push(d.end);
    var titre = 'Itinéraire ' + d.start + ' -> ' + d.end;
    var desc = 'Parcours : ' + parts.join(' -> ') +
        ' | Distance : ' + d.distanceKm + ' km' +
        (d.unpavedKm ? ' (dont ' + d.unpavedKm + ' km non revêtus, ' + d.unpavedPct + '%)' : '');

    var xml = '';
    xml += '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
    xml += '  <Document>\n';
    xml += '    <name>' + esc(titre) + '</name>\n';
    xml += '    <description>' + esc(desc) + '</description>\n';
    // Couleurs KML au format aabbggrr (alpha, bleu, vert, rouge).
    // paved   : reprend le vert/jaune de l'itinéraire (#cde20e -> ff0ee2cd).
    // unpaved : rouge pour bien distinguer les portions non revêtues.
    xml += '    <Style id="paved"><LineStyle><color>ff0ee2cd</color><width>4</width></LineStyle></Style>\n';
    xml += '    <Style id="unpaved"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle></Style>\n';

    // Un Placemark (ligne) par segment, en distinguant revêtu / non revêtu.
    d.runs.forEach(function (run, i) {
        if (!run.coords || run.coords.length < 2) return;
        xml += '    <Placemark>\n';
        xml += '      <name>' + (run.unpaved ? 'Segment non revêtu' : 'Segment revêtu') + ' ' + (i + 1) + '</name>\n';
        xml += '      <styleUrl>#' + (run.unpaved ? 'unpaved' : 'paved') + '</styleUrl>\n';
        xml += '      <LineString><tessellate>1</tessellate>\n';
        xml += '        <coordinates>' + runToCoords(run) + '</coordinates>\n';
        xml += '      </LineString>\n';
        xml += '    </Placemark>\n';
    });

    // Marqueurs de départ, points intermédiaires et arrivée.
    if (d.startLatLng) {
        xml += '    <Placemark><name>' + esc('Départ : ' + d.start) +
            '</name><Point><coordinates>' + d.startLatLng[1] + ',' + d.startLatLng[0] +
            ',0</coordinates></Point></Placemark>\n';
    }
    if (d.viaPoints) {
        d.viaPoints.forEach(function (pt) {
            xml += '    <Placemark><name>' + esc(pt.label) +
                '</name><Point><coordinates>' + pt.lng + ',' + pt.lat +
                ',0</coordinates></Point></Placemark>\n';
        });
    }
    if (d.endLatLng) {
        xml += '    <Placemark><name>' + esc('Arrivée : ' + d.end) +
            '</name><Point><coordinates>' + d.endLatLng[1] + ',' + d.endLatLng[0] +
            ',0</coordinates></Point></Placemark>\n';
    }

    xml += '  </Document>\n</kml>\n';

    // Téléchargement via un Blob (pas besoin de librairie externe, contrairement au PDF).
    var blob = new Blob([xml], { type: 'application/vnd.google-earth.kml+xml' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'itineraire_' + d.start + '-' + d.end + '.kml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ====== Démarrage ======
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}