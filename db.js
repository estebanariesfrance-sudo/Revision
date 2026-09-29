// db.js — module de données de l’application de révision (IndexedDB).
// Aucune interface ici : ce fichier ne touche jamais à la page.
// Utilisation : import { ajouterLecon, listerLecons } from './db.js';

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------
const NOM_BASE_PRINCIPALE = 'revision-db';
const PREFIXE_BASES = 'revision-'; // évite les collisions avec d’autres sites du même compte GitHub Pages

export const VERSION_SCHEMA = 1;

const STORE_LECONS = 'lecons';
const STORE_QUESTIONS = 'questions';

const IMPORTANCE_MIN = 1;
const IMPORTANCE_MAX = 3;
const BOITE_DEPART = 1;

const LONGUEUR_MAX_TITRE = 200;
const LONGUEUR_MAX_MATIERE = 100;
const LONGUEUR_MAX_TEXTE = 500000;
const LONGUEUR_MAX_SYNTHESE = 100000;
const LONGUEUR_MAX_QUESTION = 1000;
const LONGUEUR_MAX_REPONSE = 5000;
const NOMBRE_MAX_QUESTIONS_PAR_AJOUT = 500;

const CHAMPS_SAISIE_LECON = ['titre', 'matiere', 'importance', 'texte'];
const CHAMPS_MODIFIABLES_LECON = ['titre', 'matiere', 'importance', 'texte', 'synthese'];
const CHAMPS_SAISIE_QUESTION = ['question', 'reponse'];

// ------------------------------------------------------------
// État interne du module
// ------------------------------------------------------------
let nomBase = NOM_BASE_PRINCIPALE;
let connexion = null;   // promesse de la connexion en cours (ou null)
let baseOuverte = null; // la base IndexedDB réellement ouverte (ou null)
let compteurId = 0;

// ------------------------------------------------------------
// Erreurs
// ------------------------------------------------------------
// code : 'VALIDATION' (valeur refusée), 'INTROUVABLE' (élément absent) ou 'BASE' (problème technique)
export class ErreurRevision extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ErreurRevision';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function erreurValidation(message) {
  return new ErreurRevision('VALIDATION', message);
}

function erreurIntrouvable(message) {
  return new ErreurRevision('INTROUVABLE', message);
}

function traduireErreur(erreur, action) {
  if (erreur instanceof ErreurRevision) return erreur;
  if (erreur && erreur.name === 'QuotaExceededError') {
    return new ErreurRevision('BASE', `${action} : l’espace de stockage de l’appareil est plein.`, erreur);
  }
  const detail = erreur && erreur.message ? erreur.message : String(erreur);
  return new ErreurRevision('BASE', `${action} : erreur de la base de données (${detail}).`, erreur);
}

async function executer(action, travail) {
  try {
    return await travail();
  } catch (erreur) {
    throw traduireErreur(erreur, action);
  }
}

// ------------------------------------------------------------
// Dates
// ------------------------------------------------------------
// Renvoie le jour dans le fuseau de l’appareil, au format « AAAA-MM-JJ ».
// On n’utilise JAMAIS toISOString() pour cela : il donne la date UTC,
// qui peut être celle de la veille ou du lendemain selon l’heure.
export function dateLocale(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw erreurValidation('dateLocale : la date fournie n’est pas valide.');
  }
  const annee = String(date.getFullYear()).padStart(4, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  const jour = String(date.getDate()).padStart(2, '0');
  return `${annee}-${mois}-${jour}`;
}

// Un « moment » précis (création, modification) : ISO 8601 en UTC.
// Ce n’est PAS une date de révision.
function horodatage() {
  return new Date().toISOString();
}

