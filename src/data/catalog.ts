/**
 * ROYALE — data/catalog.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Every cosmetic in the game, authored by hand. This is content, not code:
 * one entry per item with a real name, a line of copy with a point of view,
 * a rarity, and the render parameters the 3D table / card / chip systems
 * consume directly.
 *
 * PRICING
 *   Gem price is derived from rarity × a per-kind weight, so the whole store
 *   reads as one economy instead of a spreadsheet of arbitrary numbers.
 *     common 150 · rare 420 · epic 950 · legendary 2100 · mythic 4200
 *   Titles and emotes are deliberately cheap (they are expression, not
 *   status); table skins are the most expensive because they change the
 *   entire stage.
 *
 * OWNERSHIP RULES
 *   priceGems === null   → not purchasable; earned from the pass (`passTier`)
 *   premiumOnly === true → requires an active Premium Pass to equip/buy
 *
 * PARAMS CONTRACT (what the renderer reads)
 *   table-skin  feltColor, feltDeep, railMaterial, trimMetal, logoId,
 *               previewA, previewB, glow
 *   felt        feltColor, feltDeep, pattern, sheen
 *   card-back   baseA, baseB, ink, metal, pattern
 *   chip-set    primary, secondary, edge, inlay, stripes
 *   avatar      motif, bgA, bgB, accent, ink, anim
 *   frame       metal, style, glow, anim
 *   emote       set (comma-separated ReactionKind list), tint
 *   title       text, tone
 */
import type { CosmeticItem, CosmeticKind, Rarity } from '../core/types.ts';

// ─────────────────────────── pricing ───────────────────────────

const RARITY_BASE: Record<Rarity, number> = {
  common: 150,
  rare: 420,
  epic: 950,
  legendary: 2100,
  mythic: 4200,
};

const KIND_WEIGHT: Record<CosmeticKind, number> = {
  avatar: 1,
  frame: 0.8,
  'table-skin': 1.25,
  'card-back': 1,
  'chip-set': 1.1,
  emote: 0.55,
  title: 0.45,
  felt: 0.9,
};

/** The advertised price for a kind at a rarity — the whole ladder in one line. */
export function priceFor(kind: CosmeticKind, rarity: Rarity): number {
  return Math.round((RARITY_BASE[rarity] * KIND_WEIGHT[kind]) / 10) * 10;
}

// ─────────────────────────── authoring helpers ───────────────────────────

interface Spec {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  params: Record<string, string | number | boolean>;
  /** overrides the derived price; `null` makes it pass-exclusive */
  price?: number | null;
  premiumOnly?: boolean;
  passTier?: number;
}

function build(kind: CosmeticKind, specs: Spec[]): CosmeticItem[] {
  return specs.map((s) => {
    const item: CosmeticItem = {
      id: s.id,
      kind,
      name: s.name,
      description: s.description,
      rarity: s.rarity,
      priceGems: s.price === undefined ? priceFor(kind, s.rarity) : s.price,
      premiumOnly: !!s.premiumOnly,
      params: s.params,
    };
    if (s.passTier !== undefined) item.passTier = s.passTier;
    return item;
  });
}

// ─────────────────────────── avatars ───────────────────────────

