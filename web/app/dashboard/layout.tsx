import Sidebar from '@/components/dashboard/Sidebar';
import TopBar from '@/components/dashboard/TopBar';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <div className="ml-[220px] flex min-h-screen flex-col max-lg:ml-[64px]">
        <TopBar />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