// ------------------------------------------------------------
// Identifiants
// ------------------------------------------------------------
// Identifiant unique qui se trie dans l’ordre de création :
// temps (base 36) + compteur + partie aléatoire.
// IndexedDB renvoie les éléments triés par identifiant, donc dans l’ordre de création.
function genererId() {
  compteurId = (compteurId + 1) % 1679616; // 36^4
  const temps = Date.now().toString(36).padStart(9, '0');
  const rang = compteurId.toString(36).padStart(4, '0');
  const alea = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(7, '0');
  return `${temps}-${rang}-${alea}`;
}

// ------------------------------------------------------------
// Validation des entrées
// ------------------------------------------------------------
function estObjetSimple(valeur) {
  return valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur);
}

function verifierChamps(objet, contexte, autorises, obligatoires = []) {
  if (!estObjetSimple(objet)) {
    throw erreurValidation(`${contexte} : un objet est attendu.`);
  }
  for (const cle of Object.keys(objet)) {
    if (!autorises.includes(cle)) {
      throw erreurValidation(`${contexte} : le champ « ${cle} » n’existe pas ou ne peut pas être fourni ici.`);
    }
  }
  for (const cle of obligatoires) {
    if (!Object.hasOwn(objet, cle)) {
      throw erreurValidation(`${contexte} : le champ « ${cle} » est obligatoire.`);
    }
  }
}

function validerTexte(valeur, libelle, { max, rogner = true }) {
  if (typeof valeur !== 'string') {
    throw erreurValidation(`${libelle} doit être un texte.`);
  }
  if (valeur.trim() === '') {
    throw erreurValidation(`${libelle} ne peut pas être vide.`);
  }
  const resultat = rogner ? valeur.trim() : valeur;
  if (resultat.length > max) {
    throw erreurValidation(`${libelle} dépasse la longueur maximale autorisée (${max} caractères).`);
  }
  return resultat;
}

function validerImportance(valeur) {
  if (!Number.isInteger(valeur) || valeur < IMPORTANCE_MIN || valeur > IMPORTANCE_MAX) {
    throw erreurValidation(`L’importance doit être un nombre entier entre ${IMPORTANCE_MIN} et ${IMPORTANCE_MAX}.`);
  }
  return valeur;
}

function validerId(valeur, libelle) {
  if (typeof valeur !== 'string' || valeur.trim() === '') {
    throw erreurValidation(`${libelle} doit être un texte non vide.`);
  }
  return valeur;
}

function validerChampLecon(cle, valeur) {
  switch (cle) {
    case 'titre':
      return validerTexte(valeur, 'Le titre', { max: LONGUEUR_MAX_TITRE });
    case 'matiere':
      return validerTexte(valeur, 'La matière', { max: LONGUEUR_MAX_MATIERE });
    case 'importance':
      return validerImportance(valeur);
    case 'texte':
      return validerTexte(valeur, 'Le texte de la leçon', { max: LONGUEUR_MAX_TEXTE, rogner: false });
    case 'synthese':
      if (valeur === null) return null;
      return validerTexte(valeur, 'La synthèse (ou null pour l’effacer)', { max: LONGUEUR_MAX_SYNTHESE, rogner: false });
    default:
      throw erreurValidation(`Le champ « ${cle} » n’existe pas.`);
  }
}

// ------------------------------------------------------------
// Outils IndexedDB
// ------------------------------------------------------------
// Transforme une requête IndexedDB en promesse.
function demande(requete) {
  return new Promise((resolve, reject) => {
    requete.onsuccess = () => resolve(requete.result);
    requete.onerror = () => reject(requete.error);
  });
}

// Promesse qui se termine quand la transaction est réellement enregistrée (ou échoue).
function suivre(transaction) {
  const fin = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = (evenement) => {
      reject((evenement.target && evenement.target.error) || transaction.error);
    };
    transaction.onabort = () => {
      reject(transaction.error || new Error('Transaction annulée'));
    };
  });
  fin.catch(() => {}); // évite un avertissement si on quitte la fonction avant d’attendre "fin"
  return fin;
}

