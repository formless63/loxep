import { useQuery } from '@tanstack/react-query';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { dockhandConnectionOptionsQuery } from '@/features/infrastructure/api/queries';
import type { DeclareContainerHostIntentInput } from '@/server/infrastructure-functions';

/**
 * The Dockhand host-registration intent fields (hb7 §2.2), shared between
 * `NewHostingTargetDialog`'s collapsed "Also register this host in Dockhand"
 * section and the fleet-detail registration panel's edit form — the ONE
 * place these fields are declared, since there is no separate hosting-
 * target edit form (hb7 §2.1(b)) and both callers collect exactly the same
 * shape.
 *
 * Deliberately plain React state, not a `useAppForm` field group: the
 * connection-picker and connectionType-conditional fields (socket vs direct
 * vs hawser-*) would otherwise need to extend the HOST DIALOG's own
 * `targetFormSchema`/validators with a second, unrelated concern, and the
 * registration panel has no surrounding form at all — a self-contained
 * controlled-value component is the smaller diff in both places.
 *
 * TLS/Hawser fields follow the write-only pattern every secret field in this
 * codebase uses (`MintTokenDialog`'s siblings): always render BLANK,
 * regardless of whether a value is already stored — an empty save leaves the
 * stored value untouched (hb7 §2.2, `container_host_secret`'s own doc).
 */
export interface DockhandRegistrationValue {
  connectionId: string;
  connectionType: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
  socketPath: string;
  host: string;
  port: string;
  protocol: 'http' | 'https';
  tlsSkipVerify: boolean;
  /** Comma-separated — split on submit. Upstream allows at most 10 (`DOCKHAND_MAX_LABELS`). */
  labels: string;
  publicIp: string;
  tlsCa: string;
  tlsCert: string;
  tlsKey: string;
  hawserToken: string;
}

export const emptyDockhandRegistrationValue: DockhandRegistrationValue = {
  connectionId: '',
  connectionType: 'socket',
  socketPath: '',
  host: '',
  port: '',
  protocol: 'http',
  tlsSkipVerify: false,
  labels: '',
  publicIp: '',
  tlsCa: '',
  tlsCert: '',
  tlsKey: '',
  hawserToken: ''
};

const CONNECTION_TYPE_OPTIONS = [
  { value: 'socket', label: 'Local Docker socket' },
  { value: 'direct', label: 'Direct TCP' },
  { value: 'hawser-standard', label: 'Hawser (HTTP agent)' },
  { value: 'hawser-edge', label: 'Hawser (WebSocket / edge)' }
] as const;

/**
 * Turns the plain form value into `declareContainerHostIntent`'s input.
 * Only the fields relevant to the chosen `connectionType` are sent — an
 * operator who filled in a `direct` host/port and then switched to `socket`
 * has that intent dropped, matching upstream's own per-type field set (hb7
 * §2.2) rather than sending stale values the new type does not use.
 */
export function dockhandRegistrationToIntentInput(
  hostingTargetId: string,
  value: DockhandRegistrationValue
): Omit<DeclareContainerHostIntentInput, 'actorUserId'> {
  const labels = value.labels
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');
  const port = value.port.trim();

  return {
    hostingTargetId,
    connectionId: value.connectionId,
    connectionType: value.connectionType,
    socketPath:
      value.connectionType === 'socket' && value.socketPath.trim() !== ''
        ? value.socketPath.trim()
        : undefined,
    host:
      value.connectionType === 'direct' && value.host.trim() !== '' ? value.host.trim() : undefined,
    port: value.connectionType === 'direct' && port !== '' ? Number(port) : undefined,
    protocol: value.connectionType === 'direct' ? value.protocol : undefined,
    tlsSkipVerify: value.connectionType === 'direct' ? value.tlsSkipVerify : undefined,
    labels: labels.length > 0 ? labels : undefined,
    publicIp: value.publicIp.trim() === '' ? undefined : value.publicIp.trim(),
    tlsCa:
      value.connectionType === 'direct' && value.tlsCa.trim() !== ''
        ? value.tlsCa.trim()
        : undefined,
    tlsCert:
      value.connectionType === 'direct' && value.tlsCert.trim() !== ''
        ? value.tlsCert.trim()
        : undefined,
    tlsKey:
      value.connectionType === 'direct' && value.tlsKey.trim() !== ''
        ? value.tlsKey.trim()
        : undefined,
    hawserToken:
      (value.connectionType === 'hawser-standard' || value.connectionType === 'hawser-edge') &&
      value.hawserToken.trim() !== ''
        ? value.hawserToken.trim()
        : undefined
  };
}

