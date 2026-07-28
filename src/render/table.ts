/**
 * The poker table.
 *
 * A long oval sized for a portrait phone. The long axis runs into the screen,
 * so the hero seat lands in the lower third at close range — big, dominant,
 * unmistakably *yours* — while the far end recedes and reads as depth rather
 * than as a second row of players.
 *
 * Layers, outside in:
 *   floor + contact shadow → pedestal → skirt → padded leather rail →
 *   brushed metal trim bead → felt
 *
 * `layout` is the world-space contract the card and chip systems build
 * against: seat anchors, board slots, pot centre, dealer and muck.
 *
 * ── Portrait seat geometry ────────────────────────────────────────────────
 * Nine seats around an oval in a 393 pt viewport is the whole reason the
 * table read as crowded: at that ring density two nameplates land inside
 * 60 CSS px of each other and the community band has nowhere to breathe.
 * `DEFAULT_TABLE_SIZE` is therefore 6, every ring is mirror-symmetric about
 * the screen's vertical axis, and the middle third of the felt is reserved
 * for `BOARD_SLOTS` — no seat's hole cards are allowed into it.
 */
import * as THREE from 'three';
import {
  feltColorFragment,
  feltNormalFragment,
  feltParsFragment,
  feltParsVertex,
  feltRoughnessFragment,
  feltVertex,
} from '../shaders/felt.ts';
import {
  railColorFragment,
  railNormalFragment,
  railParsFragment,
  railParsVertex,
  railRoughnessFragment,
  railVertex,
} from '../shaders/rail.ts';
import { floorFragment, floorVertex } from '../shaders/env.ts';
import { textures } from './textures.ts';

// ─────────────────────────── dimensions ───────────────────────────

/**
 * Playing surface half-extents, in metres. 1 : 1.88, which is a real casino
 * oval (a 3 m table is 1.9 : 1) and is what makes the far rail recede instead
 * of hovering. Rounder than this and the camera has to climb to fit it, which
 * turns the shot into a floor plan; longer and the far seats stop resolving.
 */
const FELT_RX = 0.8;
const FELT_RZ = 1.5;
/** Padded rail: width across the roll and height at the crest. */
const RAIL_W = 0.152;
const RAIL_H = 0.088;
const RAIL_CX = FELT_RX + RAIL_W / 2;
const RAIL_CZ = FELT_RZ + RAIL_W / 2;
const RAIL_OUT_X = FELT_RX + RAIL_W;
const RAIL_OUT_Z = FELT_RZ + RAIL_W;

const FELT_Y = 0;
const CARD_LIFT = 0.0035;
const CHIP_LIFT = 0.002;
/** A chip's own radius plus a hair: how close to the cloth's edge one may sit. */
const CHIP_EDGE = 0.07;
/** A card corner stops just short of the trim bead, never on it. */
const CARD_EDGE = 0.006;

/** Betting line: inside every seat's chips, outside the community band. */
const BET_RX = 0.6;
const BET_RZ = 1.06;

/** Where the pot pile rests — near side of the community row, dead centre. */
const POT_X = 0;
const POT_Z = 0.34;

/** Community row. Five cards, centred, filling 70 % of the felt's width. */
const BOARD_PITCH = 0.226;
const BOARD_Z = -0.1;

const CARD_W = 0.21;
const CARD_H = 0.292;

const FLOOR_Y = -0.88;

const SEG_U = 192;

/**
 * How far along the seat's radius its hole cards sit, and how far around the
 * ring they are allowed to slide.
 *
 * A card is 0.21 × 0.292 on a 0.8 × 1.5 cloth, so its own half-diagonal is
 * 0.18 m: a *centre* at 0.93 of the felt radius puts the outer corner well
 * past the trim bead. That is exactly what happened when the radius was
 * pushed to 0.9 + 0.07 · sideBias to buy clearance over the community row —
 * measured, the outer corner of the 145°/215°/325°/35° hands solved to
 * (x/0.8)² + (z/1.5)² = 1.305, a fifth of a card hanging off the table.
 *
 * The radius therefore comes back inside the cloth (worst corner 0.974), and
 * the clearance the push was buying is bought a different way: the *far* side
 * seats slide around the ring toward the far end of the oval instead of
 * outward along their own radius. The long axis is where the cloth has room —
 * |z| can reach 1.5 where |x| stops at 0.8 — and on screen that arc is
 * straight up, away from the community row, which is the direction that was
 * wanted in the first place. Measured against the shipped board band, the far
 * pair's clearance goes from 11 px to 25 px while every corner comes back
 * onto the felt.
 *
 * The near side seats need no arc at all: they clear the row by 58 px, and
 * sliding them would only crowd the hero.
 */
const HERO_CARD_R = 0.795;
const OPP_CARD_R = 0.862;
/**
 * How much of the radius the side seats give back. `1 − |sin θ|` is zero at
 * the ends of the oval and largest at its widest point, which is where the
 * ellipse curves away from a card corner fastest.
 */
const OPP_CARD_SIDE_TUCK = 0.216;
/** Peak arc a far side seat's hand slides toward the far end, in radians. */
const OPP_CARD_FAR_ARC = (47 * Math.PI) / 180;

/**
 * Where a seat's chip rack rests, in the same polar terms as the cards.
 *
 * A rack does NOT belong beside the hole cards. The nameplates are DOM chips
 * pinned to the rail crest, roughly 130 × 48 CSS px each, and a plate that
 * size hangs 30–45 px *inward* over the cloth — so the whole annulus a rack
 * used to sit in is, on screen, underneath a nameplate. Throwing the rack
 * "railward" (which is what the previous pass did) walked it straight into
 * the plate: measured, 12 chip instances projected inside a nameplate rect at
 * 393 × 852 and 29 at 360 × 640, and money over a chip stack is the rubric's
 * scrim failure.
 *
 * So racks are placed by the *free* felt instead. Projecting the shipped
 * layout at 393/360/430 over 14 hand states, the cloth has exactly two bands
 * the plate ring never reaches: one just inside the far plates and above the
 * community row, one just below the row and above the near plates. Every
 * rack lands in one of them:
 *
 *   • radius `RACK_R_END + RACK_R_SIDE · |cos θ|` — deep for the seats at the
 *     ends of the oval, where the camera compresses everything, wider for the
 *     seats on the long sides, where it does not.
 *   • an arc around the ring toward the far end of the table, scaled by
 *     |cos θ| so the two pole seats keep their own axis (and so the sign of
 *     `cos θ`, which is a float epsilon there, can never flip a rack across
 *     the table). The near seats swing 24°, the far seats 9°.
 *
 * Worst-case clearance between any chip in any rack and any nameplate rect,
 * over those 42 measured frames: 4 px. It was −25 px (i.e. 25 px inside).
 */