// Schéma : c’est ici qu’on ajoutera les futures migrations.
// Chaque bloc "if (ancienneVersion < N)" ne s’exécute qu’une fois, pour les appareils qui n’ont pas encore la version N.
// Exemple pour plus tard :
//   if (ancienneVersion < 2) {
//     transaction.objectStore(STORE_QUESTIONS).createIndex('boite', 'boite', { unique: false });
//   }
// (il faudra alors passer VERSION_SCHEMA à 2)
function migrer(db, transaction, ancienneVersion) {
  if (ancienneVersion < 1) {
    db.createObjectStore(STORE_LECONS, { keyPath: 'id' });

    const questions = db.createObjectStore(STORE_QUESTIONS, { keyPath: 'id' });
    questions.createIndex('leconId', 'leconId', { unique: false });
    questions.createIndex('prochaineRevision', 'prochaineRevision', { unique: false });
  }
}

function ouvrirBase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new ErreurRevision('BASE', 'IndexedDB n’est pas disponible sur cet appareil ou dans ce mode de navigation.'));
      return;
    }
    const nom = nomBase;
    const requete = indexedDB.open(nom, VERSION_SCHEMA);

    requete.onupgradeneeded = (evenement) => {
      migrer(requete.result, requete.transaction, evenement.oldVersion);
    };
    requete.onsuccess = () => {
      const db = requete.result;
      // Un autre onglet veut mettre la base à jour : on libère la connexion pour ne pas le bloquer.
      db.onversionchange = () => {
        db.close();
        if (baseOuverte === db) {
          baseOuverte = null;
          connexion = null;
        }
      };
      // Le navigateur a fermé la base de lui-même : la prochaine opération la rouvrira.
      db.onclose = () => {
        if (baseOuverte === db) {
          baseOuverte = null;
          connexion = null;
        }
      };
      baseOuverte = db;
      resolve(db);
    };
    requete.onerror = () => {
      const detail = requete.error && requete.error.message ? requete.error.message : 'raison inconnue';
      reject(new ErreurRevision('BASE', `Ouverture de la base « ${nom} » impossible (${detail}).`, requete.error));
    };
    requete.onblocked = () => {
      console.warn(`La base « ${nom} » est bloquée par un autre onglet ouvert : ferme les autres onglets de l’application.`);
    };
  });
}

function obtenirConnexion() {
  if (!connexion) {
    const promesse = ouvrirBase();
    connexion = promesse;
    promesse.catch(() => {
      if (connexion === promesse) connexion = null; // permet de réessayer plus tard
    });
  }
  return connexion;
}

function verifierNomBase(nom) {
  if (typeof nom !== 'string' || !nom.startsWith(PREFIXE_BASES) || nom.length === PREFIXE_BASES.length) {
    throw erreurValidation(`Le nom de la base doit être un texte commençant par « ${PREFIXE_BASES} ».`);
  }
}

// ------------------------------------------------------------
// Gestion de la base (utile surtout pour les tests)
// ------------------------------------------------------------
// Ferme la connexion en cours. La prochaine opération la rouvrira toute seule.
export async function fermerBase() {
  const enCours = connexion;
  connexion = null;
  baseOuverte = null;
  if (enCours) {
    try {
      const db = await enCours;
      db.close();
    } catch (erreur) {
      // L’ouverture avait échoué : il n’y a rien à fermer.
    }
  }
}

// Change la base utilisée (à appeler avant toute autre opération). Sert aux tests.
export async function choisirBase(nom) {
  verifierNomBase(nom);
  await fermerBase();
  nomBase = nom;
}

// Supprime entièrement une base de test. La base principale est protégée.
export async function supprimerBase(nom = nomBase) {
  verifierNomBase(nom);
  if (nom === NOM_BASE_PRINCIPALE) {
    throw erreurValidation('Suppression refusée : la base principale de l’application ne peut pas être supprimée avec cette fonction.');
  }
  await fermerBase();
  return executer(`Suppression de la base « ${nom} »`, () => new Promise((resolve, reject) => {
    const requete = indexedDB.deleteDatabase(nom);
    requete.onsuccess = () => resolve();
    requete.onerror = () => reject(requete.error);
    requete.onblocked = () => {
      console.warn(`La suppression de « ${nom} » attend que les autres onglets ferment la base.`);
    };
  }));
}

