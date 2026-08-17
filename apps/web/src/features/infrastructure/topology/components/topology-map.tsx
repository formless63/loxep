import * as React from 'react';
import { geoNaturalEarth1, geoPath, type ExtendedFeatureCollection } from 'd3-geo';
import { feature } from 'topojson-client';
import worldAtlas110m from 'world-atlas/countries-110m.json';
import { Link } from '@tanstack/react-router';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { toneForStatus } from '../constants';
import { clusterTopologyMap, type MapCluster } from '../map-clustering';
import type { InfrastructureTopologyDto } from '@/server/infrastructure-topology-functions';
import type { Tone } from '@/features/settings/components/status-tone';

const MARKER_COLOR: Record<Tone, string> = {
  default: 'var(--primary)',
  secondary: 'var(--secondary)',
  destructive: 'var(--destructive)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  outline: 'var(--muted-foreground)',
  ghost: 'var(--muted-foreground)',
  link: 'var(--muted-foreground)'
};

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 500;

// Computed once at module load (deterministic, offline — rule MAP2's "zero
// external requests"): decode the bundled 110m TopoJSON, project with
// Natural Earth (PROVISIONAL choice — see this bead's report), and freeze
// the resulting SVG path strings so every render reuses them.
//
// `topojson-client`'s own `feature()` parameter types (`Topology`/
// `GeometryCollection`, from `topojson-specification`) resolve only inside
// that package's own isolated dependency tree (bun's isolated linker), not
// from THIS file — so the raw JSON is passed through loosely and the
// RETURN value is asserted to `d3-geo`'s own `ExtendedFeatureCollection`
// (which resolves fine here, and is everything this module actually reads:
// `.features`, each with `.id`/`.geometry`/`.properties`).
type CountriesTopologyShape = { objects: { countries: unknown } };
const worldTopology = worldAtlas110m as unknown as CountriesTopologyShape;
const countryCollection = feature(
  worldTopology as never,
  worldTopology.objects.countries as never
) as unknown as ExtendedFeatureCollection;
const countryFeatures = countryCollection.features;
const projection = geoNaturalEarth1().fitSize([VIEW_WIDTH, VIEW_HEIGHT], countryCollection);
const pathGenerator = geoPath(projection);
const countryPaths = countryFeatures.map((countryFeature, index) => ({
  key: String(countryFeature.id ?? index),
  d: pathGenerator(countryFeature) ?? ''
}));

function ClusterMarker({ cluster }: { cluster: MapCluster }) {
  const point = projection([cluster.lon, cluster.lat]);
  if (point === null) return null;
  const [x, y] = point;
  const tone = toneForStatus(cluster.worstStatus);
  const count = cluster.targets.length;
  const names = cluster.targets.map((target) => target.name).join(', ');

  return (
    <g transform={`translate(${x}, ${y})`}>
      <circle
        r={count > 1 ? 9 : 6}
        style={{ fill: MARKER_COLOR[tone], stroke: 'var(--card)' }}
        strokeWidth={1.5}
      >
        <title>
          {cluster.label} — {count} {count === 1 ? 'target' : 'targets'}: {names}
        </title>
      </circle>
      {count > 1 && (
        <text
          textAnchor='middle'
          dy='0.32em'
          style={{ fill: 'var(--primary-foreground)', pointerEvents: 'none' }}
          className='text-[9px] font-semibold select-none'
        >
          {count}
        </text>
      )}
    </g>
  );
}

/**
 * The map lens (rules MAP1-MAP2). Offline SVG built from the bundled
 * `world-atlas` 110m TopoJSON — zero external requests, ever. Imported only
 * by `topology-page.tsx`, itself reached only through the topology route's
 * own code-split chunk.
 */
export function TopologyMap({ data }: { data: InfrastructureTopologyDto }) {
  const { clusters, unplaced } = React.useMemo(
    () => clusterTopologyMap(data.nodes, data.edges),
    [data]
  );

  return (
    <div className='flex flex-col gap-4 lg:flex-row'>
      <div className='min-w-0 flex-1 overflow-hidden rounded-lg border bg-card p-2'>
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className='h-auto w-full'
          role='img'
          aria-label='Hosting target locations, offline map'
        >
          <g>
            {countryPaths.map((country) => (
              <path
                key={country.key}
                d={country.d}
                style={{ fill: 'var(--muted)', stroke: 'var(--border)' }}
                strokeWidth={0.5}
              />
            ))}
          </g>
          <g>
            {clusters.map((cluster) => (
              <ClusterMarker key={cluster.key} cluster={cluster} />
            ))}
          </g>
        </svg>
      </div>
      <div className='flex w-full flex-col gap-3 lg:w-72'>
        <div className='flex flex-col gap-2 rounded-lg border bg-card p-3'>
          <h3 className='text-sm font-medium'>
            Placed ({clusters.reduce((sum, c) => sum + c.targets.length, 0)})
          </h3>
          {clusters.length === 0 ? (
            <p className='text-xs text-muted-foreground'>
              No hosting targets resolve to a known region yet.
            </p>
          ) : (
            <ul className='flex flex-col gap-2'>
              {clusters.map((cluster) => (
                <li key={cluster.key} className='text-xs'>
                  <p className='font-medium text-card-foreground'>{cluster.label}</p>
                  <ul className='ml-2 flex flex-col gap-0.5'>
                    {cluster.targets.map((target) =>
                      target.href ? (
                        <li key={target.nodeId}>
                          <Link
                            to={target.href.to}
                            params={target.href.params}
                            className='text-muted-foreground hover:text-primary hover:underline'
                          >
                            {target.name}
                          </Link>
                        </li>
                      ) : (
                        <li key={target.nodeId} className='text-muted-foreground'>
                          {target.name}
                        </li>
                      )
                    )}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className='flex flex-col gap-2 rounded-lg border bg-card p-3'>
          <h3 className='text-sm font-medium'>Unplaced ({unplaced.length})</h3>
          {unplaced.length === 0 ? (
            <Empty className='py-4'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.circleCheck />
                </EmptyMedia>
                <EmptyTitle>Every target resolves</EmptyTitle>
                <EmptyDescription>
                  Every hosting target's provider/region is in the registry.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className='flex flex-col gap-1.5'>
              {unplaced.map((target) => (
                <li key={target.nodeId} className='text-xs'>
                  <span className='font-medium text-card-foreground'>{target.name}</span>{' '}
                  <span className='text-muted-foreground'>
                    — {target.provider ?? '(no provider set)'} /{' '}
                    {target.region ?? '(no region set)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
