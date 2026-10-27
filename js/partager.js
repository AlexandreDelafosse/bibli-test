// ===== Panneau « Partager » : lien de partage et visibilité des séries =====
// Le jeton est créé par la base (jamais par le navigateur) ; ici on ne fait que l'afficher et appeler les fonctions
// de gestion. Tout est affiché avec textContent.
(function () {
    if (typeof clientSupabase === "undefined" || !clientSupabase) return;
    const client = clientSupabase;
    const JETON_VALIDE = /^[a-f0-9]{64}$/;

    let etatPartage = undefined; // undefined = en cours de lecture ; null = jamais activé ; sinon { jeton, actif, notes_visibles }
    let occupe = false;

    const erreur = (texte) => { champ("partage-erreur").textContent = texte || ""; };

    // Le jeton est placé après le « # » : il n'est jamais envoyé au serveur du site ni dans les en-têtes de navigation
    const lienPour = (jeton) => new URL("partage.html", location.href).href + "#" + jeton;

    function normaliser(donnees) {
        if (!donnees || typeof donnees.jeton !== "string" || !JETON_VALIDE.test(donnees.jeton)) return null;
        return { jeton: donnees.jeton, actif: donnees.actif === true, notes_visibles: donnees.notes_visibles === true };
    }

    function afficher() {
        const lecture = etatPartage === undefined;
        const actif = Boolean(etatPartage && etatPartage.actif);
        champ("partage-actif").hidden = lecture || !actif;
        champ("partage-inactif").hidden = lecture || actif;
        if (actif) champ("partage-lien").value = lienPour(etatPartage.jeton);
        // les notes se règlent même sans lien actif : elles servent aussi aux amis
        champ("partage-notes").checked = Boolean(etatPartage && etatPartage.notes_visibles);
        champ("partage-notes").disabled = lecture;

        const publiques = bibliotheque.filter(l => l.Visibilite === "public");
        champ("partage-resume").textContent = `${publiques.length} série(s) publique(s) sur ${bibliotheque.length}.`;
        const liste = champ("partage-liste");
        liste.replaceChildren();
        publiques.forEach(l => {
            const li = document.createElement("li");
            li.textContent = l.Titre;
            liste.append(li);
        });
    }

    async function appeler(nom, args) {
        const { data, error } = await client.rpc(nom, args);
        if (error) throw error;
        return data;
    }

    async function agir(tache) {
        if (occupe) return;
        occupe = true;
        erreur("");
        try {
            await tache();
        } catch (e) {
            erreur("Action impossible pour l'instant. Vérifie ta connexion et réessaie.");
        } finally {
            occupe = false;
            afficher();
        }
    }

    async function lireEtat() {
        const { data, error } = await client.from("partages").select("jeton,actif,notes_visibles").maybeSingle();
        if (error) throw error;
        return normaliser(data);
    }

    async function ouvrir() {
        erreur("");
        etatPartage = undefined;
        afficher();
        montrerVue("vue-partage");
        try {
            etatPartage = await lireEtat();
        } catch (e) {
            etatPartage = null;
            erreur("Impossible de lire ton réglage de partage pour l'instant.");
        }
        afficher();
    }

    champ("partage-bouton").addEventListener("click", ouvrir);

    champ("partage-retour").addEventListener("click", () => {
        afficherListe();
        montrerVue("vue-liste");
    });

    champ("partage-activer").addEventListener("click", () => agir(async () => {
        etatPartage = normaliser(await appeler("partage_activer"));
    }));

    champ("partage-regenerer").addEventListener("click", () => {
        if (!confirm("L'ancien lien cessera de fonctionner pour toutes les personnes qui l'ont reçu. Créer un nouveau lien ?")) return;
        agir(async () => { etatPartage = normaliser(await appeler("partage_regenerer")); });
    });

    champ("partage-desactiver").addEventListener("click", () => {
        if (!confirm("Désactiver le lien ? Plus personne ne pourra voir ta bibliothèque avec ce lien.")) return;
        agir(async () => {
            await appeler("partage_desactiver");
            etatPartage = etatPartage ? { ...etatPartage, actif: false } : null;
        });
    });

    champ("partage-notes").addEventListener("change", (evenement) => {
        const valeur = evenement.target.checked;
        agir(async () => {
            await appeler("partage_notes", { p_visibles: valeur });
            etatPartage = await lireEtat(); // la base crée le réglage s'il n'existait pas encore
        });
    });

    champ("partage-copier").addEventListener("click", async () => {
        const zone = champ("partage-lien");
        try {
            await navigator.clipboard.writeText(zone.value);
            message("Lien copié.");
        } catch (e) {
            zone.select();
            message("Copie automatique impossible : le lien est sélectionné, copie-le à la main.");
        }
    });

    if (navigator.share) {
        champ("partage-envoyer").hidden = false;
        champ("partage-envoyer").addEventListener("click", () => {
            navigator.share({ title: "Ma bibliothèque", url: champ("partage-lien").value }).catch(() => {});
        });
    }

    // Visibilité de toutes les séries d'un coup (la synchronisation envoie ensuite les changements)
    function toutDefinir(valeur) {
        const concernees = bibliotheque.filter(l => l.Visibilite !== valeur);
        if (!concernees.length) return;
        const question = valeur === "public"
            ? `Rendre ${concernees.length} série(s) publique(s) ? Elles seront visibles par tes amis et, si ton lien est actif, par toute personne qui l'a.`
            : `Rendre ${concernees.length} série(s) privée(s) ?`;
        if (!confirm(question)) return;
        concernees.forEach(l => { l.Visibilite = valeur; });
        sauvegarder();
        afficher();
    }

    champ("partage-tout-public").addEventListener("click", () => toutDefinir("public"));
    champ("partage-tout-prive").addEventListener("click", () => toutDefinir("prive"));
})();
