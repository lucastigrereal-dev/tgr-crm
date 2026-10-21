import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BLOCKED_ITEMS, CAPABILITY_LABELS, formatWhen, INDICATOR_LABELS, RULE_ROLE_LABELS, roleLabel, STORED_ROLE_LABELS, type BackendState, type HistoryEntry } from "./text";

// Painéis só de apresentação: recebem os dados e os botões por props (a página liga ao servidor), para testar sem navegador e sem rede.

export function StateNotice({ state }: { state: Exclude<BackendState, { kind: "ok" }> }) {
  return <div role="status" data-state={state.kind} className="rounded-xl border border-[#e9e4da] bg-[#f8f5ee] p-5"><p className="font-semibold text-[#1d2b2a]">{state.title}</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{state.text}</p></div>;
}

export type HistoryState = HistoryEntry[] | "error" | undefined;
export function HistoryList({ title = "Histórico de mudanças", entries }: { title?: string; entries: HistoryState }) {
  return <div className="mt-3 rounded-lg border border-[#ece6da] bg-white p-3" aria-label={title}>
    <p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">{title}</p>
    {entries === "error" ? <p role="alert" className="mt-2 text-sm text-[#9a3b2e]">Não foi possível ler o histórico agora. Tente de novo em alguns minutos.</p> : !entries ? <p className="mt-2 text-sm text-muted-foreground">Carregando...</p> : entries.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Ainda não houve mudança.</p> :
      <ul className="mt-2 space-y-1 text-sm">{entries.map(entry => <li key={entry.key}><span className="font-medium">{entry.who}</span> em {entry.when}: {entry.what}</li>)}</ul>}
  </div>;
}

