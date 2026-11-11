"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function CopyButton({
  value,
  label = "نسخ",
  size = "sm",
  variant = "secondary",
  className,
}: {
  value: string;
  label?: string;
  size?: "sm" | "icon" | "default";
  variant?: "secondary" | "outline" | "ghost" | "default";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("تم النسخ إلى الحافظة ✓");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("تعذّر النسخ — انسخ النص يدويًا");
    }
  }

  return (
    <Button type="button" size={size} variant={copied ? "default" : variant} onClick={copy} className={className} aria-label={label}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {size !== "icon" && <span>{copied ? "تم النسخ" : label}</span>}
    </Button>
  );
}
