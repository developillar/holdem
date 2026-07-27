/**
 * ROYALE — data/names.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The identity pool the whole app draws people from: screen names, human
 * display names, avatar ids and country codes, spread across a lot of
 * cultures so a lobby or a feed never reads like it was populated from a
 * single phone book.
 *
 * Everything here is *deterministic*. `personaAt(i)` returns the same person
 * forever, which means seeded feeds, seeded lobbies and seeded bot tables all
 * agree on who "RiverRatKing" is without anybody storing a roster.
 *
 *   const p = personaAt(1204);        // { handle, display, avatarId, … }
 *   const ref = playerFromPersona(p, { level: 34, premium: true });
 *   isFriend(p.id)                    // stable "is on your friends list"
 *
 * No placeholders, no `User123`: every string below is written to look like a
 * real person picked a real name.
 */
import type { PlayerRef } from '../core/types.ts';

export interface NamePersona {
  /** stable player id — safe to use as a map key or a FeedPost author id */
  id: string;
  /** the screen name shown in game */
  handle: string;
  /** the human name shown under it (may equal the handle for handle-only players) */
  display: string;
  avatarId: string;
  countryCode: string;
}

// ─────────────────────────── raw pools ───────────────────────────

/** Given names, deliberately wide: 30+ language traditions. */
export const GIVEN_NAMES: readonly string[] = [
  'Aiko', 'Akira', 'Alejandro', 'Alina', 'Amara', 'Ananya', 'Anders', 'Andrei',
  'Anika', 'Anouk', 'Antoine', 'Arjun', 'Aroha', 'Astrid', 'Ayaan', 'Ayşe',
  'Bao', 'Beatriz', 'Bilal', 'Björn', 'Bogdan', 'Callum', 'Camila', 'Carlos',
  'Chidi', 'Chloé', 'Ciara', 'Dagny', 'Damir', 'Daniela', 'Dev', 'Diego',
  'Dmitri', 'Ebele', 'Eitan', 'Elena', 'Elias', 'Emeka', 'Emil', 'Eoin',
  'Esther', 'Farah', 'Fatou', 'Felipe', 'Finn', 'Freya', 'Gabriel', 'Giulia',
  'Greta', 'Grigor', 'Hana', 'Hassan', 'Hina', 'Hiro', 'Hugo', 'Ibrahim',
  'Idris', 'Ilya', 'Inés', 'Ingrid', 'Isabela', 'Ivan', 'Jae', 'Jamal',
  'Janusz', 'Javier', 'Jelena', 'Jesper', 'Jian', 'Joanna', 'João', 'Jonas',
  'Julia', 'Kaito', 'Kalani', 'Karim', 'Kasia', 'Katya', 'Keanu', 'Kemal',
  'Kenji', 'Khalid', 'Kiran', 'Klara', 'Kwame', 'Lara', 'Lars', 'Layla',
  'Leila', 'Lena', 'Leon', 'Liang', 'Linnea', 'Lucas', 'Luka', 'Mads',
  'Magnus', 'Maja', 'Malik', 'Manu', 'Marco', 'Marek', 'Mariam', 'Marta',
  'Mateo', 'Matteo', 'Maya', 'Mehdi', 'Mei', 'Mika', 'Mikkel', 'Milena',
  'Mina', 'Miroslav', 'Nadia', 'Nadir', 'Naomi', 'Nasir', 'Ngozi', 'Nia',
  'Nikolai', 'Nina', 'Noor', 'Nuno', 'Oksana', 'Olamide', 'Oliver', 'Omar',
  'Oona', 'Otto', 'Paulo', 'Pedro', 'Petra', 'Piotr', 'Priya', 'Radu',
  'Rafael', 'Rania', 'Ravi', 'Reza', 'Rhys', 'Rin', 'Rocío', 'Rohan',
  'Rosa', 'Ruben', 'Rui', 'Saanvi', 'Sadia', 'Sami', 'Sanne', 'Santiago',
  'Sara', 'Sasha', 'Selin', 'Seoyeon', 'Sergio', 'Shreya', 'Sigrid', 'Simone',
  'Siobhan', 'Sofia', 'Søren', 'Stefan', 'Sung', 'Sven', 'Tadeo', 'Takeshi',
  'Tamar', 'Tane', 'Tariq', 'Thandiwe', 'Theo', 'Thiago', 'Tomas', 'Tove',
  'Tuan', 'Ugo', 'Valentina', 'Vera', 'Viktor', 'Vivek', 'Vlad', 'Wanda',
  'Wei', 'Wilhelm', 'Xiomara', 'Yara', 'Yasmin', 'Yohan', 'Yuki', 'Yusuf',
  'Zainab', 'Zara', 'Zeynep', 'Zoltán', 'Zuri',
];

