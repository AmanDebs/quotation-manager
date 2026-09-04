/**
 * The sidebar's icons.
 *
 * They were emoji, which is the cheapest way to get a picture into a menu and
 * the worst-looking: every platform draws its own, they carry their own colour
 * so they cannot follow the text, and at 16px on a dark rail half of them are
 * an unreadable smudge. These are drawn here — plain geometry on a 24×24 grid,
 * one stroke weight, round caps — so they inherit `currentColor`, dim with the
 * label beside them and sharpen when the row is active.
 *
 * Hand-written rather than a dependency: the bar for adding a package to this
 * project is high, an icon library is several hundred kilobytes for the twenty
 * shapes below, and none of this needs maintaining once drawn.
 */
import type { ReactNode } from 'react';

/** Each entry is the inside of an `<svg>`: paths only, no attributes. */
const PATHS: Record<string, ReactNode> = {
  // Dashboard — three bars.
  dashboard: <><path d="M5 20V10" /><path d="M12 20V4" /><path d="M19 20v-6" /></>,
  // Enquiry — a speech bubble with a question in it.
  enquiry: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z" /><path d="M10 8.2a2.1 2.1 0 1 1 2.8 2c-.5.2-.8.7-.8 1.2v.3" /><path d="M12 14.2h.01" /></>,
  // Quotation — a sheet with a folded corner.
  document: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" /></>,
  // Proforma — a till receipt, torn at the foot.
  receipt: <><path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z" /><path d="M9.5 8h5" /><path d="M9.5 12h5" /></>,
  // Order — a clipboard.
  clipboard: <><path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" /><path d="M9 3.5h6V6H9z" /><path d="M9 11h6" /><path d="M9 15h4" /></>,
  // Commercial invoice — a sheet with a currency mark.
  invoice: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 11v6" /><path d="M13.8 12.2a1.8 1.8 0 1 0-1.8 1.8 1.8 1.8 0 1 1-1.8 1.8" /></>,
  // Follow-up — a bell.
  bell: <><path d="M18 9a6 6 0 1 0-12 0c0 4.5-1.5 5.5-2 6.5h16c-.5-1-2-2-2-6.5" /><path d="M10.2 19a2 2 0 0 0 3.6 0" /></>,
  // Work order — a spanner.
  wrench: <><path d="M15.4 4.6a4.5 4.5 0 0 0-5.6 5.6L4 16v4h4l5.8-5.8a4.5 4.5 0 0 0 5.6-5.6l-2.6 2.6-2.6-.4-.4-2.6z" /></>,
  // Despatch — a lorry.
  truck: <><path d="M3 6.5h10v9H3z" /><path d="M13 9.5h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.8" /><circle cx="17" cy="18" r="1.8" /></>,
  // Stock — a carton.
  box: <><path d="M12 3 4 7v10l8 4 8-4V7z" /><path d="m4 7 8 4 8-4" /><path d="M12 11v10" /></>,
  // Purchase order — a trolley.
  cart: <><path d="M3 4h2l2.2 10.5a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.2L20 8H6" /><circle cx="9.5" cy="19.5" r="1.4" /><circle cx="17" cy="19.5" r="1.4" /></>,
  // Customer — an office block.
  building: <><path d="M4 21V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15" /><path d="M15 10h3a2 2 0 0 1 2 2v9" /><path d="M8 8h3" /><path d="M8 12h3" /><path d="M8 16h3" /><path d="M2.5 21h19" /></>,
  // Product — a price tag.
  tag: <><path d="M11.5 3H20v8.5l-8.7 8.7a1.5 1.5 0 0 1-2.1 0l-6.4-6.4a1.5 1.5 0 0 1 0-2.1z" /><circle cx="16" cy="8" r="1.4" /></>,
  // Container planner — a ship.
  ship: <><path d="M3.5 14.5 5 10h14l1.5 4.5" /><path d="M8 10V6.5h8V10" /><path d="M12 4v2.5" /><path d="M2.5 15.5c1.6 0 1.6 1.5 3.2 1.5s1.6-1.5 3.2-1.5 1.6 1.5 3.1 1.5 1.6-1.5 3.2-1.5 1.6 1.5 3.2 1.5 1.6-1.5 3.1-1.5" /><path d="M4.5 20c1.6 0 1.6-1.5 3.2-1.5S9.3 20 10.9 20s1.6-1.5 3.2-1.5S15.7 20 17.3 20" /></>,
  // Production masters — a works.
  factory: <><path d="M3 20V11l5 3V11l5 3V8l5 3.5V20z" /><path d="M18 8V4h2.5v4" /><path d="M2.5 20h19" /></>,
  // Approvals — a tick in a circle.
  check: <><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></>,
  // Activity — a clock with a hand set back.
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></>,
  // Team — two people.
  users: <><circle cx="9.5" cy="8" r="3" /><path d="M3.5 19.5c0-3 2.7-4.8 6-4.8s6 1.8 6 4.8" /><path d="M16 5.6a3 3 0 0 1 0 5.6" /><path d="M17.6 15.2c1.9.6 3.2 2.1 3.2 4.3" /></>,
  // Settings — sliders. A gear's teeth do not survive 16px, and a circle with
  // eight spokes reads as a sun, which is brightness, not settings.
  cog: <><path d="M4 7h9" /><path d="M17 7h3" /><path d="M4 12h3" /><path d="M11 12h9" /><path d="M4 17h9" /><path d="M17 17h3" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="15" cy="17" r="2" /></>,

  // Chrome.
  menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
  'chevron-left': <path d="m14.5 6-5.5 6 5.5 6" />,
  'chevron-right': <path d="m9.5 6 5.5 6-5.5 6" />,
  // The dashboard's Customise dialog reorders cards with these. They were ↑ and
  // ↓, which is the sidebar's problem in miniature: a glyph drawn by whichever
  // font happens to have it, at whatever weight that font thinks is right.
  'chevron-up': <path d="m6 14.5 6-5.5 6 5.5" />,
  'chevron-down': <path d="m6 9.5 6 5.5 6-5.5" />,
  power: <><path d="M12 3.5v8" /><path d="M7.2 6.6a7 7 0 1 0 9.6 0" /></>,
};

export type IconName = keyof typeof PATHS;

/**
 * `size` is in px because these sit beside text at a fixed optical size rather
 * than scaling with it — 16 in the nav, 18 in the phone header.
 */
export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
