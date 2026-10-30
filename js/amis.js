// ===== Amis : demandes, liste d'amis, accès à leurs bibliothèques =====
// Tout passe par des fonctions de la base : elle décide qui a le droit de voir quoi.
// Les listes arrivent en direct (signal sans donnée, puis relecture). Tout est affiché avec textContent.
(function () {
    if (typeof clientSupabase === "undefined" || !clientSupabase) return;
    const client = clientSupabase;

    const UUID_VALIDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const PSEUDO_VALIDE = /^[a-z0-9_]{3,20}$/;
    const CANAL_VALIDE = /^[a-f0-9]{64}$/;
    const MAX_LIGNES = 250;
    const DELAI_SECOURS = 60000;      // direct actif : simple filet de sécurité
    const DELAI_SANS_DIRECT = 20000;  // direct indisponible : on relit plus souvent
    const DELAI_ERREUR = 30000;
    const DELAI_GROUPAGE = 200;
    const INTERVALLE_MIN = 1000;

    // Seuls ces messages de la base sont affichés tels quels ; tout le reste donne un message générique
    const MESSAGES_CONNUS = new Set([
        "Pseudo invalide",
        "Aucun compte avec ce pseudo",
        "Tu ne peux pas t'ajouter toi-même",
        "Vous êtes déjà amis",
        "Demande déjà envoyée",
        "Trop de demandes en attente (20 maximum)",
        "Limite de 200 amis atteinte",
        "Demande introuvable",
        "Introuvable"
    ]);

    let compte = "";          // identifiant du compte connecté ("" = personne)
    let generation = 0;       // change à chaque changement de compte : les anciennes réponses sont ignorées
    let donnees = null;       // { canal, amis, recues, envoyees }
    let occupe = false;
    let enLecture = false;
    let derniereLecture = 0;
    let minuteur = null;
    let minuteurSignal = null;
    let canal = null;
    let sujetCanal = "";
    let direct = false;

    const erreur = (texte) => { champ("amis-erreur").textContent = texte || ""; };
    const info = (texte) => { champ("amis-info").textContent = texte || ""; };

    // ----- Lecture et nettoyage -----
    function listeDePseudos(brut) {
        const vus = new Set();
        const sortie = [];
        for (const element of Array.isArray(brut) ? brut : []) {
            const pseudo = element && typeof element.pseudo === "string" ? element.pseudo : "";
            if (!PSEUDO_VALIDE.test(pseudo) || vus.has(pseudo)) continue;
            vus.add(pseudo);
            sortie.push(pseudo);
            if (sortie.length >= MAX_LIGNES) break;
        }
        return sortie;
    }

    function normaliser(brut) {
        if (!brut || typeof brut !== "object") return null;
        return {
            canal: CANAL_VALIDE.test(String(brut.canal)) ? String(brut.canal) : "",
            amis: listeDePseudos(brut.amis),
            recues: listeDePseudos(brut.recues),
            envoyees: listeDePseudos(brut.envoyees)
        };
    }

    function messageDe(e) {
        const texte = e && typeof e.message === "string" ? e.message : "";
        if (e && e.code === "P0001" && MESSAGES_CONNUS.has(texte)) return texte;
        return "Action impossible pour l'instant. Vérifie ta connexion et réessaie.";
    }

    // ----- Affichage -----
    function ligne(pseudo, ...elements) {
        const li = document.createElement("li");
        li.className = "ami-ligne";
        const nom = document.createElement("strong");
        nom.textContent = pseudo;
        const actions = document.createElement("span");
        actions.className = "ami-actions";
        actions.append(...elements);
        li.append(nom, actions);
        return li;
    }

    function remplir(idListe, idTitre, pseudos, fabriquer, vide) {
        const liste = champ(idListe);
        liste.replaceChildren();
        pseudos.forEach(p => liste.append(fabriquer(p)));
        if (!pseudos.length && vide) {
            const li = document.createElement("li");
            li.className = "ami-vide";
            li.textContent = vide;
            liste.append(li);
        }
        if (idTitre) champ(idTitre).hidden = !pseudos.length && !vide;
        liste.hidden = !pseudos.length && !vide;
    }

    function lienVers(pseudo, suite, texte) {
        const a = document.createElement("a");
        a.href = "./ami.html#" + pseudo + suite; // pseudo déjà validé : lettres minuscules, chiffres, _
        a.textContent = texte;
        return a;
    }

    function afficher() {
        const d = donnees || { amis: [], recues: [], envoyees: [] };
        const n = d.recues.length;
        champ("amis-bouton").textContent = n ? `Amis (${n})` : "Amis";
        champ("amis-bouton").title = n ? `${n} demande(s) d'ami en attente` : "";

        remplir("amis-recues", "amis-recues-titre", d.recues, (p) => ligne(
            p,
            creerBouton("Accepter", () => agir(() => rpc("ami_repondre", { p_pseudo: p, p_accepter: true }), `${p} est maintenant ton ami.`)),
            creerBouton("Refuser", () => agir(() => rpc("ami_repondre", { p_pseudo: p, p_accepter: false }), "Demande refusée."))
        ), "");

        remplir("amis-liste", "amis-liste-titre", d.amis, (p) => ligne(
            p,
            lienVers(p, "", "Voir sa bibliothèque"),
            lienVers(p, "/envies", "Ses envies"),
            creerBouton("Retirer", () => {
                if (!confirm(`Retirer ${p} de tes amis ? Vous ne verrez plus vos bibliothèques.`)) return;
                agir(() => rpc("ami_retirer", { p_pseudo: p }), `${p} a été retiré de tes amis.`);
            })
        ), donnees ? "Aucun ami pour l'instant." : "");

        remplir("amis-envoyees", "amis-envoyees-titre", d.envoyees, (p) => ligne(
            p,
            creerBouton("Annuler la demande", () => agir(() => rpc("ami_retirer", { p_pseudo: p }), "Demande annulée."))
        ), "");

        const vide = Boolean(donnees);
        champ("amis-direct").hidden = !vide;
        champ("amis-direct").textContent = direct ? "● En direct" : "";
        champ("amis-direct").classList.toggle("direct", direct);
    }

    // ----- Appels à la base -----
    async function rpc(nom, args) {
        const { data, error } = await client.rpc(nom, args);
        if (error) throw error;
        return data;
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
        if (g === generation) lire();
    }

    async function lire() {
        if (!compte) return;
        if (enLecture) { demander(); return; }
        enLecture = true;
        derniereLecture = Date.now();
        const g = generation;
        try {
            const brut = await rpc("amis_liste");
            if (g !== generation) return;
            const nouvelles = normaliser(brut);
            if (!nouvelles) throw new Error("réponse inattendue");
            donnees = nouvelles;
            afficher();
            assurerCanal(g);
            planifier(g, direct ? DELAI_SECOURS : DELAI_SANS_DIRECT);
        } catch (e) {
            if (g === generation) planifier(g, DELAI_ERREUR);
        } finally {
            enLecture = false;
        }
    }

    // ----- Direct : un signal sans donnée, puis on relit la liste -----
    function planifier(g, delai) {
        clearTimeout(minuteur);
        minuteur = setTimeout(() => { if (g === generation && !document.hidden) lire(); }, delai);
    }

    function demander() {
        clearTimeout(minuteurSignal);
        const attente = Math.max(DELAI_GROUPAGE, INTERVALLE_MIN - (Date.now() - derniereLecture));
        const g = generation;
        minuteurSignal = setTimeout(() => { if (g === generation) lire(); }, attente);
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

    // Le canal secret est renouvelé quand une amitié se termine : on se réabonne à chaque relecture si besoin
    function assurerCanal(g) {
        const voulu = donnees && donnees.canal ? `ami:${donnees.canal}` : "";
        if (!voulu) { fermerDirect(); return; }
        if (voulu === sujetCanal) return;
        fermerDirect();
        sujetCanal = voulu;
        try {
            canal = client.channel(voulu)
                .on("broadcast", { event: "amis" }, () => { if (g === generation) demander(); })
                .subscribe((statut) => {
                    if (g !== generation || voulu !== sujetCanal) return;
                    const marche = statut === "SUBSCRIBED";
                    if (marche === direct) return;
                    direct = marche;
                    afficher();
                    if (marche) demander(); // rattrape ce qui a pu arriver avant la connexion
                });
        } catch (e) {
            direct = false; // pas de direct : la relecture régulière prend le relais
        }
    }

    // ----- Compte connecté ou non -----
    function arreter() {
        generation++;
        clearTimeout(minuteur);
        fermerDirect();
        compte = "";
        donnees = null;
        occupe = false;
        enLecture = false;
        champ("amis-bouton").hidden = true;
        champ("amis-pseudo").value = "";
        erreur("");
        info("");
        afficher();
    }

    function demarrer(id) {
        arreter();
        compte = id;
        champ("amis-bouton").hidden = false;
        lire();
    }

    function surSession(session) {
        const id = session && session.user ? String(session.user.id).toLowerCase() : "";
        if (!UUID_VALIDE.test(id)) { if (compte) arreter(); return; }
        if (id !== compte) demarrer(id);
    }

    client.auth.onAuthStateChange((evenement, session) => {
        if (evenement === "TOKEN_REFRESHED") return;
        setTimeout(() => surSession(session), 0);
    });
    client.auth.getSession().then(({ data }) => surSession(data && data.session)).catch(() => {});

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && compte && Date.now() - derniereLecture > 5000) lire();
    });
    window.addEventListener("pagehide", fermerDirect);

    // ----- Boutons -----
    champ("amis-bouton").addEventListener("click", () => {
        erreur("");
        info("");
        afficher();
        montrerVue("vue-amis");
        lire();
    });

    champ("amis-retour").addEventListener("click", () => {
        afficherListe();
        montrerVue("vue-liste");
    });

    champ("amis-form").addEventListener("submit", (evenement) => {
        evenement.preventDefault();
        const pseudo = champ("amis-pseudo").value.trim().toLowerCase();
        if (!PSEUDO_VALIDE.test(pseudo)) {
            info("");
            erreur("Pseudo invalide : 3 à 20 caractères, lettres sans accent, chiffres ou _.");
            return;
        }
        agir(async () => {
            const resultat = await rpc("ami_demander", { p_pseudo: pseudo });
            champ("amis-pseudo").value = "";
            info(resultat === "acceptee" ? `Vous êtes maintenant amis avec ${pseudo} !` : `Demande envoyée à ${pseudo}.`);
        });
    });
})();