const AVATARS = build('avatar', [
  {
    id: 'avatar-first-light',
    name: 'First Light',
    description: 'The face you had before you learned to fold.',
    rarity: 'common',
    params: { motif: 'sunrise', bgA: '#2b3d55', bgB: '#141d2c', accent: '#edc96b', ink: '#f2f5fb', anim: 'none' },
  },
  {
    id: 'avatar-back-room',
    name: 'Back Room',
    description: 'One bulb, four players, no clock on the wall.',
    rarity: 'common',
    params: { motif: 'lamp', bgA: '#33291d', bgB: '#161009', accent: '#f0b23f', ink: '#f7ecd6', anim: 'none' },
  },
  {
    id: 'avatar-graveyard',
    name: 'Graveyard Shift',
    description: 'Best games run between two and five in the morning.',
    rarity: 'common',
    params: { motif: 'moon', bgA: '#1e2740', bgB: '#0a0e19', accent: '#8fa6d8', ink: '#e6ecfa', anim: 'none' },
  },
  {
    id: 'avatar-coffee-grinder',
    name: 'The Grinder',
    description: 'Twelve tables, one cup, zero personality.',
    rarity: 'common',
    params: { motif: 'gears', bgA: '#37312a', bgB: '#15120e', accent: '#c9a578', ink: '#efe6da', anim: 'none' },
  },
  {
    id: 'avatar-neon-rail',
    name: 'Neon Rail',
    description: 'Railbird energy, permanently plugged in.',
    rarity: 'rare',
    params: { motif: 'visor', bgA: '#1b2f4d', bgB: '#0a1122', accent: '#47a9ff', ink: '#eaf4ff', anim: 'none' },
  },
  {
    id: 'avatar-velvet-rope',
    name: 'Velvet Rope',
    description: 'You do not queue. You are the reason there is a queue.',
    rarity: 'rare',
    params: { motif: 'crown', bgA: '#3d1f34', bgB: '#160b14', accent: '#e6688f', ink: '#fbe8f0', anim: 'none' },
  },
  {
    id: 'avatar-ice-queen',
    name: 'Ice Queen',
    description: 'Snap-calls a five-bet shove and asks for a still water.',
    rarity: 'rare',
    params: { motif: 'crystal', bgA: '#1d3a44', bgB: '#08151b', accent: '#7fe3ea', ink: '#e8fbfd', anim: 'none' },
  },
  {
    id: 'avatar-riverboat',
    name: 'Riverboat',
    description: 'Old money, older deck, brand-new tell.',
    rarity: 'rare',
    params: { motif: 'anchor', bgA: '#2a3a2c', bgB: '#0d150e', accent: '#c8b264', ink: '#f2f0e0', anim: 'none' },
  },
  {
    id: 'avatar-desert-rounder',
    name: 'Desert Rounder',
    description: 'Drove eleven hours for a soft five-ten. Worth it.',
    rarity: 'rare',
    params: { motif: 'sun', bgA: '#4a3320', bgB: '#1c1108', accent: '#f2953c', ink: '#fdeedb', anim: 'none' },
  },
  {
    id: 'avatar-the-mechanic',
    name: 'The Mechanic',
    description: 'Hands so clean the dealer watches them out of respect.',
    rarity: 'epic',
    params: { motif: 'hands', bgA: '#2c2438', bgB: '#100c18', accent: '#a855f7', ink: '#f1e9ff', anim: 'none' },
  },
  {
    id: 'avatar-midnight-oracle',
    name: 'Midnight Oracle',
    description: 'Calls your bluff before you have finished deciding to run it.',
    rarity: 'epic',
    params: { motif: 'eye', bgA: '#232a4a', bgB: '#0b0e1e', accent: '#8f7bff', ink: '#ece9ff', anim: 'none' },
  },
  {
    id: 'avatar-obsidian-fox',
    name: 'Obsidian Fox',
    description: 'Small pots, enormous patience, terrible news for you.',
    rarity: 'epic',
    params: { motif: 'fox', bgA: '#2f2029', bgB: '#120b10', accent: '#ff8a5b', ink: '#ffeadf', anim: 'none' },
  },
  {
    id: 'avatar-crimson-baron',
    name: 'Crimson Baron',
    description: 'Raises with the whole range and means every bit of it.',
    rarity: 'epic',
    params: { motif: 'shield', bgA: '#3d1a1c', bgB: '#170708', accent: '#f0524f', ink: '#ffe6e5', anim: 'none' },
  },
  {
    id: 'avatar-solar-flare',
    name: 'Solar Flare',
    description: 'Runs hot for eleven minutes and rewrites the leaderboard.',
    rarity: 'legendary',
    price: null,
    passTier: 20,
    params: { motif: 'flare', bgA: '#4d2b0d', bgB: '#1b0d03', accent: '#ffb020', ink: '#fff2d6', anim: 'shimmer' },
  },
  {
    id: 'avatar-house-of-spades',
    name: 'House of Spades',
    description: 'Wears the room like a jacket.',
    rarity: 'legendary',
    params: { motif: 'spade', bgA: '#12212c', bgB: '#050a0f', accent: '#edc96b', ink: '#fbf4e2', anim: 'shimmer' },
  },
  {
    id: 'avatar-golden-hour',
    name: 'Golden Hour',
    description: 'That last orbit before the game breaks and everyone is loose.',
    rarity: 'legendary',
    params: { motif: 'sunrise', bgA: '#57370f', bgB: '#1e1204', accent: '#ffd074', ink: '#fff6e2', anim: 'shift' },
  },
  {
    id: 'avatar-the-phantom',
    name: 'The Phantom',
    description: 'Nobody has seen the hand. Nobody has seen the player.',
    rarity: 'mythic',
    params: { motif: 'mask', bgA: '#1a1a26', bgB: '#07070d', accent: '#ff4d8d', ink: '#ffe9f1', anim: 'particles' },
  },
  {
    id: 'avatar-quiet-professional',
    name: 'Quiet Professional',
    description: 'No sunglasses, no headphones, no leaks.',
    rarity: 'epic',
    premiumOnly: true,
    params: { motif: 'suit', bgA: '#232c33', bgB: '#0a0e11', accent: '#cfd8e0', ink: '#f4f8fb', anim: 'shift' },
  },
  {
    id: 'avatar-black-card',
    name: 'Black Card',
    description: 'Metal, heavy, and never once declined.',
    rarity: 'legendary',
    premiumOnly: true,
    params: { motif: 'card', bgA: '#141416', bgB: '#050506', accent: '#d9a93a', ink: '#f6efdc', anim: 'shimmer' },
  },
  {
    id: 'avatar-aurora-syndicate',
    name: 'Aurora Syndicate',
    description: 'Backed by people who do not appear in photographs.',
    rarity: 'legendary',
    premiumOnly: true,
    params: { motif: 'aurora', bgA: '#0f3a3c', bgB: '#04141a', accent: '#4ff0c0', ink: '#e4fff7', anim: 'shift' },
  },
  {
    id: 'avatar-eclipse-royale',
    name: 'Eclipse Royale',
    description: 'The table dims a little when you sit down. That is on purpose.',
    rarity: 'mythic',
    premiumOnly: true,
    params: { motif: 'eclipse', bgA: '#1b1030', bgB: '#06040e', accent: '#c9a0ff', ink: '#f3ecff', anim: 'particles' },
  },
  {
    id: 'avatar-founders-crest',
    name: "Founder's Crest",
    description: 'Season one. There will only ever be one season one.',
    rarity: 'mythic',
    premiumOnly: true,
    params: { motif: 'crest', bgA: '#30250c', bgB: '#0d0a03', accent: '#ffd97a', ink: '#fff8e6', anim: 'particles' },
  },
]);

