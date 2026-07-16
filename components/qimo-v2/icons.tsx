import type { SVGProps } from 'react';

function IconBase({ children, ...props }: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export function ScheduleIcon(props: SVGProps<SVGSVGElement>) { return <IconBase {...props}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18m-13 4h3m2 0h3m-8 3h3"/></IconBase>; }
export function FactoryIcon(props: SVGProps<SVGSVGElement>) { return <IconBase {...props}><path d="M3 21V10l6 3V9l6 3V5h6v16H3Z"/><path d="M7 17h2m4 0h2m4-8h2"/></IconBase>; }
export function ProgressIcon(props: SVGProps<SVGSVGElement>) { return <IconBase {...props}><path d="M4 19V9m6 10V5m6 14v-7m4 7H2"/><path d="m4 7 6-4 6 6 4-3"/></IconBase>; }
export function ShieldIcon(props: SVGProps<SVGSVGElement>) { return <IconBase {...props}><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z"/><path d="M12 8v5m0 3h.01"/></IconBase>; }
export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) { return <IconBase {...props}><path d="m9 18 6-6-6-6"/></IconBase>; }
