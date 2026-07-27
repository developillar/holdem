/**
 * ROYALE — dom.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The entire view layer. No framework, no virtual DOM, no build-time magic:
 * `h()` returns real DOM nodes, so anything you can do to an Element you can
 * do to the result. Fast by construction — one `createElement` per node and a
 * single attribute pass.
 *
 * QUICK REFERENCE
 * ───────────────
 *   h('div', { class: 'card' }, 'hello', h('b', null, '!'))
 *   h('button', { class: ['btn', { 'is-on': active }], onclick: fn }, 'Go')
 *   h('div', { style: { '--x': '4px', transform: 'translateY(2px)' } })
 *   h('img', { attrs: { src: url }, dataset: { id: '7' }, ref: (el) => (mine = el) })
 *   h('svg', { attrs: { viewBox: '0 0 24 24' } }, h('path', { attrs: { d } }))
 *
 * Props are applied in this order and with these meanings:
 *   class / className  ClassValue — string | string[] | Record<string, bool>
 *   style              string | Record<prop, value>. camelCase and `--custom`
 *                      both work; numbers are stringified (add your own units).
 *   dataset            Record<string, string|number|boolean> → data-*
 *   attrs              Record<string, …> → always setAttribute (escape hatch)
 *   on                 Record<type, listener | [listener, options]>
 *   on<Event>          `onclick`, `onpointerdown`, … → addEventListener
 *   ref                (el) => void, called once with the finished element
 *   text               textContent shortcut
 *   html               innerHTML shortcut (only ever pass trusted markup)
 *   anything else      property when it is a known DOM property, else attribute
 *                      (`true` → empty attribute, `false`/`null` → omitted)
 *
 * SVG is namespaced automatically for the tags in `SVG_TAGS`. For the four
 * ambiguous names (`a`, `title`, `style`, `script`) use `s()` explicitly.
 */

// ───────────────────────────── class names ─────────────────────────────

export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

/** Joins class values. `cx('a', cond && 'b', { c: on })` → `"a c"`. */
export function cx(...parts: ClassValue[]): string {
  let out = '';
  for (const p of parts) {
    if (p === null || p === undefined || p === false || p === '') continue;
    let piece = '';
    if (typeof p === 'string' || typeof p === 'number') piece = String(p);
    else if (Array.isArray(p)) piece = cx(...p);
    else {
      for (const k in p) if (p[k]) piece += (piece && ' ') + k;
    }
    if (piece) out += (out && ' ') + piece;
  }
  return out;
}

// ───────────────────────────── hyperscript ─────────────────────────────

export type Child = Node | string | number | boolean | null | undefined | Child[];

export interface Props {
  class?: ClassValue;
  className?: ClassValue;
  style?: string | Record<string, string | number | null | undefined>;
  dataset?: Record<string, string | number | boolean | null | undefined>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, EventListener | [EventListener, AddEventListenerOptions]>;
  ref?: (el: never) => void;
  text?: string | number;
  html?: string;
  [key: string]: unknown;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'path', 'g', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur',
  'feOffset', 'feBlend', 'feColorMatrix', 'feComposite', 'feDropShadow', 'feFlood',
  'feMerge', 'feMergeNode', 'feTurbulence', 'feDisplacementMap', 'mask', 'clipPath',
  'use', 'text', 'tspan', 'textPath', 'pattern', 'symbol', 'marker', 'image',
  'foreignObject', 'animate', 'animateTransform', 'animateMotion', 'mpath',
]);

/** DOM properties that must be assigned (not setAttribute) to behave. */
const PROP_KEYS = new Set([
  'value', 'checked', 'selected', 'disabled', 'readOnly', 'indeterminate',
  'multiple', 'muted', 'srcObject', 'textContent', 'tabIndex',
]);

function appendChild(parent: Node, child: Child): void {
  if (child === null || child === undefined || typeof child === 'boolean') return;
  if (Array.isArray(child)) {
    for (let i = 0; i < child.length; i++) appendChild(parent, child[i]);
    return;
  }
  parent.appendChild(
    typeof child === 'object' ? child : document.createTextNode(String(child)),
  );
}

function applyStyle(el: Element, style: Props['style']): void {
  const s = (el as HTMLElement).style;
  if (typeof style === 'string') {
    el.setAttribute('style', style);
    return;
  }
  for (const k in style) {
    const v = style[k];
    if (v === null || v === undefined) continue;
    const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    s.setProperty(prop, String(v));
  }
}

function applyProps(el: Element, props: Props, svg: boolean): void {
  let ref: ((el: never) => void) | undefined;
  for (const k in props) {
    const v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') {
      const c = cx(v as ClassValue);
      if (c) el.setAttribute('class', c);
    } else if (k === 'style') {
      applyStyle(el, v as Props['style']);
    } else if (k === 'dataset') {
      const d = v as Record<string, string | number | boolean>;
      for (const dk in d) (el as HTMLElement).dataset[dk] = String(d[dk]);
    } else if (k === 'attrs') {
      const a = v as Record<string, string | number | boolean | null | undefined>;
      for (const ak in a) {
        const av = a[ak];
        if (av === null || av === undefined || av === false) continue;
        el.setAttribute(ak, av === true ? '' : String(av));
      }
    } else if (k === 'on') {
      const map = v as Record<string, EventListener | [EventListener, AddEventListenerOptions]>;
      for (const type in map) {
        const entry = map[type];
        if (Array.isArray(entry)) el.addEventListener(type, entry[0], entry[1]);
        else el.addEventListener(type, entry);
      }
    } else if (k === 'ref') {
      ref = v as (el: never) => void;
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (k === 'html') {
      (el as HTMLElement).innerHTML = String(v);
    } else if (k.length > 2 && k.charCodeAt(0) === 111 /* o */ && k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (!svg && PROP_KEYS.has(k)) {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (ref) (ref as (el: Element) => void)(el);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props?: Props | null, ...children: Child[]
): HTMLElementTagNameMap[K];
export function h<K extends keyof SVGElementTagNameMap>(
  tag: K, props?: Props | null, ...children: Child[]
): SVGElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): Element {
  const svg = SVG_TAGS.has(tag);
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props) applyProps(el, props, svg);
  for (let i = 0; i < children.length; i++) appendChild(el, children[i]);
  return el;
}

/** Explicit SVG-namespaced element — use for `a` / `title` inside an `<svg>`. */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K, props?: Props | null, ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) applyProps(el, props, true);
  for (let i = 0; i < children.length; i++) appendChild(el, children[i]);
  return el as SVGElementTagNameMap[K];
}

