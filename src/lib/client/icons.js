// Icônes SVG : création d'un élément <svg> à partir des fichiers statiques de src/assets/icons (importés avec ?raw).

/**
 * Crée un élément <svg> à partir du contenu brut d'un fichier d'icône statique (src/assets/icons).
 * @param {string} raw contenu du fichier .svg (statique, jamais de données)
 * @param {string} [className] classes à appliquer
 * @param {number} [size] largeur et hauteur en pixels
 * @returns {SVGElement}
 */
export function svgIcon(raw, className = '', size) {
  const template = document.createElement('template');
  template.innerHTML = raw.trim(); // SVG statique de nos fichiers
  const svg = /** @type {SVGElement} */ (template.content.firstElementChild);
  if (className) svg.setAttribute('class', className);
  if (size) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}
