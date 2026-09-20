import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Annotation } from './types';
import { labelPoint } from './canvasGeometry';
export type Tool = 'select' | 'hand' | Annotation['type'];

export function ToolIcon({ tool }: { tool: Tool }) {
  const paths: Record<Tool, string> = {
    select: 'M5 3l14 10-7 1-3 7-4-18Z',
    hand: 'M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a1.5 1.5 0 0 1 2-2l3 2Z',
    arrow: 'M5 19L19 5M8 5h11v11',
    ellipse: 'M21 12a9 7 0 1 1-18 0 9 7 0 1 1 18 0',
    box: 'M4 4h16v16H4Z',
    pen: 'M14 5l5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z',
    text: 'M4 6V4h16v2M12 4v16M8 20h8',
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[tool]} />
    </svg>
  );
}

export function Mark({
  mark,
  active,
  selected,
  scale,
  onSelect,
  onLabelDrag,
}: {
  mark: Annotation;
  active: boolean;
  selected?: boolean;
  scale: number;
  onSelect?: (e: ReactPointerEvent) => void;
  onLabelDrag?: (e: ReactPointerEvent) => void;
}) {
  const p = mark.points;
  const end = p.length >= 4 ? p.slice(-2) : [p[0] + 1, p[1] + 1];
  const label = labelPoint(mark);
  const fontSize = mark.fontSize ?? 12;
  const stroke = mark.color || '#c5a3ff';
  return (
    <g
      opacity={active ? 1 : 0.23}
      onPointerDown={onSelect}
      className={selected ? 'mark-selected' : ''}
      style={{ cursor: onSelect ? 'pointer' : undefined }}
    >
      {mark.type === 'arrow' && (
        <>
          <defs>
            <marker
              id={`arrow-${mark.id}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
            </marker>
          </defs>
          <line
            x1={p[0]}
            y1={p[1]}
            x2={end[0]}
            y2={end[1]}
            stroke={stroke}
            strokeWidth={mark.strokeWidth ?? 3}
            vectorEffect="non-scaling-stroke"
            markerEnd={`url(#arrow-${mark.id})`}
          />
        </>
      )}
      {mark.type === 'ellipse' && (
        <ellipse
          cx={(p[0] + end[0]) / 2}
          cy={(p[1] + end[1]) / 2}
          rx={Math.abs(end[0] - p[0]) / 2}
          ry={Math.abs(end[1] - p[1]) / 2}
          fill="none"
          stroke={stroke}
          strokeWidth={mark.strokeWidth ?? 2}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {mark.type === 'box' && (
        <rect
          x={Math.min(p[0], end[0])}
          y={Math.min(p[1], end[1])}
          width={Math.abs(end[0] - p[0])}
          height={Math.abs(end[1] - p[1])}
          fill={stroke}
          fillOpacity=".08"
          stroke={stroke}
          strokeWidth={mark.strokeWidth ?? 2}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {mark.type === 'pen' && (
        <polyline
          points={Array.from(
            { length: p.length / 2 },
            (_, i) => `${p[i * 2]},${p[i * 2 + 1]}`,
          ).join(' ')}
          stroke={stroke}
          strokeWidth={mark.brushSize || 3}
          opacity={mark.opacity ?? 0.42}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {(mark.text || mark.type === 'text' || selected) && (
        <g
          transform={`translate(${label[0]},${label[1]}) scale(${1 / scale})`}
          onPointerDown={onLabelDrag}
          style={{ cursor: onLabelDrag ? 'move' : undefined }}
        >
          <rect
            x={-5}
            y={-fontSize * 1.25}
            width={
              Math.max(
                ...(mark.text || '输入修改意见').split('\n').map((line) => Array.from(line).length),
                2,
              ) *
                fontSize +
              12
            }
            height={(mark.text || '输入修改意见').split('\n').length * fontSize * 1.4 + 4}
            rx={3}
            fill="var(--panel)"
            fillOpacity={0.94}
          />
          <text
            fill={stroke}
            fontSize={fontSize}
            fontWeight={mark.fontWeight ?? 400}
            paintOrder="stroke"
            stroke="#17171c"
            strokeWidth="3"
          >
            {(mark.text || '输入修改意见').split('\n').map((line, index) => (
              <tspan key={index} x="0" dy={index ? '1.4em' : 0}>
                {line || ' '}
              </tspan>
            ))}
          </text>
        </g>
      )}
    </g>
  );
}