/** Itens que aparecem trancados: sem botão, sem valor. */
export function BlockedItems() {
  return <div className="mt-6" aria-label="Itens bloqueados"><p className="text-xs font-bold uppercase tracking-[.12em] text-[#52615c]">Bloqueados (somente leitura)</p>
    <ul className="mt-2 space-y-2">{BLOCKED_ITEMS.map(item => <li key={item.label} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#ece6da] bg-[#f8f5ee] p-3 text-sm"><span>{item.label}</span><span className="flex items-center gap-2"><Badge variant="outline">Bloqueado</Badge><span className="text-xs text-muted-foreground">{item.reason}</span></span></li>)}</ul></div>;
}

// ---- Recursos do sistema (as 6 chaves permitidas)
export type FlagRow = { key: string; label: string; restartRequired: boolean; effective: boolean; override: { enabled: boolean; createdByUserId: number; createdAt: unknown } | null; pendingRestart: boolean | null };
export function FlagsPanel({ flags, pending, onToggle, historyOf, onOpenHistory, openKey, unavailable }: { flags: FlagRow[]; pending: boolean; onToggle: (key: string, enabled: boolean) => void; historyOf: (key: string) => HistoryState; onOpenHistory: (key: string | null) => void; openKey: string | null; unavailable: boolean }) {
  return <div><ul className="space-y-3">{flags.map(flag => { const configured = flag.override ? flag.override.enabled : flag.effective; return <li key={flag.key} className="rounded-xl border border-[#e9e4da] bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><p className="font-medium text-[#1d2b2a]">{flag.label}</p>
        <p className="mt-1 text-xs text-muted-foreground">Agora: <strong>{flag.effective ? "ligado" : "desligado"}</strong>{flag.restartRequired ? " · só muda depois de reiniciar o sistema" : " · muda na hora"}</p>
        {flag.pendingRestart ? <p className="mt-1 text-xs font-medium text-[#94702e]">Escolha salva: aguardando o reinício do sistema para valer.</p> : null}
        {unavailable ? <p className="mt-1 text-xs text-muted-foreground">Não foi possível conferir se há mudança salva.</p> : null}</div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending || unavailable} aria-label={`${configured ? "Desligar" : "Ligar"}: ${flag.label}`} onClick={() => onToggle(flag.key, !configured)}>{configured ? "Desligar" : "Ligar"}</Button>
        <Button size="sm" variant="ghost" disabled={unavailable} onClick={() => onOpenHistory(openKey === flag.key ? null : flag.key)}>{openKey === flag.key ? "Ocultar histórico" : "Ver histórico"}</Button></div>
    </div>
    {unavailable ? <HistoryList entries="error" /> : openKey === flag.key ? <HistoryList entries={historyOf(flag.key)} /> : null}
  </li>; })}</ul><BlockedItems /></div>;
}

// ---- Indicadores oficiais
export type IndicatorRow = { code: string; version: number; label: string; description: string; active: boolean; isDefault: boolean };
function IndicatorEditor({ item, pending, onSave }: { item: IndicatorRow; pending: boolean; onSave: (v: { code: string; label: string; description: string; active: boolean }) => void }) {
  const [label, setLabel] = useState(item.label);
  const [description, setDescription] = useState(item.description);
  const [active, setActive] = useState(item.active);
  return <div className="space-y-2">
    <label className="grid gap-1 text-sm">Nome mostrado<Input value={label} maxLength={160} onChange={event => setLabel(event.target.value)} aria-label={`Nome de ${INDICATOR_LABELS[item.code] ?? "indicador"}`} /></label>
    <label className="grid gap-1 text-sm">Explicação<Input value={description} maxLength={500} onChange={event => setDescription(event.target.value)} aria-label={`Explicação de ${INDICATOR_LABELS[item.code] ?? "indicador"}`} /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />Mostrar este indicador</label>
    <Button size="sm" disabled={pending || label.trim().length < 3} onClick={() => onSave({ code: item.code, label: label.trim(), description: description.trim(), active })}>Salvar nova versão</Button>
  </div>;
}
export function IndicatorsPanel({ items, pending, onSave, historyOf, onOpenHistory, openKey }: { items: IndicatorRow[]; pending: boolean; onSave: (v: { code: string; label: string; description: string; active: boolean }) => void; historyOf: (code: string) => HistoryState; onOpenHistory: (code: string | null) => void; openKey: string | null }) {
  return <div><p className="mb-3 text-sm text-muted-foreground">Aqui só se muda o nome e a explicação. A conta de cada indicador continua a oficial do sistema. Cada salvamento cria uma nova versão e guarda quem mudou.</p>
    <ul className="space-y-3">{items.map(item => <li key={item.code} className="rounded-xl border border-[#e9e4da] bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2"><p className="font-medium">{INDICATOR_LABELS[item.code] ?? "Indicador"}</p><Badge variant="outline">{item.isDefault ? "Texto padrão" : `Versão ${item.version}`}</Badge>{item.active ? null : <Badge variant="outline">Oculto</Badge>}</div>
      <IndicatorEditor key={`${item.code}-${item.version}`} item={item} pending={pending} onSave={onSave} />
      <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => onOpenHistory(openKey === item.code ? null : item.code)}>{openKey === item.code ? "Ocultar histórico" : "Ver histórico"}</Button></div>
      {openKey === item.code ? <HistoryList entries={historyOf(item.code)} /> : null}
    </li>)}</ul></div>;
}

// ---- Papéis da comissão
export type RoleMap = Record<string, string>;
export function RoleMapPanel({ roleMap, version, isDefault, ruleRoles, storedRoles, pending, onSave, history }: { roleMap: RoleMap; version: number; isDefault: boolean; ruleRoles: readonly string[]; storedRoles: readonly string[]; pending: boolean; onSave: (map: RoleMap) => void; history: HistoryState }) {
  const [draft, setDraft] = useState<RoleMap>(roleMap);
  const values = ruleRoles.map(role => draft[role]);
  const valid = new Set(values).size === ruleRoles.length && values.every(value => value && storedRoles.includes(value));
  return <div><p className="mb-3 text-sm text-muted-foreground">Define quem recebe cada parte da comissão da nova regra. A mudança vale só para contratos novos: contratos já assinados mantêm o que valia quando foram assinados. A nova regra de comissão continua travada até o aceite da sala.</p>
    <div className="rounded-xl border border-[#e9e4da] bg-white p-4"><p className="mb-2 text-xs text-muted-foreground">{isDefault ? "Usando o padrão do sistema." : `Versão ${version} em uso.`}</p>
      <div className="grid gap-3 sm:grid-cols-3">{ruleRoles.map(role => <label key={role} className="grid gap-1 text-sm">{RULE_ROLE_LABELS[role] ?? "Parte"} recebe como
        <select className="h-9 rounded-md border border-input bg-background px-2" value={draft[role]} aria-label={`${RULE_ROLE_LABELS[role] ?? "Parte"} recebe como`} onChange={event => setDraft({ ...draft, [role]: event.target.value })}>{storedRoles.map(stored => <option key={stored} value={stored}>{STORED_ROLE_LABELS[stored] ?? "Papel"}</option>)}</select></label>)}</div>
      {valid ? null : <p role="alert" className="mt-2 text-sm text-[#9a3b2e]">Cada parte precisa de um papel diferente. Ajuste antes de salvar.</p>}
      <Button className="mt-3" size="sm" disabled={pending || !valid} onClick={() => onSave(draft)}>Salvar nova versão</Button></div>
    <HistoryList entries={history} /></div>;
}

// ---- Permissões por ação
export type CapabilityRow = { key: string; defaultRoles: readonly string[]; roles: readonly string[]; overridden: boolean };
function CapabilityEditor({ item, allRoles, pending, onSave }: { item: CapabilityRow; allRoles: readonly string[]; pending: boolean; onSave: (key: string, roles: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([...item.roles]);
  const toggle = (role: string) => setSelected(selected.includes(role) ? selected.filter(r => r !== role) : [...selected, role]);
  return <div><div className="flex flex-wrap gap-4">{allRoles.map(role => <label key={role} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={role === "admin" || selected.includes(role)} disabled={role === "admin"} onChange={() => toggle(role)} aria-label={`${roleLabel(role)} pode: ${CAPABILITY_LABELS[item.key]?.label ?? "ação"}`} />{roleLabel(role)}{role === "admin" ? <span className="text-xs text-muted-foreground">(sempre)</span> : null}</label>)}</div>
    <div className="mt-2 flex items-center gap-2"><Button size="sm" disabled={pending} onClick={() => onSave(item.key, selected)}>Salvar</Button><span className="text-xs text-muted-foreground">Padrão: {item.defaultRoles.map(roleLabel).join(", ")}</span></div></div>;
}
export function PermissionsPanel({ items, roles, pending, onSave, historyOf, onOpenHistory, openKey }: { items: CapabilityRow[]; roles: readonly string[]; pending: boolean; onSave: (key: string, roles: string[]) => void; historyOf: (key: string) => HistoryState; onOpenHistory: (key: string | null) => void; openKey: string | null }) {
  return <div><p className="mb-3 text-sm text-muted-foreground">Escolha quem pode fazer cada ação. A administração sempre pode e não dá para tirar. Ações sensíveis, como validar venda, pagar comissão e cancelar contrato, não aparecem aqui porque são fixas. O acesso às telas também continua fixo por enquanto.</p>
    <ul className="space-y-3">{items.map(item => <li key={item.key} className="rounded-xl border border-[#e9e4da] bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2"><p className="font-medium">{CAPABILITY_LABELS[item.key]?.label ?? "Permissão"}</p>{item.overridden ? <Badge variant="outline">Alterado</Badge> : <Badge variant="outline">Padrão</Badge>}</div>
      <p className="mb-2 text-xs text-muted-foreground">{CAPABILITY_LABELS[item.key]?.help}</p>
      <CapabilityEditor key={`${item.key}-${item.roles.join(",")}`} item={item} allRoles={roles} pending={pending} onSave={onSave} />
      <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => onOpenHistory(openKey === item.key ? null : item.key)}>{openKey === item.key ? "Ocultar histórico" : "Ver histórico"}</Button></div>
      {openKey === item.key ? <HistoryList entries={historyOf(item.key)} /> : null}
    </li>)}</ul></div>;
}

export function Panel({ children }: { children: React.ReactNode }) { return <Card className="border-[#e8e1d4]"><CardContent className="p-5">{children}</CardContent></Card>; }
export { formatWhen };
