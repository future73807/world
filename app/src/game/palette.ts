/**
 * World palette. Derived from the design tokens (ink teal / warm ivory / mist gold)
 * and the island's own moss / sand / mist colours — no external game colours sampled.
 */
export const PAL = {
  // sky & atmosphere — bright open daylight, warm sun, blue depth
  skyTop: 0x1e6fd6,
  skyMid: 0x4fb3f2,
  skyHorizon: 0xdff4fc,
  skyHaze: 0xaadcef,
  sun: 0xffd257,
  sunCore: 0xfff6d8,
  fog: 0xcbe7e6,
  mist: 0xe2f2ee,

  // water
  waterDeep: 0x0e4b5c,
  waterMid: 0x1f7e8c,
  waterShallow: 0x6fd9c6,
  waterFoam: 0xecfbf4,

  // ground
  sandLight: 0xf2e6bf,
  sandMid: 0xe6d4a4,
  sandWet: 0xcdb98a,
  sandDeep: 0x9d8a66,
  grassLight: 0x9ccb6e,
  grassMid: 0x6fae55,
  grassDeep: 0x4e8a45,
  moss: 0x93bf72,
  rockLight: 0xb3bcbc,
  rockMid: 0x94a0a2,
  rockDark: 0x748084,

  // flora — fresh leaf greens with warm highlights, cool teal for the slope family
  barkLight: 0xa08265,
  barkMid: 0x7d6249,
  barkDark: 0x574434,
  barkCool: 0x6b6f5f,
  canopyATop: 0xa9d47c,
  canopyASide: 0x7cb457,
  canopyAUnder: 0x4f7f42,
  canopyBTop: 0x86cdb4,
  canopyBSide: 0x5fa894,
  canopyBUnder: 0x3f7a70,
  canopyCTop: 0xc4e4d2,
  canopyCSide: 0x94bda9,
  canopyCUnder: 0x6b9787,
  canopyCGill: 0x9fe9cd,
  canopyCGlow: 0x8ff7d4,
  canopyCStalk: 0xc9b892,

  // character — hydro-slime gel, sampled from the reference recording
  slimeBody: 0x58cfd4,
  slimeDeep: 0x1a7f96,
  slimeRim: 0xdffbff,
  slimeCore: 0xf2fff5,
  eye: 0x11312f,
  blush: 0xf0a6a2,

  // ui accent used by world-space markers
  accent: 0x8fd6c2,
  gold: 0xd9c08a,
} as const;

export const SUN_DIR = { x: -0.46, y: 0.62, z: 0.64 };
