// app.js — interface de l’application de révision.
// Règle absolue : tout texte venant des données (leçons, questions…) est affiché
// via textContent / createTextNode. Ce fichier n’utilise JAMAIS innerHTML.

import {
  ajouterLecon, listerLecons, obtenirLecon, modifierLecon, supprimerLecon,
  ajouterQuestions, listerQuestions, supprimerQuestion
} from './db.js';

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------
const DELAI_SERVICE_WORKER_MS = 10000;
const TAILLE_MAX_FICHIER = 2 * 1024 * 1024;

// Mêmes limites que db.js : elles permettent de signaler les erreurs dès l’aperçu de l’import.
const LIMITE_QUESTION = 1000;
const LIMITE_REPONSE = 5000;
const LIMITE_QUESTIONS_PAR_IMPORT = 500;

const NIVEAUX_IMPORTANCE = [
  { valeur: 1, libelle: 'Faible' },
  { valeur: 2, libelle: 'Moyenne' },
  { valeur: 3, libelle: 'Élevée' }
];

// ------------------------------------------------------------
// Éléments fixes de la page
// ------------------------------------------------------------
const racine = document.getElementById('app');
const zoneMessage = document.getElementById('message');
const zoneMaj = document.getElementById('maj');
const zoneVersion = document.getElementById('version-cache');

// ------------------------------------------------------------
// Outils pour construire l’interface (sans innerHTML)
// ------------------------------------------------------------
const PROPRIETES_DIRECTES = new Set(['value', 'checked', 'disabled', 'hidden', 'open']);

// el('div', { class: 'x', onclick: fn }, 'texte', autreElement, [liste d’éléments])
function el(nom, proprietes = {}, ...enfants) {
  const noeud = document.createElement(nom);
  for (const [cle, valeur] of Object.entries(proprietes)) {
    if (valeur === undefined || valeur === null || valeur === false) continue;
    if (cle === 'class') {
      noeud.className = valeur;
    } else if (cle.startsWith('on') && typeof valeur === 'function') {
      noeud.addEventListener(cle.slice(2), valeur);
    } else if (PROPRIETES_DIRECTES.has(cle)) {
      noeud[cle] = valeur;
    } else {
      noeud.setAttribute(cle, valeur === true ? '' : String(valeur));
    }
  }
  ajouterEnfants(noeud, enfants);
  return noeud;
}

function ajouterEnfants(parent, enfants) {
  for (const enfant of enfants) {
    if (enfant === null || enfant === undefined || enfant === false) continue;
    if (Array.isArray(enfant)) {
      ajouterEnfants(parent, enfant);
    } else if (enfant instanceof Node) {
      parent.append(enfant);
    } else {
      parent.append(document.createTextNode(String(enfant)));
    }
  }
}

function pluriel(nombre, singulier, plur) {
  return nombre + ' ' + (nombre > 1 ? plur : singulier);
}

function abreger(texte, max) {
  return texte.length > max ? texte.slice(0, max - 1) + '…' : texte;
}

function formaterDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('fr-FR');
}

function messageErreur(erreur) {
  return erreur && erreur.message ? erreur.message : String(erreur);
}

// ------------------------------------------------------------
// Messages (bandeau en haut de l’écran)
// ------------------------------------------------------------
let minuteurMessage = null;
let messageEnAttente = null; // message à afficher après la prochaine navigation

function effacerMessage() {
  clearTimeout(minuteurMessage);
  zoneMessage.hidden = true;
  zoneMessage.replaceChildren();
}

// type : 'info', 'succes' ou 'erreur' (les erreurs restent affichées jusqu’à « Fermer »)
function afficherMessage(texte, type = 'info') {
  clearTimeout(minuteurMessage);
  zoneMessage.replaceChildren(
    el('p', { class: 'message-texte' }, texte),
    el('button', { type: 'button', class: 'bouton lien', onclick: effacerMessage }, 'Fermer')
  );
  zoneMessage.className = 'message ' + type;
  zoneMessage.setAttribute('role', type === 'erreur' ? 'alert' : 'status');
  zoneMessage.hidden = false;
  if (type === 'succes') {
    minuteurMessage = setTimeout(effacerMessage, 5000);
  }
}