const RACK_R_END = 0.43;
const RACK_R_SIDE = 0.25;
const RACK_ARC_BASE = (20 * Math.PI) / 180;
const RACK_ARC_DEPTH = (16 * Math.PI) / 180;
/**
 * The hero owns the near end outright, and the hero's own plate, hand and
 * action bar are all stacked in it, so the hero's rack is placed by hand: out
 * to the rail on the right, in the gap between the hero's plate and the
 * near-right seat's.
 */
const HERO_RACK_R = 0.84;
const HERO_RACK_ARC = (-28 * Math.PI) / 180;
/**
 * Street bets on the near arc.
 *
 * On the far arc the printed betting line is clear of everything, and a bet
 * lands on it exactly as it should. On the near arc that same line runs
 * *under* the plate ring: measured over 42 projected frames, a near seat's
 * bet sat 24 px inside its own nameplate and the hero's 22 px inside his. So
 * a near bet is set in from the rack toward the pot instead — which is where
 * a pushed bet belongs anyway — and the hero's takes the mirror of the hero's
 * own rack, the one other pocket the near end has.
 */
const NEAR_BET_PUSH = 0.22;
const HERO_BET_R = 0.93;
const HERO_BET_ARC = (40 * Math.PI) / 180;
/** The button rides the rack's ray, one rack-and-a-bit out toward its owner. */
const BUTTON_OUT = 0.18;

/**
 * Nameplate anchor ring, as a fraction of the rail centre-line. The widest
 * point of the oval is where a 110 px plate has the least room on a 360 px
 * phone, so seats out there get pulled in — `cos⁶` makes that pull vanish
 * within about 30° of the extreme instead of shrinking the whole ring.
 */
const PLATE_KX = 0.955;
const PLATE_KX_SIDE_PULL = 0.07;
const PLATE_KZ = 0.975;
const HERO_PLATE_KZ = 0.94;

/** Ramanujan II — accurate to ~1e-5 at these eccentricities. */
function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

const RAIL_PERIMETER = ellipsePerimeter(RAIL_CX, RAIL_CZ);

// ─────────────────────────── seat angles ───────────────────────────

/**
 * Hand-authored per table size, in degrees, counter-clockwise from +X.
 * θ = 90° is the near end of the oval — the hero, closest to the camera —
 * and every ring is closed under the mirror θ → 180° − θ so the layout is
 * symmetric about the screen's vertical axis. (That constraint is why the
 * odd sizes have no seat at θ = 270°: 90° and 270° are the only self-mirror
 * angles, so a symmetric ring can hold at most one of each pair of them.)
 *
 * Sizes are also *biased toward the far arc*: the hero owns the whole near
 * end, so no opponent comes within 36° of the near axis. That is what keeps
 * the lower third of the frame clear for the hero's cards, the hero's chips
 * and the action bar underneath them.
 *
 * Six-max additionally pulls its four side seats 3° toward the ends of the
 * oval (148 → 145, 212 → 215 and their mirrors). Three degrees is nothing to
 * look at and a lot to measure: |sin θ| carries the seat's depth, so the far
 * pair's hole cards drop 7 px further up the screen and the near pair's drop
 * 7 px down, which is 14 px of community band bought without moving a single
 * nameplate into its neighbour. Any further and the far plates collide with
 * the plate at the head of the table, which is a worse failure than a tight
 * board — the solver would answer it by collapsing both to compact.
 *
 * Measured at 393 × 852 with the shipped camera, the tightest pair of
 * nameplate anchors is 128 px apart at 6-max and 100 px at 9-max.
 */
const SEAT_ANGLES_DEG: Record<number, number[]> = {
  1: [90],
  2: [90, 270],
  3: [90, 210, 330],
  4: [90, 165, 270, 15],
  5: [90, 153, 221, 319, 27],
  6: [90, 145, 215, 270, 325, 35],
  7: [90, 128, 165, 226, 314, 15, 52],
  8: [90, 128, 165, 212, 270, 328, 15, 52],
  9: [90, 126, 160, 204, 246, 294, 336, 20, 54],
};

/**
 * Six-max is the house default. Nine seats still exist and are still
 * correct, but they are an opt-in for a full ring, not the shape a phone
 * gets handed on open.
 */
export const DEFAULT_TABLE_SIZE = 6;

export interface SeatAnchors {
  slot: number;
  /** radians, 90° = nearest the camera */
  angle: number;
  /** rail crest — where the DOM nameplate pins */
  plate: THREE.Vector3;
  /** felt position for hole cards, index 0..3 (PLO uses all four) */
  cards: THREE.Vector3[];
  /** where this seat's street bet lands, just inside the betting line */
  bet: THREE.Vector3;
  /** where this seat's chip stack rests on the felt */
  stack: THREE.Vector3;
  /** dealer button resting spot when this seat has the button */
  button: THREE.Vector3;
  /** unit vector from the seat toward the table centre */
  inward: THREE.Vector3;
  /** Y rotation that makes a card's "up" point at this seat */
  facing: number;
}

function ellipse(rx: number, rz: number, a: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(rx * Math.cos(a), y, rz * Math.sin(a));
}

/**
 * Pulls a felt anchor back inside the cloth.
 *
 * Chips do not rest on a padded rail — they slide off it — and on a portrait
 * phone the two near-side seats are exactly where the oval is narrowest
 * relative to how much furniture that seat has to park. Their stacks solved
 * to |x| = 0.77 where the felt is only 0.73 wide, so the pile projected past
 * the edge of the screen. Scaling the point back down its own ray keeps the
 * seat's geometry and its symmetry intact and simply refuses to put a chip
 * somewhere a chip cannot be; a point already inside is returned untouched.
 */