// ------------------------------------------------------------
// Leçons
// ------------------------------------------------------------
// Crée une leçon à partir de { titre, matiere, importance, texte } et renvoie la leçon enregistrée.
export async function ajouterLecon(donnees) {
  verifierChamps(donnees, 'Leçon', CHAMPS_SAISIE_LECON, CHAMPS_SAISIE_LECON);
  const titre = validerChampLecon('titre', donnees.titre);
  const matiere = validerChampLecon('matiere', donnees.matiere);
  const importance = validerChampLecon('importance', donnees.importance);
  const texte = validerChampLecon('texte', donnees.texte);

  const maintenant = horodatage();
  const lecon = {
    id: genererId(),
    titre,
    matiere,
    importance,
    texte,
    synthese: null,
    creeLe: maintenant,
    modifieLe: maintenant
  };

  return executer('Ajout de la leçon', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction(STORE_LECONS, 'readwrite');
    const fin = suivre(transaction);
    transaction.objectStore(STORE_LECONS).add(lecon);
    await fin;
    return lecon;
  });
}

// Renvoie toutes les leçons, de la plus ancienne à la plus récente.
export async function listerLecons() {
  return executer('Lecture des leçons', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction(STORE_LECONS, 'readonly');
    return demande(transaction.objectStore(STORE_LECONS).getAll());
  });
}

// Renvoie une leçon d’après son identifiant (erreur INTROUVABLE si elle n’existe pas).
export async function obtenirLecon(id) {
  validerId(id, 'L’identifiant de la leçon');
  return executer('Lecture de la leçon', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction(STORE_LECONS, 'readonly');
    const lecon = await demande(transaction.objectStore(STORE_LECONS).get(id));
    if (!lecon) {
      throw erreurIntrouvable(`Leçon introuvable (identifiant « ${id} »).`);
    }
    return lecon;
  });
}

// Modifie certains champs (titre, matiere, importance, texte, synthese), met à jour modifieLe
// et renvoie la leçon modifiée. Les autres champs (id, creeLe…) ne peuvent pas être changés.
export async function modifierLecon(id, modifications) {
  validerId(id, 'L’identifiant de la leçon');
  verifierChamps(modifications, 'Modification de la leçon', CHAMPS_MODIFIABLES_LECON);
  const cles = Object.keys(modifications);
  if (cles.length === 0) {
    throw erreurValidation('Modification de la leçon : aucun champ à modifier n’a été fourni.');
  }
  const nouvellesValeurs = {};
  for (const cle of cles) {
    nouvellesValeurs[cle] = validerChampLecon(cle, modifications[cle]);
  }

  return executer('Modification de la leçon', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction(STORE_LECONS, 'readwrite');
    const fin = suivre(transaction);
    const magasin = transaction.objectStore(STORE_LECONS);

    const existante = await demande(magasin.get(id));
    if (!existante) {
      throw erreurIntrouvable(`Modification impossible : leçon introuvable (identifiant « ${id} »).`);
    }
    const miseAJour = { ...existante, ...nouvellesValeurs, modifieLe: horodatage() };
    magasin.put(miseAJour);
    await fin;
    return miseAJour;
  });
}

