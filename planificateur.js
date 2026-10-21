// planificateur.js — calcul de la prochaine révision (boîtes de 1 à 7, façon Leitner).
// Module de fonctions PURES : aucune base de données, aucune interface, aucune lecture de l’horloge.
// La date du jour est toujours fournie par l’appelant (paramètre « aujourdhui »).
//
// Exemple :
//   import { calculerProchaine } from './planificateur.js';
//   const planification = calculerProchaine({ boite: 3, importance: 2, resultat: 'reussi', aujourdhui: '2026-10-20' });
//   // → { boite: 4, prochaineRevision: '2026-11-03' }
//   // Ce résultat se passe tel quel à enregistrerReponse(questionId, 'reussi', planification) de db.js.

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------
export const BOITE_MIN = 1;
export const BOITE_MAX = 7;
export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 3;
export const RESULTATS = Object.freeze(['reussi', 'hesite', 'rate']);

// Intervalle en jours avant la prochaine révision, selon l’importance de la leçon
// et la boîte OBTENUE après la réponse (position 0 = boîte 1, position 6 = boîte 7).
export const INTERVALLES_PAR_IMPORTANCE = Object.freeze({
  3: Object.freeze([1, 2, 4, 7, 14, 30, 60]),
  2: Object.freeze([1, 3, 7, 14, 30, 60, 120]),
  1: Object.freeze([1, 4, 10, 21, 45, 90, 180])
});

// Années acceptées : 4 chiffres, et au moins 1000. Avant l’an 100, new Date(année, …) lirait « 1900 + année ».
const ANNEE_MIN = 1000;
const ANNEE_MAX = 9999;

const CHAMPS_CALCUL = ['boite', 'importance', 'resultat', 'aujourdhui'];

// ------------------------------------------------------------
// Erreurs
// ------------------------------------------------------------
// Toute entrée invalide lève une ErreurPlanification dont le message est en français (code : 'VALIDATION').
export class ErreurPlanification extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErreurPlanification';
    this.code = 'VALIDATION';
  }
}

function erreurValidation(message) {
  return new ErreurPlanification(message);
}

// Décrit brièvement une valeur reçue, pour l’afficher dans un message d’erreur.
function decrire(valeur) {
  if (typeof valeur === 'string') {
    return JSON.stringify(valeur.length > 40 ? valeur.slice(0, 39) + '…' : valeur);
  }
  if (valeur === null || valeur === undefined || typeof valeur === 'number' || typeof valeur === 'boolean') {
    return String(valeur);
  }
  if (Array.isArray(valeur)) return 'une liste';
  if (valeur instanceof Date) return 'un objet Date';
  if (typeof valeur === 'object') return 'un objet';
  return typeof valeur;
}

// ------------------------------------------------------------
// Dates (calculées avec new Date(année, mois - 1, jour + n) : jamais en millisecondes)
// ------------------------------------------------------------
// Vérifie une date locale « AAAA-MM-JJ » qui existe vraiment, et renvoie ses trois composants.
function lireJour(valeur, libelle) {
  if (typeof valeur !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valeur)) {
    throw erreurValidation(`${libelle} doit être une date locale au format AAAA-MM-JJ, par exemple 2026-10-25 (reçu : ${decrire(valeur)}).`);
  }
  const annee = Number(valeur.slice(0, 4));
  const mois = Number(valeur.slice(5, 7));
  const jour = Number(valeur.slice(8, 10));
  if (annee < ANNEE_MIN) {
    throw erreurValidation(`${libelle} : l’année doit être comprise entre ${ANNEE_MIN} et ${ANNEE_MAX} (reçu : ${valeur}).`);
  }
  const controle = new Date(annee, mois - 1, jour);
  if (controle.getFullYear() !== annee || controle.getMonth() !== mois - 1 || controle.getDate() !== jour) {
    throw erreurValidation(`${libelle} : « ${valeur} » n’est pas une date qui existe dans le calendrier.`);
  }
  return { annee, mois, jour };
}

