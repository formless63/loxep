import { createFileRoute } from '@tanstack/react-router';
import KanbanViewPage from '@/features/kanban/components/kanban-view-page';

export const Route = createFileRoute('/starter/kanban')({
  head: () => ({ meta: [{ title: 'Dashboard : Kanban view' }] }),
  component: () => <KanbanViewPage />
});