function ontoFelt(p: THREE.Vector3, margin: number): THREE.Vector3 {
  const rx = FELT_RX - margin;
  const rz = FELT_RZ - margin;
  const d = Math.hypot(p.x / rx, p.z / rz);
  if (d > 1) {
    p.x /= d;
    p.z /= d;
  }
  return p;
}

/**
 * Largest scale ≤ 1 along a hole-card row's own ray that puts every corner of
 * every card on the cloth.
 *
 * The radius formula above is tuned for the six-max ring; the seven-, eight-
 * and nine-handed rings put seats at 126°–128°, where `1 − |sin θ|` is small
 * enough that the tuck barely fires and the outer corner solved to 1.05. This
 * is the backstop that makes "no card leaves the felt" a property of the
 * module rather than of one hand-tuned constant: a corner is inside when
 * (s·o + d)ᵀ E (s·o + d) ≤ 1, which is a quadratic in s, so the answer is
 * exact and costs one square root per corner at layout time.
 */
function fitCardRow(ox: number, oz: number, tx: number, tz: number, spread: number): number {
  const rx = FELT_RX - CARD_EDGE;
  const rz = FELT_RZ - CARD_EDGE;
  const a = (ox * ox) / (rx * rx) + (oz * oz) / (rz * rz);
  if (a <= 1e-9) return 1;
  let s = 1;
  for (let i = 0; i < CARD_OFFSETS.length; i++) {
    for (let c = 0; c < 4; c++) {
      const dx = tx * CARD_OFFSETS[i] * spread + (c & 1 ? CARD_W : -CARD_W) / 2;
      const dz = tz * CARD_OFFSETS[i] * spread + (c & 2 ? CARD_H : -CARD_H) / 2;
      const b = 2 * ((ox * dx) / (rx * rx) + (oz * dz) / (rz * rz));
      const k = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz) - 1;
      const disc = b * b - 4 * a * k;
      if (disc <= 0) continue;
      const root = (-b + Math.sqrt(disc)) / (2 * a);
      if (root < s) s = root > 0 ? root : 0;
    }
  }
  return s;
}

/**
 * Tangential offsets for the four hole-card slots, in units of `spread`.
 * Slots 0 and 1 straddle the centre so a two-card hand is symmetric about
 * the seat axis; 2 and 3 extend the row outward for PLO. Ordering the row
 * this way rather than left-to-right is what stops a Hold'em hand from
 * sitting a full card-width left of where the player is looking.
 */
const CARD_OFFSETS = [0.5, -0.5, 1.5, -1.5];

function buildSeats(size: number): SeatAnchors[] {
  const degs = SEAT_ANGLES_DEG[size] ?? SEAT_ANGLES_DEG[DEFAULT_TABLE_SIZE];
  return degs.map((deg, slot) => {
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const edge = new THREE.Vector3(FELT_RX * cos, FELT_Y, FELT_RZ * sin);
    const inward = new THREE.Vector3(-edge.x, 0, -edge.z).normalize();
    const tangent = new THREE.Vector3(-inward.z, 0, inward.x);
    const hero = slot === 0;

    // Seats out on the long sides are the ones the ellipse pinches hardest,
    // so they give back the most radius; the far ones take it back as arc.
    const sideBias = 1 - Math.abs(sin);
    // `-sign(cos)` runs around the ring toward the far end of the oval. At the
    // two pole seats cos is a float epsilon, but there sideBias is 0 and the
    // arc collapses with it, so the unstable sign never reaches the result.
    const farward = -Math.sign(cos) || 1;
    const cardR = hero ? HERO_CARD_R : OPP_CARD_R - OPP_CARD_SIDE_TUCK * sideBias;
    const cardArc = hero || sin >= 0 ? 0 : OPP_CARD_FAR_ARC * sideBias * farward;
    const cardA = a + cardArc;
    const spread = hero ? 0.068 : 0.054;
    const rawX = FELT_RX * Math.cos(cardA) * cardR;
    const rawZ = FELT_RZ * Math.sin(cardA) * cardR;
    const fit = fitCardRow(rawX, rawZ, tangent.x, tangent.z, spread);
    const cardOrigin = new THREE.Vector3(rawX * fit, FELT_Y + CARD_LIFT, rawZ * fit);
    const cards: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const t = CARD_OFFSETS[i] * spread;
      cards.push(
        new THREE.Vector3(
          cardOrigin.x + tangent.x * t,
          cardOrigin.y + i * 0.0006,
          cardOrigin.z + tangent.z * t,
        ),
      );
    }

    // ── which way the felt furniture is nudged off the seat axis ──────
    //
    // `tangent` has one fixed handedness all the way round the ring, so an
    // offset written as a bare `+tangent` points *toward the camera* on the
    // left-hand seats and *away from it* on the right-hand ones: two mirror
    // seats come out mirrored in x and identical in z. The ring is symmetric;
    // what sits on it was not. Signing the bet's nudge by the tangent's own z
    // makes the four side seats true mirrors and sends every bet out toward
    // its *own* end of the oval, which is the only direction that is away
    // from the board for near and far seats alike.
    const betward = Math.sign(sin * tangent.z) || 1;

    // The rack: polar, off the seat's own ray, into whichever of the two
    // plate-free bands this seat's arc lands in. See RACK_R_END above.
    const rackR = hero ? HERO_RACK_R : RACK_R_END + RACK_R_SIDE * Math.abs(cos);
    const rackArc = hero
      ? HERO_RACK_ARC
      : Math.abs(cos) * (RACK_ARC_BASE + RACK_ARC_DEPTH * sin) * farward;
    const rackA = a + rackArc;
    const stack = ontoFelt(
      new THREE.Vector3(
        FELT_RX * Math.cos(rackA) * rackR,
        FELT_Y + CHIP_LIFT,
        FELT_RZ * Math.sin(rackA) * rackR,
      ),
      CHIP_EDGE,
    );

    // Street bets. On the far arc they land on the printed line — outside it
    // is the player's side of the cloth, inside it belongs to the pot —
    // nudged off the seat axis so a bet never buries that seat's own hole
    // cards. On the near arc the line is under the plate ring, so the bet is
    // set in from the rack toward the pot instead. See NEAR_BET_PUSH.
    const betPoint = ellipse(BET_RX, BET_RZ, a, FELT_Y + CHIP_LIFT);
    betPoint.x += tangent.x * 0.11 * betward;
    betPoint.z += tangent.z * 0.11 * betward;
    if (hero) {
      const ba = a + HERO_BET_ARC;
      betPoint.x = FELT_RX * Math.cos(ba) * HERO_BET_R;
      betPoint.z = FELT_RZ * Math.sin(ba) * HERO_BET_R;
    } else if (sin > 0) {
      const dx = POT_X - stack.x;
      const dz = POT_Z - stack.z;
      const len = Math.hypot(dx, dz) || 1;
      betPoint.x = stack.x + (dx / len) * NEAR_BET_PUSH;
      betPoint.z = stack.z + (dz / len) * NEAR_BET_PUSH;
    }
    betPoint.y = FELT_Y + CHIP_LIFT;
    ontoFelt(betPoint, CHIP_EDGE);
    // The button rides the rack's own ray, a rack-and-a-bit further out, so
    // it reads as belonging to that seat without ever sharing the footprint.
    const button = ontoFelt(
      new THREE.Vector3(
        FELT_RX * Math.cos(rackA) * (rackR + BUTTON_OUT),
        FELT_Y + 0.004,
        FELT_RZ * Math.sin(rackA) * (rackR + BUTTON_OUT),
      ),
      0.05,
    );

    return {
      slot,
      angle: a,
      // Pinned a touch inside the rail crest: at the true widest point a
      // 120 px nameplate hangs off the screen on a 360 px device.
      plate: ellipse(
        RAIL_CX * (PLATE_KX - PLATE_KX_SIDE_PULL * cos ** 6),
        RAIL_CZ * (hero ? HERO_PLATE_KZ : PLATE_KZ),
        a,
        RAIL_H * 1.02,
      ),
      cards,
      bet: betPoint,
      stack,
      button,
      inward,
      facing: Math.atan2(inward.x, inward.z),
    };
  });
}