function formaterJour(date) {
  const annee = String(date.getFullYear()).padStart(4, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  const jour = String(date.getDate()).padStart(2, '0');
  return `${annee}-${mois}-${jour}`;
}

// Ajoute n jours (entier, positif, nul ou négatif) à une date « AAAA-MM-JJ » et renvoie « AAAA-MM-JJ ».
// Le calendrier est géré par new Date(annee, mois - 1, jour + n) : fins de mois, d’année,
// années bissextiles et changements d’heure sont donc corrects (un jour = un jour, pas 24 heures).
export function ajouterJours(dateChaine, n) {
  const { annee, mois, jour } = lireJour(dateChaine, 'La date');
  if (!Number.isInteger(n)) {
    throw erreurValidation(`Le nombre de jours doit être un nombre entier (reçu : ${decrire(n)}).`);
  }
  const resultat = new Date(annee, mois - 1, jour + n);
  const anneeResultat = resultat.getFullYear(); // NaN si la date obtenue est invalide
  if (Number.isNaN(anneeResultat) || anneeResultat < ANNEE_MIN || anneeResultat > ANNEE_MAX) {
    throw erreurValidation(`Le résultat de ${dateChaine} ${n < 0 ? '−' : '+'} ${Math.abs(n)} jour${Math.abs(n) > 1 ? 's' : ''} sort des années ${ANNEE_MIN} à ${ANNEE_MAX}.`);
  }
  return formaterJour(resultat);
}

// ------------------------------------------------------------
// Validation de calculerProchaine
// ------------------------------------------------------------
function verifierChamps(donnees) {
  if (donnees === null || typeof donnees !== 'object' || Array.isArray(donnees)) {
    throw erreurValidation(`calculerProchaine : un objet { boite, importance, resultat, aujourdhui } est attendu (reçu : ${decrire(donnees)}).`);
  }
  for (const cle of Object.keys(donnees)) {
    if (!CHAMPS_CALCUL.includes(cle)) {
      throw erreurValidation(`calculerProchaine : le champ « ${cle.slice(0, 40)} » n’existe pas (champs attendus : ${CHAMPS_CALCUL.join(', ')}).`);
    }
  }
  for (const cle of CHAMPS_CALCUL) {
    if (!Object.hasOwn(donnees, cle)) {
      throw erreurValidation(`calculerProchaine : le champ « ${cle} » est obligatoire.`);
    }
  }
}

function validerBoite(valeur) {
  if (!Number.isInteger(valeur) || valeur < BOITE_MIN || valeur > BOITE_MAX) {
    throw erreurValidation(`La boîte doit être un nombre entier entre ${BOITE_MIN} et ${BOITE_MAX} (reçu : ${decrire(valeur)}).`);
  }
  return valeur;
}

function validerImportance(valeur) {
  if (!Number.isInteger(valeur) || valeur < IMPORTANCE_MIN || valeur > IMPORTANCE_MAX) {
    throw erreurValidation(`L’importance doit être un nombre entier entre ${IMPORTANCE_MIN} et ${IMPORTANCE_MAX} (reçu : ${decrire(valeur)}).`);
  }
  return valeur;
}

function validerResultat(valeur) {
  if (typeof valeur !== 'string' || !RESULTATS.includes(valeur)) {
    throw erreurValidation(`Le résultat doit être « reussi », « hesite » ou « rate » (reçu : ${decrire(valeur)}).`);
  }
  return valeur;
}

// ------------------------------------------------------------
// Calcul de la prochaine révision
// ------------------------------------------------------------
// 'reussi' → boîte + 1 (au maximum 7) ; 'hesite' → même boîte ; 'rate' → retour en boîte 1.
function boiteApres(boite, resultat) {
  if (resultat === 'reussi') return Math.min(boite + 1, BOITE_MAX);
  if (resultat === 'hesite') return boite;
  return BOITE_MIN;
}

// Renvoie { boite, prochaineRevision } : la nouvelle boîte, et la date « AAAA-MM-JJ » de la prochaine révision
// (aujourdhui + l’intervalle de la boîte obtenue, selon l’importance de la leçon).
export function calculerProchaine(donnees) {
  verifierChamps(donnees);
  const boite = validerBoite(donnees.boite);
  const importance = validerImportance(donnees.importance);
  const resultat = validerResultat(donnees.resultat);
  lireJour(donnees.aujourdhui, 'Le champ « aujourdhui »');

  const nouvelleBoite = boiteApres(boite, resultat);
  const intervalle = INTERVALLES_PAR_IMPORTANCE[importance][nouvelleBoite - 1];
  return {
    boite: nouvelleBoite,
    prochaineRevision: ajouterJours(donnees.aujourdhui, intervalle)
  };
}