// ─────────────────────────── frames ───────────────────────────

const FRAMES = build('frame', [
  {
    id: 'frame-hairline',
    name: 'Hairline',
    description: 'A single bright line. Restraint reads as confidence.',
    rarity: 'common',
    params: { metal: 'steel', style: 'hairline', glow: '#b7bfd0', anim: 'none' },
  },
  {
    id: 'frame-brass',
    name: 'Brass Fitting',
    description: 'Warm, slightly worn, screwed on by hand.',
    rarity: 'common',
    params: { metal: 'brass', style: 'bevel', glow: '#c08d21', anim: 'none' },
  },
  {
    id: 'frame-bevel',
    name: 'Cut Bevel',
    description: 'Forty-five degrees of unnecessary precision.',
    rarity: 'common',
    params: { metal: 'chrome', style: 'bevel', glow: '#dfe4ee', anim: 'none' },
  },
  {
    id: 'frame-laurel',
    name: 'Laurel',
    description: 'For people who win things and want it mentioned.',
    rarity: 'rare',
    params: { metal: 'gold', style: 'laurel', glow: '#edc96b', anim: 'none' },
  },
  {
    id: 'frame-rope',
    name: 'Rope Twist',
    description: 'Borrowed from a chandelier in a room you cannot afford.',
    rarity: 'rare',
    params: { metal: 'gold', style: 'rope', glow: '#d9a93a', anim: 'none' },
  },
  {
    id: 'frame-obsidian',
    name: 'Obsidian',
    description: 'Black on black, with one hairline of light to prove it exists.',
    rarity: 'rare',
    params: { metal: 'gunmetal', style: 'hairline', glow: '#5b6478', anim: 'none' },
  },
  {
    id: 'frame-glacier',
    name: 'Glacier',
    description: 'Cold enough that opponents check the timer twice.',
    rarity: 'epic',
    params: { metal: 'chrome', style: 'serrated', glow: '#7fe3ea', anim: 'shift' },
  },
  {
    id: 'frame-ember',
    name: 'Ember',
    description: 'Still glowing from the last three-bet pot.',
    rarity: 'epic',
    params: { metal: 'copper', style: 'flame', glow: '#ff7a3c', anim: 'shift' },
  },
  {
    id: 'frame-circuitry',
    name: 'Circuitry',
    description: 'Solver-approved, human-adjacent.',
    rarity: 'epic',
    params: { metal: 'gunmetal', style: 'circuit', glow: '#47a9ff', anim: 'shift' },
  },
  {
    id: 'frame-serpentine',
    name: 'Serpentine',
    description: 'Coils once around the portrait and waits.',
    rarity: 'legendary',
    price: null,
    passTier: 25,
    params: { metal: 'gold', style: 'rope', glow: '#34d399', anim: 'shimmer' },
  },
  {
    id: 'frame-royale',
    name: 'Royale',
    description: 'The house frame. You do not buy it quietly.',
    rarity: 'legendary',
    params: { metal: 'gold', style: 'laurel', glow: '#f6e0a0', anim: 'shimmer' },
  },
  {
    id: 'frame-eclipse',
    name: 'Eclipse',
    description: 'A ring of light around something you cannot look at directly.',
    rarity: 'mythic',
    params: { metal: 'gunmetal', style: 'flame', glow: '#c9a0ff', anim: 'particles' },
  },
]);

// ─────────────────────────── table skins ───────────────────────────

