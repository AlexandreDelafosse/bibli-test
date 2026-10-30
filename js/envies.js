// ===== Mes envies : ma liste de souhaits, visible par mes amis =====
// Tes amis peuvent réserver une envie pour l'offrir. Ici, tu ne reçois JAMAIS d'information sur les réservations :
// la base ne les envoie pas à la personne concernée. Tout est affiché avec textContent.
(function () {
    if (typeof clientSupabase === "undefined" || !clientSupabase) return;
    const client = clientSupabase;

    const UUID_VALIDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const MAX_ENVIES = 100;
    const LIMITES = { titre: 120, auteur: 80, note: 200 };

    // Seuls ces messages de la base sont affichés tels quels ; tout le reste donne un message générique
    const MESSAGES_CONNUS = new Set([
        "Titre invalide",
        "Auteur trop long",
        "Précision trop longue",
        "Catégorie invalide",
        "Limite de 100 envies atteinte",
        "Cette envie existe déjà",
        "Envie introuvable"
    ]);

    let compte = "";      // identifiant du compte connecté ("" = personne)
    let generation = 0;   // change à chaque changement de compte : les anciennes réponses sont ignorées
    let envies = null;    // null = pas encore lu
    let occupe = false;

    const erreur = (texte) => { champ("envies-erreur").textContent = texte || ""; };
    const info = (texte) => { champ("envies-info").textContent = texte || ""; };
    const texteSur = (valeur, max) => String(valeur ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

    function normaliser(brut) {
        if (!Array.isArray(brut)) return null;
        const sortie = [];
        for (const e of brut) {
            if (!e || typeof e !== "object" || !UUID_VALIDE.test(String(e.id))) continue;
            const titre = texteSur(e.titre, LIMITES.titre);
            if (!titre) continue;
            sortie.push({
                id: String(e.id).toLowerCase(),
                type: CATEGORIES.includes(e.type) ? e.type : "Livre",
                titre,
                auteur: texteSur(e.auteur, LIMITES.auteur),
                note: texteSur(e.note, LIMITES.note)
            });
            if (sortie.length >= MAX_ENVIES) break;
        }
        return sortie;
    }

    function messageDe(e) {
        const texte = e && typeof e.message === "string" ? e.message : "";
        if (e && e.code === "P0001" && MESSAGES_CONNUS.has(texte)) return texte;
        return "Action impossible pour l'instant. Vérifie ta connexion et réessaie.";
    }

    // ----- Affichage -----
    function afficher() {
        const liste = champ("envies-liste");
        liste.replaceChildren();
        const total = envies ? envies.length : 0;
        champ("envies-compteur").textContent = envies ? `${total} envie(s) sur ${MAX_ENVIES} possibles.` : "Chargement…";
        if (envies && !total) {
            const vide = document.createElement("li");
            vide.className = "ami-vide";
            vide.textContent = "Aucune envie pour l'instant. Ajoute ce que tu aimerais recevoir.";
            liste.append(vide);
        }
        (envies || []).forEach((e) => {
            const li = document.createElement("li");
            li.className = "envie-ligne";
            const texte = document.createElement("div");
            const titre = document.createElement("strong");
            titre.textContent = e.titre;
            const detail = document.createElement("p");
            detail.className = "legende";
            detail.textContent = e.type + (e.auteur ? " · " + e.auteur : "") + (e.note ? " · " + e.note : "");
            texte.append(titre, detail);
            const retirer = creerBouton("Retirer", () => {
                if (!confirm(`Retirer « ${e.titre} » de tes envies ?`)) return;
                agir(() => rpc("envie_supprimer", { p_id: e.id }), "Envie retirée.");
            });
            li.append(texte, retirer);
            liste.append(li);
        });
    }

    // ----- Appels à la base -----
    async function rpc(nom, args) {
        const { data, error } = await client.rpc(nom, args);
        if (error) throw error;
        return data;
    }

    async function lire() {
        if (!compte) return;
        const g = generation;
        try {
            const brut = await rpc("envies_liste");
            if (g !== generation) return;
            const lues = normaliser(brut);
            if (!lues) throw new Error("réponse inattendue");
            envies = lues;
        } catch (e) {
            if (g === generation && envies === null) erreur("Impossible de lire tes envies pour l'instant. Vérifie ta connexion.");
        }
        if (g === generation) afficher();
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
        if (g === generation) await lire();
    }

    // ----- Compte connecté ou non -----
    function arreter() {
        generation++;
        compte = "";
        envies = null;
        occupe = false;
        champ("envies-bouton").hidden = true;
        ["envies-titre-saisie", "envies-auteur", "envies-note"].forEach(id => { champ(id).value = ""; });
        erreur("");
        info("");
        afficher();
    }

    function demarrer(id) {
        arreter();
        compte = id;
        champ("envies-bouton").hidden = false;
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

    // ----- Boutons -----
    CATEGORIES.forEach((c) => {
        const option = document.createElement("option");
        option.value = c;
        option.textContent = c;
        champ("envies-type").append(option);
    });

    champ("envies-bouton").addEventListener("click", () => {
        erreur("");
        info("");
        envies = null;
        afficher();
        montrerVue("vue-envies");
        lire();
    });

    champ("envies-retour").addEventListener("click", () => {
        afficherListe();
        montrerVue("vue-liste");
    });

    champ("envies-form").addEventListener("submit", (evenement) => {
        evenement.preventDefault();
        const titre = texteSur(champ("envies-titre-saisie").value, LIMITES.titre);
        const type = champ("envies-type").value;
        const auteur = texteSur(champ("envies-auteur").value, LIMITES.auteur);
        const note = texteSur(champ("envies-note").value, LIMITES.note);
        if (!titre) { info(""); erreur("Indique un titre."); return; }
        if (!CATEGORIES.includes(type)) { info(""); erreur("Choisis une catégorie."); return; }
        agir(async () => {
            await rpc("envie_ajouter", { p_type: type, p_titre: titre, p_auteur: auteur, p_note: note });
            ["envies-titre-saisie", "envies-auteur", "envies-note"].forEach(id => { champ(id).value = ""; });
            info(`« ${titre} » ajouté à tes envies.`);
        });
    });
})();
