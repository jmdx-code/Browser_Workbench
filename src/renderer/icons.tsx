import {
  Activity,
  AlertTriangle,
  AppWindow,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Folder,
  Globe,
  Info,
  Layers,
  LayoutGrid,
  Link2,
  Menu,
  Minus,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Smartphone,
  Square,
  X,
  type LucideProps,
} from 'lucide-react';
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function icon(Comp: (props: LucideProps) => React.ReactNode) {
  return ({ size = 16, className, style, ...rest }: P) => (
    <Comp
      size={size}
      strokeWidth={1.8}
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
      {...(rest as Omit<LucideProps, 'size'>)}
    />
  );
}

export const IconMenu = icon(Menu);
export const IconPlay = ({ size = 16, ...rest }: P) => (
  <Play
    size={size}
    strokeWidth={1.8}
    fill="currentColor"
    aria-hidden="true"
    {...(rest as LucideProps)}
  />
);
export const IconStop = icon(Square);
export const IconMore = icon(MoreHorizontal);
export const IconPlus = icon(Plus);
export const IconMinus = icon(Minus);
export const IconClose = icon(X);
export const IconSearch = icon(Search);
export const IconDownload = icon(ArrowDownToLine);
export const IconWindow = icon(AppWindow);
export const IconEdit = icon(Pencil);
export const IconCopy = icon(Copy);
export const IconClock = icon(Clock);
export const IconLayers = icon(Layers);
export const IconChevron = icon(ChevronRight);
export const IconChevronDown = icon(ChevronDown);
export const IconBack = icon(ChevronLeft);
export const IconShield = icon(Shield);
export const IconFolder = icon(Folder);
export const IconDatabase = icon(Database);
export const IconLink = icon(Link2);
export const IconFile = icon(FileText);
export const IconRefresh = icon(RefreshCw);
export const IconInfo = icon(Info);
export const IconSettings = icon(Settings);
export const IconSliders = icon(SlidersHorizontal);
export const IconAlertTriangle = icon(AlertTriangle);
export const IconPower = icon(Power);
export const IconActivity = icon(Activity);
export const IconLayoutGrid = icon(LayoutGrid);
export const IconMonitor = icon(Monitor);
export const IconExternalLink = icon(ExternalLink);
export const IconCheckCircle = icon(CheckCircle2);
export const IconCircle = icon(Circle);
export const IconPanelClose = icon(PanelLeftClose);
export const IconPanelOpen = icon(PanelLeftOpen);
export const IconGlobe = icon(Globe);
export const IconSmartphone = icon(Smartphone);

export const IconBrand = ({ size = 20, ...rest }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 1024 1024"
    fill="none"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <rect x="48" y="48" width="928" height="928" rx="224" fill="#2563eb" />
    <path d="M 280.8 439.7 L 449.2 490.3 L 296 976 H 100 Z" fill="#ffffff" />
    <circle cx="365" cy="465" r="170" fill="#ffffff" />
    <circle cx="365" cy="465" r="124" fill="#2563eb" />
    <path d="M 404.2 543.8 L 725.0 380.1 L 675.0 279.9 L 325.8 386.2 Z" fill="#ffffff" />
    <circle cx="365" cy="465" r="88" fill="#ffffff" />
    <circle cx="365" cy="465" r="42" fill="#2563eb" />
    <circle cx="700" cy="330" r="62" fill="#2563eb" />
    <path
      d="M 767.4 383.3 A 86 86 0 1 1 739.4 253.6"
      fill="none"
      stroke="#ffffff"
      strokeWidth="52"
      strokeLinecap="round"
    />
    <circle cx="700" cy="330" r="32" fill="#ffffff" />
  </svg>
);