const TABLE_SKINS = build('table-skin', [
  {
    id: 'skin-house-emerald',
    name: 'House Emerald',
    description: 'The felt every good story starts on.',
    rarity: 'common',
    params: {
      feltColor: '#14432d', feltDeep: '#06180f', railMaterial: 'leather', trimMetal: 'brass',
      logoId: 'spade', previewA: '#1c5a3c', previewB: '#06180f', glow: 0.16,
    },
  },
  {
    id: 'skin-midnight-baize',
    name: 'Midnight Baize',
    description: 'Green so dark it argues it is blue.',
    rarity: 'common',
    params: {
      feltColor: '#0e2a33', feltDeep: '#041116', railMaterial: 'leather', trimMetal: 'gunmetal',
      logoId: 'crown', previewA: '#14424f', previewB: '#041116', glow: 0.14,
    },
  },
  {
    id: 'skin-riverboat',
    name: 'Riverboat',
    description: 'Mahogany rail, brass rivets, and a faint smell of the 1890s.',
    rarity: 'rare',
    params: {
      feltColor: '#1d4a34', feltDeep: '#07180f', railMaterial: 'walnut', trimMetal: 'brass',
      logoId: 'anchor', previewA: '#276b48', previewB: '#170d06', glow: 0.2,
    },
  },
  {
    id: 'skin-monte-carlo',
    name: 'Monte Carlo',
    description: 'Marble rail, sea air, and a minimum you should not mention.',
    rarity: 'rare',
    params: {
      feltColor: '#123f52', feltDeep: '#051720', railMaterial: 'marble', trimMetal: 'gold',
      logoId: 'crown', previewA: '#1b6483', previewB: '#051720', glow: 0.24,
    },
  },
  {
    id: 'skin-oxblood',
    name: 'Oxblood',
    description: 'Deep red leather that has heard some things.',
    rarity: 'rare',
    params: {
      feltColor: '#4a1620', feltDeep: '#18060a', railMaterial: 'leather', trimMetal: 'copper',
      logoId: 'spade', previewA: '#6d2130', previewB: '#18060a', glow: 0.22,
    },
  },
  {
    id: 'skin-sapphire-room',
    name: 'Sapphire Room',
    description: 'Private, cold, and reserved under a different name.',
    rarity: 'epic',
    params: {
      feltColor: '#152a63', feltDeep: '#050b1e', railMaterial: 'suede', trimMetal: 'chrome',
      logoId: 'diamond', previewA: '#2543a0', previewB: '#050b1e', glow: 0.3,
    },
  },
  {
    id: 'skin-carbon-vault',
    name: 'Carbon Vault',
    description: 'Woven carbon rail. Nothing here is decorative.',
    rarity: 'epic',
    params: {
      feltColor: '#1c2230', feltDeep: '#070a10', railMaterial: 'carbon', trimMetal: 'gunmetal',
      logoId: 'shield', previewA: '#2b3546', previewB: '#070a10', glow: 0.26,
    },
  },
  {
    id: 'skin-desert-sun',
    name: 'Desert Sun',
    description: 'Sand felt, copper rail, and a game that never breaks.',
    rarity: 'epic',
    params: {
      feltColor: '#5a3b17', feltDeep: '#1d1005', railMaterial: 'walnut', trimMetal: 'copper',
      logoId: 'sun', previewA: '#8c5c22', previewB: '#1d1005', glow: 0.3,
    },
  },
  {
    id: 'skin-tokyo-neon',
    name: 'Tokyo Neon',
    description: 'Lacquer rail with a magenta underglow that hits the chips.',
    rarity: 'legendary',
    params: {
      feltColor: '#221436', feltDeep: '#0a0514', railMaterial: 'lacquer', trimMetal: 'chrome',
      logoId: 'lotus', previewA: '#5a1f7a', previewB: '#0a0514', glow: 0.46,
    },
  },
  {
    id: 'skin-gilded-age',
    name: 'Gilded Age',
    description: 'Every edge is gold. Yes, that one too.',
    rarity: 'legendary',
    params: {
      feltColor: '#2c2412', feltDeep: '#0e0b04', railMaterial: 'walnut', trimMetal: 'gold',
      logoId: 'crest', previewA: '#6d5a1e', previewB: '#0e0b04', glow: 0.44,
    },
  },
  {
    id: 'skin-black-orchid',
    name: 'Black Orchid',
    description: 'Suede rail, violet bloom, and terrible manners.',
    rarity: 'legendary',
    price: null,
    passTier: 50,
    params: {
      feltColor: '#231038', feltDeep: '#0a0413', railMaterial: 'suede', trimMetal: 'rose',
      logoId: 'orchid', previewA: '#4c1c74', previewB: '#0a0413', glow: 0.42,
    },
  },
  {
    id: 'skin-aurora-borealis',
    name: 'Aurora Borealis',
    description: 'The felt has weather. Do not ask how.',
    rarity: 'mythic',
    params: {
      feltColor: '#08343a', feltDeep: '#02110f', railMaterial: 'lacquer', trimMetal: 'chrome',
      logoId: 'aurora', previewA: '#0f7a6a', previewB: '#062038', glow: 0.6,
    },
  },
  {
    id: 'skin-royale-noir',
    name: 'Royale Noir',
    description: 'The room the house keeps for itself.',
    rarity: 'mythic',
    premiumOnly: true,
    params: {
      feltColor: '#0d0d10', feltDeep: '#040405', railMaterial: 'leather', trimMetal: 'gold',
      logoId: 'crown', previewA: '#2a2418', previewB: '#040405', glow: 0.56,
    },
  },
]);

// ─────────────────────────── card backs ───────────────────────────