// Supprime une leçon ET toutes ses questions, en une seule opération (tout ou rien).
// Renvoie le nombre de questions supprimées.
export async function supprimerLecon(id) {
  validerId(id, 'L’identifiant de la leçon');
  return executer('Suppression de la leçon', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction([STORE_LECONS, STORE_QUESTIONS], 'readwrite');
    const fin = suivre(transaction);
    const lecons = transaction.objectStore(STORE_LECONS);
    const questions = transaction.objectStore(STORE_QUESTIONS);

    const existante = await demande(lecons.get(id));
    if (!existante) {
      throw erreurIntrouvable(`Suppression impossible : leçon introuvable (identifiant « ${id} »).`);
    }
    const cles = await demande(questions.index('leconId').getAllKeys(IDBKeyRange.only(id)));
    lecons.delete(id);
    for (const cle of cles) {
      questions.delete(cle);
    }
    await fin;
    return cles.length;
  });
}

// ------------------------------------------------------------
// Questions
// ------------------------------------------------------------
// Ajoute plusieurs questions [{ question, reponse }, …] à une leçon.
// Chaque question démarre dans la boîte 1, à réviser dès aujourd’hui (date locale), avec un historique vide.
// Tout est enregistré, ou rien. Renvoie les questions créées.
export async function ajouterQuestions(leconId, liste) {
  validerId(leconId, 'L’identifiant de la leçon');
  if (!Array.isArray(liste)) {
    throw erreurValidation('La liste de questions doit être un tableau.');
  }
  if (liste.length === 0) {
    throw erreurValidation('La liste de questions est vide : il faut au moins une question.');
  }
  if (liste.length > NOMBRE_MAX_QUESTIONS_PAR_AJOUT) {
    throw erreurValidation(`Trop de questions d’un coup (${NOMBRE_MAX_QUESTIONS_PAR_AJOUT} au maximum par ajout).`);
  }

  const aujourdHui = dateLocale();
  const nouvelles = Array.from(liste, (element, position) => {
    const contexte = `Question n° ${position + 1}`;
    verifierChamps(element, contexte, CHAMPS_SAISIE_QUESTION, CHAMPS_SAISIE_QUESTION);
    const question = validerTexte(element.question, `${contexte} : la question`, { max: LONGUEUR_MAX_QUESTION });
    const reponse = validerTexte(element.reponse, `${contexte} : la réponse`, { max: LONGUEUR_MAX_REPONSE });
    return {
      id: genererId(),
      leconId,
      question,
      reponse,
      boite: BOITE_DEPART,
      prochaineRevision: aujourdHui,
      historique: []
    };
  });

  return executer('Ajout des questions', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction([STORE_LECONS, STORE_QUESTIONS], 'readwrite');
    const fin = suivre(transaction);

    const lecon = await demande(transaction.objectStore(STORE_LECONS).get(leconId));
    if (!lecon) {
      throw erreurIntrouvable(`Ajout impossible : leçon introuvable (identifiant « ${leconId} »).`);
    }
    const magasin = transaction.objectStore(STORE_QUESTIONS);
    for (const nouvelle of nouvelles) {
      magasin.add(nouvelle);
    }
    await fin;
    return nouvelles;
  });
}

// Renvoie les questions d’une leçon, dans l’ordre de création (liste vide s’il n’y en a aucune).
export async function listerQuestions(leconId) {
  validerId(leconId, 'L’identifiant de la leçon');
  return executer('Lecture des questions', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction(STORE_QUESTIONS, 'readonly');
    return demande(transaction.objectStore(STORE_QUESTIONS).index('leconId').getAll(IDBKeyRange.only(leconId)));
  });
}

// Supprime une seule question d’après son identifiant (erreur INTROUVABLE si elle n’existe pas).
export async function supprimerQuestion(id) {
  validerId(id, 'L’identifiant de la question');
  return executer('Suppression de la question', async () => {
    const db = await obtenirConnexion();
    const transaction = db.transaction(STORE_QUESTIONS, 'readwrite');
    const fin = suivre(transaction);
    const magasin = transaction.objectStore(STORE_QUESTIONS);

    const existante = await demande(magasin.get(id));
    if (!existante) {
      throw erreurIntrouvable(`Suppression impossible : question introuvable (identifiant « ${id} »).`);
    }
    magasin.delete(id);
    await fin;
  });
}
