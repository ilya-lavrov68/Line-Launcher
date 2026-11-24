// Purpose-built graphic design for the local/demo launcher artwork.
//
// Banners and icons form one restrained abstract family: a quiet graphite field,
// one large geometric emblem, a secondary accent, and a coarse texture that
// survives the launcher’s wide and thumbnail crops. No game scenes, interface
// labels, numbers, or external image hosts. Keep the artwork deterministic so
// screenshots and the reference provider always show the same designs.

const THEMES = {
  survival: {
    name: "Survival",
    base: "#111713",
    field: "#19221D",
    line: "#405147",
    accent: "#D8B88D",
    secondary: "#82B6A0",
    bannerShape:
      '<circle cx="1080" cy="200" r="166" fill="none" stroke="#82B6A0" stroke-width="3" opacity=".76"/><circle cx="1080" cy="200" r="116" fill="none" stroke="#82B6A0" stroke-width="2" opacity=".38"/><path d="M895 320 1045 170l72 72 182-182" fill="none" stroke="#D8B88D" stroke-width="5"/><path d="M870 342h420M1080 22v356" fill="none" stroke="#82B6A0" stroke-width="2" opacity=".34"/><circle cx="1080" cy="200" r="8" fill="#D8B88D"/>',
    iconShape:
      '<circle cx="64" cy="64" r="39" fill="none" stroke="#82B6A0" stroke-width="5"/><path d="m28 88 35-35 17 17 27-27" fill="none" stroke="#D8B88D" stroke-width="7" stroke-linecap="square"/><circle cx="64" cy="64" r="5" fill="#D8B88D"/>',
  },
  skyblock: {
    name: "SkyBlock",
    base: "#121719",
    field: "#1A2224",
    line: "#3D5050",
    accent: "#B6D4C8",
    secondary: "#83AFA6",
    bannerShape:
      '<path d="m1080 22 178 178-178 178L902 200z" fill="none" stroke="#B6D4C8" stroke-width="3" opacity=".76"/><path d="m1080 78 122 122-122 122-122-122z" fill="#1A2224" stroke="#83AFA6" stroke-width="3"/><path d="m1080 133 67 67-67 67-67-67z" fill="#B6D4C8" opacity=".82"/><path d="M860 200h440M1080 16v368" fill="none" stroke="#83AFA6" stroke-width="2" opacity=".38"/><circle cx="1080" cy="200" r="8" fill="#111713"/>',
    iconShape:
      '<path d="m64 15 49 49-49 49-49-49z" fill="none" stroke="#B6D4C8" stroke-width="6"/><path d="m64 37 27 27-27 27-27-27z" fill="#83AFA6"/><circle cx="64" cy="64" r="6" fill="#111713"/>',
  },
  creative: {
    name: "Creative",
    base: "#171716",
    field: "#23231F",
    line: "#4A4A3E",
    accent: "#D2D29A",
    secondary: "#A6B8A0",
    bannerShape:
      '<path d="M890 66h164v126H890zM1078 66h220v52h-220zM1078 142h220v52h-220zM890 218h164v126H890zM1078 218h220v126h-220z" fill="#A6B8A0" opacity=".16"/><path d="M890 66h164v126H890zM1078 218h220v126h-220z" fill="none" stroke="#D2D29A" stroke-width="4"/><path d="M860 200h454M1070 38v324" fill="none" stroke="#A6B8A0" stroke-width="2" opacity=".36"/><circle cx="972" cy="128" r="10" fill="#D2D29A"/>',
    iconShape:
      '<path d="M24 25h43v35H24zM76 25h28v12H76zM76 48h28v12H76zM24 72h43v31H24zM76 72h28v31H76z" fill="#A6B8A0" opacity=".45"/><path d="M24 25h43v35H24zM76 72h28v31H76z" fill="none" stroke="#D2D29A" stroke-width="5"/><circle cx="45" cy="42" r="5" fill="#D2D29A"/>',
  },
};

function themeFor(name = "survival") {
  const aliases = { demo: "survival", showcase: "skyblock" };
  const theme = THEMES[aliases[name] ?? name];
  if (!theme) throw new Error(`Unknown demo artwork theme: ${name}`);
  return theme;
}

export function demoBannerSvg(name) {
  const t = themeFor(name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400" viewBox="0 0 1600 400" role="img" aria-label="${t.name} abstract geometric banner">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${t.line}" stroke-width="1" opacity=".42"/></pattern>
    <pattern id="grain" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1" fill="${t.secondary}" opacity=".55"/></pattern>
    <clipPath id="texture-safe"><path d="M720 18h720v364H720z"/></clipPath>
  </defs>
  <rect width="1600" height="400" fill="${t.base}"/>
  <rect width="1600" height="400" fill="url(#grid)" opacity=".52"/>
  <path d="M0 0h760v400H0z" fill="${t.field}" opacity=".76"/>
  <path d="M48 44h1504v312H48z" fill="none" stroke="${t.line}" stroke-width="1.5" opacity=".7"/>
  <path d="M48 84h1504M48 316h1504M800 44v312" fill="none" stroke="${t.line}" stroke-width="1.5" opacity=".62"/>
  <g clip-path="url(#texture-safe)" opacity=".15"><path d="M720 18h720v364H720z" fill="url(#grain)"/></g>
  <path d="M48 44h34v2H48zM1518 44h34v2h-34zM48 354h34v2H48zM1518 354h34v2h-34z" fill="${t.accent}" opacity=".76"/>
  <g>${t.bannerShape}</g>
</svg>`;
}

export function demoIconSvg(name = "survival") {
  const t = themeFor(name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="${t.name} abstract emblem">
  <rect width="128" height="128" fill="${t.base}"/>
  <path d="M12 12h104v104H12z" fill="none" stroke="${t.line}" stroke-width="2"/>
  <path d="M20 20h88v88H20z" fill="${t.field}" opacity=".76"/>
  <path d="M64 17v94M17 64h94" fill="none" stroke="${t.line}" stroke-width="1.5" opacity=".58"/>
  <g>${t.iconShape}</g>
</svg>`;
}

export function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function demoBannerDataUrl(name) {
  return svgDataUrl(demoBannerSvg(name));
}

export function demoIconDataUrl(name) {
  return svgDataUrl(demoIconSvg(name));
}
