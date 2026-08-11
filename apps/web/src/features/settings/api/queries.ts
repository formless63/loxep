import { queryOptions } from '@tanstack/react-query';
import {
  fetchApplicationSettings,
  fetchConnections,
  fetchEntities,
  fetchFirstAdminBootstrap,
  fetchHealthReport,
  fetchMonitorTargetOptions,
  fetchNotificationDeliveries,
  fetchNotificationEndpoints,
  fetchNotificationRules,
  fetchStorageBackends,
  fetchUsers
} from '@/server/admin-functions';

export const healthReportQuery = queryOptions({
  queryKey: ['settings', 'health'],
  queryFn: () => fetchHealthReport(),
  refetchInterval: 30_000
});

export const entitiesQuery = queryOptions({
  queryKey: ['settings', 'entities'],
  queryFn: () => fetchEntities()
});

export const connectionsQuery = queryOptions({
  queryKey: ['settings', 'connections'],
  queryFn: () => fetchConnections()
});

export const storageBackendsQuery = queryOptions({
  queryKey: ['settings', 'storage-backends'],
  queryFn: () => fetchStorageBackends()
});

export const usersQuery = queryOptions({
  queryKey: ['settings', 'users'],
  queryFn: () => fetchUsers()
});

export const firstAdminBootstrapQuery = queryOptions({
  queryKey: ['settings', 'first-admin-bootstrap'],
  queryFn: () => fetchFirstAdminBootstrap()
});

export const applicationSettingsQuery = queryOptions({
  queryKey: ['settings', 'application-settings'],
  queryFn: () => fetchApplicationSettings()
});

export const notificationEndpointsQuery = queryOptions({
  queryKey: ['settings', 'notification-endpoints'],
  queryFn: () => fetchNotificationEndpoints()
});

export const notificationRulesQuery = queryOptions({
  queryKey: ['settings', 'notification-rules'],
  queryFn: () => fetchNotificationRules()
});

export const monitorTargetOptionsQuery = queryOptions({
  queryKey: ['settings', 'monitor-target-options'],
  queryFn: () => fetchMonitorTargetOptions()
});

export const notificationDeliveriesQuery = queryOptions({
  queryKey: ['settings', 'notification-deliveries'],
  queryFn: () => fetchNotificationDeliveries(),
  refetchInterval: 15_000
});
