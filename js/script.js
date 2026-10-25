// ===== Réglages =====
const CATEGORIES = ["Manga", "BD", "Comics", "Série", "Livre", "Roman graphique", "Light novel", "Artbook"];
const LIMITES = { titre: 120, auteur: 80, tag: 30, tags: 10, tomes: 999, note: 200, livres: 500 };

// Vide volontairement : ta collection vit uniquement dans ton navigateur, pas dans le dépôt public.
const bibliothequeParDefaut = [];

const champ = (id) => document.getElementById(id);

// ===== Nettoyage et validation des données =====
function nettoyerTexte(valeur, max) {
    return String(valeur ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function creerId() {
    return (crypto.randomUUID && crypto.randomUUID()) || Date.now() + Math.random().toString(36).slice(2);
}

// Point de passage obligé : tout livre (saisi ou relu du stockage) est reconstruit ici, champ par champ.
function nettoyerLivre(brut) {
    if (!brut || typeof brut !== "object") return null;

    const titre = nettoyerTexte(brut.Titre, LIMITES.titre);
    const total = Number.parseInt(brut.Total_tomes, 10);
    if (!titre || !Number.isInteger(total) || total < 1 || total > LIMITES.tomes) return null;

    const tomes = [];
    const vus = new Set();
    for (const t of Array.isArray(brut.Tomes_possedes) ? brut.Tomes_possedes : []) {
        const num = Number.parseInt(t && t.Tome, 10);
        if (!Number.isInteger(num) || num < 1 || num > total || vus.has(num)) continue;
        vus.add(num);
        tomes.push({ Tome: num, Note: nettoyerTexte(t.Note, LIMITES.note) });
    }
    tomes.sort((a, b) => a.Tome - b.Tome);

    const tags = [];
    for (const tag of Array.isArray(brut.Tags) ? brut.Tags : []) {
        const propre = nettoyerTexte(tag, LIMITES.tag);
        const existe = tags.some(x => x.toLowerCase() === propre.toLowerCase());
        if (propre && !existe && tags.length < LIMITES.tags) tags.push(propre);
    }

    return {
        Id: typeof brut.Id === "string" && /^[\w-]{1,64}$/.test(brut.Id) ? brut.Id : creerId(),
        Type: CATEGORIES.includes(brut.Type) ? brut.Type : "Livre",
        Titre: titre,
        Auteur: nettoyerTexte(brut.Auteur, LIMITES.auteur),
        Total_tomes: total,
        Tomes_possedes: tomes,
        Tags: tags
    };
}

// Lit "1-10, 12" et renvoie { tomes: [...] } ou { erreur: "..." }
function lireTomes(texte, total) {
    const saisie = texte.trim();
    if (!saisie) return { tomes: [] };

    const resultat = new Set();
    for (const morceau of saisie.split(",")) {
        const m = morceau.trim();
        let match;
        if ((match = /^(\d{1,3})$/.exec(m))) {
            resultat.add(Number(match[1]));
        } else if ((match = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(m))) {
            const debut = Number(match[1]);
            const fin = Number(match[2]);
            if (debut > fin) return { erreur: `Plage invalide : "${m}"` };
            for (let n = debut; n <= fin; n++) resultat.add(n);
        } else {
            return { erreur: `Format incorrect : "${m}". Exemple : 1-10, 12` };
        }
    }
    for (const n of resultat) {
        if (n < 1 || n > total) return { erreur: `Le tome ${n} est hors de la série (1 à ${total}).` };
    }
    return { tomes: [...resultat].sort((a, b) => a - b) };
}

// ===== Stockage =====
function charger() {
    try {
        const sauvegarde = localStorage.getItem("bibliotheque");
        if (sauvegarde) {
            const donnees = JSON.parse(sauvegarde);
            if (Array.isArray(donnees)) {
                const propres = donnees.map(nettoyerLivre).filter(Boolean);
                // Réécrit les données nettoyées : purge l'ancien champ supprimé des livres déjà enregistrés
                localStorage.setItem("bibliotheque", JSON.stringify(propres));
                return propres;
            }
        }
    } catch (e) {}
    return bibliothequeParDefaut.map(nettoyerLivre).filter(Boolean);
}

let bibliotheque = charger();

function sauvegarder() {
    try { localStorage.setItem("bibliotheque", JSON.stringify(bibliotheque)); } catch (e) {}
}

// ===== Navigation entre les vues =====
function montrerVue(nom) {
    ["vue-liste", "vue-detail", "vue-form"].forEach(id => {
        champ(id).style.display = id === nom ? "block" : "none";
    });
}

// ===== Affichage (uniquement textContent, jamais innerHTML) =====
function creerTags(tags) {
    const zone = document.createElement("p");
    zone.className = "tags";
    for (const tag of tags) {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = tag;
        zone.append(span);
    }
    return zone;
}

function creerCarte(livre) {
    const carte = document.createElement("div");
    carte.className = "livre";

    const titre = document.createElement("h3");
    titre.textContent = livre.Titre;

    const info = document.createElement("p");
    info.textContent = livre.Type + (livre.Auteur ? " · " + livre.Auteur : "");

    const progression = document.createElement("p");
    progression.textContent = `${livre.Tomes_possedes.length} / ${livre.Total_tomes} tomes`;

    carte.append(titre, info, progression);
    if (livre.Tags.length) carte.append(creerTags(livre.Tags));

    carte.addEventListener("click", () => afficherDetail(livre));
    return carte;
}

function afficherListe() {
    const zone = champ("liste-cartes");
    zone.replaceChildren();

    if (bibliotheque.length === 0) {
        const vide = document.createElement("p");
        vide.textContent = "Aucun livre pour l'instant. Ajoute le premier avec le bouton ci-dessus.";
        zone.append(vide);
        return;
    }
    bibliotheque.forEach(livre => zone.append(creerCarte(livre)));
}

let modeClic = "possede"; // "possede" ou "note"

function afficherDetail(livre) {
    const contenu = champ("detail-contenu");
    contenu.replaceChildren();

    const h2 = document.createElement("h2");
    h2.textContent = livre.Titre;

    const info = document.createElement("p");
    info.textContent = livre.Type + (livre.Auteur ? " · " + livre.Auteur : "");

    // Modifier / Supprimer
    const actions = document.createElement("div");
    actions.className = "actions-livre";

    const modifier = document.createElement("button");
    modifier.type = "button";
    modifier.textContent = "Modifier";
    modifier.addEventListener("click", () => ouvrirFormulaire(livre));

    const supprimer = document.createElement("button");
    supprimer.type = "button";
    supprimer.textContent = "Supprimer";
    supprimer.addEventListener("click", () => {
        if (!confirm(`Supprimer « ${livre.Titre} » et ses ${livre.Tomes_possedes.length} tome(s) enregistré(s) ?`)) return;
        bibliotheque = bibliotheque.filter(l => l.Id !== livre.Id);
        sauvegarder();
        afficherListe();
        montrerVue("vue-liste");
    });
    actions.append(modifier, supprimer);

    const resume = document.createElement("p");
    resume.textContent = `${livre.Tomes_possedes.length} tome(s) possédé(s) sur ${livre.Total_tomes}`;

    // Sélecteur de mode
    const modes = document.createElement("div");
    modes.className = "modes";
    [["possede", "Possédé"], ["note", "Note"]].forEach(([valeur, texte]) => {
        const bouton = document.createElement("button");
        bouton.type = "button";
        bouton.textContent = texte;
        if (modeClic === valeur) bouton.classList.add("actif");
        bouton.addEventListener("click", () => { modeClic = valeur; afficherDetail(livre); });
        modes.append(bouton);
    });

    const legende = document.createElement("p");
    legende.className = "legende";
    legende.textContent = "Gris : manquant · Vert : possédé · Point blanc : note";

    // Grille des tomes
    const grille = document.createElement("div");
    grille.className = "grille-tomes";

    for (let i = 1; i <= livre.Total_tomes; i++) {
        const tome = livre.Tomes_possedes.find(t => t.Tome === i);
        const carre = document.createElement("div");
        carre.className = "tome";
        if (!tome) carre.classList.add("manquant");
        if (tome && tome.Note) { carre.classList.add("avec-note"); carre.title = tome.Note; }
        carre.textContent = i;

        carre.addEventListener("click", () => {
            const idx = livre.Tomes_possedes.findIndex(t => t.Tome === i);

            if (modeClic === "possede") {
                if (idx === -1) {
                    livre.Tomes_possedes.push({ Tome: i, Note: "" });
                } else {
                    if (livre.Tomes_possedes[idx].Note && !confirm("Ce tome a une note. Le retirer la supprimera. Continuer ?")) return;
                    livre.Tomes_possedes.splice(idx, 1);
                }
            } else {
                if (idx === -1) return; // on n'annote qu'un tome possédé
                const saisie = prompt(`Note pour le tome ${i} (vide pour l'effacer) :`, livre.Tomes_possedes[idx].Note);
                if (saisie === null) return; // annulé
                livre.Tomes_possedes[idx].Note = nettoyerTexte(saisie, LIMITES.note);
            }

            sauvegarder();
            afficherDetail(livre);
        });
        grille.append(carre);
    }

    contenu.append(h2, info);
    if (livre.Tags.length) contenu.append(creerTags(livre.Tags));
    contenu.append(actions, resume, modes, legende, grille);

    // Liste des notes (lisible aussi sur téléphone, où le survol n'existe pas)
    const avecNotes = livre.Tomes_possedes.filter(t => t.Note);
    if (avecNotes.length) {
        const liste = document.createElement("ul");
        liste.className = "notes";
        avecNotes.forEach(t => {
            const li = document.createElement("li");
            li.textContent = `Tome ${t.Tome} : ${t.Note}`;
            liste.append(li);
        });
        contenu.append(liste);
    }

    montrerVue("vue-detail");
}

// ===== Bouton retour =====
champ("bouton-retour").addEventListener("click", () => {
    afficherListe(); // met à jour les compteurs des cartes
    montrerVue("vue-liste");
});

// ===== Formulaire (ajout et modification) =====
let livreEnEdition = null;

CATEGORIES.forEach(c => {
    const option = document.createElement("option");
    option.value = c;
    option.textContent = c;
    champ("categorie").append(option);
});

function ouvrirFormulaire(livre) {
    livreEnEdition = livre || null;
    champ("form-ajout").reset();
    champ("form-erreur").textContent = "";
    champ("form-titre").textContent = livre ? "Modifier le livre" : "Ajouter un livre";
    champ("form-valider").textContent = livre ? "Enregistrer" : "Ajouter";
    champ("bloc-tomes").style.display = livre ? "none" : "flex"; // en modification, les tomes se gèrent dans la grille

    if (livre) {
        champ("titre").value = livre.Titre;
        champ("auteur").value = livre.Auteur;
        champ("categorie").value = livre.Type;
        champ("total").value = livre.Total_tomes;
        champ("tags").value = livre.Tags.join(", ");
    }
    montrerVue("vue-form");
}

champ("bouton-ajouter").addEventListener("click", () => ouvrirFormulaire());

champ("form-annuler").addEventListener("click", () => {
    if (livreEnEdition) afficherDetail(livreEnEdition);
    else montrerVue("vue-liste");
    livreEnEdition = null;
});

champ("form-ajout").addEventListener("submit", (e) => {
    e.preventDefault();
    const echec = (message) => { champ("form-erreur").textContent = message; };
    echec("");

    if (!livreEnEdition && bibliotheque.length >= LIMITES.livres) {
        return echec(`Limite atteinte : ${LIMITES.livres} livres maximum.`);
    }

    const total = Number.parseInt(champ("total").value, 10);
    if (!Number.isInteger(total) || total < 1 || total > LIMITES.tomes) {
        return echec(`Le nombre de tomes doit être entre 1 et ${LIMITES.tomes}.`);
    }

    let tomesPossedes;
    if (livreEnEdition) {
        const plusGrand = Math.max(0, ...livreEnEdition.Tomes_possedes.map(t => t.Tome));
        if (plusGrand > total) return echec(`Tu possèdes le tome ${plusGrand} : le total ne peut pas être plus petit.`);
        tomesPossedes = livreEnEdition.Tomes_possedes;
    } else {
        const tomes = lireTomes(champ("tomes").value, total);
        if (tomes.erreur) return echec(tomes.erreur);
        tomesPossedes = tomes.tomes.map(n => ({ Tome: n, Note: "" }));
    }

    const tags = champ("tags").value.split(",").map(t => nettoyerTexte(t, LIMITES.tag)).filter(Boolean);
    if (tags.length > LIMITES.tags) return echec(`${LIMITES.tags} tags maximum.`);

    const livre = nettoyerLivre({
        Id: livreEnEdition ? livreEnEdition.Id : undefined,
        Titre: champ("titre").value,
        Auteur: champ("auteur").value,
        Type: champ("categorie").value,
        Total_tomes: total,
        Tomes_possedes: tomesPossedes,
        Tags: tags
    });
    if (!livre) return echec("Titre manquant ou données invalides.");

    const doublon = bibliotheque.some(l => l.Id !== livre.Id && l.Titre.toLowerCase() === livre.Titre.toLowerCase() && l.Type === livre.Type);
    if (doublon) return echec("Ce livre existe déjà dans cette catégorie.");

    if (livreEnEdition) {
        const idx = bibliotheque.findIndex(l => l.Id === livreEnEdition.Id);
        if (idx === -1) return echec("Livre introuvable.");
        bibliotheque[idx] = livre;
        sauvegarder();
        livreEnEdition = null;
        afficherDetail(livre);
    } else {
        bibliotheque.push(livre);
        sauvegarder();
        afficherListe();
        montrerVue("vue-liste");
    }
});

afficherListe();