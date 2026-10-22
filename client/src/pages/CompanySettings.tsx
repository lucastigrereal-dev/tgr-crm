import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/crm/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlockedItems, FlagsPanel, IndicatorsPanel, isGrantActive, Panel, PermissionsPanel, RoleMapPanel, SaleValidatorsPanel, StateNotice } from "@/components/crm/companySettings/panels";
import { describeBackendState, describeMutationError, flagHistory, indicatorHistory, permissionHistory, roleMapHistory, type BackendState } from "@/components/crm/companySettings/text";
import { trpc } from "@/lib/trpc";

// "Configurações da empresa": só a administração (a rota e o menu são só do admin). Cada aba usa o que o servidor já oferece; desligado ou indisponível vira aviso claro.
const errorCode = (error: unknown): string | null => (error && typeof error === "object" && "data" in error ? ((error as { data?: { code?: string } }).data?.code ?? "INTERNAL_SERVER_ERROR") : error ? "INTERNAL_SERVER_ERROR" : null);
const notice = (state: BackendState) => (state.kind === "ok" ? null : <StateNotice state={state} />);

export default function CompanySettings() {
  const [tab, setTab] = useState("recursos");
  const team = trpc.team.list.useQuery(undefined, { retry: false });
  const names = useMemo(() => new Map((team.data?.rows ?? []).map(row => [row.id, row.name ?? "Sem nome"])), [team.data]);
  return <div className="space-y-6">
    <PageHeader eyebrow="Admin" title="Configurações da empresa" description="Ajustes que a administração pode fazer sem chamar a equipe técnica. Cada mudança guarda quem fez e quando." />
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="flex-wrap"><TabsTrigger value="recursos">Recursos do sistema</TabsTrigger><TabsTrigger value="permissoes">Permissões</TabsTrigger><TabsTrigger value="comissao">Papéis da comissão</TabsTrigger><TabsTrigger value="indicadores">Indicadores</TabsTrigger><TabsTrigger value="administrativo">Administrativo autorizado</TabsTrigger></TabsList>
      <TabsContent value="recursos"><FlagsTab names={names} active={tab === "recursos"} /></TabsContent>
      <TabsContent value="permissoes"><PermissionsTab names={names} active={tab === "permissoes"} /></TabsContent>
      <TabsContent value="comissao"><RoleMapTab names={names} active={tab === "comissao"} /></TabsContent>
      <TabsContent value="indicadores"><IndicatorsTab names={names} active={tab === "indicadores"} /></TabsContent>
      <TabsContent value="administrativo"><SaleValidatorsTab active={tab === "administrativo"} /></TabsContent>
    </Tabs>
  </div>;
}

type TabProps = { names: Map<number, string>; active: boolean };

function FlagsTab({ names, active }: TabProps) {
  const utils = trpc.useUtils();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const list = trpc.featureFlags.list.useQuery(undefined, { enabled: active, retry: false });
  const history = trpc.featureFlags.history.useQuery({ key: openKey ?? "" }, { enabled: Boolean(openKey) && Boolean(list.data?.overridesEnabled), retry: false });
  const set = trpc.featureFlags.set.useMutation({ onSuccess: () => { toast.success("Mudança salva."); void utils.featureFlags.list.invalidate(); void utils.featureFlags.history.invalidate(); }, onError: error => toast.error(describeMutationError(error)) });
  if (list.isLoading) return <Panel><p className="text-sm text-muted-foreground">Carregando...</p></Panel>;
  const state = describeBackendState({ errorCode: errorCode(list.error), status: list.data?.overridesStatus });
  if (list.error || !list.data) return <Panel>{notice(state) ?? <StateNotice state={describeBackendState({ errorCode: "ERROR" }) as never} />}</Panel>;
  const off = !list.data.overridesEnabled;
  return <Panel>{off ? notice(describeBackendState({ status: "off" })) : null}{!off && state.kind !== "ok" ? notice(state) : null}
    {off ? <BlockedItems /> : <FlagsPanel flags={list.data.flags} pending={set.isPending} unavailable={list.data.overridesStatus === "unavailable"} onToggle={(key, enabled) => set.mutate({ key, enabled })} openKey={openKey} onOpenHistory={setOpenKey} historyOf={key => (key === openKey ? (history.isError ? "error" : history.data ? flagHistory(history.data, names) : undefined) : undefined)} />}</Panel>;
}

function PermissionsTab({ names, active }: TabProps) {
  const utils = trpc.useUtils();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const list = trpc.permissionOverrides.list.useQuery(undefined, { enabled: active, retry: false });
  const history = trpc.permissionOverrides.history.useQuery({ key: openKey ?? "" }, { enabled: Boolean(openKey) && Boolean(list.data?.enabled), retry: false });
  const set = trpc.permissionOverrides.set.useMutation({ onSuccess: () => { toast.success("Permissão salva."); void utils.permissionOverrides.list.invalidate(); void utils.permissionOverrides.history.invalidate(); void utils.permissionOverrides.effective.invalidate(); }, onError: error => toast.error(describeMutationError(error)) });
  if (list.isLoading) return <Panel><p className="text-sm text-muted-foreground">Carregando...</p></Panel>;
  if (list.error || !list.data) return <Panel>{notice(describeBackendState({ errorCode: errorCode(list.error) ?? "ERROR" }))}</Panel>;
  const state = describeBackendState({ status: list.data.status });
  if (state.kind !== "ok") return <Panel>{notice(state)}</Panel>;
  return <Panel><PermissionsPanel items={list.data.capabilities} roles={list.data.roles} pending={set.isPending} onSave={(key, roles) => set.mutate({ key, roles })} openKey={openKey} onOpenHistory={setOpenKey} historyOf={key => (key === openKey ? (history.isError ? "error" : history.data ? permissionHistory(history.data, names) : undefined) : undefined)} /></Panel>;
}

