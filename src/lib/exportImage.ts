/** Serialize an on-screen SVG element (with inline styles resolved) and offer it as a download, as SVG or rasterized PNG. */

function svgToStandaloneString(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!clone.getAttribute("width")) clone.setAttribute("width", String(svg.clientWidth));
  if (!clone.getAttribute("height")) clone.setAttribute("height", String(svg.clientHeight));
  return new XMLSerializer().serializeToString(clone);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadSvg(svg: SVGSVGElement, filename: string): void {
  downloadSvgText(svgToStandaloneString(svg), filename);
}

/** Download SVG markup as a file (e.g. igv.js's `browser.toSVG()`). */
export function downloadSvgText(svgText: string, filename: string): void {
  triggerDownload(new Blob([svgText], { type: "image/svg+xml" }), filename);
}

/** Root width/height of SVG markup, from its width/height attributes or else its viewBox; null if neither. */
export function svgDimensions(svgText: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svgText)?.[0];
  if (!root) return null;
  const attr = (name: string) => {
    const m = new RegExp(`\\s${name}="([\\d.]+)(px)?"`, "i").exec(root);
    return m ? Number(m[1]) : NaN;
  };
  const w = attr("width");
  const h = attr("height");
  if (w > 0 && h > 0) return { width: w, height: h };
  const vb = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(root);
  return vb ? { width: Number(vb[1]), height: Number(vb[2]) } : null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not rasterize the diagram to PNG."));
    img.src = src;
  });
}

export async function downloadPng(svg: SVGSVGElement, filename: string, scale = 2): Promise<void> {
  const width = Number(svg.getAttribute("width")) || svg.clientWidth;
  const height = Number(svg.getAttribute("height")) || svg.clientHeight;
  await downloadPngFromSvgText(svgToStandaloneString(svg), width, height, filename, scale);
}

/** Rasterize SVG markup to a PNG download at `scale` × its size, on a white background. */
export async function downloadPngFromSvgText(str: string, width: number, height: number, filename: string, scale = 2): Promise<void> {
  const svgBlob = new Blob([str], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is unavailable in this browser.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))), "image/png");
    });
    triggerDownload(pngBlob, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}
