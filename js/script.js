const bibliotheque = [
    {
    Type: "Manga",
    Titre: "Berserk",
    Auteur: "Kentaro Miura",
    Total_tomes: 43,
    Tomes_possedes: [
        { Tome: 1, Lu: true, Note: "pas mal" },
        { Tome: 3, Lu: true, Note: "bien" },
    ]
    
},    
{
    Type: "Manga",
    Titre: "Green Blood",
    Auteur: "Masasumi Kakizaki",
    Total_tomes: 5,
        Tomes_possedes: [
        { Tome: 1, Lu: true, Note: "test11" },
        { Tome: 2, Lu: true, Note: "test22" },
    ]
    
},
{
    Type: "Manga",
    Titre: "One Piece",
    Auteur: "Eiichiro Oda",
    Total_tomes: 105,
        Tomes_possedes: [
        { Tome: 1, Lu: true, Note: "test111" },
    ]
},

];


const container = document.getElementById("vue-liste");

bibliotheque.forEach((livre) => {

    const div = document.createElement("div");
    div.className = "livre";

    const titre_livre = document.createElement("dl");
    const titre = document.createElement("dt");
    titre.textContent = livre.Titre;
    const auteur = document.createElement("dd");
    auteur.textContent = `Auteur: ${livre.Auteur}`;
    const dernier_tome = document.createElement("dd");
    dernier_tome.textContent = `Dernier tome: ${livre.Total_tomes}`;

    const tomes_possedes = document.createElement("dd");
    if (livre.Tomes_possedes) {
        const tomesList = livre.Tomes_possedes.map(tome => `Tome ${tome.Tome} - Lu: ${tome.Lu ? "Oui" : "Non"} - Note: ${tome.Note}`).join(", ");       
        tomes_possedes.textContent = `Tomes possédés: ${tomesList}`;
    }

    div.appendChild(titre_livre);
    container.appendChild(div);

    titre_livre.appendChild(titre);
    titre_livre.appendChild(auteur);
    titre_livre.appendChild(dernier_tome);
    titre_livre.appendChild(tomes_possedes);

    div.addEventListener("click", () => afficherDetail(livre));





});

// btn de retour entre page principal et manga précis

    const backButton = document.getElementById("bouton-retour");
    backButton.addEventListener("click", () => {
        document.getElementById("vue-detail").style.display = "none";
        document.getElementById("vue-liste").style.display = "block";
        document.getElementById("detail-contenu").innerHTML = "";
    
    });

    
function afficherDetail(livre) {
    const contenu = document.getElementById("detail-contenu");
    contenu.innerHTML = ""; // on repart d'une zone vide à chaque ouverture

    const h2 = document.createElement("h2");
    h2.textContent = livre.Titre;

    const auteur = document.createElement("p");
    auteur.textContent = `Auteur : ${livre.Auteur}`;

    const possedes = livre.Tomes_possedes || []; // évite une erreur si le champ manque
    const resume = document.createElement("p");
    resume.textContent = `${possedes.length} tome(s) possédé(s) sur ${livre.Total_tomes}`;

    const grille = document.createElement("div");
    grille.className = "grille-tomes";

    for (let i = 1; i <= livre.Total_tomes; i++) {
        const tome = possedes.find(t => t.Tome === i);
        const carre = document.createElement("div");
        carre.className = "tome";
        if (!tome) carre.classList.add("manquant");
        else if (!tome.Lu) carre.classList.add("non-lu");
        carre.textContent = i;
        if (tome && tome.Note) carre.title = tome.Note; // la note s'affiche au survol
        grille.appendChild(carre);
    }

    contenu.append(h2, auteur, resume, grille);

    document.getElementById("vue-liste").style.display = "none";
    document.getElementById("vue-detail").style.display = "block";
}