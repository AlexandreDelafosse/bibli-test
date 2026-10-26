// ===== Comptes (Supabase) : inscription, connexion, mot de passe oublié =====
// Tout est affiché avec textContent (jamais innerHTML). La clé utilisée est la clé publique :
// ce sont les règles de sécurité de la base qui protègent les données.
// Partagé avec sync.js (chargé après) ; reste null si les comptes ne sont pas disponibles
let clientSupabase = null;

(function () {
    const barre = champ("barre-compte");

    if (typeof supabase === "undefined" || typeof CONFIG === "undefined") {
        message("Les comptes sont indisponibles pour l'instant. Ta collection locale reste utilisable.");
        return; // la barre de compte reste cachée
    }
    barre.hidden = false;

    const client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_CLE_PUBLIQUE, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    clientSupabase = client;

    const PSEUDO_VALIDE = /^[a-z0-9_]{3,20}$/;
    const EMAIL_VALIDE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const MDP_MIN = 10;
    const MDP_MAX = 72; // limite du chiffrement des mots de passe

    // Ce que chaque mode affiche
    const MODES = {
        connexion: { titre: "Connexion",            bouton: "Se connecter",      email: true,  pseudo: false, mdp: true,  mdp2: false, mdpAuto: "current-password" },
        creation:  { titre: "Créer un compte",      bouton: "Créer mon compte",  email: true,  pseudo: true,  mdp: true,  mdp2: true,  mdpAuto: "new-password" },
        oubli:     { titre: "Mot de passe oublié",  bouton: "Envoyer le lien",   email: true,  pseudo: false, mdp: false, mdp2: false, mdpAuto: "current-password" },
        nouveau:   { titre: "Nouveau mot de passe", bouton: "Enregistrer",       email: false, pseudo: false, mdp: true,  mdp2: true,  mdpAuto: "new-password" }
    };

    let mode = "connexion";
    let occupe = false;
    let compteurProfil = 0;

    const urlRetour = () => location.origin + location.pathname;

    function viderChamps() {
        ["compte-email", "compte-pseudo", "compte-mdp", "compte-mdp2"].forEach(id => { champ(id).value = ""; });
        champ("compte-erreur").textContent = "";
    }

    function changerMode(nouveau) {
        mode = nouveau;
        const m = MODES[mode];
        champ("compte-titre").textContent = m.titre;
        champ("compte-valider").textContent = m.bouton;
        champ("bloc-email").hidden = !m.email;
        champ("bloc-pseudo").hidden = !m.pseudo;
        champ("bloc-mdp").hidden = !m.mdp;
        champ("bloc-mdp2").hidden = !m.mdp2;
        champ("compte-mdp").autocomplete = m.mdpAuto;
        champ("compte-bascule").textContent = mode === "connexion" ? "Créer un compte" : "J'ai déjà un compte";
        champ("compte-bascule").hidden = mode === "nouveau";
        champ("compte-oubli").hidden = mode !== "connexion";
        viderChamps();
    }

    function ouvrirCompte(m) {
        changerMode(m);
        montrerVue("vue-compte");
    }

    function texteErreur(e) {
        if (e instanceof ErreurUtilisateur) return e.message;
        const code = e && e.code;
        if (code === "invalid_credentials") return "E-mail ou mot de passe incorrect.";
        if (code === "email_not_confirmed") return "Adresse e-mail pas encore confirmée : clique sur le lien reçu par e-mail.";
        if (code === "user_already_exists") return "Création impossible. Si tu as déjà un compte, connecte-toi.";
        if (code === "weak_password") return "Mot de passe trop faible. Choisis-en un plus long ou moins courant.";
        if (code === "same_password") return "Choisis un mot de passe différent de l'ancien.";
        if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || (e && e.status === 429)) {
            return "Trop de tentatives. Réessaie dans quelques minutes.";
        }
        if (e && e.name === "AuthRetryableFetchError") return "Serveur injoignable. Vérifie ta connexion.";
        return "Opération impossible. Réessaie.";
    }

    // ----- Lecture et validation des champs -----
    function lireEmail() {
        const email = champ("compte-email").value.trim();
        if (!EMAIL_VALIDE.test(email) || email.length > 254) throw new ErreurUtilisateur("Adresse e-mail invalide.");
        return email;
    }

    function lirePseudo() {
        const pseudo = champ("compte-pseudo").value.trim().toLowerCase();
        if (!PSEUDO_VALIDE.test(pseudo)) {
            throw new ErreurUtilisateur("Pseudo : 3 à 20 caractères, lettres sans accent, chiffres ou _.");
        }
        return pseudo;
    }

    function lireNouveauMdp() {
        const mdp = champ("compte-mdp").value;
        if (mdp.length < MDP_MIN) throw new ErreurUtilisateur(`Le mot de passe doit faire au moins ${MDP_MIN} caractères.`);
        if (mdp.length > MDP_MAX) throw new ErreurUtilisateur(`Le mot de passe ne peut pas dépasser ${MDP_MAX} caractères.`);
        if (mdp !== champ("compte-mdp2").value) throw new ErreurUtilisateur("Les deux mots de passe ne sont pas identiques.");
        return mdp;
    }

    // ----- Actions -----
    async function seConnecter() {
        const email = lireEmail();
        const mdp = champ("compte-mdp").value;
        if (!mdp) throw new ErreurUtilisateur("Entre ton mot de passe.");
        const { error } = await client.auth.signInWithPassword({ email, password: mdp });
        if (error) throw error;
        montrerVue("vue-liste");
        message("Connecté.");
    }

    async function creerCompte() {
        const email = lireEmail();
        const pseudo = lirePseudo();
        const mdp = lireNouveauMdp();

        const { data: libre, error: errPseudo } = await client.rpc("pseudo_disponible", { p: pseudo });
        if (errPseudo) throw errPseudo;
        if (libre !== true) throw new ErreurUtilisateur("Ce pseudo est déjà pris.");

        const { data, error } = await client.auth.signUp({
            email,
            password: mdp,
            options: { data: { pseudo }, emailRedirectTo: urlRetour() }
        });
        if (error) throw error;

        if (data.session) {
            montrerVue("vue-liste");
            message("Compte créé, tu es connecté.");
        } else {
            // Même message que l'adresse soit nouvelle ou déjà connue : on ne révèle pas qui a un compte
            changerMode("connexion");
            message("Presque fini : si l'adresse est valide, un e-mail de confirmation vient d'être envoyé. Clique sur le lien, puis connecte-toi.");
        }
    }

    async function demanderLien() {
        const email = lireEmail();
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: urlRetour() });
        if (error && (error.status === 429 || /rate_limit/.test(error.code || ""))) throw error;
        changerMode("connexion");
        message("Si un compte existe avec cette adresse, un e-mail avec un lien vient d'être envoyé.");
    }

    async function enregistrerMdp() {
        const mdp = lireNouveauMdp();
        const { error } = await client.auth.updateUser({ password: mdp });
        if (error) throw error;
        montrerVue("vue-liste");
        message("Mot de passe modifié.");
    }

    const ACTIONS = { connexion: seConnecter, creation: creerCompte, oubli: demanderLien, nouveau: enregistrerMdp };

    champ("form-compte").addEventListener("submit", async (evenement) => {
        evenement.preventDefault();
        if (occupe) return;
        occupe = true;
        const bouton = champ("compte-valider");
        bouton.disabled = true;
        champ("compte-erreur").textContent = "";
        try {
            await ACTIONS[mode]();
            // les mots de passe ne restent jamais dans la page
            champ("compte-mdp").value = "";
            champ("compte-mdp2").value = "";
        } catch (e) {
            champ("compte-erreur").textContent = texteErreur(e);
            champ("compte-mdp").value = "";
            champ("compte-mdp2").value = "";
        } finally {
            occupe = false;
            bouton.disabled = false;
        }
    });

    champ("compte-bascule").addEventListener("click", () => changerMode(mode === "connexion" ? "creation" : "connexion"));
    champ("compte-oubli").addEventListener("click", () => changerMode("oubli"));
    champ("compte-annuler").addEventListener("click", () => {
        viderChamps();
        montrerVue("vue-liste");
    });

    // ----- Barre d'état en haut de la page -----
    async function majBarre(session) {
        const statut = champ("compte-statut");
        const bouton = champ("compte-bouton");
        const numero = ++compteurProfil;
        if (!session) {
            statut.textContent = "Non connecté";
            bouton.textContent = "Se connecter";
            return;
        }
        statut.textContent = "Connecté";
        bouton.textContent = "Se déconnecter";
        try {
            const { data } = await client.from("profiles").select("pseudo").eq("id", session.user.id).maybeSingle();
            // on ignore la réponse si l'état a changé entre-temps
            if (numero === compteurProfil && data && PSEUDO_VALIDE.test(data.pseudo)) {
                statut.textContent = `Connecté : @${data.pseudo}`;
            }
        } catch (e) {
            // le pseudo reste simplement non affiché
        }
    }

    champ("compte-bouton").addEventListener("click", async () => {
        const { data } = await client.auth.getSession();
        if (!data.session) {
            ouvrirCompte("connexion");
            return;
        }
        // envoie ce qui reste puis efface la copie privée de cet appareil (sync.js) ; l'utilisateur peut annuler
        if (typeof preparerDeconnexion === "function" && !(await preparerDeconnexion())) return;
        // scope "local" : ne déconnecte que cet appareil, pas ton téléphone ou ton PC
        await client.auth.signOut({ scope: "local" });
        montrerVue("vue-liste");
        message("Déconnecté. Ta collection reste dans ton compte ; la copie de cet appareil a été effacée.");
    });

    // La fonction de rappel doit rester légère : le travail se fait après coup (recommandation de Supabase)
    client.auth.onAuthStateChange((evenement, session) => {
        if (evenement === "TOKEN_REFRESHED") return;
        setTimeout(() => {
            majBarre(session);
            if (evenement === "PASSWORD_RECOVERY") ouvrirCompte("nouveau");
        }, 0);
    });

    changerMode("connexion");
})();