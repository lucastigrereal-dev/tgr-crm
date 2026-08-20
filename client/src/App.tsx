import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import DashboardLayout from "./components/DashboardLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Contracts from "./pages/Contracts";
import ContractDetail from "./pages/ContractDetail";
import Agenda from "./pages/Agenda";
import CustomerDetail from "./pages/CustomerDetail";
import Customers from "./pages/Customers";
import Finance from "./pages/Finance";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import Sales from "./pages/Sales";
import Team from "./pages/Team";
import Reservations from "./pages/Reservations";
import ImportCsv from "./pages/ImportCsv";
import Commissions from "./pages/Commissions";
import Campaigns from "./pages/Campaigns";
import Capture from "./pages/Capture";
import SalesRoom from "./pages/SalesRoom";
import SalesAnalytics from "./pages/SalesAnalytics";
import ProjectSettings from "./pages/ProjectSettings";

function Router() {
  return <DashboardLayout><Switch>
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
    <Route path="/404" component={NotFound} />
    <Route component={NotFound} />
  </Switch></DashboardLayout>;
}

function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="light"><TooltipProvider><Toaster /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;