function memoriserMessage(texte, type = 'succes') {
  messageEnAttente = { texte, type };
}

// ------------------------------------------------------------
// Boîte de confirmation
// ------------------------------------------------------------
// Renvoie true si l’utilisateur confirme, false s’il annule (ou appuie sur Retour).
function demanderConfirmation({ titre, message, libelleConfirmer }) {
  return new Promise((resolve) => {
    const boite = el('dialog', { class: 'confirmation', 'aria-labelledby': 'confirmation-titre' },
      el('form', { method: 'dialog' },
        el('h2', { id: 'confirmation-titre' }, titre),
        el('p', {}, message),
        el('div', { class: 'actions' },
          el('button', { class: 'bouton secondaire', value: 'annuler', autofocus: true }, 'Annuler'),
          el('button', { class: 'bouton danger-plein', value: 'ok' }, libelleConfirmer)
        )
      )
    );
    boite.addEventListener('close', () => {
      const confirme = boite.returnValue === 'ok';
      boite.remove();
      resolve(confirme);
    });
    document.body.append(boite);
    boite.showModal();
  });
}

// ------------------------------------------------------------
// Exécution d’une action : bouton bloqué pendant l’opération, erreur affichée en français
// ------------------------------------------------------------
async function executerAction(boutons, travail) {
  const liste = [].concat(boutons).filter(Boolean);
  liste.forEach((bouton) => { bouton.disabled = true; });
  try {
    await travail();
  } catch (erreur) {
    afficherMessage(messageErreur(erreur), 'erreur');
  } finally {
    liste.forEach((bouton) => { bouton.disabled = false; });
  }
}

// ------------------------------------------------------------
// Navigation (adresses de la forme #/lecon/ID ; le bouton Retour d’Android fonctionne)
// ------------------------------------------------------------
let numeroRendu = 0;           // sert à ignorer un écran devenu obsolète
let prochainDefilement = null; // position de défilement à conserver lors d’un rafraîchissement
let defilementConserve = null;

// Change d’écran en remplaçant l’entrée d’historique courante :
// le bouton Retour ne ramène donc pas sur un formulaire déjà validé ou une leçon supprimée.
function aller(destination) {
  location.replace(destination);
}

