import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 22, ...p }: P) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const IconLocate = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
);
export const IconLoop = (p: P) => (
  <svg {...base(p)}><path d="M4 12a8 8 0 1 0 3-6.2" /><path d="M4 4v4h4" /></svg>
);
export const IconAB = (p: P) => (
  <svg {...base(p)}><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="6" r="2.5" /><path d="M7.5 18H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6.5" /></svg>
);
export const IconSwap = (p: P) => (
  <svg {...base(p)}><path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4" /></svg>
);
export const IconGear = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const IconBookmark = (p: P) => (
  <svg {...base(p)}><path d="M6 3h12v18l-6-4-6 4z" /></svg>
);
export const IconDownload = (p: P) => (
  <svg {...base(p)}><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>
);
export const IconPlay = (p: P) => (
  <svg {...base(p)}><path d="M6 4l14 8-14 8z" fill="currentColor" /></svg>
);
export const IconNav = (p: P) => (
  <svg {...base(p)}><path d="M12 2l8 19-8-4-8 4z" fill="currentColor" /></svg>
);
export const IconStop = (p: P) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconVolume = (p: P) => (
  <svg {...base(p)}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 8.5a5 5 0 0 1 0 7M19 5.5a9 9 0 0 1 0 13" /></svg>
);
export const IconMute = (p: P) => (
  <svg {...base(p)}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M17 9l5 6M22 9l-5 6" /></svg>
);
export const IconRecenter = (p: P) => (
  <svg {...base(p)}><path d="M12 3l7 17-7-4-7 4z" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const IconRefresh = (p: P) => (
  <svg {...base(p)}><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5" /><path d="M20 3v5.5h-5.5" /></svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconChevron = (p: P) => (
  <svg {...base(p)}><path d="M6 9l6 6 6-6" /></svg>
);
export const IconBike = (p: P) => (
  <svg {...base(p)}>
    <circle cx="5" cy="16" r="3.5" />
    <circle cx="19" cy="16" r="3.5" />
    <path d="M5 16l4-6h5l3 6M9 10l-1-3H6M14 10l2-3h3" />
  </svg>
);
export const IconShare = (p: P) => (
  <svg {...base(p)}><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" /></svg>
);
export const IconUpload = (p: P) => (
  <svg {...base(p)}><path d="M12 15V3M7 8l5-5 5 5M4 21h16" /></svg>
);
export const IconOffline = (p: P) => (
  <svg {...base(p)}><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z" /><path d="M9 4v13M15 7v13" /></svg>
);
export const IconLog = (p: P) => (
  <svg {...base(p)}><path d="M4 19h16M6 16l4-6 4 3 5-8" /></svg>
);
