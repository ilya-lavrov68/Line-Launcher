import { m, useReducedMotion } from "framer-motion";
import {
  ChevronLeft,
  Info,
  LogOut,
  RefreshCw,
  Server,
  Settings,
  Shirt,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { brand } from "@/brand/generated";
import Attribution from "@/components/line/Attribution";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type LineSection = "servers" | "wardrobe" | "settings";

export interface SideNavProps {
  section: LineSection;
  collapsed: boolean;
  providerName?: string;
  /** The one project account; shown so it is clear it is shared by all servers. */
  username?: string;
  onLogout: () => void;
  onNavigate: (section: LineSection) => void;
  onToggleCollapsed: () => void;
  onChangeProvider: () => void;
  onAbout: () => void;
  actionsDisabled?: boolean;
}

interface NavItem {
  id: LineSection;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  hint?: string;
}

/**
 * Collapsible left navigation.
 *
 * Colours come from the shared semantic tokens (`bg-card/50`, `bg-primary/10`,
 * `text-muted-foreground`, `border-border/50`) rather than a bespoke palette, so
 * every branding preset restyles it with no extra CSS. Geometry reuses Obsy's
 * radii and the shared Button primitive keeps keyboard/focus semantics.
 *
 * Collapsed mode keeps the same targets as icon buttons with accessible names
 * and native tooltips, so nothing becomes unreachable.
 */
export default function SideNav({
  section,
  collapsed,
  providerName,
  username,
  onLogout,
  onNavigate,
  onToggleCollapsed,
  onChangeProvider,
  onAbout,
  actionsDisabled = false,
}: SideNavProps) {
  const reducedMotion = useReducedMotion();
  const items: NavItem[] = [
    { id: "servers", label: "Серверы", icon: Server },
    // Never gated: the local history works signed out and offline.
    { id: "wardrobe", label: "Гардероб", icon: Shirt },
    { id: "settings", label: "Настройки", icon: Settings },
  ];

  return (
    <m.nav
      aria-label="Основная навигация"
      initial={false}
      animate={{ width: collapsed ? 60 : 208 }}
      transition={
        reducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }
      }
      className={cn(
        "border-border/50 bg-card/40 relative z-20 flex min-h-0 shrink-0",
        "flex-col border-r backdrop-blur-md",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {!collapsed && providerName && (
          <p
            className="text-muted-foreground truncate px-2.5 pt-1.5 pb-2 font-mono text-[10px]"
            title={providerName}
          >
            {providerName}
          </p>
        )}
        {items.map((item) => {
          const active = section === item.id;
          const Icon = item.icon;
          const button = (
            <Button
              variant="ghost"
              disabled={item.disabled}
              // Keep it focusable and hoverable so the reason is reachable by
              // keyboard and pointer; the shared Button otherwise applies
              // pointer-events-none and the hint can never be read.
              focusableWhenDisabled={item.disabled ? true : undefined}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              title={collapsed && !item.hint ? item.label : undefined}
              onClick={() => onNavigate(item.id)}
              className={cn(
                "h-9 w-full items-center gap-2.5 rounded-lg text-xs font-medium",
                collapsed ? "justify-center px-0" : "justify-start px-2.5",
                // focusableWhenDisabled drops the native :disabled styling, so
                // the muted look is restored explicitly. It stays hoverable so
                // the tooltip explaining the reason can still be read.
                item.disabled
                  ? "cursor-not-allowed opacity-50 hover:bg-transparent"
                  : "cursor-pointer",
                active
                  ? "bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Button>
          );
          if (!item.hint) return <div key={item.id}>{button}</div>;
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger render={button} />
              <TooltipContent side="right" className="max-w-56">
                {item.hint}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="border-border/50 flex shrink-0 flex-col gap-1 border-t p-2">
        {username && (
          <div
            className={cn(
              "flex items-center gap-2",
              collapsed ? "flex-col px-0" : "px-2.5 py-1.5",
            )}
          >
            <UserRound
              className="text-muted-foreground h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            {!collapsed && (
              <span
                className="text-foreground min-w-0 flex-1 truncate text-xs font-medium"
                title={username}
              >
                {username}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={actionsDisabled}
              aria-label={`Выйти из аккаунта ${username}`}
              title={`Выйти из аккаунта ${username}`}
              onClick={onLogout}
              className="text-muted-foreground hover:text-destructive shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        )}
        <Button
          variant="ghost"
          disabled={actionsDisabled}
          aria-label="Переподключиться"
          title={collapsed ? "Переподключиться" : undefined}
          onClick={onChangeProvider}
          className={cn(
            "text-muted-foreground hover:text-foreground h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg text-xs",
            collapsed ? "justify-center px-0" : "justify-start px-2.5",
          )}
        >
          <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">Переподключиться</span>}
        </Button>
        <Button
          variant="ghost"
          aria-label="О программе"
          title={collapsed ? "О программе" : undefined}
          onClick={onAbout}
          className={cn(
            "text-muted-foreground hover:text-foreground h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg text-xs",
            collapsed ? "justify-center px-0" : "justify-start px-2.5",
          )}
        >
          <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">О программе</span>}
        </Button>
        {/* The credit is a license condition: it stays visible when collapsed. */}
        {!collapsed && brand.attribution.placement === "header" && (
          <div className="px-2.5 pt-1 pb-0.5 text-[10px]">
            <Attribution />
          </div>
        )}
        <Button
          variant="ghost"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
          title={collapsed ? "Развернуть меню" : "Свернуть меню"}
          className={cn(
            "text-muted-foreground hover:text-foreground h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg text-xs",
            collapsed ? "justify-center px-0" : "justify-start px-2.5",
          )}
        >
          <ChevronLeft
            className={cn(
              "h-4 w-4 shrink-0 transition-transform",
              collapsed && "rotate-180",
            )}
            aria-hidden="true"
          />
          {!collapsed && <span className="truncate">Свернуть</span>}
        </Button>
      </div>
    </m.nav>
  );
}