const CARD_BACKS = build('card-back', [
  {
    id: 'back-classic-lattice',
    name: 'Classic Lattice',
    description: 'The pattern your grandfather counted outs behind.',
    rarity: 'common',
    params: { baseA: '#1b2740', baseB: '#0d1426', ink: '#8aa0cc', metal: 'none', pattern: 'lattice' },
  },
  {
    id: 'back-linen',
    name: 'Linen Press',
    description: 'Woven, matte, and impossible to mark.',
    rarity: 'common',
    params: { baseA: '#33302a', baseB: '#1a1815', ink: '#c9bda6', metal: 'none', pattern: 'weave' },
  },
  {
    id: 'back-pinstripe',
    name: 'Pinstripe',
    description: 'Business casual for a deck of cards.',
    rarity: 'common',
    params: { baseA: '#232a38', baseB: '#12161f', ink: '#9fb0cc', metal: 'none', pattern: 'chevron' },
  },
  {
    id: 'back-guilloche',
    name: 'Guilloché',
    description: 'The engine-turned pattern they put on banknotes.',
    rarity: 'rare',
    params: { baseA: '#132b3d', baseB: '#08151f', ink: '#5fc4e0', metal: 'chrome', pattern: 'guilloche' },
  },
  {
    id: 'back-jade-scale',
    name: 'Jade Scale',
    description: 'Overlapping scales that catch the light as the card turns.',
    rarity: 'rare',
    params: { baseA: '#0f3b2e', baseB: '#061a14', ink: '#4fd6a0', metal: 'none', pattern: 'scale' },
  },
  {
    id: 'back-oxblood-chevron',
    name: 'Oxblood Chevron',
    description: 'Angular, dark red, and slightly aggressive about it.',
    rarity: 'rare',
    params: { baseA: '#3d1218', baseB: '#1a070a', ink: '#e08a90', metal: 'copper', pattern: 'chevron' },
  },
  {
    id: 'back-crimson-crest',
    name: 'Crimson Crest',
    description: 'A coat of arms for a family that does not exist.',
    rarity: 'epic',
    params: { baseA: '#4a1116', baseB: '#1c0508', ink: '#ffc9b0', metal: 'gold', pattern: 'crest' },
  },
  {
    id: 'back-copper-weave',
    name: 'Copper Weave',
    description: 'Fine copper thread through a dark matte ground.',
    rarity: 'epic',
    params: { baseA: '#32211a', baseB: '#150d09', ink: '#e79a63', metal: 'copper', pattern: 'weave' },
  },
  {
    id: 'back-starfield',
    name: 'Starfield',
    description: 'A very small piece of a very large sky.',
    rarity: 'epic',
    params: { baseA: '#141a34', baseB: '#06080f', ink: '#a9bcff', metal: 'chrome', pattern: 'starfield' },
  },
  {
    id: 'back-royal-monogram',
    name: 'Royal Monogram',
    description: 'One letter, repeated until it becomes a texture.',
    rarity: 'legendary',
    params: { baseA: '#241c0c', baseB: '#0d0a04', ink: '#f6e0a0', metal: 'gold', pattern: 'monogram' },
  },
  {
    id: 'back-liquid-gold',
    name: 'Liquid Gold',
    description: 'Poured, not printed.',
    rarity: 'legendary',
    price: null,
    passTier: 40,
    params: { baseA: '#3a2a08', baseB: '#120c02', ink: '#ffdf95', metal: 'gold', pattern: 'guilloche' },
  },
  {
    id: 'back-obsidian-mirror',
    name: 'Obsidian Mirror',
    description: 'You can see the whole table in the back of your own hand.',
    rarity: 'mythic',
    params: { baseA: '#101014', baseB: '#040406', ink: '#c9d2e6', metal: 'chrome', pattern: 'lattice' },
  },
  {
    id: 'back-holo-prism',
    name: 'Holo Prism',
    description: 'Shifts through the spectrum as the card leaves your hand.',
    rarity: 'mythic',
    params: { baseA: '#1a1038', baseB: '#08040f', ink: '#ff9ae0', metal: 'holo', pattern: 'scale' },
  },
]);

// ─────────────────────────── chip sets ───────────────────────────

const CHIP_SETS = build('chip-set', [
  {
    id: 'chips-casino-standard',
    name: 'Casino Standard',
    description: 'Eight-stripe edge spot. The one everyone learns to riffle on.',
    rarity: 'common',
    params: { primary: '#c9302c', secondary: '#f7f9fd', edge: '#7d1a17', inlay: 'ring', stripes: 8 },
  },
  {
    id: 'chips-clay-classic',
    name: 'Clay Classic',
    description: 'Heavy, chalky, and slightly too loud in a quiet room.',
    rarity: 'common',
    params: { primary: '#e8e2d4', secondary: '#2a3143', edge: '#b3aa96', inlay: 'dots', stripes: 6 },
  },
  {
    id: 'chips-monaco',
    name: 'Monaco',
    description: 'Cobalt and ivory, made for a table with a view.',
    rarity: 'rare',
    params: { primary: '#1f5fbf', secondary: '#f2f6ff', edge: '#123a78', inlay: 'ring', stripes: 12 },
  },
  {
    id: 'chips-neon-edge',
    name: 'Neon Edge',
    description: 'The edge spots glow when the pot passes a hundred big blinds.',
    rarity: 'rare',
    params: { primary: '#16202e', secondary: '#3ef0c8', edge: '#0a1119', inlay: 'bar', stripes: 10 },
  },
  {
    id: 'chips-ivory-inlay',
    name: 'Ivory Inlay',
    description: 'Hand-set centre disc, slightly off-white on purpose.',
    rarity: 'epic',
    params: { primary: '#2c2a26', secondary: '#f4ecd8', edge: '#141310', inlay: 'disc', stripes: 8 },
  },
  {
    id: 'chips-carbon-fiber',
    name: 'Carbon Fibre',
    description: 'Weighs nothing, costs everything.',
    rarity: 'epic',
    params: { primary: '#1a1e26', secondary: '#8fa0b8', edge: '#0a0c10', inlay: 'bar', stripes: 4 },
  },
  {
    id: 'chips-jade-imperial',
    name: 'Jade Imperial',
    description: 'Carved centres, and a stack that sounds like rain.',
    rarity: 'epic',
    params: { primary: '#0f4a37', secondary: '#7fe3c0', edge: '#062018', inlay: 'disc', stripes: 12 },
  },
  {
    id: 'chips-24k',
    name: '24K',
    description: 'Nobody needs a gold chip. That is rather the point.',
    rarity: 'legendary',
    params: { primary: '#c08d21', secondary: '#fdf3d0', edge: '#63460a', inlay: 'ring', stripes: 16 },
  },
  {
    id: 'chips-obsidian-royale',
    name: 'Obsidian Royale',
    description: 'Black chips with a gold hairline you only see when they move.',
    rarity: 'legendary',
    price: null,
    passTier: 45,
    params: { primary: '#101116', secondary: '#edc96b', edge: '#050609', inlay: 'ring', stripes: 8 },
  },
  {
    id: 'chips-plasma',
    name: 'Plasma',
    description: 'The centre disc is doing something it should not be able to do.',
    rarity: 'mythic',
    params: { primary: '#2a0e42', secondary: '#ff6ad5', edge: '#120520', inlay: 'disc', stripes: 14 },
  },
  {
    id: 'chips-founders-mint',
    name: "Founder's Mint",
    description: 'Serial-numbered. Yours ends in your account number.',
    rarity: 'mythic',
    premiumOnly: true,
    params: { primary: '#1c1a12', secondary: '#ffdf95', edge: '#0a0906', inlay: 'crest', stripes: 20 },
  },
]);

