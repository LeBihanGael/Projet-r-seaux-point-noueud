require('dotenv').config();

const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();

const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 12;
const TOKEN_EXPIRATION = '1h';   // durée de vie des tokens (identique connexion/inscription)

// Garde-fou : sans secret, les tokens ne valent rien -> on refuse de démarrer.
if (!JWT_SECRET) {
    console.error('JWT_SECRET manquant dans le .env. Arrêt du serveur.');
    process.exit(1);
}

// Limite la taille du JSON entrant (évite les payloads abusifs).
app.use(express.json({ limit: '10kb' }));

app.use(express.static(path.join(__dirname, 'public')));

// Pool de connexions : plus robuste qu'une connexion unique (reconnexion auto,
// requêtes concurrentes). L'API db.query reste identique.
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Petit test de connexion au démarrage (facultatif mais pratique).
db.getConnection((err, conn) => {
    if (err) {
        console.error('Erreur de connexion à la BDD :', err.message);
        return;
    }
    console.log('Connecté à la BDD');
    conn.release();
});

// ====== Validations ======
// L'email doit contenir au moins un '@' et un '.'.
function emailValide(mail) {
    return typeof mail === 'string' && mail.includes('@') && mail.includes('.');
}

// Le mot de passe doit faire au moins 10 caractères et contenir au moins une
// majuscule, un chiffre et un caractère spécial (tout ce qui n'est ni lettre
// ni chiffre).
function motDePasseValide(mdp) {
    return typeof mdp === 'string'
        && mdp.length >= 10
        && /[A-Z]/.test(mdp)
        && /[0-9]/.test(mdp)
        && /[^A-Za-z0-9]/.test(mdp);
}

// Normalise un mail : sans espaces superflus et en minuscules, pour éviter les
// doublons du type "Jean@X.com" vs "jean@x.com".
function normaliserMail(mail) {
    return String(mail).trim().toLowerCase();
}

// Middleware d'authentification
// Vérifie le token "Authorization: Bearer <token>". Si valide, place les infos
// dans req.user et laisse passer. Sinon 401.
function authentifier(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ erreur: 'Authentification requise.' });

    jwt.verify(token, JWT_SECRET, (err, payload) => {
        if (err) return res.status(401).json({ erreur: 'Session invalide ou expirée.' });
        req.user = payload;   // { id, mail, nom } posés à la connexion
        next();
    });
}

// Connexion
app.post('/api/connexion', (req, res) => {
    let { mail, motDePasse } = req.body;
    if (!mail || !motDePasse) return res.status(400).json({ erreur: 'Mail et mot de passe requis.' });
    if (!emailValide(mail)) return res.status(400).json({ erreur: "L'Email n'est pas valide." });

    mail = normaliserMail(mail);

    const sql = 'SELECT id, mail, nom, mot_de_passe FROM `user` WHERE mail = ?';
    db.query(sql, [mail], (err, results) => {
        if (err) {
            console.error('Erreur SQL (connexion) :', err.message);
            return res.status(500).json({ erreur: 'Erreur serveur.' });
        }
        if (results.length === 0) return res.status(401).json({ erreur: 'Mail ou mot de passe incorrect.' });

        const u = results[0];
        bcrypt.compare(motDePasse, u.mot_de_passe, (errCmp, correspond) => {
            if (errCmp) {
                console.error('Erreur bcrypt (connexion) :', errCmp.message);
                return res.status(500).json({ erreur: 'Erreur serveur.' });
            }
            if (!correspond) return res.status(401).json({ erreur: 'Mail ou mot de passe incorrect.' });

            const token = jwt.sign(
                { id: u.id, mail: u.mail, nom: u.nom },
                JWT_SECRET,
                { expiresIn: TOKEN_EXPIRATION }
            );
            res.json({ token, id: u.id, mail: u.mail, nom: u.nom });
        });
    });
});

