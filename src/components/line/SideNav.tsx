import { m, useReducedMotion } from "framer-motion";
import {
  ChevronLeft,
  Info,
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
import { useT } from "@/lib/line/i18n";

export type LineSection = "servers" | "wardrobe" | "account" | "settings";

export interface SideNavProps {
  section: LineSection;
  collapsed: boolean;
  onNavigate: (section: LineSection) => void;
  onToggleCollapsed: () => void;
  onAbout: () => void;
  navigationDisabled?: boolean;
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
 * it needs no colour of its own. Geometry reuses Obsy's
 * radii and the shared Button primitive keeps keyboard/focus semantics.
 *
 * Collapsed mode keeps the same targets as icon buttons with accessible names
 * and native tooltips, so nothing becomes unreachable.
 */
export default function SideNav({
  section,
  collapsed,
  onNavigate,
  onToggleCollapsed,
  onAbout,
  navigationDisabled = false,
}: SideNavProps) {
  const reducedMotion = useReducedMotion();
  const t = useT();
  const items: NavItem[] = [
    { id: "servers", label: t("nav.servers"), icon: Server },
    // Not gated by feature flags: the section is a normal destination once the
    // player is signed in (the sign-in page covers the whole window until then).
    { id: "wardrobe", label: t("nav.wardrobe"), icon: Shirt },
    // The account is a page now, not only a name in the footer: it is where the
    // player sees what they look like in game, and the only place the session
    // state is explained.
    { id: "account", label: t("nav.account"), icon: UserRound },
  ];

  return (
    <m.nav
      aria-label={t("nav.primary")}
      initial={false}
      animate={{ width: collapsed ? 60 : 208 }}
      transition={
        reducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }
      }
      data-line-glass="sidebar"
      className={cn(
        "relative z-20 flex min-h-0 shrink-0 flex-col",
        "rounded-[var(--radius-item)]",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-x-hidden overflow-y-auto p-2">
        {items.map((item) => {
          const active = section === item.id;
          const Icon = item.icon;
          const button = (
            <Button
              key={item.id}
              variant="ghost"
              disabled={item.disabled || navigationDisabled}
              // Keep it focusable and hoverable so the reason is reachable by
              // keyboard and pointer; the shared Button otherwise applies
              // pointer-events-none and the hint can never be read.
              focusableWhenDisabled={
                item.disabled && !navigationDisabled ? true : undefined
              }
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              title={collapsed && !item.hint ? item.label : undefined}
              onClick={() => onNavigate(item.id)}
              className={cn(
                "items-center gap-2.5 rounded-lg text-xs font-medium",
                // Collapsed targets are squares, not bars: the rail is 60px
                // wide with 8px of padding each side, so 40x40 leaves 2px of
                // air on both sides. 44 filled the rail edge to edge, which is
                // why the highlight read as a slab against the sidebar.
                collapsed
                  ? "mx-auto h-10 w-10 justify-center px-0"
                  : "h-12 w-full justify-start px-2.5",
                // focusableWhenDisabled drops the native :disabled styling, so
                // the muted look is restored explicitly. It stays hoverable so
                // the tooltip explaining the reason can still be read.
                item.disabled || navigationDisabled
                  ? "cursor-not-allowed opacity-50 hover:bg-transparent"
                  : "cursor-pointer",
                active
                  ? "bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-[30px] w-[30px] shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Button>
          );
          if (!item.hint) return button;
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

      <div className="flex shrink-0 flex-col gap-1 p-2">
        <Button
          variant="ghost"
          disabled={navigationDisabled}
          aria-current={section === "settings" ? "page" : undefined}
          aria-label={t("nav.settings")}
          title={collapsed ? t("nav.settings") : undefined}
          onClick={() => onNavigate("settings")}
          className={cn(
            "items-center gap-2.5 rounded-lg text-xs",
            collapsed
              ? "mx-auto h-10 w-10 justify-center px-0"
              : "h-12 w-full justify-start px-2.5",
            section === "settings"
              ? "bg-primary/10 text-primary hover:bg-primary/15"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Settings className="h-[30px] w-[30px] shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">{t("nav.settings")}</span>}
        </Button>
        <Button
          variant="ghost"
          aria-label={t("nav.about")}
          title={collapsed ? t("nav.about") : undefined}
          onClick={onAbout}
          className={cn(
            "text-muted-foreground hover:text-foreground cursor-pointer items-center gap-2.5 rounded-lg text-xs",
            collapsed
              ? "mx-auto h-10 w-10 justify-center px-0"
              : "h-12 w-full justify-start px-2.5",
          )}
        >
          <Info className="h-[30px] w-[30px] shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">{t("nav.about")}</span>}
        </Button>
        {/* The credit is a license condition: it stays visible when collapsed. */}
        {!collapsed && brand.attribution.placement === "header" && (
          <div className="text-muted-foreground/70 px-2.5 pt-1 pb-0.5 text-[12px]">
            <Attribution />
          </div>
        )}
        <Button
          variant="ghost"
          onClick={onToggleCollapsed}
          disabled={navigationDisabled}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
          className={cn(
            "text-muted-foreground hover:text-foreground cursor-pointer items-center gap-2.5 rounded-lg text-xs",
            collapsed
              ? "mx-auto h-10 w-10 justify-center px-0"
              : "h-11 w-full justify-start px-2.5",
          )}
        >
          <ChevronLeft
            className={cn(
              "h-[30px] w-[30px] shrink-0 transition-transform",
              collapsed && "rotate-180",
            )}
            aria-hidden="true"
          />
          {!collapsed && <span className="truncate">{t("nav.collapse")}</span>}
        </Button>
      </div>
    </m.nav>
  );
}
