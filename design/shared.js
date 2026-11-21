// 原创设计资源：背景场景示意（非实机渲染）与细线图标。禁止引入外部游戏素材。
const SCENE = `
<svg viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a5b6b"/><stop offset=".45" stop-color="#5d8f96"/>
      <stop offset=".78" stop-color="#a9bfa9"/><stop offset="1" stop-color="#cfd3ae"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7fa6a4"/><stop offset="1" stop-color="#33636c"/>
    </linearGradient>
    <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#dfe7d8" stop-opacity="0"/><stop offset="1" stop-color="#e6ead9" stop-opacity=".85"/>
    </linearGradient>
    <radialGradient id="sun" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#f7e6bd" stop-opacity=".9"/><stop offset="1" stop-color="#f7e6bd" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="slime" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bdeedd"/><stop offset="1" stop-color="#5cb8a4"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#sky)"/>
  <circle cx="1420" cy="270" r="360" fill="url(#sun)"/>
  <g opacity=".45" fill="#48737d">
    <polygon points="120,520 300,400 430,520"/><polygon points="360,520 520,428 660,520"/>
    <polygon points="1560,520 1730,392 1880,520"/>
  </g>
  <g opacity=".3" fill="#dfe7d8"><ellipse cx="480" cy="470" rx="520" ry="42"/><ellipse cx="1500" cy="440" rx="460" ry="34"/></g>
  <rect y="690" width="1920" height="390" fill="url(#sea)"/>
  <g stroke="#cfe3da" stroke-opacity=".28" stroke-width="2">
    <path d="M0 742h1920M0 806h1920M0 886h1920M0 986h1920"/>
  </g>
  <!-- 主岛：连续三角网低模切面 -->
  <g>
    <polygon points="250,700 640,470 1010,520 1320,690 960,760 520,760" fill="#6f9a72"/>
    <polygon points="640,470 1010,520 900,610 560,600" fill="#87ac7c"/>
    <polygon points="560,600 900,610 960,760 520,760" fill="#7ba473"/>
    <polygon points="900,610 1010,520 1320,690 960,760" fill="#5f8a68"/>
    <polygon points="250,700 560,600 520,760" fill="#69976f"/>
    <polygon points="520,760 960,760 1320,690 1300,742 950,812 540,808" fill="#8a8f6a"/>
    <polygon points="540,808 950,812 1300,742 1270,782 940,852 560,846" fill="#6d7460"/>
    <polygon points="250,700 520,760 540,808 560,846 300,772" fill="#7c8266"/>
  </g>
  <g fill="#cbb98f" opacity=".85">
    <polygon points="250,700 520,760 540,808 300,772"/>
  </g>
  <!-- 折伞树：原创剪影 -->
  <g>
    <g transform="translate(700,556)"><polygon points="-6,44 6,44 3,0 -3,0" fill="#6b5644"/><polygon points="-58,0 0,-52 58,0 30,10 -30,10" fill="#3f7a63"/><polygon points="-40,-6 0,-40 40,-6" fill="#549579"/></g>
    <g transform="translate(1050,586) scale(.86)"><polygon points="-6,44 6,44 3,0 -3,0" fill="#6b5644"/><polygon points="-58,0 0,-52 58,0 30,10 -30,10" fill="#3f7a63"/><polygon points="-40,-6 0,-40 40,-6" fill="#549579"/></g>
    <g transform="translate(470,668) scale(.7)"><polygon points="-6,44 6,44 3,0 -3,0" fill="#6b5644"/><polygon points="-58,0 0,-52 58,0 30,10 -30,10" fill="#3f7a63"/></g>
  </g>
  <!-- 叠羽树 -->
  <g transform="translate(880,540)">
    <polygon points="-5,52 5,52 2,0 -2,0" fill="#6b5644"/>
    <polygon points="0,-64 34,-18 12,-20 40,16 0,4 -40,16 -12,-20 -34,-18" fill="#69a488"/>
  </g>
  <!-- 草花细节 -->
  <g stroke="#a8c68f" stroke-width="3" stroke-linecap="round" opacity=".8">
    <path d="M600 700l-6-18M612 702l4-20M626 700l8-14M1120 700l-6-18M1134 702l4-18"/>
  </g>
  <g fill="#e7d9a8"><circle cx="596" cy="680" r="4"/><circle cx="1136" cy="682" r="4"/></g>
  <!-- 前方小径 -->
  <polygon points="760,748 900,742 1060,1080 560,1080" fill="#c9bd95" opacity=".55"/>
  <rect y="620" width="1920" height="180" fill="url(#mist)" opacity=".55"/>
  <!-- 史莱姆：切面水滴团子，第三人称跟随位置 -->
  <g transform="translate(880,872)">
    <ellipse cx="6" cy="86" rx="86" ry="18" fill="#0d2b30" opacity=".28"/>
    <path d="M0-108C52-84 84-30 84 22 84 66 46 88 0 88-46 88-84 66-84 22-84-30-52-84 0-108Z" fill="url(#slime)"/>
    <path d="M0-108C40-88 66-48 76-6L10 18-38-38Z" fill="#d6f6e8" opacity=".55"/>
    <path d="M-84 22C-84-30-52-84 0-108L-38-38-52 40Z" fill="#8fd6c2" opacity=".45"/>
    <g fill="#123a3c"><ellipse cx="-26" cy="6" rx="7" ry="10"/><ellipse cx="26" cy="6" rx="7" ry="10"/></g>
    <path d="M-12 34q12 12 24 0" stroke="#123a3c" stroke-width="4" fill="none" stroke-linecap="round"/>
    <circle cx="-46" cy="28" r="9" fill="#f2b8a0" opacity=".45"/><circle cx="46" cy="28" r="9" fill="#f2b8a0" opacity=".45"/>
  </g>
  <rect width="1920" height="1080" fill="none"/>
</svg>`;