/** Family names, matched in spread to the given names above. */
export const FAMILY_NAMES: readonly string[] = [
  'Achebe', 'Adeyemi', 'Almeida', 'Andersen', 'Arslan', 'Ashcroft', 'Aydın', 'Aziz',
  'Bakker', 'Barbosa', 'Bekele', 'Beltrán', 'Bennett', 'Berg', 'Bianchi', 'Botha',
  'Byrne', 'Campbell', 'Cardoso', 'Castillo', 'Çelik', 'Chen', 'Choi', 'Cohen',
  'Cortés', 'Costa', 'de Vries', 'Delgado', 'Demir', 'Diallo', 'Dimitrov', 'Dlamini',
  'Doyle', 'Dubois', 'Dvořák', 'Eriksson', 'Esposito', 'Fernández', 'Ferrari', 'Fitzgerald',
  'Fontana', 'García', 'Georgiev', 'Georgiou', 'Goldstein', 'Greco', 'Hakala', 'Haddad',
  'Halvorsen', 'Harrington', 'Herrera', 'Horváth', 'Hughes', 'Hussain', 'Ionescu', 'Ivanov',
  'Iyer', 'Jankowski', 'Jansen', 'Kalu', 'Karim', 'Karlsson', 'Kavanagh', 'Kaya',
  'Khan', 'Kim', 'Kone', 'Korhonen', 'Kovács', 'Kowalski', 'Kuznetsov', 'Larsen',
  'Laurent', 'Levi', 'Lewandowski', 'Lindqvist', 'Liu', 'Lombardi', 'Machado', 'MacLeod',
  'Magnússon', 'Marchetti', 'Marek', 'Mendoza', 'Mensah', 'Mizrahi', 'Moretti', 'Morozov',
  'Müller', 'Murphy', 'Mwangi', 'Nagy', 'Nakamura', 'Nasser', 'Navarro', 'Ndlovu',
  'Nguyen', 'Nielsen', 'Nikolaidis', 'Novak', 'Ochoa', 'Ólafsson', 'Orlov', 'O’Sullivan',
  'Öztürk', 'Papadopoulos', 'Park', 'Patel', 'Pereira', 'Petrov', 'Pham', 'Popescu',
  'Popov', 'Prescott', 'Procházka', 'Quintero', 'Rahman', 'Ramírez', 'Reddy', 'Rojas',
  'Rosenberg', 'Rossi', 'Salazar', 'Sato', 'Schneider', 'Serrano', 'Shapiro', 'Sharma',
  'Silva', 'Sinclair', 'Singh', 'Sokolov', 'Sørensen', 'Stewart', 'Stoyanov', 'Suzuki',
  'Szabó', 'Tanaka', 'Tesfaye', 'Torres', 'Tran', 'Traoré', 'van Dijk', 'Varga',
  'Vargas', 'Virtanen', 'Volkov', 'Wang', 'Weiss', 'Whitlock', 'Wójcik', 'Yamada',
  'Yılmaz', 'Zhao', 'Zieliński',
];

/**
 * Curated screen names. These carry the flavour — the ones a real poker app
 * is full of: nits, degens, table captains, people who name themselves after
 * their worst session.
 */
