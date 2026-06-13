import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

interface TipProps {
  label: string;
  children: React.ReactElement;
}

export function Tip({ label, children }: TipProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip-content" sideOffset={5}>
          {label}
          <Tooltip.Arrow className="tip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