// Inscription
app.post('/api/inscription', (req, res) => {
    let { mail, motDePasse, nom } = req.body;
    if (!mail || !motDePasse || !nom) return res.status(400).json({ erreur: 'Nom, mail et mot de passe requis.' });
    if (!emailValide(mail)) return res.status(400).json({ erreur: "L'Email n'est pas valide. Veuillez réessayer." });
    if (!motDePasseValide(motDePasse)) {
        return res.status(400).json({ erreur: 'Le mot de passe doit faire au moins 10 caractères et contenir au moins une majuscule, un chiffre et un caractère spécial.' });
    }

    mail = normaliserMail(mail);
    nom = String(nom).trim();

    // Validation de longueur (les colonnes sont en VARCHAR(50)).
    if (nom.length === 0 || nom.length > 50) {
        return res.status(400).json({ erreur: 'Le nom doit faire entre 1 et 50 caractères.' });
    }
    if (mail.length > 50) {
        return res.status(400).json({ erreur: "L'email est trop long (50 caractères max)." });
    }

    bcrypt.hash(motDePasse, SALT_ROUNDS, (errHash, hash) => {
        if (errHash) {
            console.error('Erreur bcrypt (inscription) :', errHash.message);
            return res.status(500).json({ erreur: 'Erreur serveur.' });
        }

        const sql = 'INSERT INTO `user` (nom, mail, mot_de_passe) VALUES (?, ?, ?)';
        db.query(sql, [nom, mail, hash], (err, result) => {
            if (err) {
                // La contrainte UNIQUE sur le mail ferme la faille de la "course"
                // entre le SELECT et l'INSERT : on traite le doublon ici.
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ erreur: 'Cet email est déjà utilisé.' });
                }
                console.error('Erreur SQL (inscription) :', err.message);
                return res.status(500).json({ erreur: 'Erreur serveur.' });
            }
            const token = jwt.sign(
                { id: result.insertId, mail: mail, nom: nom },
                JWT_SECRET,
                { expiresIn: TOKEN_EXPIRATION }
            );
            res.json({ token, id: result.insertId, mail: mail, nom: nom });
        });
    });
});

// Profil User
app.get('/api/profil', authentifier, (req, res) => {
    const sql = 'SELECT id, nom, nb_km_total, nb_parcours_pris, date_inscription FROM `user` WHERE id = ?';
    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error('Erreur SQL (profil) :', err.message);
            return res.status(500).json({ erreur: 'Erreur serveur.' });
        }
        if (results.length === 0) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });
        const u = results[0];
        res.json({
            id: u.id, nom: u.nom,
            nb_km_total: u.nb_km_total,
            nb_parcours_pris: u.nb_parcours_pris,
            date_inscription: u.date_inscription
        });
    });
});

// Stats pour les parcours
app.post('/api/parcours-pris', authentifier, (req, res) => {
    const kmNum = Math.max(0, Math.round(Number(req.body.km) || 0));
    const sql = 'UPDATE `user` SET nb_km_total = nb_km_total + ?, nb_parcours_pris = nb_parcours_pris + 1 WHERE id = ?';
    db.query(sql, [kmNum, req.user.id], (err, result) => {
        if (err) {
            console.error('Erreur SQL (parcours-pris) :', err.message);
            return res.status(500).json({ erreur: 'Erreur serveur.' });
        }
        if (result.affectedRows === 0) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });
        res.json({ ok: true });
    });
});

// Insertion dans la BDD
app.post('/api/historique', authentifier, (req, res) => {
    const kmNum = Math.max(0, Math.round(Number(req.body.nb_km) || 0));
    const depart = String(req.body.point_depart || '').slice(0, 50);
    const arrivee = String(req.body.point_arrivee || '').slice(0, 50);
    const sql = 'INSERT INTO `historique` (nb_Km, point_depart, point_arrivee, id_user) VALUES (?, ?, ?, ?)';
    db.query(sql, [kmNum, depart, arrivee, req.user.id], (err, result) => {
        if (err) {
            console.error('Erreur SQL (historique insert) :', err.message);
            return res.status(500).json({ erreur: 'Erreur serveur.' });
        }
        res.json({ id: result.insertId, ok: true });
    });
});

// Récuperation dans la BDD
app.get('/api/historique', authentifier, (req, res) => {
    const sql = 'SELECT id, nb_Km AS nb_km, point_depart, point_arrivee, date FROM `historique` WHERE id_user = ? ORDER BY date DESC';
    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error('Erreur SQL (historique select) :', err.message);
            return res.status(500).json({ erreur: 'Erreur serveur.' });
        }
        res.json(results);
    });
});

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 4000;
app.listen(PORT, HOST, () => {
    console.log(`Serveur prêt sur http://debdevwebt.somme.local:${PORT}/`);
});