// ===== Synchronisation de la bibliothèque avec le compte (Supabase) =====
// Principe : la collection de l'appareil est une copie de travail. À chaque modification, seules les
// DIFFÉRENCES par rapport au dernier état connu du compte sont envoyées. Hors ligne, tout est gardé
// sur l'appareil et envoyé au retour du réseau. Les règles de sécurité de la base garantissent que
// chaque compte ne lit et n'écrit que ses propres données.
(function () {
    if (typeof clientSupabase === "undefined" || !clientSupabase) return; // pas de comptes : mode local seul
    const client = clientSupabase;
    const BUCKET = "jaquettes";
    const TAILLE_LOT = 25;
    const PAGE = 1000;

    // Dernier état connu du compte : empreinte de chaque livre + images déjà en ligne
    let etat = { portee: null, livres: new Map(), images: new Set() };
    const refuses = new Map();        // id d'un livre -> empreinte refusée par le serveur (on n'insiste pas tant que rien ne change)
    const imagesPerdues = new Set();  // images absentes de l'appareil et du compte : inutile de réessayer
    let file = Promise.resolve();     // une seule opération de synchronisation à la fois
    let minuteurEnvoi = null;
    let minuteurRelance = null;
    let echecs = 0;
    let derniereSync = 0;
    let compteurModifs = 0;
    let stockageNettoye = false;
    const migrationsTentees = new Set();

    function enfiler(tache) {
        const suite = file.then(tache);
        file = suite.catch(() => {});
        return suite;
    }

    // ----- Empreintes : repèrent ce qui a changé -----
    function hacher(texte) { // cyrb53
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < texte.length; i++) {
            const c = texte.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 2654435761);
            h2 = Math.imul(h2 ^ c, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    function empreinte(l) {
        const tomes = [...l.Tomes_possedes].sort((a, b) => a.Tome - b.Tome).map(t => [t.Tome, t.Note, t.Image]);
        return hacher(JSON.stringify([l.Id, l.Type, l.Titre, l.Auteur, l.Total_tomes, l.Couverture, tomes, l.Tags, l.Visibilite]));
    }

    const versCloud = (l) => ({
        id: l.Id, type: l.Type, titre: l.Titre, auteur: l.Auteur, total_tomes: l.Total_tomes,
        couverture: l.Couverture, tags: l.Tags, visibilite: l.Visibilite,
        tomes: l.Tomes_possedes.map(t => ({ numero: t.Tome, note: t.Note, image: t.Image }))
    });

    // Tout ce qui revient du serveur repasse par la même validation que la saisie
    const depuisCloud = (ligne, tomes) => nettoyerLivre({
        Id: ligne.id, Type: ligne.type, Titre: ligne.titre, Auteur: ligne.auteur, Total_tomes: ligne.total_tomes,
        Couverture: ligne.couverture || "", Tags: ligne.tags || [], Visibilite: ligne.visibilite,
        Tomes_possedes: (tomes || []).map(t => ({ Tome: t.numero, Note: t.note || "", Image: t.image || "" }))
    });

    // ----- Dernier état connu, conservé sur l'appareil (par compte) -----
    function lireEtat(p) {
        const vide = { portee: p, livres: new Map(), images: new Set() };
        try {
            const brut = JSON.parse(localStorage.getItem(`synchro:${p}`) || "null");
            if (!brut || typeof brut.livres !== "object" || !Array.isArray(brut.images)) return vide;
            const livres = new Map();
            for (const [id, h] of Object.entries(brut.livres)) if (ID_VALIDE.test(id) && typeof h === "string") livres.set(id, h);
            const images = new Set(brut.images.filter(i => typeof i === "string" && ID_VALIDE.test(i)));
            return { portee: p, livres, images };
        } catch (e) {
            return vide;
        }
    }

    function sauverEtat() {
        try {
            localStorage.setItem(`synchro:${etat.portee}`, JSON.stringify({ livres: Object.fromEntries(etat.livres), images: [...etat.images] }));
        } catch (e) {}
    }

    function assurerEtat() {
        if (etat.portee !== portee) {
            etat = lireEtat(portee);
            refuses.clear();
            imagesPerdues.clear();
            stockageNettoye = false;
        }
    }

    // ----- Ce qui reste à envoyer -----
    function enAttente() {
        assurerEtat();
        const actuels = new Map(bibliotheque.map(l => [l.Id, empreinte(l)]));
        const utiles = new Set(idsImages(bibliotheque));
        const differents = bibliotheque.filter(l => etat.livres.get(l.Id) !== actuels.get(l.Id));
        return {
            // livres refusés par le serveur : mis de côté tant qu'on ne les modifie pas
            aEnvoyer: differents.filter(l => refuses.get(l.Id) !== actuels.get(l.Id)),
            refusesActifs: differents.filter(l => refuses.get(l.Id) === actuels.get(l.Id)),
            aSupprimer: [...etat.livres.keys()].filter(id => !actuels.has(id)),
            imagesAEnvoyer: [...utiles].filter(id => !etat.images.has(id) && !imagesPerdues.has(id))
        };
    }

    const modificationsEnAttente = (avecRefuses = false) => {
        const t = enAttente();
        return t.aEnvoyer.length > 0 || t.aSupprimer.length > 0 || t.imagesAEnvoyer.length > 0 || (avecRefuses && t.refusesActifs.length > 0);
    };

    // ----- Affichage de l'état -----
    function afficherStatut(texte) {
        const zone = champ("sync-statut");
        zone.textContent = texte || "";
        zone.hidden = !portee || !texte;
        champ("sync-bouton").hidden = !portee;
        champ("partage-bouton").hidden = !portee;
    }

    function statutEchec() {
        const attente = portee && modificationsEnAttente() ? " · modifications gardées sur cet appareil" : "";
        afficherStatut((navigator.onLine ? "Synchronisation impossible, nouvel essai bientôt" : "Hors ligne") + attente);
    }

    // ----- Erreurs -----
    // Refus définitif du serveur pour des données (contrainte, doublon...) : inutile de réessayer à l'identique
    const refusDeDonnees = (e) => Boolean(e && typeof e.code === "string" && /^(22|23|P0)[0-9A-Z]{3}$/.test(e.code));

    function refusStockage(e) {
        const s = Number(e && (e.statusCode ?? e.status));
        return s >= 400 && s < 500 && s !== 401 && s !== 408 && s !== 429;
    }

    const imageDejaEnLigne = (e) => Number(e && e.statusCode) === 409 || /already exists|duplicate/i.test((e && e.message) || "");

    function signalerRefus(livre, erreur) {
        const raison = erreur.code === "23505"
            ? "ce titre existe déjà dans cette catégorie sur ton compte"
            : "le serveur a refusé ces données";
        message(`« ${livre.Titre} » n'a pas pu être enregistré en ligne : ${raison}. Il reste sur cet appareil.`);
    }

    // ----- Envoi des différences -----
    async function sessionValide() {
        try {
            const { data } = await client.auth.getSession();
            return Boolean(portee && data.session && String(data.session.user.id).toLowerCase() === portee);
        } catch (e) {
            return false;
        }
    }

    async function envoyerLot(lot) {
        const charge = lot.map(l => ({ id: l.Id, hash: empreinte(l), json: versCloud(l), livre: l }));
        const { error } = await client.rpc("enregistrer_livres", { p_livres: charge.map(c => c.json) });
        if (!error) {
            charge.forEach(c => etat.livres.set(c.id, c.hash));
            return;
        }
        if (!refusDeDonnees(error)) throw error;
        if (lot.length > 1) {
            for (const l of lot) await envoyerLot([l]); // isole le livre fautif
            return;
        }
        refuses.set(charge[0].id, charge[0].hash);
        signalerRefus(lot[0], error);
    }

    async function pousser() {
        if (!portee) return;
        const p = portee;
        if (!(await sessionValide())) throw new Error("session indisponible");
        const stockage = client.storage.from(BUCKET);

        // 1. Images nouvelles (avant les livres qui les référencent)
        for (const id of enAttente().imagesAEnvoyer) {
            const blob = await imgGet(id);
            if (!blob) { imagesPerdues.add(id); continue; }
            const { error } = await stockage.upload(`${p}/${id}.jpg`, blob, { contentType: "image/jpeg", upsert: false });
            if (error && !imageDejaEnLigne(error)) {
                if (refusStockage(error)) { imagesPerdues.add(id); continue; }
                throw error;
            }
            if (p !== portee) return;
            etat.images.add(id);
        }

        // 2. Livres nouveaux ou modifiés
        const aEnvoyer = enAttente().aEnvoyer;
        for (let i = 0; i < aEnvoyer.length; i += TAILLE_LOT) {
            await envoyerLot(aEnvoyer.slice(i, i + TAILLE_LOT));
            if (p !== portee) return;
        }

        // 3. Livres supprimés
        const aSupprimer = enAttente().aSupprimer;
        for (let i = 0; i < aSupprimer.length; i += 50) {
            const ids = aSupprimer.slice(i, i + 50);
            const { error } = await client.from("livres").delete().in("id", ids);
            if (error) throw error;
            ids.forEach(id => etat.livres.delete(id));
        }

        // 4. Images devenues inutiles
        const utiles = new Set(idsImages(bibliotheque));
        const inutiles = [...etat.images].filter(id => !utiles.has(id));
        for (let i = 0; i < inutiles.length; i += 100) {
            const lot = inutiles.slice(i, i + 100);
            const { error } = await stockage.remove(lot.map(id => `${p}/${id}.jpg`));
            if (!error) lot.forEach(id => etat.images.delete(id));
        }

        sauverEtat();
    }

    // ----- Lecture depuis le compte -----
    async function toutLire(requete) {
        const lignes = [];
        for (let page = 0; page < 60; page++) {
            const { data, error } = await requete(page * PAGE, page * PAGE + PAGE - 1);
            if (error) throw error;
            lignes.push(...data);
            if (data.length < PAGE) break;
        }
        return lignes;
    }

    const vueEnEdition = () => champ("vue-detail").style.display === "block" || champ("vue-form").style.display === "block";

    // Renvoie true si la lecture du compte a bien eu lieu jusqu'au bout
    async function tirer(forcer) {
        if (!portee || (vueEnEdition() && !forcer)) return false;
        const p = portee;
        const modifsAvant = compteurModifs;

        const lignes = await toutLire((a, b) => client.from("livres")
            .select("id,type,titre,auteur,total_tomes,couverture,tags,visibilite").order("created_at").order("id").range(a, b));
        const lignesTomes = await toutLire((a, b) => client.from("tomes")
            .select("livre_id,numero,note,image").order("livre_id").order("numero").range(a, b));
        // si le compte a changé, ou si tu as modifié quelque chose pendant la lecture, on laisse le prochain tour s'en charger
        // + toute modification faite pendant l'envoi qui précède : on ne l'écrase jamais
        if (p !== portee || modifsAvant !== compteurModifs || modificationsEnAttente()) return false;

        const parLivre = new Map();
        for (const t of lignesTomes) {
            if (!parLivre.has(t.livre_id)) parLivre.set(t.livre_id, []);
            parLivre.get(t.livre_id).push(t);
        }
        const distants = fiabiliser(lignes.slice(0, LIMITES.livres)
            .map(l => depuisCloud(l, parLivre.get(l.id))).filter(Boolean));

        const nouvelEtat = { portee: p, livres: new Map(distants.map(l => [l.Id, empreinte(l)])), images: new Set(idsImages(distants)) };

        // Les livres refusés par le serveur restent sur l'appareil au lieu de disparaître
        const finale = [...distants];
        for (const l of bibliotheque) {
            if (refuses.get(l.Id) !== empreinte(l)) continue;
            const i = finale.findIndex(d => d.Id === l.Id);
            if (i >= 0) finale[i] = l; else finale.push(l);
        }

        const signature = (liste) => JSON.stringify(liste.map(l => [l.Id, empreinte(l)]).sort());
        const change = signature(finale) !== signature(bibliotheque);
        etat = nouvelEtat;
        sauverEtat();
        if (!change) return true;

        bibliotheque = finale;
        try { localStorage.setItem(cleStockage(), JSON.stringify(bibliotheque)); } catch (e) {}
        afficherListe();
        if (vueEnEdition()) {
            montrerVue("vue-liste");
            message("Ta collection a été mise à jour depuis ton compte.");
        }
        await nettoyerOrphelines();
        return true;
    }

    // ----- Migration de la collection locale (sans compte) vers le compte -----
    const cleDoublon = (l) => l.Titre.toLowerCase() + "\u0000" + l.Type;

    async function proposerMigration() {
        const p = portee;
        if (!p || migrationsTentees.has(p)) return false;
        migrationsTentees.add(p);
        try {
            if (localStorage.getItem(`migration:${p}`)) return false;
            const locaux = charger("");
            if (!locaux.length) return false;

            const connus = new Set(bibliotheque.map(cleDoublon));
            const nouveaux = locaux.filter(l => !connus.has(cleDoublon(l)));
            if (!nouveaux.length) { localStorage.setItem(`migration:${p}`, "faite"); return false; }

            const place = Math.max(0, LIMITES.livres - bibliotheque.length);
            const aAjouter = nouveaux.slice(0, place);
            if (!aAjouter.length) return false;

            if (!confirm(`Cet appareil contient ${aAjouter.length} livre(s) qui ne sont pas encore dans ton compte. Les ajouter à ton compte ?`)) {
                localStorage.setItem(`migration:${p}`, "refusee");
                message("D'accord. Ces livres restent sur cet appareil et réapparaissent quand tu n'es pas connecté. Pour les ajouter plus tard : Exporter sans compte, puis Importer une fois connecté.");
                return false;
            }

            const idsPris = new Set(bibliotheque.map(l => l.Id));
            for (const l of aAjouter) {
                if (idsPris.has(l.Id)) l.Id = creerId();
                idsPris.add(l.Id);
                for (const id of idsImages([l])) {
                    const blob = await imgGet(id, nomBD(""));
                    if (blob) {
                        await imgPut(id, blob);
                    } else {
                        if (l.Couverture === id) l.Couverture = "";
                        l.Tomes_possedes.forEach(t => { if (t.Image === id) t.Image = ""; });
                    }
                }
                bibliotheque.push(l);
            }
            if (!sauvegarder()) return false;
            afficherListe();
            localStorage.setItem(`migration:${p}`, "faite");

            const ignores = locaux.length - aAjouter.length;
            if (ignores === 0) {
                // tout est maintenant dans le compte : la copie sans compte n'a plus lieu d'être
                localStorage.removeItem("bibliotheque");
                await supprimerBD(nomBD(""));
                message(`${aAjouter.length} livre(s) ajouté(s) à ton compte.`);
            } else {
                message(`${aAjouter.length} livre(s) ajouté(s) à ton compte. ${ignores} déjà présent(s) ou en trop n'ont pas été ajoutés ; la copie d'origine de cet appareil est conservée.`);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // ----- Ménage des images orphelines en ligne (au plus une fois par session, seulement les plus d'une heure) -----
    async function nettoyerStockageCloud() {
        if (stockageNettoye || !portee) return;
        stockageNettoye = true;
        try {
            const p = portee;
            const stockage = client.storage.from(BUCKET);
            const { data, error } = await stockage.list(p, { limit: 1000 });
            if (error || !Array.isArray(data)) return;
            const limite = Date.now() - 3600 * 1000;
            const orphelines = data
                .filter(f => /^[\w-]{1,64}\.jpg$/.test(f.name) && !etat.images.has(f.name.slice(0, -4)) && Date.parse(f.created_at) < limite)
                .map(f => `${p}/${f.name}`)
                .slice(0, 100);
            if (orphelines.length && p === portee) await stockage.remove(orphelines);
        } catch (e) {}
    }

    // ----- Synchronisation complète ou seulement envoi -----
    function planifierRelance() {
        clearTimeout(minuteurRelance);
        const delai = Math.min(300000, 15000 * 2 ** Math.max(0, echecs - 1));
        minuteurRelance = setTimeout(() => { enfiler(() => synchroniser({ tirerAussi: true })).catch(() => {}); }, delai);
    }

    async function synchroniser({ tirerAussi = false, forcer = false } = {}) {
        if (!portee) return;
        const p = portee;
        assurerEtat();
        afficherStatut("Synchronisation…");
        try {
            await pousser();
            if (tirerAussi) {
                // la migration n'a lieu qu'après une lecture complète du compte, pour ne pas créer de doublons
                const lu = await tirer(forcer);
                if (lu && p === portee && await proposerMigration()) await pousser();
            }
            if (p !== portee) return;
            echecs = 0;
            clearTimeout(minuteurRelance);
            if (tirerAussi) derniereSync = Date.now();
            afficherStatut(enAttente().refusesActifs.length ? "Certains livres n'ont pas pu être envoyés" : "À jour");
            if (tirerAussi) await nettoyerStockageCloud();
        } catch (e) {
            if (p !== portee) return;
            echecs++;
            statutEchec();
            planifierRelance();
            throw e;
        }
    }

    // ----- Crochets utilisés par script.js et compte.js -----
    // Appelé après chaque sauvegarde locale : l'envoi est regroupé pour éviter une requête par clic
    globalThis.planifierEnvoi = function () {
        if (!portee) return;
        compteurModifs++;
        afficherStatut("Modifications en attente…");
        clearTimeout(minuteurEnvoi);
        minuteurEnvoi = setTimeout(() => { enfiler(() => synchroniser()).catch(() => {}); }, 700);
    };

    // Image absente de l'appareil : téléchargée depuis le compte, contrôlée, puis gardée en copie locale
    globalThis.telechargerImage = async function (id) {
        const p = portee;
        if (!p || !ID_VALIDE.test(id)) return null;
        const { data, error } = await client.storage.from(BUCKET).download(`${p}/${id}.jpg`);
        if (error || !data || data.size === 0 || data.size > 500000) return null;
        const blob = data.type === "image/jpeg" ? data : new Blob([data], { type: "image/jpeg" });
        try {
            const bitmap = await createImageBitmap(blob); // doit être une vraie image décodable
            if (bitmap.close) bitmap.close();
        } catch (e) {
            return null;
        }
        if (p !== portee) return null;
        await imgPut(id, blob);
        return blob;
    };

    // Avant la déconnexion : on envoie ce qui reste, puis on efface la copie privée de cet appareil
    globalThis.preparerDeconnexion = async function () {
        if (!portee) return true;
        clearTimeout(minuteurEnvoi);
        try { await enfiler(() => synchroniser()); } catch (e) {}
        if (modificationsEnAttente(true)) {
            const ok = confirm("Des modifications n'ont pas encore été envoyées à ton compte (hors ligne ?). Si tu te déconnectes, elles seront perdues. Continuer ?");
            if (!ok) return false;
        }
        const p = portee;
        await supprimerBD(nomBD(p));
        try {
            localStorage.removeItem(cleStockage(p));
            localStorage.removeItem(`synchro:${p}`);
        } catch (e) {}
        return true;
    };

    // ----- Réactions à la connexion / déconnexion -----
    async function surSession(evenement, session) {
        const id = session && session.user ? String(session.user.id).toLowerCase() : "";
        if (!UUID_VALIDE.test(id)) {
            derniereSync = 0;
            if (portee) await changerPortee("");
            afficherStatut("");
            return;
        }
        if (id !== portee) {
            derniereSync = 0; // la limite de fréquence est propre à chaque compte
            await changerPortee(id);
        }
        assurerEtat();
        afficherStatut("Synchronisation…");
        // les connexions répétées (retour sur l'onglet) ne déclenchent pas une synchronisation à chaque fois
        if (evenement === "SIGNED_IN" && Date.now() - derniereSync < 30000) { afficherStatut("À jour"); return; }
        enfiler(() => synchroniser({ tirerAussi: true, forcer: true })).catch(() => {});
    }

    client.auth.onAuthStateChange((evenement, session) => {
        if (evenement === "TOKEN_REFRESHED") return;
        setTimeout(() => { surSession(evenement, session).catch(() => {}); }, 0);
    });

    champ("sync-bouton").addEventListener("click", () => {
        enfiler(() => synchroniser({ tirerAussi: true, forcer: true }))
            .then(() => message("Collection actualisée."))
            .catch(() => message("Synchronisation impossible pour l'instant."));
    });

    window.addEventListener("online", () => {
        if (portee) enfiler(() => synchroniser({ tirerAussi: true })).catch(() => {});
    });

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && portee && Date.now() - derniereSync > 60000) {
            enfiler(() => synchroniser({ tirerAussi: true })).catch(() => {});
        }
    });

    afficherStatut(portee ? "Synchronisation…" : "");
})();