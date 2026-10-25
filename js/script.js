// ===== Réglages =====
const CATEGORIES = ["Manga", "BD", "Comics", "Série", "Livre", "Roman graphique", "Light novel", "Artbook"];
const LIMITES = { titre: 120, auteur: 80, tag: 30, tags: 10, tomes: 999, note: 200, livres: 500 };
const IMAGE = { maxOctets: 15 * 1024 * 1024, largeur: 300, hauteur: 450, qualite: 0.8, types: ["image/jpeg", "image/png", "image/webp"] };
const IMPORT_MAX_OCTETS = 100 * 1024 * 1024;
const ID_VALIDE = /^[\w-]{1,64}$/;

// Vide volontairement : ta collection vit uniquement dans ton navigateur, pas dans le dépôt public.
const bibliothequeParDefaut = [];

const champ = (id) => document.getElementById(id);

// Erreur dont le message peut être montré tel quel à l'utilisateur
class ErreurUtilisateur extends Error {}

let minuteurMessage = null;
function message(texte) {
    const zone = champ("message");
    zone.textContent = texte;
    zone.hidden = false;
    clearTimeout(minuteurMessage);
    minuteurMessage = setTimeout(() => { zone.hidden = true; }, 7000);
}

// ===== Nettoyage et validation des données =====
function nettoyerTexte(valeur, max) {
    return String(valeur ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function nettoyerId(valeur) {
    return typeof valeur === "string" && ID_VALIDE.test(valeur) ? valeur : "";
}

function creerId() {
    return (crypto.randomUUID && crypto.randomUUID()) || Date.now() + Math.random().toString(36).slice(2);
}

// Point de passage obligé : tout livre (saisi, relu du stockage ou importé) est reconstruit ici, champ par champ.
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
        tomes.push({ Tome: num, Note: nettoyerTexte(t.Note, LIMITES.note), Image: nettoyerId(t.Image) });
    }
    tomes.sort((a, b) => a.Tome - b.Tome);

    const tags = [];
    for (const tag of Array.isArray(brut.Tags) ? brut.Tags : []) {
        const propre = nettoyerTexte(tag, LIMITES.tag);
        const existe = tags.some(x => x.toLowerCase() === propre.toLowerCase());
        if (propre && !existe && tags.length < LIMITES.tags) tags.push(propre);
    }

    return {
        Id: nettoyerId(brut.Id) || creerId(),
        Type: CATEGORIES.includes(brut.Type) ? brut.Type : "Livre",
        Titre: titre,
        Auteur: nettoyerTexte(brut.Auteur, LIMITES.auteur),
        Total_tomes: total,
        Couverture: nettoyerId(brut.Couverture),
        Tomes_possedes: tomes,
        Tags: tags
    };
}

// Garantit que chaque livre et chaque image n'est référencé qu'une seule fois
function fiabiliser(livres) {
    const livresVus = new Set();
    const imagesVues = new Set();
    const garde = (id) => {
        if (!id || imagesVues.has(id)) return "";
        imagesVues.add(id);
        return id;
    };
    livres.forEach(l => {
        if (livresVus.has(l.Id)) l.Id = creerId();
        livresVus.add(l.Id);
        l.Couverture = garde(l.Couverture);
        l.Tomes_possedes.forEach(t => { t.Image = garde(t.Image); });
    });
    return livres;
}