// ─────────────────────────── emotes ───────────────────────────

const EMOTES = build('emote', [
  {
    id: 'emote-core',
    name: 'House Set',
    description: 'The six everyone understands, in any language.',
    rarity: 'common',
    price: 0,
    params: { set: 'fire,skull,clown,money,shock,clap', tint: '#dfe4ee' },
  },
  {
    id: 'emote-tilt',
    name: 'Tilt Kit',
    description: 'For the twenty minutes after a two-outer.',
    rarity: 'common',
    params: { set: 'skull,shock,clown,cold,laugh,eyes', tint: '#f6534f' },
  },
  {
    id: 'emote-riverboat',
    name: 'Riverboat Manners',
    description: 'Politely devastating. Tip your dealer.',
    rarity: 'rare',
    params: { set: 'clap,heart,money,eyes,fire,laugh', tint: '#c8b264' },
  },
  {
    id: 'emote-highroller',
    name: 'High Roller',
    description: 'Six ways to say "that was nothing".',
    rarity: 'rare',
    params: { set: 'money,fire,eyes,clap,cold,heart', tint: '#edc96b' },
  },
  {
    id: 'emote-noir',
    name: 'Noir',
    description: 'Monochrome reactions for people who do not raise their voice.',
    rarity: 'epic',
    params: { set: 'eyes,cold,skull,clap,shock,laugh', tint: '#b7bfd0' },
  },
  {
    id: 'emote-menagerie',
    name: 'Menagerie',
    description: 'Every animal a poker player has ever been called.',
    rarity: 'epic',
    params: { set: 'clown,fire,skull,laugh,eyes,heart', tint: '#34d399' },
  },
  {
    id: 'emote-gilded',
    name: 'Gilded',
    description: 'Gold-leafed reactions that leave a little dust behind.',
    rarity: 'legendary',
    params: { set: 'money,fire,clap,heart,eyes,shock', tint: '#f6e0a0' },
  },
  {
    id: 'emote-villain',
    name: 'Villain Arc',
    description: 'You have decided to be the story other people tell.',
    rarity: 'legendary',
    price: null,
    passTier: 35,
    params: { set: 'skull,laugh,clown,fire,cold,eyes', tint: '#a855f7' },
  },
  {
    id: 'emote-cosmic',
    name: 'Cosmic',
    description: 'Reactions with their own small gravitational field.',
    rarity: 'mythic',
    params: { set: 'fire,shock,eyes,heart,money,clap', tint: '#ff4d8d' },
  },
  {
    id: 'emote-founders',
    name: "Founder's Circle",
    description: 'Only visible to people who were here first.',
    rarity: 'mythic',
    premiumOnly: true,
    params: { set: 'crown,fire,money,clap,heart,eyes', tint: '#ffd97a' },
  },
]);

// ─────────────────────────── titles ───────────────────────────

const TITLES = build('title', [
  { id: 'title-rounder', name: 'Rounder', description: 'Plays every night, mentions it never.', rarity: 'common', params: { text: 'Rounder', tone: 'neutral' } },
  { id: 'title-regular', name: 'The Regular', description: 'The dealer knows your drink order.', rarity: 'common', params: { text: 'The Regular', tone: 'neutral' } },
  { id: 'title-nit', name: 'Certified Nit', description: 'Worn with pride, folded with discipline.', rarity: 'common', params: { text: 'Certified Nit', tone: 'cool' } },
  { id: 'title-donator', name: 'Generous Donor', description: 'The table thanks you for your service.', rarity: 'common', params: { text: 'Generous Donor', tone: 'warm' } },
  { id: 'title-river-rat', name: 'River Rat', description: 'Two outs is a plan if you believe hard enough.', rarity: 'rare', params: { text: 'River Rat', tone: 'good' } },
  { id: 'title-three-bet-bully', name: 'Three-Bet Bully', description: 'The button is not a suggestion.', rarity: 'rare', params: { text: 'Three-Bet Bully', tone: 'bad' } },
  { id: 'title-bankroll-nit', name: 'Bankroll Monk', description: 'Thirty buy-ins or nothing.', rarity: 'rare', params: { text: 'Bankroll Monk', tone: 'cool' } },
  { id: 'title-crusher', name: 'Stakes Crusher', description: 'Moved up. Stayed up.', rarity: 'epic', params: { text: 'Stakes Crusher', tone: 'gold' } },
  { id: 'title-table-captain', name: 'Table Captain', description: 'Sets the pace, sets the price.', rarity: 'epic', params: { text: 'Table Captain', tone: 'gold' } },
  { id: 'title-cooler-merchant', name: 'Cooler Merchant', description: 'Business is unfortunately excellent.', rarity: 'epic', params: { text: 'Cooler Merchant', tone: 'epic' } },
  { id: 'title-the-mechanic', name: 'The Mechanic', description: 'Awarded, not sold.', rarity: 'legendary', price: null, passTier: 30, params: { text: 'The Mechanic', tone: 'epic' } },
  { id: 'title-high-roller', name: 'High Roller', description: 'The nosebleeds are just a room with better chairs.', rarity: 'legendary', params: { text: 'High Roller', tone: 'gold' } },
  { id: 'title-royale', name: 'Royale', description: 'One word. It does the work.', rarity: 'mythic', params: { text: 'Royale', tone: 'mythic' } },
  { id: 'title-founder', name: 'Founder', description: 'Season one, table one, seat one.', rarity: 'mythic', premiumOnly: true, params: { text: 'Founder', tone: 'mythic' } },
]);

