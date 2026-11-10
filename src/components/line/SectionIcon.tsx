import type { LucideIcon } from "lucide-react";

/** A section marker, not a button: no tile, border, background or click affordance. */
export default function SectionIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      data-line-icon="section"
      className="text-primary mt-0.5 h-6 w-6 shrink-0"
      aria-hidden="true"
    />
  );
}
