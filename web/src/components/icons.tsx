/**
 * icons.tsx —— 内联 SVG 图标（Lucide 图标集的路径数据）
 *
 * 设计规则：禁止用 emoji 当图标，一律 SVG + currentColor 描边，
 * 跟随文本颜色，无需加载任何图标库。
 */

interface IconProps {
  size?: number;
}

function base(size: number | undefined, children: React.ReactNode) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ZapIcon = ({ size }: IconProps) => base(size, (
  <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
));
export const ChatIcon = ({ size }: IconProps) => base(size, (
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
));
export const PuzzleIcon = ({ size }: IconProps) => base(size, (
  <path d="M19.4 14a1.9 1.9 0 0 0 0-3.8h-1.3a.4.4 0 0 1-.3-.7l.8-1.4a1.9 1.9 0 0 0-3.3-1.9l-.8 1.4a.4.4 0 0 1-.7-.3V6.1a1.9 1.9 0 1 0-3.8 0v1.3a.4.4 0 0 1-.7.3l-1.4-.8a1.9 1.9 0 1 0-1.9 3.3l1.4.8a.4.4 0 0 1-.3.7H6.1a1.9 1.9 0 1 0 0 3.8h1.3a.4.4 0 0 1 .3.7l-.8 1.4a1.9 1.9 0 1 0 3.3 1.9l.8-1.4a.4.4 0 0 1 .7.3v1.3a1.9 1.9 0 1 0 3.8 0v-1.3a.4.4 0 0 1 .7-.3l1.4.8a1.9 1.9 0 1 0 1.9-3.3l-1.4-.8a.4.4 0 0 1 .3-.7z" />
));
export const SettingsIcon = ({ size }: IconProps) => base(size, (
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>
));
export const SendIcon = ({ size }: IconProps) => base(size, (
  <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>
));
export const PlusIcon = ({ size }: IconProps) => base(size, (
  <><path d="M5 12h14" /><path d="M12 5v14" /></>
));
export const CheckIcon = ({ size }: IconProps) => base(size, (
  <path d="M20 6 9 17l-5-5" />
));
export const XIcon = ({ size }: IconProps) => base(size, (
  <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>
));
export const AlertIcon = ({ size }: IconProps) => base(size, (
  <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>
));
export const MonitorIcon = ({ size }: IconProps) => base(size, (
  <><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></>
));
export const MoonIcon = ({ size }: IconProps) => base(size, (
  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
));
export const SunIcon = ({ size }: IconProps) => base(size, (
  <><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></>
));
export const TerminalIcon = ({ size }: IconProps) => base(size, (
  <><polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" /></>
));
export const TrashIcon = ({ size }: IconProps) => base(size, (
  <><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></>
));
export const DownloadIcon = ({ size }: IconProps) => base(size, (
  <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></>
));
export const ChevronDownIcon = ({ size }: IconProps) => base(size, (
  <path d="m6 9 6 6 6-6" />
));
export const ShieldIcon = ({ size }: IconProps) => base(size, (
  <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></>
));
export const RefreshIcon = ({ size }: IconProps) => base(size, (
  <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>
));
export const FolderIcon = ({ size }: IconProps) => base(size, (
  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
));
export const SearchIcon = ({ size }: IconProps) => base(size, (
  <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>
));
export const FileIcon = ({ size }: IconProps) => base(size, (
  <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>
));
export const CpuIcon = ({ size }: IconProps) => base(size, (
  <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M15 2v2" /><path d="M15 20v2" /><path d="M9 2v2" /><path d="M9 20v2" /><path d="M2 15h2" /><path d="M2 9h2" /><path d="M20 15h2" /><path d="M20 9h2" /></>
));
export const SparkIcon = ({ size }: IconProps) => base(size, (
  <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
));
export const WalletIcon = ({ size }: IconProps) => base(size, (
  <><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>
));
export const PencilIcon = ({ size }: IconProps) => base(size, (
  <><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>
));
export const ArchiveIcon = ({ size }: IconProps) => base(size, (
  <><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>
));
export const SlidersIcon = ({ size }: IconProps) => base(size, (
  <><line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" /></>
));
