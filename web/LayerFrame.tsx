import type { PointerEvent } from 'react';
import type { FrameHandle, LayerFrame as Frame } from '../shared/layer-frame';

export function LayerFrame({
  frame,
  scale,
  editable,
  onDrag,
  name,
  onSelect,
}: {
  frame: Frame;
  scale: number;
  editable: boolean;
  onDrag: (e: PointerEvent, handle: FrameHandle) => void;
  name?: string;
  onSelect?: (e: PointerEvent) => void;
}) {
  const handles: FrameHandle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  return (
    <div
      className={`layer-frame ${editable ? 'editable' : ''}`}
      aria-label="图层重建画幅"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        borderWidth: 1.5 / scale,
      }}
    >
      {editable &&
        handles.map((handle) => {
          const corner = handle.length === 2;
          return (
            <div
              key={handle}
              role="button"
              aria-label={`调整图层画幅 ${handle}`}
              className={`frame-handle ${handle}`}
              title="拖动调整重建范围，不缩放物体或标注"
              style={{
                left: handle.includes('w') ? 0 : handle.includes('e') ? '100%' : 0,
                top: handle.includes('n') ? 0 : handle.includes('s') ? '100%' : 0,
                width: corner || ['w', 'e'].includes(handle) ? 9 / scale : '100%',
                height: corner || ['n', 's'].includes(handle) ? 9 / scale : '100%',
                marginLeft: corner || ['w', 'e'].includes(handle) ? -4.5 / scale : 0,
                marginTop: corner || ['n', 's'].includes(handle) ? -4.5 / scale : 0,
                borderWidth: corner ? 1 / scale : 0,
              }}
              onPointerDown={(e) => onDrag(e, handle)}
            />
          );
        })}
      <span
        style={{ transform: `scale(${1 / scale})` }}
        onPointerDown={editable ? (e) => onDrag(e, 'move') : onSelect}
        role={onSelect ? 'button' : undefined}
        aria-label={onSelect ? `选择规划图层 ${name}` : undefined}
        className={`frame-size ${onSelect ? 'selectable' : ''}`}
        title={editable ? '拖动移动重建画幅；物体与标注位置保持不变' : undefined}
      >
        {name ? `${name} · ` : ''}
        {frame.width} × {frame.height}
        {editable ? ' · 拖边调整' : ''}
      </span>
    </div>
  );
}