export const HANDLES: readonly string[] = [
  'RiverRatKing', 'nit_wizard', 'ChipTsunami', '3BetPolice', 'FoldEquityFC',
  'AllInAgain', 'PocketRockets88', 'SnapCallSteve', 'TurnBrick', 'BluffCatcher',
  'donkbet_dave', 'GutshotGospel', 'RunItTwice', 'SetMinerSupreme', 'OverbetOracle',
  'coolerhunter', 'MuckFace', 'BigSlickRick', 'TiltProofTina', 'FlopSpinner',
  'ValueTownMayor', 'checkraise_me', 'quads_or_bust', 'NoLimitNoor', 'RakebackRoyal',
  'BadBeatBaron', 'SoulReadSam', 'FourColorDeck', 'squeeze_play', 'TheBubbleBoy',
  'AceHighHero', 'PotOddsPriya', 'RangeMerger', 'shove_it_kid', 'BrokeInVegas',
  'MidnightGrind', 'BlockerBet', 'nine_high_call', 'CardDeadCarla', 'TheHammer72o',
  'FishFinder99', 'IcyRiverRun', 'SlowRollSorry', 'MonkeyTilt', 'DeepStackDee',
  'BombPotBoss', 'FlushDrawFlo', 'RunGoodOrDie', 'nitrolls', 'CalledDownLight',
  'PaperHandsPaul', 'GTOptional', 'SolverSlave', 'exploit_only', 'MinRaiseMartin',
  'TheLastLongball', 'StraddleSeason', 'JamOrFold', 'BackdoorNuts', 'sixthstreet',
  'HeadsUpHana', 'TableCaptainK', 'FinalTableFever', 'PayJumpPirate', 'ICM_Nightmare',
  'ShortStackShark', 'BubbleWrapped', 'OneTimeDealer', 'ChipAndAChair', 'StackTheDeckhand',
  'RiverGodComplex', 'AceOfSpadework', 'ColdFourBet', 'LimpReRaise', 'MuckedTheWinner',
  'TinyValueBet', 'PolarizedPete', 'CapMyRange', 'BluffToNowhere', 'HeroFoldHouse',
  'DrawingLive', 'RunnerRunnerR', 'NutLowNoise', 'OmahaOmen', 'PLO_Problems',
  'FourCardChaos', 'BigOEnergy', 'WrapAroundWally', 'SecondNutTrap', 'BlockerBlues',
  'MorningSessionM', 'GraveyardGrinder', 'TwoTablingTom', 'SixMaxSasha', 'ZoomZoomZane',
  'RakeIsTheft', 'VariancePilot', 'DownswingDiary', 'UpswingOnly', 'EVAdjusted',
  'SamplesizeSam', 'RedlineRider', 'BlueLineBlues', 'WinrateWatcher', 'GraphAddict',
  'TheQuietRaise', 'SilentTank', 'TimeBankTerror', 'InstaFoldIsh', 'ThinkingFace',
  'ChipsAhoyCap', 'ClayChipCollector', 'FeltAndFelt', 'DealerButtonD', 'SmallBlindShrug',
  'BigBlindBandit', 'AnteUpAmara', 'StraddleSlim', 'RunItThrice', 'BoardTexture',
  'PairedBoardPain', 'MonotoneMood', 'RainbowRiver', 'BrickBrickBrick', 'DoubleGutter',
  'OpenEndedOni', 'NutFlushNadir', 'BoatRaceBen', 'FullHouseFelipe', 'QuadDeuces',
  'TheWheelDeal', 'BroadwayBaby', 'SteelWheelSteel', 'RoyalRoadTrip', 'OneOuterOwen',
  'TwoOutTerror', 'SetOverSetSad', 'CoolerCollector', 'AcesCracked', 'KingsIntoAces',
  'QueensAreFine', 'JackHighJudo', 'TenTenTrouble', 'NinesAndFines', 'EightyEightGrind',
  'SevenDeuceSociety', 'ChopItUp', 'SplitPotSplitz', 'OddChipOdds', 'SidePotSidney',
  'MainPotMagnus', 'AllInPreOnly', 'NeverFolding', 'AlwaysFolding', 'MaybeFolding',
  'TightIsRight', 'LooseIsProduce', 'PassiveAggressive', 'AggroAurora', 'ManiacMode',
  'RockGardenRex', 'CallingStation7', 'ExploitTheStation', 'LevelOneThinker', 'LevelSixLoop',
  'MetaGamer', 'TableImageOnly', 'ShowOneCard', 'MuckAndSmile', 'SlowRollJail',
  'ChatBanned', 'EmoteSpammer', 'GGWPFriend', 'NiceHandSir', 'ThanksForTheCall',
  'SorryNotSorry', 'HadToLook', 'CuriosityKilled', 'PotCommitted', 'FoldedTheNuts',
  'MisclickMaster', 'FatFingerFred', 'DisconnectDave', 'ReconnectRita', 'SitOutSultan',
  'LateRegLarry', 'BountyHunterB', 'KnockoutKiran', 'ProgressiveKO', 'RebuyRegret',
  'AddOnAlways', 'FreezeoutFreya', 'TurboTiltTom', 'HyperHyperHana', 'SlowStructureSam',
  'ChipLeadChaser', 'PayoutJumpJoy', 'MinCashMike', 'DeepRunDreams', 'HeadsUpForRolls',
  'SecondPlaceSighs', 'TrophyShelfEmpty', 'FirstPlaceFinally', 'ShipItShipley', 'GGsOnly',
];