// ─────────────────────────── felts ───────────────────────────

const FELTS = build('felt', [
  {
    id: 'felt-house-green',
    name: 'House Green',
    description: 'Speed cloth, broken in, honest.',
    rarity: 'common',
    params: { feltColor: '#14432d', feltDeep: '#06180f', pattern: 'plain', sheen: 0.22 },
  },
  {
    id: 'felt-slate',
    name: 'Slate',
    description: 'Grey enough that the cards do all the talking.',
    rarity: 'common',
    params: { feltColor: '#242b38', feltDeep: '#0b0e15', pattern: 'plain', sheen: 0.18 },
  },
  {
    id: 'felt-burgundy',
    name: 'Burgundy',
    description: 'Wine-dark and slightly theatrical.',
    rarity: 'rare',
    params: { feltColor: '#40151f', feltDeep: '#160609', pattern: 'herringbone', sheen: 0.26 },
  },
  {
    id: 'felt-ocean',
    name: 'Deep Ocean',
    description: 'The colour of the drop-off, about ninety metres down.',
    rarity: 'rare',
    params: { feltColor: '#0e3350', feltDeep: '#04121e', pattern: 'plain', sheen: 0.3 },
  },
  {
    id: 'felt-ash-herringbone',
    name: 'Ash Herringbone',
    description: 'Tailored cloth. You can see the weave from the button.',
    rarity: 'epic',
    params: { feltColor: '#2b2f36', feltDeep: '#0d0f13', pattern: 'herringbone', sheen: 0.34 },
  },
  {
    id: 'felt-imperial-violet',
    name: 'Imperial Violet',
    description: 'Historically expensive, currently gorgeous.',
    rarity: 'epic',
    params: { feltColor: '#2c1550', feltDeep: '#0d0620', pattern: 'diamond', sheen: 0.36 },
  },
  {
    id: 'felt-molten',
    name: 'Molten',
    description: 'The centre runs a little hot when the pot does.',
    rarity: 'legendary',
    price: null,
    passTier: 15,
    params: { feltColor: '#4a1a08', feltDeep: '#180702', pattern: 'diamond', sheen: 0.44 },
  },
  {
    id: 'felt-nebula',
    name: 'Nebula',
    description: 'Star nursery, cut to a nine-foot oval.',
    rarity: 'mythic',
    params: { feltColor: '#161a44', feltDeep: '#05060f', pattern: 'starfield', sheen: 0.5 },
  },
]);

// ─────────────────────────── the catalog ───────────────────────────

export const CATALOG: CosmeticItem[] = [
  ...AVATARS,
  ...FRAMES,
  ...TABLE_SKINS,
  ...CARD_BACKS,
  ...CHIP_SETS,
  ...EMOTES,
  ...TITLES,
  ...FELTS,
];

const BY_ID = new Map<string, CosmeticItem>(CATALOG.map((i) => [i.id, i]));

export function itemById(id: string): CosmeticItem | undefined {
  return BY_ID.get(id);
}

export function itemsOfKind(kind: CosmeticKind): CosmeticItem[] {
  return CATALOG.filter((i) => i.kind === kind);
}

/** Every item the pass hands out, keyed by the tier that grants it. */
export function passExclusives(): CosmeticItem[] {
  return CATALOG.filter((i) => i.priceGems === null);
}

// ─────────────────────────── presentation metadata ───────────────────────────

export interface KindMeta {
  kind: CosmeticKind;
  /** tab label */
  label: string;
  /** singular noun used in copy */
  noun: string;
  /** one line describing what the category changes */
  blurb: string;
}

/** Tab order for the store. Deliberately: identity first, table second. */
export const KIND_ORDER: CosmeticKind[] = [
  'avatar', 'frame', 'table-skin', 'card-back', 'chip-set', 'emote', 'title', 'felt',
];

