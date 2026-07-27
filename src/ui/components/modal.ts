/**
 * ROYALE — components/modal.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Centre-stage dialog. Springs in with a slight overshoot, traps focus,
 * dismisses on Escape or backdrop tap, restores focus on close, and stacks
 * safely if something opens a second one.
 *
 *   openModal({
 *     icon: icon('warning', { size: 24 }),
 *     tone: 'bad',
 *     title: 'Leave the table?',
 *     body: 'Your stack is returned to your balance.',
 *     actions: [
 *       { label: 'Stay', variant: 'ghost' },
 *       { label: 'Leave', variant: 'destructive', onTap: leaveTable },
 *     ],
 *   });
 *
 *   if (await confirmModal({ title: 'Buy for 240 gems?', confirmLabel: 'Buy' })) …
 *
 * Named modals: `registerModal('daily-reward', (props) => openModal(…))` and
 * then anyone can `bus.emit('ui:modal', { id: 'daily-reward' })`. The shell
 * wires that subscription up; `bus.emit('ui:modal', { id: null })` closes the
 * top-most one.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { Button, IconButton } from './button.ts';
import type { ButtonVariant } from './button.ts';
import { icon } from './icons.ts';
import { haptic, reduceMotion, trapFocus } from './util.ts';

export interface ModalAction {
  label: string;
  variant?: ButtonVariant;
  /** returning a promise puts the button into its loading state */
  onTap?: () => unknown;
  /** close the modal after onTap resolves (default true) */
  closes?: boolean;
}

export interface ModalOpts {
  title: string;
  body?: string | Node;
  icon?: Node;
  tone?: 'default' | 'good' | 'bad' | 'gold' | 'epic';
  actions?: ModalAction[];
  /** stack the action buttons vertically (default when >2 or any label is long) */
  stackActions?: boolean;
  dismissible?: boolean;
  showClose?: boolean;
  class?: ClassValue;
  onClose?: () => void;
}

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
}

let modalHost: HTMLElement | null = null;
const stack: ModalHandle[] = [];
const registry = new Map<string, (props?: Record<string, unknown>) => ModalHandle | void>();

export function setModalHost(el: HTMLElement): void {
  modalHost = el;
}

/** Registers a named modal so it can be opened over the bus. */
export function registerModal(
  id: string,
  factory: (props?: Record<string, unknown>) => ModalHandle | void,
): void {
  registry.set(id, factory);
}

export function openNamedModal(id: string, props?: Record<string, unknown>): void {
  const factory = registry.get(id);
  if (factory) factory(props);
  else console.warn(`[modal] no modal registered for "${id}"`);
}

export function closeTopModal(): void {
  stack[stack.length - 1]?.close();
}

export function openModal(opts: ModalOpts): ModalHandle {
  const host = modalHost ?? document.body;
  const dismissible = opts.dismissible !== false;

  const scrim = h('div', { class: 'r-modal__scrim', 'aria-hidden': 'true' });
  const bodyNode =
    typeof opts.body === 'string' ? h('p', { class: 'r-modal__body' }, opts.body) : opts.body ?? null;

  const actions = opts.actions ?? [{ label: 'OK', variant: 'primary' as ButtonVariant }];
  const stacked =
    opts.stackActions ?? (actions.length > 2 || actions.some((a) => a.label.length > 13));

  const card = h(
    'div',
    {
      class: cx('r-modal', `r-modal--${opts.tone ?? 'default'}`, opts.class),
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-label': opts.title,
    },
    h('span', { class: 'r-modal__edge', 'aria-hidden': 'true' }),
    opts.showClose
      ? IconButton({
          icon: icon('close', { size: 16, stroke: 2.2 }),
          ariaLabel: 'Close',
          variant: 'ghost',
          size: 32,
          class: 'r-modal__x',
          onTap: () => close(),
        })
      : null,
    opts.icon ? h('div', { class: 'r-modal__icon' }, opts.icon) : null,
    h('h2', { class: 'r-modal__title' }, opts.title),
    bodyNode,
  );

  const actionRow = h('div', { class: cx('r-modal__actions', stacked && 'is-stacked') });
  for (const a of actions) {
    actionRow.appendChild(
      Button({
        label: a.label,
        variant: a.variant ?? 'secondary',
        size: 'md',
        full: true,
        onTap: () => {
          const out = a.onTap?.();
          if (out && typeof (out as Promise<unknown>).then === 'function') {
            return (out as Promise<unknown>).then(() => {
              if (a.closes !== false) close();
            });
          }
          if (a.closes !== false) close();
          return undefined;
        },
      }),
    );
  }
  card.appendChild(actionRow);

  const root = h('div', { class: 'r-modal-root' }, scrim, card);
  host.appendChild(root);
  host.classList.add('has-modal');

  const releaseFocus = trapFocus(card);
  haptic('select');
  requestAnimationFrame(() => root.classList.add('is-in'));

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    releaseFocus();
    root.classList.remove('is-in');
    root.classList.add('is-out');
    const i = stack.indexOf(handle);
    if (i >= 0) stack.splice(i, 1);
    const done = () => {
      root.remove();
      if (!host.querySelector('.r-modal-root')) host.classList.remove('has-modal');
      opts.onClose?.();
    };
    if (reduceMotion()) done();
    else setTimeout(done, 220);
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape' || !dismissible) return;
    if (stack[stack.length - 1] !== handle) return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
  }

  if (dismissible) scrim.addEventListener('click', () => close());
  document.addEventListener('keydown', onKey, true);

  const handle: ModalHandle = { el: card, close };
  stack.push(handle);
  return handle;
}

export interface ConfirmOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ModalOpts['tone'];
  destructive?: boolean;
  icon?: Node;
}

/** Promise-returning confirm. Resolves false on cancel/backdrop/Escape. */
export function confirmModal(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const settle = (v: boolean) => {
      if (answered) return;
      answered = true;
      resolve(v);
    };
    openModal({
      title: opts.title,
      body: opts.body,
      icon: opts.icon,
      tone: opts.tone ?? (opts.destructive ? 'bad' : 'default'),
      actions: [
        { label: opts.cancelLabel ?? 'Cancel', variant: 'ghost', onTap: () => settle(false) },
        {
          label: opts.confirmLabel ?? 'Confirm',
          variant: opts.destructive ? 'destructive' : 'primary',
          onTap: () => settle(true),
        },
      ],
      onClose: () => settle(false),
    });
  });
}
