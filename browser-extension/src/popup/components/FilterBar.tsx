// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

type FilterType = "matching" | "domain" | "all";

interface FilterBarProps {
  active: FilterType;
  onFilterChange: (filter: FilterType) => void;
  counts: { matching: number; domain: number; all: number };
}

const filters: { key: FilterType; label: string }[] = [
  { key: "matching", label: "Matching Logins" },
  { key: "domain", label: "Same Domain" },
  { key: "all", label: "All" },
];

export function FilterBar({ active, onFilterChange, counts }: FilterBarProps) {
  return (
    <div className="flex border-b border-border bg-surface">
      {filters.map(({ key, label }) => {
        const count = counts[key];
        const displayCount = key === "all" && count > 50 ? `${count}+` : String(count);
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onFilterChange(key)}
            className={`flex-1 cursor-pointer py-2 px-2 text-center text-[11px] transition-colors ${
              isActive
                ? "border-b-2 border-accent font-semibold text-accent"
                : "border-b-2 border-transparent text-text-muted hover:text-text-primary"
            }`}
          >
            <span>{label}</span>
            {count > 0 && (
              <span
                className={`ml-1 rounded-full px-1.5 py-px text-[9px] font-medium ${
                  isActive ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-dim"
                }`}
              >
                {displayCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
