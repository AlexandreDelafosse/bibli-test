// ===== Ajout en masse : coller plusieurs séries d'un coup (une par ligne), aperçu, puis ajout =====
// Colonnes (séparées par « ; », « | » ou une tabulation) : Titre ; Catégorie ; Nombre de tomes ; Tomes possédés ; Auteur ; Tags
// Chaque ligne passe par les mêmes contrôles que le formulaire (nettoyerLivre, lireTomes). Tout est affiché avec textContent.
(function () {
    const MAX_LIGNES = 300;
    const MAX_TEXTE = 40000;
    const MOTS_TOUS = new Set(["tous", "toutes", "tout", "all", "complet", "complete"]);

    // Noms de catégories reconnus (sans accents ni majuscules), en plus des noms exacts
    const ALIAS = new Map([
        ["mangas", "Manga"], ["bds", "BD"], ["bande dessinee", "BD"], ["bandes dessinees", "BD"],
        ["comic", "Comics"], ["series", "Série"], ["serie", "Série"], ["livres", "Livre"], ["roman", "Livre"], ["romans", "Livre"],
        ["graphique", "Roman graphique"], ["romans graphiques", "Roman graphique"],
        ["ln", "Light novel"], ["light novels", "Light novel"], ["artbooks", "Artbook"], ["art book", "Artbook"]
    ]);
    CATEGORIES.forEach(c => ALIAS.set(normaliser(c), c));

    let resultats = [];

    const cle = (titre, type) => `${type}|${titre.toLowerCase()}`;
    // Découpe une ligne en colonnes. Séparateur : tabulation s'il y en a une, sinon « ; » ou « | ».
    // Un champ peut être mis entre guillemets pour contenir un séparateur : "Astérix ; le Gaulois" ; BD
    function decouper(ligne) {
        const separateurs = ligne.includes("\t") ? "\t" : ";|";
        const champs = [];
        let courant = "";
        let entreGuillemets = false;
        let debutDeChamp = true;
        for (const c of ligne) {
            if (entreGuillemets) {
                if (c === '"') entreGuillemets = false;
                else courant += c;
            } else if (c === '"' && debutDeChamp) {
                entreGuillemets = true;
                debutDeChamp = false;
            } else if (separateurs.includes(c)) {
                champs.push(courant.trim());
                courant = "";
                debutDeChamp = true;
            } else {
                courant += c;
                if (c !== " ") debutDeChamp = false;
            }
        }
        champs.push(courant.trim());
        return champs;
    }

    // Une ligne -> { statut: "ok" | "ignore" | "erreur", message, livre, detail }
    function lireLigne(texteLigne, defaut) {
        const colonnes = decouper(texteLigne);
        const [titreBrut = "", categorieBrute = "", totalBrut = "", possedesBrut = "", auteurBrut = "", ...reste] = colonnes;

        const titre = nettoyerTexte(titreBrut, LIMITES.titre + 1);
        if (!titre) return { statut: "erreur", message: "titre manquant" };
        if (titre.length > LIMITES.titre) return { statut: "erreur", message: `titre trop long (${LIMITES.titre} caractères maximum)` };

        let type = defaut;
        if (categorieBrute) {
            type = ALIAS.get(normaliser(categorieBrute));
            if (!type) return { statut: "erreur", message: `catégorie inconnue : « ${nettoyerTexte(categorieBrute, 30)} »` };
        }

        let total = null;
        if (totalBrut) {
            if (!/^\d{1,3}$/.test(totalBrut)) return { statut: "erreur", message: `nombre de tomes incorrect : « ${nettoyerTexte(totalBrut, 20)} »` };
            total = Number(totalBrut);
            if (total < 1 || total > LIMITES.tomes) return { statut: "erreur", message: `le nombre de tomes doit être entre 1 et ${LIMITES.tomes}` };
        }

        let possedes = [];
        let avertissement = "";
        if (possedesBrut) {
            if (MOTS_TOUS.has(normaliser(possedesBrut))) {
                if (total === null) return { statut: "erreur", message: "indique le nombre de tomes pour « tous »" };
                possedes = Array.from({ length: total }, (_, i) => i + 1);
            } else {
                const lus = lireTomes(possedesBrut, total === null ? LIMITES.tomes : total);
                if (lus.erreur) return { statut: "erreur", message: lus.erreur };
                possedes = lus.tomes;
            }
        }
        if (total === null) {
            total = possedes.length ? Math.max(...possedes) : 1;
            avertissement = `nombre de tomes non indiqué : ${total}`;
        }

        const tags = [];
        if (reste.length) {
            reste.join(",").split(",").forEach(t => {
                const propre = nettoyerTexte(nettoyerTexte(t, LIMITES.tag + 5).replace(/^#+\s*/, ""), LIMITES.tag + 1);
                if (propre && propre.length <= LIMITES.tag) tags.push(propre);
            });
            if (tags.length > LIMITES.tags) return { statut: "erreur", message: `${LIMITES.tags} tags maximum` };
        }

        const livre = nettoyerLivre({
            Titre: titre,
            Auteur: auteurBrut,
            Type: type,
            Total_tomes: total,
            Tomes_possedes: possedes.map(n => ({ Tome: n, Note: "", Image: "" })),
            Tags: tags,
            Visibilite: "prive"
        });
        if (!livre) return { statut: "erreur", message: "données invalides" };
        const detail = `${livre.Type} · ${livre.Tomes_possedes.length} / ${livre.Total_tomes} tomes` + (livre.Auteur ? ` · ${livre.Auteur}` : "") + (livre.Tags.length ? ` · ${livre.Tags.join(", ")}` : "");
        return { statut: "ok", livre, message: avertissement, detail };
    }

    function analyser() {
        const defaut = CATEGORIES.includes(champ("masse-categorie").value) ? champ("masse-categorie").value : "Manga";
        const lignes = champ("masse-texte").value.slice(0, MAX_TEXTE).split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
        const connus = new Set(bibliotheque.map(l => cle(l.Titre, l.Type)));
        let places = LIMITES.livres - bibliotheque.length;
        resultats = [];

        let debut = 0;
        // ligne d'en-tête collée depuis un tableur : « Titre ; Catégorie ; ... »
        if (lignes.length && decouper(lignes[0]).length > 1 && normaliser(decouper(lignes[0])[0]) === "titre") debut = 1;

        for (let i = debut; i < lignes.length; i++) {
            if (resultats.length >= MAX_LIGNES) {
                resultats.push({ numero: i + 1, texte: "…", statut: "erreur", message: `${MAX_LIGNES} lignes maximum à la fois : colle la suite séparément` });
                break;
            }
            const r = lireLigne(lignes[i], defaut);
            r.numero = i + 1;
            r.texte = nettoyerTexte(lignes[i], 100);
            if (r.statut === "ok") {
                const k = cle(r.livre.Titre, r.livre.Type);
                if (connus.has(k)) {
                    r.statut = "ignore";
                    r.message = "déjà dans ta bibliothèque ou répété plus haut : ignoré";
                } else if (places <= 0) {
                    r.statut = "erreur";
                    r.message = `limite de ${LIMITES.livres} livres atteinte`;
                } else {
                    connus.add(k);
                    places--;
                }
            }
            resultats.push(r);
        }
        afficher();
    }

    function afficher() {
        const liste = champ("masse-liste");
        liste.replaceChildren();
        const compte = (s) => resultats.filter(r => r.statut === s).length;
        const ok = compte("ok"), ignorees = compte("ignore"), erreurs = compte("erreur");

        const morceaux = [];
        if (ok) morceaux.push(`${ok} série(s) prête(s)`);
        if (ignorees) morceaux.push(`${ignorees} ignorée(s)`);
        if (erreurs) morceaux.push(`${erreurs} à corriger`);
        champ("masse-resume").textContent = resultats.length ? morceaux.join(" · ") : "";

        resultats.forEach((r) => {
            const li = document.createElement("li");
            li.className = "masse-ligne " + r.statut;
            const etiquette = document.createElement("span");
            etiquette.className = "masse-etat";
            etiquette.textContent = r.statut === "ok" ? "OK" : r.statut === "ignore" ? "Ignorée" : "Erreur";
            const corps = document.createElement("div");
            const titre = document.createElement("strong");
            titre.textContent = r.statut === "ok" ? r.livre.Titre : `Ligne ${r.numero}`;
            const detail = document.createElement("p");
            detail.className = "legende";
            detail.textContent = r.statut === "ok"
                ? r.detail + (r.message ? ` — ${r.message}` : "")
                : `${r.message}${r.statut === "erreur" && r.texte !== "…" ? ` — « ${r.texte} »` : ""}`;
            corps.append(titre, detail);
            li.append(etiquette, corps);
            liste.append(li);
        });

        const bouton = champ("masse-valider");
        bouton.disabled = ok === 0;
        bouton.textContent = ok ? `Ajouter ${ok} série(s)` : "Ajouter";
    }

    let minuteur = null;
    champ("masse-texte").addEventListener("input", () => {
        clearTimeout(minuteur);
        minuteur = setTimeout(analyser, 250);
    });
    champ("masse-categorie").addEventListener("change", analyser);

    CATEGORIES.forEach((c) => {
        const option = document.createElement("option");
        option.value = c;
        option.textContent = c;
        champ("masse-categorie").append(option);
    });

    function ouvrir() {
        champ("masse-texte").value = "";
        resultats = [];
        afficher();
        montrerVue("vue-masse");
    }

    champ("bouton-masse").addEventListener("click", ouvrir);

    function fermer() {
        clearTimeout(minuteur);
        afficherListe();
        montrerVue("vue-liste");
    }
    champ("masse-retour").addEventListener("click", fermer);
    champ("masse-annuler").addEventListener("click", fermer);

    champ("masse-valider").addEventListener("click", () => {
        clearTimeout(minuteur);
        analyser(); // on recompte juste avant d'ajouter (la bibliothèque a pu changer entre-temps)
        const nouveaux = resultats.filter(r => r.statut === "ok").map(r => r.livre);
        if (!nouveaux.length) return;
        bibliotheque.push(...nouveaux);
        if (!sauvegarder()) {
            bibliotheque.splice(bibliotheque.length - nouveaux.length, nouveaux.length); // rien n'a pu être enregistré
            return;
        }
        champ("masse-texte").value = "";
        resultats = [];
        afficherListe();
        montrerVue("vue-liste");
        message(`${nouveaux.length} série(s) ajoutée(s).`);
    });
})();
