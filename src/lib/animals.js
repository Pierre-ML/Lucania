// Animaux de l'univers Lucania (low-poly), viewBox 0 0 64 64.
// Source : copie exacte des données du site web (Lucania_site_web/src/data/animals.js).
// Format : facets = polygones { points, opacity } ; eyes = cercles { cx, cy, r } ;
// accents = petits triangles { points }. Dans l'app, tout est rendu en currentColor (aucun rouge).
//
// Table des rôles (contrat partagé) :
//   loup    = logo + chat principal (réservé au logo et au chat)
//   hibou   = e-mails
//   aigle   = serveur / récepteur (connexion entre machines, accès distant, écran serveur)
//   dragon  = extinction à distance
//   renard  = modes et options avancés
//   ours    = moteur (modèles locaux)
//   meneur  = Hugging Face (téléchargement de modèles)
//   corbeau = mémoire
//   cerf    = apparence
export const animals = {
  loup: {
    id: 'loup',
    set: 'minimal',
    facets: [
      { points: [[14,4],[26,22],[14,34]], opacity: 0.7 },
      { points: [[50,4],[38,22],[50,34]], opacity: 0.45 },
      { points: [[26,22],[38,22],[32,36]], opacity: 1 },
      { points: [[14,34],[26,22],[32,36]], opacity: 0.5 },
      { points: [[50,34],[38,22],[32,36]], opacity: 0.3 },
      { points: [[14,34],[32,36],[32,60]], opacity: 0.3 },
      { points: [[50,34],[32,36],[32,60]], opacity: 0.2 },
    ],
    eyes: [],
    accents: [],
  },
  corbeau: {
    id: 'corbeau',
    set: 'minimal',
    facets: [
      { points: [[33,19],[38,9],[47,5],[52,12],[49,14]], opacity: 0.85 },
      { points: [[33,19],[49,14],[49,24],[41,27]], opacity: 1 },
      { points: [[49,14],[63,28],[49,24]], opacity: 0.5 },
      { points: [[49,24],[63,28],[47,31]], opacity: 0.3 },
      { points: [[41,27],[49,24],[47,31],[52,42],[44,50]], opacity: 0.45 },
      { points: [[33,19],[41,27],[12,30]], opacity: 0.45 },
      { points: [[12,30],[41,27],[44,50],[30,54]], opacity: 0.7 },
      { points: [[12,30],[30,54],[3,61]], opacity: 0.3 },
      { points: [[12,30],[3,61],[4,40]], opacity: 0.5 },
    ],
    eyes: [{ cx: 43, cy: 18.5, r: 2 }],
    accents: [],
  },
  hibou: {
    id: 'hibou',
    set: 'minimal',
    facets: [
      { points: [[10,8],[32,22],[32,58],[10,40]], opacity: 0.6 },
      { points: [[54,8],[32,22],[32,58],[54,40]], opacity: 0.35 },
      { points: [[28,32],[36,32],[32,44]], opacity: 1 },
    ],
    eyes: [{ cx: 21, cy: 28, r: 5 }, { cx: 43, cy: 28, r: 5 }],
    accents: [],
  },
  renard: {
    id: 'renard',
    set: 'minimal',
    facets: [
      { points: [[5,3],[28,26],[7,31]], opacity: 0.7 },
      { points: [[4,37],[7,31],[28,26],[32,40]], opacity: 0.5 },
      { points: [[4,37],[32,40],[20,47]], opacity: 0.3 },
      { points: [[20,47],[32,40],[32,60]], opacity: 0.6 },
      { points: [[57,31],[36,26],[59,3]], opacity: 0.45 },
      { points: [[32,40],[36,26],[57,31],[60,37]], opacity: 0.3 },
      { points: [[44,47],[32,40],[60,37]], opacity: 0.2 },
      { points: [[32,60],[32,40],[44,47]], opacity: 0.4 },
      { points: [[28,26],[36,26],[32,40]], opacity: 1 },
    ],
    eyes: [{ cx: 19, cy: 34, r: 1.6 }, { cx: 45, cy: 34, r: 1.6 }],
    accents: [{ points: [[30.5,57],[33.5,57],[32,60]] }],
  },
  aigle: {
    id: 'aigle',
    set: 'minimal',
    facets: [
      { points: [[12,12],[36,8],[42,26]], opacity: 1 },
      { points: [[36,8],[58,30],[44,30]], opacity: 0.8 },
      { points: [[44,30],[58,30],[46,42]], opacity: 0.45 },
      { points: [[12,12],[42,26],[44,30],[46,42],[30,58]], opacity: 0.6 },
      { points: [[12,12],[30,58],[8,44]], opacity: 0.3 },
    ],
    eyes: [{ cx: 36, cy: 18, r: 2 }],
    accents: [],
  },
  ours: {
    id: 'ours',
    set: 'minimal',
    facets: [
      { points: [[6,10],[20,8],[18,22],[8,22]], opacity: 0.6 },
      { points: [[58,10],[44,8],[46,22],[56,22]], opacity: 0.45 },
      { points: [[14,22],[50,22],[32,26]], opacity: 1 },
      { points: [[14,22],[32,26],[8,40]], opacity: 0.7 },
      { points: [[50,22],[32,26],[56,40]], opacity: 0.45 },
      { points: [[8,40],[32,26],[32,58],[20,58]], opacity: 0.5 },
      { points: [[56,40],[32,26],[32,58],[44,58]], opacity: 0.3 },
      { points: [[28,44],[36,44],[32,50]], opacity: 1 },
    ],
    eyes: [],
    accents: [],
  },
  cerf: {
    id: 'cerf',
    set: 'minimal',
    facets: [
      { points: [[19,26],[8,4],[27,25]], opacity: 0.85 },
      { points: [[18,17],[4,14],[23,21]], opacity: 0.6 },
      { points: [[45,26],[56,4],[37,25]], opacity: 0.6 },
      { points: [[46,17],[60,14],[41,21]], opacity: 0.4 },
      { points: [[10,26],[22,26],[22,36]], opacity: 0.5 },
      { points: [[54,26],[42,26],[42,36]], opacity: 0.3 },
      { points: [[22,26],[42,26],[32,30]], opacity: 1 },
      { points: [[22,26],[32,30],[32,58]], opacity: 0.6 },
      { points: [[42,26],[32,30],[32,58]], opacity: 0.35 },
    ],
    eyes: [],
    accents: [],
  },
  dragon: {
    id: 'dragon',
    set: 'minimal',
    facets: [
      { points: [[6,6],[26,20],[14,30]], opacity: 0.6 },
      { points: [[14,30],[26,20],[44,28],[34,40]], opacity: 1 },
      { points: [[44,28],[60,42],[34,40]], opacity: 0.75 },
      { points: [[34,40],[60,42],[40,56]], opacity: 0.35 },
      { points: [[14,30],[34,40],[40,56],[10,58]], opacity: 0.45 },
    ],
    eyes: [{ cx: 35, cy: 31, r: 2.2 }],
    accents: [],
  },
  meneur: {
    id: 'meneur',
    set: 'detail',
    facets: [
      { points: [[9,5],[24,17],[14,17]], opacity: 0.85 },
      { points: [[9,5],[14,17],[11,29]], opacity: 0.55 },
      { points: [[14,17],[24,17],[11,29]], opacity: 0.35 },
      { points: [[24,17],[32,13],[26,25]], opacity: 1 },
      { points: [[32,13],[32,28],[26,25]], opacity: 0.9 },
      { points: [[24,17],[26,25],[19,30]], opacity: 0.75 },
      { points: [[24,17],[19,30],[11,29]], opacity: 0.55 },
      { points: [[26,25],[32,28],[25,35]], opacity: 0.8 },
      { points: [[26,25],[25,35],[19,30]], opacity: 0.65 },
      { points: [[32,28],[32,38],[25,35]], opacity: 0.85 },
      { points: [[19,30],[25,35],[21,40]], opacity: 0.5 },
      { points: [[19,30],[21,40],[11,29]], opacity: 0.45 },
      { points: [[11,29],[21,40],[7,38]], opacity: 0.4 },
      { points: [[25,35],[32,38],[21,40]], opacity: 0.7 },
      { points: [[32,38],[21,40],[24,50]], opacity: 0.6 },
      { points: [[32,38],[24,50],[32,50]], opacity: 0.85 },
      { points: [[21,40],[7,38],[17,50]], opacity: 0.35 },
      { points: [[21,40],[17,50],[24,50]], opacity: 0.45 },
      { points: [[17,50],[32,60],[24,50]], opacity: 0.3 },
      { points: [[24,50],[32,60],[32,50]], opacity: 0.65 },
      { points: [[55,5],[40,17],[50,17]], opacity: 0.51 },
      { points: [[55,5],[50,17],[53,29]], opacity: 0.34 },
      { points: [[50,17],[40,17],[53,29]], opacity: 0.23 },
      { points: [[40,17],[32,13],[38,25]], opacity: 0.59 },
      { points: [[32,13],[32,28],[38,25]], opacity: 0.54 },
      { points: [[40,17],[38,25],[45,30]], opacity: 0.45 },
      { points: [[40,17],[45,30],[53,29]], opacity: 0.34 },
      { points: [[38,25],[32,28],[39,35]], opacity: 0.48 },
      { points: [[38,25],[39,35],[45,30]], opacity: 0.4 },
      { points: [[32,28],[32,38],[39,35]], opacity: 0.51 },
      { points: [[45,30],[39,35],[43,40]], opacity: 0.32 },
      { points: [[45,30],[43,40],[53,29]], opacity: 0.29 },
      { points: [[53,29],[43,40],[57,38]], opacity: 0.26 },
      { points: [[39,35],[32,38],[43,40]], opacity: 0.42 },
      { points: [[32,38],[43,40],[40,50]], opacity: 0.37 },
      { points: [[32,38],[40,50],[32,50]], opacity: 0.51 },
      { points: [[43,40],[57,38],[47,50]], opacity: 0.23 },
      { points: [[43,40],[47,50],[40,50]], opacity: 0.29 },
      { points: [[47,50],[32,60],[40,50]], opacity: 0.21 },
      { points: [[40,50],[32,60],[32,50]], opacity: 0.4 },
    ],
    eyes: [],
    accents: [{ points: [[28.5,50.5],[35.5,50.5],[32,56.5]] }],
  },
};

/** Renvoie les données d'un animal ; lève une Error si l'id est inconnu. */
export function getAnimal(id) {
  const animal = animals[id];
  if (!animal) throw new Error(`Animal inconnu : ${id}`);
  return animal;
}
