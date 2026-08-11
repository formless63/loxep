import { queryOptions } from '@tanstack/react-query';
import {
  fetchApplicationSettings,
  fetchConnections,
  fetchEntities,
  fetchFirstAdminBootstrap,
  fetchHealthReport,
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