export const KIND_META: Record<CosmeticKind, KindMeta> = {
  avatar: { kind: 'avatar', label: 'Avatars', noun: 'avatar', blurb: 'Your face at every table you sit down at.' },
  frame: { kind: 'frame', label: 'Frames', noun: 'frame', blurb: 'The ring around your portrait — the first thing anyone reads.' },
  'table-skin': { kind: 'table-skin', label: 'Tables', noun: 'table skin', blurb: 'Felt, rail and trim. Changes the whole room.' },
  'card-back': { kind: 'card-back', label: 'Card Backs', noun: 'card back', blurb: 'What the table sees fifty times an hour.' },
  'chip-set': { kind: 'chip-set', label: 'Chips', noun: 'chip set', blurb: 'Colours, edge spots and the sound of a riffle.' },
  emote: { kind: 'emote', label: 'Emotes', noun: 'emote set', blurb: 'Six reactions, chosen carefully.' },
  title: { kind: 'title', label: 'Titles', noun: 'title', blurb: 'The line under your name.' },
  felt: { kind: 'felt', label: 'Felts', noun: 'felt', blurb: 'Cloth only — pairs with any rail.' },
};

export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary', 'mythic'];

export interface RarityMeta {
  label: string;
  /** matches the --c-rar-* token ramp */
  color: string;
  /** how the drop is announced */
  flavour: string;
}

export const RARITY_META: Record<Rarity, RarityMeta> = {
  common: { label: 'Common', color: '#8891a5', flavour: 'Clean and quiet.' },
  rare: { label: 'Rare', color: '#47a9ff', flavour: 'Noticed at the table.' },
  epic: { label: 'Epic', color: '#a855f7', flavour: 'Remembered after the session.' },
  legendary: { label: 'Legendary', color: '#f5a524', flavour: 'One per table, at most.' },
  mythic: { label: 'Mythic', color: '#ff4d8d', flavour: 'People screenshot it.' },
};

/** What a brand-new account owns and wears. */
export const STARTER_ITEMS: string[] = [
  'avatar-first-light',
  'frame-hairline',
  'skin-house-emerald',
  'back-classic-lattice',
  'chips-casino-standard',
  'emote-core',
  'title-rounder',
  'felt-house-green',
];

export const DEFAULT_EQUIPPED: Partial<Record<CosmeticKind, string>> = {
  avatar: 'avatar-first-light',
  frame: 'frame-hairline',
  'table-skin': 'skin-house-emerald',
  'card-back': 'back-classic-lattice',
  'chip-set': 'chips-casino-standard',
  emote: 'emote-core',
  title: 'title-rounder',
  felt: 'felt-house-green',
};

/**
 * The featured rotation. Index by day so the hero changes daily but stays
 * stable within a session — nothing is more suspicious than a store that
 * reshuffles while you are looking at it.
 */
export const FEATURED_IDS: string[] = [
  'skin-aurora-borealis',
  'avatar-the-phantom',
  'back-holo-prism',
  'skin-tokyo-neon',
  'chips-plasma',
  'avatar-eclipse-royale',
  'felt-nebula',
];

export function featuredToday(now = Date.now()): CosmeticItem {
  const day = Math.floor(now / 86_400_000);
  return BY_ID.get(FEATURED_IDS[day % FEATURED_IDS.length]) ?? CATALOG[0];
}

/** A small, rarity-mixed shelf under the hero. Stable per day. */
export function spotlightToday(now = Date.now()): CosmeticItem[] {
  const day = Math.floor(now / 86_400_000);
  const pool = CATALOG.filter((i) => i.priceGems !== null && !i.premiumOnly);
  const out: CosmeticItem[] = [];
  const seen = new Set<string>();
  const hero = featuredToday(now).id;
  seen.add(hero);
  for (let step = 0; out.length < 6 && step < pool.length; step++) {
    const idx = (day * 37 + step * 61) % pool.length;
    const item = pool[idx];
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// ─────────────────────────── gem bundles ───────────────────────────

export interface GemBundle {
  id: string;
  gems: number;
  /** free gems on top of the base amount */
  bonus: number;
  /** display price of the mock purchase */
  price: string;
  label: string;
  /** copy under the label */
  note: string;
  tag: 'none' | 'popular' | 'best-value';
}

/**
 * Standard five-tier shelf. Gems-per-dollar rises with the tier, which is the
 * honest version of this pattern: the bonus is stated in gems, not hidden in
 * a percentage nobody computes.
 */
export const GEM_BUNDLES: GemBundle[] = [
  { id: 'gems-pocket', gems: 500, bonus: 0, price: '$4.99', label: 'Pocket', note: 'A title and change.', tag: 'none' },
  { id: 'gems-stack', gems: 1200, bonus: 100, price: '$9.99', label: 'Stack', note: 'Most of a rare.', tag: 'none' },
  { id: 'gems-rack', gems: 2600, bonus: 400, price: '$19.99', label: 'Rack', note: 'An epic, comfortably.', tag: 'popular' },
  { id: 'gems-vault', gems: 6000, bonus: 1400, price: '$49.99', label: 'Vault', note: 'A legendary and a frame.', tag: 'best-value' },
  { id: 'gems-whale', gems: 14000, bonus: 4000, price: '$99.99', label: 'High Roller', note: 'Mythic territory.', tag: 'none' },
];

/** Gems per dollar, for the honest "value" line under each bundle. */
export function bundleRate(b: GemBundle): number {
  const dollars = Number(b.price.replace(/[^0-9.]/g, ''));
  return dollars > 0 ? (b.gems + b.bonus) / dollars : 0;
}
