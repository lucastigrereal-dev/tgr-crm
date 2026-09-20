import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import DashboardLayout from "./components/DashboardLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
const Contracts = lazy(() => import("./pages/Contracts"));
const ContractDetail = lazy(() => import("./pages/ContractDetail"));
const Agenda = lazy(() => import("./pages/Agenda"));
const CustomerDetail = lazy(() => import("./pages/CustomerDetail"));
const Customers = lazy(() => import("./pages/Customers"));
const Finance = lazy(() => import("./pages/Finance"));
const Home = lazy(() => import("./pages/Home"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Sales = lazy(() => import("./pages/Sales"));
const Team = lazy(() => import("./pages/Team"));
const Reservations = lazy(() => import("./pages/Reservations"));
const ImportCsv = lazy(() => import("./pages/ImportCsv"));
const Commissions = lazy(() => import("./pages/Commissions"));
const Campaigns = lazy(() => import("./pages/Campaigns"));
const Capture = lazy(() => import("./pages/Capture"));
const SalesRoom = lazy(() => import("./pages/SalesRoom"));
const SalesAnalytics = lazy(() => import("./pages/SalesAnalytics"));
const ProjectSettings = lazy(() => import("./pages/ProjectSettings"));
const Intelligence = lazy(() => import("./pages/Intelligence"));

function PageFallback() {
  return <div className="flex min-h-[40vh] items-center justify-center p-8 text-sm text-muted-foreground">Carregando área do TGR CRM…</div>;
}

function Router() {
  return <DashboardLayout><Suspense fallback={<PageFallback />}><Switch>
    <Route path="/" component={Home} />
    <Route path="/clientes" component={Customers} />
    <Route path="/clientes/:id" component={CustomerDetail} />
    <Route path="/vendas" component={Sales} />
    <Route path="/captacao" component={Capture} />
    <Route path="/sala-de-vendas" component={SalesRoom} />
    <Route path="/analise-de-vendas" component={SalesAnalytics} />
    <Route path="/comissoes" component={Commissions} />
    <Route path="/campanhas" component={Campaigns} />
    <Route path="/contratos" component={Contracts} />
    <Route path="/contratos/:id" component={ContractDetail} />
    <Route path="/reservas" component={Reservations} />
    <Route path="/financeiro" component={Finance} />
    <Route path="/agenda" component={Agenda} />
    <Route path="/equipe" component={Team} />
    <Route path="/importar" component={ImportCsv} />
    <Route path="/configuracoes-projeto" component={ProjectSettings} />
    <Route path="/inteligencia" component={Intelligence} />
    <Route path="/404" component={NotFound} />
    <Route component={NotFound} />
  </Switch></Suspense></DashboardLayout>;
}

function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="light"><TooltipProvider><Toaster /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;
