import type { ReactNode } from "react";

/** Reserve the widest of the idle/busy labels without exposing both to AT. */
export default function StableActionLabel({
  busy,
  idle,
  active,
}: {
  busy: boolean;
  idle: ReactNode;
  active: ReactNode;
}) {
  return (
    <span className="inline-grid items-center">
      <span
        className={
          busy ? "invisible col-start-1 row-start-1" : "col-start-1 row-start-1"
        }
        aria-hidden={busy}
      >
        {idle}
      </span>
      <span
        className={
          busy ? "col-start-1 row-start-1" : "invisible col-start-1 row-start-1"
        }
        aria-hidden={!busy}
      >
        {active}
      </span>
    </span>
  );
}
