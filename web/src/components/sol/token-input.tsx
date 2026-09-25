"use client";

import { WalletIcon } from "lucide-react";
import React from "react";
import { NumericFormat, type SourceInfo } from "react-number-format";
import { TokenCombobox } from "@/components/sol/token-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface TokenInputProps {
  tokens: { icon: string; symbol: string }[];
  defaultToken?: string;
  balance?: string;
  balanceMessage?: string;
  value?: string;
  usdValue?: string;
  onValueChange?: (value: string) => void;
  onTokenSelect?: (token: { icon: string; symbol: string }) => void;
  ariaLabel?: string;
  presets?: { label: string; fraction: number }[];
  onPreset?: (fraction: number) => void;
  disabled?: boolean;
  className?: string;
}

const TokenInput = ({
  tokens,
  defaultToken,
  balance,
  balanceMessage,
  value,
  usdValue,
  onValueChange,
  onTokenSelect,
  ariaLabel,
  presets = [{ label: "Half", fraction: 0.5 }, { label: "Max", fraction: 1 }],
  onPreset,
  disabled = false,
  className,
}: TokenInputProps) => {
  const [internalValue, setInternalValue] = React.useState(value ?? "");
  const currentValue = value ?? internalValue;

  const handleValueChange = (values: { value: string }, info: SourceInfo) => {
    if (info.source !== "event" || !["change", "input"].includes(info.event?.type ?? "")) return;
    setInternalValue(values.value);
    onValueChange?.(values.value);
  };

  const handleQuickAmount = (fraction: number) => {
    if (onPreset) { onPreset(fraction); return; }
    if (!balance) return;
    const numericBalance = Number.parseFloat(balance.replace(/,/g, ""));
    if (Number.isNaN(numericBalance)) return;
    const newValue = (numericBalance * fraction).toString();
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border p-4 rounded-lg w-full",
        className,
      )}
    >
      {(balance !== undefined || balanceMessage) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <WalletIcon className="size-3.5" />
            Balance: {balance ?? balanceMessage}
          </span>
          {balance !== undefined && <div className="flex items-center gap-2">
            {presets.map(({ label, fraction }) => <Button key={label} type="button" variant="outline" size="sm"
              disabled={disabled} className="h-6 rounded-sm px-2 text-xs" onClick={() => handleQuickAmount(fraction)}>{label}</Button>)}
          </div>}
        </div>
      )}
      <div className="flex items-center gap-2 w-full">
        <TokenCombobox
          tokens={tokens}
          defaultValue={defaultToken}
          onSelect={onTokenSelect}
        />
        <div className="flex flex-col flex-1 min-w-0 items-end">
          <NumericFormat
            aria-label={ariaLabel}
            disabled={disabled}
            value={currentValue}
            onValueChange={handleValueChange}
            thousandSeparator=","
            decimalSeparator="."
            allowNegative={false}
            placeholder="0"
            inputMode="decimal"
            customInput={Input}
            className="text-right bg-transparent pr-1 dark:bg-transparent shadow-none border-none focus:ring-0 focus-visible:ring-0 w-full md:text-xl"
          />
          {usdValue && (
            <span className="text-xs text-muted-foreground pr-1">
              {usdValue}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export type { TokenInputProps };
export { TokenInput };