const SEAT_CACHE = new Map<number, SeatAnchors[]>();
function seatsFor(size: number): SeatAnchors[] {
  const n = Math.max(1, Math.min(9, Math.round(size)));
  let hit = SEAT_CACHE.get(n);
  if (!hit) {
    hit = buildSeats(n);
    SEAT_CACHE.set(n, hit);
  }
  return hit;
}

const BOARD_SLOTS: THREE.Vector3[] = [0, 1, 2, 3, 4].map(
  (i) => new THREE.Vector3((i - 2) * BOARD_PITCH, FELT_Y + CARD_LIFT, BOARD_Z),
);

const SEAT_POSITIONS: Record<number, THREE.Vector3[]> = {};
for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  SEAT_POSITIONS[size] = seatsFor(size).map((s) => s.plate.clone());
}

/**
 * World-space anchor contract. Imported by the card and chip systems:
 *   import { layout } from './table.ts'
 */
export const layout = {
  FELT_RX,
  FELT_RZ,
  FELT_Y,
  RAIL_W,
  RAIL_H,
  RAIL_CX,
  RAIL_CZ,
  RAIL_OUT_X,
  RAIL_OUT_Z,
  RAIL_PERIMETER,
  FLOOR_Y,
  BET_RX,
  BET_RZ,
  /** rail-crest anchors, keyed by table size */
  SEAT_POSITIONS,
  SEAT_ANGLES_DEG,
  BOARD_SLOTS,
  POT_CENTER: new THREE.Vector3(POT_X, FELT_Y + CHIP_LIFT, POT_Z),
  /** deal origin — the dealer's chute at the far end of the felt */
  DEALER_POS: new THREE.Vector3(0, FELT_Y + 0.03, -(FELT_RZ - 0.11)),
  /** folded cards fly here and fade */
  MUCK_POS: new THREE.Vector3(0.44, FELT_Y + 0.02, -(FELT_RZ - 0.3)),
  /** suggested render sizes so cards and chips stay in proportion */
  CARD_SIZE: { w: CARD_W, h: CARD_H, t: 0.006 },
  CHIP_SIZE: { r: 0.061, h: 0.0115 },
  BOARD_PITCH,
  /** the ring the table screen should ask for unless the user picks otherwise */
  DEFAULT_SIZE: DEFAULT_TABLE_SIZE,
  sizes: [2, 3, 4, 5, 6, 7, 8, 9],
  seats: seatsFor,
  seat(size: number, slot: number): SeatAnchors {
    const all = seatsFor(size);
    return all[((slot % all.length) + all.length) % all.length];
  },
  /** engine seat index → visual slot, so the local player is always slot 0 */
  slotFor(seat: number, heroSeat: number, size: number): number {
    return (((seat - heroSeat) % size) + size) % size;
  },
  boardSlot(i: number): THREE.Vector3 {
    return BOARD_SLOTS[Math.max(0, Math.min(4, i))];
  },
};

export type TableLayout = typeof layout;

// ─────────────────────────── skin ───────────────────────────

export type RailMaterialId = 'leather' | 'suede' | 'carbon' | 'wood';
export type TrimMetalId = 'gold' | 'platinum' | 'copper' | 'gunmetal';

export interface TableSkin {
  feltColor: string;
  feltAccent: string;
  feltEdge: string;
  feltSheen: string;
  railMaterial: RailMaterialId;
  railColor: string;
  stitchColor: string;
  seamColor: string;
  logoId: string;
  logoTint: string;
  logoOpacity: number;
  trimMetal: TrimMetalId;
  betLineColor: string;
  betLineStrength: number;
}

/**
 * Mirrors `tokens.css` exactly — felt-700 cloth, felt-500 accent, felt-900
 * shadow, gold-300 line, slate-100 ink. GLSL cannot read a custom property,
 * so the 3D layer restates the palette rather than inventing one.
 */
