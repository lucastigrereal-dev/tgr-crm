import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#af8e49]">{eyebrow}</p>
      <h1 className="mt-2 font-serif text-3xl tracking-tight text-[#1d2b2a] sm:text-4xl">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
    {action}
  </div>;
}

export function MetricCard({ label, value, detail, icon: Icon, tone = "dark" }: { label: string; value: string | number; detail: string; icon: LucideIcon; tone?: "dark" | "gold" | "cream" | "sage" }) {
  const tones = {
    dark: "bg-[#1d2b2a] text-white border-[#1d2b2a]",
    gold: "bg-[#c7a35a] text-[#1d2b2a] border-[#c7a35a]",
    cream: "bg-[#f8f5ee] text-[#1d2b2a] border-[#ece5d7]",
    sage: "bg-[#dce5dc] text-[#24403d] border-[#c6d4c7]",
  };
  const muted = tone === "dark" ? "text-white/65" : "text-[#5f6863]";
  return <Card className={cn("overflow-hidden rounded-[1.35rem] border shadow-none", tones[tone])}>
    <CardContent className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div><p className={cn("text-[11px] font-bold uppercase tracking-[0.13em]", muted)}>{label}</p><p className="mt-4 text-3xl font-semibold tracking-tight">{value}</p></div>
        <div className={cn("rounded-2xl p-2.5", tone === "dark" ? "bg-white/10" : "bg-white/55")}><Icon className="h-5 w-5" /></div>
      </div>
      <p className={cn("mt-6 text-xs", muted)}>{detail}</p>
    </CardContent>
  </Card>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="relative overflow-hidden rounded-[1.35rem] border border-dashed border-[#d9d1c2] bg-[#fdfcf9] px-6 py-11 text-center"><div className="pointer-events-none absolute inset-x-12 top-5 h-px bg-[#e8decb]" /><div className="pointer-events-none absolute inset-x-20 bottom-5 h-px bg-[#e8decb]" /><div className="relative"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-[#d7bf82] bg-[#faf4e7] font-serif text-sm font-bold tracking-[.08em] text-[#8a6b2d]">TGR</div><p className="mt-4 font-serif text-xl text-[#1d2b2a]">{title}</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{body}</p>{action ? <div className="mt-5">{action}</div> : null}</div></div>;
}

const statusStyles: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800", prospect: "bg-amber-100 text-amber-800", inactive: "bg-stone-200 text-stone-700",
  draft: "bg-stone-200 text-stone-700", pending_signature: "bg-amber-100 text-amber-800", overdue: "bg-rose-100 text-rose-800", cancelled: "bg-rose-100 text-rose-800", closed: "bg-slate-200 text-slate-700",
  new: "bg-stone-200 text-stone-700", qualified: "bg-sky-100 text-sky-800", proposal: "bg-violet-100 text-violet-800", negotiation: "bg-amber-100 text-amber-800", won: "bg-emerald-100 text-emerald-800", lost: "bg-rose-100 text-rose-800",
  open: "bg-amber-100 text-amber-800", paid: "bg-emerald-100 text-emerald-800", confirmed: "bg-emerald-100 text-emerald-800", pending: "bg-amber-100 text-amber-800", completed: "bg-slate-200 text-slate-700", checked_in: "bg-sky-100 text-sky-800", in_progress: "bg-sky-100 text-sky-800", done: "bg-emerald-100 text-emerald-800",
};

export function StatusPill({ value }: { value: string }) {
  return <Badge className={cn("border-0 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em]", statusStyles[value] ?? "bg-stone-100 text-stone-700")}>{value.replaceAll("_", " ")}</Badge>;
}

export function TextButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <Button variant="ghost" onClick={onClick} className="h-auto px-0 text-xs font-semibold text-[#8a6b2d] hover:bg-transparent hover:text-[#5c451a]">{children}<ArrowUpRight className="ml-1 h-3.5 w-3.5" /></Button>;
}

export const money = (value: string | number | null | undefined) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value ?? 0));
export const dateLabel = (value: Date | string | null | undefined) => value ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "—";
