import { cloneDeep } from "lodash";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import GridLayout, { type LayoutItem } from "react-grid-layout/legacy";
import {
  RGL_CONTAINER_PADDING,
  RGL_MARGIN,
} from "../pages/workspaceGridLayout";

export type WidgetBoardProps = {
  /** Number of grid columns (e.g. 2 on phone, up to 10 on desktop). */
  cols: number;
  /** Height of one row in pixels. */
  rowHeight: number;
  /** Current layout items (react-grid-layout format). */
  layout: LayoutItem[];
  /** Called when the user drags or the layout compacts. */
  onLayoutChange: (layout: readonly LayoutItem[]) => void;
  /** Render each widget by id. */
  renderItem: (id: string) => ReactNode;
  /** CSS selector for the drag handle (e.g. title bar). */
  dragHandleSelector?: string;
  /** Highlight when an external item can drop. */
  dropHighlight?: boolean;
  className?: string;
  emptyState?: ReactNode;
};

/**
 * iOS-style widget board: vertical compact packing, no gaps, drag-and-drop.
 * Built on react-grid-layout (industry standard for dashboard grids).
 */
export function WidgetBoard({
  cols,
  rowHeight,
  layout,
  onLayoutChange,
  renderItem,
  dragHandleSelector = ".widget-drag-handle",
  dropHighlight = false,
  className = "",
  emptyState,
}: WidgetBoardProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const handleLayoutChange = useCallback(
    (next: readonly LayoutItem[]) => {
      onLayoutChange(cloneDeep([...next]));
    },
    [onLayoutChange],
  );

  const hasItems = layout.length > 0;

  return (
    <div
      ref={wrapRef}
      className={`widget-board-wrap${dropHighlight ? " widget-board-drop-highlight" : ""}${className ? ` ${className}` : ""}`}
    >
      {!hasItems && emptyState ? (
        <div className="widget-board-empty">{emptyState}</div>
      ) : (
        <GridLayout
          className="widget-board-grid"
          width={width}
          cols={cols}
          rowHeight={rowHeight}
          layout={layout}
          margin={RGL_MARGIN}
          containerPadding={RGL_CONTAINER_PADDING}
          compactType="vertical"
          preventCollision={false}
          isBounded={false}
          isDraggable
          isResizable={false}
          draggableHandle={dragHandleSelector}
          onLayoutChange={handleLayoutChange}
          useCSSTransforms
        >
          {layout.map((item) => (
            <div key={item.i} className="widget-board-item">
              {renderItem(item.i)}
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