const I = (p, extra = "") => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;

const ICONS = {
  map: I('<path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z"/><path d="M9 4v13M15 6.5v13"/>'),
  quest: I('<path d="M12 3l2.4 5.2L20 9l-4 4 1 6-5-2.8L7 19l1-6-4-4 5.6-.8L12 3Z"/>'),
  gear: I('<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/>'),
  compass: I('<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5 13.4 13.4 8.5 15.5l2.1-4.9 4.9-2.1Z"/>'),
  flag: I('<path d="M6 21V4"/><path d="M6 5c3-1.6 5 1.4 8 0s4-.6 4-.6v8s-1-.4-4 .6-5-1.6-8 0"/>'),
  close: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  minus: I('<path d="M5 12h14"/>'),
  locate: I('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="7.5" stroke-dasharray="3 3"/>'),
  check: I('<path d="M4.5 12.5 10 18 19.5 6.5"/>'),
  sparkle: I('<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><path d="M12 8.5 13.8 12 12 15.5 10.2 12 12 8.5Z" fill="currentColor" stroke="none"/>'),
  sliders: I('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  play: I('<path d="M8 5.5v13l11-6.5-11-6.5Z"/>'),
  leaf: I('<path d="M5 19C3 10 9 4 20 4c0 11-6 17-15 15Z"/><path d="M5 19c3-5 7-8 11-10"/>'),
  hand: I('<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6 7s-6-2.5-7-6l-1.4-4c-.3-1 1-1.8 1.8-1L9 13"/>'),
  jump: I('<path d="M12 20V6"/><path d="M6.5 11.5 12 5l5.5 6.5"/><path d="M5 21h14" stroke-dasharray="2 3"/>'),
  dash: I('<path d="M3 8h8M3 12h11M3 16h8"/><path d="M15 5l6 7-6 7"/>'),
  eye: I('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  sound: I('<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
  drop: I('<path d="M12 3c4 5 7 8.5 7 12a7 7 0 0 1-14 0c0-3.5 3-7 7-12Z"/><path d="M9 14a3 3 0 0 0 3 3"/>'),
  north: I('<path d="M12 4 17 20 12 16.5 7 20 12 4Z"/>'),
  keyboard: I('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  book: I('<path d="M12 6c-2-1.4-5-1.6-8-1v13c3-.6 6-.4 8 1 2-1.4 5-1.6 8-1V5c-3-.6-6-.4-8 1Z"/><path d="M12 6v13"/>'),
};

function mountScene(el, dim = false) {
  el.classList.add("scene");
  if (dim) el.classList.add("dim");
  el.innerHTML = SCENE;
}
function icon(name) { return ICONS[name] || ""; }
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(n => { n.innerHTML = icon(n.dataset.icon); });
}