function lireRoute() {
  const brut = location.hash.replace(/^#\/?/, '');
  return brut.split('/').filter(Boolean).map((partie) => {
    try {
      return decodeURIComponent(partie);
    } catch (erreur) {
      return partie;
    }
  });
}

function afficherEcran(jeton, noeuds) {
  if (jeton !== numeroRendu) return false;
  racine.replaceChildren(...noeuds.filter(Boolean));
  window.scrollTo(0, defilementConserve === null ? 0 : defilementConserve);
  racine.focus({ preventScroll: true });
  return true;
}

function rafraichir() {
  prochainDefilement = window.scrollY;
  return afficherRoute();
}

async function afficherRoute() {
  const jeton = ++numeroRendu;
  defilementConserve = prochainDefilement;
  prochainDefilement = null;

  effacerMessage();
  if (messageEnAttente) {
    afficherMessage(messageEnAttente.texte, messageEnAttente.type);
    messageEnAttente = null;
  }

  const parties = lireRoute();
  try {
    if (parties.length === 0) {
      await ecranListe(jeton);
    } else if (parties.length === 1 && parties[0] === 'nouvelle') {
      await ecranFormulaire(jeton, null);
    } else if (parties.length === 2 && parties[0] === 'lecon') {
      await ecranFiche(jeton, parties[1]);
    } else if (parties.length === 3 && parties[0] === 'lecon' && parties[2] === 'modifier') {
      await ecranFormulaire(jeton, parties[1]);
    } else if (parties.length === 3 && parties[0] === 'lecon' && parties[2] === 'import') {
      await ecranImport(jeton, parties[1]);
    } else {
      afficherEcran(jeton, ecranErreur('Page introuvable', new Error('Cette adresse ne correspond à aucun écran.')));
    }
  } catch (erreur) {
    afficherEcran(jeton, ecranErreur('Impossible d’afficher cet écran', erreur));
  }
}

function ecranErreur(titre, erreur) {
  const introuvable = erreur && erreur.code === 'INTROUVABLE';
  return [
    el('h1', {}, introuvable ? 'Leçon introuvable' : titre),
    el('p', { class: 'discret' }, messageErreur(erreur)),
    el('a', { class: 'bouton', href: '#/' }, 'Retour aux leçons')
  ];
}

// ------------------------------------------------------------
// Écran 1 : liste des leçons
// ------------------------------------------------------------
async function ecranListe(jeton) {
  // listerLecons() renvoie de la plus ancienne à la plus récente : on inverse.
  const lecons = (await listerLecons()).reverse();
  const nombres = await Promise.all(lecons.map(async (lecon) => (await listerQuestions(lecon.id)).length));

  afficherEcran(jeton, [
    el('div', { class: 'titre-ecran' },
      el('h1', {}, 'Leçons'),
      el('a', { class: 'bouton', href: '#/nouvelle' }, 'Ajouter une leçon')
    ),
    lecons.length === 0
      ? el('p', { class: 'vide' }, 'Aucune leçon pour le moment. Ajoute ta première leçon pour commencer.')
      : el('ul', { class: 'liste-lecons' },
        lecons.map((lecon, i) => el('li', {}, carteLecon(lecon, nombres[i])))
      )
  ]);
}

function badgeImportance(valeur) {
  return el('span', { class: 'importance-badge' },
    el('span', { class: 'pips', 'aria-hidden': 'true' },
      [1, 2, 3].map((n) => el('i', { class: n <= valeur ? 'on' : '' }))
    ),
    'Importance ' + valeur + '/3'
  );
}

function carteLecon(lecon, nombreQuestions) {
  return el('a', { class: 'carte-lecon', href: '#/lecon/' + encodeURIComponent(lecon.id) },
    el('span', { class: 'carte-titre' }, lecon.titre),
    el('span', { class: 'carte-meta' },
      el('span', {}, lecon.matiere),
      badgeImportance(lecon.importance),
      el('span', {}, pluriel(nombreQuestions, 'question', 'questions'))
    )
  );
}

// ------------------------------------------------------------
// Écran 2 : formulaire d’ajout / de modification
// ------------------------------------------------------------
async function ecranFormulaire(jeton, idLecon) {
  const lecon = idLecon ? await obtenirLecon(idLecon) : null;
  const toutes = await listerLecons();
  const matieres = [...new Set(toutes.map((l) => l.matiere))].sort((a, b) => a.localeCompare(b, 'fr'));
  const importanceInitiale = lecon ? lecon.importance : 2;
  const retour = lecon ? '#/lecon/' + encodeURIComponent(lecon.id) : '#/';

  const champTitre = el('input', {
    type: 'text', id: 'champ-titre', maxlength: '200', autocomplete: 'off',
    value: lecon ? lecon.titre : ''
  });
  const champMatiere = el('input', {
    type: 'text', id: 'champ-matiere', maxlength: '100', autocomplete: 'off', list: 'liste-matieres',
    value: lecon ? lecon.matiere : ''
  });
  const champTexte = el('textarea', {
    id: 'champ-texte', rows: '14', placeholder: 'Colle ici le texte de la leçon',
    value: lecon ? lecon.texte : ''
  });
  const boutonEnregistrer = el('button', { type: 'submit', class: 'bouton' },
    lecon ? 'Enregistrer les modifications' : 'Ajouter la leçon');

  const groupeImportance = el('fieldset', { class: 'importance' },
    el('legend', {}, 'Importance'),
    el('div', { class: 'choix-importance' },
      NIVEAUX_IMPORTANCE.map((niveau) => el('label', { class: 'choix' },
        el('input', {
          type: 'radio', name: 'importance', value: String(niveau.valeur),
          checked: niveau.valeur === importanceInitiale
        }),
        el('span', { class: 'puce' },
          el('span', { class: 'puce-chiffre' }, String(niveau.valeur)),
          el('span', { class: 'puce-libelle' }, niveau.libelle)
        )
      ))
    )
  );

  const formulaire = el('form', {
    class: 'formulaire', novalidate: true,
    onsubmit: (evenement) => {
      evenement.preventDefault();
      enregistrer();
    }
  },
    el('div', {},
      el('label', { class: 'libelle', for: 'champ-titre' }, 'Titre'),
      champTitre
    ),
    el('div', {},
      el('label', { class: 'libelle', for: 'champ-matiere' }, 'Matière'),
      champMatiere,
      el('datalist', { id: 'liste-matieres' }, matieres.map((m) => el('option', { value: m })))
    ),
    groupeImportance,
    el('div', {},
      el('label', { class: 'libelle', for: 'champ-texte' }, 'Texte de la leçon'),
      champTexte
    ),
    el('div', { class: 'actions' },
      boutonEnregistrer,
      el('a', { class: 'bouton secondaire', href: retour }, 'Annuler')
    )
  );

  function enregistrer() {
    const choisie = formulaire.querySelector('input[name="importance"]:checked');
    const saisie = {
      titre: champTitre.value,
      matiere: champMatiere.value,
      importance: choisie ? Number(choisie.value) : undefined,
      texte: champTexte.value
    };

    return executerAction(boutonEnregistrer, async () => {
      if (!lecon) {
        const creee = await ajouterLecon(saisie);
        memoriserMessage('Leçon ajoutée.');
        aller('#/lecon/' + encodeURIComponent(creee.id));
        return;
      }

      // Modification : on n’envoie que ce qui a réellement changé.
      const changements = {};
      if (saisie.titre.trim() !== lecon.titre) changements.titre = saisie.titre;
      if (saisie.matiere.trim() !== lecon.matiere) changements.matiere = saisie.matiere;
      if (saisie.importance !== lecon.importance) changements.importance = saisie.importance;
      if (saisie.texte !== lecon.texte) changements.texte = saisie.texte;

      if (Object.keys(changements).length === 0) {
        memoriserMessage('Aucune modification à enregistrer.', 'info');
      } else {
        await modifierLecon(lecon.id, changements);
        memoriserMessage('Leçon modifiée.');
      }
      aller(retour);
    });
  }

  afficherEcran(jeton, [
    el('h1', {}, lecon ? 'Modifier la leçon' : 'Ajouter une leçon'),
    formulaire
  ]);
}

// ------------------------------------------------------------
// Écran 3 : fiche d’une leçon
// ------------------------------------------------------------
async function ecranFiche(jeton, id) {
  const lecon = await obtenirLecon(id);
  const questions = await listerQuestions(id);
  const base = '#/lecon/' + encodeURIComponent(id);

  const boutonSupprimer = el('button', { type: 'button', class: 'bouton danger', onclick: supprimerCetteLecon }, 'Supprimer');

  async function supprimerCetteLecon() {
    const nombre = questions.length;
    const suite = nombre === 0 ? '' : nombre === 1 ? ' ainsi que sa question' : ' ainsi que ses ' + nombre + ' questions';
    const confirme = await demanderConfirmation({
      titre: 'Supprimer cette leçon ?',
      message: '« ' + abreger(lecon.titre, 120) + ' » sera supprimée définitivement' + suite + '.',
      libelleConfirmer: 'Supprimer définitivement'
    });
    if (!confirme) return;
    await executerAction(boutonSupprimer, async () => {
      await supprimerLecon(id);
      memoriserMessage('Leçon supprimée.');
      aller('#/');
    });
  }

  afficherEcran(jeton, [
    el('a', { class: 'bouton lien retour', href: '#/' }, '← Toutes les leçons'),
    el('h1', {}, lecon.titre),
    el('p', { class: 'fiche-meta' },
      el('span', {}, lecon.matiere),
      badgeImportance(lecon.importance),
      el('span', {}, 'Créée le ' + formaterDate(lecon.creeLe))
    ),
    el('div', { class: 'actions' },
      el('a', { class: 'bouton secondaire', href: base + '/modifier' }, 'Modifier'),
      el('a', { class: 'bouton secondaire', href: base + '/import' }, 'Importer des questions'),
      boutonSupprimer
    ),
    el('details', { class: 'bloc-texte', open: true },
      el('summary', {}, 'Texte de la leçon'),
      el('div', { class: 'texte-lecon' }, lecon.texte)
    ),
    el('h2', {}, 'Questions (' + questions.length + ')'),
    questions.length === 0
      ? el('p', { class: 'vide' }, 'Aucune question pour l’instant. Utilise « Importer des questions » pour en ajouter.')
      : el('ol', { class: 'liste-questions' }, questions.map((q, i) => carteQuestion(q, i + 1)))
  ]);
}

function carteQuestion(question, numero) {
  const bouton = el('button', {
    type: 'button', class: 'bouton danger',
    'aria-label': 'Supprimer la question ' + numero,
    onclick: supprimer
  }, 'Supprimer');

  async function supprimer() {
    const confirme = await demanderConfirmation({
      titre: 'Supprimer cette question ?',
      message: '« ' + abreger(question.question, 200) + ' »',
      libelleConfirmer: 'Supprimer'
    });
    if (!confirme) return;
    await executerAction(bouton, async () => {
      await supprimerQuestion(question.id);
      memoriserMessage('Question supprimée.');
      await rafraichir();
    });
  }

  return el('li', { class: 'question' },
    el('p', { class: 'q' }, el('span', { class: 'numero' }, numero + '.'), question.question),
    el('p', { class: 'r' }, question.reponse),
    bouton
  );
}

// ------------------------------------------------------------
// Écran 4 : import de questions (fichier .json ou JSON collé)
// ------------------------------------------------------------
async function ecranImport(jeton, id) {
  const lecon = await obtenirLecon(id);
  const existantes = new Set((await listerQuestions(id)).map((q) => normaliser(q.question)));
  const retour = '#/lecon/' + encodeURIComponent(id);
  let pret = null; // questions validées, prêtes à être enregistrées (null tant que rien n’est valide)

  const champJson = el('textarea', {
    id: 'champ-json', class: 'zone-json', rows: '9',
    spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
    placeholder: '{"version":1,"questions":[{"question":"…","reponse":"…"}]}',
    oninput: reinitialiserApercu
  });
  const champFichier = el('input', {
    type: 'file', id: 'champ-fichier', class: 'cache-visuel',
    accept: '.json,application/json', onchange: choisirFichier
  });
  const zoneApercu = el('div', { 'aria-live': 'polite' });
  const boutonVerifier = el('button', { type: 'button', class: 'bouton', onclick: verifier }, 'Vérifier le JSON');

  function reinitialiserApercu() {
    pret = null;
    zoneApercu.replaceChildren();
  }

  function verifier() {
    const resultat = analyserJson(champJson.value, existantes);
    if (resultat.erreurs.length > 0) {
      pret = null;
      zoneApercu.replaceChildren(blocErreurs(resultat.erreurs));
    } else {
      pret = resultat.questions;
      zoneApercu.replaceChildren(blocApercu(resultat));
    }
    zoneApercu.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function choisirFichier() {
    const fichier = champFichier.files && champFichier.files[0];
    if (!fichier) return;
    reinitialiserApercu();
    try {
      if (fichier.size > TAILLE_MAX_FICHIER) {
        zoneApercu.replaceChildren(blocErreurs([
          'Le fichier « ' + abreger(fichier.name, 80) + ' » est trop volumineux (' + Math.round(fichier.size / 1024) + ' Ko ; 2 048 Ko au maximum).'
        ]));
        return;
      }
      let contenu;
      try {
        contenu = await fichier.text();
      } catch (erreur) {
        zoneApercu.replaceChildren(blocErreurs(['Impossible de lire le fichier « ' + abreger(fichier.name, 80) + ' ».']));
        return;
      }
      champJson.value = contenu;
      verifier();
    } finally {
      champFichier.value = ''; // permet de rechoisir le même fichier
    }
  }

  function importer(bouton) {
    if (!pret) return undefined;
    const aImporter = pret;
    return executerAction(bouton, async () => {
      const creees = await ajouterQuestions(id, aImporter);
      memoriserMessage(pluriel(creees.length, 'question importée', 'questions importées') + '.');
      aller(retour);
    });
  }

  function blocErreurs(erreurs) {
    const affichees = erreurs.slice(0, 8);
    return el('div', { class: 'apercu erreur', role: 'alert' },
      el('p', { class: 'apercu-titre' }, 'Import impossible : rien n’a été enregistré.'),
      el('ul', {}, affichees.map((message) => el('li', {}, message))),
      erreurs.length > affichees.length
        ? el('p', { class: 'discret' }, '… et ' + pluriel(erreurs.length - affichees.length, 'autre erreur', 'autres erreurs') + '.')
        : null
    );
  }

  function blocApercu({ questions, doublons }) {
    const nombre = questions.length;
    const bouton = el('button', { type: 'button', class: 'bouton', onclick: () => importer(bouton) },
      nombre === 1 ? 'Importer 1 question' : 'Importer ' + nombre + ' questions');
    return el('div', { class: 'apercu ok' },
      el('p', { class: 'apercu-titre' },
        nombre === 1 ? '1 question valide, prête à être importée.' : nombre + ' questions valides, prêtes à être importées.'),
      doublons > 0
        ? el('p', { class: 'avertissement' },
          doublons === 1
            ? 'Attention : 1 question a le même énoncé qu’une question déjà présente dans cette leçon ; elle sera ajoutée en double.'
            : 'Attention : ' + doublons + ' questions ont le même énoncé que des questions déjà présentes dans cette leçon ; elles seront ajoutées en double.')
        : null,
      el('p', { class: 'discret' }, nombre > 3 ? 'Aperçu des 3 premières :' : 'Aperçu :'),
      el('ol', {}, questions.slice(0, 3).map((q) => el('li', {},
        el('strong', {}, q.question),
        el('span', { class: 'apercu-reponse' }, q.reponse)
      ))),
      nombre > 3 ? el('p', { class: 'discret' }, '… et ' + pluriel(nombre - 3, 'autre question', 'autres questions') + '.') : null,
      bouton
    );
  }

  afficherEcran(jeton, [
    el('a', { class: 'bouton lien retour', href: retour }, '← Retour à la leçon'),
    el('h1', {}, 'Importer des questions'),
    el('p', { class: 'discret' }, 'Leçon : « ' + abreger(lecon.titre, 120) + ' »'),
    el('p', {}, 'Format attendu (les champs « question » et « reponse » sont obligatoires, « reponse » s’écrit sans accent) :'),
    el('pre', { class: 'format' }, '{"version":1,"questions":[{"question":"...","reponse":"..."}]}'),
    el('div', { class: 'import-fichier' },
      champFichier,
      el('label', { class: 'bouton secondaire', for: 'champ-fichier' }, 'Choisir un fichier .json')
    ),
    el('label', { class: 'libelle', for: 'champ-json' }, 'Ou colle le JSON ici'),
    champJson,
    el('div', { class: 'actions' },
      boutonVerifier,
      el('a', { class: 'bouton secondaire', href: retour }, 'Annuler')
    ),
    zoneApercu
  ]);
}

// ------------------------------------------------------------
// Validation stricte de l’import (fonctions pures, sans accès à la page ni à la base)
// ------------------------------------------------------------
function estObjet(valeur) {
  return valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur);
}

function decrireType(valeur) {
  if (valeur === null) return 'null';
  if (Array.isArray(valeur)) return 'une liste';
  switch (typeof valeur) {
    case 'string': return 'un texte';
    case 'number': return 'un nombre';
    case 'boolean': return 'un booléen';
    case 'object': return 'un objet';
    default: return typeof valeur;
  }
}

function normaliser(texte) {
  return texte.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr');
}

// Traduit l’erreur de JSON.parse (anglais, variable selon le navigateur) en message français avec ligne et colonne.
function decrireErreurJson(erreur, texte) {
  const message = String(erreur && erreur.message);
  let lieu = '';
  const parLigne = /line (\d+) column (\d+)/.exec(message);
  const parPosition = /position (\d+)/.exec(message);
  if (parLigne) {
    lieu = ' (erreur vers la ligne ' + parLigne[1] + ', colonne ' + parLigne[2] + ')';
  } else if (parPosition) {
    const position = Number(parPosition[1]);
    const avant = texte.slice(0, position);
    const ligne = avant.split('\n').length;
    const colonne = position - (avant.lastIndexOf('\n') + 1) + 1;
    lieu = ' (erreur vers la ligne ' + ligne + ', colonne ' + colonne + ')';
  }
  const conseil = /[“”]/.test(texte)
    ? ' Le texte contient des guillemets courbes (“ ”) : le JSON n’accepte que les guillemets droits (") autour des textes et des noms de champs.'
    : ' Vérifie les guillemets, les virgules et les accolades.';
  return 'Le texte n’est pas du JSON valide' + lieu + '.' + conseil;
}

// Lit et vérifie un champ texte d’une question ; renvoie le texte nettoyé, ou null en ajoutant une erreur.
function lireTexteImport(element, champ, nom, limite, erreurs) {
  if (!Object.hasOwn(element, champ)) {
    erreurs.push(nom + ' : le champ « ' + champ + ' » est absent.');
    return null;
  }
  const valeur = element[champ];
  if (typeof valeur !== 'string') {
    erreurs.push(nom + ' : « ' + champ + ' » doit être un texte (trouvé : ' + decrireType(valeur) + ').');
    return null;
  }
  const propre = valeur.trim();
  if (propre === '') {
    erreurs.push(nom + ' : « ' + champ + ' » est vide.');
    return null;
  }
  if (propre.length > limite) {
    erreurs.push(nom + ' : « ' + champ + ' » dépasse ' + limite + ' caractères (' + propre.length + ').');
    return null;
  }
  return propre;
}

// Renvoie { erreurs: [...] } si quelque chose est invalide, sinon { erreurs: [], questions, doublons }.
function analyserJson(texteBrut, existantes) {
  const texte = texteBrut.trim();
  if (texte === '') {
    return { erreurs: ['Aucun contenu : choisis un fichier .json ou colle le JSON dans la zone de texte.'] };
  }
  if (texte.startsWith('```')) {
    return { erreurs: ['Le texte commence par des balises de code (```). Copie uniquement le JSON, de « { » jusqu’à « } », sans les balises.'] };
  }

  let donnees;
  try {
    donnees = JSON.parse(texte);
  } catch (erreur) {
    return { erreurs: [decrireErreurJson(erreur, texte)] };
  }

  if (!estObjet(donnees)) {
    return { erreurs: ['Le JSON doit être un objet de la forme {"version":1,"questions":[…]} (trouvé : ' + decrireType(donnees) + ').'] };
  }

  const erreurs = [];
  for (const cle of Object.keys(donnees)) {
    if (cle !== 'version' && cle !== 'questions') {
      erreurs.push('Champ inconnu à la racine : « ' + abreger(cle, 40) + ' » (seuls « version » et « questions » sont autorisés).');
    }
  }
  if (!Object.hasOwn(donnees, 'version')) {
    erreurs.push('Le champ « version » est absent (il doit valoir 1).');
  } else if (donnees.version !== 1) {
    erreurs.push('Le champ « version » doit valoir 1 (valeur trouvée : ' + abreger(JSON.stringify(donnees.version), 40) + ').');
  }

  if (!Object.hasOwn(donnees, 'questions')) {
    erreurs.push('Le champ « questions » est absent.');
    return { erreurs };
  }
  if (!Array.isArray(donnees.questions)) {
    erreurs.push('Le champ « questions » doit être une liste [ … ] (trouvé : ' + decrireType(donnees.questions) + ').');
    return { erreurs };
  }
  if (donnees.questions.length === 0) {
    erreurs.push('La liste « questions » est vide : il faut au moins une question.');
    return { erreurs };
  }
  if (donnees.questions.length > LIMITE_QUESTIONS_PAR_IMPORT) {
    erreurs.push('Trop de questions dans le fichier (' + donnees.questions.length + ' ; ' + LIMITE_QUESTIONS_PAR_IMPORT + ' au maximum par import). Découpe-le en plusieurs fichiers.');
    return { erreurs };
  }

  const questions = [];
  donnees.questions.forEach((element, index) => {
    const nom = 'Question n° ' + (index + 1);
    if (!estObjet(element)) {
      erreurs.push(nom + ' : ce n’est pas un objet {"question":"…","reponse":"…"} (trouvé : ' + decrireType(element) + ').');
      return;
    }
    let champsValides = true;
    for (const cle of Object.keys(element)) {
      if (cle !== 'question' && cle !== 'reponse') {
        erreurs.push(nom + ' : champ inconnu « ' + abreger(cle, 40) + ' » (seuls « question » et « reponse » sont autorisés).');
        champsValides = false;
      }
    }
    const question = lireTexteImport(element, 'question', nom, LIMITE_QUESTION, erreurs);
    const reponse = lireTexteImport(element, 'reponse', nom, LIMITE_REPONSE, erreurs);
    if (champsValides && question !== null && reponse !== null) {
      questions.push({ question, reponse });
    }
  });

  if (erreurs.length > 0) {
    return { erreurs };
  }
  const doublons = questions.filter((q) => existantes.has(normaliser(q.question))).length;
  return { erreurs: [], questions, doublons };
}
// ------------------------------------------------------------
// Fin de la validation de l’import
// ------------------------------------------------------------

// ------------------------------------------------------------
// Service worker (hors ligne) et affichage de la version du cache
// ------------------------------------------------------------
function avecDelai(promesse, ms, message) {
  let minuteur;
  const delai = new Promise((resolve, reject) => {
    minuteur = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}

// Demande au service worker le nom de son cache (sw.js répond au message GET_VERSION).
function demanderVersion(worker) {
  return new Promise((resolve) => {
    if (!worker) {
      resolve(null);
      return;
    }
    const canal = new MessageChannel();
    canal.port1.onmessage = (evenement) => resolve(evenement.data);
    worker.postMessage({ type: 'GET_VERSION' }, [canal.port2]);
    setTimeout(() => resolve(null), 2000);
  });
}

async function actualiserVersion() {
  const registration = await navigator.serviceWorker.ready;
  const cache = await demanderVersion(registration.active);
  zoneVersion.textContent = cache ? 'Version du cache : ' + cache : 'Version du cache : inconnue';
}

function proposerRechargement() {
  zoneMaj.replaceChildren(
    el('p', {}, 'Une nouvelle version de l’application est installée.'),
    el('button', { type: 'button', class: 'bouton', onclick: () => location.reload() }, 'Recharger')
  );
  zoneMaj.hidden = false;
}

async function initialiserServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    zoneVersion.textContent = 'Mode hors ligne indisponible sur cet appareil.';
    return;
  }
  const avaitControleur = Boolean(navigator.serviceWorker.controller);

  // Un nouveau service worker prend le relais : la page affichée est encore l’ancienne, il faut la recharger.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (avaitControleur) proposerRechargement();
    actualiserVersion().catch(() => {});
  });

  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await avecDelai(
      navigator.serviceWorker.ready,
      DELAI_SERVICE_WORKER_MS,
      'Le service worker n’est pas prêt après ' + (DELAI_SERVICE_WORKER_MS / 1000) + ' secondes.'
    );
    await actualiserVersion();
  } catch (erreur) {
    zoneVersion.textContent = 'Mode hors ligne non confirmé : ' + messageErreur(erreur);
  }
}

// ------------------------------------------------------------
// Démarrage
// ------------------------------------------------------------
window.addEventListener('unhandledrejection', (evenement) => {
  afficherMessage('Erreur inattendue : ' + messageErreur(evenement.reason), 'erreur');
});
window.addEventListener('error', (evenement) => {
  afficherMessage('Erreur inattendue : ' + (evenement.message || 'inconnue'), 'erreur');
});
window.addEventListener('hashchange', afficherRoute);

afficherRoute();
initialiserServiceWorker();
