// ===== Page visiteur : bibliothèque partagée par lien (lecture seule, sans compte) =====
// Le jeton est lu dans la partie « # » de l'adresse (elle n'est jamais envoyée au serveur du site).
// Tout ce qui arrive du réseau est reconstruit champ par champ avant affichage, et affiché avec textContent.
(function () {
    const $ = (id) => document.getElementById(id);

    const JETON_VALIDE = /^[a-f0-9]{64}$/;
    const UUID_VALIDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ID_VALIDE = /^[\w-]{1,64}$/;
    const PSEUDO_VALIDE = /^[a-z0-9_]{3,20}$/;
    const CATEGORIES = ["Manga", "BD", "Comics", "Série", "Livre", "Roman graphique", "Light novel", "Artbook"];
    const LIMITES = { titre: 120, auteur: 80, tag: 30, tags: 10, tomes: 999, note: 200, livres: 500 };
    const IMAGE_MAX_OCTETS = 1024 * 1024;
    const TELECHARGEMENTS_PARALLELES = 4;

    const texteSur = (valeur, max) => String(valeur ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
    const idSur = (valeur) => (typeof valeur === "string" && ID_VALIDE.test(valeur) ? valeur : "");
    const normaliser = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

    function etat(texte) {
        const zone = $("v-etat");
        zone.textContent = texte;
        zone.hidden = !texte;
    }

    if (typeof supabase === "undefined" || typeof CONFIG === "undefined") {
        etat("Cette page est indisponible pour l'instant.");
        return;
    }

    // Pas de session, rien n'est mémorisé : un visiteur reste un visiteur, même s'il est connecté ailleurs sur ce navigateur
    const client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_CLE_PUBLIQUE, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    // ----- Nettoyage des données reçues -----
    function nettoyerLivre(brut, notesVisibles) {
        if (!brut || typeof brut !== "object") return null;
        const titre = texteSur(brut.titre, LIMITES.titre);
        const total = Number.parseInt(brut.total_tomes, 10);
        if (!titre || !Number.isInteger(total) || total < 1 || total > LIMITES.tomes) return null;

        const tomes = new Map();
        for (const t of Array.isArray(brut.tomes) ? brut.tomes : []) {
            const numero = Number.parseInt(t && t.numero, 10);
            if (!Number.isInteger(numero) || numero < 1 || numero > total || tomes.has(numero)) continue;
            tomes.set(numero, {
                numero,
                image: idSur(t.image),
                note: notesVisibles ? texteSur(t.note, LIMITES.note) : ""
            });
        }

        const tags = [];
        for (const tag of Array.isArray(brut.tags) ? brut.tags : []) {
            const propre = texteSur(tag, LIMITES.tag);
            if (propre && !tags.some(x => x.toLowerCase() === propre.toLowerCase()) && tags.length < LIMITES.tags) tags.push(propre);
        }

        const type = CATEGORIES.includes(brut.type) ? brut.type : "Livre";
        return {
            cle: idSur(brut.id) || `${type}|${titre}`, // retrouve la même série d'une mise à jour à l'autre
            titre,
            type,
            auteur: texteSur(brut.auteur, LIMITES.auteur),
            total,
            couverture: idSur(brut.couverture),
            tags,
            tomes
        };
    }

    // ----- Jaquettes : téléchargées une par une à la demande, quelques-unes à la fois -----
    let proprietaire = "";
    const imagesEnCache = new Map(); // id -> Promise<url blob ou "">
    const fileAttente = [];
    let enCours = 0;

    function pomper() {
        while (enCours < TELECHARGEMENTS_PARALLELES && fileAttente.length) {
            const tache = fileAttente.shift();
            enCours++;
            tache().finally(() => { enCours--; pomper(); });
        }
    }

    function urlImage(id) {
        if (!id || !UUID_VALIDE.test(proprietaire)) return Promise.resolve("");
        if (!imagesEnCache.has(id)) {
            imagesEnCache.set(id, new Promise((resoudre) => {
                fileAttente.push(async () => {
                    try {
                        const { data, error } = await client.storage.from("jaquettes").download(`${proprietaire}/${id}.jpg`);
                        if (error || !data || data.size > IMAGE_MAX_OCTETS || data.type !== "image/jpeg") return resoudre("");
                        resoudre(URL.createObjectURL(data));
                    } catch (e) {
                        resoudre("");
                    }
                });
                pomper();
            }));
        }
        return imagesEnCache.get(id);
    }

    let observateur = null;
    function chargerQuandVisible(img, id) {
        const charger = () => {
            urlImage(id).then(url => {
                if (!url) { img.remove(); return; }
                img.src = url;
            });
        };
        if (!("IntersectionObserver" in window)) { charger(); return; }
        if (!observateur) {
            observateur = new IntersectionObserver((entrees) => {
                entrees.forEach(e => {
                    if (!e.isIntersecting) return;
                    observateur.unobserve(e.target);
                    const action = e.target._charger;
                    if (action) action();
                });
            }, { rootMargin: "200px" });
        }
        img._charger = charger;
        observateur.observe(img);
    }

    function creerImage(id, texteAlt, classe) {
        const img = document.createElement("img");
        if (classe) img.className = classe;
        img.alt = texteAlt;
        img.loading = "lazy";
        chargerQuandVisible(img, id);
        return img;
    }

    // ----- Affichage -----
    let livres = [];
    let notesVisibles = false;
    const filtres = { texte: "", categorie: "" };

    function creerTags(tags) {
        const zone = document.createElement("div");
        tags.forEach(t => {
            const span = document.createElement("span");
            span.className = "tag";
            span.textContent = t;
            zone.append(span);
        });
        return zone;
    }

    function creerCarte(livre) {
        const carte = document.createElement("div");
        carte.className = "livre";
        carte.tabIndex = 0;
        carte.setAttribute("role", "button");

        const premier = [...livre.tomes.values()].find(t => t.image);
        const idVignette = livre.couverture || (premier ? premier.image : "");
        if (idVignette) carte.append(creerImage(idVignette, `Couverture de ${livre.titre}`, "vignette"));

        const texte = document.createElement("div");
        const titre = document.createElement("h3");
        titre.textContent = livre.titre;
        const info = document.createElement("p");
        info.textContent = livre.type + (livre.auteur ? " · " + livre.auteur : "");
        const progression = document.createElement("p");
        progression.textContent = `${livre.tomes.size} / ${livre.total} tomes`;
        texte.append(titre, info, progression);
        if (livre.tags.length) texte.append(creerTags(livre.tags));
        carte.append(texte);

        const ouvrir = () => afficherDetail(livre);
        carte.addEventListener("click", ouvrir);
        carte.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ouvrir(); }
        });
        return carte;
    }

    function livresFiltres() {
        const q = normaliser(filtres.texte);
        return livres.filter(l => {
            if (filtres.categorie && l.type !== filtres.categorie) return false;
            if (q && !normaliser(l.titre + " " + l.auteur).includes(q)) return false;
            return true;
        });
    }

    function afficherListe() {
        const zone = $("v-cartes");
        zone.replaceChildren();
        const resultats = livresFiltres();
        $("compteur").textContent = livres.length ? `${resultats.length} / ${livres.length} série(s)` : "";
        if (!resultats.length) {
            const vide = document.createElement("p");
            vide.textContent = livres.length ? "Aucun résultat avec ces filtres." : "Aucune série n'est partagée pour l'instant.";
            zone.append(vide);
            return;
        }
        resultats.forEach(l => zone.append(creerCarte(l)));
    }

    // « 1, 3-5, 9 » à partir d'une liste de numéros
    function resumerNumeros(numeros) {
        const morceaux = [];
        let debut = null;
        let precedent = null;
        const fermer = () => {
            if (debut === null) return;
            morceaux.push(debut === precedent ? String(debut) : `${debut}-${precedent}`);
        };
        numeros.forEach(n => {
            if (precedent !== null && n === precedent + 1) { precedent = n; return; }
            fermer();
            debut = n;
            precedent = n;
        });
        fermer();
        return morceaux.join(", ");
    }

    let serieOuverte = ""; // clé de la série dont la fiche est affichée

    function afficherDetail(livre, conserverPosition) {
        serieOuverte = livre.cle;
        const position = window.scrollY;
        const contenu = $("v-contenu");
        contenu.replaceChildren();

        const entete = document.createElement("div");
        entete.className = "entete";
        if (livre.couverture) entete.append(creerImage(livre.couverture, `Couverture de ${livre.titre}`, "couverture"));
        const identite = document.createElement("div");
        const h2 = document.createElement("h2");
        h2.textContent = livre.titre;
        const info = document.createElement("p");
        info.textContent = livre.type + (livre.auteur ? " · " + livre.auteur : "");
        identite.append(h2, info);
        if (livre.tags.length) identite.append(creerTags(livre.tags));
        entete.append(identite);

        const resume = document.createElement("p");
        resume.textContent = `${livre.tomes.size} tome(s) possédé(s) sur ${livre.total}`;

        const manquants = [];
        for (let i = 1; i <= livre.total; i++) if (!livre.tomes.has(i)) manquants.push(i);
        const lignesManquants = document.createElement("p");
        lignesManquants.textContent = manquants.length ? `Manquants : ${resumerNumeros(manquants)}` : "Série complète.";

        const legende = document.createElement("p");
        legende.className = "legende";
        legende.textContent = "Gris : manquant · Vert ou jaquette : possédé" + (notesVisibles ? " · Point blanc : note" : "");

        const grille = document.createElement("div");
        grille.className = "grille-tomes";
        for (let i = 1; i <= livre.total; i++) {
            const tome = livre.tomes.get(i);
            const carre = document.createElement("div");
            carre.className = "tome";
            if (!tome) carre.classList.add("manquant");
            if (tome && tome.note) { carre.classList.add("avec-note"); carre.title = tome.note; }
            if (tome && tome.image) {
                carre.classList.add("avec-image");
                carre.append(creerImage(tome.image, `Tome ${i}`, ""));
            }
            const numero = document.createElement("span");
            numero.className = "num";
            numero.textContent = i;
            carre.append(numero);
            grille.append(carre);
        }

        contenu.append(entete, resume, lignesManquants, legende, grille);

        const notes = [...livre.tomes.values()].filter(t => t.note);
        if (notes.length) {
            const titreNotes = document.createElement("h3");
            titreNotes.textContent = "Notes";
            const liste = document.createElement("ul");
            liste.className = "notes";
            notes.forEach(t => {
                const li = document.createElement("li");
                li.textContent = `Tome ${t.numero} : ${t.note}`;
                liste.append(li);
            });
            contenu.append(titreNotes, liste);
        }

        $("v-liste").hidden = true;
        $("v-detail").hidden = false;
        window.scrollTo(0, conserverPosition ? position : 0);
    }

    $("v-retour").addEventListener("click", () => {
        serieOuverte = "";
        $("v-detail").hidden = true;
        $("v-liste").hidden = false;
    });

    [["", "Toutes les catégories"], ...CATEGORIES.map(c => [c, c])].forEach(([valeur, texte]) => {
        const option = document.createElement("option");
        option.value = valeur;
        option.textContent = texte;
        $("v-categorie").append(option);
    });
    $("v-recherche").addEventListener("input", (e) => { filtres.texte = texteSur(e.target.value, 100); afficherListe(); });
    $("v-categorie").addEventListener("change", (e) => {
        filtres.categorie = CATEGORIES.includes(e.target.value) ? e.target.value : "";
        afficherListe();
    });

    // ----- Chargement et mise à jour automatique -----
    // Mise à jour EN DIRECT : la base envoie un signal (sans donnée) à chaque changement ; on recharge aussitôt.
    // Contrôle de secours : une vérification très légère (quelques octets) de temps en temps, plus fréquente si le direct est coupé.
    const DELAI_SECOURS = 60000;      // direct actif : simple filet de sécurité
    const DELAI_SANS_DIRECT = 10000;  // direct indisponible : on vérifie plus souvent
    const DELAI_ERREUR = 30000;
    const DELAI_GROUPAGE = 150;       // plusieurs signaux rapprochés = une seule mise à jour
    const INTERVALLE_MIN = 1000;      // jamais plus d'une vérification par seconde
    let generation = 0;               // change à chaque nouveau lien : les anciennes vérifications s'arrêtent
    let jetonCourant = "";
    let derniereEmpreinte = null;
    let minuteur = null;
    let minuteurSignal = null;
    let enVerification = false;
    let dernierDebut = 0;
    let canal = null;
    let direct = false;
    let contenuAffiche = false;
    let derniereMaj = "";

    function reinitialiser() {
        livres = [];
        proprietaire = "";
        serieOuverte = "";
        contenuAffiche = false;
        derniereMaj = "";
        $("v-maj").hidden = true;
        fileAttente.length = 0;
        imagesEnCache.forEach(p => p.then(url => { if (url) URL.revokeObjectURL(url); }));
        imagesEnCache.clear();
        $("v-liste").hidden = true;
        $("v-detail").hidden = true;
        $("v-titre").textContent = "Bibliothèque partagée";
        document.title = "Bibliothèque partagée";
    }

    // Petite empreinte (quelques octets) du contenu partagé : permet de savoir s'il a changé sans tout retélécharger.
    // undefined = indisponible pour l'instant ; null = lien invalide ou désactivé.
    async function lireEmpreinte(jeton) {
        try {
            const { data, error } = await client.rpc("partage_empreinte", { p_jeton: jeton });
            if (error) return undefined;
            return typeof data === "string" ? data : null;
        } catch (e) {
            return undefined;
        }
    }

    async function lireContenu(jeton) {
        const { data, error } = await client.rpc("lire_partage", { p_jeton: jeton });
        if (error) throw error;
        return data && typeof data === "object" ? data : null;
    }

    function heure() {
        return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    }

    function afficherMode() {
        const zone = $("v-maj");
        zone.hidden = !contenuAffiche;
        zone.textContent = (direct ? "● En direct" : "Mise à jour automatique toutes les 10 s") + (derniereMaj ? ` · mis à jour à ${derniereMaj}` : "");
        zone.classList.toggle("direct", direct);
    }

    function appliquer(reponse, miseAJour) {
        proprietaire = UUID_VALIDE.test(String(reponse.proprietaire)) ? String(reponse.proprietaire) : "";
        notesVisibles = reponse.notes_visibles === true;
        const pseudo = PSEUDO_VALIDE.test(String(reponse.pseudo)) ? String(reponse.pseudo) : "";
        const nom = pseudo ? `Bibliothèque de ${pseudo}` : "Bibliothèque partagée";
        $("v-titre").textContent = nom;
        document.title = nom;

        livres = (Array.isArray(reponse.livres) ? reponse.livres : [])
            .slice(0, LIMITES.livres)
            .map(l => nettoyerLivre(l, notesVisibles))
            .filter(Boolean);

        etat("");
        $("v-sous-titre").textContent = "Lecture seule : tu vois les séries que cette personne a choisi de partager.";
        contenuAffiche = true;
        if (miseAJour) derniereMaj = heure();
        afficherMode();

        // Les filtres et la position de lecture sont conservés
        const ouverte = serieOuverte ? livres.find(l => l.cle === serieOuverte) : null;
        afficherListe();
        if (ouverte) {
            $("v-liste").hidden = true;
            afficherDetail(ouverte, true);
            return;
        }
        $("v-detail").hidden = true;
        $("v-liste").hidden = false;
        if (serieOuverte) {
            serieOuverte = "";
            const texteInfo = "Cette série n'est plus partagée.";
            etat(texteInfo);
            setTimeout(() => { if ($("v-etat").textContent === texteInfo) etat(""); }, 6000);
        }
    }

    function planifier(g, delai) {
        clearTimeout(minuteur);
        minuteur = setTimeout(() => verifier(g), delai || (direct ? DELAI_SECOURS : DELAI_SANS_DIRECT));
    }

    // Un signal est arrivé : on vérifie dans un instant (groupé, et jamais plus d'une fois par seconde)
    function demanderVerification(g) {
        clearTimeout(minuteurSignal);
        const attente = Math.max(DELAI_GROUPAGE, INTERVALLE_MIN - (Date.now() - dernierDebut));
        minuteurSignal = setTimeout(() => verifier(g), attente);
    }

    function fermerDirect() {
        clearTimeout(minuteurSignal);
        direct = false;
        if (canal) {
            const ancien = canal;
            canal = null;
            try { Promise.resolve(client.removeChannel(ancien)).catch(() => {}); } catch (e) { /* déjà fermé */ }
        }
    }

    function ouvrirDirect(g, jeton) {
        fermerDirect();
        try {
            canal = client.channel(`partage:${jeton}`)
                .on("broadcast", { event: "maj" }, () => { if (g === generation) demanderVerification(g); })
                .subscribe((statut) => {
                    if (g !== generation) return;
                    const marche = statut === "SUBSCRIBED";
                    if (marche === direct) return;
                    direct = marche;
                    afficherMode();
                    if (marche) demanderVerification(g); // rattrape ce qui a pu arriver avant la connexion
                    planifier(g);
                });
        } catch (e) {
            direct = false; // pas de direct : la vérification régulière prend le relais
        }
    }

    async function verifier(g) {
        if (g !== generation || document.hidden) return; // en veille : reprise au retour sur l'onglet
        if (enVerification) { planifier(g, 1000); return; }
        enVerification = true;
        dernierDebut = Date.now();
        try {
            const empreinte = await lireEmpreinte(jetonCourant);
            if (g !== generation) return;
            if (empreinte === undefined) { planifier(g, DELAI_ERREUR); return; }
            if (empreinte === derniereEmpreinte) { planifier(g); return; }

            if (empreinte === null) { // le lien vient d'être désactivé ou remplacé
                derniereEmpreinte = null;
                reinitialiser();
                etat("Ce lien n'est pas valide ou a été désactivé.");
                planifier(g, DELAI_ERREUR); // si le lien est réactivé, la page se remplit toute seule
                return;
            }

            let reponse;
            try {
                reponse = await lireContenu(jetonCourant);
            } catch (e) {
                if (g === generation) planifier(g, DELAI_ERREUR);
                return;
            }
            if (g !== generation) return;
            if (!reponse) { planifier(g, DELAI_ERREUR); return; }
            derniereEmpreinte = empreinte;
            appliquer(reponse, true);
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
        jetonCourant = "";
        reinitialiser();
        const jeton = location.hash.replace(/^#/, "");
        if (!JETON_VALIDE.test(jeton)) {
            etat("Ce lien n'est pas valide ou a été désactivé.");
            return;
        }
        etat("Chargement…");

        // L'empreinte est lue AVANT le contenu : si quelque chose change entre les deux, la vérification suivante le verra
        const empreinte = await lireEmpreinte(jeton);
        let reponse;
        try {
            reponse = await lireContenu(jeton);
        } catch (e) {
            if (g === generation) etat("Impossible de charger cette bibliothèque pour l'instant. Réessaie dans un moment.");
            return;
        }
        if (g !== generation) return; // le lien a changé pendant le chargement
        if (!reponse) {
            etat("Ce lien n'est pas valide ou a été désactivé.");
            return;
        }

        jetonCourant = jeton;
        derniereEmpreinte = typeof empreinte === "string" ? empreinte : null;
        appliquer(reponse, false);
        planifier(g);
        ouvrirDirect(g, jeton);
    }

    window.addEventListener("pagehide", fermerDirect);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && jetonCourant) verifier(generation);
    });
    window.addEventListener("hashchange", charger);
    charger();
})();