function idsImages(livres) {
    const ids = [];
    livres.forEach(l => {
        if (l.Couverture) ids.push(l.Couverture);
        l.Tomes_possedes.forEach(t => { if (t.Image) ids.push(t.Image); });
    });
    return ids;
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

// ===== Stockage des données (localStorage) =====
function charger() {
    let source = bibliothequeParDefaut;
    let lectureOk = false;
    try {
        const sauvegarde = localStorage.getItem("bibliotheque");
        if (sauvegarde) {
            const donnees = JSON.parse(sauvegarde);
            if (Array.isArray(donnees)) { source = donnees; lectureOk = true; }
        }
    } catch (e) {}
    const livres = fiabiliser(source.slice(0, LIMITES.livres).map(nettoyerLivre).filter(Boolean));
    // Réécrit les données nettoyées (purge les anciens champs supprimés)
    if (lectureOk) { try { localStorage.setItem("bibliotheque", JSON.stringify(livres)); } catch (e) {} }
    return livres;
}

let bibliotheque = charger();

function sauvegarder() {
    try {
        localStorage.setItem("bibliotheque", JSON.stringify(bibliotheque));
        return true;
    } catch (e) {
        message("Sauvegarde impossible : l'espace de stockage du navigateur est plein ou bloqué.");
        return false;
    }
}

// ===== Stockage des images (IndexedDB) =====
let bdPromesse = null;
function ouvrirBD() {
    if (!bdPromesse) {
        bdPromesse = new Promise((ok, ko) => {
            const requete = indexedDB.open("bibliotheque-images", 1);
            requete.onupgradeneeded = () => requete.result.createObjectStore("images");
            requete.onsuccess = () => ok(requete.result);
            requete.onerror = () => ko(requete.error);
        });
    }
    return bdPromesse;
}

async function operation(mode, fonction) {
    const bd = await ouvrirBD();
    return new Promise((ok, ko) => {
        const tx = bd.transaction("images", mode);
        const requete = fonction(tx.objectStore("images"));
        tx.oncomplete = () => ok(requete ? requete.result : undefined);
        tx.onerror = () => ko(tx.error);
        tx.onabort = () => ko(tx.error);
    });
}

const imgPut = (id, blob) => operation("readwrite", s => s.put(blob, id));
const imgGet = (id) => operation("readonly", s => s.get(id));
const imgDelete = (id) => operation("readwrite", s => s.delete(id));
const imgClear = () => operation("readwrite", s => s.clear());
const imgCles = () => operation("readonly", s => s.getAllKeys());

// Adresses temporaires (blob:) des images affichées, créées à la demande
const urlsImages = new Map();

async function urlImage(id) {
    if (!ID_VALIDE.test(id)) return null;
    if (urlsImages.has(id)) return urlsImages.get(id);
    try {
        const blob = await imgGet(id);
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        urlsImages.set(id, url);
        return url;
    } catch (e) {
        return null;
    }
}

function viderUrls() {
    urlsImages.forEach(url => URL.revokeObjectURL(url));
    urlsImages.clear();
}

function oublierImage(id) {
    const url = urlsImages.get(id);
    if (url) { URL.revokeObjectURL(url); urlsImages.delete(id); }
    return imgDelete(id).catch(() => {});
}

// Supprime les images que plus aucun livre ne référence
async function nettoyerOrphelines() {
    try {
        const cles = await imgCles();
        const utiles = new Set(idsImages(bibliotheque));
        for (const cle of cles) if (!utiles.has(cle)) await imgDelete(cle);
    } catch (e) {}
}

// ===== Traitement des images =====
// L'image est décodée puis redessinée dans un canvas et ré-encodée en JPEG réduit :
// seul un vrai JPEG de 300x450 maximum est conservé (métadonnées et contenu exotique disparaissent).
async function traiterImage(fichier) {
    if (!IMAGE.types.includes(fichier.type)) throw new ErreurUtilisateur("Format non accepté (JPEG, PNG ou WebP).");
    if (fichier.size > IMAGE.maxOctets) throw new ErreurUtilisateur("Image trop lourde (15 Mo maximum).");

    let bitmap;
    try {
        bitmap = await createImageBitmap(fichier);
    } catch (e) {
        throw new ErreurUtilisateur("Fichier image illisible.");
    }

    try {
        if (!bitmap.width || !bitmap.height) throw new ErreurUtilisateur("Fichier image illisible.");
        const ratio = Math.min(IMAGE.largeur / bitmap.width, IMAGE.hauteur / bitmap.height, 1);
        const largeur = Math.max(1, Math.round(bitmap.width * ratio));
        const hauteur = Math.max(1, Math.round(bitmap.height * ratio));

        const canvas = document.createElement("canvas");
        canvas.width = largeur;
        canvas.height = hauteur;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; // fond blanc pour les PNG transparents
        ctx.fillRect(0, 0, largeur, hauteur);
        ctx.drawImage(bitmap, 0, 0, largeur, hauteur);

        return await new Promise((ok, ko) => {
            canvas.toBlob(
                b => (b ? ok(b) : ko(new ErreurUtilisateur("Conversion de l'image impossible."))),
                "image/jpeg",
                IMAGE.qualite
            );
        });
    } finally {
        if (bitmap.close) bitmap.close();
    }
}

function blobEnDataUrl(blob) {
    return new Promise((ok, ko) => {
        const lecteur = new FileReader();
        lecteur.onload = () => ok(lecteur.result);
        lecteur.onerror = () => ko(lecteur.error);
        lecteur.readAsDataURL(blob);
    });
}

// Accepte uniquement "data:image/jpeg;base64,..." ; renvoie un Blob ou null
function dataUrlEnBlob(uri) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
    if (!m) return null;
    try {
        const binaire = atob(m[1]);
        const octets = new Uint8Array(binaire.length);
        for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
        return new Blob([octets], { type: "image/jpeg" });
    } catch (e) {
        return null;
    }
}

