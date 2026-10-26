/**
 * Pool chart: the recorded line, the forecast and its resets on one time axis.
 *
 * Lines and areas sit in a 100×100 SVG stretched over the plot. Strokes keep
 * their width through `vector-effect`. Text and dots are HTML placed by
 * percent, so nothing distorts when the card resizes.
 */

import { useId, type CSSProperties } from 'react';
import type { PoolPoint } from '../poolModel';
import styles from './QuotaPoolChart.module.scss';

export interface PoolChartMark {
  atMs: number;
  value: number;
  label: string;
}

export type QuotaPoolChartProps = {
  startMs: number;
  endMs: number;
  nowMs: number;
  /** Local midnights inside the range; each starts a labelled day column. */
  dayStartsMs: number[];
  formatDay: (ms: number) => string;
  yMax: number;
  yLabels: { value: number; label: string }[];
  recorded: PoolPoint[][];
  projected: PoolPoint[];
  /** Pool value at now; null hides the dot. */
  nowValue: number | null;
  nowLabel: string;
  jumps: PoolChartMark[];
  empty: PoolChartMark | null;
  accent: string;
  ariaLabel: string;
};

/** Jump labels closer than this, in percent of the width, would overlap. */
const MIN_LABEL_GAP_PERCENT = 2.2;

export function QuotaPoolChart(props: QuotaPoolChartProps) {
  const {
    startMs,
    endMs,
    nowMs,
    dayStartsMs,
    formatDay,
    yMax,
    yLabels,
    recorded,
    projected,
    nowValue,
    nowLabel,
    jumps,
    empty,
    accent,
    ariaLabel,
  } = props;
  const gradientId = `pool-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const x = (atMs: number) => ((atMs - startMs) / (endMs - startMs)) * 100;
  const y = (value: number) => (1 - Math.max(0, Math.min(value, yMax)) / yMax) * 100;
  const inRange = (atMs: number) => atMs >= startMs && atMs <= endMs;

  const linePath = (points: PoolPoint[]) =>
    points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.atMs)} ${y(point.value)}`)
      .join('');
  const areaPath = (points: PoolPoint[]) => {
    if (points.length < 2) return '';
    const first = points[0];
    const last = points[points.length - 1];
    return `${linePath(points)}L${x(last.atMs)} 100L${x(first.atMs)} 100Z`;
  };

  const visibleJumps: PoolChartMark[] = [];
  for (const jump of jumps) {
    if (!inRange(jump.atMs)) continue;
    const previous = visibleJumps[visibleJumps.length - 1];
    if (previous && x(jump.atMs) - x(previous.atMs) < MIN_LABEL_GAP_PERCENT) continue;
    visibleJumps.push(jump);
  }
  const dayMs = dayStartsMs.length > 1 ? dayStartsMs[1] - dayStartsMs[0] : endMs - startMs;
  const showNow = inRange(nowMs);

  return (
    <figure
      className={styles.chart}
      style={{ '--pool-accent': accent } as CSSProperties}
      aria-label={ariaLabel}
    >
      <div className={styles.yAxis} aria-hidden="true">
        {yLabels.map((item) => (
          <span key={item.value} className={styles.yLabel} style={{ top: `${y(item.value)}%` }}>
            {item.label}
          </span>
        ))}
      </div>

      <div className={styles.area}>
        <div className={styles.plot}>
          <svg
            className={styles.svg}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={`${gradientId}-recorded`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className={styles.stopStrong} />
                <stop offset="1" className={styles.stopClear} />
              </linearGradient>
              <linearGradient id={`${gradientId}-projected`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className={styles.stopSoft} />
                <stop offset="1" className={styles.stopClear} />
              </linearGradient>
              {/* Taller than the plot so a line at 0% or full capacity keeps its whole stroke. */}
              <clipPath id={`${gradientId}-clip`}>
                <rect x="0" y="-5" width="100" height="110" />
              </clipPath>
            </defs>

            {yLabels.map((item) => (
              <line
                key={item.value}
                className={styles.gridLine}
                x1="0"
                x2="100"
                y1={y(item.value)}
                y2={y(item.value)}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {dayStartsMs.map((dayStart) => (
              <line
                key={dayStart}
                className={styles.gridLine}
                x1={x(dayStart)}
                x2={x(dayStart)}
                y1="0"
                y2="100"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            <g clipPath={`url(#${gradientId}-clip)`}>
              {recorded.map((points) => (
                <path
                  key={`area-${points[0]?.atMs}`}
                  d={areaPath(points)}
                  fill={`url(#${gradientId}-recorded)`}
                />
              ))}
              <path d={areaPath(projected)} fill={`url(#${gradientId}-projected)`} />
              {recorded.map((points) => (
                <path
                  key={`line-${points[0]?.atMs}`}
                  className={styles.recordedLine}
                  d={linePath(points)}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <path
                className={styles.projectedLine}
                d={linePath(projected)}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          </svg>

          {visibleJumps.map((jump) => (
            <span
              key={jump.atMs}
              className={styles.jumpLabel}
              style={{ left: `${x(jump.atMs)}%`, top: `${y(jump.value)}%` }}
            >
              {jump.label}
            </span>
          ))}

          {showNow && nowValue !== null && (
            <span
              className={styles.nowDot}
              style={{ left: `${x(nowMs)}%`, top: `${y(nowValue)}%` }}
              aria-hidden="true"
            />
          )}

          {empty && inRange(empty.atMs) && (
            <>
              <span
                className={styles.emptyDot}
                style={{ left: `${x(empty.atMs)}%`, top: '100%' }}
                aria-hidden="true"
              />
              <span className={styles.emptyLabel} style={{ left: `${x(empty.atMs)}%` }}>
                {empty.label}
              </span>
            </>
          )}
        </div>

        <div className={styles.xAxis} aria-hidden="true">
          {dayStartsMs.map((dayStart) => (
            <span
              key={dayStart}
              className={styles.xLabel}
              style={{ left: `${x(dayStart + dayMs / 2)}%` }}
            >
              {formatDay(dayStart)}
            </span>
          ))}
        </div>

        {showNow && (
          <div className={styles.now} style={{ left: `${x(nowMs)}%` }} aria-hidden="true">
            <span className={styles.nowLabel}>{nowLabel}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
