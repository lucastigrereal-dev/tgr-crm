import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type FunnelRow = { label: string; value: number; color: string };

export default function SalesFunnelChart({ data }: { data: FunnelRow[] }) {
  return <div className="h-[320px]" data-testid="sales-funnel-chart">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 10 }}>
        <CartesianGrid horizontal={false} stroke="#eee9df" />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} fontSize={11} width={95} />
        <Tooltip formatter={(value: number) => [value, "Fichas"]} />
        <Bar dataKey="value" name="Fichas" radius={[0, 7, 7, 0]}>
          {data.map(item => <Cell key={item.label} fill={item.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>;
}