export const DEFAULT_SKIN: TableSkin = {
  feltColor: '#14432d',
  feltAccent: '#1c5a3c',
  feltEdge: '#06180f',
  feltSheen: '#2c7350',
  railMaterial: 'leather',
  railColor: '#2f2118',
  stitchColor: '#c08d21',
  seamColor: '#090604',
  logoId: 'royale-classic',
  logoTint: '#dfe4ee',
  logoOpacity: 0.3,
  trimMetal: 'gold',
  betLineColor: '#edc96b',
  betLineStrength: 0.38,
};

const TRIM_METALS: Record<TrimMetalId, { color: string; roughness: number; aniso: number }> = {
  gold: { color: '#a8791d', roughness: 0.76, aniso: 0.34 },
  platinum: { color: '#9aa4b2', roughness: 0.72, aniso: 0.34 },
  copper: { color: '#8a552e', roughness: 0.78, aniso: 0.32 },
  gunmetal: { color: '#3f454f', roughness: 0.82, aniso: 0.28 },
};

// ─────────────────────────── geometry builders ───────────────────────────

interface ProfilePoint {
  w: number;
  h: number;
}

/**
 * Sweeps a 2D profile around an ellipse. `w` is the outward offset from the
 * centreline, `h` the height. UVs come out as (around, across-profile), which
 * is exactly what the rail shader's analytic stitching expects.
 */
function buildSweep(
  cx: number,
  cz: number,
  profile: ProfilePoint[],
  segU: number,
): THREE.BufferGeometry {
  const nV = profile.length;
  const count = (segU + 1) * nV;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  // arc-length parameterisation across the profile keeps texel density even
  const vCoord = new Float32Array(nV);
  let total = 0;
  for (let j = 1; j < nV; j++) {
    const dw = profile[j].w - profile[j - 1].w;
    const dh = profile[j].h - profile[j - 1].h;
    total += Math.hypot(dw, dh);
    vCoord[j] = total;
  }
  for (let j = 0; j < nV; j++) vCoord[j] = total > 0 ? vCoord[j] / total : j / Math.max(1, nV - 1);

  // 2D profile normals from neighbour tangents
  const pn = new Float32Array(nV * 2);
  for (let j = 0; j < nV; j++) {
    const a = profile[Math.max(0, j - 1)];
    const b = profile[Math.min(nV - 1, j + 1)];
    let tw = b.w - a.w;
    let th = b.h - a.h;
    const len = Math.hypot(tw, th) || 1;
    tw /= len;
    th /= len;
    pn[j * 2] = -th;
    pn[j * 2 + 1] = tw;
  }

  let p = 0;
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    const cos = Math.cos(u);
    const sin = Math.sin(u);
    // outward normal of the ellipse in XZ
    let nx = cos / cx;
    let nz = sin / cz;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const px = cx * cos;
    const pz = cz * sin;
    for (let j = 0; j < nV; j++) {
      const prof = profile[j];
      const o = p * 3;
      pos[o] = px + nx * prof.w;
      pos[o + 1] = prof.h;
      pos[o + 2] = pz + nz * prof.w;
      const n2w = pn[j * 2];
      const n2h = pn[j * 2 + 1];
      nor[o] = nx * n2w;
      nor[o + 1] = n2h;
      nor[o + 2] = nz * n2w;
      uvs[p * 2] = i / segU;
      uvs[p * 2 + 1] = vCoord[j];
      p++;
    }
  }

  const idx: number[] = [];
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < nV - 1; j++) {
      const a = i * nV + j;
      const b = (i + 1) * nV + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  fixWinding(geo);
  geo.computeBoundingSphere();
  return geo;
}

/** Flips the index buffer if the first face disagrees with its vertex normals. */
function fixWinding(geo: THREE.BufferGeometry): void {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  if (!index || index.count < 3) return;
  const a = index.getX(0);
  const b = index.getX(1);
  const c = index.getX(2);
  const va = new THREE.Vector3().fromBufferAttribute(pos, a);
  const vb = new THREE.Vector3().fromBufferAttribute(pos, b);
  const vc = new THREE.Vector3().fromBufferAttribute(pos, c);
  const face = vb.sub(va).cross(vc.sub(va));
  const vn = new THREE.Vector3().fromBufferAttribute(nor, a);
  if (face.dot(vn) < 0) {
    const arr = index.array as Uint32Array | Uint16Array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
  }
}

/**
 * The felt disc. Its boundary is the rail's inner lip pushed 14 mm under the
 * leather, so there is no seam to catch the light no matter the camera angle.
 */
function buildFelt(rings: number, segU: number): THREE.BufferGeometry {
  const bx = RAIL_CX;
  const bz = RAIL_CZ;
  const inset = RAIL_W / 2 - 0.014;
  const count = (segU + 1) * (rings + 1);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  let p = 0;
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    const cos = Math.cos(u);
    const sin = Math.sin(u);
    let nx = cos / bx;
    let nz = sin / bz;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const ex = bx * cos - nx * inset;
    const ez = bz * sin - nz * inset;
    for (let r = 0; r <= rings; r++) {
      // sub-linear ramp packs vertices toward the rim where the AO gradient is
      const t = Math.pow(r / rings, 0.85);
      const o = p * 3;
      pos[o] = ex * t;
      pos[o + 1] = FELT_Y;
      pos[o + 2] = ez * t;
      nor[o] = 0;
      nor[o + 1] = 1;
      nor[o + 2] = 0;
      // world-space UV so the fibre tiles evenly, no polar pinch
      uvs[p * 2] = ex * t;
      uvs[p * 2 + 1] = ez * t;
      p++;
    }
  }
  const idx: number[] = [];
  const stride = rings + 1;
  for (let i = 0; i < segU; i++) {
    for (let r = 0; r < rings; r++) {
      const a = i * stride + r;
      const b = (i + 1) * stride + r;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  fixWinding(geo);
  geo.computeBoundingSphere();
  return geo;
}

/** Flat elliptical cap, used to close the pedestal and the skirt underside. */
function buildCap(
  rx: number,
  rz: number,
  y: number,
  segU: number,
  up: boolean,
): THREE.BufferGeometry {
  const pos = new Float32Array((segU + 2) * 3);
  const nor = new Float32Array((segU + 2) * 3);
  const uvs = new Float32Array((segU + 2) * 2);
  pos[1] = y;
  nor[1] = up ? 1 : -1;
  uvs[0] = 0.5;
  uvs[1] = 0.5;
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    const o = (i + 1) * 3;
    pos[o] = rx * Math.cos(u);
    pos[o + 1] = y;
    pos[o + 2] = rz * Math.sin(u);
    nor[o + 1] = up ? 1 : -1;
    uvs[(i + 1) * 2] = Math.cos(u) * 0.5 + 0.5;
    uvs[(i + 1) * 2 + 1] = Math.sin(u) * 0.5 + 0.5;
  }
  const idx: number[] = [];
  for (let i = 1; i <= segU; i++) idx.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  fixWinding(geo);
  geo.computeBoundingSphere();
  return geo;
}

