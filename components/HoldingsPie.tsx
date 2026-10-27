"use client";

import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
} from "recharts";
import { allocationShareText, allocationTooltipText } from "@/lib/allocation-label";
import { HOLDINGS, type Holding } from "@/lib/mock-data";
import { useI18n } from "@/lib/i18n";

type Props = {
  holdings?: Holding[];
};

// Recharts applies `contentStyle` only inside DefaultTooltipContent.
// Custom content has to paint the box itself or that style is skipped.
const allocationTooltipStyle = {
  background: "var(--background)",
  color: "var(--foreground)",
  border: "none",
  boxShadow: "none",
  outline: "none",
  padding: "4px 8px",
  fontSize: 12,
} as const;

function AllocationTooltip({ active, payload }: TooltipContentProps) {
  if (!active || payload.length === 0) return null;
  const item = payload[0];
  const name = String(item?.name ?? "");
  const raw = item?.value;
  const share =
    typeof raw === "number" ? raw : Number(Array.isArray(raw) ? raw[0] : raw);
  if (!name || !Number.isFinite(share)) return null;
  return (
    <div style={allocationTooltipStyle}>
      <span className="mono-num">{allocationTooltipText(name, share)}</span>
    </div>
  );
}

export function HoldingsPie({ holdings = HOLDINGS }: Props) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
      <div className="relative h-56 w-full max-w-[240px] mx-auto">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={holdings}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={62}
              outerRadius={88}
              paddingAngle={2}
              stroke="#0c0e12"
              strokeWidth={2}
            >
              {holdings.map((h) => (
                <Cell key={h.name} fill={h.color} />
              ))}
            </Pie>
            <Tooltip
              content={AllocationTooltip}
              wrapperStyle={{
                background: "transparent",
                border: "none",
                boxShadow: "none",
                outline: "none",
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-widest text-[#8b95a8]">
            {t("holdings.allocation")}
          </span>
          <span className="mono-num text-lg text-[#2dd4bf]">100%</span>
        </div>
      </div>
      <ul className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {holdings.map((h) => (
          <li key={h.name} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[#c5cedb]">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: h.color, boxShadow: `0 0 6px ${h.color}88` }}
              />
              {h.name}
            </span>
            <span className="mono-num text-[#8b95a8]">{allocationShareText(h.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