/** Adjective + noun stems for combinatorial handles beyond the curated list. */
const HANDLE_ADJ: readonly string[] = [
  'Silent', 'Golden', 'Crimson', 'Frozen', 'Velvet', 'Midnight', 'Iron', 'Wired',
  'Lucky', 'Bitter', 'Neon', 'Quiet', 'Savage', 'Humble', 'Reckless', 'Patient',
  'Feral', 'Polished', 'Broke', 'Loaded', 'Slick', 'Grim', 'Sunday', 'Vagrant',
  'Marble', 'Obsidian', 'Amber', 'Cobalt', 'Rusted', 'Gilded', 'Hollow', 'Restless',
];

const HANDLE_NOUN: readonly string[] = [
  'Raiser', 'Caller', 'Bluffer', 'Grinder', 'Shark', 'Dealer', 'Regular', 'Villain',
  'Hero', 'Nomad', 'Baron', 'Monk', 'Pilot', 'Ghost', 'Falcon', 'Wolf',
  'Anchor', 'Ember', 'Lantern', 'Compass', 'Verdict', 'Sermon', 'Alibi', 'Echo',
  'Cadence', 'Ledger', 'Marquee', 'Fortune', 'Tempest', 'Wager', 'Vault', 'Tide',
];

/**
 * Avatar ids. The renderer / Avatar component hashes these into a stable
 * portrait, so the exact strings only need to be distinct and evocative.
 */
export const AVATAR_IDS: readonly string[] = [
  'av-onyx', 'av-ivory', 'av-ember', 'av-cobalt', 'av-jade', 'av-rust', 'av-plum', 'av-sand',
  'av-slate', 'av-coral', 'av-moss', 'av-frost', 'av-clay', 'av-indigo', 'av-brass', 'av-ash',
  'av-mulberry', 'av-teal', 'av-saffron', 'av-storm', 'av-wine', 'av-sage', 'av-copper', 'av-dusk',
  'av-linen', 'av-cedar', 'av-lagoon', 'av-garnet', 'av-fern', 'av-basalt', 'av-honey', 'av-mist',
  'av-quarry', 'av-orchid', 'av-birch', 'av-cinder', 'av-lapis', 'av-peat', 'av-tangerine', 'av-pewter',
  'av-mallow', 'av-flint', 'av-marigold', 'av-harbor', 'av-thistle', 'av-oxide', 'av-glacier', 'av-tobacco',
  'av-heather', 'av-carbon', 'av-apricot', 'av-loam', 'av-cerulean', 'av-terracotta', 'av-juniper', 'av-bone',
  'av-magenta', 'av-driftwood', 'av-lichen', 'av-cove', 'av-pumice', 'av-nectar', 'av-shale', 'av-vermilion',
];