export default function DockhandRegistrationFields({
  value,
  onChange
}: {
  value: DockhandRegistrationValue;
  onChange: (next: DockhandRegistrationValue) => void;
}) {
  const { data: connections } = useQuery(dockhandConnectionOptionsQuery);
  const set = <K extends keyof DockhandRegistrationValue>(
    key: K,
    next: DockhandRegistrationValue[K]
  ) => onChange({ ...value, [key]: next });

  return (
    <FieldGroup>
      {(connections ?? []).length > 1 && (
        <Field>
          <FieldLabel htmlFor='dockhand-connection'>Dockhand instance</FieldLabel>
          <Select value={value.connectionId} onValueChange={(next) => set('connectionId', next)}>
            <SelectTrigger id='dockhand-connection'>
              <SelectValue placeholder='Select a Dockhand instance' />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(connections ?? []).map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor='dockhand-connection-type'>Connection type</FieldLabel>
        <Select
          value={value.connectionType}
          onValueChange={(next) =>
            set('connectionType', next as DockhandRegistrationValue['connectionType'])
          }
        >
          <SelectTrigger id='dockhand-connection-type'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {CONNECTION_TYPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {value.connectionType === 'socket' && (
        <Field>
          <FieldLabel htmlFor='dockhand-socket-path'>Socket path</FieldLabel>
          <Input
            id='dockhand-socket-path'
            placeholder='/var/run/docker.sock (default)'
            value={value.socketPath}
            onChange={(event) => set('socketPath', event.target.value)}
          />
        </Field>
      )}

      {value.connectionType === 'direct' && (
        <>
          <Field>
            <FieldLabel htmlFor='dockhand-host'>Host</FieldLabel>
            <Input
              id='dockhand-host'
              placeholder='10.0.0.5'
              value={value.host}
              onChange={(event) => set('host', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='dockhand-port'>Port</FieldLabel>
            <Input
              id='dockhand-port'
              type='number'
              placeholder='2375 (default)'
              value={value.port}
              onChange={(event) => set('port', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='dockhand-protocol'>Protocol</FieldLabel>
            <Select
              value={value.protocol}
              onValueChange={(next) =>
                set('protocol', next as DockhandRegistrationValue['protocol'])
              }
            >
              <SelectTrigger id='dockhand-protocol'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value='http'>http</SelectItem>
                  <SelectItem value='https'>https</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation='horizontal'>
            <FieldLabel htmlFor='dockhand-tls-skip-verify'>Skip TLS verification</FieldLabel>
            <Switch
              id='dockhand-tls-skip-verify'
              checked={value.tlsSkipVerify}
              onCheckedChange={(next) => set('tlsSkipVerify', next)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='dockhand-tls-ca'>TLS CA certificate</FieldLabel>
            <Input
              id='dockhand-tls-ca'
              placeholder='Write-only — leave blank to keep the stored value'
              value={value.tlsCa}
              onChange={(event) => set('tlsCa', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='dockhand-tls-cert'>TLS client certificate</FieldLabel>
            <Input
              id='dockhand-tls-cert'
              placeholder='Write-only — leave blank to keep the stored value'
              value={value.tlsCert}
              onChange={(event) => set('tlsCert', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor='dockhand-tls-key'>TLS client key</FieldLabel>
            <Input
              id='dockhand-tls-key'
              type='password'
              placeholder='Write-only — leave blank to keep the stored value'
              value={value.tlsKey}
              onChange={(event) => set('tlsKey', event.target.value)}
            />
          </Field>
        </>
      )}

      {(value.connectionType === 'hawser-standard' || value.connectionType === 'hawser-edge') && (
        <Field>
          <FieldLabel htmlFor='dockhand-hawser-token'>Hawser agent token</FieldLabel>
          <Input
            id='dockhand-hawser-token'
            type='password'
            placeholder='Write-only — leave blank to keep the stored value'
            value={value.hawserToken}
            onChange={(event) => set('hawserToken', event.target.value)}
          />
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor='dockhand-labels'>Labels</FieldLabel>
        <Input
          id='dockhand-labels'
          placeholder='Comma-separated, optional — e.g. prod, eu'
          value={value.labels}
          onChange={(event) => set('labels', event.target.value)}
        />
        <FieldDescription>Up to 10.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor='dockhand-public-ip'>Public IP</FieldLabel>
        <Input
          id='dockhand-public-ip'
          placeholder='Optional'
          value={value.publicIp}
          onChange={(event) => set('publicIp', event.target.value)}
        />
      </Field>
    </FieldGroup>
  );
}