/** Groups children without a wrapper element. */
export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (let i = 0; i < children.length; i++) appendChild(f, children[i]);
  return f;
}

/** Appends children and returns a disposer that removes exactly what it added. */
export function mount(parent: Node, ...children: Child[]): () => void {
  const added: Node[] = [];
  const probe = document.createDocumentFragment();
  for (let i = 0; i < children.length; i++) appendChild(probe, children[i]);
  while (probe.firstChild) added.push(parent.appendChild(probe.firstChild));
  return () => {
    for (const n of added) if (n.parentNode) n.parentNode.removeChild(n);
  };
}

/** Removes every child of `el` (faster than innerHTML = ''). */
export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** addEventListener that returns its own unsubscribe. */
export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K | string,
  fn: (ev: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type as string, fn as EventListener, opts);
  return () => target.removeEventListener(type as string, fn as EventListener, opts);
}

/** Resolves after the next paint — the reliable way to trigger an entrance. */
export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

// ───────────────────────────── reactivity ─────────────────────────────

export interface Signal<T> {
  /** Read the current value. */
  (): T;
  /** Read without calling. */
  readonly value: T;
  /** Write. Subscribers fire only when the value actually changes (Object.is). */
  set(next: T): void;
  /** Write derived from current. */
  update(fn: (current: T) => T): void;
  /** Subscribe; returns unsubscribe. `immediate` (default true) fires now. */
  subscribe(fn: (v: T) => void, immediate?: boolean): () => void;
}

/**
 * A one-value store. Deliberately not a reactive graph — components subscribe
 * and mutate their own nodes, which is both simpler and faster than diffing.
 */
export function reactive<T>(initial: T): Signal<T> {
  let current = initial;
  const subs = new Set<(v: T) => void>();
  const read = () => current;
  const sig = read as unknown as {
    value: T;
    set(next: T): void;
    update(fn: (c: T) => T): void;
    subscribe(fn: (v: T) => void, immediate?: boolean): () => void;
  };
  Object.defineProperty(read, 'value', { get: () => current });
  sig.set = (next: T) => {
    if (Object.is(next, current)) return;
    current = next;
    for (const fn of Array.from(subs)) fn(current);
  };
  sig.update = (fn) => sig.set(fn(current));
  sig.subscribe = (fn, immediate = true) => {
    subs.add(fn);
    if (immediate) fn(current);
    return () => subs.delete(fn);
  };
  return sig as unknown as Signal<T>;
}

// ───────────────────────────── keyed lists ─────────────────────────────

export interface KeyedListOpts<T> {
  /** Stable identity for an item. Must be unique within a render. */
  key(item: T, index: number): string;
  /** Build the element for a new key. */
  create(item: T, key: string, index: number): Element;
  /** Patch an element that survived. Omit if items are immutable. */
  update?(el: Element, item: T, key: string, index: number): void;
  /**
   * Custom teardown (exit animation). You MUST remove the element yourself.
   * The list has already forgotten it, so it will not be reordered again.
   */
  remove?(el: Element, key: string): void;
}

export interface KeyedList<T> {
  /** Reconcile against `items`: create, patch, reorder, remove. */
  update(items: readonly T[]): void;
  /** Live element for a key, if mounted. */
  get(key: string): Element | undefined;
  /** Remove everything (honours `opts.remove`). */
  clear(): void;
}

/**
 * Minimal keyed reconciler over a real parent node. Reorders with the
 * insert-before-anchor walk, so an unchanged list costs zero DOM writes.
 */
export function keyedList<T>(parent: Element, opts: KeyedListOpts<T>): KeyedList<T> {
  const map = new Map<string, Element>();
  let order: string[] = [];

  const drop = (key: string) => {
    const el = map.get(key);
    if (!el) return;
    map.delete(key);
    if (opts.remove) opts.remove(el, key);
    else el.remove();
  };

  return {
    update(items) {
      const next: string[] = new Array(items.length);
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const key = opts.key(items[i], i);
        next[i] = key;
        seen.add(key);
        const existing = map.get(key);
        if (existing) opts.update?.(existing, items[i], key, i);
        else map.set(key, opts.create(items[i], key, i));
      }
      for (let i = 0; i < order.length; i++) if (!seen.has(order[i])) drop(order[i]);
      let anchor: Node | null = null;
      for (let i = next.length - 1; i >= 0; i--) {
        const el = map.get(next[i])!;
        if (el.parentNode !== parent || el.nextSibling !== anchor) parent.insertBefore(el, anchor);
        anchor = el;
      }
      order = next;
    },
    get: (key) => map.get(key),
    clear() {
      for (const key of order.slice()) drop(key);
      order = [];
    },
  };
}