/** Country codes used for the little flag-ish chip on a nameplate. */
export const COUNTRY_CODES: readonly string[] = [
  'US', 'CA', 'BR', 'MX', 'AR', 'CO', 'GB', 'IE', 'FR', 'DE',
  'NL', 'BE', 'ES', 'PT', 'IT', 'CH', 'AT', 'SE', 'NO', 'DK',
  'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'TR',
  'UA', 'EE', 'LV', 'LT', 'IL', 'AE', 'SA', 'EG', 'MA', 'NG',
  'GH', 'KE', 'ZA', 'IN', 'PK', 'BD', 'TH', 'VN', 'PH', 'ID',
  'MY', 'SG', 'JP', 'KR', 'TW', 'HK', 'AU', 'NZ', 'CL', 'PE',
];

/** How many distinct personas the deterministic pool addresses. */
export const PERSONA_POOL_SIZE = 262_144;

// ─────────────────────────── deterministic mixing ───────────────────────────

/** splitmix32 — one integer in, one well-distributed integer out. */
function mix(n: number): number {
  let z = (n + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/** FNV-1a over a string — used to turn an id back into its persona index. */
export function hashString(str: string): number {
  let hv = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hv ^= str.charCodeAt(i);
    hv = Math.imul(hv, 0x01000193) >>> 0;
  }
  return hv >>> 0;
}

const STYLE_SUFFIX = ['', '', '', '', '7', '22', '99', '_', 'x', '00', '11', 'TV'];

/**
 * The persona at a given index. Pure, total, and stable forever — the same
 * index always yields the same person on every device and every build.
 */
export function personaAt(index: number): NamePersona {
  const i = ((index % PERSONA_POOL_SIZE) + PERSONA_POOL_SIZE) % PERSONA_POOL_SIZE;
  const a = mix(i * 3 + 1);
  const b = mix(i * 3 + 2);
  const c = mix(i * 3 + 3);

  const given = GIVEN_NAMES[a % GIVEN_NAMES.length];
  const family = FAMILY_NAMES[(a >>> 9) % FAMILY_NAMES.length];
  const style = b % 100;

  let handle: string;
  if (style < 46) {
    handle = HANDLES[(b >>> 7) % HANDLES.length];
    // Collisions in a 200-entry list are common; a tail keeps them distinct
    // without ever producing the dreaded "Name (2)".
    const tail = STYLE_SUFFIX[(c >>> 3) % STYLE_SUFFIX.length];
    handle = tail ? handle + tail : handle;
  } else if (style < 70) {
    handle = HANDLE_ADJ[(b >>> 11) % HANDLE_ADJ.length] + HANDLE_NOUN[(c >>> 5) % HANDLE_NOUN.length];
    if (c % 3 === 0) handle += String(10 + (c % 89));
  } else if (style < 86) {
    const short = given.toLowerCase().replace(/[^a-z]/g, '');
    handle = `${short}_${HANDLE_NOUN[(c >>> 5) % HANDLE_NOUN.length].toLowerCase()}`;
  } else {
    handle = `${given} ${family[0]}.`;
  }

  // Most players show a human name under the handle; handle-only players
  // (the ones whose handle already *is* their name) keep it clean.
  const display = style >= 86 ? `${given} ${family}` : style % 5 === 0 ? `${given} ${family}` : `${given} ${family[0]}.`;

  return {
    id: `p${i.toString(36)}`,
    handle,
    display,
    avatarId: AVATAR_IDS[(c >>> 13) % AVATAR_IDS.length],
    countryCode: COUNTRY_CODES[(a >>> 17) % COUNTRY_CODES.length],
  };
}

/** Persona for an arbitrary seed value (any 32-bit-ish number). */
export function personaForSeed(seed: number): NamePersona {
  return personaAt(mix(seed >>> 0) % PERSONA_POOL_SIZE);
}

/** Recover the persona behind an id produced by `personaAt`. */
export function personaById(id: string): NamePersona {
  const idx = parseInt(id.replace(/^p/, ''), 36);
  return personaAt(Number.isFinite(idx) ? idx : hashString(id));
}

/**
 * Whether a persona is on the local player's friends list. Deterministic and
 * sparse — roughly one in nine — which is what makes the Friends filter feel
 * like a real subset rather than a random half.
 */
export function isFriend(id: string): boolean {
  return mix(hashString(id)) % 9 === 0;
}

/** Level for a persona: skewed low with a long tail of grinders. */
export function levelFor(id: string): number {
  const r = mix(hashString(id) ^ 0x51ed270b) / 4294967296;
  return 2 + Math.floor(Math.pow(r, 2.1) * 118);
}

/** Premium subscribers are the minority — about one player in six. */
export function isPremium(id: string): boolean {
  return mix(hashString(id) ^ 0x2545f491) % 6 === 0;
}

export interface PlayerOverrides {
  level?: number;
  premium?: boolean;
  heat?: number;
  frameId?: string | null;
  titleId?: string | null;
  emoteSetId?: string;
}

/** Builds the shared `PlayerRef` the rest of the app consumes. */
export function playerFromPersona(p: NamePersona, over: PlayerOverrides = {}): PlayerRef {
  const seed = hashString(p.id);
  return {
    id: p.id,
    name: p.handle,
    avatarId: p.avatarId,
    frameId: over.frameId !== undefined ? over.frameId : frameFor(p.id),
    titleId: over.titleId !== undefined ? over.titleId : null,
    emoteSetId: over.emoteSetId ?? 'emote-core',
    level: over.level ?? levelFor(p.id),
    premium: over.premium ?? isPremium(p.id),
    heat: over.heat ?? Math.max(0, Math.min(1, (mix(seed ^ 0x7f4a7c15) / 4294967296) * 1.35 - 0.35)),
    countryCode: p.countryCode,
  };
}

const FRAME_IDS: readonly string[] = [
  'frame-hairline', 'frame-brass', 'frame-laurel', 'frame-obsidian',
  'frame-ember', 'frame-glacier', 'frame-royale',
];

/** Equipped avatar frame, if any — most players have none. */
export function frameFor(id: string): string | null {
  const r = mix(hashString(id) ^ 0x1b873593) % 100;
  if (r < 58) return null;
  return FRAME_IDS[r % FRAME_IDS.length];
}

/** Rarity of a persona's frame, for the Avatar ring treatment. */
export function frameRarity(frameId: string | null): 'common' | 'rare' | 'epic' | 'legendary' | 'mythic' | null {
  if (!frameId) return null;
  switch (frameId) {
    case 'frame-royale':
      return 'mythic';
    case 'frame-laurel':
    case 'frame-ember':
      return 'legendary';
    case 'frame-glacier':
    case 'frame-obsidian':
      return 'epic';
    case 'frame-brass':
      return 'rare';
    default:
      return 'common';
  }
}

/** A short, stable roster — handy for "friends online" strips. */
export function friendRoster(count: number, seed = 0x5150): NamePersona[] {
  const out: NamePersona[] = [];
  let n = 0;
  for (let i = 0; out.length < count && i < 20000; i++) {
    n = mix(seed + i);
    const p = personaAt(n % PERSONA_POOL_SIZE);
    if (isFriend(p.id) && !out.some((q) => q.id === p.id)) out.push(p);
  }
  return out;
}

/** The local player's identity, until the account system supplies a real one. */
export const LOCAL_PERSONA: NamePersona = {
  id: 'me',
  handle: 'You',
  display: 'You',
  avatarId: 'av-royale-you',
  countryCode: 'US',
};
