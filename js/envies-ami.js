// ===== Page d'un ami : onglet « Envies » (voir ses envies, en réserver une pour lui offrir) =====
// Partage la session de partage.js (un seul client sur la page). La base décide de tout : un non-ami ne reçoit rien,
// et la personne concernée ne voit jamais les réservations. Tout est affiché avec textContent.
(function () {
    const $ = (id) => document.getElementById(id);
    const client = globalThis.clientAmi;
    if (!client || document.body.dataset.mode !== "ami") return;

    const UUID_VALIDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const PSEUDO_VALIDE = /^[a-z0-9_]{3,20}$/;
    const CANAL_VALIDE = /^[a-f0-9]{64}$/;
    const CATEGORIES = ["Manga", "BD", "Comics", "Série", "Livre", "Roman graphique", "Light novel", "Artbook"];
    const RESERVATIONS = ["aucun", "moi", "autre"];
    const LIMITES = { titre: 120, auteur: 80, note: 200, envies: 100 };
    const DELAI_SECOURS = 60000;      // direct actif : simple filet de sécurité
    const DELAI_SANS_DIRECT = 10000;  // direct indisponible : on vérifie plus souvent
    const DELAI_ERREUR = 30000;
    const DELAI_GROUPAGE = 150;
    const INTERVALLE_MIN = 1000;

    // Seuls ces messages de la base sont affichés tels quels ; tout le reste donne un message générique
    const MESSAGES_CONNUS = new Set([
        "Déjà réservé",
        "Envie introuvable",
        "Introuvable",
        "Réservation introuvable",
        "Trop de réservations (100 maximum)"
    ]);

    const texteSur = (valeur, max) => String(valeur ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

    let generation = 0;          // change à chaque nouvelle adresse : les anciennes réponses sont ignorées
    let pseudo = "";
    let ongletInitial = "biblio";
    let onglet = "biblio";
    let envies = null;
    let derniereEmpreinte = null;
    let minuteur = null;
    let minuteurSignal = null;
    let enVerification = false;
    let dernierDebut = 0;
    let occupe = false;
    let canal = null;
    let sujetCanal = "";
    let direct = false;

    const erreur = (texte) => { $("e-erreur").textContent = texte || ""; };
    const info = (texte) => { $("e-info").textContent = texte || ""; };

    // ----- Adresse : « #pseudo » ou « #pseudo/envies » -----
    function lireAdresse() {
        const m = /^#([a-z0-9_]{3,20})(?:\/(envies))?$/.exec(location.hash.toLowerCase());
        return m ? { pseudo: m[1], onglet: m[2] ? "envies" : "biblio" } : null;
    }

    // ----- Onglets -----
    function montrerOnglet(nom, memoriser) {
        onglet = nom === "envies" ? "envies" : "biblio";
        $("v-biblio").hidden = onglet !== "biblio";
        $("v-envies").hidden = onglet !== "envies";
        $("onglet-biblio").classList.toggle("actif", onglet === "biblio");
        $("onglet-envies").classList.toggle("actif", onglet === "envies");
        $("onglet-biblio").setAttribute("aria-pressed", String(onglet === "biblio"));
        $("onglet-envies").setAttribute("aria-pressed", String(onglet === "envies"));
        if (memoriser && pseudo) {
            // l'adresse suit l'onglet (sans recharger la bibliothèque)
            try { history.replaceState(null, "", "#" + pseudo + (onglet === "envies" ? "/envies" : "")); } catch (e) { /* sans importance */ }
        }
    }

    // Plus d'accès (ou rien à montrer) : on n'affiche rien, même caché
    function toutCacher() {
        envies = null;
        $("v-onglets").hidden = true;
        $("e-liste").replaceChildren();
        $("e-direct").hidden = true;
        erreur("");
        info("");
        montrerOnglet("biblio", false);
    }

    // ----- Nettoyage de ce qui arrive du réseau -----
    function normaliser(brut) {
        if (!brut || typeof brut !== "object") return null;
        const liste = [];
        for (const e of Array.isArray(brut.envies) ? brut.envies : []) {
            if (!e || typeof e !== "object" || !UUID_VALIDE.test(String(e.id))) continue;
            const titre = texteSur(e.titre, LIMITES.titre);
            if (!titre) continue;
            liste.push({
                id: String(e.id).toLowerCase(),
                titre,
                type: CATEGORIES.includes(e.type) ? e.type : "Livre",
                auteur: texteSur(e.auteur, LIMITES.auteur),
                note: texteSur(e.note, LIMITES.note),
                reserve: RESERVATIONS.includes(e.reserve) ? e.reserve : "autre" // dans le doute, on ne propose pas de réserver
            });
            if (liste.length >= LIMITES.envies) break;
        }
        return { envies: liste, canal: CANAL_VALIDE.test(String(brut.canal)) ? String(brut.canal) : "" };
    }

    function messageDe(e) {
        const texte = e && typeof e.message === "string" ? e.message : "";
        if (e && e.code === "P0001" && MESSAGES_CONNUS.has(texte)) return texte;
        return "Action impossible pour l'instant. Vérifie ta connexion et réessaie.";
    }

    // ----- Affichage -----
    function afficher() {
        const liste = $("e-liste");
        liste.replaceChildren();
        const zoneDirect = $("e-direct");
        zoneDirect.hidden = !envies;
        zoneDirect.textContent = direct ? "● En direct" : "Mise à jour automatique toutes les 10 s";
        zoneDirect.classList.toggle("direct", direct);
        if (!envies) return;
        if (!envies.length) {
            const vide = document.createElement("li");
            vide.className = "ami-vide";
            vide.textContent = "Aucune envie pour l'instant.";
            liste.append(vide);
            return;
        }
        envies.forEach((e) => {
            const li = document.createElement("li");
            li.className = "envie-ligne";
            const texte = document.createElement("div");
            const titre = document.createElement("strong");
            titre.textContent = e.titre;
            const detail = document.createElement("p");
            detail.className = "legende";
            detail.textContent = e.type + (e.auteur ? " · " + e.auteur : "") + (e.note ? " · " + e.note : "");
            texte.append(titre, detail);
            li.append(texte);

            const action = document.createElement("span");
            action.className = "ami-actions";
            if (e.reserve === "aucun") {
                action.append(creerBouton("Je le réserve", () => agir(
                    () => rpc("ami_reserver", { p_pseudo: pseudo, p_envie: e.id }),
                    `« ${e.titre} » est réservé pour toi. La personne ne le verra pas.`
                )));
            } else if (e.reserve === "moi") {
                const statut = document.createElement("span");
                statut.className = "envie-statut moi";
                statut.textContent = "Réservé par toi";
                action.append(statut, creerBouton("Annuler ma réservation", () => agir(
                    () => rpc("ami_liberer", { p_pseudo: pseudo, p_envie: e.id }),
                    "Réservation annulée."
                )));
            } else {
                const statut = document.createElement("span");
                statut.className = "envie-statut";
                statut.textContent = "Déjà réservé";
                action.append(statut);
            }
            li.append(action);
            liste.append(li);
        });
    }

    function creerBouton(texte, action) {
        const bouton = document.createElement("button");
        bouton.type = "button";
        bouton.textContent = texte;
        bouton.addEventListener("click", action);
        return bouton;
    }

    // ----- Appels à la base -----
    async function rpc(nom, args) {
        const { data, error } = await client.rpc(nom, args);
        if (error) throw error;
        return data;
    }

    // undefined = indisponible pour l'instant ; null = pas (ou plus) d'accès
    async function lireEmpreinte(cible) {
        try {
            const { data, error } = await client.rpc("ami_envies_empreinte", { p_pseudo: cible });
            if (error) return undefined;
            return typeof data === "string" ? data : null;
        } catch (e) {
            return undefined;
        }
    }

    async function avoirSession() {
        try {
            const { data } = await client.auth.getSession();
            return Boolean(data && data.session);
        } catch (e) {
            return false;
        }
    }

    async function agir(tache, succes) {
        if (occupe) return;
        occupe = true;
        erreur("");
        info("");
        const g = generation;
        try {
            await tache();
            if (g === generation && succes) info(succes);
        } catch (e) {
            if (g === generation) erreur(messageDe(e));
        } finally {
            occupe = false;
        }
        if (g === generation) verifier(g);
    }

    // ----- Direct : un signal sans donnée, puis une vérification légère -----
    function planifier(g, delai) {
        clearTimeout(minuteur);
        minuteur = setTimeout(() => verifier(g), delai || (direct ? DELAI_SECOURS : DELAI_SANS_DIRECT));
    }

    function demanderVerification(g) {
        clearTimeout(minuteurSignal);
        const attente = Math.max(DELAI_GROUPAGE, INTERVALLE_MIN - (Date.now() - dernierDebut));
        minuteurSignal = setTimeout(() => verifier(g), attente);
    }

    function fermerDirect() {
        clearTimeout(minuteurSignal);
        direct = false;
        sujetCanal = "";
        if (canal) {
            const ancien = canal;
            canal = null;
            try { Promise.resolve(client.removeChannel(ancien)).catch(() => {}); } catch (e) { /* déjà fermé */ }
        }
    }

    function ouvrirDirect(g, sujet) {
        fermerDirect();
        sujetCanal = sujet;
        try {
            canal = client.channel(sujet)
                .on("broadcast", { event: "maj" }, () => { if (g === generation) demanderVerification(g); })
                .subscribe((statut) => {
                    if (g !== generation || sujet !== sujetCanal) return;
                    const marche = statut === "SUBSCRIBED";
                    if (marche === direct) return;
                    direct = marche;
                    afficher();
                    if (marche) demanderVerification(g); // rattrape ce qui a pu arriver avant la connexion
                    planifier(g);
                });
        } catch (e) {
            direct = false; // pas de direct : la vérification régulière prend le relais
        }
    }

    // Le canal secret est renouvelé quand une amitié se termine : il arrive avec le contenu
    function assurerDirect(g, canalRecu) {
        if (!canalRecu) { fermerDirect(); return; }
        const sujet = `envies:${canalRecu}`;
        if (sujet !== sujetCanal) ouvrirDirect(g, sujet);
    }

    function appliquer(reponse) {
        envies = reponse.envies;
        $("v-onglets").hidden = false;
        afficher();
    }

    async function verifier(g) {
        if (g !== generation || document.hidden) return; // en veille : reprise au retour sur l'onglet
        if (enVerification) { planifier(g, 1000); return; }
        enVerification = true;
        dernierDebut = Date.now();
        try {
            const empreinte = await lireEmpreinte(pseudo);
            if (g !== generation) return;
            if (empreinte === undefined) {
                if (!(await avoirSession())) { if (g === generation) { derniereEmpreinte = null; toutCacher(); } }
                planifier(g, DELAI_ERREUR);
                return;
            }
            if (empreinte === derniereEmpreinte) { planifier(g); return; }
            if (empreinte === null) { // l'amitié a pris fin
                derniereEmpreinte = null;
                toutCacher();
                planifier(g, DELAI_ERREUR); // si l'accès revient, l'onglet réapparaît tout seul
                return;
            }
            let brut;
            try {
                brut = await rpc("ami_envies", { p_pseudo: pseudo });
            } catch (e) {
                if (g === generation) planifier(g, DELAI_ERREUR);
                return;
            }
            if (g !== generation) return;
            const reponse = normaliser(brut);
            if (!reponse) { planifier(g, DELAI_ERREUR); return; }
            derniereEmpreinte = empreinte;
            const premiere = $("v-onglets").hidden;
            appliquer(reponse);
            if (premiere) montrerOnglet(ongletInitial, false);
            assurerDirect(g, reponse.canal);
            planifier(g);
        } finally {
            enVerification = false;
        }
    }

    async function charger() {
        const g = ++generation;
        clearTimeout(minuteur);
        fermerDirect();
        derniereEmpreinte = null;
        pseudo = "";
        toutCacher();
        const adresse = lireAdresse();
        if (!adresse) return;
        if (!(await avoirSession())) return;
        if (g !== generation) return;
        pseudo = adresse.pseudo;
        ongletInitial = adresse.onglet;

        const empreinte = await lireEmpreinte(pseudo);
        let brut;
        try {
            brut = await rpc("ami_envies", { p_pseudo: pseudo });
        } catch (e) {
            return; // la page principale explique déjà que le chargement a échoué
        }
        if (g !== generation) return;
        const reponse = normaliser(brut);
        if (!reponse) return; // pas (ou plus) d'accès : rien à montrer ici
        derniereEmpreinte = typeof empreinte === "string" ? empreinte : null;
        appliquer(reponse);
        montrerOnglet(ongletInitial, false);
        assurerDirect(g, reponse.canal);
        planifier(g);
    }

    $("onglet-biblio").addEventListener("click", () => montrerOnglet("biblio", true));
    $("onglet-envies").addEventListener("click", () => montrerOnglet("envies", true));
    window.addEventListener("pagehide", fermerDirect);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && pseudo) verifier(generation);
    });
    window.addEventListener("hashchange", charger);
    // déconnexion depuis un autre onglet : on n'affiche plus rien
    client.auth.onAuthStateChange((evenement) => {
        if (evenement === "SIGNED_OUT") setTimeout(charger, 0);
    });
    charger();
})();