// ─────────────────────────── the table ───────────────────────────

export interface TableHandle {
  group: THREE.Group;
  felt: THREE.Mesh;
  rail: THREE.Mesh;
  trim: THREE.Mesh;
  skin: TableSkin;
  setSkin(params: Partial<TableSkin>): void;
  /** Tells the felt where the key light lands so the pool matches. */
  setLightPool(x: number, z: number, inner: number, outer: number, strength: number): void;
  setQuality(tier: 'low' | 'mid' | 'high'): void;
  update(elapsed: number): void;
  dispose(): void;
}

export function createTable(env: THREE.Texture | null): TableHandle {
  const tex = textures();
  const group = new THREE.Group();
  group.name = 'table';

  const skin: TableSkin = { ...DEFAULT_SKIN };

  // ── felt ───────────────────────────────────────────────────────────
  // The inlay is deliberately taller than it is wide: at a 46° camera the
  // z axis is foreshortened by sin(46°), so a 1 : 1.39 world rectangle is
  // what reads as a *circle* on screen.
  const LOGO_HALF_W = 0.3;
  const LOGO_HALF_H = 0.4;
  const LOGO_CZ = -0.63;

  const feltUniforms = {
    uFeltRadii: { value: new THREE.Vector2(FELT_RX, FELT_RZ) },
    uFeltEdge: { value: new THREE.Color(skin.feltEdge) },
    uFeltAccent: { value: new THREE.Color(skin.feltAccent) },
    // ~2.4 cm weave cell — about five device pixels at portrait framing,
    // which is the largest the cloth can be before it stops reading as nap
    // and the smallest before it aliases into crawl.
    uFiberScale: { value: 84.0 },
    uNapStrength: { value: 0.07 },
    uWear: { value: 0.17 },
    uLogoMap: { value: tex.get(`logo:${skin.logoId}`) },
    uLogoRect: { value: new THREE.Vector4(0, LOGO_CZ, LOGO_HALF_W, LOGO_HALF_H) },
    uLogoTint: { value: new THREE.Color(skin.logoTint) },
    uLogoOpacity: { value: skin.logoOpacity },
    uBetRadii: { value: new THREE.Vector2(BET_RX, BET_RZ) },
    uBetColor: { value: new THREE.Color(skin.betLineColor) },
    uBetStrength: { value: skin.betLineStrength },
    uPool: { value: new THREE.Vector4(0, -0.12, 0.44, 1.62) },
    uPoolStrength: { value: 0.42 },
    uPoolTint: { value: new THREE.Color('#4a3316') },
  };

  const feltMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(skin.feltColor),
    roughness: 0.95,
    metalness: 0,
    sheen: 0.85,
    sheenColor: new THREE.Color(skin.feltSheen),
    sheenRoughness: 0.6,
    normalMap: tex.get('felt-normal'),
    normalScale: new THREE.Vector2(0.66, 0.66),
    roughnessMap: tex.get('felt-rough'),
    envMapIntensity: 0.07,
    dithering: true,
  });
  feltMat.normalMap!.repeat.set(5, 5);
  feltMat.roughnessMap!.repeat.set(10, 10);
  feltMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, feltUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${feltParsVertex}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${feltVertex}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${feltParsFragment}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${feltColorFragment}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${feltRoughnessFragment}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${feltNormalFragment}`,
      );
  };
  feltMat.customProgramCacheKey = () => 'royale-felt-v2';

  const felt = new THREE.Mesh(buildFelt(18, SEG_U), feltMat);
  felt.name = 'felt';
  felt.receiveShadow = true;
  felt.renderOrder = 0;
  group.add(felt);

  // ── rail ───────────────────────────────────────────────────────────
  // Fifteen points, not eight: the crest needs a genuine flat where a
  // forearm would rest, the inner edge needs a hard chamfer to catch the
  // felt bounce, and the outer edge needs a bead to break the skirt.
  const hw = RAIL_W / 2;
  const railProfile: ProfilePoint[] = [
    { w: -hw - 0.008, h: 0.002 },
    { w: -hw + 0.002, h: 0.01 },
    { w: -hw + 0.008, h: 0.024 },
    { w: -hw + 0.018, h: 0.045 },
    { w: -hw + 0.034, h: 0.068 },
    { w: -hw + 0.052, h: 0.082 },
    { w: -0.014, h: RAIL_H },
    { w: 0.018, h: RAIL_H - 0.0015 },
    { w: hw - 0.05, h: 0.08 },
    { w: hw - 0.03, h: 0.062 },
    { w: hw - 0.014, h: 0.036 },
    { w: hw - 0.003, h: 0.014 },
    { w: hw, h: -0.004 },
    { w: hw - 0.004, h: -0.02 },
    { w: hw - 0.016, h: -0.036 },
  ];

  const railUniforms = {
    uGrainScale: { value: 34.0 },
    uGrainDepth: { value: 0.2 },
    uCreaseDepth: { value: 0.22 },
    uSeamColor: { value: new THREE.Color(skin.seamColor) },
    uThreadColor: { value: new THREE.Color(skin.stitchColor) },
    uCrestTint: { value: new THREE.Color('#c9a878') },
    // 172 stitches around a 7.37 m perimeter ≈ 43 mm pitch: chunky saddle
    // stitching that still resolves as discrete dashes on a 3× display.
    uStitch: { value: new THREE.Vector4(0.185, 172.0, 0.013, 0.024) },
    uStitchOn: { value: 1.0 },
    uPolish: { value: 0.85 },
    uRailWear: { value: 0.13 },
    uArcAspect: { value: RAIL_PERIMETER },
  };

  const railMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(skin.railColor),
    roughness: 0.62,
    metalness: 0,
    clearcoat: 0.46,
    clearcoatRoughness: 0.34,
    normalMap: tex.get('leather-normal'),
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: tex.get('leather-rough'),
    aoMap: tex.get('rail-ao'),
    aoMapIntensity: 0.95,
    envMapIntensity: 0.7,
    dithering: true,
  });
  railMat.normalMap!.repeat.set(22, 3);
  railMat.roughnessMap!.repeat.set(22, 3);
  railMat.aoMap!.repeat.set(1, 1);
  railMat.aoMap!.wrapS = THREE.ClampToEdgeWrapping;
  railMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, railUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${railParsVertex}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${railVertex}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${railParsFragment}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${railColorFragment}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${railRoughnessFragment}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${railNormalFragment}`,
      );
  };
  railMat.customProgramCacheKey = () => 'royale-rail-v2';

  const rail = new THREE.Mesh(buildSweep(RAIL_CX, RAIL_CZ, railProfile, SEG_U), railMat);
  rail.name = 'rail';
  rail.castShadow = true;
  rail.receiveShadow = true;
  group.add(rail);

  // ── metal trim bead between felt and leather ───────────────────────
  const trimMeta = TRIM_METALS[skin.trimMetal];
  const trimMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(trimMeta.color),
    metalness: 1,
    roughness: trimMeta.roughness,
    roughnessMap: tex.get('metal-rough'),
    normalMap: tex.get('metal-normal'),
    normalScale: new THREE.Vector2(0.18, 0.18),
    anisotropy: trimMeta.aniso,
    anisotropyRotation: 0,
    envMapIntensity: 0.14,
    dithering: true,
  });
  trimMat.roughnessMap!.repeat.set(6, 1);
  trimMat.normalMap!.repeat.set(6, 1);

  const beadR = 0.0105;
  const beadProfile: ProfilePoint[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI * (1 - i / 12);
    beadProfile.push({ w: Math.cos(a) * beadR, h: 0.0035 + Math.sin(a) * beadR });
  }
  const trimCX = FELT_RX + 0.004;
  const trimCZ = FELT_RZ + 0.004;
  const trim = new THREE.Mesh(buildSweep(trimCX, trimCZ, beadProfile, SEG_U), trimMat);
  trim.name = 'trim';
  trim.castShadow = false;
  trim.receiveShadow = true;
  group.add(trim);

  // ── outer trim band around the skirt ───────────────────────────────
  const bandProfile: ProfilePoint[] = [
    { w: 0.0, h: -0.03 },
    { w: 0.004, h: -0.036 },
    { w: 0.005, h: -0.054 },
    { w: 0.001, h: -0.072 },
    { w: -0.004, h: -0.08 },
  ];
  const band = new THREE.Mesh(
    buildSweep(RAIL_OUT_X - 0.014, RAIL_OUT_Z - 0.014, bandProfile, SEG_U),
    trimMat,
  );
  band.name = 'trim-band';
  group.add(band);

  // ── skirt + pedestal ───────────────────────────────────────────────
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#0b0d12'),
    roughness: 0.44,
    metalness: 0.25,
    clearcoat: 0.3,
    clearcoatRoughness: 0.5,
    envMapIntensity: 0.5,
    dithering: true,
  });

  const skirtProfile: ProfilePoint[] = [
    { w: -0.012, h: -0.074 },
    { w: -0.026, h: -0.112 },
    { w: -0.05, h: -0.172 },
    { w: -0.086, h: -0.227 },
    { w: -0.13, h: -0.258 },
  ];
  const skirt = new THREE.Mesh(
    buildSweep(RAIL_OUT_X - 0.014, RAIL_OUT_Z - 0.014, skirtProfile, SEG_U),
    bodyMat,
  );
  skirt.name = 'skirt';
  skirt.castShadow = true;
  group.add(skirt);

  const underCap = new THREE.Mesh(
    buildCap(RAIL_OUT_X - 0.144, RAIL_OUT_Z - 0.144, -0.258, 64, false),
    bodyMat,
  );
  group.add(underCap);

  const columnProfile: ProfilePoint[] = [
    { w: 0.0, h: -0.258 },
    { w: -0.02, h: -0.34 },
    { w: -0.03, h: -0.58 },
    { w: -0.014, h: -0.78 },
    { w: 0.06, h: -0.85 },
    { w: 0.09, h: FLOOR_Y + 0.005 },
  ];
  const column = new THREE.Mesh(buildSweep(0.3, 0.44, columnProfile, 72), bodyMat);
  column.name = 'pedestal';
  column.castShadow = true;
  group.add(column);

  const footCap = new THREE.Mesh(buildCap(0.39, 0.53, FLOOR_Y + 0.005, 64, true), bodyMat);
  group.add(footCap);

  // ── floor + contact shadow ─────────────────────────────────────────
  const floorUniforms = {
    uNear: { value: new THREE.Color('#0b0d13') },
    uFar: { value: new THREE.Color('#04050a') },
    uTableRadii: { value: new THREE.Vector2(RAIL_OUT_X, RAIL_OUT_Z) },
    uShadow: { value: 0.66 },
  };
  const floorMat = new THREE.ShaderMaterial({
    uniforms: floorUniforms,
    vertexShader: floorVertex,
    fragmentShader: floorFragment,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(11, 11, 1, 1), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.name = 'floor';
  floor.renderOrder = -2;
  group.add(floor);

  const contactMat = new THREE.MeshBasicMaterial({
    map: tex.get('radial-shadow'),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false,
    color: 0x000000,
  });
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), contactMat);
  contact.scale.set(RAIL_OUT_X * 2.7, RAIL_OUT_Z * 2.1, 1);
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = FLOOR_Y + 0.004;
  contact.renderOrder = -1;
  contact.name = 'contact-shadow';
  group.add(contact);

  // ── env map wiring ─────────────────────────────────────────────────
  const materials = [feltMat, railMat, trimMat, bodyMat];
  if (env) for (const m of materials) m.envMap = env;

  // ─────────────────────── skin application ────────────────────────
  function applyRailMaterial(id: RailMaterialId): void {
    const t = textures();
    switch (id) {
      case 'leather':
        railMat.map = null;
        railMat.normalMap = t.get('leather-normal');
        railMat.roughnessMap = t.get('leather-rough');
        railMat.normalScale.set(0.55, 0.55);
        railMat.roughness = 0.62;
        railMat.metalness = 0;
        railMat.clearcoat = 0.46;
        railMat.clearcoatRoughness = 0.34;
        railMat.sheen = 0;
        railUniforms.uStitchOn.value = 1;
        railUniforms.uGrainScale.value = 34;
        railUniforms.uPolish.value = 0.72;
        railMat.normalMap.repeat.set(22, 3);
        railMat.roughnessMap.repeat.set(22, 3);
        break;
      case 'suede':
        railMat.map = null;
        railMat.normalMap = t.get('suede-normal');
        railMat.roughnessMap = null;
        railMat.normalScale.set(0.5, 0.5);
        railMat.roughness = 0.95;
        railMat.metalness = 0;
        railMat.clearcoat = 0;
        railMat.sheen = 1;
        railMat.sheenRoughness = 0.6;
        railMat.sheenColor.set('#6a5a4a');
        railUniforms.uStitchOn.value = 1;
        railUniforms.uGrainScale.value = 46;
        railUniforms.uPolish.value = 0.25;
        railMat.normalMap.repeat.set(26, 4);
        break;
      case 'carbon':
        railMat.map = null;
        railMat.normalMap = t.get('carbon-normal');
        railMat.roughnessMap = null;
        railMat.normalScale.set(0.7, 0.7);
        railMat.roughness = 0.3;
        railMat.metalness = 0.2;
        railMat.clearcoat = 0.85;
        railMat.clearcoatRoughness = 0.14;
        railMat.sheen = 0;
        railUniforms.uStitchOn.value = 0;
        railUniforms.uGrainScale.value = 20;
        railUniforms.uPolish.value = 0.4;
        railMat.normalMap.repeat.set(30, 4);
        break;
      case 'wood':
        railMat.map = t.get('wood-color');
        railMat.normalMap = t.get('wood-normal');
        railMat.roughnessMap = t.get('wood-rough');
        railMat.normalScale.set(0.55, 0.55);
        railMat.roughness = 0.2;
        railMat.metalness = 0;
        railMat.clearcoat = 0.95;
        railMat.clearcoatRoughness = 0.08;
        railMat.sheen = 0;
        railUniforms.uStitchOn.value = 0;
        railUniforms.uGrainScale.value = 14;
        railUniforms.uPolish.value = 0.5;
        railMat.map.repeat.set(6, 1);
        railMat.normalMap.repeat.set(6, 1);
        railMat.roughnessMap.repeat.set(6, 1);
        break;
    }
    if (env) railMat.envMap = env;
    railMat.needsUpdate = true;
  }

  function setSkin(params: Partial<TableSkin>): void {
    Object.assign(skin, params);
    feltMat.color.set(skin.feltColor);
    feltMat.sheenColor.set(skin.feltSheen);
    feltUniforms.uFeltAccent.value.set(skin.feltAccent);
    feltUniforms.uFeltEdge.value.set(skin.feltEdge);
    feltUniforms.uBetColor.value.set(skin.betLineColor);
    feltUniforms.uBetStrength.value = skin.betLineStrength;
    feltUniforms.uLogoTint.value.set(skin.logoTint);
    feltUniforms.uLogoOpacity.value = skin.logoOpacity;
    feltUniforms.uLogoMap.value = textures().get(`logo:${skin.logoId}`);

    railMat.color.set(skin.railMaterial === 'wood' ? '#ffffff' : skin.railColor);
    railUniforms.uThreadColor.value.set(skin.stitchColor);
    railUniforms.uSeamColor.value.set(skin.seamColor);
    if (params.railMaterial !== undefined || !railMat.userData.railApplied) {
      applyRailMaterial(skin.railMaterial);
      railMat.userData.railApplied = true;
    }

    const meta = TRIM_METALS[skin.trimMetal] ?? TRIM_METALS.gold;
    trimMat.color.set(meta.color);
    trimMat.roughness = meta.roughness;
    trimMat.anisotropy = meta.aniso;
    trimMat.needsUpdate = true;
  }

  setSkin({});

  let quality: 'low' | 'mid' | 'high' = 'high';

  return {
    group,
    felt,
    rail,
    trim,
    skin,
    setSkin,
    setLightPool(x, z, inner, outer, strength) {
      feltUniforms.uPool.value.set(x, z, inner, outer);
      feltUniforms.uPoolStrength.value = strength;
    },
    setQuality(tier) {
      quality = tier;
      const low = tier === 'low';
      feltMat.sheen = low ? 0 : 0.85;
      feltMat.sheenRoughness = 0.6;
      railMat.clearcoat = low ? 0 : skin.railMaterial === 'wood' ? 0.95 : 0.46;
      trimMat.anisotropy = low ? 0 : (TRIM_METALS[skin.trimMetal] ?? TRIM_METALS.gold).aniso;
      contact.visible = tier !== 'low';
      feltUniforms.uWear.value = low ? 0.08 : 0.17;
      feltUniforms.uFiberScale.value = low ? 54 : 84;
      feltMat.needsUpdate = true;
      railMat.needsUpdate = true;
      trimMat.needsUpdate = true;
    },
    update() {
      /* the table is static geometry; light pool + skin drive all change */
      void quality;
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      for (const m of materials) m.dispose();
      floorMat.dispose();
      contactMat.dispose();
    },
  };
}
