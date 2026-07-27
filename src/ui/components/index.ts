/**
 * ROYALE — component library barrel.
 * ────────────────────────────────────────────────────────────────────────────
 * Screens should import from here:
 *
 *   import { Surface, Button, Pill, ListRow, List, EmptyState } from '../components/index.ts';
 *
 * Everything is a plain function returning a real DOM node, so you compose
 * with `h()` from `../dom.ts` and never need a render loop. Importing any
 * component also links `styles/components.css`.
 *
 * Conventions shared by every component in here
 *   • options object first, children after (or as `children`)
 *   • returns the element; imperative setters hang off it (`el.setValue(…)`)
 *   • `class` is always merged, never replaced
 *   • all interactive parts are ≥44px, focusable and aria-labelled
 *   • all motion honours `prefers-reduced-motion`
 */
export { Button, IconButton } from './button.ts';
export type { ButtonOpts, ButtonEl, ButtonVariant, ButtonSize, IconButtonOpts } from './button.ts';

export { Surface, SectionHeader } from './surface.ts';
export type { SurfaceOpts, SurfaceTone, SurfacePad, SectionHeaderOpts } from './surface.ts';

export { Pill, RarityTag } from './pill.ts';
export type { PillOpts, PillEl, PillTone, PillSize } from './pill.ts';

export { Badge } from './badge.ts';
export type { BadgeOpts, BadgeEl, BadgeTone } from './badge.ts';

export { Avatar, AvatarStack } from './avatar.ts';
export type { AvatarOpts, AvatarSize } from './avatar.ts';

export { CountUp } from './countup.ts';
export type { CountUpOpts, CountUpEl } from './countup.ts';

export { ProgressBar, RingProgress } from './progress.ts';
export type { ProgressBarOpts, ProgressBarEl, RingProgressOpts, RingProgressEl, ProgressTone } from './progress.ts';

export { Segmented } from './segmented.ts';
export type { SegmentedOpts, SegmentedEl, SegmentItem } from './segmented.ts';

export { Slider } from './slider.ts';
export type { SliderOpts, SliderEl } from './slider.ts';

export { Skeleton, SkeletonText, SkeletonRow, SkeletonList } from './skeleton.ts';
export type { SkeletonOpts, SkeletonTextOpts, SkeletonRowOpts } from './skeleton.ts';

export { EmptyState } from './empty.ts';
export type { EmptyStateOpts, EmptyArt } from './empty.ts';

export { Tabs } from './tabs.ts';
export type { TabsOpts, TabsEl, TabItem } from './tabs.ts';

export { ListRow, List } from './listrow.ts';
export type { ListRowOpts, ListOpts } from './listrow.ts';

export { Divider } from './divider.ts';
export type { DividerOpts } from './divider.ts';

export { Toggle } from './toggle.ts';
export type { ToggleOpts, ToggleEl } from './toggle.ts';

export { attachTooltip, showTooltip, hideTooltip, InfoDot } from './tooltip.ts';
export type { TooltipOpts } from './tooltip.ts';

export { toast, mountToastHost } from './toast.ts';
export type { ToastTone } from './toast.ts';

export { openSheet, setSheetHost } from './sheet.ts';
export type { SheetOpts, SheetHandle } from './sheet.ts';

export {
  openModal, confirmModal, registerModal, openNamedModal, closeTopModal, setModalHost,
} from './modal.ts';
export type { ModalOpts, ModalHandle, ModalAction, ConfirmOpts } from './modal.ts';

export { icon, hasIcon } from './icons.ts';
export type { IconName, IconOpts } from './icons.ts';

export {
  spring, haptic, reduceMotion, pressFeedback, swipeToDismiss, trapFocus,
  clamp, lerp, invLerp, roundTo, uid, fmtInt, fmtSigned,
} from './util.ts';
export type { Spring, SpringOpts, SwipeOpts } from './util.ts';