function RoleMapTab({ names, active }: TabProps) {
  const utils = trpc.useUtils();
  const current = trpc.commissionRoleMap.current.useQuery(undefined, { enabled: active, retry: false });
  const history = trpc.commissionRoleMap.history.useQuery(undefined, { enabled: active && Boolean(current.data), retry: false });
  const save = trpc.commissionRoleMap.save.useMutation({ onSuccess: () => { toast.success("Nova versão salva. Vale para contratos novos."); void utils.commissionRoleMap.current.invalidate(); void utils.commissionRoleMap.history.invalidate(); }, onError: error => toast.error(describeMutationError(error)) });
  if (current.isLoading) return <Panel><p className="text-sm text-muted-foreground">Carregando...</p></Panel>;
  if (current.error || !current.data) return <Panel>{notice(describeBackendState({ errorCode: errorCode(current.error) ?? "ERROR" }))}</Panel>;
  const data = current.data;
  return <Panel><RoleMapPanel key={data.version} roleMap={data.roleMap} version={data.version} isDefault={data.isDefault} ruleRoles={data.ruleRoles} storedRoles={data.storedRoles} pending={save.isPending} onSave={roleMap => save.mutate({ roleMap })} history={history.isError ? "error" : history.data ? roleMapHistory(history.data, names) : undefined} /></Panel>;
}

function IndicatorsTab({ names, active }: TabProps) {
  const utils = trpc.useUtils();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const catalog = trpc.officialIndicators.catalog.useQuery(undefined, { enabled: active, retry: false });
  const history = trpc.officialIndicators.catalogHistory.useQuery({ code: (openKey ?? "utilization") as "utilization" | "efficiency" }, { enabled: Boolean(openKey) && Boolean(catalog.data), retry: false });
  const save = trpc.officialIndicators.saveCatalogEntry.useMutation({ onSuccess: () => { toast.success("Nova versão salva."); void utils.officialIndicators.catalog.invalidate(); void utils.officialIndicators.catalogHistory.invalidate(); }, onError: error => toast.error(describeMutationError(error)) });
  if (catalog.isLoading) return <Panel><p className="text-sm text-muted-foreground">Carregando...</p></Panel>;
  if (catalog.error || !catalog.data) return <Panel>{notice(describeBackendState({ errorCode: errorCode(catalog.error) ?? "ERROR" }))}</Panel>;
  return <Panel><IndicatorsPanel items={catalog.data} pending={save.isPending} onSave={value => save.mutate(value as never)} openKey={openKey} onOpenHistory={setOpenKey} historyOf={code => (code === openKey ? (history.isError ? "error" : history.data ? indicatorHistory(history.data, names) : undefined) : undefined)} /></Panel>;
}

function SaleValidatorsTab({ active }: { active: boolean }) {
  const utils = trpc.useUtils();
  const team = trpc.team.list.useQuery(undefined, { enabled: active, retry: false });
  const grants = trpc.saleValidation.grants.list.useQuery(undefined, { enabled: active, retry: false });
  const segregation = trpc.saleValidation.segregation.get.useQuery(undefined, { enabled: active, retry: false });
  const refresh = () => { void utils.saleValidation.grants.list.invalidate(); void utils.saleValidation.segregation.get.invalidate(); };
  const grant = trpc.saleValidation.grants.grant.useMutation({ onSuccess: () => { toast.success("Autorização concedida."); refresh(); }, onError: error => toast.error(describeMutationError(error)) });
  const revoke = trpc.saleValidation.grants.revoke.useMutation({ onSuccess: () => { toast.success("Autorização revogada."); refresh(); }, onError: error => toast.error(describeMutationError(error)) });
  const setSegregation = trpc.saleValidation.segregation.set.useMutation({ onSuccess: () => { toast.success("Mudança salva."); refresh(); }, onError: error => toast.error(describeMutationError(error)) });
  if (grants.isLoading || segregation.isLoading || team.isLoading) return <Panel><p className="text-sm text-muted-foreground">Carregando...</p></Panel>;
  if (grants.error || !grants.data) return <Panel>{notice(describeBackendState({ errorCode: errorCode(grants.error) ?? "ERROR" }))}</Panel>;
  if (segregation.error || !segregation.data) return <Panel>{notice(describeBackendState({ errorCode: errorCode(segregation.error) ?? "ERROR" }))}</Panel>;
  const now = new Date();
  const withActiveGrant = new Set(grants.data.rows.filter(row => isGrantActive(row, now)).map(row => row.userId));
  const candidates = (team.data?.rows ?? []).filter(row => row.role === "finance" && !withActiveGrant.has(row.id)).map(row => ({ id: row.id, name: row.name ?? `Usuário nº ${row.id}` }));
  return <Panel><SaleValidatorsPanel grants={grants.data.rows} candidates={candidates} segregationEnabled={segregation.data.enabled} pending={grant.isPending || revoke.isPending || setSegregation.isPending} now={now} onGrant={input => grant.mutate({ userId: input.userId, validUntil: input.validUntil, note: input.note })} onRevoke={grantId => revoke.mutate({ grantId })} onSetSegregation={enabled => setSegregation.mutate({ enabled })} /></Panel>;
}