function choisirFichier(accept, quand) {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    // Le champ reste dans la page jusqu'au choix : sur mobile, un champ détaché peut être supprimé avant d'avoir répondu
    input.style.display = "none";
    input.addEventListener("change", () => {
        const fichier = input.files && input.files[0];
        input.remove();
        if (fichier) quand(fichier);
    });
    document.body.append(input);
    input.click();
}

const choisirImage = (quand) => choisirFichier("image/jpeg,image/png,image/webp", quand);

// Traite et enregistre une image, puis l'associe via appliquer(id), qui renvoie l'ancien identifiant à supprimer
async function ajouterImage(fichier, appliquer, livre) {
    try {
        const blob = await traiterImage(fichier);
        const id = creerId();
        await imgPut(id, blob);
        const ancien = appliquer(id);
        sauvegarder();
        if (ancien) await oublierImage(ancien);
        afficherDetail(livre);
    } catch (e) {
        message(e instanceof ErreurUtilisateur ? e.message : "Impossible d'enregistrer l'image (espace de stockage plein ?).");
    }
}

// ===== Export / import =====
async function exporter() {
    try {
        const images = Object.create(null);
        for (const id of idsImages(bibliotheque)) {
            const blob = await imgGet(id);
            if (blob) images[id] = await blobEnDataUrl(blob);
        }
        const contenu = JSON.stringify({
            format: "bibliotheque",
            version: 2,
            exporte_le: new Date().toISOString(),
            livres: bibliotheque,
            images
        });
        const url = URL.createObjectURL(new Blob([contenu], { type: "application/json" }));
        const lien = document.createElement("a");
        lien.href = url;
        lien.download = `bibliotheque-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(lien);
        lien.click();
        lien.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        message(`Export prêt : ${bibliotheque.length} livre(s), ${Object.keys(images).length} image(s).`);
    } catch (e) {
        message("Export impossible.");
    }
}

async function importer(fichier) {
    try {
        if (fichier.size > IMPORT_MAX_OCTETS) throw new ErreurUtilisateur("Fichier trop volumineux.");

        let donnees;
        try {
            donnees = JSON.parse(await fichier.text());
        } catch (e) {
            throw new ErreurUtilisateur("Ce fichier n'est pas un export valide.");
        }
        if (!donnees || donnees.format !== "bibliotheque" || !Array.isArray(donnees.livres)) {
            throw new ErreurUtilisateur("Ce fichier n'est pas un export de bibliothèque.");
        }
        if (donnees.livres.length > LIMITES.livres) {
            throw new ErreurUtilisateur(`Trop de livres dans ce fichier (${LIMITES.livres} maximum).`);
        }

        // 1. Les livres repassent par la même validation que la saisie
        const livres = fiabiliser(donnees.livres.map(nettoyerLivre).filter(Boolean));

        // 2. Chaque image est contrôlée puis redessinée comme une image ajoutée à la main
        const sources = donnees.images && typeof donnees.images === "object" ? donnees.images : {};
        const images = new Map();
        let ignorees = 0;
        for (const id of idsImages(livres)) {
            try {
                const uri = Object.prototype.hasOwnProperty.call(sources, id) ? sources[id] : null;
                const brut = typeof uri === "string" && uri.length <= 2000000 ? dataUrlEnBlob(uri) : null;
                if (!brut) throw new Error("image absente ou invalide");
                images.set(id, await traiterImage(brut));
            } catch (e) {
                ignorees++;
            }
        }
        livres.forEach(l => {
            if (l.Couverture && !images.has(l.Couverture)) l.Couverture = "";
            l.Tomes_possedes.forEach(t => { if (t.Image && !images.has(t.Image)) t.Image = ""; });
        });

        const question = `Remplacer ta collection actuelle (${bibliotheque.length} livre(s)) par celle du fichier (${livres.length} livre(s), ${images.size} image(s)) ? Cette action est définitive.`;
        if (!confirm(question)) return;

        await imgClear();
        for (const [id, blob] of images) await imgPut(id, blob);
        viderUrls();
        bibliotheque = livres;
        sauvegarder();
        afficherListe();
        montrerVue("vue-liste");
        message(`Import terminé : ${livres.length} livre(s), ${images.size} image(s)` + (ignorees ? `, ${ignorees} image(s) ignorée(s) car invalides.` : "."));
    } catch (e) {
        message(e instanceof ErreurUtilisateur ? e.message : "Import impossible.");
    }
}

// ===== Navigation entre les vues =====
function montrerVue(nom) {
    ["vue-liste", "vue-detail", "vue-form"].forEach(id => {
        champ(id).style.display = id === nom ? "block" : "none";
    });
}

// ===== Éléments d'affichage (uniquement textContent, jamais innerHTML) =====
function creerBouton(texte, action) {
    const bouton = document.createElement("button");
    bouton.type = "button";
    bouton.textContent = texte;
    bouton.addEventListener("click", action);
    return bouton;
}

function creerImage(id, alt, classe) {
    const img = document.createElement("img");
    img.className = classe;
    img.alt = alt;
    urlImage(id).then(url => {
        if (url) img.src = url;
        else img.hidden = true;
    });
    return img;
}

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

let modeClic = "possede"; // "possede", "note" ou "image"
let tomeActif = null;     // tome sélectionné en mode image

function creerCarte(livre) {
    const carte = document.createElement("div");
    carte.className = "livre";

    // Couverture de la série, sinon jaquette du premier tome qui en a une
    const premier = livre.Tomes_possedes.find(t => t.Image);
    const idVignette = livre.Couverture || (premier ? premier.Image : "");
    if (idVignette) carte.append(creerImage(idVignette, `Couverture de ${livre.Titre}`, "vignette"));

    const texte = document.createElement("div");

    const titre = document.createElement("h3");
    titre.textContent = livre.Titre;

    const info = document.createElement("p");
    info.textContent = livre.Type + (livre.Auteur ? " · " + livre.Auteur : "");

    const progression = document.createElement("p");
    progression.textContent = `${livre.Tomes_possedes.length} / ${livre.Total_tomes} tomes`;

    texte.append(titre, info, progression);
    if (livre.Tags.length) texte.append(creerTags(livre.Tags));
    carte.append(texte);

    carte.addEventListener("click", () => {
        tomeActif = null;
        afficherDetail(livre);
    });
    return carte;
}

// ===== Filtres et recherche =====
const filtres = { texte: "", categorie: "", tags: new Set() };

function normaliser(s) {
    return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function livresFiltres() {
    const q = normaliser(filtres.texte);
    return bibliotheque.filter(l => {
        if (filtres.categorie && l.Type !== filtres.categorie) return false;
        if (q && !normaliser(l.Titre + " " + l.Auteur).includes(q)) return false;
        const tagsDuLivre = l.Tags.map(normaliser);
        for (const cle of filtres.tags) if (!tagsDuLivre.includes(cle)) return false;
        return true;
    });
}

function afficherFiltreTags() {
    const zone = champ("filtre-tags");
    zone.replaceChildren();

    const dispo = new Map(); // clé normalisée -> libellé affiché
    bibliotheque.forEach(l => l.Tags.forEach(t => {
        if (!dispo.has(normaliser(t))) dispo.set(normaliser(t), t);
    }));
    for (const cle of [...filtres.tags]) if (!dispo.has(cle)) filtres.tags.delete(cle); // tag disparu

    [...dispo].sort((a, b) => a[1].localeCompare(b[1], "fr")).forEach(([cle, libelle]) => {
        const puce = document.createElement("button");
        puce.type = "button";
        puce.className = "chip" + (filtres.tags.has(cle) ? " actif" : "");
        puce.textContent = libelle;
        puce.addEventListener("click", () => {
            if (filtres.tags.has(cle)) filtres.tags.delete(cle);
            else filtres.tags.add(cle);
            afficherListe();
        });
        zone.append(puce);
    });
}

function afficherListe() {
    afficherFiltreTags();

    const zone = champ("liste-cartes");
    zone.replaceChildren();

    const resultats = livresFiltres();
    const filtreActif = Boolean(filtres.texte || filtres.categorie || filtres.tags.size);
    champ("compteur").textContent = bibliotheque.length ? `${resultats.length} / ${bibliotheque.length} livre(s)` : "";
    champ("filtre-reset").style.display = filtreActif ? "inline-block" : "none";

    if (resultats.length === 0) {
        const vide = document.createElement("p");
        vide.textContent = bibliotheque.length === 0
            ? "Aucun livre pour l'instant. Ajoute le premier avec le bouton ci-dessus."
            : "Aucun résultat avec ces filtres.";
        zone.append(vide);
        return;
    }
    resultats.forEach(livre => zone.append(creerCarte(livre)));
}

[["", "Toutes les catégories"], ...CATEGORIES.map(c => [c, c])].forEach(([valeur, texte]) => {
    const option = document.createElement("option");
    option.value = valeur;
    option.textContent = texte;
    champ("filtre-categorie").append(option);
});

champ("recherche").addEventListener("input", (e) => {
    filtres.texte = nettoyerTexte(e.target.value, 100);
    afficherListe();
});

champ("filtre-categorie").addEventListener("change", (e) => {
    filtres.categorie = CATEGORIES.includes(e.target.value) ? e.target.value : "";
    afficherListe();
});

champ("filtre-reset").addEventListener("click", () => {
    filtres.texte = "";
    filtres.categorie = "";
    filtres.tags.clear();
    champ("recherche").value = "";
    champ("filtre-categorie").value = "";
    afficherListe();
});

// ===== Fiche d'un livre =====
function afficherDetail(livre) {
    const contenu = champ("detail-contenu");
    contenu.replaceChildren();

    // En-tête : couverture, titre, auteur, tags
    const entete = document.createElement("div");
    entete.className = "entete";
    if (livre.Couverture) entete.append(creerImage(livre.Couverture, `Couverture de ${livre.Titre}`, "couverture"));

    const identite = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = livre.Titre;
    const info = document.createElement("p");
    info.textContent = livre.Type + (livre.Auteur ? " · " + livre.Auteur : "");
    identite.append(h2, info);
    if (livre.Tags.length) identite.append(creerTags(livre.Tags));
    entete.append(identite);

    // Actions sur le livre
    const actions = document.createElement("div");
    actions.className = "actions-livre";
    actions.append(
        creerBouton("Modifier", () => ouvrirFormulaire(livre)),
        creerBouton("Supprimer", () => {
            if (!confirm(`Supprimer « ${livre.Titre} » et ses ${livre.Tomes_possedes.length} tome(s) enregistré(s) ?`)) return;
            const ids = idsImages([livre]);
            bibliotheque = bibliotheque.filter(l => l.Id !== livre.Id);
            sauvegarder();
            ids.forEach(oublierImage);
            afficherListe();
            montrerVue("vue-liste");
        }),
        creerBouton(livre.Couverture ? "Changer la couverture" : "Ajouter une couverture", () => {
            choisirImage(fichier => ajouterImage(fichier, (id) => {
                const ancien = livre.Couverture;
                livre.Couverture = id;
                return ancien;
            }, livre));
        })
    );
    if (livre.Couverture) {
        actions.append(creerBouton("Retirer la couverture", async () => {
            const ancien = livre.Couverture;
            livre.Couverture = "";
            sauvegarder();
            await oublierImage(ancien);
            afficherDetail(livre);
        }));
    }

    const resume = document.createElement("p");
    resume.textContent = `${livre.Tomes_possedes.length} tome(s) possédé(s) sur ${livre.Total_tomes}`;

    // Sélecteur de mode
    const modes = document.createElement("div");
    modes.className = "modes";
    [["possede", "Possédé"], ["note", "Note"], ["image", "Image"]].forEach(([valeur, texte]) => {
        const bouton = creerBouton(texte, () => {
            modeClic = valeur;
            tomeActif = null;
            afficherDetail(livre);
        });
        if (modeClic === valeur) bouton.classList.add("actif");
        modes.append(bouton);
    });

    const legende = document.createElement("p");
    legende.className = "legende";
    legende.textContent = modeClic === "image"
        ? "Mode Image : clique sur un tome que tu possèdes pour lui ajouter une jaquette."
        : "Gris : manquant · Vert ou jaquette : possédé · Point blanc : note";

    // Grille des tomes
    const grille = document.createElement("div");
    grille.className = "grille-tomes";

    for (let i = 1; i <= livre.Total_tomes; i++) {
        const tome = livre.Tomes_possedes.find(t => t.Tome === i);
        const carre = document.createElement("div");
        carre.className = "tome";
        if (!tome) carre.classList.add("manquant");
        if (tome && tome.Note) { carre.classList.add("avec-note"); carre.title = tome.Note; }
        if (tome && tome.Image) {
            carre.classList.add("avec-image");
            carre.append(creerImage(tome.Image, `Tome ${i}`, ""));
        }
        if (modeClic === "image" && tomeActif === i) carre.classList.add("selectionne");

        const numero = document.createElement("span");
        numero.className = "num";
        numero.textContent = i;
        carre.append(numero);

        carre.addEventListener("click", () => {
            const idx = livre.Tomes_possedes.findIndex(t => t.Tome === i);

            if (modeClic === "image") {
                if (idx === -1) return; // on n'ajoute une image qu'à un tome possédé
                tomeActif = i;
                afficherDetail(livre);
                return;
            }

            if (modeClic === "possede") {
                if (idx === -1) {
                    livre.Tomes_possedes.push({ Tome: i, Note: "", Image: "" });
                } else {
                    const t = livre.Tomes_possedes[idx];
                    if ((t.Note || t.Image) && !confirm("Ce tome a une note ou une image. Le retirer les supprimera. Continuer ?")) return;
                    if (t.Image) oublierImage(t.Image);
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

    contenu.append(entete, actions, resume, modes, legende);

    // Panneau d'image du tome sélectionné
    if (modeClic === "image" && tomeActif !== null) {
        const t = livre.Tomes_possedes.find(x => x.Tome === tomeActif);
        if (t) {
            const panneau = document.createElement("div");
            panneau.className = "panneau-image";
            const titre = document.createElement("strong");
            titre.textContent = `Tome ${t.Tome}`;
            panneau.append(
                titre,
                creerBouton(t.Image ? "Changer l'image" : "Ajouter une image", () => {
                    choisirImage(fichier => ajouterImage(fichier, (id) => {
                        const ancien = t.Image;
                        t.Image = id;
                        return ancien;
                    }, livre));
                })
            );
            if (t.Image) {
                panneau.append(creerBouton("Retirer l'image", async () => {
                    const ancien = t.Image;
                    t.Image = "";
                    sauvegarder();
                    await oublierImage(ancien);
                    afficherDetail(livre);
                }));
            }
            panneau.append(creerBouton("Fermer", () => {
                tomeActif = null;
                afficherDetail(livre);
            }));
            contenu.append(panneau);
        }
    }

    contenu.append(grille);

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
    afficherListe(); // met à jour les compteurs et vignettes des cartes
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
    const echec = (texte) => { champ("form-erreur").textContent = texte; };
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
        tomesPossedes = tomes.tomes.map(n => ({ Tome: n, Note: "", Image: "" }));
    }

    const tags = champ("tags").value.split(",").map(t => nettoyerTexte(t, LIMITES.tag)).filter(Boolean);
    if (tags.length > LIMITES.tags) return echec(`${LIMITES.tags} tags maximum.`);

    const livre = nettoyerLivre({
        Id: livreEnEdition ? livreEnEdition.Id : undefined,
        Titre: champ("titre").value,
        Auteur: champ("auteur").value,
        Type: champ("categorie").value,
        Total_tomes: total,
        Couverture: livreEnEdition ? livreEnEdition.Couverture : "",
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

// ===== Boutons Exporter / Importer =====
champ("bouton-exporter").addEventListener("click", exporter);
champ("bouton-importer").addEventListener("click", () => choisirFichier("", importer));

// ===== Démarrage =====
afficherListe();
nettoyerOrphelines();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});